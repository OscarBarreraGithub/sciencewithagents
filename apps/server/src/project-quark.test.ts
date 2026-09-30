import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { proxyPath } from './hosts.js';
import { parseCapacity } from './capacity.js';

let root: string, store: Store, runtime: Runtime, app: FastifyInstance, projectId: string;
const headers = { host: '127.0.0.1:4999', origin: 'http://127.0.0.1:4999' };
const url = () => `/api/projects/${projectId}/quark`;
const post = (payload: object) => app.inject({ method: 'POST', url: url(), headers, payload });
async function open() {
  store = new Store(join(root, 'dock.sqlite'));
  runtime = new Runtime(
    store,
    root,
    'never-launch-a-real-provider',
    async () => new DemoProvider(),
  );
  vi.spyOn(runtime, 'kick').mockImplementation(() => {});
  vi.spyOn(runtime.modelPolicy, 'catalog').mockRejectedValue(new Error('No account needed'));
  app = await createServer(store, runtime, { port: 4999 });
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'swa-project-priority-'));
  await open();
  projectId = store.register(join(root, 'project'), 'Priority fixture', '').id;
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

it('reads inherited policy and exposes only the exact typed project routes without starting a model', async () => {
  const head = store.head;
  const response = await app.inject({ url: url(), headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    revision: 0,
    priority: null,
    weight: 1,
    paused: false,
    instruction: '',
  });
  expect(store.head).toBe(head);
  for (const method of ['GET', 'POST'])
    expect(proxyPath(method, `/projects/${projectId}/quark`)).toBe(
      `/api/projects/${projectId}/quark`,
    );
  expect(proxyPath('POST', `/projects/${projectId}/quark/override`)).toBeNull();
  expect(
    (await app.inject({ url: `/api/projects/${randomUUID()}/quark`, headers })).statusCode,
  ).toBe(404);
  expect((await app.inject({ url: '/api/projects/not-an-id/quark', headers })).statusCode).toBe(
    400,
  );
  expect(store.runs()).toHaveLength(0);
  expect(runtime.modelPolicy.catalog).not.toHaveBeenCalled();
});

it('saves one durable owner decision, retries after restart, and refuses stale or conflicting changes', async () => {
  store.setSetting(`quark:project:${projectId}`, {
    revision: 3,
    weight: 6,
    paused: true,
    instruction: 'Retain the owner’s pause.',
  });
  const input = { key: randomUUID(), expectedRevision: 3, priority: 'high' };
  const [first, duplicate] = await Promise.all([post(input), post(input)]);
  expect(first.statusCode).toBe(200);
  expect(duplicate.json()).toEqual(first.json());
  expect(first.json()).toEqual({
    revision: 4,
    priority: 'high',
    weight: 6,
    paused: true,
    instruction: 'Retain the owner’s pause.',
  });
  expect(store.events().filter((event) => event.type === 'quark.decision')).toHaveLength(1);
  expect(runtime.coordinator.status().decisions[0]).toMatchObject({
    source: 'owner',
    action: { projectId, priority: 'high' },
  });
  expect(runtime.coordinator.identity()).toBeNull();
  expect(runtime.pulsar.policy().enabled).toBe(false);
  await app.close();
  await open();
  const head = store.head;
  expect((await post(input)).json()).toEqual(first.json());
  expect(store.head).toBe(head);
  expect((await post({ ...input, priority: 'background' })).statusCode).toBe(409);
  expect((await post({ ...input, key: randomUUID() })).statusCode).toBe(409);
  const updates = await Promise.all([
    post({ key: randomUUID(), expectedRevision: 4, priority: 'background' }),
    post({ key: randomUUID(), expectedRevision: 4, priority: 'normal' }),
  ]);
  expect(updates.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  const cleared = await post({ key: randomUUID(), expectedRevision: 5, priority: null });
  expect(cleared.json()).toMatchObject({ revision: 6, priority: null, paused: true, weight: 6 });
  expect((await post(input)).json()).toEqual(first.json()); // Replay cannot roll back newer choices.
  expect((await app.inject({ url: url(), headers })).json()).toEqual(cleared.json());
  for (const invalid of [
    { key: randomUUID(), expectedRevision: 6 },
    { key: randomUUID(), expectedRevision: 6, priority: 'interactive' },
    { key: randomUUID(), expectedRevision: 6, priority: 'normal', paused: false },
  ])
    expect((await post(invalid)).statusCode).toBe(400);
  expect(store.runs()).toHaveLength(0);
  expect(runtime.modelPolicy.catalog).not.toHaveBeenCalled();
});

it('keeps live reservations, saved caps and original accounting when priority changes', async () => {
  const now = Date.now();
  const capacity = parseCapacity(
    'codex',
    [
      {
        provider: 'codex',
        source: 'oauth',
        usage: {
          updatedAt: new Date(now).toISOString(),
          secondary: {
            usedPercent: 10,
            windowMinutes: 10080,
            resetsAt: new Date(now + 86400_000).toISOString(),
          },
        },
      },
    ],
    now,
  );
  store.setSetting('capacity:v1:codex', capacity);
  runtime.quark.saveBudget({
    key: randomUUID(),
    projectId,
    provider: 'codex',
    windowId: capacity.windows[0]!.id,
    expectedRevision: 0,
    limitPercent: 10,
  });
  const run = store.enqueue(
    store.project(projectId).managerId,
    randomUUID(),
    'Existing work',
    'report',
  );
  expect(runtime.pulsar.reserve(run, new Set())).toBe(true);
  runtime.quark.begin(run);
  store.updateRun(run.id, { status: 'running' });
  const leases = store.db.prepare('SELECT * FROM pulsar_leases').all();
  const accounting = runtime.quark.runs(true);
  const budgets = runtime.quark.budgets();
  expect(
    (await post({ key: randomUUID(), expectedRevision: 0, priority: 'background' })).statusCode,
  ).toBe(200);
  expect(store.db.prepare('SELECT * FROM pulsar_leases').all()).toEqual(leases);
  expect(runtime.quark.runs(true)).toEqual(accounting);
  expect(runtime.quark.budgets()).toEqual(budgets);
  expect(store.run(run.id).status).toBe('running');
  expect(runtime.pulsar.estimate(store.run(run.id)).priority).toBe('normal');
});
