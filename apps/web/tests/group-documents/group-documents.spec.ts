import { test, expect } from '@playwright/test';
test('scoped grant retry, link bridge and existing Reading at large text retain draft', async ({
  page,
}) => {
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/groups/documents/*/grants', async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'Export acknowledgement lost; retry same request.' },
      });
    return route.fulfill({
      json: {
        grantId: 'eeeb5ab8-e0c3-413b-b763-21f96af596d4',
        version: 'a'.repeat(64),
        visibility: 'private',
        href: '#/groups/document/eeeb5ab8-e0c3-413b-b763-21f96af596d4/' + 'a'.repeat(64),
      },
    });
  });
  await page.goto('/');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Allow selected files and open' }).click();
  await expect(page.getByRole('alert')).toContainText('Export acknowledgement lost');
  await page.getByRole('button', { name: 'Allow selected files and open' }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]?.dependencies).toHaveLength(1);
  expect(requests[0]).not.toHaveProperty('path');
  await page.getByRole('link', { name: 'Open my report' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByTestId('endpoint')).toContainText(
    '/groups/documents/d5ced7dc-df8d-4e94-82b1-a4f97218cd9c/eeeb5ab8-e0c3-413b-b763-21f96af596d4/',
  );
  await page.getByRole('button', { name: 'Larger text' }).click();
  await expect(page.locator('.document-reading')).toHaveCSS('font-size', '30px');
  await expect(page.locator('.katex')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/group-documents-ui/${test.info().project.name}-reading.png`,
  });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep this draft');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
