import type postgres from 'postgres';
import { computeTotals } from '../checkout/totals';
import { quoteShipping } from '../shipping';
import { checkGiftEligibility, screenGiftMessage, type GiftDetails } from '../gifting';

export type PaymentMethod = 'card' | 'cod';

export type DraftOrder = {
  id: string;
  orderNumber: string;
  subtotalBaisa: bigint;
  shippingBaisa: bigint;
  vatBaisa: bigint;
  roundingAdjustmentBaisa: bigint;
  totalBaisa: bigint;
  totalWeightGrams: number;
  zoneCode: string;
  lines: { nameEn: string; nameAr: string; qty: number; unitBaisa: bigint }[];
};

type CartLineRow = {
  product_id: string | null;
  configuration_id: string | null;
  qty: number;
  unit_price_baisa: string;
  unit_weight_grams: number;
  name_en: string;
  name_ar: string;
  slot_map: unknown;
};

/**
 * Turns a cart into a pending order.
 *
 * Prices are re-read from the cart rows rather than accepted from the client,
 * totals are computed in one place, and the whole thing is a single
 * transaction: an order must never exist without its line snapshots, and a
 * gift order must never exist without its recipient.
 *
 * The stock hold is NOT converted here — that happens on payment confirmation
 * in `commit_order_stock`. Placing an order does not consume inventory.
 */
export async function createOrderFromCart(
  sql: postgres.Sql,
  params: {
    cartId: string;
    governorate: string;
    paymentMethod: PaymentMethod;
    gift?: GiftDetails | undefined;
    giftBlocklist?: readonly string[];
  },
): Promise<DraftOrder> {
  return sql.begin(async (tx) => {
    const lines = await tx<CartLineRow[]>`
      select ci.product_id,
             ci.configuration_id,
             ci.qty,
             ci.unit_price_baisa,
             ci.unit_weight_grams,
             coalesce(p.name_en, cp.name_en) as name_en,
             coalesce(p.name_ar, cp.name_ar) as name_ar,
             cc.slot_map
        from cart_items ci
        left join products p on p.id = ci.product_id
        left join composite_configurations cc on cc.id = ci.configuration_id
        left join composite_products cp on cp.id = cc.composite_product_id
       where ci.cart_id = ${params.cartId}
       order by ci.created_at
    `;

    if (lines.length === 0) throw new Error('EMPTY_CART');

    const subtotalBaisa = lines.reduce(
      (total, line) => total + BigInt(line.unit_price_baisa) * BigInt(line.qty),
      0n,
    );

    const shippable = lines.map((line) => ({
      unitWeightGrams: line.unit_weight_grams,
      qty: line.qty,
    }));
    const quote = await quoteShipping(tx, shippable, params.governorate);

    if (params.paymentMethod === 'cod' && !quote.codEnabled) {
      throw new Error(`COD_NOT_AVAILABLE:${quote.zoneCode}`);
    }

    const eligibility = checkGiftEligibility({
      isGift: params.gift !== undefined,
      paymentMethod: params.paymentMethod,
      zoneIsFallback: quote.usedFallback,
    });
    if (!eligibility.allowed) throw new Error(eligibility.code);

    const totals = computeTotals({
      subtotalBaisa,
      shippingBaisa: quote.priceBaisa,
      // Cash on delivery is settled in physical currency; snapping to 10 baisa
      // would make the driver's change wrong.
      ...(params.paymentMethod === 'cod' ? { incrementBaisa: 1n } : {}),
    });

    const [order] = await tx<{ id: string; order_number: string }[]>`
      insert into orders (
        cart_id, subtotal_baisa, shipping_baisa, vat_baisa,
        rounding_adjustment_baisa, total_baisa, total_weight_grams,
        shipping_zone_id, payment_provider
      )
      values (
        ${params.cartId},
        ${totals.subtotalBaisa.toString()},
        ${totals.shippingBaisa.toString()},
        ${totals.vatBaisa.toString()},
        ${totals.roundingAdjustmentBaisa.toString()},
        ${totals.totalBaisa.toString()},
        ${quote.totalWeightGrams},
        ${quote.zoneId},
        ${params.paymentMethod === 'cod' ? 'cod' : null}
      )
      returning id, order_number
    `;
    if (!order) throw new Error('INTERNAL:order insert returned no row');

    for (const line of lines) {
      await tx`
        insert into order_items (
          order_id, product_id, configuration_id,
          name_snapshot_en, name_snapshot_ar, slot_map_snapshot,
          qty, unit_price_baisa, unit_weight_grams
        )
        values (
          ${order.id}, ${line.product_id}, ${line.configuration_id},
          ${line.name_en}, ${line.name_ar},
          ${line.slot_map === null ? null : tx.json(line.slot_map as never)},
          ${line.qty}, ${line.unit_price_baisa}, ${line.unit_weight_grams}
        )
      `;
    }

    if (params.gift) {
      const status = screenGiftMessage(params.gift.gift_message, params.giftBlocklist);
      await tx`
        insert into gift_orders (
          order_id, recipient_name, recipient_phone, delivery_location,
          delivery_geo, gift_message, gift_message_status, hide_prices
        )
        values (
          ${order.id}, ${params.gift.recipient_name}, ${params.gift.recipient_phone},
          ${params.gift.delivery_location},
          ${params.gift.delivery_geo ? tx.json(params.gift.delivery_geo) : null},
          ${params.gift.gift_message ?? null}, ${status}, ${params.gift.hide_prices}
        )
      `;
    }

    return {
      id: order.id,
      orderNumber: order.order_number,
      subtotalBaisa: totals.subtotalBaisa,
      shippingBaisa: totals.shippingBaisa,
      vatBaisa: totals.vatBaisa,
      roundingAdjustmentBaisa: totals.roundingAdjustmentBaisa,
      totalBaisa: totals.totalBaisa,
      totalWeightGrams: quote.totalWeightGrams,
      zoneCode: quote.zoneCode,
      lines: lines.map((line) => ({
        nameEn: line.name_en,
        nameAr: line.name_ar,
        qty: line.qty,
        unitBaisa: BigInt(line.unit_price_baisa),
      })),
    };
  });
}

