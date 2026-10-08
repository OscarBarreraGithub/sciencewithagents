import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { coordinationReviewReadSchema, runSchema } from '@dock/shared';
import { Store } from './store.js';
import { CoordinationReviews } from './coordination-reviews.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { materialDemand, isQuarkReport } from './quark-demand.js';
import { createServer } from './server.js';
import { parseCapacity } from './capacity.js';

let root: string,
  store: Store,
  runtime: Runtime,
  reviews: CoordinationReviews,
  manager: string,
  projectId: string,
  worker: string;
beforeEach(() => {
  mkdirSync('data/tests', { recursive: true });
  root = mkdtempSync('data/tests/coordination-review-');
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(join(root, 'project'), 'Backlog fixture', '');
  projectId = project.id;
  manager = project.managerId;
  worker = store.addAgent({
    projectId,
    parentId: manager,
    taskId: null,
    role: 'researcher',
    name: 'Retained worker',
    cwd: join(root, 'project'),
  }).id;
  runtime = new Runtime(store, root, 'fixture-only', async () => new DemoProvider());
  reviews = new CoordinationReviews(store);
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (store.db.isOpen) {
    await runtime.close();
    store.close();
  }
  rmSync(root, { recursive: true, force: true });
});
const sources = (count = 216) =>
  Array.from({ length: count }, (_, i) =>
    store.enqueue(
      manager,
      randomUUID(),
      `Original ${i}: ${'evidence '.repeat(400)}`,
      i < 123 ? 'report' : 'message',
      worker,
    ),
  );
const apply = () => {
  const preview = reviews.preview(manager);
  const input = { key: randomUUID(), expectedFingerprint: preview.fingerprint };
  return { preview, input, result: reviews.apply(manager, input) };
};

it('retains 216 unique original updates in one immutable review and a bounded paged reader across restart and receipt retries', async () => {
  const original = sources();
  for (const source of original.slice(0, 120))
    store.setSetting(`pulsar:estimate:${source.id}`, { priority: 'high', quotaPercent: 0.5 });
  store.updateAgent(manager, { status: 'interrupted', autoTurns: 100 });
  const { preview, input, result } = apply();
  expect(preview).toMatchObject({ sourceCount: 216, canCoalesce: true });
  const batch = store.run(result.batchRunId!);
  expect(batch.text.length).toBeLessThan(5000);
  expect(batch.text).toContain(batch.id);
  expect(runtime.pulsar.estimate(batch)).toMatchObject({ priority: 'high', quotaPercent: 0.5 });
  expect(store.runs(['queued']).map((r) => r.id)).toEqual([batch.id]);
  expect(store.runs(['coalesced'])).toHaveLength(216);
  expect(original.every((r) => store.run(r.id).text === r.text)).toBe(true);
  expect(store.agent(manager)).toMatchObject({ status: 'interrupted', autoTurns: 100 });
  expect(runSchema.parse(store.run(original[0]!.id)).status).toBe('coalesced');
  expect(
    store.enqueue(
      manager,
      store.run(original[0]!.id).key,
      original[0]!.text,
      original[0]!.kind,
      worker,
    ).id,
  ).toBe(original[0]!.id);
  const read = coordinationReviewReadSchema.parse({ batchRunId: batch.id });
  expect(reviews.read(projectId, read)).toMatchObject({ total: 216, nextOffset: 20 });
  expect(reviews.read(projectId, read).sources).toHaveLength(20);
  expect(reviews.read(projectId, read).sources[0]?.text.length).toBe(1024);
  expect(() =>
    store.db.prepare('DELETE FROM coordination_review_sources WHERE batch_run_id=?').run(batch.id),
  ).toThrow('retain');
  expect(() => reviews.read(randomUUID(), read)).toThrow('outside');
  expect(() => reviews.read(projectId, { ...read, sourceRunId: randomUUID() })).toThrow('belong');
  await runtime.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  reviews = new CoordinationReviews(store);
  runtime = new Runtime(store, root, 'fixture-only', async () => new DemoProvider());
  expect(reviews.apply(manager, input)).toEqual(result);
  reviews.coalescePending();
  expect(store.runs(['queued'])).toHaveLength(1);
  expect(reviews.read(projectId, { ...read, offset: 200 })).toMatchObject({
    total: 216,
    nextOffset: null,
  });
  expect(store.agent(manager)).toMatchObject({ status: 'interrupted', autoTurns: 100 });
});

