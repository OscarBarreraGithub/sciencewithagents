import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
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
  const tab = page.getByRole('tab', { name: 'Your chat', exact: true });
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
  await page.getByRole('button', { name: 'Private aside', exact: true }).click();
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
  await page.getByRole('button', { name: 'Private aside', exact: true }).click();
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
  await expect(page.locator('.group-host-status')).toContainText('Connect a Groups service');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Amina');
  await page.getByLabel('Project name', { exact: true }).fill('Retained setup intent');
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('configure protected Groups delivery');
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(
    'Retained setup intent',
  );
  await expect(page.locator('.groups-workspace')).toHaveCount(0);
});
test('fragment invitation joins a second authenticated host and exact creator approval opens its private context', async ({
  page,
  browser,
}) => {
  await enter(page);
  await create(page, 'Joined River');
  await page.getByText('Group controls', { exact: true }).click();
  await page.getByText('Invitations and approval', { exact: true }).click();
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const link = await page
    .getByLabel('Invitation (expires in 15 minutes)', { exact: true })
    .inputValue();
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
    await member.getByRole('button', { name: 'Request to join', exact: true }).click();
    await expect(member.locator('.group-host-notice')).toContainText(
      'Waiting for creator approval',
    );
    const confirmation = (await member.locator('.group-host-notice').textContent())!.match(
      /[a-f0-9]{64}/,
    )![0];
    const saved = await member.evaluate(() =>
      JSON.stringify({ ...sessionStorage, ...localStorage }),
    );
    expect(saved).not.toContain(invitationSecret);
    expect(saved).not.toContain(confirmation);
    await page.getByRole('button', { name: 'Refresh join requests', exact: true }).click();
    await page.getByRole('radio', { name: /Li Ming/ }).check();
    await page
      .getByLabel('Exact confirmation code from the member', { exact: true })
      .fill(confirmation);
    await page.getByRole('button', { name: 'Approve exact enrollment', exact: true }).click();
    await expect(
      page.getByLabel('Exact confirmation code from the member', { exact: true }),
    ).toHaveCount(0);
    await member.getByRole('button', { name: 'Back to groups', exact: true }).click();
    await member.locator('.groups-projects button').filter({ hasText: 'Joined River' }).click();
    await expect(member.getByRole('heading', { name: 'Joined River', exact: true })).toBeVisible();
    await chat(member);
    await member.getByRole('button', { name: 'Private aside', exact: true }).click();
    await member.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
    const privateInput = member.getByPlaceholder('Write a private note…');
    await privateInput.fill('SECOND-HOST-PRIVATE-CANARY');
    await member.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(member.locator('.conversation')).toContainText('SECOND-HOST-PRIVATE-CANARY');
    await member.reload();
    await chat(member);
    await member.getByRole('button', { name: 'Private aside', exact: true }).click();
    await expect(member.locator('.conversation')).toContainText('SECOND-HOST-PRIVATE-CANARY');
    await member.getByRole('button', { name: 'Back to group chat', exact: true }).click();
    await member.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
    const sharedInput = member.getByPlaceholder('Send a group message…');
    const original = '  SECOND-HOST-SHARED-EXACT\n🧬 original whitespace  ';
    await sharedInput.fill(original);
    await member.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(member.locator('.conversation')).toContainText('SECOND-HOST-SHARED-EXACT');
    await chat(page);
    await page.getByRole('combobox', { name: 'Send to', exact: true }).selectOption('message');
    await page.getByPlaceholder('Send a group message…').fill('FIRST-HOST-UNCERTAIN-COMMIT');
    const acknowledgement = page.waitForResponse(
      (r) => r.url().endsWith('/api/groups/send') && r.status() === 200,
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    expect((await (await acknowledgement).json()).delivery).toBe('uncertain');
    await expect(page.getByRole('button', { name: 'Retry delivery', exact: true })).toBeVisible();
    await page.reload();
    await chat(page);
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
  await page.getByRole('button', { name: 'Private aside', exact: true }).click();
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
