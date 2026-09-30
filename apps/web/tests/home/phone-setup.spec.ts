import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('first phone setup previews the private address, recovers lost confirmation and reaches pairing', async ({
  page,
}, info) => {
  const original = await (await page.request.get('/api/phone/status')).json();
  const status = {
    ...original,
    configured: false,
    transport: null,
    setupIssue: null,
    enabled: false,
    connection: 'off',
    authentication: 'paired',
    origin: null,
  };
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.route('**/api/phone/status', (route) => route.fulfill({ json: status }));
  let checks = 0;
  const previewId = randomUUID();
  const origin = 'https://my-computer.private-network.ts.net';
  await page.route('**/api/phone/setup/check', (route) =>
    route.fulfill({
      json:
        ++checks === 1
          ? {
              state: 'https',
              message: 'Enable HTTPS certificates in Tailscale, then check again.',
              origin,
              previewId: null,
            }
          : {
              state: 'ready',
              message: 'This computer is ready for a private phone connection.',
              origin,
              previewId,
            },
    }),
  );
  await page.route('**/api/phone/setup/confirm', (route) => {
    expect(route.request().postDataJSON()).toEqual({
      key: expect.any(String),
      previewId,
      confirm: true,
    });
    Object.assign(status, { configured: true, transport: 'tailscale', origin });
    return route.abort('failed');
  });
  await page.route('**/api/phone/enabled', (route) => {
    expect(route.request().postDataJSON()).toEqual({ enabled: true });
    Object.assign(status, { enabled: true, connection: 'connected' });
    return route.fulfill({ json: status });
  });
  await page.goto('/#/phone');
  await expect(
    page.getByRole('heading', { name: 'Bring your workspace to your phone.' }),
  ).toBeVisible();
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/screenshots/phone-setup/${info.project.name}-choose.png`,
  });
  await page.getByRole('button', { name: 'Check this computer', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open Tailscale HTTPS settings' })).toHaveAttribute(
    'href',
    'https://login.tailscale.com/admin/dns',
  );
  await expect(page.getByRole('button', { name: 'Use this private address' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(page.locator('.phone-setup-result code')).toHaveText(origin);
  await page.getByRole('button', { name: 'Use this private address' }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/screenshots/phone-setup/${info.project.name}-preview.png`,
  });
  await page.getByRole('button', { name: 'Use this private address' }).click();
  await expect(page.getByRole('button', { name: 'Turn on phone access' })).toBeVisible();
  expect(writes.filter((url) => url.endsWith('/phone/setup/confirm'))).toHaveLength(1);
  await page.getByRole('button', { name: 'Turn on phone access' }).click();
  await expect(page.getByText('Your phone connection is ready.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create a new code', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Create a new code', exact: true })).toBeVisible();
  expect(writes.filter((url) => url.includes('/phone/setup/'))).toHaveLength(3);
});

test('existing connections retain their settings and listener failure retries inside the app', async ({
  page,
}) => {
  const original = await (await page.request.get('/api/phone/status')).json();
  const status = {
    ...original,
    configured: true,
    transport: 'cloudflare',
    setupIssue: 'listener',
    enabled: false,
    connection: 'error',
    origin: 'https://phone.example.test',
  };
  await page.route('**/api/phone/status', (route) => route.fulfill({ json: status }));
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.route('**/api/phone/reconnect', (route) => {
    Object.assign(status, { setupIssue: null, connection: 'off' });
    return route.fulfill({ json: status });
  });
  await page.goto('/#/phone');
  await expect(page.getByRole('alert')).toContainText('could not start');
  await expect(page.getByRole('button', { name: 'Check this computer', exact: true })).toHaveCount(
    0,
  );
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Turn on phone access' })).toBeVisible();
  expect(writes).toEqual([expect.stringContaining('/phone/reconnect')]);
  expect(status.origin).toBe('https://phone.example.test');
});
