import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const evidenceRoot = process.env.DOCK_SETTLEMENT_EVIDENCE_DIR;
type HostConnection = { origin: string; cookie: string; port: number };
let child: ChildProcess | undefined,
  connection: HostConnection & { secondary: HostConnection; unconfigured: HostConnection };
test.beforeAll(async () => {
  const receipts = join(root, evidenceRoot ?? 'data/final-journey');
  await mkdir(receipts, { recursive: true, mode: 0o700 });
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
          receipts,
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
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
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
  await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
  const savedAgent = page.locator('.group-legacy-agent');
  if (!(await savedAgent.evaluate((element) => (element as HTMLDetailsElement).open)))
    await savedAgent.getByText('Saved SWA group agent', { exact: true }).click();
  await expect(page.getByPlaceholder('Message my group agent…')).toBeVisible();
}
async function capture(page: Page, label: string) {
  await page.screenshot({
    path: join(
      root,
      evidenceRoot ?? 'data/normal-groups',
      `${test.info().project.name}-${label}.png`,
    ),
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth + 2),
  );
}
async function fullyVisible(locator: Locator) {
  await expect(locator).toBeInViewport();
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        let top = 0,
          bottom = innerHeight,
          left = 0,
          right = innerWidth;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent);
          const clip = parent.getBoundingClientRect();
          if (['auto', 'scroll', 'hidden', 'clip'].includes(css.overflowY)) {
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
          }
          if (['auto', 'scroll', 'hidden', 'clip'].includes(css.overflowX)) {
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
          }
        }
        return (
          rect.top >= top - 1 &&
          rect.bottom <= bottom + 1 &&
          rect.left >= left - 1 &&
          rect.right <= right + 1
        );
      }),
    )
    .toBe(true);
}
test('My group agent keeps exact agent retries across human-tab switches, shared drafts and owner access', async ({
  page,
}) => {
  // Controlled native changes notify the existing authenticated stream; this
  // fixture must not depend on the former one-second idle polling schedule.
  await page.addInitScript(() => {
    const view = window as typeof window & { nativeChatStreams: EventSource[] };
    view.nativeChatStreams = [];
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (new URL(String(url), location.href).pathname === '/api/events')
          view.nativeChatStreams.push(this);
      }
    };
  });
  await enter(page);
  await create(page, 'Compact River');
  await chat(page);
  await expect(page.getByRole('tab')).toHaveText(['Group chat', 'Your Claude Code']);
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
  await expect(page.getByRole('tab', { name: 'Your Claude Code', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('My agent on this computer', { exact: true })).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Agent request', exact: true })).toHaveValue(
    'ask',
  );
  await capture(page, 'compact-default');
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  for (const text of ['Invite people', 'My agent on this computer', 'Advanced'])
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByText('Summary computer for older activity', { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText('Review proposed shared actions', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Browse earlier shared reports', { exact: true })).toHaveCount(0);
  await page.getByText('My agent on this computer', { exact: true }).click();
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
  await page.getByText('My agent on this computer', { exact: true }).click();
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
  const input = page.getByPlaceholder('Message my group agent…');
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
  const selected = await page.request.post(`${connection.origin}/api/groups/open`, {
    headers: { Origin: connection.origin },
    data: { handle: new URL(page.url()).hash.split('/').at(-1) },
  });
  const current = await selected.json();
  const notify = () =>
    page.evaluate((identity) => {
      const view = window as typeof window & { nativeChatStreams: EventSource[] };
      for (const stream of view.nativeChatStreams)
        stream.dispatchEvent(
          new MessageEvent('group', {
            data: JSON.stringify({
              groupId: identity.groupId,
              memberId: identity.memberId,
              installationId: identity.installationId,
              connected: true,
              changed: true,
            }),
          }),
        );
    }, current.shared.context);
  await notify();
  await expect.poll(() => completedReads).toBeGreaterThanOrEqual(1);
  await notify();
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
  await replyBubble.scrollIntoViewIfNeeded();
  await fullyVisible(replyBubble);
  const legacy = await page.locator('.group-legacy-chat').boundingBox();
  const composer = await input.boundingBox();
  expect(legacy!.width).toBeLessThanOrEqual(840);
  expect(composer!.x).toBeGreaterThanOrEqual(legacy!.x);
  expect(composer!.x + composer!.width).toBeLessThanOrEqual(legacy!.x + legacy!.width);
  expect(composer!.width).toBeGreaterThan(legacy!.width * 0.55);
  expect(composer!.height).toBeGreaterThanOrEqual(44);
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const sendBox = await send.boundingBox();
  expect(sendBox!.height).toBeGreaterThanOrEqual(44);
  expect(sendBox!.width).toBeGreaterThanOrEqual(44);
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
  await expect(input).toHaveCSS(
    'font-size',
    test.info().project.name === 'desktop' ? '33px' : '30px',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  // The retained agent lives in a scrolling disclosure. Its transcript must keep
  // useful space, and both the final reply and composer must remain reachable.
  const timeline = page.locator('.conversation');
  expect(await timeline.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(120);
  expect(
    await timeline.evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBeGreaterThan(0);
  await timeline.hover();
  await page.mouse.wheel(0, -10000);
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBe(0);
  await page.mouse.wheel(0, 10000);
  await expect
    .poll(() =>
      timeline.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(1);
  expect(await timeline.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await replyBubble.scrollIntoViewIfNeeded();
  await fullyVisible(replyBubble);
  await capture(page, 'readable-reply-large-text');
  await page.locator('.group-legacy-agent > summary').focus();
  for (
    let step = 0;
    step < 20 && !(await input.evaluate((el) => el === document.activeElement));
    step++
  )
    await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  await fullyVisible(input);
  await input.fill('Enlarged retained draft');
  await page.keyboard.press('Tab');
  await expect(send).toBeFocused();
  await fullyVisible(send);
  await capture(page, 'readable-composer-large-text');
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
    page.getByRole('button', { name: 'Cancel this request', exact: true }),
  ).toBeVisible();
  const savedRequest = ownerPosts.findLast(
    (body) => body.action === 'status' && body.handle === posts[0]!.body.handle && body.requestId,
  );
  expect(savedRequest?.requestId).toEqual(expect.any(String));
  const requestBeforeCancel = await owner
    .locator('p')
    .filter({ hasText: /^Request:/ })
    .innerText();
  const savedRequestOwner = page.locator('.group-native-owner').filter({
    has: page.getByText(requestBeforeCancel, { exact: true }),
  });
  await page.getByRole('button', { name: 'Cancel this request', exact: true }).click();
  // Fresh reads may offer the other saved request; cancellation targets only
  // the original shown before the click and never consumes that other request.
  await expect(
    savedRequestOwner.getByRole('button', { name: 'Cancel this request', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.group-native-owner')).toContainText('Local agent access enabled');
  expect(ownerPosts.filter((body) => body.action === 'reject')).toEqual([
    expect.objectContaining({
      action: 'reject',
      handle: posts[0]!.body.handle,
      requestId: savedRequest!.requestId,
    }),
  ]);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(input).toHaveValue('Retained manager draft');
  expect(new Set(posts.map((post) => post.body.handle)).size).toBe(1);
  await capture(page, 'group-manager-reading');
});

test('a held native acknowledgement settles after a fast tab switch and preserves the newer Work draft through reload', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Held acknowledgement');
  await manager(page);
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.getByText('My agent on this computer', { exact: true }).click();
  await page.getByRole('button', { name: 'Enable agents on this computer', exact: true }).click();
  await expect(page.locator('.group-native-owner')).toContainText('Local agent access enabled');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const posts: Record<string, unknown>[] = [];
  let held: Record<string, unknown> | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/groups/request-agent', async (route) => {
    posts.push(route.request().postDataJSON());
    const attempt = posts.length;
    const response = await route.fetch();
    if (attempt === 1) {
      await route.fulfill({ status: 503, json: { error: 'Native acknowledgement unavailable.' } });
      return;
    }
    expect(response.ok()).toBe(true);
    if (attempt === 2) {
      held = await response.json();
      await gate;
    }
    await route.fulfill({ response });
  });
  const input = page.getByPlaceholder('Message my group agent…');
  const newer = 'The newer Work draft must survive the old Ask acknowledgement.';
  try {
    await input.fill('Original exact Ask request');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry previous message', exact: true }),
    ).toBeVisible();
    await page.reload();
    await chat(page);
    await page
      .getByPlaceholder('Message the group…')
      .fill('Typing while the original reply is unknown.');
    await page.getByRole('button', { name: 'Retry previous message', exact: true }).click();
    await expect.poll(() => held?.key).toBe(posts[0]!.key);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(posts[0]!.intent).toBe('ask');
    await manager(page);
    await page.getByRole('combobox', { name: 'Agent request', exact: true }).selectOption('work');
    await input.fill(newer);
    await expect(
      page.getByRole('button', { name: 'Retry previous message', exact: true }),
    ).toBeVisible();
    release();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await expect(input).toHaveValue(newer);
    expect(posts).toHaveLength(2);
    const accepted = await page.request.post(`${connection.origin}/api/groups/chat`, {
      headers: { Origin: connection.origin },
      data: { handle: posts[0]!.handle },
    });
    expect(
      (await accepted.json()).nativeRequests.filter(
        (receipt: { key: string }) => receipt.key === posts[0]!.key,
      ),
    ).toEqual([expect.objectContaining({ key: held!.key, requestId: held!.requestId })]);
    await input.scrollIntoViewIfNeeded();
    await capture(page, 'settled-after-fast-switch');
    await page.reload();
    await manager(page);
    await expect(input).toHaveValue(newer);
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    expect(posts).toHaveLength(2); // Settlement and reload do not dispatch another turn.
    await page.getByRole('combobox', { name: 'Agent request', exact: true }).selectOption('work');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(input).toHaveValue('');
    expect(posts).toHaveLength(3);
    expect(posts[2]).toMatchObject({ text: newer, intent: 'work' });
    expect(posts[2]!.key).not.toBe(posts[0]!.key);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('a late old send acknowledgement preserves a newer same-text pending attempt after remount', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Exact attempt ownership');
  await chat(page);
  await page.evaluate(() => {
    const view = window as typeof window & { completedSendCleanups: string[] };
    view.completedSendCleanups = [];
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key: string) {
      remove.call(this, key);
      if (this === sessionStorage && key.includes(':composer-request:'))
        view.completedSendCleanups.push(key);
    };
  });
  const text = 'The same words belong to two distinct explicit attempts.';
  const sends: Record<string, unknown>[] = [];
  const agents: Record<string, unknown>[] = [];
  let held = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/groups/send', async (route) => {
    const input = route.request().postDataJSON();
    sends.push(input);
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (sends.length === 1) {
      held = true;
      await gate;
    }
    await route.fulfill({ response });
  });
  await page.route('**/api/groups/request-agent', async (route) => {
    agents.push(route.request().postDataJSON());
    await route.fulfill({
      status: 503,
      json: { error: 'New attempt acknowledgement unavailable.' },
    });
  });
  const pending = () =>
    page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(
        (key) =>
          key.startsWith('dock:') && key.includes(':workspace:send:') && key.endsWith(':pending'),
      );
      return key
        ? (JSON.parse(sessionStorage.getItem(key)!) as { key: string; text: string })
        : null;
    });
  try {
    await page.getByPlaceholder('Message the group…').fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await manager(page);
    const input = page.getByPlaceholder('Message my group agent…');
    await page.getByRole('button', { name: 'Retry previous message', exact: true }).click();
    await expect(input).toHaveValue('');
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
    // A new explicit attempt may use identical text; its UUID still owns recovery.
    await page.getByRole('combobox', { name: 'Agent request', exact: true }).selectOption('work');
    await input.fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry previous message', exact: true }),
    ).toBeVisible();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ text, intent: 'work' });
    expect(agents[0]!.key).not.toBe(sends[0]!.key);
    await expect.poll(pending).toMatchObject({ key: agents[0]!.key, text });
    release();
    // Both old callbacks have returned through GroupChat.send before checking the
    // canonical Composer receipt. This avoids a timing delay masking a late clear.
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const view = window as typeof window & { completedSendCleanups: string[] };
          return view.completedSendCleanups.filter((item) =>
            item.endsWith(`:composer-request:${key}`),
          ).length;
        }, String(sends[0]!.key)),
      )
      .toBe(2);
    await expect.poll(pending).toMatchObject({ key: agents[0]!.key, text });
    await expect(input).toHaveValue(text);
    await expect(
      page.getByRole('button', { name: 'Retry previous message', exact: true }),
    ).toBeVisible();
    await page.reload();
    await manager(page);
    await expect(input).toHaveValue(text);
    await expect.poll(pending).toMatchObject({ key: agents[0]!.key, text });
    expect(sends).toHaveLength(2);
    expect(agents).toHaveLength(1); // Neither settlement nor reload dispatches K2.
    await input.scrollIntoViewIfNeeded();
    await capture(page, 'newer-attempt-after-late-ack');
    await chat(page);
    await expect(
      page.locator('.group-shared-chat .message.user .markdown').filter({ hasText: text }),
    ).toHaveCount(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
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
  await page.getByPlaceholder('Message my group agent…').fill('Saved before local access');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.group-host-controls')).toHaveJSProperty('open', true);
  await expect(page.getByRole('button', { name: 'Enable agents on this computer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue this request' })).toHaveCount(0);
  const pending = posts.findLast(
    ({ body }) => body.action === 'status' && typeof body.requestId === 'string',
  )!;
  expect(pending.body.requestId).toEqual(expect.any(String));
  await page.getByRole('button', { name: 'Enable agents on this computer' }).click();
  await page.getByRole('button', { name: 'Continue this request' }).click();
  await expect(page.getByRole('button', { name: 'Continue this request' })).toHaveCount(0);
  expect(posts.findLast(({ body }) => body.action === 'continue')!.body).toMatchObject({
    handle: pending.body.handle,
    requestId: pending.body.requestId,
  });
  const submissions = posts.filter(({ path }) => path.endsWith('/request-agent'));
  expect(submissions).toHaveLength(1);
  expect(submissions[0]!.body).toMatchObject({ text: 'Saved before local access', intent: 'ask' });
  await capture(page, 'local-pending-request');
});
