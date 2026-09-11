/**
 * Payment provider abstraction.
 *
 * Thawani is primary and MyFatoorah the intended fallback, but the deeper
 * reason this interface exists is that the merchant's acquiring options are
 * not yet confirmed — Stripe cannot onboard an Omani entity, so the provider
 * may well change before launch. Everything above this line (checkout, order
 * state, fulfilment) is written against the interface, never against Thawani.
 */

export type PaymentLine = {
  nameEn: string;
  unitBaisa: bigint;
  qty: number;
};

export type CreateSessionParams = {
  orderId: string;
  orderNumber: string;
  totalBaisa: bigint;
  lines: readonly PaymentLine[];
  successUrl: string;
  cancelUrl: string;
  customerPhone?: string | undefined;
};

export type PaymentSession = {
  sessionId: string;
  paymentUrl: string;
};

export type WebhookOutcome = 'paid' | 'failed' | 'cancelled';

export type WebhookVerification =
  | {
      ok: true;
      /** Provider-unique event id — the replay guard's dedupe key. */
      eventId: string;
      orderId: string;
      outcome: WebhookOutcome;
      reference: string | undefined;
    }
  | { ok: false; reason: string };

export interface PaymentProvider {
  readonly name: string;
  createSession(params: CreateSessionParams): Promise<PaymentSession>;
  /**
   * Verifies against the RAW request body. Never pass a re-serialised object:
   * `JSON.parse` then `JSON.stringify` will not reproduce the exact bytes the
   * signature covers.
   */
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification;
  refund(params: { orderId: string; reference: string; amountBaisa: bigint }): Promise<void>;
}

export class PaymentError extends Error {}
