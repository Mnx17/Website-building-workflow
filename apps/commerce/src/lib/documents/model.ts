import type { OrderView } from '../repositories/orders';
import type { Locale } from '../configurator/types';

/**
 * Document models.
 *
 * The central guarantee of the gifting flow is that a recipient never sees
 * what the sender paid. That is enforced by the TYPE, not by a template
 * remembering to omit a field: `PackingSlipDocument` has no price-shaped
 * property anywhere in its shape, so a renderer cannot print one and a future
 * edit cannot reintroduce one without a compile error.
 */

export type DocumentLine = {
  name: string;
  qty: number;
  /** Resolved composite contents, so fulfilment can pick the box. */
  contents: { name: string; qty: number }[];
};

export type PackingSlipDocument = {
  kind: 'packing_slip';
  locale: Locale;
  orderNumber: string;
  placedAt: string;
  recipientName: string;
  recipientPhone: string;
  deliveryLocation: string;
  giftMessage: string | null;
  lines: DocumentLine[];
  totalWeightGrams: number;
};

export type InvoiceDocument = {
  kind: 'invoice';
  locale: Locale;
  orderNumber: string;
  placedAt: string;
  lines: (DocumentLine & { unitBaisa: bigint; lineTotalBaisa: bigint })[];
  subtotalBaisa: bigint;
  shippingBaisa: bigint;
  vatBaisa: bigint;
  roundingAdjustmentBaisa: bigint;
  totalBaisa: bigint;
};

export type CommerceDocument = PackingSlipDocument | InvoiceDocument;

function lineOf(
  item: OrderView['items'][number],
  locale: Locale,
): DocumentLine {
  return {
    name: locale === 'ar' ? item.nameAr : item.nameEn,
    qty: item.qty,
    contents: item.contents.map((entry) => ({
      name: locale === 'ar' ? entry.name_ar : entry.name_en,
      qty: entry.qty,
    })),
  };
}

export class DocumentError extends Error {}

/**
 * A packing slip is only ever built for a gift order with `hide_prices`.
 * A non-gift shipment gets the regular priced paperwork, and calling this for
 * one is a programming error rather than a silently price-free slip.
 */
export function buildPackingSlip(order: OrderView, locale: Locale): PackingSlipDocument {
  if (!order.gift) {
    throw new DocumentError('PACKING_SLIP_REQUIRES_GIFT_ORDER');
  }
  if (!order.gift.hidePrices) {
    throw new DocumentError('PACKING_SLIP_REQUIRES_HIDE_PRICES');
  }
  if (order.gift.giftMessageStatus === 'rejected') {
    // Printing a rejected message would defeat the review it was held for.
    throw new DocumentError('GIFT_MESSAGE_REJECTED');
  }

  return {
    kind: 'packing_slip',
    locale,
    orderNumber: order.orderNumber,
    placedAt: order.placedAt,
    recipientName: order.gift.recipientName,
    recipientPhone: order.gift.recipientPhone,
    deliveryLocation: order.gift.deliveryLocation,
    giftMessage: order.gift.giftMessage,
    lines: order.items.map((item) => lineOf(item, locale)),
    totalWeightGrams: order.totalWeightGrams,
  };
}

export function buildInvoice(order: OrderView, locale: Locale): InvoiceDocument {
  return {
    kind: 'invoice',
    locale,
    orderNumber: order.orderNumber,
    placedAt: order.placedAt,
    lines: order.items.map((item) => ({
      ...lineOf(item, locale),
      unitBaisa: item.unitBaisa,
      lineTotalBaisa: item.unitBaisa * BigInt(item.qty),
    })),
    subtotalBaisa: order.subtotalBaisa,
    shippingBaisa: order.shippingBaisa,
    vatBaisa: order.vatBaisa,
    roundingAdjustmentBaisa: order.roundingAdjustmentBaisa,
    totalBaisa: order.totalBaisa,
  };
}
