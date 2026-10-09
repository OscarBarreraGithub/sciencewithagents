import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MirrorConnection, type Connection, type Provider } from './connection.js';
import type { MirrorQuestionAnswer } from '@dock/shared';

const owned: MirrorConnection[] = [];
afterEach(() => owned.splice(0).forEach((mirror) => mirror.dispose()));
function fixture() {
  const providers = new Map<string, Provider>();
  const calls: string[] = [];
  const responses: { id: string | number; result: unknown }[] = [];
  let stalled: string | undefined;
  let onResponse: (() => void) | undefined;
  const connection: Connection = {
    providers,
    initialized: true,
    registerProvider(name, provider) {
      providers.set(name, provider);
      return { dispose: () => providers.delete(name) };
    },
    sendResponse(id, result) {
      responses.push({ id, result });
      onResponse?.();
    },
    sendRequest(provider, id, method) {
      calls.push(method);
      if (stalled === method) return;
      const result =
        method === 'thread/turns/list' || method === 'thread/queue/list'
          ? { data: [] }
          : { thread: { id: 'thread', status: { type: 'idle' }, turns: [] } };
      queueMicrotask(() => providers.get(provider)?.onResult?.({ id, result }));
    },
    sendProviderRequest() {
      throw new Error('No turn launch is permitted in this fixture.');
    },
  };
  const mirror = new MirrorConnection(connection, 'Native request fixture');
  owned.push(mirror);
  const request = (id: string | number = 10, extra: Record<string, unknown> = {}) => {
    const event = {
      id,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'item',
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: 'choice',
            header: 'Plan',
            question: 'Which path?',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'First', description: 'The original first choice' },
              { label: 'Second', description: 'The other choice' },
            ],
          },
        ],
        ...extra,
      },
    };
    for (const provider of providers.values()) provider.onRequest?.(event);
  };
  const notify = (method: string, params: Record<string, unknown>) => {
    for (const provider of providers.values()) provider.onNotification?.({ method, params });
  };
  const answer = (extra: Partial<MirrorQuestionAnswer> = {}): MirrorQuestionAnswer => ({
    key: randomUUID(),
    provider: 'codex',
    token: mirror.questions().nativeRequests![0].token,
    threadId: 'thread',
    turnId: 'turn',
    answers: { choice: ['First'] },
    ...extra,
  });
  return {
    mirror,
    connection,
    calls,
    responses,
    request,
    notify,
    answer,
    stall: (method = 'thread/read') => {
      stalled = method;
    },
    onResponse: (callback: () => void) => {
      onResponse = callback;
    },
  };
}

