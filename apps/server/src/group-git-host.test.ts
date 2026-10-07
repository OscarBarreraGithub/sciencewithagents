import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  realpath,
  rename,
  chmod,
  symlink,
  readdir,
  lstat,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GroupScope } from '@dock/shared';
import { GroupEventRepository } from './group-events.js';
import { GroupGitService, type GitGrant, type GroupGitAccess } from './group-git-service.js';
import {
  LocalGitObjectEndpoint,
  HttpsGitObjectEndpoint,
  metadataClosure,
  objectFrame,
  type GitObject,
} from './group-git-endpoint.js';
import { createServer } from 'node:https';
import { pinGitResource } from './group-git-host-files.js';
import { HostGitExecutor } from './group-git-executor.js';
import { SqliteGitJournal } from './group-git-journal.js';

const exec = promisify(execFile);
const env = {
  PATH: '/opt/homebrew/bin:/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_LFS_SKIP_SMUDGE: '1',
};
const git = async (cwd: string, ...argv: string[]) =>
  (
    await exec('/opt/homebrew/bin/git', argv, {
      cwd,
      env,
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
let root: string,
  a: string,
  b: string,
  remote: string,
  host: string,
  events: GroupEventRepository,
  service: GroupGitService,
  scope: GroupScope,
  access: GroupGitAccess,
  tip: string;
let registrations: { repositoryId: string; copyId: string }[] = [];
let grants: GitGrant[] = [];
const scopeFor = (context: ReturnType<GroupEventRepository['createContext']>): GroupScope => ({
  groupId: context.groupId,
  memberId: context.memberId,
  installationId: context.installationId,
  visibility: context.visibility,
  source: {
    sessionId: context.sessionId,
    provider: context.provider,
    nativeSessionId: context.nativeSessionId,
    messageId: randomUUID(),
  },
  causalRefs: [],
});
async function reopen(): Promise<void> {
  service.close();
  service = await GroupGitService.open({
    hostRoot: host,
    gitExecutable: '/opt/homebrew/bin/git',
    events,
  });
  access = service.authority.issue(scope);
}
async function register(
  activeRoot: string,
  overrides: Parameters<GroupGitService['register']>[0]['limits'] = {},
): Promise<number> {
  const n = registrations.length;
  const resourceId = `resource${n}`;
  const grantId = `grant${n}`;
  const registration = await service.register({
    activeRoot,
    resourceId,
    grantId,
    executorId: 'logical-executor',
    endpointId: 'controlled-endpoint',
    endpoint: { kind: 'local', root: remote, proposalOwnership: 'host-exclusive' },
    limits: overrides,
  });
  const grant: GitGrant = {
    id: grantId,
    revision: 'revision1',
    groupId: scope.groupId,
    memberId: scope.memberId,
    installationId: scope.installationId,
    repositoryId: registration.repositoryId,
    resourceId,
    endpointId: 'controlled-endpoint',
    executorId: 'logical-executor',
    metadata: true,
    paths: {
      'shared.txt': 'content',
      'staged.txt': 'content',
      'new.txt': 'content',
      'ignored.txt': 'content',
    },
    active: true,
  };
  service.authority.grant(grant);
  registrations.push(registration);
  grants.push(grant);
  return n;
}
const rid = (n = 0) => registrations[n].repositoryId;
async function state(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of [
    '.git/HEAD',
    '.git/index',
    '.git/config',
    'shared.txt',
    'private.txt',
    'staged.txt',
    'new.txt',
    'ignored.txt',
  ]) {
    try {
      result[name] = (await readFile(join(path, name))).toString('base64');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return result;
}
beforeEach(async () => {
  await mkdir('data/group-git-host-tests', { recursive: true });
  root = await realpath(await mkdtemp(resolve('data/group-git-host-tests/case-')));
  a = join(root, 'a');
  b = join(root, 'b');
  remote = join(root, 'remote.git');
  host = join(root, 'host');
  await mkdir(a);
  await git(a, 'init', '--initial-branch=main', '--template=');
  await git(a, 'config', 'user.name', 'Fixture');
  await git(a, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(a, 'shared.txt'), 'shared initial\n');
  await writeFile(join(a, 'private.txt'), 'private initial\n');
  await writeFile(join(a, 'huge.bin'), Buffer.alloc(1024 * 1024, 7));
  await git(a, 'add', 'shared.txt', 'private.txt', 'huge.bin');
  await git(a, 'commit', '-m', 'initial');
  tip = await git(a, 'rev-parse', 'HEAD');
  await git(root, 'clone', '--bare', '--no-hardlinks', a, remote);
  await git(root, 'clone', '--no-hardlinks', remote, b);
  await writeFile(join(b, 'shared.txt'), 'dirty shared\n');
  await writeFile(join(b, 'staged.txt'), 'staged bytes\n');
  await git(b, 'add', 'staged.txt');
  await writeFile(join(b, 'new.txt'), 'untracked shared\n');
  await writeFile(join(b, 'ignored.txt'), 'ignored bytes\n');
  await writeFile(join(b, '.git/info/exclude'), 'ignored.txt\n');
  events = new GroupEventRepository(join(root, 'events.sqlite'));
  const member = events.createGroup('Fixture');
  scope = scopeFor(
    events.createContext({
      groupId: member.groupId,
      memberId: member.memberId,
      installationId: member.installationId,
      visibility: 'shared',
      provider: 'codex',
      nativeSessionId: randomUUID(),
    }),
  );
  service = await GroupGitService.open({
    hostRoot: host,
    gitExecutable: '/opt/homebrew/bin/git',
    events,
  });
  access = service.authority.issue(scope);
  registrations = [];
  grants = [];
  await register(b);
  await register(a);
});
afterEach(async () => {
  vi.restoreAllMocks();
  service?.close();
  events?.close();
  const writable = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await chmod(path, 0o700);
      for (const name of await readdir(path)) await writable(join(path, name));
    }
  };
  await writable(root);
  await rm(root, { recursive: true, force: true });
});

it('runs actual production metadata transfer and granted views across two copies, preserving every active byte', async () => {
  const beforeA = await state(a),
    beforeB = await state(b);
  const first = await service.tick(access, rid(), 100000);
  expect(first.observedVersion).toBe(tip);
  expect(first.autoMain).toBe(false);
  await service.tick(access, rid(1), 100000);
  const object = await git(a, 'rev-parse', 'HEAD:huge.bin');
  const observation = join(host, rid(), 'observation.git');
  expect(
    await readFile(join(observation, 'objects', object.slice(0, 2), object.slice(2))).catch(
      () => null,
    ),
  ).toBeNull();
  const view = await service.materialize(access, rid(), {
    operationId: 'view1',
    viewId: 'view1',
    version: tip,
    kind: 'main',
  });
  expect(view).toEqual({ viewId: 'view1', version: tip });
  expect(await readFile(join(host, rid(), 'views/view1/content/shared.txt'), 'utf8')).toBe(
    'shared initial\n',
  );
  expect(await readdir(join(host, rid(), 'views/view1/content'))).toEqual(['shared.txt']);
  expect(await state(a)).toEqual(beforeA);
  expect(await state(b)).toEqual(beforeB);
  const pending = await service.outbox(access, rid());
  expect(pending.map((row) => (row.value as { type: string }).type)).toEqual([
    'main-observed',
    'main-view',
  ]);
  await service.acknowledge(access, rid(), pending[0].id);
  expect((await service.outbox(access, rid())).length).toBe(1);
});

it('captures change-only saved bytes, scoped dirty/staged/untracked awareness and ignores ignored/private data', async () => {
  await service.tick(access, rid(), 100000);
  const first = await service.snapshot(access, rid());
  expect(first.complete).toBe(true);
  expect(first.paths).toEqual(['new.txt', 'shared.txt', 'staged.txt']);
  expect(first.baseOid).toBe(tip);
  const second = await service.snapshot(access, rid());
  expect(second.revision).toBe(first.revision);
  await writeFile(join(b, 'private.txt'), 'private change');
  const third = await service.snapshot(access, rid());
  expect(third.revision).toBe(first.revision);
  await writeFile(join(b, 'shared.txt'), 'different same saved path');
  const fourth = await service.snapshot(access, rid());
  expect(fourth.revision).toBe(first.revision + 1);
  expect(
    (await service.outbox(access, rid())).filter((row) => row.id.startsWith('snapshot_')).length,
  ).toBe(2);
});

it.each(['include', 'filter', 'helper', 'rewrite', 'ssh', 'fsmonitor', 'hooks', 'attributes'])(
  'neutralizes executable %s canary while production reads actually execute',
  async (vector) => {
    const marker = join(root, 'EXECUTED');
    const script = join(root, 'canary.sh');
    await writeFile(script, `#!/bin/sh\nprintf escaped > '${marker}'\nexit 0\n`);
    await chmod(script, 0o755);
    const config = join(b, '.git/config');
    const base = await readFile(config, 'utf8');
    const extra: Record<string, string> = {
      include: `[include]\npath = ${join(root, 'included')}\n`,
      filter: `[filter "evil"]\nclean = ${script}\nsmudge = ${script}\n`,
      helper: `[credential]\nhelper = !${script}\n`,
      rewrite: `[url "ext::${script}"]\ninsteadOf = controlled-endpoint\n`,
      ssh: `[core]\nsshCommand = ${script}\n`,
      fsmonitor: `[core]\nfsmonitor = ${script}\n`,
      hooks: `[core]\nhooksPath = ${join(root, 'hooks')}\n`,
      attributes: `[diff "evil"]\ntextconv = ${script}\n[filter "evil"]\nprocess = ${script}\n`,
    };
    await writeFile(join(root, 'included'), `[core]\nfsmonitor = ${script}\n`);
    await mkdir(join(root, 'hooks'));
    await writeFile(join(root, 'hooks/reference-transaction'), await readFile(script));
    await chmod(join(root, 'hooks/reference-transaction'), 0o755);
    await writeFile(config, base + extra[vector]);
    const endpointConfig = join(remote, 'config');
    await writeFile(endpointConfig, (await readFile(endpointConfig, 'utf8')) + extra[vector]);
    const endpointConfigBefore = await readFile(endpointConfig);
    await writeFile(join(b, '.gitattributes'), '* filter=evil diff=evil\n');
    const before = await state(b);
    await service.tick(access, rid(), 100000);
    expect((await service.snapshot(access, rid())).complete).toBe(true);
    await service.materialize(access, rid(), {
      operationId: 'safe-view',
      viewId: 'safe-view',
      version: tip,
      kind: 'main',
    });
    expect(await readFile(marker).catch(() => null)).toBeNull();
    expect(await state(b)).toEqual(before);
    expect(await readFile(endpointConfig)).toEqual(endpointConfigBefore);
  },
);

it('denies forged/private/cross-resource access and revalidates revoked membership on outbox and recovery', async () => {
  await expect(service.tick({} as GroupGitAccess, rid(), 100000)).rejects.toThrow('access');
  const member = events.createGroup('Other');
  const other = scopeFor(
    events.createContext({
      groupId: member.groupId,
      memberId: member.memberId,
      installationId: member.installationId,
      visibility: 'shared',
      provider: 'codex',
      nativeSessionId: randomUUID(),
    }),
  );
  await expect(service.status(service.authority.issue(other), rid())).rejects.toThrow('grant');
  const privateContext = events.createContext({
    groupId: scope.groupId,
    memberId: scope.memberId,
    installationId: scope.installationId,
    visibility: 'private',
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
  await expect(
    service.tick(service.authority.issue(scopeFor(privateContext)), rid(), 100000),
  ).rejects.toThrow('shared');
  await service.tick(access, rid(), 100000);
  events.revokeMember(scope.groupId, scope.memberId);
  await expect(service.outbox(access, rid())).rejects.toThrow();
  await expect(service.reconcile(access, rid())).rejects.toThrow();
});

it('refuses gitdir/alternate/symlink resource redirection before commands', async () => {
  await writeFile(join(b, '.git/objects/info/alternates'), join(a, '.git/objects') + '\n');
  await expect(service.tick(access, rid(), 100000)).rejects.toThrow('alternate');
  await rm(join(b, '.git/objects/info/alternates'));
  await rename(join(b, '.git'), join(b, 'oldgit'));
  await writeFile(join(b, '.git'), `gitdir: ${join(b, 'oldgit')}\n`);
  await expect(service.tick(access, rid(), 100000)).rejects.toThrow();
  await expect(pinGitResource('linked', b)).rejects.toThrow('gitdir');
});

it('enforces metadata/object/source-store budgets before an observation effect intent', async () => {
  await register(b, { maxTransferBytes: 1 });
  await expect(service.tick(access, rid(2), 100000)).rejects.toThrow('limit');
  // Aggregate transport quota also bounds the initial ref probe, before a tip/intent exists.
  expect((await service.status(access, rid(2))).pendingOperationId).toBeNull();
  expect(await readdir(join(host, rid(2), 'observation.git/objects'))).toEqual([]);
  await register(b, { maxTransferBytes: 64 });
  await expect(service.tick(access, rid(3), 100000)).rejects.toThrow('limit');
  const pending = (await service.status(access, rid(3))).pendingOperationId!;
  const operation = service.journal.operation(pending)!;
  expect(operation.state).toBe('blocked');
  expect(operation.result).toBeUndefined();
  expect(await readdir(join(host, rid(2), 'observation.git/objects'))).toEqual([]);
  await service.dismissBlocked(access, rid(3), pending, 'decision1');
  expect((await service.status(access, rid(3))).pendingOperationId).toBeNull();
  await register(b, { maxInputBytes: 10 });
  await expect(service.tick(access, rid(4), 100000)).rejects.toThrow('limit');
});

it('restarts an offline pre-intent operation using the same ID, then transfers exactly once', async () => {
  const original = LocalGitObjectEndpoint.prototype.ref;
  let calls = 0;
  vi.spyOn(LocalGitObjectEndpoint.prototype, 'ref').mockImplementation(async function (
    this: LocalGitObjectEndpoint,
    ...args
  ) {
    if (++calls === 2) throw new Error('offline');
    return original.apply(this, args);
  });
  await expect(service.tick(access, rid(), 100000)).rejects.toThrow('offline');
  const pending = (await service.status(access, rid())).pendingOperationId!;
  expect(service.journal.operation(pending)?.state).toBe('uncertain');
  expect(service.journal.operation(pending)?.result).toBeUndefined();
  await reopen();
  const result = await service.tick(access, rid(), 1000000);
  expect(result.observedVersion).toBe(tip);
  expect(service.journal.operation(pending)?.state).toBe('verified');
  expect(
    (await service.outbox(access, rid())).filter(
      (row) => (row.value as { type: string }).type === 'main-observed',
    ).length,
  ).toBe(1);
});

it('recovers a lost durable fetch acknowledgement with the same ID and no replay', async () => {
  const record = service.journal.record.bind(service.journal);
  let injected = false;
  vi.spyOn(service.journal, 'record').mockImplementation((id, state, result, event) => {
    record(id, state, result, event);
    if (state === 'verified' && !injected) {
      injected = true;
      throw new Error('lost ack');
    }
  });
  await expect(service.tick(access, rid(), 100000)).rejects.toThrow('lost ack');
  const pending = (await service.status(access, rid())).pendingOperationId!;
  expect(service.journal.operation(pending)?.state).toBe('verified');
  await reopen();
  const read = vi.spyOn(LocalGitObjectEndpoint.prototype, 'object');
  await service.tick(access, rid(), 1000000);
  expect(read).not.toHaveBeenCalled();
  expect(service.journal.operation(pending)?.state).toBe('verified');
});

it('never replays a post-intent crash whose effect is absent, including changed-grant recovery', async () => {
  const record = service.journal.record.bind(service.journal);
  let injected = false;
  vi.spyOn(service.journal, 'record').mockImplementation((id, state, result, event) => {
    record(id, state, result, event);
    if (
      result &&
      typeof result === 'object' &&
      Object.hasOwn(result, 'effectIntent') &&
      !injected
    ) {
      injected = true;
      throw new Error('crash after intent');
    }
  });
  await expect(service.tick(access, rid(), 100000)).rejects.toThrow('crash after intent');
  const pending = (await service.status(access, rid())).pendingOperationId!;
  await reopen();
  await expect(service.tick(access, rid(), 1000000)).rejects.toThrow('replay is disabled');
  expect(service.journal.operation(pending)?.state).toBe('uncertain');
  await expect(
    service.materialize(access, rid(), {
      operationId: 'bypass',
      viewId: 'bypass',
      version: tip,
      kind: 'task',
    }),
  ).rejects.toThrow('new IDs');
  service.authority.grant({ ...grants[0], revision: 'changed' });
  await expect(service.tick(access, rid(), 10000000)).rejects.toThrow('authorization required');
  await expect(
    service.dismissBlocked(access, rid(), pending, 'unsafe-disposition'),
  ).rejects.toThrow('pre-intent');
});

it('requires exact trusted review/history and denies private deleted history', async () => {
  await service.tick(access, rid(1), 100000);
  await expect(
    service.propose(access, rid(1), {
      operationId: 'proposal1',
      proposalId: 'proposal1',
      reviewId: 'invented',
      historyGrantId: 'invented',
    }),
  ).rejects.toThrow('receipt');
  await git(a, 'rm', 'private.txt', 'huge.bin');
  await git(a, 'commit', '-m', 'delete private tip');
  const oid = await git(a, 'rev-parse', 'HEAD');
  service.authority.review({
    id: 'review1',
    repositoryId: rid(1),
    sourceOid: oid,
    grantRevision: 'revision1',
    historyGrantId: 'history1',
    historyRevision: 'history-revision1',
    historySourceOid: oid,
    historyTargetOid: null,
    approved: true,
  });
  await expect(
    service.propose(access, rid(1), {
      operationId: 'proposal1',
      proposalId: 'proposal1',
      reviewId: 'review1',
      historyGrantId: 'history1',
    }),
  ).rejects.toThrow('ungranted');
  expect(
    await git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/dock-proposals'),
  ).toBe('');
});

it('exports granted full history as a create-only proposal, preserving main and reconciling same IDs', async () => {
  const grant = {
    ...grants[1],
    revision: 'revision2',
    paths: {
      ...grants[1].paths,
      'private.txt': 'content' as const,
      'huge.bin': 'content' as const,
    },
  };
  service.authority.grant(grant);
  service.authority.review({
    id: 'review1',
    repositoryId: rid(1),
    sourceOid: tip,
    grantRevision: 'revision2',
    historyGrantId: 'history1',
    historyRevision: 'history-revision1',
    historySourceOid: tip,
    historyTargetOid: null,
    approved: true,
  });
  const input = {
    operationId: 'proposal1',
    proposalId: 'proposal1',
    reviewId: 'review1',
    historyGrantId: 'history1',
  };
  const result = await service.propose(access, rid(1), input);
  expect(await git(remote, 'rev-parse', result.ref)).toBe(tip);
  expect(await git(remote, 'rev-parse', 'refs/heads/main')).toBe(tip);
  await reopen();
  expect(await service.propose(access, rid(1), input)).toEqual(result);
  await expect(
    service.propose(access, rid(1), { ...input, operationId: 'proposal2' }),
  ).rejects.toThrow('already exists');
});

it('uses atomic create-only endpoint publication under an actual concurrent race', async () => {
  const executor = await HostGitExecutor.open(join(root, 'race.sqlite'), '/opt/homebrew/bin/git');
  try {
    const endpoint = new LocalGitObjectEndpoint(
      'local',
      await pinGitResource('remote', remote, true),
      executor,
      'race',
      host,
      16 * 1024 * 1024,
      'host-exclusive',
    );
    const budget = () => ({
      remaining: 4 * 1024 * 1024,
      objects: 0,
      maxObjects: 4096,
      deadline: Date.now() + 30000,
    });
    const blob = await endpoint.object(await git(a, 'rev-parse', 'HEAD:shared.txt'), budget());
    const results = await Promise.allSettled([
      endpoint.create(
        'refs/heads/dock-proposals/race/one',
        tip,
        [blob] satisfies GitObject[],
        budget(),
      ),
      endpoint.create('refs/heads/dock-proposals/race/one', tip, [blob], budget()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  } finally {
    executor.close();
  }
});

it('retains durable exclusion until an actual surviving child is quiescent and fences unknown spawns', async () => {
  const path = join(root, 'fencing.sqlite');
  const executor = await HostGitExecutor.open(path, '/opt/homebrew/bin/git');
  const journal = new SqliteGitJournal(path, executor);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const db = new DatabaseSync(path);
  try {
    db.prepare('INSERT INTO gg_executors VALUES (?,?)').run('dead-owner', 2147483647);
    db.prepare('INSERT INTO gg_processes VALUES (?,?,?,?,?)').run(
      'surviving-child',
      'dead-owner',
      'resource',
      child.pid!,
      'running',
    );
    db.prepare('INSERT INTO gg_leases VALUES (?,?,?)').run('resource', 'dead-owner', 'lease');
    expect(await journal.recover('resource')).toBe(false);
    await expect(journal.exclusive('resource', async () => undefined)).rejects.toThrow('fenced');
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    expect(await journal.recover('resource')).toBe(true);
    db.prepare('INSERT INTO gg_processes VALUES (?,?,?,?,?)').run(
      'unknown-spawn',
      'dead-owner',
      'unknown',
      null,
      'spawn-intent',
    );
    db.prepare('INSERT INTO gg_leases VALUES (?,?,?)').run('unknown', 'dead-owner', 'lease2');
    expect(await journal.recover('unknown')).toBe(false);
  } finally {
    child.kill('SIGKILL');
    db.close();
    journal.close();
    executor.close();
  }
});

it('refuses unsupported HTTPS native Git and deployed create-only capabilities precisely', async () => {
  expect(
    () =>
      new HttpsGitObjectEndpoint(
        'github',
        'https://github.com/example/project.git',
        async () => '',
      ),
  ).toThrow('smart HTTP');
  const endpoint = new HttpsGitObjectEndpoint(
    'configured',
    'https://example.invalid/group-git/v1/',
    async () => 'credential',
  );
  expect(await endpoint.createOnlyMechanism()).toBeNull();
  expect(await endpoint.observationMechanism()).toBeNull();
  await expect(endpoint.create()).rejects.toThrow('atomic create-only');
  expect(
    () =>
      new HttpsGitObjectEndpoint(
        'insecure',
        'http://example.invalid/group-git/v1/',
        async () => '',
      ),
  ).toThrow('HTTPS');
});

it('refuses symlinked object bytes with no marker execution or active-copy mutation', async () => {
  await service.tick(access, rid(), 100000);
  const previous = await service.snapshot(access, rid());
  expect(previous.dirty).toBe(true);
  const object = await git(b, 'rev-parse', 'HEAD:shared.txt');
  const file = join(b, '.git/objects', object.slice(0, 2), object.slice(2));
  const backup = await readFile(file);
  await rm(file);
  await symlink(join(a, '.git/objects', object.slice(0, 2), object.slice(2)), file);
  const snapshot = await service.snapshot(access, rid());
  expect(snapshot.complete).toBe(false);
  expect(snapshot.dirty).toBe(true);
  expect(snapshot.paths).toEqual(previous.paths);
  await rm(file);
  await writeFile(file, backup);
});

it('protects append-only transitions and current grant scoped outbox after restart', async () => {
  await service.tick(access, rid(), 100000);
  const pending = await service.outbox(access, rid());
  await reopen();
  expect(await service.outbox(access, rid())).toEqual(pending);
  const db = new DatabaseSync(join(host, 'git.sqlite'));
  try {
    expect(() => db.exec('DELETE FROM gg_transitions')).toThrow('immutable');
    expect(() => db.exec("UPDATE gg_outbox SET payload='{}'")).toThrow('immutable');
  } finally {
    db.close();
  }
  service.authority.grant({ ...grants[0], revision: 'newrevision', paths: {} });
  expect(await service.outbox(access, rid())).toEqual([]);
});

it('keeps the actual editor base/HEAD/index pinned when observed main advances', async () => {
  await service.tick(access, rid(), 100000);
  const initial = await service.snapshot(access, rid());
  const before = await state(b);
  await writeFile(join(a, 'shared.txt'), 'new remote version');
  await git(a, 'add', 'shared.txt');
  await git(a, 'commit', '-m', 'remote advance');
  await git(a, 'push', '--no-verify', remote, 'main');
  const next = await git(a, 'rev-parse', 'HEAD');
  expect((await service.tick(access, rid(), 200000)).observedVersion).toBe(next);
  const snapshot = await service.snapshot(access, rid());
  expect(snapshot.baseOid).toBe(initial.baseOid);
  expect(snapshot.headOid).toBe(initial.headOid);
  expect(await state(b)).toEqual(before);
  await service.materialize(access, rid(), {
    operationId: 'advanced-view',
    viewId: 'advanced-view',
    version: next,
    kind: 'task',
  });
  expect(await readFile(join(host, rid(), 'views/advanced-view/content/shared.txt'), 'utf8')).toBe(
    'new remote version',
  );
});

it('persists scoped advisory edit warnings with stable deduplicated IDs across restart', async () => {
  await service.tick(access, rid(), 100000);
  await service.tick(access, rid(1), 100000);
  const bSnapshot = await service.snapshot(access, rid());
  const aSnapshot = await service.snapshot(access, rid(1));
  const input = {
    intentId: 'editing-a',
    copyId: registrations[1].copyId,
    revision: 1,
    baseOid: aSnapshot.baseOid,
    copyRevision: aSnapshot.revision,
    paths: ['shared.txt'],
    expiresAt: Date.now() + 60000,
    released: false,
  };
  await service.intent(access, rid(1), input);
  const warnings = await service.warnings(access, rid(), [rid(1)]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0].paths).toEqual(['shared.txt']);
  expect(warnings[0].evidence).toBe('advisory');
  expect(warnings[0].revisions).toContain(bSnapshot.revision);
  await reopen();
  expect(await service.warnings(access, rid(), [rid(1)])).toEqual(warnings);
  expect(
    (await service.outbox(access, rid())).filter((row) => row.id === warnings[0].id),
  ).toHaveLength(1);
  await expect(
    service.intent(access, rid(1), { ...input, paths: ['private.txt'] }),
  ).rejects.toThrow('shared content');
  service.authority.grant({ ...grants[1], active: false });
  await expect(service.warnings(access, rid(), [rid(1)])).rejects.toThrow('grant');
});

it('does not accept changed grants under the same revision or mutable review IDs', async () => {
  expect(() => service.authority.grant({ ...grants[0], paths: {} })).toThrow('immutable revision');
  const receipt = {
    id: 'review1',
    repositoryId: rid(),
    sourceOid: tip,
    grantRevision: 'revision1',
    historyGrantId: 'history1',
    historyRevision: 'history-revision1',
    historySourceOid: tip,
    historyTargetOid: null,
    approved: true,
  } as const;
  service.authority.review(receipt);
  expect(() => service.authority.review({ ...receipt, approved: false })).toThrow('immutable');
});

it('executes configured HTTPS object reads with TLS, fixed-origin credentials, hash/body limits and redirect refusal', async () => {
  const certificate = join(root, 'certificate.pem'),
    key = join(root, 'key.pem');
  await exec(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      certificate,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { timeout: 15000 },
  );
  const executor = await HostGitExecutor.open(
    join(root, 'https-source.sqlite'),
    '/opt/homebrew/bin/git',
  );
  const endpoint = new LocalGitObjectEndpoint(
    'local',
    await pinGitResource('remote', remote, true),
    executor,
    'https',
    host,
    16 * 1024 * 1024,
  );
  const budget = () => ({
    remaining: 1024 * 1024,
    objects: 0,
    maxObjects: 4096,
    deadline: Date.now() + 30000,
  });
  const objects = await metadataClosure(endpoint, tip, budget());
  const frames = new Map(objects.map((object) => [object.oid, objectFrame(object)]));
  let mode = 'normal';
  const authorizations: string[] = [];
  const server = createServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    (request, response) => {
      authorizations.push(request.headers.authorization ?? '');
      if (mode === 'redirect') {
        response.writeHead(302, { Location: 'https://example.invalid/leak' });
        response.end();
        return;
      }
      if (request.url?.startsWith('/group-git/v1/refs?')) {
        const body = JSON.stringify({ oid: tip });
        response.writeHead(200, { 'Content-Length': Buffer.byteLength(body) });
        response.end(body);
        return;
      }
      const oid = request.url?.split('/').at(-1) ?? '';
      let body = frames.get(oid) ?? Buffer.alloc(0);
      if (mode === 'corrupt') body = Buffer.from('blob 3\0bad');
      if (mode === 'oversized') body = Buffer.alloc(100000);
      response.writeHead(200, { 'Content-Length': body.length });
      response.end(body);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const script = join(root, 'https-check.mjs');
  await writeFile(
    script,
    `import {HttpsGitObjectEndpoint,metadataClosure} from ${JSON.stringify(join(process.cwd(), 'apps/server/src/group-git-endpoint.ts'))};
    const endpoint=new HttpsGitObjectEndpoint('configured',process.argv[2],async()=>'owned-test-secret');
    const budget=()=>({remaining:Number(process.argv[4]),objects:0,maxObjects:4096,deadline:Date.now()+10000});
    const tip=await endpoint.ref('refs/heads/main',budget());
    const closure=await metadataClosure(endpoint,tip,budget());
    process.stdout.write(String(closure.length));`,
  );
  const run = () =>
    exec(
      process.execPath,
      [
        '--import',
        join(process.cwd(), 'apps/server/node_modules/tsx/dist/loader.mjs'),
        script,
        `https://127.0.0.1:${port}/group-git/v1/`,
        'unused',
        '4096',
      ],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
  try {
    expect((await run()).stdout).toBe(String(objects.length));
    expect(authorizations.every((value) => value === 'Bearer owned-test-secret')).toBe(true);
    mode = 'corrupt';
    await expect(run()).rejects.toThrow();
    mode = 'oversized';
    await expect(run()).rejects.toThrow();
    mode = 'redirect';
    await expect(run()).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    executor.close();
  }
});
