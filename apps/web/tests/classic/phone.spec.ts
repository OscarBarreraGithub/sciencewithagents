import { test, expect } from './fixture';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';

test('terminal reconnect preserves the view without replaying input or taking control automatically', async ({
  page,
}, info) => {
  let connections = 0;
  const inputs: string[] = [];
  let disconnect = (_code: number) => {};
  let fail = () => {};
  await page.routeWebSocket('**/api/agents/*/terminal', (socket) => {
    connections++;
    socket.send(JSON.stringify({ type: 'ready' }));
    socket.send(JSON.stringify({ type: 'output', data: 'Saved terminal output\r\n' }));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'input') inputs.push(message.data);
    });
    disconnect = (code) => socket.close({ code });
    fail = () => {
      socket.send(
        JSON.stringify({
          type: 'error',
          message: 'Send a first message before opening the terminal.',
        }),
      );
      socket.close({ code: 1000 });
    };
  });
  let closeCalls = 0;
  await page.route('**/api/agents/*/terminal/close', (route) => {
    closeCalls++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Native terminal', exact: true }).click();
  await expect(page.locator('.terminal-bar')).toContainText('Native Codex · connected');
  await page.locator('.terminal-keys').getByRole('button', { name: 'Esc', exact: true }).click();
  await expect.poll(() => inputs.length).toBe(1);
  disconnect(1001);
  const reconnect = page.getByRole('button', { name: 'Reconnect terminal', exact: true });
  await expect(reconnect).toBeVisible();
  await expect(
    page.locator('.terminal-keys').getByRole('button', { name: 'Enter', exact: true }),
  ).toBeDisabled();
  expect(connections).toBe(1);
  await page.screenshot({
    path: `../../data/screenshots/${info.project.name}-terminal-reconnect.png`,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reconnect.click();
  await expect(page.locator('.terminal-bar')).toContainText('Native Codex · connected');
  expect(connections).toBe(2);
  expect(inputs).toEqual(['\u001b']);
  expect(closeCalls).toBe(0);
  disconnect(4001);
  await page.getByRole('button', { name: 'Take control here', exact: true }).click();
  await expect(page.locator('.terminal-bar')).toContainText('Native Codex · connected');
  expect(connections).toBe(3);
  expect(inputs).toEqual(['\u001b']);
  expect(closeCalls).toBe(0);
  fail();
  await expect(page.locator('.terminal-bar')).toContainText('Send a first message');
  await expect(page.getByRole('button', { name: 'Reconnect terminal', exact: true })).toBeVisible();
});

test('phone connection failure and reconnect stay inside the app', async ({ page }, info) => {
  let connection = 'error',
    retries = 0;
  const status = () => ({
    mode: 'local',
    configured: true,
    enabled: true,
    paired: true,
    connection,
    origin: 'https://dock.example.test',
    devices: [],
  });
  await page.route('**/api/phone/status', (route) => route.fulfill({ json: status() }));
  await page.route('**/api/phone/reconnect', (route) => {
    retries++;
    connection = 'connecting';
    return route.fulfill({ json: status() });
  });
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Phone access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Phone access' });
  await expect(dialog).toContainText('Your agents and history are safe');
  await expect(dialog.getByRole('button', { name: 'Create a new code' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Reconnect phone access' }).click();
  await expect(dialog).toContainText('Connecting your phone address');
  connection = 'connected';
  await expect(dialog).toContainText('Your phone connection is ready', { timeout: 6000 });
  await expect(dialog.getByRole('button', { name: 'Create a new code' })).toBeEnabled();
  expect(retries).toBe(1);
  await page.screenshot({
    path: `../../data/screenshots/${info.project.name}-phone-reconnect.png`,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('phone setup explains private and existing-domain choices without terminal or payment instructions', async ({
  page,
}) => {
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Phone access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Phone access' });
  await expect(dialog).toContainText('Set up a phone connection');
  await expect(dialog.getByRole('button', { name: 'Check this computer' })).toBeVisible();
  await dialog.getByRole('radio', { name: 'Use a domain I already have' }).check();
  await expect(dialog).toContainText('Your setup agent can connect a domain you control');
  await expect(dialog).not.toContainText(/pnpm|API token|credit card|payment details/);
  await expect(dialog.getByRole('button', { name: 'Check existing-domain setup' })).toBeVisible();
});

test('phone connection offers an optional QR or manual address and a fifteen-minute code', async ({
  page,
}, info) => {
  const status = {
    mode: 'local',
    configured: true,
    enabled: true,
    paired: true,
    authentication: 'paired',
    enrollmentOpen: false,
    connection: 'connected',
    origin: 'https://dock.example.test',
    devices: [],
  };
  await page.route('**/api/phone/status', (route) => route.fulfill({ json: status }));
  let codes = 0;
  await page.route('**/api/phone/code', (route) => {
    codes++;
    status.enrollmentOpen = true;
    return route.fulfill({
      json: {
        code: 'ABCD-EFGH-JKLM-NPQR',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        origin: status.origin,
      },
    });
  });
  await page.route('**/api/phone/enrollment/close', (route) => {
    status.enrollmentOpen = false;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Phone access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Phone access' });
  await expect(dialog).toContainText('Pairing is closed to new devices');
  await expect(dialog).toContainText('The QR code and instructions will appear here');
  await expect(dialog.locator('.phone-qr')).toHaveCount(0);
  await expect(dialog.locator('.phone-address')).toHaveCount(0);
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-pairing-closed.png` });
  await dialog.getByRole('button', { name: 'Create a new code', exact: true }).click();
  await expect(dialog.locator('.phone-qr')).toBeVisible();
  const pairingUrl = `${status.origin}/#pair=ABCD-EFGH-JKLM-NPQR`;
  const qrLink = dialog.getByRole('link', { name: 'Open phone pairing', exact: true });
  await expect(qrLink).toHaveAttribute('href', pairingUrl);
  // Compare the rendered QR's modules against the existing QR generator using
  // the actual link. This catches a link updated to include the code while its
  // SVG still encodes only the bare address, without another dependency.
  const expectedSvg = renderToStaticMarkup(
    createElement(QRCodeSVG, { value: pairingUrl, size: 180, marginSize: 4 }),
  );
  const expectedPaths = [...expectedSvg.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)].map(
    (match) => match[1],
  );
  expect(expectedPaths.length).toBeGreaterThan(0);
  expect(
    await qrLink
      .locator('svg path')
      .evaluateAll((paths) => paths.map((path) => path.getAttribute('d'))),
  ).toEqual(expectedPaths);
  await expect(dialog).toContainText('Scanning the QR code is optional');
  await expect(dialog).toContainText('not a password to remember');
  await expect(dialog.getByRole('link', { name: status.origin })).toHaveAttribute(
    'href',
    status.origin,
  );
  await expect(dialog).toContainText('ABCD-EFGH-JKLM-NPQR');
  await expect(dialog).toContainText('15 minutes to finish pairing');
  await expect(dialog).toContainText('Scanning skips code entry; typing is only a fallback.');
  expect(codes).toBe(1);
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-pairing-open.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel pairing', exact: true }).click();
  await expect(dialog).toContainText('Pairing is closed to new devices');
  await expect(dialog.locator('.phone-qr')).toHaveCount(0);
  await expect(dialog.locator('.phone-address')).toHaveCount(0);
  await expect(dialog).not.toContainText('ABCD-EFGH-JKLM-NPQR');
});

test('pairing invitation needs a fresh local code and a working connection', async ({ page }) => {
  const status = {
    mode: 'local',
    configured: true,
    enabled: false,
    paired: true,
    authentication: 'paired',
    enrollmentOpen: false,
    connection: 'connected',
    origin: 'https://dock.example.test',
    devices: [],
  };
  let failCode = true;
  let loseCodeReply = false;
  await page.clock.install();
  await page.route('**/api/phone/status', (route) => route.fulfill({ json: status }));
  await page.route('**/api/phone/enabled', (route) => {
    status.enabled = route.request().postDataJSON().enabled;
    return route.fulfill({ json: status });
  });
  await page.route('**/api/phone/code', async (route) => {
    if (failCode)
      return route.fulfill({ status: 503, json: { error: 'Could not create a code. Try again.' } });
    status.enrollmentOpen = true;
    if (loseCodeReply) return route.abort('failed');
    return route.fulfill({
      json: {
        code: 'ABCD-EFGH-JKLM-NPQR',
        expiresAt: new Date((await page.evaluate(() => Date.now())) + 15 * 60_000).toISOString(),
        origin: status.origin,
      },
    });
  });
  const openSettings = async () => {
    await page.goto('/');
    if (page.viewportSize()!.width <= 720)
      await page.getByRole('button', { name: 'Open projects' }).click();
    await page.getByRole('button', { name: 'Phone access', exact: true }).click();
  };
  await openSettings();
  const dialog = page.getByRole('dialog', { name: 'Phone access' });
  const qr = dialog.locator('.phone-qr');
  const create = dialog.getByRole('button', { name: 'Create a new code', exact: true });
  await expect(qr).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Turn on phone access' }).click();
  await expect(qr).toHaveCount(0);
  await create.click();
  await expect(dialog.getByRole('alert')).toContainText('Could not create a code');
  await expect(qr).toHaveCount(0);
  failCode = false;
  await create.click();
  await expect(qr).toBeVisible();
  loseCodeReply = true;
  await create.click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(qr).toHaveCount(0);
  await expect(dialog).not.toContainText('ABCD-EFGH-JKLM-NPQR');
  loseCodeReply = false;
  await create.click();
  await expect(qr).toBeVisible();
  // A reloaded window cannot recover a code from server status; offer an explicit fresh start.
  await openSettings();
  await expect(dialog).toContainText('Pairing is open for one phone');
  await expect(qr).toHaveCount(0);
  await expect(dialog.locator('.phone-address')).toHaveCount(0);
  await create.click();
  await expect(qr).toBeVisible();
  status.connection = 'error';
  await expect(dialog).toContainText('The phone connection stopped', { timeout: 6000 });
  await expect(qr).toHaveCount(0);
  await expect(create).toBeDisabled();
  status.connection = 'connected';
  await expect(qr).toBeVisible({ timeout: 6000 });
  // The UI expires its own invitation even if a stale status still claims enrollment is open.
  await page.clock.fastForward(15 * 60_000 + 1);
  await expect(qr).toHaveCount(0);
  await expect(dialog.locator('.phone-address')).toHaveCount(0);
  await expect(dialog).not.toContainText('ABCD-EFGH-JKLM-NPQR');
  await create.click();
  await expect(qr).toBeVisible();
  status.enrollmentOpen = false;
  await expect(dialog).toContainText('Pairing is closed to new devices', { timeout: 6000 });
  await expect(qr).toHaveCount(0);
  await expect(dialog).not.toContainText('ABCD-EFGH-JKLM-NPQR');
});

test('remote pairing blocks the workspace, handles a wrong code, and survives reload', async ({
  page,
}, info) => {
  // UI-only remote fixture. Cryptographic authentication and cookies are tested by the real server suite.
  let paired = false,
    attempts = 0,
    snapshots = 0;
  await page.route('**/api/phone/status', (route) =>
    route.fulfill({
      json: {
        mode: 'remote',
        configured: true,
        enabled: true,
        paired,
        origin: 'https://dock.example.test',
        devices: [],
      },
    }),
  );
  await page.route('**/api/snapshot', async (route) => {
    snapshots++;
    await route.continue();
  });
  await page.route('**/api/phone/pair', async (route) => {
    attempts++;
    expect(route.request().postDataJSON().name).toBe('My phone');
    if (attempts === 1)
      return route.fulfill({
        status: 409,
        json: { error: 'That code did not match. Check the code on your computer.' },
      });
    paired = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Enter pairing code' })).toBeVisible();
  expect(snapshots).toBe(0);
  await page.getByLabel('Connection code').fill('WRONG');
  await expect(page.getByLabel('Phone nickname')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Name your phone' })).toBeVisible();
  await expect(page.getByLabel('Connection code')).toHaveCount(0);
  expect(attempts).toBe(0);
  await page.getByLabel('Phone nickname').fill('My phone');
  await page.getByRole('button', { name: 'Connect this device', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('did not match');
  await expect(page.getByRole('heading', { name: 'Enter pairing code' })).toBeVisible();
  await expect(page.getByLabel('Phone nickname')).toHaveCount(0);
  await page.getByLabel('Connection code').fill('ABCD-EFGH-JKLM-NPQR');
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-phone-pair.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('Phone nickname')).toHaveValue('My phone');
  expect(attempts).toBe(1);
  await page.getByRole('button', { name: 'Connect this device', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Message / })).toBeVisible();
  expect(snapshots).toBeGreaterThan(0);
  expect(attempts).toBe(2);
  await page.reload();
  await expect(page.getByRole('textbox', { name: /^Message / })).toBeVisible();
  expect(attempts).toBe(2);
  paired = false;
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 401, json: { error: 'Connect this device again.' } }),
  );
  await expect(page.getByRole('heading', { name: 'Enter pairing code' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole('textbox', { name: /^Message / })).toHaveCount(0);
});

test('local phone controls create a code, disconnect a device, and turn access off', async ({
  page,
}, info) => {
  let enabled = false,
    revoked = false;
  const deviceId = '4db78277-8f89-4c6e-875c-a748b8b53a64';
  const status = () => ({
    mode: 'local',
    configured: true,
    enabled,
    paired: true,
    origin: 'https://dock.example.test',
    devices: [
      {
        id: deviceId,
        name: 'My phone',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        revokedAt: revoked ? new Date().toISOString() : null,
      },
    ],
  });
  await page.route('**/api/phone/status', (route) => route.fulfill({ json: status() }));
  await page.route('**/api/phone/enabled', (route) => {
    enabled = route.request().postDataJSON().enabled;
    return route.fulfill({ json: status() });
  });
  await page.route('**/api/phone/code', (route) => {
    expect(Object.keys(route.request().postDataJSON())).toEqual(['key']);
    return route.fulfill({
      json: {
        code: 'ABCD-EFGH-JKLM-NPQR',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        origin: 'https://dock.example.test',
      },
    });
  });
  await page.route(`**/api/phone/devices/${deviceId}/revoke`, (route) => {
    revoked = true;
    return route.fulfill({ json: status() });
  });
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Phone access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Phone access' });
  await dialog.getByRole('button', { name: 'Turn on phone access' }).click();
  await dialog.getByRole('button', { name: 'Create a new code' }).click();
  await expect(dialog).toContainText('ABCD-EFGH-JKLM-NPQR');
  await expect(dialog.getByRole('link', { name: 'https://dock.example.test' })).toHaveAttribute(
    'href',
    'https://dock.example.test',
  );
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-phone-settings.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(dialog).toContainText('No connected devices yet');
  await dialog.getByRole('button', { name: 'Turn off phone access' }).click();
  await expect(dialog).toContainText('Phone access is off');
  await expect(dialog).not.toContainText('ABCD-EFGH-JKLM-NPQR');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'crossorigin',
    'use-credentials',
  );
});
