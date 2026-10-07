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
  const panel = page.getByRole('region', { name: 'Shared GitHub workspace', exact: true });
  await expect(
    panel.getByRole('heading', { name: 'Shared files on GitHub', exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole('link', { name: view.repository!, exact: true })).toHaveAttribute(
    'href',
    view.repository!,
  );
  const username = panel.getByLabel('Your GitHub username (optional)', { exact: true });
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
