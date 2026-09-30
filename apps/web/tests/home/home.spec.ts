import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Deliberate browser-only examples. They never enter an owner's database.
async function readings(page: Page, options: { empty?: boolean; stale?: boolean } = {}) {
  const now = Date.now();
  await page.route('**/api/frontdesk', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), agentId: null, projectId: null } });
  });
  await page.route('**/api/capacity', (route) =>
    route.fulfill({
      json: {
        providers: ['codex', 'claude'].map((provider, i) => ({
          provider,
          account: 'local-sign-in',
          label: provider === 'codex' ? 'Codex' : 'Claude',
          plan: null,
          source: provider === 'codex' ? 'codexbar-oauth' : 'claude-native-oauth',
          observedAt: new Date(now - (options.stale ? 240_000 : 1000)).toISOString(),
          attemptedAt: new Date(now).toISOString(),
          nextRefreshAt: new Date(now + 60_000).toISOString(),
          state: options.stale ? 'error' : 'ready',
          stale: options.stale ?? false,
          message: 'Example usage reading',
          weeklyPolicy: i ? 'owner-reported-none' : 'reported',
          windows: options.empty
            ? []
            : [
                {
                  id: 'general',
                  label: 'Session',
                  scope: 'general',
                  model: null,
                  usedPercent: i ? 38 : 24,
                  windowMinutes: 300,
                  resetsAt: new Date(now + 132 * 60_000).toISOString(),
                },
                ...(i
                  ? [
                      {
                        id: 'fable-weekly',
                        label: 'Fable weekly',
                        scope: 'model',
                        model: 'fable',
                        usedPercent: 52,
                        windowMinutes: 10080,
                        resetsAt: new Date(now + 3 * 86400_000).toISOString(),
                      },
                    ]
                  : []),
              ],
        })),
        machine: options.empty
          ? null
          : {
              observedAt: new Date(now).toISOString(),
              cpuCount: 10,
              cpuUsedPercent: 32,
              memoryTotalBytes: 24 * 1024 ** 3,
              memoryAvailableBytes: 14.2 * 1024 ** 3,
              memoryBasis: 'free-plus-reclaimable-estimate',
              diskAvailableBytes: 150 * 1024 ** 3,
              loadPerCore: 0.25,
            },
        refreshing: false,
        refreshSeconds: 60,
        notice: 'Browser fixture; example data',
      },
    }),
  );
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    if (options.empty) {
      value.projects = [];
      value.agents = [];
      value.tasks = [];
      value.approvals = [];
      value.backups = [];
    }
    await route.fulfill({ json: value });
  });
  await page.route('**/api/hosts', (route) =>
    route.fulfill({
      json: { local: { id: 'local', label: 'My Mac mini' }, hosts: [], setupError: null },
    }),
  );
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('drawn Home is read-only, responsive, and opens real destinations', async ({ page }, info) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') mutations.push(request.url());
  });
  await readings(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  const codex = page.locator('.home-allowance summary').filter({ hasText: '76%' });
  await expect(codex).toHaveAttribute('aria-label', /76% left/);
  const claude = page.locator('.home-allowance summary').filter({ hasText: '62%' });
  await claude.click();
  await expect(page.locator('.home-allowance[open]')).toContainText('Fable weekly');
  await expect(page.locator('.home-allowance[open]')).toContainText('48% left');
  await claude.click();
  await expect(page.getByRole('link', { name: /personal agent|AI news/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /recovery copy/i })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await noHorizontalOverflow(page);
  const directory = '../../data/screenshots/home';
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: `${directory}/${info.project.name}-home.png`,
    fullPage: true,
    scale: 'css',
  });
  for (const target of ['chats', 'apps', 'work', 'resources', 'settings', 'computers', 'vscode']) {
    const link = page.locator(`a[href="#/${target}"]:visible`).first();
    await link.click();
    await expect(page.locator('main h1').first()).toBeVisible();
    await expect(page.locator('.home-placeholder')).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  }
  await page.getByRole('button', { name: 'Help and setup', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await noHorizontalOverflow(page);
  expect(mutations).toEqual([]);
});

