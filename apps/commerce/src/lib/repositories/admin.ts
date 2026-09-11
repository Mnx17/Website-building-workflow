import type postgres from 'postgres';

/**
 * Audited catalogue writes.
 *
 * Every mutation records before/after in `admin_audit_log` inside the same
 * transaction as the change itself. If the audit insert fails, the change
 * fails — an unaudited edit is not an acceptable fallback, because the whole
 * point is answering "who dropped this price to 1 baisa, and when".
 */

export type AuditableEntity =
  | 'products'
  | 'raw_materials'
  | 'composite_products'
  | 'composite_slots'
  | 'themes';

/** Columns a client may set, per entity. Anything else is dropped, not trusted. */
const WRITABLE: Record<AuditableEntity, readonly string[]> = {
  products: [
    'slug', 'name_en', 'name_ar', 'description_en', 'description_ar',
    'image_urls', 'price_baisa', 'weight_grams', 'stock_qty', 'is_active',
  ],
  raw_materials: [
    'sku', 'name_en', 'name_ar', 'category', 'image_url', 'model_url',
    'color_hex', 'unit_price_baisa', 'weight_grams', 'low_stock_threshold', 'is_active',
  ],
  composite_products: [
    'slug', 'kind', 'name_en', 'name_ar', 'base_price_baisa', 'base_weight_grams',
    'model_url', 'slot_count', 'min_filled_slots', 'is_active',
  ],
  composite_slots: [
    'composite_product_id', 'slot_index', 'label_en', 'label_ar',
    'position', 'allowed_categories', 'max_qty', 'is_required',
  ],
  themes: ['name', 'logo_url', 'primary_color', 'secondary_color', 'font_family'],
};

/**
 * `raw_materials.stock_qty` is deliberately NOT writable here.
 *
 * Stock moves only through `adjust_stock()`, which writes the ledger in the
 * same transaction. Allowing a direct UPDATE would let the admin UI silently
 * break the invariant `stock_qty = sum(delta_stock_qty)`.
 */
export function assertNoStockWrite(entity: AuditableEntity, patch: Record<string, unknown>): void {
  if (entity === 'raw_materials' && ('stock_qty' in patch || 'reserved_qty' in patch)) {
    throw new Error('STOCK_NOT_DIRECTLY_WRITABLE');
  }
}

function pickWritable(
  entity: AuditableEntity,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = WRITABLE[entity];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in input) out[key] = input[key];
  }
  return out;
}

async function readRow(
  tx: postgres.ISql,
  entity: AuditableEntity,
  id: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await tx<Record<string, unknown>[]>`
    select * from ${tx(entity)} where id = ${id}
  `;
  return row ?? null;
}

/**
 * Money columns come back as `bigint`, which `JSON.stringify` refuses to
 * serialise — so an unguarded audit write fails for every entity that has a
 * price, which is all of them. Bigints become decimal strings, matching how
 * money crosses every other boundary in this codebase.
 */
function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        toJsonSafe(entry),
      ]),
    );
  }
  return value;
}

