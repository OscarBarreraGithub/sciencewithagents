import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const shots = fileURLToPath(
  new URL('../../../../../../screenshots/slurm-review-port/', import.meta.url),
);
import {
  clusterStatusSchema,
  defaultSlurmSubmissionPolicy,
  slurmPolicySaveSchema,
  slurmOwnerDecisionSchema,
  slurmReviewSchema,
  slurmReviewStatusSchema,
} from '@dock/shared';
const at = () => new Date().toISOString();
const sha = 'a'.repeat(64);
const review = () =>
  slurmReviewSchema.parse({
    id: randomUUID(),
    requestKey: randomUUID(),
    origin: 'server',
    projectId: randomUUID(),
    subject: { kind: 'cluster', id: randomUUID(), name: 'Thesis development' },
    verification: 'exact',
    agentId: null,
    helperId: null,
    attempt: 1,
    proposal: {
      command: 'salloc --account=lab_account',
      location: 'ssh',
      sshAlias: 'hpc',
      workingDirectory: null,
      invocations: [
        {
          kind: 'salloc',
          arguments: ['--account=lab_account'],
          scriptArguments: [],
          script: {
            path: null,
            source: 'none',
            sha256: null,
            bytes: null,
            content: null,
            unavailableReason: null,
          },
          requested: {
            account: 'lab_account',
            partition: null,
            qos: null,
            time: null,
            cpusPerTask: null,
            ntasks: null,
            nodes: null,
            memory: null,
            memoryPerCpu: null,
            gpus: null,
            array: null,
            jobName: null,
          },
          opaque: false,
        },
      ],
      truncated: false,
      purpose: 'Development',
    },
    hashes: { content: sha, command: sha, policy: sha, subject: sha, evidence: sha },
    policyScope: 'global',
    policyRevision: 2,
    evidence: {
      state: 'stale',
      observedAt: at(),
      ageSeconds: 4000,
      cluster: 'cannon',
      message: 'Native reading is too old.',
    },
    reviewer: null,
    status: 'completed',
    disposition: 'approve',
    assessment: {
      disposition: 'approve',
      summary: 'Earlier review approved.',
      findings: [],
      suggestedCorrection: null,
      uncertainty: '',
      evidenceUsed: [],
    },
    hostFindings: [
      {
        severity: 'warning',
        rule: 'Owner account',
        detail: 'Confirm the requested account.',
        evidence: 'Saved policy',
      },
    ],
    ownerDecision: null,
    failure: null,
    allowsSubmission: false,
    validity: {
      state: 'evidence_unavailable',
      message: 'Fresh native evidence is required before submission.',
    },
    message: 'Earlier review is retained.',
    usage: null,
    createdAt: at(),
    updatedAt: at(),
    completedAt: at(),
    approvalExpiresAt: at(),
    notifiedAt: null,
  });
