import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GroupHostOpen } from '@dock/shared/dist/group-host.js';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
type HostConnection = { origin: string; cookie: string; port: number };
let child: ChildProcess | undefined,
  connection: HostConnection & { secondary: HostConnection; unconfigured: HostConnection };
test.beforeAll(async () => {
  child = spawn(
    process.execPath,
    [
      join(root, 'apps/server/node_modules/tsx/dist/cli.mjs'),
      join(root, 'apps/server/src/group-host-browser.fixture.ts'),
      '--promotion-control',
    ],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe' },
  );
  child.stderr?.resume();
  connection = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Normal host harness startup timeout')), 30000);
    child!.once('exit', () => reject(new Error('Normal host harness exited')));
    child!.stdout!.on('data', (chunk) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        try {
          const data = JSON.parse(line) as typeof connection;
          if (data.origin && data.cookie) {
            clearTimeout(timer);
            resolve(data);
            return;
          }
        } catch {}
      }
    });
  });
});
test.afterAll(async () => {
  if (child && child.exitCode === null) {
    const end = new Promise<void>((r) => child!.once('exit', () => r()));
    child.kill('SIGTERM');
    await end;
  }
});
type PromotionSnapshot = {
  lostAcknowledgements: number;
  lostCommit?: { operationId: string; eventId: string; payloadHash: string };
  publication: { operationId: string; eventId: string; payloadHash: string; state: string } | null;
  synthesisRequests: number;
};
async function promotion(kind: 'pass' | 'inspect', loseCommit = false): Promise<PromotionSnapshot> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('Promotion fixture command timed out')), 15000);
    function finish(error?: Error, value?: PromotionSnapshot) {
      clearTimeout(timer);
      child!.stdout!.off('data', read);
      if (error) reject(error);
      else resolve(value!);
    }
    function read(chunk: Buffer) {
      output += chunk.toString();
      const lines = output.split('\n');
      output = lines.pop()!;
      for (const line of lines) {
        const value = JSON.parse(line) as PromotionSnapshot & { id: string };
        if (value.id === id) finish(undefined, value);
      }
    }
    child!.stdout!.on('data', read);
    child!.stdin!.write(JSON.stringify({ id, kind, loseCommit }) + '\n');
  });
}
async function authenticate(page: Page, host: HostConnection = connection) {
  const [name, ...parts] = host.cookie.split('=');
  await page
    .context()
    .addCookies([
      { name, value: parts.join('='), url: host.origin, httpOnly: true, sameSite: 'Strict' },
    ]);
}
async function enter(page: Page, host: HostConnection = connection) {
  await authenticate(page, host);
  await page.goto(`${host.origin}/#/home`);
  await page.locator('a[href="#/chats"]').first().click();
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Groups', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}
async function create(page: Page, name: string) {
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New group', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Your display name', { exact: true }).fill('Amina');
  await dialog.getByLabel('Project name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toMatch(/^#\/chats\/groups\/[a-f0-9-]+$/);
}
async function chat(page: Page) {
  await expect(page.locator('.groups-workspace')).toBeVisible();
  await page.getByRole('tab', { name: 'Group chat', exact: true }).click();
}
async function manager(page: Page) {
  await expect(page.locator('.groups-workspace')).toBeVisible();
  await page.getByRole('tab', { name: 'My group agent', exact: true }).click();
}
async function savedGroup(page: Page, host: HostConnection = connection) {
  const handle = new URL(page.url()).hash.split('/').at(-1)!;
  const response = await page.request.post(`${host.origin}/api/groups/open`, {
    headers: { Origin: host.origin },
    data: { handle },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as GroupHostOpen;
}
async function closeJoin(page: Page) {
  await page
    .getByRole('dialog', { name: 'Join a group', exact: true })
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
}
async function capture(page: Page, label: string) {
  await page.screenshot({
    path: join(root, 'data/normal-groups', `${test.info().project.name}-${label}.png`),
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    test.info().project.use.viewport!.width + 2,
  );
}
test('Chats filters groups, opens legacy routes and preserves shared drafts plus hidden private history', async ({
  page,
}) => {
  await enter(page);
  await expect(page.getByRole('link', { name: /Groups Shared work/ })).toHaveCount(0);
  await create(page, 'Normal River');
  const group = await savedGroup(page);
  const privateNote = 'LEGACY-PRIVATE-EXACT-NOTE\nsecond line';
  expect(
    (
      await page.request.post(`${connection.origin}/api/groups/send`, {
        headers: { Origin: connection.origin },
        data: { handle: group.private.handle, key: randomUUID(), text: privateNote },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post(`${connection.origin}/api/groups/draft`, {
        headers: { Origin: connection.origin },
        data: {
          handle: group.private.handle,
          key: randomUUID(),
          revision: 0,
          text: 'LEGACY-PRIVATE-DRAFT',
        },
      })
    ).ok(),
  ).toBe(true);
  const uiHandles: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/groups\/(chat|draft|send|request-agent|feed)$/.test(new URL(request.url()).pathname)
    ) {
      const body = request.postDataJSON() as { handle?: string };
      if (body.handle) uiHandles.push(body.handle);
    }
  });
  await chat(page);
  await expect(page.getByRole('tab')).toHaveText(['Group chat', 'My group agent']);
  await expect(page.getByRole('combobox', { name: 'Send to', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Agent request', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Private to you', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'What mattered since last visit?', exact: true }),
  ).toHaveCount(0);
  const input = page.getByPlaceholder('Message the group…');
  await expect(input).toBeEnabled();
  await input.fill('SHARED-UNSENT-DRAFT');
  await manager(page);
  await expect(page.getByRole('combobox', { name: 'Agent request' })).toHaveValue('ask');
  await expect(page.getByPlaceholder('Message my group agent…')).toHaveValue('SHARED-UNSENT-DRAFT');
  await page.getByRole('combobox', { name: 'Agent request' }).selectOption('work');
  await expect(page.getByPlaceholder('Message my group agent…')).toBeEnabled();
  await chat(page);
  await page.reload();
  await expect(input).toHaveValue('SHARED-UNSENT-DRAFT');
  await expect(page.locator('.conversation')).not.toContainText('LEGACY-PRIVATE');
  await manager(page);
  await expect(page.locator('.conversation')).not.toContainText('LEGACY-PRIVATE');
  await capture(page, 'group-manager');
  const retained = await page.request.post(`${connection.origin}/api/groups/chat`, {
    headers: { Origin: connection.origin },
    data: { handle: group.private.handle },
  });
  const privateChat = await retained.json();
  expect(privateChat.detail.entries.map((entry: { text: string }) => entry.text)).toContain(
    privateNote,
  );
  expect(privateChat.draft.text).toBe('LEGACY-PRIVATE-DRAFT');
  expect(uiHandles.length).toBeGreaterThan(0);
  expect(uiHandles).not.toContain(group.private.handle);
  await page.getByRole('button', { name: 'Back to groups', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Find a conversation', exact: true });
  await search.fill('No matching river');
  await expect(page.getByRole('navigation', { name: 'Group conversations' })).toContainText(
    'No groups match your search.',
  );
  await search.fill('normal');
  await expect(
    page
      .getByRole('navigation', { name: 'Group conversations' })
      .getByRole('button', { name: /Normal River/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  expect(new URL(page.url()).hash).toBe('#/chats');
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.goto(`${connection.origin}/#/groups`);
  await expect(page.getByRole('button', { name: 'Groups', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.goto(`${connection.origin}/#/groups/${group.group.handle}`);
  await expect(page.getByRole('heading', { name: 'Normal River', exact: true })).toBeVisible();
  await expect(input).toHaveValue('SHARED-UNSENT-DRAFT');
  await capture(page, 'legacy-group-route');
});
test('Groups refuses unauthenticated requests and keeps create input while explaining missing hosting', async ({
  page,
}) => {
  const host = connection.unconfigured;
  expect((await page.request.get(`${host.origin}/api/groups`)).status()).toBe(401);
  await enter(page, host);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New group', exact: true });
  await dialog.getByLabel('Your display name', { exact: true }).fill('Amina');
  await dialog.getByLabel('Project name', { exact: true }).fill('Retained setup intent');
  await expect(dialog.getByRole('button', { name: 'Create group', exact: true })).toBeDisabled();
  await expect(dialog).toContainText('Set up hosting once before creating your first group.');
  await dialog.getByRole('button', { name: 'Set up hosting', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Group setup', exact: true });
  await expect(setup).toBeVisible();
  await expect(setup.getByLabel('Cloudflare Groups setup prompt', { exact: true })).toContainText(
    /MY OWN Cloudflare/,
  );
  await setup.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog.getByLabel('Project name', { exact: true })).toHaveValue(
    'Retained setup intent',
  );
  await expect(page.locator('.groups-workspace')).toHaveCount(0);
});
test('beta setup code validation, definitive expiry/used replacement and ambiguous retry retain the right request', async ({
  page,
}) => {
  const host = connection.unconfigured;
  await authenticate(page, host);
  await page.route('**/api/groups', (route) =>
    route.fulfill({
      json: {
        groups: [],
        service: {
          configured: true,
          setupCodeRequired: true,
          message: 'Hosted Groups beta is available.',
        },
        native: {
          available: false,
          productionReady: false,
          authState: 'unavailable',
          message: 'Native setup remains separate.',
        },
      },
    }),
  );
  const attempts: { key: string; setupCode: string }[] = [];
  await page.route('**/api/groups/create', (route) => {
    attempts.push(route.request().postDataJSON());
    const code =
      attempts.length === 1
        ? 'GROUP_BETA_SETUP_INVALID'
        : attempts.length === 2
          ? 'GROUP_BETA_CREATION_EXPIRED'
          : attempts.length === 3
            ? 'GROUP_BETA_CODE_USED'
            : 'GROUP_SERVICE_UNAVAILABLE';
    return route.fulfill({
      status:
        attempts.length === 1
          ? 400
          : attempts.length === 2
            ? 410
            : attempts.length === 3
              ? 409
              : 503,
      json: {
        code,
        error:
          code === 'GROUP_BETA_CREATION_EXPIRED'
            ? 'This beta code expired before its group was created.'
            : code === 'GROUP_BETA_CODE_USED'
              ? 'This beta setup code has already been used.'
              : 'Controlled setup failure; your entries are retained.',
      },
    });
  });
  await page.goto(`${host.origin}/#/groups`);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Amina');
  await page.getByLabel('Project name', { exact: true }).fill('Fresh beta setup');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Paste your beta setup code');
  expect(attempts).toHaveLength(0);
  await page.getByLabel('Beta setup code', { exact: true }).fill('invalid-code-kept-in-memory');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Controlled setup failure');
  await page.getByLabel('Beta setup code', { exact: true }).fill('expired-code-kept-in-memory');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Use a new setup code', exact: true }),
  ).toBeVisible();
  expect(attempts[1].key).not.toBe(attempts[0].key);
  await capture(page, 'beta-code-expired');
  await page.getByRole('button', { name: 'Use a new setup code', exact: true }).click();
  await expect(page.getByLabel('Beta setup code', { exact: true })).toBeEmpty();
  await expect(page.getByLabel('Beta setup code', { exact: true })).toBeFocused();
  await page.getByLabel('Beta setup code', { exact: true }).fill('used-code-kept-in-memory');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already been used');
  await expect(
    page.getByRole('button', { name: 'Use a new setup code', exact: true }),
  ).toBeVisible();
  expect(attempts[2].key).not.toBe(attempts[1].key);
  await page.getByRole('button', { name: 'Use a new setup code', exact: true }).click();
  await expect(page.getByLabel('Beta setup code', { exact: true })).toBeEmpty();
  await page.getByLabel('Beta setup code', { exact: true }).fill('new-code-kept-in-memory');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Controlled setup failure');
  await expect(page.getByRole('button', { name: 'Use a new setup code', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect.poll(() => attempts.length).toBe(5);
  await expect(page.getByRole('button', { name: 'Create group', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toContainText('Controlled setup failure');
  expect(attempts[3].key).not.toBe(attempts[2].key);
  expect(attempts[3].key).toBe(attempts[4].key);
  const storage = await page.evaluate(() => JSON.stringify(sessionStorage));
  for (const attempt of attempts) expect(storage).not.toContain(attempt.setupCode);
  await capture(page, 'beta-code-retry');
});
test('fresh-page and same-tab invitations open Join without storing fragment secrets', async ({
  page,
}) => {
  await enter(page);
  const invites = Array.from({ length: 3 }, (_, i) => {
    const secret = randomBytes(32).toString('hex');
    const fragment = `#/groups?invite=${encodeURIComponent(
      JSON.stringify({ groupId: randomUUID(), secret, name: `Same-tab group ${i + 1}` }),
    )}`;
    return { secret, fragment, url: `${connection.origin}/${fragment}` };
  });
  const requestUrls: string[] = [];
  page.on('request', (request) => requestUrls.push(request.url()));
  await page.goto(invites[0].url);
  await expect(page.getByLabel('Invitation link', { exact: true })).toHaveValue(invites[0].url);
  expect(new URL(page.url()).hash).toBe('#/chats/groups');
  await closeJoin(page);
  await page.evaluate(() => {
    (window as unknown as { invitationRoutes: string[] }).invitationRoutes = [];
    window.addEventListener('hashchange', (event) => {
      (window as unknown as { invitationRoutes: string[] }).invitationRoutes.push(
        event.oldURL,
        event.newURL,
      );
    });
  });
  const open = async (index: number) => {
    await page.evaluate((fragment) => {
      location.hash = fragment;
    }, invites[index].fragment);
    await expect(page.getByRole('heading', { name: 'Join a group', exact: true })).toBeVisible();
    await expect(page.getByLabel('Invitation link', { exact: true })).toHaveValue(
      invites[index].url,
    );
    expect(new URL(page.url()).hash).toBe('#/chats/groups');
    await expect(page.getByText('This page is unavailable', { exact: true })).toHaveCount(0);
  };
  // Reopening the same link is a new handoff even though its string is unchanged.
  await open(0);
  await closeJoin(page);
  // The route is already #/chats/groups; a changed invitation must still update React.
  await open(1);
  await closeJoin(page);
  await create(page, 'Existing same-tab group');
  await open(2);
  await expect(page.locator('.groups-workspace')).toHaveCount(0);
  const browserState = await page.evaluate(() =>
    JSON.stringify({
      session: { ...sessionStorage },
      local: { ...localStorage },
      routes: (window as unknown as { invitationRoutes: string[] }).invitationRoutes,
      history: history.state,
    }),
  );
  for (const invite of invites) {
    expect(browserState).not.toContain(invite.secret);
    expect(requestUrls.join('\n')).not.toContain(invite.secret);
  }
  await capture(page, 'same-tab-invitation');
});
test('hosted invitations use the shared service instead of the creator private app address', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Portable invitation');
  await page.route('**/api/groups/invite', async (route) => {
    const response = await route.fetch();
    const value = (await response.json()) as { fragment: string; expiresAt: number };
    const payload = JSON.parse(
      new URLSearchParams(value.fragment.replace(/^\/groups\?/, '')).get('invite')!,
    );
    payload.service = { mode: 'hosted', endpoint: 'https://groups.example.test/' };
    await route.fulfill({
      json: { ...value, fragment: `/groups?invite=${encodeURIComponent(JSON.stringify(payload))}` },
    });
  });
  await page.getByRole('button', { name: 'Invite people', exact: true }).click();
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const link = await page.getByLabel('Invitation link', { exact: true }).inputValue();
  expect(new URL(link).origin).toBe('https://groups.example.test');
  expect(new URL(link).pathname).toBe('/join');
  expect(new URL(link).search).toBe('');
  expect(new URL(link).hash).toMatch(/^#\/groups\?invite=/);
  expect(new URL(link).origin).not.toBe(connection.origin);
  await capture(page, 'invite-people');
});

test('a newer invitation stays open when an earlier join acknowledgement arrives', async ({
  page,
}) => {
  await enter(page);
  const invitations = ['Earlier group', 'Newer group'].map((name) => {
    const groupId = randomUUID(),
      secret = randomBytes(32).toString('hex');
    const fragment = `#/groups?invite=${encodeURIComponent(JSON.stringify({ groupId, secret, name }))}`;
    return { name, groupId, secret, fragment, url: `${connection.origin}/${fragment}` };
  });
  let release!: () => void;
  const acknowledgement = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempts: { invitation: string }[] = [];
  await page.route('**/api/groups/join', async (route) => {
    attempts.push(route.request().postDataJSON());
    await acknowledgement;
    await route.fulfill({
      json: {
        group: {
          id: invitations[0].groupId,
          handle: randomUUID(),
          name: invitations[0].name,
          members: 2,
          sync: 'Current',
          state: 'active',
        },
        confirmation: 'a'.repeat(64),
      },
    });
  });
  try {
    await page.evaluate((fragment) => {
      location.hash = fragment;
    }, invitations[0].fragment);
    const dialog = page.getByRole('dialog', { name: 'Join a group', exact: true });
    await dialog.getByLabel('Your display name', { exact: true }).fill('Amina');
    await dialog.getByRole('button', { name: 'Join group', exact: true }).click();
    await expect.poll(() => attempts.length).toBe(1);
    expect(attempts[0].invitation).toBe(invitations[0].url);
    await page.evaluate((fragment) => {
      location.hash = fragment;
    }, invitations[1].fragment);
    await expect(dialog.getByLabel('Invitation link', { exact: true })).toHaveValue(
      invitations[1].url,
    );
    release();
    await expect(dialog.getByRole('button', { name: 'Join group', exact: true })).toBeEnabled();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Invitation link', { exact: true })).toHaveValue(
      invitations[1].url,
    );
    expect(new URL(page.url()).hash).toBe('#/chats/groups');
    expect(attempts).toHaveLength(1);
    const saved = await page.evaluate(() =>
      JSON.stringify({ ...sessionStorage, ...localStorage, history: history.state }),
    );
    for (const invitation of invitations) expect(saved).not.toContain(invitation.secret);
  } finally {
    release();
  }
});

test('a failed list refresh keeps saved groups visible and offers a working retry', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Retained list River');
  // Creation refreshes the cached sidebar asynchronously. Retain that completed
  // list before the next ordinary navigation asks the host to refresh it.
  await expect(
    page.locator('.groups-chat-list .chat-row').filter({ hasText: 'Retained list River' }),
  ).toHaveCount(1);
  const sidebar = page.getByRole('complementary', { name: 'Conversations', exact: true });
  const saved = sidebar
    .getByRole('navigation', { name: 'Group conversations', exact: true })
    .getByRole('button', { name: /Retained list River/ });
  let reads = 0;
  await page.route('**/api/groups', (route) => {
    if (++reads === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'Saved group list is temporarily unavailable.' },
      });
    return route.continue();
  });
  await page.getByRole('button', { name: 'Back to groups', exact: true }).click();
  await expect(sidebar.getByRole('alert')).toContainText(
    'Saved group list is temporarily unavailable.',
  );
  await expect(saved).toBeVisible();
  await sidebar.getByRole('button', { name: 'Retry groups', exact: true }).click();
  await expect(sidebar.getByRole('alert')).toHaveCount(0);
  await expect(saved).toBeVisible();
  expect(reads).toBeGreaterThanOrEqual(2);
});

test('invitation joins a second host, shares exact human bubbles and retries the same delivery without publishing private history', async ({
  page,
  browser,
}) => {
  await enter(page);
  await create(page, 'Joined River');
  await page.getByRole('button', { name: 'Invite people', exact: true }).click();
  await expect(page.getByRole('link', { name: 'setup guide', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const link = await page.getByLabel('Invitation link', { exact: true }).inputValue();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as Window & { copiedInvitation?: string }).copiedInvitation = text;
        },
      },
    });
  });
  await page.getByRole('button', { name: 'Copy invitation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Invitation copied', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => (window as Window & { copiedInvitation?: string }).copiedInvitation),
  ).toBe(link);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const fragment = new URL(link).hash;
  const invitationSecret = JSON.parse(
    new URLSearchParams(fragment.replace(/^#\/?groups\??/, '')).get('invite')!,
  ).secret;
  const context = await browser.newContext({ viewport: test.info().project.use.viewport });
  try {
    const member = await context.newPage();
    await authenticate(member, connection.secondary);
    await member.goto(`${connection.secondary.origin}/${fragment}`);
    const joinDialog = member.getByRole('dialog', { name: 'Join a group', exact: true });
    await expect(joinDialog).toBeVisible();
    await expect(joinDialog.getByLabel('Invitation link', { exact: true })).toHaveValue(
      `${connection.secondary.origin}/${fragment}`,
    );
    expect(new URL(member.url()).hash).not.toContain(invitationSecret);
    await joinDialog.getByLabel('Your display name', { exact: true }).fill('Li Ming');
    await joinDialog.getByRole('button', { name: 'Join group', exact: true }).click();
    await expect(joinDialog).toHaveCount(0);
    await expect(member.getByRole('heading', { name: 'Joined River', exact: true })).toBeVisible();
    await expect(member.getByLabel('Confirmation code', { exact: true })).toHaveCount(0);
    const saved = await member.evaluate(() =>
      JSON.stringify({ ...sessionStorage, ...localStorage }),
    );
    expect(saved).not.toContain(invitationSecret);
    await expect(page.locator('.groups-member-list summary')).toHaveText('2 members', {
      timeout: 15000,
    });
    await page.locator('.groups-member-list summary').click();
    await expect(page.locator('.groups-member-list')).toContainText('Li Ming', { timeout: 15000 });
    await capture(member, 'joined-directly');
    await capture(page, 'joined-members');
    await page.locator('.groups-member-list summary').click();
    const memberGroup = await savedGroup(member, connection.secondary);
    expect(
      (
        await member.request.post(`${connection.secondary.origin}/api/groups/send`, {
          headers: { Origin: connection.secondary.origin },
          data: {
            handle: memberGroup.private.handle,
            key: randomUUID(),
            text: 'SECOND-HOST-PRIVATE-CANARY',
          },
        })
      ).ok(),
    ).toBe(true);
    await member.reload();
    await chat(member);
    await expect(member.getByRole('tab')).toHaveText(['Group chat', 'My group agent']);
    await expect(member.getByRole('combobox', { name: 'Send to', exact: true })).toHaveCount(0);
    const original =
      'SECOND-HOST-SHARED-EXACT\n' +
      'Exact original context. '.repeat(30) +
      '\n🧬 final original line';
    const sharedInput = member.getByPlaceholder('Message the group…');
    await sharedInput.fill(original);
    await member.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(
      member.locator('.conversation .message').filter({ hasText: 'SECOND-HOST-SHARED-EXACT' }),
    ).toHaveCount(1);
    await promotion('pass', true);
    await chat(page);
    await page.getByPlaceholder('Message the group…').fill('FIRST-HOST-UNCERTAIN-COMMIT');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.conversation')).toContainText('FIRST-HOST-UNCERTAIN-COMMIT');
    await expect.poll(async () => (await promotion('inspect')).lostAcknowledgements).toBe(1);
    const lost = await promotion('inspect');
    expect(lost.lostCommit).toBeDefined();
    expect(lost.publication).toEqual({ ...lost.lostCommit, state: 'uncertain' });
    expect(lost.synthesisRequests).toBe(0);
    await page.getByText('Message details', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry delivery', exact: true })).toBeVisible();
    await page.reload();
    await chat(page);
    expect((await promotion('inspect')).publication).toEqual(lost.publication);
    await page.getByText('Message details', { exact: true }).click();
    await page.getByRole('button', { name: 'Retry delivery', exact: true }).click();
    await expect
      .poll(async () => (await promotion('inspect')).publication, { intervals: [250, 500, 1000] })
      .toEqual({ ...lost.lostCommit, state: 'complete' });
    expect((await promotion('inspect')).synthesisRequests).toBe(0);
    const otherBubble = page
      .locator('.conversation .message')
      .filter({ hasText: 'SECOND-HOST-SHARED-EXACT' });
    await expect(otherBubble).toHaveCount(1, { timeout: 15000 });
    await expect(otherBubble.locator('.message-heading')).toContainText('Li Ming', {
      timeout: 15000,
    });
    await expect(otherBubble.locator('.markdown')).toContainText('🧬 final original line');
    await expect(
      page.locator('.conversation .message').filter({ hasText: 'FIRST-HOST-UNCERTAIN-COMMIT' }),
    ).toHaveCount(1);
    await expect(member.locator('.conversation')).toContainText('FIRST-HOST-UNCERTAIN-COMMIT', {
      timeout: 15000,
    });
    await expect(page.locator('.conversation')).not.toContainText('SECOND-HOST-PRIVATE-CANARY');
    await manager(page);
    await expect(page.locator('.conversation')).not.toContainText('SECOND-HOST-PRIVATE-CANARY');
    const privateHistory = await member.request.post(
      `${connection.secondary.origin}/api/groups/chat`,
      {
        headers: { Origin: connection.secondary.origin },
        data: { handle: memberGroup.private.handle },
      },
    );
    expect(
      (await privateHistory.json()).detail.entries.map((entry: { text: string }) => entry.text),
    ).toContain('SECOND-HOST-PRIVATE-CANARY');
    await capture(page, 'shared-human-bubbles');
  } finally {
    await context.close().catch(() => {});
  }
});
test('Group chat receives other members as normal bubbles without a writer, reload or refresh click', async ({
  page,
  browser,
}) => {
  await enter(page);
  await create(page, 'Live chat River');
  await page.getByRole('button', { name: 'Invite people', exact: true }).click();
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const link = await page.getByLabel('Invitation link', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await chat(page);
  const context = await browser.newContext({ viewport: test.info().project.use.viewport });
  try {
    const member = await context.newPage();
    await authenticate(member, connection.secondary);
    await member.goto(`${connection.secondary.origin}/${new URL(link).hash}`);
    const dialog = member.getByRole('dialog', { name: 'Join a group', exact: true });
    await dialog.getByLabel('Your display name', { exact: true }).fill('Li Ming');
    await dialog.getByRole('button', { name: 'Join group', exact: true }).click();
    await expect(
      member.getByRole('heading', { name: 'Live chat River', exact: true }),
    ).toBeVisible();
    await member.getByPlaceholder('Message the group…').fill('Live message from Li Ming');
    await member.getByRole('button', { name: 'Send message', exact: true }).click();
    const transcript = page.locator('.conversation');
    await expect(transcript).toContainText('Live message from Li Ming', { timeout: 15000 });
    await expect(
      transcript
        .locator('.message')
        .filter({ hasText: 'Live message from Li Ming' })
        .locator('.message-heading'),
    ).toContainText('Li Ming', { timeout: 15000 });
    await expect(
      page.locator('.chat-row.group').filter({ hasText: 'Live chat River' }),
    ).toContainText('2 members');
    await member.getByPlaceholder('Message the group…').fill('A second shared update');
    await member.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(transcript).toContainText('A second shared update', { timeout: 15000 });
    await expect(transcript.locator('.message')).toHaveCount(2);
    await expect(page.getByRole('tab', { name: 'Shared feed', exact: true })).toHaveCount(0);
    expect((await promotion('inspect')).synthesisRequests).toBe(0);
    await capture(page, 'live-chat');
  } finally {
    await context.close();
  }
});
test('150% text keeps Group chat and My group agent conversations and composers reachable', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Large text River');
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '150%';
  });
  await chat(page);
  const shared = page.getByPlaceholder('Message the group…');
  await shared.fill('LARGE-SHARED-MESSAGE');
  await shared.scrollIntoViewIfNeeded();
  await expect(shared).toBeVisible();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.conversation')).toContainText('LARGE-SHARED-MESSAGE');
  const transcript = page.locator('.conversation');
  expect(await transcript.evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(120);
  await transcript.locator('.message').last().scrollIntoViewIfNeeded();
  await capture(page, 'large-group-chat');
  await manager(page);
  const input = page.getByPlaceholder('Message my group agent…');
  await input.fill('LARGE-MANAGER-DRAFT');
  await input.scrollIntoViewIfNeeded();
  await expect(input).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Agent request', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send message', exact: true }).scrollIntoViewIfNeeded();
  await capture(page, 'large-group-manager');
});

test('Group chat starts full-width and management preserves its conversation and draft', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Room to read');
  await expect(page.getByRole('tab', { name: 'Group chat', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const draft = page.getByPlaceholder('Message the group…');
  await draft.fill('Keep this draft while managing the group');
  const transcript = page.locator('.conversation');
  const before = await transcript.boundingBox();
  const composer = await page.locator('.composer').boundingBox();
  const viewport = page.viewportSize()!;
  expect(before!.width).toBeGreaterThan(viewport.width * 0.7);
  expect(before!.height).toBeGreaterThanOrEqual(
    viewport.height > 500 ? viewport.height * 0.4 : 100,
  );
  expect(before!.y).toBeGreaterThanOrEqual(0);
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(viewport.height + 2);
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Manage group' })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(draft).toHaveValue('Keep this draft while managing the group');
  const after = await transcript.boundingBox();
  expect(after!.height).toBeCloseTo(before!.height, 0);
  await capture(page, 'room-to-read');
});
