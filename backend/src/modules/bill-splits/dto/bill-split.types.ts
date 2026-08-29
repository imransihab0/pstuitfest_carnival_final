/**
 * The contract between BillSplitService (domain) and BillSplitRepository
 * (persistence). Same convention as transfers/dto/transfer.types.ts: the
 * repository reports data, never decisions.
 */

export interface CreateShareInput {
  readonly payerId: string;
  readonly amountPoisha: bigint;
}

export interface CreateSplitCommand {
  readonly creatorId: string;
  readonly totalAmountPoisha: bigint;
  readonly description?: string | undefined;
  readonly shares: readonly CreateShareInput[];
}

/** Cheap, pre-database validation failures, decided by the service. */
export type CreateSplitFailureReason =
  | 'INVALID_AMOUNT'
  | 'EMPTY_SHARES'
  | 'TOO_MANY_SHARES'
  | 'DUPLICATE_PAYER'
  | 'SELF_SHARE'
  | 'SHARE_TOTAL_MISMATCH'
  | 'PAYER_NOT_FOUND';

export type CreateSplitResult =
  | { readonly ok: true; readonly id: string; readonly reference: string }
  | { readonly ok: false; readonly reason: CreateSplitFailureReason };

/** Failures that can only be known once the share row is locked. */
export type PayShareFailureReason =
  | 'NOT_FOUND'
  | 'NOT_PENDING'
  | 'INSUFFICIENT_FUNDS'
  | 'PAYER_ACCOUNT_FROZEN'
  | 'CREATOR_ACCOUNT_FROZEN';

export type PayShareResult =
  | {
      readonly ok: true;
      readonly reference: string;
      readonly payerBalancePoisha: bigint;
      /** True when this payment was the last PENDING share — the split just settled. */
      readonly splitSettled: boolean;
    }
  | { readonly ok: false; readonly reason: PayShareFailureReason };
