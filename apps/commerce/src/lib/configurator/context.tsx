'use client';

import { createContext, useContext, useRef, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createConfiguratorStore, type ConfiguratorState, type ConfiguratorStore } from './store';
import type { CompositeProduct, Locale, Material } from './types';

const ConfiguratorContext = createContext<ConfiguratorStore | null>(null);
const LocaleContext = createContext<Locale>('en');

/**
 * Creates the store once per mount. A module-level store would be shared
 * across requests during SSR, leaking one visitor's build into another's.
 */
export function ConfiguratorProvider({
  product,
  materials,
  locale,
  children,
}: {
  product: CompositeProduct;
  materials: readonly Material[];
  locale: Locale;
  children: ReactNode;
}) {
  const storeRef = useRef<ConfiguratorStore | null>(null);
  storeRef.current ??= createConfiguratorStore(product, materials);

  return (
    <ConfiguratorContext.Provider value={storeRef.current}>
      <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
    </ConfiguratorContext.Provider>
  );
}

export function useConfiguratorStore(): ConfiguratorStore {
  const store = useContext(ConfiguratorContext);
  if (!store) {
    throw new Error('useConfigurator must be used inside <ConfiguratorProvider>');
  }
  return store;
}

export function useConfigurator<T>(selector: (state: ConfiguratorState) => T): T {
  return useStore(useConfiguratorStore(), selector);
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}
