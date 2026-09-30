import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MirrorConnection, transcript, type Connection, type Provider } from './connection.js';
import { patchedSource, supportedVersion } from './patch.js';

function fixture() {
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
      expect(calls.every((c) => c.method === 'thread/read')).toBe(true);
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
