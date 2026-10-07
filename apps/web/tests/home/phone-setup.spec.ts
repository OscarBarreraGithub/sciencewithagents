import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { PhoneStatus } from '@dock/shared';

async function expectPhoneLayout(page: Page) {
  const geometry = await page.locator('.phone-settings').evaluate((settings) => {
    const bounds = settings.getBoundingClientRect();
    const pageBounds = settings.closest('.flow-page')!.getBoundingClientRect();
    const content = document.querySelector('.home-content')!;
    const problems: string[] = [];
    for (const panel of settings.querySelectorAll('.phone-settings-panel')) {
      const card = panel.getBoundingClientRect();
      for (const item of panel.querySelectorAll('h3, p, button, fieldset, svg')) {
        const rect = item.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        if (rect.left < card.left + 10 || rect.right > card.right - 10)
          problems.push(`${item.tagName}: outside card padding`);
        if (item.tagName === 'BUTTON' && rect.height < 43.9)
          problems.push(`${item.textContent}: small touch target`);
      }
    }
    return {
      width: bounds.width,
      pageWidth: pageBounds.width,
      content: content.scrollWidth,
      available: content.clientWidth,
      problems,
    };
  });
  expect(geometry.width).toBeCloseTo(geometry.pageWidth, 0);
  expect(geometry.content).toBeLessThanOrEqual(geometry.available + 1);
  expect(geometry.problems).toEqual([]);
}

