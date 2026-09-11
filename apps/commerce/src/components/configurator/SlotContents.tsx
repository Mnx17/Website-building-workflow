'use client';

import { useConfigurator } from '@/lib/configurator/context';
import { findSlot } from '@/lib/configurator/pricing';
import type { Material } from '@/lib/configurator/types';

/**
 * Renders what is currently placed in each slot.
 *
 * Placeholder geometry until the GLB assets land: a material's `model_url` is
 * already carried through from the database, so swapping in `useGLTF` here is
 * a one-component change that touches nothing else.
 */
function PlacedItem({
  material,
  position,
  scale,
}: {
  material: Material;
  position: [number, number, number];
  scale: number;
}) {
  return (
    <mesh position={position} castShadow>
      <sphereGeometry args={[0.032 * scale, 20, 20]} />
      <meshStandardMaterial
        color={material.color_hex ?? '#C08B5C'}
        roughness={0.45}
        metalness={0.05}
      />
    </mesh>
  );
}

export function SlotContents() {
  const product = useConfigurator((state) => state.product);
  const slotMap = useConfigurator((state) => state.slotMap);
  const materials = useConfigurator((state) => state.materials);

  return (
    <group>
      {[...slotMap.entries()].map(([slotIndex, placement]) => {
        const slot = findSlot(product, slotIndex);
        const material = materials.get(placement.raw_material_id);
        if (!slot || !material) return null;

        // A slot holding more than one unit stacks them vertically.
        return Array.from({ length: placement.qty }, (_, unit) => (
          <PlacedItem
            key={`${slotIndex}-${unit}`}
            material={material}
            position={[
              slot.position.x,
              slot.position.y + 0.03 + unit * 0.055,
              slot.position.z,
            ]}
            scale={1}
          />
        ));
      })}
    </group>
  );
}
