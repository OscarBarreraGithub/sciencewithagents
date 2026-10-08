import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  clusterStatusSchema,
  clusterWorkspaceLeaseRequestSchema,
  clusterWorkspaceRefreshSchema,
  clusterWorkspaceSchema,
  clusterWorkspaceSettingsSchema,
  clusterWorkspaceUpdateResultSchema,
} from '@dock/shared';

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const shots = '../../data/screenshots/cluster-workspace';
const current = randomUUID();
const earlier = randomUUID();

/** Collector reading the existing panel already shows; kept small. */
function cluster(state: 'connected' | 'sign-in-needed' = 'connected') {
  const section = { observedAt: at(1), error: null, items: [], omitted: 0 };
  return clusterStatusSchema.parse({
    configured: true,
    settings: { enabled: true, alias: 'hpc', label: 'Lab cluster', accountingDays: 3 },
    revision: 1,
    connection: {
      state,
      master: state === 'connected' ? 'running' : 'absent',
      checkedAt: at(1),
      connectedAt: at(1),
      message:
        state === 'connected'
          ? 'Connected through your existing SSH sign-in.'
          : 'Cluster sign-in is needed. Batch jobs already submitted keep running.',
    },
    scheduler: { version: '26.05.4', cluster: 'cluster1' },
    queue: {
      ...section,
      priority: [],
      items: [
        {
          jobId: '51000001',
          baseJobId: '51000001',
          name: 'parameter-sweep',
          state: 'RUNNING',
          reason: '',
          partition: 'shared',
          account: 'lab_account',
          qos: 'normal',
          submittedAt: '2026-10-05T08:00:00',
          startAt: '2026-10-05T09:30:00',
          timeLimit: '12:00:00',
          timeUsed: '1:02:03',
          cpus: 8,
          memory: '32G',
          gres: '',
          nodes: 1,
          nodeList: 'node101',
          priority: 1_001_499,
          workDir: '/n/labs/lab_account/researcher/run',
          owner: null,
        },
      ],
    },
    fairshare: section,
    limits: { ...section, accounts: [], qos: [], partitions: [], site: null },
    recent: section,
    tracked: [],
    unavailable: [],
    refreshing: false,
    nextRefreshAt: null,
    stale: false,
    notice: 'Read-only observations of native Slurm state through your own SSH sign-in.',
  });
}
const partition = (name: string, accessible: boolean) => ({
  name,
  state: 'UP',
  maxTime: '3-00:00:00',
  defaultTime: '',
  maxNodes: 'unlimited',
  maxCpusPerNode: 'unlimited',
  defMemPerCpu: '',
  defMemPerNode: '',
  maxMemPerNode: 'unlimited',
  qos: '',
  preemptMode: 'OFF',
  priorityTier: 3,
  totalCpus: 64,
  totalNodes: 1,
  gres: '',
  cpus: { allocated: 32, idle: 32, other: 0, total: 64 },
  accessible,
});
const entry = (relativePath: string, kind: 'directory' | 'file', git = false) => ({
  id: randomUUID(),
  relativePath,
  kind,
  size: kind === 'file' ? 1200 : null,
  modifiedAt: at(60),
  git,
});
const thesisId = randomUUID();
const thesis = (index: Record<string, unknown> = {}) => ({
  id: thesisId,
  label: 'Thesis',
  path: '~/projects/thesis',
  index: {
    state: 'ready',
    observedAt: at(3),
    connectionId: current,
    canonicalPath: '/n/home01/researcher/projects/thesis',
    error: null,
    entries: [
      entry('src', 'directory', true),
      entry('data', 'directory'),
      entry('README.md', 'file'),
      entry('src/main.py', 'file'),
    ],
    omitted: 0,
    ...index,
  },
});
type Workspace = ReturnType<typeof clusterWorkspaceSchema.parse>;
function workspace(patch: Record<string, unknown> = {}, setup: Record<string, unknown> = {}) {
  return clusterWorkspaceSchema.parse({
    alias: 'hpc',
    revision: 3,
    connectionId: current,
    connected: true,
    setup: {
      username: 'researcher',
      defaultAccount: 'lab_account',
      accounts: [
        { name: 'lab_account', fairShare: 0.163485 },
        { name: 'institute_account', fairShare: 0.999952 },
      ],
      partitions: [partition('shared', true), partition('gpu_lab', false)],
      selectedAccount: null,
      accountConfirmed: false,
      observedAt: at(5),
      error: null,
      ...setup,
    },
    roots: [thesis()],
    development: {},
    workflow: {},
    keepConnected: { enabled: false, expiresAt: null, state: 'off', message: '' },
    ...patch,
  });
}
const result = (state: Workspace, status: 'saved' | 'conflict' = 'saved', reason = null) =>
  clusterWorkspaceUpdateResultSchema.parse({ status, state, reason });

