import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { repoRoot } from './paths.js';
import { Runtime } from './runtime.js';
import { Store, type PrivateRun } from './store.js';
import { createServer } from './server.js';

const eventLoopTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
let root: string, store: Store, runtime: Runtime, manager: string;

beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/runtime-wakeups-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  manager = store.register(root, 'Wakeup fixture', '').managerId;
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  runtime = new Runtime(store, root, 'never-launch-provider', async () => new DemoProvider());
  await runtime.initialize();
  await eventLoopTurn();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it('retains streamed text without rescheduling every delta, and coalesces real queue changes', async () => {
  const sync = vi.spyOn(runtime.quark, 'sync');
  const id = randomUUID();
  for (let i = 0; i < 200; i++)
    store.entry({
      id,
      agentId: manager,
      runId: null,
      kind: 'assistant',
      title: 'Response',
      text: `Reply chunk ${i}`,
      status: 'streaming',
      createdAt: new Date().toISOString(),
    });
  await eventLoopTurn();
  expect(store.savedEntry(manager, id)?.text).toBe('Reply chunk 199');
  expect(sync).not.toHaveBeenCalled();

  for (let i = 0; i < 20; i++) store.enqueue(manager, randomUUID(), `Queued message ${i}`);
  await eventLoopTurn();
  await eventLoopTurn();
  expect(store.runs().filter((run) => run.status === 'queued')).toHaveLength(20);
  expect(sync).toHaveBeenCalledTimes(1);
});

it('yields to the event loop when a drain requests another pass', async () => {
  let passes = 0;
  const sync = vi.spyOn(runtime.quark, 'sync').mockImplementation(() => {
    passes++;
    // Bound the old failure mode so a regression fails instead of hanging the suite.
    if (passes < 20) runtime.kick();
  });
  runtime.kick();
  await eventLoopTurn();
  // A microtask rerun chain consumes all 20 passes before this callback can run.
  expect(passes).toBe(1);
  sync.mockRestore();
  await eventLoopTurn();
});

it('preserves a wakeup arriving while maintenance awaits without overlapping drains', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const maintain = vi.spyOn(runtime.conversationSearch, 'maintain').mockReturnValueOnce(pending);
  const sync = vi.spyOn(runtime.quark, 'sync');
  runtime.kick();
  await eventLoopTurn();
  const run = store.enqueue(manager, randomUUID(), 'Arrived during maintenance');
  await eventLoopTurn();
  expect(sync).toHaveBeenCalledTimes(1);
  expect(maintain).toHaveBeenCalledTimes(1);
  release();
  await eventLoopTurn();
  await eventLoopTurn();
  expect(sync).toHaveBeenCalledTimes(2);
  expect(store.run(run.id).status).toBe('queued');
});

it.each(['sync', 'maintenance'] as const)(
  'keeps saved data and queue controls available after a %s failure, then recovers without replay',
  async (failure) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const clock = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(clock);
    const broken =
      failure === 'sync'
        ? vi.spyOn(runtime.quark, 'sync').mockImplementation(() => {
            throw new Error('fixture failure');
          })
        : vi
            .spyOn(runtime.conversationSearch, 'maintain')
            .mockRejectedValue(new Error('fixture failure'));
    const run = store.enqueue(manager, randomUUID(), 'Keep this queued message');
    runtime.health = { ready: false, version: '', message: 'Provider unavailable' };
    const app = await createServer(store, runtime, { port: 4998, ownsRuntime: false });
    const headers = { host: '127.0.0.1:4998', origin: 'http://127.0.0.1:4998' };
    try {
      await eventLoopTurn();
      await eventLoopTurn();
      expect(runtime.schedulingError).toContain('retries automatically');
      for (let i = 0; i < 100; i++) runtime.kick();
      await eventLoopTurn();
      expect(broken).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
      for (const url of [
        '/api/health',
        '/api/snapshot',
        `/api/agents/${manager}`,
        '/api/pulsar',
        '/api/work-items',
      ]) {
        const response = await app.inject({ url, headers });
        expect(response.statusCode, url).toBe(200);
      }
      const snapshot = (await app.inject({ url: '/api/snapshot', headers })).json();
      expect(snapshot.schedulingError).toBe(runtime.schedulingError);
      expect(snapshot.provider.ready).toBe(false);
      const saved = (await app.inject({ url: `/api/agents/${manager}`, headers })).json();
      expect(
        saved.entries.some((entry: { text: string }) => entry.text === 'Keep this queued message'),
      ).toBe(true);
      broken.mockRestore();
      time.mockReturnValue(clock + 5001);
      runtime.kick();
      await eventLoopTurn();
      await eventLoopTurn();
      expect(runtime.schedulingError).toBeNull();
      expect(store.run(run.id).status).toBe('queued');
      expect(store.runs().filter((r) => r.agentId === manager)).toHaveLength(1);
      expect(store.agent(manager).threadId).toBeNull();
    } finally {
      await app.close();
    }
  },
);

