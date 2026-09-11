'use client';

import { useEffect, useRef } from 'react';
import { useConfiguratorStore } from './context';
import { toSlotEntries } from './pricing';

export const PRICE_SYNC_DEBOUNCE_MS = 400;

/**
 * Debounced authoritative re-pricing.
 *
 * The ticker shows the client estimate immediately; this confirms it against
 * `price_configuration()` roughly 400ms after the last change. The server's
 * answer replaces the estimate, and its `config_hash` is what add-to-cart
 * sends — so a build can never be added under a price the server did not
 * compute.
 *
 * An in-flight response for a superseded revision is discarded rather than
 * applied: out-of-order responses would otherwise show the price of a build
 * the user has already moved on from.
 */
export function usePriceSync(): void {
  const store = useConfiguratorStore();
  const latestRevision = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const run = (revision: number) => {
      const state = store.getState();
      if (state.slotMap.size === 0) {
        state.setSyncState('idle');
        return;
      }

      controller?.abort();
      controller = new AbortController();
      state.setSyncState('syncing');

      void fetch('/api/configurations/price', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          composite_product_id: state.product.id,
          slot_map: toSlotEntries(state.slotMap),
        }),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`price sync failed: ${response.status}`);
          return response.json() as Promise<{
            unit_price_baisa: string;
            total_weight_grams: number;
            filled_slots: number;
            config_hash: string;
          }>;
        })
        .then((body) => {
          // A newer edit landed while this was in flight.
          if (revision !== latestRevision.current) return;
          store.getState().applyServerPricing({
            unit_price_baisa: BigInt(body.unit_price_baisa),
            total_weight_grams: body.total_weight_grams,
            filled_slots: body.filled_slots,
            config_hash: body.config_hash,
          });
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          if (revision !== latestRevision.current) return;
          store.getState().setSyncState('error');
        });
    };

    const unsubscribe = store.subscribe((state, previous) => {
      if (state.revision === previous.revision) return;
      latestRevision.current = state.revision;
      clearTimeout(timer);
      const revision = state.revision;
      timer = setTimeout(() => run(revision), PRICE_SYNC_DEBOUNCE_MS);
    });

    return () => {
      clearTimeout(timer);
      controller?.abort();
      unsubscribe();
    };
  }, [store]);
}
