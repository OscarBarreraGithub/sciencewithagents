import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { detailSchema, type Entry, type Run } from '@dock/shared';
import { DemoProvider } from './demo.js';
import { historyPage, historyRead } from './history.js';
import { modelFixture } from './model-policy.fixture.js';
import { repoRoot } from './paths.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { Store } from './store.js';

let root: string, store: Store, runtime: Runtime, app: FastifyInstance, manager: string;
const headers = { host: '127.0.0.1:4999', origin: 'http://127.0.0.1:4999' };
async function open() {
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  manager = store.register(root, 'Owner project', '').managerId;
  runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  app = await createServer(store, runtime, { port: 4999 });
}
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/conversation-entries-'));
  await open();
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
function append(runId: string | null, kind: Entry['kind'], text: string, title = 'Saved evidence') {
  const value: Entry = {
    id: randomUUID(),
    agentId: manager,
    runId,
    kind,
    title,
    text,
    status: 'complete',
    createdAt: new Date().toISOString(),
  };
  store.entry(value);
  return value;
}
function queue(kind: Run['kind'], sourceId: string | null = null) {
  const run = store.enqueue(manager, randomUUID(), 'Recorded input', kind, sourceId);
  store.updateRun(run.id, { status: 'completed' });
  return run;
}
async function page(channel = 'all', before?: string) {
  const query = new URLSearchParams({ channel });
  if (before) query.set('before', before);
  const result = await app.inject({ url: `/api/agents/${manager}?${query}`, headers });
  expect(result.statusCode).toBe(200);
  return detailSchema.parse(result.json());
}

it('classifies exact retained report/message runs without guessing names or changing stored history', async () => {
  const sender = store.addAgent({
    projectId: store.agent(manager).projectId,
    parentId: manager,
    taskId: null,
    name: 'Arbitrary sender',
    role: 'researcher',
    cwd: root,
  });
  const report = queue('report', sender.id);
  const acknowledgment = append(report.id, 'assistant', 'Keep this original acknowledgment');
  const tool = append(report.id, 'tool', 'Recorded native activity');
  const message = queue('message', sender.id);
  const reply = append(message.id, 'assistant', 'A second coordination reply');
  const automatic = queue('report');
  const owner = queue('user');
  const ownerReply = append(owner.id, 'assistant', 'An owner reply', 'QUARK');
  const unknown = append(randomUUID(), 'assistant', 'Missing run remains visible', 'QUARK');
  const system = append(report.id, 'system', 'Permission response stays visible');
  const saved = store.entries(manager);
  const kick = vi.spyOn(runtime, 'kick');
  const all = await page();
  for (const id of [report.id, acknowledgment.id, tool.id])
    expect(all.entries.find((entry) => entry.id === id)?.coordination).toEqual({
      kind: 'report',
      sourceId: sender.id,
    });
  expect(all.entries.find((entry) => entry.id === reply.id)?.coordination).toEqual({
    kind: 'message',
    sourceId: sender.id,
  });
  expect(all.entries.find((entry) => entry.id === automatic.id)?.coordination).toEqual({
    kind: 'report',
    sourceId: null,
  });
  expect((await page('conversation')).entries.map((entry) => entry.id)).toEqual([
    owner.id,
    ownerReply.id,
    unknown.id,
    system.id,
  ]);
  expect((await page('coordination')).entries.every((entry) => entry.coordination)).toBe(true);
  expect(store.entries(manager)).toEqual(saved);
  expect(kick).not.toHaveBeenCalled();
  const archived = historyRead(store, store.agent(manager).projectId, {
    source: 'entry',
    id: acknowledgment.id,
  });
  expect(archived.text).toBe(acknowledgment.text);
  expect(
    historyPage(store, store.agent(manager).projectId, {
      query: 'original acknowledgment',
    }).items.map((item) => item.id),
  ).toContain(acknowledgment.id);
});

