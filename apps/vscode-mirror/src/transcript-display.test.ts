import { describe, expect, it, vi } from 'vitest';
import { MirrorConnection, transcript, type Connection, type Provider } from './connection.js';
import { codexTranscript } from '@dock/shared';

const item = (result: unknown) => ({
  id: 'tool',
  type: 'mcpToolCall',
  server: 'fixture',
  tool: 'read',
  arguments: { path: 'fixture.txt' },
  result,
});

function fixture(result: unknown) {
  const providers = new Map<string, Provider>();
  const calls: string[] = [];
  const nativeItem = item(result);
  const connection: Connection = {
    providers,
    initialized: true,
    registerProvider(name, provider) {
      providers.set(name, provider);
      return { dispose: () => providers.delete(name) };
    },
    sendRequest(provider, id, method, params, delivery = false) {
      this.sendProviderRequest(provider, id, method, params, false, delivery);
    },
    sendProviderRequest(provider, id, method) {
      calls.push(method);
      const response =
        method === 'thread/turns/list'
          ? { error: { code: -32601, message: 'Method not found' } }
          : {
              result:
                method === 'thread/read'
                  ? {
                      thread: {
                        id: 'thread',
                        status: { type: 'idle' },
                        turns: [{ id: 'turn', status: 'completed', items: [nativeItem] }],
                      },
                    }
                  : { data: [] },
            };
      queueMicrotask(() => providers.get(provider)?.onResult?.({ id, ...response }));
    },
  };
  return { connection, calls, nativeItem, mirror: new MirrorConnection(connection, 'Fixture') };
}

describe('Codex companion tool display work', () => {
  it('does not serialize giant tool results in fallback history', async () => {
    const result = { content: [{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024) }] };
    const f = fixture(result);
    const stringify = JSON.stringify;
    let rawSerializations = 0;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      if (value === result) rawSerializations++;
      return stringify(value, replacer, space);
    });
    try {
      await f.mirror.select('thread');
      expect(rawSerializations).toBe(0);
      const saved = (await f.mirror.read()).entries[0];
      expect(saved.id).toBe('turn:tool');
      expect(saved.text).toContain('Tool details are too large to display here.');
      expect(saved.text).toContain('View the original in VS Code.');
      expect(saved.text.length).toBeLessThan(1000);
      for (const p of f.connection.providers.values()) {
        p.onNotification?.({
          method: 'item/completed',
          params: { threadId: 'thread', turnId: 'live', item: f.nativeItem },
        });
      }
      expect(rawSerializations).toBe(0);
      expect((await f.mirror.read()).entries.at(-1)?.text).toBe(saved.text);
      expect(f.nativeItem.result).toBe(result);
      expect(result.content[0].text.length).toBe(8 * 1024 * 1024);
      expect(
        f.calls.every((method) =>
          ['thread/read', 'thread/turns/list', 'thread/queue/list'].includes(method),
        ),
      ).toBe(true);
    } finally {
      spy.mockRestore();
      f.mirror.dispose();
    }
  });

  it('does not serialize giant results inside the original native completed-item callback', async () => {
    const f = fixture({ content: [] });
    const result = { content: [{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024) }] };
    const completed = item(result);
    const stringify = JSON.stringify;
    let rawSerializations = 0;
    await f.mirror.select('thread');
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      if (value === result) rawSerializations++;
      return stringify(value, replacer, space);
    });
    try {
      for (const provider of f.connection.providers.values())
        provider.onNotification?.({
          method: 'item/completed',
          params: { threadId: 'thread', turnId: 'live', item: completed },
        });
      expect(rawSerializations).toBe(0);
      const entry = (await f.mirror.read()).entries.at(-1);
      expect(entry?.id).toBe('live:tool');
      expect(entry?.text).toContain('Tool details are too large to display here.');
      expect(completed.result).toBe(result);
    } finally {
      spy.mockRestore();
      f.mirror.dispose();
    }
  });

  it('retains exact ordinary tool details and original user/assistant text', () => {
    const result = { content: [{ type: 'text', text: 'ordinary tool output' }] };
    const message = 'exact message\n'.repeat(30_000);
    const entries = transcript({
      turns: [
        {
          id: 'turn',
          items: [
            item(result),
            { ...item(result), type: 'dynamicToolCall' },
            { id: 'owner', type: 'userMessage', content: [{ type: 'text', text: message }] },
            { id: 'reply', type: 'agentMessage', text: message },
          ],
        },
      ],
    });
    expect(entries[0].text).toBe(
      `mcpToolCall\nfixture read\n{"path":"fixture.txt"}\n${JSON.stringify(result)}`,
    );
    expect(entries[1].text).toBe(
      `dynamicToolCall\nfixture read\n{"path":"fixture.txt"}\n${JSON.stringify(result)}`,
    );
    expect(entries[2].text).toBe(message);
    expect(entries[3].text).toBe(message);
  });

  it.each([
    ['many values', { values: Array.from({ length: 5000 }, () => 'small') }],
    ['combined text', { values: Array.from({ length: 1024 }, () => 'x'.repeat(300)) }],
    [
      'deep result',
      Array.from({ length: 100 }).reduce<unknown>((value) => ({ child: value }), 'leaf'),
    ],
  ])('bounds %s before JSON serialization without changing native data', (_name, result) => {
    const stringify = JSON.stringify;
    let rawSerializations = 0;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      if (value === result) rawSerializations++;
      return stringify(value, replacer, space);
    });
    try {
      const nativeItem = item(result);
      const entries = transcript({ turns: [{ id: 'turn', items: [nativeItem] }] });
      expect(rawSerializations).toBe(0);
      expect(entries[0].text).toContain('Tool details are too large to display here.');
      expect(nativeItem.result).toBe(result);
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves the existing non-companion transcript converter unchanged', () => {
    const result = { values: Array.from({ length: 5000 }, () => 'ordinary native data') };
    const entries = codexTranscript({ turns: [{ id: 'turn', items: [item(result)] }] });
    expect(entries[0].text).toContain(JSON.stringify(result));
  });

  it('retains exact small acyclic tool details with repeated object references', () => {
    const shared = { text: 'reused ordinary detail' };
    const result = { first: shared, second: shared };
    const entries = transcript({ turns: [{ id: 'turn', items: [item(result)] }] });
    expect(entries[0].text).toBe(
      `mcpToolCall\nfixture read\n{"path":"fixture.txt"}\n${JSON.stringify(result)}`,
    );
    expect(result.first).toBe(result.second);
  });

  it('bounds cyclic tool details before JSON serialization without changing them', () => {
    const result: Record<string, unknown> = { text: 'cyclic fixture' };
    result.self = result;
    const stringify = JSON.stringify;
    let rawSerializations = 0;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      if (value === result) rawSerializations++;
      return stringify(value, replacer, space);
    });
    try {
      const entries = transcript({ turns: [{ id: 'turn', items: [item(result)] }] });
      expect(rawSerializations).toBe(0);
      expect(entries[0].text).toBe(
        'mcpToolCall\nfixture read\n[Tool details are too large to display here. View the original in VS Code.]',
      );
      expect(result.self).toBe(result);
    } finally {
      spy.mockRestore();
    }
  });
});
