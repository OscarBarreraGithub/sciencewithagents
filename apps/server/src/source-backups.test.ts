import { modelFixture } from './model-policy.fixture.js';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { Store, type PrivateTask } from './store.js';
import { SourceBackups, sourceBackupStatus, type BackupTransport } from './source-backups.js';
import { git } from './workspaces.js';
import { Runtime } from './runtime.js';
import { repoRoot } from './paths.js';
import { createServer } from './server.js';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SourceBackupSetup, type BackupSetupTransport } from './source-backup-setup.js';

let root: string, local: string, remote: string, store: Store, projectId: string, base: string;
let backups: SourceBackups | undefined, task: PrivateTask;
let isPrivate: boolean, push: ReturnType<typeof vi.fn>, transport: BackupTransport;
const config = () => [{ projectId, repository: 'fixture/private', branch: 'main' }];
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/backups-'));
  local = join(root, 'project');
  remote = join(root, 'remote.git');
  mkdirSync(local);
  await git(local, ['init', '--initial-branch=main']);
  await git(local, ['config', 'user.name', 'Fixture']);
  await git(local, ['config', 'user.email', 'fixture@localhost']);
  await git(local, ['commit', '--allow-empty', '-m', 'Start']);
  base = await git(local, ['rev-parse', 'HEAD']);
  await git(root, ['init', '--bare', remote]);
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  projectId = store.register(local, 'Fixture', '').id;
  task = store.addTask(projectId, {
    title: 'Save a file',
    goal: 'Save source',
    acceptance: 'Reviewed',
    parentId: null,
  });
  const reviewer = store.addAgent({
    projectId,
    taskId: task.id,
    parentId: store.project(projectId).managerId,
    role: 'reviewer',
    name: 'Review',
    cwd: local,
  });
  writeFileSync(join(local, 'hello.txt'), 'Useful source\n');
  await git(local, ['add', 'hello.txt']);
  await git(local, ['commit', '-m', 'Verified source']);
  task = store.updateTask(task.id, {
    status: 'done',
    worktree: local,
    baseCommit: base,
    reviewedCommit: await git(local, ['rev-parse', 'HEAD']),
    review: 'approve',
    reviewAgentId: reviewer.id,
  });
  isPrivate = true;
  push = vi.fn(async (cwd: string, _repo: string, ref: string, commit: string) => {
    await git(cwd, ['push', remote, `${commit}:${ref}`]);
  });
  transport = {
    privateRepository: async () => isPrivate,
    head: async (cwd, _repo, ref) =>
      (await git(cwd, ['ls-remote', '--heads', remote, ref])).split(/\s+/)[0] || null,
    push,
  };
});
afterEach(async () => {
  await backups?.close();
  backups = undefined;
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it('is opt-in, leaves unreviewed work alone and survives invalid configuration', async () => {
  backups = new SourceBackups(store, root, transport, []);
  backups.start();
  await backups.idle();
  expect(push).not.toHaveBeenCalled();
  expect(sourceBackupStatus(store, projectId).configured).toBe(false);
  await backups.close();
  backups = new SourceBackups(store, root, transport, [
    { projectId, repository: 'https://evil.test/repo' },
  ]);
  backups.start();
  await backups.idle();
  expect(sourceBackupStatus(store, projectId).state).toBe('needs_attention');
  expect(push).not.toHaveBeenCalled();
  await backups.close();
  store.updateTask(task.id, { status: 'working' });
  backups = new SourceBackups(store, root, transport, config());
  backups.start();
  await backups.idle();
  expect(push).not.toHaveBeenCalled();
});

it('backs up a reviewed task branch, then its exact integrated commit, without altering the worktree', async () => {
  backups = new SourceBackups(store, root, transport, config());
  backups.start();
  await backups.idle();
  const ref = `refs/heads/agent-dock/task-${task.id}`;
  expect(await transport.head(local, 'fixture/private', ref, new AbortController().signal)).toBe(
    task.reviewedCommit,
  );
  expect(sourceBackupStatus(store, projectId)).toMatchObject({
    state: 'saved',
    commit: task.reviewedCommit,
  });
  expect(await git(local, ['status', '--porcelain'])).toBe('');
  backups.start();
  await backups.idle();
  expect(push).toHaveBeenCalledTimes(1);
  store.updateTask(task.id, { status: 'integrated' });
  await new Promise((resolve) => setImmediate(resolve));
  await backups.idle();
  expect(
    await transport.head(local, 'fixture/private', 'refs/heads/main', new AbortController().signal),
  ).toBe(task.reviewedCommit);
  expect(push).toHaveBeenCalledTimes(2);
  const runtime = new Runtime(store, root, 'codex');
  const context = JSON.parse(
    runtime
      .context(store.agent(store.project(projectId).managerId))
      .split('\n')
      .slice(1)
      .join('\n'),
  );
  expect(context.sourceBackup).toMatchObject({ state: 'saved', configured: true });
});

it('refuses public destinations before exporting source', async () => {
  isPrivate = false;
  backups = new SourceBackups(store, root, transport, config());
  backups.start();
  await backups.idle();
  expect(push).not.toHaveBeenCalled();
  expect(sourceBackupStatus(store, projectId).message).toContain('not private');
});

it('shows backup status in the API and does not repeat a submitted retry key', async () => {
  backups = new SourceBackups(store, root, transport, config());
  const retry = vi.spyOn(backups, 'retry').mockImplementation(() => {});
  const runtime = new Runtime(store, root, 'codex');
  const app = await createServer(store, runtime, { port: 4338, backups, ownsRuntime: false });
  try {
    const headers = {
      host: '127.0.0.1:4338',
      origin: 'http://127.0.0.1:4338',
      'content-type': 'application/json',
    };
    const snapshot = await app.inject({ url: '/api/snapshot', headers });
    expect(snapshot.json().backups).toContainEqual(
      expect.objectContaining({ projectId, configured: true, state: 'waiting' }),
    );
    const payload = { key: randomUUID() };
    const url = `/api/projects/${projectId}/backup/retry`;
    for (let i = 0; i < 2; i++)
      expect((await app.inject({ method: 'POST', url, headers, payload })).json()).toEqual({
        queued: true,
      });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...payload, path: '/untrusted' },
        })
      ).statusCode,
    ).toBe(400);
    expect(retry).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

