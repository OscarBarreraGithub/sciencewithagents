import { expect, test } from '@playwright/test';
import { pulsarJobSchema } from '@dock/shared';

test('216 retained team updates are one review, Home counts work separately, and pacing shows a plain reason with calculation in Details', async ({
  page,
}) => {
  const state = await (await page.request.get('/api/snapshot')).json();
  const coordinator = await (await page.request.get('/api/quark/coordinator')).json();
  const project = state.projects.find((p: { internal?: boolean }) => !p.internal);
  const manager = state.agents.find((a: { id: string }) => a.id === project.managerId);
  const paceAgent = {
    ...manager,
    id: crypto.randomUUID(),
    name: 'Pacing example',
    status: 'queued',
  };
  state.agents = [manager, paceAgent];
  state.tasks = [];
  const job = pulsarJobSchema.parse({
    runId: crypto.randomUUID(),
    agentId: manager.id,
    taskId: null,
    projectName: project.name,
    agentName: 'Team review example',
    provider: 'claude',
    status: 'queued',
    estimate: {},
    held: false,
    override: false,
    eligible: false,
    reason: 'The manager is stopped. Open its retained conversation to inspect progress.',
    expectedFinishAt: null,
    tokensCharged: 0,
    tokenBasis: 'none',
    coordination: { updates: 216 },
  });
  const fullPacingReason =
    'Pacing Fable weekly: it is projected to reach its reserve before the reported reset, so 3 projects with ready work share about 0.05%/hour here by weight. This project used about 0.4% in the rolling hour, including reservations. Waiting for earlier use to leave the hour or for a calmer reading. Estimate only; no cap was saved.';
  const paceJob = {
    ...job,
    runId: crypto.randomUUID(),
    agentId: paceAgent.id,
    agentName: paceAgent.name,
    reason: fullPacingReason,
    coordination: undefined,
  };
  coordinator.queue.jobs = [job, paceJob];
  coordinator.queue.history = [];
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: state }));
  await page.route('**/api/pulsar', (route) => route.fulfill({ json: coordinator.queue }));
  await page.route('**/api/quark/coordinator', (route) => route.fulfill({ json: coordinator }));
  await page.route('**/api/local-jobs', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), jobs: [] } });
  });
  let starts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /messages|coordinator\/start|resume/.test(request.url()))
      starts++;
  });
  await page.goto('/');
  await expect(
    page.getByRole('link', { name: /QUARK.*0 running · 1 queued · 216 team updates/ }),
  ).toBeVisible();
  await page.goto('/#/work');
  const review = page.locator('.quark-ticket').filter({ hasText: 'Team review example' });
  await expect(review).toHaveCount(1);
  await expect(review).toContainText('216 retained team updates for one review.');
  const paced = page.locator('.quark-ticket').filter({ hasText: 'Pacing example' });
  await expect(paced).toContainText(
    'Paused to spread Fable weekly allowance until reset. QUARK retries automatically.',
  );
  await expect(paced.getByText(fullPacingReason, { exact: true })).not.toBeVisible();
  await paced.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(paced.getByText(fullPacingReason, { exact: true })).toBeVisible();
  expect(starts).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