/** Routes the collector and workspace; counts anything that could open SSH. */
async function serve(page: Page, read: () => unknown) {
  const ssh = { signIn: 0, collector: 0 };
  await page.route('**/api/cluster', (route) => route.fulfill({ json: cluster() }));
  await page.route('**/api/cluster/refresh', (route) => {
    ssh.collector++;
    return route.fulfill({ json: cluster() });
  });
  await page.route('**/api/cluster/sign-in', (route) => {
    if (route.request().method() === 'POST') ssh.signIn++;
    return route.fallback();
  });
  await page.route('**/api/cluster/workspace', (route) => route.fulfill({ json: read() }));
  await page.route('**/api/cluster/projects', (route) => route.fulfill({ json: [] }));
  return ssh;
}
const region = (page: Page) => page.getByRole('region', { name: 'Lab cluster · Slurm cluster' });
const area = (page: Page) => page.getByRole('region', { name: 'Cluster workspace' });
const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('optional setup stays hidden after one discovery when either typed route is unavailable', async ({
  page,
}) => {
  await serve(page, () => workspace());
  let reads = 0;
  let reply: { status: number; json?: unknown; html?: string } = {
    status: 404,
    json: { error: 'Unknown API route.' },
  };
  await page.route('**/api/cluster/workspace', (route) => {
    reads++;
    return reply.html === undefined
      ? route.fulfill({ status: reply.status, json: reply.json ?? workspace() })
      : route.fulfill({ status: reply.status, contentType: 'text/html', body: reply.html });
  });
  for (const next of [
    reply,
    { status: 501, json: { error: 'Unavailable.' } },
    { status: 404, html: '<!doctype html><title>Not found</title>' },
    { status: 503, json: { error: 'Busy.' } },
    { status: 200, json: { alias: 'hpc' } },
  ]) {
    reply = next;
    const before = reads;
    if (before) await page.reload();
    else await page.goto('/#/work');
    await expect.poll(() => reads).toBe(before + 1);
    await expect(region(page).getByText('parameter-sweep')).toBeVisible();
    await expect(area(page)).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
    await page.waitForTimeout(100);
    expect(reads).toBe(before + 1);
  }
  reply = { status: 200 };
  await page.route('**/api/cluster/projects', (route) =>
    route.fulfill({ status: 404, json: { error: 'Unknown API route.' } }),
  );
  await page.reload();
  await expect.poll(() => reads).toBe(6);
  await expect(area(page)).toHaveCount(0);
});

