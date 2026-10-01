import { test as base, expect, type Page } from './fixture';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../../../server/dist/store.js';
import { Runtime } from '../../../server/dist/runtime.js';
import { DemoProvider } from '../../../server/dist/demo.js';
import { Terminals } from '../../../server/dist/terminal.js';
import { PhoneAccess, phoneConfigSchema } from '../../../server/dist/phone-access.js';
import { createServer } from '../../../server/dist/server.js';

type PhoneFixture = {
  access: PhoneAccess;
  computer: Page;
  privateRequests: () => number;
  requests: { options: number; finish: number };
  faults: { loseFinishReply: boolean; optionsTimeoutMs?: number };
};
const test = base.extend<{ phone: PhoneFixture }>({
  phone: async ({ page, context }, use) => {
    const root = mkdtempSync(join(tmpdir(), 'dock-browser-passkey-'));
    const store = new Store(join(root, 'dock.sqlite'));
    store.register(root, 'Phone acceptance fixture', '');
    const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
    const access = new PhoneAccess(
      store,
      phoneConfigSchema.parse({ origin: 'https://dock.example.test', authentication: 'paired' }),
    );
    const terminals = new Terminals(runtime);
    const remote = await createServer(store, runtime, {
      port: 4331,
      phone: access,
      terminals,
      remote: true,
      ownsRuntime: false,
      webDir: resolve(process.env.DOCK_E2E_WEB_DIR ?? 'dist'),
      demo: true,
    });
    const local = await createServer(store, runtime, {
      port: 4999,
      phone: access,
      terminals,
      webDir: resolve(process.env.DOCK_E2E_WEB_DIR ?? 'dist'),
      demo: true,
    });
    const computer = await context.newPage();
    const cdp = await context.newCDPSession(page);
    let privateRequests = 0;
    const requests = { options: 0, finish: 0 };
    const faults = { loseFinishReply: false } as PhoneFixture['faults'];
    try {
      access.setEnabled(true);
      await remote.listen({ host: '127.0.0.1', port: 0 });
      const port = (remote.server.address() as { port: number }).port;
      await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      // HTTPS browser origin + real app handlers and verifier. This bridge is a local test,
      // not evidence of Cloudflare routing, physical Face ID or iOS home-screen storage.
      await page.route('https://dock.example.test/**', async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        const headers = { ...(await request.allHeaders()), host: 'dock.example.test' };
        if (path.startsWith('/api/') && !path.startsWith('/api/phone/')) privateRequests++;
        if (path === '/api/phone/enroll/options') requests.options++;
        if (path === '/api/phone/enroll/finish') requests.finish++;
        if (path === '/api/events') {
          await route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
            body: '',
          });
          return;
        }
        const response = await context.request.fetch(
          `http://127.0.0.1:${port}${new URL(request.url()).pathname}${new URL(request.url()).search}`,
          {
            method: request.method(),
            headers,
            data: request.postDataBuffer() ?? undefined,
          },
        );
        if (path === '/api/phone/enroll/finish' && faults.loseFinishReply) {
          expect(response.ok()).toBe(true);
          await route.abort('connectionfailed');
          return;
        }
        if (path === '/api/phone/enroll/options' && faults.optionsTimeoutMs !== undefined) {
          await route.fulfill({
            response,
            json: { ...(await response.json()), timeout: faults.optionsTimeoutMs },
          });
          return;
        }
        await route.fulfill({ response });
      });
      await computer.route('http://127.0.0.1:4999/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.pathname === '/api/events') {
          await route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
            body: '',
          });
          return;
        }
        const response = await local.inject({
          method: request.method() as 'GET' | 'POST',
          url: `${url.pathname}${url.search}`,
          headers: { ...(await request.allHeaders()), host: '127.0.0.1:4999' },
          payload: request.postDataBuffer() ?? undefined,
        });
        await route.fulfill({
          status: response.statusCode,
          headers: Object.fromEntries(
            Object.entries(response.headers).map(([key, value]) => [key, String(value)]),
          ),
          body: response.rawPayload,
        });
      });
      await use({ access, computer, privateRequests: () => privateRequests, requests, faults });
    } finally {
      await page.unrouteAll({ behavior: 'wait' });
      await computer.unrouteAll({ behavior: 'wait' });
      await computer.close();
      await page.close();
      await cdp.detach().catch(() => {});
      await remote.close();
      await local.close();
      if (store.db.isOpen) store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
});

