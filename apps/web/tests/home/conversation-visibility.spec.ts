import { expect, test, type Locator, type Page } from '@playwright/test';
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
  return { project, run, read, managerName: (await read()).agent.name as string };
}
/** Archive and Restore live in one quiet options menu, never as direct buttons. */
async function choose(page: Page, trigger: Locator, item: string) {
  await trigger.click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
}
async function offers(page: Page, trigger: Locator, item: string) {
  await trigger.click();
  await expect(page.getByRole('menuitem', { name: item, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
}
const directVisibilityButtons = /^(Archive|Restore)( |$)/;

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
  const options = tools.getByRole('button', { name: 'Conversation options', exact: true });
  const surface = (button: Locator) =>
    button.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, background: style.backgroundColor, border: style.borderColor };
    });
  expect(await surface(options)).toEqual(
    await surface(tools.locator('.chat-tool[aria-pressed="false"]').first()),
  );
  const composer = page.locator('.composer textarea');
  await composer.fill('An unsent draft remains in this conversation.');
  // The selected chat has no direct archive button beside Configure or in its list row.
  await expect(page.getByRole('button', { name: directVisibilityButtons })).toHaveCount(0);
  await choose(page, options, 'Archive conversation');
  const retry = page.getByRole('dialog', { name: 'Archive conversation', exact: true });
  await expect(retry.getByRole('alert')).toHaveText('Visibility saved; acknowledgement lost.');
  await retry.getByRole('button', { name: 'Retry same request' }).click();
  await expect(retry).toHaveCount(0);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
  await expect(page.getByRole('button', { name: /^Undo:/ })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/chat/${saved.project.managerId}$`));
  await expect(page.locator('.chat-pane-meta')).toContainText('· Archived');
  await offers(page, options, 'Restore conversation');
  await expect(composer).toHaveValue('An unsent draft remains in this conversation.');
  await page.reload();
  await expect(composer).toHaveValue('An unsent draft remains in this conversation.');
  await offers(page, options, 'Restore conversation');
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
  ).toHaveText(['All', 'Projects', 'VS Code', 'Misc', 'Groups']);
  const list = page.getByRole('navigation', { name: 'Conversation list' });
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toHaveCount(0);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByText('Reading conversations…', { exact: true })).toHaveCount(0);
  const visibleManagers = await list.getByRole('link').count();
  await page.goto('/#/home');
  await expect(page.locator('.overview-destinations a[href="#/chats"] small')).toHaveText(
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
  const row = list.getByRole('button', {
    name: `Options for ${saved.managerName}`,
    exact: true,
  });
  await choose(page, row, `Restore ${saved.managerName}`);
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toHaveCount(0);
  // The row left this view, so focus moves to the result, which offers one undo.
  const status = page.getByRole('status').filter({ hasText: saved.project.name });
  await expect(status.locator('p')).toBeFocused();
  await expect(status).toContainText(`“${saved.managerName}” restored.`);
  await status
    .getByRole('button', { name: `Undo: Archive ${saved.managerName}`, exact: true })
    .click();
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toBeVisible();
  await expect(status).toContainText(`“${saved.managerName}” archived.`);
  await expect(status.getByRole('button', { name: /^Undo/ })).toHaveCount(0);
  await choose(page, row, `Restore ${saved.managerName}`);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toBeVisible();
  // Each choice was one app-visibility request; only the lost acknowledgement was repeated.
  const mine = attempts.filter(
    (attempt) =>
      attempt.target.kind === 'agent' && attempt.target.agentId === saved.project.managerId,
  );
  expect(mine.map((attempt) => attempt.archived)).toEqual([true, true, false, true, false]);
  expect(new Set(mine.map((attempt) => attempt.key)).size).toBe(4);
  await page.goto('/#/home');
  await expect(page.locator('.overview-destinations a[href="#/chats"]')).toContainText(
    /project manager/,
  );
  await expect(page.locator('.destination-quark')).toContainText(/queued/);
});

test('Escape dismisses a reopened options menu while its visibility request is pending', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/conversations/visibility', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    await pending;
    await route.fulfill({ response });
  });
  await page.goto(`/#/chat/${saved.project.managerId}`);
  const trigger = page
    .getByRole('group', { name: 'Conversation tools' })
    .getByRole('button', { name: 'Conversation options', exact: true });
  try {
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Archive conversation', exact: true }).click();
    await expect(trigger).toHaveAttribute('aria-busy', 'true');
    await trigger.click();
    await expect(page.getByRole('menuitem')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    release();
  }
  await expect(page.getByRole('button', { name: /^Undo:/ })).toBeVisible();
  await page.getByRole('button', { name: /^Undo:/ }).click();
  await offers(page, trigger, 'Archive conversation');
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
  const header = page.locator('.mirror-header');
  const options = header.getByRole('button', { name: 'Conversation options', exact: true });
  await choose(page, options, 'Archive conversation');
  await expect(page.getByLabel('Message Claude Code')).toHaveValue(
    'Shared unsent draft remains native.',
  );
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await offers(page, options, 'Restore conversation');
  online = false;
  await page.evaluate(() => sessionStorage.removeItem('dock:mirror-chats:local:all'));
  await page.goto('/#/chats');
  await page.reload();
  await expect(list.getByRole('link', { name: /Shared chapter discussion/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(list.getByRole('link', { name: /Shared chapter discussion/ })).toBeVisible();
  await choose(
    page,
    list.getByRole('button', { name: 'Options for Shared chapter discussion', exact: true }),
    'Restore Shared chapter discussion',
  );
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await list.getByRole('link', { name: /Shared chapter discussion/ }).click();
  await expect(page.getByText(/This shared conversation is unavailable/)).toBeVisible();
  await offers(
    page,
    page.locator('.chat-offline-tools').getByRole('button', { name: 'Conversation options' }),
    'Archive conversation',
  );
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
  const options = page
    .getByRole('group', { name: 'Conversation tools' })
    .getByRole('button', { name: 'Conversation options', exact: true });
  await choose(page, options, 'Archive conversation');
  await expect(page.locator('.chat-pane-meta')).toContainText('· Archived');
  await choose(page, options, 'Restore conversation');
  await expect(page.locator('.chat-pane-meta')).not.toContainText('Archived');
  await offers(page, options, 'Archive conversation');
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

test('the chat options menu is keyboard operable, dismissible and unclipped in the scrolling list', async ({
  page,
  baseURL,
}, info) => {
  const saved = await fixture(page, baseURL!);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/conversations/visibility'))
      writes.push(request.url());
  });
  await page.goto('/#/chats');
  const list = page.getByRole('navigation', { name: 'Conversation list' });
  await expect(page.getByText('Reading conversations…', { exact: true })).toHaveCount(0);
  await expect(list.getByRole('button', { name: directVisibilityButtons })).toHaveCount(0);
  const trigger = list.getByRole('button', {
    name: `Options for ${saved.managerName}`,
    exact: true,
  });
  const menu = page.getByRole('menu', { name: `Options for ${saved.managerName}`, exact: true });
  const archive = menu.getByRole('menuitem', {
    name: `Archive ${saved.managerName}`,
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(archive).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(archive).toHaveAccessibleDescription(/Hide it in this app only/);
  await page.keyboard.press('ArrowDown');
  await expect(archive).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowDown');
  await expect(archive).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await trigger.click();
  await expect(archive).toBeVisible();
  await page.locator('.chat-list-title').click();
  await expect(menu).toHaveCount(0);
  // The last row of the scrolling list keeps its menu inside the visible viewport.
  const last = list.locator('.conversation-visible-row').last();
  await last.scrollIntoViewIfNeeded();
  await last.getByRole('button', { name: /^Options for / }).click();
  const open = page.getByRole('menu');
  await expect(open).toBeVisible();
  const view = page.viewportSize()!;
  const box = (await open.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  expect(
    await open.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !!hit && node.contains(hit);
    }),
  ).toBe(true);
  await mkdir('../../data/archive-ui', { recursive: true });
  await page.screenshot({ path: `../../data/archive-ui/${info.project.name}-row-menu.png` });
  await page.keyboard.press('Escape');
  await expect(open).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
});

for (const status of [404, 501]) {
  test(`an older host missing optional archive metadata (${status}) keeps Chats and Home readable`, async ({
    page,
    baseURL,
  }, info) => {
    const saved = await fixture(page, baseURL!);
    const writes: string[] = [];
    let missing = true;
    await page.route('**/api/conversations/visibility', async (route) => {
      if (!missing) return route.fulfill({ response: await route.fetch() });
      if (route.request().method() === 'POST') writes.push(route.request().url());
      return route.fulfill({ status, json: { error: 'Archive metadata is not implemented.' } });
    });
    await page.goto('/#/chats');
    const list = page.getByRole('navigation', { name: 'Conversation list' });
    await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toBeVisible();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Archiving is not available on this computer yet.' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archived', exact: true })).toBeDisabled();
    await list
      .getByRole('button', { name: `Options for ${saved.managerName}`, exact: true })
      .click();
    await expect(
      page.getByRole('menuitem', { name: `Archive ${saved.managerName}`, exact: true }),
    ).toBeDisabled();
    await page.keyboard.press('Escape');
    await list.getByRole('link', { name: new RegExp(saved.project.name) }).click();
    const composer = page.locator('.composer textarea');
    await composer.fill('Unsent draft on an older computer');
    await expect(composer).toHaveValue('Unsent draft on an older computer');
    await page.evaluate(() => {
      location.hash = '#/home';
    });
    await expect(page.locator('.overview-destinations a[href="#/chats"] small')).toHaveText(
      /project manager/,
    );
    await page.evaluate(() => {
      location.hash = '#/chats';
    });
    await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toBeVisible();
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`legacy-archive-${status}.png`) });
    missing = false;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('button', { name: 'Archived', exact: true })).toBeEnabled();
    await list
      .getByRole('button', { name: `Options for ${saved.managerName}`, exact: true })
      .click();
    await expect(
      page.getByRole('menuitem', { name: `Archive ${saved.managerName}`, exact: true }),
    ).toBeEnabled();
    await page.keyboard.press('Escape');
  });
}

