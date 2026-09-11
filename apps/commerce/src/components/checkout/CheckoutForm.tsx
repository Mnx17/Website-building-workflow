'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatOmr } from '@/lib/money';
import { translator } from '@/lib/i18n';
import { graphemeLength, GIFT_MESSAGE_MAX_GRAPHEMES } from '@/lib/gifting';
import type { Locale } from '@/lib/configurator/types';

type CartLine = {
  id: string;
  qty: number;
  unit_price_baisa: string;
  unit_weight_grams: number;
};

type CartSummary = {
  id: string;
  items: CartLine[];
  subtotal_baisa: string;
  total_weight_grams: number;
};

const CART_STORAGE_KEY = 'sweets.cart_id';

/**
 * Checkout form.
 *
 * Deliberately thin: it collects fields and posts them. Totals, shipping, VAT,
 * rounding and every gifting rule are computed server-side — this form never
 * shows a total it calculated itself, because a number the customer sees here
 * that disagrees with what the gateway charges is worse than showing nothing.
 */
export function CheckoutForm({
  locale,
  governorates,
}: {
  locale: Locale;
  governorates: string[];
}) {
  const t = translator(locale);
  const router = useRouter();

  const [cartId, setCartId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartSummary | null>(null);
  const [governorate, setGovernorate] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'cod'>('card');
  const [isGift, setIsGift] = useState(false);
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [deliveryLocation, setDeliveryLocation] = useState('');
  const [giftMessage, setGiftMessage] = useState('');
  const [hidePrices, setHidePrices] = useState(true);
  const [status, setStatus] = useState<'idle' | 'submitting'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(CART_STORAGE_KEY);
    } catch {
      /* blocked storage */
    }
    if (!stored) return;
    setCartId(stored);

    void fetch(`/api/cart/${stored}/items`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: CartSummary | null) => setCart(body))
      .catch(() => setCart(null));
  }, []);

  /**
   * Counted in grapheme clusters, not UTF-16 units: Arabic combining marks
   * make `String.length` overcount badly, and a counter built on it tells an
   * Arabic-speaking customer their message is too long when it visibly is not.
   */
  const charsLeft = useMemo(
    () => GIFT_MESSAGE_MAX_GRAPHEMES - graphemeLength(giftMessage),
    [giftMessage],
  );

  // Mirrors the server rule so the customer is told before submitting, not after.
  const giftCodBlocked = isGift && paymentMethod === 'cod';

  const canSubmit =
    cartId !== null &&
    (cart?.items.length ?? 0) > 0 &&
    governorate !== '' &&
    !giftCodBlocked &&
    charsLeft >= 0 &&
    (!isGift || (recipientName.trim() !== '' && recipientPhone.trim() !== '' &&
      deliveryLocation.trim() !== '')) &&
    status === 'idle';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || !cartId) return;

    setStatus('submitting');
    setError(null);

    try {
      const response = await fetch('/api/checkout/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cart_id: cartId,
          governorate,
          payment_method: paymentMethod,
          locale,
          ...(isGift
            ? {
                gift: {
                  recipient_name: recipientName,
                  recipient_phone: recipientPhone,
                  delivery_location: deliveryLocation,
                  ...(giftMessage.trim() ? { gift_message: giftMessage } : {}),
                  hide_prices: hidePrices,
                },
              }
            : {}),
        }),
      });

      const body = (await response.json()) as {
        order_id?: string;
        payment_url?: string;
        error?: string;
        message?: string;
      };

      if (!response.ok) {
        setError(body.message ?? body.error ?? 'CHECKOUT_FAILED');
        setStatus('idle');
        return;
      }

      if (body.payment_url) {
        window.location.href = body.payment_url;
        return;
      }
      router.push(`/${locale}/checkout/success?order=${body.order_id}`);
    } catch {
      setError('NETWORK');
      setStatus('idle');
    }
  }

  return (
    <form className="checkout" onSubmit={(event) => void submit(event)}>
      <h1>{t('checkout.title')}</h1>

      <section className="card">
        <h2>{t('cart.title')}</h2>
        {cart === null || cart.items.length === 0 ? (
          <p className="card__hint" data-testid="cart-empty">
            {t('cart.empty')}
          </p>
        ) : (
          <dl className="summary">
            <dt>{t('cart.subtotal')}</dt>
            <dd data-testid="cart-subtotal">
              {formatOmr(BigInt(cart.subtotal_baisa), locale)}
            </dd>
            <dt>{t('cart.weight')}</dt>
            <dd>{t('configurator.weight', { grams: cart.total_weight_grams })}</dd>
          </dl>
        )}
      </section>

      <section className="card">
        <label className="field">
          <span>{t('checkout.governorate')}</span>
          <select
            name="governorate"
            value={governorate}
            onChange={(event) => setGovernorate(event.target.value)}
            required
          >
            <option value="">{t('checkout.chooseGovernorate')}</option>
            {governorates.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="field">
          <legend>{t('checkout.payment')}</legend>
          {(['card', 'cod'] as const).map((method) => (
            <label key={method} className="radio">
              <input
                type="radio"
                name="payment_method"
                value={method}
                checked={paymentMethod === method}
                onChange={() => setPaymentMethod(method)}
              />
              <span>{t(method === 'card' ? 'checkout.card' : 'checkout.cod')}</span>
            </label>
          ))}
        </fieldset>
      </section>

      <section className="card">
        <label className="checkbox">
          <input
            type="checkbox"
            name="is_gift"
            checked={isGift}
            onChange={(event) => setIsGift(event.target.checked)}
          />
          <span>🎁 {t('checkout.isGift')}</span>
        </label>

        {isGift && (
          <div className="gift" data-testid="gift-fields">
            <label className="field">
              <span>{t('checkout.recipientName')}</span>
              <input
                name="recipient_name"
                value={recipientName}
                onChange={(event) => setRecipientName(event.target.value)}
                required
              />
            </label>

            <label className="field">
              <span>{t('checkout.recipientPhone')}</span>
              <input
                name="recipient_phone"
                inputMode="tel"
                placeholder="+96891234567"
                value={recipientPhone}
                onChange={(event) => setRecipientPhone(event.target.value)}
                required
              />
            </label>

            <label className="field">
              <span>{t('checkout.deliveryLocation')}</span>
              <input
                name="delivery_location"
                value={deliveryLocation}
                onChange={(event) => setDeliveryLocation(event.target.value)}
                required
              />
            </label>

            <label className="field">
              <span>{t('checkout.giftMessage')}</span>
              <textarea
                name="gift_message"
                rows={3}
                value={giftMessage}
                onChange={(event) => setGiftMessage(event.target.value)}
              />
              <small data-testid="chars-left" data-over={charsLeft < 0 || undefined}>
                {t('checkout.charsLeft', { n: charsLeft })}
              </small>
            </label>

            <label className="checkbox">
              <input
                type="checkbox"
                name="hide_prices"
                checked={hidePrices}
                onChange={(event) => setHidePrices(event.target.checked)}
              />
              <span>{t('checkout.hidePrices')}</span>
            </label>
            <p className="card__hint">{t('checkout.hidePricesHint')}</p>
          </div>
        )}

        {giftCodBlocked && (
          <p className="addbar__error" role="alert" data-testid="gift-cod-blocked">
            {t('checkout.giftCodBlocked')}
          </p>
        )}
      </section>

      {error && (
        <p className="addbar__error" role="alert" data-testid="checkout-error">
          {error}
        </p>
      )}

      <button
        type="submit"
        className="btn btn--primary"
        disabled={!canSubmit}
        data-testid="submit-order"
      >
        {status === 'submitting'
          ? t('checkout.submitting')
          : t(paymentMethod === 'card' ? 'checkout.pay' : 'checkout.placeOrder')}
      </button>
    </form>
  );
}
