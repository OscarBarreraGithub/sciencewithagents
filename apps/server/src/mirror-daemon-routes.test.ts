import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mirrorPage,
  type MirrorState,
  type MirrorPageQuery,
  type MirrorResult,
} from '@dock/shared';
import { Store } from './store.js';
import { repoRoot } from './paths.js';
import { VscodeMirrors, registerMirrorRoutes } from './vscode-mirror.js';

let root: string, store: Store, app: FastifyInstance, mirrors: VscodeMirrors;
const windowId = randomUUID();
const state: MirrorState = {
  windowId,
  threadId: 'native-thread',
  provider: 'codex',
  source: 'codex-daemon',
  label: 'Codex on this computer',
  title: 'Existing native conversation',
  status: 'busy',
  message: '',
  canSteer: true,
  steerToken: 'active-turn',
  stopToken: 'active-turn',
  paged: true,
  groupedActivity: true,
  entries: Array.from({ length: 85 }, (_, i) => ({
    id: String(i),
    role: 'assistant',
    text: `Message ${i}`,
  })),
};
const summary = () => {
  const { entries: _, ...window } = state;
  return window;
};
let discovered: boolean;
const daemon = {
  discover: vi.fn(async () => {
    discovered = true;
  }),
  windows: vi.fn(() => (discovered ? [summary()] : [])),
  read: vi.fn(async (_id: string, page?: MirrorPageQuery) => mirrorPage(state, page)),
  send: vi.fn(async (): Promise<MirrorResult> => ({ state: 'sent', message: 'Guidance sent' })),
  control: vi.fn(async (): Promise<MirrorResult> => ({ state: 'sent', message: 'Stop requested' })),
  close: vi.fn(),
};
beforeEach(async () => {
  vi.clearAllMocks();
  discovered = false;
  daemon.send.mockImplementation(async () => ({ state: 'sent', message: 'Guidance sent' }));
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/daemon-routes-'));
  store = new Store(join(root, 'dock.sqlite'));
  mirrors = new VscodeMirrors(store, daemon);
  app = Fastify();
  registerMirrorRoutes(app, mirrors, true);
});
afterEach(async () => {
  await app.close();
  mirrors.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const send = () => ({
  key: randomUUID(),
  provider: 'codex' as const,
  threadId: 'native-thread',
  expectedTurnId: 'active-turn',
  text: 'Use the smaller example.',
});

it('discovers existing sessions and returns bounded source-aware pages through the same phone routes', async () => {
  const first = await app.inject({ url: `/api/vscode/windows/${windowId}` });
  expect(first.statusCode).toBe(200);
  expect(first.json()).toMatchObject({
    source: 'codex-daemon',
    threadId: 'native-thread',
    page: { total: 85 },
  });
  expect(first.json().entries).toHaveLength(40);
  const earlier = await app.inject({
    url: `/api/vscode/windows/${windowId}?before=${first.json().page.before}`,
  });
  expect(earlier.json().entries.at(-1).id).toBe('44');
  const list = await app.inject({ url: '/api/vscode/windows' });
  expect(list.json()).toHaveLength(1);
  expect(list.json()[0].entries).toBeUndefined();
  expect(daemon.send).not.toHaveBeenCalled();
  expect(daemon.control).not.toHaveBeenCalled();
});

it('deduplicates a native steer during delivery and across a gateway restart', async () => {
  let finish!: (value: MirrorResult) => void;
  daemon.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const input = send();
  const first = app.inject({
    method: 'POST',
    url: `/api/vscode/windows/${windowId}/send`,
    payload: input,
  });
  await expect.poll(() => daemon.send.mock.calls.length).toBe(1);
  const duplicate = await app.inject({
    method: 'POST',
    url: `/api/vscode/windows/${windowId}/send`,
    payload: input,
  });
  expect(duplicate.json().state).toBe('uncertain');
  finish({ state: 'sent', message: 'Guidance sent' });
  expect((await first).json().state).toBe('sent');
  expect(daemon.send).toHaveBeenCalledExactlyOnceWith(windowId, input);
  const restarted = new VscodeMirrors(store, daemon);
  expect((await restarted.send(randomUUID(), input)).state).toBe('sent');
  await expect(restarted.send(windowId, { ...input, text: 'Changed' })).rejects.toThrow(
    'different message',
  );
  expect(daemon.send).toHaveBeenCalledTimes(1);
});

it('retains a lost native reply as uncertain without resending on receipt lookup or restart', async () => {
  daemon.send.mockRejectedValueOnce(new Error('Connection lost after native write'));
  const input = send();
  const response = await app.inject({
    method: 'POST',
    url: `/api/vscode/windows/${windowId}/send`,
    payload: input,
  });
  expect(response.json().state).toBe('uncertain');
  const receipt = await app.inject({ url: `/api/vscode/deliveries/${input.key}` });
  expect(receipt.json().state).toBe('uncertain');
  expect((await new VscodeMirrors(store, daemon).send(windowId, input)).state).toBe('uncertain');
  expect(daemon.send).toHaveBeenCalledTimes(1);
});

it('refuses provider mismatches and retains one native Stop receipt', async () => {
  const input = { ...send(), provider: 'claude' };
  const refused = await app.inject({
    method: 'POST',
    url: `/api/vscode/windows/${windowId}/send`,
    payload: input,
  });
  expect(refused.json().state).toBe('not_sent');
  expect(daemon.send).not.toHaveBeenCalled();
  const stop = {
    key: randomUUID(),
    threadId: 'native-thread',
    provider: 'codex' as const,
    action: 'interrupt' as const,
    token: 'active-turn',
  };
  const result = await app.inject({
    method: 'POST',
    url: `/api/vscode/windows/${windowId}/control`,
    payload: stop,
  });
  expect(result.json().state).toBe('sent');
  expect(await new VscodeMirrors(store, daemon).control(windowId, stop)).toEqual(result.json());
  expect(daemon.control).toHaveBeenCalledExactlyOnceWith(windowId, stop);
});

it('deduplicates durable app enqueue and never repeats an uncertain native handoff after restart', async () => {
  const { expectedTurnId: _, ...base } = send();
  const input = { ...base, mode: 'queue' as const };
  daemon.send.mockResolvedValueOnce({ state: 'uncertain', message: 'Native acknowledgement lost' });
  const first = await app.inject({
    method: 'POST',
    url: `/api/vscode/windows/${windowId}/send`,
    payload: input,
  });
  expect(first.json().state).toBe('sent');
  expect(daemon.send).not.toHaveBeenCalled();
  const duplicate = await app.inject({
    method: 'POST',
    url: `/api/vscode/windows/${windowId}/send`,
    payload: input,
  });
  expect(duplicate.json()).toEqual(first.json());
  const row = mirrors.queue.list({ provider: 'codex', threadId: 'native-thread' }).items[0];
  state.status = 'idle';
  try {
    await mirrors.queue.pump();
  } finally {
    state.status = 'busy';
  }
  expect(mirrors.queue.item(row.id).status).toBe('uncertain');
  const restarted = new VscodeMirrors(store, daemon);
  try {
    expect((await restarted.send(windowId, input)).state).toBe('sent');
    await restarted.queue.pump();
    expect(daemon.send).toHaveBeenCalledTimes(1);
    expect(daemon.send.mock.calls[0]).toMatchObject([
      windowId,
      { ...base, key: expect.any(String) },
    ]);
    expect(
      (daemon.send.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].expectedTurnId,
    ).toBeUndefined();
  } finally {
    restarted.close();
  }
});
