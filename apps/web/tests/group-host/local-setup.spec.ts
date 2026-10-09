import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupHostLocalVisibilitySchema } from '@dock/shared/dist/group-host.js';
import { projectFolderSchema } from '@dock/shared';
import {
  groupWorkspaceInputSchema,
  type GroupWorkspaceView,
} from '@dock/shared/dist/group-workspace.js';
import {
  groupNativeGitRequestSchema,
  type GroupNativeGitView,
} from '@dock/shared/dist/group-native-git.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
let child: ChildProcess | undefined;
let connection: { origin: string; cookie: string };
test.beforeAll(async () => {
  child = spawn(
    process.execPath,
    [
      join(root, 'apps/server/node_modules/tsx/dist/cli.mjs'),
      join(root, 'apps/server/src/group-host-browser.fixture.ts'),
      '--controlled-agent',
    ],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe' },
  );
  child.stderr?.resume();
  connection = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Local setup fixture startup timeout')), 30000);
    child!.once('exit', () => reject(new Error('Local setup fixture exited')));
    child!.stdout!.on('data', (chunk) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        try {
          const value = JSON.parse(line) as typeof connection;
          if (value.origin && value.cookie) {
            clearTimeout(timer);
            resolve(value);
            return;
          }
        } catch {}
      }
    });
  });
});
test.afterAll(async () => {
  if (child && child.exitCode === null) {
    const ended = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await ended;
  }
  expect(child?.exitCode).toBe(0);
});
async function enter(page: Page) {
  const [name, ...value] = connection.cookie.split('=');
  await page
    .context()
    .addCookies([
      { name, value: value.join('='), url: connection.origin, httpOnly: true, sameSite: 'Strict' },
    ]);
  await page.goto(`${connection.origin}/#/home`);
  await page.locator('a[href="#/chats"]').first().click();
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
}
async function create(page: Page, name: string) {
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New group', exact: true });
  await form.getByLabel('Your display name', { exact: true }).fill('Amina');
  await form.getByLabel('Project name', { exact: true }).fill(name);
  await form.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({
    path: join(root, 'data/normal-groups', `${test.info().project.name}-${name}.png`),
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width + 2,
  );
}

test('selected folder and verified repository retain exact retries through reload without duplicate Git controllers', async ({
  page,
}) => {
  const folderId = randomUUID();
  const path = '/synthetic/Selected project α';
  const picks: ReturnType<typeof projectFolderSchema.parse>[] = [];
  const bindings: unknown[] = [],
    connections: unknown[] = [];
  const gitOperations: ReturnType<typeof groupNativeGitRequestSchema.parse>[] = [];
  let lostPick = true,
    lostBinding = true,
    lostConnection = true;
  const workspace: GroupWorkspaceView = {
    revision: 0,
    selectionKey: null,
    workspacePath: null,
    available: false,
    message: 'No shared folder is selected.',
  };
  const git: GroupNativeGitView = {
    available: false,
    connected: false,
    repository: 'https://github.com/example/selected-project',
    workspacePath: path,
    branch: 'main',
    githubUsername: '',
    autoSync: false,
    dirty: false,
    busy: false,
    message: 'Private repository prepared. Verify your access.',
    localEdits: [],
    tasks: [],
    preview: null,
  };
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as Window & { copiedFolder?: string }).copiedFolder = text;
        },
      },
    }),
  );
  await page.route('**/api/project-folders?*', (route) =>
    route.fulfill({
      json: {
        current: { id: folderId, name: 'Selected project α', canSelect: true },
        parentId: null,
        folders: [],
        nextOffset: null,
      },
    }),
  );
  await page.route('**/api/projects/connect-folder', async (route) => {
    const value = projectFolderSchema.parse(route.request().postDataJSON());
    picks.push(value);
    if (lostPick) {
      lostPick = false;
      await route.abort('connectionreset');
      return;
    }
    await route.fulfill({
      json: {
        project: null,
        selection: {
          key: value.key,
          name: 'Selected project α',
          needsTracking: false,
          workspacePath: path,
        },
      },
    });
  });
  await page.route('**/api/groups/workspace', async (route) => {
    const value = groupWorkspaceInputSchema.parse(route.request().postDataJSON());
    if (value.action === 'select') {
      bindings.push(value);
      workspace.revision = 1;
      workspace.selectionKey = value.selectionKey;
      workspace.workspacePath = path;
      workspace.available = true;
      workspace.message = 'Selected folder is ready.';
      if (lostBinding) {
        lostBinding = false;
        await route.abort('connectionreset');
        return;
      }
    }
    await route.fulfill({ json: workspace });
  });
  let releaseOldStatus: (() => void) | undefined;
  let heldRead = false;
  await page.route('**/api/groups/native-git', async (route) => {
    const value = groupNativeGitRequestSchema.parse(route.request().postDataJSON());
    gitOperations.push(value);
    if (value.action === 'connect') {
      connections.push(value);
      git.connected = true;
      // This existing explicit pause must survive a newly verified connection.
      git.autoSync = false;
      if (lostConnection) {
        lostConnection = false;
        await route.abort('connectionreset');
        return;
      }
    }
    if (value.action === 'status' && !heldRead) {
      heldRead = true;
      const old = {
        ...git,
        workspacePath: '/synthetic/old-folder',
        message: 'Earlier workspace status.',
      };
      await new Promise<void>((resolve) => {
        releaseOldStatus = resolve;
      });
      await route.fulfill({ json: old });
      return;
    }
    await route.fulfill({ json: git });
  });
  await enter(page);
  await page.getByRole('button', { name: 'Group setup', exact: true }).click();
  let setup = page.getByRole('dialog', { name: 'Group setup', exact: true });
  await setup.getByRole('button', { name: 'Shared files', exact: true }).click();
  await expect(
    setup.getByRole('button', { name: 'Copy folder setup prompt', exact: true }),
  ).toHaveCount(0);
  await setup.getByRole('button', { name: 'Choose work folder', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Choose a project folder', exact: true })
    .getByRole('button', { name: 'Use this folder', exact: true })
    .click();
  await expect(
    setup.getByRole('button', { name: 'Retry folder selection', exact: true }),
  ).toBeVisible();
  await page.reload();
  expect(picks).toHaveLength(1);
  await page.getByRole('button', { name: 'Group setup', exact: true }).click();
  setup = page.getByRole('dialog', { name: 'Group setup', exact: true });
  await setup.getByRole('button', { name: 'Shared files', exact: true }).click();
  await setup.getByRole('button', { name: 'Retry folder selection', exact: true }).click();
  await setup.getByRole('button', { name: 'Copy folder setup prompt', exact: true }).click();
  expect(picks).toHaveLength(2);
  expect(picks[1]).toEqual(picks[0]);
  expect(picks[0]).toEqual({ key: picks[0]!.key, folderId, selectOnly: true });
  await expect
    .poll(() => page.evaluate(() => (window as Window & { copiedFolder?: string }).copiedFolder))
    .toContain(JSON.stringify(path));
  const copied = await page.evaluate(
    () => (window as Window & { copiedFolder?: string }).copiedFolder,
  );
  expect(copied).toContain('Inspect tracked and untracked files');
  expect(copied).toMatch(/Do not stage\s+everything/);
  await screenshot(page, 'selected-folder-setup');
  await setup.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await create(page, 'Scoped Forest');
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  let controls = page.locator('.group-host-controls');
  await controls.getByText('Work folder', { exact: true }).click();
  await expect.poll(() => Boolean(releaseOldStatus)).toBe(true);
  await controls
    .getByRole('button', { name: 'Use this folder for this group', exact: true })
    .click();
  await expect(
    controls.getByRole('button', { name: 'Retry saved folder binding', exact: true }),
  ).toBeVisible();
  await controls.getByRole('button', { name: 'Retry saved folder binding', exact: true }).click();
  await expect.poll(() => bindings.length).toBe(2);
  expect(bindings[1]).toEqual(bindings[0]);
  releaseOldStatus!();
  const repository = page.getByRole('region', {
    name: 'Shared repository connection',
    exact: true,
  });
  await expect(repository).not.toContainText('Earlier workspace status.');
  await expect(repository).toContainText('Private repository prepared. Verify your access.');
  const connect = repository.getByRole('button', {
    name: 'Connect shared repository',
    exact: true,
  });
  await expect(connect).toBeDisabled();
  // The owner's setup agent repairs the repository outside this page. A read-only
  // check must be reachable even when no HTTP request failed.
  git.available = true;
  await repository.getByRole('button', { name: 'Check repository', exact: true }).click();
  await expect(connect).toBeEnabled();
  expect(connections).toHaveLength(0);
  await repository.getByRole('button', { name: 'Connect shared repository', exact: true }).click();
  await expect(
    repository.getByRole('button', { name: 'Retry saved connection', exact: true }),
  ).toBeVisible();
  await page.reload();
  expect(connections).toHaveLength(1);
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  controls = page.locator('.group-host-controls');
  await controls.getByText('Work folder', { exact: true }).click();
  await repository.getByRole('button', { name: 'Retry saved connection', exact: true }).click();
  await expect(repository).toContainText('Repository verified. Automatic sync: Paused.');
  expect(connections).toHaveLength(2);
  expect(connections[1]).toEqual(connections[0]);
  await controls.getByText('Advanced', { exact: true }).click();
  await controls.getByText('Git sync and reviewed changes', { exact: true }).click();
  const advanced = page.getByRole('region', { name: 'Shared GitHub workspace', exact: true });
  await expect(advanced).toHaveCount(1);
  await expect(advanced.getByLabel('Automatic sync', { exact: true })).not.toBeChecked();
  await expect(repository).toHaveCount(1);
  await screenshot(page, 'verified-repository-controls');
  await controls.getByText('Advanced', { exact: true }).click();
  git.autoSync = true;
  git.dirty = true;
  git.message = 'Sync is waiting for a reviewed branch correction. All files were preserved.';
  const beforeCheck = gitOperations.length;
  await repository.getByRole('button', { name: 'Check repository', exact: true }).click();
  await expect(repository).toContainText('Repository verified. Automatic sync: On.');
  await expect(repository).toContainText(git.message);
  await screenshot(page, 'connected-repository-sync-notice');
  git.dirty = false;
  git.message = 'Reviewed shared files are up to date.';
  await repository.getByRole('button', { name: 'Check repository', exact: true }).click();
  await expect(repository).toContainText(git.message);
  await expect(repository).not.toContainText('Sync is waiting for a reviewed branch correction.');
  expect(gitOperations.slice(beforeCheck).map((operation) => operation.action)).toEqual([
    'status',
    'status',
  ]);
  expect(connections).toHaveLength(2);
});

