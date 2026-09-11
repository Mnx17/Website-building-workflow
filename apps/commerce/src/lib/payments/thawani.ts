import { verifyHmacSignature } from './signature';
import {
  PaymentError,
  type CreateSessionParams,
  type PaymentProvider,
  type PaymentSession,
  type WebhookOutcome,
  type WebhookVerification,
} from './types';

/**
 * Thawani Checkout adapter.
 *
 * Amounts are sent as integer baisa, which is Thawani's native unit — no
 * conversion, no float, and the line items must sum to the order total.
 *
 * UNVERIFIED AGAINST A LIVE ACCOUNT. The session-creation shape follows
 * Thawani's published Checkout API, but the webhook signature header name and
 * payload envelope have NOT been confirmed against a real sandbox, because no
 * merchant credentials exist yet. Both are isolated in `parseWebhookBody` and
 * the header constants below; confirm them during onboarding before going
 * live. The signature verification itself (raw body, timing-safe, timestamp
 * window) is provider-independent and correct as written.
 */

const SIGNATURE_HEADER = 'thawani-signature';
const TIMESTAMP_HEADER = 'thawani-timestamp';

type ThawaniSessionResponse = {
  success?: boolean;
  code?: number;
  data?: { session_id?: string };
};

export type ThawaniConfig = {
  apiKey: string;
  publishableKey: string;
  webhookSecret: string;
  /** UAT: https://uatcheckout.thawani.om/api/v1 */
  baseUrl: string;
  checkoutBaseUrl: string;
};

export function thawaniConfigFromEnv(env = process.env): ThawaniConfig {
  const apiKey = env['THAWANI_API_KEY'];
  const publishableKey = env['THAWANI_PUBLISHABLE_KEY'];
  const webhookSecret = env['THAWANI_WEBHOOK_SECRET'];
  const baseUrl = env['THAWANI_BASE_URL'] ?? 'https://uatcheckout.thawani.om/api/v1';
  const checkoutBaseUrl =
    env['THAWANI_CHECKOUT_URL'] ?? 'https://uatcheckout.thawani.om/pay';

  if (!apiKey || !publishableKey || !webhookSecret) {
    throw new PaymentError('THAWANI_NOT_CONFIGURED');
  }
  return { apiKey, publishableKey, webhookSecret, baseUrl, checkoutBaseUrl };
}

export function createThawaniProvider(config: ThawaniConfig): PaymentProvider {
  return {
    name: 'thawani',

    async createSession(params: CreateSessionParams): Promise<PaymentSession> {
      assertLinesMatchTotal(params);

      const response = await fetch(`${config.baseUrl}/checkout/session`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'thawani-api-key': config.apiKey,
        },
        body: JSON.stringify({
          client_reference_id: params.orderId,
          mode: 'payment',
          products: params.lines.map((line) => ({
            name: line.nameEn,
            quantity: line.qty,
            unit_amount: Number(line.unitBaisa),
          })),
          success_url: params.successUrl,
          cancel_url: params.cancelUrl,
          metadata: { order_number: params.orderNumber },
        }),
      });

      if (!response.ok) {
        throw new PaymentError(`THAWANI_SESSION_FAILED:${response.status}`);
      }

      const body = (await response.json()) as ThawaniSessionResponse;
      const sessionId = body.data?.session_id;
      if (!sessionId) {
        throw new PaymentError('THAWANI_SESSION_MISSING_ID');
      }

      return {
        sessionId,
        paymentUrl: `${config.checkoutBaseUrl}/${sessionId}?key=${config.publishableKey}`,
      };
    },

    verifyWebhook(rawBody: string, headers: Headers): WebhookVerification {
      const check = verifyHmacSignature({
        rawBody,
        signature: headers.get(SIGNATURE_HEADER),
        timestamp: headers.get(TIMESTAMP_HEADER),
        secret: config.webhookSecret,
      });
      if (!check.ok) return { ok: false, reason: check.reason };

      return parseWebhookBody(rawBody);
    },

    async refund(params): Promise<void> {
      const response = await fetch(`${config.baseUrl}/refunds`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'thawani-api-key': config.apiKey,
        },
        body: JSON.stringify({
          payment_id: params.reference,
          reason: `refund for order ${params.orderId}`,
        }),
      });
      if (!response.ok) {
        throw new PaymentError(`THAWANI_REFUND_FAILED:${response.status}`);
      }
    },
  };
}

/** Isolated so the envelope can be corrected in one place after onboarding. */
export function parseWebhookBody(rawBody: string): WebhookVerification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'unparseable_body' };
  }

  const body = parsed as {
    event_id?: string;
    id?: string;
    event_type?: string;
    data?: { client_reference_id?: string; payment_status?: string; payment_id?: string };
  };

  const eventId = body.event_id ?? body.id;
  const orderId = body.data?.client_reference_id;
  if (!eventId || !orderId) {
    return { ok: false, reason: 'missing_identifiers' };
  }

  return {
    ok: true,
    eventId,
    orderId,
    outcome: toOutcome(body.data?.payment_status ?? body.event_type),
    reference: body.data?.payment_id,
  };
}

function toOutcome(status: string | undefined): WebhookOutcome {
  switch ((status ?? '').toLowerCase()) {
    case 'paid':
    case 'success':
    case 'succeeded':
    case 'checkout.completed':
      return 'paid';
    case 'cancelled':
    case 'canceled':
    case 'expired':
      return 'cancelled';
    default:
      return 'failed';
  }
}

function assertLinesMatchTotal(params: CreateSessionParams): void {
  const sum = params.lines.reduce(
    (total, line) => total + line.unitBaisa * BigInt(line.qty),
    0n,
  );
  if (sum !== params.totalBaisa) {
    // The gateway charges the sum of the lines. If that disagrees with the
    // order total, the customer is billed an amount the invoice cannot explain.
    throw new PaymentError(`LINE_TOTAL_MISMATCH:${sum}:${params.totalBaisa}`);
  }
}
