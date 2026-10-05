import { expect, test, type Page } from '@playwright/test';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { Store } from '../../../server/dist/store.js';
import { ProjectApps } from '../../../server/dist/project-apps.js';

// Browser-only examples of manager-registered apps. They never enter an owner's database.
const now = new Date().toISOString();
const projectId = '11111111-1111-4111-8111-111111111111';
const managerId = '22222222-2222-4222-8222-222222222222';
function fixture(
  id: string,
  name: string,
  state: 'running' | 'stopped' | 'not_responding',
  port: number,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    projectId,
    managerId,
    name,
    description: '',
    port,
    path: '/',
    remoteUrl: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    projectName: 'Research feeds',
    managerName: 'Feeds manager',
    localUrl: `http://localhost:${port}/`,
    state,
    ...extra,
  };
}
const apps = [
  fixture('a0000000-0000-4000-8000-000000000001', 'AI News', 'running', 5173, {
    description: 'Daily papers and model releases, summarized each morning.',
    remoteUrl: 'https://news.example.org/',
  }),
  fixture('b0000000-0000-4000-8000-000000000002', 'Sample browser', 'stopped', 8050),
  fixture(
    'c0000000-0000-4000-8000-000000000003',
    'Very long experimental dashboard name for overnight runs',
    'not_responding',
    8888,
  ),
];
async function serveApps(page: Page, openHere: boolean, failFirst = false) {
  let reads = 0;
  await page.route('**/api/apps', (route) => {
    reads += 1;
    if (failFirst && reads === 1)
      return route.fulfill({ status: 502, json: { error: 'Computer unavailable' } });
    return route.fulfill({ json: { apps, openHere, checkedAt: now } });
  });
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('registered apps show their state, retry failed reads and open on this computer', async ({
  page,
}, info) => {
  await serveApps(page, true, true);
  await page.goto('/#/apps');
  await expect(page.getByText('Project apps could not be read')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  const tiles = page.locator('.apps-grid .apps-tile');
  await expect(tiles).toHaveCount(4);
  await expect(tiles.first()).toHaveText('TEXLaTeX');
  await expect(tiles.nth(1)).toHaveAccessibleName('AI News, Research feeds: Running');
  await expect(tiles.nth(2)).toContainText('Stopped');
  await expect(tiles.nth(3)).toContainText('Not responding');
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('apps-gallery.png'), fullPage: true });

  await tiles.nth(1).click();
  await expect(page.getByRole('heading', { name: 'AI News', level: 1 })).toBeVisible();
  const open = page.getByRole('link', { name: 'Open app' });
  await expect(open).toHaveAttribute('href', 'http://localhost:5173/');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', /noopener/);
  await expect(page.getByRole('link', { name: 'Open news.example.org' })).toHaveAttribute(
    'href',
    'https://news.example.org/',
  );
  await expect(page.getByRole('link', { name: 'Feeds manager' })).toHaveAttribute(
    'href',
    `#/chat/${managerId}`,
  );
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('app-detail.png'), fullPage: true });

  // A failed removal keeps its receipt; the retry cannot remove a different revision twice.
  const keys: string[] = [];
  await page.route('**/api/apps/*/remove', (route) => {
    keys.push(route.request().postDataJSON().key);
    return keys.length === 1
      ? route.fulfill({ status: 502, json: { error: 'Computer unavailable. Try again.' } })
      : route.fulfill({ json: { removed: true, id: apps[0]!.id } });
  });
  await page.getByRole('button', { name: 'Remove from Apps' }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Computer unavailable');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page).toHaveURL(/#\/apps$/);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);

  await page.goto('/#/apps/b0000000-0000-4000-8000-000000000002');
  await expect(page.getByText('Nothing is listening on localhost:8050')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open app' })).toHaveClass(/quiet/);
});

test('apps on another computer explain where they open and keep other-device links', async ({
  page,
}) => {
  await serveApps(page, false);
  await page.goto('/#/apps/a0000000-0000-4000-8000-000000000001');
  await expect(page.getByRole('heading', { name: 'AI News', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open app' })).toHaveCount(0);
  await expect(page.getByText(/opens only in a browser on that computer/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open news.example.org' })).toBeVisible();
  await page.goto('/#/apps/d0000000-0000-4000-8000-000000000004');
  await expect(page.getByRole('heading', { name: 'App not found', level: 1 })).toBeVisible();
  await noHorizontalOverflow(page);
});

test('a manager-registered app runs, opens, stops and is removed on the real host', async ({
  page,
}, info) => {
  const response = page.waitForResponse('**/api/apps');
  await page.goto('/#/apps');
  expect(await (await response).json()).toMatchObject({ apps: [], openHere: true });
  await expect(page.getByText('Web apps your project managers build appear here')).toBeVisible();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const project = snapshot.projects.find((p: { internal?: boolean }) => !p.internal);
  // A small app this test owns and closes, standing in for one a manager started natively.
  const server = createHttpServer((_request, reply) =>
    reply.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Fixture project app</h1>'),
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const name = `Fixture app ${info.project.name}`;
  const fixtureRoot = resolve(process.env.DOCK_E2E_DATA_DIR ?? '../../data/browser-data/home');
  const store = new Store(join(fixtureRoot, 'demo', 'dock.sqlite'));
  try {
    // The same host path the dock_app manager tool uses after lease admission.
    new ProjectApps(store).saveForManager(project.managerId, crypto.randomUUID(), { name, port });
  } finally {
    store.close();
  }
  try {
    await page.reload();
    const tile = page.getByRole('link', { name: new RegExp(`^${name}`) });
    await expect(tile).toContainText('Running');
    await tile.click();
    const popup = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Open app' }).click();
    await expect((await popup).getByRole('heading')).toHaveText('Fixture project app');
    await (await popup).close();
  } finally {
    await new Promise((done) => server.close(done));
  }
  await expect(async () => {
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.locator('.app-status-card')).toContainText('Stopped', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Remove from Apps' }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page).toHaveURL(/#\/apps$/);
  await expect(page.getByRole('link', { name: new RegExp(`^${name}`) })).toHaveCount(0);
  expect((await (await page.request.get('/api/apps')).json()).apps).toEqual([]);
});
