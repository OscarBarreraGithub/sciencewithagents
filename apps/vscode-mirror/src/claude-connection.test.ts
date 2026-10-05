import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ClaudeMirrorConnection,
  claudeTranscript,
  type ClaudeSurface,
  type ClaudeChannel,
  type ClaudeHost,
} from './claude-connection.js';

function fixture(confirm = true) {
  const messages: unknown[] = [
    { type: 'user', uuid: 'u1', message: { content: 'Desktop question' } },
    {
      type: 'assistant',
      uuid: 'a1',
      message: { content: [{ type: 'text', text: 'Saved reply' }] },
    },
  ];
  const accepted: unknown[] = [];
  const displayed: unknown[] = [];
  const channel: ClaudeChannel = {
    sessionId: 'thread',
    turnComplete: true,
    outstandingSendUuids: [],
    queuedCommandUuids: new Set(),
    runningBackgroundTasks: 0,
  };
  const surface: ClaudeSurface = {
    channels: new Map([['native-channel', channel]]),
    outstandingRequests: new Map(),
    async getSession() {
      return { type: 'get_session_response', messages: [...messages] };
    },
    transportMessage(id, message) {
      expect(id).toBe('native-channel');
      const frame = message as { uuid: string };
      channel.turnComplete = false;
      channel.outstandingSendUuids.push(frame.uuid);
      accepted.push(message);
      if (confirm)
        queueMicrotask(() =>
          surface.send({
            type: 'io_message',
            channelId: id,
            message: { type: 'command_lifecycle', command_uuid: frame.uuid, state: 'started' },
          }),
        );
    },
    send(frame) {
      displayed.push(frame);
    },
  };
  const host: ClaudeHost = {
    allComms: new Set([surface]),
    sessionStates: new Map([['thread', { info: { title: 'Fixture Claude' } }]]),
  };
  return {
    messages,
    accepted,
    displayed,
    channel,
    surface,
    host,
    mirror: new ClaudeMirrorConnection(host, 'Fixture', 25),
  };
}
const input = () => ({
  key: randomUUID(),
  provider: 'claude' as const,
  threadId: 'thread',
  text: 'Phone message',
});

