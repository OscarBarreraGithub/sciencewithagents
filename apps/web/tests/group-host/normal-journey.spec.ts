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
test('existing Claude connection is explicit and does not launch an app agent', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Native Claude group');
  const forbidden: string[] = [];
  page.on('request', (request) => {
    if (
      /\/api\/groups\/(request-agent|native-owner|feed-writer)$/.test(
        new URL(request.url()).pathname,
      ) &&
      !(
        new URL(request.url()).pathname.endsWith('/native-owner') &&
        request.postDataJSON()?.action === 'status'
      )
    )
      forbidden.push(request.url());
  });
  await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your usual Claude Code' })).toBeVisible();
  await expect(page.getByText('Automatic sharing is off.', { exact: true })).toBeVisible();
  const button = page.getByRole('button', { name: 'Copy prompt for your Claude' });
  await expect(button).toBeVisible();
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const panel = page.locator('.group-claude-connection');
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole('tab', { name: 'Group chat', exact: true }).click();
  await expect(page.locator('.group-shared-chat textarea').first()).toBeVisible();
  expect(forbidden).toEqual([]);
});
test('Manage distinguishes external Claude activity and requires owner acknowledgement before releasing its Git hold', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'External closure');
  const opened = await savedGroup(page);
  const commands: unknown[] = [];
  let held = true;
  await page.route('**/api/groups/native-git', async (route) => {
    const input = route.request().postDataJSON();
    commands.push(input);
    if (input.action === 'confirm-external-closed') held = false;
    await route.fulfill({
      json: {
        available: true,
        repository: 'https://github.com/fixture/private-group',
        workspacePath: '/fixture/shared',
        branch: 'main',
        githubUsername: '',
        autoSync: true,
        connected: true,
        dirty: false,
        busy: held,
        ...(held ? { busyReason: 'external-claude', externalClosureGeneration: 2 } : {}),
        message: held ? 'External conversation closure pending.' : 'Owner closure recorded.',
        tasks: [],
        preview: null,
      },
    });
  });
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage group', exact: true });
  await dialog.getByText('Advanced', { exact: true }).click();
  await dialog.getByText('Git sync and reviewed changes', { exact: true }).click();
  const section = dialog.getByRole('region', { name: 'Confirm external Claude closure' });
  await expect(section).toBeVisible();
  const confirm = section.getByRole('button', { name: 'Confirm Claude and its jobs are closed' });
  await expect(confirm).toBeDisabled();
  await section.getByRole('checkbox').check();
  await expect(confirm).toBeEnabled();
  expect((await confirm.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  await confirm.click();
  expect(commands).toContainEqual(
    expect.objectContaining({
      action: 'confirm-external-closed',
      handle: opened.shared.handle,
      generation: 2,
    }),
  );
  await expect(section).toHaveCount(0);
  expect((await fixtureCommand('inspect')).synthesisRequests).toBe(0);
});
test('ordinary Claude checkpoints load directly in Manage and retry an initial status failure', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Claude file status');
  let releaseStatus!: () => void;
  const firstRead = new Promise<void>((resolve) => (releaseStatus = resolve));
  let failStatus = true;
  await page.route('**/api/groups/files', async (route) => {
    expect(route.request().postDataJSON().action).toBe('status');
    await firstRead;
    if (failStatus) {
      await route.fulfill({ status: 503, json: { error: 'Owned file status outage' } });
      return;
    }
    await route.fulfill({
      json: {
        proposals: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            head: 'a'.repeat(40),
            repository: 'https://github.com/fixture/private-group',
            state: 'review',
            message: 'Awaiting exact owner review.',
          },
        ],
        preview: null,
      },
    });
  });
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage group', exact: true });
  const files = dialog.getByRole('region', { name: 'Claude file checkpoints', exact: true });
  await expect(files.getByRole('status')).toHaveText('Checking Claude file checkpoints…');
  releaseStatus();
  await expect(files.getByRole('alert')).toHaveText('Owned file status outage');
  const retry = files.getByRole('button', { name: 'Retry file checkpoint status' });
  await expect(retry).toBeEnabled();
  failStatus = false;
  await retry.click();
  await expect(files.getByRole('alert')).toHaveCount(0);
  await expect(files.getByRole('button', { name: 'Review Claude’s checkpoint' })).toBeEnabled();
  expect((await fixtureCommand('inspect')).synthesisRequests).toBe(0);
});
test('ordinary Claude file review retains the exact display and approval key after lost acknowledgement on reload', async ({
  page,
}, testInfo) => {
  await enter(page);
  await create(page, 'Claude file review');
  const group = await savedGroup(page),
    id = randomUUID(),
    head = 'a'.repeat(40),
    fingerprint = 'b'.repeat(64);
  const display = {
    id,
    repository: 'https://github.com/fixture/private-group',
    branch: `swa/member-fixture/checkpoint-${id}`,
    sessionId: 'fixture-native-claude',
    base: 'c'.repeat(40),
    head,
    tree: 'd'.repeat(40),
    fingerprint,
    files: ['research/native-result.txt', 'research/older-binary.pdf'],
    patch:
      'Commit ' +
      head +
      '\nVerified result\nBinary files differ: inspect this committed version locally\n',
  };
  const approvals: unknown[] = [];
  let lost = false,
    shared = false,
    refuseStatus = false;
  await page.route('**/api/groups/files', async (route) => {
    const input = route.request().postDataJSON();
    if (input.action === 'status' && refuseStatus) {
      await route.fulfill({ status: 409, json: { error: 'Owned temporarily unavailable status' } });
      return;
    }
    if (input.action === 'approve') {
      approvals.push(input);
      shared = true;
      if (!lost) {
        lost = true;
        await route.abort('failed');
        return;
      }
    }
    await route.fulfill({
      json: {
        proposals: [
          {
            id,
            head,
            repository: display.repository,
            state: shared ? 'shared' : 'review',
            message: shared ? 'Exact reviewed checkpoint shared.' : 'Awaiting exact owner review.',
          },
        ],
        preview: input.action === 'preview' ? display : null,
      },
    });
  });
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Manage group', exact: true });
  await dialog.getByRole('button', { name: 'Review Claude’s checkpoint' }).click();
  let review = dialog.getByRole('region', { name: 'Exact Claude file checkpoint' });
  await expect(review.getByText('research/older-binary.pdf', { exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: 'Approve this file checkpoint' })).toBeDisabled();
  await review.getByRole('checkbox').check();
  const approve = review.getByRole('button', { name: 'Approve this file checkpoint' });
  expect((await approve.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await review.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(
    await review
      .getByRole('checkbox')
      .evaluate((element) => parseFloat(getComputedStyle(element.parentElement!).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  await page.screenshot({
    path: join(root, `data/normal-groups/${testInfo.project.name}-external-files-review.png`),
    fullPage: true,
  });
  await approve.click();
  await expect(dialog.getByRole('button', { name: 'Check saved file request' })).toBeVisible();
  const original = approvals[0];
  expect(original).toEqual(
    expect.objectContaining({ action: 'approve', handle: group.shared.handle, id, fingerprint }),
  );
  refuseStatus = true;
  await page.reload();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Manage group', exact: true });
  review = dialog.getByRole('region', { name: 'Exact Claude file checkpoint' });
  await expect(review.getByLabel('Complete Claude checkpoint history')).toHaveText(display.patch);
  await expect(
    dialog.getByText('Owned temporarily unavailable status', { exact: true }),
  ).toBeVisible();
  refuseStatus = false;
  await dialog.getByRole('button', { name: 'Retry file checkpoint status' }).click();
  await expect(dialog.getByRole('button', { name: 'Retry file checkpoint status' })).toHaveCount(0);
  await expect(review.getByLabel('Complete Claude checkpoint history')).toHaveText(display.patch);
  await expect(dialog.getByRole('button', { name: 'Check saved file request' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Check saved file request' }).click();
  await expect(dialog.getByRole('button', { name: 'Check saved file request' })).toHaveCount(0);
  expect(approvals[1]).toEqual(original);
  expect((await fixtureCommand('inspect')).synthesisRequests).toBe(0);
});
test('saved consent is reachable from Group chat and native coordination refusal hides legacy action controls', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Saved consent');
  const requestId = randomUUID(),
    key = randomUUID();
  let cancelled = false;
  try {
    await page.route('**/api/groups/chat', async (route) => {
      const response = await route.fetch(),
        value = await response.json();
      value.nativeRequests = [
        {
          key,
          requestId,
          text: 'Retained request needing consent',
          intent: 'work',
          resultId: null,
          state: cancelled ? 'cancelled' : 'pending-consent',
          message: 'Retained request.',
          delivery: 'pending',
        },
      ];
      await route.fulfill({ response, json: value });
    });
    const commands: unknown[] = [];
    await page.route('**/api/groups/native-owner', async (route) => {
      const input = route.request().postDataJSON();
      commands.push(input);
      if (input.action === 'reject') cancelled = true;
      await route.fulfill({
        json: {
          executionMode: 'host',
          managedCoordination: false,
          hostEnabled: true,
          configured: true,
          productionReady: true,
          provider: 'codex',
          setupId: null,
          state: cancelled ? 'stopped' : 'authenticated',
          message: 'Retained native access.',
        },
      });
    });
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Group chat', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const dialog = page.getByRole('dialog', { name: 'Manage group', exact: true });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Continue this request', exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText('Review proposed shared actions', { exact: true })).toHaveCount(
      0,
    );
    await dialog.getByRole('button', { name: 'Cancel this request', exact: true }).click();
    expect(commands).toContainEqual(expect.objectContaining({ action: 'reject', requestId }));
    expect((await fixtureCommand('inspect')).synthesisRequests).toBe(0);
  } finally {
    // Drain this test's live chat reads before its page and request context close.
    await page.unrouteAll({ behavior: 'wait' });
  }
});
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
  await expect(page.getByRole('tab')).toHaveText(['Group chat', 'Your Claude Code']);
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
  await expect(controls.getByText('My agent on this computer', { exact: true })).toHaveCount(0);
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
  try {
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
    await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
    await page.getByText('Saved SWA group agent', { exact: true }).click();
    const exact = page
      .locator('.message.assistant')
      .filter({ hasText: 'Exact captured reply · λ' });
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
    await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
    await page.getByText('Saved SWA group agent', { exact: true }).click();
    await expect(terminal).toContainText('explicitly request new Work from My group agent');
    await expect(
      exact.getByRole('button', { name: 'Open report from this reply', exact: true }),
    ).toBeVisible();
    expect(offers).toHaveLength(1); // reload never captures files or replays the original Work
    expect((await fixtureCommand('inspect')).synthesisRequests).toBe(0);
  } finally {
    // Finish this test's live chat reads before its page and request context close.
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('Groups presentation retains a failed create, reads shared messages and restores drafts through opening retry', async ({
  page,
}) => {
  await enter(page);
  await capture(page, 'groups-list');
  let failCreate = true;
  await page.route('**/api/groups/create', async (route) => {
    if (failCreate) {
      failCreate = false;
      await route.fulfill({
        status: 503,
        json: { error: 'The group service is temporarily unavailable. Retry these entries.' },
      });
    } else await route.continue();
  });
  let failFeed = true;
  await page.route('**/api/groups/feed', async (route) => {
    if (failFeed) {
      await route.fulfill({
        status: 503,
        json: { error: 'Shared messages are temporarily unavailable.' },
      });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New group', exact: true });
  await dialog.getByLabel('Your display name', { exact: true }).fill('Amina');
  const name = 'Field notes · a shared study of stars and their atmospheres';
  await dialog.getByLabel('Project name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(dialog.getByLabel('Project name', { exact: true })).toHaveValue(name);
  await capture(page, 'groups-create-retry');
  await dialog.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await chat(page);
  await expect(
    page.getByRole('button', { name: 'Retry group messages', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Send a message to start the conversation with your group.', { exact: true }),
  ).toHaveCount(0);
  failFeed = false;
  await page.getByRole('button', { name: 'Retry group messages', exact: true }).click();
  const saved = await savedGroup(page);
  await fixtureCommand('feature', {
    handle: saved.shared.handle,
    text: 'The spectra are ready to compare.\n\nWe should check the uncertainty in each observation before choosing our next target. The longer discussion and its equations remain readable here, with the original shared context retained.',
  });
  await page.reload();
  await expect(page.locator('.group-shared-chat .markdown')).toContainText([
    'The spectra are ready',
  ]);
  const draft = page.getByPlaceholder('Message the group…');
  await draft.fill('Saved for later: compare the second observation.');
  await capture(page, 'groups-conversation');
  const contrast = await page
    .locator('.group-shared-chat .message.user .markdown')
    .first()
    .evaluate((element) => {
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
      };
      const foreground = luminance(getComputedStyle(element).color);
      const background = luminance(
        getComputedStyle(element.closest('.message-body')!).backgroundColor,
      );
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.getByRole('tab', { name: 'Group chat', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Your Claude Code', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Your Claude Code', exact: true })).toHaveAttribute(
    'tabindex',
    '0',
  );
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Group chat', exact: true })).toBeFocused();
  await expect(draft).toHaveValue('Saved for later: compare the second observation.');
  for (const control of await page
    .locator(
      '.groups-workspace-heading button, .groups-workspace-heading summary, .groups-tabs button, .group-mode-button',
    )
    .all()) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    if (await control.textContent())
      expect(
        await control.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
      ).toBeGreaterThanOrEqual(16);
  }
  let failOpen = true;
  await page.route('**/api/groups/open', async (route) => {
    if (failOpen) {
      failOpen = false;
      await route.fulfill({
        status: 503,
        json: { error: 'The saved group could not be reached.' },
      });
    } else await route.continue();
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry opening group' })).toBeVisible();
  await capture(page, 'groups-open-retry');
  await page.getByRole('button', { name: 'Retry opening group' }).click();
  await expect(draft).toHaveValue('Saved for later: compare the second observation.');
  await expect(page.locator('.group-shared-chat .markdown')).toContainText([
    'The spectra are ready',
  ]);
  await page.getByRole('button', { name: 'Back to groups', exact: true }).click();
  await expect(page.locator('.groups-workspace')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Group conversations' })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '150%';
  });
  for (const name of ['New group', 'Join group', 'Group setup']) {
    const button = page.getByRole('button', { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
  }
  await capture(page, 'groups-large-list');
  expect((await fixtureCommand('inspect')).synthesisRequests).toBe(0);
});

test('Claude connection offers explicit status retry and keeps a failed stop visible until exact retry', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Claude connection study');
  let failStatus = true,
    failStop = true,
    enabled = true;
  const stopKeys: string[] = [];
  await page.route('**/api/groups/conversation-sharing', async (route) => {
    const input = route.request().postDataJSON();
    if (input.action === 'status' && failStatus) {
      failStatus = false;
      await route.fulfill({
        status: 503,
        json: { error: 'Sharing status is temporarily unavailable.' },
      });
      return;
    }
    if (input.action === 'stop') {
      stopKeys.push(input.key);
      if (failStop) {
        failStop = false;
        enabled = false; // The server accepted Stop but its acknowledgement was lost.
        await route.fulfill({
          status: 503,
          json: { error: 'Stop acknowledgement was lost. Retry stopping sharing.' },
        });
        return;
      }
      enabled = false;
      await route.fulfill({ json: { outcome: 'stopped', enabled: false } });
      return;
    }
    await route.fulfill({
      json: {
        selection: {
          enabled,
          sessionId: 'selected-native-conversation',
          generation: enabled ? 1 : 2,
        },
        pending: 1,
        model: 'Policy-selected summary model',
        blocked: 0,
        warning: null,
        latest: null,
      },
    });
  });
  await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Retry sharing status', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retry sharing status', exact: true }).click();
  await expect(
    page.getByText('Automatic sharing is on for your selected Claude conversation.', {
      exact: true,
    }),
  ).toBeVisible();
  await capture(page, 'groups-claude-connection');
  await expect(page.locator('.group-legacy-chat')).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop automatic sharing', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Stop acknowledgement was lost');
  // A successful status refresh must not dismiss an uncertain write acknowledgement.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Automatic sharing is off.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Stop acknowledgement was lost');
  await expect(
    page.getByRole('button', { name: 'Retry stopping sharing', exact: true }),
  ).toBeVisible();
  await page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: connection.origin });
  await page.getByRole('button', { name: 'Copy prompt for your Claude', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Connection prompt copied', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Stop acknowledgement was lost');
  await page.reload();
  await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
  await expect(page.getByText('Automatic sharing is off.', { exact: true })).toBeVisible();
  await expect(
    page.getByText('A stop request is awaiting confirmation.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retry stopping sharing', exact: true }).click();
  expect(stopKeys).toHaveLength(2);
  expect(stopKeys[1]).toBe(stopKeys[0]);
  await expect(page.getByText('Automatic sharing is off.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
  await expect(page.getByText('Automatic sharing is off.', { exact: true })).toBeVisible();
  await page.getByText('Saved SWA group agent', { exact: true }).click();
  await expect(page.locator('.group-legacy-chat')).toBeVisible();
  await expect(page.getByPlaceholder('Message my group agent…')).toBeVisible();
  await capture(page, 'groups-saved-agent');
  expect((await fixtureCommand('inspect')).synthesisRequests).toBe(0);
});

for (const reselect of ['same session', 'different session', 'unaccepted Stop']) {
  test(`Stop recovery preserves its generation after ${reselect}`, async ({ page }) => {
    await enter(page);
    await create(page, `Stop recovery ${reselect}`);
    let generation = 1,
      enabled = true,
      fail = true;
    const requests: { key: string; generation: number }[] = [];
    await page.route('**/api/groups/conversation-sharing', async (route) => {
      const input = route.request().postDataJSON();
      if (input.action === 'stop') {
        requests.push({ key: input.key, generation: input.generation });
        if (fail) {
          fail = false;
          if (reselect !== 'unaccepted Stop') {
            enabled = false;
            generation = 2;
          }
          await route.fulfill({ status: 503, json: { error: 'Stop reply unavailable.' } });
          return;
        }
        if (input.generation === generation) {
          enabled = false;
          generation++;
        }
        await route.fulfill({
          json: {
            outcome: reselect === 'unaccepted Stop' ? 'superseded' : 'stopped',
            enabled: false,
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          selection: {
            enabled,
            generation,
            sessionId: generation > 2 && reselect === 'different session' ? 'native-B' : 'native-A',
          },
          pending: 0,
          model: null,
          blocked: 0,
          warning: null,
          latest: null,
        },
      });
    });
    await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
    await page.getByRole('button', { name: 'Stop automatic sharing', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Stop reply unavailable');
    generation = 3;
    enabled = true;
    await page.reload();
    await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
    await page.getByRole('button', { name: 'Retry stopping sharing', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Stop automatic sharing', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Automatic sharing is on for your selected Claude conversation.', {
        exact: true,
      }),
    ).toBeVisible();
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0].generation).toBe(1);
    expect(enabled).toBe(true);
    await capture(page, `stop-recovered-${reselect.replaceAll(' ', '-')}`);
    await page.getByRole('button', { name: 'Stop automatic sharing', exact: true }).click();
    expect(requests[2].generation).toBe(3);
    expect(requests[2].key).not.toBe(requests[0].key);
    await expect(page.getByText('Automatic sharing is off.', { exact: true })).toBeVisible();
  });
}

test('legacy Stop recovery retains an unknown key while allowing a new generation-bound Stop', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Legacy Stop recovery');
  const handle = new URL(page.url()).hash.split('/').at(-1)!;
  const legacy = randomUUID();
  const storage = await page.evaluate(
    ({ handle, legacy }) => {
      const key = `swa:groups:local:${handle}:stop-sharing`;
      sessionStorage.setItem(key, legacy);
      return key;
    },
    { handle, legacy },
  );
  let known = false,
    enabled = true;
  const requests: { key: string; generation?: number; recoverOnly?: boolean }[] = [];
  await page.route('**/api/groups/conversation-sharing', async (route) => {
    const input = route.request().postDataJSON();
    if (input.action === 'stop') {
      requests.push(input);
      if (input.recoverOnly) {
        expect(input.key).toBe(legacy);
        expect(input.generation).toBeUndefined();
        await route.fulfill({ json: { outcome: known ? 'stopped' : 'unresolved' } });
      } else {
        expect(input.key).not.toBe(legacy);
        expect(input.generation).toBe(3);
        enabled = false;
        await route.fulfill({ json: { outcome: 'stopped' } });
      }
      return;
    }
    await route.fulfill({
      json: {
        selection: { enabled, generation: enabled ? 3 : 4, sessionId: 'native-B' },
        pending: 0,
        model: null,
        latest: null,
      },
    });
  });
  await page.reload();
  await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
  await page.getByRole('button', { name: 'Check earlier Stop receipt', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('identity is kept');
  expect(enabled).toBe(true);
  await capture(page, 'stop-legacy-unresolved');
  await page.getByRole('button', { name: 'Stop automatic sharing', exact: true }).click();
  await expect(page.getByText('Automatic sharing is off.', { exact: true })).toBeVisible();
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).legacy, storage),
  ).toBe(legacy);
  await page.reload();
  await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Check earlier Stop receipt', exact: true }),
  ).toBeVisible();
  known = true;
  await page.getByRole('button', { name: 'Check earlier Stop receipt', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Check earlier Stop receipt', exact: true }),
  ).toHaveCount(0);
  expect(requests.map((r) => r.recoverOnly ?? false)).toEqual([true, false, true]);
});

test('a delayed status read cannot overwrite the status read after a Stop receipt', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Stop status race');
  let reads = 0,
    staleReturned = false,
    stopped = false;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/groups/conversation-sharing', async (route) => {
    const input = route.request().postDataJSON();
    if (input.action === 'stop') {
      stopped = true;
      await route.fulfill({ json: { outcome: 'stopped' } });
      return;
    }
    const read = ++reads,
      enabled = !stopped;
    if (read === 2) await delayed;
    await route.fulfill({
      json: {
        selection: { enabled, generation: enabled ? 1 : 2, sessionId: 'native-A' },
        pending: 0,
        model: null,
        latest: null,
      },
    });
    if (read === 2) staleReturned = true;
  });
  await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Stop automatic sharing', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => reads).toBe(2);
  await page.getByRole('button', { name: 'Stop automatic sharing', exact: true }).click();
  await expect(page.getByText('Automatic sharing is off.', { exact: true })).toBeVisible();
  release();
  await expect.poll(() => staleReturned).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(
    page.getByRole('button', { name: 'Stop automatic sharing', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('Automatic sharing is off.', { exact: true })).toBeVisible();
});

test('a delayed shared feed restores its reading position after visiting the Claude tab', async ({
  page,
}) => {
  await enter(page);
  await create(page, 'Reading position');
  const saved = await savedGroup(page);
  for (let index = 0; index < 8; index++)
    await fixtureCommand('feature', {
      handle: saved.shared.handle,
      text: `Observation ${index + 1}. ${'The exact shared discussion stays available while we compare these measurements. '.repeat(8)}`,
    });
  let releaseFeed!: () => void;
  const heldFeed = new Promise<void>((resolve) => {
    releaseFeed = resolve;
  });
  let delayFeed = true;
  await page.route('**/api/groups/feed', async (route) => {
    if (delayFeed) await heldFeed;
    await route.continue();
  });
  try {
    await page.reload();
    await expect(page.locator('.group-chat-loading')).toBeVisible();
    await expect(page.locator('.group-shared-chat .conversation')).toHaveCount(0);
  } finally {
    delayFeed = false;
    releaseFeed();
  }
  const transcript = page.locator('.group-shared-chat .conversation');
  await expect(transcript.locator('.message')).toHaveCount(8);
  // Let initial tail fitting finish before explicitly choosing an earlier reading position.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const position = await transcript.evaluate((element) => {
    element.scrollTop = 160;
    element.dispatchEvent(new Event('scroll'));
    return element.scrollTop;
  });
  expect(position).toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
  await page.getByRole('tab', { name: 'Group chat', exact: true }).click();
  await expect(transcript.locator('.message')).toHaveCount(8);
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(position);
  await capture(page, 'groups-restored-position');
});
