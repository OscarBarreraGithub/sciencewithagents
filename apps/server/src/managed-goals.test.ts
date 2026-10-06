import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { managedGoalViewSchema, pulsarPolicySchema, type ManagedGoalAction } from '@dock/shared';
import { Store, type PrivateRun } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { modelFixture } from './model-policy.fixture.js';
import { repoRoot } from './paths.js';
import { ClaudeSession, parseClaudeIdentity, type ClaudeSessionOptions } from './claude-session.js';
import { parseCapacity } from './capacity.js';

class ControlledCodex extends DemoProvider {
  starts: { threadId: string; turnId: string }[] = [];
  override async request(method: string, raw?: unknown): Promise<unknown> {
    if (method === 'turn/start') {
      const turnId = randomUUID();
      this.starts.push({ threadId: (raw as { threadId: string }).threadId, turnId });
      return { turn: { id: turnId, status: 'inProgress' } };
    }
    return super.request(method, raw);
  }
  finish(run: PrivateRun, status = 'completed') {
    this.emit('notification', 'turn/completed', {
      threadId: this.starts.at(-1)!.threadId,
      turn: { id: run.turnId, status },
    });
  }
}
class ControlledClaude extends ClaudeSession {
  override submit = vi.fn(async (input: { deliveryId: string; text: string }) => {
    if (this.submit.mock.calls.length === 1) this.options.beforeStart?.();
    this.options.beforeWrite?.(input.deliveryId);
  });
  override close = vi.fn(async () => {});
  finish(run: PrivateRun, status: 'completed' | 'failed' | 'interrupted' = 'completed') {
    this.emit('event', {
      type: 'result',
      id: randomUUID(),
      deliveryId: run.id,
      sessionId: this.options.sessionId,
      status,
      text: '',
      usage: null,
    });
  }
}
let root: string, store: Store, runtime: Runtime, app: FastifyInstance, manager: string;
let codex: ControlledCodex[], claude: ControlledClaude[];
const headers = {
  host: '127.0.0.1:4999',
  origin: 'http://127.0.0.1:4999',
  'content-type': 'application/json',
};
const identity = parseClaudeIdentity({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'fixture@example.invalid',
  orgId: 'fixture',
});
async function open(provider: 'codex' | 'claude' = 'codex', initialize = false) {
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  manager = store.register(root, 'Goal fixture', '').managerId;
  store.updateAgent(manager, { provider });
  codex = [];
  claude = [];
  runtime = new Runtime(
    store,
    root,
    'never-launch-real-provider',
    async () => {
      const value = new ControlledCodex();
      codex.push(value);
      return value;
    },
    {
      identity: async () => identity,
      inspect: async () => ({
        identity,
        models: [
          {
            value: 'default',
            displayName: 'Fixture Claude',
            description: '',
            supportsEffort: true,
            supportedEffortLevels: ['medium', 'high'],
          },
        ],
      }),
      session: (options: ClaudeSessionOptions) => {
        const value = new ControlledClaude(options);
        claude.push(value);
        return value;
      },
    },
  );
  app = await createServer(store, runtime, { port: 4999 });
  if (initialize) await runtime.initialize();
}
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/managed-goals-'));
  await open();
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
const view = async () =>
  managedGoalViewSchema.parse(
    (await app.inject({ url: `/api/agents/${manager}/goal`, headers })).json(),
  );
