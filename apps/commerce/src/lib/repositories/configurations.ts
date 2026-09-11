import type postgres from 'postgres';
import { configHash, canonicalizeSlotMap, type SlotEntry } from '../config-hash';

export interface ConfigurationPricing {
  unit_price_baisa: bigint;
  total_weight_grams: number;
  filled_slots: number;
}

export interface StoredConfiguration extends ConfigurationPricing {
  id: string;
  composite_product_id: string;
  config_hash: string;
}

/**
 * Authoritative price for a build. Read-only — safe to call on every debounced
 * keystroke from the configurator.
 */
export async function priceConfiguration(
  sql: postgres.ISql,
  compositeProductId: string,
  slotMap: readonly SlotEntry[],
): Promise<ConfigurationPricing> {
  const canonical = canonicalizeSlotMap(slotMap);
  const [row] = await sql<
    { unit_price_baisa: string; total_weight_grams: number; filled_slots: number }[]
  >`
    select (p).unit_price_baisa, (p).total_weight_grams, (p).filled_slots
      from price_configuration(${compositeProductId}, ${sql.json(canonical)}::jsonb) as p
  `;

  if (!row) {
    throw new Error('COMPOSITE_NOT_FOUND:price_configuration returned no row');
  }

  return {
    unit_price_baisa: BigInt(row.unit_price_baisa),
    total_weight_grams: row.total_weight_grams,
    filled_slots: row.filled_slots,
  };
}

/**
 * Verifies the client's hash against a server-side recomputation, then
 * persists (or reuses) the configuration row.
 *
 * The hash check is what stops a tampered slot_map from being stored under the
 * hash of a cheaper build.
 */
export async function upsertConfiguration(
  sql: postgres.ISql,
  compositeProductId: string,
  slotMap: readonly SlotEntry[],
  clientHash: string,
  createdBy: string | null = null,
): Promise<StoredConfiguration> {
  const expected = await configHash(compositeProductId, slotMap);
  if (expected !== clientHash) {
    throw new Error(`HASH_MISMATCH:${clientHash}`);
  }

  const canonical = canonicalizeSlotMap(slotMap);
  const [row] = await sql<
    {
      id: string;
      composite_product_id: string;
      config_hash: string;
      unit_price_baisa: string;
      total_weight_grams: number;
    }[]
  >`
    select (c).id, (c).composite_product_id, (c).config_hash,
           (c).unit_price_baisa, (c).total_weight_grams
      from upsert_configuration(
        ${compositeProductId}, ${sql.json(canonical)}::jsonb, ${expected}, ${createdBy}
      ) as c
  `;

  if (!row) {
    throw new Error('COMPOSITE_NOT_FOUND:upsert_configuration returned no row');
  }

  return {
    id: row.id,
    composite_product_id: row.composite_product_id,
    config_hash: row.config_hash,
    unit_price_baisa: BigInt(row.unit_price_baisa),
    total_weight_grams: row.total_weight_grams,
    filled_slots: canonical.length,
  };
}
