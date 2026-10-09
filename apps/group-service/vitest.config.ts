import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include: ['test/**/*.test.ts'],
    // Real workerd fixtures retain ~528 MiB SQLite pressure. Avoid concurrent
    // file runtimes competing for CI memory/CPU; in-test authority races stay explicit.
    fileParallelism: false,
  },
});
