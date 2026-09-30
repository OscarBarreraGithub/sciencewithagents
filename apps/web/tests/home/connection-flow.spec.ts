import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('unavailable phone setup retains a usable workspace and only rechecks status', async ({
  page,
}, info) => {
  const original = await (await page.request.get('/api/phone/status')).json();
  let issue: 'configuration' | 'listener' | null = 'configuration';
  let reads = 0;
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.route('**/api/phone/status', (route) => {
    reads++;
    return route.fulfill({
      json: {
        ...original,
        configured: issue === 'listener',
        enabled: false,
        setupIssue: issue,
        connection: issue ? 'error' : 'off',
      },
    });
  });
  await page.goto('/#/phone');
  await expect(page.getByRole('alert')).toHaveText('Phone settings need repair.');
  await expect(page.getByText(/Saved phone pairing is retained/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on phone access' })).toHaveCount(0);
  const before = reads;
  issue = 'listener';
  await page.getByRole('button', { name: 'Check phone setup', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'The phone connection could not start on this computer.',
  );
  expect(reads).toBeGreaterThan(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/screenshots/connections/${info.project.name}-phone-unavailable.png`,
  });
  await page.getByRole('link', { name: 'Workspace settings', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Make yourself at home.');
  issue = null;
  await page.getByRole('link', { name: /Phone access/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Bring your workspace to your phone.' }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test('phone settings retry a first-read failure inside the app without locking the workspace', async ({
  page,
}) => {
  let reads = 0;
  await page.route('**/api/phone/status', async (route) => {
    if (++reads === 2)
      return route.fulfill({
        status: 503,
        json: { error: 'Phone setup is temporarily unavailable.' },
      });
    await route.fallback();
  });
  await page.goto('/#/phone');
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await page.getByRole('button', { name: 'Try connection again', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Bring your workspace to your phone.', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('settings pages are reachable, read-only on opening and fit the shared shell', async ({
  page,
}, info) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Make yourself at home.');
  await page.screenshot({
    path: `../../data/screenshots/connections/${info.project.name}-settings.png`,
  });
  for (const [title, path] of [
    ['Models and roles', 'models'],
    ['Assistant privacy', 'assistant-settings'],
    ['Computers and accounts', 'computers'],
    ['Phone access', 'phone'],
    ['Recovery copies', 'recovery'],
  ] as const) {
    await page.getByRole('link', { name: new RegExp(title) }).click();
    await expect(page).toHaveURL(new RegExp(`#/${path}$`));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    await page.goBack();
    await expect(page.locator('.connection-grid')).toBeVisible();
  }
  expect(writes).toEqual([]);
});

test('personal conversation creation and privacy saves retain exact retry receipts without sending a turn', async ({
  page,
}, info) => {
  const original = await (await page.request.get('/api/frontdesk')).json();
  let opened = false;
  await page.route('**/api/frontdesk', async (route) => {
    if (!opened) return route.fulfill({ json: { ...original, agentId: null, projectId: null } });
    await route.fallback();
  });
  const starts: object[] = [];
  let messages = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/messages')) messages++;
  });
  await page.route('**/api/frontdesk/start', async (route) => {
    starts.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (starts.length === 1)
      return route.fulfill({
        status: 502,
        json: { error: 'The confirmation was lost. Check the same request.' },
      });
    opened = true;
    return route.fulfill({ response });
  });
  await page.goto('/#/assistant');
  await page.getByRole('button', { name: 'Create personal conversation' }).click();
  await expect(page.getByRole('alert')).toContainText('confirmation was lost');
  await page.getByRole('button', { name: 'Check the same request' }).click();
  await expect(page.getByRole('textbox', { name: 'Message Your assistant' })).toBeVisible();
  expect(starts).toHaveLength(2);
  expect(starts[0]).toEqual(starts[1]);
  expect(messages).toBe(0);
  await page.getByRole('link', { name: 'Assistant privacy', exact: true }).click();
  const value = `Concise updates on ${info.project.name}`;
  await page.getByLabel('How should your assistant work with you?').fill(value);
  const saves: object[] = [];
  await page.route('**/api/frontdesk/settings', async (route) => {
    saves.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    return saves.length === 1
      ? route.fulfill({ status: 502, json: { error: 'Save confirmation lost.' } })
      : route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Save confirmation lost');
  await page.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Assistant settings saved');
  expect(saves[0]).toEqual(saves[1]);
  expect(messages).toBe(0);
  await page.reload();
  await expect(page.getByLabel('How should your assistant work with you?')).toHaveValue(value);
  await page.screenshot({
    path: `../../data/screenshots/connections/${info.project.name}-privacy.png`,
  });
});

test('a lost recovery-copy response retains the same copy and update handoff', async ({
  page,
}, info) => {
  const keys: string[] = [];
  const copies: string[] = [];
  await page.route('**/api/recovery-backups', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    keys.push(route.request().postDataJSON().key);
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    copies.push((await response.json()).id);
    return keys.length === 1
      ? route.fulfill({ status: 502, json: { error: 'Lost response.' } })
      : route.fulfill({ response });
  });
  await page.goto('/#/recovery');
  await page.getByRole('button', { name: 'Create recovery copy', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('connection ended');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verified recovery copy' }).first()).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(copies[0]).toBe(copies[1]);
  const item = page
    .getByRole('list', { name: 'Recent recovery copies' })
    .locator('li')
    .filter({
      has: page.locator('code', { hasText: copies[0] }),
    });
  await item.getByText('Use this copy before updating', { exact: true }).click();
  await expect(item.locator('.recovery-request-text')).toContainText(copies[0]);
  await expect(item.locator('.recovery-request-text')).toContainText('docs/UPDATE_APP.md');
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Clipboard unavailable');
        },
      },
    }),
  );
  await item.getByRole('button', { name: 'Copy update request' }).click();
  await expect(item.getByRole('status')).toContainText('Select and copy the request above');
  await page.screenshot({
    path: `../../data/screenshots/connections/${info.project.name}-update-request.png`,
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => sessionStorage.setItem('copied-update', text) },
    }),
  );
  await item.getByRole('button', { name: 'Copy update request' }).click();
  await expect(item.getByRole('status')).toContainText('Request copied');
  expect(await page.evaluate(() => sessionStorage.getItem('copied-update'))).toContain(copies[0]);
  await page.getByRole('link', { name: 'See active work', exact: true }).click();
  await expect(page).toHaveURL(/#\/work$/);
  await page.goBack();
  await page.getByRole('link', { name: 'Check this computer', exact: true }).click();
  await expect(page).toHaveURL(/#\/welcome$/);
  expect(writes).toEqual([]);
});

