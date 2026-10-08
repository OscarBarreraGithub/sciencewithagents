import { defineConfig, devices } from '@playwright/test';
// Client cache checks. Each spec starts and closes its own 127.0.0.1 fixture server from
// source files; no app server, account or runtime data is involved.
export default defineConfig({
  testDir: './tests/cache',
  outputDir: '../../data/browser-results/cache',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    { name: 'iphone-webkit', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
});