describe('Claude Code native mirror', () => {
  it('queues a follow-up during native work only after the matching provider queue acknowledgement', async () => {
    const f = fixture(false);
    try {
      await f.mirror.select('thread');
      f.channel.turnComplete = false;
      expect(await f.mirror.read()).toMatchObject({ canQueue: true, status: 'busy' });
      const message = { ...input(), mode: 'queue' as const };
      let settled = false;
      const delivery = f.mirror.send(message).then((result) => {
        settled = true;
        return result;
      });
      await Promise.resolve();
      expect(f.accepted).toHaveLength(1);
      expect(settled).toBe(false);
      // Neither local pending UUID bookkeeping nor a replay display proves queue acceptance.
      expect(f.channel.outstandingSendUuids).toContain(message.key);
      f.surface.send({
        type: 'io_message',
        channelId: 'native-channel',
        message: {
          type: 'user',
          uuid: message.key,
          isReplay: true,
        },
      });
      f.surface.send({
        type: 'io_message',
        channelId: 'native-channel',
        message: {
          type: 'command_lifecycle',
          command_uuid: 'another-message',
          state: 'queued',
        },
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      f.channel.queuedCommandUuids.add(message.key);
      f.surface.send({
        type: 'io_message',
        channelId: 'native-channel',
        message: {
          type: 'command_lifecycle',
          command_uuid: message.key,
          state: 'queued',
        },
      });
      expect(await delivery).toEqual({
        state: 'sent',
        message: 'Queued in Claude Code. It will run when native work allows.',
      });
      expect(f.accepted).toHaveLength(1);
      expect((await f.mirror.read()).status).toBe('busy');
      expect((await f.mirror.read()).queuedMessages).toEqual([
        { id: message.key, text: message.text },
      ]);
      f.channel.queuedCommandUuids.delete(message.key);
      expect((await f.mirror.read()).queuedMessages).toEqual([]);
    } finally {
      f.mirror.dispose();
    }
  });
  it('allows the native queue to start a follow-up immediately after current work completes', async () => {
    const f = fixture();
    try {
      await f.mirror.select('thread');
      const result = await f.mirror.send({ ...input(), mode: 'queue' });
      expect(result).toEqual({
        state: 'sent',
        message: 'The follow-up started in the existing Claude Code conversation.',
      });
      expect(f.accepted).toHaveLength(1);
    } finally {
      f.mirror.dispose();
    }
  });
  it('keeps native approvals and bound identities authoritative for queued follow-ups', async () => {
    const f = fixture();
    try {
      await f.mirror.select('thread');
      f.channel.turnComplete = false;
      for (const value of [
        { ...input(), threadId: 'other', mode: 'queue' as const },
        { ...input(), provider: 'codex' as const, mode: 'queue' as const },
        { ...input(), expectedTurnId: 'not-a-Claude-turn' },
      ])
        expect((await f.mirror.send(value)).state).toBe('not_sent');
      f.surface.outstandingRequests.set('approval', { original: true });
      expect((await f.mirror.send({ ...input(), mode: 'queue' })).state).toBe('not_sent');
      expect(f.surface.outstandingRequests.get('approval')).toEqual({ original: true });
      expect(f.accepted).toHaveLength(0);
    } finally {
      f.mirror.dispose();
    }
  });
  it('retains uncertainty for an unconfirmed native queue write and does not replay it', async () => {
    const f = fixture(false);
    try {
      await f.mirror.select('thread');
      f.channel.turnComplete = false;
      const message = { ...input(), mode: 'queue' as const };
      expect((await f.mirror.send(message)).state).toBe('uncertain');
      expect((await f.mirror.send(message)).state).toBe('not_sent');
      expect(f.accepted).toHaveLength(1);
    } finally {
      f.mirror.dispose();
    }
  });
  it.each(['outstandingRequests', 'transportMessage', 'getSession', 'send'] as const)(
    'reports an unavailable capability (%s) without using native input',
    async (key) => {
      const f = fixture();
      try {
        Reflect.set(f.surface, key, undefined);
        await expect(f.mirror.choices()).rejects.toThrow('connection features');
        await f.mirror.select('thread');
        expect((await f.mirror.read()).status).toBe('offline');
        expect((await f.mirror.send(input())).state).toBe('not_sent');
        expect(f.accepted).toHaveLength(0);
      } finally {
        f.mirror.dispose();
      }
    },
  );
  it.each([
    'turnComplete',
    'outstandingSendUuids',
    'queuedCommandUuids',
    'runningBackgroundTasks',
  ] as const)('stops sharing safely when native state %s disappears', async (key) => {
    const f = fixture();
    const nativeSend = f.surface.send;
    try {
      await f.mirror.select('thread');
      Reflect.set(f.channel, key, undefined);
      const state = await f.mirror.read();
      expect(state.status).toBe('offline');
      expect(state.message).toContain('connection features');
      expect((await f.mirror.send(input())).state).toBe('not_sent');
      expect(f.accepted).toHaveLength(0);
      expect(f.surface.send).toBe(nativeSend);
    } finally {
      f.mirror.dispose();
    }
  });
  it('leaves native input usable if provider methods become read-only', async () => {
    const f = fixture();
    const send = f.surface.send;
    const transport = f.surface.transportMessage;
    Object.defineProperty(f.surface, 'transportMessage', { writable: false });
    try {
      await f.mirror.select('thread');
      expect((await f.mirror.read()).status).toBe('offline');
      expect((await f.mirror.send(input())).state).toBe('not_sent');
      expect(f.surface.send).toBe(send);
      expect(f.surface.transportMessage).toBe(transport);
      expect(f.accepted).toHaveLength(0);
    } finally {
      f.mirror.dispose();
    }
  });
  it('reads retained history from the same loaded channel and restores observation hooks', async () => {
    const f = fixture();
    const send = f.surface.send;
    const transport = f.surface.transportMessage;
    try {
      expect(await f.mirror.choices()).toEqual([{ id: 'thread', label: 'Fixture Claude' }]);
      await f.mirror.select('thread');
      expect((await f.mirror.read()).entries.map((entry) => entry.text)).toEqual([
        'Desktop question',
        'Saved reply',
      ]);
      expect(f.accepted).toHaveLength(0);
    } finally {
      f.mirror.dispose();
    }
    expect(f.surface.send).toBe(send);
    expect(f.surface.transportMessage).toBe(transport);
  });
  it('sends plain text once, synchronizes the native sidebar, and preserves native settings', async () => {
    const f = fixture();
    try {
      await f.mirror.select('thread');
      const message = input();
      expect((await f.mirror.send(message)).state).toBe('sent');
      expect(f.accepted).toEqual([
        {
          type: 'user',
          uuid: message.key,
          session_id: 'thread',
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: 'Phone message' }] },
        },
      ]);
      expect(f.displayed).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ isReplay: true, uuid: message.key }),
        }),
      );
      expect((await f.mirror.send(input())).state).toBe('not_sent');
      expect((await f.mirror.read()).entries.at(-1)?.text).toBe('Phone message');
    } finally {
      f.mirror.dispose();
    }
  });
  it('does not treat its own UI echo as a provider acknowledgement and never retries uncertain input', async () => {
    const f = fixture(false);
    try {
      await f.mirror.select('thread');
      expect((await f.mirror.send(input())).state).toBe('uncertain');
      f.channel.turnComplete = true;
      f.channel.outstandingSendUuids = [];
      expect((await f.mirror.send(input())).state).toBe('not_sent');
      expect(f.accepted).toHaveLength(1);
    } finally {
      f.mirror.dispose();
    }
  });
  it('refuses the wrong provider, changed thread, slash commands and native pending approvals', async () => {
    const f = fixture();
    try {
      await f.mirror.select('thread');
      for (const value of [
        { ...input(), provider: 'codex' as const },
        { ...input(), threadId: 'wrong' },
        { ...input(), text: '/settings' },
      ])
        expect((await f.mirror.send(value)).state).toBe('not_sent');
      f.surface.outstandingRequests.set('native-approval', {});
      expect((await f.mirror.read()).status).toBe('attention');
      expect((await f.mirror.send(input())).state).toBe('not_sent');
      expect(f.surface.outstandingRequests.size).toBe(1);
      expect(f.accepted).toHaveLength(0);
    } finally {
      f.mirror.dispose();
    }
  });
  it('checks busy state at the actual write boundary for simultaneous phone and native input', async () => {
    const f = fixture();
    try {
      await f.mirror.select('thread');
      const results = await Promise.all([f.mirror.send(input()), f.mirror.send(input())]);
      expect(results.map((result) => result.state).sort()).toEqual(['not_sent', 'sent']);
      expect(f.accepted).toHaveLength(1);
    } finally {
      f.mirror.dispose();
    }
  });
  it('mirrors native sends and partial output and reconnects only to the chosen session', async () => {
    const f = fixture();
    try {
      await f.mirror.select('thread');
      f.surface.transportMessage('native-channel', {
        type: 'user',
        uuid: 'desktop',
        message: { content: 'Desktop follow-up' },
      });
      for (const event of [
        { type: 'message_start', message: { id: 'stream' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Live ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply' } },
      ])
        f.surface.send({
          type: 'io_message',
          channelId: 'native-channel',
          message: { type: 'stream_event', event },
        });
      expect((await f.mirror.read()).entries.at(-1)?.text).toBe('Live reply');
      f.surface.channels.clear();
      expect((await f.mirror.read()).status).toBe('offline');
      f.surface.channels.set('different', { ...f.channel, sessionId: 'other' });
      expect((await f.mirror.read()).status).toBe('offline');
      f.surface.channels.set('restored', {
        ...f.channel,
        turnComplete: true,
        outstandingSendUuids: [],
      });
      expect((await f.mirror.read()).status).toBe('idle');
    } finally {
      f.mirror.dispose();
    }
  });
  it('will not pick one of two ambiguous loaded channels or replace a new selection with late history', async () => {
    const f = fixture();
    try {
      let release!: (value: unknown) => void;
      f.surface.getSession = () =>
        new Promise((resolve) => {
          release = resolve;
        });
      const selecting = f.mirror.select('thread');
      await f.mirror.select(null);
      release({ type: 'get_session_response', messages: f.messages });
      await selecting;
      expect((await f.mirror.read()).entries).toEqual([]);
      f.surface.channels.set('duplicate', { ...f.channel });
      expect(await f.mirror.choices()).toEqual([]);
      await f.mirror.select('thread');
      expect((await f.mirror.read()).status).toBe('offline');
    } finally {
      f.mirror.dispose();
    }
  });
  it('does not leak a new unshared session when native code reuses the same channel object', async () => {
    const f = fixture(false);
    try {
      await f.mirror.select('thread');
      f.channel.sessionId = 'unshared';
      const message = {
        type: 'assistant',
        uuid: 'private-reply',
        session_id: 'unshared',
        message: { content: [{ type: 'text', text: 'PRIVATE UNSELECTED REPLY' }] },
      };
      const frame = { type: 'io_message', channelId: 'native-channel', message };
      f.surface.send(frame);
      f.surface.transportMessage('native-channel', {
        type: 'user',
        uuid: 'private-user',
        session_id: 'unshared',
        message: { content: 'PRIVATE UNSELECTED INPUT' },
      });
      const state = await f.mirror.read();
      expect(state.status).toBe('offline');
      expect(state.entries.map((entry) => entry.text)).toEqual(['Desktop question', 'Saved reply']);
      expect(f.displayed).toContainEqual(frame);
      expect(f.accepted).toHaveLength(1);
    } finally {
      f.mirror.dispose();
    }
  });
  it('rejects mismatched session frames, replaced channel objects and late callbacks after selection changes', async () => {
    const f = fixture(false);
    try {
      await f.mirror.select('thread');
      const oldSend = f.surface.send;
      const oldTransport = f.surface.transportMessage;
      const frame = (session_id: string, text: string) => ({
        type: 'io_message',
        channelId: 'native-channel',
        message: {
          type: 'assistant',
          uuid: text,
          session_id,
          message: { content: [{ type: 'text', text }] },
        },
      });
      f.surface.send(frame('foreign', 'FOREIGN FRAME'));
      expect((await f.mirror.read()).entries.map((entry) => entry.text)).toEqual([
        'Desktop question',
        'Saved reply',
      ]);
      f.surface.channels.set('native-channel', { ...f.channel });
      oldSend.call(f.surface, frame('thread', 'REPLACED CHANNEL'));
      expect((await f.mirror.read()).entries.map((entry) => entry.text)).toEqual([
        'Desktop question',
        'Saved reply',
      ]);
      f.channel.sessionId = 'second';
      f.surface.channels.set('native-channel', f.channel);
      f.surface.getSession = async () => ({ type: 'get_session_response', messages: [] });
      await f.mirror.select('second');
      oldSend.call(f.surface, frame('thread', 'OLD SESSION'));
      oldSend.call(f.surface, frame('second', 'STALE CALLBACK NEW SESSION'));
      oldTransport.call(f.surface, 'native-channel', {
        type: 'user',
        uuid: 'old-user',
        session_id: 'thread',
        message: { content: 'OLD NATIVE INPUT' },
      });
      f.surface.send(frame('second', 'SELECTED NEW SESSION'));
      expect((await f.mirror.read()).entries.map((entry) => entry.text)).toEqual([
        'SELECTED NEW SESSION',
      ]);
      expect(f.displayed).toHaveLength(5);
      expect(f.accepted).toHaveLength(1);
    } finally {
      f.mirror.dispose();
    }
  });
  it('keeps visible tool output without copying opaque provider fields', () => {
    const entries = claudeTranscript([
      {
        type: 'assistant',
        uuid: 'a',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file: 'example' } },
            { type: 'redacted_thinking', data: 'SECRET' },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u',
        message: { content: [{ type: 'tool_result', content: 'visible output' }] },
      },
    ]);
    expect(entries.map((entry) => entry.text).join('\n')).toContain('visible output');
    expect(JSON.stringify(entries)).not.toContain('SECRET');
  });
  it('bounds unavailable history reads and allows a later read-only recovery', async () => {
    const f = fixture();
    f.mirror.dispose();
    const mirror = new ClaudeMirrorConnection(f.host, 'Fixture', 25, 25);
    const read = f.surface.getSession;
    f.surface.getSession = () => new Promise(() => {});
    try {
      await mirror.select('thread');
      expect((await mirror.read()).status).toBe('offline');
      f.surface.getSession = read;
      expect((await mirror.read()).status).toBe('idle');
      expect(f.accepted).toHaveLength(0);
    } finally {
      mirror.dispose();
    }
  });
});