for (const failure of [
  '403',
  '500',
  '502',
  'network',
  'html404',
  'malformed',
  'later404',
] as const) {
  test(`archive metadata ${failure} retains a real error and never claims an unsupported capability`, async ({
    page,
    baseURL,
  }) => {
    const saved = await fixture(page, baseURL!);
    const cursor = randomUUID();
    await page.route(/\/api\/conversations\/visibility(?:\?.*)?$/, (route) => {
      if (failure === 'network') return route.abort('failed');
      if (failure === 'html404')
        return route.fulfill({
          status: 404,
          contentType: 'text/html',
          body: '<p>Tunnel unavailable</p>',
        });
      if (failure === 'malformed')
        return route.fulfill({ json: { records: 'invalid', nextCursor: null } });
      if (failure === 'later404' && !new URL(route.request().url()).searchParams.has('cursor'))
        return route.fulfill({ json: { records: [], nextCursor: cursor } });
      return route.fulfill({
        status: failure === 'later404' ? 404 : Number(failure),
        json: { error: 'Visibility fixture failed.' },
      });
    });
    await page.goto('/#/chats');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Could not read archived conversations.' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry visibility' })).toBeVisible();
    await expect(
      page.getByText(
        'Archiving is not available on this computer yet. Chats and drafts are still available.',
        { exact: true },
      ),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole('navigation', { name: 'Conversation list' })
        .getByRole('link', { name: new RegExp(saved.project.name) }),
    ).toHaveCount(0);
  });
}

