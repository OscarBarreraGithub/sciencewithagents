import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { entrySchema } from '@dock/shared';
const repo = resolve('../..');
let root: string, base: string, token: string, child: ChildProcess | undefined;
let stderr = '';
async function stop() {
  const current = child;
  if (!current || current.exitCode !== null || current.signalCode !== null) return;
  const exited = once(current, 'exit');
  current.kill('SIGTERM');
  const timeout = setTimeout(() => current.kill('SIGKILL'), 8000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
    child = undefined;
  }
}
async function start(port: number) {
  let output = '';
  stderr = '';
  child = spawn(process.execPath, [join(repo, 'apps/server/dist/main.js'), '--demo', '--fixture'], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      CODEX_HOME: join(root, 'fake-codex'),
      CLAUDE_CONFIG_DIR: join(root, 'fake-claude'),
      DOCK_FIXTURE_ROOT: root,
      DOCK_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (v: Buffer) => {
    output += v.toString();
  });
  child.stderr!.on('data', (v: Buffer) => {
    stderr += v.toString();
  });
  await expect
    .poll(
      () => {
        if (child?.exitCode !== null) throw new Error(stderr || output || 'fixture exited');
        return output.includes('Groups test host:');
      },
      { timeout: 15000 },
    )
    .toBe(true);
  token = /#fixture=([a-f0-9]{64})/.exec(output)![1];
  base = `http://127.0.0.1:${port}`;
}
async function api(path: string, body?: unknown) {
  const response = await fetch(`${base}/api/group-fixture/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { origin: base, 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
}
test.beforeAll(async () => {
  mkdirSync(join(repo, 'data/fixtures'), { recursive: true });
  root = mkdtempSync(join(repo, 'data/fixtures/group-browser-'));
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((r) => server.close(() => r()));
  await start(port);
});
test.afterAll(async () => {
  await stop();
  if (root) rmSync(root, { recursive: true, force: true });
});
async function enter(page: Page) {
  await page.goto(`${base}/#fixture=${token}`);
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
}
async function create(page: Page, name: string) {
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByLabel('Your display name')).toHaveValue('');
  await page.getByLabel('Project name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Continue setup' }).click();
  await expect(page.getByRole('alert')).toContainText('name');
  await page.getByLabel('Your display name').fill('Typed Amina · أمينة');
  await page.getByRole('button', { name: 'Continue setup' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function chatTab(page: Page) {
  const tab = page.getByRole('tab', { name: 'Shared chat', exact: true });
  if ((page.viewportSize()?.width ?? 1440) < 981) await tab.click();
}
async function feedTab(page: Page) {
  const tab = page.getByRole('tab', { name: 'Shared feed', exact: true });
  if ((page.viewportSize()?.width ?? 1440) < 981) await tab.click();
}
async function screenshot(page: Page, name: string) {
  const dir = join(repo, 'data/group-fixture-evidence/browser', test.info().project.name);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  const metrics = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    font: getComputedStyle(document.documentElement).fontSize,
    scrollWidth: document.documentElement.scrollWidth,
    scrollTop: document.scrollingElement?.scrollTop,
    viewportOffset: visualViewport?.offsetTop,
    transcript: document.querySelector('.conversation')?.getBoundingClientRect().toJSON(),
  }));
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(metrics, null, 2));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1);
  expect(metrics.scrollTop).toBe(0);
  expect(metrics.viewportOffset).toBe(0);
}

test('persisted UI send/original/private draft and canaries survive reload and real host restart', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'River persisted');
  await chatTab(page);
  const input = page.getByPlaceholder('Message shared test session…');
  await expect(input).toBeEnabled();
  await input.fill('Shared exact original · أمينة\nsecond line');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.conversation')).toContainText('no model was called', {
    timeout: 15000,
  });
  await screenshot(page, 'shared-chat');
  await feedTab(page);
  await expect(page.locator('.groups-feed-panel')).toContainText('Test excerpt');
  await page
    .getByRole('button', { name: /original/i })
    .first()
    .click();
  await expect(
    page.getByLabel('Exact original').filter({ hasText: 'Shared exact original' }),
  ).toContainText('second line');
  await screenshot(page, 'shared-original');
  await chatTab(page);
  await page.getByRole('button', { name: 'Private to you', exact: true }).click();
  const privateInput = page.getByPlaceholder('Message private test session…');
  await privateInput.fill('PRIVATE-ASIDE-CANARY');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.conversation')).toContainText('PRIVATE-ASIDE-CANARY');
  await privateInput.fill('PRIVATE-DRAFT-RETAINED');
  await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').press('Escape');
  await expect(page.getByRole('heading', { name: 'Private to you', exact: true })).toBeVisible();
  await expect(privateInput).toHaveValue('PRIVATE-DRAFT-RETAINED');
  await page.getByRole('button', { name: 'What mattered since last visit?' }).click();
  await expect(page.getByRole('region', { name: 'Private catch-up' })).toContainText(
    'Deterministic test catch-up',
  );
  await expect(page.getByRole('region', { name: 'Private catch-up' })).not.toContainText(
    'PRIVATE-ASIDE-CANARY',
  );
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await expect(privateInput).toHaveValue('PRIVATE-DRAFT-RETAINED');
  await screenshot(page, 'private-draft');
  await page.getByRole('button', { name: 'Back to shared chat' }).click();
  await expect(input).toHaveValue('');
  await input.fill('SHARED-DRAFT-RETAINED');
  await page.reload();
  await page.getByRole('button', { name: /River persisted/ }).click();
  await chatTab(page);
  await expect(input).toHaveValue('SHARED-DRAFT-RETAINED');
  const port = Number(new URL(base).port);
  await stop();
  await start(port);
  await page.reload();
  await page.getByRole('button', { name: /River persisted/ }).click();
  await chatTab(page);
  await expect(page.locator('.conversation')).toContainText('Shared exact original');
  await expect(input).toHaveValue('SHARED-DRAFT-RETAINED');
  await page.getByRole('button', { name: 'Private to you', exact: true }).click();
  await expect(privateInput).toHaveValue('PRIVATE-DRAFT-RETAINED');
  await expect(page.locator('.conversation')).toContainText('PRIVATE-ASIDE-CANARY');
  await feedTab(page);
  await expect(page.locator('.groups-feed-panel')).not.toContainText('PRIVATE-ASIDE-CANARY');
});

