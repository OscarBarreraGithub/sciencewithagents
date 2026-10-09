import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
      '--controlled-agent',
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
  expect(child?.exitCode).toBe(0);
});
async function fixtureCommand(
  kind: 'inspect' | 'feature',
  fields?: { handle: string; text: string },
): Promise<{ synthesisRequests: number }> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('Feature fixture command timed out')), 15000);
    function finish(error?: Error, value?: { synthesisRequests: number }) {
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
        const value = JSON.parse(line) as { id: string; synthesisRequests: number };
        if (value.id === id) finish(undefined, value);
      }
    }
    child!.stdout!.on('data', read);
    child!.stdin!.write(JSON.stringify({ id, kind, ...fields }) + '\n');
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
async function savedGroup(page: Page, host: HostConnection = connection) {
  const handle = new URL(page.url()).hash.split('/').at(-1)!;
  const response = await page.request.post(`${host.origin}/api/groups/open`, {
    headers: { Origin: host.origin },
    data: { handle },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as GroupHostOpen;
}
async function capture(page: Page, label: string) {
  await page.screenshot({
    path: join(root, 'data/normal-groups', `${test.info().project.name}-${label}.png`),
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    test.info().project.use.viewport!.width + 2,
  );
}
test('normal Groups opens scoped report notifications and keeps Advanced and shared drafts across refresh', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Clear Meadow');
  const saved = await savedGroup(page);
  const publicationId = randomUUID();
  const manifestHash = 'a'.repeat(64);
  const original = JSON.stringify(
    {
      kind: 'shared-report',
      title: 'Retained study · α → β 📚',
      publication: { publicationId, manifestHash },
      href: `#/groups/report/${publicationId}/${manifestHash}`,
    },
    null,
    2,
  );
  await fixtureCommand('feature', { handle: saved.shared.handle, text: original });
  // An unrelated original must never create a report button, even with a similar-looking URL.
  await fixtureCommand('feature', {
    handle: saved.shared.handle,
    text: 'Unrelated text #/groups/report/not-a-publication',
  });
  await page.reload();
  await chat(page);
  await expect(page.getByRole('tab')).toHaveText(['Group chat', 'My group agent']);
  await expect(page.getByText('Retained study · α → β 📚', { exact: true })).toBeVisible();
  const report = page.locator('.group-report-message');
  await expect(report).toHaveCount(1);
  await expect(report.getByRole('button', { name: 'Open report', exact: true })).toBeVisible();
  expect((await report.getByRole('button').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(report.locator('pre')).toBeHidden();
  await report.getByText('Original notification', { exact: true }).click();
  expect(await report.locator('pre').textContent()).toBe(original);
  const forbidden: string[] = [];
  const paths: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(documents|chat-files|chat-images)(\/|$)/.test(path)) forbidden.push(path);
    if (path.startsWith('/api/groups/reports/')) paths.push(path);
  });
  await page.route('**/api/groups/reports/**', (route) =>
    route.fulfill({
      status: 403,
      json: { error: 'This shared report is no longer available to this membership.' },
    }),
  );
  await report.getByRole('button', { name: 'Open report', exact: true }).click();
  await expect(page.locator('.pdf-error')).toContainText('no longer available');
  expect(paths.length).toBeGreaterThan(0);
  expect(
    paths.every((path) =>
      path.startsWith(
        `/api/groups/reports/${saved.shared.handle}/${publicationId}/${manifestHash}`,
      ),
    ),
  ).toBe(true);
  expect(forbidden).toEqual([]);
  await page.getByRole('button', { name: 'Back to where I was', exact: true }).click();
  await expect(report).toHaveCount(1);
  const draft = page.getByPlaceholder('Message the group…');
  await draft.fill('Exact unsent shared draft · γ');
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  const controls = page.locator('.group-host-controls');
  await expect(controls.getByText('Invite people', { exact: true })).toBeVisible();
  await expect(controls.getByText('My agent on this computer', { exact: true })).toBeVisible();
  await expect(controls.getByText('Review proposed shared actions', { exact: true })).toHaveCount(
    0,
  );
  await expect(controls.getByText('Browse earlier shared reports', { exact: true })).toHaveCount(0);
  await expect(
    controls.getByText('Creator backup of shared group data', { exact: true }),
  ).toHaveCount(0);
  await controls.getByText('Advanced', { exact: true }).click();
  await expect(controls.getByText('Review proposed shared actions', { exact: true })).toBeVisible();
  await expect(controls.getByText('Browse earlier shared reports', { exact: true })).toBeVisible();
  await expect(
    controls.getByText('Creator backup of shared group data', { exact: true }),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  const secondary = await controls
    .getByRole('button', { name: 'Done', exact: true })
    .evaluate((button) => {
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, color: style.color, border: style.borderColor };
    });
  const summaries = controls.locator('summary:visible');
  for (const summary of await summaries.all()) {
    const style = await summary.evaluate((row) => {
      const css = getComputedStyle(row);
      return {
        fontSize: parseFloat(css.fontSize),
        height: row.getBoundingClientRect().height,
        borderWidth: parseFloat(css.borderTopWidth),
        background: css.backgroundColor,
        color: css.color,
        border: css.borderColor,
      };
    });
    expect(style.fontSize).toBeGreaterThanOrEqual(16);
    expect(style.height).toBeGreaterThanOrEqual(44);
    expect(style.borderWidth).toBeGreaterThanOrEqual(1);
    expect(style).toMatchObject(secondary);
  }
  await page.keyboard.press('Tab');
  const focusedSummary = controls.locator('summary:focus-visible');
  await expect(focusedSummary).toHaveCount(1);
  expect(
    await focusedSummary.evaluate((summary) => parseFloat(getComputedStyle(summary).outlineWidth)),
  ).toBeGreaterThanOrEqual(2);
  await expect(controls.locator('[aria-label="Shared GitHub workspace"]')).toHaveCount(1);
  await controls.getByText('Advanced', { exact: true }).click();
  await expect(controls.locator('[aria-label="Shared GitHub workspace"]')).toHaveCount(1);
  await expect(controls.locator('[aria-label="Shared GitHub workspace"]')).toBeHidden();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await expect(draft).toHaveValue('Exact unsent shared draft · γ');
  await expect(report).toHaveCount(1);
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(controls.getByText('Review proposed shared actions', { exact: true })).toHaveCount(
    0,
  );
  await controls.getByText('Advanced', { exact: true }).click();
  await expect(controls.locator('[aria-label="Shared GitHub workspace"]')).toHaveCount(1);
  await capture(page, 'clear-maintenance');
  expect((await fixtureCommand('inspect')).synthesisRequests).toBe(0);
});

test('own report controls stay on the exact completed reply and retain terminal guidance after reload', async ({
  page,
}) => {
  await enter(page);
  const capturedId = randomUUID(),
    terminalId = randomUUID(),
    earlierId = randomUUID();
  const capturedKey = randomUUID(),
    terminalKey = randomUUID();
  const capturedRequestId = randomUUID(),
    terminalRequestId = randomUUID();
  await page.route('**/api/groups/chat', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    const add = (id: string, text: string) => ({
      id,
      agentId: value.detail.agent.id,
      runId: null,
      kind: 'assistant',
      title: 'Codex response',
      text,
      status: 'complete',
      createdAt: new Date().toISOString(),
    });
    value.detail.entries.push(
      add(earlierId, 'Earlier ordinary reply'),
      add(capturedId, 'Exact captured reply · λ'),
      add(terminalId, 'Exact unavailable reply · μ'),
    );
    value.nativeRequests = [
      {
        key: capturedKey,
        text: 'Create the selected report',
        intent: 'work',
        requestId: capturedRequestId,
        resultId: capturedId,
        documentAvailable: true,
        state: 'completed',
        message: 'Reply retained.',
        delivery: 'complete',
      },
      {
        key: terminalKey,
        text: 'Create the other report',
        intent: 'work',
        requestId: terminalRequestId,
        resultId: terminalId,
        documentAvailable: false,
        documentCaptureState: 'unavailable',
        state: 'completed',
        message: 'Reply retained.',
        delivery: 'complete',
      },
    ];
    await route.fulfill({ response, json: value });
  });
  const offers: unknown[] = [];
  await page.route('**/api/groups/document-offer', (route) => {
    offers.push(route.request().postDataJSON());
    return route.fulfill({
      status: 503,
      json: {
        error: 'Private fixture diagnostic must not be shown.',
        code: 'GROUP_DOCUMENT_CAPTURE_PENDING',
      },
    });
  });
  await create(page, 'Retained Pine');
  await page.getByRole('tab', { name: 'My group agent', exact: true }).click();
  const exact = page.locator('.message.assistant').filter({ hasText: 'Exact captured reply · λ' });
  const terminal = page
    .locator('.message.assistant')
    .filter({ hasText: 'Exact unavailable reply · μ' });
  await expect(
    exact.getByRole('button', { name: 'Open report from this reply', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator('.message.assistant')
      .filter({ hasText: 'Earlier ordinary reply' })
      .getByRole('button'),
  ).toHaveCount(0);
  await expect(terminal.getByRole('button')).toHaveCount(0);
  await expect(terminal).toContainText('explicitly request new Work from My group agent');
  await exact.getByRole('button', { name: 'Open report from this reply', exact: true }).click();
  await expect(exact).toContainText(
    'Report capture is still finishing. Retry this same saved reply.',
  );
  await expect(page.locator('.conversation')).not.toContainText('Private fixture diagnostic');
  expect(offers).toEqual([{ handle: (await savedGroup(page)).shared.handle, key: capturedKey }]);
  await page.getByText('Message details', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open report from this reply', exact: true }),
  ).toHaveCount(1);
  await page.reload();
  await page.getByRole('tab', { name: 'My group agent', exact: true }).click();
  await expect(terminal).toContainText('explicitly request new Work from My group agent');
  await expect(
    exact.getByRole('button', { name: 'Open report from this reply', exact: true }),
  ).toBeVisible();
  expect(offers).toHaveLength(1); // reload never captures files or replays the original Work
  expect((await fixtureCommand('inspect')).synthesisRequests).toBe(0);
});
