import { describe, expect, it } from 'vitest';
import { createConfiguratorStore } from '@/lib/configurator/store';
import { estimate, toSlotEntries, validate, slotAccepts } from '@/lib/configurator/pricing';
import type { CompositeProduct, Material, Slot } from '@/lib/configurator/types';

function slot(partial: Partial<Slot> & { slot_index: number }): Slot {
  return {
    id: `slot-${partial.slot_index}`,
    label_en: null,
    label_ar: null,
    position: { x: 0, y: 0, z: 0 },
    allowed_categories: [],
    max_qty: 1,
    is_required: false,
    ...partial,
  };
}

function material(partial: Partial<Material> & { id: string }): Material {
  return {
    sku: partial.id,
    name_en: 'Test',
    name_ar: 'اختبار',
    category: 'citrus',
    image_url: null,
    model_url: null,
    color_hex: null,
    unit_price_baisa: 750n,
    weight_grams: 45,
    available: 10,
    ...partial,
  };
}

const BOX: CompositeProduct = {
  id: 'box-1',
  slug: 'custom-box-4',
  kind: 'box',
  name_en: 'Box',
  name_ar: 'صندوق',
  base_price_baisa: 2500n,
  base_weight_grams: 180,
  model_url: 'models/box.glb',
  slot_count: 4,
  min_filled_slots: 1,
  slots: [slot({ slot_index: 0 }), slot({ slot_index: 1 }), slot({ slot_index: 2 }), slot({ slot_index: 3 })],
};

const BOUQUET: CompositeProduct = {
  ...BOX,
  id: 'bouquet-1',
  kind: 'bouquet',
  slot_count: 6,
  min_filled_slots: 3,
  slots: [
    slot({ slot_index: 0, is_required: true }),
    slot({ slot_index: 1, is_required: true }),
    slot({ slot_index: 2 }),
    slot({ slot_index: 3 }),
    slot({ slot_index: 4, allowed_categories: ['rose'] }),
    slot({ slot_index: 5, allowed_categories: ['rose'] }),
  ],
};

const ORANGE = material({ id: 'orange', category: 'citrus', unit_price_baisa: 750n, weight_grams: 45 });
const CHOCOLATE = material({ id: 'chocolate', category: 'chocolate', unit_price_baisa: 1250n, weight_grams: 60 });
const ROSE = material({ id: 'rose', category: 'rose', unit_price_baisa: 1400n, weight_grams: 35 });
const SOLD_OUT = material({ id: 'sold-out', available: 0 });

const MATERIALS = [ORANGE, CHOCOLATE, ROSE, SOLD_OUT];
const MATERIAL_MAP = new Map(MATERIALS.map((m) => [m.id, m]));

describe('estimate', () => {
  it('matches what price_configuration computes server-side', () => {
    const slotMap = new Map([
      [0, { raw_material_id: 'orange', qty: 1 }],
      [1, { raw_material_id: 'chocolate', qty: 1 }],
    ]);
    const result = estimate(BOX, slotMap, MATERIAL_MAP);

    // 2500 base + 750 + 1250 — the same arithmetic the integration test asserts.
    expect(result.unit_price_baisa).toBe(4500n);
    expect(result.total_weight_grams).toBe(285);
    expect(result.filled_slots).toBe(2);
  });

  it('is the base price when nothing is placed', () => {
    const result = estimate(BOX, new Map(), MATERIAL_MAP);
    expect(result.unit_price_baisa).toBe(2500n);
    expect(result.total_weight_grams).toBe(180);
  });

  it('multiplies by slot quantity', () => {
    const slotMap = new Map([[0, { raw_material_id: 'orange', qty: 3 }]]);
    expect(estimate(BOX, slotMap, MATERIAL_MAP).unit_price_baisa).toBe(2500n + 750n * 3n);
  });
});

describe('slotAccepts', () => {
  it('allows any category when the slot lists none', () => {
    expect(slotAccepts(slot({ slot_index: 0 }), CHOCOLATE, undefined)).toBe(true);
  });

  it('enforces the slot category whitelist', () => {
    const roseOnly = slot({ slot_index: 4, allowed_categories: ['rose'] });
    expect(slotAccepts(roseOnly, ROSE, undefined)).toBe(true);
    expect(slotAccepts(roseOnly, ORANGE, undefined)).toBe(false);
  });

  it('refuses a slot already at max_qty', () => {
    const single = slot({ slot_index: 0, max_qty: 1 });
    const occupant = { raw_material_id: 'orange', qty: 1 };
    expect(slotAccepts(single, ORANGE, occupant)).toBe(false);
  });
});

describe('validate', () => {
  it('passes a complete bouquet', () => {
    const slotMap = new Map([
      [0, { raw_material_id: 'orange', qty: 1 }],
      [1, { raw_material_id: 'chocolate', qty: 1 }],
      [4, { raw_material_id: 'rose', qty: 1 }],
    ]);
    expect(validate(BOUQUET, slotMap, MATERIAL_MAP)).toEqual([]);
  });

  it('reports every failure at once, not just the first', () => {
    const slotMap = new Map([[4, { raw_material_id: 'orange', qty: 1 }]]);
    const failures = validate(BOUQUET, slotMap, MATERIAL_MAP);
    const codes = failures.map((f) => f.code);

    expect(codes).toContain('CATEGORY_NOT_ALLOWED'); // orange in a rose-only ring
    expect(codes).toContain('MIN_FILL_NOT_MET'); // 1 of 3
    expect(codes).toContain('REQUIRED_SLOT_EMPTY'); // slots 0 and 1
    expect(failures.filter((f) => f.code === 'REQUIRED_SLOT_EMPTY')).toHaveLength(2);
  });
});

