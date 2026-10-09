import { expect, test } from '@playwright/test';

// Keep submission inside the browser fixture: this never starts an owner's agent.
test('Help saves a report, retains its receipt across a lost response and reopens the maintenance chat', async ({
  page,
}) => {
  const requests: Record<string, string>[] = [];
  let delivered = false;
  await page.route('**/api/bug-reports', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { items: [] } });
    const input = route.request().postDataJSON();
    requests.push(input);
    if (!delivered) {
      delivered = true;
      return route.fulfill({
        status: 502,
        json: { error: 'Connection interrupted after saving.' },
      });
    }
    return route.fulfill({
      json: {
        ...input,
        id: input.key,
        createdAt: new Date().toISOString(),
        managerId: '11111111-1111-4111-8111-111111111111',
        workItemId: '22222222-2222-4222-8222-222222222222',
        runId: '33333333-3333-4333-8333-333333333333',
        folder: `bug-reports/${input.key}`,
        status: 'open',
        message: 'Queued for the maintenance manager.',
        fileSaved: true,
      },
    });
  });
  await page.goto('/#/work');
  const open = async () => {
    await page.getByRole('button', { name: 'Help and setup', exact: true }).click();
    await page.getByRole('button', { name: 'Ask an agent to fix a problem', exact: true }).click();
  };
  await open();
  const dialog = page.getByRole('dialog', { name: 'Ask an agent to fix a problem', exact: true });
  await expect(dialog).toContainText('private repair request');
  await expect(dialog).toContainText('may use your model allowance');
  await expect(dialog).toContainText('won’t publish the report');
  await dialog
    .getByLabel('What went wrong?')
    .fill('My implementation is blocked by a raw-token cap despite spare allowance.');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await open();
  await expect(dialog.getByLabel('What went wrong?')).toHaveValue(
    'My implementation is blocked by a raw-token cap despite spare allowance.',
  );
  await dialog.getByRole('button', { name: 'Save and assign' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your report is retained');
  await expect(dialog.getByLabel('What went wrong?')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await open();
  await dialog.getByRole('button', { name: 'Retry same report' }).click();
  await expect(dialog.getByRole('heading', { name: 'Report saved' })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].page).toBe('#/work');
  await expect(dialog.getByRole('link', { name: 'Open maintenance chat' })).toHaveAttribute(
    'href',
    '#/chat/11111111-1111-4111-8111-111111111111',
  );
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath('report-saved.png'), fullPage: true });
});
