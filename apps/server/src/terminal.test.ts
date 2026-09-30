import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { repoRoot } from './paths.js';
import { Terminals } from './terminal.js';
import { createServer } from './server.js';
import type { NativeHandoff, NativeTransition } from './native-relay.js';

const mocks = vi.hoisted(() => ({
  relays: [] as {
    path: string;
    prepare: (method: string, params: unknown) => NativeHandoff | NativeTransition | null;
  }[],
  processes: [] as {
    write: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    exit: (code: number) => void;
  }[],
  failSpawn: false,
}));
vi.mock('./native-relay.js', () => ({
  nativeConfigMutations: new Set(['config/batchWrite']),
  NativeRelay: class {
    constructor(
      readonly path: string,
      readonly upstream: string,
      readonly prepare: (typeof mocks.relays)[number]['prepare'],
    ) {
      mocks.relays.push(this);
    }
    async start() {}
    close() {}
  },
}));
vi.mock('node-pty', () => ({
  spawn: vi.fn((_binary, args: string[]) => {
    if (mocks.failSpawn) throw new Error('Fixture spawn failed');
    let onExit = (_event: { exitCode: number }) => {};
    const process = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: (callback: typeof onExit) => {
        onExit = callback;
      },
      exit: (exitCode: number) => onExit({ exitCode }),
    };
    mocks.processes.push(process);
    const relay = mocks.relays.find((r) => `unix://${r.path}` === args[2])!;
    queueMicrotask(() => {
      const transition = relay.prepare('thread/resume', { threadId: args[3] });
      if (transition && 'finish' in transition) void transition.finish({});
    });
    return process;
  }),
}));
class Client extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  received: Record<string, unknown>[] = [];
  send(raw: string) {
    this.received.push(JSON.parse(raw));
  }
  close = vi.fn(() => {
    this.readyState = 3;
    this.emit('close');
  });
  input(data: string) {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'input', data })));
  }
  get socket() {
    return this as unknown as WebSocket;
  }
}
let root: string,
  store: Store,
  runtime: Runtime,
  terminals: Terminals,
  sourceId: string,
  targetId: string;
beforeEach(async () => {
  mocks.relays.length = 0;
  mocks.processes.length = 0;
  mocks.failSpawn = false;
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/terminal-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(root, 'Terminal fixture', '');
  sourceId = project.managerId;
  targetId = store.addAgent({
    projectId: project.id,
    parentId: sourceId,
    taskId: null,
    role: 'researcher',
    name: 'Reader',
    cwd: root,
  }).id;
  runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  await runtime.attach(sourceId);
  await runtime.attach(targetId);
  // Keep already attached demo providers; exercise the real terminal ownership layer with fake PTYs.
  Object.defineProperty(runtime, 'factory', { value: undefined });
  terminals = new Terminals(runtime);
});
afterEach(async () => {
  terminals.close();
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const handoff = (threadId = store.agent(targetId).threadId!) => {
  const transition = mocks.relays[0].prepare('thread/resume', { threadId });
  if (!transition || !('handoff' in transition)) throw new Error('Expected a handoff');
  return transition;
};

it('opens a fresh terminal-only conversation without a turn and reuses its named thread after a failed opening', async () => {
  const app = await createServer(store, runtime, { port: 4999, terminals, ownsRuntime: false });
  const headers = { host: '127.0.0.1:4999', origin: 'http://127.0.0.1:4999' };
  const payload = {
    key: randomUUID(),
    name: 'Native only',
    provider: 'codex',
    saveContact: false,
    model: 'demo',
    effort: 'medium',
  };
  const sockets: WebSocket[] = [];
  vi.spyOn(runtime.modelPolicy, 'catalog').mockResolvedValue([
    { id: 'demo', label: 'Demo', isDefault: true, efforts: ['medium'] },
  ]);
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers,
      payload,
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().id as string;
    expect(store.agent(agentId)).toMatchObject({
      surface: 'terminal',
      threadId: null,
      status: 'idle',
    });
    const provider = new DemoProvider();
    runtime.clients.set(agentId, provider);
    const request = vi.spyOn(provider, 'request');
    const connect = async () => {
      const received: Record<string, unknown>[] = [];
      const socket = await app.injectWS(
        `/api/agents/${agentId}/terminal`,
        { headers },
        {
          onInit: (socket) =>
            socket.on('message', (raw) => received.push(JSON.parse(raw.toString()))),
        },
      );
      sockets.push(socket);
      return { socket, received };
    };
    mocks.failSpawn = true;
    const failed = await connect();
    await expect
      .poll(() => failed.received)
      .toContainEqual({ type: 'error', message: 'Fixture spawn failed' });
    const threadId = store.agent(agentId).threadId;
    expect(threadId).toBeTruthy();
    expect(request).toHaveBeenCalledWith('thread/name/set', { threadId, name: payload.name });
    expect(terminals.active(agentId)).toBe(false);
    expect(runtime.externalControl.has(agentId)).toBe(false);

    // Retrying creation after a lost response does not replace the retained native identity.
    const repeated = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers,
      payload,
    });
    expect(repeated.json()).toEqual(created.json());
    expect(store.agent(agentId).threadId).toBe(threadId);
    mocks.failSpawn = false;
    const opened = await connect();
    await expect.poll(() => opened.received).toContainEqual({ type: 'ready' });
    expect(request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({ threadId }));
    const processCount = mocks.processes.length;
    const reconnected = await connect();
    await expect.poll(() => reconnected.received).toContainEqual({ type: 'ready' });
    expect(mocks.processes).toHaveLength(processCount);
    expect(request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === 'thread/name/set')).toHaveLength(1);
    expect(request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
    expect(store.agent(agentId)).toMatchObject({ threadId, status: 'idle', turnId: null });
    expect(store.entries(agentId)).toHaveLength(0);
    expect(store.runs()).toHaveLength(0);
    expect(runtime.externalControl.has(agentId)).toBe(true);
    reconnected.socket.send(JSON.stringify({ type: 'input', data: '/status' }));
    await expect.poll(() => mocks.processes.at(-1)!.write.mock.calls).toEqual([['/status']]);

    const closed = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/terminal/close`,
      headers,
      payload: {},
    });
    expect(closed.statusCode).toBe(200);
    expect(terminals.active(agentId)).toBe(false);
    expect(runtime.externalControl.has(agentId)).toBe(false);
    expect(store.agent(agentId).threadId).toBe(threadId);
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close();
  }
});

it('moves the same input socket to the target process and preserves both roles, workspaces and archives', async () => {
  const before = store.agents();
  const source = new Client(),
    previousTarget = new Client();
  await terminals.connect(sourceId, source.socket);
  await terminals.connect(targetId, previousTarget.socket);
  expect(pty.spawn).toHaveBeenLastCalledWith(
    'codex',
    [
      'resume',
      '--remote',
      `unix://${mocks.relays[1].path}`,
      store.agent(targetId).threadId,
      '--no-alt-screen',
    ],
    expect.any(Object),
  );
  // The remote TUI must not override the host's existing permission policy.
  expect(store.agent(targetId).permission).toBe('read-only');
  const archive = store.entries(sourceId);
  await handoff().handoff();
  expect(source.received).toContainEqual({ type: 'transferred', agentId: targetId });
  expect(previousTarget.close).toHaveBeenCalledWith(4001, expect.any(String));
  expect(source.close).not.toHaveBeenCalled();
  expect(terminals.active(sourceId)).toBe(false);
  expect(runtime.externalControl.has(targetId)).toBe(true);
  source.input('target-only');
  expect(mocks.processes[1].write).toHaveBeenCalledExactlyOnceWith('target-only');
  expect(mocks.processes[0].write).not.toHaveBeenCalled();
  previousTarget.input('late-input');
  expect(mocks.processes[1].write).toHaveBeenCalledTimes(1);
  expect(store.agents()).toEqual(before);
  expect(store.entries(sourceId)).toEqual(archive);
  expect(store.events().find((e) => e.type === 'terminal.transferred')?.data).toMatchObject({
    sourceAgentId: sourceId,
    targetAgentId: targetId,
  });
  // Reattaching the source before its old PTY exits must retain the new lease.
  await terminals.connect(sourceId, new Client().socket);
  mocks.processes[0].exit(0);
  expect(runtime.externalControl.has(sourceId)).toBe(true);
  expect(runtime.externalControl.has(targetId)).toBe(true);
});

