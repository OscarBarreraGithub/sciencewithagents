import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import {
  schedulerSettingsSchema,
  type ConversationVisibility,
  type ConversationVisibilityUpdate,
} from '@dock/shared';

const owned = new WeakMap<Page, { settings: unknown; agents: string[] }>();
test.beforeEach(async ({ page }) => {
  const baseline = await (await page.request.get('/api/scheduler')).json();
  owned.set(page, { settings: schedulerSettingsSchema.parse(baseline.settings), agents: [] });
});
test.afterEach(async ({ page, baseURL }) => {
  const fixture = owned.get(page)!;
  for (const agentId of fixture.agents) {
    const detail = await (await page.request.get(`/api/agents/${agentId}`)).json();
    for (const run of detail.runs as { id: string; status: string }[]) {
      if (run.status !== 'queued') continue;
      expect(
        (
          await page.request.post('/api/pulsar/jobs', {
            headers: { Origin: baseURL! },
            data: { key: randomUUID(), runId: run.id, action: 'cancel' },
          })
        ).ok(),
      ).toBe(true);
    }
  }
  expect(
    (
      await page.request.post('/api/scheduler/settings', {
        headers: { Origin: baseURL! },
        data: { key: randomUUID(), settings: fixture.settings },
      })
    ).ok(),
  ).toBe(true);
});
async function fixture(page: Page, origin: string) {
  const headers = { Origin: origin };
  expect(
    (
      await page.request.post('/api/scheduler/settings', {
        headers,
        data: { key: randomUUID(), settings: { paused: true, maxConcurrent: 4 } },
      })
    ).ok(),
  ).toBe(true);
  const project = await (
    await page.request.post('/api/projects', {
      headers,
      data: { key: randomUUID(), name: `Visible ${randomUUID().slice(0, 8)}`, provider: 'codex' },
    })
  ).json();
  owned.get(page)!.agents.push(project.managerId);
  const run = await (
    await page.request.post(`/api/agents/${project.managerId}/messages`, {
      headers,
      data: { key: randomUUID(), text: 'Owned queued work stays intact when hidden.' },
    })
  ).json();
  const read = async () =>
    await (await page.request.get(`/api/agents/${project.managerId}`)).json();
  return { project, run, read };
}

