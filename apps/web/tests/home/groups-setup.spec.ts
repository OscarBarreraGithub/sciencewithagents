import { expect, test } from '@playwright/test';

test('fresh Groups shows creator-owned Cloudflare prompts, human steps and copyable join/phone/GitHub setup', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as Window & { copiedSetupPrompt?: string }).copiedSetupPrompt = text;
        },
      },
    });
  });
  await page.route('**/api/groups', (route) =>
    route.fulfill({
      json: {
        groups: [],
        service: {
          configured: false,
          message: 'Use your own Cloudflare creator setup.',
          setupCodeRequired: false,
        },
        native: {
          available: false,
          productionReady: false,
          authState: 'unavailable',
          message: 'Enable local agents after joining.',
        },
      },
    }),
  );
  await page.goto('/#/groups');
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
  const setup = page
    .locator('.group-host-status')
    .filter({ hasText: 'Set up Groups with your agent' });
  await expect(setup).toHaveAttribute('open', '');
  await expect(setup).toContainText('The creator hosts Groups in their own Cloudflare account.');
  await expect(setup).toContainText('Your human checklist');
  await page.getByRole('button', { name: 'Copy Cloudflare setup prompt', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { copiedSetupPrompt?: string }).copiedSetupPrompt),
    )
    .toContain('MY OWN Cloudflare account');
  for (const [summary, button, expected] of [
    [
      '2. Member: join the creator’s service',
      'Copy join setup prompt',
      "creator's exact HTTPS service",
    ],
    ['3. Phone: your own Cloudflare Tunnel', 'Copy phone setup prompt', 'Cloudflare'],
    [
      '4. GitHub for shared code and files (optional)',
      'Copy GitHub setup prompt',
      'GitHub is not required',
    ],
  ]) {
    await page.getByText(summary!, { exact: true }).click();
    await page.getByRole('button', { name: button!, exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as Window & { copiedSetupPrompt?: string }).copiedSetupPrompt),
      )
      .toContain(expected!);
  }
  await expect(page.getByLabel('Beta setup code', { exact: true })).toHaveCount(0);
  expect(await setup.textContent()).not.toContain('Tailscale');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width + 2,
  );
  await page.reload();
  await expect(page.getByLabel('Cloudflare Groups setup prompt')).toBeVisible();
});

test('configured Groups keeps setup prompts available and collapsed above projects', async ({
  page,
}) => {
  await page.route('**/api/groups', (route) =>
    route.fulfill({
      json: {
        groups: [],
        service: {
          configured: true,
          message: 'Creator service configured.',
          setupCodeRequired: false,
        },
        native: {
          available: false,
          productionReady: false,
          authState: 'unavailable',
          message: 'Local setup.',
        },
      },
    }),
  );
  await page.goto('/#/groups');
  const setup = page
    .locator('.group-host-status')
    .filter({ hasText: 'Set up Groups with your agent' });
  await expect(page.getByText('Creator service configured.', { exact: true })).toBeAttached();
  await expect(setup).not.toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeVisible();
  await page.getByText('Set up Groups with your agent', { exact: true }).click();
  await expect(page.getByLabel('Cloudflare Groups setup prompt')).toBeVisible();
});
