import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch:
    /(?:cluster-workspace|cluster-project-scope|cluster-project-setup|fresh-manager)\.spec\.ts/,
  outputDir: '../../data/browser-results/cluster-ui-port',
  use: { ...base.use, baseURL: 'http://127.0.0.1:4354', serviceWorkers: 'block' },
  webServer: {
    command: 'node ../server/dist/main.js --demo',
    env: {
      DOCK_PORT: '4354',
      DOCK_DATA_DIR: '../../data/browser-data/cluster-ui-port',
    },
    port: 4354,
    reuseExistingServer: false,
    timeout: 15_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
