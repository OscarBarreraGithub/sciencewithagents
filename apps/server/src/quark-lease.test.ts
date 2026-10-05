import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './paths.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { parseCapacity } from './capacity.js';

class Controlled extends DemoProvider {
  starts = 0;
  compactions = 0;
  stops: { threadId: string; turnId: string }[] = [];
  requests: { method: string; params: unknown }[] = [];
  responses: { id: string | number; result: unknown }[] = [];
  override async request(method: string, raw?: unknown): Promise<unknown> {
    this.requests.push({ method, params: raw });
    if (method === 'thread/compact/start') {
      this.compactions++;
      this.emit('notification', 'turn/started', {
        threadId: (raw as { threadId: string }).threadId,
        turn: { id: `compact-${this.compactions}` },
      });
      return {};
    }
    if (method === 'turn/start') {
      this.starts++;
      return { turn: { id: randomUUID(), status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') {
      const p = raw as { threadId: string; turnId: string };
      this.stops.push(p);
      this.emit('notification', 'turn/completed', {
        threadId: p.threadId,
        turn: { id: p.turnId, status: 'interrupted' },
      });
      return {};
    }
    return super.request(method, raw);
  }
  override respond(id: string | number, result: unknown) {
    this.responses.push({ id, result });
  }
}
let root: string, store: Store, runtime: Runtime, manager: string, project: string;
let providers: Map<string, Controlled>;
let providerSessions: Map<string, Controlled[]>;
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/quark-lease-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const p = store.register(root, 'Lease fixture', '');
  manager = p.managerId;
  project = p.id;
  providers = new Map();
  providerSessions = new Map();
  runtime = new Runtime(store, root, 'never-launch-real-provider', async (a) => {
    const p = new Controlled();
    providers.set(a.id, p);
    const sessions = providerSessions.get(a.id) ?? [];
    sessions.push(p);
    providerSessions.set(a.id, sessions);
    return p;
  });
});
afterEach(async () => {
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const taskInput = { title: 'Bounded result', goal: 'Read evidence', acceptance: 'Report evidence' };
async function start(agentId = manager) {
  const run = store.enqueue(agentId, randomUUID(), 'Bounded work');
  runtime.kick();
  await vi.waitFor(() => expect(store.agent(agentId).turnId).toBeTruthy());
  return store.run(run.id);
}
function worker() {
  const task = store.addTask(project, { ...taskInput, parentId: null });
  return store.addAgent({
    projectId: project,
    parentId: manager,
    taskId: task.id,
    role: 'researcher',
    name: 'Worker',
    provider: 'codex',
    cwd: root,
  });
}
it('adds coalesced QUARK changes to original Codex tool replies without starting manager turns', async () => {
  runtime.coordinator.saveProjectPriority(project, {
    key: randomUUID(),
    expectedRevision: 0,
    priority: 'background',
  });
  const run = await start();
  const managerState = store.agent(manager),
    client = providers.get(manager)!;
  const invoke = async () => {
    const requestId = randomUUID();
    client.emit('request', requestId, 'item/tool/call', {
      threadId: managerState.threadId,
      turnId: managerState.turnId,
      callId: randomUUID(),
      tool: 'dock_inspect',
      arguments: {},
    });
    await vi.waitFor(() =>
      expect(client.responses.some((response) => response.id === requestId)).toBe(true),
    );
    return JSON.parse(
      (
        client.responses.find((response) => response.id === requestId)!.result as {
          contentItems: { text: string }[];
        }
      ).contentItems[0].text,
    );
  };
  const first = await invoke();
  expect(first.quarkUpdate.managerLease.state).toBe('active');
  expect(first.quarkUpdate.projectPolicy).toMatchObject({ revision: 1, priority: 'background' });
  expect(
    first.quarkUpdate.providers.map((provider: { provider: string }) => provider.provider).sort(),
  ).toEqual(['claude', 'codex']);
  expect(await invoke()).not.toHaveProperty('quarkUpdate');
  runtime.ownerSteering(
    manager,
    randomUUID(),
    'Preserve the original work and also review new evidence.',
    'submitted',
  );
  const steering = await invoke();
  expect(steering.quarkUpdate.ownerRequests.items).toContainEqual(
    expect.objectContaining({
      text: 'Preserve the original work and also review new evidence.',
      delivery: 'submitted',
    }),
  );
  expect(await invoke()).not.toHaveProperty('quarkUpdate');
  client.emit('notification', 'thread/compacted', { threadId: managerState.threadId });
  await vi.waitFor(() =>
    expect(store.entries(manager).some((entry) => entry.title === 'Context compacted')).toBe(true),
  );
  expect((await invoke()).quarkUpdate.ownerRequests.total).toBe(2);
  const restored = JSON.parse(
    runtime.context(store.agent(manager)).split('\n').slice(1).join('\n'),
  );
  expect(restored.ownerRequests.items.map((item: { text: string }) => item.text)).toContain(
    'Bounded work',
  );
  const child = worker(),
    childRun = await start(child.id);
  expect(await invoke()).not.toHaveProperty('quarkUpdate'); // Routine progress is coalesced.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
  try {
    expect((await invoke()).quarkUpdate.progress).toContainEqual(
      expect.objectContaining({ runId: childRun.id }),
    );
  } finally {
    clock.mockRestore();
  }
  runtime.quark.hold(childRun, 'Allowance reached in this task', false, 'budget');
  const changed = await invoke();
  expect(changed.quarkUpdate.holds).toContainEqual(
    expect.objectContaining({ runId: childRun.id, reason: 'Allowance reached in this task' }),
  );
  expect(JSON.stringify(changed.quarkUpdate).length).toBeLessThan(10_000);
  expect(await invoke()).not.toHaveProperty('quarkUpdate');
  expect(client.starts).toBe(1);
  expect(
    store
      .runs()
      .filter((item) => item.agentId === manager)
      .map((item) => item.id),
  ).toEqual([run.id]);
});

it('requires a signed active lease for orchestration and rejects stale native manager calls', async () => {
  await expect(runtime.tool(manager, randomUUID(), 'dock_task_create', taskInput)).rejects.toThrow(
    'admitted',
  );
  expect(store.tasks()).toHaveLength(0);
  const run = await start();
  expect(runtime.quark.requireManagerLease(run).runId).toBe(run.id);
  const key = randomUUID();
  const result = await runtime.tool(manager, key, 'dock_task_create', taskInput);
  const p = providers.get(manager)!;
  p.emit('request', 55, 'item/tool/call', {
    threadId: store.agent(manager).threadId,
    turnId: 'old-turn',
    callId: randomUUID(),
    tool: 'dock_task_create',
    arguments: taskInput,
  });
  await vi.waitFor(() => expect(p.responses).toHaveLength(1));
  expect(p.responses[0]!.result).toMatchObject({ success: false });
  store.setSetting(`quark:manager-lease:${run.id}`, null);
  await expect(runtime.tool(manager, randomUUID(), 'dock_task_create', taskInput)).rejects.toThrow(
    'signed',
  );
  expect(await runtime.tool(manager, key, 'dock_task_create', taskInput)).toEqual(result);
  runtime.kick();
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('interrupted'));
  expect(p.stops).toHaveLength(1);
  expect(store.tasks()).toHaveLength(1);
});
it('rechecks the original lease after asynchronous model selection, before creating a worker', async () => {
  const run = await start();
  const task = store.addTask(project, { ...taskInput, parentId: null });
  const resolve = runtime.modelPolicy.resolveWorker.bind(runtime.modelPolicy);
  const assignment = await resolve(project, 'researcher');
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const selection = vi.spyOn(runtime.modelPolicy, 'resolveWorker').mockImplementation(async () => {
    await gate;
    return assignment;
  });
  const dispatch = runtime.tool(manager, randomUUID(), 'dock_delegate', {
    taskId: task.id,
    role: 'researcher',
    name: 'Late worker',
    instruction: 'Read',
  });
  try {
    await vi.waitFor(() => expect(selection).toHaveBeenCalled());
    store.setSetting(`quark:manager-lease:${run.id}`, null);
  } finally {
    release();
  }
  await expect(dispatch).rejects.toThrow('signed');
  expect(store.agents()).toHaveLength(1);
  expect(store.task(task.id).worktree).toBeNull();
});
it('refuses a delegation paused during model selection and retains the manager conversation', async () => {
  const run = await start();
  const task = store.addTask(project, { ...taskInput, parentId: null });
  const pending = store.enqueue(manager, randomUUID(), 'Keep this follow-up');
  const resolve = runtime.modelPolicy.resolveWorker.bind(runtime.modelPolicy);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const selection = vi
    .spyOn(runtime.modelPolicy, 'resolveWorker')
    .mockImplementation(async (...args) => {
      await gate;
      return resolve(...args);
    });
  const dispatch = runtime.tool(manager, randomUUID(), 'dock_delegate', {
    taskId: task.id,
    role: 'researcher',
    name: 'After pause',
    instruction: 'Read',
  });
  try {
    await vi.waitFor(() => expect(selection).toHaveBeenCalled());
    runtime.coordinator.updateProjectPolicy(
      {
        action: 'project',
        projectId: project,
        expectedRevision: 0,
        paused: true,
        reason: 'Owner paused the project',
      },
      true,
    );
  } finally {
    release();
  }
  await expect(dispatch).rejects.toThrow('project is paused');
  expect(store.agents()).toHaveLength(1);
  expect(store.task(task.id).worktree).toBeNull();
  runtime.kick();
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('interrupted'));
  expect(store.run(pending.id).status).toBe('queued');
  expect(store.agent(manager).threadId).toBeTruthy();
  expect(store.task(task.id).title).toBe(taskInput.title);
});
it('lets a manager pause only its owned worker, preserves pending input, and makes retries harmless', async () => {
  const w = worker(),
    run = await start(w.id);
  const originalProvider = providers.get(w.id)!,
    sessions = providerSessions.get(w.id)!,
    threadId = store.agent(w.id).threadId,
    stoppedTurn = { threadId, turnId: run.turnId };
  const queued = store.enqueue(w.id, randomUUID(), 'Unsent follow-up');
  const other = store.addAgent({
    projectId: project,
    parentId: null,
    taskId: null,
    role: 'manager',
    name: 'Peer manager',
    cwd: root,
    provider: 'codex',
  });
  await expect(
    runtime.tool(other.id, randomUUID(), 'dock_pause_worker', {
      agentId: w.id,
      reason: 'Too costly',
    }),
  ).rejects.toThrow('responsible manager');
  // Stop remains available without a running manager or a valid lease.
  const key = randomUUID(),
    input = { agentId: w.id, reason: 'Forecast exceeds the approved work' };
  const response = await runtime.tool(manager, key, 'dock_pause_worker', input);
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('interrupted'));
  expect(store.run(queued.id)).toMatchObject(queued);
  expect(store.agent(w.id).threadId).toBe(threadId);
  expect(originalProvider.ready).toBe(false);
  expect(sessions.flatMap((p) => p.stops)).toEqual([stoppedTurn]);
  expect(runtime.quark.holds().find((h) => h.runId === run.id)?.reason).toContain('Forecast');
  expect(await runtime.tool(manager, key, 'dock_pause_worker', input)).toEqual(response);
  expect(sessions).toEqual([originalProvider]);
  expect(sessions.flatMap((p) => p.stops)).toEqual([stoppedTurn]);
  runtime.quark.release(run.id);
  runtime.kick();
  await vi.waitFor(() =>
    expect(store.run(queued.id)).toMatchObject({ status: 'running', turnId: expect.any(String) }),
  );
  expect(await runtime.tool(manager, key, 'dock_pause_worker', input)).toEqual(response);
  const resumedProvider = providers.get(w.id)!;
  expect(resumedProvider).not.toBe(originalProvider);
  expect(resumedProvider.ready).toBe(true);
  expect(sessions).toEqual([originalProvider, resumedProvider]);
  expect(sessions.flatMap((p) => p.stops)).toEqual([stoppedTurn]);
  expect(sessions.reduce((total, p) => total + p.starts, 0)).toBe(2);
  expect(resumedProvider.requests.filter((r) => r.method === 'thread/resume')).toMatchObject([
    { params: { threadId } },
  ]);
  expect(
    sessions.flatMap((p) => p.requests.filter((r) => r.method === 'turn/start')),
  ).toMatchObject([
    {
      params: {
        threadId,
        clientUserMessageId: run.id,
        input: [{ type: 'text', text: run.text }],
      },
    },
    {
      params: {
        threadId,
        clientUserMessageId: queued.id,
        input: [{ type: 'text', text: queued.text }],
      },
    },
  ]);
  expect(store.runs().filter((r) => r.agentId === w.id)).toHaveLength(2);
  expect(store.run(run.id)).toEqual({ ...run, status: 'interrupted' });
  expect(store.agent(w.id).threadId).toBe(threadId);
  expect(store.run(queued.id).status).toBe('running');
});
it('the host stops a budgeted worker while its manager is idle and leaves other projects alone', async () => {
  const w = worker();
  const reset = new Date(Date.now() + 7 * 86400_000).toISOString();
  const usage = (n: number) =>
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
              secondary: { usedPercent: n, windowMinutes: 10080, resetsAt: reset },
            },
          },
        ],
        Date.now(),
      ),
    );
  usage(6);
  runtime.quark.sync();
  runtime.quark.saveBudget({
    key: randomUUID(),
    projectId: project,
    provider: 'codex',
    windowId: 'secondary',
    limitPercent: 5,
  });
  const other = store.register(join(root, 'other'), 'Other', '');
  const independent = await start(other.managerId);
  const run = await start(w.id);
  await new Promise((r) => setTimeout(r, 20));
  // Input token evidence weights the changed meter toward this worker.
  const a = store.agent(w.id);
  providers.get(w.id)!.emit('notification', 'thread/tokenUsage/updated', {
    threadId: a.threadId,
    turnId: a.turnId,
    tokenUsage: {
      total: {
        totalTokens: 1000000,
        inputTokens: 990000,
        outputTokens: 10000,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 1000000,
        inputTokens: 990000,
        outputTokens: 10000,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      },
    },
  });
  await vi.waitFor(() => {
    runtime.quark.sync();
    expect(runtime.quark.runs(true).find((r) => r.runId === run.id)?.tokens.totalTokens).toBe(
      1000000,
    );
  });
  usage(20);
  runtime.kick();
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('interrupted'));
  expect(store.run(independent.id).status).toBe('running');
  expect(store.runs().some((r) => r.agentId === manager && r.status === 'running')).toBe(false);
  expect(providers.get(manager)?.starts ?? 0).toBe(0);
});

