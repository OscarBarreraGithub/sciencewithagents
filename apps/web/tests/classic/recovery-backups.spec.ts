import { test, expect } from './fixture';

async function openCopies(page: import('@playwright/test').Page) {
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Recovery copies', exact: true }).click();
  return page.getByRole('dialog', { name: 'Recovery copies', exact: true });
}

test('recovery copies explain scope, make a real checked snapshot, and survive view reload', async ({
  page,
}, testInfo) => {
  const dialog = await openCopies(page);
  await expect(dialog).toContainText(
    'Stored on this computer, not on GitHub or another backup drive',
  );
  await dialog.getByRole('button', { name: 'Create recovery copy', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('passed the database integrity check');
  await expect(dialog.locator('.recovery-copy > summary').first()).toContainText(
    'Verified recovery copy',
  );
  await dialog.locator('.recovery-copy > summary').first().click();
  await page.screenshot({ path: `../../data/recovery-ui-${testInfo.project.name}.png` });
  await dialog.getByRole('button', { name: 'Check this copy', exact: true }).first().click();
  await expect(dialog.getByRole('status')).toContainText('matches its original bytes');
  for (const summary of [
    'What is included?',
    'Protect against losing this computer',
    'How do I restore a copy?',
  ])
    await dialog.getByText(summary, { exact: true }).click();
  await expect(dialog).toContainText('No messages or uncertain work should be replayed');
  await expect(dialog).toContainText('No copy is deleted automatically');
  await expect(dialog).toContainText('VS Code chat transcripts');
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Recovery copies', exact: true }).click();
  await expect(dialog.locator('.recovery-copy > summary').first()).toContainText(
    'Verified recovery copy',
  );
});

test('failed first load and an uncertain copy response stay visible and retry one durable request', async ({
  page,
}) => {
  let statusReads = 0,
    requests = 0;
  const keys: string[] = [];
  let saved: object | null = null;
  await page.route('**/api/recovery-backups', async (route) => {
    if (route.request().method() === 'GET') {
      statusReads++;
      if (statusReads === 1)
        return route.fulfill({ status: 500, json: { error: 'Fixture read failure' } });
      return route.fulfill({ json: { copies: saved ? [saved] : [], creating: false } });
    }
    requests++;
    const body = route.request().postDataJSON();
    expect(Object.keys(body)).toEqual(['key']);
    keys.push(body.key);
    if (requests === 1) return route.abort('failed');
    saved = {
      id: body.key,
      state: 'verified',
      createdAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      sizeBytes: 4096,
      counts: { projects: 1, conversations: 1, entries: 2, images: 0 },
      message: 'Saved on this computer and passed the database integrity check.',
    };
    await route.fulfill({ json: saved });
  });
  const dialog = await openCopies(page);
  await expect(dialog.getByRole('alert')).toContainText('Could not read recovery copies');
  await dialog.getByRole('button', { name: 'Refresh list' }).click();
  await expect(dialog).toContainText('No recovery copies yet');
  await dialog.getByRole('button', { name: 'Create recovery copy' }).click();
  await expect(dialog.getByRole('alert')).toContainText('will not create a duplicate');
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('passed the database integrity check');
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(1);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});
