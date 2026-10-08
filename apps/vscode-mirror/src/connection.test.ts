import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MirrorConnection, transcript, type Connection, type Provider } from './connection.js';
import { patchedSource, supportedVersion } from './patch.js';

function fixture(updatedAt?: number) {
  const providers = new Map<string, Provider>();
  const calls: { method: string; params: unknown }[] = [];
  let active = false;
  const connection: Connection = {
    providers,
    initialized: true,
    registerProvider(name, p) {
      providers.set(name, p);
      return {
        dispose() {
          providers.delete(name);
        },
      };
    },
    sendRequest(p, id, method, params, delivery = false) {
      this.sendProviderRequest(p, id, method, params, false, delivery);
    },
    sendProviderRequest(p, id, method, params) {
      calls.push({ method, params });
      let result: unknown = {};
      if (method === 'thread/read')
        result = {
          thread: {
            id: 'thread',
            updatedAt,
            status: { type: active ? 'active' : 'idle' },
            turns: [
              {
                id: 'old',
                status: 'completed',
                items: [
                  {
                    id: 'u',
                    type: 'userMessage',
                    content: [{ type: 'text', text: 'Desktop message' }],
                  },
                  { id: 'a', type: 'agentMessage', text: 'Old reply' },
                ],
              },
            ],
          },
        };
      if (method === 'turn/start') {
        active = true;
        for (const provider of providers.values())
          provider.onNotification?.({ method: 'turn/started', params: { threadId: 'thread' } });
      }
      queueMicrotask(() => providers.get(p)?.onResult?.({ id, result }));
    },
  };
  return { connection, calls, mirror: new MirrorConnection(connection, 'Fixture') };
}
describe('native connection mirror', () => {
  it('uses saved Codex conversation time without refreshing it on repeated reads', async () => {
    const f = fixture(1760000000);
    try {
      await f.mirror.select('thread');
      expect(f.mirror.summary.lastActivityAt).toBe('2025-10-09T08:53:20.000Z');
      expect((await f.mirror.read(true)).lastActivityAt).toBe(f.mirror.summary.lastActivityAt);
      await f.mirror.select(null);
      expect(f.mirror.summary.lastActivityAt).toBeUndefined();
    } finally {
      f.mirror.dispose();
    }
  });
  it('does not replace newer desktop activity with a stale idle history response', async () => {
    const { mirror, connection, calls } = fixture();
    try {
      await mirror.select('thread');
      const send = connection.sendRequest.bind(connection);
      connection.sendRequest = (provider, id, method, params, delivery) => {
        send(provider, id, method, params, delivery);
        if (method === 'thread/read')
          for (const p of connection.providers.values())
            p.onNotification?.({ method: 'turn/started', params: { threadId: 'thread' } });
      };
      expect(
        (await mirror.send({ key: randomUUID(), threadId: 'thread', text: 'race' })).state,
      ).toBe('not_sent');
      expect(calls.filter((c) => c.method === 'turn/start')).toHaveLength(0);
    } finally {
      mirror.dispose();
    }
  });
  it('merges live output without waiting for a completed saved item', async () => {
    const { mirror, connection } = fixture();
    try {
      await mirror.select('thread');
      for (const p of connection.providers.values()) {
        p.onNotification?.({ method: 'turn/started', params: { threadId: 'thread' } });
        p.onNotification?.({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread', turnId: 'live', itemId: 'answer', delta: 'First ' },
        });
        p.onNotification?.({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread', turnId: 'live', itemId: 'answer', delta: 'words' },
        });
      }
      expect((await mirror.read()).entries.at(-1)?.text).toBe('First words');
    } finally {
      mirror.dispose();
    }
  });
  it('reads all returned history without resuming or starting a second context', async () => {
    const { mirror, calls } = fixture();
    try {
      await mirror.select('thread');
      const state = await mirror.read();
      expect(state.entries.map((e) => e.text)).toEqual(['Desktop message', 'Old reply']);
      expect(
        calls.every((c) =>
          ['thread/read', 'thread/turns/list', 'thread/queue/list'].includes(c.method),
        ),
      ).toBe(true);
    } finally {
      mirror.dispose();
    }
  });
  it('sends only text to the existing thread and refuses a busy or wrong target', async () => {
    const { mirror, calls } = fixture();
    try {
      await mirror.select('thread');
      const input = { key: randomUUID(), threadId: 'thread', text: 'Phone input' };
      expect((await mirror.send({ ...input, provider: 'claude' })).state).toBe('not_sent');
      expect((await mirror.send({ ...input, threadId: 'wrong' })).state).toBe('not_sent');
      expect((await mirror.send(input)).state).toBe('sent');
      expect((await mirror.send({ ...input, key: randomUUID() })).state).toBe('not_sent');
      expect(calls.filter((c) => c.method === 'turn/start')).toEqual([
        {
          method: 'turn/start',
          params: {
            threadId: 'thread',
            input: [{ type: 'text', text: 'Phone input', text_elements: [] }],
          },
        },
      ]);
    } finally {
      mirror.dispose();
    }
  });
  it('serializes concurrent sends at the native write boundary and restores the hook', async () => {
    const { mirror, connection, calls } = fixture();
    const original = connection.sendProviderRequest;
    await mirror.select('thread');
    const results = await Promise.all([
      mirror.send({ key: randomUUID(), threadId: 'thread', text: 'one' }),
      mirror.send({ key: randomUUID(), threadId: 'thread', text: 'two' }),
    ]);
    expect(results.filter((r) => r.state === 'sent')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'turn/start')).toHaveLength(1);
    mirror.dispose();
    expect(connection.sendProviderRequest).not.toBe(original);
    expect(connection.providers.size).toBe(0);
  });
  it('retains command output and labels unsupported activity without exposing opaque reasoning', () => {
    const entries = transcript({
      turns: [
        {
          items: [
            {
              type: 'commandExecution',
              command: 'echo hello',
              aggregatedOutput: 'hello',
              exitCode: 0,
            },
            { type: 'opaqueFutureItem', encrypted: 'private' },
          ],
        },
      ],
    });
    expect(entries[0].text).toContain('hello');
    expect(entries[1].text).toContain('view this item in VS Code');
    expect(JSON.stringify(entries)).not.toContain('private');
  });
  it('refuses unknown version, edited assets and a fake matching anchor', () => {
    expect(() =>
      patchedSource('let b=new vI(t.extensionUri,c);e.push(b);', supportedVersion),
    ).toThrow('not supported');
    expect(() => patchedSource('', 'future')).toThrow('not supported');
  });
});