test('first phone setup copies the owner Cloudflare prompt, retries checks and reaches pairing', async ({
  page,
}, info) => {
  const original = await (await page.request.get('/api/phone/status')).json();
  const status: PhoneStatus = {
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
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copiedSetupPrompt = text;
        },
      },
    });
  });
  await page.route('**/api/phone/status', (route) => route.fulfill({ json: status }));
  await page.route('**/api/phone/enabled', (route) => {
    expect(route.request().postDataJSON()).toEqual({ enabled: true });
    Object.assign(status, { enabled: true, connection: 'connected' });
    return route.fulfill({ json: status });
  });
  await page.goto('/#/phone');
  await expect(page.getByRole('heading', { name: 'Set up a phone connection' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your to-do list' })).toBeVisible();
  await expect(page.locator('.phone-connection-setup')).toContainText(
    'your own Cloudflare account',
  );
  await expect(page.locator('.phone-connection-setup')).not.toContainText('Tailscale');
  await expect(page.getByRole('radio')).toHaveCount(0);
  expect(writes).toEqual([]);
  await expectPhoneLayout(page);
  await page.screenshot({
    path: `../../data/screenshots/phone-setup/${info.project.name}-cloudflare.png`,
  });
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  await expectPhoneLayout(page);
  await page.evaluate(() => (document.documentElement.style.fontSize = ''));
  const prompt = page.locator('.phone-connection-setup .setup-prompt');
  await expect(prompt).toContainText('MY OWN Cloudflare account');
  await expect(prompt).toContainText('Workers Free');
  await expect(prompt).toContainText('stable free workers.dev address');
  await expect(prompt).toContainText('I do not need to own or buy a domain');
  await expect(prompt).toContainText('docs/CLOUDFLARE_SETUP.md');
  await expect(prompt).toContainText(
    'Never expose the local owner/development listener on port 4330',
  );
  await prompt.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(prompt.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect(await page.locator('html').getAttribute('data-copied-setup-prompt')).toBe(
    await prompt.locator('pre').textContent(),
  );
  await page.getByRole('button', { name: 'Check phone setup', exact: true }).click();
  await expect(page.locator('.phone-connection-setup')).toContainText(
    'Cloudflare setup is not ready yet',
  );
  expect(writes).toEqual([]);

  // The external setup agent has saved the private config and safely relaunched the app.
  Object.assign(status, {
    configured: true,
    transport: 'cloudflare',
    origin: 'https://phone.example.test',
  });
  await page.getByRole('button', { name: 'Check phone setup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Turn on phone access' })).toBeVisible();
  await page.getByRole('button', { name: 'Turn on phone access' }).click();
  await expect(page.getByText('Your phone connection is ready.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create a new code', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Create a new code', exact: true })).toBeVisible();
  expect(writes).toEqual([expect.stringContaining('/phone/enabled')]);
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

test('phone panels fill the page, reflow with larger text and preserve pairing and device controls', async ({
  page,
}, info) => {
  const original = await (await page.request.get('/api/phone/status')).json();
  const status: PhoneStatus = {
    ...original,
    configured: true,
    transport: 'cloudflare',
    setupIssue: null,
    enabled: true,
    connection: 'connected',
    authentication: 'paired',
    origin: 'https://phone.example.test',
    devices: Array.from({ length: 8 }, (_, i) => ({
      id: randomUUID(),
      name: i === 0 ? 'My phone with a long device name' : `Phone ${i + 1}`,
      createdAt: new Date().toISOString(),
      revokedAt: null,
      expiresAt: null,
    })),
  };
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);
  });
  await page.clock.install();
  await page.route('**/api/phone/status', (route) => route.fulfill({ json: status }));
  await page.route('**/api/phone/code', (route) => {
    status.enrollmentOpen = true;
    return route.fulfill({
      json: {
        code: 'ABCD-EFGH-JKLM-NPQR',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        origin: status.origin,
      },
    });
  });
  await page.route('**/api/phone/confirm', (route) => {
    expect(route.request().postDataJSON()).toEqual({
      id: status.pending!.id,
      confirmation: status.pending!.confirmation,
    });
    status.pending = null;
    status.enrollmentOpen = false;
    return route.fulfill({ json: status });
  });
  const firstDevice = status.devices[0]!;
  await page.route(`**/api/phone/devices/${firstDevice.id}/revoke`, (route) => {
    firstDevice.revokedAt = new Date().toISOString();
    return route.fulfill({ json: status });
  });
  await page.route('**/api/phone/enabled', (route) => {
    status.enabled = route.request().postDataJSON().enabled;
    status.connection = status.enabled ? 'connected' : 'off';
    return route.fulfill({ json: status });
  });
  await page.goto('/#/phone');
  const pairing = page.getByRole('region', { name: 'Pair a phone', exact: true });
  const devices = page.getByRole('region', { name: 'Connected devices', exact: true });
  await expect(pairing).toContainText('Pairing is closed');
  expect(writes).toEqual([]);
  await expectPhoneLayout(page);
  const pairBox = (await pairing.boundingBox())!;
  const devicesBox = (await devices.boundingBox())!;
  if (page.viewportSize()!.width >= 1200) {
    expect(devicesBox.x).toBeGreaterThan(pairBox.x + pairBox.width);
    expect(devicesBox.y).toBeCloseTo(pairBox.y, 0);
  } else if (page.viewportSize()!.width <= 500) {
    expect(devicesBox.y).toBeGreaterThan(pairBox.y + pairBox.height);
    expect(devicesBox.x).toBeCloseTo(pairBox.x, 0);
  }
  const list = devices.getByRole('list');
  const listSize = await list.evaluate((el) => ({
    visible: el.clientHeight,
    all: el.scrollHeight,
  }));
  expect(listSize.all).toBeGreaterThan(listSize.visible);
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(list.getByText('Phone 8', { exact: true })).toBeVisible();
  await list.evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: info.outputPath('phone-panels.png') });
  await pairing.getByRole('button', { name: 'Create a new code', exact: true }).click();
  await expect(pairing.getByRole('link', { name: 'Open phone pairing' })).toHaveAttribute(
    'href',
    'https://phone.example.test/#pair=ABCD-EFGH-JKLM-NPQR',
  );
  await expectPhoneLayout(page);
  await pairing.screenshot({ path: info.outputPath('pairing-card.png') });
  await page.locator('.home-content').evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: info.outputPath('phone-qr.png') });
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  await expectPhoneLayout(page);
  await page.screenshot({ path: info.outputPath('phone-large-text.png') });
  await page.evaluate(() => (document.documentElement.style.fontSize = ''));
  status.pending = { id: randomUUID(), name: 'A new phone', confirmation: '123456' };
  await page.clock.fastForward(3000);
  await expect(pairing).toContainText('123456');
  await expect(pairing.locator('.phone-qr')).toHaveCount(0);
  await pairing.getByRole('button', { name: 'Confirm this phone', exact: true }).click();
  await expect(pairing).toContainText('Pairing is closed');
  await devices.getByRole('button', { name: 'Remove device', exact: true }).first().click();
  await expect(devices.getByText(firstDevice.name, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Turn off phone access', exact: true }).click();
  await expect(pairing).toHaveCount(0);
  await page.getByRole('button', { name: 'Turn on phone access', exact: true }).click();
  await expect(devices.getByRole('listitem')).toHaveCount(7);
  expect(writes).toEqual([
    '/api/phone/code',
    '/api/phone/confirm',
    `/api/phone/devices/${firstDevice.id}/revoke`,
    '/api/phone/enabled',
    '/api/phone/enabled',
  ]);
});

test('paired phone shows readable installation help without computer-only controls', async ({
  page,
}, info) => {
  const original = await (await page.request.get('/api/phone/status')).json();
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.route('**/api/phone/status', (route) =>
    route.fulfill({
      json: {
        ...original,
        mode: 'remote',
        configured: true,
        enabled: true,
        paired: true,
        enrolled: true,
        setupComplete: true,
        authentication: 'paired',
        connection: 'connected',
        origin: 'https://phone.example.test',
      },
    }),
  );
  await page.goto('/#/phone');
  await expect(
    page.getByRole('heading', { name: 'Add sciencewithagents to your device' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create a new code' })).toHaveCount(0);
  await page.getByText('On a laptop or desktop', { exact: true }).click();
  await expect(page.getByText('Share → Add to Dock', { exact: true })).toBeVisible();
  await expect(
    page.getByText('⋮ → Cast, save and share → Install page as app', { exact: true }),
  ).toBeVisible();
  await expectPhoneLayout(page);
  await page.screenshot({ path: info.outputPath('phone-installation.png') });
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  await expectPhoneLayout(page);
  await page.getByText('Still seeing the old app icon?', { exact: true }).click();
  await expect(page.getByText(/Open the new shortcut and check/)).toBeVisible();
  expect(writes).toEqual([]);
});
