'use client';

import { useConfigurator, useLocale } from '@/lib/configurator/context';
import { formatOmr } from '@/lib/money';
import { translator } from '@/lib/i18n';

/**
 * Shows the client estimate immediately and the server's confirmed price once
 * it arrives. The estimate is never presented as final: while unconfirmed the
 * figure is marked "Estimated", and a server figure that differs replaces it
 * with a note rather than silently swapping the number under the user.
 */
export function PriceTicker() {
  const locale = useLocale();
  const t = translator(locale);

  const product = useConfigurator((state) => state.product);
  const estimate = useConfigurator((state) => state.estimate);
  const server = useConfigurator((state) => state.server);
  const syncState = useConfigurator((state) => state.syncState);
  const filled = useConfigurator((state) => state.slotMap.size);

  const price = server?.unit_price_baisa ?? estimate.unit_price_baisa;
  const grams = server?.total_weight_grams ?? estimate.total_weight_grams;
  const repriced =
    server !== null && server.unit_price_baisa !== estimate.unit_price_baisa;

  const status =
    syncState === 'syncing'
      ? t('configurator.confirming')
      : syncState === 'error'
        ? t('configurator.priceError')
        : server
          ? t('configurator.confirmed')
          : t('configurator.estimated');

  return (
    <div className="ticker" aria-live="polite">
      <div className="ticker__row">
        <span className="ticker__price">{formatOmr(price, locale)}</span>
        <span className="ticker__weight">{t('configurator.weight', { grams })}</span>
      </div>

      <p className="ticker__status" data-state={syncState} data-confirmed={!!server || undefined}>
        {status}
      </p>

      <p className="ticker__slots">
        {t('configurator.slotsFilled', { filled, total: product.slot_count })}
      </p>

      {repriced && <p className="ticker__repriced">{t('configurator.repriced')}</p>}
    </div>
  );
}