test('archive and restore keep queued work, history and the composer; retries retain one visibility action', async ({
  page,
  baseURL,
}, info) => {
  const saved = await fixture(page, baseURL!);
  const original = await saved.read();
  const attempts: ConversationVisibilityUpdate[] = [];
  await page.route('**/api/conversations/visibility', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (attempts.length === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'Visibility saved; acknowledgement lost.' },
      });
    return route.fulfill({ response });
  });
  await page.goto(`/#/chat/${saved.project.managerId}`);
  const tools = page.getByRole('group', { name: 'Conversation tools' });
  const composer = page.locator('.composer textarea');
  await composer.fill('An unsent draft remains in this conversation.');
  await tools.getByRole('button', { name: 'Archive conversation', exact: true }).click();
  const retry = page.getByRole('dialog', { name: 'Archive conversation', exact: true });
  await expect(retry.getByRole('alert')).toHaveText('Visibility saved; acknowledgement lost.');
  await retry.getByRole('button', { name: 'Retry same request' }).click();
  await expect(retry).toHaveCount(0);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
  await expect(
    tools.getByRole('button', { name: 'Restore conversation', exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue('An unsent draft remains in this conversation.');
  await page.reload();
  await expect(composer).toHaveValue('An unsent draft remains in this conversation.');
  await expect(
    tools.getByRole('button', { name: 'Restore conversation', exact: true }),
  ).toBeVisible();
  const after = await saved.read();
  expect(after.runs.find((run: { id: string }) => run.id === saved.run.id).status).toBe('queued');
  expect(after.agent.archivedAt).toBeUndefined();
  expect(after.entries).toEqual(original.entries);
  expect(after.agent.projectId).toBe(saved.project.id);
  await page.goto('/#/chats');
  const actions = page.getByRole('group', { name: 'Conversation actions' });
  await expect(actions.getByRole('button', { name: 'Assisted search', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Archived', exact: true })).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Conversation type' }).getByRole('button'),
  ).toHaveCount(4);
  const list = page.getByRole('navigation', { name: 'Conversation list' });
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toHaveCount(0);
  await page.getByRole('button', { name: 'Managers', exact: true }).click();
  await expect(page.getByText('Reading conversations…', { exact: true })).toHaveCount(0);
  const visibleManagers = await list.getByRole('link').count();
  await page.goto('/#/home');
  await expect(page.locator('.destination-chats small')).toHaveText(
    new RegExp(`^${visibleManagers} project manager`),
  );
  await expect(page.locator('.destination-quark small')).toHaveText(
    /\d+ running · [1-9]\d* queued/,
  );
  await page.goto('/#/chats');
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toBeVisible();
  await mkdir('../../data/archive-ui', { recursive: true });
  await page.screenshot({ path: `../../data/archive-ui/${info.project.name}-archived-list.png` });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await list.getByRole('button', { name: new RegExp(`Restore ${saved.project.name}`) }).click();
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toBeVisible();
  await page.goto('/#/home');
  await expect(page.locator('.destination-chats')).toContainText(/project manager/);
  await expect(page.locator('.destination-quark')).toContainText(/queued/);
});

test('shared archive uses stable provider thread identity and stays restorable offline without native controls', async ({
  page,
}, info) => {
  const state = {
    windowId: randomUUID(),
    provider: 'claude',
    label: 'Shared fixture',
    threadId: `shared-${randomUUID()}`,
    title: 'Shared chapter discussion',
    status: 'idle',
    message: '',
    entries: [{ id: 'answer', role: 'assistant', text: 'Scientific history stays in the editor.' }],
  };
  let record: ConversationVisibility | null = null;
  let online = true;
  let nativeWrites = 0;
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
    route.fulfill({ json: online ? [{ ...state, entries: undefined }] : [] }),
  );
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: state }),
  );
  await page.route('**/api/vscode/windows/*/send', (route) => {
    nativeWrites++;
    return route.abort();
  });
  await page.route('**/api/vscode/windows/*/control', (route) => {
    nativeWrites++;
    return route.abort();
  });
  // Native discovery and visibility metadata are typed transport fixtures; no provider runs.
  await page.route('**/api/conversations/visibility', (route) => {
    if (route.request().method() !== 'POST')
      return route.fulfill({ json: { records: record ? [record] : [], nextCursor: null } });
    const input = route.request().postDataJSON() as ConversationVisibilityUpdate;
    expect(input.target).toEqual({ kind: 'shared', provider: 'claude', threadId: state.threadId });
    expect(input.expectedRevision).toBe(record?.revision ?? 0);
    record = {
      id: record?.id ?? randomUUID(),
      target: input.target,
      revision: (record?.revision ?? 0) + 1,
      archived: input.archived,
      archivedAt: input.archived ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
      provider: 'claude',
      source: 'vscode',
      title: state.title,
      caption: state.label,
    };
    return route.fulfill({ json: record });
  });
  await page.goto('/#/chats');
  const list = page.getByRole('navigation', { name: 'Conversation list' });
  await list.getByRole('link', { name: /Shared chapter discussion/ }).click();
  await page.getByLabel('Message Claude Code').fill('Shared unsent draft remains native.');
  await page.getByRole('button', { name: 'Archive conversation', exact: true }).click();
  await expect(page.getByLabel('Message Claude Code')).toHaveValue(
    'Shared unsent draft remains native.',
  );
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Restore conversation', exact: true }),
  ).toBeVisible();
  online = false;
  await page.evaluate(() => sessionStorage.removeItem('dock:mirror-chats:local:all'));
  await page.goto('/#/chats');
  await page.reload();
  await expect(list.getByRole('link', { name: /Shared chapter discussion/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(list.getByRole('link', { name: /Shared chapter discussion/ })).toBeVisible();
  await list
    .getByRole('button', { name: 'Restore Shared chapter discussion', exact: true })
    .click();
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await list.getByRole('link', { name: /Shared chapter discussion/ }).click();
  await expect(page.getByText(/This shared conversation is unavailable/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Archive conversation', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `../../data/archive-ui/${info.project.name}-restored-shared-offline.png`,
  });
  expect(nativeWrites).toBe(0);
});

test('selected-host archive routes visibility only to the pinned computer', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
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
            accountLabel: 'owner fixture',
            status: 'connected',
            error: null,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/hosts/${host}/proxy/**`, async (route) => {
    const source = route.request();
    const url = source.url().replace(`/api/hosts/${host}/proxy`, '/api');
    if (new URL(url).pathname === '/api/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'event: ready\ndata: {}\n\n',
      });
    if (source.method() === 'POST' && url.includes('/conversations/visibility'))
      writes.push(source.url());
    const response = await page.request.fetch(url, {
      method: source.method(),
      data: source.postData() ?? undefined,
      headers: { 'content-type': 'application/json', Origin: baseURL! },
    });
    return route.fulfill({ response });
  });
  await page.goto(`/#/chat/${saved.project.managerId}`);
  const tools = page.getByRole('group', { name: 'Conversation tools' });
  await tools.getByRole('button', { name: 'Archive conversation', exact: true }).click();
  await expect(
    tools.getByRole('button', { name: 'Restore conversation', exact: true }),
  ).toBeVisible();
  await tools.getByRole('button', { name: 'Restore conversation', exact: true }).click();
  await expect(
    tools.getByRole('button', { name: 'Archive conversation', exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(
    writes.every((url) => url.includes(`/api/hosts/${host}/proxy/conversations/visibility`)),
  ).toBe(true);
});

test('visibility filtering reads later metadata pages before showing saved conversations', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
  const now = new Date().toISOString();
  const cursor = randomUUID();
  const first: ConversationVisibility[] = Array.from({ length: 100 }, () => ({
    id: randomUUID(),
    target: { kind: 'agent', agentId: randomUUID() },
    revision: 1,
    archived: false,
    archivedAt: null,
    updatedAt: now,
    provider: 'codex',
    source: 'app',
    title: 'Unrelated saved metadata',
    caption: '',
  }));
  const archived: ConversationVisibility = {
    id: randomUUID(),
    target: { kind: 'agent', agentId: saved.project.managerId },
    revision: 1,
    archived: true,
    archivedAt: now,
    updatedAt: now,
    provider: 'codex',
    source: 'app',
    title: saved.project.name,
    caption: '',
  };
  let laterPages = 0;
  await page.route(/\/api\/conversations\/visibility(?:\?.*)?$/, (route) => {
    if (new URL(route.request().url()).searchParams.get('cursor') === cursor) {
      laterPages++;
      return route.fulfill({ json: { records: [archived], nextCursor: null } });
    }
    return route.fulfill({ json: { records: first, nextCursor: cursor } });
  });
  await page.goto('/#/chats');
  const list = page.getByRole('navigation', { name: 'Conversation list' });
  await expect(page.getByText('Reading conversations…', { exact: true })).toHaveCount(0);
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toBeVisible();
  expect(laterPages).toBeGreaterThan(0);
});
