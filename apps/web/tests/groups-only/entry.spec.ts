import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { resolve, join, basename, dirname, parse, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareBrowserHandoff } from '../../../server/dist/local-browser-handoff.js';
const root = () =>
  JSON.parse(
    readFileSync(resolve('../../data/groups-only-browser/installation/active.json'), 'utf8'),
  ).root as string;
const savedHost = 'a3ad4940-b687-42d0-8c7f-76109b67e45d';
const savedCluster = {
  controllerHost: savedHost,
  projectId: '39eb77b0-3540-4395-b8eb-f86f42fe3279',
};
const generalApi =
  /^\/api\/(?:workspace|snapshot|hosts|quark|frontdesk|vscode|owner-terminal|agents|projects|pulsar|scheduler|app-updates|model-policy|providers|resources|cluster)(?:\/|$)/;

test('actual Groups entry ignores old navigation and pins this installation without changing saved choices', async ({
  page,
}) => {
  await page.addInitScript(
    ({ savedHost, savedCluster }) => {
      if (!location.hostname.startsWith('swa-')) return;
      try {
        if (sessionStorage.getItem('groups-only-seeded')) return;
        localStorage.setItem('dock:host', savedHost);
        localStorage.setItem('dock:cluster-project', JSON.stringify(savedCluster));
        localStorage.setItem('swa:groups:local:retained-draft', 'Keep my group draft');
        sessionStorage.setItem('dock:workspace-ui', 'classic');
        sessionStorage.setItem('groups-only-seeded', 'yes');
      } catch {}
    },
    { savedHost, savedCluster },
  );
  const calls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/'))
      calls.push(new URL(request.url()).pathname);
  });
  const link = await prepareBrowserHandoff(root(), 4372);
  expect(link).not.toBeNull();
  await page.goto(link!);
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/?workspace=classic#/quark`);
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('computer')).toBe('entry');
  expect(await page.evaluate(() => localStorage.getItem('dock:host'))).toBe(savedHost);
  expect(await page.evaluate(() => localStorage.getItem('dock:cluster-project'))).toBe(
    JSON.stringify(savedCluster),
  );
  expect(await page.evaluate(() => localStorage.getItem('swa:groups:local:retained-draft'))).toBe(
    'Keep my group draft',
  );
  expect(calls.filter((path) => generalApi.test(path))).toEqual([]);
  await expect(page.getByRole('button', { name: 'New group', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
});

test('distribution failure shows dark recovery and preserves storage before retry', async ({
  page,
}) => {
  const link = await prepareBrowserHandoff(root(), 4372);
  await page.goto(link!);
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
  await page.evaluate(() =>
    localStorage.setItem('groups-only-failure-draft', 'Retained through retry'),
  );
  await page.route('**/api/distribution', (route) => route.abort());
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry opening app' })).toBeVisible();
  const background = await page
    .locator('body')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe('rgb(255, 255, 255)');
  await page.unroute('**/api/distribution');
  await page.getByRole('button', { name: 'Retry opening app' }).click();
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('groups-only-failure-draft'))).toBe(
    'Retained through retry',
  );
});