async function writeAudit(
  tx: postgres.ISql,
  params: {
    actorUserId: string;
    action: 'insert' | 'update' | 'delete';
    entity: AuditableEntity;
    entityId: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx`
    insert into admin_audit_log (actor_user_id, action, entity, entity_id, before, after)
    values (
      ${params.actorUserId}, ${params.action}, ${params.entity}, ${params.entityId},
      ${params.before ? tx.json(toJsonSafe(params.before) as never) : null},
      ${params.after ? tx.json(toJsonSafe(params.after) as never) : null}
    )
  `;
}

export async function createEntity(
  sql: postgres.Sql,
  entity: AuditableEntity,
  input: Record<string, unknown>,
  actorUserId: string,
): Promise<Record<string, unknown>> {
  assertNoStockWrite(entity, input);
  const values = pickWritable(entity, input);
  if (Object.keys(values).length === 0) throw new Error('NO_WRITABLE_FIELDS');

  return sql.begin(async (tx) => {
    const [row] = await tx<Record<string, unknown>[]>`
      insert into ${tx(entity)} ${tx(values)} returning *
    `;
    if (!row) throw new Error('INTERNAL:insert returned no row');

    await writeAudit(tx, {
      actorUserId,
      action: 'insert',
      entity,
      entityId: String(row['id']),
      before: null,
      after: row,
    });
    return row;
  });
}

export async function updateEntity(
  sql: postgres.Sql,
  entity: AuditableEntity,
  id: string,
  patch: Record<string, unknown>,
  actorUserId: string,
): Promise<Record<string, unknown>> {
  assertNoStockWrite(entity, patch);
  const values = pickWritable(entity, patch);
  if (Object.keys(values).length === 0) throw new Error('NO_WRITABLE_FIELDS');

  return sql.begin(async (tx) => {
    const before = await readRow(tx, entity, id);
    if (!before) throw new Error(`NOT_FOUND:${entity}:${id}`);

    const [after] = await tx<Record<string, unknown>[]>`
      update ${tx(entity)} set ${tx(values)} where id = ${id} returning *
    `;
    if (!after) throw new Error(`NOT_FOUND:${entity}:${id}`);

    await writeAudit(tx, {
      actorUserId,
      action: 'update',
      entity,
      entityId: id,
      before,
      after,
    });
    return after;
  });
}

/**
 * Soft delete where the entity supports it.
 *
 * A product that appears on a historical order must not vanish: `order_items`
 * keeps name snapshots, but deactivating preserves the link for anything that
 * still resolves it. Hard deletes are reserved for slots, which nothing
 * references after the fact.
 */
export async function deactivateEntity(
  sql: postgres.Sql,
  entity: Extract<AuditableEntity, 'products' | 'raw_materials' | 'composite_products'>,
  id: string,
  actorUserId: string,
): Promise<Record<string, unknown>> {
  return updateEntity(sql, entity, id, { is_active: false }, actorUserId);
}

// ------------------------------------------------------------- inventory --

export type LowStockRow = {
  id: string;
  sku: string;
  name_en: string;
  name_ar: string;
  available: number;
  stock_qty: number;
  reserved_qty: number;
  low_stock_threshold: number;
};

export async function lowStock(sql: postgres.ISql): Promise<LowStockRow[]> {
  return sql<LowStockRow[]>`
    select id, sku, name_en, name_ar,
           greatest(stock_qty - reserved_qty, 0) as available,
           stock_qty, reserved_qty, low_stock_threshold
      from raw_materials
     where is_active
       and stock_qty - reserved_qty <= low_stock_threshold
     order by (stock_qty - reserved_qty) asc
  `;
}

export type LedgerRow = {
  id: string;
  raw_material_id: string;
  sku: string;
  delta_stock_qty: number;
  delta_reserved_qty: number;
  reason: string;
  order_id: string | null;
  note: string | null;
  created_at: string;
};

export async function ledger(
  sql: postgres.ISql,
  params: { rawMaterialId?: string | undefined; limit?: number } = {},
): Promise<LedgerRow[]> {
  const limit = Math.min(params.limit ?? 100, 500);
  return sql<LedgerRow[]>`
    select l.id, l.raw_material_id, m.sku, l.delta_stock_qty, l.delta_reserved_qty,
           l.reason, l.order_id, l.note, l.created_at
      from inventory_ledger l
      join raw_materials m on m.id = l.raw_material_id
     where ${params.rawMaterialId ? sql`l.raw_material_id = ${params.rawMaterialId}` : sql`true`}
     order by l.id desc
     limit ${limit}
  `;
}

/** Manual stock movement. Goes through the RPC so the ledger stays reconciled. */
export async function adjustStock(
  sql: postgres.ISql,
  params: {
    rawMaterialId: string;
    delta: number;
    reason: 'restock' | 'manual_adjust' | 'spoilage';
    note: string;
    actorUserId: string;
  },
): Promise<void> {
  await sql`
    select adjust_stock(
      ${params.rawMaterialId}, ${params.delta}, ${params.reason}::ledger_reason,
      ${params.note}, ${params.actorUserId}
    )
  `;
}

// ---------------------------------------------------------------- orders --

export async function ordersNeedingReview(sql: postgres.ISql) {
  return sql<
    { id: string; order_number: string; status: string; review_reason: string | null }[]
  >`
    select id, order_number, status, review_reason
      from orders
     where needs_review
     order by placed_at desc
     limit 100
  `;
}

export async function auditTrail(
  sql: postgres.ISql,
  params: { entity?: string | undefined; entityId?: string | undefined; limit?: number } = {},
) {
  const limit = Math.min(params.limit ?? 100, 500);
  return sql<
    {
      id: string;
      actor_user_id: string | null;
      action: string;
      entity: string;
      entity_id: string;
      created_at: string;
    }[]
  >`
    select id, actor_user_id, action, entity, entity_id, created_at
      from admin_audit_log
     where ${params.entity ? sql`entity = ${params.entity}` : sql`true`}
       and ${params.entityId ? sql`entity_id = ${params.entityId}` : sql`true`}
     order by id desc
     limit ${limit}
  `;
}
