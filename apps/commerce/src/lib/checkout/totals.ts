import { roundToIncrement, vatBaisa, GATEWAY_INCREMENT_BAISA } from '../money';

/**
 * Order totals.
 *
 * The single place rounding happens. Line items keep their exact baisa prices;
 * only the grand total is snapped to a gateway-acceptable increment, and the
 * delta is persisted so `subtotal + shipping + vat + adjustment === total`
 * holds exactly — a constraint the `orders` table also enforces.
 */

export type TotalsInput = {
  subtotalBaisa: bigint;
  shippingBaisa: bigint;
  /** Oman VAT, 5% by default. Zero-rate by passing 0n. */
  vatRatePercent?: bigint;
  /** Whether shipping is taxable. In Oman it generally is. */
  taxShipping?: boolean;
  /** Set to 1n to disable gateway rounding (e.g. cash on delivery). */
  incrementBaisa?: bigint;
};

export type Totals = {
  subtotalBaisa: bigint;
  shippingBaisa: bigint;
  vatBaisa: bigint;
  roundingAdjustmentBaisa: bigint;
  totalBaisa: bigint;
};

export function computeTotals({
  subtotalBaisa,
  shippingBaisa,
  vatRatePercent = 5n,
  taxShipping = true,
  incrementBaisa = GATEWAY_INCREMENT_BAISA,
}: TotalsInput): Totals {
  if (subtotalBaisa < 0n || shippingBaisa < 0n) {
    throw new RangeError('Negative amounts are not valid order totals');
  }

  const taxable = taxShipping ? subtotalBaisa + shippingBaisa : subtotalBaisa;
  const vat = vatBaisa(taxable, vatRatePercent);

  const exact = subtotalBaisa + shippingBaisa + vat;
  const charged = roundToIncrement(exact, incrementBaisa);

  return {
    subtotalBaisa,
    shippingBaisa,
    vatBaisa: vat,
    roundingAdjustmentBaisa: charged - exact,
    totalBaisa: charged,
  };
}

/** The invariant `orders.totals_reconcile` checks. Useful in tests. */
export function totalsReconcile(totals: Totals): boolean {
  return (
    totals.totalBaisa ===
    totals.subtotalBaisa +
      totals.shippingBaisa +
      totals.vatBaisa +
      totals.roundingAdjustmentBaisa
  );
}
