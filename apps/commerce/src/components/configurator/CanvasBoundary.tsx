'use client';

import { Component, useEffect, useState, type ReactNode } from 'react';
import { useConfigurator, useLocale } from '@/lib/configurator/context';
import { findSlot } from '@/lib/configurator/pricing';
import { materialName, slotLabel } from '@/lib/configurator/types';
import { translator } from '@/lib/i18n';

/**
 * Keeps a WebGL failure from taking the whole route down.
 *
 * Without this, a browser with no WebGL context — headless Chrome, a locked-down
 * corporate build, an old Android, a GPU blocklist — throws during hydration
 * and Next replaces the entire document with "Application error". The shopper
 * cannot even see the products, let alone buy them.
 *
 * The plan's risk register called for a non-3D fallback for low-end devices.
 * This is it: the tray, pricing, validation and add-to-cart all keep working,
 * because none of them ever depended on three.js. Only the view is replaced.
 */
class ErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error('[configurator] 3D view unavailable, falling back', error);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Cheap feature probe: try to get a context before mounting the renderer. */
function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      canvas.getContext('webgl2') ??
        canvas.getContext('webgl') ??
        canvas.getContext('experimental-webgl'),
    );
  } catch {
    return false;
  }
}

/**
 * The 2D fallback: the same slots, as a list. Every interaction rule lives in
 * the store, so tapping a slot here behaves exactly as tapping it in 3D.
 */
function SlotList() {
  const locale = useLocale();
  const t = translator(locale);
  const product = useConfigurator((state) => state.product);
  const slotMap = useConfigurator((state) => state.slotMap);
  const materials = useConfigurator((state) => state.materials);
  const dropOnSlot = useConfigurator((state) => state.dropOnSlot);
  const clearSlot = useConfigurator((state) => state.clearSlot);
  const hasActive = useConfigurator((state) => state.activeMaterial() !== null);

  return (
    <div className="slotlist" data-testid="slot-list-fallback">
      <p className="card__hint">{t('configurator.dragHint')}</p>
      <ul>
        {product.slots.map((slot) => {
          const placement = slotMap.get(slot.slot_index);
          const material = placement ? materials.get(placement.raw_material_id) : undefined;

          return (
            <li key={slot.id}>
              <button
                type="button"
                className="slotlist__slot"
                data-filled={material ? true : undefined}
                onClick={() =>
                  hasActive ? dropOnSlot(slot.slot_index) : clearSlot(slot.slot_index)
                }
              >
                <span className="slotlist__label">{slotLabel(slot, locale)}</span>
                <span className="slotlist__value">
                  {material ? materialName(material, locale) : '—'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function CanvasBoundary({ children }: { children: ReactNode }) {
  // Probed after mount: the server has no `document`, and guessing from a user
  // agent string is how you end up wrong about exactly the devices that matter.
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => setSupported(hasWebGL()), []);

  if (supported === null) return <div className="canvas__placeholder" />;
  if (!supported) return <SlotList />;

  return <ErrorBoundary fallback={<SlotList />}>{children}</ErrorBoundary>;
}
