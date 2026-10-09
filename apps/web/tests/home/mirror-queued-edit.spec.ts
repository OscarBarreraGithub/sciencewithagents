import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  mirrorPage,
  mirrorQueuedMessagesSchema,
  mirrorQueuedMessageSchema,
  type MirrorState,
  type MirrorCommand,
  type MirrorQueuedAction,
  type MirrorQueuedMessage,
} from '@dock/shared';
const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const WebSocket = require('ws') as typeof import('ws').default;

type Fixture = Awaited<ReturnType<typeof fixture>>;
const owned = new WeakMap<Page, Fixture>();
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
  const saved = owned.get(page);
  if (!saved) return;
  try {
    for (let item of await saved.list()) {
      if (item.status === 'queued' && !item.queueEdit) {
        const held = await page.request.post(`/api/vscode/queued/${item.id}`, {
          headers: saved.headers,
          data: {
            key: randomUUID(),
            clientId: saved.cleanupClient,
            revision: item.queueRevision,
            action: 'edit',
          },
        });
        expect(held.ok()).toBe(true);
        item = mirrorQueuedMessageSchema.parse(await held.json());
      }
      const input = {
        key: randomUUID(),
        clientId: item.queueEdit?.clientId ?? saved.cleanupClient,
        revision: item.queueRevision,
        action: 'remove',
      };
      expect(
        (
          await page.request.post(`/api/vscode/queued/${item.id}`, {
            headers: saved.headers,
            data: input,
          })
        ).ok(),
      ).toBe(true);
    }
  } finally {
    await new Promise<void>((resolve) => {
      if (saved.socket.readyState === WebSocket.CLOSED) return resolve();
      saved.socket.once('close', () => resolve());
      saved.socket.close();
    });
  }
});

