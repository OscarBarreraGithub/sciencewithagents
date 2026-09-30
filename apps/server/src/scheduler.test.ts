import { modelFixture } from './model-policy.fixture.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
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
    const calls = vi.spyOn(DemoProvider.prototype, 'request');
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
    await vi.waitFor(() => expect(store.run(first.id).status).toBe('completed'));
    expect(store.run(second.id).status).toBe('queued');
    expect(store.run(third.id).status).toBe('queued');
    settings(false, 1);
    runtime.kick();
    await vi.waitFor(() => expect(store.run(second.id).status).toBe('running'));
    expect(store.run(third.id).status).toBe('queued');
    await vi.waitFor(() => expect(store.run(third.id).status).toBe('completed'));
    const starts = store
      .events()
      .filter((event) => event.type === 'run.running')
      .map((event) => (event.data as { id: string }).id);
    expect([...new Set(starts)]).toEqual([first.id, second.id, third.id]);
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
});