it('checks earlier commits too, so deleting a runtime file does not leak its old blob', async () => {
  writeFileSync(join(local, '.env'), 'PRIVATE_DATA=fixture\n');
  await git(local, ['add', '.env']);
  await git(local, ['commit', '-m', 'Mistaken file']);
  await git(local, ['rm', '.env']);
  await git(local, ['commit', '-m', 'Remove mistaken file']);
  store.updateTask(task.id, { reviewedCommit: await git(local, ['rev-parse', 'HEAD']) });
  backups = new SourceBackups(store, root, transport, config());
  backups.start();
  await backups.idle();
  expect(push).not.toHaveBeenCalled();
  expect(sourceBackupStatus(store, projectId).message).toContain('private or runtime file');
  expect(JSON.stringify(store.events())).not.toContain('PRIVATE_DATA');
});

it('backs up ordinary research data, logs, uploads and databases without treating them as app runtime', async () => {
  for (const directory of ['data', 'logs', 'uploads']) mkdirSync(join(local, directory));
  writeFileSync(join(local, 'data/observations.csv'), 'time,value\n1,2\n');
  writeFileSync(join(local, 'logs/fit.log'), 'Fit converged\n');
  writeFileSync(join(local, 'uploads/measurements.txt'), 'Public research fixture\n');
  const measurements = new DatabaseSync(join(local, 'data/measurements.sqlite'));
  measurements.exec('CREATE TABLE observations (value REAL); INSERT INTO observations VALUES (2)');
  measurements.close();
  await git(local, ['add', '.']);
  await git(local, ['commit', '-m', 'Research inputs']);
  const commit = await git(local, ['rev-parse', 'HEAD']);
  store.updateTask(task.id, { reviewedCommit: commit });
  backups = new SourceBackups(store, root, transport, config());
  backups.start();
  await backups.idle();
  expect(sourceBackupStatus(store, projectId)).toMatchObject({ state: 'saved', commit });
  expect(push).toHaveBeenCalledTimes(1);
  expect(await git(local, ['status', '--porcelain'])).toBe('');
});