async function fixture(page: Page, origin: string, provider: 'codex' | 'claude' = 'codex') {
  const state: MirrorState = {
    windowId: randomUUID(),
    provider,
    threadId: randomUUID(),
    label: 'Owned queue fixture',
    title: 'Shared follow-ups',
    status: 'busy',
    message: '',
    entries: [],
    canQueue: false,
    ...(provider === 'codex' ? { canSteer: true, steerToken: 'owned-active-turn' } : {}),
    queuedMessages: [{ id: 'native-owned', text: 'Written directly in the editor' }],
  };
  const headers = { Origin: origin };
  const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/api/vscode/bridge');
  const commands: MirrorCommand[] = [];
  let uncertain = false;
  socket.on('message', (raw) => {
    const command = JSON.parse(raw.toString()) as MirrorCommand;
    let value: unknown;
    if (command.type === 'read') value = mirrorPage(state, command.page);
    else {
      commands.push(command);
      value = {
        state: uncertain ? 'uncertain' : 'sent',
        message: uncertain ? 'Fixture native acknowledgement lost.' : 'Fixture accepted.',
      };
      if (!uncertain && command.type === 'send')
        state.entries.push({ id: randomUUID(), role: 'user', text: command.input.text });
    }
    const text = JSON.stringify(value);
    for (let i = 0; i < text.length; i += 4096)
      socket.send(
        JSON.stringify({
          type: 'chunk',
          id: command.id,
          text: text.slice(i, i + 4096),
          last: i + 4096 >= text.length,
        }),
      );
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const { entries: _, queuedMessages: _queue, ...window } = state;
  socket.send(JSON.stringify({ type: 'hello', window }));
  const client = await (
    await page.request.post('/api/workspace/clients', {
      headers,
      data: { key: randomUUID(), label: 'Owned fixture cleanup' },
    })
  ).json();
  const list = async () =>
    mirrorQueuedMessagesSchema.parse(
      await (
        await page.request.get(`/api/vscode/queued?provider=${provider}&threadId=${state.threadId}`)
      ).json(),
    ).items;
  const saved = {
    state,
    socket,
    commands,
    headers,
    cleanupClient: client.client.id as string,
    list,
    uncertain: () => {
      uncertain = true;
    },
    read: async (id: string) =>
      (await (await page.request.get(`/api/vscode/queued/${id}`)).json()) as MirrorQueuedMessage,
  };
  owned.set(page, saved);
  await expect
    .poll(async () =>
      (await (await page.request.get('/api/vscode/windows')).json()).some(
        (item: { windowId: string }) => item.windowId === state.windowId,
      ),
    )
    .toBe(true);
  return saved;
}
async function open(page: Page, saved: Fixture) {
  await page.goto(
    `/#/chats/vscode/${encodeURIComponent(`${saved.state.provider}:${saved.state.threadId}`)}`,
  );
  await expect(
    page.getByRole('textbox', {
      name: `Message ${saved.state.provider === 'claude' ? 'Claude Code' : 'Codex'}`,
    }),
  ).toBeVisible();
}
/** The closed queue is one summary row; its items open in the full-height dialog. */
async function openQueue(page: Page) {
  await page.getByRole('button', { name: /Expand queue/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Queued messages', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function queue(page: Page, saved: Fixture, text: string) {
  if (saved.state.provider === 'codex')
    await page.getByRole('combobox', { name: 'Send timing' }).selectOption('queue');
  await page.locator('.mirror-input-row textarea').fill(text);
  await page.getByRole('button', { name: 'Queue follow-up', exact: true }).click();
  await expect.poll(async () => (await saved.list()).length).toBe(1);
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  const dialog = await openQueue(page);
  await expect(dialog.getByRole('list', { name: 'Queued messages' })).toContainText(text);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  return (await saved.list())[0];
}

test('app shared follow-ups hold, minimize, reload and explicitly requeue while editor-owned entries remain read-only', async ({
  page,
  baseURL,
}, info) => {
  const saved = await fixture(page, baseURL!);
  await open(page, saved);
  const item = await queue(page, saved, 'App-created follow-up');
  const composer = page.locator('.mirror-input-row textarea');
  await composer.fill('Separate unsent draft');
  const expanded = await openQueue(page);
  const native = expanded
    .getByRole('list', { name: 'Queued messages', exact: true })
    .getByRole('listitem')
    .filter({ hasText: 'Written directly in the editor' });
  await expect(native).toContainText('Written directly in the editor');
  await expect(native.getByRole('button')).toHaveCount(0);
  await expanded.getByRole('button', { name: 'Edit', exact: true }).click();
  const pad = page.getByRole('dialog', { name: 'Edit queued message', exact: true });
  await expect.poll(async () => (await saved.read(item.id)).queueEdit?.state).toBe('editing');
  await pad.getByRole('textbox').fill('Edited follow-up stays held\nSecond line');
  await expect
    .poll(async () => (await saved.read(item.id)).queueEdit?.text)
    .toBe('Edited follow-up stays held\nSecond line');
  await expect(pad.getByRole('button', { name: 'Save and queue', exact: true })).toBeInViewport();
  await expect(pad.getByRole('button', { name: 'Minimize', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath(`${info.project.name}-held-shared.png`) });
  await pad.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expanded.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(composer).toHaveValue('Separate unsent draft');
  await expect(page.getByRole('button', { name: /Expand queue/ })).toContainText('1 held');
  expect((await saved.read(item.id)).queueEdit?.state).toBe('editing');
  await page.reload();
  const list = page.getByRole('list', { name: 'Queued messages' });
  await openQueue(page);
  await list.getByRole('button', { name: 'Resume edit', exact: true }).click();
  await expect(pad.getByRole('textbox')).toHaveValue('Edited follow-up stays held\nSecond line');
  await pad.getByRole('button', { name: 'Save and queue', exact: true }).click();
  await expect(pad).toHaveCount(0);
  await expect.poll(async () => (await saved.read(item.id)).queueEdit).toBeNull();
  expect(saved.commands).toHaveLength(0);
  saved.state.status = 'idle';
  await expect.poll(() => saved.commands.length).toBe(1);
  expect(saved.commands[0]).toMatchObject({
    type: 'send',
    input: { text: 'Edited follow-up stays held\nSecond line' },
  });
  await expect.poll(async () => (await saved.read(item.id)).status).toBe('completed');
  await expect(composer).toHaveValue('Separate unsent draft');
});

test('lost queue and edit acknowledgements resolve the original keys, retain later typing and never replay after reload', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
  let initialSends = 0;
  await page.route(`**/api/vscode/windows/${saved.state.windowId}/send`, async (route) => {
    initialSends++;
    await route.fetch();
    await route.fulfill({ status: 503, json: { error: 'Queued; acknowledgement lost.' } });
  });
  await open(page, saved);
  await page.getByRole('combobox', { name: 'Send timing' }).selectOption('queue');
  const composer = page.locator('.mirror-input-row textarea');
  await composer.fill('First queued content');
  await page.getByRole('button', { name: 'Queue follow-up', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeEnabled();
  await composer.fill('Later unsent composer draft');
  await page.reload();
  await page.getByRole('button', { name: 'Check delivery', exact: true }).click();
  await expect(composer).toHaveValue('Later unsent composer draft');
  expect(initialSends).toBe(1);
  const item = (await saved.list())[0];
  const attempts: MirrorQueuedAction[] = [];
  let lost = false;
  let minimizedAckLost = false;
  await page.route(`**/api/vscode/queued/${item.id}`, async (route) => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().action !== 'save')
      return route.continue();
    const input = route.request().postDataJSON();
    attempts.push(input);
    const response = await route.fetch();
    if (!lost) {
      lost = true;
      return route.fulfill({ status: 503, json: { error: 'Saved edit; acknowledgement lost.' } });
    }
    if (input.text === 'Saved while minimizing' && !minimizedAckLost) {
      minimizedAckLost = true;
      return route.fulfill({
        status: 503,
        json: { error: 'Minimized save acknowledgement lost.' },
      });
    }
    return route.fulfill({ response });
  });
  const list = page.getByRole('list', { name: 'Queued messages' });
  await openQueue(page);
  await list.getByRole('button', { name: 'Edit', exact: true }).click();
  const pad = page.getByRole('dialog', { name: 'Edit queued message' });
  await pad.getByRole('textbox').fill('Saved edit before lost acknowledgement');
  await expect(
    pad.getByText('Saved edit; acknowledgement lost.', { exact: true }).first(),
  ).toBeVisible();
  await pad.getByRole('textbox').fill('Later typing survives saved retry');
  await pad.getByRole('button', { name: 'Retry saved action', exact: true }).click();
  await expect
    .poll(async () => (await saved.read(item.id)).queueEdit?.text)
    .toBe('Later typing survives saved retry');
  expect(attempts[0].key).toBe(attempts[1].key);
  await pad.getByRole('textbox').fill('Saved while minimizing');
  await pad.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Inspect queued action', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Inspect queued action', exact: true }).click();
  await expect(page.locator('.queue-action-recovery')).toHaveCount(0);
  await list.getByRole('button', { name: 'Resume edit', exact: true }).click();
  await expect(pad.getByRole('textbox')).toHaveValue('Saved while minimizing');
  let queueAttempts = 0;
  await page.route(`**/api/vscode/queued/${item.id}`, async (route) => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().action !== 'queue')
      return route.fallback();
    queueAttempts++;
    await route.fetch();
    return route.fulfill({ status: 503, json: { error: 'Requeued; acknowledgement lost.' } });
  });
  await pad.getByRole('button', { name: 'Save and queue', exact: true }).click();
  await expect(
    pad.getByText('Requeued; acknowledgement lost.', { exact: true }).first(),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Inspect queued action', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Inspect queued action', exact: true }).click();
  await expect(page.locator('.queue-action-recovery')).toHaveCount(0);
  expect(queueAttempts).toBe(1);
  expect(saved.commands).toHaveLength(0);
});

