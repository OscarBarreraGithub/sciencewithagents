import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { NativeRelay } from './native-relay.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.reverse()) clean();
  cleanups.length = 0;
});

it('forwards native RPC unchanged and holds fork acknowledgement until host subscription completes', async () => {
  // Unix socket paths must also fit when the checkout itself is deeply nested.
  const root = mkdtempSync(join(tmpdir(), 'dock-relay-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/rpc' });
  cleanups.push(() => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    http.close();
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(join(root, 'p'), () => {
      http.off('error', reject);
      resolve();
    });
  });
  const upstream: Record<string, unknown>[] = [];
  wss.on('connection', (socket) =>
    socket.on('message', (data) => {
      const value = JSON.parse(data.toString());
      upstream.push(value);
      if (value.method === 'thread/fork' || value.method === 'thread/resume') {
        socket.send(
          JSON.stringify({ method: 'thread/started', params: { thread: { id: 'fork' } } }),
        );
        socket.send(JSON.stringify({ id: value.id, result: { thread: { id: 'fork' } } }));
      } else if (
        ['turn/start', 'config/batchWrite', 'thread/compact/start'].includes(value.method)
      ) {
        socket.send(JSON.stringify({ id: value.id, result: {} }));
      } else if (value.method === 'plugin/list') {
        socket.send(
          JSON.stringify({ id: value.id, result: { catalog: 'x'.repeat(5 * 1024 * 1024) } }),
        );
      } else socket.send(data, { binary: false });
    }),
  );
  let subscribed!: () => void;
  const subscription = new Promise<void>((resolve) => {
    subscribed = resolve;
  });
  const cancel = vi.fn();
  const finish = vi.fn(async () => {
    await subscription;
  });
  let allowResume!: () => void;
  const resumePreparation = new Promise<void>((resolve) => {
    allowResume = resolve;
  });
  let handoffReady = false;
  const handoff = vi.fn(async () => {
    if (!handoffReady) throw new Error('Target unavailable');
  });
  let allowTurn!: () => void;
  const turnPreparation = new Promise<void>((resolve) => {
    allowTurn = resolve;
  });
  let allowCompact!: () => void;
  const compactPreparation = new Promise<void>((resolve) => {
    allowCompact = resolve;
  });
  const configFinished = vi.fn();
  const prepare = vi.fn((method, params) => {
    if (method === 'turn/start' || method === 'thread/compact/start')
      return {
        params,
        before: () => (method === 'turn/start' ? turnPreparation : compactPreparation),
        finish: async () => {},
        cancel: () => {},
      };
    if (method === 'config/batchWrite')
      return {
        params,
        finish: async () => {
          configFinished();
        },
        cancel: () => {},
      };
    if (params.threadId === 'another-agent') return { handoff, cancel: () => {} };
    if (method === 'thread/resume')
      return {
        params,
        finish,
        cancel,
        before: async () => {
          if (params.threadId === 'unavailable') throw new Error('Host subscription failed');
          await resumePreparation;
        },
      };
    if (params.threadId !== 'current') throw new Error('Only the current context can fork.');
    return { params: { ...params, deferGoalContinuation: true }, finish, cancel };
  });
  const relay = new NativeRelay(join(root, 'r'), join(root, 'p'), prepare);
  cleanups.push(() => relay.close());
  await relay.start();
  expect(statSync(relay.path).mode & 0o777).toBe(0o600);
  const client = new WebSocket(`ws+unix://${relay.path}:/rpc`, { perMessageDeflate: false });
  cleanups.push(() => client.terminate());
  const received: Record<string, unknown>[] = [];
  client.on('message', (data) => received.push(JSON.parse(data.toString())));
  await once(client, 'open');
  const ordinary = { id: 1, method: 'thread/settings/update', params: { effort: 'high' } };
  client.send(JSON.stringify(ordinary));
  await expect.poll(() => received).toContainEqual(ordinary);
  const provider = [...wss.clients][0];
  const url = {
    id: 'url-approval',
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'current',
      mode: 'url',
      serverName: 'fixture',
      message: 'Continue in the host UI',
      url: 'https://example.invalid',
      elicitationId: 'fixture-url',
    },
  };
  provider.send(JSON.stringify(url));
  const form = { ...url, id: 'ordinary-form', params: { ...url.params, mode: 'form' } };
  provider.send(JSON.stringify(form));
  await expect.poll(() => received).toContainEqual(form);
  expect(received).not.toContainEqual(url);
  expect(upstream.some((value) => value.id === 'url-approval')).toBe(false);
  const resolved = {
    method: 'serverRequest/resolved',
    params: { threadId: 'current', requestId: 'url-approval' },
  };
  provider.send(JSON.stringify(resolved));
  await expect.poll(() => received).toContainEqual(resolved);
  client.send(JSON.stringify({ id: 2, method: 'thread/fork', params: { threadId: 'current' } }));
  await expect.poll(() => finish.mock.calls.length).toBe(1);
  expect(upstream.at(-1)).toEqual({
    id: 2,
    method: 'thread/fork',
    params: {
      threadId: 'current',
      deferGoalContinuation: true,
    },
  });
  expect(received.some((r) => r.id === 2)).toBe(false);
  expect(received.some((r) => r.method === 'thread/started')).toBe(true);
  client.send(JSON.stringify({ id: 3, method: 'turn/start', params: { threadId: 'fork' } }));
  await expect
    .poll(() => received.find((r) => r.id === 3))
    .toMatchObject({ error: { code: -32000 } });
  expect(upstream.some((r) => r.id === 3)).toBe(false);
  // Approval replies and unrelated notifications must not deadlock behind the gate.
  client.send(JSON.stringify({ id: 'approval', result: { decision: 'decline' } }));
  await expect
    .poll(() => received.find((r) => r.id === 'approval'))
    .toMatchObject({ result: { decision: 'decline' } });
  subscribed();
  await expect
    .poll(() => received.find((r) => r.id === 2))
    .toEqual({ id: 2, result: { thread: { id: 'fork' } } });
  expect(cancel).toHaveBeenCalledOnce();
  client.send(JSON.stringify({ id: 4, method: 'thread/fork', params: { threadId: 'foreign' } }));
  await expect
    .poll(() => received.find((r) => r.id === 4))
    .toMatchObject({ error: { code: -32000 } });
  expect(upstream.some((r) => r.id === 4)).toBe(false);
  client.send(JSON.stringify({ id: 5, method: 'thread/resume', params: { threadId: 'current' } }));
  await expect.poll(() => prepare.mock.calls.at(-1)?.[0]).toBe('thread/resume');
  expect(upstream.some((r) => r.id === 5)).toBe(false);
  allowResume();
  await expect
    .poll(() => received.find((r) => r.id === 5))
    .toEqual({ id: 5, result: { thread: { id: 'fork' } } });
  expect(upstream.find((r) => r.id === 5)).toEqual({
    id: 5,
    method: 'thread/resume',
    params: { threadId: 'current' },
  });
  client.send(
    JSON.stringify({ id: 7, method: 'thread/resume', params: { threadId: 'another-agent' } }),
  );
  await expect
    .poll(() => received.find((r) => r.id === 7))
    .toMatchObject({ error: { message: 'Target unavailable' } });
  expect(upstream.some((r) => r.id === 7)).toBe(false);
  client.send(JSON.stringify({ id: 8, method: 'ordinary' }));
  await expect.poll(() => received.find((r) => r.id === 8)).toMatchObject({ method: 'ordinary' });
  const turn = { id: 10, method: 'turn/start', params: { threadId: 'current', input: [] } };
  client.send(JSON.stringify(turn));
  await expect.poll(() => prepare.mock.calls.at(-1)?.[0]).toBe('turn/start');
  expect(upstream.some((r) => r.id === 10)).toBe(false);
  client.send(JSON.stringify({ id: 13, method: 'config/batchWrite', params: { edits: [] } }));
  await expect
    .poll(() => received.find((r) => r.id === 13))
    .toMatchObject({ error: { code: -32000 } });
  expect(upstream.some((r) => r.id === 13)).toBe(false);
  client.send(
    JSON.stringify({ id: 'during-policy', result: { action: 'decline', content: null } }),
  );
  await expect
    .poll(() => received.find((r) => r.id === 'during-policy'))
    .toMatchObject({
      result: { action: 'decline', content: null },
    });
  allowTurn();
  await expect.poll(() => received.find((r) => r.id === 10)).toEqual({ id: 10, result: {} });
  expect(upstream.find((r) => r.id === 10)).toEqual(turn);
  const mutation = { id: 11, method: 'config/batchWrite', params: { edits: [] } };
  client.send(JSON.stringify(mutation));
  await expect.poll(() => received.find((r) => r.id === 11)).toEqual({ id: 11, result: {} });
  expect(upstream.find((r) => r.id === 11)).toEqual(mutation);
  expect(configFinished).toHaveBeenCalledOnce();
  const compact = { id: 14, method: 'thread/compact/start', params: { threadId: 'current' } };
  client.send(JSON.stringify(compact));
  await expect.poll(() => prepare.mock.calls.at(-1)?.[0]).toBe('thread/compact/start');
  expect(upstream.some((r) => r.id === 14)).toBe(false);
  allowCompact();
  await expect.poll(() => received.find((r) => r.id === 14)).toEqual({ id: 14, result: {} });
  expect(upstream.find((r) => r.id === 14)).toEqual(compact);
  client.send(JSON.stringify({ id: 12, method: 'plugin/list', params: {} }));
  await expect
    .poll(
      () => (received.find((r) => r.id === 12)?.result as { catalog?: string })?.catalog?.length,
    )
    .toBe(5 * 1024 * 1024);
  const end = once(client, 'close');
  client.send(
    JSON.stringify({ id: 6, method: 'thread/resume', params: { threadId: 'unavailable' } }),
  );
  await end;
  expect(upstream.some((r) => r.id === 6)).toBe(false);
  expect(finish).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledTimes(3);
  const transferred = new WebSocket(`ws+unix://${relay.path}:/rpc`, { perMessageDeflate: false });
  cleanups.push(() => transferred.terminate());
  await once(transferred, 'open');
  handoffReady = true;
  const moved = once(transferred, 'close');
  transferred.send(
    JSON.stringify({ id: 9, method: 'thread/resume', params: { threadId: 'another-agent' } }),
  );
  await moved;
  expect(handoff).toHaveBeenCalledTimes(2);
  expect(upstream.some((r) => r.id === 9)).toBe(false);
});
