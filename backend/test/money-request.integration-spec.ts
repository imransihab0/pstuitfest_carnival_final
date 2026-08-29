import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { WalletRepository } from '../src/modules/wallet/wallet.repository.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * ============================================================================
 *  Money requests, accepted against a real PostgreSQL
 * ============================================================================
 *
 * WalletRepository.acceptMoneyRequest previously flipped `status` to
 * 'ACCEPTED' in one UPDATE and attached `settled_transaction_id` in a second,
 * later UPDATE within the same transaction. That is exactly the shape
 * `chk_money_requests_settlement_shape` exists to forbid — a row claiming
 * ACCEPTED with no settling transaction — and Postgres does not wait for
 * commit to check a CHECK constraint: it evaluates one at the end of the
 * *statement* that touched the row. The first UPDATE therefore failed
 * outright with SQLSTATE 23514, meaning accepting a money request crashed on
 * every real call. Nothing caught this because the only existing coverage was
 * a unit test against a mocked repository, which cannot see a database
 * constraint at all — a mock agrees with whatever it's told.
 *
 * This file is the integration coverage that was missing. It exists so this
 * exact failure mode — correct-looking code that a real CHECK constraint
 * rejects — cannot silently return.
 */

const TAKA = 100n;

describe('WalletRepository.acceptMoneyRequest — against real PostgreSQL', () => {
  let database: TestDatabase;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let wallet: WalletRepository;
  let systemAccountId: string;
  let userCounter = 0;

  beforeAll(async () => {
    database = await startTestDatabase();

    moduleRef = await Test.createTestingModule({
      providers: [
        WalletRepository,
        PrismaService,
        {
          provide: ConfigService,
          useValue: { get: () => database.connectionString },
        },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    await prisma.onModuleInit();
    wallet = moduleRef.get(WalletRepository);

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

  async function createFundedUser(
    balancePoisha: bigint,
  ): Promise<{ userId: string; accountId: string }> {
    userCounter += 1;
    const suffix = `${Date.now()}${userCounter}`;

    return await prisma.client.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: `mruser${suffix}@example.com`,
          phone: `+8803${suffix.slice(-9)}`,
          username: `mruser${suffix}`,
          displayName: `Request User ${suffix}`,
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

  it('accepts a pending request without violating chk_money_requests_settlement_shape', async () => {
    const requester = await createFundedUser(0n); // wants to be paid
    const requestee = await createFundedUser(1_000n * TAKA); // will pay

    const { id: requestId } = await wallet.createMoneyRequest({
      requesterId: requester.userId,
      requesteeId: requestee.userId,
      amountPoisha: 400n * TAKA,
    });

    const outcome = await wallet.acceptMoneyRequest({
      requestId,
      requesteeUserId: requestee.userId,
    });

    expect(outcome).toMatchObject({ ok: true, balancePoisha: 600n * TAKA });

    expect(await balanceOf(requestee.accountId)).toBe(600n * TAKA);
    expect(await balanceOf(requester.accountId)).toBe(400n * TAKA);

    const row = await prisma.client.moneyRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.status).toBe('ACCEPTED');
    expect(row.settledTransactionId).not.toBeNull();
    expect(row.respondedAt).not.toBeNull();
  });

  it('lets exactly one of two concurrent accepts of the same request succeed', async () => {
    const requester = await createFundedUser(0n);
    const requestee = await createFundedUser(1_000n * TAKA);

    const { id: requestId } = await wallet.createMoneyRequest({
      requesterId: requester.userId,
      requesteeId: requestee.userId,
      amountPoisha: 250n * TAKA,
    });

    const [first, second] = await Promise.all([
      wallet.acceptMoneyRequest({ requestId, requesteeUserId: requestee.userId }),
      wallet.acceptMoneyRequest({ requestId, requesteeUserId: requestee.userId }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toHaveLength(1);

    // The money moved exactly once.
    expect(await balanceOf(requestee.accountId)).toBe(750n * TAKA);
    expect(await balanceOf(requester.accountId)).toBe(250n * TAKA);
  });

  it('rejects a request and leaves no settled transaction behind', async () => {
    const requester = await createFundedUser(0n);
    const requestee = await createFundedUser(1_000n * TAKA);

    const { id: requestId } = await wallet.createMoneyRequest({
      requesterId: requester.userId,
      requesteeId: requestee.userId,
      amountPoisha: 100n * TAKA,
    });

    const outcome = await wallet.rejectMoneyRequest(requestId, requestee.userId);
    expect(outcome).toBe('REJECTED');

    const row = await prisma.client.moneyRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.status).toBe('REJECTED');
    expect(row.settledTransactionId).toBeNull();

    expect(await balanceOf(requestee.accountId)).toBe(1_000n * TAKA);
    expect(await balanceOf(requester.accountId)).toBe(0n);
  });
});
