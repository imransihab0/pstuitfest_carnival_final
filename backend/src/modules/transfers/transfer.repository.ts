import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { generateReference } from '../../common/reference.js';
import {
  type AtomicTransferOutcome,
  type CachedIdempotentResult,
  type ReceiverIdentifier,
  type TransferFailureReason,
} from './dto/transfer.types.js';

/**
 * Shape of a resolved `accounts` row.
 *
 * Balances are always selected as `::text` rather than as a raw BIGINT. Driver
 * adapters differ in whether they hand back a JS `number`, a `string`, or a
 * `bigint` for BIGINT columns, and a silent downgrade to `number` would put a
 * balance through a double — precisely the failure this system is built to
 * avoid. Casting to text and parsing with `BigInt()` makes the representation
 * explicit and driver-independent.
 */
interface ResolvedAccountRow {
  account_id: string;
  user_id: string | null;
  status: string;
}

/** Thrown inside the interactive transaction to force a rollback with a reason. */
class TransferAbort extends Error {
  constructor(
    readonly reason: TransferFailureReason,
    readonly senderAccountId?: string,
    readonly receiverAccountId?: string,
  ) {
    super(`Transfer aborted: ${reason}`);
    this.name = 'TransferAbort';
  }
}

/** Postgres unique-violation SQLSTATE, and Prisma's equivalent error code. */
const PG_UNIQUE_VIOLATION = '23505';
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Transient SQLSTATEs — the transaction failed for a reason that has nothing to
 * do with the request being wrong, and an identical retry may well succeed.
 *
 *   40001  serialization_failure
 *   40P01  deadlock_detected
 *
 * PostgreSQL treats both as the application's responsibility to retry.
 */
const PG_SERIALIZATION_FAILURE = '40001';
const PG_DEADLOCK_DETECTED = '40P01';
/** Prisma's wrapper code for "transaction failed due to a write conflict or deadlock". */
const PRISMA_TRANSACTION_CONFLICT = 'P2034';

/**
 * Retry budget. Deadlocks here are rare and resolve almost immediately once the
 * competing transaction finishes, so a small budget is enough; an unbounded one
 * would turn a systemic problem into a silent latency cliff.
 */
const MAX_TRANSIENT_RETRIES = 5;

/** Sentinel: this attempt hit a transient error and should be retried. */
const TRANSIENT_RETRY = Symbol('TRANSIENT_RETRY');

