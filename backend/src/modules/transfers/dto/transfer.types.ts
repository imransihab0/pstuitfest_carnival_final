/**
 * The contract between TransferService (domain) and TransferRepository
 * (persistence).
 *
 * The important convention: **the repository returns data, never decisions.**
 * It reports `{ ok: false, reason: 'INSUFFICIENT_FUNDS' }`; deciding what that
 * means — which HTTP status, whether to audit it, what to tell the user — is
 * the service's job.
 *
 * This matters because some validation genuinely has to happen inside the
 * locked transaction (a balance check outside the lock is worthless), which
 * puts it physically in the repository. Returning a discriminated result keeps
 * that from turning into domain logic leaking downward.
 */

/** Stable failure codes. Mirrors the `TransactionFailureReason` DB enum. */
export type TransferFailureReason =
  | 'INSUFFICIENT_FUNDS'
  | 'SELF_TRANSFER'
  | 'INVALID_AMOUNT'
  | 'LIMIT_EXCEEDED'
  | 'SENDER_ACCOUNT_FROZEN'
  | 'RECEIVER_ACCOUNT_FROZEN'
  | 'RECEIVER_NOT_FOUND'
  | 'REQUEST_NOT_PENDING'
  | 'INTERNAL_ERROR';

/** How a recipient was named by the caller. Resolved server-side. */
export interface ReceiverIdentifier {
  readonly kind: 'userId' | 'username' | 'email' | 'phone';
  readonly value: string;
}

export interface ExecuteTransferCommand {
  readonly senderUserId: string;
  readonly receiver: ReceiverIdentifier;
  readonly amountPoisha: bigint;
  readonly idempotencyKey: string;
  readonly note?: string | undefined;
}

/** A successful, committed transfer. */
export interface TransferSuccess {
  readonly ok: true;
  readonly reference: string;
  readonly transactionId: string;
  readonly amountPoisha: bigint;
  readonly senderBalancePoisha: bigint;
  readonly receiverBalancePoisha: bigint;
  readonly completedAt: Date;
  /** True when this response was replayed from a stored idempotent result. */
  readonly replayed: boolean;
}

/** A rejected transfer. No money moved. */
export interface TransferFailure {
  readonly ok: false;
  readonly reason: TransferFailureReason;
  /** Present when a FAILED audit record was written (FR-21). */
  readonly reference?: string;
  readonly transactionId?: string;
}

export type TransferResult = TransferSuccess | TransferFailure;

/**
 * Outcome of the atomic database unit. Distinct from `TransferResult` because
 * the repository additionally reports which accounts it touched, so the service
 * can write an accurate audit record after a rollback.
 */
export type AtomicTransferOutcome =
  | {
      readonly ok: true;
      readonly reference: string;
      readonly transactionId: string;
      readonly senderAccountId: string;
      readonly receiverAccountId: string;
      readonly senderBalancePoisha: bigint;
      readonly receiverBalancePoisha: bigint;
      readonly completedAt: Date;
    }
  | {
      readonly ok: false;
      readonly reason: TransferFailureReason;
      readonly senderAccountId?: string;
      readonly receiverAccountId?: string;
    }
  /**
   * A concurrent duplicate of the same idempotency key won the race. The caller
   * should re-read the stored result rather than retry the transfer — the money
   * has already moved exactly once.
   */
  | { readonly ok: false; readonly reason: 'IDEMPOTENT_REPLAY' };

/** A previously stored idempotent response. */
export interface CachedIdempotentResult {
  readonly requestHash: string;
  readonly state: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  readonly responseStatus: number | null;
  readonly responseBody: unknown;
  readonly transactionId: string | null;
}
