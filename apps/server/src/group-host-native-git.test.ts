import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { groupContextSchema, type GroupContext } from '@dock/shared';
import { groupNativeGitRequestSchema } from '@dock/shared/dist/group-native-git.js';
import { GroupHostNativeGit } from './group-host-native-git.js';
import type { GroupHost } from './group-host.js';
import type { GroupHostNativeRuntime } from './group-native-host-runtime.js';
import type { Runtime } from './runtime.js';
import { Store } from './store.js';
import { modelFixture } from './model-policy.fixture.js';
import { git, ensureWorktree, checkpointWorktree, integrationPreview } from './workspaces.js';

let root: string, cwd: string, origin: string, store: Store, db: DatabaseSync;
let adapter: GroupHostNativeGit, host: GroupHost, runtime: Runtime;
let context: GroupContext, binding: ReturnType<GroupHostNativeRuntime['resolveLocalContext']>;
let handle: string;
const requests = new Map<string, ReturnType<GroupHostNativeRuntime['context']>>();
beforeEach(async () => {
  mkdirSync('data/tests', { recursive: true });
  root = mkdtempSync(resolve('data/tests/native-group-git-'));
  cwd = join(root, 'shared');
  origin = join(root, 'remote.git');
  await git(root, ['init', '--bare', '--initial-branch=main', origin]);
  await git(root, ['clone', origin, cwd]);
  await git(cwd, ['config', 'user.name', 'Fixture']);
  await git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  db = new DatabaseSync(join(root, 'host.sqlite'));
  const project = store.register(cwd, 'Shared fixture', '');
  handle = randomUUID();
  context = groupContextSchema.parse({
    groupId: randomUUID(),
    memberId: randomUUID(),
    installationId: randomUUID(),
    sessionId: randomUUID(),
    visibility: 'shared',
    provider: 'codex',
    nativeSessionId: 'fixture-shared',
  });
  binding = {
    anchor: context,
    context,
    enrollmentHandle: randomUUID(),
    projectId: project.id,
    agentId: project.managerId,
    provider: 'codex',
    cwd,
  };
  host = {
    db,
    authenticatedContext: async ({ handle: selected }: { handle: string }) => {
      if (selected !== handle) throw new Error('Unknown saved member');
      return { context, enrollmentHandle: binding.enrollmentHandle, revalidate: async () => {} };
    },
    nativeFeatureContext: async () => ({ handle, revalidate: async () => {} }),
  } as unknown as GroupHost;
  runtime = { store, externalControl: new Set<string>() } as Runtime;
  requests.clear();
  const connector = {
    resolveLocalContext: () => binding,
    context: (id: string) => requests.get(id) ?? null,
  } as unknown as GroupHostNativeRuntime;
  adapter = new GroupHostNativeGit(host, runtime, connector, true);
});
afterEach(async () => {
  await adapter?.close();
  if (db?.isOpen) db.close();
  if (store?.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
const sync = () => adapter.request({ action: 'sync', handle, key: randomUUID() });
const status = () => adapter.request({ action: 'status', handle });
async function seed() {
  await git(cwd, ['commit', '--allow-empty', '-m', 'Canonical shared baseline']);
  await git(cwd, ['push', 'origin', 'HEAD:refs/heads/main']);
  await sync();
  return git(cwd, ['rev-parse', 'HEAD']);
}
async function work(intent: 'ask' | 'work' = 'work') {
  const id = randomUUID();
  requests.set(id, { ...binding, runId: null, intent });
  await adapter.beforeWork(context, id);
  // The native connector immediately queues a run after the preparation hook.
  requests.set(id, { ...binding, runId: randomUUID(), intent });
  return id;
}
async function reviewed(name = 'drawing') {
  const task = store.addTask(binding.projectId, {
    title: name,
    goal: `Add ${name}`,
    acceptance: 'One shared file',
    parentId: null,
  });
  const path = await ensureWorktree(store, task, root);
  writeFileSync(join(path, `${name}.txt`), `${name} shared outcome\n`);
  const source = await checkpointWorktree(store, task.id);
  const reviewer = store.addAgent({
    projectId: binding.projectId,
    parentId: task.managerId,
    taskId: task.id,
    role: 'reviewer',
    name: 'Independent reviewer',
    cwd: path,
  });
  store.updateTask(task.id, {
    status: 'done',
    reviewedCommit: source,
    reviewAgentId: reviewer.id,
    review: 'Independent review approved',
  });
  return { task: store.task(task.id), path, source };
}
async function apply(taskId: string, key = randomUUID()) {
  const result = await adapter.request({ action: 'preview', handle, taskId });
  return {
    input: {
      action: 'apply' as const,
      handle,
      key,
      taskId,
      source: result.preview!.source,
      target: result.preview!.target,
    },
    result,
  };
}
async function remoteAdvance(name: string) {
  const other = join(root, name);
  await git(root, ['clone', origin, other]);
  await git(other, ['config', 'user.name', 'Other member']);
  await git(other, ['config', 'user.email', 'other@example.invalid']);
  writeFileSync(join(other, `${name}.txt`), `${name}\n`);
  await git(other, ['add', `${name}.txt`]);
  await git(other, ['commit', '-m', name]);
  await git(other, ['push', 'origin', 'HEAD:refs/heads/main']);
  return git(other, ['rev-parse', 'HEAD']);
}

it('starts with blank GitHub identity, retains settings, and never accepts browser paths or private scope', async () => {
  expect(await status()).toMatchObject({ githubUsername: '', autoSync: false, workspacePath: cwd });
  const input = {
    action: 'configure',
    handle,
    key: randomUUID(),
    githubUsername: '',
    autoSync: true,
  };
  const configured = await adapter.request(input);
  expect(configured).toMatchObject({ githubUsername: '', autoSync: true });
  expect(await adapter.request(input)).toEqual(configured);
  await expect(adapter.request({ ...input, githubUsername: 'someone-else' })).rejects.toThrow(
    'exact saved',
  );
  await expect(adapter.request({ action: 'status', handle, cwd: '/private' })).rejects.toThrow();
  context = { ...context, visibility: 'private' };
  await expect(status()).rejects.toThrow('shared group conversation');
});

it('Ask preserves files and branches; Work creates an empty member/request branch without staging files', async () => {
  writeFileSync(join(cwd, 'private-note.txt'), 'Never stage this fixture note');
  await work('ask');
  expect(await git(cwd, ['branch', '--show-current'])).toBe('main');
  expect(await git(cwd, ['ls-files'])).toBe('');
  await expect(work()).rejects.toThrow('Finish active shared work');
  expect(readFileSync(join(cwd, 'private-note.txt'), 'utf8')).toContain('Never stage');
  rmSync(join(cwd, 'private-note.txt'));
  const id = await work();
  expect(await git(cwd, ['branch', '--show-current'])).toMatch(
    new RegExp(`^swa/member-[a-f0-9]{12}/work-${id}$`),
  );
  expect(await git(cwd, ['ls-tree', '-r', '--name-only', 'HEAD'])).toBe('');
  expect(await git(cwd, ['ls-remote', 'origin', 'refs/heads/main'])).toBe('');
});

it('pulls only a clean idle default branch and prepares later Work from current shared default while retaining old branches', async () => {
  await seed();
  const first = await remoteAdvance('first');
  runtime.externalControl.add(binding.agentId);
  const initial = await git(cwd, ['rev-parse', 'HEAD']);
  expect((await sync()).busy).toBe(true);
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(initial);
  await expect(work()).rejects.toThrow('Finish active shared work');
  runtime.externalControl.clear();
  await sync();
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(first);
  await work();
  const oldBranch = await git(cwd, ['branch', '--show-current']);
  const second = await remoteAdvance('second');
  await sync();
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(first);
  expect(await git(cwd, ['branch', '--show-current'])).toBe(oldBranch);
  await work();
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(second);
  expect(await git(cwd, ['rev-parse', oldBranch])).toBe(first);
  writeFileSync(join(cwd, 'unfinished.txt'), 'Local unfinished work');
  await remoteAdvance('third');
  await sync();
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(second);
  expect(readFileSync(join(cwd, 'unfinished.txt'), 'utf8')).toBe('Local unfinished work');
});

it('publishes only independently reviewed exact applies, suppresses implicit tags/mirroring, and retains lost acknowledgements', async () => {
  const base = await seed();
  await work();
  const item = await reviewed();
  const { input } = await apply(item.task.id);
  await adapter.request(input);
  // Simulate a response lost after the integration event was committed.
  db.prepare('UPDATE gng_operations SET result=NULL WHERE key=?').run(input.key);
  await adapter.request(input);
  expect(
    store.db.prepare("SELECT count(*) n FROM events WHERE type='task.integrated'").get()!.n,
  ).toBe(1);
  await git(cwd, ['tag', '-a', 'unrequested-tag', '-m', 'Do not publish this tag', item.source]);
  await git(cwd, ['config', 'push.followTags', 'true']);
  await git(cwd, ['config', 'remote.origin.mirror', 'true']);
  expect((await sync()).message).toContain('Reviewed committed work shared');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'refs/heads/main'])).toBe(item.source);
  expect(await git(root, ['--git-dir', origin, 'tag', '--list'])).toBe('');
  expect(
    await git(root, [
      '--git-dir',
      origin,
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads/dock',
    ]),
  ).toBe('');
  expect(base).not.toBe(item.source);
});

