import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The concurrency test deliberately opens 50 connections and waits on
    // row locks; the default 5s timeout is too tight.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration test files share one database. Running them in parallel
    // makes stock assertions depend on interleaving.
    fileParallelism: false,
  },
});
