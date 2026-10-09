import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { repoRoot } from './paths.js';
import { modelFixture } from './model-policy.fixture.js';
import {
  git,
  ensureWorktree,
  checkpointWorktree,
  integrationPreview,
  integrate,
  reconcileTask,
} from './workspaces.js';
import { attention } from '@dock/shared';
import { conversationEntries } from './conversation-entries.js';
import { historyPage, historyRead } from './history.js';
let root: string, projectRoot: string, store: Store, runtime: Runtime, projectId: string;
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/integration-'));
  projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  await git(projectRoot, ['init', '-b', 'main']);
  await git(projectRoot, ['config', 'user.name', 'Fixture']);
  await git(projectRoot, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(projectRoot, 'README.md'), 'Original project\n');
  await git(projectRoot, ['add', '.']);
  await git(projectRoot, ['commit', '-m', 'Initial']);
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  projectId = store.register(projectRoot, 'Parallel work', '').id;
  runtime = new Runtime(store, root, 'never-start-real-provider', async () => new DemoProvider());
  // Requests queue normally, but this fixture deliberately inspects admission without running a model.
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
});
afterEach(async () => {
  if (store.db.isOpen) {
    await runtime.close();
    store.close();
  }
  rmSync(root, { recursive: true, force: true });
});
async function reviewed(name: string) {
  const task = store.addTask(projectId, {
    title: name,
    goal: `Add ${name}`,
    acceptance: 'One file',
    parentId: null,
  });
  const path = await ensureWorktree(store, task, root);
  writeFileSync(join(path, `${name}.txt`), `${name} work\n`);
  const source = await checkpointWorktree(store, task.id);
  store.updateTask(task.id, {
    status: 'done',
    review: 'Independent review approved',
    reviewedCommit: source,
  });
  return { task: store.task(task.id), path, source };
}
it('previews only a task’s own changes when parallel work diverges and never applies a misleading two-tip diff', async () => {
  const first = await reviewed('First'),
    second = await reviewed('Second');
  const preview = await integrationPreview(store, first.task.id);
  expect(preview.canApply).toBe(true);
  await integrate(store, first.task.id, preview);
  const divergent = await integrationPreview(store, second.task.id);
  expect(divergent).toMatchObject({ relation: 'diverged', canApply: false });
  expect(divergent.patch).toContain('+Second work');
  expect(divergent.patch).not.toContain('First.txt');
  expect(divergent.changes).not.toContain('First.txt');
  await expect(integrate(store, second.task.id, divergent)).rejects.toThrow(
    'Prepare updated changes',
  );
  expect(readFileSync(join(projectRoot, 'First.txt'), 'utf8')).toBe('First work\n');
  expect(await git(projectRoot, ['rev-parse', 'HEAD'])).toBe(first.source);
});
it('creates one scoped follow-up with the same manager and allowance ancestry, retaining original review and files', async () => {
  const first = await reviewed('First'),
    second = await reviewed('Second');
  await integrate(store, first.task.id, await integrationPreview(store, first.task.id));
  const p = await integrationPreview(store, second.task.id),
    input = { key: randomUUID(), source: p.source, target: p.target };
  const saved = await reconcileTask(store, second.task.id, input);
  expect(saved).toMatchObject({
    parentId: second.task.id,
    managerId: second.task.managerId,
    status: 'open',
  });
  expect(store.task(second.task.id)).toMatchObject({
    status: 'done',
    review: second.task.review,
    reviewedCommit: second.source,
    reconciliationTaskId: saved.id,
  });
  expect(await git(second.path, ['rev-parse', 'HEAD'])).toBe(second.source);
  expect(await reconcileTask(store, second.task.id, input)).toEqual(saved);
  expect(await reconcileTask(store, second.task.id, { ...input, key: randomUUID() })).toEqual(
    saved,
  );
  expect(store.runs()).toHaveLength(1);
  const run = store.runs()[0]!;
  expect(store.getSetting(`pulsar:task:${run.id}`)).toBe(saved.id);
  expect(runtime.quark.taskIds(run)).toEqual([saved.id, second.task.id]);
  expect(runtime.clients.size).toBe(0);
  const preview = await integrationPreview(store, second.task.id);
  expect(preview.reconciliationTaskId).toBe(saved.id);
  const app = await createServer(store, runtime, { port: 4999 });
  try {
    const snapshot = (
      await app.inject({ url: '/api/snapshot', headers: { host: '127.0.0.1:4999' } })
    ).json();
    expect(
      attention(snapshot).items.some((i) => i.id === second.task.id && i.kind === 'integration'),
    ).toBe(false);
  } finally {
    await app.close();
  }
});
async function divergedReconcile() {
  const first = await reviewed('First'),
    second = await reviewed('Second');
  await integrate(store, first.task.id, await integrationPreview(store, first.task.id));
  const p = await integrationPreview(store, second.task.id);
  await reconcileTask(store, second.task.id, {
    key: randomUUID(),
    source: p.source,
    target: p.target,
  });
  const run = store.runs()[0]!;
  return { run, manager: run.agentId };
}
it('delivers a generated reconciliation handoff as an app notification under manager apply policy', async () => {
  const { run, manager } = await divergedReconcile();
  // Native delivery is unchanged: the manager still receives a user-role turn.
  expect(run).toMatchObject({ kind: 'user', sourceId: null });
  expect(run.text).toMatch(/^App notification \(generated by the app, not written by the owner\)/);
  expect(run.text).toContain('Owner confirmation is not required.');
  expect(run.text).not.toMatch(/owner requested|owner's (exact preview|confirmation)/i);
  expect(store.savedEntry(manager, run.id)).toMatchObject({
    kind: 'system',
    title: 'App notification',
    text: run.text,
  });
  expect(conversationEntries(store, manager).entries.find((e) => e.id === run.id)).toMatchObject({
    kind: 'system',
    title: 'App notification',
  });
  expect(runtime.workItems.ownerRequests(manager, { limit: 50 }).items).toEqual([]);
});
it('asks for owner confirmation only when the project requires human apply review', async () => {
  store.setSetting(`project-workflow:${projectId}`, { applyChanges: 'human' });
  const { run } = await divergedReconcile();
  expect(run.text).toContain(
    "This project requires the owner's review before applying changes: return the exact apply preview for the owner's confirmation.",
  );
  expect(run.text).not.toContain('Owner confirmation is not required');
});
it('labels retained reconciliation handoffs by exact run key without changing text or owner messages', () => {
  const manager = store.project(projectId).managerId!,
    taskId = randomUUID();
  const legacyText = `The owner requested updated changes for task ${taskId} (Old). Return it for the owner's exact preview and confirmation.`;
  const legacy = store.enqueue(manager, `reconcile:${taskId}`, legacyText, 'user');
  // Owner wording alone never makes a message an app notification.
  const owner = store.enqueue(manager, randomUUID(), legacyText, 'user');
  expect(store.savedEntry(manager, legacy.id)).toMatchObject({ kind: 'user', text: legacyText });
  const shown = conversationEntries(store, manager, undefined, 'conversation').entries;
  expect(shown.find((e) => e.id === legacy.id)).toMatchObject({
    kind: 'system',
    title: 'App notification · not written by you',
    text: legacyText,
  });
  expect(shown.find((e) => e.id === owner.id)).toMatchObject({ kind: 'user', title: 'You' });
  expect(
    runtime.workItems
      .ownerRequests(manager, { limit: 50, includeHandled: true })
      .items.map((i) => i.entryId),
  ).toEqual([owner.id]);
  const page = historyPage(store, projectId, { agentId: manager });
  expect(page.items.find((i) => i.id === legacy.id)).toMatchObject({
    kind: 'system',
    title: 'App notification · not written by you',
  });
  expect(page.items.find((i) => i.id === owner.id)).toMatchObject({ kind: 'user' });
  expect(historyRead(store, projectId, { source: 'entry', id: legacy.id })).toMatchObject({
    kind: 'system',
    text: legacyText,
  });

  // New links must be owner messages; an item linked earlier stays updatable.
  expect(() =>
    runtime.workItems.saveForManager(manager, {
      key: randomUUID(),
      kind: 'internal',
      title: 'Follow the generated handoff',
      sourceMessages: [{ agentId: manager, entryId: legacy.id }],
    }),
  ).toThrow('is not a retained owner message');
  const item = runtime.workItems.saveForManager(manager, {
    key: randomUUID(),
    kind: 'internal',
    title: 'Earlier linked handoff',
    sourceMessages: [{ agentId: manager, entryId: owner.id }],
  });
  const sources = [
    { agentId: manager, entryId: owner.id },
    { agentId: manager, entryId: legacy.id },
  ];
  store.db
    .prepare("UPDATE work_items SET body=json_set(body,'$.sourceMessages',json(?)) WHERE id=?")
    .run(JSON.stringify(sources), item.id);
  store.db
    .prepare('INSERT INTO work_item_sources(item_id,agent_id,entry_id) VALUES(?,?,?)')
    .run(item.id, manager, legacy.id);
  const updated = runtime.workItems.saveForManager(manager, {
    key: randomUUID(),
    id: item.id,
    expectedRevision: item.revision,
    status: 'done',
  });
  expect(updated).toMatchObject({ status: 'done', sourceMessages: sources });
});
it('requires a fresh exact preview before starting a follow-up and rejects a changed review', async () => {
  const first = await reviewed('First'),
    second = await reviewed('Second');
  await integrate(store, first.task.id, await integrationPreview(store, first.task.id));
  const p = await integrationPreview(store, second.task.id);
  writeFileSync(join(projectRoot, 'new.txt'), 'Later owner work\n');
  await git(projectRoot, ['add', '.']);
  await git(projectRoot, ['commit', '-m', 'Later']);
  await expect(
    reconcileTask(store, second.task.id, { key: randomUUID(), source: p.source, target: p.target }),
  ).rejects.toThrow('Refresh');
  store.updateTask(second.task.id, { reviewedCommit: null });
  await expect(
    reconcileTask(store, second.task.id, { key: randomUUID(), source: p.source, target: p.target }),
  ).rejects.toThrow('current finished task');
  expect(store.tasks()).toHaveLength(2);
  expect(store.runs()).toHaveLength(0);
});
it('returns an empty apply preview when reviewed changes are already an ancestor of the project', async () => {
  const first = await reviewed('First');
  await git(projectRoot, ['merge', '--ff-only', first.source]);
  writeFileSync(join(projectRoot, 'later.txt'), 'Later work\n');
  await git(projectRoot, ['add', '.']);
  await git(projectRoot, ['commit', '-m', 'Later']);
  const target = await git(projectRoot, ['rev-parse', 'HEAD']);
  const preview = await integrationPreview(store, first.task.id);
  expect(preview).toMatchObject({
    relation: 'already-present',
    canApply: true,
    patch: '',
    changes: '',
  });
  await integrate(store, first.task.id, preview);
  expect(await git(projectRoot, ['rev-parse', 'HEAD'])).toBe(target);
  expect(store.task(first.task.id).status).toBe('integrated');
});
it('exposes the explicit follow-up through the protected API with a durable retry receipt', async () => {
  const first = await reviewed('First'),
    second = await reviewed('Second');
  await integrate(store, first.task.id, await integrationPreview(store, first.task.id));
  const p = await integrationPreview(store, second.task.id);
  const app = await createServer(store, runtime, { port: 4999 });
  try {
    const request = {
      method: 'POST' as const,
      url: `/api/tasks/${second.task.id}/reconcile`,
      headers: { host: '127.0.0.1:4999', origin: 'http://127.0.0.1:4999' },
      payload: { key: randomUUID(), source: p.source, target: p.target },
    };
    const refused = await app.inject({
      ...request,
      headers: { ...request.headers, origin: 'https://example.invalid' },
    });
    expect(refused.statusCode).toBe(403);
    const firstReply = await app.inject(request),
      retry = await app.inject(request);
    expect(firstReply.statusCode).toBe(200);
    expect(retry.json()).toEqual(firstReply.json());
    expect(store.runs()).toHaveLength(1);
    expect(store.run(store.runs()[0]!.id).status).toBe('queued');
  } finally {
    await app.close();
  }
});
