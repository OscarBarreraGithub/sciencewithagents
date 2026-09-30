import { test, expect } from '@playwright/test';
import { quarkSettingsSchema, type QuarkStatus } from '@dock/shared';
import { mkdir } from 'node:fs/promises';

const project = '10000000-0000-4000-8000-000000000001';
const agent = '10000000-0000-4000-8000-000000000002';
const run = '10000000-0000-4000-8000-000000000003';
const now = new Date().toISOString();
function initial(): QuarkStatus {
  return {
    settings: quarkSettingsSchema.parse({}),
    since: now,
    budgets: [],
    holds: [],
    runs: [],
    omittedRuns: 0,
    totals: [],
    windows: [],
    cache: [
      {
        agentId: agent,
        name: 'Literature reviewer',
        provider: 'codex',
        observedAt: now,
        estimatedExpiresAt: null,
        cachedTokens: 12400,
        nudgesToday: 0,
        state: 'Expiry is not exposed; no automatic timer configured.',
      },
    ],
    notice: 'Estimates, not billing.',
  };
}

test('usage explains a stale provider reading and its shared automatic retry without suggesting an exhausted allowance', async ({
  page,
}, info) => {
  await page.route('**/api/capacity', async (route) => {
    const body = await (await route.fetch()).json();
    const provider = body.providers.find((p: { provider: string }) => p.provider === 'claude');
    provider.stale = true;
    provider.state = 'error';
    provider.observedAt = now;
    provider.nextRefreshAt = new Date(Date.now() + 600_000).toISOString();
    provider.windows = [
      {
        id: 'primary',
        label: 'Session',
        scope: 'general',
        model: null,
        usedPercent: 19,
        windowMinutes: 300,
        resetsAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    ];
    provider.message =
      'Claude is limiting usage checks. This does not mean your model allowance is exhausted. The shared collector will retry automatically.';
    body.providers = [provider];
    await route.fulfill({ json: body });
  });
  await page.goto('/#/usage');
  const allowance = page.locator('.quark-allowances');
  await expect(allowance).toContainText('does not mean your model allowance is exhausted');
  await expect(allowance).toContainText('Last successful reading');
  await expect(allowance).toContainText('Next automatic check');
  await expect(allowance).toContainText('Refresh shares this waiting period');
  await expect(allowance).toContainText('81.0% remaining');
  await allowance.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/screenshots/quark/${info.project.name}-usage-retry.png`,
  });
});

test('QUARK budgets, pause recovery and cache settings work on phone and desktop with safe retries', async ({
  page,
}, info) => {
  let state = initial();
  const requests: object[] = [];
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    body.projects = [
      { ...body.projects[0], id: project, name: 'Research project', managerId: agent },
    ];
    body.tasks = [];
    body.agents = [];
    body.runs = [];
    await route.fulfill({ json: body });
  });
  await page.route('**/api/capacity', async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    body.providers = [
      {
        provider: 'codex',
        account: 'local-sign-in',
        label: 'Codex',
        plan: null,
        source: 'codexbar-oauth',
        observedAt: now,
        attemptedAt: now,
        nextRefreshAt: null,
        state: 'ready',
        stale: false,
        message: 'Shared reading',
        weeklyPolicy: 'reported',
        windows: [
          {
            id: 'secondary',
            label: 'Weekly',
            scope: 'general',
            model: null,
            usedPercent: 6,
            windowMinutes: 10080,
            resetsAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
          },
        ],
      },
    ];
    await route.fulfill({ json: body });
  });
  await page.route('**/api/quark', (route) => route.fulfill({ json: state }));
  await page.route('**/api/quark/budgets', (route) => {
    const payload = route.request().postDataJSON();
    requests.push(payload);
    if (requests.length === 1)
      return route.fulfill({
        status: 502,
        json: { error: 'Connection interrupted. Try saving again.' },
      });
    state = {
      ...state,
      budgets: [
        {
          id: '10000000-0000-4000-8000-000000000004',
          revision: 1,
          projectId: project,
          taskId: null,
          provider: 'codex',
          windowId: 'secondary',
          limitPercent: 10,
          createdAt: now,
          startSequence: 0,
          source: 'owner',
          spentPercent: 8,
          reservedPercent: 1,
          remainingPercent: 2,
          reason: 'Allowance budget reached its stopping buffer.',
        },
      ],
      holds: [
        {
          runId: run,
          agentId: agent,
          projectId: project,
          reason: 'Allowance budget reached its stopping buffer.',
          createdAt: now,
          cause: 'budget',
          stopAcknowledgedAt: now,
          releasedAt: null,
          lastAttemptAt: now,
          error: null,
        },
      ],
    };
    return route.fulfill({ json: state });
  });
  await page.route('**/api/quark/resume', (route) =>
    route.fulfill({ status: 409, json: { error: 'Increase the budget before continuing.' } }),
  );
  await page.route('**/api/quark/settings', (route) => {
    const body = route.request().postDataJSON();
    state = { ...state, settings: { ...body.settings, revision: body.settings.revision + 1 } };
    return route.fulfill({ json: state });
  });
  await page.goto('/#/usage');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Usage and allowances');
  await expect(page.getByText('94.0%', { exact: false })).toBeVisible();
  await page.getByLabel('Project', { exact: true }).selectOption(project);
  await page.getByLabel('Allowance', { exact: true }).selectOption('secondary');
  await page.getByLabel('Use at most (%)').fill('10');
  await page.getByRole('button', { name: 'Set budget', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Connection interrupted');
  await page.getByRole('button', { name: 'Set budget', exact: true }).click();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  await expect(page.getByRole('status')).toContainText('Budget saved');
  await page.getByRole('button', { name: 'Continue saved work' }).click();
  await expect(page.getByRole('alert')).toContainText('Increase the budget');
  await page.getByText('Context cache settings', { exact: true }).click();
  await expect(page.getByText('Expiry not exposed', { exact: true })).toBeVisible();
  await page.getByLabel('Automatically refresh eligible idle task conversations').uncheck();
  await page.getByRole('button', { name: 'Save QUARK settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('settings saved');
  expect(state.settings.cacheEnabled).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement)?.blur();
    window.scrollTo(0, 0);
  });
  await mkdir('../../data/screenshots/quark', { recursive: true });
  await page.screenshot({
    path: `../../data/screenshots/quark/${info.project.name}.png`,
    fullPage: true,
  });
});

test('reported Claude helper totals remain distinct from unknown breakdowns on every screen size', async ({
  page,
}, info) => {
  const state = initial();
  const unknown = {
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningOutputTokens: null,
  };
  state.runs = [
    {
      runId: run,
      agentId: agent,
      nativeRootId: '10000000-0000-4000-8000-000000000004',
      projectId: project,
      taskId: null,
      taskAncestors: [],
      provider: 'claude',
      model: null,
      threadId: 'native/helper',
      startedAt: now,
      finishedAt: now,
      observedAt: now,
      baseline: unknown,
      tokens: { ...unknown, totalTokens: 750, inputTokens: 100 },
      basis: 'partial',
      expectedTokens: 1000,
      expectedSeconds: 60,
      quotaPercent: 1,
      cacheNudge: false,
      agentName: 'Literature helper',
      projectName: 'Research project',
      status: 'completed',
    },
  ];
  await page.route('**/api/quark', (route) => route.fulfill({ json: state }));
  await page.goto('/#/usage');
  await page.getByText('Tokens by agent', { exact: true }).click();
  const helper = page.locator('.quark-runs details');
  await helper.locator('summary').click();
  await expect(helper.locator('summary')).toContainText('750');
  await expect(helper).toContainText('reported total · partial breakdown');
  await expect(helper).toContainText('not added again');
  await expect(
    helper
      .locator('dt')
      .filter({ hasText: /^Output$/ })
      .locator('xpath=following-sibling::dd[1]'),
  ).toHaveText('Not reported');
  await helper.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/screenshots/quark/${info.project.name}-helper-total.png`,
  });
});

test('QUARK read failures recover without starting work or hiding an empty ledger', async ({
  page,
}) => {
  let reads = 0,
    writes = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/') && r.method() === 'POST') writes++;
  });
  await page.route('**/api/quark', (route) =>
    ++reads === 1
      ? route.fulfill({ status: 503, json: { error: 'Usage ledger unavailable' } })
      : route.fulfill({ json: initial() }),
  );
  await page.goto('/#/usage');
  await expect(page.getByRole('alert')).toContainText('Usage ledger unavailable');
  await page.getByRole('button', { name: 'Retry reading' }).click();
  await expect(page.getByText('No project caps yet.', { exact: false })).toBeVisible();
  await page.getByText('Tokens by agent', { exact: true }).click();
  await expect(
    page.getByText('New agent work will appear automatically.', { exact: false }),
  ).toBeVisible();
  expect(writes).toBe(0);
});
