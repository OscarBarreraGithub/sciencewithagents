import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mirrorControlSchema, type MirrorControl } from '@dock/shared';
import { MirrorConnection, type Connection, type Provider } from './connection.js';
import {
  ClaudeMirrorConnection,
  type ClaudeChannel,
  type ClaudeHost,
  type ClaudeSurface,
} from './claude-connection.js';

const dispose: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of dispose.splice(0)) cleanup();
  vi.useRealTimers();
});
const control = (provider: 'codex' | 'claude', token: string): MirrorControl => ({
  key: randomUUID(),
  provider,
  threadId: 'thread',
  action: 'interrupt',
  token,
});

function codexFixture() {
  const providers = new Map<string, Provider>();
  const calls: { method: string; params: unknown }[] = [];
  const pendingInterrupts: (() => void)[] = [];
  const state = {
    activeTurn: 'turn-one',
    deferInterrupt: false,
    failRead: false,
    afterRead: undefined as (() => void) | undefined,
  };
  const connection: Connection = {
    initialized: true,
    providers,
    registerProvider(name, provider) {
      providers.set(name, provider);
      return {
        dispose: () => {
          providers.delete(name);
        },
      };
    },
    sendRequest(provider, id, method, params, delivery = false) {
      this.sendProviderRequest(provider, id, method, params, false, delivery);
    },
    sendProviderRequest(provider, id, method, params) {
      calls.push({ method, params });
      const response =
        method === 'thread/read'
          ? {
              thread: {
                id: 'thread',
                status: { type: state.activeTurn ? 'active' : 'idle' },
                turns: state.activeTurn
                  ? [{ id: state.activeTurn, status: 'inProgress', items: [] }]
                  : [],
              },
            }
          : {};
      if (method === 'thread/read') {
        const callback = state.afterRead;
        state.afterRead = undefined;
        callback?.();
      }
      const reply = () =>
        providers
          .get(provider)
          ?.onResult?.(
            method === 'thread/read' && state.failRead
              ? { id, error: { message: 'History unavailable' } }
              : { id, result: response },
          );
      if (method === 'turn/interrupt' && state.deferInterrupt) pendingInterrupts.push(reply);
      else queueMicrotask(reply);
    },
  };
  const mirror = new MirrorConnection(connection, 'Codex control fixture');
  dispose.push(() => mirror.dispose());
  const notify = (method: string, params: unknown) => {
    for (const provider of providers.values()) provider.onNotification?.({ method, params });
  };
  const stops = () => calls.filter((call) => call.method === 'turn/interrupt');
  return { mirror, connection, calls, state, pendingInterrupts, notify, stops };
}

function claudeFixture() {
  const interrupt = vi.fn(async (): Promise<unknown> => undefined);
  const channel: ClaudeChannel = {
    sessionId: 'thread',
    turnComplete: false,
    outstandingSendUuids: [],
    queuedCommandUuids: new Set(),
    runningBackgroundTasks: 0,
    query: { interrupt },
  };
  const nativeSends: unknown[] = [];
  const surface: ClaudeSurface = {
    channels: new Map([['native-channel', channel]]),
    outstandingRequests: new Map(),
    async getSession() {
      return { type: 'get_session_response', messages: [] };
    },
    transportMessage() {
      channel.turnComplete = false;
    },
    send(frame) {
      nativeSends.push(frame);
    },
  };
  const host: ClaudeHost = {
    allComms: new Set([surface]),
    sessionStates: new Map([['thread', { info: {} }]]),
  };
  const mirror = new ClaudeMirrorConnection(host, 'Claude control fixture', 20);
  dispose.push(() => mirror.dispose());
  const frame = (message: unknown) =>
    surface.send({
      type: 'io_message',
      channelId: 'native-channel',
      message,
    });
  return { mirror, host, channel, surface, interrupt, frame, nativeSends };
}

describe('typed mirror control contract', () => {
  it('permits only a bounded exact-target stop request', () => {
    expect(mirrorControlSchema.parse(control('codex', 'turn-one')).action).toBe('interrupt');
    for (const change of [
      { action: 'shell' },
      { token: '' },
      { token: 'x'.repeat(129) },
      { method: 'arbitrary/rpc' },
      { command: 'arbitrary command' },
    ])
      expect(
        mirrorControlSchema.safeParse({ ...control('codex', 'turn-one'), ...change }).success,
      ).toBe(false);
  });
});