it('rolls back a partial batch and rejects a stale exact preview without losing any sources', () => {
  sources();
  const before = reviews.preview(manager);
  const update = store.updateRun.bind(store);
  let n = 0;
  vi.spyOn(store, 'updateRun').mockImplementation((id, changes) => {
    if (changes.status === 'coalesced' && ++n === 50) throw new Error('simulated crash');
    return update(id, changes);
  });
  expect(() =>
    reviews.apply(manager, { key: randomUUID(), expectedFingerprint: before.fingerprint }),
  ).toThrow('simulated crash');
  expect(store.runs(['queued'])).toHaveLength(216);
  expect(store.runs(['coalesced'])).toHaveLength(0);
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM coordination_reviews').get()?.n).toBe(0);
  vi.restoreAllMocks();
  sources(1);
  expect(() =>
    reviews.apply(manager, { key: randomUUID(), expectedFingerprint: before.fingerprint }),
  ).toThrow('changed');
  expect(store.runs(['queued'])).toHaveLength(217);
});

it('does not wake stopped managers, change owner input, collapse held/scoped work, or manufacture demand', async () => {
  sources(2);
  store.updateAgent(manager, { status: 'failed', autoTurns: 100 });
  const held = store.enqueue(manager, randomUUID(), 'Held report', 'report', worker);
  const scoped = store.enqueue(manager, randomUUID(), 'Group Work lineage', 'report', worker);
  store.setSetting(`pulsar:held:${held.id}`, true);
  store.setSetting(`group:host-native-run:${scoped.id}`, {});
  expect(store.agent(manager).status).toBe('failed');
  apply();
  expect(store.agent(manager)).toMatchObject({ status: 'failed', autoTurns: 100 });
  expect(store.run(held.id).status).toBe('queued');
  expect(store.run(scoped.id).status).toBe('queued');
  expect(materialDemand(store, runtime.quark, Date.now()).get(projectId)?.runs).toEqual([]);
  const owner = store.enqueue(manager, randomUUID(), 'Owner asks a direct question');
  expect(store.agent(manager).autoTurns).toBe(0);
  expect(store.run(owner.id).text).toBe('Owner asks a direct question');
  expect(
    materialDemand(store, runtime.quark, Date.now())
      .get(projectId)
      ?.runs.map((r) => r.runId),
  ).toEqual([owner.id]);
  const old = store.run(owner.id);
  reviews.coalescePending();
  expect(store.run(owner.id)).toEqual(old);
});

it('shows one pending review with 216 updates before and after reconciliation without per-source admission decisions', () => {
  sources();
  const decision = vi.spyOn(runtime.pulsar, 'decision');
  const before = runtime.pulsar.status();
  expect(before.jobs).toHaveLength(1);
  expect(before.jobs[0]?.coordination).toEqual({ updates: 216 });
  expect(decision).toHaveBeenCalledTimes(1);
  expect(materialDemand(store, runtime.quark, Date.now()).get(projectId)?.runs).toEqual([]);
  decision.mockClear();
  apply();
  expect(runtime.pulsar.status().jobs[0]?.coordination).toEqual({ updates: 216 });
  expect(decision).toHaveBeenCalledTimes(1);
});

it('does not absorb arrivals into a queued/running receipt or repeat a coalesced QUARK notice', () => {
  sources(2);
  const coordinator = store.register(join(root, 'quark'), 'QUARK', '');
  store.setSetting('quark:coordinator:identity', {
    projectId: coordinator.id,
    agentId: coordinator.managerId,
  });
  store.enqueue(manager, randomUUID(), 'Original QUARK notice', 'report', coordinator.managerId);
  const { result } = apply();
  expect(isQuarkReport(store, store.run(result.batchRunId!))).toBe(true);
  sources(2);
  reviews.coalescePending();
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM coordination_reviews').get()?.n).toBe(1);
  expect(reviews.preview(manager)).toMatchObject({
    pendingBatchRunId: result.batchRunId,
    canCoalesce: false,
    sourceCount: 2,
  });
  store.updateRun(result.batchRunId!, { status: 'completed' });
  reviews.coalescePending();
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM coordination_reviews').get()?.n).toBe(2);
});

it('keeps an immutable held review separate from later projected updates', () => {
  sources(2);
  const { result } = apply();
  const batchId = result.batchRunId!;
  store.setSetting(`pulsar:held:${batchId}`, true);
  const later = sources(3);
  const jobs = runtime.pulsar.status().jobs;
  expect(jobs).toHaveLength(2);
  expect(jobs.find((job) => job.runId === batchId)).toMatchObject({
    held: true,
    coordination: { updates: 2 },
  });
  expect(jobs.find((job) => job.runId === later[0]!.id)).toMatchObject({
    held: false,
    coordination: { updates: 3 },
  });
  expect(reviews.preview(manager)).toMatchObject({
    pendingBatchRunId: batchId,
    sourceCount: 3,
    canCoalesce: false,
  });
});

