import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const completions = new Set<string>();
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
    localVisible: () => true,
    authenticatedContext: async ({ handle: selected }: { handle: string }) => {
      if (selected !== handle) throw new Error('Unknown saved member');
      return { context, enrollmentHandle: binding.enrollmentHandle, revalidate: async () => {} };
    },
    nativeFeatureContext: async () => ({ handle, revalidate: async () => {} }),
  } as unknown as GroupHost;
  runtime = { store, dataDir: root, externalControl: new Set<string>() } as Runtime;
  requests.clear();
  completions.clear();
  const connector = {
    resolveLocalContext: () => binding,
    context: (id: string) => requests.get(id) ?? null,
    completionPending: () => false,
    inspect: async ({ requestId }: { requestId: string }) => ({
      requestId,
      state: completions.has(requestId) ? 'completed' : 'blocked',
      message: 'Exact fixture completion',
      result: { context: requests.get(requestId)?.context },
    }),
  } as unknown as GroupHostNativeRuntime;
  adapter = new GroupHostNativeGit(host, runtime, connector, true);
});
afterEach(async () => {
  await adapter?.close();
  if (db?.isOpen) db.close();
  if (store?.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const sync = () => adapter.request({ action: 'sync', handle, key: randomUUID() });
const status = () => adapter.request({ action: 'status', handle });
async function chosenAdapter(verify = vi.fn(async () => {})) {
  await adapter.close();
  binding = { ...binding, workspaceChoiceKey: randomUUID() };
  const connector = {
    workspaceScope: () => binding,
    context: (id: string) => requests.get(id) ?? null,
    completionPending: () => false,
    inspect: async ({ requestId }: { requestId: string }) => ({
      requestId,
      state: completions.has(requestId) ? 'completed' : 'blocked',
      message: 'Exact fixture completion',
      result: { context: requests.get(requestId)?.context },
    }),
  } as unknown as GroupHostNativeRuntime;
  adapter = new GroupHostNativeGit(host, runtime, connector, true, verify);
  return verify;
}
it('turns sync on only after a new verified connection, retains explicit Off and fences exact retries to their original folder', async () => {
  await seed();
  const verify = await chosenAdapter();
  expect(await status()).toMatchObject({ autoSync: false, connected: false });
  const connect = { action: 'connect' as const, handle, key: randomUUID() };
  const first = await adapter.request(connect);
  expect(first).toMatchObject({ autoSync: true, connected: true });
  expect(await adapter.request(connect)).toEqual(first);
  expect(verify).toHaveBeenCalledTimes(1);
  const retained = Number(db.prepare('SELECT count(*) n FROM gng_operations').get()!.n);
  const automatic = adapter as unknown as { pass(): Promise<void>; last: Map<string, number> };
  for (let poll = 0; poll < 5; poll++) {
    automatic.last.clear();
    await automatic.pass();
  }
  expect(Number(db.prepare('SELECT count(*) n FROM gng_operations').get()!.n)).toBe(retained);
  expect(store.runs()).toEqual([]);
  await adapter.request({
    action: 'configure',
    handle,
    key: randomUUID(),
    githubUsername: '',
    autoSync: false,
  });
  await adapter.request({ ...connect, key: randomUUID() });
  expect(await status()).toMatchObject({ autoSync: false, connected: true });
  const oldChoice = binding.workspaceChoiceKey;
  binding = { ...binding, workspaceChoiceKey: randomUUID() };
  expect(await status()).toMatchObject({ autoSync: false, connected: false });
  expect(await adapter.request(connect)).toEqual(first);
  expect(
    db
      .prepare('SELECT count(*) n FROM gng_connections WHERE scope_key=?')
      .get(binding.workspaceChoiceKey!)!.n,
  ).toBe(0);
  const pending = { ...connect, key: randomUUID() };
  db.prepare('INSERT INTO gng_operations VALUES(?,?,NULL)').run(
    pending.key,
    JSON.stringify({ ...pending, workspaceChoiceKey: oldChoice }),
  );
  await expect(adapter.request(pending)).rejects.toThrow('original shared folder');
  expect(verify).toHaveBeenCalledTimes(2);
  await adapter.request({ ...connect, key: randomUUID() });
  expect(await status()).toMatchObject({ autoSync: false, connected: true });
});

it('verifies only the intended private GitHub repo through bounded native metadata and exposes no command or credential output', async () => {
  const bin = join(root, 'fixture-bin');
  mkdirSync(bin);
  const metadata = join(root, 'metadata.json');
  const argumentsFile = join(root, 'arguments.json');
  const script = join(bin, 'gh');
  writeFileSync(
    script,
    `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify(process.argv.slice(2))); process.stdout.write(fs.readFileSync(${JSON.stringify(metadata)}, 'utf8'));\n`,
  );
  chmodSync(script, 0o700);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  const verify = (
    adapter as unknown as { privateAccess(cwd: string, origin: string): Promise<void> }
  ).privateAccess.bind(adapter);
  const origin = 'git@github.com:fixture-owner/research.git';
  writeFileSync(
    metadata,
    JSON.stringify({
      nameWithOwner: 'fixture-owner/research',
      isPrivate: true,
      viewerPermission: 'WRITE',
    }),
  );
  await verify(cwd, origin);
  expect(JSON.parse(readFileSync(argumentsFile, 'utf8'))).toEqual([
    'repo',
    'view',
    'https://github.com/fixture-owner/research',
    '--json',
    'nameWithOwner,isPrivate,viewerPermission',
  ]);
  for (const invalid of [
    { nameWithOwner: 'fixture-owner/research', isPrivate: false, viewerPermission: 'WRITE' },
    { nameWithOwner: 'other/research', isPrivate: true, viewerPermission: 'WRITE' },
    { nameWithOwner: 'fixture-owner/research', isPrivate: true, viewerPermission: 'UNKNOWN' },
  ]) {
    writeFileSync(metadata, JSON.stringify(invalid));
    await expect(verify(cwd, origin)).rejects.toThrow('Verify native GitHub sign-in');
  }
  writeFileSync(metadata, 'PRIVATE_FIXTURE_DO_NOT_RETURN'.repeat(1000));
  await expect(verify(cwd, origin)).rejects.toThrow('Verify native GitHub sign-in');
  await expect(verify(cwd, 'https://arbitrary.invalid/repository')).rejects.toThrow(
    'intended private GitHub',
  );
});
it('local removal pauses the automatic Git pass before polling the group or remote', async () => {
  await seed();
  await adapter.request({
    action: 'configure',
    handle,
    key: randomUUID(),
    githubUsername: '',
    autoSync: true,
  });
  vi.spyOn(host, 'localVisible').mockReturnValue(false);
  const resolve = vi.spyOn(host, 'authenticatedContext');
  await (adapter as unknown as { pass(): Promise<void> }).pass();
  expect(resolve).not.toHaveBeenCalled();
  expect((await status()).autoSync).toBe(true); // Saved choice stays intact for restore.
});
it('owner status shows unfinished group/task edits without returning contents or sharing private names', async () => {
  await seed();
  writeFileSync(join(cwd, 'unfinished.txt'), 'local draft');
  writeFileSync(join(cwd, '.env'), 'PRIVATE_FIXTURE');
  const task = store.addTask(binding.projectId, {
    title: 'Pending task',
    goal: 'Work',
    acceptance: 'Review',
    parentId: null,
  });
  const taskPath = await ensureWorktree(store, task, root);
  writeFileSync(join(taskPath, 'worker.txt'), 'worker draft');
  const view = await status();
  expect(view.localEdits).toMatchObject([
    {
      taskId: null,
      state: 'changed',
      changed: 2,
      withheld: 1,
      files: [{ path: 'unfinished.txt', status: '??' }],
    },
    { taskId: task.id, state: 'changed', files: [{ path: 'worker.txt', status: '??' }] },
  ]);
  expect(JSON.stringify(view.localEdits)).not.toContain('PRIVATE_FIXTURE');
  expect(JSON.stringify(view.localEdits)).not.toContain('.env');
  expect(await git(cwd, ['ls-files', '--', 'unfinished.txt'])).toBe('');
  expect(readFileSync(join(taskPath, 'worker.txt'), 'utf8')).toBe('worker draft');
});
it('shows external project dataset names in root and task status while withholding credentials and databases', async () => {
  const appData = join(root, 'private-app-data');
  mkdirSync(appData);
  (runtime as unknown as { dataDir: string }).dataDir = appData;
  await seed();
  await chosenAdapter();
  mkdirSync(join(cwd, 'data'));
  writeFileSync(join(cwd, 'data/measurements.csv'), 'initial measurement\n');
  await git(cwd, ['add', 'data/measurements.csv']);
  await git(cwd, ['commit', '-m', 'Track scientific dataset']);
  const task = store.addTask(binding.projectId, {
    title: 'Dataset analysis',
    goal: 'Analyze measurements',
    acceptance: 'Reviewed outcome',
    parentId: null,
  });
  const taskPath = await ensureWorktree(store, task, appData);
  for (const workspace of [cwd, taskPath]) {
    writeFileSync(join(workspace, 'data/measurements.csv'), 'PRIVATE_DATASET_CONTENT_FIXTURE\n');
    writeFileSync(join(workspace, '.env'), 'PRIVATE_CREDENTIAL_CONTENT_FIXTURE');
    writeFileSync(join(workspace, 'conversation.sqlite'), 'PRIVATE_DATABASE_CONTENT_FIXTURE');
  }
  const view = await status();
  for (const taskId of [null, task.id]) {
    const row = view.localEdits.find((item) => item.taskId === taskId)!;
    expect(row).toMatchObject({
      state: 'changed',
      changed: 3,
      withheld: 2,
      files: [{ path: 'data/measurements.csv', status: ' M' }],
    });
  }
  const body = JSON.stringify(view.localEdits);
  expect(body).not.toContain('PRIVATE_');
  expect(body).not.toContain('.env');
  expect(body).not.toContain('conversation.sqlite');
  // Reclassifying this checkout as app-owned storage restores the strict data policy.
  (runtime as unknown as { dataDir: string }).dataDir = root;
  const legacy = await status();
  for (const row of legacy.localEdits)
    expect(row).toMatchObject({ changed: 3, withheld: 3, files: [] });
});

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

it.each([
  'unowned',
  'missing-request',
  'failed',
  'uncertain',
  'dirty',
  'active',
  'queued-child',
  'unpublished',
  'divergent-default',
  'pending-git',
  'late-active',
] as const)(
  'preserves current branch and files when completed-work return-to-default proof is %s',
  async (disposition) => {
    await seed();
    const requestId = await work();
    const original = await git(cwd, ['branch', '--show-current']);
    const run = store.enqueue(binding.agentId, requestId, 'Exact saved Work');
    requests.set(requestId, { ...binding, runId: run.id, intent: 'work' });
    store.updateRun(run.id, { status: 'completed' });
    store.updateAgent(binding.agentId, { status: 'idle' });
    completions.add(requestId);
    (adapter as unknown as { starting: Map<string, unknown> }).starting.clear();
    if (disposition === 'unowned') await git(cwd, ['checkout', '-b', 'owner-topic']);
    if (disposition === 'missing-request') requests.delete(requestId);
    if (disposition === 'failed') store.updateRun(run.id, { status: 'failed' });
    if (disposition === 'uncertain') completions.delete(requestId);
    if (disposition === 'dirty')
      writeFileSync(join(cwd, 'unfinished.txt'), 'Unfinished owner work');
    if (disposition === 'active') runtime.externalControl.add(binding.agentId);
    if (disposition === 'queued-child') {
      const child = store.addAgent({
        projectId: binding.projectId,
        parentId: binding.agentId,
        taskId: null,
        name: 'Retained queued child',
        role: 'researcher',
        cwd,
      });
      store.enqueue(child.id, randomUUID(), 'Retained child input');
    }
    if (disposition === 'unpublished') {
      writeFileSync(join(cwd, 'unpublished.txt'), 'Owner checkpoint');
      await git(cwd, ['add', 'unpublished.txt']);
      await git(cwd, ['commit', '-m', 'Unpublished owner checkpoint']);
    }
    if (disposition === 'divergent-default') {
      await git(cwd, ['checkout', 'main']);
      writeFileSync(join(cwd, 'default-only.txt'), 'Retained local default branch checkpoint');
      await git(cwd, ['add', 'default-only.txt']);
      await git(cwd, ['commit', '-m', 'Local default checkpoint']);
      await git(cwd, ['checkout', original]);
    }
    if (disposition === 'pending-git') {
      const key = randomUUID();
      db.prepare('INSERT INTO gng_operations VALUES(?,?,NULL)').run(
        key,
        JSON.stringify({ action: 'apply', handle, key, source: randomUUID() }),
      );
    }
    if (disposition === 'late-active') {
      let validations = 0;
      host.authenticatedContext = async () =>
        ({
          context,
          enrollmentHandle: binding.enrollmentHandle,
          revalidate: async () => {
            if (++validations === 2) runtime.externalControl.add(binding.agentId);
          },
        }) as Awaited<ReturnType<GroupHost['authenticatedContext']>>;
    }
    const head = await git(cwd, ['rev-parse', 'HEAD']);
    const branch = await git(cwd, ['branch', '--show-current']);
    await remoteAdvance('incoming-after-work');
    await sync();
    expect(await git(cwd, ['branch', '--show-current'])).toBe(branch);
    expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(cwd, ['rev-parse', original])).toBe(head);
    expect(await git(cwd, ['ls-files', '--', 'incoming-after-work.txt'])).toBe('');
    if (disposition === 'dirty')
      expect(readFileSync(join(cwd, 'unfinished.txt'), 'utf8')).toContain('Unfinished owner');
    expect(store.run(run.id).key).toBe(requestId);
  },
);

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
it('syncs reviewed scientific data and a large figure from an outside project to another checkout', async () => {
  const privateRuntime = join(root, 'private-runtime');
  mkdirSync(privateRuntime);
  Object.defineProperty(runtime, 'dataDir', { value: privateRuntime });
  await seed();
  await work();
  const item = await reviewed('Scientific files');
  mkdirSync(join(item.path, 'data'));
  writeFileSync(join(item.path, 'data', 'measurements.csv'), 'energy,count\n1,42\n');
  const figure = Buffer.alloc(5 * 1024 ** 2, 0x41);
  figure[0] = 0;
  writeFileSync(join(item.path, 'figure.bin'), figure);
  await git(item.path, ['add', 'data/measurements.csv', 'figure.bin']);
  await git(item.path, ['commit', '-m', 'Reviewed scientific data and figure']);
  const head = await git(item.path, ['rev-parse', 'HEAD']);
  store.updateTask(item.task.id, { reviewedCommit: head });
  await adapter.request((await apply(item.task.id)).input);
  expect((await sync()).message).toContain('Reviewed committed work shared');
  const other = join(root, 'reader');
  await git(root, ['clone', origin, other]);
  expect(readFileSync(join(other, 'data', 'measurements.csv'), 'utf8')).toBe(
    'energy,count\n1,42\n',
  );
  const received = readFileSync(join(other, 'figure.bin'));
  expect(received.length).toBe(figure.length);
  expect(createHash('sha256').update(received).digest('hex')).toBe(
    createHash('sha256').update(figure).digest('hex'),
  );
});
it('local task repository without a remote keeps optional GitHub setup available', async () => {
  await git(cwd, ['remote', 'remove', 'origin']);
  const view = await adapter.request({ action: 'status', handle });
  expect(view.available).toBe(false);
});

it.each(['data/runtime-canary.txt', 'nested/data/runtime-canary.txt', '.env', 'notes.sqlite'])(
  'native Git still refuses the private/runtime path %s',
  async (name) => {
    await seed();
    await work();
    const item = await reviewed();
    mkdirSync(join(item.path, name, '..'), { recursive: true });
    writeFileSync(join(item.path, name), 'Private runtime canary');
    await git(item.path, ['add', name]);
    await git(item.path, ['commit', '-m', 'Private path checkpoint']);
    const head = await git(item.path, ['rev-parse', 'HEAD']);
    store.updateTask(item.task.id, { reviewedCommit: head });
    await adapter.request((await apply(item.task.id)).input);
    await expect(sync()).rejects.toThrow('likely private or runtime file');
    expect(await git(root, ['--git-dir', origin, 'ls-tree', '-r', '--name-only', 'main'])).toBe('');
  },
);