test('lost send acknowledgement retries after reload/restart with one persisted run/event', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Lost ack');
  await chatTab(page);
  const input = page.getByPlaceholder('Message shared test session…');
  await expect(input).toBeEnabled();
  let key = '';
  await page.route('**/api/group-fixture/send', async (route) => {
    key = route.request().postDataJSON().key as string;
    await route.fetch();
    await route.abort('failed');
  });
  await input.fill('LOST-ACK-ORIGINAL');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await page.unroute('**/api/group-fixture/send');
  const port = Number(new URL(base).port);
  await stop();
  await start(port);
  await page.reload();
  await page.getByRole('button', { name: /Lost ack/ }).click();
  await chatTab(page);
  await expect(input).toHaveValue('LOST-ACK-ORIGINAL');
  await page
    .getByRole('button', { name: /Retry previous message|Send message/ })
    .first()
    .click();
  await expect(input).toHaveValue('');
  const list = (await api('groups')) as { groups: { handle: string; name: string }[] };
  const selected = list.groups.find((g) => g.name === 'Lost ack')!;
  const opened = (await api('open', { handle: selected.handle })) as { shared: { handle: string } };
  const receipt = (await api('send', {
    handle: opened.shared.handle,
    key,
    text: 'LOST-ACK-ORIGINAL',
  })) as { runId: string };
  expect(receipt.runId).toBeTruthy();
  const result = (await api('feed', {
    handle: opened.shared.handle,
    query: { visibility: 'shared', after: 0, limit: 20, cursor: null },
  })) as { entries: { condensedText: string }[] };
  expect(result.entries.filter((e) => e.condensedText.includes('LOST-ACK-ORIGINAL'))).toHaveLength(
    1,
  );
});

test('150% text keeps transcript/last message and composer reachable with natural wheel; catch-up retains position', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Readable group');
  const list = (await api('groups')) as { groups: { handle: string; name: string }[] };
  const selected = list.groups.find((g) => g.name === 'Readable group')!;
  const opened = (await api('open', { handle: selected.handle })) as {
    shared: { handle: string };
    private: { handle: string };
  };
  // Actual host sends populate retained normal chat, never synthetic DOM messages.
  for (const handle of [opened.shared.handle, opened.private.handle])
    for (let i = 0; i < 8; i++)
      await api('send', {
        handle,
        key: crypto.randomUUID(),
        text: `Readable persisted message ${i}. ${'Evidence and shared work. '.repeat(10)}`,
      });
  await chatTab(page);
  await page.locator('.group-fixture-status summary').click();
  await page.getByLabel('150% text').check();
  await page.locator('.group-fixture-status summary').click();
  for (const visibility of ['shared', 'private'] as const) {
    if (visibility === 'private')
      await page.getByRole('button', { name: 'Private to you', exact: true }).click();
    const input = page.getByPlaceholder(`Message ${visibility} test session…`);
    await expect(input).toBeEnabled();
    const handle = visibility === 'shared' ? opened.shared.handle : opened.private.handle;
    await expect
      .poll(
        async () =>
          ((await api('chat', { handle })) as { detail: { agent: { status: string } } }).detail
            .agent.status,
        { timeout: 20000 },
      )
      .toBe('idle');
    const conversation = page.locator('.conversation');
    await expect(conversation).toContainText('Readable persisted message 7', { timeout: 20000 });
    const height = await conversation.evaluate((e) => e.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(120);
    const readingPanel = page.locator('.groups-chat-panel');
    const readingBox = await readingPanel.boundingBox();
    await page.mouse.move(readingBox!.x + 8, readingBox!.y + 8);
    await page.mouse.wheel(0, -2000);
    await expect.poll(() => readingPanel.evaluate((e) => e.scrollTop)).toBe(0);
    const panelBottom = await readingPanel.evaluate((e) => e.getBoundingClientRect().bottom);
    const transcriptBottom = await conversation.evaluate((e) => e.getBoundingClientRect().bottom);
    if (transcriptBottom > panelBottom)
      await page.mouse.wheel(0, transcriptBottom - panelBottom + 8);
    await expect
      .poll(() => conversation.evaluate((e) => e.getBoundingClientRect().bottom))
      .toBeLessThanOrEqual(panelBottom);
    await conversation.hover();
    await page.mouse.wheel(0, 10000);
    await page.waitForTimeout(600);
    // Prove the final message's last words are visible through both clipping ancestors.
    const last = conversation.locator('.message').last().locator('p').last();
    await expect
      .poll(() =>
        last.evaluate((element) => {
          const node = element.lastChild!;
          const range = document.createRange();
          range.setStart(node, Math.max(0, (node.textContent?.length ?? 0) - 15));
          range.setEnd(node, node.textContent?.length ?? 0);
          const rect = range.getBoundingClientRect();
          const timeline = element.closest('.conversation')!.getBoundingClientRect();
          const panel = element.closest('.groups-chat-panel')!.getBoundingClientRect();
          return (
            rect.top >= Math.max(0, timeline.top, panel.top) &&
            rect.bottom <= Math.min(innerHeight, timeline.bottom, panel.bottom)
          );
        }),
      )
      .toBe(true);
    await screenshot(page, `${visibility}-large-reading`);
    await page.getByRole('button', { name: 'What mattered since last visit?' }).click();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: 'What mattered since last visit?' }),
    ).toBeFocused();
    for (
      let step = 0;
      step < 20 && !(await input.evaluate((e) => e === document.activeElement));
      step++
    )
      await page.keyboard.press('Tab');
    await expect(input).toBeFocused();
    await expect(input).toBeInViewport();
    await input.fill(`${visibility}-selection-draft`);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeFocused();
    const panel = page.locator('.groups-chat-panel');
    const box = await panel.boundingBox();
    await page.mouse.move(
      box!.x + 8,
      Math.min(box!.y + box!.height - 8, page.viewportSize()!.height - 8),
    );
    await page.mouse.wheel(0, 2000);
    await expect
      .poll(() =>
        input.evaluate((e) => {
          const rect = e.getBoundingClientRect();
          const panel = e.closest('.groups-chat-panel')!.getBoundingClientRect();
          return (
            rect.top >= Math.max(0, panel.top) && rect.bottom <= Math.min(innerHeight, panel.bottom)
          );
        }),
      )
      .toBe(true);
    await input.focus();
    await page.evaluate(() => {
      const e = document.querySelector('.composer textarea') as HTMLTextAreaElement;
      e.setSelectionRange(3, 8);
    });
    await screenshot(page, `${visibility}-large-composer`);
    const readingTop = await conversation.evaluate((e) => e.scrollTop);
    await page.getByRole('button', { name: 'What mattered since last visit?' }).click();
    await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
    await expect(input).toHaveValue(`${visibility}-selection-draft`);
    expect(
      Math.abs((await conversation.evaluate((e) => e.scrollTop)) - readingTop),
    ).toBeLessThanOrEqual(2);
    const selection = await input.evaluate((e: HTMLTextAreaElement) => [
      e.selectionStart,
      e.selectionEnd,
    ]);
    expect(selection).toEqual([3, 8]);
  }
});