test('unknown and stale allowances remain honest and destinations survive reload', async ({
  page,
}) => {
  await readings(page, { empty: true });
  await page.goto('/#/home');
  const codex = page
    .locator('.home-allowance summary')
    .filter({ has: page.locator('[aria-hidden]') })
    .first();
  await expect(codex).toHaveAttribute('aria-label', /remaining allowance unknown/);
  await codex.click();
  await expect(page.locator('.home-allowance[open]')).toContainText(
    'No allowance windows reported',
  );
  await codex.click();
  await page.locator('.overview-destinations a[href="#/apps"]').click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No apps yet' })).toBeVisible();
  await page.goto('/#/home');
  await page.unroute('**/api/capacity');
  await readings(page, { stale: true });
  await page.reload();
  await expect(page.locator('.home-allowance summary').first()).toHaveAttribute(
    'aria-label',
    /last reading/,
  );
  await noHorizontalOverflow(page);
  await page.goto('/?mirror');
  await expect(page.locator('.connection-page')).toBeVisible();
  await page.getByRole('link', { name: 'sciencewithagents home', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
});

test('connection failure has an explicit read-only retry and clears after recovery', async ({
  page,
}) => {
  await readings(page);
  let fail = true;
  await page.route('**/api/snapshot', async (route) => {
    if (fail) return route.fulfill({ status: 502, json: { error: 'Connection interrupted' } });
    return route.fallback();
  });
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Computer connection interrupted');
  fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.home-connection-note')).toHaveCount(0);
  await expect(page.locator('.destination-chats')).toContainText('manager');
});

test('Home shows window-specific rates and keeps a to-do after a lost save response', async ({
  page,
}, info) => {
  await readings(page);
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const project = snapshot.projects.find((p: { internal?: boolean }) => !p.internal);
  snapshot.agents.find((a: { id: string }) => a.id === project.managerId).status = 'running';
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  const now = Date.now();
  await page.route('**/api/project-rates', (route) =>
    route.fulfill({
      json: {
        observedAt: new Date(now).toISOString(),
        notice: 'Estimated window shares.',
        rates: [
          {
            projectId: project.id,
            provider: 'codex',
            windowId: 'weekly',
            label: 'Weekly',
            resetsAt: new Date(now + 86400000).toISOString(),
            from: new Date(now - 600000).toISOString(),
            to: new Date(now).toISOString(),
            estimatedPercentPerHour: 2.4,
            estimatedPercent: 0.4,
            samples: 3,
            stale: false,
          },
        ],
      },
    }),
  );
  const keys: string[] = [];
  await page.route('**/api/work-items', async (route) => {
    if (route.request().method() === 'GET') return route.continue();
    keys.push(route.request().postDataJSON().key);
    const response = await route.fetch();
    if (keys.length === 1)
      return route.fulfill({ status: 502, json: { error: 'Save response lost' } });
    return route.fulfill({ response });
  });
  await page.goto('/');
  await expect(page.locator('.overview-running')).toContainText('2.4 %/h');
  await expect(page.locator('.overview-running')).toContainText('Weekly · estimate');
  const text = `Keep this ${info.project.name} to-do ${Date.now()}`;
  await page.getByRole('textbox', { name: 'New to-do' }).fill(text);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.todo-error')).toContainText('Save response lost');
  await expect(page.getByRole('textbox', { name: 'New to-do' })).toHaveValue(text);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.todo-list li').filter({ hasText: text })).toHaveCount(1);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await page.reload();
  await expect(page.locator('.todo-list li').filter({ hasText: text })).toHaveCount(1);
  await noHorizontalOverflow(page);
});

test('the phone lock remains in front of private home data', async ({ page }) => {
  let privateReads = 0;
  page.on('request', (request) => {
    if (
      /\/api\/(snapshot|capacity|resources|pulsar|local-jobs|vscode\/windows|hosts)$/.test(
        new URL(request.url()).pathname,
      )
    )
      privateReads++;
  });
  await page.route('**/api/phone/status', (route) =>
    route.fulfill({
      json: {
        mode: 'remote',
        configured: true,
        enabled: true,
        connection: 'connected',
        paired: false,
        authentication: 'paired',
        enrolled: true,
        requireUnlock: true,
        setupComplete: true,
        enrollmentOpen: false,
        enrollmentInProgress: false,
        pending: null,
        origin: 'https://example.test',
        devices: [],
      },
    }),
  );
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Unlock sciencewithagents', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.home-shell')).toHaveCount(0);
  expect(privateReads).toBe(0);
});

test('a paired phone can lock the new home without opening a placeholder', async ({ page }) => {
  await readings(page);
  let paired = true;
  let locks = 0;
  await page.route('**/api/phone/status', (route) =>
    route.fulfill({
      json: {
        mode: 'remote',
        configured: true,
        enabled: true,
        connection: 'connected',
        paired,
        authentication: 'paired',
        enrolled: true,
        requireUnlock: false,
        setupComplete: true,
        enrollmentOpen: false,
        enrollmentInProgress: false,
        pending: null,
        origin: 'https://example.test',
        devices: [],
      },
    }),
  );
  await page.route('**/api/phone/lock', (route) => {
    locks++;
    paired = false;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Lock app', exact: true }).click();
  await expect(page.locator('.home-shell')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Unlock sciencewithagents', exact: true }),
  ).toBeVisible();
  expect(locks).toBe(1);
  await page.reload();
  await expect(page.locator('.home-shell')).toHaveCount(0);
});
