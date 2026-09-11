import { getSql } from '@/lib/db';
import { checkoutSessionSchema } from '@/lib/contracts';
import { createOrderFromCart } from '@/lib/repositories/orders';
import { getPaymentProvider } from '@/lib/payments';
import { errorResponse, validationResponse } from '@/lib/errors';
import { jsonResponse, readJson } from '@/lib/http';
import { enforceRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Creates the order and, for card payments, the gateway session.
 *
 * Totals are recomputed here from the cart rows — nothing about the amount
 * comes from the client. Rounding to a gateway-acceptable increment happens
 * once, on the grand total, with the delta persisted so the invoice
 * reconciles.
 *
 * Stock is NOT consumed at this point. The cart's reservation continues to
 * hold it, and `commit_order_stock` converts the hold only when payment is
 * confirmed by webhook.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = checkoutSessionSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return validationResponse(parsed.error.issues);
  }

  const { cart_id, governorate, payment_method, gift, locale } = parsed.data;

  try {
    const sql = getSql();

    // Keyed on the cart, not the IP: a shopper behind CGNAT is not a hundred
    // shoppers, and this still bounds repeated checkout attempts per cart.
    const limited = await enforceRateLimit(sql, 'checkout', request, cart_id);
    if (limited) return limited;

    const order = await createOrderFromCart(sql, {
      cartId: cart_id,
      governorate,
      paymentMethod: payment_method,
      gift,
      giftBlocklist: (process.env['GIFT_MESSAGE_BLOCKLIST'] ?? '')
        .split(',')
        .map((term) => term.trim())
        .filter(Boolean),
    });

    // Cash on delivery has no gateway hop. The order stays pending until
    // fulfilment confirms it, which is where its stock gets committed.
    if (payment_method === 'cod') {
      return jsonResponse(
        {
          order_id: order.id,
          order_number: order.orderNumber,
          total_baisa: order.totalBaisa,
          payment_method: 'cod',
        },
        { status: 201 },
      );
    }

    const provider = getPaymentProvider();
    const origin = new URL(request.url).origin;

    const session = await provider.createSession({
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalBaisa: order.totalBaisa,
      // Shipping and VAT ride as their own lines so the gateway's total equals
      // the order total exactly; assertLinesMatchTotal enforces that.
      lines: [
        ...order.lines.map((line) => ({
          nameEn: line.nameEn,
          unitBaisa: line.unitBaisa,
          qty: line.qty,
        })),
        ...(order.shippingBaisa > 0n
          ? [{ nameEn: 'Shipping', unitBaisa: order.shippingBaisa, qty: 1 }]
          : []),
        ...(order.vatBaisa + order.roundingAdjustmentBaisa !== 0n
          ? [
              {
                nameEn: 'VAT',
                unitBaisa: order.vatBaisa + order.roundingAdjustmentBaisa,
                qty: 1,
              },
            ]
          : []),
      ],
      successUrl: `${origin}/${locale}/checkout/success?order=${order.id}`,
      cancelUrl: `${origin}/${locale}/checkout/cancelled?order=${order.id}`,
      customerPhone: gift?.recipient_phone,
    });

    await sql`
      update orders
         set payment_provider   = ${provider.name},
             payment_session_id = ${session.sessionId}
       where id = ${order.id}
    `;

    return jsonResponse(
      {
        order_id: order.id,
        order_number: order.orderNumber,
        total_baisa: order.totalBaisa,
        payment_url: session.paymentUrl,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
