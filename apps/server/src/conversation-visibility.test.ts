import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { conversationVisibilityPageSchema, type MirrorState } from '@dock/shared';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { VscodeMirrors } from './vscode-mirror.js';
import { createServer } from './server.js';
import { modelFixture } from './model-policy.fixture.js';

let root: string, store: Store, runtime: Runtime, mirrors: VscodeMirrors, app: FastifyInstance;
let manager: string, windows: Omit<MirrorState, 'entries'>[];
const headers = {
  host: '127.0.0.1:4999',
  origin: 'http://127.0.0.1:4999',
  'content-type': 'application/json',
};
const get = (url: string) => app.inject({ url, headers });
const save = (body: unknown) =>
  app.inject({ method: 'POST', url: '/api/conversations/visibility', headers, payload: body });
const change = (
  target:
    | { kind: 'agent'; agentId: string }
    | { kind: 'shared'; provider: 'codex' | 'claude'; threadId: string },
  archived = true,
  expectedRevision = 0,
) => ({ key: randomUUID(), target, archived, expectedRevision });
async function open() {
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  manager = store.projects()[0]?.managerId ?? store.register(root, 'Private fixture', '').managerId;
  runtime = new Runtime(store, root, 'codex', async () => {
    throw new Error('Archive must not launch a provider');
  });
  mirrors = new VscodeMirrors(store);
  vi.spyOn(mirrors, 'windows').mockImplementation(() => windows);
  app = await createServer(store, runtime, { port: 4999, mirrors });
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'swa-conversation-visibility-'));
  windows = [
    {
      windowId: randomUUID(),
      provider: 'codex',
      threadId: 'same-native-thread',
      title: 'Codex discussion',
      label: 'Editor fixture',
      status: 'busy',
      message: '',
      source: 'vscode',
    },
    {
      windowId: randomUUID(),
      provider: 'claude',
      threadId: 'same-native-thread',
      title: 'Claude discussion',
      label: 'Other editor fixture',
      status: 'idle',
      message: '',
      source: 'vscode',
    },
  ];
  await open();
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

it('archives an app conversation without changing active work, approval, files or searchable text', async () => {
  store.updateAgent(manager, {
    surface: 'misc',
    status: 'running',
    threadId: 'retained-native-thread',
    turnId: 'retained-native-turn',
  });
  const run = store.enqueue(manager, randomUUID(), 'Continue existing work');
  store.updateRun(run.id, { status: 'running', turnId: 'retained-native-turn' });
  const approval = store.addApproval(manager, {
    kind: 'input',
    title: 'Existing owner question',
    details: '',
    questions: [],
    requestId: 'request',
    params: {},
  });
  store.entry({
    id: randomUUID(),
    agentId: manager,
    runId: run.id,
    kind: 'assistant',
    title: 'Saved evidence',
    text: 'Retained archive evidence remains searchable.',
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  writeFileSync(join(root, 'sentinel.txt'), 'Preserved owner file');
  const before = store.agent(manager);
  const kick = vi.spyOn(runtime, 'kick');
  const result = await save(change({ kind: 'agent', agentId: manager }));
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    revision: 1,
    archived: true,
    title: before.name,
    caption: 'Private fixture',
    source: 'app',
  });
  expect(store.agent(manager)).toEqual(before);
  expect(store.run(run.id)).toMatchObject({ status: 'running', turnId: 'retained-native-turn' });
  expect(store.approval(approval.id).status).toBe('pending');
  expect(readFileSync(join(root, 'sentinel.txt'), 'utf8')).toBe('Preserved owner file');
  expect(kick).not.toHaveBeenCalled();
  expect((await get('/api/conversations')).json().conversations).toEqual([]);
  expect((await get('/api/conversations?includeArchived=true')).json().conversations[0].id).toBe(
    manager,
  );
  const snapshot = (await get('/api/snapshot')).json();
  expect(snapshot.agents.find((agent: { id: string }) => agent.id === manager)).toMatchObject({
    status: 'waiting',
  });
  expect(snapshot.approvals.find((item: { id: string }) => item.id === approval.id)).toBeDefined();
  const search = await app.inject({
    method: 'POST',
    url: '/api/archive/search',
    headers,
    payload: { source: 'managed', query: 'Retained archive evidence', limit: 10 },
  });
  expect(search.statusCode).toBe(200);
  expect(JSON.stringify(search.json())).toContain('Retained archive evidence');
});

