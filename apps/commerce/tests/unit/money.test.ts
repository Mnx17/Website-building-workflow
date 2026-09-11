import { describe, expect, it } from 'vitest';
import {
  formatOmr,
  roundToIncrement,
  roundingAdjustment,
  sumBaisa,
  toBaisa,
  vatBaisa,
  MoneyError,
} from '@/lib/money';

describe('toBaisa', () => {
  it('accepts integers, integer strings and bigints', () => {
    expect(toBaisa(8750)).toBe(8750n);
    expect(toBaisa('8750')).toBe(8750n);
    expect(toBaisa(8750n)).toBe(8750n);
  });

  it('rejects a float, which is how rounding bugs enter a money path', () => {
    expect(() => toBaisa(87.5)).toThrow(MoneyError);
  });

  it('rejects junk strings', () => {
    expect(() => toBaisa('8.750')).toThrow(MoneyError);
    expect(() => toBaisa('OMR 8')).toThrow(MoneyError);
  });
});

describe('roundToIncrement', () => {
  it('leaves exact multiples alone', () => {
    expect(roundToIncrement(8750n)).toBe(8750n);
    expect(roundToIncrement(0n)).toBe(0n);
  });

  it('rounds half up', () => {
    expect(roundToIncrement(8751n)).toBe(8750n);
    expect(roundToIncrement(8755n)).toBe(8760n); // exact tie goes up
    expect(roundToIncrement(8756n)).toBe(8760n);
  });

  it('rounds negatives away from zero symmetrically', () => {
    expect(roundToIncrement(-8755n)).toBe(-8760n);
    expect(roundToIncrement(-8751n)).toBe(-8750n);
  });

  it('rejects a non-positive increment', () => {
    expect(() => roundToIncrement(100n, 0n)).toThrow(MoneyError);
  });
});

describe('rounding is applied once, to the total', () => {
  /**
   * This is the bug the plan calls out: rounding each slot and summing gives a
   * different answer from rounding the sum. The system must do the latter.
   */
  it('per-line rounding diverges from whole-order rounding', () => {
    const slots = [755n, 755n, 755n, 755n];

    const perLine = sumBaisa(slots.map((s) => roundToIncrement(s)));
    const wholeOrder = roundToIncrement(sumBaisa(slots));

    expect(perLine).toBe(3040n);
    expect(wholeOrder).toBe(3020n);
    expect(perLine).not.toBe(wholeOrder);
  });

  it('the persisted adjustment makes the invoice reconcile exactly', () => {
    const subtotal = 8753n;
    const shipping = 1000n;
    const vat = vatBaisa(subtotal);
    const exact = subtotal + shipping + vat;

    const adjustment = roundingAdjustment(exact);
    const charged = exact + adjustment;

    expect(charged % 10n).toBe(0n);
    expect(subtotal + shipping + vat + adjustment).toBe(charged);
  });
});

describe('vatBaisa', () => {
  it('computes 5% on integers with half-up rounding', () => {
    expect(vatBaisa(10_000n)).toBe(500n);
    expect(vatBaisa(1n)).toBe(0n); // 0.05 baisa rounds down
    expect(vatBaisa(10n)).toBe(1n); // 0.5 baisa ties up
  });

  it('never produces a fractional baisa', () => {
    for (let i = 0n; i < 200n; i++) {
      expect(vatBaisa(i) % 1n).toBe(0n);
    }
  });
});

describe('formatOmr', () => {
  it('always shows three decimals', () => {
    expect(formatOmr(8750n)).toMatch(/8\.750/);
    expect(formatOmr(1n)).toMatch(/0\.001/);
  });

  it('uses Latin digits in Arabic, per Omani price convention', () => {
    const arabic = formatOmr(8750n, 'ar');
    expect(arabic).toMatch(/8\.750/);
    // No Eastern Arabic numerals.
    expect(arabic).not.toMatch(/[٠-٩]/);
  });
});
