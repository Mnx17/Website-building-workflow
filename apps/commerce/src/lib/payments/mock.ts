import { randomUUID } from 'node:crypto';
import { signPayload, verifyHmacSignature } from './signature';
import type {
  CreateSessionParams,
  PaymentProvider,
  PaymentSession,
  WebhookVerification,
} from './types';
import { parseWebhookBody } from './thawani';

/**
 * In-process provider for tests and local development.
 *
 * It signs and verifies with the same code path Thawani uses, so the webhook
 * route — signature check, replay guard, stock commit — is exercised for real
 * without a merchant account. What it CANNOT prove is that the live gateway's
 * envelope and header names match; that remains an open item until sandbox
 * credentials exist.
 */

export const MOCK_SECRET = 'mock-webhook-secret';

export function createMockProvider(secret = MOCK_SECRET): PaymentProvider {
  return {
    name: 'mock',

    async createSession(params: CreateSessionParams): Promise<PaymentSession> {
      const sessionId = `mock_${randomUUID()}`;
      return {
        sessionId,
        paymentUrl: `https://example.invalid/pay/${sessionId}?order=${params.orderNumber}`,
      };
    },

    verifyWebhook(rawBody: string, headers: Headers): WebhookVerification {
      const check = verifyHmacSignature({
        rawBody,
        signature: headers.get('mock-signature'),
        timestamp: headers.get('mock-timestamp'),
        secret,
      });
      if (!check.ok) return { ok: false, reason: check.reason };
      return parseWebhookBody(rawBody);
    },

    async refund(): Promise<void> {
      /* no-op */
    },
  };
}

/** Builds a signed webhook exactly as the route expects to receive it. */
export function mockWebhook(params: {
  orderId: string;
  outcome?: 'paid' | 'failed' | 'cancelled';
  eventId?: string;
  secret?: string;
  timestamp?: number;
}): { body: string; headers: Headers } {
  const timestamp = String(params.timestamp ?? Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    event_id: params.eventId ?? randomUUID(),
    data: {
      client_reference_id: params.orderId,
      payment_status: params.outcome ?? 'paid',
      payment_id: `pay_${randomUUID()}`,
    },
  });

  const headers = new Headers({
    'content-type': 'application/json',
    'mock-timestamp': timestamp,
    'mock-signature': signPayload(body, params.secret ?? MOCK_SECRET),
  });

  return { body, headers };
}