it('retains a queued worker until explicit continuation without starting its provider', async () => {
  const w = worker();
  const run = store.enqueue(w.id, randomUUID(), 'Not sent yet');
  await runtime.tool(manager, randomUUID(), 'dock_pause_worker', {
    agentId: w.id,
    reason: 'Reserve this budget for urgent work',
  });
  runtime.kick();
  expect(store.run(run.id).status).toBe('queued');
  expect(providers.get(w.id)?.starts ?? 0).toBe(0);
  expect(runtime.quark.holds().some((h) => h.runId === run.id)).toBe(true);
  runtime.quark.release(run.id);
  runtime.kick();
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('running'));
});
it('retains a failed stop and the watchdog retries the same worker without a manager turn', async () => {
  const w = worker(),
    run = await start(w.id),
    provider = providers.get(w.id)!;
  const request = provider.request.bind(provider);
  let fail = true;
  vi.spyOn(provider, 'request').mockImplementation(async (method, raw) => {
    if (method === 'turn/interrupt' && fail) {
      fail = false;
      throw new Error('Temporary disconnect');
    }
    return request(method, raw);
  });
  try {
    await runtime.tool(manager, randomUUID(), 'dock_pause_worker', {
      agentId: w.id,
      reason: 'Stop spending',
    });
    expect(runtime.quark.holds().find((h) => h.runId === run.id)?.error).toContain(
      'Temporary disconnect',
    );
    expect(store.run(run.id).status).toBe('running');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000);
    runtime.kick();
    await vi.waitFor(() => expect(store.run(run.id).status).toBe('interrupted'));
    expect(provider.stops).toEqual([{ threadId: store.agent(w.id).threadId, turnId: run.turnId }]);
    expect(runtime.quark.holds().find((h) => h.runId === run.id)?.error).toBeNull();
  } finally {
    vi.restoreAllMocks();
  }
});

