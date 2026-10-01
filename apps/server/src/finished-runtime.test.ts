import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type PrivateAgent } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { ClaudeSession, parseClaudeIdentity } from './claude-session.js';

let root: string, store: Store, runtime: Runtime, worker: PrivateAgent;
const factory = vi.fn(async () => new DemoProvider());
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function sweep() {
  vi.setSystemTime(Date.now() + 31_000);
  runtime.kick();
  await tick();
}
function helper() {
  const child = store.addAgent({
    projectId: worker.projectId,
    taskId: worker.taskId,
    parentId: worker.id,
    name: 'Observed helper',
    role: 'researcher',
    cwd: root,
  });
  return store.updateAgent(child.id, { nativeRootId: worker.id, threadId: randomUUID() });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  root = mkdtempSync(join(tmpdir(), 'swa-finished-runtime-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  store.setSetting('pulsar:policy', { enabled: false });
  const project = store.register(root, 'Saved work', '');
  const task = store.addTask(project.id, {
    title: 'Finished result',
    goal: 'Retained work',
    acceptance: 'Recorded',
    parentId: null,
  });
  store.updateTask(task.id, { status: 'done', review: 'approve', reviewedCommit: 'saved-commit' });
  worker = store.addAgent({
    projectId: project.id,
    taskId: task.id,
    parentId: project.managerId,
    name: 'Finished worker',
    role: 'researcher',
    cwd: root,
  });
  worker = store.updateAgent(worker.id, {
    threadId: randomUUID(),
    model: 'demo',
    modelSelection: 'exact',
  });
  factory.mockClear();
  runtime = new Runtime(store, root, 'never-start-native', factory);
});
afterEach(async () => {
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('releases the finished owning group once, preserves files/history/review, and does not reconnect it on restore', async () => {
  const child = helper();
  const client = await runtime.client(worker);
  await runtime.client(child);
  const close = vi.spyOn(client, 'close');
  const manager = await runtime.client(store.agent(worker.parentId!));
  const managerClose = vi.spyOn(manager, 'close');
  writeFileSync(join(root, 'result.txt'), 'Retained result');
  store.entry({
    id: randomUUID(),
    agentId: worker.id,
    runId: null,
    kind: 'assistant',
    title: worker.name,
    text: 'Why this choice was made.',
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  const saved = {
    worker: store.agent(worker.id),
    child: store.agent(child.id),
    task: store.task(worker.taskId!),
    entries: store.entries(worker.id),
  };
  await sweep();
  expect(close).toHaveBeenCalledOnce();
  expect(managerClose).not.toHaveBeenCalled();
  expect(runtime.clients.has(worker.id)).toBe(false);
  expect(runtime.clients.has(child.id)).toBe(false);
  expect(store.agent(worker.id)).toEqual(saved.worker);
  expect(store.agent(child.id)).toEqual(saved.child);
  expect(store.task(worker.taskId!)).toEqual(saved.task);
  expect(store.entries(worker.id)).toEqual(saved.entries);
  expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('Retained result');
  await sweep();
  const opened = factory.mock.calls.length;
  await expect(runtime.restoreSessions([worker.id, child.id])).resolves.toEqual([
    expect.objectContaining({
      agentId: worker.id,
      state: 'ready',
      message: expect.stringContaining('Finished work'),
    }),
  ]);
  expect(factory).toHaveBeenCalledTimes(opened);
  expect(store.events(0, 1000).filter((e) => e.type === 'runtime.released')).toHaveLength(1);
  await runtime.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  runtime = new Runtime(store, root, 'never-start-native', factory);
  await runtime.restoreSessions([worker.id]);
  expect(factory).toHaveBeenCalledTimes(opened);
  expect(store.agent(worker.id).threadId).toBe(saved.worker.threadId);
  expect(store.task(worker.taskId!)).toEqual(saved.task);
  expect(store.entries(worker.id)).toEqual(saved.entries);
});

it.each([
  'open task',
  'native input',
  'active helper',
  'queued input',
  'approval',
  'quota hold',
  'discussion',
])('keeps the runtime while it has %s', async (reason) => {
  const client = await runtime.client(worker);
  const close = vi.spyOn(client, 'close');
  if (reason === 'open task') store.updateTask(worker.taskId!, { status: 'working' });
  if (reason === 'native input') runtime.externalControl.add(worker.id);
  if (reason === 'active helper') store.updateAgent(helper().id, { status: 'running' });
  if (reason === 'queued input') store.enqueue(worker.id, randomUUID(), 'Retained unsent input');
  if (reason === 'approval')
    store.addApproval(worker.id, {
      requestId: 1,
      kind: 'command',
      title: 'Original permission',
      details: '{}',
      questions: [],
      params: {},
    });
  if (reason === 'quota hold') {
    const run = store.enqueue(worker.id, randomUUID(), 'Retained paused work');
    store.updateRun(run.id, { status: 'interrupted' });
    store.updateAgent(worker.id, { status: 'idle' });
    runtime.quark.hold(store.run(run.id), 'Owner continuation needed', false, 'manual');
  }
  if (reason === 'discussion')
    store.updateAgent(worker.id, {
      interview: {
        sourceAgentId: worker.parentId!,
        sourceTaskId: worker.taskId,
        capturedAt: new Date().toISOString(),
        continuity: 'saved-evidence',
      },
    });
  const before = { agents: store.agents(), runs: store.runs(), approvals: store.approvals() };
  await sweep();
  expect(close).not.toHaveBeenCalled();
  expect(runtime.clients.get(worker.id)).toBe(client);
  expect({ agents: store.agents(), runs: store.runs(), approvals: store.approvals() }).toEqual(
    before,
  );
});

it('waits for history reads and makes a new read wait for an in-progress close', async () => {
  const client = await runtime.client(worker);
  let finishRead!: () => void;
  const reading = runtime.withCodexHistory(
    worker,
    async () =>
      new Promise<void>((resolve) => {
        finishRead = resolve;
      }),
  );
  await tick();
  const originalClose = client.close.bind(client);
  const close = vi.spyOn(client, 'close');
  await sweep();
  expect(close).not.toHaveBeenCalled();
  finishRead();
  await reading;
  let finishClose!: () => void;
  close.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    await originalClose();
  });
  await sweep();
  expect(close).toHaveBeenCalledOnce();
  const read = vi.fn(async () => 'Saved history');
  const nextRead = runtime.withCodexHistory(worker, read);
  await tick();
  expect(read).not.toHaveBeenCalled();
  expect(factory).toHaveBeenCalledOnce();
  finishClose();
  await expect(nextRead).resolves.toBe('Saved history');
  expect(factory).toHaveBeenCalledTimes(2);
  expect(store.agent(worker.id).threadId).toBe(worker.threadId);
});

it('rechecks a later worker if a hold arrives while an earlier worker is closing', async () => {
  const client = await runtime.client(worker);
  const later = store.addAgent({
    projectId: worker.projectId,
    taskId: worker.taskId,
    parentId: worker.parentId,
    name: 'Later finished worker',
    role: 'researcher',
    cwd: root,
  });
  const laterClient = await runtime.client(later);
  const laterClose = vi.spyOn(laterClient, 'close');
  let finishClose!: () => void;
  vi.spyOn(client, 'close').mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
  );
  await sweep();
  const run = store.enqueue(later.id, randomUUID(), 'Saved continuation');
  store.updateRun(run.id, { status: 'interrupted' });
  store.updateAgent(later.id, { status: 'idle' });
  runtime.quark.hold(store.run(run.id), 'Retain paused work', false, 'manual');
  runtime.kick();
  finishClose();
  await tick();
  expect(laterClose).not.toHaveBeenCalled();
  expect(runtime.clients.get(later.id)).toBe(laterClient);
  expect(runtime.quark.holds()).toEqual([expect.objectContaining({ runId: run.id })]);
});

it('retries a failed owned close without clearing history or reporting work failure', async () => {
  const client = await runtime.client(worker);
  const close = vi
    .spyOn(client, 'close')
    .mockRejectedValueOnce(new Error('Private fixture diagnostic'));
  await sweep();
  expect(runtime.clients.get(worker.id)).toBe(client);
  expect(store.agent(worker.id)).toEqual(worker);
  expect(store.events(0, 1000).filter((e) => e.type === 'runtime.release_failed')).toHaveLength(1);
  await sweep();
  expect(close).toHaveBeenCalledTimes(2);
  expect(runtime.clients.has(worker.id)).toBe(false);
  expect(store.entries(worker.id)).toHaveLength(0);
});

it('releases a finished Claude process through its existing session close without submitting input', async () => {
  worker = store.addAgent({
    projectId: worker.projectId,
    taskId: worker.taskId,
    parentId: worker.parentId,
    provider: 'claude',
    name: 'Finished Claude worker',
    role: 'researcher',
    cwd: root,
  });
  worker = store.updateAgent(worker.id, { model: 'default' });
  await runtime.close();
  const identity = parseClaudeIdentity({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'fixture@example.invalid',
    orgId: 'fixture',
  });
  let session!: ClaudeSession;
  const close = vi.fn(async () => {});
  const submit = vi.fn();
  runtime = new Runtime(store, root, 'never-start-native', factory, {
    identity: async () => identity,
    inspect: async () => ({
      identity,
      models: [
        {
          value: 'default',
          displayName: 'Fixture',
          description: '',
          supportsEffort: true,
          supportedEffortLevels: ['medium'],
        },
      ],
    }),
    session: (options) => {
      session = new ClaudeSession(options);
      session.close = close;
      session.submit = submit;
      return session;
    },
  });
  await runtime.claude.prepare(worker);
  const saved = store.agent(worker.id);
  await sweep();
  expect(close).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
  expect(runtime.claude.get(worker.id)).toBeUndefined();
  expect(store.agent(worker.id)).toEqual(saved);
  await runtime.restoreSessions([worker.id]);
  expect(runtime.claude.get(worker.id)).toBeUndefined();
});

it('archives a proven app-owned finished session, without changing its saved work', async () => {
  store.setSetting(`codex:owned:${worker.threadId}`, worker.id);
  const client = await runtime.client(worker);
  const request = vi.spyOn(client, 'request');
  const saved = store.agent(worker.id);
  await sweep();
  expect(request).toHaveBeenCalledWith('thread/archive', { threadId: worker.threadId });
  expect(store.agent(worker.id)).toEqual(saved);
  expect(store.events(0, 1000).some((e) => e.type === 'session.archived')).toBe(true);
});

it('does not archive imported sessions or active workers; archive failure does not fail work', async () => {
  const client = await runtime.client(worker);
  const request = vi.spyOn(client, 'request');
  await sweep();
  expect(request).not.toHaveBeenCalledWith('thread/archive', expect.anything());
  const replacement = await runtime.client(worker);
  store.setSetting(`codex:owned:${worker.threadId}`, worker.id);
  store.updateAgent(worker.id, { status: 'running', turnId: 'active' });
  const again = vi.spyOn(replacement, 'request');
  await sweep();
  expect(again).not.toHaveBeenCalledWith('thread/archive', expect.anything());
  store.updateAgent(worker.id, { status: 'idle', turnId: null });
  again.mockRejectedValue(new Error('Archive unavailable'));
  await sweep();
  expect(store.task(worker.taskId!).status).toBe('done');
  expect(runtime.clients.has(worker.id)).toBe(false);
  expect(store.events(0, 1000).some((e) => e.type === 'session.archive_failed')).toBe(true);
});