test('shared Claude held edits use the pinned host and offer queue-only controls', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!, 'claude');
  const host = randomUUID();
  const writes: string[] = [];
  await page.addInitScript((id) => localStorage.setItem('dock:host', id), host);
  await page.route('**/api/hosts', (route) =>
    route.fulfill({
      json: {
        local: { id: 'local', label: 'Entry fixture' },
        setupError: null,
        hosts: [
          {
            id: host,
            label: 'Selected fixture',
            accountLabel: 'Owner fixture',
            status: 'connected',
            error: null,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/hosts/${host}/proxy/**`, async (route) => {
    const url = route.request().url().replace(`/api/hosts/${host}/proxy`, '/api');
    if (new URL(url).pathname === '/api/events')
      return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (route.request().method() === 'POST' && url.includes('/vscode/'))
      writes.push(route.request().url());
    const response = await route.fetch({ url });
    return route.fulfill({ response });
  });
  await open(page, saved);
  const item = await queue(page, saved, 'Claude app-owned follow-up');
  const list = page.getByRole('list', { name: 'Queued messages' });
  await openQueue(page);
  // The app-owned follow-up and existing editor-owned item both remain visible.
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(
    list
      .getByRole('listitem')
      .filter({ hasText: 'Written directly in the editor' })
      .getByRole('button', { name: 'Edit', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Steer now/ })).toHaveCount(0);
  await list.getByRole('button', { name: 'Edit', exact: true }).click();
  const pad = page.getByRole('dialog', { name: 'Edit queued message' });
  await pad.getByRole('textbox').fill('Claude revised queued question');
  await pad.getByRole('button', { name: 'Save and queue', exact: true }).click();
  await expect
    .poll(async () => (await saved.read(item.id)).text)
    .toBe('Claude revised queued question');
  expect(writes.length).toBeGreaterThanOrEqual(3);
  expect(writes.every((url) => url.includes(`/api/hosts/${host}/proxy/vscode/`))).toBe(true);
  expect(saved.commands).toHaveLength(0);
});

test('individual steering binds the current turn; unknown acknowledgement stays held and is never requeued', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
  await open(page, saved);
  const item = await queue(page, saved, 'Steer this individual follow-up');
  saved.uncertain();
  const list = page.getByRole('list', { name: 'Queued messages' });
  await openQueue(page);
  await list.getByRole('button', { name: 'Steer now…', exact: true }).click();
  const pad = page.getByRole('dialog', { name: 'Edit queued message' });
  await pad.getByRole('button', { name: 'Steer now', exact: true }).click();
  await expect.poll(() => saved.commands.length).toBe(1);
  expect(saved.commands[0]).toMatchObject({
    type: 'send',
    input: { expectedTurnId: 'owned-active-turn', text: 'Steer this individual follow-up' },
  });
  await expect.poll(async () => (await saved.read(item.id)).queueEdit?.state).toBe('steering');
  await page.reload();
  const recovery = page.getByRole('button', { name: 'Inspect queued action', exact: true });
  if (await recovery.isVisible()) await recovery.click();
  await openQueue(page);
  await list.getByRole('button', { name: 'Resume edit', exact: true }).click();
  await expect(pad.getByRole('textbox')).toHaveAttribute('readonly', '');
  await expect(pad.getByRole('button', { name: 'Save and queue', exact: true })).toBeDisabled();
  await expect(pad.getByRole('button', { name: 'Steer now', exact: true })).toHaveCount(0);
  expect(saved.commands).toHaveLength(1);
});

test('deletes only app-owned shared queued messages and reconciles a lost delete acknowledgement without replay', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
  await open(page, saved);
  const item = await queue(page, saved, 'App-owned message to delete');
  const attempts: MirrorQueuedAction[] = [];
  await page.route(`**/api/vscode/queued/${item.id}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push(route.request().postDataJSON());
    expect((await route.fetch()).ok()).toBe(true);
    await route.abort('failed');
  });
  const expanded = await openQueue(page);
  const native = expanded
    .getByRole('listitem')
    .filter({ hasText: 'Written directly in the editor' });
  await expect(
    native.getByRole('button', { name: 'Delete queued message', exact: true }),
  ).toHaveCount(0);
  await expanded.getByRole('button', { name: 'Delete queued message', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete queued message?', exact: true });
  await expect(
    confirmation.getByRole('button', { name: 'Delete message', exact: true }),
  ).toBeInViewport();
  await confirmation.getByRole('button', { name: 'Delete message', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toBeVisible();
  await confirmation.getByRole('button', { name: 'Close', exact: true }).click();
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ action: 'remove', revision: 0 });
  expect((await saved.read(item.id)).status).toBe('cancelled');
  await page.reload();
  await openQueue(page);
  await page.getByRole('button', { name: 'Inspect queued action', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Inspect queued action', exact: true }),
  ).toHaveCount(0);
  expect(attempts).toHaveLength(1);
  expect(saved.commands).toEqual([]);
  await expect(page.getByRole('list', { name: 'Queued messages', exact: true })).toContainText(
    'Written directly in the editor',
  );
});
