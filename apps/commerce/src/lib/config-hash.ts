/**
 * Stable content hash for a composite build.
 *
 * Two users who assemble the same box must produce the same hash, so the same
 * `composite_configurations` row is reused rather than duplicated. That means
 * canonicalisation has to be total: slot order, key order, and the default
 * quantity all have to collapse to one representation before hashing.
 *
 * Uses WebCrypto so the identical implementation runs in the browser (client
 * estimate) and in a Route Handler (server re-validation). A mismatch between
 * the two is a rejected request, never a silently accepted price.
 */

export type SlotEntry = {
  slot_index: number;
  raw_material_id: string;
  qty?: number | undefined;
};

/**
 * Declared as a type alias rather than an interface on purpose: TypeScript
 * grants implicit index signatures to anonymous object types but not to
 * interfaces, and postgres.js's `sql.json()` parameter requires one.
 */
export type CanonicalSlotEntry = {
  slot_index: number;
  raw_material_id: string;
  qty: number;
};

/** Sorts by slot_index and materialises the implicit `qty: 1`. */
export function canonicalizeSlotMap(entries: readonly SlotEntry[]): CanonicalSlotEntry[] {
  return entries
    .map((entry) => ({
      slot_index: entry.slot_index,
      raw_material_id: entry.raw_material_id.toLowerCase(),
      qty: entry.qty ?? 1,
    }))
    .sort((a, b) => a.slot_index - b.slot_index);
}

/**
 * Canonical JSON: fixed key order within each entry, so a client that happens
 * to serialise keys differently still hashes identically.
 */
export function canonicalJson(
  compositeProductId: string,
  entries: readonly SlotEntry[],
): string {
  const canonical = canonicalizeSlotMap(entries).map(
    (e) => `{"slot_index":${e.slot_index},"raw_material_id":"${e.raw_material_id}","qty":${e.qty}}`,
  );
  return `${compositeProductId.toLowerCase()}|[${canonical.join(',')}]`;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Returns `sha256:<64 hex chars>`. */
export async function configHash(
  compositeProductId: string,
  entries: readonly SlotEntry[],
): Promise<string> {
  const payload = new TextEncoder().encode(canonicalJson(compositeProductId, entries));
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return `sha256:${toHex(digest)}`;
}

export const CONFIG_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
