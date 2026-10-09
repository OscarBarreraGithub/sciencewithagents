import { defineConfig } from '@playwright/test';
import home from './playwright.config';

export default defineConfig({
  ...home,
  testMatch: 'group-managed-capability.spec.ts',
  outputDir: '../../data/group-capability/browser-results',
  projects: home.projects?.filter((project) => project.name !== 'iphone-webkit'),
  use: { ...home.use, baseURL: 'http://127.0.0.1:5298' },
  webServer: {
    command: 'node ../server/dist/main.js --demo',
    env: {
      DOCK_PORT: '5298',
      DOCK_DATA_DIR: '../../data/group-capability/browser-data',
    },
    port: 5298,
    reuseExistingServer: false,
    timeout: 15_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
