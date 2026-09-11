/**
 * Configurator state.
 *
 * Built with zustand's vanilla `createStore` rather than the React hook so the
 * interaction rules can be unit-tested in Node with no renderer, and so the
 * store is created per request — a module-level singleton would leak one
 * visitor's build into another's during SSR.
 *
 * The store performs no I/O. It exposes a `revision` counter that increments
 * on every mutation; `usePriceSync` watches that and debounces the
 * authoritative server call. Keeping fetch out of the store is what makes
 * these rules testable.
 */
import { createStore } from 'zustand/vanilla';
import { estimate, slotAccepts, findSlot, validate, type Estimate, type SlotMap } from './pricing';
import type {
  CompositeProduct,
  Material,
  Placement,
  ServerPricing,
  SlotHighlight,
  SyncState,
} from './types';

export type ConfiguratorState = {
  product: CompositeProduct;
  materials: ReadonlyMap<string, Material>;

  slotMap: SlotMap;
  /** Pointer-drag source. Null when not dragging. */
  dragging: Material | null;
  /** Tap-to-add selection, the touch equivalent of `dragging`. */
  selectedMaterialId: string | null;
  hoveredSlot: number | null;
  hoveredHighlight: SlotHighlight;
  /** Set briefly on an invalid drop to drive the shake animation. */
  rejectedSlot: number | null;

  estimate: Estimate;
  server: ServerPricing | null;
  syncState: SyncState;
  /** Increments on every mutation; drives the debounced price sync. */
  revision: number;

  startDrag: (materialId: string) => void;
  endDrag: () => void;
  selectMaterial: (materialId: string | null) => void;
  setHoveredSlot: (slotIndex: number | null, highlight: SlotHighlight) => void;
  /** The active material: a pointer drag takes precedence over a tap selection. */
  activeMaterial: () => Material | null;
  accepts: (slotIndex: number) => boolean;
  placeInSlot: (slotIndex: number, materialId: string) => boolean;
  /** Drag-or-tap drop onto a slot. Returns false and flags a rejection if invalid. */
  dropOnSlot: (slotIndex: number) => boolean;
  clearSlot: (slotIndex: number) => void;
  clearRejection: () => void;
  reset: () => void;

  setSyncState: (state: SyncState) => void;
  applyServerPricing: (pricing: ServerPricing) => void;

  isComplete: () => boolean;
};

export type ConfiguratorStore = ReturnType<typeof createConfiguratorStore>;

export function createConfiguratorStore(
  product: CompositeProduct,
  materialList: readonly Material[],
) {
  const materials: ReadonlyMap<string, Material> = new Map(
    materialList.map((material) => [material.id, material]),
  );
  const emptyMap: SlotMap = new Map();

  return createStore<ConfiguratorState>()((set, get) => ({
    product,
    materials,

    slotMap: emptyMap,
    dragging: null,
    selectedMaterialId: null,
    hoveredSlot: null,
    hoveredHighlight: null,
    rejectedSlot: null,

    estimate: estimate(product, emptyMap, materials),
    server: null,
    syncState: 'idle',
    revision: 0,

    startDrag: (materialId) => {
      const material = get().materials.get(materialId);
      if (!material || material.available <= 0) return;
      set({ dragging: material });
    },

    endDrag: () => set({ dragging: null, hoveredSlot: null, hoveredHighlight: null }),

    selectMaterial: (materialId) => {
      if (materialId === null) {
        set({ selectedMaterialId: null });
        return;
      }
      const material = get().materials.get(materialId);
      if (!material || material.available <= 0) return;
      // Tapping the selected material again deselects it.
      set({
        selectedMaterialId: get().selectedMaterialId === materialId ? null : materialId,
      });
    },

    setHoveredSlot: (slotIndex, highlight) =>
      set({ hoveredSlot: slotIndex, hoveredHighlight: highlight }),

    activeMaterial: () => {
      const state = get();
      if (state.dragging) return state.dragging;
      if (state.selectedMaterialId) {
        return state.materials.get(state.selectedMaterialId) ?? null;
      }
      return null;
    },

    accepts: (slotIndex) => {
      const state = get();
      const material = state.activeMaterial();
      if (!material) return false;
      const slot = findSlot(state.product, slotIndex);
      if (!slot) return false;
      return slotAccepts(slot, material, state.slotMap.get(slotIndex));
    },

    placeInSlot: (slotIndex, materialId) => {
      const state = get();
      const slot = findSlot(state.product, slotIndex);
      const material = state.materials.get(materialId);
      if (!slot || !material) return false;

      const occupant = state.slotMap.get(slotIndex);
      if (!slotAccepts(slot, material, occupant)) return false;

      const next = new Map(state.slotMap);
      const replacingSame = occupant?.raw_material_id === materialId;
      const placement: Placement = replacingSame
        ? { raw_material_id: materialId, qty: Math.min(occupant.qty + 1, slot.max_qty) }
        : { raw_material_id: materialId, qty: 1 };
      next.set(slotIndex, placement);

      set({
        slotMap: next,
        estimate: estimate(state.product, next, state.materials),
        revision: state.revision + 1,
        // A new build invalidates the previous authoritative price.
        server: null,
        syncState: 'idle',
      });
      return true;
    },

    dropOnSlot: (slotIndex) => {
      const state = get();
      const material = state.activeMaterial();
      if (!material) return false;

      if (!state.accepts(slotIndex)) {
        set({ rejectedSlot: slotIndex });
        return false;
      }

      const placed = state.placeInSlot(slotIndex, material.id);
      if (placed) {
        // A tap selection is consumed by the drop; a drag ends on pointerup.
        set({ selectedMaterialId: null, hoveredSlot: null, hoveredHighlight: null });
      }
      return placed;
    },

    clearSlot: (slotIndex) => {
      const state = get();
      if (!state.slotMap.has(slotIndex)) return;
      const next = new Map(state.slotMap);
      next.delete(slotIndex);
      set({
        slotMap: next,
        estimate: estimate(state.product, next, state.materials),
        revision: state.revision + 1,
        server: null,
        syncState: 'idle',
      });
    },

    clearRejection: () => set({ rejectedSlot: null }),

    reset: () => {
      const state = get();
      set({
        slotMap: emptyMap,
        dragging: null,
        selectedMaterialId: null,
        hoveredSlot: null,
        hoveredHighlight: null,
        rejectedSlot: null,
        estimate: estimate(state.product, emptyMap, state.materials),
        server: null,
        syncState: 'idle',
        revision: state.revision + 1,
      });
    },

    setSyncState: (syncState) => set({ syncState }),

    applyServerPricing: (pricing) => set({ server: pricing, syncState: 'synced' }),

    isComplete: () => {
      const state = get();
      return validate(state.product, state.slotMap, state.materials).length === 0;
    },
  }));
}
