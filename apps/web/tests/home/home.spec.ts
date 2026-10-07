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

test('GitHub and Cloudflare prompts are readable and copyable in Apps and Help', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as Window & { setupCopies: string[]; setupCopyFails: boolean };
    state.setupCopies = [];
    state.setupCopyFails = false;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          if (state.setupCopyFails) throw new Error('Clipboard unavailable');
          state.setupCopies.push(value);
        },
      },
    });
  });
  await readings(page);
  await page.goto('/#/apps');
  await expect(page.locator('.apps-setup .setup-guide')).not.toBeVisible();
  await page.locator('.apps-setup > summary').click();
  await expect(page.locator('.apps-setup .setup-guide')).toBeVisible();
  for (const destination of ['Apps', 'Help']) {
    if (destination === 'Help') {
      await page.getByRole('button', { name: 'Hide setup shortcut' }).click();
      await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeFocused();
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible();
      await expect(page.locator('.apps-setup')).toHaveCount(0);
      await page.getByRole('button', { name: 'Help and setup', exact: true }).click();
    }
    const guide =
      destination === 'Apps'
        ? page.locator('.apps-setup')
        : page.getByRole('dialog', { name: 'Help and setup', exact: true });
    const cards = guide.locator('.setup-prompt');
    await expect(cards).toHaveCount(2);
    for (const [index, account] of ['GitHub', 'Cloudflare'].entries()) {
      const card = cards.nth(index);
      const prompt = card.locator('pre');
      await expect(prompt).toContainText(`Set up ${account} sign-in on this computer`);
      await expect(prompt).toContainText('Never ask me to paste credentials into chat.');
      // DOM visibility alone misses pale text on a pale inherited pre background.
      const contrast = await prompt.evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (color: string) => {
          const channels = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((n) => {
              const value = n / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
          return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
        };
        const ink = luminance(style.color);
        const paper = luminance(style.backgroundColor);
        return (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05);
      });
      expect(contrast).toBeGreaterThanOrEqual(4.5);
      await card.getByRole('button', { name: 'Copy', exact: true }).click();
      await expect(card.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
      expect(
        await page.evaluate(() =>
          (window as Window & { setupCopies: string[] }).setupCopies.at(-1),
        ),
      ).toBe(await prompt.textContent());
      expect((await prompt.boundingBox())!.height).toBeGreaterThan(50);
      await page.screenshot({
        path: test.info().outputPath(`${destination}-${account}-prompt.png`),
      });
    }
    await noHorizontalOverflow(page);
  }
  await page.evaluate(() => {
    (window as Window & { setupCopyFails: boolean }).setupCopyFails = true;
  });
  const lastCard = page
    .getByRole('dialog', { name: 'Help and setup', exact: true })
    .locator('.setup-prompt')
    .last();
  await lastCard.getByRole('button').click();
  await expect(lastCard.getByRole('status')).toContainText('copy it by hand');
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(
    await lastCard.locator('pre').textContent(),
  );
});

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
  for (const target of ['chats', 'apps', 'work', 'resources', 'settings', 'computers']) {
    const link = page.locator(`a[href="#/${target}"]:visible`).first();
    await link.click();
    await expect(page.locator('main h1').first()).toBeVisible();
    await expect(page.locator('.home-placeholder')).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  }
  await expect(page.getByRole('button', { name: /VS Code on this computer:/ })).toHaveCount(0);
  await page.locator('a[href="#/chats"]:visible').first().click();
  await page.getByRole('button', { name: /VS Code on this computer:/ }).click();
  const editorSetup = page.getByRole('dialog', { name: 'VS Code setup' });
  await expect(editorSetup).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Chats');
  await editorSetup.getByRole('button', { name: 'Close dialog' }).click();
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
  await expect(page.getByRole('link', { name: 'LaTeX', exact: true })).toHaveAttribute(
    'href',
    '#/latex',
  );
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
  // Home also keeps an empty pull-to-refresh live region.
  await expect(
    page.getByRole('status').filter({ hasText: 'Computer connection interrupted' }),
  ).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.home-connection-note')).toHaveCount(0);
  await expect(page.locator('.overview-destinations a[href="#/chats"]')).toContainText('manager');
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
  await expect(page.locator('.overview-attention')).toContainText('2.4 %/h');
  await expect(page.locator('.overview-attention')).toContainText('Weekly · estimate');
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

test('an unpaired phone cannot mount private home data', async ({ page }) => {
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
        enrolled: false,
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
    page.getByRole('heading', { name: 'Enter pairing code', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.home-shell')).toHaveCount(0);
  expect(privateReads).toBe(0);
});

test('paired home stays open on return with no app lock and closes after removal', async ({
  page,
}) => {
  await readings(page);
  let paired = true;
  await page.route('**/api/phone/status', (route) =>
    route.fulfill({
      json: {
        mode: 'remote',
        configured: true,
        enabled: true,
        connection: 'connected',
        paired,
        authentication: 'paired',
        enrolled: paired,
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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  await noHorizontalOverflow(page);
  await expect(page.getByRole('button', { name: 'Lock app', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    localStorage.setItem('dock:phone-manually-locked', '1'); // Obsolete lock flag has no effect.
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
  });
  await expect(page.locator('.home-shell')).toBeVisible();
  await page.reload();
  await expect(page.locator('.home-shell')).toBeVisible();
  paired = false;
  await page.evaluate(() => window.dispatchEvent(new Event('dock:authentication-required')));
  await expect(page.locator('.home-shell')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Enter pairing code' })).toBeVisible();
  await page.reload();
  await expect(page.locator('.home-shell')).toHaveCount(0);
});
