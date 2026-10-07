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

test('arrivals preserve paginated history and a manual refresh ignores its previous read', async ({
  page,
}) => {
  const [name, ...parts] = connection.cookie.split('=');
  await page
    .context()
    .addCookies([
      { name, value: parts.join('='), url: connection.origin, httpOnly: true, sameSite: 'Strict' },
    ]);
  await page.goto(`${connection.origin}/#/home`);
  await page.getByRole('link', { name: /Groups Shared work/ }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Amina');
  await page.getByLabel('Project name', { exact: true }).fill('Paginated River');
  const opening = page.waitForResponse((response) => response.url().endsWith('/api/groups/open'));
  const opened = opening.then((response) => response.json() as Promise<GroupHostOpen>);
  const entries = new Map<number, GroupFeedEntry>();
  const queries: GroupFeedQuery[] = [];
  const scopeKey = 'a'.repeat(64);
  let reset = false;
  let available = 30;
  let releaseOldRead: (() => void) | undefined;
  let oldReadStarted = false;
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
      condensedText: `Shared event ${sequence}`,
      evidenceRefs: [],
      corrects: null,
      manifest: { bytes, sha256, chunks: [{ index: 0, bytes, sha256 }] },
      recordedAt: new Date().toISOString(),
    } as GroupFeedEntry;
    entries.set(sequence, value);
    return value;
  };
  await page.route('**/api/groups/original', async (route) => {
    const { eventId } = route.request().postDataJSON();
    const entry = [...entries.values()].find((value) => value.eventId === eventId)!;
    await route.fulfill({ json: { eventId, text: `Exact shared original ${entry.sequence}` } });
  });
  await page.route('**/api/groups/feed', async (route) => {
    const { query } = route.request().postDataJSON() as { query: GroupFeedQuery };
    queries.push(query);
    let positions: number[];
    let watermark: number;
    if (query.cursor) {
      positions = Array.from({ length: 8 }, (_, index) => query.cursor!.after + index + 1);
      watermark = query.cursor.watermark;
    } else if (query.after === 0) {
      positions = [1, 2, 3, 4, 5, 6, 7, 8];
      watermark = reset ? 40 : 30;
    } else if (!reset && query.after === 32) {
      oldReadStarted = true;
      await new Promise<void>((resolve) => {
        releaseOldRead = resolve;
      });
      positions = [33];
      watermark = 33;
    } else if (query.after >= available) {
      positions = [];
      watermark = available;
    } else {
      positions = [query.after + 1];
      watermark = query.after === 30 ? 32 : query.after + 1;
    }
    const after = positions.at(-1) ?? query.after;
    await route
      .fulfill({
        json: {
          entries: await Promise.all(positions.map(event)),
          watermark,
          continuation:
            positions.length && after < watermark
              ? { version: 2, scopeKey, visibility: 'shared', after, watermark }
              : null,
        },
      })
      .catch(() => {}); // The reset deliberately aborts the held response.
  });
  try {
    await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
    await page.getByRole('tab', { name: 'Shared feed', exact: true }).click();
    await expect(page.locator('.groups-event')).toHaveCount(8);
    await page.getByRole('button', { name: 'Read exact original', exact: true }).first().click();
    await expect(page.locator('.groups-original')).toContainText('Exact shared original 1');
    const scroller = page.locator('.groups-feed-scroll');
    const scrollTop = await scroller.evaluate((element) => {
      element.scrollTop = 100;
      return element.scrollTop;
    });
    available = 32;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.groups-event')).toHaveCount(9);
    expect(queries.at(-1)!.after).toBe(30);
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(scrollTop, 0);
    await expect(page.locator('.groups-original')).toContainText('Exact shared original 1');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.groups-event')).toHaveCount(10);
    expect(queries.at(-1)!.after).toBe(31); // Poll continuation must not jump to watermark32.
    await page.getByRole('button', { name: 'Load more events', exact: true }).click();
    await expect(page.locator('.groups-event')).toHaveCount(18);
    expect(queries.find((query) => query.cursor)?.cursor).toMatchObject({
      after: 8,
      watermark: 30,
    });
    await expect(page.locator('.groups-original')).toContainText('Exact shared original 1');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => oldReadStarted).toBe(true);
    reset = true;
    available = 41;
    await page.getByRole('button', { name: 'Refresh shared feed', exact: true }).click();
    await expect(page.locator('.groups-event')).toHaveCount(8);
    releaseOldRead!();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.groups-event')).toHaveCount(9);
    expect(queries.at(-1)!.after).toBe(40);
    await expect(page.getByText('Shared event 33', { exact: true })).toHaveCount(0);
    await expect(page.locator('.groups-feed-panel')).toContainText('Shared event 41');
  } finally {
    releaseOldRead?.();
  }
});