it('filters before keyset pagination and classifies old replies absent from the recent run ledger', async () => {
  const conversationIds: string[] = [];
  const coordinationIds: string[] = [];
  for (let index = 0; index < 205; index++) {
    conversationIds.push(append(null, 'user', `Owner message ${index}`).id);
    const run = queue(index % 2 ? 'message' : 'report');
    coordinationIds.push(run.id, append(run.id, 'assistant', `Coordination ${index}`).id);
  }
  const collect = async (channel: string) => {
    const ids: string[] = [];
    let before: string | undefined;
    let pages = 0;
    while (true) {
      const value = await page(channel, before);
      ids.unshift(...value.entries.map((entry) => entry.id));
      pages++;
      if (!value.hasMore) break;
      expect(value.entries).toHaveLength(200);
      before = value.entries[0]!.id;
      expect(pages).toBeLessThan(4);
    }
    return { ids, pages };
  };
  expect(await collect('conversation')).toEqual({ ids: conversationIds, pages: 2 });
  expect(await collect('coordination')).toEqual({ ids: coordinationIds, pages: 3 });
  const oldest = (await page('coordination', coordinationIds[200])).entries;
  expect(oldest[0]?.id).toBe(coordinationIds[0]);
  expect(oldest[1]?.coordination?.kind).toBe('report');
  expect((await page()).runs.some((run) => run.id === coordinationIds[0])).toBe(false);
});

it('keeps an already-streaming reply and following output in main after owner steering, including reopen', async () => {
  const pure = queue('report');
  const pureReply = append(pure.id, 'assistant', 'Previous internal turn');
  const mixed = queue('message');
  store.updateRun(mixed.id, { status: 'running' });
  const streaming = append(mixed.id, 'assistant', 'Before steering');
  store.entry({ ...streaming, status: 'streaming' });
  const tool = append(mixed.id, 'tool', 'An action spanning the update');
  store.entry({ ...tool, status: 'running' });
  expect((await page('conversation')).entries).toHaveLength(0);
  const key = randomUUID();
  runtime.ownerSteering(manager, key, 'Answer my question too', 'uncertain');
  store.entry({ ...streaming, text: 'Before steering and the answer afterward' });
  const following = append(mixed.id, 'assistant', 'Another owner-facing answer');
  runtime.ownerSteering(manager, key, 'Answer my question too', 'submitted');
  const expected = [streaming.id, tool.id, `owner-steering:${key}`, following.id];
  const main = await page('conversation');
  expect(main.entries.map((entry) => entry.id)).toEqual(expected);
  expect(main.entries.find((entry) => entry.id === `owner-steering:${key}`)).toMatchObject({
    kind: 'user',
    ownerInput: { delivery: 'submitted' },
  });
  expect((await page('coordination')).entries.map((entry) => entry.id)).toEqual([
    pure.id,
    pureReply.id,
    mixed.id,
  ]);
  const saved = store.entries(manager);
  await app.close();
  await open();
  expect((await page('conversation')).entries).toEqual(main.entries);
  expect(store.entries(manager)).toEqual(saved);
});

it('preserves legacy owner steering and paged replies on both sides of its boundary', async () => {
  const mixed = queue('report');
  const expected = [];
  for (let index = 0; index < 110; index++)
    expected.push(append(mixed.id, 'assistant', `Earlier item ${index}`).id);
  expected.push(append(mixed.id, 'system', 'Original owner update', 'Owner steering').id);
  for (let index = 0; index < 110; index++)
    expected.push(append(mixed.id, 'assistant', `Following item ${index}`).id);
  const latest = await page('conversation');
  expect(latest.entries.map((entry) => entry.id)).toEqual(expected.slice(-200));
  expect(latest.hasMore).toBe(true);
  const earlier = await page('conversation', latest.entries[0]!.id);
  expect(earlier.entries.map((entry) => entry.id)).toEqual(expected.slice(0, 21));
  expect(earlier.hasMore).toBe(false);
  expect((await page('coordination')).entries.map((entry) => entry.id)).toEqual([mixed.id]);
});

it('keeps pending approvals and human work items primary without exposing another agent through a run or cursor', async () => {
  const projectId = store.agent(manager).projectId;
  const other = store.register(join(root, 'other'), 'Other owner project', '');
  const foreign = store.enqueue(other.managerId, randomUUID(), 'Foreign report', 'report');
  const unlinked = append(foreign.id, 'assistant', 'Unmatched run ownership stays visible');
  const own = queue('report');
  append(own.id, 'assistant', 'Internal acknowledgment');
  const notice = append(own.id, 'system', 'Please answer the permission request');
  const approval = store.addApproval(manager, {
    kind: 'input',
    title: 'Which dataset?',
    details: 'An owner choice is needed.',
    questions: [],
    requestId: 'fixture',
    params: {},
  });
  const human = runtime.workItems.saveForManager(manager, {
    key: randomUUID(),
    kind: 'human',
    title: 'Choose a dataset',
    detail: 'Pick spring or summer.',
  });
  expect((await page('conversation')).entries.map((entry) => entry.id)).toEqual([
    unlinked.id,
    notice.id,
  ]);
  expect((await page('conversation', foreign.id)).entries).toEqual([]);
  const snapshot = (await app.inject({ url: '/api/snapshot', headers })).json();
  expect(snapshot.approvals).toContainEqual(expect.objectContaining({ id: approval.id }));
  expect(runtime.workItems.list({ projectId }).items).toContainEqual(
    expect.objectContaining({ id: human.id, kind: 'human' }),
  );
  expect(
    (await app.inject({ url: `/api/agents/${manager}?channel=guessed`, headers })).statusCode,
  ).toBe(400);
});