describe('observed native questions', () => {
  it.each([
    ['thread/read', true],
    ['thread/queue/list', false],
  ] as const)(
    'keeps a healthy native question visible independently of stalled %s (blocking=%s)',
    async (method, isBlocking) => {
      const f = fixture();
      await f.mirror.select('thread');
      f.stall(method);
      const prior = f.calls.filter((call) => call === method).length;
      const history = f.mirror.read(true);
      await expect.poll(() => f.calls.filter((call) => call === method).length).toBe(prior + 1);
      f.request(10, { isBlocking });
      const view = f.mirror.questions();
      expect(view).toMatchObject({
        status: 'attention',
        nativeRequestCount: 1,
        nativeRequestsUnavailable: false,
      });
      expect(view.nativeRequests![0]).toMatchObject({ response: 'answer', observation: 'pending' });
      expect((await f.mirror.read()).status).toBe('attention');
      expect(f.mirror.summary).not.toHaveProperty('nativeRequests');
      expect(f.responses).toHaveLength(0);
      f.mirror.dispose();
      await history;
    },
  );
  it('hands the exact native response once to the original dispatcher and never confirms acceptance', async () => {
    const f = fixture();
    await f.mirror.select('thread');
    f.request();
    const input = f.answer();
    expect(f.mirror.questionAnswer(input).state).toBe('uncertain');
    expect(f.responses).toEqual([
      { id: 10, result: { answers: { choice: { answers: ['First'] } } } },
    ]);
    expect(f.mirror.questionAnswer({ ...input, key: randomUUID() }).state).toBe('not_sent');
    f.notify('serverRequest/resolved', { threadId: 'thread', requestId: 10 });
    expect(f.responses).toHaveLength(1);
    expect(
      f.calls.every((method) =>
        ['thread/read', 'thread/turns/list', 'thread/queue/list'].includes(method),
      ),
    ).toBe(true);
  });
  it('refuses foreign turns, secret questions and invented choices without native writes', async () => {
    const f = fixture();
    await f.mirror.select('thread');
    f.request();
    expect(f.mirror.questionAnswer(f.answer({ turnId: 'later' })).state).toBe('not_sent');
    expect(f.mirror.questionAnswer(f.answer({ answers: { choice: ['Invented'] } })).state).toBe(
      'not_sent',
    );
    f.request(11, {
      questions: [
        {
          id: 'secret',
          header: '',
          question: 'Credential?',
          isOther: true,
          isSecret: true,
          options: null,
        },
      ],
    });
    const secret = f.mirror
      .questions()
      .nativeRequests!.find((request) => request.requestId === 11)!;
    expect(secret.response).toBe('editor_only');
    expect(
      f.mirror.questionAnswer(f.answer({ token: secret.token, answers: { secret: ['private'] } }))
        .state,
    ).toBe('not_sent');
    expect(f.responses).toHaveLength(0);
  });
  it('preserves exact duplicate token but quarantines recycled and foreign-colliding native IDs', async () => {
    const f = fixture();
    await f.mirror.select('thread');
    f.request();
    const first = f.mirror.questions().nativeRequests![0];
    f.request();
    expect(f.mirror.questions().nativeRequests![0].token).toBe(first.token);
    f.notify('serverRequest/resolved', { threadId: 'thread', requestId: 10 });
    f.request();
    const recycled = f.mirror.questions().nativeRequests![0];
    expect(recycled.token).not.toBe(first.token);
    expect(recycled.response).toBe('editor_only');
    f.notify('serverRequest/resolved', { threadId: 'thread', requestId: 10 });
    expect(f.mirror.questions().nativeRequests![0].token).toBe(recycled.token);
    f.request(12);
    f.request(12, { threadId: 'foreign' });
    expect(
      f.mirror.questions().nativeRequests!.find((request) => request.requestId === 12)?.observation,
    ).toBe('unconfirmed');
    expect(f.mirror.summary.nativeRequestsUnavailable).toBe(true);
    expect(f.responses).toHaveLength(0);
  });
  it('retains disabled last-observed details after idle without advertising fresh waiting metadata', async () => {
    const f = fixture();
    await f.mirror.select('thread');
    f.request();
    const input = f.answer();
    f.notify('thread/status/changed', {
      threadId: 'thread',
      status: { type: 'idle', activeFlags: [] },
    });
    expect(f.mirror.questions().nativeRequests![0]).toMatchObject({
      token: input.token,
      observation: 'unconfirmed',
      response: 'editor_only',
    });
    expect(f.mirror.summary.nativeRequestsUnavailable).toBe(true);
    expect(f.mirror.summary).not.toHaveProperty('nativeRequests');
    expect(f.mirror.questionAnswer(input).state).toBe('not_sent');
    expect(f.responses).toHaveLength(0);
  });
  it('does not erase a newly recycled native request during synchronous native response delivery', async () => {
    const f = fixture();
    await f.mirror.select('thread');
    f.request();
    const input = f.answer();
    f.onResponse(() => f.request(10, { itemId: 'new-item' }));
    expect(f.mirror.questionAnswer(input).state).toBe('uncertain');
    const newer = f.mirror.questions().nativeRequests![0];
    expect(newer.itemId).toBe('new-item');
    expect(newer.response).toBe('editor_only');
    f.notify('serverRequest/resolved', { threadId: 'thread', requestId: 10 });
    expect(f.mirror.questions().nativeRequests![0].token).toBe(newer.token);
  });
  it('does not resurrect a request already answered synchronously by an earlier editor provider', async () => {
    const f = fixture();
    await f.mirror.select('thread');
    f.connection.sendResponse!(10, {});
    f.request();
    expect(f.mirror.questions().nativeRequests).toEqual([]);
    await Promise.resolve();
    f.request();
    expect(f.mirror.questions().nativeRequests![0].response).toBe('editor_only');
  });
  it('bounds overload, reports unavailable details, and clears accounted requests at native turn completion', async () => {
    const f = fixture();
    await f.mirror.select('thread');
    for (let id = 0; id < 20; id++) f.request(id);
    expect(f.mirror.questions()).toMatchObject({
      nativeRequestCount: 20,
      nativeRequestsUnavailable: true,
    });
    expect(f.mirror.questions().nativeRequests).toHaveLength(8);
    f.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn' } });
    expect(f.mirror.questions()).toMatchObject({
      nativeRequestCount: 0,
      nativeRequestsUnavailable: false,
    });
  });
  it('makes disconnect/reconnect and thread switches truthful without replay or pending guesses', async () => {
    const f = fixture();
    await f.mirror.select('thread');
    f.request();
    const input = f.answer();
    for (const provider of f.connection.providers.values()) provider.onFatalError?.();
    expect(f.mirror.questions()).toMatchObject({
      status: 'offline',
      nativeRequestsUnavailable: true,
    });
    expect(f.mirror.questions().nativeRequests![0].observation).toBe('unconfirmed');
    expect(f.mirror.questionAnswer(input).state).toBe('not_sent');
    for (const provider of f.connection.providers.values()) provider.onInitialized?.();
    expect(f.mirror.questions().nativeRequests).toEqual([]);
    f.request();
    await f.mirror.select(null);
    expect(f.mirror.questionAnswer(input).state).toBe('not_sent');
    expect(f.mirror.questions().nativeRequests).toEqual([]);
    expect(f.responses).toHaveLength(0);
  });
  it('shows pre-observer waiting and unsupported native approvals as editor-only, not invented questions', async () => {
    const f = fixture();
    await f.mirror.select('thread');
    f.notify('thread/status/changed', {
      threadId: 'thread',
      status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
    });
    expect(f.mirror.questions()).toMatchObject({
      status: 'attention',
      nativeRequests: [],
      nativeRequestsUnavailable: true,
    });
    for (const provider of f.connection.providers.values())
      provider.onRequest?.({
        id: 20,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread', turnId: 'turn', command: 'echo native' },
      });
    expect(f.mirror.questions().nativeRequests![0]).toMatchObject({
      kind: 'approval',
      response: 'editor_only',
      questions: [],
    });
  });
});
