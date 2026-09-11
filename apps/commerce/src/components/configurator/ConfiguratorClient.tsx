'use client';

import dynamic from 'next/dynamic';
import { ConfiguratorProvider } from '@/lib/configurator/context';
import { usePriceSync } from '@/lib/configurator/use-price-sync';
import { MaterialTray } from './MaterialTray';
import { PriceTicker } from './PriceTicker';
import { AddToCartBar } from './AddToCartBar';
import {
  hydrateMaterial,
  hydrateProduct,
  type CompositeProductWire,
  type Locale,
  type MaterialWire,
} from '@/lib/configurator/types';
import { useMemo } from 'react';

/**
 * The WebGL bundle is large and useless on the server, so it is loaded only on
 * the client and only once this route is reached.
 */
const ConfiguratorCanvas = dynamic(
  () => import('./ConfiguratorCanvas').then((m) => m.ConfiguratorCanvas),
  { ssr: false, loading: () => <div className="canvas__placeholder" /> },
);

function ConfiguratorBody({ title }: { title: string }) {
  usePriceSync();

  return (
    <div className="configurator">
      <div className="configurator__stage">
        <h1 className="configurator__title">{title}</h1>
        <div className="canvas">
          <ConfiguratorCanvas />
        </div>
      </div>

      <aside className="configurator__panel">
        <MaterialTray />
        <PriceTicker />
        <AddToCartBar />
      </aside>
    </div>
  );
}

export function ConfiguratorClient({
  product,
  materials,
  locale,
}: {
  product: CompositeProductWire;
  materials: readonly MaterialWire[];
  locale: Locale;
}) {
  const hydratedProduct = useMemo(() => hydrateProduct(product), [product]);
  const hydratedMaterials = useMemo(() => materials.map(hydrateMaterial), [materials]);
  const title = locale === 'ar' ? product.name_ar : product.name_en;

  return (
    <ConfiguratorProvider
      product={hydratedProduct}
      materials={hydratedMaterials}
      locale={locale}
    >
      <ConfiguratorBody title={title} />
    </ConfiguratorProvider>
  );
}
