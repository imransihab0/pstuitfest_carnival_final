/**
 * Money primitives.
 *
 * Money is an integer number of **poisha** (1 taka = 100 poisha), carried as
 * `bigint`. It is never a `number`: JavaScript's `number` is an IEEE-754 double,
 * which is exactly the representation this system exists to avoid. See the
 * header of `prisma/schema.prisma` for the full reasoning.
 *
 * The rule this module exists to enforce:
 *
 *     parse at the input edge  →  bigint everywhere  →  format at the output edge
 *
 * Nothing in between rounds, divides, or converts to a float.
 */

/** 1 taka = 100 poisha. */
export const POISHA_PER_TAKA = 100n;

/** The registration credit: ৳100,000.00 (FR-A). */
export const SIGNUP_BONUS_POISHA = 100_000n * POISHA_PER_TAKA;

/**
 * Per-transaction ceiling: ৳1,000,000.00. A sanity bound, not a business rule —
 * it turns an absurd amount into a clean rejection instead of a surprising
 * success.
 */
export const MAX_TRANSFER_POISHA = 1_000_000n * POISHA_PER_TAKA;

/** Why a string could not be parsed into an amount. */
export type MoneyParseError = 'NOT_A_NUMBER' | 'TOO_MANY_DECIMALS' | 'NEGATIVE' | 'OUT_OF_RANGE';

export type MoneyParseResult =
  | { readonly ok: true; readonly poisha: bigint }
  | { readonly ok: false; readonly error: MoneyParseError };

/** Optional sign, digits, optionally a dot and 1–2 decimal places. Nothing else. */
const TAKA_PATTERN = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a user-supplied taka string (`"1234.56"`) into integer poisha.
 *
 * Deliberately strict:
 *   - more than two decimal places is an **error**, not something to round.
 *     Silently rounding is how money gets created or destroyed one poisha at a
 *     time, and the user never finds out.
 *   - no exponent notation, no thousands separators, no whitespace tolerance
 *     beyond trimming. Ambiguous input is rejected rather than guessed at.
 *   - the string is parsed digit-by-digit into a bigint. It never becomes a
 *     `number`, so it cannot lose precision on the way in.
 */
export function parseTakaToPoisha(input: string): MoneyParseResult {
  const match = TAKA_PATTERN.exec(input.trim());
  if (match === null) {
    // Distinguish "1.234" from "abc" so the caller can explain the rejection.
    return /^-?\d+\.\d{3,}$/.test(input.trim())
      ? { ok: false, error: 'TOO_MANY_DECIMALS' }
      : { ok: false, error: 'NOT_A_NUMBER' };
  }

  const [, sign, whole = '0', decimals] = match;
  if (sign === '-') {
    return { ok: false, error: 'NEGATIVE' };
  }

  // Right-pad so "1.5" is 50 poisha, not 5.
  const fraction = (decimals ?? '').padEnd(2, '0');
  const poisha = BigInt(whole) * POISHA_PER_TAKA + BigInt(fraction);

  if (poisha > MAX_TRANSFER_POISHA) {
    return { ok: false, error: 'OUT_OF_RANGE' };
  }
  return { ok: true, poisha };
}

/**
 * Formats integer poisha for display: `10000000n` → `"৳100,000.00"`.
 *
 * This is the output edge — the only place a monetary value becomes a string
 * with a decimal point in it.
 */
export function formatPoisha(poisha: bigint, { symbol = true } = {}): string {
  const negative = poisha < 0n;
  const absolute = negative ? -poisha : poisha;

  const taka = absolute / POISHA_PER_TAKA;
  const fraction = absolute % POISHA_PER_TAKA;

  const grouped = taka.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${grouped}.${fraction.toString().padStart(2, '0')}`;

  return `${negative ? '-' : ''}${symbol ? '৳' : ''}${body}`;
}

/**
 * Serialises an amount for JSON.
 *
 * Amounts cross the API as **strings**, never as JSON numbers: a JSON number is
 * a double, so `10000000` would survive but a larger balance eventually would
 * not, and the client's `JSON.parse` would hand back a float either way. Sending
 * a string forces the consumer to be explicit.
 */
export function poishaToJson(poisha: bigint): string {
  return poisha.toString();
}

/** Whether an amount is a legal transfer value, before any account is consulted. */
export function isTransferableAmount(poisha: bigint): boolean {
  return poisha > 0n && poisha <= MAX_TRANSFER_POISHA;
}
