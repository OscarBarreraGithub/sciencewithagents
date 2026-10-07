import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/groups',
  outputDir: '../../data/groups-ui/results',
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5197',
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
  ],
  webServer: {
    command: 'pnpm exec vite --config vite.groups-preview.config.ts',
    url: 'http://127.0.0.1:5197',
    reuseExistingServer: false,
    timeout: 15_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
