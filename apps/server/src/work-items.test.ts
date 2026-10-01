import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { projectNotesSchema, workItemSchema, workItemsSchema } from '@dock/shared';
import { Conflict, Missing, Store } from './store.js';
import { repoRoot } from './paths.js';
import { registerWorkItemRoutes, WorkItems } from './work-items.js';

let root: string, store: Store, items: WorkItems;
let projectId: string, managerId: string, otherProjectId: string, otherManagerId: string;
let app: FastifyInstance | undefined;
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/work-items-'));
  store = new Store(join(root, 'dock.sqlite'));
  const first = store.register(join(root, 'first'), 'First project', '', 'codex');
  const second = store.register(join(root, 'second'), 'Second project', '', 'codex');
  projectId = first.id;
  managerId = first.managerId;
  otherProjectId = second.id;
  otherManagerId = second.managerId;
  items = new WorkItems(store);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
  store.close();
  rmSync(root, { recursive: true, force: true });
});
function restart() {
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  items = new WorkItems(store);
}
function ask() {
  return items.saveForManager(managerId, {
    key: randomUUID(),
    kind: 'human',
    title: 'Which dataset should we use?',
    detail: 'Choose the spring or summer measurements.',
  });
}

it('persists personal and manager to-dos with generated IDs, scoped reads and append-only history', () => {
  const key = randomUUID();
  const personal = items.save({ key, title: 'Read the methods paper' });
  const internal = items.saveForManager(managerId, {
    key: randomUUID(),
    title: 'Check the sample counts',
  });
  expect(personal).toMatchObject({
    kind: 'general',
    projectId: null,
    managerId: null,
    taskId: null,
    status: 'open',
    revision: 1,
  });
  expect(personal.id).not.toBe(key);
  expect(internal).toMatchObject({ kind: 'internal', projectId, managerId, revision: 1 });
  const head = store.head;
  restart();
  expect(items.save({ key, title: 'Read the methods paper' })).toEqual(personal);
  expect(items.list().items).toEqual([internal, personal]);
  expect(items.list({ projectId }).items).toEqual([internal]);
  expect(items.list({ projectId: otherProjectId }).items).toEqual([]);
  expect(store.runs()).toHaveLength(0);
  expect(store.head).toBe(head);
  const changed = items.save({
    key: randomUUID(),
    id: personal.id,
    expectedRevision: 1,
    status: 'done',
  });
  expect(changed).toMatchObject({ revision: 2, status: 'done' });
  expect(changed.resolvedAt).toBeTruthy();
  expect(store.events().filter((event) => event.type.startsWith('work-item.'))).toHaveLength(3);
  expect(() =>
    store.db.prepare('DELETE FROM events WHERE type=?').run('work-item.created'),
  ).toThrow('append-only events');
});

it('rejects stale writes and retry keys used for a different request without losing the latest changes', () => {
  const first = items.save({ key: randomUUID(), title: 'Original note' });
  const input = { key: randomUUID(), id: first.id, expectedRevision: 1, title: 'Updated note' };
  const updated = items.save(input);
  expect(() => items.save({ ...input, key: randomUUID(), title: 'Stale note' })).toThrow(Conflict);
  expect(() => items.save({ key: randomUUID(), id: first.id, status: 'done' })).toThrow(Conflict);
  expect(() => items.save({ ...input, title: 'Changed retry' })).toThrow('different input');
  expect(items.save(input)).toEqual(updated);
  expect(items.get(first.id)).toEqual(updated);
});