async function action(input: ManagedGoalAction) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/agents/${manager}/goal`,
    headers,
    payload: input,
  });
  expect(response.statusCode).toBe(200);
  return managedGoalViewSchema.parse(response.json());
}
async function create() {
  return action({
    key: randomUUID(),
    action: 'create',
    expectedRevision: null,
    objective: 'Complete the original bounded objective',
  });
}
function admitted() {
  const run = store.runs().find((run) => run.agentId === manager && run.status === 'queued')!;
  expect(runtime.pulsar.reserve(run, new Set())).toBe(true);
  runtime.quark.issueManagerLease(run);
  store.updateRun(run.id, { status: 'running', turnId: run.id });
  store.updateAgent(manager, { status: 'running', turnId: run.id });
  return store.run(run.id);
}
async function progress(
  run: PrivateRun,
  mode = 'continue',
  summary = 'First evidence saved',
  nextAction = 'Verify the next remaining item',
) {
  const goal = (await view()).goal!;
  return runtime.tool(manager, randomUUID(), 'dock_goal_update', {
    goalId: goal.id,
    expectedRevision: goal.revision,
    action: mode,
    summary,
    ...(mode === 'continue' ? { nextAction } : {}),
  });
}
function boundary(run: PrivateRun, success = true) {
  store.transaction(() => {
    store.updateRun(run.id, { status: success ? 'completed' : 'interrupted' });
    store.updateAgent(manager, { status: success ? 'idle' : 'interrupted', turnId: null });
    runtime.managedGoals.finish(store.run(run.id), success);
  });
  runtime.pulsar.settle(run.id);
}
function reconcileOwnerRequests() {
  runtime.workItems.saveForManager(manager, {
    key: randomUUID(),
    kind: 'internal',
    title: 'Retained owner request outcomes',
    status: 'done',
    sourceMessages: runtime.workItems
      .ownerRequests(manager, { limit: 50 })
      .items.map((source) => ({ agentId: manager, entryId: source.entryId })),
    sourceDisposition: 'All independent asks reviewed and verified with retained evidence.',
  });
}
function usage(provider: 'codex' | 'claude', usedPercent: number) {
  const clock = Date.now();
  store.setSetting(
    `capacity:v1:${provider}`,
    parseCapacity(
      provider,
      [
        {
          provider,
          source: 'oauth',
          usage: {
            updatedAt: new Date(clock).toISOString(),
            primary: {
              usedPercent,
              windowMinutes: 300,
              resetsAt: new Date(clock + 300 * 60_000).toISOString(),
            },
          },
        },
      ],
      clock,
    ),
  );
}

it.each(['pause', 'stop', 'replace'] as const)(
  'owns the first queued user request under a QUARK hold when the owner chooses %s',
  async (choice) => {
    store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
    store.setSetting(`quark:project:${store.agent(manager).projectId}`, { paused: true });
    const created = await create(),
      first = created.continuation!.runId;
    expect(store.run(first)).toMatchObject({ kind: 'user', sourceId: null, status: 'queued' });
    expect(created.continuation?.reason).toContain('paused');
    const changed = await action({
      key: randomUUID(),
      expectedRevision: created.goal!.revision,
      ...(choice === 'replace'
        ? { action: choice, objective: 'Explicit replacement' }
        : { action: choice }),
    });
    if (choice === 'pause') {
      expect(store.run(first).status).toBe('queued');
      expect(changed.continuation?.reason).toContain('Goal paused');
      const resumed = await action({
        key: randomUUID(),
        action: 'resume',
        expectedRevision: changed.goal!.revision,
      });
      expect(resumed.continuation?.runId).toBe(first);
      expect(resumed.continuation?.reason).toContain('paused');
    } else {
      expect(store.run(first).status).toBe('cancelled');
      if (choice === 'replace') {
        expect(changed.goal!.id).not.toBe(created.goal!.id);
        expect(changed.continuation?.runId).not.toBe(first);
        expect(store.runs(['queued'])).toHaveLength(1);
      } else expect(store.runs(['queued'])).toHaveLength(0);
    }
    expect(
      store.entries(manager).some((entry) => entry.id === first && entry.kind === 'user'),
    ).toBe(true);
    expect(codex).toHaveLength(0);
  },
);

it('reconciles a successful paused completion on resume without another model turn', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  await create();
  const run = admitted();
  reconcileOwnerRequests();
  await action({
    key: randomUUID(),
    action: 'pause',
    expectedRevision: (await view()).goal!.revision,
  });
  await progress(run, 'complete', 'Scoped outcomes verified');
  boundary(run);
  expect((await view()).goal?.status).toBe('paused');
  const resumed = await action({
    key: randomUUID(),
    action: 'resume',
    expectedRevision: (await view()).goal!.revision,
  });
  expect(resumed.goal?.status).toBe('completed');
  expect(store.runs()).toHaveLength(1);
});

it('keeps the exact owner objective in history and bounds routine context while explicit inspection retains full detail', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  const objective = 'Detailed original requirement. '.repeat(700);
  const created = await action({
    key: randomUUID(),
    action: 'create',
    expectedRevision: null,
    objective,
  });
  expect(store.run(created.continuation!.runId).text).toBe(objective.trim());
  const run = admitted();
  const summary = 'Retained evidence. '.repeat(400);
  await progress(run, 'continue', summary, 'Bounded next action');
  const context = runtime.managedGoals.context(manager)!;
  expect(context).toMatchObject({ id: created.goal!.id, status: 'active' });
  expect(context.objectivePreview.length).toBeLessThanOrEqual(601);
  expect(context.progressPreview.length).toBeLessThanOrEqual(801);
  expect(JSON.stringify(context).length).toBeLessThan(3200);
  const inspected = managedGoalViewSchema.parse(
    await runtime.tool(manager, randomUUID(), 'dock_inspect', { goal: true }),
  );
  expect(inspected.goal?.objective).toBe(objective.trim());
  expect(inspected.goal?.progress.summary).toBe(summary.trim());
  expect(inspected.goal?.revision).toBe(context.revision);
});

it('keeps active replies intact on stop and does not let an older turn clobber a replacement goal', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  await create();
  const run = admitted();
  await progress(run);
  await action({
    key: randomUUID(),
    action: 'stop',
    expectedRevision: (await view()).goal!.revision,
  });
  expect(store.run(run.id).status).toBe('running');
  const replaced = await action({
    key: randomUUID(),
    action: 'replace',
    expectedRevision: (await view()).goal!.revision,
    objective: 'New explicitly chosen objective',
  });
  await expect(progress(run)).rejects.toThrow('before the current goal');
  boundary(run);
  expect((await view()).goal).toEqual(replaced.goal);
  expect(store.run(replaced.continuation!.runId).status).toBe('queued');
});

it('rechecks additive owner input arriving after completion evidence before marking the goal completed', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  await create();
  const run = admitted();
  reconcileOwnerRequests();
  await progress(run, 'complete', 'Prior scoped outcomes verified');
  runtime.ownerSteering(
    manager,
    randomUUID(),
    'Also preserve this final adjacent requirement',
    'submitted',
  );
  boundary(run);
  expect((await view()).goal?.status).toBe('waiting');
  expect((await view()).message).toContain('remaining owner requests');
  expect((await view()).goal?.objective).toBe('Complete the original bounded objective');
  expect(store.runs(['queued'])).toHaveLength(0);
});

it('permits useful independent work while another owned item awaits a human or worker, but refuses completion', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  await create();
  const run = admitted();
  const worker = store.addAgent({
    projectId: store.agent(manager).projectId,
    parentId: manager,
    taskId: null,
    role: 'researcher',
    name: 'Dependent worker',
    cwd: root,
  });
  store.updateAgent(worker.id, { status: 'running' });
  runtime.workItems.saveForManager(manager, {
    key: randomUUID(),
    kind: 'human',
    title: 'One dependency needs an answer',
  });
  await expect(progress(run, 'complete')).rejects.toThrow('open internal and human');
  await progress(
    run,
    'continue',
    'Independent evidence prepared',
    'Review the independent evidence while that item waits',
  );
  boundary(run);
  expect((await view()).continuation?.status).toBe('queued');
  expect(runtime.pulsar.decision(store.run((await view()).continuation!.runId)).eligible).toBe(
    true,
  );
});

it.each(['queued', 'running', 'waiting', 'queued-ledger'] as const)(
  'requires completion to reconcile a taskless native helper with %s work while allowing independent continuation',
  async (state) => {
    store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
    await create();
    const run = admitted();
    reconcileOwnerRequests();
    const child = store.addAgent({
      projectId: store.agent(manager).projectId,
      parentId: manager,
      taskId: null,
      role: 'researcher',
      name: 'Native helper without a task',
      cwd: root,
    });
    store.updateAgent(child.id, {
      nativeRootId: manager,
      nativePath: 'fixture/helper',
      status: state === 'queued-ledger' ? 'idle' : state,
    });
    if (state === 'queued-ledger') {
      store.enqueue(child.id, randomUUID(), 'Preparing retained native child work');
      store.updateAgent(child.id, { status: 'idle' });
    }
    await expect(
      progress(run, 'complete', 'Cannot claim completion with pending helper work'),
    ).rejects.toThrow('active or pending children');
    await progress(
      run,
      'continue',
      'Useful independent evidence saved',
      'Review independent evidence while the helper runs',
    );
    boundary(run);
    expect((await view()).continuation?.status).toBe('queued');
    expect((await view()).goal?.status).toBe('active');
  },
);

it.each(['wait', 'blocked'] as const)(
  'keeps a full8000-character %s summary readable through typed views, context and explicit inspection',
  async (mode) => {
    store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
    await create();
    const run = admitted(),
      summary = 'S'.repeat(8000);
    await progress(run, mode, summary);
    const saved = await view();
    expect(saved.message).toHaveLength(2000);
    expect(saved.goal?.progress.summary).toBe(summary);
    expect(runtime.managedGoals.context(manager)?.message).toHaveLength(241);
    const before = managedGoalViewSchema.parse(
      await runtime.tool(manager, randomUUID(), 'dock_inspect', { goal: true }),
    );
    expect(before.goal?.progress.summary).toBe(summary);
    boundary(run);
    const after = await view();
    expect(after.message).toHaveLength(2000);
    expect(after.goal?.progress.summary).toBe(summary);
    expect(runtime.managedGoals.context(manager)?.progressPreview.length).toBeLessThanOrEqual(801);
    const inspected = managedGoalViewSchema.parse(
      await runtime.tool(manager, randomUUID(), 'dock_inspect', { goal: true }),
    );
    expect(inspected.goal?.progress.summary).toBe(summary);
    expect(store.runs(['queued'])).toHaveLength(0);
  },
);

it('waits without polling when there is no fresh checkpoint and reconciles an in-flight restart to blocked', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  await create();
  const first = admitted();
  boundary(first);
  expect((await view()).goal?.status).toBe('waiting');
  expect(store.runs()).toHaveLength(1);
  const owner = store.enqueue(manager, randomUUID(), 'Inspect a remaining item');
  const run = admitted();
  expect(run.id).toBe(owner.id);
  await progress(run);
  await app.close();
  await open('codex', true);
  expect(store.run(run.id).status).toBe('interrupted');
  expect((await view()).goal?.status).toBe('blocked');
  expect((await view()).message).toContain('no action is replayed');
  expect(store.runs()).toHaveLength(2);
});

it.each(['codex', 'claude'] as const)(
  'retains ordinary %s reserve, separate hourly/window allowances and turn-limit admission on goal reports',
  async (provider) => {
    await app.close();
    await open(provider);
    store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
    runtime.quark.saveChatPolicy(manager, {
      key: randomUUID(),
      expectedRevision: 0,
      enabled: true,
    });
    await create();
    const first = admitted();
    await progress(first);
    boundary(first);
    const next = store.run((await view()).continuation!.runId);
    const snapshot = runtime.capacity.status();
    vi.spyOn(runtime.capacity, 'status').mockImplementation(() => ({
      ...snapshot,
      machine: {
        observedAt: new Date().toISOString(),
        cpuCount: 8,
        cpuUsedPercent: 10,
        memoryTotalBytes: 32 * 1024 ** 3,
        memoryAvailableBytes: 16 * 1024 ** 3,
        diskAvailableBytes: 100 * 1024 ** 3,
        loadPerCore: 0.2,
      },
    }));
    store.setSetting(
      'pulsar:policy',
      pulsarPolicySchema.parse({
        enabled: true,
        maxAutomaticTurns: 12,
        providerReserves: {
          codex: { reservePercent: 25, releaseEnabled: false, releaseBeforeResetMinutes: 720 },
          claude: { reservePercent: 35, releaseEnabled: false, releaseBeforeResetMinutes: 45 },
        },
      }),
    );
    usage(provider === 'codex' ? 'claude' : 'codex', 5);
    expect(runtime.pulsar.decision(next).eligible).toBe(false);
    usage(provider, 90);
    expect(runtime.pulsar.decision(next).reason).toMatch(/headroom|reserve/);
    usage(provider, 10);
    expect(runtime.pulsar.decision(next).eligible).toBe(true);
    const hourly = runtime.quark.saveBudget({
      key: randomUUID(),
      projectId: store.agent(manager).projectId,
      provider,
      windowId: 'primary',
      period: 'hour',
      limitPercent: 0,
    });
    expect(runtime.pulsar.decision(next).reason).toContain('0%/hour');
    const paused = await action({
      key: randomUUID(),
      action: 'pause',
      expectedRevision: (await view()).goal!.revision,
    });
    const resumed = await action({
      key: randomUUID(),
      action: 'resume',
      expectedRevision: paused.goal!.revision,
    });
    expect(resumed.continuation?.runId).toBe(next.id);
    expect(resumed.continuation?.reason).toContain('0%/hour');
    runtime.quark.saveBudget({
      key: randomUUID(),
      id: hourly.id,
      expectedRevision: hourly.revision,
      projectId: hourly.projectId,
      provider,
      windowId: 'primary',
      period: 'hour',
      limitPercent: 0,
      enabled: false,
    });
    runtime.quark.saveBudget({
      key: randomUUID(),
      projectId: store.agent(manager).projectId,
      provider,
      windowId: 'primary',
      period: 'window',
      limitPercent: 0.1,
    });
    expect(runtime.pulsar.decision(next).reason).toMatch(/allowance budget/i);
    // The existing automatic-turn check precedes any native submission and retains this receipt.
    store.updateAgent(manager, { autoTurns: 12 });
    store.setSetting('scheduler:settings', { paused: false, maxConcurrent: 4 });
    runtime.kick();
    await vi.waitFor(() => expect(store.agent(manager).status).toBe('waiting'));
    expect(store.run(next.id).status).toBe('queued');
    expect(codex).toHaveLength(0);
    expect(claude).toHaveLength(0);
    expect((await view()).continuation?.runId).toBe(next.id);
  },
);

it('never enrolls or launches work on reads and rejects non-root/native/special managers', async () => {
  expect((await view()).goal).toBeNull();
  expect(store.runs()).toHaveLength(0);
  store.updateAgent(manager, { surface: 'misc' });
  expect((await view()).supported).toBe(false);
  const response = await app.inject({
    method: 'POST',
    url: `/api/agents/${manager}/goal`,
    headers,
    payload: {
      key: randomUUID(),
      action: 'create',
      expectedRevision: null,
      objective: 'Unsupported',
    },
  });
  expect(response.statusCode).toBe(409);
  expect(store.runs()).toHaveLength(0);
});

it.each(['codex', 'claude'] as const)(
  'uses the real %s host lifecycle and normal admission for exactly one continuation, then waits on no progress',
  async (provider) => {
    await app.close();
    await open(provider, true);
    await create();
    await vi.waitFor(() => expect(store.agent(manager).turnId).toBeTruthy());
    const first = store.runs().find((run) => run.agentId === manager && run.status === 'running')!;
    await progress(first);
    store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
    if (provider === 'codex') codex.find((client) => client.starts.length)!.finish(first);
    else
      claude
        .find((session) =>
          session.submit.mock.calls.some(([input]) => input.deliveryId === first.id),
        )!
        .finish(first);
    await vi.waitFor(() => expect(store.run(first.id).status).toBe('completed'));
    const saved = await view(),
      next = store.run(saved.goal!.continuationRunId!);
    expect(next).toMatchObject({
      status: 'queued',
      kind: 'report',
      sourceId: manager,
      key: `goal:${saved.goal!.id}:after:${first.id}`,
    });
    runtime.managedGoals.finish(store.run(first.id), true);
    expect(store.runs(['queued']).filter((run) => run.agentId === manager)).toHaveLength(1);
    const paused = await action({
      key: randomUUID(),
      action: 'pause',
      expectedRevision: (await view()).goal!.revision,
    });
    expect(paused.continuation?.runId).toBe(next.id);
    expect(paused.continuation?.reason).toContain('Goal paused');
    const resumed = await action({
      key: randomUUID(),
      action: 'resume',
      expectedRevision: paused.goal!.revision,
    });
    expect(resumed.continuation?.runId).toBe(next.id);
    store.setSetting('scheduler:settings', { paused: false, maxConcurrent: 4 });
    runtime.kick();
    await vi.waitFor(() => expect(store.run(next.id).status).toBe('running'));
    await progress(store.run(next.id));
    if (provider === 'codex')
      codex.find((client) => client.starts.length)!.finish(store.run(next.id));
    else
      claude
        .find((session) =>
          session.submit.mock.calls.some(([input]) => input.deliveryId === next.id),
        )!
        .finish(store.run(next.id));
    await vi.waitFor(() => expect(store.run(next.id).status).toBe('completed'));
    expect((await view()).goal?.status).toBe('waiting');
    expect((await view()).message).toContain('No new progress');
    expect(store.runs(['queued']).filter((run) => run.agentId === manager)).toHaveLength(0);
    expect(store.agent(manager).provider).toBe(provider);
  },
);

it.each(['codex', 'claude'] as const)(
  'blocks the goal after a failed native %s boundary and requires explicit conversation recovery',
  async (provider) => {
    await app.close();
    await open(provider, true);
    await create();
    await vi.waitFor(() => expect(store.agent(manager).turnId).toBeTruthy());
    const run = store.runs(['running']).find((run) => run.agentId === manager)!;
    await progress(run);
    if (provider === 'codex') codex.find((client) => client.starts.length)!.finish(run, 'failed');
    else
      claude
        .find((session) =>
          session.submit.mock.calls.some(([input]) => input.deliveryId === run.id),
        )!
        .finish(run, 'failed');
    await vi.waitFor(() => expect(store.run(run.id).status).toBe('failed'));
    const blocked = await view();
    expect(blocked.goal?.status).toBe('blocked');
    expect(store.runs(['queued']).filter((run) => run.agentId === manager)).toHaveLength(0);
    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${manager}/goal`,
      headers,
      payload: { key: randomUUID(), action: 'resume', expectedRevision: blocked.goal!.revision },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('GOAL_INSPECT_RESUME');
    expect((await view()).goal?.revision).toBe(blocked.goal!.revision);
    expect(store.runs().filter((run) => run.agentId === manager)).toHaveLength(1);
  },
);

