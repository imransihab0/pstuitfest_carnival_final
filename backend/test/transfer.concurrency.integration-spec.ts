import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { TransferService } from '../src/modules/transfers/transfer.service.js';
import { TransferRepository } from '../src/modules/transfers/transfer.repository.js';
import { type TransferResult } from '../src/modules/transfers/dto/transfer.types.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * ============================================================================
 *  THE HEADLINE TEST
 * ============================================================================
 *
 * The organizers' brief names this scenario explicitly:
 *
 *   "Two requests attempt to spend the same balance simultaneously → only valid
 *    transactions succeed, and the final balance remains correct."
 *
 * This suite runs it at 50x against a real PostgreSQL. It is the difference
 * between claiming the system is concurrency-safe and demonstrating it.
 *
 * A mocked database could not run this test: what is under examination is
 * `SELECT ... FOR UPDATE` blocking, lock ordering, and unique-index
 * serialisation — behaviours of the engine, not of our call sequence.
 */

const TAKA = 100n; // poisha per taka

describe('TransferService — concurrency and correctness', () => {
  let database: TestDatabase;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let transfers: TransferService;

  beforeAll(async () => {
    database = await startTestDatabase();

    moduleRef = await Test.createTestingModule({
      providers: [
        TransferService,
        TransferRepository,
        PrismaService,
        {
          // Minimal ConfigService stand-in: PrismaService only reads DATABASE_URL.
          provide: ConfigService,
          useValue: { get: () => database.connectionString },
        },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    await prisma.onModuleInit();
    transfers = moduleRef.get(TransferService);

    // The mint. Its balance goes negative by exactly the money issued, which is
    // what makes SUM(balance_poisha) = 0 hold across the whole database.
    const system = await prisma.client.account.create({
      data: { userId: null, accountType: 'SYSTEM', balancePoisha: 0n },
    });
    systemAccountId = system.id;
  }, 180_000);

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await moduleRef?.close();
    await database?.stop();
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  let userCounter = 0;
  let systemAccountId: string;

  /**
   * Creates a user and funds them **through the ledger**, exactly as
   * registration does: a SIGNUP_BONUS transaction debiting the SYSTEM account
   * and crediting the user, with both double-entry lines written.
   *
   * This matters for the reconciliation assertion. If fixtures were funded by
   * poking a balance column directly, every account would start with money the
   * ledger cannot explain, and "the ledger reconciles with the balance" would
   * have to be weakened to an inequality — which proves almost nothing. Funding
   * the honest way lets the test assert exact equality, and lets it check the
   * global zero-sum invariant.
   */
  async function createFundedUser(balancePoisha: bigint): Promise<{
    userId: string;
    accountId: string;
  }> {
    userCounter += 1;
    const suffix = `${Date.now()}${userCounter}`;

    return await prisma.client.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: `user${suffix}@example.com`,
          phone: `+8801${suffix.slice(-9)}`,
          username: `user${suffix}`,
          displayName: `User ${suffix}`,
          passwordHash: 'scrypt$test',
        },
      });
      const account = await tx.account.create({
        data: { userId: user.id, balancePoisha: 0n, accountType: 'USER' },
      });

      if (balancePoisha > 0n) {
        const funding = await tx.transaction.create({
          data: {
            reference: `TXN-SEED${suffix}`.slice(0, 32),
            type: 'SIGNUP_BONUS',
            status: 'SUCCESS',
            amountPoisha: balancePoisha,
            senderAccountId: systemAccountId,
            receiverAccountId: account.id,
            completedAt: new Date(),
          },
        });
        const systemAfter = await tx.account.update({
          where: { id: systemAccountId },
          data: { balancePoisha: { decrement: balancePoisha } },
        });
        const userAfter = await tx.account.update({
          where: { id: account.id },
          data: { balancePoisha: { increment: balancePoisha } },
        });
        await tx.ledgerEntry.createMany({
          data: [
            {
              transactionId: funding.id,
              accountId: systemAccountId,
              direction: 'DEBIT',
              amountPoisha: balancePoisha,
              balanceAfterPoisha: systemAfter.balancePoisha,
            },
            {
              transactionId: funding.id,
              accountId: account.id,
              direction: 'CREDIT',
              amountPoisha: balancePoisha,
              balanceAfterPoisha: userAfter.balancePoisha,
            },
          ],
        });
      }

      return { userId: user.id, accountId: account.id };
    });
  }

  /** Sums a single account's ledger entries: CREDIT positive, DEBIT negative. */
  async function replayLedger(accountId: string): Promise<bigint> {
    const rows = await prisma.client.$queryRaw<{ net: string }[]>`
      SELECT COALESCE(SUM(
        CASE "direction" WHEN 'CREDIT' THEN "amount_poisha" ELSE -"amount_poisha" END
      ), 0)::text AS net
      FROM "ledger_entries"
      WHERE "account_id" = ${accountId}::uuid
    `;
    return BigInt(rows[0]?.net ?? '0');
  }

  async function balanceOf(accountId: string): Promise<bigint> {
    const rows = await prisma.client.$queryRaw<{ balance_poisha: string }[]>`
      SELECT "balance_poisha"::text AS balance_poisha
      FROM "accounts" WHERE "id" = ${accountId}::uuid
    `;
    return BigInt(rows[0]?.balance_poisha ?? '0');
  }

  // ===========================================================================
  //  1. 50 concurrent transfers against an underfunded account
  // ===========================================================================

  it('lets exactly the affordable number of 50 concurrent transfers succeed', async () => {
    // ৳1,000 available; 50 concurrent attempts at ৳100 each. Only 10 are
    // affordable. The other 40 must fail cleanly, not overdraw.
    const startingBalance = 1_000n * TAKA;
    const transferAmount = 100n * TAKA;
    const attempts = 50;
    const affordable = Number(startingBalance / transferAmount); // 10

    const sender = await createFundedUser(startingBalance);
    const receiver = await createFundedUser(0n);

    // Fired without awaiting in between: they genuinely contend.
    const results = await Promise.all(
      Array.from({ length: attempts }, async (): Promise<TransferResult> => {
        return await transfers.executeTransfer({
          senderUserId: sender.userId,
          receiver: { kind: 'userId', value: receiver.userId },
          amountPoisha: transferAmount,
          // A distinct key per attempt: these are 50 *different* intents
          // racing for one balance, not 50 retries of one intent.
          idempotencyKey: randomUUID(),
        });
      }),
    );

    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const insufficient = failed.filter((r) => !r.ok && r.reason === 'INSUFFICIENT_FUNDS');

    // (b) exactly the affordable number succeed
    expect(succeeded).toHaveLength(affordable);
    expect(failed).toHaveLength(attempts - affordable);
    // Every failure is the *expected* failure — not a deadlock, not a
    // serialization abort, not an internal error. This is what distinguishes
    // "correct under contention" from "crashed in a way that happened to
    // avoid overdrawing".
    expect(insufficient).toHaveLength(attempts - affordable);

    // (a) the balance never went negative
    const senderBalance = await balanceOf(sender.accountId);
    const receiverBalance = await balanceOf(receiver.accountId);
    expect(senderBalance).toBe(0n);
    expect(senderBalance >= 0n).toBe(true);
    expect(receiverBalance).toBe(startingBalance);

    // (c) the ledger reconciles with the cached balances — exactly.
    // Both accounts were funded through the ledger, so replaying every entry
    // must reproduce the stored balance with nothing left over.
    expect(await replayLedger(sender.accountId)).toBe(senderBalance);
    expect(await replayLedger(receiver.accountId)).toBe(receiverBalance);

    // Conservation: nothing created, nothing destroyed.
    expect(senderBalance + receiverBalance).toBe(startingBalance);
  }, 120_000);

  // ===========================================================================
  //  2. Ledger reconciliation across every account
  // ===========================================================================

  it('reconciles ledger entries against every cached balance', async () => {
    const rows = await prisma.client.$queryRaw<
      { account_id: string; stored: string; replayed: string; matches: boolean }[]
    >`
      SELECT a."id"::text AS account_id,
             a."balance_poisha"::text AS stored,
             COALESCE(SUM(
               CASE le."direction" WHEN 'CREDIT' THEN le."amount_poisha"
                                   ELSE -le."amount_poisha" END
             ), 0)::text AS replayed,
             a."balance_poisha" = COALESCE(SUM(
               CASE le."direction" WHEN 'CREDIT' THEN le."amount_poisha"
                                   ELSE -le."amount_poisha" END
             ), 0) AS matches
      FROM "accounts" a
      LEFT JOIN "ledger_entries" le ON le."account_id" = a."id"
      GROUP BY a."id", a."balance_poisha"
    `;

    // Every account — including the SYSTEM mint — was funded through the
    // ledger, so replaying entries must reproduce the cached balance exactly.
    // Not "approximately", not "no greater than": exactly.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(BigInt(row.replayed), `account ${row.account_id}`).toBe(BigInt(row.stored));
      expect(row.matches, `account ${row.account_id}`).toBe(true);
    }
  });

  it('keeps the global invariant: all balances sum to zero', async () => {
    // The single most important property in the system. Money is only ever
    // moved, never created or destroyed — issuance shows up as system debt.
    const rows = await prisma.client.$queryRaw<
      { total_balance_poisha: string; is_balanced: boolean }[]
    >`SELECT "total_balance_poisha"::text AS total_balance_poisha, "is_balanced"
      FROM "v_money_invariant"`;

    expect(rows[0]?.is_balanced).toBe(true);
    expect(BigInt(rows[0]?.total_balance_poisha ?? '-1')).toBe(0n);
  });

  it('has no unbalanced transactions', async () => {
    // The view asserts every SUCCESS transaction has >= 2 entries netting to 0.
    const rows = await prisma.client.$queryRaw<{ transaction_id: string }[]>`
      SELECT transaction_id FROM "v_unbalanced_transactions"
    `;
    expect(rows).toEqual([]);
  });

  it('writes exactly one DEBIT and one CREDIT per successful transfer', async () => {
    const rows = await prisma.client.$queryRaw<
      { debits: number; credits: number; total: number }[]
    >`
      SELECT
        COUNT(*) FILTER (WHERE le."direction" = 'DEBIT')::int  AS debits,
        COUNT(*) FILTER (WHERE le."direction" = 'CREDIT')::int AS credits,
        COUNT(*)::int AS total
      FROM "ledger_entries" le
      JOIN "transactions" t ON t."id" = le."transaction_id"
      WHERE t."status" = 'SUCCESS' AND t."type" = 'TRANSFER'
    `;
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.debits).toBe(row?.credits);
    expect(row?.total).toBe((row?.debits ?? 0) * 2);
  });

  // ===========================================================================
  //  3. Idempotency: 50 retries of ONE intent
  // ===========================================================================

  it('moves money exactly once for 50 concurrent retries of one idempotency key', async () => {
    const sender = await createFundedUser(1_000n * TAKA);
    const receiver = await createFundedUser(0n);
    const amount = 250n * TAKA;
    const idempotencyKey = randomUUID();

    // The realistic failure mode: a client times out and retries, or a queue
    // delivers at-least-once. Every one of these is the SAME intent.
    const results = await Promise.all(
      Array.from(
        { length: 50 },
        async () =>
          await transfers.executeTransfer({
            senderUserId: sender.userId,
            receiver: { kind: 'userId', value: receiver.userId },
            amountPoisha: amount,
            idempotencyKey,
          }),
      ),
    );

    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(50);

    // All 50 describe the same single transfer.
    const references = new Set(succeeded.map((r) => (r.ok ? r.reference : '')));
    expect(references.size).toBe(1);

    // Money moved once, not 50 times.
    expect(await balanceOf(sender.accountId)).toBe(1_000n * TAKA - amount);
    expect(await balanceOf(receiver.accountId)).toBe(amount);

    // Exactly one TRANSFER debit on the sender — 50 requests, one movement.
    // (The account also carries its SIGNUP_BONUS credit, which is not a
    // transfer and is excluded here.)
    const entries = await prisma.client.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM "ledger_entries" le
      JOIN "transactions" t ON t."id" = le."transaction_id"
      WHERE le."account_id" = ${sender.accountId}::uuid
        AND t."type" = 'TRANSFER'
    `;
    expect(entries[0]?.n).toBe(1);
  }, 120_000);

  it('rejects a reused idempotency key carrying a different payload', async () => {
    const sender = await createFundedUser(1_000n * TAKA);
    const receiver = await createFundedUser(0n);
    const key = randomUUID();

    const first = await transfers.executeTransfer({
      senderUserId: sender.userId,
      receiver: { kind: 'userId', value: receiver.userId },
      amountPoisha: 100n * TAKA,
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);

    // Same key, different amount. Serving the cached response would tell the
    // user their ৳500 went through when only ৳100 did.
    await expect(
      transfers.executeTransfer({
        senderUserId: sender.userId,
        receiver: { kind: 'userId', value: receiver.userId },
        amountPoisha: 500n * TAKA,
        idempotencyKey: key,
      }),
    ).rejects.toThrow(/different request/i);

    expect(await balanceOf(sender.accountId)).toBe(900n * TAKA);
  });

  // ===========================================================================
  //  4. Deadlock resistance: A→B and B→A simultaneously
  // ===========================================================================

  it('does not deadlock when two accounts transfer to each other simultaneously', async () => {
    const a = await createFundedUser(1_000n * TAKA);
    const b = await createFundedUser(1_000n * TAKA);
    const amount = 10n * TAKA;
    const pairs = 30;

    // Without deterministic lock ordering this is the textbook deadlock: one
    // transaction holds A and wants B while the other holds B and wants A.
    // Locking in ascending UUID order makes it impossible.
    const results = await Promise.all([
      ...Array.from(
        { length: pairs },
        async () =>
          await transfers.executeTransfer({
            senderUserId: a.userId,
            receiver: { kind: 'userId', value: b.userId },
            amountPoisha: amount,
            idempotencyKey: randomUUID(),
          }),
      ),
      ...Array.from(
        { length: pairs },
        async () =>
          await transfers.executeTransfer({
            senderUserId: b.userId,
            receiver: { kind: 'userId', value: a.userId },
            amountPoisha: amount,
            idempotencyKey: randomUUID(),
          }),
      ),
    ]);

    // Every one succeeds: both accounts can afford all of them, and no
    // transaction was aborted by the engine.
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results).toHaveLength(pairs * 2);

    // Equal flows both ways, so both balances return to where they started.
    expect(await balanceOf(a.accountId)).toBe(1_000n * TAKA);
    expect(await balanceOf(b.accountId)).toBe(1_000n * TAKA);
  }, 120_000);

  // ===========================================================================
  //  5. Validation, and that failures are audited without moving money
  // ===========================================================================

  it('rejects a self-transfer and leaves the balance untouched', async () => {
    const user = await createFundedUser(1_000n * TAKA);

    const result = await transfers.executeTransfer({
      senderUserId: user.userId,
      receiver: { kind: 'userId', value: user.userId },
      amountPoisha: 100n * TAKA,
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('SELF_TRANSFER');
    expect(await balanceOf(user.accountId)).toBe(1_000n * TAKA);

    // FR-12: every attempt, including a rejected one, gets a reference.
    //
    // Regression guard. The audit row for a self-transfer cannot carry
    // sender = receiver without violating chk_transactions_no_self_transfer, so
    // the repository writes a NULL receiver instead. An earlier version did
    // not, and the audit write failed silently — the transfer was correctly
    // rejected but left no trace, which is exactly the kind of hole an audit
    // trail exists to not have.
    const reference = result.ok === false ? result.reference : undefined;
    expect(reference, 'a rejected self-transfer must still be audited').toBeDefined();

    const audit = await prisma.client.$queryRaw<
      { status: string; failure_reason: string; receiver_account_id: string | null }[]
    >`
      SELECT "status"::text AS status,
             "failure_reason"::text AS failure_reason,
             "receiver_account_id"::text AS receiver_account_id
      FROM "transactions" WHERE "reference" = ${reference ?? ''}
    `;
    expect(audit[0]?.status).toBe('FAILED');
    expect(audit[0]?.failure_reason).toBe('SELF_TRANSFER');
    expect(audit[0]?.receiver_account_id).toBeNull();
  });

  it.each([
    ['zero', 0n, 'INVALID_AMOUNT'],
    ['negative', -100n * TAKA, 'INVALID_AMOUNT'],
    ['above the per-transaction ceiling', 2_000_000n * TAKA, 'LIMIT_EXCEEDED'],
  ])('rejects a %s amount', async (_label, amount, expectedReason) => {
    const sender = await createFundedUser(1_000n * TAKA);
    const receiver = await createFundedUser(0n);

    const result = await transfers.executeTransfer({
      senderUserId: sender.userId,
      receiver: { kind: 'userId', value: receiver.userId },
      amountPoisha: amount,
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe(expectedReason);
    expect(await balanceOf(sender.accountId)).toBe(1_000n * TAKA);
  });

  it('records a FAILED transaction with no ledger entries', async () => {
    const sender = await createFundedUser(10n * TAKA);
    const receiver = await createFundedUser(0n);

    const result = await transfers.executeTransfer({
      senderUserId: sender.userId,
      receiver: { kind: 'userId', value: receiver.userId },
      amountPoisha: 500n * TAKA,
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('INSUFFICIENT_FUNDS');

    const reference = result.ok === false ? result.reference : undefined;
    expect(reference).toBeDefined();

    const rows = await prisma.client.$queryRaw<
      { status: string; failure_reason: string; entry_count: number }[]
    >`
      SELECT t."status"::text AS status,
             t."failure_reason"::text AS failure_reason,
             COUNT(le."id")::int AS entry_count
      FROM "transactions" t
      LEFT JOIN "ledger_entries" le ON le."transaction_id" = t."id"
      WHERE t."reference" = ${reference ?? ''}
      GROUP BY t."status", t."failure_reason"
    `;

    expect(rows[0]?.status).toBe('FAILED');
    expect(rows[0]?.failure_reason).toBe('INSUFFICIENT_FUNDS');
    // The absence of ledger entries is the proof that no balance moved.
    expect(rows[0]?.entry_count).toBe(0);
    expect(await balanceOf(sender.accountId)).toBe(10n * TAKA);
  });

  it('resolves a recipient by username, email and phone', async () => {
    const sender = await createFundedUser(1_000n * TAKA);
    const receiver = await createFundedUser(0n);

    const user = await prisma.client.user.findUniqueOrThrow({
      where: { id: receiver.userId },
      select: { username: true, email: true, phone: true },
    });

    for (const [kind, value] of [
      ['username', user.username.toUpperCase()], // case-insensitive
      ['email', user.email.toUpperCase()],
      ['phone', user.phone],
    ] as const) {
      const result = await transfers.executeTransfer({
        senderUserId: sender.userId,
        receiver: { kind, value },
        amountPoisha: 10n * TAKA,
        idempotencyKey: randomUUID(),
      });
      expect(result.ok, `resolving by ${kind}`).toBe(true);
    }

    expect(await balanceOf(receiver.accountId)).toBe(30n * TAKA);
  });

  it('rejects an unknown recipient', async () => {
    const sender = await createFundedUser(1_000n * TAKA);

    const result = await transfers.executeTransfer({
      senderUserId: sender.userId,
      receiver: { kind: 'username', value: 'nobody-with-this-name' },
      amountPoisha: 10n * TAKA,
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('RECEIVER_NOT_FOUND');
  });

  // ===========================================================================
  //  6. The ledger is immutable
  // ===========================================================================

  it('refuses to update or delete a ledger entry', async () => {
    const sender = await createFundedUser(1_000n * TAKA);
    const receiver = await createFundedUser(0n);

    await transfers.executeTransfer({
      senderUserId: sender.userId,
      receiver: { kind: 'userId', value: receiver.userId },
      amountPoisha: 100n * TAKA,
      idempotencyKey: randomUUID(),
    });

    await expect(
      prisma.client.$executeRaw`
        UPDATE "ledger_entries" SET "amount_poisha" = 1
        WHERE "account_id" = ${sender.accountId}::uuid`,
    ).rejects.toThrow(/append-only/i);

    await expect(
      prisma.client.$executeRaw`
        DELETE FROM "ledger_entries" WHERE "account_id" = ${sender.accountId}::uuid`,
    ).rejects.toThrow(/append-only/i);
  });
});
