import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('reviews saved text through failure/retry, empty search pages and full message parts without model sends', async ({
  page,
}) => {
  const managedId = randomUUID(),
    windowId = randomUUID(),
    offlineId = randomUUID();
  const item = {
    source: 'managed',
    recordType: 'entry',
    id: 'original-entry-id',
    agentId: managedId,
    projectId: randomUUID(),
    windowId: null,
    threadId: null,
    provider: 'codex',
    role: 'user',
    title: 'Saved request',
    text: 'Deep retained evidence',
    offset: 25000,
    totalCharacters: 30000,
    nextOffset: 25022,
    href: `#/chat/${managedId}`,
  };
  const writes: string[] = [];
  const searches: Record<string, unknown>[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);
  });
  await page.route('**/api/archive/editors', (route) =>
    route.fulfill({
      json: {
        windows: [
          {
            windowId,
            provider: 'claude',
            threadId: 'native-source',
            label: 'Shared editor',
            title: 'Original VS Code thread',
            status: 'idle',
            message: '',
            paged: true,
            groupedActivity: true,
          },
          {
            windowId: offlineId,
            provider: 'codex',
            threadId: 'offline-thread',
            label: 'Offline editor',
            title: 'Offline saved thread',
            status: 'offline',
            message: '',
          },
        ],
        notice: 'Offline and unshared histories are not searched.',
      },
    }),
  );
  await page.route('**/api/archive/search', async (route) => {
    const input = route.request().postDataJSON();
    searches.push(input);
    if (searches.length === 1) {
      await route.fulfill({
        status: 503,
        json: { error: 'Archive read interrupted; retry this page.' },
      });
      return;
    }
    await route.fulfill({
      json: {
        items: input.cursor ? [item] : [],
        nextCursor: input.cursor ? null : 'older-page',
        complete: !!input.cursor,
        scannedEntries: 40,
        notice: 'Full retained text, paged read-only review.',
      },
    });
  });
  await page.route('**/api/archive/read', async (route) => {
    const input = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ...item,
        text: input.offset
          ? 'Final original message part'
          : 'Original full message ' + 'word '.repeat(1500),
        offset: input.offset ?? 0,
        nextOffset: input.offset ? null : 8000,
      },
    });
  });
  await page.goto('/#/chats');
  await page.getByRole('button', { name: 'Assisted search', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assisted search', exact: true });
  await dialog.getByText('Search saved text', { exact: true }).click();
  await dialog
    .getByRole('textbox', { name: 'Text to find', exact: true })
    .fill('Deep retained evidence');
  await expect(dialog.getByRole('combobox', { name: 'Archive source' })).toContainText(
    'Original VS Code thread',
  );
  expect(searches).toHaveLength(0);
  expect(writes).toEqual([]);
  await dialog.getByRole('button', { name: 'Search text', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Archive read interrupted');
  await expect(dialog.getByRole('textbox', { name: 'Text to find' })).toHaveValue(
    'Deep retained evidence',
  );
  await dialog.getByRole('button', { name: 'Retry this page', exact: true }).click();
  expect(searches[1]).toEqual(searches[0]);
  const results = dialog.getByRole('region', { name: 'Saved text results' });
  await expect(results).toContainText('No matches on this page. Continue');
  await dialog.getByRole('button', { name: 'Next archive page' }).click();
  expect(searches[2]!.cursor).toBe('older-page');
  await expect(results).toContainText('Scan complete');
  await dialog.getByRole('button', { name: 'Read full message', exact: true }).click();
  const message = dialog.getByRole('region', { name: 'Saved message text' });
  await expect(message).toContainText('Original full message');
  await message.getByRole('button', { name: 'Next message part' }).click();
  await expect(message).toContainText('Final original message part');
  await message.getByRole('button', { name: 'Previous message part' }).click();
  await expect(message).toContainText('Original full message');
  await message.getByRole('button', { name: 'Close message' }).click();
  await dialog.getByRole('combobox', { name: 'Archive source' }).selectOption(offlineId);
  await expect(dialog).toContainText('It has not been searched.');
  await expect(dialog.getByRole('button', { name: 'Search text', exact: true })).toBeDisabled();
  await dialog.getByRole('combobox', { name: 'Archive source' }).selectOption(windowId);
  await dialog.getByRole('button', { name: 'Search text', exact: true }).click();
  expect(searches.at(-1)).toMatchObject({
    source: 'editor',
    windowId,
    threadId: 'native-source',
    provider: 'claude',
  });
  expect(
    writes.every((path) => path === '/api/archive/search' || path === '/api/archive/read'),
  ).toBe(true);
  const box = await dialog.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