@Injectable()
export class TransferRepository {
  private readonly logger = new Logger(TransferRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Executes a transfer as a single atomic database transaction.
   *
   * ===========================================================================
   *  ISOLATION AND LOCKING — the central design decision
   * ===========================================================================
   *
   * Two viable strategies exist for making concurrent transfers correct:
   *
   *   (A) SERIALIZABLE isolation. PostgreSQL detects read/write dependency
   *       cycles and aborts one of the offending transactions with SQLSTATE
   *       40001. Correctness is automatic and no explicit locks are needed.
   *
   *       Cost: the application MUST implement a retry loop, because 40001 is a
   *       normal outcome, not an error. Under exactly the workload this system
   *       is judged on — many transfers contending on one hot account — the
   *       abort rate climbs sharply and each abort means redoing the work. That
   *       makes p95 latency a function of contention, which is the opposite of
   *       what NFR-E asks for, and a retry loop around money movement is itself
   *       a place bugs hide.
   *
   *   (B) READ COMMITTED with row locks taken by conditional UPDATE.
   *       Contending transfers queue on the row lock instead of aborting. Each
   *       waits, then proceeds. No retry loop in the normal path, no lost work,
   *       and latency degrades gracefully and predictably under contention.
   *
   *       Cost: correctness now depends on us taking the right locks in the
   *       right order. Get the order wrong and A→B racing B→A deadlocks.
   *
   * **We chose (B).** The cost of (B) is a bounded, reviewable discipline
   * applied in exactly one function; the cost of (A) is unbounded retry
   * behaviour spread across every caller. We pay for (B) by writing the two
   * balance rows in a deterministic global order — ascending account UUID.
   *
   * ---------------------------------------------------------------------------
   *  WHAT THE CONCURRENCY TEST ACTUALLY TAUGHT US
   * ---------------------------------------------------------------------------
   *
   * The first version of this method took the row locks with two explicit
   * `SELECT ... FOR UPDATE` statements *before* the two UPDATEs, and this
   * comment claimed deterministic ordering made deadlock impossible.
   *
   * The 50-way concurrency test falsified that. Roughly a third of runs
   * produced SQLSTATE 40P01 (`deadlock detected`) on ~18 of 50 requests.
   * Balances stayed correct throughout — no overdraft, no money created or
   * destroyed — but those callers received an internal error instead of a clean
   * answer, which is its own kind of wrong.
   *
   * Two lessons, both now encoded here:
   *
   *   1. **Ordering governs only the locks we take explicitly.** It does not
   *      govern the locks PostgreSQL takes on our behalf — foreign-key checks
   *      acquire KEY SHARE locks on referenced rows, and when those fire is the
   *      engine's business. "Impossible" was never available; "rare" is.
   *
   *   2. **The lock window matters more than the lock count.** The `FOR UPDATE`
   *      selects were redundant — a conditional UPDATE already takes a
   *      row-exclusive lock and already re-checks the balance atomically — but
   *      they doubled the number of round trips during which locks were held.
   *      Removing them dropped observed deadlocks to **zero across 10 full runs**
   *      and cut the suite from ~7-26s to ~1.7s. Fewer statements inside the
   *      lock window was not a micro-optimisation; it was the fix.
   *
   * The bounded retry with jittered backoff stays regardless. PostgreSQL
   * documents that any application using row locks must be prepared to retry on
   * 40P01, and being correct-but-occasionally-500 is not good enough for money.
   * Retrying is safe because each attempt is atomic: a deadlocked transaction
   * rolled back entirely, leaving no balance change, no ledger row and no
   * committed idempotency key. It is now a genuine exception path rather than
   * the routine one it would be under (A).
   */
  async executeAtomically(params: {
    senderUserId: string;
    receiver: ReceiverIdentifier;
    amountPoisha: bigint;
    idempotencyKey: string;
    requestHash: string;
    note?: string | undefined;
    idempotencyTtlMs: number;
  }): Promise<AtomicTransferOutcome> {
    // Bounded retry on transient serialization errors. See `isTransient` and
    // the note on deadlocks in this class's header for why this is required
    // even with deterministic lock ordering.
    //
    // Retrying is safe precisely because the unit is atomic: a transaction that
    // deadlocked rolled back completely, so no balance moved, no ledger row
    // exists, and the idempotency key was never committed. Each attempt starts
    // from a clean slate — there is nothing to compensate for.
    let lastTransient: unknown;
    for (let attempt = 0; attempt < MAX_TRANSIENT_RETRIES; attempt += 1) {
      const outcome = await this.attemptTransfer(params);
      if (outcome !== TRANSIENT_RETRY) {
        return outcome;
      }
      lastTransient = outcome;

      // Exponential backoff with full jitter. Jitter matters more than the
      // backoff: without it, every victim of the same pile-up retries in
      // lockstep and reproduces the same collision.
      const backoffMs = Math.min(2 ** attempt * 5, 80);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * backoffMs));
    }

