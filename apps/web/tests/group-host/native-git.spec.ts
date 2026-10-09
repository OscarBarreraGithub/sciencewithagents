import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  groupNativeGitRequestSchema,
  type GroupNativeCommitPreview,
  type GroupNativeGitRequest,
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
    const timer = setTimeout(() => reject(new Error('Native Git harness startup timeout')), 30000);
    child!.once('exit', () => reject(new Error('Native Git harness exited')));
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
    const end = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await end;
  }
  expect(child?.exitCode).toBe(0);
});

test('native Groups management saves a blank GitHub username and retries its exact sync setup', async ({
  page,
}) => {
  const requests: GroupNativeGitRequest[] = [];
  const view: GroupNativeGitView = {
    available: true,
    repository: 'https://github.com/example/research-group',
    workspacePath: '/synthetic/shared/group-workspace',
    branch: 'sciencewithagents/shared',
    githubUsername: '',
    autoSync: false,
    dirty: false,
    busy: false,
    message: 'Shared files are ready. Automatic sync is off.',
    localEdits: [
      {
        taskId: null,
        label: 'Group workspace',
        state: 'changed',
        changed: 2,
        withheld: 1,
        truncated: false,
        files: [{ path: 'chapters/unfinished.tex', status: ' M' }],
      },
    ],
    tasks: [],
    preview: null,
  };
  let loseAcknowledgement = true;
  // The actual GroupsApp and native-mode host mount the panel. Only this Git
  // endpoint is simulated; the fixture never invokes Git, GitHub or a provider.
  await page.route('**/api/groups/native-git', async (route) => {
    const input = groupNativeGitRequestSchema.parse(route.request().postDataJSON());
    requests.push(input);
    if (input.action === 'configure') {
      view.githubUsername = input.githubUsername;
      view.autoSync = input.autoSync;
      view.message = 'Automatic sync is on. Your shared files are up to date.';
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        await route.abort('connectionreset');
        return;
      }
    }
    if (input.action === 'sync') view.message = 'Sync complete. Your shared files are up to date.';
    await route.fulfill({ json: view });
  });
  const [name, ...parts] = connection.cookie.split('=');
  await page
    .context()
    .addCookies([
      { name, value: parts.join('='), url: connection.origin, httpOnly: true, sameSite: 'Strict' },
    ]);
  await page.goto(`${connection.origin}/#/home`);
  await page.goto(`${connection.origin}/#/chats/groups`);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Amina');
  await page.getByLabel('Project name', { exact: true }).fill('Native files River');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Native files River', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Shared files on GitHub', exact: true }),
  ).toBeHidden();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  await page.getByText('Git sync and reviewed changes', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'Shared GitHub workspace', exact: true });
  await expect(panel).toHaveCount(1);
  await expect(
    panel.getByRole('heading', { name: 'Shared files on GitHub', exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole('link', { name: view.repository!, exact: true })).toHaveAttribute(
    'href',
    view.repository!,
  );
  const username = panel.getByLabel('Your GitHub username (optional)', { exact: true });
  await panel.getByText('Unfinished files on this computer', { exact: true }).click();
  await expect(panel.getByText('chapters/unfinished.tex', { exact: true })).toBeVisible();
  await expect(
    panel.getByText('1 private or runtime names withheld.', { exact: true }),
  ).toBeVisible();
  const automaticSync = panel.getByLabel('Automatic sync', { exact: true });
  await expect(username).toHaveValue('');
  await automaticSync.check();
  await panel.getByRole('button', { name: 'Save GitHub setup', exact: true }).click();
  const retry = panel.getByRole('button', { name: 'Retry saved Git change', exact: true });
  await expect(retry).toBeVisible();
  const configured = requests.find((input) => input.action === 'configure')!;
  expect(configured).toMatchObject({ action: 'configure', githubUsername: '', autoSync: true });
  expect(configured.handle).toBe(requests[0]!.handle);
  await expect(
    panel.getByRole('button', { name: 'Save GitHub setup', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Native files River', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  await page.getByText('Git sync and reviewed changes', { exact: true }).click();
  await expect(panel).toHaveCount(1);
  await expect(username).toHaveValue('');
  await expect(automaticSync).toBeChecked();
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(retry).toHaveCount(0);
  expect(requests.filter((input) => input.action === 'configure')).toEqual([
    configured,
    configured,
  ]);
  await expect(panel.getByRole('status')).toHaveText(
    'Automatic sync is on. Your shared files are up to date.',
  );
  await panel.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(
    'Sync complete. Your shared files are up to date.',
  );
  expect(requests.at(-1)).toMatchObject({ action: 'sync', handle: configured.handle });
  await expect(username).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  expect(
    await page
      .locator('.group-host-controls')
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({
    path: join(root, 'data/normal-groups', `${test.info().project.name}-native-git-manage.png`),
  });
});
test('creator can retry a changed hosted snapshot and see a verified private archive in Manage', async ({
  page,
}) => {
  const archiveId = '99999999-9999-4999-8999-999999999999';
  let attempts = 0;
  const keys: string[] = [];
  await page.route('**/api/groups/hosted-export', async (route) => {
    const request = route.request().postDataJSON();
    expect(Object.keys(request)).toEqual(['handle', 'key']);
    keys.push(request.key);
    if (++attempts === 1) {
      await route.fulfill({
        status: 503,
        json: {
          code: 'GROUP_EXPORT_UNAVAILABLE',
          error: 'The group changed during export. Choose a quiet window and start a fresh export.',
        },
      });
      return;
    }
    if (attempts === 2) {
      await route.abort('failed');
      return;
    }
    if (attempts === 4) {
      await route.fulfill({
        status: 503,
        json: {
          code: 'GROUP_EXPORT_HELD',
          error: 'An interrupted private archive needs inspection. Its bytes were preserved.',
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        archiveId,
        groupId: '88888888-8888-4888-8888-888888888888',
        pages: 8,
        rows: 144,
        bytes: 65536,
        sha256: 'a'.repeat(64),
        createdAt: new Date().toISOString(),
      },
    });
  });
  const [name, ...parts] = connection.cookie.split('=');
  await page
    .context()
    .addCookies([
      { name, value: parts.join('='), url: connection.origin, httpOnly: true, sameSite: 'Strict' },
    ]);
  await page.goto(`${connection.origin}/#/home`);
  await page.goto(`${connection.origin}/#/chats/groups`);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Creator');
  await page.getByLabel('Project name', { exact: true }).fill('Private archive River');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Private archive River', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  const summary = page
    .locator('summary')
    .filter({ hasText: 'Creator backup of shared group data' });
  await expect(summary).toHaveCount(1);
  await summary.click();
  const exportButton = page.getByRole('button', {
    name: 'Save private shared-data backup',
    exact: true,
  });
  await exportButton.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'The group changed during export' }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  await expect(summary).toHaveCount(1);
  await summary.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'An export acknowledgement is pending' }),
  ).toBeVisible();
  await exportButton.click();
  await expect.poll(() => attempts).toBe(2);
  await expect(exportButton).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  await expect(summary).toHaveCount(1);
  await summary.click();
  await exportButton.click();
  await expect(
    page.getByRole('status').filter({ hasText: `Verified private archive ${archiveId}` }),
  ).toBeVisible();
  expect(attempts).toBe(3);
  expect(new Set(keys).size).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  await expect(summary).toHaveCount(1);
  await summary.click();
  await expect(
    page.getByRole('status').filter({ hasText: `Verified private archive ${archiveId}` }),
  ).toBeVisible();
  expect(attempts).toBe(3);
  await page.getByRole('button', { name: 'Export another snapshot', exact: true }).click();
  const fresh = page.getByRole('button', {
    name: 'Keep held archive and export a fresh snapshot',
    exact: true,
  });
  await expect(fresh).toBeVisible();
  await fresh.click();
  await expect(
    page.getByRole('button', { name: 'Export another snapshot', exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(5);
  expect(keys[3]).not.toBe(keys[2]);
  expect(keys[4]).not.toBe(keys[3]);
  const dialog = page.getByRole('dialog');
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

function reviewView(): GroupNativeGitView {
  return {
    available: true,
    connected: true,
    repository: 'https://github.com/example/private-native-work',
    workspacePath: '/synthetic/chosen-shared-folder',
    branch: 'sciencewithagents/member/request',
    githubUsername: '',
    autoSync: true,
    dirty: false,
    busy: false,
    message: 'Completed native Work is ready for owner review.',
    localEdits: [],
    tasks: [],
    preview: null,
    nativeReviewAvailable: true,
    nativePreview: null,
  };
}
function nativePreview(head = 'b'.repeat(40)): GroupNativeCommitPreview {
  return {
    id: randomUUID(),
    requestId: randomUUID(),
    base: 'a'.repeat(40),
    head,
    tree: 'c'.repeat(40),
    branch: 'sciencewithagents/member/request',
    repository: 'https://github.com/example/private-native-work',
    fingerprint: (head.startsWith('b') ? 'd' : 'e').repeat(64),
    files: ['src/analysis.ts', 'data/result.png'],
    patch: `commit ${'f'.repeat(40)}\ndiff --git a/src/analysis.ts b/src/analysis.ts\n+${'x'.repeat(200)}\n+First commit result\ncommit ${head}\n+<script>window.__reviewScriptExecuted=true</script>\n${'+Exact retained result\n'.repeat(2500)}Binary files a/data/result.png and b/data/result.png differ\n`,
  };
}
async function openReviewGroup(page: Page, name: string) {
  const [cookie, ...value] = connection.cookie.split('=');
  await page.context().addCookies([
    {
      name: cookie,
      value: value.join('='),
      url: connection.origin,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  await page.goto(`${connection.origin}/#/chats/groups`);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByLabel('Your display name', { exact: true }).fill('Owner reviewer');
  await page.getByLabel('Project name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await openWorkFolder(page);
}
async function openWorkFolder(page: Page) {
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.locator('.group-work-folder > summary').click();
}

test('Files to share preserves the complete native review and exact approval through a lost reply and reload without model work', async ({
  page: initialPage,
}, info) => {
  let page = initialPage;
  const context = page.context();
  const view = reviewView();
  const preview = nativePreview();
  const inputs: GroupNativeGitRequest[] = [];
  let approvals = 0;
  let effect = 0;
  let completed: GroupNativeGitView | undefined;
  let modelRequests = 0;
  context.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/agents\/[^/]+\/messages$/.test(new URL(request.url()).pathname)
    )
      modelRequests++;
  });
  await context.route('**/api/groups/native-git', async (route) => {
    const input = groupNativeGitRequestSchema.parse(route.request().postDataJSON());
    inputs.push(input);
    if (input.action === 'preview-native')
      return route.fulfill({ json: { ...view, nativePreview: preview } });
    if (input.action === 'approve-native') {
      approvals++;
      expect(input).toMatchObject({ previewId: preview.id, fingerprint: preview.fingerprint });
      completed ??= {
        ...view,
        nativeReviewAvailable: false,
        nativePreview: null,
        message:
          'Your exact file review was recorded. Automatic sync can now share this checkpoint.',
      };
      if (approvals === 1) {
        effect++;
        view.nativeReviewAvailable = false;
        return route.abort('failed');
      }
      return route.fulfill({ json: completed });
    }
    if (input.action === 'sync')
      view.message = 'Reviewed files shared; the current native program was not started.';
    return route.fulfill({ json: view });
  });
  await openReviewGroup(page, `Owner native files ${info.project.name}`);
  let files = page.getByRole('region', { name: 'Files to share', exact: true });
  await files.getByRole('button', { name: 'Review changes', exact: true }).click();
  let patch = files.getByLabel('Complete saved native diff');
  await expect(patch).toHaveText(preview.patch);
  expect(
    await patch.evaluate((element) => ({
      nodes: element.childNodes.length,
      text: element.textContent,
      scrollable: element.scrollHeight > element.clientHeight,
      fits: element.scrollWidth <= element.clientWidth + 1,
    })),
  ).toEqual({ nodes: 1, text: preview.patch, scrollable: true, fits: true });
  await expect(patch.locator('script')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __reviewScriptExecuted?: boolean }).__reviewScriptExecuted,
    ),
  ).toBeUndefined();
  await expect(files.getByRole('list', { name: 'Files in this review' })).toHaveText(
    preview.files.join(''),
  );
  const approve = files.getByRole('button', { name: 'Record review', exact: true });
  await expect(approve).toBeDisabled();
  await files.getByRole('checkbox').check();
  await approve.click();
  await expect(
    files.getByRole('button', { name: 'Check saved review', exact: true }),
  ).toBeVisible();
  await expect(patch).toHaveText(preview.patch);
  expect(effect).toBe(1);
  expect(inputs.some((input) => input.action === 'sync')).toBe(false);
  await page.reload();
  await openWorkFolder(page);
  await expect(patch).toHaveText(preview.patch);
  await expect(
    files.getByRole('button', { name: 'Check saved review', exact: true }),
  ).toBeEnabled();
  expect(approvals).toBe(1); // Reload reads status, never silently retries owner approval.
  const originalUrl = page.url();
  await page.close();
  page = await context.newPage();
  await page.goto(originalUrl);
  await openWorkFolder(page);
  files = page.getByRole('region', { name: 'Files to share', exact: true });
  patch = files.getByLabel('Complete saved native diff');
  await expect(patch).toHaveText(preview.patch);
  await expect(
    files.getByRole('button', { name: 'Check saved review', exact: true }),
  ).toBeEnabled();
  expect(approvals).toBe(1); // Closing the old tab never loses or dispatches the saved approval.
  await files.getByRole('button', { name: 'Check saved review', exact: true }).click();
  await expect(files.getByRole('status')).toContainText('Your exact review was recorded');
  expect(inputs.filter((input) => input.action === 'approve-native')).toEqual([
    inputs.find((input) => input.action === 'approve-native'),
    inputs.find((input) => input.action === 'approve-native'),
  ]);
  expect(effect).toBe(1);
  await files.getByRole('button', { name: 'Share reviewed changes', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Shared repository connection', exact: true }),
  ).toContainText('Reviewed files shared');
  expect(inputs.filter((input) => input.action === 'sync')).toHaveLength(1);
  expect(modelRequests).toBe(0);
  // Preview again only to inspect readability; it cannot approve or share by itself.
  view.nativeReviewAvailable = true;
  await page.getByRole('button', { name: 'Check repository', exact: true }).click();
  await files.getByRole('button', { name: 'Review changes', exact: true }).click();
  const fontSizes = await files
    .locator('p, label, code, dt, dd, pre, button')
    .evaluateAll((elements) =>
      elements.map((element) => parseFloat(getComputedStyle(element).fontSize)),
    );
  for (const size of fontSizes) expect(size).toBeGreaterThanOrEqual(16);
  const controls = await files
    .locator('button')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  for (const height of controls) expect(height).toBeGreaterThanOrEqual(44);
  expect(
    await page
      .locator('.group-host-controls')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({
    path: join(root, 'data/normal-groups', `${info.project.name}-native-file-review.png`),
  });
});

test('a changed native HEAD refuses the old approval and requires a fresh exact preview, acknowledgement and key', async ({
  page,
}, info) => {
  const view = reviewView();
  let preview = nativePreview();
  const first = preview;
  const inputs: GroupNativeGitRequest[] = [];
  let recorded = 0;
  await page.route('**/api/groups/native-git', (route) => {
    const input = groupNativeGitRequestSchema.parse(route.request().postDataJSON());
    inputs.push(input);
    if (input.action === 'preview-native')
      return route.fulfill({ json: { ...view, nativePreview: preview } });
    if (input.action === 'approve-native') {
      if (input.previewId !== preview.id)
        return route.fulfill({
          status: 409,
          json: {
            error:
              'The native head changed. Review the current exact commits before recording another review.',
          },
        });
      recorded++;
      return route.fulfill({
        json: { ...view, nativePreview: null, message: 'Exact current review recorded.' },
      });
    }
    return route.fulfill({ json: view });
  });
  await openReviewGroup(page, `Changed native files ${info.project.name}`);
  const files = page.getByRole('region', { name: 'Files to share', exact: true });
  await files.getByRole('button', { name: 'Review changes', exact: true }).click();
  await files.getByRole('checkbox').check();
  preview = nativePreview('9'.repeat(40));
  await files.getByRole('button', { name: 'Record review', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Shared repository connection', exact: true })
      .getByRole('alert'),
  ).toContainText('native head changed');
  await expect(files.getByRole('button', { name: 'Check saved review' })).toHaveCount(0);
  await expect(files.getByRole('checkbox')).toHaveCount(0);
  await expect(files.getByRole('button', { name: 'Record review' })).toHaveCount(0);
  expect(recorded).toBe(0);
  expect(inputs.filter((input) => input.action === 'approve-native')).toHaveLength(1);
  await files.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(files.getByLabel('Complete saved native diff')).toHaveText(preview.patch);
  await expect(files.getByRole('checkbox')).not.toBeChecked();
  await expect(files.getByRole('button', { name: 'Record review' })).toBeDisabled();
  await files.getByRole('checkbox').check();
  await files.getByRole('button', { name: 'Record review' }).click();
  const approved = inputs.filter((input) => input.action === 'approve-native');
  expect(approved).toHaveLength(2);
  expect(approved[0]).toMatchObject({ previewId: first.id, fingerprint: first.fingerprint });
  expect(approved[1]).toMatchObject({ previewId: preview.id, fingerprint: preview.fingerprint });
  expect((approved[0] as { key: string }).key).not.toBe((approved[1] as { key: string }).key);
  expect(recorded).toBe(1);
});

test('retained managed task preview and exact apply remain in Advanced without native review controls', async ({
  page,
}, info) => {
  const view = reviewView();
  delete view.nativeReviewAvailable;
  delete view.nativePreview;
  const taskId = randomUUID();
  view.tasks = [{ id: taskId, title: 'Retained managed task', status: 'done', reviewed: true }];
  const requests: GroupNativeGitRequest[] = [];
  const managed = {
    taskId,
    source: '1'.repeat(40),
    target: '2'.repeat(40),
    changes: '1 file changed',
    patch: 'diff --git a/managed.txt b/managed.txt\n+Reviewed managed result\n',
    canApply: true,
    relation: 'fast-forward' as const,
    reconciliationTaskId: null,
  };
  await page.route('**/api/groups/native-git', (route) => {
    const input = groupNativeGitRequestSchema.parse(route.request().postDataJSON());
    requests.push(input);
    return route.fulfill({
      json: { ...view, preview: input.action === 'preview' ? managed : null },
    });
  });
  await openReviewGroup(page, `Retained managed files ${info.project.name}`);
  await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toHaveCount(0);
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  await page.getByText('Git sync and reviewed changes', { exact: true }).click();
  const advanced = page.getByRole('region', { name: 'Shared GitHub workspace', exact: true });
  await advanced.getByText('Review shared tasks', { exact: true }).click();
  await advanced.getByRole('button', { name: 'Inspect exact changes' }).click();
  const original = advanced.getByRole('region', { name: 'Exact shared task changes' });
  await expect(original.locator('pre')).toContainText(managed.patch);
  await original.getByRole('button', { name: 'Confirm and apply these exact changes' }).click();
  expect(requests.filter((input) => input.action === 'apply')).toEqual([
    {
      action: 'apply',
      handle: requests[0]!.handle,
      key: (requests.find((input) => input.action === 'apply') as { key: string }).key,
      taskId,
      source: managed.source,
      target: managed.target,
    },
  ]);
  expect(
    requests.some(
      (input) => input.action === 'approve-native' || input.action === 'preview-native',
    ),
  ).toBe(false);
});

test('a native review browser-save failure sends no approval and keeps the displayed exact changes', async ({
  page,
}, info) => {
  const view = reviewView();
  const preview = nativePreview();
  const requests: GroupNativeGitRequest[] = [];
  await page.route('**/api/groups/native-git', (route) => {
    const input = groupNativeGitRequestSchema.parse(route.request().postDataJSON());
    requests.push(input);
    return route.fulfill({
      json: { ...view, nativePreview: input.action === 'preview-native' ? preview : null },
    });
  });
  await openReviewGroup(page, `Review storage failure ${info.project.name}`);
  const files = page.getByRole('region', { name: 'Files to share', exact: true });
  await files.getByRole('button', { name: 'Review changes', exact: true }).click();
  await files.getByRole('checkbox').check();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith(':native-approval'))
        throw new DOMException('Review storage unavailable', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await files.getByRole('button', { name: 'Record review' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Shared repository connection', exact: true })
      .getByRole('alert'),
  ).toContainText('No review request was sent');
  await expect(files.getByLabel('Complete saved native diff')).toHaveText(preview.patch);
  await expect(files.getByRole('checkbox')).toBeChecked();
  await expect(files.getByRole('button', { name: 'Check saved review' })).toHaveCount(0);
  expect(requests.filter((input) => input.action === 'approve-native')).toEqual([]);
});

for (const outcome of ['success', 'refusal'] as const) {
  test(`first native approval ${outcome} clears its durable intent before reload`, async ({
    page,
  }, info) => {
    const view = reviewView();
    let preview = nativePreview();
    let approvals = 0;
    await page.route('**/api/groups/native-git', (route) => {
      const input = groupNativeGitRequestSchema.parse(route.request().postDataJSON());
      if (input.action === 'preview-native')
        return route.fulfill({ json: { ...view, nativePreview: preview } });
      if (input.action === 'approve-native') {
        approvals++;
        if (outcome === 'refusal')
          return route.fulfill({
            status: 409,
            json: { error: 'Native head changed; choose a new preview.' },
          });
        view.nativeReviewAvailable = false;
        return route.fulfill({ json: { ...view, message: 'Exact native review recorded.' } });
      }
      return route.fulfill({ json: view });
    });
    await openReviewGroup(page, `First review ${outcome} ${info.project.name}`);
    const files = page.getByRole('region', { name: 'Files to share', exact: true });
    await files.getByRole('button', { name: 'Review changes', exact: true }).click();
    await files.getByRole('checkbox').check();
    await files.getByRole('button', { name: 'Record review' }).click();
    if (outcome === 'success')
      await expect(files.getByRole('status')).toContainText('Your exact review was recorded');
    else
      await expect(
        page
          .getByRole('region', { name: 'Shared repository connection', exact: true })
          .getByRole('alert'),
      ).toContainText('Native head changed');
    expect(approvals).toBe(1);
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.endsWith(':native-approval')),
      ),
    ).toEqual([]);
    await page.reload();
    await openWorkFolder(page);
    await expect(page.getByRole('button', { name: 'Check saved review' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Record review' })).toHaveCount(0);
    expect(approvals).toBe(1);
    if (outcome === 'refusal') {
      preview = nativePreview('9'.repeat(40));
      await files.getByRole('button', { name: 'Review changes', exact: true }).click();
      await expect(files.getByRole('checkbox')).not.toBeChecked();
      await expect(files.getByRole('button', { name: 'Record review' })).toBeDisabled();
      await expect(files.getByLabel('Complete saved native diff')).toHaveText(preview.patch);
    }
  });
}

test('settled native approval preserves and restores a different legacy saved sync request', async ({
  page,
}, info) => {
  const view = reviewView();
  const preview = nativePreview();
  const requests: GroupNativeGitRequest[] = [];
  await page.route('**/api/groups/native-git', (route) => {
    const input = groupNativeGitRequestSchema.parse(route.request().postDataJSON());
    requests.push(input);
    if (input.action === 'approve-native') view.nativeReviewAvailable = false;
    return route.fulfill({
      json: { ...view, nativePreview: input.action === 'preview-native' ? preview : null },
    });
  });
  await openReviewGroup(page, `Retained legacy sync ${info.project.name}`);
  const files = page.getByRole('region', { name: 'Files to share', exact: true });
  await files.getByRole('button', { name: 'Review changes', exact: true }).click();
  const handle = requests[0]!.handle;
  const legacy = { action: 'sync', handle, key: randomUUID() } as const;
  await page.evaluate(
    (input) =>
      sessionStorage.setItem(`swa:local:group-native-git:${input.handle}`, JSON.stringify(input)),
    legacy,
  );
  await files.getByRole('checkbox').check();
  await files.getByRole('button', { name: 'Record review' }).click();
  await expect(
    page.getByRole('region', { name: 'Shared repository connection', exact: true }),
  ).toContainText('A saved repository change is unresolved');
  expect(
    await page.evaluate(
      (handle) => JSON.parse(sessionStorage.getItem(`swa:local:group-native-git:${handle}`)!),
      handle,
    ),
  ).toEqual(legacy);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.endsWith(':native-approval')),
    ),
  ).toEqual([]);
  await page.reload();
  await openWorkFolder(page);
  await expect(page.getByRole('button', { name: 'Check saved review' })).toHaveCount(0);
  await page.locator('.group-host-controls').getByText('Advanced', { exact: true }).click();
  await page.getByText('Git sync and reviewed changes', { exact: true }).click();
  const advanced = page.getByRole('region', { name: 'Shared GitHub workspace', exact: true });
  await expect(advanced.getByRole('button', { name: 'Save GitHub setup' })).toBeDisabled();
  await advanced.getByRole('button', { name: 'Retry saved Git change' }).click();
  expect(requests.filter((input) => input.action === 'sync')).toEqual([legacy]);
});
