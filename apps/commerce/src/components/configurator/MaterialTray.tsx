'use client';

import { useConfigurator, useConfiguratorStore, useLocale } from '@/lib/configurator/context';
import { materialName } from '@/lib/configurator/types';
import { formatOmr } from '@/lib/money';
import { translator } from '@/lib/i18n';

/**
 * The material palette.
 *
 * Both input modes are first-class: pointer-down starts a drag, click selects
 * for tap-to-place. Touch users get the second because dragging from DOM onto
 * a WebGL canvas is unreliable on mobile browsers.
 *
 * Laid out with logical properties only (`ps-`/`pe-`/`margin-inline`), so the
 * tray flips with `dir="rtl"` while the 3D scene behind it does not move.
 */
export function MaterialTray() {
  const locale = useLocale();
  const t = translator(locale);
  const store = useConfiguratorStore();

  const materials = useConfigurator((state) => [...state.materials.values()]);
  const selectedId = useConfigurator((state) => state.selectedMaterialId);
  const draggingId = useConfigurator((state) => state.dragging?.id ?? null);

  return (
    <section className="tray" aria-label={t('configurator.tray')}>
      <h2 className="tray__title">{t('configurator.tray')}</h2>
      <p className="tray__hint">{t('configurator.dragHint')}</p>

      <ul className="tray__list">
        {materials.map((material) => {
          const soldOut = material.available <= 0;
          const active = selectedId === material.id || draggingId === material.id;

          return (
            <li key={material.id}>
              <button
                type="button"
                className="chip"
                data-active={active || undefined}
                data-sold-out={soldOut || undefined}
                disabled={soldOut}
                aria-pressed={active}
                onPointerDown={() => store.getState().startDrag(material.id)}
                onPointerUp={() => store.getState().endDrag()}
                onClick={() => store.getState().selectMaterial(material.id)}
              >
                <span
                  className="chip__swatch"
                  style={{ background: material.color_hex ?? '#C08B5C' }}
                  aria-hidden
                />
                <span className="chip__body">
                  <span className="chip__name">{materialName(material, locale)}</span>
                  <span className="chip__price">
                    {soldOut
                      ? t('configurator.soldOut')
                      : formatOmr(material.unit_price_baisa, locale)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
