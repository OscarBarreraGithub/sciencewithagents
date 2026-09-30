import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/home',
  outputDir: '../../data/browser-results/home',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4339',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
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
    { name: 'iphone-webkit', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
  webServer: {
    command: 'node ../server/dist/main.js --demo',
    env: {
      DOCK_PORT: '4339',
      DOCK_DATA_DIR: process.env.DOCK_E2E_DATA_DIR ?? '../../data/browser-data/home',
    },
    port: 4339,
    reuseExistingServer: false,
    timeout: 15_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
