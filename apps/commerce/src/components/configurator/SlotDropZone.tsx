'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import type { Mesh } from 'three';
import { useConfigurator, useConfiguratorStore } from '@/lib/configurator/context';
import type { Slot } from '@/lib/configurator/types';

const REJECT_SHAKE_MS = 320;

/**
 * An invisible collider marking where a material may be dropped.
 *
 * Snapping is not physics: dropping anywhere inside this collider hard-sets
 * the item to `composite_slots.position`. Both input modes land here — pointer
 * drag raises `onPointerUp`, touch tap-to-place raises `onClick`.
 */
export function SlotDropZone({ slot, radius = 0.06 }: { slot: Slot; radius?: number }) {
  const mesh = useRef<Mesh>(null);
  const { invalidate } = useThree();
  const store = useConfiguratorStore();

  const hasActiveMaterial = useConfigurator((state) => state.activeMaterial() !== null);
  const occupant = useConfigurator((state) => state.slotMap.get(slot.slot_index));
  const rejected = useConfigurator((state) => state.rejectedSlot === slot.slot_index);
  const hovered = useConfigurator((state) => state.hoveredSlot === slot.slot_index);

  const accepts = useConfigurator((state) => state.accepts(slot.slot_index));

  // Clear the rejection flag after the shake has played.
  useEffect(() => {
    if (!rejected) return;
    const timer = setTimeout(() => {
      store.getState().clearRejection();
      invalidate();
    }, REJECT_SHAKE_MS);
    return () => clearTimeout(timer);
  }, [rejected, store, invalidate]);

  // The only per-frame work in the scene, and only while a slot is shaking.
  useFrame((state) => {
    if (!rejected || !mesh.current) return;
    const offset = Math.sin(state.clock.elapsedTime * 60) * 0.006;
    mesh.current.position.x = slot.position.x + offset;
    invalidate();
  });

  useEffect(() => {
    if (rejected || !mesh.current) return;
    mesh.current.position.x = slot.position.x;
  }, [rejected, slot.position.x]);

  const { opacity, color } = useMemo(() => {
    if (rejected) return { opacity: 0.55, color: '#D9534F' };
    if (!hasActiveMaterial) return { opacity: occupant ? 0 : 0.08, color: '#9AA5A0' };
    if (!accepts) return { opacity: hovered ? 0.3 : 0.12, color: '#D9534F' };
    return { opacity: hovered ? 0.5 : 0.28, color: '#3FBF7F' };
  }, [rejected, hasActiveMaterial, accepts, hovered, occupant]);

  const onPointerOver = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    if (!hasActiveMaterial) return;
    store.getState().setHoveredSlot(slot.slot_index, accepts ? 'valid' : 'invalid');
    invalidate();
  };

  const onPointerOut = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    store.getState().setHoveredSlot(null, null);
    invalidate();
  };

  const drop = (event: ThreeEvent<PointerEvent | MouseEvent>) => {
    event.stopPropagation();
    if (!hasActiveMaterial) {
      // Tapping a filled slot with nothing in hand empties it.
      if (occupant) {
        store.getState().clearSlot(slot.slot_index);
        invalidate();
      }
      return;
    }
    store.getState().dropOnSlot(slot.slot_index);
    invalidate();
  };

  return (
    <mesh
      ref={mesh}
      position={[slot.position.x, slot.position.y, slot.position.z]}
      rotation-y={slot.position.ry ?? 0}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
      onPointerUp={drop}
      onClick={drop}
    >
      <cylinderGeometry args={[radius, radius, 0.012, 24]} />
      <meshBasicMaterial transparent opacity={opacity} color={color} depthWrite={false} />
    </mesh>
  );
}
