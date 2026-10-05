import { test, expect } from '@playwright/test';

test('old usage links open QUARK with no separate accounting or cache screen', async ({ page }) => {
  await page.goto('/#/usage');
  await expect(page).toHaveURL(/#\/work$/);
  await expect(page.getByRole('heading', { name: 'QUARK', exact: true })).toBeVisible();
  for (const name of ['Usage and allowances', 'Tokens by agent', 'Context cache settings'])
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  await expect(page.locator('a[href^="#/usage"]')).toHaveCount(0);
  const state = await (await page.request.get('/api/snapshot')).json();
  const task = state.tasks[0];
  await page.goto(`/#/usage/${task.id}`);
  await expect(page).toHaveURL(new RegExp(`#/work/${task.id}$`));
  await expect(page.locator(`#quark-task-${task.id}`)).toBeAttached();
  await page.goto('/#/settings');
  const quark = page
    .getByRole('navigation', { name: 'Main navigation', includeHidden: true })
    .getByRole('link', { name: 'QUARK', exact: true, includeHidden: true });
  await expect(quark).toHaveAttribute('href', '#/work');
  await expect(page.locator('a[href^="#/usage"]')).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 0) > 700) await expect(quark).toBeVisible();
  else {
    // Phones hide the header navigation; QUARK is one step away on Home.
    await expect(quark).toBeHidden();
    await page.getByRole('link', { name: 'sciencewithagents home', exact: true }).click();
    await expect(page.locator('.overview-destinations a[href="#/work"]')).toBeVisible();
  }
});

test('QUARK shows remaining allowances, reset times and connection recovery in plain language', async ({
  page,
}, info) => {
  const now = new Date().toISOString();
  await page.route('**/api/quark/coordinator', async (route) => {
    const body = await (await route.fetch()).json();
    const provider = body.capacity.find((p: { provider: string }) => p.provider === 'claude');
    provider.stale = true;
    provider.state = 'error';
    provider.observedAt = now;
    provider.nextRefreshAt = new Date(Date.now() + 600_000).toISOString();
    provider.windows = [
      {
        id: 'primary',
        label: 'Session',
        scope: 'general',
        model: null,
        usedPercent: 19,
        windowMinutes: 300,
        resetsAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    ];
    provider.message =
      'Claude is limiting usage checks. This does not mean your model allowance is exhausted. The shared collector will retry automatically.';
    await route.fulfill({ json: body });
  });
  await page.goto('/#/work');
  const allowance = page.locator('.quark-account').filter({ hasText: 'Claude' });
  await expect(allowance).toContainText('81% left');
  await expect(allowance).toContainText('Resets in');
  await expect(allowance).toContainText('Last reading');
  await allowance.locator('summary').click();
  await expect(allowance).toContainText('does not mean your model allowance is exhausted');
  await expect(allowance).toContainText('Next automatic check');
  await expect(allowance.getByRole('button', { name: 'Refresh usage', exact: true })).toBeVisible();
  await expect(
    allowance.getByRole('button', { name: 'Check connection', exact: true }),
  ).toBeVisible();
  await expect(allowance.getByRole('button', { name: 'Check & install updates' })).toBeVisible();
  await allowance.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('quark-allowance.png') });
});

test('QUARK reading failures recover without starting model work', async ({ page }) => {
  let reads = 0,
    writes = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/') && r.method() === 'POST') writes++;
  });
  await page.route('**/api/quark/coordinator', async (route) => {
    if (++reads === 1) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    return route.fulfill({ response: await route.fetch() });
  });
  await page.goto('/#/work');
  await expect(page.getByRole('heading', { name: 'QUARK could not connect' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project usage rates' })).toBeVisible();
  expect(writes).toBe(0);
});
