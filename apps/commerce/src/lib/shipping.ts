import type postgres from 'postgres';

/**
 * Weight-based shipping.
 *
 * Composite weight is already materialised into
 * `composite_configurations.total_weight_grams` (shell + every raw material),
 * so aggregation here is plain arithmetic over cart lines rather than a second
 * bill-of-materials walk.
 */

export type ShippableItem = {
  unitWeightGrams: number;
  qty: number;
};

export type ShippingQuote = {
  zoneCode: string;
  zoneId: string;
  priceBaisa: bigint;
  totalWeightGrams: number;
  /** True when no zone claimed this governorate and the fallback was used. */
  usedFallback: boolean;
  codEnabled: boolean;
};

export function aggregateWeight(items: readonly ShippableItem[]): number {
  return items.reduce((grams, item) => grams + item.unitWeightGrams * item.qty, 0);
}

export class ShippingError extends Error {}

/**
 * Resolves governorate + weight to a rate.
 *
 * An exact zone match always beats the fallback; `priority` makes that
 * explicit rather than relying on row order. Every zone must carry a band
 * reaching the top of int4 — `assertShippingCoverage` enforces that, because a
 * heavy cart falling through the band lookup would 500 at checkout.
 */
export async function quoteShipping(
  sql: postgres.ISql,
  items: readonly ShippableItem[],
  governorate: string,
): Promise<ShippingQuote> {
  const totalWeightGrams = aggregateWeight(items);
  if (totalWeightGrams <= 0) {
    throw new ShippingError('EMPTY_CART');
  }

  const [row] = await sql<
    {
      zone_id: string;
      code: string;
      is_fallback: boolean;
      cod_enabled: boolean;
      price_baisa: string;
    }[]
  >`
    with candidate as (
      select id, code, is_fallback, cod_enabled,
             case when ${governorate} = any(governorates) then 0 else 1 end as priority
        from shipping_zones
       where ${governorate} = any(governorates) or is_fallback
       order by priority
       limit 1
    )
    select c.id as zone_id, c.code, c.is_fallback, c.cod_enabled, r.price_baisa
      from candidate c
      join shipping_rates r on r.zone_id = c.id
     where ${totalWeightGrams} >= r.min_grams
       and ${totalWeightGrams} <  r.max_grams
     limit 1
  `;

  if (!row) {
    throw new ShippingError(`NO_RATE_BAND:${governorate}:${totalWeightGrams}`);
  }

  return {
    zoneCode: row.code,
    zoneId: row.zone_id,
    priceBaisa: BigInt(row.price_baisa),
    totalWeightGrams,
    usedFallback: row.is_fallback,
    codEnabled: row.cod_enabled,
  };
}

/**
 * Seed-time / startup check: every zone needs an unbounded top band, or some
 * cart weight has no price. Run this in CI rather than discovering it when a
 * customer builds a heavy order.
 */
export async function assertShippingCoverage(sql: postgres.ISql): Promise<void> {
  const gaps = await sql<{ code: string }[]>`
    select z.code
      from shipping_zones z
     where not exists (
       select 1 from shipping_rates r
        where r.zone_id = z.id and r.max_grams = 2147483647
     )
  `;
  if (gaps.length > 0) {
    throw new ShippingError(
      `ZONES_WITHOUT_TOP_BAND:${gaps.map((gap) => gap.code).join(',')}`,
    );
  }
}
