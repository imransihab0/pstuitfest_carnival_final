import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { BillSplitService } from '../src/modules/bill-splits/bill-split.service.js';
import { BillSplitRepository } from '../src/modules/bill-splits/bill-split.repository.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * ============================================================================
 *  Bill splits against a real PostgreSQL
 * ============================================================================
 *
 * Mirrors transfer.concurrency.integration-spec.ts: the properties under test
 * here — the `SELECT ... FOR UPDATE` on `bill_splits` that serializes the
 * "has every sibling share been paid?" check, and the state-transition guard
 * that makes double-clicking "pay" safe — are database behaviours. A mocked
 * repository would only prove the stub does what it was told; the interesting
 * failure mode is two payment transactions interleaving in a way that was not
 * anticipated, and only a real engine can produce that.
 */

const TAKA = 100n;

describe('BillSplitRepository — concurrency and correctness', () => {
  let database: TestDatabase;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let billSplits: BillSplitService;
  let systemAccountId: string;
  let userCounter = 0;

  beforeAll(async () => {
    database = await startTestDatabase();

    moduleRef = await Test.createTestingModule({
      providers: [
        BillSplitService,
        BillSplitRepository,
        PrismaService,
        {
          provide: ConfigService,
          useValue: { get: () => database.connectionString },
        },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    await prisma.onModuleInit();
    billSplits = moduleRef.get(BillSplitService);

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

  /** Funds a user through the ledger, exactly as registration does — see the transfer suite for why. */
  async function createFundedUser(
    balancePoisha: bigint,
  ): Promise<{ userId: string; accountId: string }> {
    userCounter += 1;
    const suffix = `${Date.now()}${userCounter}`;

    return await prisma.client.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: `bsuser${suffix}@example.com`,
          phone: `+8802${suffix.slice(-9)}`,
          username: `bsuser${suffix}`,
          displayName: `Split User ${suffix}`,
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

  async function balanceOf(accountId: string): Promise<bigint> {
    const rows = await prisma.client.$queryRaw<{ balance_poisha: string }[]>`
      SELECT "balance_poisha"::text AS balance_poisha FROM "accounts" WHERE "id" = ${accountId}::uuid
    `;
    return BigInt(rows[0]?.balance_poisha ?? '0');
  }

  async function invariantIsBalanced(): Promise<boolean> {
    const rows = await prisma.client.$queryRaw<{ is_balanced: boolean }[]>`
      SELECT "is_balanced" FROM "v_money_invariant"
    `;
    return rows[0]?.is_balanced ?? false;
  }

  // ===========================================================================
  //  1. Happy path: create, pay, settle
  // ===========================================================================

  it('pays a share, moves the exact amount, and reconciles the ledger', async () => {
    const creator = await createFundedUser(0n);
    const payer = await createFundedUser(1_000n * TAKA);

    const created = await billSplits.create(creator.userId, {
      totalAmountPoisha: 300n * TAKA,
      shares: [{ payerId: payer.userId, amountPoisha: 300n * TAKA }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await billSplits.payShare(payer.userId, created.id);
    expect(result).toMatchObject({ ok: true, splitSettled: true });

    expect(await balanceOf(payer.accountId)).toBe(700n * TAKA);
    expect(await balanceOf(creator.accountId)).toBe(300n * TAKA);

    const detail = await billSplits.getDetail(created.id, creator.userId);
    expect(detail.status).toBe('SETTLED');
    expect(detail.settledAt).not.toBeNull();
    expect(detail.shares[0]?.status).toBe('PAID');

    expect(await invariantIsBalanced()).toBe(true);
  });

  it('rejects a share total that does not match the declared total, before touching the database', async () => {
    const creator = await createFundedUser(0n);
    const payer = await createFundedUser(1_000n * TAKA);

    const result = await billSplits.create(creator.userId, {
      totalAmountPoisha: 1000n * TAKA,
      shares: [{ payerId: payer.userId, amountPoisha: 300n * TAKA }],
    });

    expect(result).toEqual({ ok: false, reason: 'SHARE_TOTAL_MISMATCH' });
  });

  // ===========================================================================
  //  2. Double-click safety: two concurrent payments of the same share
  // ===========================================================================

  it('lets exactly one of two concurrent payments of the same share succeed', async () => {
    const creator = await createFundedUser(0n);
    const payer = await createFundedUser(1_000n * TAKA);

    const created = await billSplits.create(creator.userId, {
      totalAmountPoisha: 250n * TAKA,
      shares: [{ payerId: payer.userId, amountPoisha: 250n * TAKA }],
    });
    if (!created.ok) throw new Error('setup failed');

    const [first, second] = await Promise.all([
      billSplits.payShare(payer.userId, created.id),
      billSplits.payShare(payer.userId, created.id),
    ]);

    const outcomes = [first, second];
    const succeeded = outcomes.filter((r) => r.ok);
    const rejected = outcomes.filter((r) => !r.ok);

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ ok: false, reason: 'NOT_PENDING' });

    // The money moved exactly once, not zero and not twice.
    expect(await balanceOf(payer.accountId)).toBe(750n * TAKA);
    expect(await balanceOf(creator.accountId)).toBe(250n * TAKA);
    expect(await invariantIsBalanced()).toBe(true);
  });

  // ===========================================================================
  //  3. The settlement race this repository's `FOR UPDATE` exists to prevent
  // ===========================================================================

  it('settles the split exactly once when the last two shares are paid at the same instant', async () => {
    const creator = await createFundedUser(0n);
    const payerA = await createFundedUser(500n * TAKA);
    const payerB = await createFundedUser(500n * TAKA);

    const created = await billSplits.create(creator.userId, {
      totalAmountPoisha: 1000n * TAKA,
      shares: [
        { payerId: payerA.userId, amountPoisha: 500n * TAKA },
        { payerId: payerB.userId, amountPoisha: 500n * TAKA },
      ],
    });
    if (!created.ok) throw new Error('setup failed');

    // Both participants pay their share in the same instant. Without the lock
    // on the parent bill_splits row, each transaction's "any siblings still
    // PENDING?" check could run against a snapshot that predates the other's
    // still-uncommitted update, and neither would mark the split SETTLED.
    const [resultA, resultB] = await Promise.all([
      billSplits.payShare(payerA.userId, created.id),
      billSplits.payShare(payerB.userId, created.id),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);

    // Exactly one of the two payments observes itself as the one that settled
    // the split — never zero (the race this test targets) and never both
    // (which would mean settledAt got stamped twice).
    const settledCount = [resultA, resultB].filter((r) => r.ok && r.splitSettled).length;
    expect(settledCount).toBe(1);

    const detail = await billSplits.getDetail(created.id, creator.userId);
    expect(detail.status).toBe('SETTLED');
    expect(detail.shares.every((share) => share.status === 'PAID')).toBe(true);

    expect(await balanceOf(creator.accountId)).toBe(1000n * TAKA);
    expect(await invariantIsBalanced()).toBe(true);
  });

  // ===========================================================================
  //  4. Insufficient funds leaves the share PENDING, not half-settled
  // ===========================================================================

  it('leaves the share PENDING when the payer cannot afford it, and moves no money', async () => {
    const creator = await createFundedUser(0n);
    const payer = await createFundedUser(100n * TAKA);

    const created = await billSplits.create(creator.userId, {
      totalAmountPoisha: 500n * TAKA,
      shares: [{ payerId: payer.userId, amountPoisha: 500n * TAKA }],
    });
    if (!created.ok) throw new Error('setup failed');

    const result = await billSplits.payShare(payer.userId, created.id);
    expect(result).toEqual({ ok: false, reason: 'INSUFFICIENT_FUNDS' });

    expect(await balanceOf(payer.accountId)).toBe(100n * TAKA);
    expect(await balanceOf(creator.accountId)).toBe(0n);

    const detail = await billSplits.getDetail(created.id, creator.userId);
    expect(detail.status).toBe('OPEN');
    expect(detail.shares[0]?.status).toBe('PENDING');

    expect(await invariantIsBalanced()).toBe(true);
  });
});