async function enterCode(page: Page, code: string) {
  await page.getByLabel('Connection code').fill(code);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Name your phone', exact: true })).toBeVisible();
  await expect(page.getByLabel('Connection code')).toHaveCount(0);
  await expect(page.getByLabel('Phone nickname')).toBeVisible();
}
async function enterNickname(page: Page, nickname = 'My phone') {
  await page.getByLabel('Phone nickname').fill(nickname);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}
async function expectQrNickname(page: Page) {
  await expect(page.getByRole('heading', { name: 'Name your phone', exact: true })).toBeVisible();
  await expect(page.getByLabel('Connection code')).toHaveCount(0);
  await expect(page.getByLabel('Phone nickname')).toBeVisible();
  await expect(page.getByText(/Connection code filled from QR/)).toHaveCount(0);
}
async function prepare(page: Page, phone: PhoneFixture) {
  const code = phone.access.issueCode(randomUUID()).code;
  await page.goto('https://dock.example.test');
  await enterCode(page, code);
  await enterNickname(page);
  await expect(page.getByRole('button', { name: 'Save passkey', exact: true })).toBeVisible();
  await expect(page.getByText('Your code was accepted.', { exact: false })).toBeVisible();
}

test('manual pairing separates code and nickname, preserves back navigation, and corrects a wrong code without losing the nickname', async ({
  page,
  phone,
}, info) => {
  const code = phone.access.issueCode(randomUUID()).code;
  const wrongCode = `${code[0] === 'A' ? 'B' : 'A'}${code.slice(1)}`;
  await page.goto('https://dock.example.test');
  await expect(page.getByRole('heading', { name: 'Enter pairing code' })).toBeVisible();
  await expect(page.getByLabel('Phone nickname')).toHaveCount(0);
  await page.screenshot({
    path: `../../data/screenshots/${info.project.name}-pairing-code-step.png`,
  });
  await enterCode(page, wrongCode);
  await expect(page.getByLabel('Phone nickname')).toHaveValue('');
  await expect(page.getByLabel('Phone nickname')).toHaveAttribute('placeholder', 'e.g. My iPhone');
  await expect(page.getByText('Your code was accepted.', { exact: false })).toHaveCount(0);
  expect(phone.requests).toEqual({ options: 0, finish: 0 });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect(phone.requests).toEqual({ options: 0, finish: 0 });
  await page.getByLabel('Phone nickname').fill('   ');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect(phone.requests).toEqual({ options: 0, finish: 0 });
  await page.getByLabel('Phone nickname').fill('Family iPhone');
  await page.getByRole('button', { name: 'Use a different code', exact: true }).click();
  await expect(page.getByLabel('Connection code')).toHaveValue(wrongCode);
  await expect(page.getByLabel('Phone nickname')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('Phone nickname')).toHaveValue('Family iPhone');
  await page.screenshot({
    path: `../../data/screenshots/${info.project.name}-pairing-nickname-step.png`,
  });
  expect(phone.requests).toEqual({ options: 0, finish: 0 });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('did not match');
  await expect(page.getByRole('heading', { name: 'Enter pairing code' })).toBeVisible();
  await expect(page.getByLabel('Connection code')).toHaveValue(wrongCode);
  await expect(page.getByLabel('Phone nickname')).toHaveCount(0);
  expect(phone.requests).toEqual({ options: 1, finish: 0 });
  await enterCode(page, code);
  await expect(page.getByLabel('Phone nickname')).toHaveValue('Family iPhone');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save passkey', exact: true })).toBeVisible();
  expect(phone.requests).toEqual({ options: 2, finish: 0 });
  expect(phone.privateRequests()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a temporary QR preparation failure keeps the nickname step and retries only on Continue', async ({
  page,
  phone,
}) => {
  const code = phone.access.issueCode(randomUUID()).code;
  let attempts = 0;
  await page.route('https://dock.example.test/api/phone/enroll/options', async (route) => {
    attempts++;
    if (attempts === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'The computer is temporarily unavailable.' },
      });
    await route.fallback();
  });
  await page.goto(`https://dock.example.test/#pair=${encodeURIComponent(code)}`);
  await expectQrNickname(page);
  expect(attempts).toBe(0);
  await enterNickname(page, 'Family iPhone');
  await expect(page.getByRole('alert')).toBeVisible();
  await expectQrNickname(page);
  await expect(page.getByLabel('Phone nickname')).toHaveValue('Family iPhone');
  expect(attempts).toBe(1);
  expect(phone.requests).toEqual({ options: 0, finish: 0 });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save passkey', exact: true })).toBeVisible();
  expect(attempts).toBe(2);
  expect(phone.requests).toEqual({ options: 1, finish: 0 });
  expect(phone.privateRequests()).toBe(0);
});