it('counts unchanged file versions once across a long history', async () => {
  const source = join(local, 'research');
  mkdirSync(source);
  for (let n = 0; n < 2100; n++) writeFileSync(join(source, `${n}.txt`), 'Research reference\n');
  await git(local, ['add', '.']);
  await git(local, ['commit', '-m', 'Research references']);
  for (let n = 0; n < 10; n++)
    await git(local, ['commit', '--allow-empty', '-m', `Milestone ${n}`]);
  store.updateTask(task.id, { reviewedCommit: await git(local, ['rev-parse', 'HEAD']) });
  backups = new SourceBackups(store, root, transport, config());
  backups.start();
  await backups.idle();
  expect(sourceBackupStatus(store, projectId).state).toBe('saved');
  expect(push).toHaveBeenCalledTimes(1);
});

it('refuses the actual private runtime inside a project, even after its file was deleted', async () => {
  const runtimeDir = join(local, 'private-runtime');
  mkdirSync(runtimeDir);
  writeFileSync(join(runtimeDir, 'ordinary.txt'), 'Retained private fixture content\n');
  await git(local, ['add', '.']);
  await git(local, ['commit', '-m', 'Mistaken runtime content']);
  await git(local, ['rm', 'private-runtime/ordinary.txt']);
  await git(local, ['commit', '-m', 'Removed runtime content']);
  mkdirSync(runtimeDir, { recursive: true });
  store.updateTask(task.id, { reviewedCommit: await git(local, ['rev-parse', 'HEAD']) });
  backups = new SourceBackups(store, runtimeDir, transport, config());
  backups.start();
  await backups.idle();
  expect(push).not.toHaveBeenCalled();
  expect(sourceBackupStatus(store, projectId).message).toContain('private or runtime file');
  expect(JSON.stringify(store.events())).not.toContain('Retained private fixture content');
});

it('still checks sensitive aliases and credential content in allowed research paths', async () => {
  // The same blob already exists under an ordinary filename.
  await git(local, ['mv', 'hello.txt', '.env']);
  await git(local, ['commit', '-m', 'Sensitive alias']);
  await git(local, ['rm', '.env']);
  await git(local, ['commit', '-m', 'Removed alias']);
  store.updateTask(task.id, { reviewedCommit: await git(local, ['rev-parse', 'HEAD']) });
  backups = new SourceBackups(store, root, transport, config());
  backups.start();
  await backups.idle();
  expect(push).not.toHaveBeenCalled();
  expect(sourceBackupStatus(store, projectId).message).toContain('private or runtime file');
  await backups.close();
  // Exclude the already-inspected history as if present remotely; the new content
  // still needs a scan even when its filename is a legitimate research log.
  await git(local, ['push', remote, 'HEAD:refs/heads/main']);
  writeFileSync(join(local, 'experiment.log'), `ghp_${'x'.repeat(36)}\n`);
  await git(local, ['add', 'experiment.log']);
  await git(local, ['commit', '-m', 'Mistaken credential']);
  store.updateTask(task.id, { reviewedCommit: await git(local, ['rev-parse', 'HEAD']) });
  backups = new SourceBackups(store, root, transport, config());
  backups.start();
  await backups.idle();
  expect(push).not.toHaveBeenCalled();
  expect(sourceBackupStatus(store, projectId).message).toContain('possible credential');
  expect(JSON.stringify(store.events())).not.toContain('ghp_');
});

