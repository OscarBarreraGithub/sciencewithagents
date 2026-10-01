import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { RecoveryCopy } from '@dock/shared';

test('recovery copies and browser drafts stay in bounded lists with usable details', async ({
  page,
}, info) => {
  const base = Date.UTC(2026, 9, 1, 12);
  let copies: RecoveryCopy[] = Array.from({ length: 20 }, (_, i) => ({
    id: randomUUID(),
    state: i === 1 ? 'failed' : 'verified',
    createdAt: new Date(base - i * 60_000).toISOString(),
    checkedAt: new Date(base - i * 60_000).toISOString(),
    sizeBytes: 4096,
    counts: { projects: 4, conversations: 25, entries: 2000, images: 3 },
    message:
      i === 1
        ? 'Copy could not be checked. The original records are retained.'
        : 'Database integrity checked.',
  }));
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.route('**/api/recovery-backups', (route) =>
    route.fulfill({ json: { copies, creating: false } }),
  );
  await page.addInitScript((base) => {
    for (let i = 0; i < 20; i++)
      localStorage.setItem(
        `dock:local-access:retained:layout-${i}`,
        JSON.stringify({
          version: 1,
          source: 'http://127.0.0.1:4339',
          createdAt: new Date(base - i * 60_000).toISOString(),
          entries: [
            { kind: 'local', key: 'dock:local:workspace:draft:test', value: `Retained draft ${i}` },
          ],
        }),
      );
  }, base);
  await page.goto('/#/recovery');
  const list = page.getByRole('list', { name: 'Recent recovery copies' });
  await expect(list.locator('li')).toHaveCount(20);
  await expect(page.locator('.recovery-copy[open]')).toHaveCount(0);
  await expect(list).toContainText('Copy needs attention');
  const drafts = page.getByRole('region', { name: 'Retained browser copies' });
  for (const target of [list, drafts]) {
    await target.scrollIntoViewIfNeeded();
    const outerScroll = await page.locator('.home-content').evaluate((e) => e.scrollTop);
    const sizes = await target.evaluate((e) => {
      e.scrollTop = e.scrollHeight;
      return {
        height: e.clientHeight,
        content: e.scrollHeight,
        scroll: e.scrollTop,
        viewport: innerHeight,
      };
    });
    expect(sizes.height).toBeLessThanOrEqual(sizes.viewport * 0.53 + 2);
    expect(sizes.content).toBeGreaterThan(sizes.height);
    expect(sizes.scroll).toBeGreaterThan(0);
    expect(await page.locator('.home-content').evaluate((e) => e.scrollTop)).toBe(outerScroll);
  }
  await list.evaluate((e) => e.scrollTo(0, 0));
  const first = list.locator('li').first();
  await first.locator('.recovery-copy > summary').click();
  await expect(first.getByRole('button', { name: 'Check this copy' })).toBeVisible();
  copies = [
    { ...copies[0]!, id: randomUUID(), createdAt: new Date(base + 60_000).toISOString() },
    ...copies.slice(0, 19),
  ];
  await page.getByRole('button', { name: 'Refresh list' }).click();
  await expect(list.locator('li').nth(1).locator('.recovery-copy')).toHaveAttribute('open');
  await list.locator('li').nth(1).locator('.recovery-copy > summary').click();
  await page.locator('.home-content').evaluate((e) => e.scrollTo(0, 0));
  const panels = await page.locator('.recovery-layout').evaluate((e) => {
    const main = e.querySelector('.recovery-main')!.getBoundingClientRect();
    const side = e.querySelector('.recovery-guidance')!.getBoundingClientRect();
    return {
      main: { x: main.x, y: main.y, right: main.right },
      side: { x: side.x, y: side.y },
      width: e.clientWidth,
    };
  });
  if (panels.width >= 864) {
    expect(panels.side.x).toBeGreaterThan(panels.main.right);
    expect(panels.side.y).toBeCloseTo(panels.main.y, 0);
  }
  await page.screenshot({ path: info.outputPath('recovery-bounded-lists.png') });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  const fit = await page
    .locator('.home-content')
    .evaluate((e) => ({ width: e.clientWidth, content: e.scrollWidth }));
  expect(fit.content).toBeLessThanOrEqual(fit.width + 1);
  expect(writes).toEqual([]);
});

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
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  issue = null;
  await page.getByRole('link', { name: /Phone access/ }).click();
  await expect(page.getByRole('heading', { name: 'Set up a phone connection' })).toBeVisible();
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
    page.getByRole('heading', { name: 'Set up a phone connection', exact: true }),
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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await page.screenshot({
    path: `../../data/screenshots/connections/${info.project.name}-settings.png`,
  });
  for (const [title, path] of [
    ['Model preferences', 'models'],
    ['Computers and accounts', 'computers'],
    ['Phone access', 'phone'],
    ['Recovery copies', 'recovery'],
  ] as const) {
    const destination = page.getByRole('link', { name: new RegExp(title) });
    await destination.scrollIntoViewIfNeeded();
    const previousScroll = await page.locator('.home-content').evaluate((node) => node.scrollTop);
    await destination.click();
    await expect(page).toHaveURL(new RegExp(`#/${path}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    await page.locator('.home-content').evaluate((node) => node.scrollTo(0, node.scrollHeight));
    const back = page.getByRole('link', { name: 'Back', exact: true });
    await expect(back).toBeInViewport();
    expect(
      await back.evaluate((link) => {
        const box = link.getBoundingClientRect();
        return (
          box.width >= 44 &&
          box.height >= 44 &&
          link.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
        );
      }),
    ).toBe(true);
    await back.click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.locator('.connection-grid')).toBeVisible();
    await expect
      .poll(() => page.locator('.home-content').evaluate((node) => node.scrollTop))
      .toBeCloseTo(previousScroll, 0);
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
  await expect.poll(() => copies.length).toBe(2);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(copies[0]).toBe(copies[1]);
  const item = page
    .getByRole('list', { name: 'Recent recovery copies' })
    .locator('li')
    .filter({
      has: page.locator('code', { hasText: copies[0] }),
    });
  await expect(item.locator('.recovery-copy > summary')).toContainText('Verified recovery copy');
  await item.locator('.recovery-copy > summary').click();
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
  // Welcome can check native sign-in; navigating the update handoff must start no work.
  expect(writes.filter((url) => new URL(url).pathname !== '/api/setup/check')).toEqual([]);
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
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
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
        : route.fulfill({ status: 401, json: { error: 'Pair this phone.' } }),
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

test('another computer has copyable prompts for each machine without starting setup', async ({
  page,
}, info) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          sessionStorage.setItem('test:copied', text);
        },
      },
    });
  });
  await page.goto('/#/computers');
  await page.getByText('Connect another computer', { exact: true }).click();
  const guide = page.locator('.host-connect-guide');
  const install = guide.locator('.setup-prompt').first();
  await expect(install.locator('pre')).toContainText(
    'on this new computer from https://github.com/OscarBarreraGithub/sciencewithagents',
  );
  await expect(install.locator('pre')).toContainText('docs/CONTRIBUTOR_SETUP.md');
  await expect(install.locator('pre')).toContainText('docs/MULTI_COMPUTER_SETUP.md');
  await expect(install.locator('pre')).toContainText('Applications launcher');
  await install.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('test:copied'))).toBe(
    await install.locator('pre').textContent(),
  );
  await expect(install.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('new-computer-prompt.png') });
  await page.getByText('Then finish linking from your main computer', { exact: true }).click();
  const link = guide.locator('.setup-prompt').last();
  await expect(link.locator('pre')).toContainText('on this main computer');
  await link.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('test:copied'))).toBe(
    await link.locator('pre').textContent(),
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('unavailable');
        },
      },
    });
    document.documentElement.style.fontSize = '200%';
  });
  await link.getByRole('button').click();
  await expect(link.getByRole('status')).toContainText('copy it by hand');
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(
    await link.locator('pre').textContent(),
  );
  const fit = await page
    .locator('.home-content')
    .evaluate((el) => ({ width: el.clientWidth, content: el.scrollWidth }));
  expect(fit.content).toBeLessThanOrEqual(fit.width + 1);
  expect(writes).toEqual([]);
});
