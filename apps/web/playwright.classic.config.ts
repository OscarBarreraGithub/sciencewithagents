import { defineConfig } from '@playwright/test';
import home from './playwright.config';

export default defineConfig({
  ...home,
  testDir: './tests/classic',
  outputDir: '../../data/browser-results/classic',
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'phone', use: { viewport: { width: 412, height: 915 } } },
    { name: 'small-phone', use: { viewport: { width: 360, height: 800 } } },
    { name: 'landscape', use: { viewport: { width: 915, height: 412 } } },
  ],
  webServer: {
    command: 'node ../server/dist/main.js --demo',
    env: {
      DOCK_PORT: '4339',
      DOCK_DATA_DIR: process.env.DOCK_E2E_DATA_DIR ?? '../../data/browser-data/classic',
    },
    port: 4339,
    reuseExistingServer: false,
    timeout: 15_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
