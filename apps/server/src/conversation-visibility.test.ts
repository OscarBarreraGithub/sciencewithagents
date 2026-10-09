import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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
type NativeMetadata = Pick<MirrorState, 'source' | 'label' | 'title' | 'lastActivityAt'>;
let native: Record<string, NativeMetadata>;
const metadata = vi.fn(async (threadId: string) => {
  if (!native[threadId]) throw new Error('Codex has no such thread.');
  return native[threadId];
});
const daemon = {
  discover: async () => {},
  windows: () => [],
  metadata,
  close: () => {},
} as unknown as ConstructorParameters<typeof VscodeMirrors>[1];
const codexHome = () => join(root, 'codex-home');
/** Codex's own local thread index, as kept by the native app (subset of its columns). */
function codexIndex(rows: Record<string, string | number | null>[]) {
  mkdirSync(codexHome(), { recursive: true });
  const db = new DatabaseSync(join(codexHome(), 'state_5.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, source TEXT NOT NULL,
    thread_source TEXT, cwd TEXT NOT NULL, name TEXT, title TEXT NOT NULL,
    preview TEXT NOT NULL DEFAULT '', updated_at_ms INTEGER, updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL)`);
  for (const row of rows)
    db.prepare(
      'INSERT INTO threads (id, source, thread_source, cwd, name, title, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      row.id,
      row.source ?? 'vscode',
      row.thread_source ?? 'user',
      row.cwd ?? '/fixture/agent-dock',
      row.name ?? null,
      row.title ?? '',
      1760000000,
      1760000000,
    );
  db.close();
}
const receipt = (key: string) =>
  store.db.prepare('SELECT 1 FROM operations WHERE key=?').get(`conversation.visibility:${key}`);
/** Pre-catalog provenance: the app once queued an owner message to this exact thread. */
const queuedEarlier = (target: Store, provider: 'codex' | 'claude', threadId: string) =>
  target.db
    .prepare('INSERT INTO mirror_outbox VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), randomUUID(), provider, threadId, 'completed', '{}');
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
  mirrors = new VscodeMirrors(store, daemon, undefined, codexHome());
  vi.spyOn(mirrors, 'windows').mockImplementation(() => windows);
  app = await createServer(store, runtime, { port: 4999, mirrors });
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'swa-conversation-visibility-'));
  native = {};
  metadata.mockClear();
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

it('archives a listed native thread after its editor disconnects and the app restarts', async () => {
  const original = windows[1];
  const target = {
    kind: 'shared' as const,
    provider: 'claude' as const,
    threadId: original.threadId!,
  };
  const read = vi.spyOn(mirrors, 'read');
  const send = vi.spyOn(mirrors, 'send');
  const control = vi.spyOn(mirrors, 'control');
  // The owner's list observed it once; that is the only identity source.
  expect((await get('/api/vscode/windows')).json()).toHaveLength(2);
  windows = [];
  await app.close();
  await open();
  expect((await get('/api/vscode/windows')).json()).toEqual([]);
  const input = change(target);
  const [first, duplicate] = await Promise.all([save(input), save(input)]);
  expect(first.statusCode).toBe(200);
  expect(first.json()).toMatchObject({
    target,
    revision: 1,
    archived: true,
    provider: 'claude',
    source: 'vscode',
    title: 'Claude discussion',
    caption: 'Other editor fixture',
  });
  expect(duplicate.json()).toEqual(first.json());
  expect(store.events().filter((event) => event.type === 'conversation.visibility')).toHaveLength(
    1,
  );
  // Another device's stale first archive is still refused.
  const stale = await save(change(target, true, 0));
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('VISIBILITY_CHANGED');
  await app.close();
  await open();
  expect((await save(input)).json()).toEqual(first.json());
  expect(
    (await get('/api/conversations/visibility?archived=true')).json().records[0],
  ).toMatchObject({ id: first.json().id, archived: true, title: 'Claude discussion' });
  const restored = await save(change(target, false, 1));
  expect(restored.json()).toMatchObject({
    id: first.json().id,
    revision: 2,
    archived: false,
    archivedAt: null,
    title: 'Claude discussion',
    caption: 'Other editor fixture',
  });
  // Identity is provider-specific: the same thread ID under another provider was never listed.
  expect(
    (await save(change({ kind: 'shared', provider: 'codex', threadId: 'never-listed' })))
      .statusCode,
  ).toBe(404);
  expect(read).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(control).not.toHaveBeenCalled();
});

it('archives a chat offline since before the catalog from host provenance and native metadata', async () => {
  windows = [];
  const target = { kind: 'shared' as const, provider: 'codex' as const, threadId: 'legacy-thread' };
  queuedEarlier(store, 'codex', target.threadId);
  native[target.threadId] = {
    source: 'vscode',
    label: 'agent-dock',
    title: 'Summarize Agent Dock vision',
    lastActivityAt: '2026-10-08T12:00:00.000Z',
  };
  expect(mirrors.known('codex', target.threadId)).toBeNull();
  const read = vi.spyOn(mirrors, 'read');
  const send = vi.spyOn(mirrors, 'send');
  const control = vi.spyOn(mirrors, 'control');
  const input = change(target);
  const [first, duplicate] = await Promise.all([save(input), save(input)]);
  expect(first.statusCode).toBe(200);
  expect(first.json()).toMatchObject({
    target,
    revision: 1,
    archived: true,
    provider: 'codex',
    source: 'vscode',
    title: 'Summarize Agent Dock vision',
    caption: 'agent-dock',
    lastActivityAt: '2026-10-08T12:00:00.000Z',
  });
  expect(duplicate.json()).toEqual(first.json());
  expect(store.events().filter((event) => event.type === 'conversation.visibility')).toHaveLength(
    1,
  );
  expect(metadata.mock.calls.every(([id]) => id === target.threadId)).toBe(true);
  const stale = await save(change(target, true, 0));
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('VISIBILITY_CHANGED');
  await app.close();
  await open();
  native = {};
  metadata.mockClear();
  expect((await save(input)).json()).toEqual(first.json());
  const restored = await save(change(target, false, 1));
  expect(restored.json()).toMatchObject({
    id: first.json().id,
    revision: 2,
    archived: false,
    title: 'Summarize Agent Dock vision',
    caption: 'agent-dock',
  });
  // Saved visibility needs no further native reads.
  expect(metadata).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(control).not.toHaveBeenCalled();
});

it('accepts only exact host-known earlier identities and keeps authentication', async () => {
  windows = [];
  queuedEarlier(store, 'codex', 'queued-codex');
  native['queued-codex'] = { source: 'vscode', label: 'agent-dock', title: 'Queued chat' };
  native['native-only'] = {
    source: 'codex-daemon',
    label: 'Codex on this computer',
    title: 'Terminal session',
  };
  codexIndex([
    { id: 'helper-thread', title: 'Managed helper', thread_source: 'sciencewithagents' },
    { id: 'subagent-thread', title: 'Subagent', source: '{"subagent":"review"}' },
  ]);
  const shared = (provider: 'codex' | 'claude', threadId: string) =>
    change({ kind: 'shared', provider, threadId });
  // Wrong provider for a queued identity; Claude has no native metadata source.
  expect((await save(shared('claude', 'queued-codex'))).statusCode).toBe(404);
  expect((await save(shared('codex', 'never-seen'))).statusCode).toBe(404);
  // App-managed helpers and subagents are not owner chats.
  expect((await save(shared('codex', 'helper-thread'))).statusCode).toBe(404);
  expect((await save(shared('codex', 'subagent-thread'))).statusCode).toBe(404);
  // Another computer's provenance never authorizes this one.
  const otherRoot = mkdtempSync(join(tmpdir(), 'swa-conversation-visibility-other-'));
  const other = new Store(join(otherRoot, 'dock.sqlite'));
  new VscodeMirrors(other, undefined, undefined, join(otherRoot, 'codex'));
  queuedEarlier(other, 'codex', 'foreign-thread');
  other.close();
  rmSync(otherRoot, { recursive: true, force: true });
  expect((await save(shared('codex', 'foreign-thread'))).statusCode).toBe(404);
  const denied = await app.inject({
    method: 'POST',
    url: '/api/conversations/visibility',
    headers: { ...headers, host: 'dock.example.test', origin: 'https://dock.example.test' },
    payload: shared('codex', 'queued-codex'),
  });
  expect(denied.statusCode).toBeGreaterThanOrEqual(400);
  expect(denied.statusCode).not.toBe(404);
  expect((await get('/api/conversations/visibility')).json().records).toEqual([]);
  expect((await save(shared('codex', 'native-only'))).json()).toMatchObject({
    source: 'codex-daemon',
    title: 'Terminal session',
    caption: 'Codex on this computer',
  });
  expect(metadata.mock.calls.map(([id]) => id).sort()).toEqual([
    'foreign-thread',
    'helper-thread',
    'native-only',
    'never-seen',
    'subagent-thread',
  ]);
});

it('uses the local Codex index while its server is offline and never invents labels', async () => {
  windows = [];
  // Daemon offline: every metadata read fails, as with an absent control socket.
  queuedEarlier(store, 'codex', 'owner-thread');
  queuedEarlier(store, 'codex', 'pending-thread');
  queuedEarlier(store, 'claude', 'legacy-claude');
  codexIndex([{ id: 'owner-thread', name: 'Summarize Agent Dock vision', title: 'Other' }]);
  const owner = change({ kind: 'shared', provider: 'codex', threadId: 'owner-thread' });
  const first = await save(owner);
  expect(first.statusCode).toBe(200);
  expect(first.json()).toMatchObject({
    archived: true,
    source: 'vscode',
    title: 'Summarize Agent Dock vision',
    caption: 'agent-dock',
    lastActivityAt: '2025-10-09T08:53:20.000Z',
  });
  // Unreadable index: retryable, with no record, receipt or event.
  writeFileSync(join(codexHome(), 'state_6.sqlite'), 'not a database');
  const pending = change({ kind: 'shared', provider: 'codex', threadId: 'pending-thread' });
  const unavailable = await save(pending);
  expect(unavailable.statusCode).toBe(409);
  expect(unavailable.json().code).toBe('METADATA_UNAVAILABLE');
  // Known Claude chat without saved labels: nothing is synthesized.
  const claude = change({ kind: 'shared', provider: 'claude', threadId: 'legacy-claude' });
  expect((await save(claude)).json().code).toBe('METADATA_UNAVAILABLE');
  expect(receipt(pending.key)).toBeUndefined();
  expect(receipt(claude.key)).toBeUndefined();
  expect((await get('/api/conversations/visibility')).json().records).toHaveLength(1);
  expect(store.events().filter((event) => event.type === 'conversation.visibility')).toHaveLength(
    1,
  );
  // Same keys succeed once real labels are available.
  rmSync(join(codexHome(), 'state_6.sqlite'));
  codexIndex([{ id: 'pending-thread', title: 'Pending native title', cwd: '/fixture/site' }]);
  windows = [
    {
      windowId: randomUUID(),
      provider: 'claude',
      threadId: 'legacy-claude',
      title: 'Claude legacy title',
      label: 'Claude workspace',
      status: 'idle',
      message: '',
      source: 'vscode',
    },
  ];
  await mirrors.list(true);
  windows = [];
  const retried = await save(pending);
  expect(retried.json()).toMatchObject({ title: 'Pending native title', caption: 'site' });
  expect((await save(claude)).json()).toMatchObject({
    title: 'Claude legacy title',
    caption: 'Claude workspace',
  });
  await app.close();
  rmSync(codexHome(), { recursive: true, force: true });
  await open();
  expect((await save(pending)).json()).toEqual(retried.json());
  expect((await save(owner)).json()).toEqual(first.json());
  const restored = await save(change(owner.target, false, 1));
  expect(restored.json()).toMatchObject({
    archived: false,
    title: 'Summarize Agent Dock vision',
    caption: 'agent-dock',
  });
});

it('keeps list recency and a hard 2,000-identity bound in storage and memory', async () => {
  const listed = (threadId: string, title = threadId): Omit<MirrorState, 'entries'> => ({
    windowId: randomUUID(),
    provider: 'codex',
    threadId,
    title,
    label: 'Editor fixture',
    status: 'idle',
    message: '',
    source: 'vscode',
  });
  const rows = () =>
    Number(store.db.prepare('SELECT count(*) AS n FROM mirror_listed_threads').get()?.n);
  windows = [listed('A', 'Kept discussion')];
  await mirrors.list(true);
  windows = Array.from({ length: 1999 }, (_, index) => listed(`B${index}`));
  await mirrors.list(true);
  // Relisting unchanged A makes it the most recent, so C evicts the oldest B instead.
  windows = [listed('A', 'Kept discussion')];
  await mirrors.list(true);
  windows = [listed('C')];
  await mirrors.list(true);
  expect(rows()).toBe(2000);
  expect(mirrors.known('codex', 'A')?.title).toBe('Kept discussion');
  expect(mirrors.known('codex', 'B0')).toBeNull();
  expect(mirrors.known('codex', 'B1')).not.toBeNull();
  // Restart reloads the same order: unchanged polls write nothing.
  await app.close();
  await open();
  const writes = vi.spyOn(store.db, 'prepare');
  windows = [listed('C')];
  await mirrors.list(true);
  expect(writes.mock.calls.some(([sql]) => /mirror_listed_threads/.test(String(sql)))).toBe(false);
  writes.mockRestore();
  windows = [];
  const archived = await save(change({ kind: 'shared', provider: 'codex', threadId: 'A' }));
  expect(archived.json()).toMatchObject({ title: 'Kept discussion', caption: 'Editor fixture' });
  // One oversized list still stays within the bound, and an evicted identity is relisted.
  windows = Array.from({ length: 2001 }, (_, index) => listed(`D${index}`));
  await mirrors.list(true);
  expect(rows()).toBe(2000);
  expect(mirrors.known('codex', 'A')).toBeNull();
  expect(mirrors.known('codex', 'D2000')).toBeNull();
  windows = [listed('A', 'Kept discussion')];
  await mirrors.list(true);
  expect(rows()).toBe(2000);
  expect(mirrors.known('codex', 'A')?.title).toBe('Kept discussion');
  expect(mirrors.known('codex', 'D0')).toBeNull();
  expect(metadata).not.toHaveBeenCalled();
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