it('offers read-only exact preview and retry-safe supported apply while the owner-paused runtime makes no model call', async () => {
  sources();
  store.updateAgent(manager, { status: 'interrupted', autoTurns: 100 });
  const before = store.runs(['queued']).map((r) => r.id);
  const app = await createServer(store, runtime, { port: 4999 });
  const request = (url: string, payload?: unknown) =>
    app.inject({
      url,
      method: payload ? 'POST' : 'GET',
      headers: { host: '127.0.0.1:4999', origin: 'http://127.0.0.1:4999' },
      ...(payload ? { payload } : {}),
    });
  try {
    const preview = (await request(`/api/agents/${manager}/coordination-review/preview`)).json();
    expect(store.runs(['queued']).map((r) => r.id)).toEqual(before);
    const input = { key: randomUUID(), expectedFingerprint: preview.fingerprint };
    const first = await request(`/api/agents/${manager}/coordination-review`, input);
    expect(first.statusCode).toBe(200);
    expect((await request(`/api/agents/${manager}/coordination-review`, input)).json()).toEqual(
      first.json(),
    );
    expect(store.agent(manager)).toMatchObject({ status: 'interrupted', autoTurns: 100 });
    expect(runtime.clients.size).toBe(0);
    const chat = (await request(`/api/agents/${manager}`)).json();
    expect(
      chat.runs.every((run: { status: string }) =>
        ['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled'].includes(
          run.status,
        ),
      ),
    ).toBe(true);
    expect(chat.entries.length).toBeGreaterThan(0);
    expect(store.runs(['coalesced'])).toHaveLength(216);
  } finally {
    await app.close();
  }
});

it('admits an owner turn ahead of a batched review, retains ordinary admission, and never bypasses the automatic-turn limit', async () => {
  sources();
  const { result } = apply();
  const batch = store.run(result.batchRunId!);
  const owner = store.enqueue(manager, randomUUID(), 'Owner first');
  store.setSetting('scheduler:settings', { paused: false, maxConcurrent: 1 });
  const internal = runtime as unknown as {
    drain(): Promise<void>;
    preparedRuns: Set<string>;
    startRun(run: typeof batch): Promise<void>;
  };
  internal.preparedRuns.add(batch.id);
  internal.preparedRuns.add(owner.id);
  const starts: string[] = [];
  vi.spyOn(internal, 'startRun').mockImplementation(async (run) => {
    starts.push(run.id);
    store.updateRun(run.id, { status: 'running' });
    store.updateAgent(manager, { status: 'running' });
  });
  await internal.drain();
  expect(starts).toEqual([owner.id]);
  expect(runtime.pulsar.lease(batch.id)).toBeNull();
  expect(runtime.pulsar.lease(owner.id)).not.toBeNull();
  await runtime.close();
  // Fresh runtime with a retained queued review and exhausted auto-turn allowance.
  store.updateRun(owner.id, { status: 'completed' });
  store.updateAgent(manager, { status: 'queued', autoTurns: 12 });
  runtime = new Runtime(store, root, 'fixture-only', async () => new DemoProvider());
  const reserve = vi.spyOn(runtime.pulsar, 'reserve');
  await (runtime as unknown as { drain(): Promise<void> }).drain();
  expect(store.agent(manager).status).toBe('waiting');
  expect(store.run(batch.id).status).toBe('queued');
  expect(reserve).not.toHaveBeenCalled();
});

it('keeps a held aggregate under ordinary QUARK admission with no lease or provider start', async () => {
  sources(2);
  const { result } = apply();
  const batch = store.run(result.batchRunId!);
  store.setSetting(`pulsar:held:${batch.id}`, true);
  store.setSetting('scheduler:settings', { paused: false, maxConcurrent: 1 });
  const internal = runtime as unknown as {
    drain(): Promise<void>;
    preparedRuns: Set<string>;
    startRun(run: typeof batch): Promise<void>;
  };
  internal.preparedRuns.add(batch.id);
  const start = vi.spyOn(internal, 'startRun');
  await internal.drain();
  expect(start).not.toHaveBeenCalled();
  expect(runtime.pulsar.lease(batch.id)).toBeNull();
  expect(store.run(batch.id).status).toBe('queued');
  expect(runtime.pulsar.decision(batch).eligible).toBe(false);
});

it('preserves owner-enabled goal continuation as real queued work outside coordination batching', () => {
  sources(2);
  const wake = store.enqueue(
    manager,
    `quark:wake:${randomUUID()}`,
    'Host scheduling notice',
    'report',
  );
  const goal = store.enqueue(
    manager,
    randomUUID(),
    'Owner-authorized goal next action',
    'report',
    manager,
  );
  store.setSetting(`managed-goal:run:${goal.id}`, randomUUID());
  apply();
  expect(store.run(goal.id).status).toBe('queued');
  expect(runtime.pulsar.status().jobs.find((j) => j.runId === wake.id)?.coordination).toEqual({
    updates: 1,
  });
  expect(
    runtime.pulsar.status().jobs.find((j) => j.runId === goal.id)?.coordination,
  ).toBeUndefined();
  expect(
    materialDemand(store, runtime.quark, Date.now())
      .get(projectId)
      ?.runs.map((r) => r.runId),
  ).toEqual([goal.id]);
});

