'use client';

import { useConfigurator } from '@/lib/configurator/context';
import { SlotDropZone } from './SlotDropZone';
import { SlotContents } from './SlotContents';

/**
 * The composite shell plus its drop zones.
 *
 * Geometry is procedural for now. The real pipeline is Draco + Meshopt GLBs
 * under 500KB loaded with `useGLTF(product.model_url)`; the slot colliders and
 * every interaction rule are independent of which mesh is underneath, so that
 * swap does not touch the rest of the configurator.
 *
 * Note the model is NOT mirrored in RTL. World coordinates stay put in both
 * locales; only the surrounding DOM flips. Slot ordering comes from
 * `composite_slots.position`, never from DOM order.
 */
export function ProductModel() {
  const kind = useConfigurator((state) => state.product.kind);
  const slots = useConfigurator((state) => state.product.slots);

  return (
    <group>
      {kind === 'box' ? <BoxShell /> : <BouquetRing />}

      {slots.map((slot) => (
        <SlotDropZone key={slot.id} slot={slot} radius={kind === 'box' ? 0.042 : 0.036} />
      ))}

      <SlotContents />
    </group>
  );
}

function BoxShell() {
  return (
    <group>
      <mesh position={[0, -0.01, 0]} receiveShadow>
        <boxGeometry args={[0.24, 0.03, 0.24]} />
        <meshStandardMaterial color="#8A6A4B" roughness={0.8} />
      </mesh>
      {/* Four walls, so the tray reads as a box rather than a plate. */}
      {(
        [
          [0, 0.03, -0.12],
          [0, 0.03, 0.12],
        ] as const
      ).map(([x, y, z], index) => (
        <mesh key={`wall-z-${index}`} position={[x, y, z]}>
          <boxGeometry args={[0.24, 0.06, 0.008]} />
          <meshStandardMaterial color="#75573C" roughness={0.85} />
        </mesh>
      ))}
      {(
        [
          [-0.12, 0.03, 0],
          [0.12, 0.03, 0],
        ] as const
      ).map(([x, y, z], index) => (
        <mesh key={`wall-x-${index}`} position={[x, y, z]}>
          <boxGeometry args={[0.008, 0.06, 0.24]} />
          <meshStandardMaterial color="#75573C" roughness={0.85} />
        </mesh>
      ))}
      {/* Divider cross marking the four slots. */}
      <mesh position={[0, 0.015, 0]}>
        <boxGeometry args={[0.232, 0.03, 0.006]} />
        <meshStandardMaterial color="#9B7A58" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.015, 0]}>
        <boxGeometry args={[0.006, 0.03, 0.232]} />
        <meshStandardMaterial color="#9B7A58" roughness={0.9} />
      </mesh>
    </group>
  );
}

/**
 * The bouquet's wrap and stem. Ring slot positions come from the database, not
 * from geometry here, so an admin can move them without a code change.
 */
export function BouquetRing() {
  return (
    <group>
      <mesh position={[0, -0.06, 0]} receiveShadow>
        <cylinderGeometry args={[0.02, 0.05, 0.18, 24]} />
        <meshStandardMaterial color="#2F5D3A" roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.05, 0]}>
        <coneGeometry args={[0.13, 0.14, 28, 1, true]} />
        <meshStandardMaterial color="#E8D9C0" roughness={0.6} side={2} />
      </mesh>
    </group>
  );
}