async function serve(page: Page, emptyCatalogs = false) {
  const section = { observedAt: at(), error: null, items: [], omitted: 0 };
  const cluster = clusterStatusSchema.parse({
    configured: true,
    settings: { enabled: true, alias: 'hpc', label: 'Lab cluster', accountingDays: 3 },
    revision: 1,
    connection: {
      state: 'connected',
      master: 'running',
      checkedAt: at(),
      connectedAt: at(),
      message: 'Connected.',
    },
    scheduler: { version: '26', cluster: 'cannon' },
    queue: { ...section, priority: [] },
    fairshare: section,
    limits: { ...section, accounts: [], qos: [], partitions: [], site: null },
    recent: section,
    tracked: [],
    unavailable: [],
    refreshing: false,
    nextRefreshAt: null,
    stale: false,
    notice: '',
  });
  const state = slurmReviewStatusSchema.parse({
    policy: { ...defaultSlurmSubmissionPolicy, revision: 2, confirmedAccount: 'lab_account' },
    siteRuleSets: [
      {
        id: 'fasrc-cannon',
        title: 'FASRC Cannon',
        retrievedAt: '2026-10-06',
        sources: ['https://docs.rc.fas.harvard.edu/'],
        origin: 'bundled',
      },
    ],
    reviews: [review()],
    notice: '',
  });
  const mutations: string[] = [];
  const catalogs = { available: !emptyCatalogs, status: null as unknown };
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.method() !== 'HEAD') mutations.push(new URL(r.url()).pathname);
  });
  await page.route('**/api/cluster', (route) => route.fulfill({ json: cluster }));
  await page.route('**/api/slurm-review', (route) => route.fulfill({ json: state }));
  await page.route('**/api/model-policy', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    value.catalogs = catalogs.available
      ? [
          {
            provider: 'claude',
            observedAt: at(),
            error: null,
            models: [
              {
                id: 'claude-sonnet-current',
                label: 'Claude Sonnet',
                isDefault: true,
                efforts: ['high'],
              },
            ],
          },
          {
            provider: 'codex',
            observedAt: at(),
            error: null,
            models: [
              { id: 'terra-current', label: 'Terra', isDefault: true, efforts: ['high', 'xhigh'] },
            ],
          },
        ]
      : [];
    catalogs.status = value;
    await route.fulfill({ json: value });
  });
  return { state, mutations, catalogs, cluster };
}
const area = (page: Page) => page.getByRole('region', { name: 'Slurm submission review' });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

