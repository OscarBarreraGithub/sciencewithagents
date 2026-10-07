import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GroupFeedEntry, GroupFeedQuery } from '@dock/shared';
import type { GroupHostOpen } from '@dock/shared/dist/group-host.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
let child: ChildProcess | undefined;
let connection: { origin: string; cookie: string };
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
  let available = 6;
  let damaged = false;
  const event = async (sequence: number) => {
    const saved = entries.get(sequence);
    if (saved) return saved;
    const { context } = (await opened).shared;
    const text = `Exact shared original ${sequence}`;
    const bytes = Buffer.byteLength(text);
    const sha256 = createHash('sha256').update(text).digest('hex');
    const value = {
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
    } as GroupFeedEntry;
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
    const { query } = route.request().postDataJSON() as { query: GroupFeedQuery };
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
  await page.getByRole('tab', { name: 'Group manager', exact: true }).click();
  available = 8;
  await page.getByRole('tab', { name: 'Group chat', exact: true }).click();
  await expect(conversation.locator('.message')).toHaveCount(8);
  await expect(conversation).toContainText('Exact shared original 8');
  await expect(conversation).toContainText('Exact shared original 1');
});
