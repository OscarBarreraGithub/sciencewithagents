import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexDaemonChats } from './codex-daemon-chats.js';

type Frame = { id?: number; method: string; params: Record<string, unknown> };
type Thread = {
  id: string;
  ephemeral: boolean;
  canAcceptDirectInput?: boolean;
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
  reject(frame: Frame, message: string) {
    this.emit(
      'message',
      Buffer.from(JSON.stringify({ id: frame.id, error: { code: -32000, message } })),
    );
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