test('known archives survive an optional-route loss across Home/Chats and remain scoped to one computer', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
  await page.goto('/#/chats');
  const list = page.getByRole('navigation', { name: 'Conversation list' });
  await choose(
    page,
    list.getByRole('button', { name: `Options for ${saved.managerName}`, exact: true }),
    `Archive ${saved.managerName}`,
  );
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toHaveCount(0);
  await page.evaluate(() => {
    location.hash = '#/home';
  });
  const count = page.locator('.overview-destinations a[href="#/chats"] small');
  await expect(count).toHaveText(/project manager/);
  // The editor connection count loads independently of archived app conversations.
  const appCount = async () => (await count.textContent())?.replace(/ · \d+ VS Code chats?$/, '');
  const before = await appCount();
  await page.route('**/api/conversations/visibility', (route) =>
    route.fulfill({ status: 404, json: { error: 'Optional route absent' } }),
  );
  await page.evaluate(() => {
    location.hash = '#/chats';
  });
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Archiving is not available on this computer yet.' }),
  ).toBeVisible();
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toBeVisible();
  await list.getByRole('button', { name: `Options for ${saved.managerName}`, exact: true }).click();
  await expect(
    page.getByRole('menuitem', { name: `Restore ${saved.managerName}`, exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    location.hash = '#/home';
  });
  await expect.poll(appCount).toBe(before);

  const host = randomUUID();
  const prefix = `/api/hosts/${host}/proxy`;
  await page.route('**/api/hosts', (route) =>
    route.fulfill({
      json: {
        local: { id: 'local', label: 'Entry fixture' },
        setupError: null,
        hosts: [
          {
            id: host,
            label: 'Older fixture',
            accountLabel: 'Fixture owner',
            status: 'connected',
            error: null,
          },
        ],
      },
    }),
  );
  await page.route(`**${prefix}/**`, async (route) => {
    const url = route.request().url().replace(prefix, '/api');
    if (new URL(url).pathname === '/api/events')
      return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (new URL(url).pathname === '/api/conversations/visibility')
      return route.fulfill({ status: 501, json: { error: 'Older host has no archives' } });
    return route.fulfill({ response: await route.fetch({ url }) });
  });
  await page.evaluate((id) => {
    localStorage.setItem('dock:host', id);
    location.hash = '#/chats';
  }, host);
  await page.reload();
  await expect(list.getByRole('link', { name: new RegExp(saved.project.name) })).toBeVisible();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Archiving is not available on this computer yet.' }),
  ).toBeVisible();
});