it('offers personal loaded chats without native subagents or app-created helpers', async () => {
  const { connection, mirror } = fixture();
  const threads: Record<string, Record<string, unknown>> = {
    personal: { id: 'personal', name: 'My conversation', source: 'vscode' },
    child: { id: 'child', source: { subAgent: { thread_spawn: {} } } },
    linked: { id: 'linked', parentThreadId: 'personal' },
    managed: { id: 'managed', threadSource: 'sciencewithagents' },
    temporary: { id: 'temporary', ephemeral: true },
  };
  connection.sendRequest = (provider, id, method, params) => {
    const result =
      method === 'thread/loaded/list'
        ? { data: Object.keys(threads) }
        : { thread: threads[(params as { threadId: string }).threadId] };
    queueMicrotask(() => connection.providers.get(provider)?.onResult?.({ id, result }));
  };
  try {
    expect(await mirror.choices()).toEqual([{ id: 'personal', label: 'My conversation' }]);
  } finally {
    mirror.dispose();
  }
});

it('rechecks explicit helper provenance after sharing, without hiding a personal chat by title', async () => {
  const { connection, mirror, calls } = fixture();
  let helper = false;
  const send = connection.sendRequest.bind(connection);
  connection.sendRequest = (provider, id, method, params, delivery) => {
    if (method !== 'thread/read') return send(provider, id, method, params, delivery);
    queueMicrotask(() =>
      connection.providers.get(provider)?.onResult?.({
        id,
        result: {
          thread: {
            id: 'thread',
            name: 'Computer health',
            status: { type: 'idle' },
            turns: [],
            ...(helper ? { threadSource: 'sciencewithagents' } : {}),
          },
        },
      }),
    );
  };
  try {
    await mirror.select('thread');
    expect((await mirror.read(true)).status).toBe('idle');
    helper = true;
    expect(await mirror.read(true)).toMatchObject({ status: 'offline', entries: [] });
    expect(
      await mirror.send({ key: randomUUID(), threadId: 'thread', text: 'Do not send' }),
    ).toMatchObject({ state: 'not_sent' });
    expect(calls.filter((call) => call.method.startsWith('turn/'))).toEqual([]);
  } finally {
    mirror.dispose();
  }
});

