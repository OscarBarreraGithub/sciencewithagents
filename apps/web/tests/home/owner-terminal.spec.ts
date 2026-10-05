import { expect, test, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../server/dist/store.js';
import { Runtime } from '../../../server/dist/runtime.js';
import { createServer } from '../../../server/dist/server.js';
import { LocalAccess, prepareLocalAccess } from '../../../server/dist/local-access.js';
import { OwnerTerminals } from '../../../server/dist/owner-terminal.js';
import { parseCapacity } from '../../../server/dist/capacity.js';
import { localRequestProof } from '@dock/shared/dist/local-authorization.js';

/** Browser transport is routed into the authenticated API; commands run in a real PTY. */
async function fixture(page: Page, selected = false) {
  const root = mkdtempSync(join(tmpdir(), 'owner-shell-browser-'));
  const store = new Store(join(root, 'dock.sqlite'));
  let launches = 0;
  const runtime = new Runtime(store, root, 'offline-provider', async () => {
    launches++;
    throw new Error('All providers unavailable');
  });
  let shells = new OwnerTerminals({
    shell: '/bin/sh',
    cwd: root,
    computer: 'Owned shell computer',
  });
  const access = new LocalAccess(prepareLocalAccess(root, 4999));
  for (const provider of ['codex', 'claude'] as const) {
    const now = Date.now();
    store.setSetting(
      `capacity:v1:${provider}`,
      parseCapacity(
        provider,
        [
          {
            provider,
            source: 'oauth',
            usage: {
              updatedAt: new Date(now).toISOString(),
              primary: {
                usedPercent: 100,
                windowMinutes: 300,
                resetsAt: new Date(now + 3600000).toISOString(),
              },
            },
          },
        ],
        now,
      ),
    );
  }
  let app = await createServer(store, runtime, {
    port: 4999,
    localAccess: access,
    ownerTerminals: shells,
    ownsRuntime: false,
  });
  const hostId = randomUUID();
  const prefix = selected ? `/api/hosts/${hostId}/proxy` : '/api';
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const connections: { close: () => void }[] = [];
  const authorization = (method: string, path: string) => {
    const challenge = randomBytes(32).toString('hex');
    const proof = access.proof({ role: 'owner', challenge });
    return `Dock owner.${proof.nonce}.${localRequestProof(access.configuration.owner, 'http://127.0.0.1:4999', 'owner', challenge, proof.nonce, method, path)}`;
  };
  if (selected) {
    await page.addInitScript((id) => localStorage.setItem('dock:host', id), hostId);
    await page.route('**/api/hosts', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({
        json: {
          ...data,
          hosts: [
            {
              id: hostId,
              label: 'Selected shell computer',
              accountLabel: 'Fixture',
              status: 'connected',
              error: null,
            },
          ],
        },
      });
    });
    await page.route(`**${prefix}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.includes('/owner-terminal')) return route.fallback();
      const response = await page.request.fetch(
        `http://127.0.0.1:4339/api${url.pathname.slice(prefix.length)}${url.search}`,
        { method: route.request().method(), data: route.request().postData() ?? undefined },
      );
      await route.fulfill({ response });
    });
  }
  let loseClose = false;
  let delayedOpen: Promise<void> | undefined;
  let openRequested = false;
  await page.route('**/api/**/owner-terminal**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    expect(url.pathname.startsWith(`${prefix}/owner-terminal`)).toBe(true);
    const path = `/api${url.pathname.slice(prefix.length)}`;
    const body = request.postDataJSON();
    calls.push({ path: url.pathname, method: request.method(), body });
    const response = await app.inject({
      method: request.method() as 'GET' | 'POST',
      url: path,
      headers: {
        host: '127.0.0.1:4999',
        origin: 'http://127.0.0.1:4999',
        authorization: authorization(request.method(), path),
        'content-type': 'application/json',
      },
      ...(body ? { payload: body } : {}),
    });
    if (request.method() === 'POST' && path === '/api/owner-terminal') {
      openRequested = true;
      await delayedOpen;
    }
    if (loseClose && path.endsWith('/close')) {
      loseClose = false;
      return route.abort('failed');
    }
    await route.fulfill({
      status: response.statusCode,
      contentType: 'application/json',
      body: response.body,
    });
  });
  await page.routeWebSocket('**/api/**/owner-terminal/*/socket', async (downstream) => {
    const url = new URL(downstream.url());
    expect(url.pathname.startsWith(`${prefix}/owner-terminal`)).toBe(true);
    const path = `/api${url.pathname.slice(prefix.length)}`;
    const upstream = await app.injectWS(
      path,
      {
        headers: {
          host: '127.0.0.1:4999',
          origin: 'http://127.0.0.1:4999',
          authorization: authorization('GET', path),
        },
      },
      {
        onInit(socket) {
          socket.on('message', (raw) => downstream.send(raw.toString()));
        },
      },
    );
    downstream.onMessage((data) => upstream.send(data));
    downstream.onClose(() => upstream.close());
    upstream.once('close', (code) =>
      downstream.close({ code: code === 1005 || code === 1006 ? 1011 : code }),
    );
    connections.push({
      close: () => {
        downstream.close({ code: 1012, reason: 'Fixture connection dropped' });
        upstream.close();
      },
    });
  });
  return {
    root,
    calls,
    openRequested: () => openRequested,
    holdOpen: () => {
      let release!: () => void;
      delayedOpen = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    launches: () => launches,
    disconnect: () => connections.at(-1)?.close(),
    async restart() {
      shells.close();
      await app.close();
      shells = new OwnerTerminals({
        shell: '/bin/sh',
        cwd: root,
        computer: 'Owned shell computer',
      });
      app = await createServer(store, runtime, {
        port: 4999,
        localAccess: access,
        ownerTerminals: shells,
        ownsRuntime: false,
      });
    },
    loseClose: () => {
      loseClose = true;
    },
    async close() {
      for (const connection of connections) connection.close();
      await page.unrouteAll({ behavior: 'wait' });
      shells.close();
      await app.close();
      await runtime.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function command(page: Page, text: string) {
  await page.locator('.owner-terminal .xterm-helper-textarea').focus();
  await page.keyboard.type(text);
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
}

for (const selected of [false, true])
  test(`owner shell at zero AI allowance ${selected ? 'on the selected computer' : 'survives reconnect and close recovery'}`, async ({
    page,
  }, info) => {
    const owned = await fixture(page, selected);
    try {
      await page.goto('/#/computers');
      await page.getByRole('link', { name: /Open terminal/ }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Connected · owner shell · no AI usage' }),
      ).toBeVisible();
      await expect(
        page.getByRole('dialog', {
          name: selected ? 'Terminal · Selected shell computer' : /Terminal ·/,
        }),
      ).toBeVisible();
      await command(page, "printf 'once\\n' >> marker; printf 'PWD_%s\\n' \"$PWD\"");
      await expect.poll(() => readFileSync(join(owned.root, 'marker'), 'utf8')).toBe('once\n');
      await expect(page.locator('.xterm-rows')).toContainText(`PWD_${owned.root}`);
      expect(
        await page.locator('.owner-terminal-location').evaluate((e) => getComputedStyle(e).color),
      ).toBe('rgb(179, 192, 181)');
      const geometry = await page.locator('.owner-terminal-host').boundingBox();
      expect(geometry!.height).toBeGreaterThan(page.viewportSize()!.height * 0.45);
      for (const label of ['Ctrl C', 'Ctrl D', 'Enter']) {
        const button = page.getByRole('button', { name: label, exact: true });
        const box = await button.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
      }
      const shot = await page.screenshot({ path: info.outputPath('owner-terminal.png') });
      await info.attach('owner-terminal', { body: shot, contentType: 'image/png' });
      owned.disconnect();
      await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Enter', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Connected · owner shell' }),
      ).toBeVisible();
      await expect(page.locator('.xterm-rows')).toContainText(`PWD_${owned.root}`);
      await page.reload();
      await expect(
        page.getByRole('status').filter({ hasText: 'Connected · owner shell' }),
      ).toBeVisible();
      await command(page, "printf 'alive\\n' >> marker");
      await expect
        .poll(() => readFileSync(join(owned.root, 'marker'), 'utf8'))
        .toBe('once\nalive\n');
      expect(
        owned.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/owner-terminal')),
      ).toHaveLength(1);
      expect(owned.launches()).toBe(0);
      if (!selected) {
        await owned.restart();
        await page.reload();
        await expect(page.locator('.owner-terminal-error')).toContainText('Open a new terminal');
        expect(
          owned.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/owner-terminal')),
        ).toHaveLength(1);
        await page.getByRole('button', { name: 'New terminal', exact: true }).click();
        await expect(
          page.getByRole('status').filter({ hasText: 'Connected · owner shell' }),
        ).toBeVisible();
        expect(readFileSync(join(owned.root, 'marker'), 'utf8')).toBe('once\nalive\n');
        owned.loseClose();
      }
      await page.getByRole('button', { name: 'Close shell', exact: true }).click();
      if (!selected) {
        await expect(page.locator('.owner-terminal-error')).toBeVisible();
        await page.getByRole('button', { name: 'Close shell', exact: true }).click();
      }
      await expect(page.getByRole('dialog', { name: /Terminal ·/ })).toHaveCount(0);
      await expect(page.getByRole('link', { name: /Open terminal/ })).toBeVisible();
    } finally {
      await owned.close();
    }
  });

test('late owner-shell opening retains only its pinned computer receipt after leaving the view', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'One focused acknowledgement-boundary check.');
  const owned = await fixture(page);
  const release = owned.holdOpen();
  try {
    await page.goto('/#/computers');
    await page.getByRole('link', { name: /Open terminal/ }).click();
    await expect.poll(owned.openRequested).toBe(true);
    await page.getByRole('button', { name: 'Back to computers' }).click();
    const unrelatedHost = randomUUID();
    await page.evaluate((id) => localStorage.setItem('dock:host', id), unrelatedHost);
    release();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(sessionStorage.getItem('dock:local:owner-terminal') ?? 'null')?.id ?? null,
        ),
      )
      .not.toBeNull();
    expect(
      await page.evaluate(
        (id) => sessionStorage.getItem(`dock:${id}:owner-terminal`),
        unrelatedHost,
      ),
    ).toBeNull();
    await page.getByRole('link', { name: /Open terminal/ }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Connected · owner shell' }),
    ).toBeVisible();
    expect(
      owned.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/owner-terminal')),
    ).toHaveLength(1);
    await page.getByRole('button', { name: 'Close shell', exact: true }).click();
  } finally {
    release();
    await owned.close();
  }
});