test('an older host retains early typing through workspace registration and draft hydration', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
  await page.route('**/api/conversations/visibility', (route) =>
    route.fulfill({ status: 501, json: { error: 'Optional archive route absent' } }),
  );
  let releaseRegistration!: () => void;
  const registrationHeld = new Promise<void>((resolve) => (releaseRegistration = resolve));
  let registrationReached!: () => void;
  const registrationArrived = new Promise<void>((resolve) => (registrationReached = resolve));
  let releaseDraft!: () => void;
  const draftHeld = new Promise<void>((resolve) => (releaseDraft = resolve));
  let draftReached!: () => void;
  const draftArrived = new Promise<void>((resolve) => (draftReached = resolve));
  await page.route('**/api/workspace/clients', async (route) => {
    const response = await route.fetch();
    registrationReached();
    await registrationHeld;
    await route.fulfill({ response });
  });
  await page.route(`**/api/workspace/*/drafts/${saved.project.managerId}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    draftReached();
    await draftHeld;
    await route.fulfill({ response });
  });
  const messages: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/agents\/[^/]+\/(messages|steer|turns)$/.test(new URL(request.url()).pathname)
    )
      messages.push(request.url());
  });
  try {
    await page.goto(`/#/chat/${saved.project.managerId}`);
    await registrationArrived;
    const composer = page.locator('.composer > textarea');
    await expect(page.locator('[data-draft="connecting"]')).toBeVisible();
    const original = await composer.elementHandle();
    // Typing is accepted while workspace=null, before either hydration response.
    await composer.fill('Early typing remains on this older computer');
    await expect(composer).toHaveValue('Early typing remains on this older computer');
    const local = () =>
      page.evaluate(
        (id) => JSON.parse(localStorage.getItem(`dock:local:workspace:draft:${id}`) ?? '{}').text,
        saved.project.managerId,
      );
    expect(await local()).toBe('Early typing remains on this older computer');
    releaseRegistration();
    await draftArrived;
    await expect(composer).toHaveValue('Early typing remains on this older computer');
    expect(
      await original!.evaluate((node) => node === document.querySelector('.composer > textarea')),
    ).toBe(true);
    releaseDraft();
    await expect(page.locator('[data-draft="connecting"]')).toHaveCount(0);
    await expect(composer).toHaveValue('Early typing remains on this older computer');
    expect(
      await original!.evaluate((node) => node === document.querySelector('.composer > textarea')),
    ).toBe(true);
    expect(await local()).toBe('Early typing remains on this older computer');
    expect(messages).toEqual([]);
  } finally {
    releaseRegistration();
    releaseDraft();
  }
});
