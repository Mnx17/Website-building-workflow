import { z } from 'zod';

/**
 * Gifting rules.
 *
 * `hide_prices` governs recipient-facing documents only. The buyer always sees
 * full prices everywhere — their own confirmation, invoice and order history.
 */

export const GIFT_MESSAGE_MAX_GRAPHEMES = 280;

/**
 * Counts user-perceived characters, not UTF-16 code units.
 *
 * Arabic combining marks and emoji make `String.length` overcount badly: a
 * counter built on it tells an Arabic-speaking customer their message is too
 * long when it visibly is not.
 */
export function graphemeLength(value: string): number {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let count = 0;
    for (const _ of segmenter.segment(value)) count += 1;
    return count;
  }
  return [...value].length; // code points — still better than .length
}

/** Oman mobile numbers are +968 followed by 8 digits starting 7 or 9. */
const OMANI_PHONE = /^\+968[79]\d{7}$/;
const INTERNATIONAL_PHONE = /^\+\d{8,15}$/;

/**
 * A +968 number must satisfy the Omani rule — the international pattern must
 * not be allowed to rescue it.
 *
 * Without this precedence, `+96851234567` (a typo: 5 is not a valid Omani
 * mobile prefix) still matches `^\+\d{8,15}$` and is accepted as an
 * "international" number. The courier then cannot reach the recipient, and for
 * a gift order the buyer is not the one who finds out.
 */
export function isValidRecipientPhone(value: string): boolean {
  if (value.startsWith('+968')) return OMANI_PHONE.test(value);
  return INTERNATIONAL_PHONE.test(value);
}

export const giftDetailsSchema = z.object({
  recipient_name: z.string().trim().min(2).max(120),
  recipient_phone: z
    .string()
    .trim()
    .refine(
      isValidRecipientPhone,
      'Enter a valid phone number in international format, e.g. +96891234567',
    ),
  delivery_location: z.string().trim().min(3).max(500),
  delivery_geo: z.object({ lat: z.number(), lng: z.number() }).optional(),
  gift_message: z
    .string()
    .trim()
    .refine(
      (value) => graphemeLength(value) <= GIFT_MESSAGE_MAX_GRAPHEMES,
      `Keep the message to ${GIFT_MESSAGE_MAX_GRAPHEMES} characters or fewer`,
    )
    .optional(),
  hide_prices: z.boolean().default(true),
});

export type GiftDetails = z.infer<typeof giftDetailsSchema>;

export type GiftMessageStatus = 'clean' | 'flagged' | 'rejected';

/**
 * Screening hook.
 *
 * Deliberately a pure function with an injectable word list rather than a
 * bundled dictionary: the real list is a business decision, needs Arabic and
 * English coverage, and should be editable by staff without a deploy. A
 * flagged message is held for review, never silently edited — rewriting
 * someone's gift message is worse than delaying it.
 */
export function screenGiftMessage(
  message: string | undefined,
  blocklist: readonly string[] = [],
): GiftMessageStatus {
  if (!message) return 'clean';
  const haystack = message.toLowerCase();
  return blocklist.some((term) => term && haystack.includes(term.toLowerCase()))
    ? 'flagged'
    : 'clean';
}

export type GiftEligibility =
  | { allowed: true }
  | { allowed: false; code: 'GIFT_COD_NOT_ALLOWED' | 'GIFT_INTERNATIONAL_NEEDS_CUSTOMS' };

/**
 * Gift + cash on delivery is blocked outright: asking a recipient to pay for
 * their own present is a support incident, not an edge case.
 *
 * Gift + international is allowed but flagged — customs declarations legally
 * require a declared value, so the price-free slip cannot be the customs form
 * and the buyer must be told before paying.
 */
export function checkGiftEligibility(params: {
  isGift: boolean;
  paymentMethod: 'card' | 'cod';
  zoneIsFallback: boolean;
}): GiftEligibility {
  if (!params.isGift) return { allowed: true };
  if (params.paymentMethod === 'cod') {
    return { allowed: false, code: 'GIFT_COD_NOT_ALLOWED' };
  }
  if (params.zoneIsFallback) {
    return { allowed: false, code: 'GIFT_INTERNATIONAL_NEEDS_CUSTOMS' };
  }
  return { allowed: true };
}
