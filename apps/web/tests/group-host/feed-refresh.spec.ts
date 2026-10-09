import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupFeedEntrySchema, type GroupFeedEntry, type GroupFeedQuery } from '@dock/shared';
import type { GroupHostOpen } from '@dock/shared/dist/group-host.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
let child: ChildProcess | undefined;
let connection: { origin: string; cookie: string; secondary: { origin: string; cookie: string } };
test.beforeAll(async () => {
  child = spawn(
    process.execPath,
    [
      join(root, 'apps/server/node_modules/tsx/dist/cli.mjs'),
      join(root, 'apps/server/src/group-host-browser.fixture.ts'),
    ],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe' },
  );
  child.stderr?.resume();
  connection = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Feed harness startup timeout')), 30000);
    child!.once('exit', () => reject(new Error('Feed harness exited')));
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

test('shared chat follows paginated originals and retries damaged arrivals without losing history', async ({
  page,
}) => {
  const [name, ...parts] = connection.cookie.split('=');
  await page
    .context()
    .addCookies([
      { name, value: parts.join('='), url: connection.origin, httpOnly: true, sameSite: 'Strict' },
    ]);
  await page.goto(`${connection.origin}/#/chats/groups`);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Amina');
  await page.getByLabel('Project name', { exact: true }).fill('Paginated River');
  const opened = page
    .waitForResponse((response) => response.url().endsWith('/api/groups/open'))
    .then((response) => response.json() as Promise<GroupHostOpen>);
  const entries = new Map<number, GroupFeedEntry>();
  const queries: GroupFeedQuery[] = [];
  const feedHandles: string[] = [];
  let available = 6;
  let damaged = false;
  const event = async (sequence: number) => {
    const saved = entries.get(sequence);
    if (saved) return saved;
    const { context } = (await opened).shared;
    const text = `Exact shared original ${sequence}`;
    const bytes = Buffer.byteLength(text);
    const sha256 = createHash('sha256').update(text).digest('hex');
    const value = groupFeedEntrySchema.parse({
      eventId: randomUUID(),
      sequence,
      scope: {
        groupId: context.groupId,
        memberId: context.memberId,
        installationId: context.installationId,
        visibility: 'shared',
        source: {
          sessionId: context.sessionId,
          provider: context.provider,
          nativeSessionId: context.nativeSessionId,
          messageId: `synthetic-${sequence}`,
        },
        causalRefs: [],
      },
      operationId: randomUUID(),
      entityId: randomUUID(),
      revision: 1,
      category: 'Finding',
      condensedText: `Summary ${sequence}`,
      evidenceRefs: [],
      corrects: null,
      manifest: { bytes, sha256, chunks: [{ index: 0, bytes, sha256 }] },
      recordedAt: new Date(1700000000000 + sequence * 1000).toISOString(),
    });
    entries.set(sequence, value);
    return value;
  };
  await page.route('**/api/groups/original', async (route) => {
    const { eventId } = route.request().postDataJSON();
    const entry = [...entries.values()].find((value) => value.eventId === eventId)!;
    await route.fulfill({
      json: {
        eventId,
        text:
          damaged && entry.sequence === 7
            ? 'Damaged content'
            : `Exact shared original ${entry.sequence}`,
      },
    });
  });
  await page.route('**/api/groups/feed', async (route) => {
    const { handle, query } = route.request().postDataJSON() as {
      handle: string;
      query: GroupFeedQuery;
    };
    feedHandles.push(handle);
    queries.push(query);
    const after = query.cursor?.after ?? query.after;
    const watermark = query.cursor?.watermark ?? available;
    const positions = Array.from(
      { length: Math.min(2, Math.max(0, watermark - after)) },
      (_, index) => after + index + 1,
    );
    const last = positions.at(-1) ?? after;
    await route.fulfill({
      json: {
        entries: await Promise.all(positions.map(event)),
        watermark,
        continuation:
          last < watermark
            ? { version: 2, scopeKey: 'a'.repeat(64), visibility: 'shared', after: last, watermark }
            : null,
      },
    });
  });
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  const conversation = page.locator('.group-shared-chat .conversation');
  await expect(conversation.locator('.message')).toHaveCount(6);
  await expect(conversation).toContainText('Exact shared original 1');
  await expect(conversation).toContainText('Exact shared original 6');
  expect(queries.some((query) => query.cursor?.after === 2 && query.cursor.watermark === 6)).toBe(
    true,
  );
  expect(queries.some((query) => query.cursor?.after === 4 && query.cursor.watermark === 6)).toBe(
    true,
  );
  damaged = true;
  available = 7;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Retry group messages' })).toBeVisible();
  await expect(conversation.locator('.message')).toHaveCount(6);
  await expect(conversation).not.toContainText('Damaged content');
  damaged = false;
  await page.getByRole('button', { name: 'Retry group messages' }).click();
  await expect(conversation.locator('.message')).toHaveCount(7);
  await expect(conversation).toContainText('Exact shared original 7');
  await expect(page.getByRole('button', { name: 'Retry group messages' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'My group agent', exact: true }).click();
  available = 8;
  await page.getByRole('tab', { name: 'Group chat', exact: true }).click();
  await expect(conversation.locator('.message')).toHaveCount(8);
  await expect(conversation).toContainText('Exact shared original 8');
  await expect(conversation).toContainText('Exact shared original 1');
  const sharedHandle = (await opened).shared.handle;
  expect(feedHandles.every((handle) => handle === sharedHandle)).toBe(true);
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  const controls = page.locator('.group-host-controls');
  const summary = controls.getByText('Summary computer for older activity', { exact: true });
  await expect(summary).toHaveCount(0);
  await controls.getByText('Advanced', { exact: true }).click();
  await summary.click();
  const writer = controls.getByRole('button', {
    name: 'Use my agent to summarize older activity',
    exact: true,
  });
  await expect(writer).toBeVisible();
  await expect(writer).toBeEnabled();
  await expect(summary.locator('..')).toContainText('uses that person’s provider allowance');
  // Accessing the optional retained writer does not select it or start a summary.
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(conversation.locator('.message')).toHaveCount(8);
});

test('a second member saved original reaches normal Group chat through native notifications without focus polling', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const observed = window as typeof window & {
      groupHints: { groupId: string; connected: boolean; changed: boolean }[];
    };
    observed.groupHints = [];
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener('group', (event) => {
          observed.groupHints.push(JSON.parse((event as MessageEvent<string>).data));
        });
      }
    };
  });
  const [name, ...parts] = connection.cookie.split('=');
  await page
    .context()
    .addCookies([
      { name, value: parts.join('='), url: connection.origin, httpOnly: true, sameSite: 'Strict' },
    ]);
  await page.goto(`${connection.origin}/#/chats/groups`);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Amina');
  await page.getByLabel('Project name', { exact: true }).fill('Notification River');
  const opening = page
    .waitForResponse((response) => response.url().endsWith('/api/groups/open'))
    .then((response) => response.json() as Promise<GroupHostOpen>);
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  const open = await opening;
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (
            window as typeof window & { groupHints: { groupId: string; connected: boolean }[] }
          ).groupHints.some((hint) => hint.groupId === id && hint.connected),
        open.group.id,
      ),
    )
    .toBe(true);
  const invitation = await page.request.post(`${connection.origin}/api/groups/invite`, {
    headers: { Origin: connection.origin },
    data: { handle: open.group.handle, key: randomUUID() },
  });
  expect(invitation.ok()).toBe(true);
  const joining = await page.request.post(`${connection.secondary.origin}/api/groups/join`, {
    headers: { Cookie: connection.secondary.cookie, Origin: connection.secondary.origin },
    data: {
      key: randomUUID(),
      invitation: `http://invitation.invalid/#${(await invitation.json()).fragment}`,
      displayName: 'Li Ming',
    },
  });
  expect(joining.ok()).toBe(true);
  const saved = (await joining.json()) as GroupHostOpen;
  const reading = await page.request.post(`${connection.secondary.origin}/api/groups/open`, {
    headers: { Cookie: connection.secondary.cookie, Origin: connection.secondary.origin },
    data: { handle: saved.group.handle },
  });
  expect(reading.ok()).toBe(true);
  const member = (await reading.json()) as GroupHostOpen;
  const before = await page.evaluate(
    () => (window as typeof window & { groupHints: unknown[] }).groupHints.length,
  );
  const sent = await page.request.post(`${connection.secondary.origin}/api/groups/send`, {
    headers: { Cookie: connection.secondary.cookie, Origin: connection.secondary.origin },
    data: {
      handle: member.shared.handle,
      key: randomUUID(),
      text: 'An exact saved second-member original, without a model turn.',
    },
  });
  expect(sent.ok()).toBe(true);
  expect((await sent.json()).delivery).toBe('complete');
  await expect(page.locator('.group-shared-chat .conversation')).toContainText(
    'An exact saved second-member original, without a model turn.',
    { timeout: 10_000 },
  );
  expect(
    await page.evaluate(
      () => (window as typeof window & { groupHints: unknown[] }).groupHints.length,
    ),
  ).toBeGreaterThan(before);
});
