import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/groups-only',
  outputDir: '../../data/groups-only-browser/results',
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4372',
    serviceWorkers: 'block',
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
    command: 'node ../../scripts/groups-only-browser-fixture.mjs',
    env: {
      DOCK_DATA_DIR: '../../data/groups-only-browser/installation',
      DOCK_PORT: '4372',
      DOCK_CODEX_BIN: '/unavailable-codex',
      DOCK_CLAUDE_BIN: '/unavailable-claude',
      DOCK_CLUSTER_BOOTSTRAP_FILE: '',
    },
    port: 4372,
    reuseExistingServer: false,
    timeout: 15_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