it('reconciles an uncertain push from the remote instead of sending it twice', async () => {
  const realPush = transport.push;
  transport.push = vi.fn(async (...args: Parameters<BackupTransport['push']>) => {
    await realPush(...args);
    throw new Error('lost response');
  });
  backups = new SourceBackups(store, root, transport, config());
  backups.start();
  await backups.idle();
  expect(sourceBackupStatus(store, projectId).state).toBe('needs_attention');
  await backups.close();
  backups = new SourceBackups(store, root, transport, config());
  backups.start();
  await backups.idle();
  expect(transport.push).toHaveBeenCalledTimes(1);
  expect(sourceBackupStatus(store, projectId).state).toBe('saved');
});

it('never force-pushes a divergent branch and retains dirty owner files', async () => {
  const other = join(root, 'other');
  mkdirSync(other);
  await git(other, ['init', '--initial-branch=main']);
  await git(other, [
    '-c',
    'user.name=Other',
    '-c',
    'user.email=other@localhost',
    'commit',
    '--allow-empty',
    '-m',
    'Unrelated history',
  ]);
  const otherCommit = await git(other, ['rev-parse', 'HEAD']);
  const ref = `refs/heads/agent-dock/task-${task.id}`;
  await git(other, ['push', remote, `HEAD:${ref}`]);
  writeFileSync(join(local, 'unsaved.txt'), 'Owner work stays here\n');
  backups = new SourceBackups(store, root, transport, config());
  backups.start();
  await backups.idle();
  expect(sourceBackupStatus(store, projectId).state).toBe('needs_attention');
  expect(await transport.head(local, 'fixture/private', ref, new AbortController().signal)).toBe(
    otherCommit,
  );
  expect(await git(local, ['status', '--porcelain'])).toContain('unsaved.txt');
});

it('keeps failed backups visible even if another task is backed up successfully', async () => {
  const other = store.addTask(projectId, {
    title: 'Other',
    goal: 'Same commit',
    acceptance: 'Reviewed',
    parentId: null,
  });
  store.updateTask(other.id, { ...task, id: other.id });
  const realPush = transport.push;
  transport.push = vi.fn(async (...args: Parameters<BackupTransport['push']>) => {
    if (args[2].endsWith(task.id)) throw new Error('fixture offline');
    await realPush(...args);
  });
  backups = new SourceBackups(store, root, transport, config());
  backups.start();
  await backups.idle();
  expect(sourceBackupStatus(store, projectId).state).toBe('needs_attention');
  expect(sourceBackupStatus(store, projectId).message).toContain('still need attention');
});

function setupFixture() {
  let account = { id: 7, login: 'fixture' };
  const repos = new Map<
    string,
    NonNullable<Awaited<ReturnType<BackupSetupTransport['repository']>>>
  >();
  const metadata = (name: string, description = '') => ({
    id: 42,
    full_name: name,
    private: true,
    archived: false,
    disabled: false,
    permissions: { push: true },
    default_branch: 'main',
    description,
  });
  const create = vi.fn(async (name: string, description: string) => {
    repos.set(name, metadata(name, description));
  });
  const github: BackupSetupTransport = {
    account: async () => account,
    repository: async (name) => repos.get(name) ?? null,
    create,
  };
  backups = new SourceBackups(store, root, transport);
  return {
    setup: new SourceBackupSetup(backups, github),
    repos,
    create,
    metadata,
    github,
    setAccount: (next: typeof account) => {
      account = next;
    },
  };
}