test('available setup opens as a compact status with folded folders and accounts', async ({
  page,
}, info) => {
  const ssh = await serve(page, () => workspace());
  await page.goto('/#/work');
  const section = area(page);
  await expect(section.getByText(/Keep connected is off/)).toBeVisible();
  await expect(section.getByText('Workspace connected', { exact: true })).toHaveCount(0);
  await expect(section.getByLabel('Folder on the cluster')).toBeHidden();
  await expect(section.getByText('Account for agent jobs')).toBeHidden();
  await expect(section.getByText('Saved folders (1) · listed')).toBeVisible();
  await expect(section.getByText('choose an account', { exact: true })).toBeVisible();
  expect(ssh).toEqual({ signIn: 0, collector: 0 });
  expect(await noOverflow(page)).toBe(true);
  await mkdir(shots, { recursive: true });
  await region(page).evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${shots}/compact-${info.project.name}.png` });
});

test('a controller without project routes preserves local setup without advertising a remote launch', async ({
  page,
}) => {
  await serve(page, () => workspace());
  await page.route('**/api/cluster/projects', (route) =>
    route.fulfill({ status: 404, json: { error: 'Unknown API route.' } }),
  );
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/cluster/'))
      writes.push(request.url());
  });
  await page.goto('/#/new');
  await expect(page.getByRole('radiogroup', { name: 'Where the project runs' })).toHaveCount(0);
  const name = page.getByLabel('Project name', { exact: true });
  await name.fill('Keep my local name');
  await page.reload();
  await expect(name).toHaveValue('Keep my local name');
  await page.getByRole('radio', { name: /Existing folder/ }).check();
  await expect(page.getByRole('dialog', { name: /folder/i })).toBeVisible();
  expect(writes).toEqual([]);
});

test('keep connected starts, renews and stops only on an explicit request', async ({ page }) => {
  let state = workspace();
  await serve(page, () => state);
  const leases: ReturnType<typeof clusterWorkspaceLeaseRequestSchema.parse>[] = [];
  await page.route('**/api/cluster/workspace/lease', async (route) => {
    const body = clusterWorkspaceLeaseRequestSchema.parse(route.request().postDataJSON());
    leases.push(body);
    state = workspace({
      revision: state.revision + 1,
      keepConnected:
        body.hours === null
          ? { enabled: false, expiresAt: null, state: 'off', message: '' }
          : {
              enabled: true,
              expiresAt: new Date(Date.now() + body.hours * 3_600_000).toISOString(),
              state: 'holding',
              message: 'Holding the app’s own connection.',
            },
    });
    await route.fulfill({ json: result(state) });
  });
  await page.goto('/#/work');
  const section = area(page);
  await expect(section.getByText(/not your terminal’s/)).toBeVisible();
  await expect(section.getByRole('button', { name: 'Turn off' })).toHaveCount(0);
  await section.getByLabel('How long to keep connected').selectOption('24');
  await section.getByRole('button', { name: 'Keep connected' }).click();
  await expect(section.getByText(/Kept connected until .* · 2[34] h/)).toBeVisible();
  await section.getByLabel('How long to keep connected').selectOption('72');
  await section.getByRole('button', { name: 'Renew' }).click();
  await expect(section.getByText(/Kept connected until .* · 7[12] h/)).toBeVisible();
  await section.getByRole('button', { name: 'Turn off' }).click();
  await expect(section.getByText(/Keep connected is off/)).toBeVisible();
  expect(leases.map(({ hours, revision, alias }) => ({ hours, revision, alias }))).toEqual([
    { hours: 24, revision: 3, alias: 'hpc' },
    { hours: 72, revision: 4, alias: 'hpc' },
    { hours: null, revision: 5, alias: 'hpc' },
  ]);
  expect(new Set(leases.map((lease) => lease.key)).size).toBe(3);
});

test('an uncertain save survives reload as the exact request; a conflict keeps edits for an explicit rebase', async ({
  page,
}, info) => {
  let state = workspace();
  await serve(page, () => state);
  const saves: Record<string, unknown>[] = [];
  let reply: 'lost' | 'conflict' | 'saved' = 'lost';
  await page.route('**/api/cluster/workspace/settings', async (route) => {
    const raw = route.request().postDataJSON();
    clusterWorkspaceSettingsSchema.parse(raw);
    saves.push(raw);
    if (reply === 'lost') return route.abort('connectionreset');
    if (reply === 'conflict') {
      // Another browser confirmed the account meanwhile; folders were untouched there.
      state = workspace(
        { revision: 4 },
        { selectedAccount: 'lab_account', accountConfirmed: true },
      );
      return route.fulfill({
        json: { ...result(state, 'conflict'), reason: 'The setup changed in another browser.' },
      });
    }
    state = workspace(
      {
        revision: 5,
        roots: [
          thesis(),
          {
            id: randomUUID(),
            label: 'Scratch',
            path: '/n/netscratch/lab/run',
            index: {
              state: 'stale',
              observedAt: null,
              connectionId: null,
              canonicalPath: null,
              error: null,
              entries: [],
              omitted: 0,
            },
          },
        ],
      },
      { selectedAccount: 'lab_account', accountConfirmed: true },
    );
    return route.fulfill({ json: result(state) });
  });
  await page.goto('/#/work');
  const section = area(page);
  await section.getByText('Saved folders (1)').click();
  await expect(section.getByText(/Resolves to \/n\/home01/)).toBeVisible();
  await expect(section.getByText('src/ (Git)  data/  README.md')).toBeVisible();
  await section.getByRole('button', { name: 'Add folder' }).click();
  await section.getByLabel('Name', { exact: true }).nth(1).fill('Scratch');
  await section.getByLabel('Folder on the cluster').nth(1).fill('/n/netscratch/lab/run');
  await expect(section.getByRole('group', { name: 'Unsaved workspace setup' })).toContainText(
    'Unsaved: folders',
  );
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  const uncertain = section.getByRole('status').filter({ hasText: 'may not have arrived' });
  await expect(uncertain).toContainText('Saving your setup for hpc');
  await expect(section.getByLabel('Name', { exact: true }).nth(1)).toBeDisabled();

  await page.reload();
  await expect(uncertain).toBeVisible();
  await section.getByText('Saved folders (1)').click();
  await expect(section.getByLabel('Name', { exact: true }).nth(1)).toHaveValue('Scratch');
  reply = 'conflict';
  await uncertain.getByRole('button', { name: 'Retry', exact: true }).click();
  const conflict = section.getByRole('status').filter({ hasText: 'Not saved' });
  await expect(conflict).toContainText('The setup changed in another browser.');
  await expect(conflict).toContainText('do not overlap yours');
  await expect(section.getByLabel('Folder on the cluster').nth(1)).toHaveValue(
    '/n/netscratch/lab/run',
  );
  await expect(section.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  expect(await noOverflow(page)).toBe(true);
  await mkdir(shots, { recursive: true });
  await conflict.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/conflict-${info.project.name}.png` });

  reply = 'saved';
  await conflict.getByRole('button', { name: 'Apply my edits to the latest' }).click();
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(section.getByText('Saved folders (2) · 1 not current')).toBeVisible();
  await expect(section.getByRole('group', { name: 'Unsaved workspace setup' })).toHaveCount(0);
  // The retry repeated the lost request exactly; the rebased save is a new request.
  expect(saves[1]).toEqual(saves[0]);
  expect(saves[2]!.key).not.toBe(saves[0]!.key);
  expect(saves[2]).toMatchObject({ revision: 4, account: 'lab_account' });
  expect(saves[2]!.roots).toEqual([
    { id: thesisId, label: 'Thesis', path: '~/projects/thesis' },
    { label: 'Scratch', path: '/n/netscratch/lab/run' },
  ]);
  expect(saves).toHaveLength(3);
  expect(
    await page.evaluate(() => localStorage.getItem('dock:local:cluster-workspace')),
  ).toBeNull();
});