test('history opens retained evidence without executing work and workspace reconnects a forgotten browser without replay', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const project = snapshot.projects.find((p: { name: string }) => p.name === 'Fieldnotes');
  const missing = randomUUID();
  const text = 'Preserve this local draft after the computer was restored.';
  await page.addInitScript(
    ({ missing, text, agent }) => {
      localStorage.setItem('dock:local:workspace:client', missing);
      localStorage.setItem(
        'dock:local:workspace:pending',
        JSON.stringify({ old: 'Retain, never replay' }),
      );
      localStorage.setItem(
        `dock:local:workspace:draft:${agent}`,
        JSON.stringify({ text, baseRevision: 0 }),
      );
    },
    { missing, text, agent: project.managerId },
  );
  const writes: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST') writes.push(req.url());
  });
  await page.goto('/#/workspace');
  await expect(page.getByRole('alert')).toContainText('connected again');
  const registered = await page.evaluate(() => localStorage.getItem('dock:local:workspace:client'));
  expect(registered).not.toBe(missing);
  expect(writes.filter((url) => url.includes('/workspace/'))).toEqual([
    expect.stringContaining('/workspace/clients'),
  ]);
  expect(
    await page.evaluate(
      (id) => JSON.parse(localStorage.getItem(`dock:local:workspace:retired:${id}`)!).old,
      missing,
    ),
  ).toBe('Retain, never replay');
  await page.getByRole('link', { name: 'Find a conversation', exact: true }).click();
  await page.locator(`a[href="#/chat/${project.managerId}"]`).first().click();
  await expect(page.getByRole('textbox', { name: 'Message Fieldnotes manager' })).toHaveValue(text);
  await page.getByRole('link', { name: 'Saved history', exact: true }).click();
  await expect(page.getByLabel('Find in saved history')).toBeVisible();
  await page.getByRole('button', { name: 'Read saved item' }).first().click();
  await expect(page.getByRole('region', { name: 'Saved evidence' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open conversation', exact: true })).toBeVisible();
  expect(writes.filter((url) => /\/(messages|commands|restore)$/.test(url))).toEqual([]);
});

test('editor chats keep provider identity, drafts and delivery receipts through reload and offline return', async ({
  page,
  isMobile,
}, info) => {
  const codex = {
    windowId: randomUUID(),
    provider: 'codex',
    label: 'This computer',
    threadId: 'same-thread',
    title: 'Plan the experiment',
    status: 'idle',
    message: '',
    entries: [{ id: '1', role: 'assistant', text: 'Here is the retained experiment.' }],
  };
  const claude = {
    ...codex,
    provider: 'claude',
    windowId: randomUUID(),
    title: 'Review the experiment',
  };
  let online = true;
  await page.route('**/api/vscode/windows', (route) =>
    route.fulfill({ json: online ? [codex, claude] : [] }),
  );
  for (const state of [codex, claude])
    await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
      route.fulfill({ json: state }),
    );
  const sends: { key: string; provider: string; threadId: string }[] = [];
  await page.route(`**/api/vscode/windows/${claude.windowId}/send`, async (route) => {
    sends.push(route.request().postDataJSON());
    return route.abort('failed');
  });
  await page.route('**/api/vscode/deliveries/*', (route) =>
    route.fulfill({ json: { state: 'sent', message: 'Sent to Claude Code.' } }),
  );
  await page.goto('/#/vscode');
  await page.getByRole('button', { name: /Plan the experiment/ }).click();
  await page.getByLabel('Message Codex').fill('Retain my Codex draft');
  await page.getByRole('link', { name: 'All editor chats', exact: true }).click();
  await page.getByRole('button', { name: /Review the experiment/ }).click();
  await page.getByLabel('Message Claude Code').fill('Review this evidence');
  if (isMobile) {
    await page.getByLabel('Message Claude Code').press('Enter');
    await expect(page.getByLabel('Message Claude Code')).toHaveValue('Review this evidence\n');
    expect(sends).toHaveLength(0);
  }
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Check delivery', exact: true }).click();
  await expect(page.getByLabel('Message Claude Code')).toHaveValue('');
  expect(sends).toHaveLength(1);
  expect(sends[0].provider).toBe('claude');
  expect(sends[0].threadId).toBe('same-thread');
  await page.getByRole('link', { name: 'All editor chats', exact: true }).click();
  await page.getByRole('button', { name: /Plan the experiment/ }).click();
  await expect(page.getByLabel('Message Codex')).toHaveValue('Retain my Codex draft');
  online = false;
  await expect(page.locator('.mirror-header')).toContainText('Offline');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  online = true;
  await expect(page.locator('.mirror-header')).toContainText('Connected');
  await page.screenshot({
    path: `../../data/screenshots/connections/${info.project.name}-editor.png`,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('transient JSON and tunnel failures do not request phone authentication, while an actual 401 does', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { authRequests: number }).authRequests = 0;
    window.addEventListener(
      'dock:authentication-required',
      () => (window as unknown as { authRequests: number }).authRequests++,
    );
  });
  let kind = 0;
  await page.route('**/api/recovery-backups', (route) =>
    kind === 0
      ? route.fulfill({ status: 503, json: { error: 'Temporarily unavailable.' } })
      : kind === 1
        ? route.fulfill({ status: 502, contentType: 'text/html', body: 'Tunnel unavailable' })
        : route.fulfill({ status: 401, json: { error: 'Unlock this phone.' } }),
  );
  await page.goto('/#/recovery');
  await expect(page.getByRole('alert')).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { authRequests: number }).authRequests),
  ).toBe(0);
  kind = 1;
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
  expect(
    await page.evaluate(() => (window as unknown as { authRequests: number }).authRequests),
  ).toBe(0);
  kind = 2;
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { authRequests: number }).authRequests))
    .toBeGreaterThan(0);
});
