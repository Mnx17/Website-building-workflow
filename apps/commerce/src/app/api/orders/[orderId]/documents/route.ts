import { getSql } from '@/lib/db';
import { uuidSchema } from '@/lib/contracts';
import { loadOrderView } from '@/lib/repositories/orders';
import { buildInvoice, buildPackingSlip, DocumentError } from '@/lib/documents/model';
import { renderInvoice, renderPackingSlip } from '@/lib/documents/render';
import { isLocale } from '@/lib/i18n';
import { jsonResponse } from '@/lib/http';
import { sessionForOrder } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Fulfilment documents.
 *
 * Two kinds of caller are allowed: staff (any role — fulfilment needs the
 * packing slip), and the buyer for their own order. Nobody else, and there is
 * no unauthenticated path.
 *
 * The invoice is the sensitive one: a leaked packing-slip URL exposes a name
 * and address, while a leaked invoice URL also exposes prices — precisely what
 * the gifting feature promises to hide. Hence the extra rule below: a buyer
 * gets their own invoice, but only staff get a packing slip, because the slip
 * carries the recipient's address and the buyer is not always the person who
 * should be able to re-fetch it at will.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const { orderId } = await context.params;
  if (!uuidSchema.safeParse(orderId).success) {
    return jsonResponse({ error: 'BAD_ORDER_ID' }, { status: 400 });
  }

  const caller = await sessionForOrder(getSql(), request, orderId);
  if (!caller) {
    return jsonResponse({ error: 'FORBIDDEN' }, { status: 403 });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type') ?? 'invoice';
  const localeParam = url.searchParams.get('locale') ?? 'en';
  const locale = isLocale(localeParam) ? localeParam : 'en';

  if (type === 'packing_slip' && caller.kind !== 'staff') {
    return jsonResponse({ error: 'STAFF_ONLY' }, { status: 403 });
  }

  const order = await loadOrderView(getSql(), orderId);
  if (!order) {
    return jsonResponse({ error: 'ORDER_NOT_FOUND' }, { status: 404 });
  }

  try {
    const html =
      type === 'packing_slip'
        ? renderPackingSlip(buildPackingSlip(order, locale))
        : renderInvoice(buildInvoice(order, locale));

    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Never let a shared cache hold a document containing recipient PII.
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof DocumentError) {
      return jsonResponse({ error: error.message }, { status: 422 });
    }
    console.error('[documents] render failed', error);
    return jsonResponse({ error: 'INTERNAL' }, { status: 500 });
  }
}