it('persists the same paused receipt across restart, rejects stale lifecycle actions, and stops only unstarted goal work', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  const input = {
    key: randomUUID(),
    action: 'create' as const,
    expectedRevision: null,
    objective: 'Retain original work',
  };
  const created = await action(input);
  expect((await action(input)).goal?.id).toBe(created.goal?.id);
  const run = admitted();
  await progress(run);
  boundary(run);
  const key = randomUUID(),
    paused = await action({
      key,
      action: 'pause',
      expectedRevision: (await view()).goal!.revision,
    });
  const next = paused.goal!.continuationRunId!;
  await app.close();
  await open();
  expect((await view()).goal).toEqual(paused.goal);
  expect(store.run(next).status).toBe('queued');
  const conflict = await app.inject({
    method: 'POST',
    url: `/api/agents/${manager}/goal`,
    headers,
    payload: { key: randomUUID(), action: 'resume', expectedRevision: 1 },
  });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().code).toBe('GOAL_REVISION');
  const resumed = await action({
    key: randomUUID(),
    action: 'resume',
    expectedRevision: paused.goal!.revision,
  });
  expect(resumed.goal?.continuationRunId).toBe(next);
  const stopped = await action({
    key: randomUUID(),
    action: 'stop',
    expectedRevision: resumed.goal!.revision,
  });
  expect(stopped.goal?.status).toBe('stopped');
  expect(stopped.goal?.objective).toBe('Retain original work');
  expect(store.run(next).status).toBe('cancelled');
  expect(store.entries(manager).some((entry) => entry.id === next)).toBe(true);
  expect(store.run(run.id).status).toBe('completed');
});