test('compact review shows stale approval honestly; explicit model/rules save and owner decision use typed receipts', async ({
  page,
}, info) => {
  const f = await serve(page);
  const saves: unknown[] = [];
  const decisions: unknown[] = [];
  await page.route('**/api/slurm-review/policy', (route) => {
    expect(route.request().method()).toBe('PUT');
    const body = slurmPolicySaveSchema.parse(route.request().postDataJSON());
    expect(body.scope).toBe('global');
    saves.push(body);
    f.state.policy = { ...body.policy!, revision: body.expectedRevision + 1 };
    return route.fulfill({ json: f.state.policy });
  });
  await page.route('**/api/slurm-review/reviews/*/decision', (route) => {
    const body = slurmOwnerDecisionSchema.parse(route.request().postDataJSON());
    decisions.push(body);
    const row = f.state.reviews[0]!;
    row.ownerDecision = {
      decision: body.decision === 'retry' ? 'reject' : body.decision,
      note: body.note,
      withoutCurrentEvidence: body.withoutCurrentEvidence,
      decidedAt: at(),
    };
    return route.fulfill({ json: row });
  });
  await page.goto('/#/work');
  await expect(area(page)).toContainText('Latest sonnet');
  expect(f.mutations).toEqual([]);
  await mkdir(shots, { recursive: true });
  await area(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/compact-${info.project.name}.png` });
  await area(page).getByText('Recent submissions (1)', { exact: true }).click();
  await expect(area(page)).toContainText('Fresh native evidence is required');
  await expect(area(page)).not.toContainText('Allowed to submit now');
  await area(page).getByText('Reviewer and lab rules', { exact: true }).click();
  await expect(area(page).getByLabel('Review new Slurm submissions')).not.toBeChecked();
  await area(page)
    .getByRole('combobox', { name: 'Reviewer model', exact: true })
    .selectOption('codex:terra-current');
  await area(page).getByRole('combobox', { name: 'Reasoning', exact: true }).selectOption('xhigh');
  await area(page)
    .getByLabel('Lab rules', { exact: true })
    .fill('Use test for short development work.');
  await area(page).getByLabel('Default account', { exact: true }).fill('fixture_lab');
  await area(page)
    .getByRole('combobox', { name: 'Site rules', exact: true })
    .selectOption('fasrc-cannon');
  await area(page).getByLabel('Review new Slurm submissions').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/settings-${info.project.name}.png` });
  await area(page).getByRole('button', { name: 'Save review settings' }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({
    policy: {
      enabled: false,
      confirmedAccount: 'fixture_lab',
      siteRules: 'fasrc-cannon',
      reviewer: { provider: 'codex', model: 'terra-current', effort: 'xhigh' },
    },
  });
  await area(page).getByText('Evidence and owner decision', { exact: true }).click();
  await expect(area(page)).toContainText('Confirm the requested account.');
  await expect(
    area(page).getByLabel('Approve without current matching evidence'),
  ).not.toBeChecked();
  await area(page).getByRole('button', { name: 'Reject', exact: true }).click();
  await expect.poll(() => decisions.length).toBe(1);
  expect(decisions[0]).toMatchObject({ decision: 'reject', withoutCurrentEvidence: false });
  expect(f.mutations.every((p) => p.includes('/slurm-review/'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(shots, { recursive: true });
  await area(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${shots}/${info.project.name}.png`,
    fullPage: false,
  });
});

test('empty cached model choices refresh explicitly and preserve saved selection and draft through a failure', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Catalog refresh routing does not depend on layout.');
  const f = await serve(page, true);
  f.state.policy.reviewer = {
    provider: 'codex',
    family: 'terra',
    model: 'saved-pin',
    effort: null,
  };
  const refreshes: unknown[] = [],
    saves: unknown[] = [];
  await page.route('**/api/model-policy/catalogs', (route) => {
    expect(route.request().method()).toBe('POST');
    refreshes.push(route.request().postDataJSON());
    if (refreshes.length === 1)
      return route.fulfill({ status: 503, json: { error: 'Catalog temporarily unavailable.' } });
    f.catalogs.available = true;
    return route.fulfill({ json: f.catalogs.status });
  });
  await page.route('**/api/slurm-review/policy', (route) => {
    const body = slurmPolicySaveSchema.parse(route.request().postDataJSON());
    saves.push(body);
    f.state.policy = { ...body.policy!, revision: body.expectedRevision + 1 };
    return route.fulfill({ json: f.state.policy });
  });
  await page.goto('/#/work');
  await area(page).getByText('Reviewer and lab rules', { exact: true }).click();
  const models = area(page).getByRole('combobox', { name: 'Reviewer model', exact: true });
  await expect(models).toHaveValue('codex:saved-pin');
  await expect(models.locator('option')).toHaveCount(2);
  expect(refreshes).toEqual([]);
  await area(page).getByLabel('Lab rules', { exact: true }).fill('Keep this draft.');
  await area(page).getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(area(page).getByRole('alert')).toContainText(
    'Your saved choice and edits are retained',
  );
  await expect(models).toHaveValue('codex:saved-pin');
  await expect(area(page).getByRole('textbox', { name: 'Lab rules', exact: true })).toHaveValue(
    'Keep this draft.',
  );
  await area(page).getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(models.locator('option[value="codex:terra-current"]')).toHaveCount(1);
  await expect(models).toHaveValue('codex:saved-pin');
  await models.selectOption('codex:terra-current');
  await area(page).getByRole('button', { name: 'Save review settings' }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({
    policy: {
      enabled: false,
      labRules: 'Keep this draft.',
      reviewer: { provider: 'codex', model: 'terra-current' },
    },
  });
  expect(refreshes).toEqual([{}, {}]);
  expect(
    f.mutations.every((path) =>
      ['/api/model-policy/catalogs', '/api/slurm-review/policy'].includes(path),
    ),
  ).toBe(true);
});

test('unknown policy save survives reload with its exact body and key; revision conflict retains edits and current account', async ({
  page,
}) => {
  const f = await serve(page);
  const requests: unknown[] = [];
  let fail = true;
  await page.route('**/api/slurm-review/policy', (route) => {
    const body = slurmPolicySaveSchema.parse(route.request().postDataJSON());
    requests.push(body);
    if (fail)
      return route.fulfill({ status: 502, json: { error: 'Connection lost before receipt.' } });
    if (body.expectedRevision !== f.state.policy.revision)
      return route.fulfill({ status: 409, json: { error: 'Policy changed.' } });
    f.state.policy = { ...body.policy!, revision: body.expectedRevision + 1 };
    return route.fulfill({ json: f.state.policy });
  });
  await page.goto('/#/work');
  await area(page).getByText('Reviewer and lab rules', { exact: true }).click();
  await area(page).getByLabel('Lab rules').fill('Retained rules');
  await area(page).getByRole('button', { name: 'Save review settings' }).click();
  await expect(area(page).getByRole('button', { name: 'Retry same change' })).toBeVisible();
  await page.reload();
  await area(page).getByText('Reviewer and lab rules', { exact: true }).click();
  await expect(area(page).getByLabel('Lab rules')).toHaveValue('Retained rules');
  fail = false;
  f.state.policy = { ...f.state.policy, revision: 3, confirmedAccount: 'new_confirmed_lab' };
  await area(page).getByRole('button', { name: 'Retry same change' }).click();
  await expect(
    area(page).getByRole('button', { name: 'Use current policy and retain edits' }),
  ).toBeVisible();
  expect(requests[1]).toEqual(requests[0]);
  await area(page).getByRole('button', { name: 'Use current policy and retain edits' }).click();
  await expect(area(page).getByLabel('Lab rules')).toHaveValue('Retained rules');
  await area(page).getByRole('button', { name: 'Save review settings' }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toMatchObject({
    expectedRevision: 3,
    policy: { labRules: 'Retained rules', confirmedAccount: 'new_confirmed_lab' },
  });
});

test('partial reviewer draft survives reload and cannot save until account and numeric fields are corrected', async ({
  page,
}) => {
  const f = await serve(page);
  const requests: unknown[] = [];
  await page.route('**/api/slurm-review/policy', (route) => {
    const body = slurmPolicySaveSchema.parse(route.request().postDataJSON());
    requests.push(body);
    f.state.policy = { ...body.policy!, revision: body.expectedRevision + 1 };
    return route.fulfill({ json: f.state.policy });
  });
  await page.goto('/#/work');
  await area(page).getByText('Reviewer and lab rules', { exact: true }).click();
  await area(page).getByLabel('Lab rules').fill('Keep my edited lab rules.');
  await area(page).getByLabel('Default account', { exact: true }).fill('not valid yet!');
  await area(page)
    .getByRole('combobox', { name: 'Reviewer model', exact: true })
    .selectOption('codex:terra-current');
  await area(page).getByText('Resource limits and validity', { exact: true }).click();
  await area(page).getByLabel('Approval lasts (minutes)').fill('');
  await area(page).getByLabel('Allowed partitions', { exact: true }).fill('not valid yet!');
  await page.reload();
  await area(page).getByText('Reviewer and lab rules', { exact: true }).click();
  await area(page).getByText('Resource limits and validity', { exact: true }).click();
  await expect(area(page).getByLabel('Lab rules')).toHaveValue('Keep my edited lab rules.');
  await expect(area(page).getByLabel('Default account', { exact: true })).toHaveValue(
    'not valid yet!',
  );
  await expect(
    area(page).getByRole('combobox', { name: 'Reviewer model', exact: true }),
  ).toHaveValue('codex:terra-current');
  await expect(area(page).getByLabel('Approval lasts (minutes)')).toHaveValue('');
  await expect(area(page).getByLabel('Allowed partitions', { exact: true })).toHaveValue(
    'not valid yet!',
  );
  await area(page).getByRole('button', { name: 'Save review settings' }).click();
  await expect(area(page)).toContainText('Check the model, rules and numeric limits');
  expect(requests).toEqual([]);
  await area(page).getByLabel('Default account', { exact: true }).fill('fixture_lab');
  await area(page).getByLabel('Approval lasts (minutes)').fill('60');
  await area(page).getByLabel('Allowed partitions', { exact: true }).fill('test');
  await area(page).getByRole('button', { name: 'Save review settings' }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    policy: {
      labRules: 'Keep my edited lab rules.',
      confirmedAccount: 'fixture_lab',
      approvalValidMinutes: 60,
      allowedPartitions: ['test'],
    },
  });
});

test('review switches on only after an explicit owner choice and unsupported service stays hidden', async ({
  page,
}) => {
  const f = await serve(page);
  const saves: unknown[] = [];
  await page.route('**/api/slurm-review/policy', (route) => {
    const body = slurmPolicySaveSchema.parse(route.request().postDataJSON());
    saves.push(body);
    f.state.policy = { ...body.policy!, revision: body.expectedRevision + 1 };
    return route.fulfill({ json: f.state.policy });
  });
  await page.goto('/#/work');
  await expect(area(page).getByRole('status')).toHaveText('Off');
  await expect(area(page).getByLabel('Default account')).toBeHidden();
  await area(page).getByText('Reviewer and lab rules', { exact: true }).click();
  await area(page).getByLabel('Review new Slurm submissions').check();
  await area(page).getByRole('button', { name: 'Save review settings' }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({ policy: { enabled: true } });
  // Settle the save-triggered status read before replacing its route and navigating.
  await expect(area(page).locator('header [role="status"]')).toHaveText('On');
  let reads = 0;
  let available = false;
  await page.route('**/api/slurm-review', (route) => {
    reads++;
    return available
      ? route.fulfill({ json: f.state })
      : route.fulfill({ status: 404, json: { error: 'Unknown route.' } });
  });
  await page.reload();
  await expect.poll(() => reads).toBe(1);
  await expect(area(page)).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await page.waitForTimeout(100);
  expect(reads).toBe(1);
  // A supported reconnect/reload must rediscover capability instead of retaining the 404.
  available = true;
  await page.reload();
  await expect(area(page).getByRole('status')).toHaveText('On');
  expect(reads).toBe(2);
});

test('an unsupported controller does not suppress review discovery on another computer', async ({
  page,
}) => {
  const f = await serve(page);
  let unsupportedReads = 0;
  await page.route('**/api/slurm-review', (route) => {
    unsupportedReads++;
    return route.fulfill({ status: 404, json: { error: 'Unknown route.' } });
  });
  await page.goto('/#/work');
  await expect.poll(() => unsupportedReads).toBe(1);
  await expect(area(page)).toHaveCount(0);
  const computer = randomUUID();
  const prefix = `/api/hosts/${computer}/proxy`;
  let selectedReads = 0;
  await page.route(`**${prefix}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice(prefix.length);
    if (path === '/slurm-review') {
      selectedReads++;
      return route.fulfill({ json: f.state });
    }
    if (path === '/cluster') return route.fulfill({ json: f.cluster });
    url.pathname = '/api' + path;
    return route.fulfill({ response: await route.fetch({ url: url.toString() }) });
  });
  // Computer selection is document-pinned; its supported UI action saves and reloads.
  await page.evaluate((id) => localStorage.setItem('dock:host', id), computer);
  await page.reload();
  await expect(area(page).getByRole('status')).toHaveText('Off');
  expect(selectedReads).toBe(1);
  expect(unsupportedReads).toBe(1);
});

test('a failed browser receipt save stays visible and prevents policy writes', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Browser storage failure does not depend on layout.');
  const f = await serve(page);
  await page.goto('/#/work');
  await area(page).getByText('Reviewer and lab rules', { exact: true }).click();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith(':slurm-review-edit'))
        throw new DOMException('Fixture storage unavailable', 'SecurityError');
      return original.call(this, key, value);
    };
  });
  await area(page).getByLabel('Lab rules').fill('Retain this change');
  await expect(area(page).getByRole('alert')).toContainText(
    'This browser could not save the change',
  );
  await expect(area(page).getByRole('button', { name: 'Save review settings' })).toBeDisabled();
  expect(f.mutations).toEqual([]);
});
