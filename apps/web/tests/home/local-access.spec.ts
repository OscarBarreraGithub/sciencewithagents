import { test, expect } from '../fixtures/protected-app';

const projectKey = 'dock:local:project-draft';
const mirrorKey = 'dock:mirror:local:claude:retained-thread';
const pendingKey = 'dock:local:workspace:pending';
const archivePrefix = 'dock:local-access:retained:';

test('native handoff retains shared drafts, and an old tab reconnects its own editor and pending records', async ({
  page,
  context,
  protectedApp,
}, info) => {
  const { origin, browserOrigin } = protectedApp;
  const writes: string[] = [];
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (
      request.method() === 'POST' &&
      !url.pathname.startsWith('/api/local-access/') &&
      url.pathname !== '/api/setup/check'
    )
      writes.push(url.pathname);
    expect(url.search).not.toMatch(/ticket|credential|authorization/);
  });
  await page.goto(`${origin}/api/health`);
  await page.evaluate(
    ({ projectKey, mirrorKey, pendingKey }) => {
      localStorage.setItem(projectKey, 'Unsent project idea');
      localStorage.setItem('unrelated-site-data', 'Keep here');
      sessionStorage.setItem(
        mirrorKey,
        JSON.stringify({ text: 'Unsent editor reply', provider: 'claude', host: 'local' }),
      );
      sessionStorage.setItem(
        pendingKey,
        JSON.stringify({ key: 'original-request-id', text: 'Pending response' }),
      );
    },
    { projectKey, mirrorKey, pendingKey },
  );
  await page.goto(`${origin}/?mirror=1`);
  await expect(page.getByRole('heading', { name: 'Reconnect your workspace' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open desktop app' })).toBeVisible();

  // A newly opened native browser tab cannot read another tab's session storage.
  const native = await context.newPage();
  await native.goto(await protectedApp.handoff());
  await expect(native.locator('.home-shell')).toBeVisible();
  expect(new URL(native.url()).origin).toBe(browserOrigin);
  expect(await native.evaluate((key) => localStorage.getItem(key), projectKey)).toBe(
    'Unsent project idea',
  );
  expect(await native.evaluate((key) => sessionStorage.getItem(key), mirrorKey)).toBeNull();
  expect(await native.evaluate(() => localStorage.getItem('unrelated-site-data'))).toBeNull();
  expect((await native.request.get(`${origin}/api/snapshot`)).status()).toBe(401);
  expect((await native.request.get(`${browserOrigin}/api/snapshot`)).ok()).toBe(true);
  await native.close();

  await page.bringToFront();
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await expect(page.locator('.home-shell')).toBeVisible();
  await expect(page).toHaveURL(`${browserOrigin}/#/vscode`);
  expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), mirrorKey)).toEqual(
    { text: 'Unsent editor reply', provider: 'claude', host: 'local' },
  );
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), pendingKey),
  ).toEqual({ key: 'original-request-id', text: 'Pending response' });
  // The source is retained and reconnecting did not replay anything.
  await page.goto(`${origin}/api/health`);
  expect(await page.evaluate((key) => localStorage.getItem(key), projectKey)).toBe(
    'Unsent project idea',
  );
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).key, pendingKey),
  ).toBe('original-request-id');
  expect(writes).toEqual([]);
});

test('conflicting versions remain readable without replacing current drafts or resurrecting cleared requests', async ({
  page,
  protectedApp,
}, info) => {
  const { origin, browserOrigin } = protectedApp;
  const hostileText = '</script><script>window.draftExecuted=true</script>';
  await page.goto(`${origin}/api/health`);
  await page.evaluate(
    ({ projectKey, pendingKey, hostileText }) => {
      localStorage.setItem(projectKey, hostileText);
      localStorage.setItem(pendingKey, 'old-pending-receipt');
    },
    { projectKey, pendingKey, hostileText },
  );
  await page.goto(`${browserOrigin}/api/health`);
  await page.evaluate((key) => localStorage.setItem(key, 'Current draft'), projectKey);
  await page.goto(await protectedApp.handoff());
  await expect(page.getByRole('heading', { name: 'Your drafts are retained' })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { draftExecuted?: boolean }).draftExecuted),
  ).toBeUndefined();
  expect(await page.evaluate((key) => localStorage.getItem(key), projectKey)).toBe('Current draft');
  await page.getByRole('link', { name: 'Review retained drafts' }).click();
  await expect(page.getByRole('heading', { name: 'Retained browser drafts' })).toBeVisible();
  await page.locator('.retained-copy > summary').click();
  await page.locator('.retained-entry > summary').click();
  await expect(page.getByRole('textbox', { name: 'Retained text' })).toHaveValue(hostileText);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/screenshots/connections/${info.project.name}-retained-drafts.png`,
  });
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download this copy' }).click();
  expect((await downloaded).suggestedFilename()).toBe(
    'sciencewithagents-retained-browser-drafts.json',
  );
  await page.evaluate((key) => localStorage.removeItem(key), pendingKey);
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Your drafts are retained' })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBeNull();
  const copies = await page.evaluate(
    (prefix) =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith(prefix))
        .map((key) => JSON.parse(localStorage.getItem(key)!)),
    archivePrefix,
  );
  expect(
    copies.some((copy) =>
      copy.entries.some(
        (entry: { key: string; value: string }) =>
          entry.key === pendingKey && entry.value === 'old-pending-receipt',
      ),
    ),
  ).toBe(true);
});

test('editor sharing requires no separate code or credential exchange', async ({
  page,
  protectedApp,
}) => {
  await page.goto(await protectedApp.handoff());
  await expect(page.locator('.home-shell')).toBeVisible();
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && !request.url().endsWith('/api/setup/check'))
      writes.push(request.url());
  });
  await page.goto(`${protectedApp.browserOrigin}/#/vscode`);
  await expect(page.getByRole('heading', { name: 'VS Code chats' })).toBeVisible();
  await expect(page.getByText('Share a Codex conversation', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create connection code' })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('expired browser access waits without redirect loops and resumes the intended screen after app opening', async ({
  page,
  context,
  protectedApp,
}) => {
  await page.goto(await protectedApp.handoff());
  await expect(page.locator('.home-shell')).toBeVisible();
  const target = `${protectedApp.browserOrigin}/#/vscode`;
  await page.goto(target);
  await context.clearCookies();
  // The expired page may redirect as soon as a pending API request returns 401.
  // Wait for the reload to commit, then assert the actual reconnect destination.
  await page.reload({ waitUntil: 'commit' });
  await expect(page.getByRole('heading', { name: 'Reconnect your workspace' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open desktop app' })).toBeVisible();
  const waiting = page.url();
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open desktop app' })).toBeVisible();
  await expect(page).toHaveURL(waiting);
  const native = await context.newPage();
  await native.goto(await protectedApp.handoff());
  await expect(native.locator('.home-shell')).toBeVisible();
  await page.bringToFront();
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await expect(page).toHaveURL(target);
  await expect(page.getByRole('heading', { name: 'VS Code chats' })).toBeVisible();
  await native.close();
});

test('a connected browser follows an editor link directly without another connection action', async ({
  page,
  protectedApp,
}) => {
  await page.goto(await protectedApp.handoff());
  await expect(page.locator('.home-shell')).toBeVisible();
  await page.goto(`${protectedApp.origin}/?mirror=1`);
  await expect(page).toHaveURL(`${protectedApp.browserOrigin}/#/vscode`);
  await expect(page.getByRole('heading', { name: 'VS Code chats' })).toBeVisible();
});