test('real shared conversation keeps private drafts and supports paused automatic sharing, local removal and restoration', async ({
  page,
}, info) => {
  const calls: string[] = [];
  const missing: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) calls.push(path);
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/') && response.status() === 404) missing.push(path);
  });
  const link = await prepareBrowserHandoff(root(), 4372);
  await page.goto(link!);
  // Every case owns a newly created group. Failed assertions cannot poison the
  // seeded group or another layout's contribution mode/removal state.
  const groupName = `Human ${info.project.name} ${randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'New group', exact: true });
  await create.getByLabel('Your display name').fill('Browser researcher');
  await create.getByLabel('Project name').fill(groupName);
  await create.getByRole('radio', { name: 'Chat only — no GitHub', exact: true }).check();
  await create.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByRole('heading', { name: groupName, exact: true })).toBeVisible();
  const row = page.getByRole('button', { name: new RegExp(groupName) });
  const composer = page.locator('.composer textarea');
  const shared = `Real human message ${info.project.name} ${Date.now()}`;
  const accepted: Record<string, unknown>[] = [];
  await page.route('**/api/groups/send', async (route) => {
    accepted.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    // The real host/Worker accepted it; only its acknowledgement is lost.
    if (accepted.length === 1)
      await route.fulfill({ status: 503, json: { error: 'Owned fixture lost send receipt' } });
    else await route.fulfill({ response });
  });
  await composer.fill(shared);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Retry previous message', exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue(shared);
  await page.reload();
  await expect(composer).toHaveValue(shared);
  await page.getByRole('button', { name: 'Retry previous message', exact: true }).click();
  await expect(composer).toHaveValue('');
  const delivered = page
    .locator('.group-shared-chat .conversation .markdown')
    .getByText(shared, { exact: true });
  await expect(delivered).toBeVisible();
  expect(accepted).toHaveLength(2);
  expect(accepted[1]).toEqual(accepted[0]);
  await expect(delivered).toHaveCount(1);
  await page.unroute('**/api/groups/send');
  const draft = `Private unsent draft ${info.project.name}`;
  await composer.fill(draft);
  await expect(page.locator('.composer [data-draft]')).toHaveAttribute('data-draft', 'saved');
  await page.reload();
  await expect(composer).toHaveValue(draft);
  await expect(page.locator('.group-shared-chat .conversation')).not.toContainText(draft);
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  const manage = page.getByRole('dialog', { name: 'Manage group' });
  await expect(manage).toBeVisible();
  await manage.getByRole('button', { name: /Automatic sharing: On/ }).click();
  const mode = page.getByRole('dialog', { name: 'Automatic sharing on this computer' });
  await mode.getByRole('button', { name: 'Pause automatic sharing', exact: true }).click();
  await expect(mode).toBeHidden();
  await manage.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.groups-workspace-heading')).toContainText('Automatic sharing paused');
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(composer).toHaveValue(draft);
  const pausedText = `${draft} sent manually while automatic sharing is paused`;
  await composer.fill(pausedText);
  const pausedSends: Record<string, unknown>[] = [];
  await page.route('**/api/groups/send', async (route) => {
    pausedSends.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (pausedSends.length === 1)
      await route.fulfill({ status: 503, json: { error: 'Lost paused human send receipt' } });
    else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Retry previous message', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Retry previous message', exact: true }).click();
  await expect(composer).toHaveValue('');
  await expect(
    page
      .locator('.group-shared-chat .conversation .markdown')
      .getByText(pausedText, { exact: true }),
  ).toHaveCount(1);
  expect(pausedSends).toHaveLength(2);
  expect(pausedSends[1]).toEqual(pausedSends[0]);
  expect(calls.filter((path) => path === '/api/groups/request-agent')).toEqual([]);
  await page.unroute('**/api/groups/send');
  const pausedDraft = `Retained private draft while paused ${info.project.name}`;
  await composer.fill(pausedDraft);
  await expect(page.locator('.composer [data-draft]')).toHaveAttribute('data-draft', 'saved');
  await page.reload();
  await expect(composer).toHaveValue(pausedDraft);
  await page.screenshot({
    path: info.outputPath('groups-human-sharing-paused.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await manage.getByRole('button', { name: 'Remove from my app', exact: true }).click();
  const remove = page.getByRole('dialog', { name: 'Remove group from my app' });
  await remove.getByRole('button', { name: 'Remove group', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'Removed groups' }).click();
  await page
    .locator('.groups-removed-row')
    .filter({ hasText: groupName })
    .getByRole('button', { name: 'Restore group', exact: true })
    .click();
  const restore = page.getByRole('dialog', { name: 'Restore group to this app' });
  await restore.getByRole('button', { name: 'Restore group', exact: true }).click();
  await row.click();
  await expect(composer).toHaveValue(pausedDraft);
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await manage.getByRole('button', { name: /Automatic sharing: Paused/ }).click();
  await mode.getByRole('button', { name: 'Resume automatic sharing', exact: true }).click();
  await expect(mode).toBeHidden();
  await page.screenshot({ path: info.outputPath('groups-human-manage.png'), fullPage: true });
  await manage.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue(pausedDraft);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  const bounds = await composer.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(calls.filter((path) => generalApi.test(path))).toEqual([]);
  expect(missing).toEqual([]);
  await expect(page.getByText('This API is unavailable in Groups.', { exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({ path: info.outputPath('groups-human-restored.png'), fullPage: true });
});

test('distribution refusal keeps a bounded server explanation and recovers from non-JSON failure', async ({
  page,
}) => {
  const link = await prepareBrowserHandoff(root(), 4372);
  await page.goto(link!);
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
  await page.route('**/api/distribution', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Phone access is turned off on your computer.' }),
    }),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText(
    'Phone access is turned off on your computer.',
  );
  await page.unroute('**/api/distribution');
  await page.route('**/api/distribution', (route) =>
    route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Proxy unavailable</h1>' }),
  );
  await page.getByRole('button', { name: 'Retry opening app' }).click();
  await expect(page.getByRole('alert')).toContainText('The computer is unavailable');
  await page.unroute('**/api/distribution');
  await page.getByRole('button', { name: 'Retry opening app' }).click();
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
});

test('real creation reuses its supplied folder and exact create/bind receipts after lost replies', async ({
  page,
}, info) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'swa-onboarding-')));
  const folderName = basename(folder);
  try {
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as Window & { setupCopy?: string }).setupCopy = text;
          },
        },
      }),
    );
    const link = await prepareBrowserHandoff(root(), 4372);
    await page.goto(link!);
    // The file handoff can finish goto while access restoration is still navigating.
    // Wait for the app document before installing the later lost-response routes.
    await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New group', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New group', exact: true });
    const groupName = `Onboarding ${info.project.name} ${randomUUID().slice(0, 8)}`;
    await form.getByLabel('Your display name').fill('Creator');
    await form.getByLabel('Project name').fill(groupName);
    await form.getByRole('radio', { name: 'Use my intended work folder', exact: true }).check();
    await form.getByRole('button', { name: 'Choose work folder', exact: true }).click();
    const browser = page.getByRole('dialog', { name: 'Choose a project folder' });
    // Use real navigation and its server-issued IDs, rather than rewriting an
    // initial request during the handoff's cross-document navigation.
    const path = browser.getByRole('navigation', { name: 'Folder path', exact: true });
    const folders = browser.locator('.folder-browser-list');
    await browser
      .getByRole('navigation', { name: 'Locations', exact: true })
      .getByRole('button', { name: 'This computer', exact: true })
      .click();
    await expect(path.locator('button[aria-current="location"]')).toHaveText('This computer');
    const parent = dirname(folder);
    for (const segment of parent.slice(parse(parent).root.length).split(sep).filter(Boolean)) {
      await expect(folders).toHaveAttribute('aria-busy', 'false');
      const child = folders.getByRole('button', { name: segment, exact: true });
      const more = folders.getByRole('button', { name: 'Load more folders', exact: true });
      while ((await child.count()) === 0 && (await more.count()) > 0) {
        await more.click();
        await expect(folders).toHaveAttribute('aria-busy', 'false');
      }
      await child.click();
      await expect(path.locator('button[aria-current="location"]')).toHaveText(segment);
    }
    await browser
      .getByRole('combobox', { name: 'Search scope', exact: true })
      .selectOption('children');
    await browser.getByRole('searchbox', { name: 'Search folders', exact: true }).fill(folderName);
    await browser.getByRole('button', { name: 'Search folders', exact: true }).click();
    await browser
      .locator('.folder-browser-list')
      .getByRole('button', { name: new RegExp(folderName) })
      .click();
    await browser.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await expect(form).toContainText(folder);
    await form.getByRole('button', { name: 'Copy group setup prompt', exact: true }).click();
    const prompt = await page.evaluate(() => (window as Window & { setupCopy?: string }).setupCopy);
    expect(prompt).toContain(JSON.stringify(groupName));
    expect(prompt).toContain(JSON.stringify(folder));
    await page.reload();
    await expect(form.getByLabel('Project name')).toHaveValue(groupName);
    const creates: Record<string, unknown>[] = [],
      binds: Record<string, unknown>[] = [];
    await page.route('**/api/groups/create', async (route) => {
      creates.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (creates.length === 1)
        await route.fulfill({
          status: 503,
          json: { error: 'Lost create reply; retry the saved request.' },
        });
      else await route.fulfill({ response });
    });
    await page.route('**/api/groups/workspace', async (route) => {
      const input = route.request().postDataJSON();
      if (input.action !== 'select') return route.continue();
      binds.push(input);
      const response = await route.fetch();
      if (binds.length === 1)
        await route.fulfill({
          status: 503,
          json: { error: 'Lost bind reply; retry the saved request.' },
        });
      else await route.fulfill({ response });
    });
    const create = form.getByRole('button', { name: 'Create group', exact: true });
    await create.click();
    await expect(form.getByRole('alert')).toContainText('Lost create reply');
    await page.reload();
    await create.click();
    await expect(form.getByRole('alert')).toContainText('Lost bind reply');
    await form.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Group setup', exact: true }).click();
    const recovery = page.getByRole('dialog', { name: 'Group setup', exact: true });
    await recovery.getByText('Recover an interrupted request', { exact: true }).click();
    await recovery.getByRole('button', { name: 'Recover pending setup', exact: true }).click();
    await expect(page.getByRole('heading', { name: groupName, exact: true })).toBeVisible();
    await recovery.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.evaluate(() => {
      location.hash = '#/chats/groups';
    });
    await page.getByRole('button', { name: 'Continue group setup', exact: true }).click();
    await expect(form.getByLabel('Project name')).toHaveValue(groupName);
    await expect(form.getByLabel('Project name')).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Group created', exact: true })).toBeDisabled();
    await form.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(groupName) }).click();
    expect(creates).toHaveLength(2);
    expect(new Set(creates.map((input) => input.key)).size).toBe(1);
    expect(creates[0]).not.toHaveProperty('selectionKey');
    expect(creates[0]).not.toHaveProperty('path');
    expect(binds).toHaveLength(2);
    expect(binds[0]).toEqual(binds[1]);
    expect(binds[0]).not.toHaveProperty('path');
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    const manage = page.getByRole('dialog', { name: 'Manage group' });
    await manage.getByText('Your saved setup choices', { exact: true }).click();
    await manage.getByRole('button', { name: 'Copy saved setup prompt', exact: true }).click();
    expect(
      await page.evaluate(() => (window as Window & { setupCopy?: string }).setupCopy),
    ).toContain('This group already exists; do not create another group.');
    await page.screenshot({ path: info.outputPath('created-group-context.png') });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