describe('toSlotEntries', () => {
  it('sorts by slot_index regardless of insertion order', () => {
    const slotMap = new Map([
      [3, { raw_material_id: 'orange', qty: 1 }],
      [0, { raw_material_id: 'rose', qty: 1 }],
      [2, { raw_material_id: 'chocolate', qty: 1 }],
    ]);
    expect(toSlotEntries(slotMap).map((e) => e.slot_index)).toEqual([0, 2, 3]);
  });
});

describe('configurator store', () => {
  const make = (product = BOX) => createConfiguratorStore(product, MATERIALS);

  it('places a material on drop', () => {
    const store = make();
    store.getState().startDrag('orange');
    expect(store.getState().dropOnSlot(0)).toBe(true);

    expect(store.getState().slotMap.get(0)).toEqual({ raw_material_id: 'orange', qty: 1 });
    expect(store.getState().estimate.unit_price_baisa).toBe(3250n);
  });

  it('supports tap-to-add as well as drag, and consumes the selection', () => {
    const store = make();
    store.getState().selectMaterial('orange');
    expect(store.getState().activeMaterial()?.id).toBe('orange');

    expect(store.getState().dropOnSlot(2)).toBe(true);
    expect(store.getState().slotMap.get(2)?.raw_material_id).toBe('orange');
    expect(store.getState().selectedMaterialId).toBeNull();
  });

  it('deselects when the same material is tapped twice', () => {
    const store = make();
    store.getState().selectMaterial('orange');
    store.getState().selectMaterial('orange');
    expect(store.getState().selectedMaterialId).toBeNull();
  });

  it('refuses to pick up a sold-out material', () => {
    const store = make();
    store.getState().startDrag('sold-out');
    expect(store.getState().dragging).toBeNull();

    store.getState().selectMaterial('sold-out');
    expect(store.getState().selectedMaterialId).toBeNull();
  });

  it('flags a rejection instead of placing into a disallowed slot', () => {
    const store = make(BOUQUET);
    store.getState().startDrag('orange');

    expect(store.getState().dropOnSlot(4)).toBe(false); // rose-only ring
    expect(store.getState().rejectedSlot).toBe(4);
    expect(store.getState().slotMap.size).toBe(0);

    store.getState().clearRejection();
    expect(store.getState().rejectedSlot).toBeNull();
  });

  it('a drag takes precedence over a lingering tap selection', () => {
    const store = make();
    store.getState().selectMaterial('orange');
    store.getState().startDrag('chocolate');
    expect(store.getState().activeMaterial()?.id).toBe('chocolate');
  });

  it('invalidates the authoritative price whenever the build changes', () => {
    const store = make();
    store.getState().startDrag('orange');
    store.getState().dropOnSlot(0);

    store.getState().applyServerPricing({
      unit_price_baisa: 3250n,
      total_weight_grams: 225,
      filled_slots: 1,
      config_hash: `sha256:${'a'.repeat(64)}`,
    });
    expect(store.getState().syncState).toBe('synced');

    // Any further edit must drop the stale server price, or the cart could be
    // handed a hash that no longer describes the build.
    store.getState().startDrag('chocolate');
    store.getState().dropOnSlot(1);
    expect(store.getState().server).toBeNull();
    expect(store.getState().syncState).toBe('idle');
  });

  it('bumps the revision on every mutation so the sync hook refires', () => {
    const store = make();
    const start = store.getState().revision;

    store.getState().startDrag('orange');
    store.getState().dropOnSlot(0);
    store.getState().clearSlot(0);

    expect(store.getState().revision).toBe(start + 2);
  });

  it('does not bump the revision when clearing an empty slot', () => {
    const store = make();
    const start = store.getState().revision;
    store.getState().clearSlot(3);
    expect(store.getState().revision).toBe(start);
  });

  it('stacks quantity when the same material is dropped on a multi-qty slot', () => {
    const product: CompositeProduct = {
      ...BOX,
      slots: [slot({ slot_index: 0, max_qty: 3 }), ...BOX.slots.slice(1)],
    };
    const store = createConfiguratorStore(product, MATERIALS);

    store.getState().startDrag('orange');
    store.getState().dropOnSlot(0);
    store.getState().startDrag('orange');
    store.getState().dropOnSlot(0);

    expect(store.getState().slotMap.get(0)).toEqual({ raw_material_id: 'orange', qty: 2 });
  });

  it('gates add-to-cart on the same rules the database enforces', () => {
    const store = make(BOUQUET);
    expect(store.getState().isComplete()).toBe(false);

    store.getState().startDrag('orange');
    store.getState().dropOnSlot(0);
    store.getState().startDrag('chocolate');
    store.getState().dropOnSlot(1);
    expect(store.getState().isComplete()).toBe(false); // 2 of 3 minimum

    store.getState().startDrag('rose');
    store.getState().dropOnSlot(4);
    expect(store.getState().isComplete()).toBe(true);
  });

  it('resets to an empty build', () => {
    const store = make();
    store.getState().startDrag('orange');
    store.getState().dropOnSlot(0);
    store.getState().reset();

    expect(store.getState().slotMap.size).toBe(0);
    expect(store.getState().estimate.unit_price_baisa).toBe(2500n);
  });
});
