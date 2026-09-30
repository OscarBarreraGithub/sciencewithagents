import { test, expect } from './fixture';

test('source backup status distinguishes local work from GitHub and offers a bounded retry', async ({
  page,
}) => {
  let saved = false,
    retries = 0;
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.backups = snapshot.projects.map((project: { id: string }) => ({
      projectId: project.id,
      configured: true,
      state: saved ? 'saved' : 'needs_attention',
      commit: 'a'.repeat(40),
      checkedAt: new Date().toISOString(),
      message: saved
        ? 'Verified source checkpoint backed up to private GitHub.'
        : 'GitHub backup needs attention. Local work is safe.',
    }));
    await route.fulfill({ json: snapshot });
  });
  await page.route('**/api/projects/*/backup/retry', async (route) => {
    retries++;
    expect(Object.keys(route.request().postDataJSON())).toEqual(['key']);
    saved = true;
    await route.fulfill({ json: { queued: true } });
  });
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await expect(page.locator('.backup-status')).toContainText('Local work is safe');
  await page.getByRole('button', { name: 'Retry source backup' }).click();
  await expect(page.locator('.backup-status')).toContainText('backed up to private GitHub');
  await expect(page.getByRole('button', { name: 'Retry source backup' })).toHaveCount(0);
  expect(retries).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
