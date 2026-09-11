/**
 * Client-side optimistic pricing and slot validation.
 *
 * This deliberately mirrors the rules in `price_configuration()`. It exists so
 * the price ticker updates on the same frame as the drop instead of waiting a
 * round trip — it is NOT an authority. The server recomputes and the client
 * replaces its estimate; only the server number reaches the cart.
 *
 * Pure functions, no React and no three.js, so the rules are unit-testable
 * without a browser.
 */
import type { CompositeProduct, Material, Placement, Slot } from './types';
import type { SlotEntry } from '../config-hash';

export type SlotMap = ReadonlyMap<number, Placement>;

export type Estimate = {
  unit_price_baisa: bigint;
  total_weight_grams: number;
  filled_slots: number;
};

export type ValidationFailure =
  | { code: 'SLOT_NOT_FOUND'; slot_index: number }
  | { code: 'MATERIAL_NOT_FOUND'; raw_material_id: string }
  | { code: 'CATEGORY_NOT_ALLOWED'; slot_index: number; category: string }
  | { code: 'SLOT_QTY_OUT_OF_RANGE'; slot_index: number }
  | { code: 'MIN_FILL_NOT_MET'; filled: number; required: number }
  | { code: 'REQUIRED_SLOT_EMPTY'; slot_index: number };

export function findSlot(product: CompositeProduct, slotIndex: number): Slot | undefined {
  return product.slots.find((slot) => slot.slot_index === slotIndex);
}

/**
 * Whether a material may be dropped into a slot. An empty `allowed_categories`
 * means any category, matching the DDL default.
 */
export function slotAccepts(
  slot: Slot,
  material: Material,
  occupant: Placement | undefined,
): boolean {
  if (occupant && occupant.qty >= slot.max_qty) return false;
  if (slot.allowed_categories.length === 0) return true;
  return slot.allowed_categories.includes(material.category);
}

export function estimate(
  product: CompositeProduct,
  slotMap: SlotMap,
  materials: ReadonlyMap<string, Material>,
): Estimate {
  let price = product.base_price_baisa;
  let weight = product.base_weight_grams;
  let filled = 0;

  for (const placement of slotMap.values()) {
    const material = materials.get(placement.raw_material_id);
    if (!material) continue;
    price += material.unit_price_baisa * BigInt(placement.qty);
    weight += material.weight_grams * placement.qty;
    filled += 1;
  }

  return { unit_price_baisa: price, total_weight_grams: weight, filled_slots: filled };
}

/**
 * Full validation, run before enabling add-to-cart. Returns every failure
 * rather than the first, so the UI can mark all offending slots at once.
 */
export function validate(
  product: CompositeProduct,
  slotMap: SlotMap,
  materials: ReadonlyMap<string, Material>,
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];

  for (const [slotIndex, placement] of slotMap) {
    const slot = findSlot(product, slotIndex);
    if (!slot) {
      failures.push({ code: 'SLOT_NOT_FOUND', slot_index: slotIndex });
      continue;
    }

    const material = materials.get(placement.raw_material_id);
    if (!material) {
      failures.push({ code: 'MATERIAL_NOT_FOUND', raw_material_id: placement.raw_material_id });
      continue;
    }

    if (placement.qty < 1 || placement.qty > slot.max_qty) {
      failures.push({ code: 'SLOT_QTY_OUT_OF_RANGE', slot_index: slotIndex });
    }

    if (
      slot.allowed_categories.length > 0 &&
      !slot.allowed_categories.includes(material.category)
    ) {
      failures.push({
        code: 'CATEGORY_NOT_ALLOWED',
        slot_index: slotIndex,
        category: material.category,
      });
    }
  }

  const filled = slotMap.size;
  if (filled < product.min_filled_slots) {
    failures.push({ code: 'MIN_FILL_NOT_MET', filled, required: product.min_filled_slots });
  }

  for (const slot of product.slots) {
    if (slot.is_required && !slotMap.has(slot.slot_index)) {
      failures.push({ code: 'REQUIRED_SLOT_EMPTY', slot_index: slot.slot_index });
    }
  }

  return failures;
}

/**
 * Serialises the store's slot map into the wire format.
 *
 * Sorted by slot_index — never by insertion order and never by DOM order, so
 * an RTL tray cannot change the payload or its hash.
 */
export function toSlotEntries(slotMap: SlotMap): SlotEntry[] {
  return [...slotMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([slot_index, placement]) => ({
      slot_index,
      raw_material_id: placement.raw_material_id,
      qty: placement.qty,
    }));
}