it('recovers the crash gap after an authorized Git apply and refuses stale previews or unreviewed direct commits', async () => {
  await seed();
  await work();
  const item = await reviewed();
  const { input, result } = await apply(item.task.id);
  // Saved exact authorization, then Git completed before task/event acknowledgement.
  db.prepare('INSERT INTO gng_operations VALUES (?,?,NULL)').run(
    input.key,
    JSON.stringify(groupNativeGitRequestSchema.parse(input)),
  );
  db.prepare('INSERT INTO gng_applies VALUES (?,?)').run(input.key, JSON.stringify(result.preview));
  await git(cwd, ['merge', '--ff-only', item.source]);
  await adapter.request(input);
  expect(store.task(item.task.id).status).toBe('integrated');
  expect(
    store.db.prepare("SELECT count(*) n FROM events WHERE type='task.integrated'").get()!.n,
  ).toBe(1);
  const other = await reviewed('later');
  const stale = await integrationPreview(store, other.task.id);
  writeFileSync(join(cwd, 'unreviewed.txt'), 'Direct unreviewed change\n');
  await git(cwd, ['add', 'unreviewed.txt']);
  await git(cwd, ['commit', '-m', 'Unreviewed direct change']);
  await expect(
    adapter.request({
      action: 'apply',
      handle,
      key: randomUUID(),
      taskId: other.task.id,
      source: stale.source,
      target: stale.target,
    }),
  ).rejects.toThrow('preview changed');
  expect((await sync()).message).toContain('await independent task review');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'refs/heads/main'])).not.toBe(
    await git(cwd, ['rev-parse', 'HEAD']),
  );
});

