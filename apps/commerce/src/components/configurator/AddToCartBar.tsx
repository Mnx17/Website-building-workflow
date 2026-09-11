'use client';

import { useState } from 'react';
import { useConfigurator, useConfiguratorStore, useLocale } from '@/lib/configurator/context';
import { toSlotEntries, validate } from '@/lib/configurator/pricing';
import { addCompositeToCart } from '@/lib/cart-client';
import { translator, type MessageKey } from '@/lib/i18n';

type Status = 'idle' | 'adding' | 'added' | 'error';

/** Maps a server domain code to a message the shopper can act on. */
const ERROR_KEY: Record<string, MessageKey> = {
  CATEGORY_NOT_ALLOWED: 'configurator.categoryNotAllowed',
  REQUIRED_SLOT_EMPTY: 'configurator.requiredEmpty',
};

export function AddToCartBar() {
  const locale = useLocale();
  const t = translator(locale);
  const store = useConfiguratorStore();

  const product = useConfigurator((state) => state.product);
  const slotMap = useConfigurator((state) => state.slotMap);
  const materials = useConfigurator((state) => state.materials);
  const estimate = useConfigurator((state) => state.estimate);

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  const failures = validate(product, slotMap, materials);
  const blocked = failures.length > 0;

  // Lead with what the shopper must do next, not a generic "invalid build".
  const blockingMessage = (() => {
    const required = failures.find((f) => f.code === 'REQUIRED_SLOT_EMPTY');
    if (required) return t('configurator.requiredEmpty');
    const minFill = failures.find((f) => f.code === 'MIN_FILL_NOT_MET');
    if (minFill && minFill.code === 'MIN_FILL_NOT_MET') {
      return t('configurator.needMore', { required: minFill.required });
    }
    const category = failures.find((f) => f.code === 'CATEGORY_NOT_ALLOWED');
    if (category) return t('configurator.categoryNotAllowed');
    return null;
  })();

  async function onAdd() {
    setStatus('adding');
    setError(null);
    try {
      const result = await addCompositeToCart({
        compositeProductId: product.id,
        slotMap: toSlotEntries(slotMap),
        estimateBaisa: estimate.unit_price_baisa,
        estimateGrams: estimate.total_weight_grams,
        locale,
      });
      setStatus('added');
      if (result.repriced) {
        store.getState().applyServerPricing({
          unit_price_baisa: result.unit_price_baisa,
          total_weight_grams: estimate.total_weight_grams,
          filled_slots: slotMap.size,
          config_hash: '',
        });
      }
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : 'ADD_FAILED';
      const key = ERROR_KEY[code];
      setError(key ? t(key) : code);
      setStatus('error');
    }
  }

  return (
    <div className="addbar">
      {blockingMessage && <p className="addbar__blocked">{blockingMessage}</p>}
      {error && (
        <p className="addbar__error" role="alert">
          {error}
        </p>
      )}

      <div className="addbar__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            store.getState().reset();
            setStatus('idle');
            setError(null);
          }}
        >
          {t('configurator.reset')}
        </button>

        <button
          type="button"
          className="btn btn--primary"
          disabled={blocked || status === 'adding'}
          onClick={() => void onAdd()}
        >
          {status === 'adding'
            ? t('configurator.adding')
            : status === 'added'
              ? t('configurator.added')
              : t('configurator.addToCart')}
        </button>
      </div>
    </div>
  );
}
