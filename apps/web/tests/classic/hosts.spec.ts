import { test, expect, type Page } from './fixture';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer as reservePort } from 'node:net';
import { Store } from '../../../server/dist/store.js';
import { Runtime } from '../../../server/dist/runtime.js';
import { DemoProvider } from '../../../server/dist/demo.js';
import { createServer } from '../../../server/dist/server.js';
import { Hosts } from '../../../server/dist/hosts.js';
import { WorkspaceState } from '../../../server/dist/workspace-state.js';

test('computer selection keeps accounts, drafts and offline recovery separate', async ({
  page,
  context,
}, info) => {
  const fixtures: {
    root: string;
    app: Awaited<ReturnType<typeof createServer>>;
    store: Store;
    online: boolean;
    config: {
      id: string;
      label: string;
      accountLabel: string;
      sshAlias: string;
      expectedHostId: string;
      remotePort: number;
    };
  }[] = [];
  const gatewayRoot = mkdtempSync(join(tmpdir(), 'dock-browser-gateway-'));
  const gatewayStore = new Store(join(gatewayRoot, 'dock.sqlite'));
  let gateway: Awaited<ReturnType<typeof createServer>> | undefined;
  let hosts: Hosts | undefined;
  let modelRequests = 0;
  let otherTab: Page | undefined;
  let closing = false;
  const bridges = new Set<Promise<void>>();
  try {
    for (const label of ['School', 'Family', 'Travel']) {
      const reservation = reservePort();
      await new Promise<void>((resolve, reject) => {
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', resolve);
      });
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
      const root = mkdtempSync(join(tmpdir(), 'dock-browser-hosts-'));
      const store = new Store(join(root, 'dock.sqlite'));
      store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 2 });
      store.register(root, `${label} projects`, 'Isolated computer acceptance fixture');
      const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
      const workspace = new WorkspaceState(store);
      const app = await createServer(store, runtime, { port, demo: true });
      fixtures.push({
        root,
        store,
        app,
        online: true,
        config: {
          id: randomUUID(),
          label: `${label} computer`,
          accountLabel: `${label} account`,
          expectedHostId: workspace.hostId,
          sshAlias: `fixture-${label.toLowerCase()}`,
          remotePort: port,
        },
      });
      await app.listen({ host: '127.0.0.1', port });
    }
    fixtures[2].online = false;
    hosts = new Hosts(
      fixtures[0].root,
      async (host) => {
        const fixture = fixtures.find((item) => item.config.id === host.id)!;
        if (!fixture.online) throw new Error('Fixture offline');
        return { port: host.remotePort, alive: () => fixture.online, async close() {} };
      },
      fixtures.map((fixture) => fixture.config),
    );
    gateway = await createServer(
      gatewayStore,
      new Runtime(gatewayStore, gatewayRoot, 'codex', async () => new DemoProvider()),
      {
        port: 4999,
        hosts,
        demo: true,
      },
    );
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const gatewayPort = (gateway.server.address() as { port: number }).port;
    await context.route(/\/api\/hosts(?:\/|$)/, (route) => {
      const handle = (async () => {
        try {
          const request = route.request(),
            url = new URL(request.url());
          if (url.pathname.endsWith('/messages')) modelRequests++;
          if (url.pathname.endsWith('/events')) {
            await route.fulfill({
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
              body: '',
            });
            return;
          }
          const response = await context.request.fetch(
            `http://127.0.0.1:${gatewayPort}${url.pathname}${url.search}`,
            {
              method: request.method(),
              headers: {
                'content-type': 'application/json',
                host: '127.0.0.1:4999',
                origin: 'http://127.0.0.1:4999',
              },
              data: request.postDataBuffer() ?? undefined,
            },
          );
          await route.fulfill({ response });
        } catch (error) {
          if (!closing) throw error;
          await route.abort().catch(() => {});
        }
      })();
      bridges.add(handle);
      void handle.finally(() => bridges.delete(handle)).catch(() => {});
      return handle;
    });
    const openComputers = async () => {
      if (
        page.viewportSize()!.width <= 720 &&
        !(await page.getByLabel('Computer', { exact: true }).isVisible())
      )
        await page.getByRole('button', { name: 'Open projects' }).click();
    };
    const choose = async (index: number) => {
      await openComputers();
      await page.getByLabel('Computer', { exact: true }).selectOption(fixtures[index].config.id);
    };
    await page.goto('/');
    await choose(0);
    const draft = page.getByRole('textbox', { name: /^Message / });
    await expect(draft).toBeVisible();
    await draft.fill('Private school draft');
    await choose(1);
    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue('');
    await draft.fill('Family draft');
    await choose(0);
    await expect(draft).toHaveValue('Private school draft');
    await page.reload();
    await expect(draft).toHaveValue('Private school draft');
    await openComputers();
    await expect(page.getByLabel('Computer', { exact: true })).toHaveValue(fixtures[0].config.id);
    await page.screenshot({ path: `../../data/screenshots/${info.project.name}-computers.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await choose(2);
    await openComputers();
    await expect(page.getByRole('region', { name: 'Computer connection' })).toContainText(
      'not connected',
    );
    await expect(
      page.getByRole('heading', {
        name: /Connect to sciencewithagents|Enter pairing code|Name your phone|Connect to your computer/,
      }),
    ).toHaveCount(0);
    await expect(draft).toHaveCount(0);
    await expect(page.getByLabel('Computer', { exact: true })).toHaveValue(fixtures[2].config.id);
    fixtures[2].online = true;
    await page.getByRole('button', { name: 'Try connection again' }).click();
    if (page.viewportSize()!.width <= 720)
      await page
        .getByRole('navigation', { name: 'Projects', exact: true })
        .getByRole('button', { name: /Travel projects/ })
        .click();
    await expect(draft).toBeVisible({ timeout: 10_000 });
    await expect(draft).toHaveValue('');
    expect(modelRequests).toBe(0);
    await choose(1);
    await expect(draft).toHaveValue('Family draft');
    expect(modelRequests).toBe(0);

    // Tabs share localStorage, not the account of an already-open document.
    otherTab = await context.newPage();
    await otherTab.goto('http://127.0.0.1:4339');
    if (otherTab.viewportSize()!.width <= 720)
      await otherTab.getByRole('button', { name: 'Open projects' }).click();
    await otherTab.getByLabel('Computer', { exact: true }).selectOption(fixtures[0].config.id);
    const schoolDraft = otherTab.getByRole('textbox', { name: /^Message / });
    await expect(schoolDraft).toHaveValue('Private school draft');
    // A local edit forces the old tab to rerender after the other tab switches.
    await draft.fill('Family message stays on its original computer');
    await openComputers();
    await expect(page.getByLabel('Computer', { exact: true })).toHaveValue(fixtures[1].config.id);
    if (page.viewportSize()!.width <= 720)
      await page
        .getByRole('navigation', { name: 'Projects', exact: true })
        .getByRole('button', { name: /Family projects/ })
        .click();
    await expect(draft).toHaveValue('Family message stays on its original computer');
    await expect(schoolDraft).toHaveValue('Private school draft');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(draft).toHaveValue('');
    expect(modelRequests).toBe(1);
    expect(fixtures[1].store.runs()).toHaveLength(1);
    expect(fixtures[1].store.runs()[0]).toMatchObject({
      text: 'Family message stays on its original computer',
      status: 'queued',
    });
    expect(fixtures[0].store.runs()).toHaveLength(0);
    await expect(schoolDraft).toHaveValue('Private school draft');
  } finally {
    closing = true;
    await otherTab?.close();
    await page.close();
    await Promise.allSettled([...bridges]);
    await gateway?.close();
    await hosts?.close();
    if (gatewayStore.db.isOpen) gatewayStore.close();
    rmSync(gatewayRoot, { recursive: true, force: true });
    for (const fixture of fixtures) {
      await fixture.app.close();
      if (fixture.store.db.isOpen) fixture.store.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});
