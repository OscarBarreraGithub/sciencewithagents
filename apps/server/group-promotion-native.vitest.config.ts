import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@dock\/shared\/dist\/(.+)$/u,
        replacement: fileURLToPath(new URL('../../packages/shared/dist/$1', import.meta.url)),
      },
    ],
  },
  test: { include: ['src/group-promotion-native-synthesis.test.ts'] },
});