it('starts a ready provider while another provider model lookup is stalled', async () => {
  const claude = store.addAgent({
    projectId: store.agent(manager).projectId,
    parentId: null,
    taskId: null,
    role: 'manager',
    name: 'Claude fixture',
    cwd: root,
    provider: 'claude',
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepare = vi.spyOn(runtime.modelPolicy, 'prepare').mockImplementation(async (agent) => {
    if (agent.provider === 'codex') await gate;
    return agent;
  });
  const started: string[] = [];
  vi.spyOn(
    runtime as unknown as { startRun(run: PrivateRun): Promise<void> },
    'startRun',
  ).mockImplementation(async (run) => {
    started.push(run.agentId);
    store.updateRun(run.id, { status: 'running' });
  });
  const first = store.enqueue(manager, randomUUID(), 'Codex waits for discovery');
  store.enqueue(claude.id, randomUUID(), 'Claude can start independently');
  store.setSetting('scheduler:settings', { paused: false, maxConcurrent: 4 });
  try {
    runtime.kick();
    await expect.poll(() => started).toEqual([claude.id]);
    expect(store.run(first.id).status).toBe('queued');
    expect(prepare.mock.calls.filter(([agent]) => agent.id === manager)).toHaveLength(1);
  } finally {
    release();
  }
  await expect.poll(() => started).toEqual([claude.id, manager]);
});

it('retains queued work through temporary discovery errors and retries without a manual resume', async () => {
  const { Conflict } = await import('./store.js');
  const clock = Date.now();
  const time = vi.spyOn(Date, 'now').mockReturnValue(clock);
  const prepare = vi
    .spyOn(runtime.modelPolicy, 'prepare')
    .mockRejectedValue(new Conflict('Temporary lookup failure', 'MODEL_DISCOVERY_WAIT'));
  const started: string[] = [];
  vi.spyOn(
    runtime as unknown as { startRun(run: PrivateRun): Promise<void> },
    'startRun',
  ).mockImplementation(async (run) => {
    started.push(run.id);
    store.updateRun(run.id, { status: 'running' });
  });
  const run = store.enqueue(manager, randomUUID(), 'Retain this during a provider outage');
  store.setSetting('scheduler:settings', { paused: false, maxConcurrent: 4 });
  runtime.kick();
  await expect.poll(() => store.getSetting(`model-policy:wait:${run.id}`)).toBe(clock + 60_000);
  expect(store.run(run.id).status).toBe('queued');
  expect(runtime.pulsar.decision(store.run(run.id)).reason).toContain('retry automatically');
  runtime.kick();
  await eventLoopTurn();
  await eventLoopTurn();
  expect(prepare).toHaveBeenCalledTimes(1);
  prepare.mockImplementation(async (agent) => agent);
  time.mockReturnValue(clock + 60_001);
  runtime.kick();
  await expect.poll(() => started).toEqual([run.id]);
  expect(store.getSetting(`model-policy:wait:${run.id}`)).toBeNull();
});