test('local removal and restore keep original history and draft with lost-ack recovery after reload', async ({
  page,
}) => {
  const requests: ReturnType<typeof groupHostLocalVisibilitySchema.parse>[] = [];
  let loseAck = true;
  await page.route('**/api/groups/local-visibility', async (route) => {
    requests.push(groupHostLocalVisibilitySchema.parse(route.request().postDataJSON()));
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (loseAck) {
      loseAck = false;
      await route.abort('connectionreset');
      return;
    }
    await route.fulfill({ response });
  });
  await enter(page);
  await create(page, 'Retained Creek');
  const draft = page.getByPlaceholder('Message the group…');
  const savedDraft = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/groups/draft' &&
      response.request().postDataJSON().text === 'Unsent retained draft · β 📚' &&
      response.ok(),
  );
  await draft.fill('Unsent retained draft · β 📚');
  await savedDraft;
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.getByRole('button', { name: 'Remove from this app', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Remove group from this app', exact: true });
  await expect(dialog).toContainText('It does not leave the group or delete cloud data.');
  await dialog.getByRole('button', { name: 'Remove group', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry saved change', exact: true }),
  ).toBeVisible();
  await page.reload();
  expect(requests).toHaveLength(1);
  await page.getByRole('button', { name: 'Back to groups', exact: true }).click();
  await page.getByText('Removed groups (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Review saved list change', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Remove group from this app', exact: true });
  await dialog.getByRole('button', { name: 'Check current setting', exact: true }).click();
  await expect(dialog).toContainText('Currently hidden from this app.');
  expect(requests).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Retry saved change', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await page.getByRole('button', { name: 'Restore group', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Restore group to this app', exact: true });
  await dialog.getByRole('button', { name: 'Restore group', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests[2]).toMatchObject({ handle: requests[0]!.handle, revision: 1, hidden: false });
  expect(requests[2]!.key).not.toBe(requests[0]!.key);
  await page.getByRole('button', { name: /Retained Creek/ }).click();
  await expect(draft).toHaveValue('Unsent retained draft · β 📚');
  await screenshot(page, 'restored-group-draft');
});

test('Read-only is server-enforced, retains editable drafts and exact mode retry after reload', async ({
  page,
}) => {
  const operations: unknown[] = [];
  let loseAck = true;
  await page.route('**/api/groups/local-mode', async (route) => {
    operations.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (loseAck) {
      loseAck = false;
      await route.abort('connectionreset');
      return;
    }
    await route.fulfill({ response });
  });
  await enter(page);
  await create(page, 'Quiet Valley');
  const draft = page.getByPlaceholder('Message the group…');
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/groups/draft' &&
      response.request().postDataJSON().text === 'Retained while reading · λ' &&
      response.ok(),
  );
  await draft.fill('Retained while reading · λ');
  await saved;
  await page.getByRole('button', { name: 'Contribution mode: Contribute', exact: true }).click();
  let dialog = page.getByRole('dialog', {
    name: 'Contribution mode on this computer',
    exact: true,
  });
  await expect(dialog).toContainText('Already running work may finish.');
  await screenshot(page, 'contribution-mode');
  await dialog.getByRole('button', { name: 'Read-only', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry saved mode change', exact: true }),
  ).toBeVisible();
  await page.reload();
  expect(operations).toHaveLength(1);
  const mode = page.getByRole('button', {
    name: 'Contribution mode: Read-only, saved change pending',
    exact: true,
  });
  await expect(mode).toBeVisible();
  expect((await mode.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(draft).toHaveValue('Retained while reading · λ');
  await draft.fill('Edited without contributing · γ');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  const handle = new URL(page.url()).hash.split('/').at(-1)!;
  const opened = await page.request.post(`${connection.origin}/api/groups/open`, {
    headers: { Origin: connection.origin },
    data: { handle },
  });
  const group = await opened.json();
  for (const target of ['send', 'request-agent']) {
    const refused = await page.request.post(`${connection.origin}/api/groups/${target}`, {
      headers: { Origin: connection.origin },
      data: {
        handle: group.shared.handle,
        key: randomUUID(),
        text: 'Must not dispatch a new contribution',
        ...(target === 'request-agent' ? { intent: 'ask' } : {}),
      },
    });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'GROUP_LOCAL_READ_ONLY' });
  }
  await mode.click();
  dialog = page.getByRole('dialog', { name: 'Contribution mode on this computer', exact: true });
  await dialog.getByRole('button', { name: 'Check current mode', exact: true }).click();
  await expect(dialog).toContainText('Current mode refreshed.');
  expect(operations).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Retry saved mode change', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(operations).toHaveLength(2);
  expect(operations[1]).toEqual(operations[0]);
  await expect(
    page.getByRole('button', { name: 'Contribution mode: Read-only', exact: true }),
  ).toBeVisible();
  await screenshot(page, 'read-only-draft');
  await page.getByRole('button', { name: 'Contribution mode: Read-only', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Contribution mode on this computer', exact: true });
  await dialog.getByRole('button', { name: 'Contribute', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Contribution mode: Contribute', exact: true }),
  ).toBeVisible();
  await expect(draft).toHaveValue('Edited without contributing · γ');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  expect(operations[2]).toMatchObject({ handle, revision: 1, mode: 'contribute' });
  // Switching mode never submits the current draft or a new native request.
  expect(operations).toHaveLength(3);
});

test('mode retry acknowledges the original receipt while showing a later saved setting', async ({
  page,
}) => {
  const operations: Array<{ handle: string; key: string; revision: number; mode: string }> = [];
  await page.route('**/api/groups/local-mode', async (route) => {
    operations.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (operations.length === 1) await route.abort('connectionreset');
    else await route.fulfill({ response });
  });
  await enter(page);
  await create(page, 'Current Meadow');
  await page.getByRole('button', { name: 'Contribution mode: Contribute', exact: true }).click();
  let dialog = page.getByRole('dialog', {
    name: 'Contribution mode on this computer',
    exact: true,
  });
  await dialog.getByRole('button', { name: 'Read-only', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry saved mode change', exact: true }),
  ).toBeVisible();
  const later = await page.request.post(`${connection.origin}/api/groups/local-mode`, {
    headers: { Origin: connection.origin },
    data: { handle: operations[0]!.handle, key: randomUUID(), revision: 1, mode: 'contribute' },
  });
  expect(later.ok()).toBe(true);
  await page.reload();
  await page
    .getByRole('button', {
      name: 'Contribution mode: Contribute, saved change pending',
      exact: true,
    })
    .click();
  dialog = page.getByRole('dialog', { name: 'Contribution mode on this computer', exact: true });
  await dialog.getByRole('button', { name: 'Retry saved mode change', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(operations).toHaveLength(2);
  expect(operations[1]).toEqual(operations[0]);
  await expect(
    page.getByRole('button', { name: 'Contribution mode: Contribute', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Contribution mode: Contribute', exact: true }).click();
  await dialog.getByRole('button', { name: 'Read-only', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(operations[2]).toMatchObject({ revision: 2, mode: 'read-only' });
  expect(operations[2]!.key).not.toBe(operations[0]!.key);
});

test('Advanced explains optional local receipt admission and warns near capacity without a new read loop', async ({
  page,
}) => {
  let include = true,
    full = false,
    reads = 0;
  const limitBytes = 252 * 1024 * 1024;
  await page.route(/\/api\/groups(?:\?.*)?$/, async (route) => {
    reads++;
    const response = await route.fetch();
    const value = await response.json();
    if (include)
      value.service.localReceiptStorage = {
        bytes: full ? limitBytes : 210 * 1024 * 1024,
        limitBytes,
        full,
      };
    else delete value.service.localReceiptStorage;
    await route.fulfill({ response, json: value });
  });
  await enter(page);
  await create(page, 'Bounded Grove');
  await expect(
    page.getByRole('region', { name: 'Local recovery records', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  const beforeAdvanced = reads;
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  let panel = page.getByRole('region', { name: 'Local recovery records', exact: true });
  await expect(panel).toContainText('210.0 of 252.0 MiB');
  await expect(panel).toContainText(
    'separate from Cloudflare storage, other local data and physical disk usage.',
  );
  await expect(panel.getByRole('status')).toContainText('approaching their limit');
  expect(reads).toBe(beforeAdvanced);
  await panel
    .getByRole('heading', { name: 'Local recovery records', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible();
  await screenshot(page, 'advanced-local-receipt-usage');
  await panel.getByRole('status').scrollIntoViewIfNeeded();
  await expect(panel.getByRole('status')).toBeInViewport();
  await screenshot(page, 'advanced-local-receipt-warning');
  full = true;
  await page.reload();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  panel = page.getByRole('region', { name: 'Local recovery records', exact: true });
  await expect(panel).toContainText('252.0 of 252.0 MiB');
  await expect(panel.getByRole('status')).toContainText('full; new contributions may be refused');
  include = false;
  await page.reload();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  await expect(panel).toHaveCount(0);
});
