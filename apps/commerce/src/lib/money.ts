/**
 * OMR money arithmetic.
 *
 * The Omani rial has THREE decimal places: 1 OMR = 1000 baisa. Every amount in
 * this system is an integer count of baisa held in a `bigint`. Floats never
 * touch money — `0.1 + 0.2` problems are not acceptable in a price ticker that
 * sums four slot prices on every pointer move.
 */

export const BAISA_PER_OMR = 1000n;

/** Smallest increment some card rails will accept for a 3-decimal currency. */
export const GATEWAY_INCREMENT_BAISA = 10n;

export class MoneyError extends Error {}

/** Parses a value that arrived as JSON (string | number) into baisa. */
export function toBaisa(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new MoneyError(`Non-integer baisa amount: ${value}`);
    }
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) {
    throw new MoneyError(`Unparseable baisa amount: ${value}`);
  }
  return BigInt(value);
}

export function sumBaisa(amounts: readonly bigint[]): bigint {
  return amounts.reduce((total, amount) => total + amount, 0n);
}

/**
 * Rounds half-up (away from zero) to a gateway-acceptable increment.
 *
 * Apply this ONCE, to the order grand total, at checkout-session creation.
 * Rounding per line item makes the parts disagree with the whole: four slot
 * prices of 755 baisa each round to 760 × 4 = 3040, while the true total of
 * 3020 rounds to 3020.
 */
export function roundToIncrement(
  amount: bigint,
  increment: bigint = GATEWAY_INCREMENT_BAISA,
): bigint {
  if (increment <= 0n) {
    throw new MoneyError(`Increment must be positive, got ${increment}`);
  }
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;

  const remainder = magnitude % increment;
  if (remainder === 0n) return amount;

  const down = magnitude - remainder;
  const rounded = remainder * 2n >= increment ? down + increment : down;

  return negative ? -rounded : rounded;
}

/**
 * The delta to persist in `orders.rounding_adjustment_baisa` so the invoice
 * reconciles: subtotal + shipping + vat + adjustment === charged total.
 */
export function roundingAdjustment(
  exactTotal: bigint,
  increment: bigint = GATEWAY_INCREMENT_BAISA,
): bigint {
  return roundToIncrement(exactTotal, increment) - exactTotal;
}

/**
 * Oman VAT is 5%. Computed on the integer subtotal and rounded half-up to the
 * baisa — never carried as a float.
 */
export function vatBaisa(taxableBaisa: bigint, ratePercent = 5n): bigint {
  const scaled = taxableBaisa * ratePercent;
  const whole = scaled / 100n;
  const remainder = scaled % 100n;
  return remainder * 2n >= 100n ? whole + 1n : whole;
}

/**
 * Display formatting.
 *
 * `numberingSystem: 'latn'` is deliberate: Omani price displays conventionally
 * use Latin digits even in Arabic copy, and the default for `ar` locales is
 * Eastern Arabic numerals (٠١٢).
 */
export function formatOmr(baisa: bigint, locale: 'ar' | 'en' = 'en'): string {
  const formatter = new Intl.NumberFormat(locale === 'ar' ? 'ar-OM' : 'en-OM', {
    style: 'currency',
    currency: 'OMR',
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
    numberingSystem: 'latn',
  });
  // Safe for any realistic order value; OMR amounts far below 2^53 baisa.
  return formatter.format(Number(baisa) / Number(BAISA_PER_OMR));
}
