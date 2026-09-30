import { modelFixture } from './model-policy.fixture.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';

const fixtures: { root: string; store: Store; runtime: Runtime }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.runtime.close();
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

it('reconnects five persisted provider identities after restart without replay or a model turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dock-restart-'));
  let store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(root, 'Restart fixture', '');
  const agents = [
    store.agent(project.managerId),
    ...Array.from({ length: 4 }, (_, index) =>
      store.addManager(project.id, `Module ${index}`, `Scope ${index}`),
    ),
  ];
  const ids = agents.map((agent) => agent.id);
  const threads = ids.map(() => randomUUID());
  for (const [index, agent] of agents.entries()) {
    store.updateAgent(agent.id, {
      threadId: threads[index],
      status: 'running',
      model: 'saved-model',
      effort: 'high',
    });
    const run = store.enqueue(agent.id, randomUUID(), 'An action with an uncertain outcome');
    store.updateRun(run.id, { status: 'running', turnId: randomUUID() });
  }
  const runIds = store.runs().map((run) => run.id);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const calls: { method: string; params: unknown }[] = [];
  const runtime = new Runtime(store, root, 'codex', async () => {
    const provider = new DemoProvider();
    const request = provider.request.bind(provider);
    vi.spyOn(provider, 'request').mockImplementation(async (method, params) => {
      calls.push({ method, params });
      return request(method, params);
    });
    return provider;
  });
  fixtures.push({ root, store, runtime });
  await runtime.initialize();
  const result = await runtime.restoreSessions(ids);
  expect(result.map((item) => item.state)).toEqual(Array(5).fill('inspect'));
  expect(store.runs().map((run) => run.id)).toEqual(runIds);
  expect(store.runs().every((run) => run.status === 'interrupted')).toBe(true);
  expect(store.agents().map((agent) => agent.threadId)).toEqual(threads);
  expect(calls.filter((call) => call.method === 'thread/resume')).toHaveLength(5);
  expect(
    calls.filter((call) => call.method === 'thread/resume').map((call) => call.params),
  ).toEqual(
    threads.map((threadId) =>
      expect.objectContaining({
        threadId,
        model: 'saved-model',
        config: expect.objectContaining({ model_reasoning_effort: 'high' }),
      }),
    ),
  );
  expect(
    calls.some((call) => ['turn/start', 'turn/steer', 'thread/start'].includes(call.method)),
  ).toBe(false);
});

it('keeps a missing provider history unavailable and does not replace it or start fresh agents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dock-restart-'));
  const store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(root, 'Unavailable fixture', '');
  const saved = store.addManager(project.id, 'Saved', '');
  store.updateAgent(saved.id, { threadId: 'saved-thread' });
  const provider = new DemoProvider();
  const original = provider.request.bind(provider);
  const request = vi.spyOn(provider, 'request').mockImplementation(async (method, params) => {
    if (method === 'thread/resume') throw new Error('not found');
    return original(method, params);
  });
  const runtime = new Runtime(store, root, 'codex', async () => provider);
  fixtures.push({ root, store, runtime });
  const result = await runtime.restoreSessions([project.managerId, saved.id]);
  expect(result.map((item) => item.state)).toEqual(['ready', 'unavailable']);
  expect(store.agent(saved.id).threadId).toBe('saved-thread');
  expect(
    request.mock.calls.some(([method]) => ['thread/start', 'turn/start'].includes(method)),
  ).toBe(false);
  expect(store.runs()).toHaveLength(0);
});

it('bounds simultaneous device restores to two reconnects and deduplicates the same saved identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dock-restart-'));
  const store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(root, 'Concurrent recovery', '');
  const agents = [
    store.agent(project.managerId),
    ...Array.from({ length: 5 }, (_, index) => store.addManager(project.id, `Module ${index}`, '')),
  ];
  for (const agent of agents) store.updateAgent(agent.id, { threadId: randomUUID() });
  let active = 0;
  let peak = 0;
  let resumed = 0;
  const runtime = new Runtime(store, root, 'codex', async () => {
    const provider = new DemoProvider();
    const request = provider.request.bind(provider);
    vi.spyOn(provider, 'request').mockImplementation(async (method, params) => {
      if (method !== 'thread/resume') return request(method, params);
      active++;
      peak = Math.max(peak, active);
      resumed++;
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await request(method, params);
      } finally {
        active--;
      }
    });
    return provider;
  });
  fixtures.push({ root, store, runtime });
  const ids = agents.map((agent) => agent.id);
  const results = await Promise.all([
    runtime.restoreSessions(ids.slice(0, 2)),
    runtime.restoreSessions(ids.slice(2, 4)),
    runtime.restoreSessions(ids.slice(4)),
    runtime.restoreSessions(ids.slice(0, 1)),
  ]);
  expect(results.flat().every((item) => item.state === 'connected')).toBe(true);
  expect(peak).toBe(2);
  expect(resumed).toBe(6);
  expect(store.runs()).toHaveLength(0);
});
