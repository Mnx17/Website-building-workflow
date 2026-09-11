import { createMockProvider } from './mock';
import { createThawaniProvider, thawaniConfigFromEnv } from './thawani';
import { PaymentError, type PaymentProvider } from './types';

export * from './types';
export { mockWebhook, MOCK_SECRET } from './mock';

/**
 * Resolves a provider by name.
 *
 * `PAYMENT_PROVIDER=mock` is what CI and local development use. It is refused
 * outside development unless explicitly allowed, so a misconfigured deploy
 * cannot quietly accept unsigned "payments" in production.
 */
export function getPaymentProvider(
  name = process.env['PAYMENT_PROVIDER'] ?? 'thawani',
  env = process.env,
): PaymentProvider {
  switch (name) {
    case 'thawani':
      return createThawaniProvider(thawaniConfigFromEnv(env));

    case 'mock': {
      const allowed =
        env['NODE_ENV'] !== 'production' || env['ALLOW_MOCK_PAYMENTS'] === 'true';
      if (!allowed) {
        throw new PaymentError('MOCK_PROVIDER_FORBIDDEN_IN_PRODUCTION');
      }
      return createMockProvider(env['MOCK_WEBHOOK_SECRET']);
    }

    default:
      // MyFatoorah lands here as the secondary adapter; it implements the same
      // interface, so nothing above this function changes when it is added.
      throw new PaymentError(`UNKNOWN_PAYMENT_PROVIDER:${name}`);
  }
}
