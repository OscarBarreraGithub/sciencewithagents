import { expect, test, type Page } from '@playwright/test';
import { jobDetailSchema, jobEstimateSchema, type JobDetail } from '@dock/shared';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

// Saved-job browser fixtures only. Control POSTs never reach a provider or owner database.
async function fixture(page: Page) {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const worker = snapshot.agents.find(
    (agent: { role: string; parentId: string | null }) =>
      agent.role === 'manager' && !agent.parentId,
  );
  const runId = randomUUID();
  const now = new Date().toISOString();
  const state: JobDetail = jobDetailSchema.parse({
    job: {
      runId,
      agentId: worker.id,
      taskId: randomUUID(),
      projectName: 'Scientific research',
      agentName: 'Research manager',
      provider: 'codex',
      status: 'completed',
      estimate: jobEstimateSchema.parse({ expectedTokens: 4000, expectedSeconds: 120 }),
      held: false,
      override: false,
      eligible: false,
      reason: 'Turn completed. History and original conversation are retained.',
      expectedFinishAt: null,
      tokensCharged: 3200,
      tokenBasis: 'measured',
    },
    projectId: worker.projectId,
    kind: 'delegation',
    request: {
      text: 'Compare the observed calibration with the saved uncertainty.',
      truncated: false,
    },
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    worker: {
      role: 'manager',
      status: 'idle',
      model: 'Recorded native model',
      modelBasis: 'admission',
    },
    task: {
      id: randomUUID(),
      title: 'Verify calibration uncertainty',
      status: 'review',
      goal: { text: 'Check the calibration against saved observations.', truncated: false },
      acceptance: {
        text: 'Show the comparison and identify any unresolved discrepancy.',
        truncated: false,
      },
      review: { text: 'The measured comparison is ready for review.', truncated: false },
      closure: null,
    },
    queueHold: null,
    approval: null,
    outcome: [
      {
        id: randomUUID(),
        kind: 'assistant',
        title: 'Saved calibration result',
        text: {
          text: 'The observed uncertainty agrees with the calibration. Full evidence remains in the saved conversation.',
          truncated: false,
        },
        createdAt: now,
      },
    ],
    moreOutcome: true,
  });
  await page.route(`**/pulsar/jobs/${runId}`, async (route) => route.fulfill({ json: state }));
  await page.route('**/api/pulsar/jobs', (route) =>
    route.fulfill({ status: 500, json: { error: 'Unconfigured control fixture' } }),
  );
  return { state, worker, snapshot, runId };
}

