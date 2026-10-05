import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { modelPolicySchema, projectWorkflowSchema, type WorkItem } from '@dock/shared';
import { managerTool } from './manager-lease.fixture.js';
import { modelFixture } from './model-policy.fixture.js';
import { repoRoot } from './paths.js';
import { Pulsar } from './pulsar.js';
import { Runtime } from './runtime.js';
import { Conflict, Store, type PrivateRun } from './store.js';
import { registerWorkItemRoutes, WorkItems } from './work-items.js';
import { git } from './workspaces.js';

let root: string, store: Store, items: WorkItems, projectId: string, managerId: string;
let app: FastifyInstance | undefined, runtime: Runtime | undefined;
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/owner-tickets-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(join(root, 'project'), 'Owner project', '', 'codex');
  projectId = project.id;
  managerId = project.managerId;
  items = new WorkItems(store);
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
});
afterEach(async () => {
  await app?.close();
  await runtime?.close();
  app = undefined;
  runtime = undefined;
  vi.restoreAllMocks();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
function todo(title = 'Compare the measurements', detail = 'Use the retained source dataset.') {
  return items.save({ key: randomUUID(), projectId, title, detail });
}
function request(selected: WorkItem[], priority = 3, estimatedCompute = 3) {
  return {
    key: randomUUID(),
    projectId,
    items: selected.map(({ id, revision }) => ({ id, expectedRevision: revision })),
    title: 'A bounded comparison',
    brief: 'Preserve the scientific assumptions.',
    acceptance: 'Report the comparison with reproducible evidence.',
    priority,
    estimatedCompute,
  };
}
function restart() {
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  items = new WorkItems(store);
}

it('packages several source snapshots into one durable worker ticket without a manager turn', () => {
  const first = todo(),
    second = todo('Write the uncertainty table', 'Retain every sample.');
  const input = request([first, second], 5, 2);
  const result = items.ticket(input);
  expect(result.task).toMatchObject({
    projectId,
    managerId,
    status: 'working',
    ownerTicket: {
      priority: 5,
      estimatedCompute: 2,
      sourceItems: [
        { id: first.id, revision: 1, title: first.title },
        { id: second.id, revision: 1, title: second.title },
      ],
    },
  });
  for (const source of [first, second]) {
    expect(result.task.goal).toContain(source.title);
    expect(result.task.goal).toContain(source.detail);
    expect(items.get(source.id)).toMatchObject({
      taskId: result.task.id,
      ownerTicketId: result.task.ownerTicket!.id,
      projectId,
      managerId,
      revision: 2,
      status: 'in_progress',
    });
  }
  expect(store.runs()).toHaveLength(1);
  expect(store.runs().filter((run) => run.agentId === managerId)).toHaveLength(0);
  expect(store.agent(result.workerId)).toMatchObject({
    role: 'implementer',
    parentId: managerId,
    taskId: result.task.id,
    provider: 'codex',
    modelSelection: 'policy',
    toolPolicy: 'native',
  });
  expect(store.run(result.runId)).toMatchObject({ status: 'queued', kind: 'delegation' });
  expect(store.run(result.runId).text).toContain(result.task.acceptance);
  const head = store.head;
  restart();
  expect(items.ticket(input)).toEqual(result);
  expect(store.head).toBe(head);
  expect(store.tasks()).toHaveLength(1);
  expect(() => items.ticket({ ...input, title: 'Changed after lost reply' })).toThrow(Conflict);
  expect(() => items.ticket({ ...input, key: randomUUID() })).toThrow('changed');
  expect(store.runs()).toHaveLength(1);
});

it('rejects stale, completed, idea, foreign and duplicate selections atomically', () => {
  const idea = items.save({
    key: randomUUID(),
    projectId,
    kind: 'idea',
    title: 'Try a new method',
  });
  const other = store.register(join(root, 'other'), 'Other project', '', 'codex');
  const foreign = items.save({ key: randomUUID(), projectId: other.id, title: 'Foreign outcome' });
  const completed = items.save({
    key: randomUUID(),
    projectId,
    title: 'Finished outcome',
    status: 'done',
  });
  const stale = todo();
  items.save({ key: randomUUID(), id: stale.id, expectedRevision: 1, detail: 'New evidence' });
  const valid = todo('Keep this selected outcome intact');
  for (const invalid of [idea, foreign, completed, stale]) {
    const before = store.head;
    expect(() => items.ticket(request([valid, invalid]))).toThrow(Conflict);
    expect(store.head).toBe(before);
    expect(items.get(valid.id)).toEqual(valid);
  }
  expect(() => items.ticket(request([valid, valid]))).toThrow(ZodError);
  expect(store.tasks()).toHaveLength(0);
  expect(store.runs()).toHaveLength(0);
  expect(() =>
    items.saveForManager(managerId, { key: randomUUID(), kind: 'idea', title: 'Claim an idea' }),
  ).toThrow(ZodError);
});

it('keeps Ideas, completion and Undo across restart and preserves queued source bindings', () => {
  const idea = items.save({
    key: randomUUID(),
    kind: 'idea',
    title: 'An unscoped idea',
    detail: 'Keep this on seed or cancel.',
  });
  const actionable = items.save({
    key: randomUUID(),
    id: idea.id,
    expectedRevision: 1,
    kind: 'general',
  });
  const ticket = items.ticket(request([actionable]));
  const linked = items.get(idea.id);
  const done = items.save({
    key: randomUUID(),
    id: linked.id,
    expectedRevision: linked.revision,
    status: 'done',
  });
  restart();
  expect(items.list({ projectId }).items).toContainEqual(done);
  expect(items.page(projectId).items).toEqual([]);
  expect(items.page(projectId, { includeDone: true }).items).toContainEqual(done);
  const undo = items.save({
    key: randomUUID(),
    id: done.id,
    expectedRevision: done.revision,
    status: 'in_progress',
  });
  expect(undo).toMatchObject({
    status: 'in_progress',
    resolvedAt: null,
    taskId: ticket.task.id,
    ownerTicketId: ticket.task.ownerTicket!.id,
  });
  expect(() =>
    items.save({ key: randomUUID(), id: undo.id, expectedRevision: undo.revision, taskId: null }),
  ).toThrow('binding');
  expect(() =>
    items.save({ key: randomUUID(), id: undo.id, expectedRevision: undo.revision, kind: 'idea' }),
  ).toThrow('binding');
  expect(store.runs()).toHaveLength(1);
  restart();
  expect(items.get(undo.id)).toEqual(undo);
});

it('honors the project provider ceiling and rejects oversized packages before durable writes', () => {
  const selected = todo();
  const policy = modelPolicySchema.parse(store.getSetting('model-policy'));
  store.setSetting(
    `project-workflow:${projectId}`,
    projectWorkflowSchema.parse({ providerMix: 'claude-only' }),
  );
  store.setSetting('model-policy', { ...policy, enabledProviders: ['codex'] });
  expect(() => items.ticket(request([selected]))).toThrow('enabled worker provider');
  expect(store.tasks()).toHaveLength(0);
  expect(items.get(selected.id)).toEqual(selected);
  store.setSetting(
    `project-workflow:${projectId}`,
    projectWorkflowSchema.parse({ providerMix: 'codex-only' }),
  );
  const oversized = Array.from({ length: 4 }, (_, n) =>
    todo(`Large source ${n}`, 'x'.repeat(8000)),
  );
  expect(() => items.ticket(request(oversized))).toThrow(ZodError);
  expect(store.tasks()).toHaveLength(0);
  expect(store.runs()).toHaveLength(0);
});

it.each([false, true])(
  'orders background tickets by owner ratings and age while foreground wins (pacing %s)',
  (enabled) => {
    const clock = Date.now();
    const pulsar = new Pulsar(
      store,
      () => null,
      () => clock,
    );
    pulsar.savePolicy({ key: randomUUID(), policy: { ...pulsar.policy(), enabled } });
    const enqueue = (priority: number, compute: number, hoursOld = 0) => {
      const result = items.ticket(request([todo()], priority, compute));
      return store.updateRun(result.runId, {
        createdAt: new Date(clock - hoursOld * 3600_000).toISOString(),
      });
    };
    const low = enqueue(1, 3),
      high = enqueue(5, 3);
    expect(pulsar.ordered([low, high]).map((run) => run.id)).toEqual([high.id, low.id]);
    const expensive = enqueue(3, 5),
      small = enqueue(3, 1);
    expect(pulsar.ordered([expensive, small]).map((run) => run.id)).toEqual([
      small.id,
      expensive.id,
    ]);
    const fresh = enqueue(4, 3),
      old = enqueue(3, 3, 24);
    expect(pulsar.ordered([fresh, old]).map((run) => run.id)).toEqual([old.id, fresh.id]);
    const oldestHigh = enqueue(5, 1, 240);
    store.setSetting(`quark:project:${projectId}`, { priority: 'high' });
    const foreground = store.enqueue(managerId, randomUUID(), 'Direct owner message');
    expect(pulsar.estimate(oldestHigh).priority).toBe('background');
    expect(pulsar.ordered([oldestHigh, foreground]).map((run) => run.id)).toEqual([
      foreground.id,
      oldestHigh.id,
    ]);
  },
);

it('retries the direct HTTP enqueue receipt without duplicating its task or worker', async () => {
  const input = request([todo()]);
  app = Fastify();
  const kick = vi.fn();
  registerWorkItemRoutes(app, items, kick);
  const first = await app.inject({
    method: 'POST',
    url: '/api/work-items/tickets',
    payload: input,
  });
  expect(first.statusCode).toBe(201);
  const retry = await app.inject({
    method: 'POST',
    url: '/api/work-items/tickets',
    payload: input,
  });
  expect(retry.statusCode).toBe(201);
  expect(retry.json()).toEqual(first.json());
  expect(store.tasks()).toHaveLength(1);
  expect(store.runs()).toHaveLength(1);
  expect(kick).toHaveBeenCalledTimes(2);
});

it('prepares the central model and isolated task worktree before launch and retains existing review guards', async () => {
  const projectRoot = store.project(projectId).root;
  mkdirSync(projectRoot, { recursive: true });
  await git(projectRoot, ['init', '-q']);
  await git(projectRoot, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'Owned fixture',
  ]);
  store.setSetting(
    `project-workflow:${projectId}`,
    projectWorkflowSchema.parse({
      applyChanges: 'human',
      reviewLimit: 'ask-human',
      overrides: {
        research: { provider: 'codex', family: 'sol', model: 'demo', effort: 'medium' },
      },
    }),
  );
  const factory = vi.fn(async () => {
    throw new Error('No native provider may start in this check.');
  });
  runtime = new Runtime(store, join(root, 'runtime'), 'never-launch-provider', factory);
  vi.spyOn(runtime.modelPolicy, 'catalog').mockResolvedValue([
    { id: 'demo', label: 'Demo · no model calls', isDefault: true, efforts: ['medium'] },
  ]);
  vi.spyOn(runtime.coordinator, 'tick').mockImplementation(() => {});
  const result = items.ticket(request([todo()]));
  const started: string[] = [];
  vi.spyOn(
    runtime as unknown as { startRun(run: PrivateRun): Promise<void> },
    'startRun',
  ).mockImplementation(async (run) => {
    const worker = store.agent(run.agentId),
      task = store.task(result.task.id);
    expect(worker.cwd).toBe(task.worktree);
    expect(worker.cwd).not.toBe(projectRoot);
    expect(worker.assignment).toMatchObject({
      provider: 'codex',
      model: 'demo',
      taskClass: 'reasoning',
    });
    expect(store.getSetting(`model-policy:run:${run.id}`)).toMatchObject({ model: 'demo' });
    expect(await git(worker.cwd, ['rev-parse', 'HEAD'])).toBe(task.baseCommit);
    started.push(run.id);
    store.updateRun(run.id, { status: 'completed' });
    store.updateAgent(worker.id, { status: 'idle' });
  });
  store.setSetting('scheduler:settings', { paused: false, maxConcurrent: 4 });
  runtime.kick();
  await expect.poll(() => started).toEqual([result.runId]);
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  expect(factory).not.toHaveBeenCalled();
  expect(store.runs().filter((run) => run.agentId === managerId)).toHaveLength(0);
  await expect(
    managerTool(runtime, managerId, randomUUID(), 'dock_apply', {
      taskId: result.task.id,
      action: 'apply',
    }),
  ).rejects.toThrow('human review');
  const decision = {
    taskId: result.task.id,
    rationale: 'Preserve the existing review and application policy.',
    evidence: 'Owned worker fixture completed.',
  };
  await expect(
    managerTool(runtime, managerId, randomUUID(), 'dock_decide', { ...decision, kind: 'complete' }),
  ).rejects.toThrow('independent review');
  store.updateTask(result.task.id, { revisions: 2 });
  await expect(
    managerTool(runtime, managerId, randomUUID(), 'dock_decide', { ...decision, kind: 'revise' }),
  ).rejects.toThrow('Two revisions');
  store.updateTask(result.task.id, { status: 'needs_decision' });
  await expect(
    managerTool(runtime, managerId, randomUUID(), 'dock_decide', { ...decision, kind: 'accept' }),
  ).rejects.toThrow('human decision');
  expect(factory).not.toHaveBeenCalled();
});
