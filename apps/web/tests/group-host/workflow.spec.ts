import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
async function enter(page: Page) {
  await authenticate(page);
  await page.goto(`${connection.origin}/#/home`);
  await page.getByRole('link', { name: /Groups Shared work/ }).click();
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
}
async function create(page: Page, name: string) {
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Amina');
  await page.getByLabel('Project name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function chat(page: Page) {
  await expect(page.locator('.groups-workspace')).toBeVisible();
  const tab = page.getByRole('tab', { name: 'Shared chat', exact: true });
  if (await tab.count()) await tab.click();
}
async function feed(page: Page) {
  await expect(page.locator('.groups-workspace')).toBeVisible();
  const tab = page.getByRole('tab', { name: 'Shared feed', exact: true });
  if (await tab.count()) await tab.click();
}
async function capture(page: Page, label: string) {
  await page.screenshot({
    path: join(root, 'data/normal-groups', `${test.info().project.name}-${label}.png`),
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    test.info().project.use.viewport!.width + 2,
  );
}
test('normal Home navigation, authenticated create, saved private notes/drafts, reload and missing verified native setup', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Normal River');
  await chat(page);
  await expect(page.getByRole('combobox', { name: 'Agent request' })).toHaveValue('ask');
  await page.getByRole('combobox', { name: 'Agent request' }).selectOption('work');
  await expect(page.getByPlaceholder('Message your group agent…')).toBeEnabled();
  await page.getByRole('combobox', { name: 'Agent request' }).selectOption('ask');
  await page.getByText('Group controls', { exact: true }).click();
  await page.getByText('Shared work and actions', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'Shared work board' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Shared work board' })).toContainText(
    'No shared tasks yet.',
  );
  await capture(page, 'actions');
  await page.getByText('Shared work and actions', { exact: true }).click();
  await page.getByText('Group controls', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
  const shared = page.getByPlaceholder('Send a group message…');
  await expect(shared).toBeEnabled();
  await shared.fill('SHARED-UNSENT-DRAFT');
  await page.getByRole('button', { name: 'Private to you', exact: true }).click();
  await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
  const input = page.getByPlaceholder('Write a private note…');
  await expect(input).toBeEnabled();
  await input.fill('PRIVATE-EXACT-NOTE\nsecond line');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.conversation')).toContainText('PRIVATE-EXACT-NOTE');
  await page.getByRole('button', { name: 'What mattered since last visit?', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Private catch-up', exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Read since my last acknowledgement', exact: true })
    .click();
  await expect(page.locator('.group-catchup')).toContainText('No new shared events');
  await capture(page, 'catchup');
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(input).toHaveValue('');
  await input.fill('PRIVATE-DRAFT-RELOAD');
  await capture(page, 'private');
  await page.reload();
  await chat(page);
  await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
  await expect(shared).toHaveValue('SHARED-UNSENT-DRAFT');
  await page.getByRole('button', { name: 'Private to you', exact: true }).click();
  await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
  await expect(input).toHaveValue('PRIVATE-DRAFT-RELOAD');
  await expect(page.locator('.conversation')).toContainText('PRIVATE-EXACT-NOTE');
  await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('agent');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('verified isolated native adapter');
  await feed(page);
  await expect(page.locator('.groups-feed-panel')).not.toContainText('PRIVATE-EXACT-NOTE');
  await capture(page, 'feed');
});
test('normal Groups refuses unauthenticated requests and explains missing host setup while retaining form input', async ({
  page,
}) => {
  const host = connection.unconfigured;
  expect((await page.request.get(`${host.origin}/api/groups`)).status()).toBe(401);
  await authenticate(page, host);
  await page.goto(`${host.origin}/#/home`);
  await page.getByRole('link', { name: /Groups Shared work/ }).click();
  await page.getByText('Groups delivery and agent setup', { exact: true }).click();
  await expect(page.locator('.group-host-status').first()).toContainText(
    'creator’s own Cloudflare',
  );
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Amina');
  await page.getByLabel('Project name', { exact: true }).fill('Retained setup intent');
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Copy the Cloudflare setup prompt');
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(
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
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Amina');
  await page.getByLabel('Project name', { exact: true }).fill('Fresh beta setup');
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Paste your beta setup code');
  expect(attempts).toHaveLength(0);
  await page.getByLabel('Beta setup code', { exact: true }).fill('invalid-code-kept-in-memory');
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Controlled setup failure');
  await page.getByLabel('Beta setup code', { exact: true }).fill('expired-code-kept-in-memory');
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Use a new setup code', exact: true }),
  ).toBeVisible();
  expect(attempts[1].key).not.toBe(attempts[0].key);
  await capture(page, 'beta-code-expired');
  await page.getByRole('button', { name: 'Use a new setup code', exact: true }).click();
  await expect(page.getByLabel('Beta setup code', { exact: true })).toBeEmpty();
  await expect(page.getByLabel('Beta setup code', { exact: true })).toBeFocused();
  await page.getByLabel('Beta setup code', { exact: true }).fill('used-code-kept-in-memory');
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already been used');
  await expect(
    page.getByRole('button', { name: 'Use a new setup code', exact: true }),
  ).toBeVisible();
  expect(attempts[2].key).not.toBe(attempts[1].key);
  await page.getByRole('button', { name: 'Use a new setup code', exact: true }).click();
  await expect(page.getByLabel('Beta setup code', { exact: true })).toBeEmpty();
  await page.getByLabel('Beta setup code', { exact: true }).fill('new-code-kept-in-memory');
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Controlled setup failure');
  await expect(page.getByRole('button', { name: 'Use a new setup code', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect.poll(() => attempts.length).toBe(5);
  await expect(page.getByRole('button', { name: 'Continue setup', exact: true })).toBeEnabled();
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
  expect(new URL(page.url()).hash).toBe('#/groups');
  await page.getByRole('button', { name: 'Back to groups', exact: true }).click();
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
    await expect(page.getByRole('heading', { name: 'Join a project', exact: true })).toBeVisible();
    await expect(page.getByLabel('Invitation link', { exact: true })).toHaveValue(
      invites[index].url,
    );
    expect(new URL(page.url()).hash).toBe('#/groups');
    await expect(page.getByText('This page is unavailable', { exact: true })).toHaveCount(0);
  };
  // Reopening the same link is a new handoff even though its string is unchanged.
  await open(0);
  await page.getByRole('button', { name: 'Back to groups', exact: true }).click();
  // The route is already #/groups; a changed invitation must still update React.
  await open(1);
  await page.getByRole('button', { name: 'Back to groups', exact: true }).click();
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
  const link = await page
    .getByLabel('Invitation (expires in 15 minutes)', { exact: true })
    .inputValue();
  expect(new URL(link).origin).toBe('https://groups.example.test');
  expect(new URL(link).pathname).toBe('/join');
  expect(new URL(link).search).toBe('');
  expect(new URL(link).hash).toMatch(/^#\/groups\?invite=/);
  expect(new URL(link).origin).not.toBe(connection.origin);
  await capture(page, 'invite-people');
});

test('invitation directly joins a second authenticated host and opens its private context', async ({
  page,
  browser,
}) => {
  await enter(page);
  await create(page, 'Joined River');
  await page.getByRole('button', { name: 'Invite people', exact: true }).click();
  await expect(page.getByRole('link', { name: 'setup guide', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const link = await page
    .getByLabel('Invitation (expires in 15 minutes)', { exact: true })
    .inputValue();
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
  const fragment = new URL(link).hash;
  const invitationSecret = JSON.parse(
    new URLSearchParams(fragment.replace(/^#\/?groups\??/, '')).get('invite')!,
  ).secret;
  const context = await browser.newContext({ viewport: test.info().project.use.viewport });
  try {
    const member = await context.newPage();
    await authenticate(member, connection.secondary);
    await member.goto(`${connection.secondary.origin}/${fragment}`);
    await expect(member.getByLabel('Invitation link', { exact: true })).toHaveValue(
      `${connection.secondary.origin}/${fragment}`,
    );
    expect(new URL(member.url()).hash).toBe('#/groups');
    await member.getByLabel('Your display name', { exact: true }).fill('Li Ming');
    await member.getByRole('button', { name: 'Join group', exact: true }).click();
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
    await expect(page.locator('.groups-member-list')).toContainText('Li Ming');
    await capture(member, 'joined-directly');
    await capture(page, 'joined-members');
    await page.getByText('Shared feed agent', { exact: true }).click();
    await page
      .getByRole('button', { name: 'Use this computer for the shared feed', exact: true })
      .click();
    await expect(
      page.getByText('This computer is the shared feed writer.', { exact: false }),
    ).toBeVisible();
    await page.getByText('Group controls', { exact: true }).click();
    await chat(member);
    await member.getByRole('button', { name: 'Private to you', exact: true }).click();
    await member.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
    const privateInput = member.getByPlaceholder('Write a private note…');
    await privateInput.fill('SECOND-HOST-PRIVATE-CANARY');
    await member.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(member.locator('.conversation')).toContainText('SECOND-HOST-PRIVATE-CANARY');
    await member.reload();
    await chat(member);
    await member.getByRole('button', { name: 'Private to you', exact: true }).click();
    await expect(member.locator('.conversation')).toContainText('SECOND-HOST-PRIVATE-CANARY');
    await member.getByRole('button', { name: 'Back to shared chat', exact: true }).click();
    await member.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
    const sharedInput = member.getByPlaceholder('Send a group message…');
    const original = '  SECOND-HOST-SHARED-EXACT\n🧬 original whitespace  ';
    await sharedInput.fill(original);
    await member.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(member.locator('.conversation')).toContainText('SECOND-HOST-SHARED-EXACT');
    await promotion('pass');
    await chat(page);
    await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
    await page.getByPlaceholder('Send a group message…').fill('FIRST-HOST-UNCERTAIN-COMMIT');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.conversation')).toContainText('FIRST-HOST-UNCERTAIN-COMMIT');
    const lost = await promotion('pass', true);
    expect(lost.lostAcknowledgements).toBe(1);
    expect(lost.lostCommit).toBeDefined();
    expect(lost.publication).toEqual({ ...lost.lostCommit, state: 'uncertain' });
    expect(lost.synthesisRequests).toBe(2);
    await expect(page.getByRole('button', { name: 'Retry delivery', exact: true })).toBeVisible();
    await page.reload();
    await chat(page);
    expect((await promotion('inspect')).publication).toEqual(lost.publication);
    // Existing durable backoff remains authoritative; advance the normal writer lifecycle.
    await expect
      .poll(async () => (await promotion('pass')).publication, { intervals: [250, 500, 1000] })
      .toEqual({ ...lost.lostCommit, state: 'complete' });
    const recovered = await promotion('inspect');
    expect(recovered.lostAcknowledgements).toBe(1);
    expect(recovered.synthesisRequests).toBe(2);
    await page.getByRole('button', { name: 'Retry delivery', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry delivery', exact: true })).toHaveCount(0);
    await feed(page);
    await page.getByRole('button', { name: 'Refresh shared feed', exact: true }).click();
    await expect(page.locator('.groups-feed-panel')).toContainText('SECOND-HOST-SHARED-EXACT');
    await expect(page.locator('.groups-feed-panel')).toContainText('FIRST-HOST-UNCERTAIN-COMMIT');
    await expect(page.locator('.groups-feed-panel article')).toHaveCount(2);
    await page
      .locator('.groups-feed-panel article')
      .filter({ hasText: 'SECOND-HOST-SHARED-EXACT' })
      .getByRole('button', { name: 'Read exact original', exact: true })
      .click();
    await expect(page.locator('.groups-original')).toContainText(original);
    await expect(page.locator('.groups-feed-panel')).not.toContainText(
      'SECOND-HOST-PRIVATE-CANARY',
    );
  } finally {
    await context.close().catch(() => {});
  }
});
test('150% text keeps shared/private Conversation and Composer reachable with nested scrolling', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Large text River');
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '150%';
  });
  await chat(page);
  await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
  const shared = page.getByPlaceholder('Send a group message…');
  await shared.fill('READABLE-PRIVATE-DRAFT');
  await shared.scrollIntoViewIfNeeded();
  await expect(shared).toBeVisible();
  await capture(page, 'large-shared-composer');
  await page.getByRole('button', { name: 'Private to you', exact: true }).click();
  await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
  const input = page.getByPlaceholder('Write a private note…');
  await input.fill('LARGE-PRIVATE-NOTE');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.conversation')).toContainText('LARGE-PRIVATE-NOTE');
  await page.locator('.conversation').scrollIntoViewIfNeeded();
  const panel = page.locator('.groups-chat-panel');
  expect(await panel.evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(120);
  expect(
    await page.locator('.conversation').evaluate((el) => el.clientHeight),
  ).toBeGreaterThanOrEqual(120);
  const last = page.locator('.conversation .message').last();
  const transcript = page.locator('.conversation');
  await transcript.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
  await capture(page, 'large-private-reading');
  await input.scrollIntoViewIfNeeded();
  await expect(input).toBeVisible();
  await page.getByRole('button', { name: 'Send message', exact: true }).scrollIntoViewIfNeeded();
  await capture(page, 'large-private-composer');
});
