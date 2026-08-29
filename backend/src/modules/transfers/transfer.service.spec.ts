import { Test, type TestingModule } from '@nestjs/testing';
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  TransferService,
} from './transfer.service.js';
import { TransferRepository } from './transfer.repository.js';
import { type ExecuteTransferCommand } from './dto/transfer.types.js';

/**
 * Unit tests for the domain layer, with the repository stubbed.
 *
 * These cover the decisions the service makes: amount validation, idempotent
 * replay, conflict detection, and whether a failure gets audited. They
 * deliberately do NOT cover concurrency — locking and serialisation are
 * database behaviours, and asserting them against a stub would only prove the
 * stub behaves as written. That work is in
 * `test/transfer.concurrency.integration-spec.ts`, against a real PostgreSQL.
 */

const TAKA = 100n;

describe('TransferService', () => {
  let service: TransferService;
  let repository: {
    executeAtomically: Mock;
    findCachedIdempotentResult: Mock;
    recordFailedTransaction: Mock;
  };

  const command = (overrides: Partial<ExecuteTransferCommand> = {}): ExecuteTransferCommand => ({
    senderUserId: 'sender-user-id',
    receiver: { kind: 'username', value: 'bob' },
    amountPoisha: 100n * TAKA,
    idempotencyKey: 'key-1',
    ...overrides,
  });

  beforeEach(async () => {
    repository = {
      executeAtomically: vi.fn(),
      findCachedIdempotentResult: vi.fn().mockResolvedValue(null),
      recordFailedTransaction: vi.fn().mockResolvedValue({
        reference: 'TXN-FAILREF',
        transactionId: 'failed-txn-id',
      }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [TransferService, { provide: TransferRepository, useValue: repository }],
    }).compile();

    service = moduleRef.get(TransferService);
  });

  const successOutcome = {
    ok: true as const,
    reference: 'TXN-ABC123',
    transactionId: 'txn-id',
    senderAccountId: 'sender-account',
    receiverAccountId: 'receiver-account',
    senderBalancePoisha: 900n * TAKA,
    receiverBalancePoisha: 100n * TAKA,
    completedAt: new Date('2026-08-29T06:00:00.000Z'),
  };

  // ---------------------------------------------------------------------------
  // Amount validation — rejected before the database is touched at all
  // ---------------------------------------------------------------------------

  it.each([
    ['zero', 0n],
    ['negative', -1n],
    ['a large negative', -100n * TAKA],
  ])('rejects %s amounts without opening a transaction', async (_label, amountPoisha) => {
    const result = await service.executeTransfer(command({ amountPoisha }));

    expect(result).toEqual({ ok: false, reason: 'INVALID_AMOUNT' });
    // The point of validating here is to not do database work for a request
    // that cannot possibly succeed.
    expect(repository.executeAtomically).not.toHaveBeenCalled();
    expect(repository.findCachedIdempotentResult).not.toHaveBeenCalled();
  });

  it('rejects an amount above the per-transaction ceiling', async () => {
    const result = await service.executeTransfer(command({ amountPoisha: 2_000_000n * TAKA }));

    expect(result).toEqual({ ok: false, reason: 'LIMIT_EXCEEDED' });
    expect(repository.executeAtomically).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // The happy path
  // ---------------------------------------------------------------------------

  it('returns the committed transfer', async () => {
    repository.executeAtomically.mockResolvedValue(successOutcome);

    const result = await service.executeTransfer(command());

    expect(result).toMatchObject({
      ok: true,
      reference: 'TXN-ABC123',
      transactionId: 'txn-id',
      amountPoisha: 100n * TAKA,
      replayed: false,
    });
  });

  it('passes a stable request hash so retries are recognisable', async () => {
    repository.executeAtomically.mockResolvedValue(successOutcome);

    await service.executeTransfer(command());
    await service.executeTransfer(command());

    const [first, second] = repository.executeAtomically.mock.calls;
    expect(first?.[0].requestHash).toBe(second?.[0].requestHash);
    expect(first?.[0].requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes a different amount differently', async () => {
    repository.executeAtomically.mockResolvedValue(successOutcome);

    await service.executeTransfer(command({ amountPoisha: 100n * TAKA }));
    await service.executeTransfer(command({ amountPoisha: 101n * TAKA }));

    const [first, second] = repository.executeAtomically.mock.calls;
    expect(first?.[0].requestHash).not.toBe(second?.[0].requestHash);
  });

  // ---------------------------------------------------------------------------
  // Idempotency (NFR-B)
  // ---------------------------------------------------------------------------

  const cachedResponse = (overrides: Record<string, unknown> = {}) => ({
    requestHash: '',
    state: 'COMPLETED' as const,
    responseStatus: 201,
    responseBody: {
      reference: 'TXN-ORIGINAL',
      transactionId: 'original-txn',
      amountPoisha: (100n * TAKA).toString(),
      senderBalancePoisha: (900n * TAKA).toString(),
      receiverBalancePoisha: (100n * TAKA).toString(),
      completedAt: '2026-08-29T06:00:00.000Z',
    },
    transactionId: 'original-txn',
    ...overrides,
  });

  it('replays a stored result without re-executing the transfer', async () => {
    // Capture the hash the service computes for this exact command.
    repository.executeAtomically.mockResolvedValue(successOutcome);
    await service.executeTransfer(command());
    const hash = repository.executeAtomically.mock.calls[0]?.[0].requestHash as string;

    repository.executeAtomically.mockClear();
    repository.findCachedIdempotentResult.mockResolvedValue(cachedResponse({ requestHash: hash }));

    const result = await service.executeTransfer(command());

    expect(result).toMatchObject({
      ok: true,
      reference: 'TXN-ORIGINAL',
      replayed: true,
      // Amounts were stored as strings and must come back as bigints, never
      // having passed through a JS number.
      amountPoisha: 100n * TAKA,
      senderBalancePoisha: 900n * TAKA,
    });
    expect(repository.executeAtomically).not.toHaveBeenCalled();
  });

  it('rejects a key reused with a different payload', async () => {
    repository.findCachedIdempotentResult.mockResolvedValue(
      cachedResponse({ requestHash: 'a-hash-from-some-other-request' }),
    );

    // Serving the cached response here would tell the user their ৳500 went
    // through when the stored transfer was ৳100.
    await expect(service.executeTransfer(command())).rejects.toThrow(IdempotencyConflictError);
    expect(repository.executeAtomically).not.toHaveBeenCalled();
  });

  it('reports an in-flight duplicate as retryable rather than inventing a result', async () => {
    repository.executeAtomically.mockResolvedValue(successOutcome);
    await service.executeTransfer(command());
    const hash = repository.executeAtomically.mock.calls[0]?.[0].requestHash as string;

    repository.findCachedIdempotentResult.mockResolvedValue(
      cachedResponse({ requestHash: hash, state: 'IN_PROGRESS', responseBody: null }),
    );

    await expect(service.executeTransfer(command())).rejects.toThrow(IdempotencyInProgressError);
  });

  it('reads back the winner when a concurrent duplicate loses the race', async () => {
    repository.executeAtomically.mockResolvedValue(successOutcome);
    await service.executeTransfer(command());
    const hash = repository.executeAtomically.mock.calls[0]?.[0].requestHash as string;

    repository.executeAtomically.mockResolvedValue({
      ok: false,
      reason: 'IDEMPOTENT_REPLAY',
    });
    repository.findCachedIdempotentResult
      .mockResolvedValueOnce(null) // fast path: not there yet
      .mockResolvedValueOnce(cachedResponse({ requestHash: hash })); // after collision

    const result = await service.executeTransfer(command());

    expect(result).toMatchObject({ ok: true, reference: 'TXN-ORIGINAL', replayed: true });
    // No audit record: nothing failed, the money moved in the other request.
    expect(repository.recordFailedTransaction).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Failures are audited (FR-12, FR-21)
  // ---------------------------------------------------------------------------

  it('records a FAILED transaction and returns its reference', async () => {
    repository.executeAtomically.mockResolvedValue({
      ok: false,
      reason: 'INSUFFICIENT_FUNDS',
      senderAccountId: 'sender-account',
      receiverAccountId: 'receiver-account',
    });

    const result = await service.executeTransfer(command());

    expect(result).toEqual({
      ok: false,
      reason: 'INSUFFICIENT_FUNDS',
      reference: 'TXN-FAILREF',
      transactionId: 'failed-txn-id',
    });
    expect(repository.recordFailedTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        senderAccountId: 'sender-account',
        reason: 'INSUFFICIENT_FUNDS',
        amountPoisha: 100n * TAKA,
      }),
    );
  });

  it('still returns a clean rejection when the audit write itself fails', async () => {
    repository.executeAtomically.mockResolvedValue({
      ok: false,
      reason: 'INSUFFICIENT_FUNDS',
      senderAccountId: 'sender-account',
    });
    repository.recordFailedTransaction.mockResolvedValue(null);

    const result = await service.executeTransfer(command());

    // Audit logging must never turn a clean rejection into a 500 — the user's
    // outcome is unchanged.
    expect(result).toEqual({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
  });

  it('does not attempt an audit record when no sender account was resolved', async () => {
    repository.executeAtomically.mockResolvedValue({
      ok: false,
      reason: 'INTERNAL_ERROR',
    });

    const result = await service.executeTransfer(command());

    expect(result).toEqual({ ok: false, reason: 'INTERNAL_ERROR' });
    expect(repository.recordFailedTransaction).not.toHaveBeenCalled();
  });

  it('audits a RECEIVER_NOT_FOUND attempt with no receiver account', async () => {
    repository.executeAtomically.mockResolvedValue({
      ok: false,
      reason: 'RECEIVER_NOT_FOUND',
      senderAccountId: 'sender-account',
    });

    const result = await service.executeTransfer(command());

    expect(result.ok).toBe(false);
    expect(repository.recordFailedTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ receiverAccountId: undefined }),
    );
  });
});
