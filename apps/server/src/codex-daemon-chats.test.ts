import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexDaemonChats } from './codex-daemon-chats.js';
import type { NativeGoal, NativeGoalAction } from '@dock/shared';

type Frame = { id?: number; method: string; params: Record<string, unknown> };
type Thread = {
  id: string;
  ephemeral: boolean;
  canAcceptDirectInput?: boolean;
  updatedAt?: number;
  source?: unknown;
  threadSource?: string;
  parentThreadId?: string;
  name: string;
  status: { type: string; activeFlags?: string[] };
  turns: { id: string; status: string; items: unknown[] }[];
};
class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly frames: Frame[] = [];
  constructor(readonly handle: (frame: Frame, socket: Socket) => void) {
    super();
  }
  send(value: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(value) as Frame;
    this.frames.push(frame);
    queueMicrotask(() => this.handle(frame, this));
    callback?.();
  }
  reply(frame: Frame, result: unknown) {
    this.emit('message', Buffer.from(JSON.stringify({ id: frame.id, result })));
  }
  reject(frame: Frame, message: string, code = -32000) {
    this.emit('message', Buffer.from(JSON.stringify({ id: frame.id, error: { code, message } })));
  }
  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}
const owned: CodexDaemonChats[] = [];
afterEach(() => {
  for (const chats of owned.splice(0)) chats.close();
  vi.restoreAllMocks();
});