it('keeps exact archive retries durable after restart and refuses stale-device revisions', async () => {
  const input = change({ kind: 'agent', agentId: manager });
  const [first, duplicate] = await Promise.all([save(input), save(input)]);
  expect(first.statusCode).toBe(200);
  expect(duplicate.json()).toEqual(first.json());
  const id = first.json().id;
  expect(store.events().filter((event) => event.type === 'conversation.visibility')).toHaveLength(
    1,
  );
  const stale = await save(change(input.target, false, 0));
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('VISIBILITY_CHANGED');
  await app.close();
  await open();
  expect((await save(input)).json()).toEqual(first.json());
  const restored = await save(change(input.target, false, 1));
  expect(restored.json()).toMatchObject({ id, revision: 2, archived: false, archivedAt: null });
  expect((await save(input)).json()).toEqual(first.json());
  expect((await get('/api/conversations/visibility')).json().records[0]).toMatchObject({
    id,
    revision: 2,
    archived: false,
  });
  expect((await save({ ...input, archived: false })).statusCode).toBe(409);
});

it('archives shared native identity across window changes, preserves searchable source and restores offline', async () => {
  const original = windows[0];
  const input = change({ kind: 'shared', provider: 'codex', threadId: original.threadId! });
  const read = vi.spyOn(mirrors, 'read').mockResolvedValue({
    ...original,
    entries: [{ id: 'native-entry', role: 'assistant', text: 'Retained shared native evidence' }],
    page: { total: 1 },
  });
  const send = vi.spyOn(mirrors, 'send');
  const control = vi.spyOn(mirrors, 'control');
  const saved = (await save(input)).json();
  expect(saved).toMatchObject({
    title: 'Codex discussion',
    caption: 'Editor fixture',
    provider: 'codex',
    source: 'vscode',
    revision: 1,
  });
  expect(read).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(control).not.toHaveBeenCalled();
  const search = await app.inject({
    method: 'POST',
    url: '/api/archive/search',
    headers,
    payload: {
      source: 'editor',
      windowId: original.windowId,
      threadId: original.threadId,
      provider: 'codex',
      query: 'Retained shared native evidence',
      limit: 10,
    },
  });
  expect(search.statusCode).toBe(200);
  expect(JSON.stringify(search.json())).toContain('Retained shared native evidence');
  windows[0] = { ...original, windowId: randomUUID() };
  expect(
    (await get('/api/vscode/windows'))
      .json()
      .map((window: { provider: string }) => window.provider),
  ).toEqual(['claude']);
  expect((await get('/api/vscode/windows?includeArchived=true')).json()).toHaveLength(2);
  const editors = (await get('/api/archive/editors')).json().windows;
  expect(editors).toHaveLength(2);
  expect(windows[0].status).toBe('busy');
  expect(mirrors.windows()[0].threadId).toBe(original.threadId);
  windows = [];
  await app.close();
  await open();
  expect(
    (await get('/api/conversations/visibility?archived=true')).json().records[0],
  ).toMatchObject(saved);
  expect((await save(change(input.target, false, 1))).json()).toMatchObject({
    title: saved.title,
    caption: saved.caption,
    archived: false,
    revision: 2,
  });
  windows = [{ ...original, windowId: randomUUID() }];
  expect((await get('/api/vscode/windows')).json()[0].threadId).toBe(original.threadId);
});

it('pages saved visibility without dropping metadata and rejects forged targets and route parameters', async () => {
  await save(change({ kind: 'agent', agentId: manager }));
  await save(change({ kind: 'shared', provider: 'codex', threadId: windows[0].threadId! }));
  await save(change({ kind: 'shared', provider: 'claude', threadId: windows[1].threadId! }));
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = conversationVisibilityPageSchema.parse(
      (
        await get(`/api/conversations/visibility?limit=1${cursor ? `&cursor=${cursor}` : ''}`)
      ).json(),
    );
    expect(page.records).toHaveLength(1);
    seen.push(page.records[0].id);
    cursor = page.nextCursor;
  } while (cursor);
  expect(new Set(seen).size).toBe(3);
  windows[0] = { ...windows[0], title: 't'.repeat(700), label: 'c'.repeat(300) };
  const bounded = await save(
    change({ kind: 'shared', provider: 'codex', threadId: windows[0].threadId! }, true, 1),
  );
  expect(bounded.statusCode).toBe(200);
  expect(bounded.json().title).toHaveLength(500);
  expect(bounded.json().caption).toHaveLength(200);
  expect((await get('/api/conversations/visibility?limit=101')).statusCode).toBe(400);
  expect((await get(`/api/conversations/visibility?cursor=${randomUUID()}`)).statusCode).toBe(404);
  expect((await get('/api/conversations/visibility?path=/tmp')).statusCode).toBe(400);
  expect(
    (
      await save({
        ...change({ kind: 'agent', agentId: manager }),
        title: 'Client-supplied metadata',
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await save(change({ kind: 'shared', provider: 'codex', threadId: '../../not-observed' })))
      .statusCode,
  ).toBe(404);
  expect((await save(change({ kind: 'agent', agentId: randomUUID() }))).statusCode).toBe(404);
});