it('projects held and specially scoped updates as separate controllable jobs', () => {
  const ordinary = sources(2);
  const held = store.enqueue(manager, randomUUID(), 'Individually held', 'report', worker);
  const group = store.enqueue(manager, randomUUID(), 'Group lineage', 'report', worker);
  const override = store.enqueue(manager, randomUUID(), 'Explicit override', 'message', worker);
  const scoped = store.enqueue(manager, randomUUID(), 'Explicit task mapping', 'report', worker);
  const goal = store.enqueue(manager, randomUUID(), 'Owner goal continuation', 'report', manager);
  const wake = store.enqueue(manager, 'quark:wake:fixture', 'Own QUARK notice', 'report');
  store.setSetting(`pulsar:held:${held.id}`, true);
  store.setSetting(`group:host-native-run:${group.id}`, {});
  store.setSetting(`pulsar:override:${override.id}`, true);
  store.setSetting(`pulsar:task:${scoped.id}`, null);
  store.setSetting(`managed-goal:run:${goal.id}`, randomUUID());
  const jobs = runtime.pulsar.status().jobs;
  expect(jobs).toHaveLength(7);
  expect(jobs.find((j) => j.runId === ordinary[0]!.id)?.coordination).toEqual({ updates: 2 });
  for (const source of [held, group, override, scoped, goal])
    expect(jobs.find((j) => j.runId === source.id)?.coordination).toBeUndefined();
  expect(jobs.find((j) => j.runId === held.id)?.held).toBe(true);
  expect(jobs.find((j) => j.runId === wake.id)?.coordination).toEqual({ updates: 1 });
  expect(reviews.preview(manager).sourceCount).toBe(2);
});

it('retains source task ancestors for caps and holds after one joint review is created', () => {
  const parent = store.addTask(projectId, {
    title: 'Parent',
    goal: 'Preserved cap',
    acceptance: 'Kept',
    parentId: null,
  });
  const child = store.addTask(projectId, {
    title: 'Child',
    goal: 'Preserved hold',
    acceptance: 'Kept',
    parentId: parent.id,
  });
  store.updateAgent(worker, { taskId: child.id });
  const original = sources(2);
  store.setSetting(`pulsar:held-task:${parent.id}`, true);
  expect(reviews.preview(manager).sourceCount).toBe(0);
  store.setSetting(`pulsar:held-task:${parent.id}`, false);
  const { result } = apply();
  const batch = store.run(result.batchRunId!);
  expect(runtime.quark.taskIds(batch)).toEqual([child.id, parent.id]);
  expect(original.every((source) => store.run(source.id).status === 'coalesced')).toBe(true);
  expect(store.task(parent.id).status).toBe('open');
  expect(store.task(child.id).status).toBe('open');
  store.setSetting(`pulsar:held-task:${parent.id}`, true);
  expect(runtime.pulsar.decision(batch).eligible).toBe(false);
  expect(runtime.pulsar.status().jobs.find((j) => j.runId === batch.id)?.held).toBe(true);
  store.setSetting(`pulsar:held-task:${parent.id}`, false);
  store.setSetting(
    'capacity:v1:codex',
    parseCapacity(
      'codex',
      [
        {
          provider: 'codex',
          source: 'oauth',
          usage: {
            updatedAt: new Date().toISOString(),
            primary: {
              usedPercent: 1,
              windowMinutes: 300,
              resetsAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          },
        },
      ],
      Date.now(),
    ),
  );
  runtime.quark.saveBudget({
    key: randomUUID(),
    projectId,
    taskId: parent.id,
    provider: 'codex',
    windowId: 'primary',
    period: 'hour',
    limitPercent: 0,
  });
  expect(runtime.quark.block(batch)?.cause).toBe('hourly');
  expect(runtime.pulsar.decision(batch).eligible).toBe(false);
});

it('does not coalesce an admitted queued input while its provider preparation is pending', () => {
  const original = sources(2);
  const admitted = store.run(original[0]!.id);
  expect(runtime.pulsar.reserve(admitted, new Set())).toBe(true);
  expect(reviews.preview(manager).sourceCount).toBe(1);
  expect(reviews.preview(manager).canCoalesce).toBe(false);
  reviews.coalescePending();
  expect(store.run(admitted.id).status).toBe('queued');
  expect(runtime.pulsar.lease(admitted.id)?.finishedAt).toBeNull();
});
