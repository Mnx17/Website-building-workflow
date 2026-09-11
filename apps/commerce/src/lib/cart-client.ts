'use client';

import { configHash, type SlotEntry } from './config-hash';

const CART_STORAGE_KEY = 'sweets.cart_id';

function readStoredCartId(): string | null {
  try {
    return localStorage.getItem(CART_STORAGE_KEY);
  } catch {
    // Private mode / blocked storage. Fall back to a per-session cart.
    return null;
  }
}

function storeCartId(cartId: string): void {
  try {
    localStorage.setItem(CART_STORAGE_KEY, cartId);
  } catch {
    /* non-fatal */
  }
}

export async function getOrCreateCartId(): Promise<string> {
  const existing = readStoredCartId();
  if (existing) return existing;

  const response = await fetch('/api/cart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ anon_token: crypto.randomUUID() }),
  });
  if (!response.ok) throw new Error(`Could not create cart: ${response.status}`);

  const body = (await response.json()) as { cart_id: string };
  storeCartId(body.cart_id);
  return body.cart_id;
}

export type AddResult = {
  item_id: string;
  configuration_id: string;
  unit_price_baisa: bigint;
  /** True when the server's price differed from the estimate we sent. */
  repriced: boolean;
};

/**
 * Sends the build to the cart.
 *
 * The hash is recomputed here from the same canonicalisation the server uses;
 * the server verifies it and rejects a mismatch, so a tampered slot map cannot
 * be stored under the hash of a cheaper build. `client_estimate` is advisory —
 * the server prices the build itself and the response tells us if it differed.
 */
export async function addCompositeToCart(params: {
  compositeProductId: string;
  slotMap: readonly SlotEntry[];
  estimateBaisa: bigint;
  estimateGrams: number;
  qty?: number;
  locale?: 'ar' | 'en';
}): Promise<AddResult> {
  const cartId = await getOrCreateCartId();
  const hash = await configHash(params.compositeProductId, params.slotMap);

  const response = await fetch(`/api/cart/${cartId}/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'composite',
      composite_product_id: params.compositeProductId,
      slot_map: params.slotMap,
      config_hash: hash,
      client_estimate: {
        unit_price_baisa: params.estimateBaisa.toString(),
        total_weight_grams: params.estimateGrams,
      },
      qty: params.qty ?? 1,
    }),
  });

  const body = (await response.json()) as {
    item_id?: string;
    configuration_id?: string;
    unit_price_baisa?: string;
    repriced?: boolean;
    error?: string;
    message?: string;
  };

  if (!response.ok) {
    // Surface the server's domain code (OUT_OF_STOCK, HASH_MISMATCH, …) so the
    // UI can say something specific rather than "something went wrong".
    throw new Error(body.error ?? `ADD_FAILED:${response.status}`);
  }

  return {
    item_id: body.item_id!,
    configuration_id: body.configuration_id!,
    unit_price_baisa: BigInt(body.unit_price_baisa ?? '0'),
    repriced: body.repriced ?? false,
  };
}
