import { describe, expect, it } from 'vitest';
import { buildInvoice, buildPackingSlip, DocumentError } from '@/lib/documents/model';
import { renderInvoice, renderPackingSlip } from '@/lib/documents/render';
import type { OrderView } from '@/lib/repositories/orders';

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    orderNumber: 'SW-2026-001234',
    status: 'paid',
    placedAt: '2026-09-11T00:00:00.000Z',
    subtotalBaisa: 9000n,
    shippingBaisa: 1000n,
    vatBaisa: 500n,
    roundingAdjustmentBaisa: 0n,
    totalBaisa: 10_500n,
    totalWeightGrams: 570,
    items: [
      {
        nameEn: 'Build Your Own Box',
        nameAr: 'صمم صندوقك',
        qty: 2,
        unitBaisa: 4500n,
        contents: [
          { name_en: 'Candied Orange', name_ar: 'برتقال مسكر', qty: 1 },
          { name_en: 'Dark Chocolate', name_ar: 'شوكولاتة داكنة', qty: 1 },
        ],
      },
    ],
    gift: {
      recipientName: 'Fatma Al Balushi',
      recipientPhone: '+96891234567',
      deliveryLocation: 'Al Khuwair, Muscat',
      giftMessage: 'كل عام وأنتِ بخير',
      giftMessageStatus: 'clean',
      hidePrices: true,
    },
    ...overrides,
  };
}

/**
 * Anything that could read as a price on a document a recipient will hold.
 * Deliberately broad — a false positive here costs a test edit, a false
 * negative costs the feature its entire point.
 */
const PRICE_SHAPED = [
  /\bOMR\b/i,
  /ر\.ع/,
  /ريال/,
  /\d+\.\d{3}\b/, // 4.500 — OMR's three-decimal form
  /\d+\.\d{2}\b/, // 4.50  — any other currency formatting
  /baisa/i,
  /بيسة/,
];

describe('packing slip', () => {
  it('carries no price-shaped text anywhere in the rendered output', () => {
    const html = renderPackingSlip(buildPackingSlip(order(), 'en'));
    for (const pattern of PRICE_SHAPED) {
      expect(html, `matched ${pattern}`).not.toMatch(pattern);
    }
  });

  it('carries no price-shaped text in Arabic either', () => {
    const html = renderPackingSlip(buildPackingSlip(order(), 'ar'));
    for (const pattern of PRICE_SHAPED) {
      expect(html, `matched ${pattern}`).not.toMatch(pattern);
    }
  });

  it('the detector actually catches prices — proven against the invoice', () => {
    // Guards the guard: if PRICE_SHAPED matched nothing, the tests above would
    // pass forever while catching no regression.
    const html = renderInvoice(buildInvoice(order(), 'en'));
    expect(PRICE_SHAPED.some((pattern) => pattern.test(html))).toBe(true);
  });

  it('still shows what to pack, and the gift message', () => {
    const html = renderPackingSlip(buildPackingSlip(order(), 'en'));
    expect(html).toContain('Build Your Own Box');
    expect(html).toContain('Candied Orange');
    expect(html).toContain('Fatma Al Balushi');
    expect(html).toContain('كل عام وأنتِ بخير');
  });

  it('renders Arabic right-to-left', () => {
    const html = renderPackingSlip(buildPackingSlip(order(), 'ar'));
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
  });

  it('escapes a gift message that contains markup', () => {
    const hostile = order({
      gift: { ...order().gift!, giftMessage: '<script>alert(1)</script>' },
    });
    const html = renderPackingSlip(buildPackingSlip(hostile, 'en'));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('refuses to build for a non-gift order', () => {
    expect(() => buildPackingSlip(order({ gift: null }), 'en')).toThrow(DocumentError);
  });

  it('refuses to build when the sender chose to show prices', () => {
    const shown = order({ gift: { ...order().gift!, hidePrices: false } });
    expect(() => buildPackingSlip(shown, 'en')).toThrow(/HIDE_PRICES/);
  });

  it('refuses to print a rejected gift message', () => {
    const rejected = order({ gift: { ...order().gift!, giftMessageStatus: 'rejected' } });
    expect(() => buildPackingSlip(rejected, 'en')).toThrow(/REJECTED/);
  });

  it('has no price-shaped key anywhere in the document model', () => {
    const doc = buildPackingSlip(order(), 'en');
    const serialised = JSON.stringify(doc);
    expect(serialised).not.toMatch(/baisa/i);
    expect(serialised).not.toMatch(/price/i);
    expect(serialised).not.toMatch(/total_?baisa/i);
  });
});

describe('invoice', () => {
  it('shows unit and line totals, VAT and the amount due', () => {
    const html = renderInvoice(buildInvoice(order(), 'en'));
    expect(html).toContain('4.500'); // unit
    expect(html).toContain('9.000'); // line total
    expect(html).toContain('0.500'); // VAT
    expect(html).toContain('10.500'); // grand total
  });

  it('omits the rounding row when there is nothing to explain', () => {
    const html = renderInvoice(buildInvoice(order(), 'en'));
    expect(html).not.toContain('Rounding');
  });

  it('shows the rounding row when an adjustment was applied', () => {
    const adjusted = order({ roundingAdjustmentBaisa: 3n, totalBaisa: 10_503n });
    const html = renderInvoice(buildInvoice(adjusted, 'en'));
    expect(html).toContain('Rounding');
  });

  it('uses Latin digits in Arabic, per Omani price convention', () => {
    const html = renderInvoice(buildInvoice(order(), 'ar'));
    expect(html).toContain('10.500');
    // No Eastern Arabic numerals in the money values.
    expect(html).not.toMatch(/[٠-٩]\.[٠-٩]/);
  });
});
