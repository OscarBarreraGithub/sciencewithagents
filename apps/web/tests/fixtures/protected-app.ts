import { test as base } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../../server/dist/store.js';
import { Runtime } from '../../../server/dist/runtime.js';
import { DemoProvider } from '../../../server/dist/demo.js';
import { createServer } from '../../../server/dist/server.js';
import { PhoneAccess } from '../../../server/dist/phone-access.js';
import { LocalAccess, prepareLocalAccess } from '../../../server/dist/local-access.js';
import { prepareBrowserHandoff } from '../../../server/dist/local-browser-handoff.js';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
type ProtectedApp = { origin: string; browserOrigin: string; handoff: () => Promise<string> };

/** Owned loopback fixture; no runtime initialization, native accounts, turns or owner data. */
export const test = base.extend<{ protectedApp: ProtectedApp }>({
  protectedApp: async ({}, use) => {
    const parent = join(repo, 'data/browser-data/local-access');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'browser-'));
    const store = new Store(join(root, 'dock.sqlite'));
    const runtime = new Runtime(
      store,
      root,
      'unused-fixture-codex',
      async () => new DemoProvider(),
    );
    const port = 4348;
    const access = new LocalAccess(prepareLocalAccess(root, port));
    const origin = access.configuration.origin;
    const app = await createServer(store, runtime, {
      port,
      webDir: join(repo, 'apps/web/dist'),
      localAccess: access,
      phone: new PhoneAccess(store, null),
      ownsRuntime: false,
    });
    try {
      await app.listen({ host: '127.0.0.1', port });
      await use({
        origin,
        browserOrigin: access.browserOrigin,
        async handoff() {
          const url = await prepareBrowserHandoff(root, port);
          if (!url) throw Error('Fixture local authentication is missing.');
          return url;
        },
      });
    } finally {
      await app.close();
      await runtime.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
});
export { expect } from '@playwright/test';
