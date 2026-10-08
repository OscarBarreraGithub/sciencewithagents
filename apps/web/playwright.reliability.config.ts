import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/home',
  testMatch: /(?:run-recovery|chat-cache-reopen)\.spec\.ts/,
  outputDir: '../../data/browser-results/reliability',
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4348', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: 'phone',
      use: { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true },
    },
    {
      name: 'small-phone',
      use: { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true },
    },
    {
      name: 'landscape',
      use: { viewport: { width: 915, height: 412 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: 'node ../server/dist/main.js --demo',
    env: { DOCK_PORT: '4348', DOCK_DATA_DIR: '../../data/browser-data/reliability' },
    port: 4348,
    reuseExistingServer: false,
    timeout: 15_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
