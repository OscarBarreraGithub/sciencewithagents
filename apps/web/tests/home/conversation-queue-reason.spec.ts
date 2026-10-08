import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { detailSchema, snapshotSchema, type Agent } from '@dock/shared';

async function fixture(page: Page) {
  const snapshot = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = snapshot.projects.find((p) => !p.internal)!;
  const agent = snapshot.agents.find((a) => a.id === project.managerId)!;
  const detail = detailSchema.parse(
    await (await page.request.get(`/api/agents/${agent.id}`)).json(),
  );
  let status: Agent['status'] = 'queued';
  await page.route('**/api/snapshot', (route) => {
    agent.status = status;
    return route.fulfill({ json: snapshot });
  });
  await page.route(new RegExp(`/api/agents/${agent.id}(?:\\?.*)?$`), (route) =>
    route.fulfill({ json: { ...detail, agent: { ...agent, status }, runs: [] } }),
  );
  const item = (explanation: string, createdAt: string) => ({
    id: randomUUID(),
    agentId: agent.id,
    projectId: project.id,
    projectName: project.name,
    agentName: agent.name,
    status: 'queued',
    createdAt,
    explanation,
  });
  return { agent, snapshot, detail, item, setStatus: (value: Agent['status']) => (status = value) };
}

test('queued chat shows its first saved hold, recovers failed reads and removes waits when work ends', async ({
  page,
}, info) => {
  const f = await fixture(page);
  let reason = 'This allowance grant is paused. The owner must explicitly continue saved work.';
  let failed = false;
  let reads = 0;
  let starts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/messages|\/resume|coordinator\/start/.test(r.url())) starts++;
  });
  await page.route('**/api/scheduler', (route) => {
    reads++;
    if (failed)
      return route.fulfill({ status: 503, json: { error: 'Fixture queue read failure' } });
    return route.fulfill({
      json: {
        settings: { paused: false, maxConcurrent: 4 },
        items: [
          { ...f.item('Another agent is waiting.', '2026-10-05T00:00:00Z'), agentId: randomUUID() },
          f.item('A later message must not supply this label.', '2026-10-05T02:00:00Z'),
          f.item(reason, '2026-10-05T01:00:00Z'),
        ],
      },
    });
  });
  await page.goto(`/#/chat/${f.agent.id}`);
  const status = page.locator('.conversation .thinking');
  await expect(status).toHaveText(reason);
  await expect(status).not.toContainText('Waiting for an available slot');
  expect(await status.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('queued-hold.png') });
  failed = true;
  await expect(status).toHaveText('Queued · reconnecting…');
  await expect(status).not.toContainText(reason);
  reason =
    'A native terminal controls this agent or task. Return it to chat to release queued work.';
  failed = false;
  await expect(status).toHaveText(reason);
  await page.reload();
  await expect(status).toHaveText(reason);
  f.setStatus('running');
  await expect(status).toHaveText(`${f.agent.name.replace(/ manager$/i, '')} is working`, {
    timeout: 10_000,
  });
  const afterStart = reads;
  // A later conversation refresh is enough to observe the completed state.
  f.setStatus('idle');
  await expect(status).toHaveCount(0, { timeout: 10_000 });
  expect(reads).toBe(afterStart);
  expect(starts).toBe(0);
});

test('an old in-flight queue read cannot replace the next conversation reason', async ({
  page,
}) => {
  const f = await fixture(page);
  const other = f.snapshot.agents.find((a) => a.id !== f.agent.id)!;
  other.status = 'queued';
  await page.route(`**/api/agents/${other.id}`, (route) =>
    route.fulfill({ json: { ...f.detail, agent: other, runs: [] } }),
  );
  let release!: () => void;
  let started!: () => void;
  const delayed = new Promise<void>((resolve) => (release = resolve));
  const firstRead = new Promise<void>((resolve) => (started = resolve));
  let reads = 0;
  await page.route('**/api/scheduler', async (route) => {
    const first = ++reads === 1;
    if (first) {
      started();
      await delayed;
    }
    const row = f.item(
      first ? 'Old conversation hold.' : 'Current conversation hold.',
      new Date().toISOString(),
    );
    if (!first) row.agentId = other.id;
    // The first fetch is deliberately aborted when its conversation unmounts.
    await route
      .fulfill({ json: { settings: { paused: false, maxConcurrent: 4 }, items: [row] } })
      .catch(() => {});
  });
  await page.goto(`/#/chat/${f.agent.id}`);
  await firstRead;
  await expect(page.locator('.conversation .thinking')).toHaveText('Queued');
  await page.evaluate((id) => (location.hash = `#/chat/${id}`), other.id);
  const status = page.locator('.conversation .thinking');
  await expect(status).toHaveText('Current conversation hold.');
  release();
  await expect.poll(() => reads).toBeGreaterThan(2);
  await expect(status).toHaveText('Current conversation hold.');
  await expect(status).not.toContainText('Old conversation hold.');
});