test('rendered QR skips code entry and asks for a nickname before real passkey verification and computer confirmation', async ({
  page,
  phone,
}, info) => {
  const { computer, access } = phone;
  await page.goto('https://dock.example.test');
  await expect(page.getByRole('heading', { name: 'Enter pairing code' })).toBeVisible();
  expect(phone.privateRequests()).toBe(0);
  await enterCode(page, 'AAAA-AAAA-AAAA-AAAA');
  expect(phone.requests.options).toBe(0);
  await enterNickname(page);
  await expect(page.getByRole('alert')).toContainText('Pairing is closed');
  await computer.goto('http://127.0.0.1:4999');
  if (computer.viewportSize()!.width <= 720)
    await computer.getByRole('button', { name: 'Open projects' }).click();
  await computer.getByRole('button', { name: 'Phone access', exact: true }).click();
  const settings = computer.getByRole('dialog', { name: 'Phone access' });
  await expect(settings.locator('.phone-qr')).toHaveCount(0);
  await settings.getByRole('button', { name: 'Create a new code' }).click();
  const code = await settings.locator('.phone-code strong').innerText();
  await settings
    .getByRole('link', { name: 'https://dock.example.test', exact: true })
    .scrollIntoViewIfNeeded();
  await computer.screenshot({
    path: `../../data/screenshots/${info.project.name}-passkey-address.png`,
  });
  await settings
    .getByText('15 minutes to finish pairing', { exact: false })
    .scrollIntoViewIfNeeded();
  await computer.screenshot({
    path: `../../data/screenshots/${info.project.name}-passkey-code.png`,
  });
  const qrLink = settings.getByRole('link', { name: 'Open phone pairing', exact: true });
  const pairingUrl = await qrLink.getAttribute('href');
  expect(pairingUrl).toBe(`https://dock.example.test/#pair=${encodeURIComponent(code)}`);
  await expect(qrLink.locator('svg')).toHaveCount(1);
  const optionsBeforeScan = phone.requests.options;
  // Scanning opens a document, not an SPA hash-only navigation in an old tab.
  await page.goto('about:blank');
  await page.goto(pairingUrl!);
  await expectQrNickname(page);
  await expect(page.getByLabel('Phone nickname')).toHaveValue('');
  await expect(page.getByLabel('Phone nickname')).toHaveAttribute('placeholder', 'e.g. My iPhone');
  expect(new URL(page.url()).hash).toBe('');
  expect(phone.requests).toEqual({ options: optionsBeforeScan, finish: 0 });
  expect(phone.privateRequests()).toBe(0);
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-qr-nickname.png` });
  await enterNickname(page);
  await expect(page.getByRole('heading', { name: 'Save a passkey' })).toBeVisible();
  // Leave the real phone-side verification waiting, as a person would see it.
  await expect(settings).toContainText('Continue pairing on your phone');
  await expect(settings.locator('.phone-qr')).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Create a new code' })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Confirm this phone' })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Cancel pairing' })).toBeVisible();
  expect(phone.requests.finish).toBe(0);
  await page.getByRole('button', { name: 'Save passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm on your computer' })).toBeVisible();
  expect(phone.privateRequests()).toBe(0);
  const pending = access.status(false).pending!;
  await expect(page.locator('.phone-code')).toContainText(pending.confirmation);
  await expect(settings.getByRole('button', { name: 'Confirm this phone' })).toBeVisible();
  await expect(settings).toContainText(pending.confirmation);
  await expect(settings.getByRole('button', { name: 'Confirm this phone' })).toBeInViewport();
  await expect(settings.getByRole('button', { name: 'Create a new code' })).toHaveCount(0);
  await expect(settings.locator('.phone-qr')).toHaveCount(0);
  await expect(settings.locator('.phone-address')).toHaveCount(0);
  await expect(settings).toContainText('Your phone is waiting for confirmation');
  await expect(settings).not.toContainText(code);
  await computer.screenshot({
    path: `../../data/screenshots/${info.project.name}-passkey-confirm.png`,
  });
  expect(await computer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await settings.getByRole('button', { name: 'Confirm this phone' }).click();
  await expect(settings).toContainText('Pairing is closed to new devices');
  await expect(settings.locator('.phone-qr')).toHaveCount(0);
  await expect(settings.locator('.phone-address')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Add sciencewithagents to your Home Screen', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Home Screen instructions' })).toContainText(
    'Open as Web App',
  );
  await expect(page.getByRole('region', { name: 'Home Screen instructions' })).toContainText(
    'Android',
  );
  await page.screenshot({
    path: `../../data/screenshots/${info.project.name}-phone-install-guide.png`,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open my workspace', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Message / })).toBeVisible();
  expect(phone.privateRequests()).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByRole('textbox', { name: /^Message / })).toBeVisible();
  await expect(page.getByRole('button', { name: /Unlock|Lock app/ })).toHaveCount(0);
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-paired-return.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await settings.getByRole('button', { name: 'Turn off phone access' }).click();
  await expect(settings).toContainText('Phone access is off');
  const denied = await page.evaluate(async () => (await fetch('/api/snapshot')).status);
  expect(denied).toBe(503);
  await settings.getByRole('button', { name: 'Turn on phone access' }).click();
  await page.reload();
  await expect(page.getByRole('textbox', { name: /^Message / })).toBeVisible();
  expect(access.status(false).devices).toHaveLength(1);
  expect(access.status(false).devices[0].expiresAt).toBeNull();
  await settings.getByRole('button', { name: 'Remove device' }).click();
  await expect(settings).toContainText('No connected devices yet');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Enter pairing code' })).toBeVisible();
});

test('paired access survives reload, backgrounding, old lock flags and transient outages without verification', async ({
  page,
  phone,
}) => {
  await prepare(page, phone);
  await page.getByRole('button', { name: 'Save passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm on your computer' })).toBeVisible();
  const pending = phone.access.status(false).pending!;
  phone.access.pairedDevices!.confirm({ id: pending.id, confirmation: pending.confirmation });
  await page.getByRole('button', { name: 'Open my workspace', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Message / })).toBeVisible();
  const ceremonies: string[] = [];
  page.on('request', (request) => {
    if (/\/phone\/(unlock|lock|enroll)/.test(request.url())) ceremonies.push(request.url());
  });
  await page.evaluate(() => localStorage.setItem('dock:phone-manually-locked', '1'));
  await page.reload();
  await expect(page.getByRole('textbox', { name: /^Message / })).toBeVisible();
  const draft = page.getByRole('textbox', { name: /^Message / });
  await draft.fill('Keep this unsent draft when I leave the app.');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(draft).toHaveValue('Keep this unsent draft when I leave the app.');
  await page.route('https://dock.example.test/api/phone/status', (route) =>
    route.abort('connectionfailed'),
  );
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(draft).toHaveValue('Keep this unsent draft when I leave the app.');
  await page.unroute('https://dock.example.test/api/phone/status');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('button', { name: /Unlock|Lock app/ })).toHaveCount(0);
  expect(ceremonies).toEqual([]);
  // Removal still closes a returning phone; the old cookie cannot restore it.
  phone.access.revoke(pending.id);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('heading', { name: 'Enter pairing code' })).toBeVisible();
  await expect(draft).toHaveCount(0);
});

test('phone installation setup retries a failed save without repeating pairing', async ({
  page,
  phone,
}) => {
  await prepare(page, phone);
  await page.getByRole('button', { name: 'Save passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm on your computer' })).toBeVisible();
  const pending = phone.access.status(false).pending!;
  phone.access.pairedDevices!.confirm({ id: pending.id, confirmation: pending.confirmation });
  await expect(
    page.getByRole('heading', { name: 'Add sciencewithagents to your Home Screen' }),
  ).toBeVisible();
  let saves = 0;
  await page.route('https://dock.example.test/api/phone/setup/complete', async (route) => {
    saves++;
    if (saves === 1) return route.abort('connectionfailed');
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Open my workspace', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not confirm setup finished');
  expect(saves).toBe(1);
  expect(phone.privateRequests()).toBe(0);
  await page.getByText('Already added an icon, or the icon asks to pair again?').click();
  await expect(page.getByRole('region', { name: 'Home Screen instructions' })).toContainText(
    'Do not clear this browser’s data',
  );
  await page.getByRole('button', { name: 'Open my workspace', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Message / })).toBeVisible();
  expect(saves).toBe(2);
  expect(phone.requests).toEqual({ options: 1, finish: 1 });
});

test('cancelled creation retries the same accepted code without repeating preparation', async ({
  page,
  phone,
}, info) => {
  await prepare(page, phone);
  await page.evaluate(() => {
    const original = navigator.credentials.create.bind(navigator.credentials);
    let first = true;
    navigator.credentials.create = (options) => {
      if (first) {
        first = false;
        return Promise.reject(new DOMException('PRIVATE_MESSAGE_DO_NOT_RENDER', 'NotAllowedError'));
      }
      return original(options);
    };
  });
  await page.getByRole('button', { name: 'Save passkey', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cancelled, timed out, or unavailable');
  await page.getByText('Verification detail', { exact: true }).click();
  await expect(page.locator('.phone-card')).toContainText('NotAllowedError');
  await expect(page.locator('.phone-card')).not.toContainText('PRIVATE_MESSAGE');
  await expect(page.getByLabel('Connection code')).toHaveCount(0);
  expect(phone.requests).toEqual({ options: 1, finish: 0 });
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-passkey-retry.png` });
  await page.getByRole('button', { name: 'Save passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm on your computer' })).toBeVisible();
  expect(phone.requests).toEqual({ options: 1, finish: 1 });
  expect(phone.privateRequests()).toBe(0);
});