it('retains trusted goal output in primary paged history across replacement and reload without rewriting entries', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  const initial = runtime.managedGoals.ownerAction(manager, {
    key: randomUUID(),
    action: 'create',
    expectedRevision: null,
    objective: 'Retain substantive goal work in this conversation',
  });
  const first = store.run(initial.continuation!.runId);
  store.updateRun(first.id, { status: 'running' });
  const checkpoint = runtime.managedGoals.update(
    manager,
    randomUUID(),
    {
      goalId: initial.goal!.id,
      expectedRevision: initial.goal!.revision,
      action: 'continue',
      summary: 'Initial evidence saved',
      nextAction: 'Verify the retained outcome',
    },
    store.run(first.id),
  );
  store.updateRun(first.id, { status: 'completed' });
  store.updateAgent(manager, { status: 'idle' });
  runtime.managedGoals.finish(store.run(first.id), true);
  const automatic = store.run(runtime.managedGoals.view(manager).continuation!.runId);
  expect(automatic.sourceId).toBe(manager);
  expect(store.getSetting(`managed-goal:run:${automatic.id}`)).toBe(checkpoint.id);
  const expected = [first.id];
  for (let index = 0; index < 220; index++)
    expected.push(
      append(automatic.id, index % 2 ? 'tool' : 'assistant', `Substantive result ${index}`).id,
    );
  store.updateRun(automatic.id, { status: 'completed' });
  // A goal-shaped key alone is not trusted goal provenance.
  const untrusted = store.enqueue(
    manager,
    `goal:${checkpoint.id}:after:${randomUUID()}`,
    'Internal scheduling',
    'report',
    manager,
  );
  store.updateRun(untrusted.id, { status: 'completed' });
  const internal = append(
    untrusted.id,
    'assistant',
    'Ordinary internal report remains coordination',
  );
  const other = store.addAgent({
    projectId: store.agent(manager).projectId,
    parentId: manager,
    taskId: null,
    name: 'Other worker',
    role: 'researcher',
    cwd: root,
  });
  const foreignSource = store.enqueue(
    manager,
    `goal:${checkpoint.id}:after:${randomUUID()}`,
    'Worker report',
    'report',
    other.id,
  );
  store.updateRun(foreignSource.id, { status: 'completed' });
  store.setSetting(`managed-goal:run:${foreignSource.id}`, checkpoint.id);
  const foreignReply = append(
    foreignSource.id,
    'assistant',
    'Worker acknowledgment still belongs in coordination',
  );
  const latest = await page('conversation');
  expect(latest.entries.map((entry) => entry.id)).toEqual(expected.slice(-200));
  expect(latest.hasMore).toBe(true);
  const earlier = await page('conversation', latest.entries[0]!.id);
  expect(earlier.entries.map((entry) => entry.id)).toEqual(expected.slice(0, 21));
  expect(earlier.hasMore).toBe(false);
  const coordination = [automatic.id, untrusted.id, internal.id, foreignSource.id, foreignReply.id];
  expect((await page('coordination')).entries.map((entry) => entry.id)).toEqual(coordination);
  const replaced = runtime.managedGoals.ownerAction(manager, {
    key: randomUUID(),
    action: 'replace',
    expectedRevision: runtime.managedGoals.view(manager).goal!.revision,
    objective: 'A new explicit goal',
  });
  expected.push(replaced.continuation!.runId);
  const savedBodies = store.db
    .prepare('SELECT id,body FROM entries WHERE agent_id=? ORDER BY rowid')
    .all(manager);
  await app.close();
  await open();
  const reloaded = await page('conversation');
  expect(reloaded.entries.map((entry) => entry.id)).toEqual(expected.slice(-200));
  expect(
    (await page('conversation', reloaded.entries[0]!.id)).entries.map((entry) => entry.id),
  ).toEqual(expected.slice(0, 22));
  expect((await page('coordination')).entries.map((entry) => entry.id)).toEqual(coordination);
  expect(
    store.db.prepare('SELECT id,body FROM entries WHERE agent_id=? ORDER BY rowid').all(manager),
  ).toEqual(savedBodies);
});
