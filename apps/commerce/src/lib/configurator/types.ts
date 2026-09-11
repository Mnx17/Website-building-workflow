/**
 * Domain types for the configurator, mirroring the P1 schema.
 *
 * Everything the client needs to render and price a build, and nothing it
 * doesn't: stock counts are exposed as availability so the tray can grey out
 * a sold-out material without leaking exact inventory levels.
 */

export type CompositeKind = 'box' | 'bouquet';

/** 3D placement from `composite_slots.position`. */
export type SlotPosition = {
  x: number;
  y: number;
  z: number;
  ry?: number;
};

export type Slot = {
  id: string;
  slot_index: number;
  label_en: string | null;
  label_ar: string | null;
  position: SlotPosition;
  allowed_categories: string[];
  max_qty: number;
  is_required: boolean;
};

export type Material = {
  id: string;
  sku: string;
  name_en: string;
  name_ar: string;
  category: string;
  image_url: string | null;
  model_url: string | null;
  color_hex: string | null;
  unit_price_baisa: bigint;
  weight_grams: number;
  /** stock_qty - reserved_qty, clamped at 0. */
  available: number;
};

export type CompositeProduct = {
  id: string;
  slug: string;
  kind: CompositeKind;
  name_en: string;
  name_ar: string;
  base_price_baisa: bigint;
  base_weight_grams: number;
  model_url: string;
  slot_count: number;
  min_filled_slots: number;
  slots: Slot[];
};

/** What currently occupies a slot, keyed by slot_index in the store. */
export type Placement = {
  raw_material_id: string;
  qty: number;
};

export type SlotHighlight = 'valid' | 'invalid' | null;

/** Result of the authoritative server price call. */
export type ServerPricing = {
  unit_price_baisa: bigint;
  total_weight_grams: number;
  filled_slots: number;
  config_hash: string;
};

export type SyncState = 'idle' | 'syncing' | 'synced' | 'error';

export type Locale = 'ar' | 'en';

/**
 * Wire shapes for the RSC → client boundary.
 *
 * React's Flight serialisation is not a safe place to bet on `bigint`, and a
 * number would defeat the point of integer baisa. Money crosses as a decimal
 * string and is rehydrated below.
 */
export type MaterialWire = Omit<Material, 'unit_price_baisa'> & {
  unit_price_baisa: string;
};

export type CompositeProductWire = Omit<CompositeProduct, 'base_price_baisa'> & {
  base_price_baisa: string;
};

export function hydrateMaterial(wire: MaterialWire): Material {
  return { ...wire, unit_price_baisa: BigInt(wire.unit_price_baisa) };
}

export function hydrateProduct(wire: CompositeProductWire): CompositeProduct {
  return { ...wire, base_price_baisa: BigInt(wire.base_price_baisa) };
}

export function materialName(material: Material, locale: Locale): string {
  return locale === 'ar' ? material.name_ar : material.name_en;
}

export function slotLabel(slot: Slot, locale: Locale): string {
  const label = locale === 'ar' ? slot.label_ar : slot.label_en;
  return label ?? `${slot.slot_index + 1}`;
}