it('keeps adjacent steering additive and requires completion to reconcile owned work rather than owner notes/ideas', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  await create();
  const run = admitted(),
    objective = (await view()).goal!.objective;
  runtime.ownerSteering(manager, randomUUID(), 'Also check the older remaining ask', 'submitted');
  const owned = runtime.workItems.saveForManager(manager, {
    key: randomUUID(),
    kind: 'internal',
    title: 'Remaining original work',
  });
  await expect(progress(run, 'complete', 'Finished')).rejects.toThrow('open internal and human');
  expect((await view()).goal?.objective).toBe(objective);
  const sources = runtime.workItems
    .ownerRequests(manager, { limit: 50 })
    .items.map((source) => ({ agentId: manager, entryId: source.entryId }));
  runtime.workItems.saveForManager(manager, {
    key: randomUUID(),
    id: owned.id,
    expectedRevision: owned.revision,
    status: 'done',
    sourceMessages: sources,
    sourceDisposition:
      'Both original and adjacent requests reconciled with retained outcome evidence.',
  });
  runtime.workItems.save({
    key: randomUUID(),
    projectId: store.agent(manager).projectId,
    kind: 'idea',
    title: 'Unrelated owner idea',
  });
  await progress(run, 'complete', 'Original and additive work verified');
  boundary(run);
  expect((await view()).goal?.status).toBe('completed');
  expect(store.runs(['queued'])).toHaveLength(0);
});