test('saved job failure/retry shows actual older request and outcome with reachable work links', async ({
  page,
}, info) => {
  const { state, runId } = await fixture(page);
  let unavailable = true;
  await page.route(`**/pulsar/jobs/${runId}`, (route) =>
    unavailable
      ? route.fulfill({ status: 503, json: { error: 'Saved records unavailable' } })
      : route.fulfill({ json: state }),
  );
  await page.goto(`/#/job/${runId}`);
  const job = page.getByRole('region', { name: 'Saved job' });
  await expect(job.getByRole('alert')).toContainText('Could not read this saved job');
  unavailable = false;
  await job.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(job.getByRole('heading', { name: state.task!.title })).toBeVisible();
  await expect(job).toContainText(state.request.text);
  await expect(job).toContainText(state.outcome[0].text.text);
  await expect(job).toContainText('Recorded native model');
  await expect(job.getByRole('link', { name: 'Open project', exact: true })).toHaveAttribute(
    'href',
    `#/project/${state.projectId}`,
  );
  await expect(job.getByRole('link', { name: 'Open task', exact: true })).toHaveAttribute(
    'href',
    `#/task/${state.task!.id}`,
  );
  await expect(
    job.getByRole('link', { name: 'Project hourly rate and caps', exact: true }),
  ).toHaveAttribute('href', `#/work/${state.projectId}`);
  await expect(job.getByRole('button', { name: /Pause|Cancel queued/ })).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await mkdir('../../data/finish-20261005/job-detail-ui-evidence', { recursive: true });
  await page.screenshot({
    path: `../../data/finish-20261005/job-detail-ui-evidence/${info.project.name}.png`,
    fullPage: true,
  });
  await job.getByText('Task goal and acceptance', { exact: true }).click();
  await expect(job).toContainText(state.task!.acceptance.text);
  await job.getByRole('button', { name: 'Open conversation', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${state.job.agentId}$`));
});

test('queued job preserves a scheduling change receipt across a lost acknowledgement', async ({
  page,
}) => {
  const { state, runId } = await fixture(page);
  state.job.status = 'queued';
  state.job.eligible = false;
  state.job.reason = 'Waiting for a fresh computer-capacity reading.';
  state.startedAt = null;
  state.finishedAt = null;
  state.outcome = [];
  state.moreOutcome = false;
  const attempts: { key: string; runId: string; action: string }[] = [];
  await page.route('**/api/pulsar/jobs', async (route) => {
    const body = route.request().postDataJSON();
    attempts.push(body);
    state.job.held = true;
    state.job.reason = 'Paused. Release this job to let QUARK reconsider it.';
    if (attempts.length === 1) return route.abort('failed');
    return route.fulfill({ json: { saved: true } });
  });
  await page.goto(`/#/job/${runId}`);
  const job = page.getByRole('region', { name: 'Saved job' });
  await expect(job).toContainText('Waiting for a fresh computer-capacity reading.');
  await job.getByRole('button', { name: 'Pause job', exact: true }).click();
  await expect(job.getByRole('button', { name: 'Retry same change', exact: true })).toBeVisible();
  await expect(job.getByRole('button', { name: 'Cancel queued job', exact: true })).toBeDisabled();
  await job.getByRole('button', { name: 'Retry same change', exact: true }).click();
  await expect(job.getByRole('button', { name: 'Release job', exact: true })).toBeEnabled();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0]).toMatchObject({ runId, action: 'hold' });
});

test('selected-host job distinguishes editing holds and answer requests without scheduling them', async ({
  page,
}) => {
  const { state, snapshot, runId } = await fixture(page);
  const hostId = randomUUID();
  await page.addInitScript((id) => localStorage.setItem('dock:host', id), hostId);
  await page.route(`**/api/hosts/${hostId}/proxy/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.split('/proxy')[1];
    if (path === `/pulsar/jobs/${runId}`) return route.fulfill({ json: state });
    if (path === '/snapshot') return route.fulfill({ json: snapshot });
    // Forward bounded demo reads only. Writes are never forwarded by this fixture.
    if (route.request().method() !== 'GET') throw new Error('Unexpected fixture write');
    const response = await page.request.get(`/api${path}`);
    return route.fulfill({ response });
  });
  state.job.status = 'queued';
  state.job.reason = 'Held for editing. Save and queue from the conversation.';
  state.queueHold = 'editing';
  state.finishedAt = null;
  state.startedAt = null;
  await page.goto(`/#/job/${runId}`);
  const job = page.getByRole('region', { name: 'Saved job' });
  await expect(job).toContainText('Held for editing');
  await expect(job.getByRole('button', { name: 'Open queued message', exact: true })).toBeVisible();
  await expect(
    job.getByRole('button', { name: /Pause|Release|Use reserved|Cancel queued/ }),
  ).toHaveCount(0);
  state.queueHold = null;
  state.job.status = 'running';
  state.job.reason = 'Waiting for your answer in the conversation.';
  state.approval = { id: randomUUID(), title: 'Which saved calibration should I compare?' };
  await page.reload();
  await expect(job).toContainText(state.approval.title);
  await expect(
    job.getByRole('button', { name: 'Answer in conversation', exact: true }),
  ).toBeVisible();
  await expect(
    job.getByRole('button', { name: 'Pause after this turn', exact: true }),
  ).toBeVisible();
  await expect(job.getByRole('button', { name: 'Cancel queued job', exact: true })).toHaveCount(0);
});
