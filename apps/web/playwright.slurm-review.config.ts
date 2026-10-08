import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base,
  testMatch: /slurm-review\.spec\.ts/,
  outputDir: '../../data/browser-results/slurm-review-port',
  use: { ...base.use, baseURL: 'http://127.0.0.1:4356', serviceWorkers: 'block' },
  webServer: {
    command: 'node ../server/dist/main.js --demo',
    env: { DOCK_PORT: '4356', DOCK_DATA_DIR: '../../data/browser-data/slurm-review-port' },
    port: 4356,
    reuseExistingServer: false,
    timeout: 15000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
  },
});
