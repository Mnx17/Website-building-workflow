'use client';

import { useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, PerformanceMonitor, Environment } from '@react-three/drei';
import { ProductModel } from './ProductModel';
import { useConfiguratorStore } from '@/lib/configurator/context';

/**
 * Low-end devices are a large share of GCC mobile traffic, so quality starts
 * conservative and only the shadow/environment work is dropped further if the
 * frame rate sags. `frameloop="demand"` matters more than any of it: the scene
 * is static between interactions, and rendering it at 60fps continuously is
 * what drains a phone battery in a configurator.
 */
function isLowEndDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const cores = navigator.hardwareConcurrency ?? 8;
  return cores <= 4;
}

export function ConfiguratorCanvas() {
  const [degraded, setDegraded] = useState(isLowEndDevice);
  const store = useConfiguratorStore();

  return (
    <Canvas
      frameloop="demand"
      dpr={degraded ? 1 : [1, 2]}
      shadows={!degraded}
      camera={{ position: [0.32, 0.34, 0.42], fov: 42 }}
      // Releasing the pointer anywhere ends the drag, including outside a slot.
      onPointerMissed={() => store.getState().endDrag()}
      style={{ touchAction: 'none' }}
    >
      <PerformanceMonitor onDecline={() => setDegraded(true)} />

      <ambientLight intensity={0.7} />
      <directionalLight
        position={[0.4, 0.8, 0.5]}
        intensity={1.1}
        castShadow={!degraded}
        shadow-mapSize={[1024, 1024]}
      />
      {!degraded && <Environment preset="apartment" />}

      <ProductModel />

      <OrbitControls
        makeDefault
        enablePan={false}
        minDistance={0.35}
        maxDistance={0.9}
        // Stop the camera dropping below the table.
        maxPolarAngle={Math.PI / 2.1}
      />
    </Canvas>
  );
}
