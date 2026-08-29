import { createHash, randomBytes } from 'node:crypto';

/**
 * Crockford base32 — no I, L, O or U. Chosen so a reference read aloud over the
 * phone or typed from a screenshot cannot be misheard as a different, valid
 * reference.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Public, shareable identifier for a transaction or request, e.g.
 * `TXN-7GH2K9QWX4`.
 *
 * Random rather than sequential on purpose: a sequential reference leaks the
 * platform's transaction volume and lets one user guess another's reference.
 * 10 characters of base32 is ~50 bits, so collisions are negligible — and the
 * `reference` column is UNIQUE, so a collision fails loudly rather than
 * overwriting anything.
 */
export function generateReference(prefix: 'TXN' | 'REQ' | 'SPL', length = 10): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) {
    // Modulo bias across 256 → 32 is exactly zero: 256 is a multiple of 32.
    out += ALPHABET[byte % ALPHABET.length];
  }
  return `${prefix}-${out}`;
}

/**
 * Stable digest of a request payload, used to detect an idempotency key being
 * replayed with *different* content (NFR-B).
 *
 * Keys are sorted so that `{a,b}` and `{b,a}` hash identically — the same
 * request serialised in a different property order is the same request, and
 * treating it as a conflict would break honest clients.
 */
export function hashRequestPayload(payload: Record<string, string>): string {
  const canonical = Object.keys(payload)
    .sort()
    .map((key) => `${key}=${payload[key] ?? ''}`)
    .join('&');
  return createHash('sha256').update(canonical).digest('hex');
}
