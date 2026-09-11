import { getSql } from '@/lib/db';
import { priceRequestSchema } from '@/lib/contracts';
import { priceConfiguration } from '@/lib/repositories/configurations';
import { configHash } from '@/lib/config-hash';
import { errorResponse, validationResponse } from '@/lib/errors';
import { jsonResponse, readJson } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Authoritative price for an in-progress build.
 *
 * The configurator shows its own optimistic total immediately and calls this
 * debounced (~400ms). Whatever this returns wins: the client replaces its
 * estimate, and only this number is allowed to reach the cart.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  const parsed = priceRequestSchema.safeParse(body);
  if (!parsed.success) {
    return validationResponse(parsed.error.issues);
  }

  try {
    const sql = getSql();
    const [pricing, hash] = await Promise.all([
      priceConfiguration(sql, parsed.data.composite_product_id, parsed.data.slot_map),
      configHash(parsed.data.composite_product_id, parsed.data.slot_map),
    ]);

    return jsonResponse({
      unit_price_baisa: pricing.unit_price_baisa,
      total_weight_grams: pricing.total_weight_grams,
      filled_slots: pricing.filled_slots,
      config_hash: hash,
      currency: 'OMR',
    });
  } catch (error) {
    return errorResponse(error);
  }
}
