import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  await page.locator('a[href="#/chats"]').first().click();
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible();
}
async function create(page: Page, name: string) {
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New group', exact: true });
  await dialog.getByLabel('Your display name', { exact: true }).fill('Amina');
  await dialog.getByLabel('Project name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function chat(page: Page) {
  await expect(page.locator('.groups-workspace')).toBeVisible();
  await page.getByRole('tab', { name: 'Group chat', exact: true }).click();
}
async function manager(page: Page) {
  await expect(page.locator('.groups-workspace')).toBeVisible();
  await page.getByRole('tab', { name: 'Group manager', exact: true }).click();
}
async function capture(page: Page, label: string) {
  await page.screenshot({
    path: join(root, 'data/normal-groups', `${test.info().project.name}-${label}.png`),
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth + 2),
  );
}
test('Group manager keeps exact agent retries across human-tab switches, shared drafts and owner access', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Compact River');
  await chat(page);
  await expect(page.getByRole('tab')).toHaveText(['Group chat', 'Group manager']);
  await expect(page.getByRole('tab', { name: 'Group chat', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('combobox', { name: 'Send to', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Agent request', exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder('Message the group…')).toBeEnabled();
  await manager(page);
  const controls = page.locator('.group-host-controls');
  await expect(controls).toHaveJSProperty('open', false);
  await expect(page.locator('.group-host-controls')).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Group manager', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('Local agent access', { exact: true })).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Agent request', exact: true })).toHaveValue(
    'ask',
  );
  await capture(page, 'compact-default');
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  for (const text of ['Invite people', 'Shared feed agent', 'Local agent access'])
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByText('Shared Git workspace', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Shared work and actions', { exact: true })).toBeVisible();
  await expect(page.getByText('Shared reports', { exact: true })).toBeVisible();
  await page.getByText('Local agent access', { exact: true }).click();
  const owner = page.locator('.group-native-owner');
  await expect(owner).toContainText('existing sign-in and native tools');
  await expect(owner).toContainText('agents retain normal access to this computer');
  await expect(owner).toContainText('Private content is not automatically shared');
  await expect(page.getByRole('button', { name: 'Prepare isolated context' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Sign in to/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Enable agents on this computer', exact: true }).click();
  await expect(owner).toContainText('Local agent access enabled');
  await expect(page.getByRole('button', { name: 'Enable agents on this computer' })).toHaveCount(0);
  await capture(page, 'local-agent-access');
  await page.getByText('Local agent access', { exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
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
  const input = page.getByPlaceholder('Message your group manager…');
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
  const humanInput = page.getByPlaceholder('Message the group…');
  await expect(humanInput).toHaveValue('Exact failed native question');
  await humanInput.fill('Newer draft typed before retry');
  await page.getByRole('button', { name: 'Retry previous message', exact: true }).click();
  await expect(page.getByPlaceholder('Message the group…')).toHaveValue(
    'Newer draft typed before retry',
  );
  expect(posts).toHaveLength(2);
  expect(posts[0]!.path).toBe('/api/groups/request-agent');
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[0]!.body.intent).toBe('ask');
  await manager(page);
  await page.getByRole('combobox', { name: 'Agent request', exact: true }).selectOption('work');
  await input.fill('Exact shared work instruction');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue('');
  expect(posts.at(-1)!.body.intent).toBe('work');
  const reply =
    'Your group reply stays visible while sharing is pending. You can keep talking here.';
  const replyId = randomUUID();
  let completedReads = 0;
  await page.route('**/api/groups/chat', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    const receipt = value.nativeRequests?.at(-1);
    if (receipt?.text === 'Exact shared work instruction') {
      receipt.state = 'completed';
      receipt.delivery = 'pending';
      receipt.message = 'Native reply retained. Shared feed delivery is pending.';
      if (++completedReads >= 2)
        value.detail.entries.push({
          id: replyId,
          agentId: value.detail.agent.id,
          runId: receipt.requestId,
          kind: 'assistant',
          title: 'Codex response',
          text: reply,
          status: 'complete',
          createdAt: new Date().toISOString(),
        });
    }
    await route.fulfill({ response, json: value });
  });
  const replyBubble = page
    .locator('.conversation .message.assistant .markdown')
    .filter({ hasText: reply });
  await expect(replyBubble).toBeVisible();
  await expect(
    page.getByText('Native reply retained. Shared feed delivery is pending.', { exact: true }),
  ).toBeHidden();
  await expect(
    page.getByText('Shared with this group · your agent runs on this computer', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/Saved agent requests/)).toHaveCount(0);
  const viewport = page.viewportSize()!;
  if (test.info().project.name === 'desktop')
    await page.setViewportSize({ width: 2048, height: 1229 });
  const readingSize = test.info().project.name === 'desktop' ? '22px' : '20px';
  await expect(replyBubble).toHaveCSS('font-size', readingSize);
  await expect(input).toHaveCSS('font-size', readingSize);
  await expect(replyBubble).toBeInViewport();
  if (test.info().project.name === 'desktop') {
    const composer = await input.boundingBox();
    expect(composer!.width).toBeLessThanOrEqual(1050);
    expect(composer!.width).toBeGreaterThan(900);
  }
  await expect(page.locator('.conversation-scroll-hint[aria-hidden="true"]')).toBeHidden();
  await capture(page, 'readable-completed-reply');
  await page.getByText('Message details', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Retry request', exact: true }).last(),
  ).toBeVisible();
  await page.getByText('Message details', { exact: true }).click();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '150%';
  });
  await expect(input).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  expect(
    await page.locator('.conversation').evaluate((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (
          ['auto', 'scroll'].includes(getComputedStyle(parent).overflowY) &&
          parent.scrollHeight > parent.clientHeight + 1
        )
          return false;
      }
      return true;
    }),
  ).toBe(true);
  await capture(page, 'readable-reply-large-text');
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await page.setViewportSize(viewport);
  await page.unroute('**/api/groups/chat');
  await input.fill('Shared draft stays here');
  const sentBeforeSwitch = posts.length;
  await chat(page);
  await expect(humanInput).toHaveValue('Shared draft stays here');
  await expect(page.getByRole('combobox', { name: 'Agent request', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Private to you', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'What mattered since last visit?', exact: true }),
  ).toHaveCount(0);
  await manager(page);
  await expect(input).toHaveValue('Shared draft stays here');
  await page.reload();
  await chat(page);
  await expect(humanInput).toHaveValue('Shared draft stays here');
  expect(posts).toHaveLength(sentBeforeSwitch);
  await humanInput.fill('Explicit human group message');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(humanInput).toHaveValue('');
  expect(posts.at(-1)).toMatchObject({
    path: '/api/groups/send',
    body: {
      handle: posts[0]!.body.handle,
      text: 'Explicit human group message',
    },
  });
  await expect(page.locator('.conversation')).toContainText('Explicit human group message');
  await manager(page);
  await input.fill('Retained manager draft');
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Cancel saved request', exact: true }),
  ).toBeVisible();
  const savedRequest = ownerPosts.findLast(
    (body) => body.action === 'status' && body.handle === posts[0]!.body.handle && body.requestId,
  );
  expect(savedRequest?.requestId).toEqual(expect.any(String));
  await page.getByRole('button', { name: 'Cancel saved request', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel saved request', exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('.group-native-owner')).toContainText('Local agent access enabled');
  expect(ownerPosts.at(-1)).toMatchObject({
    action: 'reject',
    handle: posts[0]!.body.handle,
    requestId: savedRequest!.requestId,
  });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(input).toHaveValue('Retained manager draft');
  expect(new Set(posts.map((post) => post.body.handle)).size).toBe(1);
  await capture(page, 'group-manager-reading');
});

test('first local request waits for owner enable and continues the same saved request', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Enable Brook');
  await manager(page);
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/groups\/(request-agent|native-owner)$/.test(path))
      posts.push({ path, body: request.postDataJSON() });
  });
  await page.getByPlaceholder('Message your group manager…').fill('Saved before local access');
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
