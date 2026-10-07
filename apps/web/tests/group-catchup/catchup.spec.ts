import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
test('explicit paged acknowledgement, lost-ack retry, reload snapshot and private source queries', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.request.post('/__test/control', {
    data: { reset: true, offline: false, loseAck: false },
  });
  await expect(page.getByRole('heading', { name: 'Private catch-up' })).toBeFocused();
  await page.getByRole('button', { name: 'Read since my last acknowledgement' }).click();
  await expect(page.getByRole('status')).toContainText('Positions 1–8');
  await expect(page.getByRole('button', { name: 'Continue catch-up' })).toBeDisabled();
  await mkdir(resolve('../../data/group-catchup-ui/screenshots'), { recursive: true });
  await page.screenshot({
    path: resolve(`../../data/group-catchup-ui/screenshots/${testInfo.project.name}-reading.png`),
    fullPage: true,
  });
  expect(await page.locator('body').textContent()).not.toContain('PRIVATE ASIDE CANARY');
  await page.getByRole('button', { name: 'Read exact original' }).first().click();
  await expect(page.getByLabel('Exact original')).toContainText('Keep exact whitespace');
  await page.getByText('Original IDs and evidence', { exact: true }).first().click();
  await expect(page.locator('dl').first()).toContainText('Unknown: no verified causal edge');
  await page.request.post('/__test/control', { data: { loseAck: true } });
  await page.getByRole('button', { name: 'Mark this page read' }).click();
  await expect(page.getByRole('alert')).toContainText('lost acknowledgement');
  await page.getByRole('button', { name: 'Mark this page read' }).click();
  await expect(page.getByRole('button', { name: 'Continue catch-up' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue catch-up' }).click();
  await expect(page.getByRole('status')).toContainText('Positions 9–16');
  await page.reload();
  await page.getByRole('button', { name: 'Read since my last acknowledgement' }).click();
  await expect(page.getByRole('status')).toContainText('Positions 9–16');
  await page.getByLabel('Question', { exact: true }).selectOption('file_changes');
  await page.getByLabel('Exact group file path').fill('src/river.ts');
  await page.request.post('/__test/control', { data: { loseQuery: true } });
  await page.getByRole('button', { name: 'Query evidence', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('lost private query response');
  await page.reload();
  await page.getByRole('button', { name: 'Resume saved evidence query' }).click();
  await expect(page.getByLabel('Private evidence result')).toContainText('indexed shared evidence');
  await expect(page.getByRole('button', { name: 'Continue evidence query' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue evidence query' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Resume saved evidence query' }).click();
  await expect(page.getByLabel('Private evidence result')).toContainText(
    'Indexed shared sources through position 37',
  );
  await page.getByRole('button', { name: 'Read since my last acknowledgement' }).click();
  for (const end of [16, 24, 32, 37]) {
    await expect(page.getByRole('status')).toContainText(`–${end}`);
    await page.getByRole('button', { name: 'Mark this page read' }).click();
    if (end < 37) await page.getByRole('button', { name: 'Continue catch-up' }).click();
  }
  await page.getByRole('button', { name: 'Check for newer changes' }).click();
  await expect(page.getByRole('status')).toContainText('No new shared events through position 37');
  await page.getByLabel('Question', { exact: true }).selectOption('unresolved');
  await page.getByRole('button', { name: 'Query evidence', exact: true }).click();
  await expect(page.getByLabel('Private evidence result')).toContainText('Blocker');
  await page
    .getByLabel('Private evidence result')
    .getByText('Original IDs and evidence', { exact: true })
    .first()
    .click();
  await expect(page.getByLabel('Private evidence result')).toContainText('group-action:');
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '150%';
  });
  await page.getByRole('button', { name: 'Resume saved evidence query' }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await mkdir(resolve('../../data/group-catchup-ui/screenshots'), { recursive: true });
  await page.screenshot({
    path: resolve(`../../data/group-catchup-ui/screenshots/${testInfo.project.name}.png`),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
