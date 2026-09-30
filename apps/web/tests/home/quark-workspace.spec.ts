import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
test('QUARK shows chat entry, real queue columns and forecasts without starting a model on open', async ({
  page,
}, info) => {
  let starts = 0;
  page.on('request', (r) => {
    if (r.url().includes('/coordinator/start')) starts++;
  });
  await page.goto('/#/work');
  await expect(page.getByRole('heading', { name: 'QUARK' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Talk to QUARK', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open QUARK conversation' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Waiting', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Paused / needs input', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Waiting', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Active work', exact: true }).click();
  await expect(page.getByText('Shared reserve', { exact: true })).toBeVisible();
  expect(starts).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('../../data/screenshots/quark-board', { recursive: true });
  await page
    .locator('.home-content')
    .evaluate((el) => {
      el.scrollTop = 0;
    })
    .catch(() => {});
  await page.getByRole('heading', { name: 'QUARK' }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `../../data/screenshots/quark-board/${info.project.name}.png`,
    fullPage: true,
  });
});
test('usage opens provider actions with explicit connection and update results', async ({
  page,
}) => {
  let updates = 0;
  await page.route('**/api/providers/update', async (route) => {
    updates++;
    await route.fulfill({
      json: {
        provider: 'codex',
        state: 'current',
        message: 'Up to date · 1.2.3',
        before: '1.2.3',
        after: '1.2.3',
        checkedAt: new Date().toISOString(),
        command: null,
      },
    });
  });
  await page.goto('/');
  const card = page.locator('.home-usage-codex');
  await card.locator('summary').first().click();
  await expect(card.getByRole('button', { name: 'Refresh usage' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Check connection', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Check & install updates' }).click();
  await expect(card.getByRole('status')).toContainText('Up to date');
  expect(updates).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
