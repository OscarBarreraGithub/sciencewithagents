import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import type { Provider } from './codex.js';
import { git, ensureWorktree } from './workspaces.js';
import { repoRoot } from './paths.js';

let dir: string,
  store: Store,
  runtime: Runtime,
  client: Provider,
  rootId: string,
  threadId: string,
  manager: string,
  taskId: string;
let childThread: string, rootTurn: string, childTurn: string;
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  dir = mkdtempSync(join(repoRoot, 'data/tests/native-runtime-'));
  const projectRoot = join(dir, 'project');
  mkdirSync(projectRoot);
  await git(projectRoot, ['init', '-b', 'main']);
  await git(projectRoot, ['config', 'user.name', 'Dock Test']);
  await git(projectRoot, ['config', 'user.email', 'dock@example.invalid']);
  writeFileSync(join(projectRoot, 'README.md'), '# Fixture\n');
  await git(projectRoot, ['add', 'README.md']);
  await git(projectRoot, ['commit', '-m', 'Fixture']);
  store = new Store(join(dir, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(projectRoot, 'Native fixture', '');
  manager = project.managerId;
  const task = store.addTask(project.id, {
    title: 'One result',
    goal: 'One result',
    acceptance: 'One file',
    parentId: null,
  });
  taskId = task.id;
  const cwd = await ensureWorktree(store, task, dir);
  rootId = store.addAgent({
    projectId: project.id,
    parentId: manager,
    taskId,
    role: 'implementer',
    name: 'Builder',
    cwd,
  }).id;
  store.updateAgent(rootId, {
    model: 'demo',
    mcpServers: ['demo_docs'],
    checkpoint: 'Parent checkpoint',
  });
  runtime = new Runtime(store, dir, 'codex', async () => new DemoProvider());
  ({ client, threadId } = await runtime.attach(rootId));
  childThread = randomUUID();
  rootTurn = randomUUID();
  childTurn = randomUUID();
  const sessionId = randomUUID(),
    original = client.request.bind(client);
  vi.spyOn(client, 'request').mockImplementation(async (method, raw) => {
    if (method !== 'thread/read') return original(method, raw);
    const id = (raw as { threadId: string }).threadId;
    if (![threadId, childThread].includes(id)) return { thread: null };
    return {
      thread: {
        id,
        sessionId,
        cwd,
        ephemeral: false,
        canAcceptDirectInput: id === childThread ? false : true,
        status: { type: 'idle' },
        parentThreadId: id === childThread ? threadId : null,
        source:
          id === childThread
            ? {
                subAgent: {
                  thread_spawn: { parent_thread_id: threadId, agent_path: '/root/helper' },
                },
              }
            : 'appServer',
      },
    };
  });
});
afterEach(async () => {
  await runtime.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const flush = () => runtime.withLock(`provider:${rootId}`, async () => {});
const notify = (method: string, params: unknown) => client.emit('notification', method, params);
const begin = async () => {
  notify('turn/started', { threadId, turn: { id: rootTurn } });
  // Real Codex sends this BEFORE a child turn, without thread/started.
  notify('thread/status/changed', { threadId: childThread, status: { type: 'active' } });
  notify('turn/started', { threadId: childThread, turn: { id: childTurn } });
  await flush();
  return store.agent(store.contextOwner(childThread)!);
};
const complete = (id: string, turn: string, status = 'completed') =>
  notify('turn/completed', { threadId: id, turn: { id: turn, status } });

it('observes a loaded native child without moving work ownership, then returns to its busy parent', async () => {
  const child = await begin();
  const state = JSON.parse(runtime.context(store.agent(rootId)).split('\n')[1]!);
  expect(state.agents.find((a: { id: string }) => a.id === child.id)).toMatchObject({
    nativeRootId: rootId,
    nativeThreadId: childThread,
  });
  runtime.externalControl.add(rootId);
  const agents = store.agents(),
    runs = store.runs();
  const view = runtime.prepareNativeObservation(rootId, 'thread/resume', {
    threadId: childThread,
    excludeTurns: true,
    model: 'unrelated',
    approvalPolicy: 'never',
    config: { mcp_servers: { unselected: { enabled: true } } },
  })!;
  expect(view.params).toEqual({ threadId: childThread, excludeTurns: true });
  expect(() =>
    runtime.prepareNativeObservation(rootId, 'thread/resume', { threadId: childThread }),
  ).toThrow('Observe only');
  await view.before!();
  await view.finish(await client.request('thread/read', { threadId: childThread }));
  view.cancel();
  expect(store.agents()).toEqual(agents);
  expect(store.runs()).toEqual(runs);
  expect(runtime.clients.get(child.id)).toBe(client);
  for (const method of ['thread/start', 'thread/fork', 'turn/start', 'config/batchWrite'])
    expect(() => runtime.prepareNativeContext(rootId, method, { threadId })).toThrow(
      'Return to the parent',
    );
  const back = runtime.prepareNativeObservation(rootId, 'thread/resume', { threadId })!;
  await back.before!();
  await back.finish(await client.request('thread/read', { threadId }));
  back.cancel();
  expect(
    store
      .events()
      .filter((e) => e.type === 'terminal.observed')
      .map((e) => e.data),
  ).toEqual([{ observedAgentId: child.id }, { observedAgentId: rootId }]);
  expect(runtime.prepareNativeObservation(rootId, 'thread/resume', { threadId })).toBeNull();
  expect(store.agents()).toEqual(agents);
});

it.each([
  { canAcceptDirectInput: true },
  { canAcceptDirectInput: null },
  { status: { type: 'notLoaded' } },
  { sessionId: randomUUID() },
  { parentThreadId: randomUUID() },
  { cwd: '/outside' },
  { ephemeral: true },
])('refuses native observation with incompatible live metadata: %j', async (change) => {
  await begin();
  runtime.externalControl.add(rootId);
  const request = vi.mocked(client.request).getMockImplementation()!;
  vi.mocked(client.request).mockImplementation(async (method, raw) => {
    const result = await request(method, raw);
    if (method === 'thread/read' && (raw as { threadId: string }).threadId === childThread)
      return { thread: { ...(result as { thread: object }).thread, ...change } };
    return result;
  });
  const view = runtime.prepareNativeObservation(rootId, 'thread/resume', {
    threadId: childThread,
  })!;
  await expect(view.before!()).rejects.toThrow('Resume this native child through its parent');
  view.cancel();
  expect(store.events().some((e) => e.type === 'terminal.observed')).toBe(false);
});

it('refuses stale or cancelled native observation and clears child view state on detachment', async () => {
  await begin();
  runtime.externalControl.add(rootId);
  const first = runtime.prepareNativeObservation(rootId, 'thread/resume', {
    threadId: childThread,
  })!;
  await first.before!();
  first.cancel();
  await expect(
    first.finish(await client.request('thread/read', { threadId: childThread })),
  ).rejects.toThrow('connection changed');
  const second = runtime.prepareNativeObservation(rootId, 'thread/resume', {
    threadId: childThread,
  })!;
  await second.before!();
  store.updateAgent(rootId, { threadId: randomUUID() });
  await expect(
    second.finish(await client.request('thread/read', { threadId: childThread })),
  ).rejects.toThrow('connection changed');
  second.cancel();
  store.updateAgent(rootId, { threadId });
  const third = runtime.prepareNativeObservation(rootId, 'thread/resume', {
    threadId: childThread,
  })!;
  await third.before!();
  await third.finish(await client.request('thread/read', { threadId: childThread }));
  third.cancel();
  runtime.clearNativeObservation(rootId);
  expect(runtime.prepareNativeObservation(rootId, 'thread/resume', { threadId })).toBeNull();
  expect(runtime.prepareNativeContext(rootId, 'config/batchWrite', {})).toBeNull();
});

it('routes native tools, visible replies, approval IDs and parentage without misattributing child input', async () => {
  const child = await begin(),
    respond = vi.spyOn(client, 'respond');
  expect(runtime.clients.get(child.id)).toBe(client);
  client.emit('request', 91, 'item/tool/call', {
    threadId: childThread,
    turnId: childTurn,
    callId: 'checkpoint',
    tool: 'dock_checkpoint',
    arguments: { summary: 'Child checkpoint' },
  });
  notify('item/completed', {
    threadId: childThread,
    turnId: childTurn,
    item: {
      id: 'input',
      type: 'userMessage',
      content: [{ type: 'text', text: 'Visible delegation' }],
    },
  });
  notify('item/completed', {
    threadId: childThread,
    turnId: childTurn,
    item: { id: 'answer', type: 'agentMessage', text: 'Child result' },
  });
  notify('item/completed', {
    threadId: childThread,
    turnId: childTurn,
    item: { id: 'reasoning', type: 'reasoning', text: 'Never archive this' },
  });
  await flush();
  expect(respond).toHaveBeenCalledWith(91, expect.objectContaining({ success: true }));
  expect(store.agent(child.id).checkpoint).toBe('Child checkpoint');
  expect(store.agent(rootId).checkpoint).toBe('Parent checkpoint');
  store.updateAgent(child.id, { role: 'reviewer' });
  await expect(
    runtime.tool(child.id, randomUUID(), 'dock_review', {
      verdict: 'approve',
      findings: 'Helper cannot submit the verdict',
      evidence: 'Fixture',
    }),
  ).rejects.toThrow('parent reviewer owns');
  store.updateAgent(child.id, { role: 'implementer' });
  expect(store.entries(child.id).map((e) => [e.kind, e.title, e.text])).toEqual([
    ['message', 'Native delegated input', 'Visible delegation'],
    ['assistant', 'helper', 'Child result'],
  ]);
  expect(store.entries(rootId).some((e) => e.text.includes('Child result'))).toBe(false);
  client.emit('request', 92, 'mcpServer/elicitation/request', {
    threadId: childThread,
    turnId: childTurn,
    serverName: 'demo_docs',
    mode: 'form',
    message: 'Original child consent',
    _meta: { codex_approval_kind: 'mcp_tool_call' },
    requestedSchema: { type: 'object', properties: {} },
  });
  await flush();
  const approval = store.approvals()[0];
  expect(approval).toMatchObject({ agentId: child.id, requestId: 92, status: 'pending' });
  await runtime.approve(approval.id, 'decline');
  await runtime.approve(approval.id, 'decline');
  expect(respond.mock.calls.filter(([id]) => id === 92)).toEqual([
    [92, { action: 'decline', content: null }],
  ]);
  complete(childThread, childTurn);
  complete(threadId, rootTurn);
  await flush();
  expect(
    store
      .runs()
      .filter((r) => r.kind === 'report')
      .map((r) => r.sourceId),
  ).toEqual([rootId]);
});

it('defers one parent checkpoint and report until the entire native write group stops', async () => {
  const child = await begin(),
    cwd = store.agent(rootId).cwd,
    base = await git(cwd, ['rev-parse', 'HEAD']);
  writeFileSync(join(cwd, 'parent.txt'), 'Parent result\n');
  complete(threadId, rootTurn);
  await flush();
  expect(store.agent(rootId).status).toBe('running');
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(base);
  expect(store.runs().filter((r) => r.kind === 'report')).toHaveLength(0);
  runtime.externalControl.add(rootId);
  expect(() => runtime.prepareNativeContext(rootId, 'turn/start', { threadId, input: [] })).toThrow(
    'Reconnect',
  );
  await expect(runtime.newContext(rootId)).rejects.toThrow('Stop the current turn');
  await expect(runtime.reconnectTools(rootId)).rejects.toThrow('native children');
  writeFileSync(join(cwd, 'child.txt'), 'Late child result\n');
  complete(childThread, childTurn);
  await flush();
  expect(store.agent(child.id).status).toBe('idle');
  expect(store.agent(rootId).status).toBe('idle');
  expect(await git(cwd, ['show', 'HEAD:child.txt'])).toBe('Late child result');
  expect(await git(cwd, ['status', '--porcelain'])).toBe('');
  const events = store.events().filter((e) => e.type === 'task.checkpointed');
  expect(events).toHaveLength(1);
  expect(events[0].agentId).toBe(rootId);
  complete(childThread, childTurn);
  complete(threadId, rootTurn);
  await flush();
  expect(store.events().filter((e) => e.type === 'task.checkpointed')).toEqual(events);
  expect(store.runs().filter((r) => r.kind === 'report')).toHaveLength(1);
});

it('interrupts the remaining children and never checkpoints a stopped group', async () => {
  const child = await begin();
  writeFileSync(join(store.agent(rootId).cwd, 'partial.txt'), 'Uncertain partial work\n');
  complete(threadId, rootTurn);
  await flush();
  await runtime.interrupt(rootId);
  expect(client.request).toHaveBeenCalledWith('turn/interrupt', {
    threadId: childThread,
    turnId: childTurn,
  });
  expect(client.request).not.toHaveBeenCalledWith('turn/interrupt', { threadId, turnId: rootTurn });
  complete(childThread, childTurn, 'interrupted');
  await flush();
  expect(store.agent(child.id).status).toBe('interrupted');
  expect(store.agent(rootId).status).toBe('interrupted');
  expect(store.events().filter((e) => e.type === 'task.checkpointed')).toHaveLength(0);
});

it('holds a newly observed active child before its first turn and ignores premature idle metadata', async () => {
  notify('turn/started', { threadId, turn: { id: rootTurn } });
  notify('thread/status/changed', { threadId: childThread, status: { type: 'active' } });
  complete(threadId, rootTurn);
  await flush();
  const child = store.agent(store.contextOwner(childThread)!);
  expect(child.status).toBe('running');
  expect(store.agent(rootId).status).toBe('running');
  notify('thread/status/changed', { threadId: childThread, status: { type: 'idle' } });
  await flush();
  expect(store.agent(child.id).status).toBe('running');
  expect(store.events().filter((e) => e.type === 'task.checkpointed')).toHaveLength(0);
  notify('turn/started', { threadId: childThread, turn: { id: childTurn } });
  complete(childThread, childTurn);
  await flush();
  expect(store.agent(rootId).status).toBe('idle');
  expect(store.events().filter((e) => e.type === 'task.checkpointed')).toHaveLength(1);
});

it('keeps all writers busy until a failed shared provider closes, then expires every child approval', async () => {
  const child = await begin();
  client.emit('request', 94, 'item/fileChange/requestApproval', {
    threadId: childThread,
    turnId: childTurn,
    reason: 'Child write',
  });
  await flush();
  let release!: () => void;
  const close = vi.spyOn(client, 'close').mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  client.emit('unavailable', new Error('Fixture provider failure'));
  client.emit('unavailable', new Error('Same connection failed again'));
  expect(close).toHaveBeenCalledOnce();
  expect(store.agent(rootId).status).toBe('running');
  expect(store.agent(child.id).status).toBe('waiting');
  release();
  await vi.waitFor(() => expect(store.agent(rootId).status).toBe('interrupted'));
  expect(store.agent(child.id).status).toBe('interrupted');
  expect(store.approvals()[0].status).toBe('expired');
  expect(runtime.clients.size).toBe(0);
  expect(store.entries(rootId).filter((e) => e.title === 'Runtime unavailable')).toHaveLength(1);
  expect(store.events().filter((e) => e.type === 'task.checkpointed')).toHaveLength(0);
});

it('retains separate child history through restart without replaying unfinished completion, approvals or messages', async () => {
  const child = await begin();
  client.emit('request', 93, 'item/fileChange/requestApproval', {
    threadId: childThread,
    turnId: childTurn,
    reason: 'Original child write',
  });
  await flush();
  complete(threadId, rootTurn);
  await flush();
  const close = vi.spyOn(client, 'close');
  await runtime.close();
  expect(close).toHaveBeenCalledOnce();
  expect(store.approvals()[0].status).toBe('expired');
  expect(store.agent(rootId).status).toBe('interrupted');
  expect(store.agent(child.id).status).toBe('interrupted');
  const archive = store.entries(child.id);
  store.close();
  store = new Store(join(dir, 'dock.sqlite'));
  modelFixture(store);
  const factory = vi.fn(async () => new DemoProvider());
  runtime = new Runtime(store, dir, 'codex', factory);
  await runtime.initialize();
  expect(factory).not.toHaveBeenCalled();
  expect(store.entries(child.id)).toEqual(archive);
  expect(store.contextOwner(childThread)).toBe(child.id);
  expect(store.events().filter((e) => e.type === 'task.checkpointed')).toHaveLength(0);
  await expect(runtime.attach(child.id)).rejects.toThrow('controlled by its parent');
  await expect(
    runtime.tool(rootId, randomUUID(), 'dock_message', {
      agentId: child.id,
      message: 'Direct input cannot be queued',
    }),
  ).rejects.toThrow('controlled by its parent');
  expect(store.runs().some((r) => r.agentId === child.id && r.status === 'queued')).toBe(false);
});
