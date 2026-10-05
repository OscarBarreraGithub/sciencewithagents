import { expect, test, type Page } from '@playwright/test';
import { snapshotSchema, pulsarStatusSchema, jobEstimateSchema } from '@dock/shared';

async function fixture(page: Page) {
  const snapshot = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const queue = pulsarStatusSchema.parse(await (await page.request.get('/api/pulsar')).json());
  const coordinator = await (await page.request.get('/api/quark/coordinator')).json();
  const project = snapshot.projects.find((p) => !p.internal)!;
  const task = snapshot.tasks.find((t) => t.projectId === project.id)!;
  task.status = 'done';
  task.hasReviewedChanges = false;
  snapshot.tasks = [task];
  for (const agent of snapshot.agents) agent.status = 'idle';
  const job = {
    runId: crypto.randomUUID(),
    agentId: project.managerId,
    taskId: task.id,
    projectName: project.name,
    agentName: 'Idle manager',
    provider: 'codex' as const,
    status: 'queued',
    estimate: jobEstimateSchema.parse({ quotaPercent: 1 }),
    held: false,
    override: false,
    reason: 'This turn would exceed the remaining allowance budget and stopping buffer.',
    eligible: false,
    budgetBlock: { kind: 'allowance' as const, targetId: task.id },
    expectedFinishAt: null,
    tokensCharged: 0,
    tokenBasis: 'none' as const,
  };
  queue.jobs = [job];
  queue.history = [];
  coordinator.agentId = null;
  coordinator.queue = queue;
  coordinator.localJobs = [];
  coordinator.accounting.holds = [];
  coordinator.accounting.budgets = [
    {
      id: crypto.randomUUID(),
      projectId: project.id,
      taskId: task.id,
      provider: 'codex',
      windowId: 'primary',
      limitPercent: 0.5,
      revision: 0,
      createdAt: new Date().toISOString(),
      startSequence: 0,
      source: 'owner',
      spentPercent: 0,
      reservedPercent: 0,
      remainingPercent: 0.5,
      reason: null,
    },
  ];
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  // This fixture tests budget attention only. Other persistence journeys keep
  // genuine human requests in the shared demo database across viewport runs.
  await page.route('**/api/work-items', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/pulsar', (route) => route.fulfill({ json: queue }));
  await page.route('**/api/quark/coordinator', (route) => route.fulfill({ json: coordinator }));
  return { snapshot, queue, coordinator };
}

test('queued budgets need attention with an idle manager and jump to the QUARK cap card', async ({
  page,
}) => {
  const { snapshot, queue } = await fixture(page);
  const job = queue.jobs.find((j) => j.budgetBlock)!;
  const project = snapshot.projects.find((p) => p.managerId === job.agentId)!;
  expect(snapshot.agents.find((a) => a.id === project.managerId)?.status).toBe('idle');
  expect(job.budgetBlock?.kind).toBe('allowance');
  let starts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && /coordinator\/start|\/messages|\/resume/.test(r.url())) starts++;
  });
  await page.goto('/#/home');
  const panel = page.getByRole('region', { name: 'For your attention', exact: true });
  const link = panel.getByRole('link', { name: /Budget needs attention/ });
  await expect(link).toHaveAttribute('href', `#/work/${job.budgetBlock!.targetId}`);
  await expect(panel).not.toContainText('Nothing needs you');
  await link.click();
  const card = page.locator(`#quark-task-${job.taskId}`);
  await expect(card).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Paused / needs input', exact: true }),
  ).toContainText('Keep drafts across reloads');
  await expect(card.getByRole('slider')).toBeVisible();
  expect(starts).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('only typed budget refusals appear; failed queue reads cannot say nothing needs you', async ({
  page,
}) => {
  const { queue } = await fixture(page);
  const job = queue.jobs.find((j) => j.budgetBlock)!;
  let mode: 'budget' | 'waiting' | 'manual' | 'failed' | 'recovered' = 'budget';
  await page.route('**/api/pulsar', (route) => {
    if (mode === 'failed')
      return route.fulfill({ status: 503, json: { error: 'Isolated read failure' } });
    const jobs =
      mode === 'budget'
        ? [job, { ...job, runId: crypto.randomUUID() }]
        : mode === 'recovered'
          ? []
          : [
              {
                ...job,
                budgetBlock: undefined,
                held: mode === 'manual',
                reason: 'Budget word in an ordinary wait is not classification.',
              },
            ];
    return route.fulfill({ json: { ...queue, jobs } });
  });
  await page.goto('/#/home');
  const panel = page.getByRole('region', { name: 'For your attention', exact: true });
  await expect(panel.getByRole('link', { name: /Budget needs attention/ })).toHaveCount(1);
  for (const next of ['waiting', 'manual', 'recovered'] as const) {
    mode = next;
    await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
    await expect(panel.getByRole('link', { name: /Budget needs attention/ })).toHaveCount(0);
    await expect(panel).toContainText('Nothing needs you');
  }
  mode = 'failed';
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(panel).not.toContainText('Nothing needs you');
  await expect(panel).toContainText('Requests will appear when the computer reconnects.');
  mode = 'budget';
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(panel.getByRole('link', { name: /Budget needs attention/ })).toHaveCount(1);
});

test('a project budget refusal jumps to its project cap card', async ({ page }) => {
  const { snapshot: state, queue, coordinator } = await fixture(page);
  const job = queue.jobs.find((j) => j.budgetBlock)!;
  const project = state.projects.find((p) => p.managerId === job.agentId)!;
  const projectJob = { ...job, budgetBlock: { kind: 'allowance', targetId: project.id } };
  coordinator.queue.jobs = [projectJob];
  coordinator.accounting.budgets[0].taskId = null;
  await page.route('**/api/pulsar', (route) =>
    route.fulfill({ json: { ...queue, jobs: [projectJob] } }),
  );
  await page.route('**/api/quark/coordinator', (route) => route.fulfill({ json: coordinator }));
  await page.goto('/#/home');
  const link = page
    .getByRole('region', { name: 'For your attention', exact: true })
    .getByRole('link', { name: /Budget needs attention/ });
  await expect(link).toHaveAttribute('href', `#/work/${project.id}`);
  await link.click();
  const windowLabel =
    coordinator.capacity
      .find((provider: { provider: string }) => provider.provider === 'codex')
      ?.windows.find((window: { id: string }) => window.id === 'primary')?.label ??
    coordinator.accounting.windows.find(
      (window: { provider: string; windowId: string }) =>
        window.provider === 'codex' && window.windowId === 'primary',
    )?.label ??
    'Saved allowance';
  await expect(
    page
      .locator(`#quark-project-${project.id}`)
      .getByRole('slider', { name: `Codex · ${windowLabel} spending limit`, exact: true }),
  ).toBeVisible();
});