for (const [name, expected] of [
  ['NotSupportedError', 'This browser cannot save a passkey'],
  ['SecurityError', 'The browser rejected this address'],
  ['PRIVATE_UNKNOWN_NAME', 'The phone could not save its passkey'],
]) {
  test(`creation ${name} shows safe guidance without browser payloads`, async ({ page, phone }) => {
    await prepare(page, phone);
    await page.evaluate((errorName) => {
      navigator.credentials.create = () => {
        const error = new Error('PRIVATE_RAW_MESSAGE');
        error.name = errorName;
        Object.assign(error, { code: 'PRIVATE_RAW_CODE', cause: 'PRIVATE_RAW_CAUSE' });
        return Promise.reject(error);
      };
    }, name);
    await page.getByRole('button', { name: 'Save passkey', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(expected);
    await page.getByText('Verification detail', { exact: true }).click();
    await expect(page.locator('.phone-card')).not.toContainText('PRIVATE_');
    expect(phone.requests).toEqual({ options: 1, finish: 0 });
    expect(phone.privateRequests()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('slow preparation does not invoke WebAuthn, and Save runs directly during its click', async ({
  page,
  phone,
}) => {
  let releaseOptions!: () => void;
  const waitingOptions = new Promise<void>((resolve) => {
    releaseOptions = resolve;
  });
  await page.route('https://dock.example.test/api/phone/enroll/options', async (route) => {
    await waitingOptions;
    await route.fallback();
  });
  const code = phone.access.issueCode(randomUUID()).code;
  await page.goto('https://dock.example.test');
  await page.evaluate(() => {
    const original = navigator.credentials.create.bind(navigator.credentials);
    const record = { calls: 0, sameClick: false };
    Object.assign(window, { pairingGestureCheck: record });
    navigator.credentials.create = (options) => {
      record.calls++;
      // Test-only Chromium event inspection: a promise continuation is no longer
      // inside the browser's native click dispatch.
      record.sameClick = window.event?.type === 'click' && window.event.eventPhase > 0;
      return original(options);
    };
  });
  await enterCode(page, code);
  await enterNickname(page);
  try {
    await expect(page.getByRole('button', { name: 'Checking code…' })).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { pairingGestureCheck: { calls: number } }).pairingGestureCheck
            .calls,
      ),
    ).toBe(0);
  } finally {
    releaseOptions();
  }
  await expect(page.getByRole('button', { name: 'Save passkey', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm on your computer' })).toBeVisible();
  const actual = await page.evaluate(
    () =>
      (window as unknown as { pairingGestureCheck: { calls: number; sameClick: boolean } })
        .pairingGestureCheck,
  );
  expect(actual.calls).toBe(1);
  expect(actual.sameClick).toBe(true);
  expect(phone.requests).toEqual({ options: 1, finish: 1 });
});

test('an uncertain finish is inspected without another credential or automatic resubmission', async ({
  page,
  phone,
}) => {
  await prepare(page, phone);
  phone.faults.loseFinishReply = true;
  let hideStatus = true;
  await page.route('https://dock.example.test/api/phone/status', async (route) => {
    if (hideStatus)
      return route.fulfill({
        status: 503,
        json: { error: 'This computer is temporarily offline.' },
      });
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Save passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check pairing' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save passkey', exact: true })).toHaveCount(0);
  expect(phone.requests.finish).toBe(1);
  await page.getByRole('button', { name: 'Check connection' }).click();
  expect(phone.requests.finish).toBe(1);
  hideStatus = false;
  await page.getByRole('button', { name: 'Check connection' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm on your computer' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Confirm on your computer' })).toBeVisible();
  expect(phone.requests.finish).toBe(1);
  expect(phone.privateRequests()).toBe(0);
});

test('a cancelled prompt does not extend the accepted code deadline', async ({ page, phone }) => {
  await page.clock.install();
  phone.faults.optionsTimeoutMs = 5000;
  const code = phone.access.issueCode(randomUUID()).code;
  await page.goto(`https://dock.example.test/#pair=${encodeURIComponent(code)}`);
  await expectQrNickname(page);
  await enterNickname(page);
  await expect(page.getByRole('button', { name: 'Save passkey', exact: true })).toBeVisible();
  await page.evaluate(() => {
    navigator.credentials.create = () =>
      Promise.reject(new DOMException('Cancelled', 'NotAllowedError'));
  });
  await page.getByRole('button', { name: 'Save passkey', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cancelled, timed out, or unavailable');
  await page.clock.fastForward(5001);
  await expect(page.getByRole('alert')).toContainText('This pairing attempt has expired');
  await expect(page.getByRole('button', { name: 'Save passkey', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Connection code')).toBeVisible();
  await expect(page.getByLabel('Connection code')).toHaveValue('');
  await expect(page.getByLabel('Phone nickname')).toHaveCount(0);
  expect(phone.requests).toEqual({ options: 1, finish: 0 });
  expect(phone.privateRequests()).toBe(0);
  await enterCode(page, phone.access.issueCode(randomUUID()).code);
  await expect(page.getByLabel('Phone nickname')).toHaveValue('My phone');
  expect(phone.requests).toEqual({ options: 1, finish: 0 });
});

test('a scanned code is scrubbed from history and never restored from browser storage after reload', async ({
  page,
  phone,
}) => {
  const code = phone.access.issueCode(randomUUID()).code;
  await page.goto(`https://dock.example.test/#pair=${encodeURIComponent(code)}`);
  await expectQrNickname(page);
  expect(new URL(page.url()).hash).toBe('');
  expect(
    await page.evaluate(
      (value) =>
        [...Object.values(localStorage), ...Object.values(sessionStorage)].some((stored) =>
          stored.includes(value),
        ),
      code,
    ),
  ).toBe(false);
  expect(phone.requests).toEqual({ options: 0, finish: 0 });
  expect(phone.privateRequests()).toBe(0);
  await page.reload();
  await expect(page.getByLabel('Connection code')).toHaveValue('');
  await expect(page.getByLabel('Phone nickname')).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('');
  await page.goto('about:blank');
  await page.goBack();
  await expect(page.getByLabel('Connection code')).toHaveValue('');
  expect(new URL(page.url()).hash).toBe('');
  expect(phone.requests).toEqual({ options: 0, finish: 0 });
  expect(phone.privateRequests()).toBe(0);
});

test('a malformed QR fragment is scrubbed without filling or starting enrollment', async ({
  page,
  phone,
}) => {
  for (const fragment of [
    'pair=not-a-valid-code',
    'pair=ABCD-EFGH-JKLM-NPQR&pair=ABCD-EFGH-JKLM-NPQR',
    `pair=${'A'.repeat(129)}`,
  ]) {
    await page.goto(`https://dock.example.test/#${fragment}`);
    await expect(page).toHaveURL('https://dock.example.test/');
    await expect(page.getByLabel('Connection code')).toHaveValue('');
    await expect(page.getByLabel('Phone nickname')).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
  }
  expect(phone.requests).toEqual({ options: 0, finish: 0 });
  expect(phone.privateRequests()).toBe(0);
  expect(phone.access.status(false).devices).toHaveLength(0);
});

test('scanning into an existing tab fills and scrubs the code again without automatic enrollment', async ({
  page,
  phone,
}) => {
  const code = phone.access.issueCode(randomUUID()).code;
  await page.goto('https://dock.example.test/');
  await expect(page.getByLabel('Connection code')).toHaveValue('');
  await page.evaluate(() => Object.assign(window, { sameDocumentScanMarker: 'original document' }));
  for (let scan = 0; scan < 2; scan++) {
    await page.evaluate((value) => {
      window.location.hash = `pair=${encodeURIComponent(value)}`;
    }, code);
    await expectQrNickname(page);
    await expect(page).toHaveURL('https://dock.example.test/');
    expect(
      await page.evaluate(
        () => (window as unknown as { sameDocumentScanMarker: string }).sameDocumentScanMarker,
      ),
    ).toBe('original document');
    expect(phone.requests).toEqual({ options: 0, finish: 0 });
    expect(phone.privateRequests()).toBe(0);
    if (scan === 0) {
      await page.getByLabel('Phone nickname').fill('My phone');
      await page.getByRole('button', { name: 'Use a different code', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Enter pairing code' })).toBeVisible();
      await expect(page.getByLabel('Phone nickname')).toHaveCount(0);
      await page.getByLabel('Connection code').fill('');
    }
  }
  await expect(page.getByLabel('Phone nickname')).toHaveValue('My phone');
  await enterNickname(page);
  await expect(page.getByRole('button', { name: 'Save passkey', exact: true })).toBeVisible();
  expect(phone.requests).toEqual({ options: 1, finish: 0 });
  expect(phone.privateRequests()).toBe(0);
});

test('a reused QR can fill the form but cannot reuse an accepted code or grant access', async ({
  page,
  phone,
}) => {
  const code = phone.access.issueCode(randomUUID()).code;
  const pairingUrl = `https://dock.example.test/#pair=${encodeURIComponent(code)}`;
  await page.goto(pairingUrl);
  await expectQrNickname(page);
  await enterNickname(page);
  await expect(page.getByRole('button', { name: 'Save passkey', exact: true })).toBeVisible();
  expect(phone.requests).toEqual({ options: 1, finish: 0 });
  await page.goto('about:blank');
  await page.goto(pairingUrl);
  await expectQrNickname(page);
  expect(phone.requests).toEqual({ options: 1, finish: 0 });
  await enterNickname(page);
  await expect(page.getByRole('alert')).toContainText('Pairing is closed');
  await expect(page.getByRole('heading', { name: 'Enter pairing code' })).toBeVisible();
  await expect(page.getByLabel('Connection code')).toHaveValue(code);
  await expect(page.getByLabel('Phone nickname')).toHaveCount(0);
  expect(phone.requests).toEqual({ options: 2, finish: 0 });
  expect(phone.privateRequests()).toBe(0);
  expect(phone.access.status(false).devices).toHaveLength(0);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('Phone nickname')).toHaveValue('My phone');
  expect(phone.requests).toEqual({ options: 2, finish: 0 });
});
