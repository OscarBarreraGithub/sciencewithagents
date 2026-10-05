import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { NativeGoal, NativeGoalAction } from '@dock/shared';
import { MirrorConnection, type Connection, type Provider } from './connection.js';

const owned: MirrorConnection[] = [];
afterEach(() => {
  for (const mirror of owned.splice(0)) mirror.dispose();
});
function fixture() {
  const providers = new Map<string, Provider>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const state = {
    goal: {
      threadId: 'thread',
      objective: 'Preserve the original scientific objective',
      status: 'blocked',
      createdAt: 100,
      updatedAt: 110,
      timeUsedSeconds: 20,
      tokensUsed: 300,
      tokenBudget: 9000,
    } as NativeGoal | null,
    unsupported: false,
    reject: false,
    malformed: false,
    deferRead: false,
    replies: [] as (() => void)[],
  };
  const connection: Connection = {
    providers,
    initialized: true,
    registerProvider(name, provider) {
      providers.set(name, provider);
      return {
        dispose: () => {
          providers.delete(name);
        },
      };
    },
    sendRequest(provider, id, method, params) {
      this.sendProviderRequest(provider, id, method, params, false, true);
    },
    sendProviderRequest(provider, id, method, raw) {
      const params = raw as Record<string, unknown>;
      calls.push({ method, params });
      let result: unknown = {},
        error: { code: number; message: string } | undefined;
      if (method === 'thread/read')
        result = { thread: { id: String(params.threadId), status: { type: 'idle' }, turns: [] } };
      if (method === 'thread/goal/get') {
        if (state.unsupported) error = { code: -32601, message: 'Method not found' };
        else result = { goal: state.goal && { ...state.goal } };
      }
      if (method === 'thread/goal/set') {
        if (state.reject) error = { code: -32000, message: 'Native allowance is exhausted' };
        else {
          state.goal = {
            ...(state.goal ?? {
              threadId: String(params.threadId),
              objective: String(params.objective),
              createdAt: 120,
              timeUsedSeconds: 0,
              tokensUsed: 0,
              tokenBudget: null,
            }),
            status: params.status as NativeGoal['status'],
            updatedAt: 120,
          };
          result = { goal: { ...state.goal, ...(state.malformed ? { threadId: 'other' } : {}) } };
        }
      }
      if (method === 'thread/goal/clear') {
        state.goal = null;
        result = {};
      }
      const reply = () =>
        providers.get(provider)?.onResult?.({ id, ...(error ? { error } : { result }) });
      if (state.deferRead && method === 'thread/goal/get') state.replies.push(reply);
      else queueMicrotask(reply);
    },
  };
  const mirror = new MirrorConnection(connection, 'Native goal fixture');
  owned.push(mirror);
  return { mirror, state, calls };
}
it('resumes the original blocked goal through the same native Play API without changing objective, budget or settings', async () => {
  const f = fixture();
  await f.mirror.select('thread');
  f.calls.length = 0;
  const view = await f.mirror.goal();
  expect(view).toMatchObject({ supported: true, goal: { status: 'blocked', tokensUsed: 300 } });
  expect(
    f.calls.filter((c) => c.method === 'thread/read').every((c) => c.params.includeTurns === false),
  ).toBe(true);
  const action: NativeGoalAction = {
    key: randomUUID(),
    threadId: 'thread',
    action: 'resume',
    expectedToken: view.token!,
  };
  expect((await f.mirror.goalAction(action)).state).toBe('sent');
  expect(f.calls.filter((c) => c.method === 'thread/goal/set')).toEqual([
    { method: 'thread/goal/set', params: { threadId: 'thread', status: 'active' } },
  ]);
  expect(f.calls.some((c) => c.method === 'turn/start' || c.method === 'thread/resume')).toBe(
    false,
  );
  expect(f.state.goal).toMatchObject({
    objective: view.goal!.objective,
    tokenBudget: 9000,
    createdAt: 100,
    status: 'active',
  });
});
it('creates only in a goal-free conversation and rejects stale status or an existing objective without overwriting it', async () => {
  const f = fixture();
  await f.mirror.select('thread');
  expect(
    (
      await f.mirror.goalAction({
        key: randomUUID(),
        threadId: 'thread',
        action: 'create',
        objective: 'Replacement',
        expectedToken: null,
      })
    ).state,
  ).toBe('not_sent');
  const old = await f.mirror.goal();
  f.state.goal!.status = 'paused';
  expect(
    (
      await f.mirror.goalAction({
        key: randomUUID(),
        threadId: 'thread',
        action: 'resume',
        expectedToken: old.token!,
      })
    ).state,
  ).toBe('not_sent');
  expect(f.calls.filter((c) => c.method === 'thread/goal/set')).toHaveLength(0);
  f.state.goal = null;
  expect(
    (
      await f.mirror.goalAction({
        key: randomUUID(),
        threadId: 'thread',
        action: 'create',
        objective: 'New owner objective',
        expectedToken: null,
      })
    ).state,
  ).toBe('sent');
  expect(f.state.goal).toMatchObject({
    objective: 'New owner objective',
    status: 'active',
    tokenBudget: null,
  });
});
it('clears only an explicitly selected non-active goal and then allows a fresh objective without deleting the chat', async () => {
  const f = fixture();
  await f.mirror.select('thread');
  f.state.goal!.status = 'active';
  let view = await f.mirror.goal();
  expect(
    (
      await f.mirror.goalAction({
        key: randomUUID(),
        threadId: 'thread',
        action: 'clear',
        expectedToken: view.token!,
      })
    ).state,
  ).toBe('not_sent');
  f.state.goal!.status = 'complete';
  view = await f.mirror.goal();
  expect(
    (
      await f.mirror.goalAction({
        key: randomUUID(),
        threadId: 'thread',
        action: 'clear',
        expectedToken: view.token!,
      })
    ).state,
  ).toBe('sent');
  expect((await f.mirror.goal()).goal).toBeNull();
  expect(
    (
      await f.mirror.goalAction({
        key: randomUUID(),
        threadId: 'thread',
        action: 'create',
        objective: 'Next objective',
        expectedToken: null,
      })
    ).state,
  ).toBe('sent');
  expect(f.calls.filter((c) => c.method === 'thread/goal/clear')).toEqual([
    { method: 'thread/goal/clear', params: { threadId: 'thread' } },
  ]);
  expect(f.calls.some((c) => c.method === 'thread/delete' || c.method === 'thread/archive')).toBe(
    false,
  );
});
it('allows pause after native progress updates, including updatedAt, without widening native goal budgets', async () => {
  const f = fixture();
  await f.mirror.select('thread');
  f.state.goal!.status = 'active';
  const view = await f.mirror.goal();
  Object.assign(f.state.goal!, { updatedAt: 200, tokensUsed: 800, timeUsedSeconds: 50 });
  expect(
    (
      await f.mirror.goalAction({
        key: randomUUID(),
        threadId: 'thread',
        action: 'pause',
        expectedToken: view.token!,
      })
    ).state,
  ).toBe('sent');
  expect(f.state.goal).toMatchObject({ status: 'paused', tokenBudget: 9000 });
  f.state.goal!.status = 'budgetLimited';
  const limited = await f.mirror.goal();
  expect(
    (
      await f.mirror.goalAction({
        key: randomUUID(),
        threadId: 'thread',
        action: 'resume',
        expectedToken: limited.token!,
      })
    ).state,
  ).toBe('not_sent');
});
it('holds one goal action across competing devices and refuses a selection changed during the metadata read', async () => {
  const f = fixture();
  await f.mirror.select('thread');
  const view = await f.mirror.goal();
  f.state.deferRead = true;
  const input: NativeGoalAction = {
    key: randomUUID(),
    threadId: 'thread',
    action: 'resume',
    expectedToken: view.token!,
  };
  const first = f.mirror.goalAction(input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await f.mirror.goalAction({ ...input, key: randomUUID() })).state).toBe('not_sent');
  await f.mirror.select(null);
  f.state.replies.splice(0).forEach((reply) => reply());
  expect((await first).state).toBe('not_sent');
  expect(f.calls.filter((c) => c.method === 'thread/goal/set')).toHaveLength(0);
});
it('reports unsupported APIs and native allowance rejection without pretending to resume, and treats mismatched acknowledgements as uncertain', async () => {
  const f = fixture();
  await f.mirror.select('thread');
  f.state.unsupported = true;
  expect((await f.mirror.goal()).supported).toBe(false);
  f.state.unsupported = false;
  const view = await f.mirror.goal();
  const input: NativeGoalAction = {
    key: randomUUID(),
    threadId: 'thread',
    action: 'resume',
    expectedToken: view.token!,
  };
  f.state.reject = true;
  expect(await f.mirror.goalAction(input)).toMatchObject({
    state: 'not_sent',
    message: 'Native allowance is exhausted',
  });
  f.state.reject = false;
  f.state.malformed = true;
  expect((await f.mirror.goalAction(input)).state).toBe('uncertain');
});
