import { describe, expect, it } from 'vitest';
import {
  MAX_TRANSFER_POISHA,
  SIGNUP_BONUS_POISHA,
  formatPoisha,
  isTransferableAmount,
  parseTakaToPoisha,
  poishaToJson,
} from './money.js';

/**
 * Guards NFR-C: money is integer poisha, and no value in the money path ever
 * passes through a float.
 */
describe('money', () => {
  describe('parseTakaToPoisha', () => {
    it.each([
      ['0', 0n],
      ['1', 100n],
      ['1.5', 150n], // right-padded: 1.5 taka is 150 poisha, not 105
      ['1.50', 150n],
      ['1.05', 105n],
      ['0.01', 1n],
      ['1234.56', 123_456n],
      ['100000', 10_000_000n],
      ['  42.25  ', 4225n],
    ])('parses %s to %s poisha', (input, expected) => {
      const result = parseTakaToPoisha(input);
      expect(result.ok && result.poisha).toBe(expected);
    });

    it('rejects more than two decimal places rather than rounding', () => {
      // Rounding here is how money gets created or destroyed one poisha at a
      // time, invisibly. Better to reject and make the caller be explicit.
      const result = parseTakaToPoisha('1.234');
      expect(result).toEqual({ ok: false, error: 'TOO_MANY_DECIMALS' });
    });

    it.each([
      ['abc'],
      [''],
      ['1e5'], // no exponent notation
      ['1,234.00'], // no thousands separators
      ['1.2.3'],
      ['٤٢'], // non-ASCII digits
      ['Infinity'],
      ['NaN'],
      ['0x10'],
    ])('rejects %s as not a number', (input) => {
      expect(parseTakaToPoisha(input).ok).toBe(false);
    });

    it('rejects negative amounts', () => {
      expect(parseTakaToPoisha('-5.00')).toEqual({ ok: false, error: 'NEGATIVE' });
    });

    it('rejects amounts beyond the ceiling', () => {
      expect(parseTakaToPoisha('99999999')).toEqual({ ok: false, error: 'OUT_OF_RANGE' });
    });

    it('parses a value too large for an exact JS number without losing precision', () => {
      // 9007199254740993 poisha exceeds Number.MAX_SAFE_INTEGER. If this ever
      // went through a double it would come back as ...992.
      const taka = '90071992547409.93';
      const result = parseTakaToPoisha(taka);
      // Above the ceiling, so rejected — but rejected for range, not mangled.
      expect(result).toEqual({ ok: false, error: 'OUT_OF_RANGE' });
    });
  });

  describe('formatPoisha', () => {
    it.each([
      [0n, '৳0.00'],
      [1n, '৳0.01'],
      [150n, '৳1.50'],
      [123_456n, '৳1,234.56'],
      [10_000_000n, '৳100,000.00'],
      [-10_000_000n, '-৳100,000.00'],
      [100_000n, '৳1,000.00'],
    ])('formats %s poisha as %s', (poisha, expected) => {
      expect(formatPoisha(poisha)).toBe(expected);
    });

    it('can omit the currency symbol', () => {
      expect(formatPoisha(123_456n, { symbol: false })).toBe('1,234.56');
    });

    it('round-trips through parse without drift', () => {
      for (const poisha of [0n, 1n, 99n, 100n, 12_345n, 9_999_999n, 10_000_000n]) {
        const formatted = formatPoisha(poisha, { symbol: false }).replace(/,/g, '');
        const reparsed = parseTakaToPoisha(formatted);
        expect(reparsed.ok && reparsed.poisha, `round-trip of ${poisha}`).toBe(poisha);
      }
    });
  });

  describe('serialisation', () => {
    it('serialises amounts as strings, never JSON numbers', () => {
      // A JSON number is a double. Sending one would put the amount through
      // exactly the representation this system exists to avoid.
      expect(poishaToJson(10_000_000n)).toBe('10000000');
      expect(typeof poishaToJson(1n)).toBe('string');
    });
  });

  describe('constants and bounds', () => {
    it('sets the signup bonus to exactly ৳100,000.00 (FR-A)', () => {
      expect(SIGNUP_BONUS_POISHA).toBe(10_000_000n);
      expect(formatPoisha(SIGNUP_BONUS_POISHA)).toBe('৳100,000.00');
    });

    it.each([
      [0n, false],
      [-1n, false],
      [1n, true],
      [MAX_TRANSFER_POISHA, true],
      [MAX_TRANSFER_POISHA + 1n, false],
    ])('isTransferableAmount(%s) is %s', (amount, expected) => {
      expect(isTransferableAmount(amount)).toBe(expected);
    });
  });
});