it('waits on an explicit dependency checkpoint, then yields a queued automatic receipt to ordinary input', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  await create();
  const run = admitted();
  const worker = store.addAgent({
    projectId: store.agent(manager).projectId,
    parentId: manager,
    taskId: null,
    role: 'researcher',
    name: 'Owned worker',
    cwd: root,
  });
  store.updateAgent(worker.id, { status: 'running' });
  await progress(run, 'wait', 'Waiting for the existing worker report');
  boundary(run);
  expect((await view()).message).toContain('existing worker report');
  expect(store.runs(['queued'])).toHaveLength(0);
  store.updateAgent(worker.id, { status: 'idle' });
  const report = store.enqueue(manager, randomUUID(), 'Worker finished', 'report', worker.id);
  const reportRun = admitted();
  expect(reportRun.id).toBe(report.id);
  await progress(reportRun, 'continue', 'Worker outcome recorded');
  boundary(reportRun);
  const automatic = (await view()).goal!.continuationRunId!;
  const owner = store.enqueue(manager, randomUUID(), 'A further owner ask');
  runtime.managedGoals.queued(store.run(owner.id));
  expect(store.run(automatic).status).toBe('cancelled');
  expect(store.run(owner.id).status).toBe('queued');
  expect((await view()).goal?.objective).toBe('Complete the original bounded objective');
});

it('never replays failed/interrupted work or silently resumes it after restart', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  await create();
  const run = admitted();
  await progress(run);
  boundary(run, false);
  const blocked = await view();
  expect(blocked.goal?.status).toBe('blocked');
  expect(blocked.continuation?.status).toBe('interrupted');
  await app.close();
  await open();
  const result = await app.inject({
    method: 'POST',
    url: `/api/agents/${manager}/goal`,
    headers,
    payload: { key: randomUUID(), action: 'resume', expectedRevision: blocked.goal!.revision },
  });
  expect(result.statusCode).toBe(409);
  expect(result.json().code).toBe('GOAL_INSPECT_RESUME');
  expect(store.runs()).toHaveLength(1);
  expect(store.run(run.id).status).toBe('interrupted');
});
