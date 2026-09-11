/**
 * Checkout, payment webhook and fulfilment documents against a real database.
 *
 * The Route Handlers are imported and called directly — they are plain
 * functions over `Request`, so this exercises the real routing code (signature
 * check, replay guard, transaction boundaries) without booting a server.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getSql, closeSql } from '@/lib/db';
import { configHash } from '@/lib/config-hash';
import { addCompositeItem, createCart } from '@/lib/repositories/carts';
import { loadOrderView } from '@/lib/repositories/orders';
import { mockWebhook, MOCK_SECRET } from '@/lib/payments';
import { assertShippingCoverage, quoteShipping } from '@/lib/shipping';
import { POST as checkoutRoute } from '@/app/api/checkout/session/route';
import { POST as webhookRoute } from '@/app/api/webhooks/[provider]/route';
import { GET as documentsRoute } from '@/app/api/orders/[orderId]/documents/route';

const DATABASE_URL = process.env['DATABASE_URL'];
const suite = DATABASE_URL ? describe : describe.skip;

const BOX = '22222222-0000-4000-8000-000000000001';
const ORANGE = '11111111-0000-4000-8000-000000000001';
const CHOCOLATE = '11111111-0000-4000-8000-000000000003';
const JWT_SECRET = 'test-jwt-secret-for-checkout-suite';
const STAFF_ID = '00000000-0000-4000-8000-0000000000b1';
const OUTSIDER_ID = '00000000-0000-4000-8000-0000000000b2';

function jwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const SLOT_MAP = [
  { slot_index: 0, raw_material_id: ORANGE },
  { slot_index: 1, raw_material_id: CHOCOLATE },
];

let sql: postgres.Sql;

// One client for the whole file: closing it in the first suite's afterAll
// leaves later suites querying a dead connection.
beforeAll(() => {
  process.env['PAYMENT_PROVIDER'] = 'mock';
  process.env['MOCK_WEBHOOK_SECRET'] = MOCK_SECRET;
  process.env['SUPABASE_JWT_SECRET'] = JWT_SECRET;
  sql = getSql();
});

afterAll(async () => {
  await closeSql();
});

async function seedStaff(): Promise<void> {
  await sql`
    insert into auth.users (id, email) values (${STAFF_ID}, 'fulfilment@example.com')
    on conflict (id) do nothing
  `;
  await sql`
    insert into staff_users (user_id, role) values (${STAFF_ID}, 'fulfillment')
    on conflict (user_id) do update set role = excluded.role
  `;
  await sql`
    insert into auth.users (id, email) values (${OUTSIDER_ID}, 'buyer@example.com')
    on conflict (id) do nothing
  `;
}

async function cartWithBox(qty = 1): Promise<string> {
  const cart = await createCart(sql, { anonToken: crypto.randomUUID() });
  await addCompositeItem(sql, {
    cartId: cart.id,
    compositeProductId: BOX,
    slotMap: SLOT_MAP,
    configHash: await configHash(BOX, SLOT_MAP),
    qty,
  });
  return cart.id;
}

function checkoutRequest(body: unknown): Request {
  return new Request('http://localhost/api/checkout/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postWebhook(body: string, headers: Headers): Promise<Response> {
  return webhookRoute(
    new Request('http://localhost/api/webhooks/mock', { method: 'POST', headers, body }),
    { params: Promise.resolve({ provider: 'mock' }) },
  );
}

async function reservedQty(id: string): Promise<number> {
  const [row] = await sql<{ reserved_qty: number }[]>`
    select reserved_qty from raw_materials where id = ${id}
  `;
  return row!.reserved_qty;
}

async function stockQty(id: string): Promise<number> {
  const [row] = await sql<{ stock_qty: number }[]>`
    select stock_qty from raw_materials where id = ${id}
  `;
  return row!.stock_qty;
}

suite('checkout and payment', () => {
  it('every shipping zone has an unbounded top band', async () => {
    await expect(assertShippingCoverage(sql)).resolves.toBeUndefined();
  });

  it('quotes by governorate and weight, and falls back for the unknown', async () => {
    const light = await quoteShipping(sql, [{ unitWeightGrams: 500, qty: 1 }], 'Muscat');
    expect(light.zoneCode).toBe('MUSCAT');
    expect(light.priceBaisa).toBe(1000n);

    const heavy = await quoteShipping(sql, [{ unitWeightGrams: 3000, qty: 1 }], 'Muscat');
    expect(heavy.priceBaisa).toBe(1500n);

    const abroad = await quoteShipping(sql, [{ unitWeightGrams: 500, qty: 1 }], 'Atlantis');
    expect(abroad.usedFallback).toBe(true);
    expect(abroad.zoneCode).toBe('REST');
  });

  it('never falls through the band lookup, even for an absurd weight', async () => {
    const quote = await quoteShipping(sql, [{ unitWeightGrams: 2_000_000, qty: 1 }], 'Muscat');
    expect(quote.priceBaisa).toBeGreaterThan(0n);
  });

  it('creates an order whose totals reconcile and round to 10 baisa', async () => {
    const cartId = await cartWithBox(2);
    const response = await checkoutRoute(
      checkoutRequest({ cart_id: cartId, governorate: 'Muscat', payment_method: 'card' }),
    );
    expect(response.status).toBe(201);

    const body = (await response.json()) as { order_id: string; total_baisa: string };
    const order = await loadOrderView(sql, body.order_id);

    // 2 × 4500 subtotal, 1000 shipping (570g → Muscat 0-1000g band)
    expect(order!.subtotalBaisa).toBe(9000n);
    expect(order!.shippingBaisa).toBe(1000n);
    expect(order!.vatBaisa).toBe(500n);
    expect(
      order!.subtotalBaisa +
        order!.shippingBaisa +
        order!.vatBaisa +
        order!.roundingAdjustmentBaisa,
    ).toBe(order!.totalBaisa);
    expect(order!.totalBaisa % 10n).toBe(0n);
  });

  it('does not consume stock at checkout — only the hold is kept', async () => {
    const cartId = await cartWithBox(1);
    const stockBefore = await stockQty(ORANGE);
    const reservedBefore = await reservedQty(ORANGE);

    await checkoutRoute(
      checkoutRequest({ cart_id: cartId, governorate: 'Muscat', payment_method: 'card' }),
    );

    expect(await stockQty(ORANGE)).toBe(stockBefore);
    expect(await reservedQty(ORANGE)).toBe(reservedBefore);
  });

  it('commits stock on a verified paid webhook, exactly once across replays', async () => {
    const cartId = await cartWithBox(3);
    const checkout = await checkoutRoute(
      checkoutRequest({ cart_id: cartId, governorate: 'Muscat', payment_method: 'card' }),
    );
    const { order_id } = (await checkout.json()) as { order_id: string };

    const stockBefore = await stockQty(ORANGE);
    const reservedBefore = await reservedQty(ORANGE);

    // The SAME signed delivery, five times — what a retrying gateway does.
    const { body, headers } = mockWebhook({ orderId: order_id });

    const results: unknown[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await postWebhook(body, new Headers(headers));
      expect(response.status).toBe(200);
      results.push(await response.json());
    }

    expect(results[0]).toMatchObject({ ok: true, commit: 'committed' });
    for (const later of results.slice(1)) {
      expect(later).toMatchObject({ ok: true, duplicate: true });
    }

    expect(await stockQty(ORANGE)).toBe(stockBefore - 3);
    expect(await reservedQty(ORANGE)).toBe(reservedBefore - 3);

    const [order] = await sql<{ status: string; paid_at: string | null }[]>`
      select status, paid_at from orders where id = ${order_id}
    `;
    expect(order!.status).toBe('paid');
    expect(order!.paid_at).not.toBeNull();

    // The box is assembled from two raw materials, so a commit writes one
    // ledger row per material. What must never happen is a SECOND row for the
    // same material — that would be a double decrement.
    const commits = await sql<{ raw_material_id: string; rows: string }[]>`
      select raw_material_id, count(*) as rows
        from inventory_ledger
       where order_id = ${order_id} and reason = 'commit'
       group by raw_material_id
    `;
    expect(commits).toHaveLength(2);
    for (const row of commits) {
      expect(Number(row.rows)).toBe(1);
    }
  });

  it('rejects a webhook with a bad signature and changes nothing', async () => {
    const cartId = await cartWithBox(1);
    const checkout = await checkoutRoute(
      checkoutRequest({ cart_id: cartId, governorate: 'Muscat', payment_method: 'card' }),
    );
    const { order_id } = (await checkout.json()) as { order_id: string };

    const { body, headers } = mockWebhook({ orderId: order_id, secret: 'wrong-secret' });
    const response = await postWebhook(body, new Headers(headers));

    expect(response.status).toBe(400);
    const [order] = await sql<{ status: string }[]>`
      select status from orders where id = ${order_id}
    `;
    expect(order!.status).toBe('pending');
  });

  it('rejects a replayed-but-stale timestamp', async () => {
    const cartId = await cartWithBox(1);
    const checkout = await checkoutRoute(
      checkoutRequest({ cart_id: cartId, governorate: 'Muscat', payment_method: 'card' }),
    );
    const { order_id } = (await checkout.json()) as { order_id: string };

    const { body, headers } = mockWebhook({
      orderId: order_id,
      timestamp: Math.floor(Date.now() / 1000) - 7200,
    });
    const response = await postWebhook(body, new Headers(headers));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ reason: 'stale' });
  });

  it('releases the hold when payment fails', async () => {
    const cartId = await cartWithBox(2);
    const checkout = await checkoutRoute(
      checkoutRequest({ cart_id: cartId, governorate: 'Muscat', payment_method: 'card' }),
    );
    const { order_id } = (await checkout.json()) as { order_id: string };

    const reservedBefore = await reservedQty(ORANGE);
    const { body, headers } = mockWebhook({ orderId: order_id, outcome: 'failed' });
    const response = await postWebhook(body, new Headers(headers));

    expect(response.status).toBe(200);
    expect(await reservedQty(ORANGE)).toBe(reservedBefore - 2);

    const [order] = await sql<{ status: string }[]>`
      select status from orders where id = ${order_id}
    `;
    expect(order!.status).toBe('cancelled');
  });

  it('blocks gift + cash on delivery', async () => {
    const cartId = await cartWithBox(1);
    const response = await checkoutRoute(
      checkoutRequest({
        cart_id: cartId,
        governorate: 'Muscat',
        payment_method: 'cod',
        gift: {
          recipient_name: 'Fatma',
          recipient_phone: '+96891234567',
          delivery_location: 'Al Khuwair',
        },
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'GIFT_COD_NOT_ALLOWED' });
  });

  it('blocks gift + international until customs is handled', async () => {
    const cartId = await cartWithBox(1);
    const response = await checkoutRoute(
      checkoutRequest({
        cart_id: cartId,
        governorate: 'Atlantis',
        payment_method: 'card',
        gift: {
          recipient_name: 'Fatma',
          recipient_phone: '+96891234567',
          delivery_location: 'Somewhere',
        },
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: 'GIFT_INTERNATIONAL_NEEDS_CUSTOMS',
    });
  });

  it('rejects checkout on an empty cart with a business error, not a 500', async () => {
    const cart = await createCart(sql, { anonToken: crypto.randomUUID() });
    const response = await checkoutRoute(
      checkoutRequest({ cart_id: cart.id, governorate: 'Muscat', payment_method: 'card' }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'EMPTY_CART' });
  });

  it('does not round a cash-on-delivery total', async () => {
    const cartId = await cartWithBox(1);
    const response = await checkoutRoute(
      checkoutRequest({ cart_id: cartId, governorate: 'Muscat', payment_method: 'cod' }),
    );
    const { order_id } = (await response.json()) as { order_id: string };
    const order = await loadOrderView(sql, order_id);
    expect(order!.roundingAdjustmentBaisa).toBe(0n);
  });
});

suite('fulfilment documents', () => {
  beforeAll(async () => {
    await seedStaff();
  });

  async function giftOrder(): Promise<string> {
    const cartId = await cartWithBox(1);
    const response = await checkoutRoute(
      checkoutRequest({
        cart_id: cartId,
        governorate: 'Muscat',
        payment_method: 'card',
        locale: 'ar',
        gift: {
          recipient_name: 'Fatma Al Balushi',
          recipient_phone: '+96891234567',
          delivery_location: 'Al Khuwair, Muscat',
          gift_message: 'كل عام وأنتِ بخير',
        },
      }),
    );
    const { order_id } = (await response.json()) as { order_id: string };
    return order_id;
  }

  function documentsRequest(orderId: string, query: string, as: string | null = STAFF_ID): Request {
    return new Request(`http://localhost/api/orders/${orderId}/documents?${query}`, {
      headers: as ? { authorization: `Bearer ${jwt(as)}` } : {},
    });
  }

  it('serves a packing slip with no price anywhere in it', async () => {
    const orderId = await giftOrder();
    const response = await documentsRoute(
      documentsRequest(orderId, 'type=packing_slip&locale=ar'),
      { params: Promise.resolve({ orderId }) },
    );

    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).not.toMatch(/\bOMR\b/i);
    expect(html).not.toMatch(/ر\.ع/);
    expect(html).not.toMatch(/\d+\.\d{3}\b/);

    // It still has to be usable by whoever packs the box.
    expect(html).toContain('Fatma Al Balushi');
    expect(html).toContain('كل عام وأنتِ بخير');
    expect(html).toContain('dir="rtl"');
  });

  it('serves a priced invoice for the same order', async () => {
    const orderId = await giftOrder();
    const response = await documentsRoute(documentsRequest(orderId, 'type=invoice'), {
      params: Promise.resolve({ orderId }),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/\d+\.\d{3}/);
  });

  it('refuses an unauthenticated request', async () => {
    const orderId = await giftOrder();
    const response = await documentsRoute(documentsRequest(orderId, 'type=invoice', null), {
      params: Promise.resolve({ orderId }),
    });
    expect(response.status).toBe(403);
  });

  it('refuses a signed-in user who is neither staff nor the buyer', async () => {
    const orderId = await giftOrder();
    const response = await documentsRoute(
      documentsRequest(orderId, 'type=invoice', OUTSIDER_ID),
      { params: Promise.resolve({ orderId }) },
    );
    expect(response.status).toBe(403);
  });

  it('never gives a non-staff caller a packing slip, even for their own order', async () => {
    // The slip carries the recipient's address; staff handle it, not the buyer.
    const cartId = await cartWithBox(1);
    const checkout = await checkoutRoute(
      checkoutRequest({ cart_id: cartId, governorate: 'Muscat', payment_method: 'card' }),
    );
    const { order_id } = (await checkout.json()) as { order_id: string };
    await sql`update orders set user_id = ${OUTSIDER_ID} where id = ${order_id}`;

    const response = await documentsRoute(
      documentsRequest(order_id, 'type=packing_slip', OUTSIDER_ID),
      { params: Promise.resolve({ orderId: order_id }) },
    );
    expect(response.status).toBe(403);
  });

  it('refuses a packing slip for a non-gift order', async () => {
    const cartId = await cartWithBox(1);
    const checkout = await checkoutRoute(
      checkoutRequest({ cart_id: cartId, governorate: 'Muscat', payment_method: 'card' }),
    );
    const { order_id } = (await checkout.json()) as { order_id: string };

    const response = await documentsRoute(
      documentsRequest(order_id, 'type=packing_slip'),
      { params: Promise.resolve({ orderId: order_id }) },
    );
    expect(response.status).toBe(422);
  });

  it('never sets a cacheable header on a document containing PII', async () => {
    const orderId = await giftOrder();
    const response = await documentsRoute(
      documentsRequest(orderId, 'type=packing_slip'),
      { params: Promise.resolve({ orderId }) },
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
