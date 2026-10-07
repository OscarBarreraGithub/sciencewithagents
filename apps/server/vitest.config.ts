import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // SQLite FULL-sync, TLS and owned-child fixtures share the runner's disks.
    // Bound concurrent files instead of relaxing their safety/retry deadlines.
    maxWorkers: 2,
  },
});
