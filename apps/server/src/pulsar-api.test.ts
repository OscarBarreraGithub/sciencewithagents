import { managerTool } from './manager-lease.fixture.js';
import { modelFixture } from './model-policy.fixture.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { parseCapacity } from './capacity.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'swa-pulsar-api-')),
    store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(root, 'Fixture', '');
  const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 2 });
  const app = await createServer(store, runtime, { port: 4330, ownsRuntime: false });
  cleanups.push(async () => {
    await app.close();
    await runtime.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const post = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: { host: '127.0.0.1:4330', origin: 'http://127.0.0.1:4330' },
    });
  const get = (url: string) => app.inject({ url, headers: { host: '127.0.0.1:4330' } });
  return { root, store, project, runtime, app, post, get };
}
it('retains one transcription and control receipt and rejects command injection or hostile origins', async () => {
  const { store, runtime, app, post, get } = await fixture();
  const body = {
    key: randomUUID(),
    url: 'https://youtu.be/abcdefghijk',
    resources: { priority: 'background' },
  };
  const first = await post('/api/local-jobs', body);
  expect(first.statusCode).toBe(200);
  expect((await post('/api/local-jobs', body)).json().id).toBe(first.json().id);
  expect((await get('/api/local-jobs')).json().jobs).toHaveLength(1);
  const control = { key: randomUUID(), jobId: first.json().id, action: 'pause' };
  expect((await post('/api/local-jobs/control', control)).statusCode).toBe(200);
  expect((await post('/api/local-jobs/control', control)).statusCode).toBe(200);
  expect((await get('/api/local-jobs')).json().jobs[0].status).toBe('paused');
  expect(runtime.localJobs.reservations()).toEqual([]);
  expect(
    (await post('/api/local-jobs', { ...body, key: randomUUID(), binary: '/bin/sh' })).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/local-jobs',
        payload: body,
        headers: { host: '127.0.0.1:4330', origin: 'https://evil.invalid' },
      })
    ).statusCode,
  ).toBe(403);
  expect(store.runs()).toHaveLength(0);
});
it('gives both providers the same cached usage and bounds manager schedule authority to its own task', async () => {
  const { store, project, runtime, get, post, root } = await fixture();
  for (const provider of ['codex', 'claude'] as const)
    store.setSetting(
      `capacity:v1:${provider}`,
      parseCapacity(
        provider,
        [
          {
            provider,
            source: 'oauth',
            usage: {
              updatedAt: new Date().toISOString(),
              primary: { usedPercent: 12, windowMinutes: 300 },
            },
          },
        ],
        Date.now(),
      ),
    );
  const owner = store.agent(project.managerId);
  const other = store.addAgent({
    projectId: project.id,
    parentId: null,
    taskId: null,
    role: 'manager',
    name: 'Claude manager',
    cwd: root,
    provider: 'claude',
  });
  const a = await managerTool(runtime, owner.id, randomUUID(), 'dock_inspect', { capacity: true });
  const b = await managerTool(runtime, other.id, randomUUID(), 'dock_inspect', { capacity: true });
  expect(a).toEqual(b);
  expect(JSON.stringify(a)).toContain('12');
  expect((await get('/api/capacity')).json().providers).toHaveLength(2);
  const task = store.addTask(project.id, {
    title: 'Small job',
    goal: 'Work',
    acceptance: 'Done',
    parentId: null,
  });
  await expect(
    managerTool(runtime, other.id, randomUUID(), 'dock_schedule', {
      taskId: task.id,
      estimate: { priority: 'background' },
    }),
  ).rejects.toThrow();
  await managerTool(runtime, owner.id, randomUUID(), 'dock_schedule', {
    taskId: task.id,
    estimate: { priority: 'background', tokenBudget: 12345 },
  });
  expect(store.task(task.id).scheduling.tokenBudget).toBe(12345);
  expect(
    (
      await post('/api/pulsar/policy', {
        key: randomUUID(),
        policy: { enabled: true, claudeConcurrent: 1 },
      })
    ).statusCode,
  ).toBe(200);
  expect((await get('/api/pulsar')).json().policy.enabled).toBe(true);
  expect(store.runs().filter((r) => r.status !== 'completed')).toHaveLength(0);
});
