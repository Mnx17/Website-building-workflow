import type postgres from 'postgres';
import type { SlotEntry } from '../config-hash';
import { upsertConfiguration } from './configurations';

export interface CartItemRow {
  id: string;
  product_id: string | null;
  configuration_id: string | null;
  qty: number;
  unit_price_baisa: bigint;
  unit_weight_grams: number;
}

export interface CartSummary {
  id: string;
  currency: string;
  reserved_until: string | null;
  items: CartItemRow[];
  subtotal_baisa: bigint;
  total_weight_grams: number;
}

export async function createCart(
  sql: postgres.ISql,
  { userId = null, anonToken = null }: { userId?: string | null; anonToken?: string | null },
): Promise<{ id: string }> {
  const [row] = await sql<{ id: string }[]>`
    insert into carts (user_id, anon_token)
    values (${userId}, ${anonToken})
    returning id
  `;
  if (!row) throw new Error('INTERNAL:cart insert returned no row');
  return row;
}

export async function getCart(sql: postgres.ISql, cartId: string): Promise<CartSummary | null> {
  const [cart] = await sql<{ id: string; currency: string; reserved_until: string | null }[]>`
    select id, currency, reserved_until from carts where id = ${cartId}
  `;
  if (!cart) return null;

  const rows = await sql<
    {
      id: string;
      product_id: string | null;
      configuration_id: string | null;
      qty: number;
      unit_price_baisa: string;
      unit_weight_grams: number;
    }[]
  >`
    select id, product_id, configuration_id, qty, unit_price_baisa, unit_weight_grams
      from cart_items
     where cart_id = ${cartId}
     order by created_at
  `;

  const items: CartItemRow[] = rows.map((row) => ({
    id: row.id,
    product_id: row.product_id,
    configuration_id: row.configuration_id,
    qty: row.qty,
    unit_price_baisa: BigInt(row.unit_price_baisa),
    unit_weight_grams: row.unit_weight_grams,
  }));

  return {
    id: cart.id,
    currency: cart.currency,
    reserved_until: cart.reserved_until,
    items,
    subtotal_baisa: items.reduce((t, i) => t + i.unit_price_baisa * BigInt(i.qty), 0n),
    total_weight_grams: items.reduce((t, i) => t + i.unit_weight_grams * i.qty, 0),
  };
}

/**
 * Adds a composite build to a cart.
 *
 * The whole operation is one transaction: price, persist the configuration,
 * reserve the bill of materials, then write the line item. If the reservation
 * fails because a material just sold out, nothing is written at all — there is
 * no window where a cart row exists without its stock hold.
 */
export async function addCompositeItem(
  sql: postgres.Sql,
  params: {
    cartId: string;
    compositeProductId: string;
    slotMap: readonly SlotEntry[];
    configHash: string;
    qty: number;
    userId?: string | null;
  },
): Promise<{ item_id: string; configuration_id: string; unit_price_baisa: bigint }> {
  return sql.begin(async (tx) => {
    const configuration = await upsertConfiguration(
      tx,
      params.compositeProductId,
      params.slotMap,
      params.configHash,
      params.userId ?? null,
    );

    await tx`select reserve_configuration(${params.cartId}, ${configuration.id}, ${params.qty})`;

    const [item] = await tx<{ id: string }[]>`
      insert into cart_items (
        cart_id, configuration_id, qty, unit_price_baisa, unit_weight_grams
      )
      values (
        ${params.cartId}, ${configuration.id}, ${params.qty},
        ${configuration.unit_price_baisa.toString()}, ${configuration.total_weight_grams}
      )
      on conflict (cart_id, configuration_id) where configuration_id is not null
      do update set qty              = cart_items.qty + excluded.qty,
                    unit_price_baisa = excluded.unit_price_baisa
      returning id
    `;
    if (!item) throw new Error('INTERNAL:cart_item insert returned no row');

    return {
      item_id: item.id,
      configuration_id: configuration.id,
      unit_price_baisa: configuration.unit_price_baisa,
    };
  });
}

export async function addProductItem(
  sql: postgres.Sql,
  params: { cartId: string; productId: string; qty: number },
): Promise<{ item_id: string }> {
  return sql.begin(async (tx) => {
    const [product] = await tx<
      { price_baisa: string; weight_grams: number; stock_qty: number }[]
    >`
      select price_baisa, weight_grams, stock_qty
        from products
       where id = ${params.productId} and is_active
       for update
    `;
    if (!product) throw new Error(`MATERIAL_NOT_FOUND:${params.productId}`);
    if (product.stock_qty < params.qty) {
      throw new Error(`OUT_OF_STOCK:${params.productId}`);
    }

    const [item] = await tx<{ id: string }[]>`
      insert into cart_items (cart_id, product_id, qty, unit_price_baisa, unit_weight_grams)
      values (
        ${params.cartId}, ${params.productId}, ${params.qty},
        ${product.price_baisa}, ${product.weight_grams}
      )
      on conflict (cart_id, product_id) where product_id is not null
      do update set qty              = cart_items.qty + excluded.qty,
                    unit_price_baisa = excluded.unit_price_baisa
      returning id
    `;
    if (!item) throw new Error('INTERNAL:cart_item insert returned no row');
    return { item_id: item.id };
  });
}

/**
 * Removing a composite line releases its hold. Reservations are tracked per
 * cart rather than per line, so the whole cart is re-reserved from what
 * remains — simpler than reversing one line's BOM and impossible to drift.
 */
export async function removeCartItem(
  sql: postgres.Sql,
  cartId: string,
  itemId: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [removed] = await tx<{ configuration_id: string | null; qty: number }[]>`
      delete from cart_items
       where id = ${itemId} and cart_id = ${cartId}
      returning configuration_id, qty
    `;
    if (!removed) return;
    if (removed.configuration_id === null) return;

    await tx`select release_cart_reservations(${cartId})`;

    const remaining = await tx<{ configuration_id: string; qty: number }[]>`
      select configuration_id, qty
        from cart_items
       where cart_id = ${cartId} and configuration_id is not null
       order by configuration_id
    `;
    for (const line of remaining) {
      await tx`select reserve_configuration(${cartId}, ${line.configuration_id}, ${line.qty})`;
    }
  });
}
