import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { detailSchema, snapshotSchema, type Run } from '@dock/shared';

test('one saved owner bubble follows authoritative queued and sending run state', async ({ page }, info) => {
  const state = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = state.projects.find((value) => !value.internal)!;
  const agent = state.agents.find((value) => value.id === project.managerId)!;
  const retained = detailSchema.parse(
    await (await page.request.get(`/api/agents/${agent.id}`)).json(),
  );
  const runId = randomUUID();
  const text = 'Please keep this saved request visible while it waits.';
  let status: Run['status'] = 'queued';
  let reads = 0;
  let sends = 0;
  const createdAt = new Date().toISOString();
  await page.route('**/api/snapshot', (route) => {
    agent.status = status === 'completed' ? 'idle' : status;
    return route.fulfill({ json: state });
  });
  await page.route(new RegExp(`/api/agents/${agent.id}(?:\\?.*)?$`), (route) => {
    reads++;
    return route.fulfill({
      json: {
        ...retained,
        agent: { ...agent, status: status === 'completed' ? 'idle' : status },
        runs: [{ id: runId, agentId: agent.id, sourceId: null, text, kind: 'user', status, createdAt }],
        entries: [{
          id: runId, agentId: agent.id, runId, kind: 'user', title: 'You', text,
          // Deliberately stale: saved entry status must never decide delivery.
          status: 'complete', createdAt,
        }],
      },
    });
  });
  await page.route(`**/api/agents/${agent.id}/messages`, (route) => {
    sends++;
    return route.fulfill({ status: 500, json: { error: 'Unexpected delivery' } });
  });
  await page.goto(`/#/chat/${agent.id}`);
  const bubble = page.locator(`.message.user[data-prompt-id="${runId}"]`);
  const label = bubble.locator('.message-delivery');
  await expect(bubble).toHaveCount(1);
  await expect(bubble).toContainText(text);
  await expect(label).toHaveText('Queued');
  await expect(page.getByRole('button', { name: /^1 queued message/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('saved-owner-message-queued.png') });
  const beforeStart = reads;
  status = 'running';
  await expect.poll(() => reads, { timeout: 10_000 }).toBeGreaterThan(beforeStart);
  await expect(label).toHaveText('Sending');
  await expect(page.getByRole('button', { name: /^1 queued message/ })).toHaveCount(0);
  await expect(bubble).toHaveCount(1);
  const beforeFinish = reads;
  status = 'completed';
  await expect.poll(() => reads, { timeout: 10_000 }).toBeGreaterThan(beforeFinish);
  await expect(label).toHaveCount(0);
  await expect(bubble).toContainText(text);
  await expect(bubble).toHaveCount(1);
  expect(sends).toBe(0);
});