describe('Codex exact-turn stop', () => {
  it('uses the observed native turn without a new session or model message', async () => {
    const f = codexFixture();
    await f.mirror.select('thread');
    expect((await f.mirror.read()).stopToken).toBe('turn-one');
    expect((await f.mirror.control(control('codex', 'turn-one'))).state).toBe('sent');
    expect(f.stops()).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn-one' } },
    ]);
    // History and native queue reads are the only other calls; no turn/start,
    // thread/start or thread/queue/add may accompany a stop.
    const allowed = ['thread/read', 'thread/queue/list', 'turn/interrupt'];
    expect(f.calls.every(({ method }) => allowed.includes(method))).toBe(true);
    const threads = f.calls.map(({ params }) => (params as { threadId?: string }).threadId);
    expect(new Set(threads)).toEqual(new Set(['thread']));
  });
  it('rejects another provider, another thread, stale tokens and idle conversations', async () => {
    const f = codexFixture();
    await f.mirror.select('thread');
    for (const value of [
      control('claude', 'turn-one'),
      { ...control('codex', 'turn-one'), threadId: 'other' },
      control('codex', 'stale'),
    ])
      expect((await f.mirror.control(value)).state).toBe('not_sent');
    f.state.activeTurn = '';
    expect((await f.mirror.control(control('codex', 'turn-one'))).state).toBe('not_sent');
    expect((await f.mirror.read()).stopToken).toBeUndefined();
    expect(f.stops()).toHaveLength(0);
  });
  it('never replaces a newer native turn with a stale in-flight history snapshot', async () => {
    const f = codexFixture();
    await f.mirror.select('thread');
    f.state.afterRead = () => {
      f.state.activeTurn = 'new-turn';
      f.notify('turn/started', { threadId: 'thread', turn: { id: 'new-turn' } });
    };
    expect((await f.mirror.control(control('codex', 'turn-one'))).state).toBe('not_sent');
    expect(f.stops()).toHaveLength(0);
    expect((await f.mirror.read()).stopToken).toBe('new-turn');
  });
  it('does not stop anything if the fresh history read fails', async () => {
    const f = codexFixture();
    await f.mirror.select('thread');
    f.state.failRead = true;
    expect((await f.mirror.control(control('codex', 'turn-one'))).state).toBe('not_sent');
    expect(f.stops()).toHaveLength(0);
  });
  it('cannot send a late stop through a disposed adapter', async () => {
    const f = codexFixture();
    await f.mirror.select('thread');
    const count = f.calls.length;
    f.mirror.dispose();
    expect((await f.mirror.control(control('codex', 'turn-one'))).state).toBe('not_sent');
    expect(f.calls).toHaveLength(count);
  });
  it('rechecks ownership after an in-flight read loses its selected conversation', async () => {
    const f = codexFixture();
    await f.mirror.select('thread');
    f.state.afterRead = () => {
      f.mirror.dispose();
    };
    expect((await f.mirror.control(control('codex', 'turn-one'))).state).toBe('not_sent');
    expect(f.stops()).toHaveLength(0);
  });
  it('permits a separately observed later turn without reusing the previous control', async () => {
    const f = codexFixture();
    await f.mirror.select('thread');
    expect((await f.mirror.control(control('codex', 'turn-one'))).state).toBe('sent');
    f.state.activeTurn = 'turn-two';
    f.notify('turn/started', { threadId: 'thread', turn: { id: 'turn-two' } });
    expect((await f.mirror.control(control('codex', 'turn-one'))).state).toBe('not_sent');
    expect((await f.mirror.read()).stopToken).toBe('turn-two');
    expect((await f.mirror.control(control('codex', 'turn-two'))).state).toBe('sent');
    expect(f.stops().map((call) => call.params)).toEqual([
      { threadId: 'thread', turnId: 'turn-one' },
      { threadId: 'thread', turnId: 'turn-two' },
    ]);
  });
  it('claims a displayed control once across simultaneous device requests', async () => {
    const f = codexFixture();
    await f.mirror.select('thread');
    f.state.deferInterrupt = true;
    const first = f.mirror.control(control('codex', 'turn-one'));
    const second = f.mirror.control(control('codex', 'turn-one'));
    await vi.waitFor(() => expect(f.stops().length).toBeGreaterThan(0));
    for (const reply of f.pendingInterrupts) reply();
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.map((result) => result.state).sort()).toEqual(['not_sent', 'sent']);
    expect(f.stops()).toHaveLength(1);
  });
  it('does not replay an uncertain stop when an old control arrives again', async () => {
    vi.useFakeTimers();
    const f = codexFixture();
    await f.mirror.select('thread');
    f.state.deferInterrupt = true;
    const input = control('codex', 'turn-one');
    const result = f.mirror.control(input);
    await vi.advanceTimersByTimeAsync(12_001);
    expect((await result).state).toBe('uncertain');
    expect(f.stops()).toHaveLength(1);
    const duplicate = f.mirror.control(input);
    await vi.advanceTimersByTimeAsync(12_001);
    expect((await duplicate).state).toBe('not_sent');
    expect(f.stops()).toHaveLength(1);
  });
});