it('keeps source input alive for a busy, unregistered or failed target', async () => {
  const source = new Client();
  await terminals.connect(sourceId, source.socket);
  expect(() => handoff('not-imported')).toThrow('has not been imported');
  store.updateAgent(targetId, { status: 'running' });
  await expect(handoff().handoff()).rejects.toThrow('active turn');
  store.updateAgent(targetId, { status: 'idle' });
  mocks.failSpawn = true;
  await expect(handoff().handoff()).rejects.toThrow('Fixture spawn failed');
  expect(terminals.active(targetId)).toBe(false);
  expect(runtime.externalControl.has(targetId)).toBe(false);
  expect(source.close).not.toHaveBeenCalled();
  source.input('still-source');
  expect(mocks.processes[0].write).toHaveBeenCalledWith('still-source');
  expect(store.events().some((e) => e.type === 'terminal.transferred')).toBe(false);
});

it('reserves ownership before asynchronous attachment and cancels it on close', async () => {
  let release!: () => void;
  const attach = runtime.attach.bind(runtime);
  vi.spyOn(runtime, 'attach').mockImplementationOnce(async (id) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return attach(id);
  });
  const connecting = terminals.connect(sourceId, new Client().socket);
  await expect.poll(() => runtime.externalControl.has(sourceId)).toBe(true);
  expect(terminals.active(sourceId)).toBe(true);
  terminals.stop(sourceId);
  release();
  await expect(connecting).rejects.toThrow('cancelled');
  expect(terminals.active(sourceId)).toBe(false);
  expect(runtime.externalControl.has(sourceId)).toBe(false);
  expect(mocks.processes).toHaveLength(0);
});

it('allows an explicit handoff within a task but not two independent terminal owners', async () => {
  const managerId = sourceId;
  const projectId = store.agent(sourceId).projectId;
  const task = store.addTask(projectId, {
    title: 'One task',
    goal: 'One outcome',
    acceptance: 'One check',
    parentId: null,
  });
  store.updateAgent(targetId, { taskId: task.id });
  const peer = store.addAgent({
    projectId,
    parentId: managerId,
    taskId: task.id,
    role: 'reviewer',
    name: 'Peer',
    cwd: root,
  });
  runtime.clients.set(peer.id, new DemoProvider());
  await runtime.attach(peer.id);
  sourceId = peer.id;
  const source = new Client();
  await terminals.connect(sourceId, source.socket);
  await expect(terminals.connect(targetId, new Client().socket)).rejects.toThrow('task worktree');
  await handoff().handoff();
  expect(terminals.active(sourceId)).toBe(false);
  expect(terminals.active(targetId)).toBe(true);
  expect(source.received).toContainEqual({ type: 'transferred', agentId: targetId });
});
