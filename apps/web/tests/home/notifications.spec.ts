import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { NotificationStatus } from '@dock/shared';

// The demo server has no notifier, so these checks drive the Settings contract with
// route fixtures and a fake push manager. They do not certify real device delivery.
const projects = [
  { id: randomUUID(), name: 'Thesis', enabled: false },
  {
    id: randomUUID(),
    name: 'A very long project name that should wrap cleanly on a narrow phone',
    enabled: true,
  },
];
async function fixture(page: Page, options: { subscribed?: () => boolean } = {}) {
  const writes: Array<{ url: string; body: unknown }> = [];
  let enabled = true;
  for (const project of projects) project.enabled = project.name !== 'Thesis';
  const status = (): NotificationStatus => ({
    available: true,
    publicKey:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    enabled,
    projects,
    subscriptions: options.subscribed?.()
      ? [
          {
            id: randomUUID(),
            label: 'iPhone',
            service: 'web.push.apple.com',
            createdAt: new Date().toISOString(),
            lastSuccessAt: null,
            lastFailureAt: null,
            mine: true,
          },
        ]
      : [],
    otherSubscriptions: 1,
  });
  await page.route('**/api/notifications**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: status() });
    const url = new URL(request.url()).pathname,
      body = request.postDataJSON();
    writes.push({ url, body });
    // Saved state comes back from the server; the controls never assume success.
    if (url.endsWith('/project'))
      projects.find((project) => project.id === body.projectId)!.enabled = body.enabled;
    if (url.endsWith('/enabled')) enabled = body.enabled;
    return route.fulfill({ json: { ok: true } });
  });
  return writes;
}
async function expectFits(page: Page) {
  const panel = page.getByRole('region', { name: 'Notifications' });
  await expect(panel).toBeVisible();
  const issues = await page.evaluate(() => {
    const problems: string[] = [];
    const root = document.scrollingElement!;
    if (root.scrollWidth > innerWidth + 1) problems.push('page scrolls sideways');
    for (const element of document.querySelectorAll<HTMLElement>(
      '.notification-settings :is(button, label, p, li)',
    )) {
      const box = element.getBoundingClientRect();
      if (box.right > innerWidth + 1 || box.left < -1)
        problems.push(`${element.textContent?.slice(0, 30)} overflows`);
    }
    return problems;
  });
  expect(issues).toEqual([]);
}
const fakePush = (permission: NotificationPermission, standalone = true) => {
  const subscription = {
    endpoint: 'https://web.push.apple.com/fixture',
    toJSON: () => ({
      endpoint: 'https://web.push.apple.com/fixture',
      keys: {
        p256dh:
          'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
        auth: 'tBHItJI5svbpez7KI4CCXg',
      },
    }),
    unsubscribe: async () => true,
  };
  let subscribed = false;
  const pushManager = {
    getSubscription: async () => (subscribed ? subscription : null),
    subscribe: async () => {
      subscribed = true;
      return subscription;
    },
  };
  const registration = { pushManager };
  Object.defineProperty(window, 'PushManager', { value: function PushManager() {} });
  Object.defineProperty(navigator, 'standalone', { get: () => standalone });
  Object.defineProperty(Navigator.prototype, 'serviceWorker', {
    get: () => ({
      register: async () => registration,
      ready: Promise.resolve(registration),
      getRegistration: async () => registration,
    }),
  });
  const calls: string[] = [];
  (window as unknown as { pushCalls: string[] }).pushCalls = calls;
  class FakeNotification {
    static permission = permission;
    static async requestPermission() {
      calls.push(navigator.userActivation?.isActive === false ? 'without gesture' : 'gesture');
      FakeNotification.permission = permission === 'default' ? 'granted' : permission;
      return FakeNotification.permission;
    }
  }
  Object.defineProperty(window, 'Notification', { value: FakeNotification });
};

test('Settings offers notifications with explicit opt-in and per-project toggles', async ({
  page,
}, info) => {
  let subscribed = false;
  const writes = await fixture(page, { subscribed: () => subscribed });
  await page.addInitScript(fakePush, 'default');
  await page.goto('/#/settings');
  await page.getByRole('link', { name: /Notifications/ }).click();
  await expect(page).toHaveURL(/#\/notifications$/);
  const panel = page.getByRole('region', { name: 'Notifications' });
  await expect(panel).toContainText('Details stay in the app');
  await expectFits(page);
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => (window as any).pushCalls)).toEqual([]);

  // Controlled by saved server state: the box reflects the change after the save returns.
  await panel.getByRole('checkbox', { name: 'Thesis' }).click();
  await expect(panel.getByRole('checkbox', { name: 'Thesis' })).toBeChecked();
  await expect
    .poll(() => writes.at(-1))
    .toEqual({
      url: '/api/notifications/project',
      body: { projectId: projects[0]!.id, enabled: true },
    });
  await panel.getByRole('checkbox', { name: 'Send notifications from this computer' }).click();
  await expect(
    panel.getByRole('checkbox', { name: 'Send notifications from this computer' }),
  ).not.toBeChecked();
  await expect
    .poll(() => writes.at(-1))
    .toEqual({
      url: '/api/notifications/enabled',
      body: { enabled: false },
    });
  await expect(panel.getByRole('checkbox', { name: 'Thesis' })).toBeDisabled();

  subscribed = true;
  await panel.getByRole('button', { name: 'Turn on notifications on this device' }).click();
  await expect(panel.getByRole('status')).toHaveText('Notifications are on for this device.');
  const subscribe = writes.find((write) => write.url === '/api/notifications/subscribe');
  expect(subscribe?.body).toMatchObject({
    endpoint: 'https://web.push.apple.com/fixture',
    keys: { auth: 'tBHItJI5svbpez7KI4CCXg' },
  });
  expect(await page.evaluate(() => (window as any).pushCalls)).toEqual(['gesture']);
  await expect(panel.getByRole('button', { name: 'Send a test' })).toBeVisible();
  await expect(panel).toContainText('1 other device');
  await expectFits(page);
  await panel.screenshot({ path: info.outputPath('notifications.png') });
});

