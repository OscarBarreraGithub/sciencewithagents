import { expect, test } from '@playwright/test';

test('Groups detects external setup without leaving, recovers a failed refresh and preserves form entries', async ({
  page,
}) => {
  await page.clock.install();
  let configured = false;
  let unavailable = false;
  let reads = 0;
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/groups'))
      writes.push(request.url());
  });
  await page.route('**/api/groups', (route) => {
    reads++;
    return unavailable
      ? route.fulfill({ status: 503, json: { error: 'Reconnecting to this computer.' } })
      : route.fulfill({
          json: {
            groups: [],
            service: {
              configured,
              message: configured ? 'Creator service configured.' : 'Setup needed.',
              setupCodeRequired: false,
            },
            native: {
              available: false,
              productionReady: false,
              authState: 'unavailable',
              message: 'No model started.',
            },
          },
        });
  });
  await page.goto('/#/groups');
  const setup = page
    .locator('.group-host-status')
    .filter({ hasText: 'Set up Groups with your agent' });
  await expect(setup).toHaveAttribute('open', '');
  expect(
    await page
      .getByRole('button', { name: 'Join by invitation', exact: true })
      .evaluate((button) => button.getBoundingClientRect().bottom),
  ).toBeLessThan(await setup.evaluate((panel) => panel.getBoundingClientRect().top));
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Amina');
  await page.getByLabel('Project name', { exact: true }).fill('Research group');
  unavailable = true;
  await page.clock.fastForward(5100);
  await expect(page.getByRole('alert')).toContainText('Reconnecting');
  unavailable = false;
  configured = true;
  await page.clock.fastForward(5100);
  await expect(setup).not.toHaveAttribute('open', '');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Your display name', { exact: true })).toHaveValue('Amina');
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Research group');
  const readyReads = reads;
  await page.clock.fastForward(16000);
  expect(reads).toBe(readyReads);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => reads).toBe(readyReads + 1);
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Back to groups', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeVisible();
});

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

test('configured Groups keeps setup prompts available and collapsed below projects', async ({
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

test('invalid invitation can be corrected while uncertain joins keep their retry identity', async ({
  page,
}) => {
  await page.route('**/api/groups', (route) =>
    route.fulfill({
      json: {
        groups: [],
        service: { configured: true, message: 'Ready.', setupCodeRequired: false },
        native: {
          available: false,
          productionReady: false,
          authState: 'unavailable',
          message: 'No model.',
        },
      },
    }),
  );
  const keys: string[] = [];
  await page.route('**/api/groups/join', (route) => {
    keys.push(route.request().postDataJSON().key);
    return route.fulfill(
      keys.length === 1
        ? {
            status: 400,
            json: { code: 'INVALID_INVITATION', error: 'Use the correct service invitation.' },
          }
        : {
            status: 503,
            json: {
              code: 'GROUP_SERVICE_UNAVAILABLE',
              error: 'Service unavailable. Retry this request.',
            },
          },
    );
  });
  await page.goto('/#/groups');
  await page.getByRole('button', { name: 'Join by invitation', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Li Ming');
  await page
    .getByLabel('Invitation link', { exact: true })
    .fill('https://groups.example.test/incorrect');
  const send = page.getByRole('button', { name: 'Request to join', exact: true });
  await send.click();
  await expect(page.getByRole('alert')).toHaveText('Use the correct service invitation.');
  await page
    .getByLabel('Invitation link', { exact: true })
    .fill('https://groups.example.test/corrected');
  await send.click();
  await expect(page.getByRole('alert')).toHaveText('Service unavailable. Retry this request.');
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
  await send.click();
  await expect.poll(() => keys.length).toBe(3);
  expect(keys[1]).toBe(keys[2]);
  await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toHaveCount(0);
});