/** A Codex build with native turn paging; `turns` is oldest first. */
function pagingFixture(
  turnCount: number,
  options: { pages?: 'unsupported' | 'summary' | 'repeating' } = {},
) {
  const providers = new Map<string, Provider>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const turn = (n: number) => ({
    id: `turn-${n}`,
    status: 'completed',
    items: [
      { id: 'u', type: 'userMessage', content: [{ type: 'text', text: `Question ${n}` }] },
      { id: 'a', type: 'agentMessage', text: `Answer ${n}` },
    ],
  });
  const state = { turns: Array.from({ length: turnCount }, (_, n) => turn(n)), active: false };
  let failReads = false;
  const connection: Connection = {
    providers,
    initialized: true,
    registerProvider(name, p) {
      providers.set(name, p);
      return { dispose: () => providers.delete(name) };
    },
    sendRequest(p, id, method, params, delivery = false) {
      this.sendProviderRequest(p, id, method, params, false, delivery);
    },
    sendProviderRequest(p, id, method, raw) {
      const params = raw as Record<string, unknown>;
      calls.push({ method, params });
      const reply = (response: Record<string, unknown>) =>
        queueMicrotask(() => providers.get(p)?.onResult?.({ id, ...response }));
      const thread = {
        id: 'thread',
        name: 'Long conversation',
        status: { type: state.active ? 'active' : 'idle' },
      };
      if (method === 'thread/read') {
        if (failReads) return reply({ error: { code: -32000, message: 'Read failed.' } });
        return reply({
          result: { thread: params.includeTurns ? { ...thread, turns: state.turns } : thread },
        });
      }
      if (method === 'thread/turns/list') {
        if (options.pages === 'unsupported')
          return reply({ error: { code: -32601, message: 'Method not found' } });
        const newest = [...state.turns].reverse();
        const start = Number(params.cursor ?? 0);
        const data = newest.slice(start, start + Number(params.limit));
        const next =
          options.pages === 'repeating'
            ? '0'
            : start + data.length < newest.length
              ? String(start + data.length)
              : null;
        return reply({
          result: {
            data:
              options.pages === 'summary'
                ? data.map((t) => ({ ...t, itemsView: 'summary' }))
                : data,
            nextCursor: next,
          },
        });
      }
      if (method === 'thread/queue/list') return reply({ result: { data: [] } });
      reply({ result: {} });
    },
  };
  const notify = () => {
    for (const provider of providers.values())
      provider.onNotification?.({ method: 'item/completed', params: { threadId: 'thread' } });
  };
  return {
    calls,
    state,
    turn,
    notify,
    failReads: () => (failReads = true),
    mirror: new MirrorConnection(connection, 'Paging fixture'),
  };
}
const full = (turns: unknown[]) => transcript({ turns });

describe('native turn paging', () => {
  it('pages the saved history once, then re-reads only the newest turns', async () => {
    const { mirror, calls, state, turn, notify } = pagingFixture(45);
    try {
      await mirror.select('thread');
      // A fresh, unchanged reading is reused without another native request.
      const first = await mirror.read();
      // Identical entry IDs and text to the full-history read.
      expect(first.entries).toEqual(full(state.turns));
      expect(calls.filter((c) => c.method === 'thread/turns/list')).toHaveLength(3);
      expect(calls.some((c) => c.method === 'thread/read' && c.params.includeTurns)).toBe(false);

      calls.length = 0;
      state.turns[44] = {
        ...turn(44),
        items: [...turn(44).items, { id: 'b', type: 'agentMessage', text: 'More' }],
      };
      state.turns.push(turn(45));
      notify();
      const next = await mirror.read(true);
      expect(next.entries).toEqual(full(state.turns));
      expect(calls.filter((c) => c.method === 'thread/turns/list')).toEqual([
        {
          method: 'thread/turns/list',
          params: { threadId: 'thread', limit: 3, sortDirection: 'desc', itemsView: 'full' },
        },
      ]);

      // More new turns than the tail covers: page the whole history again, never a gap.
      calls.length = 0;
      state.turns.push(turn(46), turn(47), turn(48), turn(49));
      notify();
      expect((await mirror.read(true)).entries).toEqual(full(state.turns));
      expect(calls.filter((c) => c.method === 'thread/turns/list').length).toBeGreaterThan(1);
      expect(calls.some((c) => c.params.includeTurns)).toBe(false);
    } finally {
      mirror.dispose();
    }
  });
  it.each(['unsupported', 'summary', 'repeating'] as const)(
    'falls back to the full-history read when native paging is %s',
    async (pages) => {
      const { mirror, calls, state, notify } = pagingFixture(5, { pages });
      try {
        await mirror.select('thread');
        expect((await mirror.read()).entries).toEqual(full(state.turns));
        // A repeated cursor is detected on its second appearance, then never retried.
        expect(calls.filter((c) => c.method === 'thread/turns/list')).toHaveLength(
          pages === 'repeating' ? 2 : 1,
        );
        expect(
          calls.filter((c) => c.method === 'thread/read' && c.params.includeTurns),
        ).toHaveLength(1);
        calls.length = 0;
        notify();
        expect((await mirror.read(true)).entries).toEqual(full(state.turns));
        // The capability result is kept for this shared thread.
        expect(calls.map((c) => c.method)).not.toContain('thread/turns/list');
        expect(
          calls.filter((c) => c.method === 'thread/read' && c.params.includeTurns),
        ).toHaveLength(1);
      } finally {
        mirror.dispose();
      }
    },
  );
  it('refuses a stale steer when the latest native read fails', async () => {
    const { mirror, calls, state, failReads } = pagingFixture(2);
    try {
      state.turns[1] = { ...state.turns[1], status: 'inProgress' };
      state.active = true;
      await mirror.select('thread');
      const busy = await mirror.read(true);
      expect(busy).toMatchObject({ status: 'busy', steerToken: 'turn-1' });
      failReads();
      expect(
        await mirror.send({
          key: randomUUID(),
          threadId: 'thread',
          expectedTurnId: 'turn-1',
          text: 'Stale steer',
        }),
      ).toMatchObject({ state: 'not_sent' });
      expect((await mirror.read(true)).status).toBe('offline');
      expect(calls.map((c) => c.method)).not.toContain('turn/steer');
    } finally {
      mirror.dispose();
    }
  });
});