test('blocked permission explains recovery without prompting again', async ({ page }) => {
  const writes = await fixture(page);
  await page.addInitScript(fakePush, 'denied');
  await page.goto('/#/notifications');
  const panel = page.getByRole('region', { name: 'Notifications' });
  await expect(panel.getByRole('alert')).toContainText('Notifications are blocked');
  await expect(panel.getByRole('button', { name: /Turn on notifications/ })).toHaveCount(0);
  await expectFits(page);
  expect(writes).toEqual([]);
});

test('iPhone Safari outside the Home Screen app is told how to enable it', async ({ page }) => {
  await fixture(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      get: () =>
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    });
  });
  await page.goto('/#/notifications');
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Add sciencewithagents to your Home Screen',
  );
  await expectFits(page);
});

test('the real demo entry reports notifications as unavailable and serves a push-only worker', async ({
  page,
  request,
}, info) => {
  await page.goto('/#/notifications');
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Notifications are not available on this computer entry.',
  );
  const worker = await request.get('/notifications-sw.js');
  expect(worker.ok()).toBe(true);
  expect(worker.headers()['content-type']).toMatch(/javascript/);
  expect(worker.headers()['cache-control']).toBe('no-store');
  const source = await worker.text();
  expect(source).toContain("addEventListener('push'");
  expect(source).not.toContain("addEventListener('fetch'");
  test.skip(info.project.name !== 'desktop', 'Real registration is checked once in Chromium.');
  const state = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/notifications-sw.js', {
      scope: '/',
    });
    await navigator.serviceWorker.ready;
    const worker = registration.active!;
    if (worker.state !== 'activated')
      await new Promise((resolve) => worker.addEventListener('statechange', resolve));
    const active = worker.state;
    await registration.unregister();
    return active;
  });
  expect(state).toBe('activated');
});

test('a notification tap stays on its entry computer until this tab explicitly switches', async ({
  page,
}) => {
  const other = randomUUID(),
    agent = randomUUID();
  await page.route('**/api/hosts', (route) =>
    route.fulfill({
      json: {
        local: { id: 'local', label: 'Main computer' },
        hosts: [
          {
            id: other,
            label: 'Shirai',
            accountLabel: 'Lab',
            status: 'connected',
            error: null,
          },
        ],
        setupError: null,
      },
    }),
  );
  await page.goto('/');
  await page.evaluate((id) => localStorage.setItem('dock:host', id), other);
  const requests: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/')) requests.push(pathname);
  });
  const proxied = () => requests.some((path) => path.startsWith(`/api/hosts/${other}/proxy/`));
  const onEntry = async () => {
    await expect.poll(() => requests.includes('/api/snapshot')).toBe(true);
    expect(proxied()).toBe(false);
  };
  await page.goto(`/?computer=entry#/chat/${agent}`);
  await onEntry();
  // The marker stays with this document; the browser's saved selection is untouched.
  expect(new URL(page.url()).searchParams.get('computer')).toBe('entry');
  expect(new URL(page.url()).hash).toBe(`#/chat/${agent}`);
  expect(await page.evaluate(() => localStorage.getItem('dock:host'))).toBe(other);
  requests.length = 0;
  await page.reload();
  await onEntry();
  // An explicit choice in this tab removes the marker and applies the selection.
  await page.evaluate(() => (location.hash = '#/computers'));
  const computer = page.getByRole('combobox', { name: 'Computer' });
  await expect(computer.locator('option', { hasText: 'Shirai' })).toHaveCount(1);
  requests.length = 0;
  await computer.selectOption(other);
  await expect.poll(proxied).toBe(true);
  expect(new URL(page.url()).searchParams.has('computer')).toBe(false);
  expect(new URL(page.url()).hash).toBe('#/computers');
  expect(await page.evaluate(() => localStorage.getItem('dock:host'))).toBe(other);
});
