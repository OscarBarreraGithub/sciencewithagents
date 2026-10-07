import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
type HostConnection = { origin: string; cookie: string; port: number };
let child: ChildProcess | undefined,
  connection: HostConnection & { secondary: HostConnection; unconfigured: HostConnection };
test.beforeAll(async () => {
  child = spawn(
    process.execPath,
    [
      join(root, 'apps/server/node_modules/tsx/dist/cli.mjs'),
      join(root, 'apps/server/src/group-host-browser.fixture.ts'),
      '--controlled-agent',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: 'false',
        GROUP_HOST_ACCEPTANCE_RECEIPT: join(
          root,
          'data/final-journey',
          `compact-native-${test.info().project.name}.json`,
        ),
      },
      stdio: 'pipe',
    },
  );
  child.stderr?.resume();
  connection = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Normal host harness startup timeout')), 30000);
    child!.once('exit', () => reject(new Error('Normal host harness exited')));
    child!.stdout!.on('data', (chunk) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        try {
          const data = JSON.parse(line) as typeof connection;
          if (data.origin && data.cookie) {
            clearTimeout(timer);
            resolve(data);
            return;
          }
        } catch {}
      }
    });
  });
});
test.afterAll(async () => {
  if (child && child.exitCode === null) {
    const end = new Promise<void>((r) => child!.once('exit', () => r()));
    child.kill('SIGTERM');
    await end;
  }
});
async function authenticate(page: Page, host: HostConnection = connection) {
  const [name, ...parts] = host.cookie.split('=');
  await page
    .context()
    .addCookies([
      { name, value: parts.join('='), url: host.origin, httpOnly: true, sameSite: 'Strict' },
    ]);
}
async function enter(page: Page) {
  await authenticate(page);
  await page.goto(`${connection.origin}/#/home`);
  await page.getByRole('link', { name: /Groups Shared work/ }).click();
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
}
async function create(page: Page, name: string) {
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Amina');
  await page.getByLabel('Project name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function chat(page: Page) {
  await expect(page.locator('.groups-workspace')).toBeVisible();
  const tab = page.getByRole('tab', { name: 'Your chat', exact: true });
  if (await tab.count()) await tab.click();
}
async function feed(page: Page) {
  await expect(page.locator('.groups-workspace')).toBeVisible();
  const tab = page.getByRole('tab', { name: 'Shared feed', exact: true });
  if (await tab.count()) await tab.click();
}
async function capture(page: Page, label: string) {
  await page.screenshot({
    path: join(root, 'data/normal-groups', `${test.info().project.name}-${label}.png`),
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    test.info().project.use.viewport!.width + 2,
  );
}
test('compact agent chat sends native by default, retries exact UUID, retains human notes and reachable controls', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Compact River');
  await chat(page);
  const controls = page.locator('.group-host-controls');
  await expect(controls).toHaveJSProperty('open', false);
  await expect(page.getByText('Invitations and approval', { exact: true })).toBeHidden();
  await expect(page.getByText('Native agent setup', { exact: true })).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Send to', exact: true })).toHaveValue('agent');
  await expect(page.getByRole('combobox', { name: 'Agent request', exact: true })).toHaveValue(
    'ask',
  );
  await capture(page, 'compact-default');
  await page.getByText('Group controls', { exact: true }).click();
  for (const text of [
    'Invitations and approval',
    'Shared work and actions',
    'Shared Git workspace',
    'Shared feed agent',
    'Native agent setup',
  ])
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  await page.getByText('Shared Git workspace', { exact: true }).click();
  await capture(page, 'compact-git-open');
  await page.getByText('Shared Git workspace', { exact: true }).click();
  await page.getByText('Group controls', { exact: true }).click();
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/groups\/(?:send|request-agent)$/.test(new URL(request.url()).pathname)
    )
      posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  const input = page.getByPlaceholder('Message your group agent…');
  await input.fill('Exact failed native question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Retry previous message', exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue('Exact failed native question');
  await page.reload();
  await chat(page);
  await expect(input).toHaveValue('Exact failed native question');
  await input.fill('Newer draft typed before retry');
  await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
  await page.getByRole('button', { name: 'Retry previous message', exact: true }).click();
  await expect(page.getByPlaceholder('Send a group message…')).toHaveValue(
    'Newer draft typed before retry',
  );
  expect(posts).toHaveLength(2);
  expect(posts[0]!.path).toBe('/api/groups/request-agent');
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[0]!.body.intent).toBe('ask');
  await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('agent');
  await page.getByRole('combobox', { name: 'Agent request', exact: true }).selectOption('work');
  await input.fill('Exact shared work instruction');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue('');
  expect(posts.at(-1)!.body.intent).toBe('work');
  await page.getByRole('button', { name: 'Private aside', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Agent request', exact: true })).toHaveCount(0);
  await page.getByPlaceholder('Ask privately…').fill('Private native question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByPlaceholder('Ask privately…')).toHaveValue('');
  expect(posts.at(-1)!.body.intent).toBe('ask');
  expect(posts.at(-1)!.body.handle).not.toBe(posts[0]!.body.handle);
  await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
  await page.getByPlaceholder('Write a private note…').fill('Explicit human private note');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.conversation')).toContainText('Explicit human private note');
  expect(posts.at(-1)!.path).toBe('/api/groups/send');
  await capture(page, 'compact-private-reading');
});
