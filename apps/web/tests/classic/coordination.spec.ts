import { test, expect } from './fixture';

test('attention collects projects without approving or starting work', async ({ page }, info) => {
  let mutations = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      !new URL(request.url()).pathname.startsWith('/api/workspace/')
    )
      mutations++;
  });
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch(),
      state = await response.json();
    state.agents[0].status = 'interrupted';
    await route.fulfill({ json: state });
  });
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: /^Needs your attention/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Needs your attention' });
  await expect(dialog).toContainText('Opening an item never approves');
  await expect(dialog).toContainText('stopped work');
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-attention.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Open conversation' }).first().click();
  await expect(dialog).toHaveCount(0);
  expect(mutations).toBe(0);
});

test('queue pause, work limit and error retry have ordinary app controls', async ({
  page,
}, info) => {
  let settings = { paused: false, maxConcurrent: 4 },
    fail = true;
  const keys: string[] = [];
  await page.route('**/api/scheduler', (route) => route.fulfill({ json: { settings, items: [] } }));
  await page.route('**/api/scheduler/settings', (route) => {
    const body = route.request().postDataJSON();
    keys.push(body.key);
    if (fail) {
      fail = false;
      return route.fulfill({ status: 500, json: { error: 'Could not save. Try again.' } });
    }
    settings = body.settings;
    return route.fulfill({ json: { settings, items: [] } });
  });
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Work queue', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Work queue' });
  await dialog.getByRole('button', { name: 'Pause new work' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not save');
  await dialog.getByRole('button', { name: 'Retry queue change' }).click();
  expect(keys[0]).toBe(keys[1]);
  await expect(dialog).toContainText('New queued work is paused');
  await dialog.getByLabel('Concurrent work groups').selectOption('2');
  await dialog.getByRole('button', { name: 'Save work limit' }).click();
  expect(settings).toEqual({ paused: true, maxConcurrent: 2 });
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-queue.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Resume queued work' }).click();
  expect(settings).toEqual({ paused: false, maxConcurrent: 2 });
  await dialog.getByRole('button', { name: 'Open local compute jobs' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Local video transcription' })).toBeVisible();
});