function fixture() {
  const id = randomUUID();
  const thread: Thread = {
    id,
    ephemeral: false,
    name: 'Existing native conversation',
    status: { type: 'idle' },
    turns: [],
  };
  const state = {
    threads: new Map([[id, thread]]),
    loaded: [id],
    queue: undefined as unknown[] | undefined,
    queueMore: false,
    queueReadFailure: undefined as string | undefined,
    queueReadFailureCode: -32000,
    deferQueueRead: false,
    queueReadTransportFailure: false,
    historyError: undefined as string | undefined,
    mutation: undefined as ((frame: Frame, socket: Socket) => void) | undefined,
  };
  const sockets: Socket[] = [];
  const locate = vi.fn(async () => '/fixture/native.sock');
  const chats = new CodexDaemonChats('configured-codex', {
    socketPath: locate,
    timeoutMs: 30,
    connect: () => {
      const socket = new Socket((frame, client) => {
        if (frame.id === undefined) return;
        if (frame.method === 'initialize') return client.reply(frame, {});
        if (frame.method === 'thread/loaded/list')
          return client.reply(frame, { data: state.loaded, nextCursor: 'not-followed' });
        if (frame.method === 'thread/read') {
          if (frame.params.includeTurns && state.historyError)
            return client.reject(frame, state.historyError);
          const value = state.threads.get(String(frame.params.threadId));
          if (!value) return client.reject(frame, 'Thread is no longer loaded');
          const { turns, ...metadata } = value;
          return client.reply(frame, {
            thread: { ...metadata, ...(frame.params.includeTurns ? { turns } : {}) },
          });
        }
        if (frame.method === 'thread/queue/list' && state.queueReadTransportFailure)
          return client.emit('error', new Error('The native connection closed.'));
        if (frame.method === 'thread/queue/list' && state.deferQueueRead) return;
        if (frame.method === 'thread/queue/list' && state.queueReadFailure)
          return client.reject(frame, state.queueReadFailure, state.queueReadFailureCode);
        if (frame.method === 'thread/queue/list')
          return state.queue
            ? client.reply(frame, {
                data: state.queue,
                nextCursor: state.queueMore ? 'next' : null,
              })
            : client.reject(frame, 'Method not found');
        if (state.mutation) return state.mutation(frame, client);
        if (frame.method === 'turn/start')
          return client.reply(frame, { turn: { id: 'accepted-turn' } });
        if (frame.method === 'turn/steer')
          return client.reply(frame, { turnId: frame.params.expectedTurnId });
        if (frame.method === 'turn/interrupt') return client.reply(frame, {});
        throw new Error(`Unexpected method: ${frame.method}`);
      });
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  owned.push(chats);
  const frames = () => sockets.flatMap((socket) => socket.frames);
  const mutations = () => frames().filter((frame) => frame.method.startsWith('turn/'));
  const input = () => ({ key: randomUUID(), threadId: id, text: 'Owner guidance' });
  const busy = (turnId = 'observed-turn') => {
    thread.status = { type: 'active', activeFlags: [] };
    thread.turns = [{ id: turnId, status: 'inProgress', items: [] }];
  };
  return { chats, locate, state, thread, sockets, frames, mutations, input, busy };
}

it('retains native conversation time across discovery and reads instead of using observation time', async () => {
  const f = fixture();
  f.thread.updatedAt = 1760000000;
  await f.chats.discover();
  const window = f.chats.windows()[0]!;
  expect(window.lastActivityAt).toBe('2025-10-09T08:53:20.000Z');
  expect((await f.chats.read(window.windowId)).lastActivityAt).toBe(window.lastActivityAt);
  f.thread.updatedAt += 60;
  expect((await f.chats.read(window.windowId)).lastActivityAt).toBe('2025-10-09T08:54:20.000Z');
  expect(f.mutations()).toEqual([]);
});

function goalFixture() {
  const f = fixture();
  const state = {
    goal: {
      threadId: f.thread.id,
      objective: 'Original native objective',
      status: 'blocked',
      createdAt: 10,
      updatedAt: 20,
      tokensUsed: 120,
      timeUsedSeconds: 5,
      tokenBudget: 5000,
    } as NativeGoal | null,
    reject: false,
    disconnect: false,
  };
  f.state.mutation = (frame, socket) => {
    if (frame.method === 'thread/goal/get') return socket.reply(frame, { goal: state.goal });
    if (frame.method === 'thread/goal/clear') {
      state.goal = null;
      return socket.reply(frame, {});
    }
    if (frame.method === 'thread/goal/set') {
      if (state.reject) return socket.reject(frame, 'Native usage limit is still active');
      if (state.disconnect) return socket.terminate();
      state.goal = {
        ...(state.goal ?? {
          threadId: f.thread.id,
          objective: String(frame.params.objective),
          createdAt: 30,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          tokenBudget: null,
        }),
        status: frame.params.status as NativeGoal['status'],
        updatedAt: 30,
      };
      return socket.reply(frame, { goal: state.goal });
    }
    throw new Error(`Unexpected goal method: ${frame.method}`);
  };
  return { ...f, goalState: state };
}
it('reads and resumes the exact loaded daemon goal without starting a provider, model or full transcript read', async () => {
  const f = goalFixture();
  await f.chats.discover();
  const window = f.chats.windows()[0];
  const view = await f.chats.goal(window.windowId);
  expect(view).toMatchObject({ supported: true, goal: { status: 'blocked', tokenBudget: 5000 } });
  expect(
    (
      await f.chats.goalAction(window.windowId, {
        key: randomUUID(),
        threadId: f.thread.id,
        action: 'resume',
        expectedToken: view.token!,
      })
    ).state,
  ).toBe('sent');
  expect(
    f
      .frames()
      .filter((frame) => frame.method === 'thread/goal/set')
      .map((frame) => frame.params),
  ).toEqual([{ threadId: f.thread.id, status: 'active' }]);
  expect(
    f
      .frames()
      .filter((frame) => frame.method === 'thread/read')
      .every((frame) => frame.params.includeTurns === false),
  ).toBe(true);
  expect(f.mutations()).toHaveLength(0);
});
it('keeps daemon goal controls bound to a loaded native identity and current lifecycle across devices', async () => {
  const f = goalFixture();
  await f.chats.discover();
  const window = f.chats.windows()[0];
  const view = await f.chats.goal(window.windowId);
  const input: NativeGoalAction = {
    key: randomUUID(),
    threadId: f.thread.id,
    action: 'resume',
    expectedToken: view.token!,
  };
  f.goalState.goal!.status = 'paused';
  expect((await f.chats.goalAction(window.windowId, input)).state).toBe('not_sent');
  const paused = await f.chats.goal(window.windowId);
  f.state.loaded = [];
  expect(
    (await f.chats.goalAction(window.windowId, { ...input, expectedToken: paused.token! })).state,
  ).toBe('not_sent');
  expect(f.frames().filter((frame) => frame.method === 'thread/goal/set')).toHaveLength(0);
});
it('clears a completed daemon goal explicitly before creating another, preserves budget and reports native failure truthfully', async () => {
  const f = goalFixture();
  await f.chats.discover();
  const window = f.chats.windows()[0];
  let view = await f.chats.goal(window.windowId);
  const resume: NativeGoalAction = {
    key: randomUUID(),
    threadId: f.thread.id,
    action: 'resume',
    expectedToken: view.token!,
  };
  f.goalState.reject = true;
  expect((await f.chats.goalAction(window.windowId, resume)).state).toBe('not_sent');
  f.goalState.reject = false;
  f.goalState.goal!.status = 'complete';
  view = await f.chats.goal(window.windowId);
  expect(
    (
      await f.chats.goalAction(window.windowId, {
        key: randomUUID(),
        threadId: f.thread.id,
        action: 'clear',
        expectedToken: view.token!,
      })
    ).state,
  ).toBe('sent');
  expect((await f.chats.goal(window.windowId)).goal).toBeNull();
  expect(
    (
      await f.chats.goalAction(window.windowId, {
        key: randomUUID(),
        threadId: f.thread.id,
        action: 'create',
        objective: 'Next native objective',
        expectedToken: null,
      })
    ).state,
  ).toBe('sent');
  expect(f.goalState.goal).toMatchObject({ objective: 'Next native objective', tokenBudget: null });
  f.goalState.goal!.status = 'paused';
  view = await f.chats.goal(window.windowId);
  f.goalState.disconnect = true;
  expect(
    (
      await f.chats.goalAction(window.windowId, {
        ...resume,
        key: randomUUID(),
        expectedToken: view.token!,
      })
    ).state,
  ).toBe('uncertain');
});

it('discovers metadata only, coalesces foreground refresh and excludes ephemeral threads', async () => {
  const f = fixture();
  const ephemeral = { ...f.thread, id: randomUUID(), ephemeral: true };
  f.state.threads.set(ephemeral.id, ephemeral);
  f.state.loaded.push(ephemeral.id);
  await Promise.all([f.chats.discover(), f.chats.discover(), f.chats.discover()]);
  await f.chats.discover();
  expect(f.locate).toHaveBeenCalledTimes(1);
  expect(f.frames().filter((frame) => frame.method === 'thread/loaded/list')).toHaveLength(1);
  expect(
    f
      .frames()
      .filter((frame) => frame.method === 'thread/read')
      .every((frame) => frame.params.includeTurns === false),
  ).toBe(true);
  expect(f.chats.windows()).toHaveLength(1);
  const window = f.chats.windows()[0];
  expect(window).toMatchObject({
    source: 'codex-daemon',
    provider: 'codex',
    threadId: f.thread.id,
    status: 'idle',
  });
  expect(window).not.toHaveProperty('entries');
  expect(window.windowId).toMatch(
    /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
  );
  expect(f.frames().map((frame) => frame.method)).not.toEqual(
    expect.arrayContaining(['thread/start', 'thread/resume']),
  );
});

it('reads only selected loaded history with bounded pages and lazy activity expansion', async () => {
  const f = fixture();
  f.thread.turns = [
    {
      id: 'history',
      status: 'completed',
      items: [
        ...Array.from({ length: 60 }, (_, i) => ({
          id: `message-${i}`,
          type: 'agentMessage',
          text: 'x'.repeat(20_000),
        })),
        ...Array.from({ length: 20 }, (_, i) => ({
          id: `tool-${i}`,
          type: 'commandExecution',
          command: 'read fixture',
          aggregatedOutput: 'output'.repeat(2000),
        })),
      ],
    },
  ];
  await f.chats.discover();
  const id = f.chats.windows()[0].windowId;
  const page = await f.chats.read(id);
  expect(page.entries.length).toBeLessThanOrEqual(40);
  expect(page.entries.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(64_000);
  expect(page.page).toMatchObject({ total: 80, before: expect.any(String) });
  expect(page.entries.at(-1)?.activityGroup?.count).toBe(20);
  const activity = await f.chats.read(id, { activity: 'history:tool-0' });
  expect(activity.page?.total).toBe(20);
  expect(activity.entries.every((entry) => !entry.activityGroup)).toBe(true);
  const detail = await f.chats.read(id, { entry: 'history:message-0', offset: 8000 });
  expect(detail.entries[0]).toMatchObject({ textOffset: 8000, textLength: 20_000 });
  expect(f.mutations()).toEqual([]);
});

it('does not read or resume a thread after it unloads', async () => {
  const f = fixture();
  await f.chats.discover();
  const id = f.chats.windows()[0].windowId;
  f.state.loaded = [];
  expect(await f.chats.send(id, f.input())).toMatchObject({ state: 'not_sent' });
  expect(
    f.frames().filter((frame) => frame.method === 'thread/read' && frame.params.includeTurns),
  ).toEqual([]);
  expect(f.mutations()).toEqual([]);
  expect(f.chats.windows()).toEqual([]);
});

it('excludes explicit native read-only threads and rechecks input eligibility before sending', async () => {
  const f = fixture();
  const helper = { ...f.thread, id: randomUUID(), canAcceptDirectInput: false };
  f.state.threads.set(helper.id, helper);
  f.state.loaded.push(helper.id);
  await f.chats.discover();
  expect(f.chats.windows().map((window) => window.threadId)).toEqual([f.thread.id]);
  const id = f.chats.windows()[0].windowId;
  f.thread.canAcceptDirectInput = false;
  expect(await f.chats.send(id, f.input())).toMatchObject({ state: 'not_sent' });
  expect(f.mutations()).toEqual([]);
});

it('starts only on the existing idle thread without overriding any native settings', async () => {
  const f = fixture();
  await f.chats.discover();
  const input = f.input();
  expect(await f.chats.send(f.chats.windows()[0].windowId, input)).toMatchObject({ state: 'sent' });
  expect(f.mutations()).toEqual([
    {
      id: expect.any(Number),
      method: 'turn/start',
      params: {
        threadId: f.thread.id,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
      },
    },
  ]);
});

it('labels the known empty-session history limitation and allows the first idle message from metadata', async () => {
  const f = fixture();
  f.state.historyError = 'list_turns is not supported yet';
  await f.chats.discover();
  const id = f.chats.windows()[0].windowId;
  expect(await f.chats.read(id)).toMatchObject({
    status: 'idle',
    historyUnavailable: true,
    entries: [],
    message:
      'Codex has not exposed this session’s history yet. You can send a message or read it on the computer.',
  });
  const fullReads = f
    .frames()
    .filter((frame) => frame.method === 'thread/read' && frame.params.includeTurns).length;
  expect(await f.chats.send(id, f.input())).toMatchObject({ state: 'sent' });
  expect(
    f.frames().filter((frame) => frame.method === 'thread/read' && frame.params.includeTurns),
  ).toHaveLength(fullReads);
  expect(f.mutations().map((frame) => frame.method)).toEqual(['turn/start']);
  f.state.historyError = undefined;
  f.thread.turns = [
    {
      id: 'first',
      status: 'completed',
      items: [{ id: 'reply', type: 'agentMessage', text: 'Native reply' }],
    },
  ];
  const available = await f.chats.read(id);
  expect(available.historyUnavailable).toBeUndefined();
  expect(available.entries[0].text).toBe('Native reply');
});

it('never fabricates history for other native errors or steers without observed turn history', async () => {
  const f = fixture();
  await f.chats.discover();
  const id = f.chats.windows()[0].windowId;
  f.state.historyError = 'Unable to read saved conversation';
  await expect(f.chats.read(id)).rejects.toThrow('Unable to read saved conversation');
  f.busy();
  f.state.historyError = 'list_turns is not supported yet';
  expect(await f.chats.send(id, { ...f.input(), expectedTurnId: 'observed-turn' })).toMatchObject({
    state: 'not_sent',
  });
  expect(
    await f.chats.control(id, {
      key: randomUUID(),
      threadId: f.thread.id,
      action: 'interrupt',
      token: 'observed-turn',
    }),
  ).toMatchObject({ state: 'not_sent' });
  expect(f.mutations()).toEqual([]);
});

it('steers and interrupts the exact observed active turn, refusing a later or completed turn', async () => {
  const f = fixture();
  f.busy();
  await f.chats.discover();
  const id = f.chats.windows()[0].windowId;
  const read = await f.chats.read(id);
  expect(read).toMatchObject({
    status: 'busy',
    steerToken: 'observed-turn',
    stopToken: 'observed-turn',
  });
  expect(await f.chats.send(id, { ...f.input(), expectedTurnId: read.steerToken })).toMatchObject({
    state: 'sent',
  });
  expect(
    await f.chats.control(id, {
      key: randomUUID(),
      threadId: f.thread.id,
      action: 'interrupt',
      token: read.stopToken!,
    }),
  ).toMatchObject({ state: 'sent' });
  f.busy('replacement');
  expect(await f.chats.send(id, { ...f.input(), expectedTurnId: 'observed-turn' })).toMatchObject({
    state: 'not_sent',
  });
  expect(
    await f.chats.control(id, {
      key: randomUUID(),
      threadId: f.thread.id,
      action: 'interrupt',
      token: 'observed-turn',
    }),
  ).toMatchObject({ state: 'not_sent' });
  f.thread.status = { type: 'idle' };
  f.thread.turns = [];
  expect(await f.chats.send(id, { ...f.input(), expectedTurnId: 'observed-turn' })).toMatchObject({
    state: 'not_sent',
  });
  expect(f.mutations().map((frame) => frame.method)).toEqual(['turn/steer', 'turn/interrupt']);
  expect(f.mutations()[0].params.expectedTurnId).toBe('observed-turn');
  expect(f.mutations()[1].params.turnId).toBe('observed-turn');
});

it.each(['waitingOnApproval', 'waitingOnUserInput', 'futureFlag'])(
  'refuses mutations while native attention is %s and never answers requests',
  async (flag) => {
    const f = fixture();
    f.busy();
    f.thread.status.activeFlags = [flag];
    await f.chats.discover();
    const id = f.chats.windows()[0].windowId;
    f.sockets[0].emit(
      'message',
      Buffer.from(
        JSON.stringify({ id: 987654, method: 'item/commandExecution/requestApproval', params: {} }),
      ),
    );
    expect(await f.chats.send(id, f.input())).toMatchObject({ state: 'not_sent' });
    expect(await f.chats.send(id, { ...f.input(), expectedTurnId: 'observed-turn' })).toMatchObject(
      { state: 'not_sent' },
    );
    expect(
      await f.chats.control(id, {
        key: randomUUID(),
        threadId: f.thread.id,
        action: 'interrupt',
        token: 'observed-turn',
      }),
    ).toMatchObject({ state: 'not_sent' });
    expect(f.mutations()).toEqual([]);
    expect(f.frames().some((frame) => frame.id === 987654)).toBe(false);
  },
);

it('refuses unknown state, foreign identity, queue mode, and ambiguous active turns', async () => {
  const f = fixture();
  await f.chats.discover();
  const id = f.chats.windows()[0].windowId;
  expect(await f.chats.send(id, { ...f.input(), threadId: 'foreign' })).toMatchObject({
    state: 'not_sent',
  });
  expect(await f.chats.send(id, { ...f.input(), mode: 'queue' })).toMatchObject({
    state: 'not_sent',
  });
  f.thread.status = { type: 'new-native-status' };
  expect(await f.chats.send(id, f.input())).toMatchObject({ state: 'not_sent' });
  f.busy();
  f.thread.turns.push({ ...f.thread.turns[0], id: 'another' });
  expect(await f.chats.send(id, { ...f.input(), expectedTurnId: 'observed-turn' })).toMatchObject({
    state: 'not_sent',
  });
  expect(f.mutations()).toEqual([]);
});

it('preserves native rejection distinctly from lost or mismatched acknowledgements', async () => {
  const f = fixture();
  f.busy();
  await f.chats.discover();
  const id = f.chats.windows()[0].windowId;
  f.state.mutation = (frame, socket) => socket.reject(frame, 'Expected turn already completed');
  expect(await f.chats.send(id, { ...f.input(), expectedTurnId: 'observed-turn' })).toEqual({
    state: 'not_sent',
    message: 'Expected turn already completed',
  });
  f.state.mutation = (frame, socket) => socket.reply(frame, { turnId: 'different-turn' });
  expect(await f.chats.send(id, { ...f.input(), expectedTurnId: 'observed-turn' })).toMatchObject({
    state: 'uncertain',
  });
  f.state.mutation = (_frame, socket) => socket.terminate();
  expect(await f.chats.send(id, { ...f.input(), expectedTurnId: 'observed-turn' })).toMatchObject({
    state: 'uncertain',
  });
  expect(f.mutations()).toHaveLength(3);
  expect(f.sockets).toHaveLength(1); // No automatic replay/reconnect after uncertain mutation.
});

it('times out a lost response without retry and reconnects only on later foreground discovery', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = fixture();
  await f.chats.discover();
  const id = f.chats.windows()[0].windowId;
  f.state.mutation = () => {};
  expect(await f.chats.send(id, f.input())).toMatchObject({ state: 'uncertain' });
  expect(f.mutations()).toHaveLength(1);
  expect(f.chats.windows()).toEqual([]);
  now += 2001;
  await f.chats.discover();
  expect(f.sockets).toHaveLength(2);
  expect(f.chats.windows()[0].windowId).toBe(id);
  expect(f.mutations()).toHaveLength(1);
  f.chats.close();
  await f.chats.discover();
  expect(f.chats.windows()).toEqual([]);
  expect(f.sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true);
});

it('bounds loaded discovery, does not follow cursors, and caches unavailable discovery', async () => {
  const f = fixture();
  for (let i = 1; i < 100; i++) {
    const thread = { ...f.thread, id: `loaded-${i}` };
    f.state.threads.set(thread.id, thread);
    f.state.loaded.push(thread.id);
  }
  await f.chats.discover();
  expect(f.chats.windows()).toHaveLength(100);
  expect(f.frames().filter((frame) => frame.method === 'thread/loaded/list')).toEqual([
    { id: expect.any(Number), method: 'thread/loaded/list', params: { limit: 100 } },
  ]);
  const locate = vi.fn(async () => null);
  const unavailable = new CodexDaemonChats('absent', { socketPath: locate });
  owned.push(unavailable);
  await unavailable.discover();
  await unavailable.discover();
  expect(locate).toHaveBeenCalledTimes(1);
  expect(unavailable.windows()).toEqual([]);
});

it('rejects an oversized response and closes only its own connection', async () => {
  const f = fixture();
  await f.chats.discover();
  f.sockets[0].emit('message', Buffer.alloc(32 * 1024 * 1024 + 1, 32));
  expect(f.sockets[0].readyState).toBe(WebSocket.CLOSED);
  expect(f.chats.windows()).toEqual([]);
});

it.each([false, true])(
  'uses only daemon version discovery and an owned Unix socket with the real WebSocket transport (managed symlink: %s)',
  async (managedSymlink) => {
    const dir = await mkdtemp(join(tmpdir(), 'dock-daemon-'));
    const socketPath = join(dir, 'native.sock');
    const binary = join(dir, 'codex');
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const methods: string[] = [];
    const sockets = new Set<WebSocket>();
    wss.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('message', (bytes) => {
        const frame = JSON.parse(bytes.toString());
        methods.push(frame.method);
        if (frame.id !== undefined)
          socket.send(
            JSON.stringify({
              id: frame.id,
              result: frame.method === 'thread/loaded/list' ? { data: [] } : {},
            }),
          );
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const reportedPath = managedSymlink ? join(dir, 'managed.sock') : socketPath;
      if (managedSymlink) await symlink('native.sock', reportedPath);
      await writeFile(
        binary,
        `#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['app-server','daemon','version']))process.exit(9);console.log(${JSON.stringify(JSON.stringify({ status: 'running', socketPath: reportedPath }))});\n`,
        { mode: 0o700 },
      );
      const chats = new CodexDaemonChats(binary);
      owned.push(chats);
      await chats.discover();
      expect(methods).toEqual(['initialize', 'initialized', 'thread/loaded/list']);
      chats.close();
      expect(server.listening).toBe(true);
      // The same reported path must not be accepted if it is a regular file.
      await writeFile(
        binary,
        `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ status: 'running', socketPath: binary }))});\n`,
        { mode: 0o700 },
      );
      const invalid = new CodexDaemonChats(binary);
      owned.push(invalid);
      await invalid.discover();
      expect(invalid.windows()).toEqual([]);
      expect(methods).toHaveLength(3);
    } finally {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each([
  { source: { subAgent: { thread_spawn: {} } } },
  { parentThreadId: 'parent' },
  { threadSource: 'sciencewithagents' },
])('excludes helper provenance from shared chat discovery: %j', async (metadata) => {
  const f = fixture();
  Object.assign(f.thread, metadata);
  await f.chats.discover();
  expect(f.chats.windows()).toEqual([]);
  expect(f.mutations()).toEqual([]);
});

it('discovers queue support, reads external messages and submits with the original native UUID', async () => {
  const f = fixture();
  f.state.queue = [
    {
      id: 'desktop-message',
      clientUserMessageId: 'desktop',
      input: [{ type: 'text', text: 'Editor follow-up' }],
    },
  ];
  f.state.queueMore = true;
  await f.chats.discover();
  const window = f.chats.windows()[0];
  expect(await f.chats.read(window.windowId)).toMatchObject({
    canQueue: true,
    queuedMessages: [{ id: 'desktop-message', text: 'Editor follow-up' }],
    queueHasMore: true,
  });
  f.busy();
  const message = { ...f.input(), mode: 'queue' as const };
  f.state.mutation = (frame, socket) =>
    socket.reply(frame, {
      queuedSubmission: { id: 'accepted', clientUserMessageId: frame.params.clientUserMessageId },
    });
  expect((await f.chats.send(window.windowId, message)).state).toBe('sent');
  expect(f.frames().filter((frame) => frame.method === 'thread/queue/add')[0].params).toMatchObject(
    { clientUserMessageId: message.key, threadId: message.threadId },
  );
  expect(f.mutations()).toEqual([]);
});
it('rejects unsupported native queue without launching a turn', async () => {
  const f = fixture();
  await f.chats.discover();
  const window = f.chats.windows()[0];
  expect((await f.chats.read(window.windowId)).canQueue).toBe(false);
  expect((await f.chats.send(window.windowId, { ...f.input(), mode: 'queue' })).state).toBe(
    'not_sent',
  );
  expect(f.mutations()).toEqual([]);
});

it('reports a transient unreadable queue without hiding readable chat or claiming an empty queue', async () => {
  const f = fixture();
  f.state.queue = [];
  await f.chats.discover();
  const window = f.chats.windows()[0];
  expect((await f.chats.read(window.windowId)).queueReadError).toBeUndefined();
  f.state.queueReadFailure = 'Temporarily unavailable';
  f.busy();
  const unavailable = await f.chats.read(window.windowId);
  expect(unavailable).toMatchObject({
    status: 'busy',
    canSteer: true,
    canQueue: false,
    queueReadError: 'unavailable',
  });
  expect(unavailable.queuedMessages).toBeUndefined();
  f.state.queueReadFailure = 'Method not found';
  expect((await f.chats.read(window.windowId)).queueReadError).toBe('unsupported');
  f.state.queueReadFailure = undefined;
  expect(await f.chats.read(window.windowId)).toMatchObject({
    canQueue: true,
    queuedMessages: [],
    queueReadError: undefined,
  });
});

it.each([
  [
    -32600,
    'Invalid request: unknown variant `thread/queue/list`, expected one of `initialize`, `thread/start`',
    'unsupported',
  ],
  [-32601, 'The requested method is absent', 'unsupported'],
  [-32600, 'Invalid request: missing field `threadId`', 'unavailable'],
  [-32602, 'Invalid params: threadId must be a string', 'unavailable'],
  [-32600, 'Invalid request: unknown variant `queuePolicy`, expected one of `fifo`', 'unavailable'],
  [
    -32000,
    'Invalid request: unknown variant `thread/queue/list`, expected one of `initialize`',
    'unavailable',
  ],
] as const)(
  'keeps daemon queue rejection %s %s classified as %s',
  async (code, message, expected) => {
    const f = fixture();
    f.state.queueReadFailureCode = code;
    f.state.queueReadFailure = message;
    await f.chats.discover();
    const state = await f.chats.read(f.chats.windows()[0].windowId);
    expect(state).toMatchObject({ status: 'idle', canQueue: false, queueReadError: expected });
    expect(state.queuedMessages).toBeUndefined();
    expect(f.mutations()).toEqual([]);
  },
);

it.each(['timeout', 'network'] as const)(
  'keeps a daemon queue %s unavailable and recovers only on foreground discovery',
  async (failure) => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture();
    f.state.queue = [];
    await f.chats.discover();
    const id = f.chats.windows()[0].windowId;
    f.state.deferQueueRead = failure === 'timeout';
    f.state.queueReadTransportFailure = failure === 'network';
    expect(await f.chats.read(id)).toMatchObject({
      canQueue: false,
      queueReadError: 'unavailable',
    });
    expect(f.chats.windows()).toEqual([]);
    expect(f.sockets).toHaveLength(1);
    f.state.deferQueueRead = false;
    f.state.queueReadTransportFailure = false;
    now += 2001;
    await f.chats.discover();
    expect(f.sockets).toHaveLength(2);
    expect(await f.chats.read(id)).toMatchObject({
      canQueue: true,
      queuedMessages: [],
      queueReadError: undefined,
    });
    expect(f.mutations()).toEqual([]);
  },
);

it('reads stored metadata for one exact thread without loading turns or starting work', async () => {
  const f = fixture();
  const stored = (id: string, extra: Record<string, unknown>) =>
    f.state.threads.set(id, {
      ...f.thread,
      id,
      name: '',
      updatedAt: 1760000000,
      ...extra,
    } as Thread);
  stored('editor-thread', {
    source: 'vscode',
    cwd: '/fixture/agent-dock',
    preview: 'Summarize Agent Dock vision',
  });
  stored('terminal-thread', { source: 'cli', name: 'Terminal session' });
  expect(await f.chats.metadata('editor-thread')).toEqual({
    source: 'vscode',
    label: 'agent-dock',
    title: 'Summarize Agent Dock vision',
    lastActivityAt: '2025-10-09T08:53:20.000Z',
  });
  expect(await f.chats.metadata('terminal-thread')).toMatchObject({
    source: 'codex-daemon',
    label: 'Codex on this computer',
    title: 'Terminal session',
  });
  await expect(f.chats.metadata('missing-thread')).rejects.toThrow();
  expect(
    f
      .frames()
      .filter((frame) => !frame.method.startsWith('initialize'))
      .map((frame) => [frame.method, frame.params.includeTurns]),
  ).toEqual([
    ['thread/read', false],
    ['thread/read', false],
    ['thread/read', false],
  ]);
  expect(f.mutations()).toHaveLength(0);
});