test('feed/original failures retry against the real host and saved groups exclude other-group canaries', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Foreign canary group');
  await chatTab(page);
  let input = page.getByPlaceholder('Message shared test session…');
  await expect(input).toBeEnabled();
  await input.fill('OTHER-GROUP-ORIGINAL-CANARY');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Back to groups' }).click();
  await page.route('**/api/group-fixture/feed', async (route) => {
    await route.abort('failed');
  });
  await create(page, 'Retry feed group');
  await feedTab(page);
  await expect(page.getByRole('button', { name: 'Retry feed' })).toBeVisible();
  await page.unroute('**/api/group-fixture/feed');
  await page.getByRole('button', { name: 'Retry feed' }).click();
  await expect(page.locator('.groups-feed-panel')).toContainText('No shared events');
  await chatTab(page);
  input = page.getByPlaceholder('Message shared test session…');
  await expect(input).toBeEnabled();
  await input.fill('OWN-GROUP-ORIGINAL');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.conversation')).toContainText('no model was called');
  await feedTab(page);
  await expect(page.locator('.groups-feed-panel')).toContainText('OWN-GROUP-ORIGINAL');
  await expect(page.locator('.groups-feed-panel')).not.toContainText('OTHER-GROUP-ORIGINAL-CANARY');
  await page.route('**/api/group-fixture/original', async (route) => {
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Read exact original' }).first().click();
  await expect(page.getByRole('button', { name: 'Retry original' })).toBeVisible();
  await page.unroute('**/api/group-fixture/original');
  await page.getByRole('button', { name: 'Retry original' }).click();
  await expect(page.getByLabel('Exact original')).toHaveText('OWN-GROUP-ORIGINAL');
  await screenshot(page, 'recovered-feed');
});

test('two pages retain their drafts and recover a definitive revision conflict', async ({
  page,
  context,
}) => {
  await enter(page);
  await create(page, 'Two view recovery');
  await chatTab(page);
  const other = await context.newPage();
  await enter(other);
  await other.getByRole('button', { name: /Two view recovery/ }).click();
  await chatTab(other);
  const first = page.getByPlaceholder('Message shared test session…');
  const second = other.getByPlaceholder('Message shared test session…');
  await expect(first).toBeEnabled();
  await expect(second).toBeEnabled();
  await first.fill('FIRST-VIEW-UNSENT');
  await expect
    .poll(async () => {
      const groups = await api('groups');
      const opened = await api('open', {
        handle: groups.groups.find((g: { name: string }) => g.name === 'Two view recovery').handle,
      });
      return (await api('chat', { handle: opened.shared.handle })).draft.text;
    })
    .toBe('FIRST-VIEW-UNSENT');
  await second.fill('SECOND-VIEW-UNSENT');
  await expect(other.getByRole('button', { name: 'Keep my text', exact: true })).toBeVisible();
  await expect(first).toHaveValue('FIRST-VIEW-UNSENT');
  await expect(second).toHaveValue('SECOND-VIEW-UNSENT');
  const group = (await api('groups')).groups.find(
    (g: { name: string }) => g.name === 'Two view recovery',
  );
  const opened = await api('open', { handle: group.handle });
  const savedText = async () => (await api('chat', { handle: opened.shared.handle })).draft.text;
  const reopen = async (view: Page) => {
    await view.reload();
    await view.getByRole('button', { name: /Two view recovery/ }).click();
    await chatTab(view);
  };
  // Each tab retains its own unsent text through reload, including the blocked view.
  await second.fill('SECOND-VIEW-NEW-TYPING');
  await reopen(page);
  await reopen(other);
  await expect(first).toHaveValue('FIRST-VIEW-UNSENT');
  await expect(second).toHaveValue('SECOND-VIEW-NEW-TYPING');
  await expect(other.getByRole('button', { name: 'Keep my text', exact: true })).toBeVisible();
  await first.fill('FIRST-VIEW-NEWER-SAVED');
  await expect.poll(savedText).toBe('FIRST-VIEW-NEWER-SAVED');
  // The first choice is stale: CAS rejects it, refreshes the saved version, and
  // asks again instead of silently overwriting the newer text.
  await other.getByRole('button', { name: 'Keep my text', exact: true }).click();
  await expect(other.getByRole('alert').first()).toContainText('Draft changed');
  await other.getByText('Review the saved version', { exact: true }).click();
  await expect(other.locator('.draft-preview')).toHaveText('FIRST-VIEW-NEWER-SAVED');
  await expect.poll(savedText).toBe('FIRST-VIEW-NEWER-SAVED');
  await expect(second).toHaveValue('SECOND-VIEW-NEW-TYPING');
  await other.locator('.group-fixture-status summary').click();
  await other.getByLabel('150% text').check();
  await other.locator('.group-fixture-status summary').click();
  await other.getByRole('button', { name: 'Keep my text', exact: true }).scrollIntoViewIfNeeded();
  await screenshot(other, 'correction-conflict-large');
  await other.getByRole('button', { name: 'Keep my text', exact: true }).click();
  await expect.poll(savedText).toBe('SECOND-VIEW-NEW-TYPING');
  await other.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(second).toHaveValue('');
  await expect(other.locator('.conversation')).toContainText('SECOND-VIEW-NEW-TYPING');
  // The other page can now recover and send too; no shared rejected key wedges it.
  await first.fill('FIRST-VIEW-RECOVER-THEN-SEND');
  await expect(page.getByRole('button', { name: 'Use saved version', exact: true })).toBeVisible();
  await expect(first).toHaveValue('FIRST-VIEW-RECOVER-THEN-SEND');
  await page.locator('.group-fixture-status summary').click();
  await page.getByLabel('150% text').check();
  await page.locator('.group-fixture-status summary').click();
  await page
    .getByRole('button', { name: 'Use saved version', exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot(page, 'correction-use-saved-large');
  await page.getByRole('button', { name: 'Use saved version', exact: true }).click();
  await expect(first).toHaveValue('');
  await expect
    .poll(async () => (await api('chat', { handle: opened.shared.handle })).detail.agent.status)
    .toBe('idle');
  await expect(page.getByLabel('Send timing')).toHaveCount(0);
  await first.fill('FIRST-VIEW-SENT-AFTER-RECOVERY');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(first).toHaveValue('');
  await expect(page.locator('.conversation')).toContainText('FIRST-VIEW-SENT-AFTER-RECOVERY');
  await reopen(page);
  await reopen(other);
  for (const view of [page, other]) {
    await expect(view.getByPlaceholder('Message shared test session…')).toHaveValue('');
    await expect(view.locator('.conversation')).toContainText('FIRST-VIEW-SENT-AFTER-RECOVERY');
    await expect(view.locator('.conversation')).toContainText('SECOND-VIEW-NEW-TYPING');
    await expect(view.getByRole('button', { name: 'Keep my text', exact: true })).toHaveCount(0);
    expect(
      await view.evaluate(() => Object.keys(localStorage).filter((k) => k.endsWith(':pending'))),
    ).toEqual([]);
    expect(
      await view.evaluate(() =>
        Object.keys(sessionStorage)
          .filter((k) => k.endsWith(':view'))
          .map((k) => JSON.parse(sessionStorage.getItem(k)!).pending),
      ),
    ).not.toContainEqual(expect.objectContaining({ key: expect.any(String) }));
  }
  await page.getByRole('button', { name: 'Private to you', exact: true }).click();
  const privateInput = page.getByPlaceholder('Message private test session…');
  await privateInput.fill('CONFLICT-PRIVATE-CANARY');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(privateInput).toHaveValue('');
  await privateInput.fill('PRIVATE-DRAFT-ONLY-IN-FIRST-TAB');
  await expect
    .poll(async () => (await api('chat', { handle: opened.private.handle })).draft.text)
    .toBe('PRIVATE-DRAFT-ONLY-IN-FIRST-TAB');
  await page.getByRole('button', { name: 'Back to shared chat' }).click();
  await expect(first).toHaveValue('');
  await reopen(page);
  await page.getByRole('button', { name: 'Private to you', exact: true }).click();
  await expect(privateInput).toHaveValue('PRIVATE-DRAFT-ONLY-IN-FIRST-TAB');
  await page.getByRole('button', { name: 'What mattered since last visit?' }).click();
  await expect(page.getByRole('region', { name: 'Private catch-up' })).not.toContainText(
    'CONFLICT-PRIVATE-CANARY',
  );
  const feed = await api('feed', {
    handle: opened.shared.handle,
    query: { visibility: 'shared', after: 0, limit: 20, cursor: null },
  });
  expect(JSON.stringify(feed)).not.toContain('CONFLICT-PRIVATE-CANARY');
  expect(JSON.stringify(feed)).not.toContain('PRIVATE-DRAFT-ONLY-IN-FIRST-TAB');
  await other.close();
});

test('draft lost ack keeps exact key through typing, unmount, reload and restart; legacy 409 can recover', async ({
  page,
  context,
}) => {
  await enter(page);
  await create(page, 'Draft lost ack');
  await chatTab(page);
  const group = (await api('groups')).groups.find(
    (g: { name: string }) => g.name === 'Draft lost ack',
  );
  const opened = await api('open', { handle: group.handle });
  const input = page.getByPlaceholder('Message shared test session…');
  await expect(input).toBeEnabled();
  const requests: { handle: string; key: string; revision: number; text: string }[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let committed!: () => void;
  const accepted = new Promise<void>((r) => {
    committed = r;
  });
  await page.route('**/api/group-fixture/draft', async (route) => {
    const body = route.request().postDataJSON() as (typeof requests)[number];
    if (body.handle !== opened.shared.handle) {
      await route.continue();
      return;
    }
    requests.push(body);
    await route.fetch();
    if (requests.length === 1) {
      committed();
      await held;
    }
    await route.abort('failed');
  });
  await input.fill('ACKNOWLEDGED-SNAPSHOT');
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await accepted;
  await input.fill('NEW-TYPING-DURING-ACK');
  let releaseRead!: () => void;
  const heldRead = new Promise<void>((r) => {
    releaseRead = r;
  });
  let firstRead = true;
  await page.route('**/api/group-fixture/chat', async (route) => {
    if (route.request().postDataJSON().handle === opened.private.handle && firstRead) {
      firstRead = false;
      const response = await route.fetch();
      await heldRead;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Private to you', exact: true }).click();
  await page.getByPlaceholder('Message private test session…').fill('SEPARATE-PRIVATE-DRAFT');
  await page.getByRole('button', { name: 'Back to shared chat' }).click();
  await expect(input).toHaveValue('NEW-TYPING-DURING-ACK');
  releaseRead();
  await page.unroute('**/api/group-fixture/chat');
  release();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect
    .poll(async () => (await api('chat', { handle: opened.private.handle })).draft.text)
    .toBe('SEPARATE-PRIVATE-DRAFT');
  const pending = await page.evaluate(
    (handle) =>
      JSON.parse(
        sessionStorage.getItem(`swa:group-fixture:${location.origin}:${handle}:draft:view`)!,
      ).pending,
    opened.shared.handle,
  );
  expect(pending).toEqual(requests[0]);
  expect(new Set(requests.map((r) => JSON.stringify(r))).size).toBe(1);
  await page.unroute('**/api/group-fixture/draft');
  const replayed: typeof requests = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/api/group-fixture/draft'))
      replayed.push(req.postDataJSON() as (typeof requests)[number]);
  });
  const port = Number(new URL(base).port);
  await stop();
  await start(port);
  await page.reload();
  await page.getByRole('button', { name: /Draft lost ack/ }).click();
  await chatTab(page);
  await expect(input).toHaveValue('NEW-TYPING-DURING-ACK');
  await expect
    .poll(async () => (await api('chat', { handle: opened.shared.handle })).draft.text)
    .toBe('NEW-TYPING-DURING-ACK');
  expect(replayed.find((r) => r.handle === opened.shared.handle)).toEqual(pending);
  expect((await api('chat', { handle: opened.shared.handle })).draft.revision).toBe(2);
  await page.getByRole('button', { name: 'Private to you', exact: true }).click();
  await expect(page.getByPlaceholder('Message private test session…')).toHaveValue(
    'SEPARATE-PRIVATE-DRAFT',
  );
  await page.getByRole('button', { name: 'Back to shared chat' }).click();

  // A browser upgraded with the old per-handle localStorage request can recover.
  const legacy = {
    handle: opened.shared.handle,
    key: crypto.randomUUID(),
    revision: 0,
    text: 'LEGACY-REJECTED-TEXT',
  };
  await page.evaluate((value) => {
    const key = `swa:group-fixture:${location.origin}:${value.handle}:draft`;
    localStorage.setItem(key, value.text);
    localStorage.setItem(`${key}:pending`, JSON.stringify(value));
  }, legacy);
  const replacement = {
    ...legacy,
    key: crypto.randomUUID(),
    revision: 2,
    text: 'DIFFERENT-UNCERTAIN-LEGACY-REQUEST',
  };
  const other = await context.newPage();
  let rejected = false;
  let releaseRejection!: () => void;
  const heldRejection = new Promise<void>((r) => {
    releaseRejection = r;
  });
  await other.route('**/api/group-fixture/draft', async (route) => {
    if (route.request().postDataJSON().key === legacy.key) {
      const response = await route.fetch();
      expect(response.status()).toBe(409);
      rejected = true;
      await heldRejection;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await enter(other);
  await other.getByRole('button', { name: /Draft lost ack/ }).click();
  await chatTab(other);
  const otherInput = other.getByPlaceholder('Message shared test session…');
  await expect.poll(() => rejected).toBe(true);
  // Another view replaces the shared legacy key during the 409 response. The
  // rejected-key cleanup must not erase this different, genuinely uncertain key.
  await api('draft', replacement);
  await page.evaluate((value) => {
    const key = `swa:group-fixture:${location.origin}:${value.handle}:draft`;
    localStorage.setItem(key, value.text);
    localStorage.setItem(`${key}:pending`, JSON.stringify(value));
  }, replacement);
  releaseRejection();
  await expect(other.getByRole('button', { name: 'Keep my text', exact: true })).toBeVisible();
  await expect(otherInput).toHaveValue('LEGACY-REJECTED-TEXT');
  expect(
    await other.evaluate(
      (handle) =>
        localStorage.getItem(`swa:group-fixture:${location.origin}:${handle}:draft:pending`),
      opened.shared.handle,
    ),
  ).toBe(JSON.stringify(replacement));
  await expect(input).toHaveValue('NEW-TYPING-DURING-ACK');
  await other.getByRole('button', { name: 'Keep my text', exact: true }).click();
  await expect
    .poll(async () => (await api('chat', { handle: opened.shared.handle })).draft.text)
    .toBe('LEGACY-REJECTED-TEXT');
  await other.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(otherInput).toHaveValue('');
  const fresh = await context.newPage();
  const migrationRequests: typeof requests = [];
  fresh.on('request', (req) => {
    if (req.url().endsWith('/api/group-fixture/draft'))
      migrationRequests.push(req.postDataJSON() as (typeof requests)[number]);
  });
  await enter(fresh);
  await fresh.getByRole('button', { name: /Draft lost ack/ }).click();
  await chatTab(fresh);
  await expect(fresh.getByRole('button', { name: 'Use saved version', exact: true })).toBeVisible();
  expect(migrationRequests[0]).toEqual(replacement);
  await expect(fresh.getByPlaceholder('Message shared test session…')).toHaveValue(
    replacement.text,
  );
  await fresh.getByRole('button', { name: 'Use saved version', exact: true }).click();
  await expect(fresh.getByPlaceholder('Message shared test session…')).toHaveValue('');
  await fresh.close();
  writeFileSync(
    join(
      repo,
      `data/group-fixture-evidence/correction-1/draft-receipts-${test.info().project.name}.json`,
    ),
    JSON.stringify(
      {
        pending,
        requests,
        replayed,
        legacyRejectedKey: legacy.key,
        replacement,
        migrationRequests,
      },
      null,
      2,
    ),
  );
  await other.close();
});

test('bounded chat notices persisted fixture history without publishing raw entries', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Host truncation is independent of viewport.');
  await enter(page);
  await create(page, 'Bounded history');
  const group = (await api('groups')).groups.find(
    (g: { name: string }) => g.name === 'Bounded history',
  );
  const opened = await api('open', { handle: group.handle });
  // Only this harness-owned fixture DB is seeded. This checks the existing chat
  // bound without consuming hundreds of fake-run admission slots. UI send/restart
  // is covered above; these unjournaled history entries must not become feed events.
  const db = new DatabaseSync(join(root, 'data/dock.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT INTO entries(id,agent_id,body) VALUES(?,?,?)');
    for (let i = 0; i < 201; i++) {
      const entry = entrySchema.parse({
        id: crypto.randomUUID(),
        agentId: opened.shared.agent.id,
        runId: null,
        kind: 'user',
        title: 'Seeded bounded test history',
        text: `SEEDED-UNPUBLISHED-HISTORY-${i}`,
        status: 'complete',
        createdAt: new Date().toISOString(),
      });
      insert.run(entry.id, entry.agentId, JSON.stringify(entry));
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  const result = await api('chat', { handle: opened.shared.handle });
  expect(result.detail.entries).toHaveLength(200);
  expect(result.detail.hasMore).toBe(true);
  await chatTab(page);
  await expect(
    page.getByText('Older messages hidden · this test view shows only the latest 200 entries.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Load older/ })).toHaveCount(0);
  const feed = await api('feed', {
    handle: opened.shared.handle,
    query: { visibility: 'shared', after: 0, limit: 20, cursor: null },
  });
  expect(feed.entries).toHaveLength(0);
  await screenshot(page, 'correction-bounded-history');
});

for (const [status, oversized] of [
  [400, '界'.repeat(6000)],
  [413, '\u0001'.repeat(5000)],
] as const) {
  test(`oversized ${status} preflight suppresses new requests; definitive pending rejection recovers`, async ({
    page,
    context,
  }) => {
    await enter(page);
    const name = `Rejected ${status}`;
    await create(page, name);
    await chatTab(page);
    const input = page.getByPlaceholder('Message shared test session…');
    await expect(page.locator('.draft-handoff [role=status]').first()).toHaveText('Draft saved');
    const group = (await api('groups')).groups.find((g: { name: string }) => g.name === name);
    const opened = await api('open', { handle: group.handle });
    const key = `swa:group-fixture:${base}:${opened.shared.handle}:draft:view`;
    const requests: unknown[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/group-fixture/draft')) requests.push(request.postDataJSON());
    });
    const original = {
      handle: opened.shared.handle,
      key: crypto.randomUUID(),
      revision: 0,
      text: oversized,
    };
    for (const text of [oversized, oversized + 'a', oversized]) {
      await input.fill(text);
      await expect(page.getByRole('alert').first()).toContainText('Shorten or correct');
      await page.waitForTimeout(400); // Allow each actual 250ms debounce to run.
      expect(requests).toHaveLength(0);
      await expect(input).toHaveValue(text);
    }
    expect((await api('chat', { handle: opened.shared.handle })).draft.revision).toBe(0);
    expect(
      await page.evaluate((k) => JSON.parse(sessionStorage.getItem(k)!).pending, key),
    ).toBeNull();
    await page.reload();
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await chatTab(page);
    await expect(input).toHaveValue(oversized);
    await expect(page.getByRole('alert').first()).toContainText('Shorten or correct');
    expect(requests).toHaveLength(0);
    await page.locator('.group-fixture-status summary').click();
    await page.getByLabel('150% text').check();
    await page.locator('.group-fixture-status summary').click();
    const cue = page.getByText('· Shorten or correct draft to save/send.', { exact: true });
    await cue.scrollIntoViewIfNeeded();
    await expect(cue).toBeVisible();
    await screenshot(page, `b2-${status}-feedback-large`);
    // A legacy invalid request must survive schema parsing and reach the host,
    // so its definitive rejection can be cleared without losing local text.
    const legacy = { ...original, key: crypto.randomUUID() };
    await page.evaluate((value) => {
      const key = `swa:group-fixture:${location.origin}:${value.handle}:draft`;
      localStorage.setItem(key, value.text);
      localStorage.setItem(`${key}:pending`, JSON.stringify(value));
    }, legacy);
    const other = await context.newPage();
    await enter(other);
    const legacyResponse = other.waitForResponse(
      (r) =>
        r.url().endsWith('/api/group-fixture/draft') &&
        r.request().postDataJSON().key === legacy.key,
    );
    await other.getByRole('button', { name: new RegExp(name) }).click();
    await chatTab(other);
    expect((await legacyResponse).status()).toBe(status);
    await expect(other.getByRole('alert').first()).toContainText('Shorten or correct');
    await expect(other.getByPlaceholder('Message shared test session…')).toHaveValue(oversized);
    await expect
      .poll(() =>
        other.evaluate(
          (handle) =>
            localStorage.getItem(`swa:group-fixture:${location.origin}:${handle}:draft:pending`),
          opened.shared.handle,
        ),
      )
      .toBeNull();
    await other.getByPlaceholder('Message shared test session…').fill(`SHORTER-${status}`);
    await expect
      .poll(async () => (await api('chat', { handle: opened.shared.handle })).draft.text)
      .toBe(`SHORTER-${status}`);
    await other.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(other.getByPlaceholder('Message shared test session…')).toHaveValue('');
    await other.reload();
    await other.getByRole('button', { name: new RegExp(name) }).click();
    await chatTab(other);
    await expect(other.getByPlaceholder('Message shared test session…')).toHaveValue('');
    await expect(other.locator('.conversation')).toContainText(`SHORTER-${status}`);
    await input.fill(`FIRST-PAGE-SHORTER-${status}`);
    // The legacy view advanced this scope: normal 409 explicit recovery remains.
    await expect(page.getByRole('button', { name: 'Keep my text', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Keep my text', exact: true }).click();
    await expect
      .poll(async () => (await api('chat', { handle: opened.shared.handle })).draft.text)
      .toBe(`FIRST-PAGE-SHORTER-${status}`);
    writeFileSync(
      join(
        repo,
        `data/group-fixture-evidence/correction-2/rejection-${status}-${test.info().project.name}.json`,
      ),
      JSON.stringify(
        {
          status,
          originalKey: original.key,
          originalTextUnits: oversized.length,
          originalUtf8Bytes: Buffer.byteLength(oversized),
          encodedRequestBytes: Buffer.byteLength(JSON.stringify(original)),
          legacyKey: legacy.key,
          recoveredText: `SHORTER-${status}`,
        },
        null,
        2,
      ),
    );
    await other.close();
  });
}

test('5xx and auth ambiguity retain exact draft identity until acknowledged; bounded view parsing retains valid receipts', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Transport/state parsing is independent of viewport.');
  for (const status of [500, 401, 403]) {
    await enter(page);
    await create(page, `Uncertain ${status}`);
    await chatTab(page);
    const input = page.getByPlaceholder('Message shared test session…');
    await expect(page.locator('.draft-handoff [role=status]').first()).toHaveText('Draft saved');
    const requests: { handle: string; key: string; revision: number; text: string }[] = [];
    await page.route('**/api/group-fixture/draft', async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fetch(); // Effect happened: error/auth status alone must not discard its identity.
      await route.fulfill({ status, json: { error: `Uncertain ${status}` } });
    });
    await input.fill(`UNCERTAIN-${status}`);
    await expect(page.getByRole('alert').first()).toContainText(`Uncertain ${status}`);
    const oversizedTyping = '界'.repeat(6000);
    await input.fill(oversizedTyping);
    await expect.poll(() => requests.length).toBeGreaterThan(1);
    expect(new Set(requests.map((r) => JSON.stringify(r))).size).toBe(1);
    const original = requests[0];
    const storageKey = `swa:group-fixture:${base}:${original.handle}:draft:view`;
    expect(
      await page.evaluate((k) => JSON.parse(sessionStorage.getItem(k)!).pending, storageKey),
    ).toEqual(original);
    await page.unroute('**/api/group-fixture/draft');
    const replayed: typeof requests = [];
    const observe = (request: import('@playwright/test').Request) => {
      if (request.url().endsWith('/api/group-fixture/draft')) replayed.push(request.postDataJSON());
    };
    page.on('request', observe);
    await page.getByRole('button', { name: 'Retry saving draft', exact: true }).click();
    await expect(page.getByRole('alert').first()).toContainText('Shorten or correct');
    await expect(input).toHaveValue(oversizedTyping);
    expect(replayed).toEqual([original]);
    await input.fill(`NEW-TYPING-${status}`);
    await expect
      .poll(async () => (await api('chat', { handle: original.handle })).draft.text)
      .toBe(`NEW-TYPING-${status}`);
    expect(replayed[0]).toEqual(original);
    // Corrupt only view metadata while retaining a structurally supported receipt.
    const saved = (await api('chat', { handle: original.handle })).draft;
    const pending = {
      handle: original.handle,
      key: crypto.randomUUID(),
      revision: saved.revision,
      text: `ACK-FOR-PARSING-${status}`,
    };
    await api('draft', pending);
    await page.evaluate(
      ({ k, pending, text }) =>
        sessionStorage.setItem(
          k,
          JSON.stringify({
            text,
            base: null,
            pending,
            conflict: null,
            blocked: false,
            ready: 'malformed',
            saving: false,
            error: '',
          }),
        ),
      { k: storageKey, pending, text: `SALVAGED-TYPING-${status}` },
    );
    replayed.length = 0;
    await page.reload();
    await page.getByRole('button', { name: new RegExp(`Uncertain ${status}`) }).click();
    await chatTab(page);
    await expect(input).toHaveValue(`SALVAGED-TYPING-${status}`);
    await expect
      .poll(async () => (await api('chat', { handle: original.handle })).draft.text)
      .toBe(`SALVAGED-TYPING-${status}`);
    expect(replayed[0]).toEqual(pending);
    const group = (await api('groups')).groups.find(
      (g: { name: string }) => g.name === `Uncertain ${status}`,
    );
    const opened = await api('open', { handle: group.handle });
    await api('draft', {
      handle: opened.private.handle,
      key: crypto.randomUUID(),
      revision: 0,
      text: 'PRIVATE-SAVED-PARSE-CANARY',
    });
    await page.evaluate(
      (handle) =>
        sessionStorage.setItem(
          `swa:group-fixture:${location.origin}:${handle}:draft:view`,
          '{broken-json',
        ),
      opened.private.handle,
    );
    await page.getByRole('button', { name: 'Private to you', exact: true }).click();
    await expect(page.getByPlaceholder('Message private test session…')).toHaveValue(
      'PRIVATE-SAVED-PARSE-CANARY',
    );
    const feed = await api('feed', {
      handle: opened.shared.handle,
      query: { visibility: 'shared', after: 0, limit: 20, cursor: null },
    });
    expect(JSON.stringify(feed)).not.toContain('PRIVATE-SAVED-PARSE-CANARY');
    page.off('request', observe);
    writeFileSync(
      join(repo, `data/group-fixture-evidence/correction-2/uncertain-${status}.json`),
      JSON.stringify({ status, original, requests, preservedPending: pending, replayed }, null, 2),
    );
  }
});

test('damaged draft text recovers saved provenance and exact pending snapshots without empty autosaves', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Storage recovery is independent of viewport.');
  await enter(page);
  await create(page, 'Damaged recovery');
  await chatTab(page);
  const group = (await api('groups')).groups.find(
    (g: { name: string }) => g.name === 'Damaged recovery',
  );
  const opened = await api('open', { handle: group.handle });
  const handle = opened.shared.handle as string;
  const input = page.getByPlaceholder('Message shared test session…');
  const key = `swa:group-fixture:${base}:${handle}:draft:view`;
  const requests: { handle: string; key: string; revision: number; text: string }[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/group-fixture/draft')) requests.push(request.postDataJSON());
  });
  const store = async (value: unknown) => {
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
      key,
      value,
    });
    requests.length = 0;
    await page.reload();
    await page.getByRole('button', { name: /Damaged recovery/ }).click();
    await chatTab(page);
  };
  let saved = await api('draft', {
    handle,
    key: crypto.randomUUID(),
    revision: 0,
    text: 'SAVED-NONEMPTY',
  });
  // Invalid local text with a valid base must not manufacture an empty save.
  await store({ text: 7, base: saved, pending: null, ready: 'broken' });
  await expect(input).toHaveValue(saved.text);
  await expect(page.locator('.draft-handoff [role=status]').first()).toHaveText('Draft saved');
  await page.waitForTimeout(400);
  expect(requests).toHaveLength(0);
  expect((await api('chat', { handle })).draft).toEqual(saved);

  for (const hasBase of [true, false]) {
    const oldBase = saved;
    const pending = {
      handle,
      key: crypto.randomUUID(),
      revision: saved.revision,
      text: `PENDING-SNAPSHOT-${hasBase}`,
    };
    saved = await api('draft', pending); // Effect happened, but this tab lost the acknowledgement.
    await store({ text: null, base: hasBase ? oldBase : null, pending, ready: 'broken' });
    await expect(input).toHaveValue(pending.text);
    await expect(page.locator('.draft-handoff [role=status]').first()).toHaveText('Draft saved');
    expect(requests).toEqual([pending]);
    expect((await api('chat', { handle })).draft).toEqual(saved);
    await page.reload();
    await page.getByRole('button', { name: /Damaged recovery/ }).click();
    await chatTab(page);
    await expect(input).toHaveValue(pending.text);
  }

  // Even damaged metadata cannot remove an already explicit conflict choice.
  const stale = saved;
  saved = await api('draft', {
    handle,
    key: crypto.randomUUID(),
    revision: saved.revision,
    text: 'OTHER-VIEW-SAVED',
  });
  await store({
    text: null,
    base: stale,
    pending: null,
    conflict: saved,
    blocked: true,
    ready: 'broken',
  });
  await expect(input).toHaveValue(stale.text);
  await expect(page.getByRole('button', { name: 'Keep my text', exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Use saved version', exact: true }).click();
  await expect(input).toHaveValue(saved.text);

  // A whole copied private view has no shared provenance; recover from shared host.
  const privatePending = {
    handle: opened.private.handle,
    key: crypto.randomUUID(),
    revision: 0,
    text: 'PRIVATE-DAMAGED-CANARY',
  };
  const privateSaved = await api('draft', privatePending);
  await store({
    text: privatePending.text,
    base: privateSaved,
    pending: privatePending,
    ready: 'broken',
  });
  await expect(input).toHaveValue(saved.text);
  await expect(page.locator('.draft-handoff [role=status]').first()).toHaveText('Draft saved');
  expect(requests).toHaveLength(0);
  await store({ text: {}, base: { revision: -1, text: 'BROKEN-BASE' }, pending: null });
  await expect(input).toHaveValue(saved.text);
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Private to you', exact: true }).click();
  await expect(page.getByPlaceholder('Message private test session…')).toHaveValue(
    privatePending.text,
  );
  expect(
    JSON.stringify(
      await api('feed', {
        handle,
        query: { visibility: 'shared', after: 0, limit: 20, cursor: null },
      }),
    ),
  ).not.toContain(privatePending.text);
});

test('damaged recovery keeps typing during first read and uncertain replay before oversized new edits', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'In-flight ordering is independent of viewport.');
  await enter(page);
  await create(page, 'Damaged in flight');
  await chatTab(page);
  const group = (await api('groups')).groups.find(
    (g: { name: string }) => g.name === 'Damaged in flight',
  );
  const opened = await api('open', { handle: group.handle });
  const handle = opened.shared.handle as string;
  const input = page.getByPlaceholder('Message shared test session…');
  const oldBase = (await api('chat', { handle })).draft;
  const pending = {
    handle,
    key: crypto.randomUUID(),
    revision: oldBase.revision,
    text: 'PENDING-BEFORE-TYPING',
  };
  await api('draft', pending);
  await page.evaluate(
    ({ handle, oldBase, pending }) =>
      sessionStorage.setItem(
        `swa:group-fixture:${location.origin}:${handle}:draft:view`,
        JSON.stringify({ text: null, base: oldBase, pending, ready: 'broken' }),
      ),
    { handle, oldBase, pending },
  );
  let releaseRead!: () => void;
  const heldRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let readHeld = false;
  await page.route('**/api/group-fixture/chat', async (route) => {
    if (!readHeld && route.request().postDataJSON().handle === handle) {
      readHeld = true;
      const response = await route.fetch();
      await heldRead;
      await route.fulfill({ response });
    } else await route.continue();
  });
  const requests: (typeof pending)[] = [];
  let releaseReplay!: () => void;
  const heldReplay = new Promise<void>((resolve) => {
    releaseReplay = resolve;
  });
  await page.route('**/api/group-fixture/draft', async (route) => {
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    await heldReplay;
    await route.fulfill({ response });
  });
  await page.reload();
  await page.getByRole('button', { name: /Damaged in flight/ }).click();
  await chatTab(page);
  await expect.poll(() => readHeld).toBe(true);
  await input.fill('TYPING-DURING-FIRST-READ');
  releaseRead();
  await expect.poll(() => requests.length).toBe(1);
  await expect(input).toHaveValue('TYPING-DURING-FIRST-READ');
  const oversized = '界'.repeat(6000);
  await input.fill(oversized);
  releaseReplay();
  await expect(page.getByRole('alert').first()).toContainText('Shorten or correct');
  await page.waitForTimeout(400);
  expect(requests).toEqual([pending]); // Reconcile the exact uncertain identity, then preflight new text.
  await expect(input).toHaveValue(oversized);
  expect((await api('chat', { handle })).draft.text).toBe(pending.text);
  await page.unroute('**/api/group-fixture/draft');
  await page.unroute('**/api/group-fixture/chat');
  await page.reload();
  await page.getByRole('button', { name: /Damaged in flight/ }).click();
  await chatTab(page);
  await expect(input).toHaveValue(oversized);
  await expect(page.getByRole('alert').first()).toContainText('Shorten or correct');
  await input.fill('SHORTENED-AFTER-REPLAY');
  await expect
    .poll(async () => (await api('chat', { handle })).draft.text)
    .toBe('SHORTENED-AFTER-REPLAY');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.locator('.conversation')).toContainText('SHORTENED-AFTER-REPLAY');
});

test('new draft preflight matches UTF16, UTF8, surrogate and encoded JSON boundaries', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Encoding boundaries are independent of viewport.');
  await enter(page);
  await create(page, 'Encoding boundaries');
  await chatTab(page);
  const group = (await api('groups')).groups.find(
    (g: { name: string }) => g.name === 'Encoding boundaries',
  );
  const opened = await api('open', { handle: group.handle });
  const handle = opened.shared.handle as string;
  const input = page.getByPlaceholder('Message shared test session…');
  const requests: { handle: string; key: string; revision: number; text: string }[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/group-fixture/draft')) requests.push(request.postDataJSON());
  });
  for (const text of ['a'.repeat(16385), '界'.repeat(5462), '\ud800', '\udc00']) {
    // React's native input event keeps exact UTF16, including lone surrogates.
    await input.evaluate((element, value) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await expect(page.getByRole('alert').first()).toContainText('Shorten or correct');
    await page.waitForTimeout(400);
    expect(requests).toHaveLength(0);
    expect(await input.inputValue()).toBe(text);
  }
  const revision = (await api('chat', { handle })).draft.revision as number;
  const overhead = Buffer.byteLength(
    JSON.stringify({ handle, key: crypto.randomUUID(), revision, text: '' }),
  );
  const escaped = '\u0001'.repeat(Math.floor((24 * 1024 - overhead) / 6));
  const exact = escaped + 'a'.repeat(24 * 1024 - overhead - escaped.length * 6);
  expect(
    Buffer.byteLength(JSON.stringify({ handle, key: crypto.randomUUID(), revision, text: exact })),
  ).toBe(24 * 1024);
  await input.fill(exact + 'a');
  await expect(page.getByRole('alert').first()).toContainText('Shorten or correct');
  await page.waitForTimeout(400);
  expect(requests).toHaveLength(0);
  await input.fill(exact);
  await expect.poll(async () => (await api('chat', { handle })).draft.text).toBe(exact);
  expect(requests).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(requests[0]))).toBe(24 * 1024);
  await input.fill('😀'.repeat(4096)); // Valid paired UTF16 and exactly 16384 UTF8 bytes.
  await expect.poll(async () => (await api('chat', { handle })).draft.text).toBe('😀'.repeat(4096));
  expect(requests).toHaveLength(2);
});

test('oversized pending identities still replay through network and auth uncertainty before local preflight', async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== 'desktop',
    'Pending identity reconciliation is independent of viewport.',
  );
  for (const status of [500, 401, 403, 'network'] as const) {
    await enter(page);
    const name = `Oversized pending ${status}`;
    await create(page, name);
    await chatTab(page);
    const group = (await api('groups')).groups.find((g: { name: string }) => g.name === name);
    const opened = await api('open', { handle: group.handle });
    const pending = {
      handle: opened.shared.handle as string,
      key: crypto.randomUUID(),
      revision: 0,
      text: '界'.repeat(6000),
    };
    const key = `swa:group-fixture:${base}:${pending.handle}:draft:view`;
    await page.evaluate(
      ({ key, pending }) =>
        sessionStorage.setItem(
          key,
          JSON.stringify({ text: pending.text, base: null, pending, ready: 'broken' }),
        ),
      { key, pending },
    );
    const requests: (typeof pending)[] = [];
    await page.route('**/api/group-fixture/draft', async (route) => {
      requests.push(route.request().postDataJSON());
      if (status === 'network') await route.abort('failed');
      else await route.fulfill({ status, json: { error: 'Uncertain oversized receipt' } });
    });
    await page.reload();
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await chatTab(page);
    await expect(page.getByRole('alert').first()).toBeVisible();
    const input = page.getByPlaceholder('Message shared test session…');
    await input.fill(`NEW-SHORT-${status}`);
    await expect.poll(() => requests.length).toBeGreaterThan(1);
    expect(requests.every((value) => JSON.stringify(value) === JSON.stringify(pending))).toBe(true);
    expect(
      await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).pending, key),
    ).toEqual(pending);
    await page.unroute('**/api/group-fixture/draft');
    const rejected = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/group-fixture/draft') &&
        response.request().postDataJSON().key === pending.key,
    );
    await page.getByRole('button', { name: 'Retry saving draft', exact: true }).click();
    expect((await rejected).status()).toBe(400);
    await expect(page.getByRole('alert').first()).toContainText('Shorten or correct');
    expect(
      await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).pending, key),
    ).toBeNull();
    await expect(input).toHaveValue(`NEW-SHORT-${status}`);
    await page.getByRole('button', { name: 'Retry saving draft', exact: true }).click();
    await expect
      .poll(async () => (await api('chat', { handle: pending.handle })).draft.text)
      .toBe(`NEW-SHORT-${status}`);
  }
});
