import { test, expect, type Page } from './fixture';
import type { HistoryItem, Snapshot } from '@dock/shared';

async function openHistory(page: Page) {
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Search saved history', exact: true }).click();
  return page.getByRole('dialog', { name: 'Saved history', exact: true });
}
async function item(page: Page): Promise<HistoryItem> {
  const state = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  return {
    source: 'entry',
    id: 'retained-evidence',
    projectId: state.projects[0].id,
    agentId: state.projects[0].managerId,
    taskId: null,
    runId: null,
    senderId: null,
    kind: 'assistant',
    title: 'Recorded result',
    text: 'A short saved preview',
    status: 'complete',
    createdAt: '2026-09-13T12:00:00.000Z',
    offset: 0,
    totalCharacters: 21,
    nextOffset: null,
  };
}
test('saved history searches and pages source records, then reads all retained text with retry', async ({
  page,
}, info) => {
  const source = await item(page);
  const queries: Record<string, unknown>[] = [];
  let failedRead = false;
  let modelActions = 0;
  const fullText =
    'The original result.\n' + 'Retained evidence '.repeat(500) + '\nEnd of the retained result.';
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(messages|commands|tasks|integrate)$/.test(request.url()))
      modelActions++;
  });
  await page.route('**/api/projects/*/history', (route) => {
    const input = route.request().postDataJSON();
    queries.push(input);
    return route.fulfill({
      json: {
        items: [
          {
            ...source,
            id: input.cursor ? 'older-evidence' : source.id,
            text: input.query ? 'Earlier needle evidence' : source.text,
            title: input.cursor ? 'Older recorded result' : source.title,
          },
        ],
        nextCursor: input.cursor || input.query ? null : 'older-page',
        throughEventId: 42,
        notice: 'Saved evidence only.',
      },
    });
  });
  await page.route('**/api/projects/*/history/read', (route) => {
    if (!failedRead) {
      failedRead = true;
      return route.fulfill({
        status: 500,
        json: { error: 'Could not open this saved item. Try again.' },
      });
    }
    const input = route.request().postDataJSON();
    const offset = input.offset ?? 0;
    return route.fulfill({
      json: {
        ...source,
        text: fullText.slice(offset, offset + 8000),
        offset,
        totalCharacters: fullText.length,
        nextOffset: offset + 8000 < fullText.length ? offset + 8000 : null,
      },
    });
  });
  const dialog = await openHistory(page);
  await dialog.getByRole('button', { name: 'Load older results' }).click();
  await expect(dialog.getByRole('button', { name: 'Read saved item' })).toHaveCount(2);
  await dialog.getByLabel('Find in saved history').fill('needle');
  await dialog.getByLabel('Which records?').selectOption('messages');
  await dialog.getByRole('button', { name: 'Search saved history', exact: true }).click();
  await expect(dialog).toContainText('Earlier needle evidence');
  expect(queries.at(-1)).toMatchObject({ query: 'needle', source: 'messages' });
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-history-search.png` });
  await dialog.getByRole('button', { name: 'Read saved item' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not open');
  await dialog.getByRole('button', { name: 'Try reading again' }).click();
  await expect(dialog).toContainText('The original result.');
  await dialog.getByRole('button', { name: 'Read more of this item' }).click();
  await expect(dialog).toContainText('End of the retained result.');
  await expect(dialog).toContainText(
    `All ${fullText.length.toLocaleString()} retained characters are shown.`,
  );
  await dialog.getByText('Source reference', { exact: true }).click();
  await expect(dialog).toContainText(`entry: ${source.id}`);
  expect(modelActions).toBe(0);
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-history-source.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a failed new history search retains the phrase without reusing an older cursor', async ({
  page,
}) => {
  const source = await item(page);
  let failSearch = true;
  await page.route('**/api/projects/*/history', (route) => {
    const input = route.request().postDataJSON();
    if (input.query && failSearch) {
      failSearch = false;
      return route.fulfill({
        status: 500,
        json: { error: 'Could not search saved records. Try again.' },
      });
    }
    return route.fulfill({
      json: {
        items: input.query ? [] : [source],
        nextCursor: input.query ? null : 'older-page',
        throughEventId: 42,
        notice: 'Saved records only.',
      },
    });
  });
  const dialog = await openHistory(page);
  await expect(dialog.getByRole('button', { name: 'Load older results' })).toBeVisible();
  await dialog.getByLabel('Find in saved history').fill('missing topic');
  await dialog.getByRole('button', { name: 'Search saved history', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not search');
  await expect(dialog.getByLabel('Find in saved history')).toHaveValue('missing topic');
  await expect(dialog.getByRole('button', { name: 'Load older results' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Search saved history', exact: true }).click();
  await expect(dialog).toContainText('No matching saved records');
});
