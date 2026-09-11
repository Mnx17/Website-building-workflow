import { getSql } from '@/lib/db';
import { getPaymentProvider } from '@/lib/payments';
import { jsonResponse } from '@/lib/http';

// Node runtime: signature verification needs node:crypto's timingSafeEqual.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Payment webhook.
 *
 * Order of operations is the whole design:
 *   1. Read the RAW body. Never `request.json()` first — re-serialising
 *      changes the bytes the signature covers.
 *   2. Verify the signature (timing-safe, with a timestamp window).
 *   3. Record the event under a unique (provider, event_id). A duplicate
 *      insert means we have already handled it, so return 200 immediately —
 *      that is the replay guard.
 *   4. Only then mutate state, with the status change and the stock commit in
 *      ONE transaction.
 *
 * Always 200 on anything already handled. A gateway that receives a 500
 * retries, so a handler that throws on a duplicate retries forever.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider: providerName } = await context.params;

  const rawBody = await request.text();

  let provider;
  try {
    provider = getPaymentProvider(providerName);
  } catch {
    return jsonResponse({ error: 'UNKNOWN_PROVIDER' }, { status: 404 });
  }

  const verified = provider.verifyWebhook(rawBody, request.headers);
  if (!verified.ok) {
    // 400, not 500: the gateway should not retry a payload that will never
    // verify. A genuine secret rotation shows up as a spike here.
    console.warn('[webhook] rejected', providerName, verified.reason);
    return jsonResponse({ error: 'INVALID_SIGNATURE', reason: verified.reason }, { status: 400 });
  }

  const sql = getSql();

  // Replay guard. The unique index on (provider, event_id) is the authority.
  try {
    await sql`
      insert into webhook_events (provider, event_id, signature, payload)
      values (
        ${provider.name},
        ${verified.eventId},
        ${request.headers.get('mock-signature') ?? request.headers.get('thawani-signature')},
        ${sql.json(JSON.parse(rawBody) as never)}
      )
    `;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return jsonResponse({ ok: true, duplicate: true });
    }
    console.error('[webhook] could not record event', error);
    return jsonResponse({ error: 'INTERNAL' }, { status: 500 });
  }

  if (verified.outcome !== 'paid') {
    await sql`
      update orders
         set status = 'cancelled', payment_reference = ${verified.reference ?? null}
       where id = ${verified.orderId} and status = 'pending'
    `;
    await sql`select release_cart_reservations(cart_id) from orders where id = ${verified.orderId}`;
    await markProcessed(sql, provider.name, verified.eventId);
    return jsonResponse({ ok: true, outcome: verified.outcome });
  }

  let commitResult = 'unknown';
  try {
    await sql.begin(async (tx) => {
      const [order] = await tx<{ status: string }[]>`
        select status from orders where id = ${verified.orderId} for update
      `;
      if (!order) throw new Error(`ORDER_NOT_FOUND:${verified.orderId}`);

      // Idempotent at the state-machine level too: a second delivery that got
      // past the dedupe table must not attempt pending -> paid twice.
      if (order.status === 'pending') {
        await tx`
          update orders
             set status = 'paid',
                 paid_at = now(),
                 payment_reference = ${verified.reference ?? null}
           where id = ${verified.orderId}
        `;
      }

      const [row] = await tx<{ commit_order_stock: string }[]>`
        select commit_order_stock(${verified.orderId})
      `;
      commitResult = row?.commit_order_stock ?? 'unknown';
    });
  } catch (error) {
    console.error('[webhook] commit failed', error);
    return jsonResponse({ error: 'INTERNAL' }, { status: 500 });
  }

  if (commitResult === 'reservation_lost') {
    // The hold lapsed before payment landed. The customer has been charged, so
    // the order stands — but it must not be shipped from stock that may not
    // exist. Logging is not enough: put it in front of a human.
    console.error('[webhook] RESERVATION_LOST for paid order', verified.orderId);
    await sql`
      update orders
         set needs_review = true,
             review_reason = 'Stock reservation expired before payment confirmed; verify availability before fulfilling.'
       where id = ${verified.orderId}
    `;
  }

  await markProcessed(sql, provider.name, verified.eventId);

  return jsonResponse({ ok: true, commit: commitResult });
}

async function markProcessed(
  sql: ReturnType<typeof getSql>,
  provider: string,
  eventId: string,
): Promise<void> {
  await sql`
    update webhook_events set processed_at = now()
     where provider = ${provider} and event_id = ${eventId}
  `;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}