it('shares a reviewed divergent work branch without replacing default or discarding either member’s work', async () => {
  await seed();
  await work();
  const branch = await git(cwd, ['branch', '--show-current']);
  const item = await reviewed();
  await adapter.request((await apply(item.task.id)).input);
  const remote = await remoteAdvance('other-member');
  expect((await sync()).message).toContain('default branch advanced separately');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'refs/heads/main'])).toBe(remote);
  expect(await git(root, ['--git-dir', origin, 'rev-parse', `refs/heads/${branch}`])).toBe(
    item.source,
  );
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(item.source);
  await expect(work()).rejects.toThrow('unpublished or divergent');
});

it('rejects a separate push destination and refuses credentials even when later removed from history', async () => {
  await seed();
  const foreign = join(root, 'foreign.git');
  await git(root, ['init', '--bare', foreign]);
  await git(cwd, ['remote', 'set-url', '--push', 'origin', foreign]);
  await expect(sync()).rejects.toThrow('fetch and push destinations differ');
  await git(cwd, ['config', '--unset-all', 'remote.origin.pushurl']);
  await work();
  const item = await reviewed();
  writeFileSync(join(item.path, 'notes.txt'), `ghp_${'a'.repeat(36)}\n`);
  await git(item.path, ['add', 'notes.txt']);
  await git(item.path, ['commit', '-m', 'Bad checkpoint']);
  rmSync(join(item.path, 'notes.txt'));
  await git(item.path, ['add', '-u']);
  await git(item.path, ['commit', '-m', 'Remove bad checkpoint']);
  const head = await git(item.path, ['rev-parse', 'HEAD']);
  store.updateTask(item.task.id, { reviewedCommit: head });
  await adapter.request((await apply(item.task.id)).input);
  await expect(sync()).rejects.toThrow('likely credential');
  expect(await git(root, ['--git-dir', origin, 'ls-tree', '-r', '--name-only', 'main'])).toBe('');
});
