import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  groupNativeGitRequestSchema,
  type GroupNativeGitRequest,
  type GroupNativeGitView,
} from '@dock/shared/dist/group-native-git.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
let child: ChildProcess | undefined;
let connection: { origin: string; cookie: string };
test.beforeAll(async () => {
  child = spawn(
    process.execPath,
    [
      join(root, 'apps/server/node_modules/tsx/dist/cli.mjs'),
      join(root, 'apps/server/src/group-host-browser.fixture.ts'),
      '--controlled-agent',
    ],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe' },
  );
  child.stderr?.resume();
  connection = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Native Git harness startup timeout')), 30000);
    child!.once('exit', () => reject(new Error('Native Git harness exited')));
    child!.stdout!.on('data', (chunk) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        try {
          const value = JSON.parse(line) as typeof connection;
          if (value.origin && value.cookie) {
            clearTimeout(timer);
            resolve(value);
            return;
          }
        } catch {}
      }
    });
  });
});
test.afterAll(async () => {
  if (child && child.exitCode === null) {
    const end = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await end;
  }
  expect(child?.exitCode).toBe(0);
});

test('native Groups management saves a blank GitHub username and retries its exact sync setup', async ({
  page,
}) => {
  const requests: GroupNativeGitRequest[] = [];
  const view: GroupNativeGitView = {
    available: true,
    repository: 'https://github.com/example/research-group',
    workspacePath: '/synthetic/shared/group-workspace',
    branch: 'sciencewithagents/shared',
    githubUsername: '',
    autoSync: false,
    dirty: false,
    busy: false,
    message: 'Shared files are ready. Automatic sync is off.',
    localEdits: [
      {
        taskId: null,
        label: 'Group workspace',
        state: 'changed',
        changed: 2,
        withheld: 1,
        truncated: false,
        files: [{ path: 'chapters/unfinished.tex', status: ' M' }],
      },
    ],
    tasks: [],
    preview: null,
  };
  let loseAcknowledgement = true;
  // The actual GroupsApp and native-mode host mount the panel. Only this Git
  // endpoint is simulated; the fixture never invokes Git, GitHub or a provider.
  await page.route('**/api/groups/native-git', async (route) => {
    const input = groupNativeGitRequestSchema.parse(route.request().postDataJSON());
    requests.push(input);
    if (input.action === 'configure') {
      view.githubUsername = input.githubUsername;
      view.autoSync = input.autoSync;
      view.message = 'Automatic sync is on. Your shared files are up to date.';
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        await route.abort('connectionreset');
        return;
      }
    }
    if (input.action === 'sync') view.message = 'Sync complete. Your shared files are up to date.';
    await route.fulfill({ json: view });
  });
  const [name, ...parts] = connection.cookie.split('=');
  await page
    .context()
    .addCookies([
      { name, value: parts.join('='), url: connection.origin, httpOnly: true, sameSite: 'Strict' },
    ]);
  await page.goto(`${connection.origin}/#/home`);
  await page.goto(`${connection.origin}/#/chats/groups`);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Amina');
  await page.getByLabel('Project name', { exact: true }).fill('Native files River');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Native files River', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Shared files on GitHub', exact: true }),
  ).toBeHidden();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  await page.getByText('Git sync and reviewed changes', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'Shared GitHub workspace', exact: true });
  await expect(panel).toHaveCount(1);
  await expect(
    panel.getByRole('heading', { name: 'Shared files on GitHub', exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole('link', { name: view.repository!, exact: true })).toHaveAttribute(
    'href',
    view.repository!,
  );
  const username = panel.getByLabel('Your GitHub username (optional)', { exact: true });
  await panel.getByText('Unfinished files on this computer', { exact: true }).click();
  await expect(panel.getByText('chapters/unfinished.tex', { exact: true })).toBeVisible();
  await expect(
    panel.getByText('1 private or runtime names withheld.', { exact: true }),
  ).toBeVisible();
  const automaticSync = panel.getByLabel('Automatic sync', { exact: true });
  await expect(username).toHaveValue('');
  await automaticSync.check();
  await panel.getByRole('button', { name: 'Save GitHub setup', exact: true }).click();
  const retry = panel.getByRole('button', { name: 'Retry saved Git change', exact: true });
  await expect(retry).toBeVisible();
  const configured = requests.find((input) => input.action === 'configure')!;
  expect(configured).toMatchObject({ action: 'configure', githubUsername: '', autoSync: true });
  expect(configured.handle).toBe(requests[0]!.handle);
  await expect(
    panel.getByRole('button', { name: 'Save GitHub setup', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Native files River', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  await page.getByText('Git sync and reviewed changes', { exact: true }).click();
  await expect(panel).toHaveCount(1);
  await expect(username).toHaveValue('');
  await expect(automaticSync).toBeChecked();
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(retry).toHaveCount(0);
  expect(requests.filter((input) => input.action === 'configure')).toEqual([
    configured,
    configured,
  ]);
  await expect(panel.getByRole('status')).toHaveText(
    'Automatic sync is on. Your shared files are up to date.',
  );
  await panel.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(
    'Sync complete. Your shared files are up to date.',
  );
  expect(requests.at(-1)).toMatchObject({ action: 'sync', handle: configured.handle });
  await expect(username).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  expect(
    await page
      .locator('.group-host-controls')
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({
    path: join(root, 'data/normal-groups', `${test.info().project.name}-native-git-manage.png`),
  });
});
test('creator can retry a changed hosted snapshot and see a verified private archive in Manage', async ({
  page,
}) => {
  const archiveId = '99999999-9999-4999-8999-999999999999';
  let attempts = 0;
  const keys: string[] = [];
  await page.route('**/api/groups/hosted-export', async (route) => {
    const request = route.request().postDataJSON();
    expect(Object.keys(request)).toEqual(['handle', 'key']);
    keys.push(request.key);
    if (++attempts === 1) {
      await route.fulfill({
        status: 503,
        json: {
          code: 'GROUP_EXPORT_UNAVAILABLE',
          error: 'The group changed during export. Choose a quiet window and start a fresh export.',
        },
      });
      return;
    }
    if (attempts === 2) {
      await route.abort('failed');
      return;
    }
    if (attempts === 4) {
      await route.fulfill({
        status: 503,
        json: {
          code: 'GROUP_EXPORT_HELD',
          error: 'An interrupted private archive needs inspection. Its bytes were preserved.',
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        archiveId,
        groupId: '88888888-8888-4888-8888-888888888888',
        pages: 8,
        rows: 144,
        bytes: 65536,
        sha256: 'a'.repeat(64),
        createdAt: new Date().toISOString(),
      },
    });
  });
  const [name, ...parts] = connection.cookie.split('=');
  await page
    .context()
    .addCookies([
      { name, value: parts.join('='), url: connection.origin, httpOnly: true, sameSite: 'Strict' },
    ]);
  await page.goto(`${connection.origin}/#/home`);
  await page.goto(`${connection.origin}/#/chats/groups`);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Creator');
  await page.getByLabel('Project name', { exact: true }).fill('Private archive River');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Private archive River', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  const summary = page
    .locator('summary')
    .filter({ hasText: 'Creator backup of shared group data' });
  await expect(summary).toHaveCount(1);
  await summary.click();
  const exportButton = page.getByRole('button', {
    name: 'Save private shared-data backup',
    exact: true,
  });
  await exportButton.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'The group changed during export' }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  await expect(summary).toHaveCount(1);
  await summary.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'An export acknowledgement is pending' }),
  ).toBeVisible();
  await exportButton.click();
  await expect.poll(() => attempts).toBe(2);
  await expect(exportButton).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  await expect(summary).toHaveCount(1);
  await summary.click();
  await exportButton.click();
  await expect(
    page.getByRole('status').filter({ hasText: `Verified private archive ${archiveId}` }),
  ).toBeVisible();
  expect(attempts).toBe(3);
  expect(new Set(keys).size).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  await expect(summary).toHaveCount(1);
  await summary.click();
  await expect(
    page.getByRole('status').filter({ hasText: `Verified private archive ${archiveId}` }),
  ).toBeVisible();
  expect(attempts).toBe(3);
  await page.getByRole('button', { name: 'Export another snapshot', exact: true }).click();
  const fresh = page.getByRole('button', {
    name: 'Keep held archive and export a fresh snapshot',
    exact: true,
  });
  await expect(fresh).toBeVisible();
  await fresh.click();
  await expect(
    page.getByRole('button', { name: 'Export another snapshot', exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(5);
  expect(keys[3]).not.toBe(keys[2]);
  expect(keys[4]).not.toBe(keys[3]);
  const dialog = page.getByRole('dialog');
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});
