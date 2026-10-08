import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { detailSchema, snapshotSchema, type Agent, type RunRecoveryRequest } from '@dock/shared';

async function fixture(page: Page, action: 'retry' | 'continue' = 'retry') {
  const state = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = state.projects.find((p) => !p.internal)!;
  const agent = state.agents.find((a) => a.id === project.managerId)!;
  const detail = detailSchema.parse(
    await (await page.request.get(`/api/agents/${agent.id}`)).json(),
  );
  let status: Agent['status'] = action === 'retry' ? 'failed' : 'interrupted';
  const runId = randomUUID(),
    failureId = randomUUID();
  const view = {
    runId,
    failureId,
    action,
    explanation:
      action === 'retry'
        ? 'This message was saved but never sent to the model. Retry sends the original message once.'
        : 'Saved work may already include changes. Continue inspects progress and unfinished requests before taking the next step.',
  };
  await page.route('**/api/snapshot', (route) => {
    agent.status = status;
    return route.fulfill({ json: state });
  });
  await page.route(new RegExp(`/api/agents/${agent.id}(?:\\?.*)?$`), (route) =>
    route.fulfill({
      json: {
        ...detail,
        agent: { ...agent, status },
        runs: [
          {
            id: runId,
            agentId: agent.id,
            sourceId: null,
            text: 'Original saved objective',
            kind: 'user',
            status: 'failed',
            createdAt: new Date().toISOString(),
          },
        ],
        entries: [
          {
            id: runId,
            agentId: agent.id,
            runId,
            kind: 'user',
            title: 'You',
            text: 'Original saved objective',
            status: 'complete',
            createdAt: new Date().toISOString(),
          },
          {
            id: randomUUID(),
            agentId: agent.id,
            runId,
            kind: 'system',
            title: 'Could not complete this turn',
            text: 'Claude’s sign-in check timed out. No model request was sent.',
            status: 'complete',
            createdAt: new Date().toISOString(),
          },
        ],
      },
    }),
  );
  return {
    agent,
    view,
    setStatus: (value: Agent['status']) => {
      status = value;
    },
    getStatus: () => status,
  };
}

test('visible Retry message retains a lost-ack key, avoids duplicate taps and stays in the conversation', async ({
  page,
}, info) => {
  const f = await fixture(page);
  const requests: RunRecoveryRequest[] = [];
  let release!: () => void;
  let receipt: unknown = null;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/agents/${f.agent.id}/run-recovery`, async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: f.getStatus() === 'queued' ? null : f.view });
    const input = route.request().postDataJSON() as RunRecoveryRequest;
    requests.push(input);
    receipt = {
      sourceRunId: input.runId,
      failureId: input.failureId,
      runId: randomUUID(),
      action: input.action,
    };
    if (requests.length === 1) {
      await held;
      return route.fulfill({
        status: 502,
        json: { error: 'The response was lost. Tap again to check the same request.' },
      });
    }
    f.setStatus('queued');
    return route.fulfill({ json: receipt });
  });
  await page.route(`**/api/agents/${f.agent.id}/run-recovery/receipts/*`, (route) =>
    route.fulfill({ json: receipt }),
  );
  await page.goto(`/#/chat/${f.agent.id}`);
  const recovery = page.locator('.run-recovery');
  const retry = recovery.getByRole('button', { name: 'Retry message', exact: true });
  await expect(retry).toBeVisible();
  await expect(page.getByText('Original saved objective', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Resume from history to continue', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show commands', exact: true }).click();
  await page.getByRole('button', { name: /\/resume/ }).click();
  await expect(retry).toBeFocused();
  expect(page.url()).toContain(`#/chat/${f.agent.id}`);
  expect(await recovery.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('inline-retry.png') });
  await retry.click();
  await expect(recovery.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  expect(requests).toHaveLength(1);
  release();
  await expect(recovery.getByRole('alert')).toContainText('response was lost');
  await retry.click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toMatchObject({ runId: f.view.runId, action: 'retry' });
  await expect(recovery).toHaveCount(0);
  await page.reload();
  await expect(recovery).toHaveCount(0);
  expect(requests).toHaveLength(2);
});

test('uncertain work offers Continue and recovers an unavailable recovery read without replaying input', async ({
  page,
}, info) => {
  const f = await fixture(page, 'continue');
  let unavailable = true;
  const requests: RunRecoveryRequest[] = [];
  await page.route(`**/api/agents/${f.agent.id}/run-recovery`, (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill(
        unavailable ? { status: 503, json: { error: 'Temporary read failure' } } : { json: f.view },
      );
    const input = route.request().postDataJSON() as RunRecoveryRequest;
    requests.push(input);
    f.setStatus('queued');
    return route.fulfill({
      json: {
        sourceRunId: input.runId,
        failureId: input.failureId,
        runId: randomUUID(),
        action: input.action,
      },
    });
  });
  await page.goto(`/#/chat/${f.agent.id}`);
  const recovery = page.locator('.run-recovery');
  await expect(recovery.getByRole('button', { name: 'Check recovery' })).toBeVisible();
  unavailable = false;
  await recovery.getByRole('button', { name: 'Check recovery' }).click();
  await expect(recovery.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Retry message' })).toHaveCount(0);
  await expect(recovery).toContainText('inspect');
  await page.screenshot({ path: info.outputPath('inline-continue.png') });
  await recovery.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(recovery).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ action: 'continue', runId: f.view.runId });
  expect(JSON.stringify(requests[0])).not.toContain('Original saved objective');
});