it('derives manager scope and refuses cross-project, cross-manager and worker mutations', () => {
  const human = ask();
  const peer = store.addManager(projectId, 'Methods manager', 'Methods', 'codex');
  const worker = store.addAgent({
    projectId,
    parentId: managerId,
    taskId: null,
    name: 'Research',
    role: 'researcher',
    cwd: join(root, 'first'),
    provider: 'codex',
  });
  for (const unauthorized of [otherManagerId, peer.id]) {
    expect(() =>
      items.saveForManager(unauthorized, {
        key: randomUUID(),
        id: human.id,
        expectedRevision: human.revision,
        status: 'done',
      }),
    ).toThrow('their own');
  }
  expect(() =>
    items.saveForManager(worker.id, { key: randomUUID(), title: 'Spoofed manager' }),
  ).toThrow('existing project manager');
  expect(() =>
    items.saveForManager(managerId, {
      key: randomUUID(),
      title: 'Spoofed scope',
      projectId: otherProjectId,
    }),
  ).toThrow(ZodError);
  expect(() =>
    items.saveForManager(managerId, {
      key: randomUUID(),
      id: human.id,
      expectedRevision: 1,
      humanReply: 'Invented owner answer',
    }),
  ).toThrow(ZodError);
  expect(items.get(human.id)).toEqual(human);
  expect(store.runs()).toHaveLength(0);
});

it('requires concise human asks and validates linked tasks against their project and manager', () => {
  const task = store.addTask(projectId, {
    title: 'Summarize results',
    goal: 'A summary',
    acceptance: 'Readable',
    parentId: null,
  });
  expect(() => items.save({ key: randomUUID(), title: 'No manager', kind: 'human' })).toThrow(
    'need a project manager',
  );
  expect(() =>
    items.saveForManager(managerId, {
      key: randomUUID(),
      title: 'A question',
      kind: 'human',
      detail: 'one\ntwo\nthree',
    }),
  ).toThrow('one or two');
  expect(() =>
    items.saveForManager(managerId, {
      key: randomUUID(),
      title: 'A question',
      kind: 'human',
      detail: 'a'.repeat(481),
    }),
  ).toThrow('one or two');
  expect(() =>
    items.saveForManager(otherManagerId, {
      key: randomUUID(),
      title: 'Wrong task',
      taskId: task.id,
    }),
  ).toThrow('task belonging');
  const saved = items.saveForManager(managerId, {
    key: randomUUID(),
    title: 'Confirm the chart labels',
    kind: 'human',
    taskId: task.id,
  });
  expect(saved).toMatchObject({ projectId, managerId, taskId: task.id, status: 'waiting' });
});

it('saves a human reply and one linked manager run atomically across lost-response retries and restart', () => {
  const human = ask();
  const input = {
    key: randomUUID(),
    id: human.id,
    expectedRevision: human.revision,
    humanReply: 'Use summer.',
  };
  const replied = items.save(input);
  expect(replied).toMatchObject({ humanReply: 'Use summer.', status: 'in_progress', revision: 2 });
  expect(replied.repliedAt).toBeTruthy();
  expect(replied.replyRunId).toBeTruthy();
  const run = store.run(replied.replyRunId!);
  expect(run).toMatchObject({ agentId: managerId, kind: 'user', status: 'queued' });
  expect(run.text).toContain(human.id);
  expect(run.text).toContain(projectId);
  expect(run.text).toContain(human.title);
  expect(run.text).toContain('Owner reply: Use summer.');
  const head = store.head;
  restart();
  expect(items.save(input)).toEqual(replied);
  expect(store.head).toBe(head);
  expect(store.runs()).toHaveLength(1);
  expect(store.entries(managerId).filter((entry) => entry.id === run.id)).toHaveLength(1);
  expect(() => items.save({ ...input, key: randomUUID() })).toThrow('changed');
  expect(() => items.save({ ...input, key: randomUUID(), expectedRevision: 2 })).toThrow(
    'already answered',
  );
  const completed = items.saveForManager(managerId, {
    key: randomUUID(),
    id: replied.id,
    expectedRevision: 2,
    status: 'done',
  });
  expect(items.save(input)).toEqual(replied);
  expect(items.get(human.id)).toEqual(completed);
  expect(store.runs()).toHaveLength(1);
});

