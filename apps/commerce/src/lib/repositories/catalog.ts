import type postgres from 'postgres';
import type {
  CompositeProductWire,
  MaterialWire,
  Slot,
  SlotPosition,
} from '../configurator/types';

/**
 * Catalogue reads for the configurator route (RSC).
 *
 * Availability is exposed as `stock_qty - reserved_qty` rather than the raw
 * columns: the tray needs to know whether a material can be picked up, not
 * what the warehouse holds.
 */
export async function loadCompositeProduct(
  sql: postgres.ISql,
  slug: string,
): Promise<CompositeProductWire | null> {
  const [product] = await sql<
    {
      id: string;
      slug: string;
      kind: 'box' | 'bouquet';
      name_en: string;
      name_ar: string;
      base_price_baisa: string;
      base_weight_grams: number;
      model_url: string;
      slot_count: number;
      min_filled_slots: number;
    }[]
  >`
    select id, slug, kind, name_en, name_ar, base_price_baisa,
           base_weight_grams, model_url, slot_count, min_filled_slots
      from composite_products
     where slug = ${slug} and is_active
  `;
  if (!product) return null;

  const slotRows = await sql<
    {
      id: string;
      slot_index: number;
      label_en: string | null;
      label_ar: string | null;
      position: SlotPosition;
      allowed_categories: string[];
      max_qty: number;
      is_required: boolean;
    }[]
  >`
    select id, slot_index, label_en, label_ar, position,
           allowed_categories, max_qty, is_required
      from composite_slots
     where composite_product_id = ${product.id}
     order by slot_index
  `;

  const slots: Slot[] = slotRows.map((row) => ({
    id: row.id,
    slot_index: row.slot_index,
    label_en: row.label_en,
    label_ar: row.label_ar,
    position: row.position,
    allowed_categories: row.allowed_categories,
    max_qty: row.max_qty,
    is_required: row.is_required,
  }));

  return { ...product, slots };
}

export async function loadMaterials(sql: postgres.ISql): Promise<MaterialWire[]> {
  const rows = await sql<
    {
      id: string;
      sku: string;
      name_en: string;
      name_ar: string;
      category: string;
      image_url: string | null;
      model_url: string | null;
      color_hex: string | null;
      unit_price_baisa: string;
      weight_grams: number;
      available: number;
    }[]
  >`
    select id, sku, name_en, name_ar, category, image_url, model_url, color_hex,
           unit_price_baisa, weight_grams,
           greatest(stock_qty - reserved_qty, 0) as available
      from raw_materials
     where is_active
     order by category, name_en
  `;
  return rows;
}