describe('Claude original-query stop', () => {
  it('interrupts only the existing query and retains native pending approvals', async () => {
    const f = claudeFixture();
    await f.mirror.select('thread');
    f.surface.outstandingRequests.set('approval', { original: true });
    const token = (await f.mirror.read()).stopToken!;
    expect((await f.mirror.control(control('claude', token))).state).toBe('sent');
    expect(f.interrupt).toHaveBeenCalledTimes(1);
    expect(f.interrupt).toHaveBeenCalledWith();
    expect(f.surface.outstandingRequests.get('approval')).toEqual({ original: true });
    expect(f.nativeSends).toEqual([]);
    expect((await f.mirror.control(control('claude', token))).state).toBe('not_sent');
  });
  it('refuses another provider/thread and idle or missing-query channels', async () => {
    const f = claudeFixture();
    await f.mirror.select('thread');
    const token = (await f.mirror.read()).stopToken!;
    for (const value of [
      control('codex', token),
      { ...control('claude', token), threadId: 'other' },
    ])
      expect((await f.mirror.control(value)).state).toBe('not_sent');
    f.channel.turnComplete = true;
    expect((await f.mirror.read()).stopToken).toBeUndefined();
    expect((await f.mirror.control(control('claude', token))).state).toBe('not_sent');
    f.channel.turnComplete = false;
    f.channel.query = undefined;
    expect((await f.mirror.read()).stopToken).toBeUndefined();
    expect((await f.mirror.control(control('claude', token))).state).toBe('not_sent');
    expect(f.interrupt).not.toHaveBeenCalled();
  });
  it.each(['native-message', 'started', 'result'] as const)(
    'invalidates a stale control after native activity: %s',
    async (event) => {
      const f = claudeFixture();
      await f.mirror.select('thread');
      const token = (await f.mirror.read()).stopToken!;
      if (event === 'native-message')
        f.surface.transportMessage('native-channel', { type: 'user', uuid: randomUUID() });
      else
        f.frame(
          event === 'started'
            ? { type: 'command_lifecycle', state: 'started', command_uuid: 'new-turn' }
            : { type: 'result', user_message_uuid: 'prior-turn' },
        );
      expect((await f.mirror.control(control('claude', token))).state).toBe('not_sent');
      expect(f.interrupt).not.toHaveBeenCalled();
    },
  );
  it('serializes simultaneous stops and rejects the consumed displayed token', async () => {
    const f = claudeFixture();
    await f.mirror.select('thread');
    let finish!: () => void;
    f.interrupt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const token = (await f.mirror.read()).stopToken!;
    const first = f.mirror.control(control('claude', token));
    expect((await f.mirror.read()).stopToken).toBeUndefined();
    expect((await f.mirror.control(control('claude', token))).state).toBe('not_sent');
    finish();
    expect((await first).state).toBe('sent');
    expect((await f.mirror.control(control('claude', token))).state).toBe('not_sent');
    expect(f.interrupt).toHaveBeenCalledTimes(1);
  });
  it('refuses a channel replacement or a reused channel belonging to an unshared session', async () => {
    const f = claudeFixture();
    await f.mirror.select('thread');
    const token = (await f.mirror.read()).stopToken!;
    f.surface.channels.set('native-channel', { ...f.channel });
    expect((await f.mirror.control(control('claude', token))).state).toBe('not_sent');
    const replacementToken = (await f.mirror.read()).stopToken!;
    f.surface.channels.get('native-channel')!.sessionId = 'unshared';
    expect((await f.mirror.control(control('claude', replacementToken))).state).toBe('not_sent');
    expect(f.interrupt).not.toHaveBeenCalled();
  });
  it('invalidates the observed stop when the native query is replaced on the same channel', async () => {
    const f = claudeFixture();
    await f.mirror.select('thread');
    const token = (await f.mirror.read()).stopToken!;
    const replacement = vi.fn(async () => undefined);
    f.channel.query = { interrupt: replacement };
    expect((await f.mirror.control(control('claude', token))).state).toBe('not_sent');
    expect(replacement).not.toHaveBeenCalled();
    expect(f.interrupt).not.toHaveBeenCalled();
    const current = (await f.mirror.read()).stopToken!;
    expect(current).not.toBe(token);
    expect((await f.mirror.control(control('claude', current))).state).toBe('sent');
    expect(replacement).toHaveBeenCalledTimes(1);
  });
  it('invalidates an old binding when the same channel object moves to another native ID', async () => {
    const f = claudeFixture();
    await f.mirror.select('thread');
    const token = (await f.mirror.read()).stopToken!;
    f.surface.channels.delete('native-channel');
    f.surface.channels.set('replacement-native-id', f.channel);
    expect((await f.mirror.control(control('claude', token))).state).toBe('not_sent');
    expect(f.interrupt).not.toHaveBeenCalled();
  });
  it('does not rebind native hooks or send control after sharing was disposed', async () => {
    const f = claudeFixture();
    const originalSend = f.surface.send;
    const originalTransport = f.surface.transportMessage;
    await f.mirror.select('thread');
    const token = (await f.mirror.read()).stopToken!;
    f.mirror.dispose();
    expect((await f.mirror.control(control('claude', token))).state).toBe('not_sent');
    expect(f.surface.send).toBe(originalSend);
    expect(f.surface.transportMessage).toBe(originalTransport);
    expect(f.interrupt).not.toHaveBeenCalled();
  });
  it('does not automatically repeat an uncertain native interrupt or accept its old token', async () => {
    vi.useFakeTimers();
    const f = claudeFixture();
    await f.mirror.select('thread');
    f.interrupt.mockImplementation(() => new Promise(() => {}));
    const token = (await f.mirror.read()).stopToken!;
    const result = f.mirror.control(control('claude', token));
    await vi.advanceTimersByTimeAsync(21);
    expect((await result).state).toBe('uncertain');
    await f.mirror.read();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await f.mirror.control(control('claude', token))).state).toBe('not_sent');
    expect(f.interrupt).toHaveBeenCalledTimes(1);
  });
  it('returns to idle after a real interrupted/error terminal result without changing native state', async () => {
    const f = claudeFixture();
    await f.mirror.select('thread');
    const token = (await f.mirror.read()).stopToken!;
    expect((await f.mirror.control(control('claude', token))).state).toBe('sent');
    // A control acknowledgement alone is not terminal evidence.
    expect((await f.mirror.read()).status).toBe('busy');
    f.frame({
      type: 'result',
      is_error: true,
      user_message_uuid: 'interrupted-turn',
      errors: ['Interrupted'],
    });
    const ended = await f.mirror.read();
    expect(ended.status).toBe('idle');
    expect(ended.stopToken).toBeUndefined();
    expect(f.channel.turnComplete).toBe(false);
    expect(ended.entries.at(-1)?.text).toBe('Interrupted');
    f.mirror.dispose();
    expect((await f.mirror.read()).status).toBe('offline');
  });
  it('keeps real queued/background work and approvals authoritative after a terminal error', async () => {
    const f = claudeFixture();
    await f.mirror.select('thread');
    f.frame({ type: 'result', is_error: true });
    f.channel.outstandingSendUuids.push('another-message');
    expect((await f.mirror.read()).status).toBe('busy');
    f.channel.outstandingSendUuids = [];
    f.channel.queuedCommandUuids.add('queued');
    expect((await f.mirror.read()).status).toBe('busy');
    f.channel.queuedCommandUuids.clear();
    f.channel.runningBackgroundTasks = 1;
    expect((await f.mirror.read()).status).toBe('busy');
    f.channel.runningBackgroundTasks = 0;
    f.surface.outstandingRequests.set('original-approval', {});
    expect((await f.mirror.read()).status).toBe('attention');
    f.surface.outstandingRequests.clear();
    expect((await f.mirror.read()).status).toBe('idle');
    expect(f.channel.turnComplete).toBe(false);
  });
  it.each(['native-message', 'started', 'session-state', 'replacement'] as const)(
    'does not reuse a prior terminal result as idle after %s',
    async (activity) => {
      const f = claudeFixture();
      await f.mirror.select('thread');
      f.frame({ type: 'result', is_error: true });
      expect((await f.mirror.read()).status).toBe('idle');
      if (activity === 'native-message')
        f.surface.transportMessage('native-channel', { type: 'user', uuid: randomUUID() });
      else if (activity === 'started') f.frame({ type: 'command_lifecycle', state: 'started' });
      else if (activity === 'session-state')
        f.frame({ type: 'system', subtype: 'session_state_changed', state: 'running' });
      else f.channel.query = { interrupt: async () => undefined };
      expect((await f.mirror.read()).status).toBe('busy');
      expect((await f.mirror.read()).stopToken).toBeDefined();
    },
  );
});
