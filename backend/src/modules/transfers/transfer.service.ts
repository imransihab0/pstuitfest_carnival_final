import { Injectable } from '@nestjs/common';
import { TransferRepository } from './transfer.repository.js';
import { hashRequestPayload } from '../../common/reference.js';
import { MAX_TRANSFER_POISHA } from '../../common/money.js';
import {
  type ExecuteTransferCommand,
  type TransferResult,
  type TransferSuccess,
} from './dto/transfer.types.js';

/** Raised when one idempotency key is reused for two different payloads. */
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor() {
    super(
      'This idempotency key was already used with a different request. ' +
        'Generate a new key for a new operation.',
    );
    this.name = 'IdempotencyConflictError';
  }
}

/** Raised when a duplicate arrives while the original is still in flight. */
export class IdempotencyInProgressError extends Error {
  readonly code = 'IDEMPOTENCY_IN_PROGRESS';
  constructor() {
    super('A request with this idempotency key is currently being processed. Retry shortly.');
    this.name = 'IdempotencyInProgressError';
  }
}

/** How long a stored idempotent response stays replayable. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class TransferService {
  constructor(private readonly transferRepository: TransferRepository) {}

  /**
   * Moves money from one user to another, exactly once.
   *
   * The division of labour with the repository:
   *
   *   - **Here**: rules that need no lock (amount bounds), idempotency
   *     orchestration, deciding what a failure means, and writing the audit
   *     record.
   *   - **Repository**: the atomic unit — locking, the balance check that has
   *     to happen under that lock, and the writes.
   *
   * Validation that depends on live balance genuinely cannot live in this
   * layer: a balance checked outside the lock is stale before it is used. The
   * repository therefore reports `{ ok: false, reason }` as *data*, and this
   * method decides what to do about it.
   */
  async executeTransfer(command: ExecuteTransferCommand): Promise<TransferResult> {
    const { senderUserId, receiver, amountPoisha, idempotencyKey, note } = command;

    // -----------------------------------------------------------------------
    // 1. Cheap validation, before touching the database.
    //
    // The database also enforces `amount > 0` via chk_transactions_amount_positive
    // and non-negative balances via chk_accounts_balance_sign. Rejecting here is
    // about giving a clear error, not about correctness — the constraint is what
    // makes it true.
    // -----------------------------------------------------------------------
    if (amountPoisha <= 0n) {
      return { ok: false, reason: 'INVALID_AMOUNT' };
    }
    if (amountPoisha > MAX_TRANSFER_POISHA) {
      return { ok: false, reason: 'LIMIT_EXCEEDED' };
    }

    const requestHash = hashRequestPayload({
      senderUserId,
      receiverKind: receiver.kind,
      receiverValue: receiver.value.toLowerCase(),
      amountPoisha: amountPoisha.toString(),
      note: note ?? '',
    });

    // -----------------------------------------------------------------------
    // 2. Idempotency fast path (NFR-B).
    //
    // A retry that arrives after the original committed is answered from the
    // stored response without touching an account. This is only a fast path:
    // the guarantee comes from the UNIQUE constraint inside the transaction,
    // not from this lookup, which is why a race here is harmless.
    // -----------------------------------------------------------------------
    const cached = await this.transferRepository.findCachedIdempotentResult(
      senderUserId,
      idempotencyKey,
    );
    if (cached !== null) {
      return this.replayCached(cached, requestHash);
    }

    // -----------------------------------------------------------------------
    // 3. The atomic transfer.
    // -----------------------------------------------------------------------
    const outcome = await this.transferRepository.executeAtomically({
      senderUserId,
      receiver,
      amountPoisha,
      idempotencyKey,
      requestHash,
      note,
      idempotencyTtlMs: IDEMPOTENCY_TTL_MS,
    });

    if (outcome.ok) {
      return {
        ok: true,
        reference: outcome.reference,
        transactionId: outcome.transactionId,
        amountPoisha,
        senderBalancePoisha: outcome.senderBalancePoisha,
        receiverBalancePoisha: outcome.receiverBalancePoisha,
        completedAt: outcome.completedAt,
        replayed: false,
      };
    }

    // -----------------------------------------------------------------------
    // 4. A concurrent duplicate won the race on the unique index.
    //
    // The money moved exactly once, in the other request. Read back its stored
    // response and return it — the caller cannot tell which of the two
    // duplicates it was, which is the entire point of idempotency.
    // -----------------------------------------------------------------------
    if (outcome.reason === 'IDEMPOTENT_REPLAY') {
      const winner = await this.transferRepository.findCachedIdempotentResult(
        senderUserId,
        idempotencyKey,
      );
      if (winner !== null) {
        return this.replayCached(winner, requestHash);
      }
      // The winner rolled back between our collision and this read, so nothing
      // was stored. Nothing happened; report it as retryable rather than
      // inventing a result.
      throw new IdempotencyInProgressError();
    }

    // -----------------------------------------------------------------------
    // 5. Clean failure. Record it for audit (FR-12, FR-21).
    //
    // Written in its own transaction, because the transfer's transaction has
    // already rolled back. The record has no ledger entries — that absence is
    // the evidence that no money moved.
    // -----------------------------------------------------------------------
    if (outcome.senderAccountId !== undefined) {
      const audit = await this.transferRepository.recordFailedTransaction({
        senderAccountId: outcome.senderAccountId,
        receiverAccountId: outcome.receiverAccountId,
        amountPoisha,
        reason: outcome.reason,
        note,
      });

      if (audit !== null) {
        return {
          ok: false,
          reason: outcome.reason,
          reference: audit.reference,
          transactionId: audit.transactionId,
        };
      }
    }

    return { ok: false, reason: outcome.reason };
  }

  /**
   * Turns a stored idempotency record back into a result.
   *
   * A key replayed with a *different* payload is a client bug. Serving the
   * original response would hide it — and could mean a user believes they sent
   * ৳500 when the stored transfer was ৳50 — so it is rejected as a conflict.
   */
  private replayCached(
    cached: NonNullable<Awaited<ReturnType<TransferRepository['findCachedIdempotentResult']>>>,
    requestHash: string,
  ): TransferSuccess {
    if (cached.requestHash !== requestHash) {
      throw new IdempotencyConflictError();
    }
    if (cached.state !== 'COMPLETED' || cached.responseBody === null) {
      throw new IdempotencyInProgressError();
    }

    const body = cached.responseBody as {
      reference: string;
      transactionId: string;
      amountPoisha: string;
      senderBalancePoisha: string;
      receiverBalancePoisha: string;
      completedAt: string;
    };

    return {
      ok: true,
      reference: body.reference,
      transactionId: body.transactionId,
      // Amounts were stored as strings, never as JSON numbers — a JSON number
      // is a double, which would reintroduce the float problem on replay.
      amountPoisha: BigInt(body.amountPoisha),
      senderBalancePoisha: BigInt(body.senderBalancePoisha),
      receiverBalancePoisha: BigInt(body.receiverBalancePoisha),
      completedAt: new Date(body.completedAt),
      replayed: true,
    };
  }
}