async function native(agentId = manager, extra: object = {}) {
  const attached = await runtime.attach(agentId);
  runtime.externalControl.add(agentId);
  const transition = runtime.prepareNativeContext(agentId, 'turn/start', {
    threadId: attached.threadId,
    input: [{ type: 'text', text: 'Bounded native work' }],
    ...extra,
  })!;
  return { ...attached, transition };
}
it('admits a native manager before provider input, binds the effective native model and monitors its lease', async () => {
  const { threadId, client, transition } = await native(manager, {
    model: 'other-choice',
    collaborationMode: {
      mode: 'default',
      settings: {
        model: 'explicit-native-model',
        reasoning_effort: 'high',
        developer_instructions: null,
      },
    },
  });
  expect(store.runs()).toHaveLength(0);
  await transition.before!();
  const run = store.runs().find((r) => r.agentId === manager && r.status === 'running')!;
  expect(runtime.quark.requireManagerLease(run)).toMatchObject({
    model: 'explicit-native-model',
    runId: run.id,
  });
  expect(runtime.pulsar.hasReservation(run.id)).toBe(true);
  expect(providers.get(manager)!.starts).toBe(0); // Admission itself must spend no tokens.
  expect(runtime.quark.runs()).toHaveLength(0);
  transition.submitted!();
  const turnId = randomUUID();
  client.emit('notification', 'turn/started', { threadId, turn: { id: turnId } });
  await runtime.withLock(`provider:${manager}`, async () => {});
  await transition.finish({ turn: { id: turnId, status: 'inProgress' } });
  transition.cancel();
  expect(store.runs()).toHaveLength(1);
  await runtime.tool(manager, randomUUID(), 'dock_task_create', taskInput);
  expect(store.tasks()).toHaveLength(1);
  store.setSetting(`quark:manager-lease:${run.id}`, null);
  runtime.kick();
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('interrupted'));
  expect(providers.get(manager)!.stops).toEqual([{ threadId, turnId }]);
  expect(runtime.quark.holds()[0]?.cause).toBe('lease');
});
it('admits manual compaction through QUARK without changing model policy or completing the task', async () => {
  const w = worker();
  store.updateAgent(w.id, { role: 'implementer', autoTurns: 7 });
  const { client, threadId } = await runtime.attach(w.id);
  const original = store.agent(w.id);
  const task = store.task(w.taskId!);
  await runtime.compact(w.id);
  await runtime.withLock(`provider:${w.id}`, async () => {});
  const run = store.runs().find((r) => r.agentId === w.id)!;
  expect(run).toMatchObject({ status: 'running', turnId: 'compact-1' });
  expect(runtime.pulsar.hasReservation(run.id)).toBe(true);
  expect(runtime.quark.runs().find((r) => r.runId === run.id)).toBeTruthy();
  expect(runtime.quark.isMaintenance(run.id)).toBe(true);
  expect(runtime.quark.isNudge(run.id)).toBe(false);
  expect(store.agent(w.id)).toMatchObject({
    model: original.model,
    modelSelection: original.modelSelection,
    autoTurns: 7,
  });
  client.emit('notification', 'turn/completed', {
    threadId,
    turn: { id: 'compact-1', status: 'completed' },
  });
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('completed'));
  expect(store.task(w.taskId!)).toEqual(task);
  expect(store.runs().filter((r) => r.agentId === manager)).toHaveLength(0);
  expect(providers.get(w.id)!.starts).toBe(0);
});
it('signs native manager compaction before input, forbids orchestration, and holds uncertain delivery', async () => {
  const { client, threadId } = await runtime.attach(manager);
  runtime.externalControl.add(manager);
  const transition = runtime.prepareNativeContext(manager, 'thread/compact/start', { threadId })!;
  await transition.before!();
  const run = store.runs()[0]!;
  expect(runtime.quark.requireManagerLease(run).runId).toBe(run.id);
  transition.submitted!();
  await expect(runtime.tool(manager, randomUUID(), 'dock_task_create', taskInput)).rejects.toThrow(
    'Context maintenance',
  );
  // No acknowledgement is fabricated when the native request is lost.
  transition.cancel();
  expect(runtime.quark.holds()[0]?.cause).toBe('lease');
  client.emit('notification', 'turn/started', { threadId, turn: { id: 'late-compact' } });
  runtime.kick();
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('interrupted'));
  expect(providers.get(manager)!.stops).toEqual([{ threadId, turnId: 'late-compact' }]);
  expect(store.tasks()).toHaveLength(0);
});
it('refuses compaction before provider work when the queue or allowance blocks it', async () => {
  await runtime.attach(manager);
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  await expect(runtime.compact(manager)).rejects.toThrow('admission is paused');
  expect(providers.get(manager)!.compactions).toBe(0);
  store.setSetting('scheduler:settings', { paused: false, maxConcurrent: 4 });
  const block = vi.spyOn(runtime.quark, 'reason').mockReturnValue('Allowance grant exhausted');
  await expect(runtime.compact(manager)).rejects.toThrow('Allowance grant exhausted');
  block.mockRestore();
  expect(store.runs()).toHaveLength(0);
  expect(providers.get(manager)!.compactions).toBe(0);
});
it('refuses a native turn before forwarding when the queue is paused, a grant blocks it, or earlier input exists', async () => {
  await runtime.attach(manager);
  runtime.externalControl.add(manager);
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  expect(() =>
    runtime.prepareNativeContext(manager, 'turn/start', {
      threadId: store.agent(manager).threadId,
    }),
  ).toThrow('admission is paused');
  store.setSetting('scheduler:settings', { paused: false, maxConcurrent: 4 });
  const { transition } = await native();
  const block = vi.spyOn(runtime.quark, 'reason').mockReturnValue('Allowance grant exhausted');
  await expect(transition.before!()).rejects.toThrow('Allowance grant exhausted');
  transition.cancel();
  expect(store.runs()).toHaveLength(0); // The entire admission rolls back.
  expect(providers.get(manager)!.starts).toBe(0);
  block.mockRestore();
  store.enqueue(manager, randomUUID(), 'Earlier unsent input');
  expect(() =>
    runtime.prepareNativeContext(manager, 'turn/start', {
      threadId: store.agent(manager).threadId,
    }),
  ).toThrow('earlier queued work');
});
it('distinguishes cancellation before forwarding from a lost native acknowledgement and never replays either', async () => {
  const first = await native();
  await first.transition.before!();
  first.transition.cancel();
  expect(store.runs()[0]?.status).toBe('cancelled');
  expect(runtime.quark.runs()).toHaveLength(0);
  const second = await native();
  await second.transition.before!();
  second.transition.submitted!();
  const run = store.runs().at(-1)!;
  second.transition.cancel();
  runtime.kick();
  await vi.waitFor(() => expect(runtime.quark.holds()[0]?.error).toContain('not acknowledged'));
  expect(store.run(run.id).status).toBe('running'); // Keep its reservation until known stopped.
  expect(runtime.quark.holds()[0]?.cause).toBe('lease');
  const turnId = randomUUID();
  second.client.emit('notification', 'turn/started', {
    threadId: second.threadId,
    turn: { id: turnId },
  });
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('interrupted'));
  expect(store.runs()).toHaveLength(2);
  expect(providers.get(manager)!.starts).toBe(0);
});
it('never grants authority retroactively to an unsolicited native manager turn', async () => {
  const { client, threadId } = await runtime.attach(manager);
  runtime.externalControl.add(manager);
  const turnId = randomUUID();
  client.emit('notification', 'turn/started', { threadId, turn: { id: turnId } });
  await vi.waitFor(() => expect(store.runs()[0]?.status).toBe('interrupted'));
  expect(store.events().some((e) => e.type === 'quark.manager_lease')).toBe(false);
  expect(providers.get(manager)!.stops).toEqual([{ threadId, turnId }]);
  await expect(runtime.tool(manager, randomUUID(), 'dock_task_create', taskInput)).rejects.toThrow(
    'admitted',
  );
});
it('recovers a confirmed telemetry pause automatically without replaying the worker request', async () => {
  const w = worker();
  const fresh = () =>
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
              secondary: {
                usedPercent: 6,
                windowMinutes: 10080,
                resetsAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
              },
            },
          },
        ],
        Date.now(),
      ),
    );
  fresh();
  runtime.quark.saveBudget({
    key: randomUUID(),
    projectId: project,
    provider: 'codex',
    windowId: 'secondary',
    limitPercent: 20,
  });
  const run = await start(w.id);
  const originalProvider = providers.get(w.id)!,
    sessions = providerSessions.get(w.id)!,
    threadId = store.agent(w.id).threadId,
    stoppedTurn = { threadId, turnId: run.turnId };
  store.setSetting('capacity:v1:codex', {
    ...(store.getSetting('capacity:v1:codex') as object),
    state: 'error',
    observedAt: new Date(Date.now() - 180_001).toISOString(),
  });
  runtime.kick();
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('interrupted'));
  expect(runtime.quark.holds()[0]).toMatchObject({
    cause: 'monitoring',
    stopAcknowledgedAt: expect.any(String),
  });
  expect(originalProvider.ready).toBe(false);
  expect(sessions.flatMap((p) => p.stops)).toEqual([stoppedTurn]);
  fresh();
  runtime.kick();
  await vi.waitFor(() => {
    const recovery = store.runs().find((r) => r.agentId === w.id && r.kind === 'resume');
    expect(recovery).toMatchObject({ status: 'running', turnId: expect.any(String) });
  });
  const recovery = store.runs().find((r) => r.agentId === w.id && r.kind === 'resume')!,
    resumedProvider = providers.get(w.id)!;
  expect(store.run(run.id)).toEqual({ ...run, status: 'interrupted' });
  expect(recovery.key).toBe(`quark:resume:${run.id}`);
  expect(store.runs().filter((r) => r.agentId === w.id)).toHaveLength(2);
  expect(runtime.quark.holds()).toHaveLength(0);
  expect(store.agent(w.id).threadId).toBe(threadId);
  expect(resumedProvider).not.toBe(originalProvider);
  expect(resumedProvider.ready).toBe(true);
  expect(sessions).toEqual([originalProvider, resumedProvider]);
  expect(sessions.flatMap((p) => p.stops)).toEqual([stoppedTurn]);
  expect(sessions.reduce((total, p) => total + p.starts, 0)).toBe(2);
  expect(resumedProvider.requests.filter((r) => r.method === 'thread/resume')).toMatchObject([
    { params: { threadId } },
  ]);
  expect(
    sessions.flatMap((p) => p.requests.filter((r) => r.method === 'turn/start')),
  ).toMatchObject([
    {
      params: {
        threadId,
        clientUserMessageId: run.id,
        input: [{ type: 'text', text: run.text }],
      },
    },
    {
      params: {
        threadId,
        clientUserMessageId: recovery.id,
        input: [{ type: 'text', text: `Recorded input:\n${recovery.text}` }],
      },
    },
  ]);
});
