import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { jobEstimateSchema, pulsarStatusSchema } from '@dock/shared';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { repoRoot } from './paths.js';
import { parseCapacity } from './capacity.js';
import { modelFixture } from './model-policy.fixture.js';

let root: string, store: Store, runtime: Runtime, app: FastifyInstance;
const headers = { host: '127.0.0.1:4371', origin: 'http://127.0.0.1:4371' };
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/11-budget-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  const status = runtime.capacity.status.bind(runtime.capacity);
  vi.spyOn(runtime.capacity, 'status').mockImplementation(() => ({
    ...status(),
    machine: {
      observedAt: new Date().toISOString(),
      cpuCount: 8,
      cpuUsedPercent: 10,
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryAvailableBytes: 8 * 1024 ** 3,
      diskAvailableBytes: 100 * 1024 ** 3,
      loadPerCore: 0.1,
    },
  }));
  app = await createServer(store, runtime, { port: 4371, demo: true });
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const project = store.register(root, 'Idle manager project', '');
  const task = store.addTask(project.id, {
    title: 'First bounded task',
    goal: 'One outcome',
    acceptance: 'Evidence',
    parentId: null,
    scheduling: jobEstimateSchema.parse({
      expectedTokens: 1000,
      tokenBudget: 500,
      quotaPercent: 1,
    }),
  });
  const worker = store.addAgent({
    projectId: project.id,
    parentId: project.managerId,
    taskId: task.id,
    role: 'researcher',
    name: 'Completed worker',
    cwd: root,
    provider: 'codex',
  });
  store.updateAgent(worker.id, { status: 'idle' });
  store.updateTask(task.id, { status: 'done' });
  const run = store.enqueue(
    project.managerId,
    randomUUID(),
    'Saved worker completion',
    'message',
    worker.id,
  );
  store.updateAgent(project.managerId, { status: 'idle' });
  const now = Date.now();
  store.setSetting(
    'capacity:v1:codex',
    parseCapacity(
      'codex',
      [
        {
          provider: 'codex',
          source: 'oauth',
          usage: {
            updatedAt: new Date(now).toISOString(),
            primary: {
              usedPercent: 10,
              windowMinutes: 300,
              resetsAt: new Date(now + 3600000).toISOString(),
            },
          },
        },
      ],
      now,
    ),
  );
  return { project, task, run };
}
async function jobs() {
  const response = await app.inject({ url: '/api/pulsar', headers });
  expect(response.statusCode).toBe(200);
  return pulsarStatusSchema.parse(response.json()).jobs;
}
it('does not ask the owner for a raw-token increase before delivering a worker report', async () => {
  const f = fixture();
  runtime.pulsar.savePolicy({
    key: randomUUID(),
    policy: { ...runtime.pulsar.policy(), enabled: true },
  });
  expect(store.agent(f.project.managerId).status).toBe('idle');
  expect((await jobs())[0]).toMatchObject({
    status: 'queued',
    eligible: true,
    taskId: f.task.id,
  });
  expect(runtime.quark.holds()).toHaveLength(0);
  expect((await jobs())[0].budgetBlock).toBeUndefined();
  expect(store.run(f.run.id).status).toBe('queued');
});
it.each(['task', 'project', 'ancestor'] as const)(
  'routes a typed %s allowance refusal to the actual budget card',
  async (scope) => {
    const f = fixture();
    const ancestor =
      scope === 'ancestor'
        ? store.addTask(f.project.id, {
            title: 'Parent budget',
            goal: 'One',
            acceptance: 'Evidence',
            parentId: null,
          })
        : null;
    if (ancestor) store.updateTask(f.task.id, { parentId: ancestor.id });
    const target = scope === 'project' ? null : (ancestor?.id ?? f.task.id);
    runtime.quark.saveBudget({
      key: randomUUID(),
      projectId: f.project.id,
      taskId: target,
      provider: 'codex',
      windowId: 'primary',
      limitPercent: 0.5,
    });
    expect((await jobs())[0]).toMatchObject({
      eligible: false,
      budgetBlock: { kind: 'allowance', targetId: target ?? f.project.id },
    });
    expect(runtime.quark.holds()).toHaveLength(0);
  },
);
it('distinguishes failed and missing readings and explicit project/manual queue pauses from owner budget requests', async () => {
  const f = fixture();
  store.updateTask(f.task.id, { scheduling: { ...f.task.scheduling, tokenBudget: 5000 } });
  runtime.pulsar.savePolicy({
    key: randomUUID(),
    policy: { ...runtime.pulsar.policy(), enabled: true },
  });
  const good = store.getSetting('capacity:v1:codex') as object;
  for (const reading of [
    null,
    { ...good, state: 'error', stale: true },
    { ...good, observedAt: new Date(Date.now() - 180001).toISOString() },
  ]) {
    store.setSetting('capacity:v1:codex', reading);
    expect((await jobs())[0].budgetBlock).toBeUndefined();
  }
  store.setSetting('capacity:v1:codex', good);
  runtime.pulsar.control({ key: randomUUID(), runId: f.run.id, action: 'hold' });
  expect((await jobs())[0]).toMatchObject({ held: true, eligible: false });
  expect((await jobs())[0].budgetBlock).toBeUndefined();
  store.setSetting(`quark:project:${f.project.id}`, { paused: true });
  expect((await jobs())[0].budgetBlock).toBeUndefined();
});
