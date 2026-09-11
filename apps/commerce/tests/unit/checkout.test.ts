import { describe, expect, it } from 'vitest';
import { computeTotals, totalsReconcile } from '@/lib/checkout/totals';
import { aggregateWeight } from '@/lib/shipping';
import {
  checkGiftEligibility,
  graphemeLength,
  screenGiftMessage,
  giftDetailsSchema,
  GIFT_MESSAGE_MAX_GRAPHEMES,
} from '@/lib/gifting';
import { signPayload, verifyHmacSignature } from '@/lib/payments/signature';
import { parseWebhookBody } from '@/lib/payments/thawani';

describe('computeTotals', () => {
  it('reconciles exactly, always', () => {
    for (let subtotal = 0n; subtotal < 300n; subtotal += 7n) {
      for (const shipping of [0n, 1000n, 1543n]) {
        const totals = computeTotals({ subtotalBaisa: subtotal, shippingBaisa: shipping });
        expect(totalsReconcile(totals)).toBe(true);
      }
    }
  });

  it('charges a multiple of 10 baisa for card payments', () => {
    for (let subtotal = 1n; subtotal < 500n; subtotal += 3n) {
      const totals = computeTotals({ subtotalBaisa: subtotal, shippingBaisa: 1000n });
      expect(totals.totalBaisa % 10n).toBe(0n);
    }
  });

  it('does not round for cash on delivery', () => {
    const totals = computeTotals({
      subtotalBaisa: 8753n,
      shippingBaisa: 1000n,
      incrementBaisa: 1n,
    });
    expect(totals.roundingAdjustmentBaisa).toBe(0n);
    expect(totals.totalBaisa).toBe(8753n + 1000n + totals.vatBaisa);
  });

  it('taxes shipping by default and can be told not to', () => {
    const taxed = computeTotals({ subtotalBaisa: 10_000n, shippingBaisa: 2000n });
    const untaxed = computeTotals({
      subtotalBaisa: 10_000n,
      shippingBaisa: 2000n,
      taxShipping: false,
    });
    expect(taxed.vatBaisa).toBe(600n); // 5% of 12,000
    expect(untaxed.vatBaisa).toBe(500n); // 5% of 10,000
  });

  it('rejects negative amounts', () => {
    expect(() => computeTotals({ subtotalBaisa: -1n, shippingBaisa: 0n })).toThrow(RangeError);
  });
});

describe('aggregateWeight', () => {
  it('multiplies unit weight by quantity', () => {
    expect(
      aggregateWeight([
        { unitWeightGrams: 285, qty: 2 },
        { unitWeightGrams: 620, qty: 1 },
      ]),
    ).toBe(1190);
  });

  it('is zero for an empty cart', () => {
    expect(aggregateWeight([])).toBe(0);
  });
});

describe('gift message length', () => {
  it('counts Arabic combining marks as one character each', () => {
    // Arabic text with diacritics: .length overcounts badly.
    const withHarakat = 'مَرْحَبًا';
    expect(withHarakat.length).toBeGreaterThan(graphemeLength(withHarakat));
  });

  it('counts an emoji with a modifier as one character', () => {
    expect(graphemeLength('👍🏽')).toBe(1);
    expect('👍🏽'.length).toBeGreaterThan(1);
  });

  it('accepts a message at the limit and rejects one past it', () => {
    const base = {
      recipient_name: 'Fatma',
      recipient_phone: '+96891234567',
      delivery_location: 'Al Khuwair, Muscat',
    };

    expect(
      giftDetailsSchema.safeParse({
        ...base,
        gift_message: 'ا'.repeat(GIFT_MESSAGE_MAX_GRAPHEMES),
      }).success,
    ).toBe(true);

    expect(
      giftDetailsSchema.safeParse({
        ...base,
        gift_message: 'ا'.repeat(GIFT_MESSAGE_MAX_GRAPHEMES + 1),
      }).success,
    ).toBe(false);
  });
});

describe('gift phone validation', () => {
  const base = {
    recipient_name: 'Fatma',
    delivery_location: 'Al Khuwair, Muscat',
  };

  it.each(['+96891234567', '+96871234567', '+971501234567'])('accepts %s', (phone) => {
    expect(giftDetailsSchema.safeParse({ ...base, recipient_phone: phone }).success).toBe(true);
  });

  it.each(['91234567', '+96851234567', 'not a phone', '+968912345678'])(
    'rejects %s',
    (phone) => {
      expect(giftDetailsSchema.safeParse({ ...base, recipient_phone: phone }).success).toBe(
        false,
      );
    },
  );

  it('defaults hide_prices to true', () => {
    const parsed = giftDetailsSchema.parse({ ...base, recipient_phone: '+96891234567' });
    expect(parsed.hide_prices).toBe(true);
  });
});