it('allows resolving an ask with its reply and rejects invalid reply states without enqueueing', () => {
  const human = ask();
  expect(() =>
    items.save({
      key: randomUUID(),
      id: human.id,
      expectedRevision: 1,
      humanReply: 'Use summer.',
      status: 'waiting',
    }),
  ).toThrow('in progress or done');
  expect(store.runs()).toHaveLength(0);
  const resolved = items.save({
    key: randomUUID(),
    id: human.id,
    expectedRevision: 1,
    humanReply: 'Use summer.',
    status: 'done',
  });
  expect(resolved).toMatchObject({ status: 'done', revision: 2 });
  expect(resolved.resolvedAt).toEqual(resolved.repliedAt);
  expect(store.runs()).toHaveLength(1);
});

it('assigns a personal to-do to an existing manager once and keeps the original assignment', () => {
  const personal = items.save({ key: randomUUID(), title: 'Compare the samples' });
  const input = { key: randomUUID(), id: personal.id, expectedRevision: 1, managerId };
  const assigned = items.save(input);
  expect(assigned).toMatchObject({ projectId, managerId, status: 'in_progress', revision: 2 });
  expect(assigned.assignmentRunId).toBeTruthy();
  restart();
  expect(items.save(input)).toEqual(assigned);
  const edited = items.save({
    key: randomUUID(),
    id: personal.id,
    expectedRevision: 2,
    title: 'Compare all samples',
  });
  expect(edited.assignmentRunId).toBe(assigned.assignmentRunId);
  expect(() =>
    items.save({
      key: randomUUID(),
      id: personal.id,
      expectedRevision: 3,
      managerId: otherManagerId,
    }),
  ).toThrow('original project and manager');
  expect(store.runs()).toHaveLength(1);
  expect(store.run(assigned.assignmentRunId!).text).toContain(personal.id);
});

it('rolls back the reply, queue, entries, events and receipt together if enqueue fails', () => {
  const human = ask();
  const input = { key: randomUUID(), id: human.id, expectedRevision: 1, humanReply: 'Use summer.' };
  const head = store.head;
  const enqueue = store.enqueue.bind(store);
  const failure = vi.spyOn(store, 'enqueue').mockImplementationOnce((...args) => {
    enqueue(...args);
    throw new Error('Simulated failure after the run was written');
  });
  expect(() => items.save(input)).toThrow('Simulated failure');
  expect(items.get(human.id)).toEqual(human);
  expect(store.runs()).toHaveLength(0);
  expect(store.entries(managerId)).toHaveLength(0);
  expect(store.head).toBe(head);
  expect(store.agent(managerId).status).toBe('idle');
  failure.mockRestore();
  restart();
  const replied = items.save(input);
  expect(replied.humanReply).toBe('Use summer.');
  expect(store.runs()).toHaveLength(1);
});

it('rolls back an assignment enqueue failure and retries exactly once across later edits and restart', () => {
  const personal = items.save({
    key: randomUUID(),
    title: 'Send this once',
    detail: 'Keep every line.\nMore detail.',
  });
  const input = { key: randomUUID(), id: personal.id, expectedRevision: 1, managerId };
  const head = store.head;
  const enqueue = store.enqueue.bind(store);
  const failure = vi.spyOn(store, 'enqueue').mockImplementationOnce((...args) => {
    enqueue(...args);
    throw new Error('Assignment response failure');
  });
  expect(() => items.save(input)).toThrow('Assignment response failure');
  expect(items.get(personal.id)).toEqual(personal);
  expect(store.head).toBe(head);
  expect(store.runs()).toHaveLength(0);
  expect(store.entries(managerId)).toHaveLength(0);
  failure.mockRestore();
  restart();
  const assigned = items.save(input);
  const completed = items.saveForManager(managerId, {
    key: randomUUID(),
    id: personal.id,
    expectedRevision: assigned.revision,
    status: 'done',
  });
  const reopened = items.save({
    key: randomUUID(),
    id: personal.id,
    expectedRevision: completed.revision,
    status: 'open',
  });
  restart();
  expect(items.save(input)).toEqual(assigned);
  expect(items.get(personal.id)).toEqual(reopened);
  expect(reopened.assignmentRunId).toBe(assigned.assignmentRunId);
  expect(store.runs()).toHaveLength(1);
  expect(store.run(assigned.assignmentRunId!).text).toContain(personal.detail);
  expect(
    store.entries(managerId).filter((entry) => entry.id === assigned.assignmentRunId),
  ).toHaveLength(1);
});

