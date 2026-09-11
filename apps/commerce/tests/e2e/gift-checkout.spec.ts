import { createHmac, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The plan's P4 exit criterion: the gift checkout flow, in a real browser, in
 * both locales.
 *
 * Scope note, stated plainly: the cart is seeded through the API rather than
 * by dragging items across the WebGL canvas. Driving three.js raycasting
 * through a synthetic pointer is brittle in a way that produces flaky tests
 * rather than real coverage, and the interaction rules already have 21
 * dedicated unit tests against the store. What this suite covers is the part
 * those cannot: the checkout form, the server's gifting rules, the payment
 * round trip, and the price-free packing slip as a browser actually receives
 * it.
 */

const BOX = '22222222-0000-4000-8000-000000000001';
const ORANGE = '11111111-0000-4000-8000-000000000001';
const CHOCOLATE = '11111111-0000-4000-8000-000000000003';
const SLOT_MAP = [
  { slot_index: 0, raw_material_id: ORANGE, qty: 1 },
  { slot_index: 1, raw_material_id: CHOCOLATE, qty: 1 },
];

const MOCK_SECRET = process.env['MOCK_WEBHOOK_SECRET'] ?? 'mock-webhook-secret';
const JWT_SECRET = process.env['SUPABASE_JWT_SECRET'] ?? 'e2e-jwt-secret';

/** Anything that could read as a price on a document the recipient holds. */
const PRICE_SHAPED = [/\bOMR\b/i, /ر\.ع/, /\d+\.\d{3}\b/, /baisa/i];

/**
 * Each test is a different shopper, so it gets its own client address.
 *
 * Without this they share one rate-limit bucket and the suite starts failing
 * at the eleventh cart — the limiter working correctly, but measuring the test
 * runner rather than a user. Note this does NOT disable the limiter: it stays
 * enforced per simulated client, which is what production sees.
 */
function clientHeaders(): Record<string, string> {
  // 203.0.113.0/24 is the RFC 5737 documentation range.
  const octet = Math.floor(Math.random() * 254) + 1;
  return { 'x-forwarded-for': `203.0.113.${octet}` };
}

async function seedCart(request: APIRequestContext): Promise<string> {
  const headers = clientHeaders();

  const cartResponse = await request.post('/api/cart', {
    headers,
    data: { anon_token: randomUUID() },
  });
  expect(cartResponse.ok()).toBeTruthy();
  const { cart_id } = (await cartResponse.json()) as { cart_id: string };

  // Ask the server for the canonical hash rather than recomputing it here:
  // if the two ever disagree, the add below fails and the test says so.
  const priceResponse = await request.post('/api/configurations/price', {
    headers,
    data: { composite_product_id: BOX, slot_map: SLOT_MAP },
  });
  expect(priceResponse.ok()).toBeTruthy();
  const priced = (await priceResponse.json()) as {
    config_hash: string;
    unit_price_baisa: string;
  };
  expect(priced.unit_price_baisa).toBe('4500');

  const addResponse = await request.post(`/api/cart/${cart_id}/items`, {
    headers,
    data: {
      type: 'composite',
      composite_product_id: BOX,
      slot_map: SLOT_MAP,
      config_hash: priced.config_hash,
      qty: 1,
    },
  });
  expect(addResponse.ok()).toBeTruthy();

  return cart_id;
}

/** Puts the cart id where the checkout form looks for it. */
async function attachCart(page: Page, locale: string, cartId: string): Promise<void> {
  await page.goto(`/${locale}`);
  await page.evaluate((id) => localStorage.setItem('sweets.cart_id', id), cartId);
}

function staffJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Delivers a signed webhook, exactly as the gateway would. */
async function payOrder(request: APIRequestContext, orderId: string): Promise<void> {
  const body = JSON.stringify({
    event_id: randomUUID(),
    data: {
      client_reference_id: orderId,
      payment_status: 'paid',
      payment_id: `pay_${randomUUID()}`,
    },
  });

  const response = await request.post('/api/webhooks/mock', {
    headers: {
      'content-type': 'application/json',
      'mock-timestamp': String(Math.floor(Date.now() / 1000)),
      'mock-signature': createHmac('sha256', MOCK_SECRET).update(body).digest('hex'),
    },
    data: body,
  });
  expect(response.ok()).toBeTruthy();
  expect((await response.json()) as { commit: string }).toMatchObject({ commit: 'committed' });
}

for (const locale of ['en', 'ar'] as const) {
  test.describe(`gift checkout (${locale})`, () => {
    test('a gift order reaches paid and its packing slip carries no prices', async ({
      page,
      request,
    }) => {
      const cartId = await seedCart(request);
      await attachCart(page, locale, cartId);

      await page.goto(`/${locale}/checkout`);

      // Direction is set from the route segment, server-side.
      await expect(page.locator('html')).toHaveAttribute(
        'dir',
        locale === 'ar' ? 'rtl' : 'ltr',
      );

      await expect(page.getByTestId('cart-subtotal')).toContainText('4.500');

      await page.selectOption('select[name="governorate"]', 'Muscat');

      // Gift fields appear only once the toggle is on.
      await expect(page.getByTestId('gift-fields')).toHaveCount(0);
      await page.check('input[name="is_gift"]');
      await expect(page.getByTestId('gift-fields')).toBeVisible();

      await page.fill('input[name="recipient_name"]', 'Fatma Al Balushi');
      await page.fill('input[name="recipient_phone"]', '+96891234567');
      await page.fill('input[name="delivery_location"]', 'Al Khuwair, Muscat');
      await page.fill('textarea[name="gift_message"]', 'كل عام وأنتِ بخير');

      await page.getByTestId('submit-order').click();

      // Read the order id from where the shopper ends up, not from the
      // response body: the navigation discards the body before it can be read,
      // and the URL is what the customer actually gets.
      await page.waitForURL(/\/checkout\/success\?order=/);
      const orderId = new URL(page.url()).searchParams.get('order');
      expect(orderId).toBeTruthy();

      // Before payment the order is pending — the redirect is a hint, not proof.
      await expect(page.getByTestId('order-state')).toHaveAttribute(
        'data-status',
        'pending',
      );

      await payOrder(request, orderId!);

      await page.reload();
      await expect(page.getByTestId('order-state')).toHaveAttribute('data-status', 'paid');

      // The whole point of the feature: the recipient's paperwork has no prices.
      const slip = await request.get(
        `/api/orders/${orderId}/documents?type=packing_slip&locale=${locale}`,
        { headers: { authorization: `Bearer ${staffJwt(process.env['E2E_STAFF_ID']!)}` } },
      );
      expect(slip.ok()).toBeTruthy();
      const html = await slip.text();

      for (const pattern of PRICE_SHAPED) {
        expect(html, `packing slip matched ${pattern}`).not.toMatch(pattern);
      }
      expect(html).toContain('Fatma Al Balushi');
      expect(html).toContain('كل عام وأنتِ بخير');

      // The buyer's invoice, by contrast, must show them.
      const invoice = await request.get(
        `/api/orders/${orderId}/documents?type=invoice&locale=${locale}`,
        { headers: { authorization: `Bearer ${staffJwt(process.env['E2E_STAFF_ID']!)}` } },
      );
      expect(await invoice.text()).toMatch(/\d+\.\d{3}/);
    });

    test('gift plus cash on delivery is refused before it can be submitted', async ({
      page,
      request,
    }) => {
      const cartId = await seedCart(request);
      await attachCart(page, locale, cartId);
      await page.goto(`/${locale}/checkout`);

      await page.selectOption('select[name="governorate"]', 'Muscat');
      await page.check('input[name="is_gift"]');
      await page.fill('input[name="recipient_name"]', 'Fatma');
      await page.fill('input[name="recipient_phone"]', '+96891234567');
      await page.fill('input[name="delivery_location"]', 'Al Khuwair');

      await page.check('input[name="payment_method"][value="cod"]');

      await expect(page.getByTestId('gift-cod-blocked')).toBeVisible();
      await expect(page.getByTestId('submit-order')).toBeDisabled();
    });

    test('the gift message counter counts Arabic correctly', async ({ page, request }) => {
      const cartId = await seedCart(request);
      await attachCart(page, locale, cartId);
      await page.goto(`/${locale}/checkout`);

      await page.check('input[name="is_gift"]');

      // Ten Arabic letters each carrying a diacritic: twenty UTF-16 units, ten
      // characters as a reader perceives them. A counter built on
      // String.length would report 260 remaining instead of 270.
      await page.fill('textarea[name="gift_message"]', 'بَ'.repeat(10));
      await expect(page.getByTestId('chars-left')).toContainText('270');
    });
  });
}

test.describe('storefront', () => {
  test('redirects to a locale and renders the configurator shell', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/(en|ar)$/);

    await page.goto('/ar/configure/custom-box-4');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // Arabic content is server-rendered, not fetched after hydration.
    await expect(page.getByRole('heading', { name: 'صمم صندوقك' })).toBeVisible();
    await expect(page.getByRole('button', { name: /برتقال مسكر/ })).toBeVisible();
  });

  test('the admin panel is closed to an anonymous visitor', async ({ page }) => {
    await page.goto('/en/admin');
    await expect(page.getByText('NO_CREDENTIALS')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Inventory' })).toHaveCount(0);
  });
});