test('accounts need an explicit choice; typed job defaults and source review save separately', async ({
  page,
}, info) => {
  // Cached readings: a FASRC suggestion and separately timed fairshare/partition readings.
  const readings = {
    fairshareObservedAt: at(4),
    partitionsObservedAt: at(6),
    developmentSuggestion: 'Suggested for development: the accessible FASRC test partition.',
    suggestedDevelopment: {
      partition: 'test',
      qos: null,
      cpus: 2,
      memoryMb: 8192,
      timeMinutes: 120,
      idleMinutes: 20,
    },
  };
  let state = workspace({ siteRules: 'fasrc-cannon' }, readings);
  const workflow = structuredClone(state.workflow);
  await serve(page, () => state);
  const saves: ReturnType<typeof clusterWorkspaceSettingsSchema.parse>[] = [];
  await page.route('**/api/cluster/workspace/settings', async (route) => {
    const body = clusterWorkspaceSettingsSchema.parse(route.request().postDataJSON());
    saves.push(body);
    state = workspace(
      {
        revision: state.revision + 1,
        development: body.development,
        siteRules: body.siteRules,
        workflow: body.workflow,
      },
      {
        ...readings,
        ...(body.account ? { selectedAccount: body.account, accountConfirmed: true } : {}),
      },
    );
    await route.fulfill({ json: result(state) });
  });
  await page.goto('/#/work');
  const section = area(page);
  await section.getByText(/Account and job defaults/).click();
  await expect(section.getByText('no partition', { exact: false })).toBeVisible();
  await expect(section.getByText('Slurm default account:')).toContainText('lab_account');
  await expect(section.getByText(/Choose the account for development jobs\./)).toBeVisible();
  await expect(
    section.getByText(/Fairshare \(read 4 min ago\) is a priority factor, not remaining capacity/),
  ).toBeVisible();
  await expect(section.getByText(/Partitions read 6 min ago/)).toBeVisible();
  await expect(section.getByText(/need a partition before one can start/)).toBeVisible();
  for (const radio of await section.getByRole('radio').all()) await expect(radio).not.toBeChecked();
  await expect(section.getByLabel('Site preset')).toHaveValue('fasrc-cannon');
  // The suggestion only fills the editable draft; nothing is saved until Save.
  await section.getByRole('button', { name: 'Use suggested defaults' }).click();
  await expect(section.getByLabel('Partition')).toHaveValue('test');
  await expect(section.getByRole('button', { name: 'Use suggested defaults' })).toHaveCount(0);
  await expect(section.getByRole('group', { name: 'Unsaved workspace setup' })).toContainText(
    'Unsaved: job defaults',
  );
  expect(saves).toHaveLength(0);
  await section.getByLabel('Partition').fill('shared');
  await section.getByLabel('QOS').fill('normal');
  await section.getByLabel('CPUs').fill('4');
  await section.getByLabel('Time limit (minutes)').fill('9999');
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(section.getByRole('alert')).toHaveText(
    'Time limit (minutes): enter a whole number from 1 to 720.',
  );
  expect(saves).toHaveLength(0);
  await section.getByLabel('Time limit (minutes)').fill('240');
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(section.getByText(/4 CPU, 8 GB, 4 h/)).toBeVisible();
  // Saving defaults is not an account approval.
  expect(saves[0]).toMatchObject({
    account: null,
    siteRules: 'fasrc-cannon',
    development: {
      partition: 'shared',
      qos: 'normal',
      cpus: 4,
      memoryMb: 8192,
      timeMinutes: 240,
      idleMinutes: 20,
    },
  });

  await section.getByRole('radio', { name: /institute_account/ }).check();
  await section.getByLabel('Site preset').selectOption({ label: 'None' });
  // Source-change review belongs to project configuration, not SSH setup.
  await expect(section.getByRole('checkbox')).toHaveCount(0);
  const unsaved = section.getByRole('group', { name: 'Unsaved workspace setup' });
  await expect(unsaved).toContainText('site preset');
  await expect(unsaved).toContainText('agent jobs on hpc will use institute_account');
  expect(await noOverflow(page)).toBe(true);
  const small = await section.evaluate((element) =>
    [...element.querySelectorAll('button, select, input:not([type=radio], [type=checkbox])')]
      .filter((control) => control.getClientRects().length)
      .filter((control) => control.getBoundingClientRect().height < 43.5)
      .map((control) => control.outerHTML.slice(0, 80)),
  );
  expect(small).toEqual([]);
  await mkdir(shots, { recursive: true });
  await section.getByText('Account for agent jobs').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/accounts-${info.project.name}.png` });
  await unsaved.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/defaults-${info.project.name}.png` });
  await unsaved.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(section.getByText('institute_account', { exact: true }).first()).toBeVisible();
  await expect(unsaved).toHaveCount(0);
  expect(saves[1]).toMatchObject({
    revision: 4,
    account: 'institute_account',
    siteRules: null,
  });
  // The saved workflow passes through unchanged; this setup never edits it.
  expect(saves.map((save) => save.workflow)).toEqual([workflow, workflow]);
});

