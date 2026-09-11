import { timingSafeEqual } from 'node:crypto';
import { getSql } from '@/lib/db';
import { uuidSchema } from '@/lib/contracts';
import { loadOrderView } from '@/lib/repositories/orders';
import { buildInvoice, buildPackingSlip, DocumentError } from '@/lib/documents/model';
import { renderInvoice, renderPackingSlip } from '@/lib/documents/render';
import { isLocale } from '@/lib/i18n';
import { jsonResponse } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Fulfilment documents.
 *
 * Access control is a shared staff token, because P1–P3 have no auth yet. That
 * is a deliberate stopgap and a known gap: when Supabase Auth lands in P4 this
 * must become a role check (`has_role('{admin,fulfillment}')`) plus
 * buyer-owns-order, and the token goes away.
 *
 * The invoice is the sensitive one — it is the document that reveals what the
 * sender paid. Both are gated, but note the asymmetry: a leaked packing-slip
 * URL exposes a name and address; a leaked invoice URL also exposes prices,
 * which is precisely what the gifting feature promises to hide.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const { orderId } = await context.params;
  if (!uuidSchema.safeParse(orderId).success) {
    return jsonResponse({ error: 'BAD_ORDER_ID' }, { status: 400 });
  }

  if (!isAuthorisedStaff(request)) {
    return jsonResponse({ error: 'FORBIDDEN' }, { status: 403 });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type') ?? 'invoice';
  const localeParam = url.searchParams.get('locale') ?? 'en';
  const locale = isLocale(localeParam) ? localeParam : 'en';

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

function isAuthorisedStaff(request: Request): boolean {
  const expected = process.env['STAFF_API_TOKEN'];
  // Fail closed: no token configured means nobody gets documents.
  if (!expected) return false;

  const provided = request.headers.get('x-staff-token') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
