import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
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

test('real shared conversation keeps private drafts and supports read-only, local removal and restoration', async ({
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
  await manage.getByRole('button', { name: /Contribution mode: Contribute/ }).click();
  const mode = page.getByRole('dialog', { name: 'Contribution mode on this computer' });
  await mode.getByRole('button', { name: 'Read-only', exact: true }).click();
  await expect(mode).toBeHidden();
  await manage.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.groups-workspace-heading')).toContainText('Read-only');
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await expect(composer).toHaveValue(draft);
  const editedDraft = `${draft} edited while read-only`;
  await composer.fill(editedDraft);
  const sendsBeforeEnter = calls.filter((path) => path === '/api/groups/send').length;
  await composer.press('Enter');
  // Phones may insert a newline; neither pointer mode may contribute.
  const readOnlyDraft = await composer.inputValue();
  expect(readOnlyDraft.trim()).toBe(editedDraft);
  await expect(page.locator('.composer [data-draft]')).toHaveAttribute('data-draft', 'saved');
  await page.reload();
  await expect(composer).toHaveValue(readOnlyDraft);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  expect(calls.filter((path) => path === '/api/groups/send')).toHaveLength(sendsBeforeEnter);
  await expect(page.locator('.group-shared-chat .conversation')).not.toContainText(editedDraft);
  await page.screenshot({ path: info.outputPath('groups-human-read-only.png'), fullPage: true });
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
  await expect(composer).toHaveValue(readOnlyDraft);
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await manage.getByRole('button', { name: /Contribution mode: Read-only/ }).click();
  await mode.getByRole('button', { name: 'Contribute', exact: true }).click();
  await expect(mode).toBeHidden();
  await page.screenshot({ path: info.outputPath('groups-human-manage.png'), fullPage: true });
  await manage.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue(readOnlyDraft);
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