export type OrderView = {
  id: string;
  orderNumber: string;
  status: string;
  placedAt: string;
  subtotalBaisa: bigint;
  shippingBaisa: bigint;
  vatBaisa: bigint;
  roundingAdjustmentBaisa: bigint;
  totalBaisa: bigint;
  totalWeightGrams: number;
  items: {
    nameEn: string;
    nameAr: string;
    qty: number;
    unitBaisa: bigint;
    contents: { name_en: string; name_ar: string; qty: number }[];
  }[];
  gift:
    | {
        recipientName: string;
        recipientPhone: string;
        deliveryLocation: string;
        giftMessage: string | null;
        giftMessageStatus: string;
        hidePrices: boolean;
      }
    | null;
};

/** Loads everything a document needs, including resolved composite contents. */
export async function loadOrderView(
  sql: postgres.ISql,
  orderId: string,
): Promise<OrderView | null> {
  const [order] = await sql<
    {
      id: string;
      order_number: string;
      status: string;
      placed_at: string;
      subtotal_baisa: string;
      shipping_baisa: string;
      vat_baisa: string;
      rounding_adjustment_baisa: string;
      total_baisa: string;
      total_weight_grams: number;
    }[]
  >`
    select id, order_number, status, placed_at, subtotal_baisa, shipping_baisa,
           vat_baisa, rounding_adjustment_baisa, total_baisa, total_weight_grams
      from orders where id = ${orderId}
  `;
  if (!order) return null;

  const items = await sql<
    {
      name_snapshot_en: string;
      name_snapshot_ar: string;
      qty: number;
      unit_price_baisa: string;
      contents: { name_en: string; name_ar: string; qty: number }[] | null;
    }[]
  >`
    select oi.name_snapshot_en, oi.name_snapshot_ar, oi.qty, oi.unit_price_baisa,
           (
             select json_agg(json_build_object(
                      'name_en', rm.name_en,
                      'name_ar', rm.name_ar,
                      'qty', (e->>'qty')::int
                    ) order by (e->>'slot_index')::int)
               from jsonb_array_elements(oi.slot_map_snapshot) e
               join raw_materials rm on rm.id = (e->>'raw_material_id')::uuid
           ) as contents
      from order_items oi
     where oi.order_id = ${orderId}
     order by oi.id
  `;

  const [gift] = await sql<
    {
      recipient_name: string;
      recipient_phone: string;
      delivery_location: string;
      gift_message: string | null;
      gift_message_status: string;
      hide_prices: boolean;
    }[]
  >`
    select recipient_name, recipient_phone, delivery_location,
           gift_message, gift_message_status, hide_prices
      from gift_orders where order_id = ${orderId}
  `;

  return {
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
    placedAt: order.placed_at,
    subtotalBaisa: BigInt(order.subtotal_baisa),
    shippingBaisa: BigInt(order.shipping_baisa),
    vatBaisa: BigInt(order.vat_baisa),
    roundingAdjustmentBaisa: BigInt(order.rounding_adjustment_baisa),
    totalBaisa: BigInt(order.total_baisa),
    totalWeightGrams: order.total_weight_grams,
    items: items.map((item) => ({
      nameEn: item.name_snapshot_en,
      nameAr: item.name_snapshot_ar,
      qty: item.qty,
      unitBaisa: BigInt(item.unit_price_baisa),
      contents: item.contents ?? [],
    })),
    gift: gift
      ? {
          recipientName: gift.recipient_name,
          recipientPhone: gift.recipient_phone,
          deliveryLocation: gift.delivery_location,
          giftMessage: gift.gift_message,
          giftMessageStatus: gift.gift_message_status,
          hidePrices: gift.hide_prices,
        }
      : null,
  };
}
