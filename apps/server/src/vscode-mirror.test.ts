import { modelFixture } from './model-policy.fixture.js';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { VscodeMirrors } from './vscode-mirror.js';
import { repoRoot } from './paths.js';
import { proxyPath } from './hosts.js';
import {
  chatImageReference,
  chatFileReference,
  mirrorPage,
  type MirrorPageQuery,
  type MirrorState,
  type NativeGoalView,
  type NativeGoalAction,
} from '@dock/shared';

let root: string,
  store: Store,
  mirrors: VscodeMirrors,
  app: Awaited<ReturnType<typeof createServer>>,
  socket: WebSocket | undefined;
const windowId = randomUUID();
let preparedText: string[] = [];
const headers = {
  host: '127.0.0.1:4999',
  origin: 'http://127.0.0.1:4999',
  'content-type': 'application/json',
};
const state = {
  windowId,
  label: 'Fixture',
  threadId: 'thread',
  title: 'Shared chat',
  status: 'idle',
  message: '',
  entries: [{ id: '1', role: 'user', text: 'old desktop message' }],
};
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/mirror-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  preparedText = [];
  mirrors = new VscodeMirrors(store, undefined, (text) => {
    preparedText.push(text);
    return text;
  });
  const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  app = await createServer(store, runtime, { port: 4999, mirrors });
  await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  socket?.terminate();
  socket = undefined;
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
async function connect(
  handler: (v: { id: string; type: string; input?: unknown; page?: MirrorPageQuery }) => unknown,
  provider?: 'claude',
  paged = false,
  autoPong = true,
  capabilities: Partial<MirrorState> = {},
) {
  const address = app.server.address() as { port: number };
  socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/vscode/bridge`, {
    headers: { Host: headers.host },
    autoPong,
  });
  await new Promise<void>((resolve, reject) => {
    socket!.once('open', resolve);
    socket!.once('error', reject);
  });
  const { entries: _, ...window } = state;
  socket.send(
    JSON.stringify({
      type: 'hello',
      window: {
        ...window,
        ...capabilities,
        ...(provider ? { provider } : {}),
        ...(paged ? { paged: true } : {}),
      },
    }),
  );
  socket.on('message', async (data) => {
    const command = JSON.parse(data.toString());
    const value = await handler(command);
    if (value === undefined || socket?.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(value);
    for (let i = 0; i < text.length; i += 4096)
      socket!.send(
        JSON.stringify({
          type: 'chunk',
          id: command.id,
          text: text.slice(i, i + 4096),
          last: i + 4096 >= text.length,
        }),
      );
  });
  await expect.poll(() => mirrors.windows().length).toBe(1);
}
const goalView = (): NativeGoalView => ({
  threadId: 'thread',
  supported: true,
  token: 'a'.repeat(64),
  message: '',
  goal: {
    threadId: 'thread',
    objective: 'Original owner objective',
    status: 'blocked',
    createdAt: 10,
    updatedAt: 20,
    tokensUsed: 120,
    timeUsedSeconds: 5,
    tokenBudget: 5000,
  },
});
it('reads native goals lazily and preserves exact durable lifecycle receipts across restart', async () => {
  const commands: string[] = [];
  await connect(
    (command) => {
      commands.push(command.type);
      return command.type === 'goal_read'
        ? goalView()
        : { state: 'sent', message: 'Existing native goal resumed.' };
    },
    undefined,
    false,
    true,
    { canManageGoal: true },
  );
  const url = `/api/vscode/windows/${windowId}/goal`;
  expect((await app.inject({ url, headers })).json()).toMatchObject({
    goal: { status: 'blocked' },
    supported: true,
  });
  expect(commands).toEqual(['goal_read']);
  const input: NativeGoalAction = {
    key: randomUUID(),
    threadId: 'thread',
    action: 'resume',
    expectedToken: (await mirrors.goal(windowId)).token!,
  };
  const first = await app.inject({ method: 'POST', url, headers, payload: input });
  expect(first.json().state).toBe('sent');
  expect((await app.inject({ method: 'POST', url, headers, payload: input })).json()).toEqual(
    first.json(),
  );
  const recovered = new VscodeMirrors(store);
  try {
    expect(await recovered.goalAction(randomUUID(), input)).toEqual(first.json());
  } finally {
    recovered.close();
  }
  expect(commands.filter((type) => type === 'goal_action')).toHaveLength(1);
  expect(
    (await app.inject({ method: 'POST', url, headers, payload: { ...input, action: 'pause' } }))
      .statusCode,
  ).toBe(409);
  const evidence = store.db
    .prepare("SELECT data FROM events WHERE type='mirror.goal_observed'")
    .get() as { data: string };
  expect(JSON.parse(evidence.data).goal).toMatchObject({
    objective: 'Original owner objective',
    tokenBudget: 5000,
  });
});
it('keeps an in-flight goal action uncertain on exact-key retry and serializes competing device actions', async () => {
  let finish: (() => void) | undefined;
  let writes = 0;
  await connect(
    (command) =>
      command.type === 'goal_read'
        ? goalView()
        : new Promise((resolve) => {
            writes++;
            finish = () => resolve({ state: 'sent', message: 'Goal resumed.' });
          }),
    undefined,
    false,
    true,
    { canManageGoal: true },
  );
  const input: NativeGoalAction = {
    key: randomUUID(),
    threadId: 'thread',
    action: 'resume',
    expectedToken: (await mirrors.goal(windowId)).token!,
  };
  const first = mirrors.goalAction(windowId, input);
  await expect.poll(() => writes).toBe(1);
  expect((await mirrors.goalAction(windowId, input)).state).toBe('uncertain');
  expect((await mirrors.goalAction(windowId, { ...input, key: randomUUID() })).state).toBe(
    'not_sent',
  );
  finish!();
  expect((await first).state).toBe('sent');
  expect(mirrors.receipt(input.key).state).toBe('sent');
  expect(writes).toBe(1);
});
it('never replays an unconfirmed native goal action after disconnect or process recovery', async () => {
  let writes = 0;
  await connect(
    (command) => {
      if (command.type === 'goal_read') return goalView();
      writes++;
      socket!.terminate();
      return undefined;
    },
    undefined,
    false,
    true,
    { canManageGoal: true },
  );
  const input: NativeGoalAction = {
    key: randomUUID(),
    threadId: 'thread',
    action: 'resume',
    expectedToken: (await mirrors.goal(windowId)).token!,
  };
  expect((await mirrors.goalAction(windowId, input)).state).toBe('uncertain');
  const recovered = new VscodeMirrors(store);
  try {
    expect((await recovered.goalAction(windowId, input)).state).toBe('uncertain');
  } finally {
    recovered.close();
  }
  expect(writes).toBe(1);
});
it('rejects an older device action after a same-second native pause/resume cycle while allowing native progress changes', async () => {
  const view = goalView();
  view.goal!.status = 'paused';
  let writes = 0;
  await connect(
    (command) => {
      if (command.type === 'goal_read') return view;
      const input = command.input as NativeGoalAction;
      writes++;
      view.goal!.status = input.action === 'pause' ? 'paused' : 'active';
      view.token = (view.goal!.status === 'paused' ? 'a' : 'b').repeat(64);
      return { state: 'sent', message: 'Native lifecycle acknowledged.' };
    },
    undefined,
    false,
    true,
    { canManageGoal: true },
  );
  const before = await mirrors.goal(windowId);
  const old: NativeGoalAction = {
    key: randomUUID(),
    threadId: 'thread',
    action: 'resume',
    expectedToken: before.token!,
  };
  expect((await mirrors.goalAction(windowId, old)).state).toBe('sent');
  const active = await mirrors.goal(windowId);
  Object.assign(view.goal!, { tokensUsed: 240, timeUsedSeconds: 10, updatedAt: 25 });
  expect(
    (
      await mirrors.goalAction(windowId, {
        key: randomUUID(),
        threadId: 'thread',
        action: 'pause',
        expectedToken: active.token!,
      })
    ).state,
  ).toBe('sent');
  const after = await mirrors.goal(windowId);
  expect(after.goal!.createdAt).toBe(before.goal!.createdAt);
  expect(after.goal!.status).toBe(before.goal!.status);
  expect(after.token).not.toBe(before.token);
  expect((await mirrors.goalAction(windowId, { ...old, key: randomUUID() })).state).toBe(
    'not_sent',
  );
  expect(writes).toBe(2);
});
it('rejects stale native goal identity and status before forwarding and retains completed evidence when explicitly clearing', async () => {
  const view = goalView();
  let writes = 0;
  await connect(
    (command) => {
      if (command.type === 'goal_read') return view;
      writes++;
      return { state: 'sent', message: 'Native goal cleared.' };
    },
    undefined,
    false,
    true,
    { canManageGoal: true },
  );
  const base = {
    key: randomUUID(),
    threadId: 'thread',
    action: 'resume' as const,
    expectedToken: 'b'.repeat(64),
  };
  expect((await mirrors.goalAction(windowId, base)).state).toBe('not_sent');
  expect(
    (await mirrors.goalAction(windowId, { ...base, key: randomUUID(), threadId: 'other' })).state,
  ).toBe('not_sent');
  view.goal!.status = 'active';
  expect(
    (
      await mirrors.goalAction(windowId, {
        ...base,
        key: randomUUID(),
        action: 'clear',
        expectedToken: (await mirrors.goal(windowId)).token!,
      })
    ).state,
  ).toBe('not_sent');
  view.goal!.status = 'complete';
  expect(
    (
      await mirrors.goalAction(windowId, {
        ...base,
        key: randomUUID(),
        action: 'clear',
        expectedToken: (await mirrors.goal(windowId)).token!,
      })
    ).state,
  ).toBe('sent');
  expect(writes).toBe(1);
  expect(
    store.db.prepare("SELECT count(*) AS n FROM events WHERE type='mirror.goal_observed'").get(),
  ).toMatchObject({ n: 3 });
});
it('reports older companions and Claude goal limitations without sending unsupported native commands', async () => {
  let commands = 0;
  await connect(() => {
    commands++;
    return {};
  });
  const view = await mirrors.goal(windowId);
  expect(view).toMatchObject({ supported: false, goal: null });
  expect(view.message).toContain('installed companion');
  expect(
    (
      await mirrors.goalAction(windowId, {
        key: randomUUID(),
        threadId: 'thread',
        action: 'create',
        objective: 'Owner goal',
        expectedToken: null,
      })
    ).state,
  ).toBe('not_sent');
  expect(commands).toBe(0);
  expect(
    (
      await app.inject({
        url: `/api/vscode/windows/${windowId}/goal`,
        headers: { ...headers, origin: 'https://unrelated.example.test' },
      })
    ).statusCode,
  ).toBe(403);
});
it('allows exact goal reads/actions through the selected-host route and rejects arbitrary native RPC', () => {
  for (const method of ['GET', 'POST'])
    expect(proxyPath(method, `/vscode/windows/${windowId}/goal`)).toBe(
      `/api/vscode/windows/${windowId}/goal`,
    );
  expect(proxyPath('POST', `/vscode/windows/${windowId}/goal/set`)).toBeNull();
  expect(proxyPath('POST', '/vscode/goal')).toBeNull();
});
describe('VS Code mirror gateway', () => {
  it.each([
    { kind: 'screenshots', reference: chatImageReference },
    { kind: 'general files', reference: chatFileReference },
  ])(
    'refuses remote $kind before resolving local files and still sends text',
    async ({ reference }) => {
      const sent: unknown[] = [];
      await connect(
        (command) => {
          if (command.type === 'send') sent.push(command.input);
          return { state: 'sent', message: 'Native send acknowledged.' };
        },
        undefined,
        false,
        true,
        { canAttachImages: false },
      );
      const input = {
        key: randomUUID(),
        threadId: 'thread',
        text: `Look\n\n${reference(randomUUID())}`,
      };
      expect(await mirrors.send(windowId, input)).toMatchObject({
        state: 'not_sent',
        message: expect.stringContaining('remote editor'),
      });
      expect(sent).toEqual([]);
      expect(preparedText).toEqual([]);
      expect(
        await mirrors.send(windowId, { ...input, key: randomUUID(), text: 'Text only' }),
      ).toMatchObject({ state: 'sent' });
      expect(sent).toHaveLength(1);
    },
  );
  it('refreshes stale list status without opening the chat and shares reads across devices', async () => {
    const commands: unknown[] = [];
    let working = true;
    await connect(
      (command) => {
        commands.push(command);
        return mirrorPage(
          {
            ...state,
            status: working ? 'busy' : 'idle',
            canSteer: true,
            ...(working ? { steerToken: 'live-turn', stopToken: 'live-turn' } : {}),
            paged: true,
          } as MirrorState,
          command.page,
        );
      },
      undefined,
      true,
    );
    const lists = await Promise.all([
      app.inject({ url: '/api/vscode/windows', headers }),
      app.inject({ url: '/api/vscode/windows', headers }),
    ]);
    for (const response of lists) {
      expect(response.statusCode).toBe(200);
      expect(response.json()[0]).toMatchObject({ status: 'busy', steerToken: 'live-turn' });
      expect(response.json()[0].entries).toBeUndefined();
    }
    expect(commands).toEqual([expect.objectContaining({ type: 'read', page: {} })]);
    await app.inject({ url: '/api/vscode/windows', headers });
    expect(commands).toHaveLength(1);

    // An open chat's newer reading also refreshes the list, including removing
    // the finished turn's controls. It needs no additional provider request.
    working = false;
    await mirrors.read(windowId, {});
    const idle = await app.inject({ url: '/api/vscode/windows', headers });
    expect(idle.json()[0].status).toBe('idle');
    expect(idle.json()[0].steerToken).toBeUndefined();
    expect(commands).toHaveLength(2);
  });
  it('keeps a slow but connected editor reading and applies the late transcript', async () => {
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let commands = 0;
    await connect(async () => {
      commands++;
      await delayed;
      return { ...state, status: 'busy', canSteer: true, steerToken: 'turn', stopToken: 'turn' };
    });
    const started = Date.now();
    const slow = await app.inject({ url: '/api/vscode/windows', headers });
    expect(Date.now() - started).toBeLessThan(4000);
    // The editor answers pings, so a long native read is not reported as offline.
    expect(slow.json()[0]).toMatchObject({ status: 'idle' });
    const detail = app.inject({ url: `/api/vscode/windows/${windowId}`, headers });
    await app.inject({ url: '/api/vscode/windows', headers });
    release();
    expect((await detail).json()).toMatchObject({ status: 'busy', steerToken: 'turn' });
    // Phone, desktop and list refreshes shared the one outstanding editor read.
    expect(commands).toBe(1);
    const updated = await app.inject({ url: '/api/vscode/windows', headers });
    expect(updated.json()[0]).toMatchObject({ status: 'busy', steerToken: 'turn' });
  });
  it('reports a frozen editor offline promptly and recovers through the normal chat read', async () => {
    let respond = false;
    let commands = 0;
    await connect(
      () => {
        commands++;
        return respond ? state : undefined;
      },
      undefined,
      false,
      false,
    );
    const started = Date.now();
    const offline = await app.inject({ url: '/api/vscode/windows', headers });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(offline.json()[0]).toMatchObject({ status: 'offline' });
    expect(offline.json()[0].message).toContain('not responding');
    expect(offline.json()[0].steerToken).toBeUndefined();
    await app.inject({ url: '/api/vscode/windows', headers });
    expect(commands).toBe(1);
    respond = true;
    // The frozen latest read stays outstanding; any later successful reading recovers.
    await mirrors.read(windowId, { before: 'newer' });
    const recovered = await app.inject({ url: '/api/vscode/windows', headers });
    expect(recovered.json()[0].status).toBe('idle');
    expect(commands).toBe(2);
  });
  it('marks a failed refresh offline without letting reads block a send', async () => {
    const reads: string[] = [];
    let sent = 0;
    await connect((command) => {
      if (command.type === 'send') {
        sent++;
        return { state: 'sent', message: 'Sent.' };
      }
      reads.push(command.id);
      return reads.length === 1 ? { invalid: true } : undefined;
    });
    const failed = await app.inject({ url: '/api/vscode/windows', headers });
    expect(failed.json()[0]).toMatchObject({ status: 'offline' });
    // Four distinct history reads wait on the editor; the owner's send still goes through.
    const waiting = ['a', 'b', 'c', 'd'].map((before) =>
      mirrors.read(windowId, { before }).catch(() => undefined),
    );
    await expect.poll(() => reads.length).toBe(5);
    await expect(mirrors.read(windowId, { before: 'e' })).rejects.toThrow('catching up');
    const result = await mirrors.send(windowId, {
      key: randomUUID(),
      threadId: 'thread',
      text: 'Still deliverable',
    });
    expect(result.state).toBe('sent');
    expect(sent).toBe(1);
    socket?.terminate();
    await Promise.all(waiting);
  });
  it('requests a bounded page directly from an updated companion', async () => {
    const commands: unknown[] = [];
    const large = {
      ...state,
      paged: true,
      entries: Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        role: 'assistant' as const,
        text: 'large '.repeat(2000),
      })),
    } as MirrorState;
    await connect(
      (command) => {
        commands.push(command);
        return mirrorPage(large, command.page);
      },
      undefined,
      true,
    );
    const first = await app.inject({ url: `/api/vscode/windows/${windowId}`, headers });
    expect(commands[0]).toMatchObject({ type: 'read', page: {} });
    expect(first.json().page.total).toBe(100);
    expect(first.body.length).toBeLessThan(70_000);
    const before = first.json().page.before;
    const older = await app.inject({
      url: `/api/vscode/windows/${windowId}?before=${before}`,
      headers,
    });
    expect(commands[1]).toMatchObject({ type: 'read', page: { before } });
    expect(older.json().entries.at(-1).id).toBe(String(Number(before) - 1));
  });
  it('binds stop to the shared identity, persists one receipt, and never retries after restart', async () => {
    const controls: unknown[] = [];
    await connect((command) => {
      controls.push(command);
      return { state: 'sent', message: 'Stop requested' };
    }, 'claude');
    const input = {
      key: randomUUID(),
      provider: 'claude' as const,
      threadId: 'thread',
      action: 'interrupt' as const,
      token: 'current-turn',
    };
    expect((await mirrors.control(windowId, { ...input, provider: 'codex' })).state).toBe(
      'not_sent',
    );
    expect((await mirrors.control(windowId, { ...input, threadId: 'other' })).state).toBe(
      'not_sent',
    );
    expect(controls).toHaveLength(0);
    const result = await mirrors.control(windowId, input);
    expect(result.state).toBe('sent');
    expect(controls).toEqual([expect.objectContaining({ type: 'control', input })]);
    expect(await new VscodeMirrors(store).control(randomUUID(), input)).toEqual(result);
    expect(controls).toHaveLength(1);
    await expect(mirrors.control(windowId, { ...input, token: 'new-turn' })).rejects.toThrow(
      'different action',
    );
    await expect(
      mirrors.send(windowId, {
        key: input.key,
        provider: 'claude',
        threadId: 'thread',
        text: 'not a control',
      }),
    ).rejects.toThrow('different message');
    expect(
      (await app.inject({ url: `/api/vscode/deliveries/${input.key}`, headers })).json(),
    ).toEqual(result);
  });
  it('keeps an uncertain stop receipt after disconnect without stopping a later turn', async () => {
    let controls = 0;
    await connect(() => {
      controls++;
      socket!.close();
      return undefined;
    });
    const input = {
      key: randomUUID(),
      threadId: 'thread',
      action: 'interrupt' as const,
      token: 'old-turn',
    };
    expect((await mirrors.control(windowId, input)).state).toBe('uncertain');
    expect((await new VscodeMirrors(store).control(randomUUID(), input)).state).toBe('uncertain');
    expect(controls).toBe(1);
  });
  it('accepts only typed stop actions and retains the same origin boundary', async () => {
    const input = { key: randomUUID(), threadId: 'thread', action: 'interrupt', token: 'turn' };
    for (const payload of [
      { ...input, action: 'shell' },
      { ...input, method: 'turn/start' },
      { ...input, token: '' },
    ]) {
      const result = await app.inject({
        method: 'POST',
        url: `/api/vscode/windows/${windowId}/control`,
        headers,
        payload,
      });
      expect(result.statusCode).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/vscode/windows/${windowId}/control`,
          headers: { ...headers, origin: 'https://evil.test' },
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    expect(proxyPath('POST', `/vscode/windows/${windowId}/control`)).toBe(
      `/api/vscode/windows/${windowId}/control`,
    );
  });
  it('keeps Claude and Codex identities separate even with the same thread ID', async () => {
    let sends = 0;
    await connect(() => {
      sends++;
      return { state: 'sent', message: 'Sent to Claude' };
    }, 'claude');
    const input = { key: randomUUID(), threadId: 'thread', text: 'hello' };
    expect((await mirrors.send(windowId, input)).state).toBe('not_sent');
    expect(sends).toBe(0);
    expect((await mirrors.send(windowId, { ...input, provider: 'claude' })).state).toBe('sent');
    expect(sends).toBe(1);
    await expect(mirrors.send(windowId, input)).rejects.toThrow('different message');
    expect(sends).toBe(1);
  });
  it('allows cross-computer mirror consumers but never a producer or arbitrary RPC', () => {
    expect(proxyPath('GET', `/vscode/deliveries/${windowId}`)).toBe(
      `/api/vscode/deliveries/${windowId}`,
    );
    expect(proxyPath('GET', '/vscode/windows')).toBe('/api/vscode/windows');
    expect(proxyPath('GET', `/vscode/windows/${windowId}`)).toBe(`/api/vscode/windows/${windowId}`);
    for (const query of [
      'before=turn%3Aitem',
      'after=last-item',
      'entry=long-item&offset=8000',
      'activity=first-tool&before=last-tool',
    ])
      expect(proxyPath('GET', `/vscode/windows/${windowId}?${query}`)).toBe(
        `/api/vscode/windows/${windowId}?${query}`,
      );
    for (const query of [
      'before=a&before=b',
      'entry=x&offset=-1',
      'before=a&after=b',
      'method=shell',
    ])
      expect(proxyPath('GET', `/vscode/windows/${windowId}?${query}`)).toBeNull();
    expect(proxyPath('POST', `/vscode/windows/${windowId}/send`)).toBe(
      `/api/vscode/windows/${windowId}/send`,
    );
    expect(proxyPath('GET', '/vscode/bridge', true)).toBeNull();
    expect(proxyPath('POST', `/vscode/windows/${windowId}/rpc`)).toBeNull();
  });
  it('pages a large legacy transcript before sending it to the phone and denies cross-origin reads', async () => {
    const large = { ...state, entries: [{ ...state.entries[0], text: 'history '.repeat(40_000) }] };
    await connect(() => large);
    const res = await app.inject({ url: `/api/vscode/windows/${windowId}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries[0]).toEqual({
      ...large.entries[0],
      text: large.entries[0].text.slice(0, 8000),
      textOffset: 0,
      textLength: large.entries[0].text.length,
    });
    expect(res.json().page).toEqual({ total: 1 });
    const next = await app.inject({
      url: `/api/vscode/windows/${windowId}?entry=1&offset=8000`,
      headers,
    });
    expect(next.json().entries[0].textOffset).toBe(8000);
    expect(next.body.length).toBeLessThan(9000);
    expect(
      (
        await app.inject({
          url: '/api/vscode/windows',
          headers: { ...headers, origin: 'https://evil.test' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('persists a send receipt, deduplicates retries and rejects changed content', async () => {
    let sends = 0;
    await connect((command) =>
      command.type === 'send' ? (++sends, { state: 'sent', message: 'Sent' }) : state,
    );
    const input = { key: randomUUID(), threadId: 'thread', text: 'hello' };
    const result = await mirrors.send(windowId, input);
    expect(result.state).toBe('sent');
    const afterRestart = new VscodeMirrors(store);
    expect(await afterRestart.send(windowId, input)).toEqual(result);
    expect(await afterRestart.send(randomUUID(), input)).toEqual(result);
    expect(sends).toBe(1);
    await expect(mirrors.send(windowId, { ...input, text: 'different' })).rejects.toThrow(
      'different message',
    );
    expect(
      (await app.inject({ url: `/api/vscode/deliveries/${input.key}`, headers })).json(),
    ).toEqual(result);
    expect(
      (await app.inject({ url: `/api/vscode/deliveries/${randomUUID()}`, headers })).json().state,
    ).toBe('uncertain');
    expect(sends).toBe(1);
  });
  it('keeps uncertain intent after disconnect and does not replay through a new gateway', async () => {
    let sends = 0;
    await connect(() => {
      sends++;
      socket!.close();
      return undefined;
    });
    const input = { key: randomUUID(), threadId: 'thread', text: 'hello' };
    expect((await mirrors.send(windowId, input)).state).toBe('uncertain');
    expect((await new VscodeMirrors(store).send(windowId, input)).state).toBe('uncertain');
    expect(sends).toBe(1);
  });
  it('accepts only the narrow send contract and never sends to a different shared thread', async () => {
    await connect(() => state);
    const result = await app.inject({
      method: 'POST',
      url: `/api/vscode/windows/${windowId}/send`,
      headers,
      payload: { key: randomUUID(), threadId: 'thread', text: 'hello', method: 'shell' },
    });
    expect(result.statusCode).toBe(400);
    expect(
      (await mirrors.send(windowId, { key: randomUUID(), threadId: 'other', text: 'hello' })).state,
    ).toBe('not_sent');
  });
  it('refuses browser-origin extension producers', async () => {
    const address = app.server.address() as { port: number };
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/vscode/bridge`, { headers });
    await new Promise<void>((resolve) => socket!.once('close', () => resolve()));
    expect(mirrors.windows()).toEqual([]);
  });
});

it('delivers a long Unicode owner message through HTTP and the editor with one receipt', async () => {
  const sent: unknown[] = [];
  await connect((command) => {
    if (command.type === 'send') {
      sent.push(command.input);
      return { state: 'sent', message: 'Delivered.' };
    }
    return state;
  });
  const input = { key: randomUUID(), threadId: 'thread', text: '科学 🧪'.repeat(25_000) };
  const request = {
    method: 'POST' as const,
    url: `/api/vscode/windows/${windowId}/send`,
    headers,
    payload: input,
  };
  expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(128 * 1024);
  const first = await app.inject(request);
  expect(first.statusCode).toBe(200);
  expect(first.json().state).toBe('sent');
  expect((await app.inject(request)).json()).toEqual(first.json());
  expect(sent).toEqual([input]);
});