test('a confirmed account stays chosen offline while the failed reading shows separately', async ({
  page,
}) => {
  let state = workspace(
    { connected: false, connectionId: null },
    {
      accounts: [{ name: 'institute_account', fairShare: null }],
      selectedAccount: 'lab_account',
      accountConfirmed: true,
      error: 'sacctmgr: error: Unable to contact the accounting daemon.',
    },
  );
  await serve(page, () => state);
  const saves: ReturnType<typeof clusterWorkspaceSettingsSchema.parse>[] = [];
  await page.route('**/api/cluster/workspace/settings', async (route) => {
    const body = clusterWorkspaceSettingsSchema.parse(route.request().postDataJSON());
    saves.push(body);
    state = { ...state, revision: state.revision + 1, development: body.development };
    await route.fulfill({ json: result(state) });
  });
  await page.goto('/#/work');
  const section = area(page);
  await expect(section.getByText('Workspace not connected', { exact: true })).toBeVisible();
  await section.getByText(/Account and job defaults · lab_account/).click();
  await expect(section.getByText('Confirmed:')).toContainText('lab_account');
  await expect(section.getByRole('radio', { name: /lab_account/ })).toBeChecked();
  await expect(section.getByText('saved choice · not in the latest account reading')).toBeVisible();
  await expect(section.getByRole('radio', { name: /institute_account/ })).toBeDisabled();
  await expect(section.getByText('fairshare not current')).toBeVisible();
  await expect(
    section.getByText(/Not connected now\. A\s+confirmed account is kept/),
  ).toBeVisible();
  await expect(
    section.getByText('Unable to contact the accounting daemon.', { exact: false }),
  ).toBeVisible();
  await section.getByLabel('CPUs').fill('4');
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(section.getByRole('group', { name: 'Unsaved workspace setup' })).toHaveCount(0);
  expect(saves.map(({ account, development }) => ({ account, cpus: development.cpus }))).toEqual([
    { account: 'lab_account', cpus: 4 },
  ]);
});

