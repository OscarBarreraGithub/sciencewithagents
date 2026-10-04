import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, publicTask } from './store.js';
import { repoRoot } from './paths.js';

let root: string, store: Store;
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/store-'));
  store = new Store(join(root, 'dock.sqlite'));
});
afterEach(() => {
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
describe('durable state', () => {
  it('migrates legacy unique folders without changing IDs, history or foreign references', () => {
    const original = store.register(root, 'Original', 'Keep this');
    const run = store.enqueue(original.managerId, randomUUID(), 'Saved message');
    const agent = store.agent(original.managerId),
      entries = store.entries(original.managerId),
      events = store.events();
    store.close();
    const legacy = new DatabaseSync(join(root, 'dock.sqlite'));
    legacy.exec(`PRAGMA foreign_keys=OFF;
      BEGIN;
      CREATE TABLE legacy_projects (id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      INSERT INTO legacy_projects SELECT * FROM projects;
      DROP TABLE projects;
      ALTER TABLE legacy_projects RENAME TO projects;
      COMMIT;`);
    legacy.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(store.db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(store.agent(original.managerId)).toEqual(agent);
    expect(store.run(run.id).text).toBe('Saved message');
    expect(store.entries(original.managerId)).toEqual(entries);
    expect(store.events()).toEqual(events);
    const key = randomUUID();
    const fresh = store.register(root, 'New idea', '', 'claude', key);
    expect(fresh.id).not.toBe(original.id);
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(store.register(root, 'New idea', '', 'claude', key)).toEqual(fresh);
    expect(store.projects()).toHaveLength(2);
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => store.db.prepare('DELETE FROM projects WHERE id=?').run(original.id)).toThrow();
  });
  it('explicitly retains full WAL commit synchronization across reopen', () => {
    expect(store.db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(store.db.prepare('PRAGMA synchronous').get()).toMatchObject({ synchronous: 2 });
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(store.db.prepare('PRAGMA synchronous').get()).toMatchObject({ synchronous: 2 });
  });

  it('retains immutable image bytes atomically through nested import and restart', () => {
    const project = store.register(root, 'Images', ''),
      agentId = project.managerId;
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
      'base64',
    );
    const entry = {
      id: 'native-image-item',
      agentId,
      runId: null,
      kind: 'tool' as const,
      title: 'Generated image',
      text: 'Test image',
      status: 'complete',
      createdAt: new Date().toISOString(),
    };
    expect(() =>
      store.transaction(() => {
        store.imageEntry(entry, bytes);
        throw new Error('Failed import');
      }),
    ).toThrow('Failed import');
    expect(store.db.prepare('SELECT id FROM images').all()).toHaveLength(0);
    expect(store.entries(agentId)).toHaveLength(0);
    store.transaction(() => store.imageEntry(entry, bytes));
    const image = store.entries(agentId)[0].image!;
    store.imageEntry(entry, bytes);
    expect(store.entries(agentId)[0].image).toEqual(image);
    expect(store.db.prepare('SELECT id FROM images').all()).toHaveLength(1);
    const different = Buffer.from(bytes);
    different[35] ^= 1;
    expect(() => store.imageEntry(entry, different)).toThrow('replayed');
    expect(store.image(agentId, image.id)).toEqual(bytes);
    const events = store.events(),
      entries = store.entries(agentId);
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(store.image(agentId, image.id)).toEqual(bytes);
    expect(store.entries(agentId)).toEqual(entries);
    expect(store.events()).toEqual(events);
    expect(JSON.stringify(events)).not.toContain(bytes.toString('base64'));
  });

  it('keeps legacy web access off without rewriting history and persists explicit worker modes', () => {
    const project = store.register(root, 'Project', '');
    const worker = store.addAgent({
      provider: 'codex', // This fixture exercises Codex's native web modes, independent of the provider preset.
      projectId: project.id,
      parentId: project.managerId,
      taskId: null,
      role: 'researcher',
      name: 'Researcher',
      cwd: root,
    });
    expect(worker.webSearch).toBe('cached');
    expect(store.agent(project.managerId).webSearch).toBe('disabled');
    store.db
      .prepare(
        "UPDATE agents SET body=json_remove(body, '$.webSearch', '$.imageGeneration') WHERE id=?",
      )
      .run(worker.id);
    const body = store.db.prepare('SELECT body FROM agents WHERE id=?').get(worker.id),
      events = store.events();
    expect(store.agent(worker.id).webSearch).toBe('disabled');
    expect(store.agent(worker.id).imageGeneration).toBe(false);
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(store.agents().find((agent) => agent.id === worker.id)?.webSearch).toBe('disabled');
    expect(store.db.prepare('SELECT body FROM agents WHERE id=?').get(worker.id)).toEqual(body);
    expect(store.events()).toEqual(events);
    store.updateAgent(worker.id, { webSearch: 'indexed', imageGeneration: true });
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(store.agent(worker.id).webSearch).toBe('indexed');
    expect(store.agent(worker.id).imageGeneration).toBe(true);
  });

  it('derives public task evidence across restart without rewriting old tasks, conversations or events', () => {
    const project = store.register(root, 'Project', '');
    const task = store.addTask(project.id, {
      title: 'Code result',
      goal: 'One change',
      acceptance: 'Reviewed',
      parentId: null,
    });
    store.enqueue(project.managerId, randomUUID(), 'Retain this conversation');
    store.updateTask(task.id, {
      status: 'done',
      worktree: '/private/worktree',
      baseCommit: 'base',
      reviewedCommit: 'reviewed',
    });
    const body = store.db.prepare('SELECT body FROM tasks WHERE id=?').get(task.id);
    const events = store.events(),
      entries = store.entries(project.managerId);
    expect(publicTask(store.task(task.id)).hasReviewedChanges).toBe(true);
    expect(JSON.parse(String(body!.body))).not.toHaveProperty('hasReviewedChanges');
    expect(events.at(-1)?.data).toMatchObject({ hasReviewedChanges: true });
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(publicTask(store.task(task.id)).hasReviewedChanges).toBe(true);
    expect(store.db.prepare('SELECT body FROM tasks WHERE id=?').get(task.id)).toEqual(body);
    expect(store.events()).toEqual(events);
    expect(store.entries(project.managerId)).toEqual(entries);
    store.updateTask(task.id, { reviewedCommit: null });
    expect(publicTask(store.task(task.id)).hasReviewedChanges).toBe(false);
    expect(store.events().at(-1)?.data).toMatchObject({ hasReviewedChanges: false });
    store.updateTask(task.id, { reviewedCommit: 'base' });
    expect(publicTask(store.task(task.id)).hasReviewedChanges).toBe(false);
    store.updateTask(task.id, { baseCommit: null, reviewedCommit: 'reviewed' });
    expect(publicTask(store.task(task.id)).hasReviewedChanges).toBe(false);
  });
  it('migrates context ownership from current and retired history without rewriting the archive', () => {
    const project = store.register(root, 'Project', '');
    const manager = project.managerId;
    store.updateAgent(manager, { threadId: 'current' });
    store.event('session.retired', project.id, manager, { threadId: 'retired' });
    store.event('session.forked', project.id, manager, {
      threadId: 'fork',
      previousThreadId: 'source',
    });
    store.enqueue(manager, randomUUID(), 'The retained conversation');
    const entries = store.entries(manager);
    const events = store.events();
    store.db.exec("DROP TABLE contexts; DELETE FROM settings WHERE key='migration:contexts:v1';");
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    for (const id of ['current', 'retired', 'fork', 'source'])
      expect(store.contextOwner(id)).toBe(manager);
    expect(store.entries(manager)).toEqual(entries);
    expect(store.events()).toEqual(events);
    const other = store.addManager(project.id, 'Other', 'Another module');
    expect(() => store.updateAgent(other.id, { threadId: 'retired' })).toThrow('another agent');
    expect(store.agent(other.id).threadId).toBe(null);
    store.updateAgent(manager, { threadId: 'next' });
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(store.agent(manager).threadId).toBe('next');
    expect(store.contextOwner('current')).toBe(manager);
    expect(store.contextOwner('next')).toBe(manager);
    expect(store.entries(manager)).toEqual(entries);
  });
  it('upgrades old tasks without changing identities, conversations, or historical events', () => {
    const project = store.register(root, 'Project', '');
    const task = store.addTask(project.id, {
      title: 'Legacy task',
      goal: 'Keep the archive',
      acceptance: 'History survives',
      parentId: null,
    });
    const run = store.enqueue(project.managerId, randomUUID(), 'A saved conversation');
    store.db
      .prepare("UPDATE agents SET body=json_remove(body, '$.scope') WHERE id=?")
      .run(project.managerId);
    store.db
      .prepare("UPDATE tasks SET body=json_remove(body, '$.managerId') WHERE id=?")
      .run(task.id);
    const events = store.events();
    const entries = store.entries(project.managerId);
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(store.task(task.id).managerId).toBe(project.managerId);
    expect(store.agent(project.managerId).scope).toBe('');
    expect(store.entries(project.managerId)).toEqual(entries);
    expect(store.run(run.id).text).toBe('A saved conversation');
    expect(store.events()).toEqual(events);
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(store.task(task.id).managerId).toBe(project.managerId);
    expect(store.events()).toEqual(events);
  });
  it('keeps module manager identity and task ownership across restart', () => {
    const project = store.register(root, 'Project', '');
    const manager = store.addManager(project.id, 'Interface manager', 'Web interface');
    const task = store.addTask(project.id, {
      title: 'Layout',
      goal: 'Readable UI',
      acceptance: 'No overflow',
      parentId: null,
      managerId: manager.id,
    });
    expect(manager).toMatchObject({
      role: 'manager',
      permission: 'workspace-write',
      parentId: null,
    });
    expect(() => store.addManager(project.id, 'INTERFACE MANAGER', 'Duplicate')).toThrow(
      'already exists',
    );
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(store.agent(manager.id).scope).toBe('Web interface');
    expect(store.task(task.id).managerId).toBe(manager.id);
    expect(store.project(project.id).managerId).toBe(project.managerId);
  });
  it('retains exact external receipts and never retries a crash-ambiguous action', async () => {
    let calls = 0;
    const action = async () => {
      calls++;
      return { ok: true };
    };
    expect(await store.externalOperation('one', { value: 1 }, action)).toEqual({ ok: true });
    expect(await store.externalOperation('one', { value: 1 }, action)).toEqual({ ok: true });
    expect(calls).toBe(1);
    await expect(store.externalOperation('one', { value: 2 }, action)).rejects.toThrow(
      'different input',
    );
    await expect(
      store.externalOperation('uncertain', {}, async () => {
        throw new Error('lost acknowledgement');
      }),
    ).rejects.toThrow('lost acknowledgement');
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    await expect(store.externalOperation('uncertain', {}, action)).rejects.toThrow(
      'will not be repeated',
    );
    expect(calls).toBe(1);
  });
  it('retains exactly one message for an idempotent retry and rejects changed input', () => {
    const project = store.register(root, 'Project', '');
    const key = randomUUID();
    const first = store.transaction(() => store.enqueue(project.managerId, key, 'A bounded goal'));
    expect(
      store.transaction(() => store.enqueue(project.managerId, key, 'A bounded goal')).id,
    ).toBe(first.id);
    expect(() =>
      store.transaction(() => store.enqueue(project.managerId, key, 'A changed goal')),
    ).toThrow('different message');
    expect(store.runs()).toHaveLength(1);
    expect(store.entries(project.managerId)).toHaveLength(1);
    const count = store.head;
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(store.runs()[0].text).toBe('A bounded goal');
    expect(store.head).toBe(count);
  });
  it('rolls back the whole mutation and preserves append-only monotonic events', () => {
    const project = store.register(root, 'Project', '');
    const head = store.head;
    expect(() =>
      store.transaction(() => {
        store.enqueue(project.managerId, randomUUID(), 'Will roll back');
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(store.runs()).toHaveLength(0);
    expect(store.head).toBe(head);
    expect(() =>
      store.db.prepare('UPDATE events SET type=? WHERE id=?').run('changed', head),
    ).toThrow('append-only');
    expect(() => store.db.prepare('DELETE FROM events WHERE id=?').run(head)).toThrow(
      'append-only',
    );
    store.event('next', project.id, null, {});
    expect(store.events(head).map((e) => e.id)).toEqual([head + 1]);
  });
  it('marks in-flight work interrupted and expires approvals after restart without replaying actions', () => {
    const project = store.register(root, 'Project', '');
    const run = store.enqueue(project.managerId, randomUUID(), 'A goal');
    store.updateRun(run.id, { status: 'running' });
    const approval = store.addApproval(project.managerId, {
      kind: 'command',
      title: 'Example',
      details: '',
      questions: [],
      requestId: 12,
      params: {},
    });
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    store.recover();
    expect(store.run(run.id).status).toBe('interrupted');
    expect(store.agent(project.managerId).status).toBe('interrupted');
    expect(store.approval(approval.id).status).toBe('expired');
    expect(store.runs().filter((r) => r.status === 'queued')).toHaveLength(0);
  });
});

it('keeps streamed entry-change storage linear while complete text survives pagination and reopen', async () => {
  const project = store.register(root, 'Streaming', '');
  const agentId = project.managerId;
  const entryId = `${agentId}:long-reply`;
  const before = store.head;
  const text = 'A measured observation. '.repeat(100);
  const entry = {
    id: entryId,
    agentId,
    runId: null,
    kind: 'assistant' as const,
    title: 'Reply',
    text: '',
    status: 'streaming',
    createdAt: new Date().toISOString(),
  };
  for (let i = 1; i <= 100; i++) store.entry({ ...entry, text: text.repeat(i) });
  store.entry({ ...entry, text: text.repeat(100), status: 'complete' });
  const events = store.events(before);
  expect(events).toHaveLength(101);
  expect(events.every((event) => JSON.stringify(event.data).length < 250)).toBe(true);
  expect(events.at(-1)?.data).toMatchObject({ entryId, status: 'complete' });
  expect(store.savedEntry(agentId, entryId)?.text).toBe(text.repeat(100));
  expect(store.savedEntry(randomUUID(), entryId)).toBeNull();
  // Many newer entries cannot hide or truncate an older continuing reply.
  for (let i = 0; i < 210; i++)
    store.entry({ ...entry, id: `${agentId}:other-${i}`, text: 'Tool activity', kind: 'tool' });
  expect(store.entries(agentId).some((item) => item.id === entryId)).toBe(false);
  expect(store.savedEntry(agentId, entryId)?.text).toBe(text.repeat(100));
  const historical = store.events(0, 1000);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  expect(store.savedEntry(agentId, entryId)?.text).toBe(text.repeat(100));
  expect(store.events(0, 1000)).toEqual(historical);
});
