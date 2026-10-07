import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/group-documents',
  outputDir: '../../data/group-documents-ui/results',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5199', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'phone', use: { viewport: { width: 412, height: 915 } } },
    { name: 'small-phone', use: { viewport: { width: 360, height: 800 } } },
    { name: 'landscape', use: { viewport: { width: 915, height: 412 } } },
  ],
  webServer: {
    command: 'pnpm exec vite --config vite.group-documents.config.ts',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