it('previews without export, connects once, and uses the existing reviewed-checkpoint queue after restart', async () => {
  const f = setupFixture();
  const preview = (await f.setup.preview(projectId, { choice: 'create' })).preview!;
  expect(preview.repository).toMatch(/^fixture\/fixture-/);
  expect(f.create).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  expect(existsSync(join(root, 'source-backups.json'))).toBe(false);
  const input = { key: preview.id, previewId: preview.id, confirm: true };
  await expect(f.setup.connect(projectId, { ...input, confirm: false })).rejects.toThrow();
  await f.setup.connect(projectId, input);
  await backups!.idle();
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(push).toHaveBeenCalledTimes(1);
  expect(sourceBackupStatus(store, projectId).state).toBe('saved');
  expect(statSync(join(root, 'source-backups.json')).mode & 0o777).toBe(0o600);
  const saved = readFileSync(join(root, 'source-backups.json'), 'utf8');
  await backups!.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  backups = new SourceBackups(store, root, transport);
  const restored = new SourceBackupSetup(backups, f.github);
  expect((await restored.connect(projectId, input)).destination?.repository).toBe(
    preview.repository,
  );
  backups.start();
  await backups.idle();
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(push).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(root, 'source-backups.json'), 'utf8')).toBe(saved);
});

it('reconciles a lost GitHub creation acknowledgement at the exact saved address', async () => {
  const f = setupFixture();
  f.create.mockImplementationOnce(async (name, description) => {
    f.repos.set(name, f.metadata(name, description));
    throw Error('Lost acknowledgement, private stderr must not escape');
  });
  const preview = (await f.setup.preview(projectId, { choice: 'create' })).preview!;
  await f.setup.connect(projectId, { key: preview.id, previewId: preview.id, confirm: true });
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.setup.status(projectId).destination?.repository).toBe(preview.repository);
});

it('retries a failed creation only at its original unique address and refuses another preview', async () => {
  const f = setupFixture();
  f.create.mockRejectedValueOnce(Error('offline'));
  const preview = (await f.setup.preview(projectId, { choice: 'create' })).preview!;
  const input = { key: preview.id, previewId: preview.id, confirm: true };
  await expect(f.setup.connect(projectId, input)).rejects.toThrow('could not be confirmed');
  expect(push).not.toHaveBeenCalled();
  expect(f.setup.status(projectId).preview?.attempted).toBe(true);
  await expect(f.setup.preview(projectId, { choice: 'create' })).rejects.toThrow(
    'awaiting confirmation',
  );
  await f.setup.connect(projectId, input);
  expect(f.create).toHaveBeenCalledTimes(2);
  expect(f.create.mock.calls[0]).toEqual(f.create.mock.calls[1]);
  expect(f.repos.size).toBe(1);
});

