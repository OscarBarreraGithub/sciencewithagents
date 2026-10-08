import { modelFixture } from './model-policy.fixture.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { parseCapacity } from './capacity.js';
import type { PrivateRun } from './store.js';
import { saveSchedulerSettings, schedulerSettings, schedulerStatus } from './scheduler.js';

let root: string, store: Store, runtime: Runtime, manager: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dock-scheduler-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  manager = store.register(root, 'Queue fixture', '').managerId;
  runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
});
afterEach(async () => {
  await runtime.close();
  vi.restoreAllMocks();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
const settings = (paused: boolean, maxConcurrent = 4) =>
  saveSchedulerSettings(store, { key: randomUUID(), settings: { paused, maxConcurrent } });
describe('bounded deterministic queue controls', () => {
  it('persists settings and exact retry semantics without changing queued work or original permissions', async () => {
    expect(schedulerSettings(store)).toEqual({ paused: false, maxConcurrent: 4 });
    const run = store.enqueue(manager, randomUUID(), 'Keep my original message');
    const input = { key: randomUUID(), settings: { paused: true, maxConcurrent: 1 } };
    const previous = store.agent(manager);
    saveSchedulerSettings(store, input);
    const head = store.head;
    saveSchedulerSettings(store, input);
    expect(store.head).toBe(head);
    expect(() =>
      saveSchedulerSettings(store, { ...input, settings: { paused: false, maxConcurrent: 4 } }),
    ).toThrow('retry key');
    expect(store.agent(manager)).toEqual(previous);
    expect(store.run(run.id).text).toBe('Keep my original message');
    await runtime.close();
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store);
    runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
    expect(schedulerSettings(store)).toEqual(input.settings);
    const hostState = JSON.parse(
      runtime.context(store.agent(manager)).split('\n').slice(1).join('\n'),
    );
    expect(hostState.scheduler).toEqual(input.settings);
    expect(store.run(run.id).status).toBe('queued');
    for (const value of [0, 5, 1.5]) expect(() => settings(false, value)).toThrow();
  });
  it('pauses dispatch without cancelling work and resumes the same queued run exactly once', async () => {
    settings(true, 1);
    const run = store.enqueue(manager, randomUUID(), 'A harmless fixture message');
    await runtime.initialize();
    expect(store.run(run.id).status).toBe('queued');
    expect(runtime.clients.size).toBe(0);
    settings(false, 1);
    runtime.kick();
    await vi.waitFor(() => expect(store.run(run.id).status).toBe('completed'));
    expect(store.runs()).toHaveLength(1);
    expect(store.entries(manager).filter((entry) => entry.kind === 'assistant')).toHaveLength(1);
  });
  it('limits starts across projects, keeps per-agent order and lets current work finish when paused', async () => {
    // Finish turns explicitly: model preparation may make another project's head
    // ready first, and CI timing must not decide whether a turn is still running.
    const finishes = new Map<string, () => void>();
    const request = DemoProvider.prototype.request;
    const calls = vi.spyOn(DemoProvider.prototype, 'request').mockImplementation(async function (
      this: DemoProvider,
      method,
      raw,
    ) {
      if (method !== 'turn/start') return request.call(this, method, raw);
      const turnId = randomUUID();
      finishes.set(this.threadId, () => {
        finishes.delete(this.threadId);
        this.emit('notification', 'turn/completed', {
          threadId: this.threadId,
          turn: { id: turnId, status: 'completed' },
        });
      });
      return { turn: { id: turnId, status: 'inProgress' } };
    });
    const finish = (agentId: string) => {
      const done = finishes.get(store.agent(agentId).threadId!);
      expect(done).toBeDefined();
      done!();
    };
    settings(false, 1);
    const other = store.addManager(
      store.agent(manager).projectId,
      'Second manager',
      'Another scope',
    );
    const first = store.enqueue(manager, randomUUID(), 'First');
    const second = store.enqueue(manager, randomUUID(), 'Second');
    const third = store.enqueue(other.id, randomUUID(), 'Third');
    await runtime.initialize();
    await vi.waitFor(() => expect(store.run(first.id).status).toBe('running'));
    expect(store.run(second.id).status).toBe('queued');
    expect(store.run(third.id).status).toBe('queued');
    settings(true, 1);
    finish(manager);
    await vi.waitFor(() => expect(store.run(first.id).status).toBe('completed'));
    expect(store.run(second.id).status).toBe('queued');
    expect(store.run(third.id).status).toBe('queued');
    settings(false, 1);
    runtime.kick();
    await vi.waitFor(() => expect(store.runs(['running'])).toHaveLength(1));
    const next = store.runs(['running'])[0]!;
    const remaining = next.id === second.id ? third : second;
    expect([second.id, third.id]).toContain(next.id);
    expect(store.run(remaining.id).status).toBe('queued');
    finish(next.agentId);
    await vi.waitFor(() => expect(store.run(remaining.id).status).toBe('running'));
    expect(store.runs(['running'])).toHaveLength(1);
    finish(remaining.agentId);
    await vi.waitFor(() => expect(store.run(third.id).status).toBe('completed'));
    await vi.waitFor(() => expect(store.run(second.id).status).toBe('completed'));
    const starts = store
      .events()
      .filter((event) => event.type === 'run.running')
      .map((event) => (event.data as { id: string }).id);
    expect([...new Set(starts)].sort()).toEqual([first.id, second.id, third.id].sort());
    expect(starts.indexOf(first.id)).toBeLessThan(starts.indexOf(second.id));
    expect(calls.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(3);
    calls.mockRestore();
  });
  it('does not take native control or clear a waiting approval when the queue resumes', async () => {
    const run = store.enqueue(manager, randomUUID(), 'Waiting');
    runtime.externalControl.add(manager);
    await runtime.initialize();
    expect(store.run(run.id).status).toBe('queued');
    expect(schedulerStatus(store, runtime.externalControl).items[0].explanation).toContain(
      'native terminal',
    );
    runtime.externalControl.delete(manager);
    store.updateAgent(manager, { status: 'waiting' });
    settings(true);
    settings(false);
    runtime.kick();
    expect(store.run(run.id).status).toBe('queued');
    expect(runtime.clients.size).toBe(0);
    expect(schedulerStatus(store, runtime.externalControl).items[0].explanation).toContain(
      'pending request',
    );
  });
  it('starts an opted-out project manager and worker past occupied QUARK slots without consuming slots or reordering their conversation', async () => {
    const finishes = new Map<string, () => void>();
    const request = DemoProvider.prototype.request;
    const calls = vi.spyOn(DemoProvider.prototype, 'request').mockImplementation(async function (
      this: DemoProvider,
      method,
      raw,
    ) {
      if (method !== 'turn/start') return request.call(this, method, raw);
      const turnId = randomUUID();
      finishes.set(this.threadId, () => {
        this.emit('notification', 'turn/completed', {
          threadId: this.threadId,
          turn: { id: turnId, status: 'completed' },
        });
      });
      return { turn: { id: turnId, status: 'inProgress' } };
    });
    settings(false, 1);
    const first = store.enqueue(manager, randomUUID(), 'Occupy the one QUARK slot');
    runtime.kick();
    await vi.waitFor(() => expect(store.run(first.id).status).toBe('running'));
    const offRoot = join(root, 'off');
    mkdirSync(offRoot);
    const off = store.register(offRoot, 'Opted out', '');
    runtime.quark.saveProjectPolicy(off.id, {
      key: randomUUID(),
      enabled: false,
      expectedRevision: 0,
    });
    const worker = store.addAgent({
      projectId: off.id,
      parentId: off.managerId,
      taskId: null,
      role: 'researcher',
      name: 'Opted-out worker',
      cwd: offRoot,
    });
    const resumed = store.enqueue(
      off.managerId,
      randomUUID(),
      'Continue the saved request',
      'resume',
    );
    const later = store.enqueue(off.managerId, randomUUID(), 'Later owner request');
    const child = store.enqueue(
      worker.id,
      randomUUID(),
      'Independent worker',
      'delegation',
      off.managerId,
    );
    const onPeer = store.addManager(store.agent(manager).projectId, 'On peer', 'Independent work');
    const queued = store.enqueue(onPeer.id, randomUUID(), 'Still respects the one QUARK slot');
    runtime.kick();
    await vi.waitFor(() => {
      expect(store.run(resumed.id).status).toBe('running');
      expect(store.run(child.id).status).toBe('running');
    });
    expect(store.run(later.id).status).toBe('queued');
    expect(store.run(queued.id).status).toBe('queued');
    expect(calls.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(3);
    finishes.get(store.agent(manager).threadId!)!();
    await vi.waitFor(() => expect(store.run(queued.id).status).toBe('running'));
    expect(store.run(resumed.id).status).toBe('running');
    expect(store.run(child.id).status).toBe('running');
    expect(store.run(later.id).status).toBe('queued');
    expect(calls.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(4);
  });
  it.each([
    'global pause',
    'failed agent',
    'job hold',
    'native control',
    'task workspace',
  ] as const)('project opt-out preserves %s before provider preparation', async (guard) => {
    const projectId = store.agent(manager).projectId;
    runtime.quark.saveProjectPolicy(projectId, {
      key: randomUUID(),
      enabled: false,
      expectedRevision: 0,
    });
    settings(guard === 'global pause', 1);
    const run = store.enqueue(manager, randomUUID(), 'Preserve explicit ownership');
    if (guard === 'failed agent') store.updateAgent(manager, { status: 'failed' });
    if (guard === 'job hold') store.setSetting(`pulsar:held:${run.id}`, true);
    if (guard === 'native control') runtime.externalControl.add(manager);
    if (guard === 'task workspace') {
      const task = store.addTask(projectId, {
        title: 'Owned workspace',
        goal: 'One writer',
        acceptance: 'Evidence',
        parentId: null,
      });
      store.updateAgent(manager, { taskId: task.id });
      const peer = store.addAgent({
        projectId,
        parentId: manager,
        taskId: task.id,
        role: 'implementer',
        name: 'Workspace owner',
        cwd: root,
      });
      runtime.executing.add(peer.id);
    }
    const starts = vi.spyOn(DemoProvider.prototype, 'request');
    await (runtime as unknown as { drain(): Promise<void> }).drain();
    expect(store.run(run.id).status).toBe('queued');
    expect(starts.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
    expect(runtime.pulsar.lease(run.id)).toBeNull();
    runtime.executing.clear();
    runtime.externalControl.clear();
  });
  it('explains an actual paused allowance grant instead of a slot wait when slots are free', () => {
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
    const budget = runtime.quark.saveBudget({
      key: randomUUID(),
      projectId: store.agent(manager).projectId,
      taskId: null,
      provider: 'codex',
      windowId: 'primary',
      limitPercent: 50,
    });
    store.setSetting(`quark:budget-paused:${budget.id}`, {
      at: new Date(now).toISOString(),
      runId: randomUUID(),
    });
    settings(false, 4);
    const run = store.enqueue(manager, randomUUID(), 'Saved news run');
    // Same authority as the server route: QUARK's existing admission decision.
    const hold = (queued: PrivateRun) => {
      const decision = runtime.pulsar.decision(queued);
      return decision.eligible ? null : decision.reason;
    };
    const explanation = () =>
      schedulerStatus(store, runtime.externalControl, hold).items[0].explanation;
    expect(store.runs(['running'])).toHaveLength(0);
    expect(explanation()).toBe(
      'This allowance grant is paused. The owner must explicitly continue saved work.',
    );
    store.updateAgent(manager, { status: 'interrupted' });
    expect(explanation()).toContain('allowance grant is paused');
    expect(schedulerStatus(store, runtime.externalControl).items[0].explanation).toContain(
      'pending request',
    );
    store.updateAgent(manager, { status: 'idle' });
    runtime.externalControl.add(manager);
    expect(explanation()).toContain('native terminal');
    runtime.externalControl.delete(manager);
    settings(true, 4);
    expect(explanation()).toBe('New queued work is paused.');
    store.updateRun(run.id, {
      queueEdit: { clientId: randomUUID(), text: 'Revision', state: 'editing' },
    });
    expect(explanation()).toContain('Held for editing');
    store.updateRun(run.id, { queueEdit: null, status: 'running' });
    expect(explanation()).toBe('Already started; queue settings do not interrupt it.');
  });
});