it('versions project notes with durable receipts, manager authorship and preserved prior text', () => {
  expect(items.notes(projectId)).toEqual({
    projectId,
    text: '',
    revision: 0,
    updatedAt: null,
    updatedByManagerId: null,
  });
  const input = { key: randomUUID(), expectedRevision: 0, text: 'Prefer the summer measurements.' };
  const first = items.saveNotes(projectId, input);
  restart();
  expect(items.saveNotes(projectId, input)).toEqual(first);
  expect(items.notes(projectId)).toEqual(first);
  expect(() =>
    items.saveNotes(projectId, { ...input, key: randomUUID(), text: 'Stale notes' }),
  ).toThrow('notes changed');
  const second = items.saveNotesForManager(managerId, {
    key: randomUUID(),
    expectedRevision: 1,
    text: 'Summer measurements chosen; labels confirmed.',
  });
  expect(second).toMatchObject({ revision: 2, updatedByManagerId: managerId });
  expect(items.notes(otherProjectId).revision).toBe(0);
  const history = store.events().filter((event) => event.type === 'project.notes.updated');
  expect(history.map((event) => projectNotesSchema.parse(event.data).text)).toEqual([
    input.text,
    second.text,
  ]);
  expect(() =>
    items.saveNotes(projectId, {
      key: randomUUID(),
      expectedRevision: 2,
      text: 'a'.repeat(24_001),
    }),
  ).toThrow(ZodError);
  expect(() => items.notes(randomUUID())).toThrow(Missing);
});

it('serves validated HTTP item and note contracts, scoped lists, conflicts and a queue wake after a reply', async () => {
  app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(
        error instanceof ZodError
          ? 400
          : error instanceof Conflict
            ? 409
            : error instanceof Missing
              ? 404
              : 500,
      )
      .send({ error: error.message }),
  );
  const kick = vi.fn();
  registerWorkItemRoutes(app, items, kick);
  const human = ask();
  const list = await app.inject({ method: 'GET', url: `/api/work-items?projectId=${projectId}` });
  expect(list.statusCode).toBe(200);
  expect(workItemsSchema.parse(list.json()).items).toEqual([human]);
  const input = { key: randomUUID(), id: human.id, expectedRevision: 1, humanReply: 'Summer.' };
  const saved = await app.inject({ method: 'POST', url: '/api/work-items', payload: input });
  expect(saved.statusCode).toBe(200);
  expect(workItemSchema.parse(saved.json()).humanReply).toBe('Summer.');
  expect(kick).toHaveBeenCalledTimes(1);
  const retry = await app.inject({ method: 'POST', url: '/api/work-items', payload: input });
  expect(retry.json()).toEqual(saved.json());
  expect(store.runs()).toHaveLength(1);
  const stale = await app.inject({
    method: 'POST',
    url: '/api/work-items',
    payload: { ...input, key: randomUUID() },
  });
  expect(stale.statusCode).toBe(409);
  const unknown = await app.inject({
    method: 'POST',
    url: '/api/work-items',
    payload: {
      key: randomUUID(),
      title: 'Bad request',
      path: '/tmp/arbitrary',
    },
  });
  expect(unknown.statusCode).toBe(400);
  const notes = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/notes`,
    payload: {
      key: randomUUID(),
      expectedRevision: 0,
      text: 'The owner selected summer.',
    },
  });
  expect(notes.statusCode).toBe(200);
  expect(projectNotesSchema.parse(notes.json()).revision).toBe(1);
  const read = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/notes` });
  expect(read.json()).toEqual(notes.json());
  const missing = await app.inject({ method: 'GET', url: `/api/projects/${randomUUID()}/notes` });
  expect(missing.statusCode).toBe(404);
});
