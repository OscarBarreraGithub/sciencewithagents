import { expect, test } from '@playwright/test';
import { browserSetupSchema } from '@dock/shared';

test('compact connection controls give retryable native setup without navigating or launching on read', async ({
  page,
}) => {
  let status = browserSetupSchema.parse({
    checkedAt: null,
    checking: false,
    state: 'unchecked',
    nativeTools: false,
    connectedBrowsers: 0,
    message: 'Check browser setup on the selected computer.',
  });
  let attempts = 0;
  await page.route('**/api/browser/setup', (route) => route.fulfill({ json: status }));
  await page.route('**/api/browser/check', (route) => {
    attempts++;
    if (attempts === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'Temporary connection failure. Retry.' },
      });
    status = {
      ...status,
      checkedAt: new Date().toISOString(),
      state: 'connected',
      nativeTools: true,
      connectedBrowsers: 1,
      message: 'One browser connection; sites may still require permission.',
    };
    return route.fulfill({ json: status });
  });
  await page.goto('/#/chats');
  const browser = page.getByRole('button', { name: /^Browser on this computer:/ });
  const editor = page.getByRole('button', { name: /^VS Code on this computer:/ });
  await expect(browser).toBeVisible();
  await expect(editor).toBeVisible();
  expect(attempts).toBe(0);
  const before = await browser.boundingBox();
  expect(before!.height).toBeLessThan(60);
  await browser.click();
  const dialog = page.getByRole('dialog', { name: 'Browser connection' });
  await expect(dialog).toBeVisible();
  expect(attempts).toBe(0);
  await expect(page).toHaveURL(/#\/chats$/);
  const check = dialog.getByRole('button', { name: 'Check browser setup', exact: true });
  await check.click();
  await expect(dialog.getByRole('alert')).toContainText('Temporary connection failure');
  await check.click();
  await expect(dialog.locator('.browser-connection-result')).toContainText('Connected');
  await dialog.locator('summary').filter({ hasText: 'Connect Claude' }).click();
  await expect(dialog).toContainText('does not verify Claude');
  await expect(dialog.getByRole('link', { name: 'Claude browser setup guide' })).toHaveAttribute(
    'href',
    'https://code.claude.com/docs/en/chrome',
  );
  for (const zoom of [1, 2]) {
    await page.evaluate((value) => {
      document.documentElement.style.zoom = String(value);
    }, zoom);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
  });
  await page.screenshot({ path: test.info().outputPath('browser-setup.png') });
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(browser).toContainText('Connected');
  // A later host poll must replace the manual result, including expired observations.
  status = { ...status, state: 'unchecked', message: 'Check again: the observation is stale.' };
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(browser).not.toContainText('Connected');
  expect(attempts).toBe(2);
});