    this.logger.error(
      `Transfer exhausted ${MAX_TRANSIENT_RETRIES} retries under contention (${String(lastTransient)})`,
    );
    return { ok: false, reason: 'INTERNAL_ERROR' };
  }

  /** One attempt at the atomic unit. Returns TRANSIENT_RETRY if worth retrying. */
  private async attemptTransfer(params: {
    senderUserId: string;
    receiver: ReceiverIdentifier;
    amountPoisha: bigint;
    idempotencyKey: string;
    requestHash: string;
    note?: string | undefined;
    idempotencyTtlMs: number;
  }): Promise<AtomicTransferOutcome | typeof TRANSIENT_RETRY> {
    const { senderUserId, receiver, amountPoisha, idempotencyKey, requestHash, note } = params;

    try {
      return await this.prisma.client.$transaction(
        async (tx): Promise<AtomicTransferOutcome> => {
          // ---------------------------------------------------------------
          // 1. Resolve both accounts (unlocked — we only need their IDs yet).
          // ---------------------------------------------------------------
          const senderRows = await tx.$queryRaw<ResolvedAccountRow[]>`
            SELECT a."id" AS account_id, a."user_id" AS user_id, a."status"::text AS status
            FROM "accounts" a
            WHERE a."user_id" = ${senderUserId}::uuid
            LIMIT 1
          `;
          const senderRow = senderRows[0];
          if (senderRow === undefined) {
            throw new TransferAbort('INTERNAL_ERROR');
          }

          const receiverRow = await this.resolveReceiver(tx, receiver);
          if (receiverRow === undefined) {
            throw new TransferAbort('RECEIVER_NOT_FOUND', senderRow.account_id);
          }

          const senderAccountId = senderRow.account_id;
          const receiverAccountId = receiverRow.account_id;

          // Self-transfer (FR-08). Checked before locking: taking a lock twice
          // on the same row would otherwise self-deadlock on some plans, and
          // there is nothing to learn from locking to reject this.
          if (senderAccountId === receiverAccountId) {
            throw new TransferAbort('SELF_TRANSFER', senderAccountId, receiverAccountId);
          }

          // ---------------------------------------------------------------
          // 2. Claim the idempotency key FIRST.
          //
          // The UNIQUE (user_id, key) index does the deduplication (NFR-B).
          // Placing this before the account locks means a concurrent duplicate
          // blocks here — on the index — and never acquires an account lock at
          // all. When the first transaction commits, the duplicate's INSERT
          // fails with a unique violation, which we translate into
          // IDEMPOTENT_REPLAY so the caller reads back the stored response.
          //
          // "Check whether the key exists, then insert" would be a race. The
          // constraint violation IS the mechanism.
          // ---------------------------------------------------------------
          await tx.idempotencyKey.create({
            data: {
              key: idempotencyKey,
              userId: senderUserId,
              operation: 'POST /transfers',
              requestHash,
              state: 'IN_PROGRESS',
              expiresAt: new Date(Date.now() + params.idempotencyTtlMs),
            },
          });

          // Account status is read unlocked, purely to produce a precise error
          // message. It is NOT the authoritative check — `status = 'ACTIVE'` is
          // repeated in the WHERE clause of each balance update below, where it
          // is evaluated atomically with the write.
          if (senderRow.status !== 'ACTIVE') {
            throw new TransferAbort('SENDER_ACCOUNT_FROZEN', senderAccountId, receiverAccountId);
          }
          if (receiverRow.status !== 'ACTIVE') {
            throw new TransferAbort('RECEIVER_ACCOUNT_FROZEN', senderAccountId, receiverAccountId);
          }

          // ---------------------------------------------------------------
          // 3. Move the money, locking rows in ascending UUID order.
          //
          // Each balance change is a single conditional UPDATE. That statement
          // *is* the lock: PostgreSQL takes a row-exclusive lock and evaluates
          // the WHERE clause atomically with the write, so the balance check and
          // the deduction cannot be split by a concurrent transaction. A
          // read-then-write in application code can be split, and that gap is
          // the classic double-spend.
          //
          // Applying the two updates in ascending account-UUID order — rather
          // than sender-then-receiver — is what keeps A→B and B→A from
          // deadlocking: every transfer in the system, in either direction,
          // takes its row locks in the same global order.
          //
          // An earlier version issued two extra `SELECT ... FOR UPDATE`
          // statements before these updates. They were redundant (the
          // conditional UPDATE already locks and already re-checks) and they
          // were actively harmful: they doubled the number of round trips
          // during which locks were held, which measurably increased deadlock
          // rate under the 50-way concurrency test. Fewer statements inside the
          // lock window is not a micro-optimisation here, it is the difference
          // between the test passing and flaking.
          // ---------------------------------------------------------------
          const debit = async (): Promise<bigint> => {
            const rows = await tx.$queryRaw<{ balance_poisha: string }[]>`
              UPDATE "accounts"
                 SET "balance_poisha" = "balance_poisha" - ${amountPoisha}::bigint,
                     "updated_at"     = now()
               WHERE "id" = ${senderAccountId}::uuid
                 AND "status" = 'ACTIVE'
                 AND "balance_poisha" >= ${amountPoisha}::bigint
              RETURNING "balance_poisha"::text AS balance_poisha
            `;
            const row = rows[0];
            if (row === undefined) {
              // The guard matched nothing: the balance moved beneath us, or the
              // account was frozen between the read above and this write.
              throw new TransferAbort('INSUFFICIENT_FUNDS', senderAccountId, receiverAccountId);
            }
            return BigInt(row.balance_poisha);
          };

          const credit = async (): Promise<bigint> => {
            const rows = await tx.$queryRaw<{ balance_poisha: string }[]>`
              UPDATE "accounts"
                 SET "balance_poisha" = "balance_poisha" + ${amountPoisha}::bigint,
                     "updated_at"     = now()
               WHERE "id" = ${receiverAccountId}::uuid
                 AND "status" = 'ACTIVE'
              RETURNING "balance_poisha"::text AS balance_poisha
            `;
            const row = rows[0];
            if (row === undefined) {
              throw new TransferAbort(
                'RECEIVER_ACCOUNT_FROZEN',
                senderAccountId,
                receiverAccountId,
              );
            }
            return BigInt(row.balance_poisha);
          };

          // Whichever account sorts first is written first. If the debit runs
          // second and fails, the credit that already ran is rolled back with
          // the rest of the transaction — atomicity makes the order safe to
          // choose on lock-ordering grounds alone.
          let senderBalanceAfter: bigint;
          let receiverBalanceAfter: bigint;
          if (senderAccountId < receiverAccountId) {
            senderBalanceAfter = await debit();
            receiverBalanceAfter = await credit();
          } else {
            receiverBalanceAfter = await credit();
            senderBalanceAfter = await debit();
          }
          const completedAt = new Date();
          const reference = generateReference('TXN');

          // ---------------------------------------------------------------
          // 6. Record the event and its double-entry lines.
          //
          // Note the status is SUCCESS, not COMPLETED — that is the name in the
          // TransactionStatus enum, and it is referenced by the
          // chk_transactions_status_shape CHECK constraint.
          // ---------------------------------------------------------------
          const transaction = await tx.transaction.create({
            data: {
              reference,
              type: 'TRANSFER',
              status: 'SUCCESS',
              amountPoisha,
              senderAccountId,
              receiverAccountId,
              note: note ?? null,
              completedAt,
            },
          });

          // Exactly one DEBIT and one CREDIT, equal in magnitude. Amounts are
          // always positive; direction carries the sign.
          await tx.ledgerEntry.createMany({
            data: [
              {
                transactionId: transaction.id,
                accountId: senderAccountId,
                direction: 'DEBIT',
                amountPoisha,
                balanceAfterPoisha: senderBalanceAfter,
              },
              {
                transactionId: transaction.id,
                accountId: receiverAccountId,
                direction: 'CREDIT',
                amountPoisha,
                balanceAfterPoisha: receiverBalanceAfter,
              },
            ],
          });

          // ---------------------------------------------------------------
          // 7. Store the response for replay, in the same transaction.
          // ---------------------------------------------------------------
          await tx.idempotencyKey.update({
            where: { userId_key: { userId: senderUserId, key: idempotencyKey } },
            data: {
              state: 'COMPLETED',
              responseStatus: 201,
              responseBody: {
                reference,
                transactionId: transaction.id,
                amountPoisha: amountPoisha.toString(),
                senderBalancePoisha: senderBalanceAfter.toString(),
                receiverBalancePoisha: receiverBalanceAfter.toString(),
                completedAt: completedAt.toISOString(),
              },
              transactionId: transaction.id,
            },
          });

          return {
            ok: true,
            reference,
            transactionId: transaction.id,
            senderAccountId,
            receiverAccountId,
            senderBalancePoisha: senderBalanceAfter,
            receiverBalancePoisha: receiverBalanceAfter,
            completedAt,
          };
        },
        {
          // READ COMMITTED — see the method comment for why not SERIALIZABLE.
          isolationLevel: 'ReadCommitted',
          // A transfer that cannot get its locks within 10s is pathological;
          // failing is better than holding a connection indefinitely.
          timeout: 10_000,
          maxWait: 10_000,
        },
      );
    } catch (error) {
      if (error instanceof TransferAbort) {
        // The transaction has rolled back. No balance moved, no ledger row
        // exists — which is exactly what proves the failure was clean (FR-21).
        return {
          ok: false,
          reason: error.reason,
          ...(error.senderAccountId !== undefined
            ? { senderAccountId: error.senderAccountId }
            : {}),
          ...(error.receiverAccountId !== undefined
            ? { receiverAccountId: error.receiverAccountId }
            : {}),
        };
      }

      if (this.isTransient(error)) {
        // Not the caller's fault and not a rejection — the engine aborted us to
        // break a lock cycle. The transaction rolled back whole, so retrying is
        // safe and is what PostgreSQL expects an application to do.
        return TRANSIENT_RETRY;
      }

      if (this.isUniqueViolation(error)) {
        // A concurrent request with the same idempotency key committed first.
        // The money has already moved exactly once; the caller re-reads the
        // stored response rather than retrying.
        return { ok: false, reason: 'IDEMPOTENT_REPLAY' };
      }

      this.logger.error(
        `Transfer failed unexpectedly: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return { ok: false, reason: 'INTERNAL_ERROR' };
    }
  }

  /** Resolves a recipient from whichever identifier the caller supplied (FR-05). */
  private async resolveReceiver(
    tx: {
      $queryRaw: PrismaService['client']['$queryRaw'];
    },
    receiver: ReceiverIdentifier,
  ): Promise<ResolvedAccountRow | undefined> {
    const { kind, value } = receiver;

    // Lookups are case-insensitive for username and email, matching the
    // uq_users_email_lower / uq_users_username_lower unique indexes — so a user
    // can be found the way they would actually type it.
    const rows =
      kind === 'userId'
        ? await tx.$queryRaw<ResolvedAccountRow[]>`
            SELECT a."id" AS account_id, a."user_id" AS user_id, a."status"::text AS status
            FROM "accounts" a
            JOIN "users" u ON u."id" = a."user_id"
            WHERE u."id" = ${value}::uuid AND u."status" = 'ACTIVE'
            LIMIT 1`
        : kind === 'username'
          ? await tx.$queryRaw<ResolvedAccountRow[]>`
            SELECT a."id" AS account_id, a."user_id" AS user_id, a."status"::text AS status
            FROM "accounts" a
            JOIN "users" u ON u."id" = a."user_id"
            WHERE lower(u."username") = lower(${value}) AND u."status" = 'ACTIVE'
            LIMIT 1`
          : kind === 'email'
            ? await tx.$queryRaw<ResolvedAccountRow[]>`
            SELECT a."id" AS account_id, a."user_id" AS user_id, a."status"::text AS status
            FROM "accounts" a
            JOIN "users" u ON u."id" = a."user_id"
            WHERE lower(u."email") = lower(${value}) AND u."status" = 'ACTIVE'
            LIMIT 1`
            : await tx.$queryRaw<ResolvedAccountRow[]>`
            SELECT a."id" AS account_id, a."user_id" AS user_id, a."status"::text AS status
            FROM "accounts" a
            JOIN "users" u ON u."id" = a."user_id"
            WHERE u."phone" = ${value} AND u."status" = 'ACTIVE'
            LIMIT 1`;

    return rows[0];
  }

  /**
   * Reads a previously stored idempotent result (NFR-B).
   *
   * Called before the transaction as a fast path, and again after an
   * IDEMPOTENT_REPLAY to fetch the winner's response.
   */
  async findCachedIdempotentResult(
    userId: string,
    key: string,
  ): Promise<CachedIdempotentResult | null> {
    const row = await this.prisma.client.idempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
      select: {
        requestHash: true,
        state: true,
        responseStatus: true,
        responseBody: true,
        transactionId: true,
      },
    });
    if (row === null) return null;

    return {
      requestHash: row.requestHash,
      state: row.state,
      responseStatus: row.responseStatus,
      responseBody: row.responseBody,
      transactionId: row.transactionId,
    };
  }

  /**
   * Writes a FAILED transaction record for audit (FR-12, FR-21).
   *
   * Deliberately a **separate** transaction: the failing transfer has already
   * rolled back, so writing this inside it would roll back too and the attempt
   * would leave no trace. The row has no ledger entries, and that absence is
   * the proof that no balance moved.
   */
  async recordFailedTransaction(params: {
    senderAccountId: string;
    receiverAccountId?: string | undefined;
    amountPoisha: bigint;
    reason: TransferFailureReason;
    note?: string | undefined;
  }): Promise<{ reference: string; transactionId: string } | null> {
    try {
      const reference = generateReference('TXN');

      // A self-transfer would violate chk_transactions_no_self_transfer, so the
      // audit row for one records a NULL receiver. The constraint is not
      // weakened to accommodate the audit: `failure_reason = 'SELF_TRANSFER'`
      // already says precisely what was attempted, and letting sender =
      // receiver into the table — even on a FAILED row — would mean the
      // constraint no longer guarantees what it claims.
      const receiverAccountId =
        params.receiverAccountId === params.senderAccountId
          ? null
          : (params.receiverAccountId ?? null);

      const row = await this.prisma.client.transaction.create({
        data: {
          reference,
          type: 'TRANSFER',
          status: 'FAILED',
          amountPoisha: params.amountPoisha,
          senderAccountId: params.senderAccountId,
          receiverAccountId,
          failureReason: params.reason,
          note: params.note ?? null,
          completedAt: new Date(),
        },
        select: { id: true },
      });
      return { reference, transactionId: row.id };
    } catch (error) {
      // Audit logging must never turn a clean rejection into a 500. The
      // user-facing outcome is unchanged; we log and move on.
      this.logger.error(
        `Could not record FAILED transaction: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return null;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    return code === PRISMA_UNIQUE_VIOLATION || code === PG_UNIQUE_VIOLATION;
  }

  /**
   * Whether an error is a transient serialization failure worth retrying.
   *
   * Prisma wraps the driver error, so the SQLSTATE is often only present in the
   * message text rather than on a `code` property. Both are checked: missing a
   * retryable error would surface an internal error to a user whose request was
   * perfectly valid.
   */
  private isTransient(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;

    const code = (error as { code?: unknown }).code;
    if (
      code === PG_DEADLOCK_DETECTED ||
      code === PG_SERIALIZATION_FAILURE ||
      code === PRISMA_TRANSACTION_CONFLICT
    ) {
      return true;
    }

    const message = (error as { message?: unknown }).message;
    if (typeof message !== 'string') return false;
    return (
      message.includes(PG_DEADLOCK_DETECTED) ||
      message.includes(PG_SERIALIZATION_FAILURE) ||
      message.includes('deadlock detected') ||
      message.includes('could not serialize access') ||
      message.includes('write conflict or a deadlock')
    );
  }
}
