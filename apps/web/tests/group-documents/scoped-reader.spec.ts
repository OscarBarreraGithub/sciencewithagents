import { test, expect } from '@playwright/test';
test('native scoped report controls exclude personal Library and host-path link handlers', async ({
  page,
}) => {
  const forbidden: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/(documents|chat-files|chat-images)(\/|\?)/.test(request.url()))
      forbidden.push(request.url());
  });
  await page.route('**/api/groups/reports', (route) =>
    route.fulfill({
      json: {
        kind: 'list',
        entries: [
          {
            key: {
              publicationId: 'eeeb5ab8-e0c3-413b-b763-21f96af596d4',
              manifestHash: 'b'.repeat(64),
            },
            manifest: { title: 'Exact shared report', files: [{ bytes: 64 }] },
          },
        ],
        next: null,
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Personal report', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Host report', exact: true })).toHaveCount(0);
  await expect(page.getByText('Personal report', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Web reference', exact: true })).toHaveAttribute(
    'href',
    'https://example.com/research',
  );
  await expect(page.getByRole('link', { name: 'Scoped report', exact: true })).toBeVisible();
  await page.getByText('Browse earlier shared reports', { exact: true }).click();
  await page.getByRole('button', { name: 'Find shared reports' }).click();
  await expect(page.getByRole('button', { name: 'Exact shared report' })).toBeVisible();
  expect(forbidden).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
