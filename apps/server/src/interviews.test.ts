import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Store, type PrivateAgent } from './store.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { repoRoot } from './paths.js';
import { recordCodexUsage } from './usage.js';

let directory: string, store: Store, runtime: Runtime, app: FastifyInstance, worker: PrivateAgent;
let configure: ((client: DemoProvider) => void) | undefined;
const headers = { host: '127.0.0.1:4999', origin: 'http://127.0.0.1:4999' };
const post = (path: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/api${path}`, headers, payload });
beforeEach(async () => {
  configure = undefined;
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  directory = mkdtempSync(join(repoRoot, 'data/tests/interviews-'));
  store = new Store(join(directory, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(directory, 'Past work', '');
  const task = store.addTask(project.id, {
    title: 'Finished change',
    goal: 'An outcome',
    acceptance: 'Checked',
    parentId: null,
  });
  store.updateTask(task.id, {
    status: 'integrated',
    review: 'Independent approval',
    reviewedCommit: 'approved-commit',
  });
  worker = store.addAgent({
    projectId: project.id,
    taskId: task.id,
    parentId: project.managerId,
    name: 'Original builder',
    role: 'implementer',
    cwd: directory,
  });
  worker = store.updateAgent(worker.id, {
    model: 'demo',
    modelSelection: 'exact',
    checkpoint: 'Used an index to avoid repeated scans.',
  });
  runtime = new Runtime(store, directory, 'codex', async () => {
    const client = new DemoProvider();
    configure?.(client);
    return client;
  });
  app = await createServer(store, runtime, { port: 4999 });
});

function nativeSource() {
  worker = store.updateAgent(worker.id, { threadId: randomUUID() });
  const last = store.enqueue(worker.id, randomUUID(), 'Original finished request');
  store.updateRun(last.id, { status: 'completed', turnId: 'recorded-final-turn' });
  worker = store.updateAgent(worker.id, { status: 'idle', turnId: null });
  return worker.threadId!;
}

it('offers Claude native continuity only for its latest completed root reply and keeps the original account', async () => {
  worker = store.updateAgent(worker.id, { provider: 'claude' });
  nativeSource();
  const run = store.runs().find((item) => item.agentId === worker.id)!;
  const messageId = randomUUID();
  const boundary = { sessionId: worker.threadId, runId: run.id, messageId };
  const key = `claude:discussion-boundary:${worker.id}`;
  const detail = async () =>
    (await app.inject({ url: `/api/agents/${worker.id}`, headers })).json();
  store.setSetting(`claude:account:${worker.id}`, 'a'.repeat(64));
  for (const invalid of [
    null,
    { ...boundary, messageId: null },
    { ...boundary, sessionId: randomUUID() },
    { ...boundary, runId: randomUUID() },
  ]) {
    store.setSetting(key, invalid);
    expect((await detail()).nativeDiscussion).toBeUndefined();
  }
  store.setSetting(key, boundary);
  store.updateRun(run.id, { status: 'failed' });
  expect((await detail()).nativeDiscussion).toBeUndefined();
  store.updateRun(run.id, { status: 'completed' });
  expect((await detail()).nativeDiscussion).toBe('available');
  const original = store.agent(worker.id),
    task = store.task(worker.taskId!);
  const created = await post(`/agents/${worker.id}/interviews`, {
    key: randomUUID(),
    continuity: 'native-fork',
  });
  expect(created.statusCode).toBe(200);
  expect(created.json().interview).toMatchObject({
    continuity: 'native-fork',
    sourceThreadId: worker.threadId,
    sourceMessageId: messageId,
  });
  expect(store.getSetting(`claude:account:${created.json().id}`)).toBe('a'.repeat(64));
  expect(store.agent(worker.id)).toEqual(original);
  expect(store.task(task.id)).toEqual(task);
  const copyId = created.json().id,
    threadId = randomUUID();
  store.updateAgent(copyId, { threadId });
  const copied = async () => (await app.inject({ url: `/api/agents/${copyId}`, headers })).json();
  expect((await copied()).nativeDiscussion).toBeUndefined(); // Reserved identity is not a copied history.
  store.setSetting(`claude:started:${threadId}`, true);
  expect((await copied()).nativeDiscussion).toBe('prepared');
  store.updateAgent(worker.id, {
    nativeRootId: store.project(worker.projectId).managerId,
    nativePath: 'helper-id',
  });
  expect((await detail()).nativeDiscussion).toBeUndefined();
});

it('native discussion forks once through the recorded turn, clears only its inherited goal and retains task accounting', async () => {
  const sourceId = nativeSource(),
    branchId = randomUUID();
  const task = store.task(worker.taskId!),
    original = store.agent(worker.id);
  const calls: { method: string; params: any }[] = [];
  configure = (client) => {
    const request = client.request.bind(client);
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: { status: 'paused' } };
      if (method === 'thread/fork')
        return { thread: { id: branchId, forkedFromId: sourceId, turns: [] } };
      return request(method, params);
    });
  };
  const input = { key: randomUUID(), continuity: 'native-fork' };
  const created = await post(`/agents/${worker.id}/interviews`, input);
  expect(created.statusCode).toBe(200);
  const discussion = created.json();
  expect(discussion.interview).toMatchObject({
    continuity: 'native-fork',
    sourceThreadId: sourceId,
    sourceTurnId: 'recorded-final-turn',
  });
  expect(calls).toEqual([]);
  expect((await post(`/agents/${worker.id}/interviews`, input)).json()).toEqual(discussion);
  // A caller cannot reuse an old creation receipt to change its continuity choice.
  expect((await post(`/agents/${worker.id}/interviews`, { key: input.key })).statusCode).toBe(409);
  const reply = await post(`/agents/${discussion.id}/messages`, {
    key: randomUUID(),
    text: 'Why this choice?',
  });
  expect(reply.statusCode).toBe(202);
  await vi.waitFor(() => expect(store.run(reply.json().id).status).toBe('completed'));
  const fork = calls.find((call) => call.method === 'thread/fork')!;
  expect(fork.params).toMatchObject({
    threadId: sourceId,
    lastTurnId: 'recorded-final-turn',
    sandbox: 'read-only',
    excludeTurns: true,
    deferGoalContinuation: true,
  });
  expect(fork.params.developerInstructions).toContain('native copy');
  expect(calls.filter((call) => call.method === 'thread/goal/clear')).toEqual([
    { method: 'thread/goal/clear', params: { threadId: branchId } },
  ]);
  expect(calls.findIndex((call) => call.method === 'thread/goal/clear')).toBeLessThan(
    calls.findIndex((call) => call.method === 'turn/start'),
  );
  expect(store.agent(worker.id)).toEqual(original);
  expect(store.task(task.id)).toEqual(task);
  expect(store.agent(discussion.id).threadId).toBe(branchId);
  expect(runtime.quark.runs().find((run) => run.runId === reply.json().id)?.taskId).toBe(task.id);
  const counters = (inputTokens: number, outputTokens: number) => ({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
  });
  recordCodexUsage(store, discussion.id, {
    threadId: branchId,
    turnId: store.run(reply.json().id).turnId,
    tokenUsage: { total: counters(8000, 2100), last: counters(80, 20) },
  });
  runtime.quark.sync();
  // The copied conversation's old token totals are not new project spending.
  expect(runtime.quark.runs().find((run) => run.runId === reply.json().id)).toMatchObject({
    basis: 'partial',
    tokens: { totalTokens: 100 },
  });
  await expect(runtime.tool(discussion.id, randomUUID(), 'dock_delegate', {})).rejects.toThrow(
    'only read saved evidence',
  );
  // A new provider connection resumes the recorded branch, without another fork.
  await runtime.clients.get(discussion.id)!.close();
  await runtime.attach(discussion.id);
  expect(calls.filter((call) => call.method === 'thread/fork')).toHaveLength(1);
  expect(
    calls
      .filter((call) => call.method === 'thread/resume')
      .every((call) => call.params.threadId === branchId),
  ).toBe(true);
});

it('unknown native fork outcomes never replay or silently switch to saved evidence', async () => {
  nativeSource();
  let forks = 0;
  configure = (client) => {
    const request = client.request.bind(client);
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'thread/fork') {
        forks++;
        throw new Error('Lost native acknowledgement');
      }
      return request(method, params);
    });
  };
  const discussion = (
    await post(`/agents/${worker.id}/interviews`, { key: randomUUID(), continuity: 'native-fork' })
  ).json();
  await expect(runtime.attach(discussion.id)).rejects.toThrow('Lost native acknowledgement');
  await app.close();
  store = new Store(join(directory, 'dock.sqlite'));
  runtime = new Runtime(store, directory, 'codex', async () => {
    const client = new DemoProvider();
    configure?.(client);
    return client;
  });
  app = await createServer(store, runtime, { port: 4999 });
  await expect(runtime.attach(discussion.id)).rejects.toThrow('uncertain or failed');
  expect(forks).toBe(1);
  expect(store.agent(discussion.id).threadId).toBeNull();
  expect(store.agent(discussion.id).interview?.continuity).toBe('native-fork');
});

it('native discussions require a real saved boundary and refuse active inherited goals before forking', async () => {
  expect(
    (
      await post(`/agents/${worker.id}/interviews`, {
        key: randomUUID(),
        continuity: 'native-fork',
      })
    ).statusCode,
  ).toBe(409);
  nativeSource();
  const requests: string[] = [];
  configure = (client) => {
    const request = client.request.bind(client);
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      requests.push(method);
      if (method === 'thread/goal/get') return { goal: { status: 'active' } };
      return request(method, params);
    });
  };
  const discussion = (
    await post(`/agents/${worker.id}/interviews`, { key: randomUUID(), continuity: 'native-fork' })
  ).json();
  await expect(runtime.attach(discussion.id)).rejects.toThrow('original native goal');
  expect(requests).not.toContain('thread/fork');
  expect(requests).not.toContain('turn/start');
  expect(requests).not.toContain('thread/goal/clear');
});
afterEach(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

it('creates one explicit read-only discussion, without model work or altering the original', async () => {
  const task = store.task(worker.taskId!);
  const before = store.agent(worker.id);
  const key = randomUUID();
  const first = await post(`/agents/${worker.id}/interviews`, { key });
  expect(first.statusCode).toBe(200);
  const discussion = first.json();
  expect(discussion).toMatchObject({
    parentId: null,
    taskId: worker.taskId,
    role: 'researcher',
    permission: 'read-only',
    model: 'demo',
    effort: worker.effort,
    interview: { sourceAgentId: worker.id, continuity: 'saved-evidence' },
  });
  expect((await post(`/agents/${worker.id}/interviews`, { key })).json()).toEqual(discussion);
  expect(store.runs()).toHaveLength(0);
  expect(runtime.clients.size).toBe(0);
  expect(store.agent(worker.id)).toEqual(before);
  expect(store.task(worker.taskId!)).toEqual(task);
  expect(runtime.context(store.agent(discussion.id))).toContain('Used an index');
});

it('refuses reopening finished workers, including old queued work and explicit resume', async () => {
  for (const status of ['done', 'integrated', 'split', 'cancelled'] as const) {
    store.updateTask(worker.taskId!, { status });
    expect(
      (await post(`/agents/${worker.id}/messages`, { key: randomUUID(), text: 'Why?' })).statusCode,
    ).toBe(409);
    expect(
      (await post(`/agents/${worker.id}/commands`, { key: randomUUID(), command: 'resume' }))
        .statusCode,
    ).toBe(409);
  }
  const pending = store.enqueue(worker.id, randomUUID(), 'An old queued follow-up');
  runtime.kick();
  await vi.waitFor(() => expect(store.run(pending.id).status).toBe('failed'));
  expect(runtime.clients.size).toBe(0);
  expect(store.runs().filter((r) => r.agentId === worker.parentId)).toHaveLength(0);
  expect(store.task(worker.taskId!).review).toBe('Independent approval');
});

it('answers through the normal queue, charges the original task and never wakes its manager', async () => {
  const task = store.task(worker.taskId!);
  const discussion = (await post(`/agents/${worker.id}/interviews`, { key: randomUUID() })).json();
  const reply = await post(`/agents/${discussion.id}/messages`, {
    key: randomUUID(),
    text: 'Why did you use an index?',
  });
  expect(reply.statusCode).toBe(202);
  await vi.waitFor(() => expect(store.run(reply.json().id).status).toBe('completed'));
  expect(store.task(task.id)).toEqual(task);
  expect(store.runs().filter((r) => r.agentId === worker.parentId)).toHaveLength(0);
  expect(runtime.quark.runs().find((r) => r.runId === reply.json().id)).toMatchObject({
    taskId: task.id,
    agentId: discussion.id,
  });
});

it('prevents permission widening, coordination writes and native control on interviews', async () => {
  const discussion = (await post(`/agents/${worker.id}/interviews`, { key: randomUUID() })).json();
  for (const name of [
    'dock_message',
    'dock_review',
    'dock_task_create',
    'dock_transcribe',
    'dock_escalate',
  ])
    await expect(runtime.tool(discussion.id, randomUUID(), name, {})).rejects.toThrow(
      'only read saved evidence',
    );
  expect(
    (
      await post(`/agents/${discussion.id}/settings`, {
        model: 'demo',
        effort: 'medium',
        permission: 'workspace-write',
      })
    ).statusCode,
  ).toBe(409);
  expect(() => runtime.prepareNativeContext(discussion.id, 'turn/start', {})).toThrow(
    'read-only interview',
  );
  const evidence = await runtime.tool(discussion.id, randomUUID(), 'dock_inspect', {
    agentId: worker.id,
  });
  expect(evidence).toMatchObject({ agent: { id: worker.id } });
});

it('retains Claude account affinity and refuses an active source', async () => {
  const claude = store.addAgent({
    projectId: worker.projectId,
    taskId: worker.taskId,
    parentId: worker.parentId,
    name: 'Claude worker',
    role: 'researcher',
    cwd: directory,
    provider: 'claude',
  });
  store.updateAgent(claude.id, { model: 'sonnet', threadId: randomUUID() });
  expect((await post(`/agents/${claude.id}/interviews`, { key: randomUUID() })).statusCode).toBe(
    409,
  );
  store.setSetting(`claude:account:${claude.id}`, 'original-account');
  const discussion = (await post(`/agents/${claude.id}/interviews`, { key: randomUUID() })).json();
  expect(store.getSetting(`claude:account:${discussion.id}`)).toBe('original-account');
  store.updateAgent(worker.id, { status: 'running' });
  expect((await post(`/agents/${worker.id}/interviews`, { key: randomUUID() })).statusCode).toBe(
    409,
  );
});

it('keeps a late old implementation completion from clearing the review', async () => {
  const before = store.task(worker.taskId!);
  const run = store.enqueue(worker.id, randomUUID(), 'Earlier assignment');
  store.updateRun(run.id, { status: 'running', turnId: 'last-turn' });
  store.updateAgent(worker.id, { status: 'running', turnId: 'last-turn' });
  const finish = runtime as unknown as {
    finish(agentId: string, turnId: string, status: string): Promise<void>;
  };
  await finish.finish(worker.id, 'last-turn', 'completed');
  expect(store.run(run.id).status).toBe('completed');
  expect(store.task(worker.taskId!)).toEqual(before);
  expect(store.runs().filter((r) => r.agentId === worker.parentId)).toHaveLength(0);
});
