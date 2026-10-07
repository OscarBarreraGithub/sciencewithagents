import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
type HostConnection = { origin: string; cookie: string; port: number };
let child: ChildProcess | undefined,
  connection: HostConnection & { secondary: HostConnection; unconfigured: HostConnection };
test.beforeAll(async () => {
  await mkdir(join(root, 'data/final-journey'), { recursive: true, mode: 0o700 });
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
  expect(child?.exitCode).toBe(0);
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
  const tab = page.getByRole('tab', { name: 'Shared chat', exact: true });
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
test('local agents keep shared and private chats distinct, retain exact retries and expose owner access', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Compact River');
  await chat(page);
  const controls = page.locator('.group-host-controls');
  await expect(controls).toHaveJSProperty('open', false);
  await expect(page.getByText('Invitations and approval', { exact: true })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Shared chat', exact: true })).toBeVisible();
  await expect(page.getByText('Local agent access', { exact: true })).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Send to', exact: true })).toHaveValue('agent');
  await expect(page.getByRole('combobox', { name: 'Agent request', exact: true })).toHaveValue(
    'ask',
  );
  await capture(page, 'compact-default');
  await page.getByText('Group controls', { exact: true }).click();
  for (const text of ['Invitations and approval', 'Shared feed agent', 'Local agent access'])
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByText('Shared Git workspace', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Shared work and actions', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Shared reports', { exact: true })).toHaveCount(0);
  await expect(controls).toContainText('Saved records are retained');
  await page.getByText('Local agent access', { exact: true }).click();
  const owner = page.locator('.group-native-owner');
  await expect(owner).toContainText(
    'existing provider sign-in, tools, skills, hooks and permissions',
  );
  await expect(owner).toContainText('Local execution does not isolate files or account access');
  await expect(owner).toContainText(
    'Private history, drafts and files are not automatically published',
  );
  await expect(page.getByRole('button', { name: 'Prepare isolated context' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Sign in to/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Enable agents on this computer', exact: true }).click();
  await expect(owner).toContainText('Local agent access enabled');
  await expect(page.getByRole('button', { name: 'Enable agents on this computer' })).toHaveCount(0);
  await capture(page, 'local-agent-access');
  await page.getByText('Local agent access', { exact: true }).click();
  await page.getByText('Group controls', { exact: true }).click();
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const ownerPosts: Array<Record<string, unknown>> = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/groups\/(?:send|request-agent)$/.test(new URL(request.url()).pathname)
    )
      posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/groups/native-owner'
    )
      ownerPosts.push(request.postDataJSON());
  });
  const input = page.getByPlaceholder('Message your group agent…');
  await input.scrollIntoViewIfNeeded();
  await expect(input).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
  await capture(page, 'local-composer-reachable');
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
  await input.fill('Shared draft stays here');
  const sentBeforeSwitch = posts.length;
  await page.getByRole('button', { name: 'Private to you', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Private to you', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Agent request', exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder('Ask privately…')).toHaveValue('');
  await page.getByPlaceholder('Ask privately…').fill('Private draft stays private');
  await page.getByRole('button', { name: 'Back to shared chat', exact: true }).click();
  await expect(input).toHaveValue('Shared draft stays here');
  await expect(page.locator('.conversation')).not.toContainText('Private draft stays private');
  await page.reload();
  await chat(page);
  await expect(input).toHaveValue('Shared draft stays here');
  await page.getByRole('button', { name: 'Private to you', exact: true }).click();
  await expect(page.getByPlaceholder('Ask privately…')).toHaveValue('Private draft stays private');
  expect(posts).toHaveLength(sentBeforeSwitch);
  await page.getByPlaceholder('Ask privately…').fill('Private native question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByPlaceholder('Ask privately…')).toHaveValue('');
  expect(posts.at(-1)!.body.intent).toBe('ask');
  expect(posts.at(-1)!.body.handle).not.toBe(posts[0]!.body.handle);
  const privateHandle = posts.at(-1)!.body.handle;
  await page.getByText('Group controls', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Cancel saved request', exact: true }),
  ).toBeVisible();
  const savedPrivateRequest = ownerPosts.findLast(
    (body) => body.action === 'status' && body.handle === privateHandle && body.requestId,
  );
  expect(savedPrivateRequest?.requestId).toEqual(expect.any(String));
  await page.getByRole('button', { name: 'Cancel saved request', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel saved request', exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('.group-native-owner')).toContainText('Local agent access enabled');
  expect(ownerPosts.at(-1)).toMatchObject({
    action: 'reject',
    handle: privateHandle,
    requestId: savedPrivateRequest!.requestId,
  });
  await page.getByText('Group controls', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
  await page.getByPlaceholder('Write a private note…').fill('Explicit human private note');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.conversation')).toContainText('Explicit human private note');
  expect(posts.at(-1)!.path).toBe('/api/groups/send');
  await capture(page, 'compact-private-reading');
  await page.getByRole('button', { name: 'Back to shared chat', exact: true }).click();
  await expect(input).toHaveValue('Shared draft stays here');
  await expect(page.locator('.conversation')).not.toContainText('Private native question');
  await expect(page.locator('.conversation')).not.toContainText('Explicit human private note');
});

test('first local request waits for owner enable and continues the same saved request', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Enable Brook');
  await chat(page);
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/groups\/(request-agent|native-owner)$/.test(path))
      posts.push({ path, body: request.postDataJSON() });
  });
  await page.getByPlaceholder('Message your group agent…').fill('Saved before local access');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.group-host-controls')).toHaveJSProperty('open', true);
  await expect(page.getByRole('button', { name: 'Enable agents on this computer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue saved request' })).toHaveCount(0);
  const pending = posts.findLast(
    ({ body }) => body.action === 'status' && typeof body.requestId === 'string',
  )!;
  expect(pending.body.requestId).toEqual(expect.any(String));
  await page.getByRole('button', { name: 'Enable agents on this computer' }).click();
  await page.getByRole('button', { name: 'Continue saved request' }).click();
  await expect(page.getByRole('button', { name: 'Continue saved request' })).toHaveCount(0);
  expect(posts.findLast(({ body }) => body.action === 'continue')!.body).toMatchObject({
    handle: pending.body.handle,
    requestId: pending.body.requestId,
  });
  const submissions = posts.filter(({ path }) => path.endsWith('/request-agent'));
  expect(submissions).toHaveLength(1);
  expect(submissions[0]!.body).toMatchObject({ text: 'Saved before local access', intent: 'ask' });
  await capture(page, 'local-pending-request');
});
