import { test, expect } from './fixture';

test('usage is visible on first opening and distinguishes independent windows, stale readings and retry', async ({
  page,
}, info) => {
  const now = new Date().toISOString();
  const provider = (name: 'codex' | 'claude') => ({
    provider: name,
    account: 'local-sign-in',
    label: name === 'codex' ? 'Codex' : 'Claude',
    plan: null,
    source: 'codexbar-oauth',
    observedAt: now,
    attemptedAt: now,
    nextRefreshAt: null,
    state: 'ready',
    stale: false,
    message: 'Shared provider reading',
    weeklyPolicy: 'not-reported',
    windows: [
      {
        id: 'primary',
        label: 'Session',
        scope: 'general',
        model: null,
        usedPercent: name === 'codex' ? 22 : 38,
        windowMinutes: 300,
        resetsAt: new Date(Date.now() + 3600000).toISOString(),
      },
    ],
  });
  const state = {
    providers: [
      provider('codex'),
      {
        ...provider('claude'),
        stale: true,
        windows: [
          ...provider('claude').windows,
          {
            id: 'fable',
            label: 'Fable weekly',
            scope: 'model',
            model: 'fable',
            usedPercent: 61,
            windowMinutes: 10080,
            resetsAt: null,
          },
        ],
      },
    ],
    machine: null,
    refreshing: false,
    refreshSeconds: 60,
    notice: 'Subscription percentages are not token prices.',
  };
  let refreshes = 0;
  await page.route('**/api/capacity', (route) => route.fulfill({ json: state }));
  await page.route('**/api/capacity/refresh', (route) => {
    refreshes++;
    return refreshes === 1
      ? route.fulfill({ status: 500, json: { error: 'Connection lost' } })
      : route.fulfill({ json: state });
  });
  await page.goto('/');
  const strip = page.getByRole('button', { name: 'Usage and computer capacity', exact: true });
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('22% used');
  await expect(strip).toContainText('38% used');
  await expect(strip).toContainText('stale');
  expect(refreshes).toBe(0);
  await strip.click();
  const dialog = page.getByRole('dialog', { name: 'Usage and computer capacity' });
  await expect(dialog).toContainText('Fable weekly');
  await expect(dialog).toContainText('61% used');
  await dialog.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not refresh');
  await dialog.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-capacity.png` });
});

test('owner can pace work, change priority, hold a job and retry the same control safely', async ({
  page,
}, info) => {
  const runId = '00000000-0000-4000-8000-000000000001';
  const policy = {
    enabled: true,
    reservePercent: 20,
    claudeConcurrent: 1,
    codexConcurrent: 3,
    backgroundGapSeconds: 120,
    maxCpuPercent: 85,
    memoryReserveMb: 1024,
  };
  const estimate = {
    priority: 'background',
    expectedTokens: 12000,
    tokenBudget: 100000,
    quotaPercent: 3,
    expectedSeconds: 300,
    cpuCores: 0.25,
    memoryMb: 512,
    estimatedCostUsd: null,
    estimateNote: 'Crude estimate',
    deadline: null,
  };
  const state = {
    name: 'QUARK',
    policy,
    notice: 'Background work yields at turn boundaries.',
    jobs: [
      {
        runId,
        agentId: runId,
        taskId: null,
        projectName: 'Research',
        agentName: 'Claude worker',
        provider: 'claude',
        status: 'queued',
        estimate,
        held: false,
        override: false,
        reason: 'Waiting for shared Claude headroom.',
        eligible: false,
        expectedFinishAt: null,
        tokensCharged: 0,
        tokenBasis: 'none',
      },
    ],
  };
  const keys: string[] = [];
  let fail = true;
  let reads = 0;
  await page.route('**/api/pulsar', (route) =>
    ++reads === 1
      ? route.fulfill({ status: 500, json: { error: 'Temporary read failure' } })
      : route.fulfill({ json: state }),
  );
  await page.route('**/api/pulsar/jobs', (route) => {
    const body = route.request().postDataJSON();
    keys.push(body.key);
    if (fail) {
      fail = false;
      return route.fulfill({ status: 500, json: { error: 'Try again safely' } });
    }
    if (body.action === 'hold') state.jobs[0]!.held = true;
    if (body.action === 'configure') state.jobs[0]!.estimate = body.estimate;
    return route.fulfill({ json: state });
  });
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Work queue', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Work queue' });
  await expect(dialog.getByRole('heading', { name: 'QUARK', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Pause job', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Try again');
  await dialog.getByRole('button', { name: 'Pause job', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Release job', exact: true })).toBeVisible();
  expect(keys[0]).toBe(keys[1]);
  await dialog.getByRole('button', { name: 'Change priority or budget' }).click();
  await dialog.getByRole('combobox', { name: 'Priority', exact: true }).selectOption('interactive');
  await dialog.getByRole('button', { name: 'Save job estimate' }).click();
  await expect(dialog).toContainText('claude · interactive');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-pulsar.png` });
});
