import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { MirrorSend } from '@dock/shared';
import { MirrorConnection, type Connection, type Provider } from './connection.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});
function fixture() {
  const providers = new Map<string, Provider>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const accepted: Record<string, unknown>[] = [];
  const acknowledgements: (() => void)[] = [];
  const state = {
    turn: 'original-turn',
    flags: [] as string[],
    defer: false,
    malformedAck: false,
    afterRead: undefined as (() => void) | undefined,
    beforeSteer: undefined as (() => void) | undefined,
  };
  const notify = (method: string, params: unknown) => {
    for (const provider of providers.values()) provider.onNotification?.({ method, params });
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
    sendProviderRequest(provider, id, method, raw) {
      const params = raw as Record<string, unknown>;
      calls.push({ method, params });
      let result: unknown = {};
      let error: { code: number; message: string } | undefined;
      if (method === 'thread/read') {
        result = {
          thread: {
            id: 'thread',
            status: { type: state.turn ? 'active' : 'idle', activeFlags: state.flags },
            turns: [
              {
                id: 'saved',
                status: 'completed',
                items: [
                  {
                    id: 'saved-user',
                    type: 'userMessage',
                    content: [{ type: 'text', text: 'Original work' }],
                  },
                ],
              },
              ...(state.turn ? [{ id: state.turn, status: 'inProgress', items: [] }] : []),
            ],
          },
        };
        const afterRead = state.afterRead;
        state.afterRead = undefined;
        afterRead?.();
      }
      if (method === 'turn/steer') {
        state.beforeSteer?.();
        if (state.turn !== params.expectedTurnId || !state.turn)
          error = { code: -32600, message: 'expectedTurnId does not match the active turn' };
        else {
          accepted.push(params);
          result = { turnId: state.malformedAck ? 'wrong-acknowledgement' : state.turn };
        }
      }
      const reply = () =>
        providers.get(provider)?.onResult?.({ id, ...(error ? { error } : { result }) });
      if (method === 'turn/steer' && state.defer) acknowledgements.push(reply);
      else queueMicrotask(reply);
    },
  };
  const mirror = new MirrorConnection(connection, 'Steering fixture');
  cleanups.push(() => mirror.dispose());
  return { mirror, state, calls, accepted, acknowledgements, notify };
}
const input = (expectedTurnId = 'original-turn'): MirrorSend => ({
  key: randomUUID(),
  provider: 'codex',
  threadId: 'thread',
  expectedTurnId,
  text: 'Keep the original output format.',
});

it('advertises the observed busy turn and steers that native turn without starting or changing the conversation', async () => {
  const f = fixture();
  await f.mirror.select('thread');
  expect(await f.mirror.read()).toMatchObject({
    canSteer: true,
    status: 'busy',
    steerToken: 'original-turn',
  });
  expect((await f.mirror.send(input())).state).toBe('sent');
  expect(f.accepted).toEqual([
    {
      threadId: 'thread',
      expectedTurnId: 'original-turn',
      input: [{ type: 'text', text: 'Keep the original output format.', text_elements: [] }],
    },
  ]);
  expect(
    f.calls.some((call) => ['turn/start', 'thread/start', 'thread/resume'].includes(call.method)),
  ).toBe(false);
  expect((await f.mirror.read()).entries[0]?.text).toBe('Original work');
});

it.each(['idle', 'changed', 'approval', 'missing-turn', 'wrong-thread', 'wrong-provider'] as const)(
  'refuses steering for %s without starting a replacement turn',
  async (condition) => {
    const f = fixture();
    await f.mirror.select('thread');
    const request = input();
    if (condition === 'idle' || condition === 'missing-turn') f.state.turn = '';
    if (condition === 'changed') f.state.turn = 'next-turn';
    if (condition === 'approval') f.state.flags = ['waitingOnApproval'];
    if (condition === 'wrong-thread') request.threadId = 'another-thread';
    if (condition === 'wrong-provider') request.provider = 'claude';
    expect((await f.mirror.send(request)).state).toBe('not_sent');
    expect(f.accepted).toHaveLength(0);
    expect(f.calls.filter((call) => call.method.startsWith('turn/'))).toHaveLength(0);
  },
);

it('keeps newer native turn activity authoritative over an older history response', async () => {
  const f = fixture();
  await f.mirror.select('thread');
  f.state.afterRead = () => {
    f.state.turn = 'new-turn';
    f.notify('turn/started', { threadId: 'thread', turn: { id: 'new-turn' } });
  };
  expect((await f.mirror.send(input())).state).toBe('not_sent');
  expect(f.accepted).toHaveLength(0);
});

it.each(['', 'new-turn'])(
  'lets the native expected-turn precondition refuse a completion race (%s)',
  async (nextTurn) => {
    const f = fixture();
    await f.mirror.select('thread');
    f.state.beforeSteer = () => {
      f.state.turn = nextTurn;
    };
    expect((await f.mirror.send(input())).state).toBe('not_sent');
    expect(f.accepted).toHaveLength(0);
    expect(f.calls.filter((call) => call.method === 'turn/steer')).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
  },
);

it('does not resurrect a finished reply when its steering acknowledgement arrives later', async () => {
  const f = fixture();
  await f.mirror.select('thread');
  f.state.defer = true;
  const request = f.mirror.send(input());
  await vi.waitFor(() => expect(f.accepted).toHaveLength(1));
  f.state.turn = '';
  f.notify('turn/completed', { threadId: 'thread', turn: { id: 'original-turn' } });
  for (const reply of f.acknowledgements) reply();
  expect((await request).state).toBe('sent');
  expect(await f.mirror.read(true)).toMatchObject({ status: 'idle', steerToken: undefined });
});

it('treats a lost or mismatched acknowledgement as uncertain and never falls back to start', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.mirror.select('thread');
  f.state.defer = true;
  const request = f.mirror.send(input());
  await vi.advanceTimersByTimeAsync(12_001);
  expect((await request).state).toBe('uncertain');
  expect(f.accepted).toHaveLength(1);
  expect((await f.mirror.send(input())).state).toBe('not_sent');
  expect(f.accepted).toHaveLength(1);
  expect(f.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
  const malformed = fixture();
  await malformed.mirror.select('thread');
  malformed.state.malformedAck = true;
  expect((await malformed.mirror.send(input())).state).toBe('uncertain');
});
