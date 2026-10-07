import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The isolated base has no hosted-service package yet. Resolve only the new
// contract subpaths for the NEW same-DO adapter test; do not import peer source.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@dock\/shared\/dist\/(.+)$/u,
        replacement: fileURLToPath(new URL('../../packages/shared/dist/$1', import.meta.url)),
      },
    ],
  },
  test: { include: ['src/group-promotion.test.ts'] },
});