describe('screenGiftMessage', () => {
  it('flags rather than edits', () => {
    expect(screenGiftMessage('this contains badword here', ['badword'])).toBe('flagged');
  });

  it('is clean with no blocklist or no message', () => {
    expect(screenGiftMessage('anything at all')).toBe('clean');
    expect(screenGiftMessage(undefined, ['badword'])).toBe('clean');
  });

  it('is case insensitive', () => {
    expect(screenGiftMessage('BadWord', ['badword'])).toBe('flagged');
  });
});

describe('checkGiftEligibility', () => {
  it('blocks gift + cash on delivery', () => {
    const result = checkGiftEligibility({
      isGift: true,
      paymentMethod: 'cod',
      zoneIsFallback: false,
    });
    expect(result).toEqual({ allowed: false, code: 'GIFT_COD_NOT_ALLOWED' });
  });

  it('blocks gift + international until customs is handled', () => {
    const result = checkGiftEligibility({
      isGift: true,
      paymentMethod: 'card',
      zoneIsFallback: true,
    });
    expect(result).toEqual({ allowed: false, code: 'GIFT_INTERNATIONAL_NEEDS_CUSTOMS' });
  });

  it('allows a domestic card gift', () => {
    expect(
      checkGiftEligibility({ isGift: true, paymentMethod: 'card', zoneIsFallback: false }),
    ).toEqual({ allowed: true });
  });

  it('leaves non-gift COD alone', () => {
    expect(
      checkGiftEligibility({ isGift: false, paymentMethod: 'cod', zoneIsFallback: false }),
    ).toEqual({ allowed: true });
  });
});

describe('webhook signature', () => {
  const secret = 'shhh';
  const body = JSON.stringify({ event_id: 'evt_1', data: { client_reference_id: 'o1' } });
  const now = 1_700_000_000;

  it('accepts a correct signature', () => {
    const result = verifyHmacSignature({
      rawBody: body,
      signature: signPayload(body, secret),
      secret,
      timestamp: String(now),
      nowSeconds: now,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = signPayload(body, secret);
    const result = verifyHmacSignature({
      rawBody: body.replace('o1', 'o2'),
      signature,
      secret,
      timestamp: String(now),
      nowSeconds: now,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects the wrong secret', () => {
    const result = verifyHmacSignature({
      rawBody: body,
      signature: signPayload(body, 'wrong'),
      secret,
      timestamp: String(now),
      nowSeconds: now,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a stale timestamp, so a captured payload cannot be replayed forever', () => {
    const result = verifyHmacSignature({
      rawBody: body,
      signature: signPayload(body, secret),
      secret,
      timestamp: String(now - 3600),
      nowSeconds: now,
    });
    expect(result).toEqual({ ok: false, reason: 'stale' });
  });

  it('rejects a missing signature outright', () => {
    const result = verifyHmacSignature({ rawBody: body, signature: null, secret });
    expect(result).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('accepts hex and base64 encodings', () => {
    const hex = signPayload(body, secret);
    const base64 = Buffer.from(hex, 'hex').toString('base64');
    for (const signature of [hex, `sha256=${hex}`, base64]) {
      expect(verifyHmacSignature({ rawBody: body, signature, secret }).ok).toBe(true);
    }
  });

  it('does not throw on a garbage signature', () => {
    expect(() =>
      verifyHmacSignature({ rawBody: body, signature: '!!!!', secret }),
    ).not.toThrow();
  });
});

describe('parseWebhookBody', () => {
  it('maps paid statuses to the paid outcome', () => {
    for (const status of ['paid', 'success', 'succeeded']) {
      const result = parseWebhookBody(
        JSON.stringify({
          event_id: 'e',
          data: { client_reference_id: 'o', payment_status: status },
        }),
      );
      expect(result.ok && result.outcome).toBe('paid');
    }
  });

  it('treats an unknown status as failed rather than paid', () => {
    const result = parseWebhookBody(
      JSON.stringify({
        event_id: 'e',
        data: { client_reference_id: 'o', payment_status: 'something_new' },
      }),
    );
    expect(result.ok && result.outcome).toBe('failed');
  });

  it('rejects a body with no identifiers', () => {
    expect(parseWebhookBody(JSON.stringify({ nope: true }))).toEqual({
      ok: false,
      reason: 'missing_identifiers',
    });
  });

  it('rejects unparseable JSON', () => {
    expect(parseWebhookBody('not json')).toEqual({ ok: false, reason: 'unparseable_body' });
  });
});