test('folder listings stay honest after a reconnect and refresh only on request', async ({
  page,
}) => {
  const roots = [
    thesis({ connectionId: earlier }),
    {
      id: randomUUID(),
      label: 'Simulations',
      path: '/n/holylabs/lab/sims',
      index: {
        state: 'truncated',
        observedAt: at(2),
        connectionId: current,
        canonicalPath: '/n/holylabs/lab/sims',
        error: null,
        entries: [entry('runs', 'directory')],
        omitted: 1200,
      },
    },
    {
      id: randomUUID(),
      label: 'Archive',
      path: '~/archive',
      index: {
        state: 'error',
        observedAt: at(2),
        connectionId: current,
        canonicalPath: null,
        error: 'Permission denied while listing this folder.',
        entries: [],
        omitted: 0,
      },
    },
  ];
  let state = workspace({ roots });
  await serve(page, () => state);
  const refreshes: unknown[] = [];
  await page.route('**/api/cluster/workspace/refresh', async (route) => {
    refreshes.push(clusterWorkspaceRefreshSchema.parse(route.request().postDataJSON()));
    state = workspace({
      roots: roots.map((root) => ({
        ...root,
        index: { ...root.index, state: 'ready', connectionId: current, error: null, omitted: 0 },
      })),
    });
    await route.fulfill({ json: result(state) });
  });
  await page.goto('/#/work');
  const section = area(page);
  await section.getByText('Saved folders (3) · 3 not current').click();
  await expect(section.getByText('From an earlier connection')).toBeVisible();
  await expect(section.getByText('Partly listed')).toBeVisible();
  await expect(section.getByText(/at least 1,200 more not listed/)).toBeVisible();
  await expect(section.getByText('Permission denied while listing this folder.')).toBeVisible();
  expect(refreshes).toHaveLength(0);
  await section.getByRole('button', { name: 'Refresh folder details' }).click();
  await expect(section.getByText('Saved folders (3) · listed')).toBeVisible();
  await expect(section.getByText('Listed', { exact: true })).toHaveCount(3);
  expect(refreshes).toEqual([{ key: expect.any(String), alias: 'hpc' }]);
});