it('rejects changed account, repository identity, access, branch, expiry and public destinations before export', async () => {
  const f = setupFixture();
  const name = 'fixture/existing';
  f.repos.set(name, { ...f.metadata(name), private: false });
  await expect(
    f.setup.preview(projectId, { choice: 'existing', repository: name }),
  ).rejects.toThrow('private');
  f.repos.set(name, f.metadata(name));
  const preview = (await f.setup.preview(projectId, { choice: 'existing', repository: name }))
    .preview!;
  const input = { key: preview.id, previewId: preview.id, confirm: true };
  f.setAccount({ id: 8, login: 'other' });
  await expect(f.setup.connect(projectId, input)).rejects.toThrow('account changed');
  f.setAccount({ id: 7, login: 'fixture' });
  f.repos.set(name, { ...f.metadata(name), id: 99 });
  await expect(f.setup.connect(projectId, input)).rejects.toThrow('changed after preview');
  f.repos.set(name, { ...f.metadata(name), default_branch: 'different' });
  await expect(f.setup.connect(projectId, input)).rejects.toThrow('changed after preview');
  f.repos.set(name, { ...f.metadata(name), permissions: { push: false } });
  await expect(f.setup.connect(projectId, input)).rejects.toThrow('writable');
  f.repos.set(name, f.metadata(name));
  const expired = new SourceBackupSetup(backups!, f.github, () => Date.now() + 700_000);
  // Earlier invalid confirmations must not extend this preview's lifetime.
  await expect(expired.connect(projectId, input)).rejects.toThrow('expired');
  expect(f.create).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

it('retains other destinations and rejects stale keys and external configuration changes', async () => {
  const other = store.register(remote, 'Other', 'Keep its destination').id;
  const first = { projectId: other, repository: 'fixture/other', branch: 'retained' };
  writeFileSync(join(root, 'source-backups.json'), JSON.stringify([first]), { mode: 0o600 });
  const f = setupFixture();
  f.repos.set('fixture/existing', f.metadata('fixture/existing'));
  const preview = (
    await f.setup.preview(projectId, { choice: 'existing', repository: 'fixture/existing' })
  ).preview!;
  const input = { key: preview.id, previewId: preview.id, confirm: true };
  await f.setup.connect(projectId, input);
  expect(JSON.parse(readFileSync(join(root, 'source-backups.json'), 'utf8'))[0]).toEqual(first);
  await expect(f.setup.connect(other, input)).rejects.toThrow('different destination');
  await expect(f.setup.preview(projectId, { choice: 'create' })).rejects.toThrow('already has');
  const third = store.register(join(root, 'third'), 'Third', '').id;
  writeFileSync(
    join(root, 'source-backups.json'),
    JSON.stringify([{ ...first, branch: 'owner-change' }]),
  );
  expect(() =>
    backups!.connectInitial({ projectId: third, repository: 'fixture/third', branch: 'main' }),
  ).toThrow('changed outside');
  expect(readFileSync(join(root, 'source-backups.json'), 'utf8')).toContain('owner-change');
});

it('exposes destination confirmation through protected typed routes with no automatic GitHub calls', async () => {
  const f = setupFixture();
  const account = vi.spyOn(f.github, 'account');
  const runtime = new Runtime(store, root, 'codex');
  const app = await createServer(store, runtime, {
    port: 4338,
    backups,
    backupSetup: f.setup,
    ownsRuntime: false,
  });
  const headers = { host: '127.0.0.1:4338', origin: 'http://127.0.0.1:4338' };
  const path = `/api/projects/${projectId}/backup`;
  try {
    expect((await app.inject({ url: `${path}/setup`, headers })).json().destination).toBeNull();
    expect(account).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${path}/preview`,
          payload: { choice: 'create' },
          headers: { host: headers.host, origin: 'https://unrelated.test' },
        })
      ).statusCode,
    ).toBe(403);
    const response = await app.inject({
      method: 'POST',
      url: `${path}/preview`,
      headers,
      payload: { choice: 'create' },
    });
    expect(response.statusCode).toBe(200);
    const preview = response.json().preview;
    expect(f.create).not.toHaveBeenCalled();
    const payload = { key: preview.id, previewId: preview.id, confirm: true };
    for (let i = 0; i < 2; i++)
      expect(
        (await app.inject({ method: 'POST', url: `${path}/connect`, headers, payload })).statusCode,
      ).toBe(200);
    expect(f.create).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
    await runtime.close();
  }
});

it('native GitHub sign-in preserves a working account and opens an explicit attempt only once', async () => {
  const f = setupFixture();
  const open = vi.fn(async () => {});
  const setup = new SourceBackupSetup(backups!, f.github, Date.now, open);
  await expect(setup.signIn(projectId, { key: randomUUID() })).rejects.toThrow('already signed in');
  expect(open).not.toHaveBeenCalled();
  vi.spyOn(f.github, 'account').mockRejectedValue(Error('Native sign-in needed'));
  const input = { key: randomUUID() };
  expect(await setup.signIn(projectId, input)).toEqual({ opened: true });
  expect(await setup.signIn(projectId, input)).toEqual({ opened: true });
  expect(open).toHaveBeenCalledTimes(1);
  const fail = new SourceBackupSetup(
    backups!,
    f.github,
    Date.now,
    vi.fn(async () => {
      throw Error('Unknown window opening');
    }),
  );
  const uncertain = { key: randomUUID() };
  await expect(fail.signIn(projectId, uncertain)).rejects.toThrow('Unknown window');
  await expect(fail.signIn(projectId, uncertain)).rejects.toThrow('uncertain');
});
