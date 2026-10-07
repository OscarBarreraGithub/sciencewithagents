import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  realpath,
  symlink,
  stat,
  utimes,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  GroupGit,
  digest,
  repositoryBinding,
  type HostGitBoundaryRequest,
  type HostGitBoundaryObservation,
  type GitTransport,
  type GitGateObservation,
  type GitCall,
  type GroupRepository,
  type GitJournal,
  type GitOperation,
  type GitEvent,
  type ProposalRequest,
  type ImmutableViews,
} from './group-git.js';
import {
  GroupGitSnapshots,
  editIntent,
  overlapAlerts,
  type CopySnapshot,
  type SnapshotLedger,
  type SnapshotOptions,
} from './group-git-snapshot.js';
import {
  planObservation,
  settleObservation,
  type ObservationSchedule,
} from './group-git-schedule.js';
import { DirectoryGitViews } from './group-git-views.js';

const exec = promisify(execFile);
let root: string,
  a: string,
  b: string,
  observation: string,
  otherObservation: string,
  remote: string,
  base: string;
let db: SqliteFixtureJournal, transport: FixtureGit, repository: GroupRepository, core: GroupGit;
const env = () => ({
  PATH: process.env.PATH,
  HOME: root,
  LANG: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_LFS_SKIP_SMUDGE: '1',
});
async function git(cwd: string, argv: string[]): Promise<string> {
  return (
    await exec('git', argv, { cwd, env: env(), timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
  ).stdout.trim();
}

/** Disposable durable adapter. Lease has no expiration: tests never recover a live executor.
 * Production adapters additionally need trusted abandoned-executor recovery. */
class SqliteFixtureJournal implements GitJournal, SnapshotLedger {
  readonly owner = randomUUID();
  readonly observedDeadOwners = new Set<string>();
  readonly observedQuiescentDescendants = new Set<string>();
  readonly sql: DatabaseSync;
  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transitions(sequence INTEGER PRIMARY KEY, id TEXT, state TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(repository TEXT PRIMARY KEY, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(copy TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
  }
  async exclusive<T>(repositoryId: string, work: () => Promise<T>): Promise<T> {
    this.sql.prepare('INSERT INTO leases VALUES (?,?)').run(repositoryId, this.owner);
    try {
      return await work();
    } finally {
      this.sql
        .prepare('DELETE FROM leases WHERE repository=? AND owner=?')
        .run(repositoryId, this.owner);
    }
  }
  recoverDeadFixtureOwner(repositoryId: string, owner: string) {
    if (!this.observedDeadOwners.has(owner) || !this.observedQuiescentDescendants.has(owner))
      throw new Error('Executor AND descendant quiescence/death not observed');
    this.sql.prepare('DELETE FROM leases WHERE repository=? AND owner=?').run(repositoryId, owner);
  }
  begin(operation: GitOperation): GitOperation {
    const row = this.sql.prepare('SELECT payload FROM operations WHERE id=?').get(operation.id) as
      | { payload: string }
      | undefined;
    if (row) {
      const prior = JSON.parse(row.payload) as GitOperation;
      if (
        prior.payloadHash !== operation.payloadHash ||
        prior.repositoryId !== operation.repositoryId
      )
        throw new Error('Operation payload changed');
      return prior;
    }
    this.sql
      .prepare('INSERT INTO operations VALUES (?,?)')
      .run(operation.id, JSON.stringify(operation));
    return operation;
  }
  record(id: string, state: GitOperation['state'], result?: unknown, event?: GitEvent) {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const row = this.sql.prepare('SELECT payload FROM operations WHERE id=?').get(id) as {
        payload: string;
      };
      const prior = JSON.parse(row.payload) as GitOperation;
      const next = { ...prior, state, ...(result === undefined ? {} : { result }) };
      this.sql.prepare('UPDATE operations SET payload=? WHERE id=?').run(JSON.stringify(next), id);
      this.sql
        .prepare('INSERT INTO transitions(id,state,result) VALUES (?,?,?)')
        .run(id, state, JSON.stringify(next.result) ?? null);
      if (event)
        this.sql
          .prepare('INSERT OR IGNORE INTO outbox VALUES (?,?)')
          .run(event.id, JSON.stringify(event));
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }
  current(copyId: string): CopySnapshot | null {
    const row = this.sql.prepare('SELECT payload FROM snapshots WHERE copy=?').get(copyId) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as CopySnapshot) : null;
  }
  save(previous: CopySnapshot | null, snapshot: CopySnapshot) {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      if (digest(this.current(snapshot.copyId)) !== digest(previous))
        throw new Error('Snapshot CAS changed');
      this.sql
        .prepare(
          'INSERT INTO snapshots VALUES (?,?) ON CONFLICT(copy) DO UPDATE SET payload=excluded.payload',
        )
        .run(snapshot.copyId, JSON.stringify(snapshot));
      if (previous?.revision !== snapshot.revision)
        this.sql
          .prepare('INSERT OR IGNORE INTO outbox VALUES (?,?)')
          .run(
            `snapshot_${snapshot.copyId}_${snapshot.epoch}_${snapshot.revision}`,
            JSON.stringify(snapshot),
          );
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }
  operation(id: string): GitOperation {
    return JSON.parse(
      (this.sql.prepare('SELECT payload FROM operations WHERE id=?').get(id) as { payload: string })
        .payload,
    );
  }
  events(): unknown[] {
    return this.sql
      .prepare('SELECT payload FROM outbox ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(row.payload as string));
  }
  close() {
    this.sql.close();
  }
}

/** LOCAL FIXTURES ONLY, not a live endpoint implementation. A local bare server permits object
 * inspection before transfer; remote quota/filter enforcement is an undelivered enrollment gate. */
class FixtureGit implements GitTransport {
  calls: GitCall[] = [];
  boundaries: HostGitBoundaryRequest[] = [];
  async observeHostGitBoundary(
    request: HostGitBoundaryRequest,
  ): Promise<HostGitBoundaryObservation | null> {
    // Test-owned resources only. No Git or other subprocess is used by this observer.
    this.boundaries.push(request);
    if (
      request.scope !== 'disposable-local-fixture' ||
      request.hostCallerId !== 'fixture-host' ||
      request.boundaryRevision !== 'boundary1' ||
      ![a, b, observation, otherObservation].includes(request.root) ||
      request.endpoint !== `file://${remote}`
    )
      return null;
    return {
      ...request,
      evidenceId: 'owned-disposable-boundary',
      mechanism: 'test-host registration only; not production isolation',
    };
  }
  blobs: string[] = [];
  lostFetch = false;
  lostPush = false;
  fetchSafe = true;
  proposalSafe = true;
  beforePush?: () => Promise<void>;
  unknownFetch = false;
  unknownPush = false;
  denyRemoteInspection = false;
  async observeBloblessGate(
    endpoint: string,
    expectedTip: string,
    maxBytes: number,
  ): Promise<GitGateObservation | null> {
    if (
      !this.fetchSafe ||
      endpoint !== `file://${remote}` ||
      (await git(remote, ['config', 'uploadpack.allowFilter'])) !== 'true'
    )
      return null;
    // Executable LOCAL evidence, not an attestation about live wire quotas/GitHub.
    const objects = (
      await git(remote, [
        'rev-list',
        '--objects',
        '--no-object-names',
        '--filter=blob:none',
        expectedTip,
      ])
    ).split('\n');
    let boundedObjectBytes = 0;
    for (const object of objects)
      boundedObjectBytes += Number(await git(remote, ['cat-file', '-s', object])) + 256;
    if (boundedObjectBytes > maxBytes) throw new Error('Fixture transfer quota');
    const probe = join(root, `filter-probe-${randomUUID()}.git`);
    await git(root, ['init', '--bare', '--template=', probe]);
    await git(probe, [
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--no-write-fetch-head',
      '--filter=blob:none',
      endpoint,
      expectedTip,
    ]);
    const observedObjects = await git(probe, [
      'cat-file',
      '--batch-all-objects',
      '--batch-check=%(objectname) %(objecttype) %(objectsize)',
    ]);
    const rows = observedObjects.split('\n');
    if (
      rows.some((row) => row.split(' ')[1] === 'blob') ||
      rows.reduce((sum, row) => sum + Number(row.split(' ')[2]) + 256, 0) > maxBytes
    )
      return null;
    return {
      scope: 'disposable-local-fixture',
      endpoint,
      gate: 'blobless-byte-budget',
      expectedTip,
      maxBytes,
      evidenceId: digest([expectedTip, observedObjects]),
      mechanism: 'local Git filter probe plus bounded reachable-object inventory (fixture only)',
    };
  }
  async observeCreateOnlyGate(endpoint: string, ref: string): Promise<GitGateObservation | null> {
    if (!this.proposalSafe || endpoint !== `file://${remote}`) return null;
    const hook = join(remote, 'hooks/pre-receive');
    const invoke = (old: string) =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(hook, [], {
          cwd: remote,
          env: env(),
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.stdin.end(`${old} ${base} ${ref}\n`);
      });
    const creates = await invoke('0'.repeat(40));
    const updates = await invoke(base);
    if (creates !== 0 || updates !== 1) return null;
    return {
      scope: 'disposable-local-fixture',
      endpoint,
      gate: 'create-only-proposal',
      ref,
      evidenceId: digest([ref, await readFile(hook, 'utf8'), creates, updates]),
      mechanism:
        'executed disposable pre-receive rule; actual receive race is independently tested',
    };
  }
  async run(call: GitCall): Promise<Buffer> {
    if (![a, b, observation, otherObservation].includes(call.cwd))
      throw new Error('Unregistered fixture copy');
    this.calls.push(call);
    if (this.denyRemoteInspection && call.argv.includes('ls-remote'))
      throw new Error('Remote inspection unavailable');
    if (this.unknownFetch && call.argv.includes('fetch')) {
      this.unknownFetch = false;
      throw new Error('Unknown fetch outcome');
    }
    if (this.unknownPush && call.argv.includes('push')) {
      this.unknownPush = false;
      throw new Error('Unknown push outcome');
    }
    if (call.transfer?.mode === 'blobless') {
      const objects = (
        await git(remote, [
          'rev-list',
          '--objects',
          '--no-object-names',
          '--filter=blob:none',
          call.transfer.expectedTip,
        ])
      ).split('\n');
      let bytes = 0;
      for (const object of objects)
        bytes += Number(await git(remote, ['cat-file', '-s', object])) + 256;
      if (bytes > call.transfer.maxBytes) throw new Error('Fixture transfer quota');
    }
    if (call.transfer?.mode === 'proposal') {
      const source = call.argv[call.argv.length - 1].split(':')[0];
      const objects = (
        await git(call.cwd, ['rev-list', '--objects', '--no-object-names', source])
      ).split('\n');
      let bytes = 0;
      for (const object of objects)
        bytes += Number(await git(call.cwd, ['cat-file', '-s', object])) + 256;
      if (bytes > call.transfer.maxBytes) throw new Error('Fixture proposal transfer quota');
    }
    if (call.argv.includes('push')) await this.beforePush?.();
    const result = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn('git', [...call.argv], {
        cwd: call.cwd,
        env: { ...env(), ...call.environment },
        stdio: 'pipe',
      });
      const parts: Buffer[] = [];
      const errors: Buffer[] = [];
      let bytes = 0;
      let errorBytes = 0;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, call.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > call.maxOutputBytes) child.kill('SIGKILL');
        else parts.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errorBytes += chunk.length;
        if (errorBytes > call.maxOutputBytes) child.kill('SIGKILL');
        else errors.push(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) reject(new Error('Git timeout'));
        else if (code || bytes > call.maxOutputBytes || errorBytes > call.maxOutputBytes)
          reject(new Error(`Git failed: ${Buffer.concat(errors).toString().slice(0, 150)}`));
        else resolve(Buffer.concat(parts));
      });
      child.stdin.end(call.stdin);
    });
    if (this.lostFetch && call.argv.includes('fetch')) {
      this.lostFetch = false;
      throw new Error('Lost fetch acknowledgement');
    }
    if (this.lostPush && call.argv.includes('push')) {
      this.lostPush = false;
      throw new Error('Lost push acknowledgement');
    }
    return result;
  }
  async readApprovedBlob(request: {
    endpoint: string;
    oid: string;
    path: string;
    maxBytes: number;
  }): Promise<Buffer> {
    if (
      request.endpoint !== `file://${remote}` ||
      repository.policy.visibility(request.path) !== 'content'
    )
      throw new Error('Ungrantable blob');
    const size = Number(await git(remote, ['cat-file', '-s', request.oid]));
    if (size > request.maxBytes) throw new Error('Fixture blob quota');
    this.blobs.push(request.path);
    return (
      await exec('git', ['cat-file', 'blob', request.oid], {
        cwd: remote,
        env: env(),
        encoding: 'buffer',
        maxBuffer: request.maxBytes + 1,
      })
    ).stdout;
  }
}
const views = () =>
  new DirectoryGitViews(join(root, 'views'), {
    maxFiles: 100,
    maxFileBytes: 4096,
    maxTotalBytes: 8192,
  });
const mainObserve = (
  operationId: string,
  expectedTip: string,
  expectedPrevious: string | null = null,
) => ({
  operationId,
  remoteRef: 'refs/heads/main',
  expectedPrevious,
  expectedTip,
  grantRevision: 'grant1',
});
const materialize = (
  operationId: string,
  viewId: string,
  expectedMain: string,
  kind: 'main' | 'task' = 'main',
) => ({ operationId, viewId, expectedMain, grantRevision: 'grant1', kind });
const proposal = (
  operationId: string,
  sourceOid: string,
  proposalId = operationId,
): ProposalRequest => ({
  operationId,
  proposalId,
  sourceOid,
  expectedTarget: null,
  grantRevision: 'grant1',
  review: { approved: true, sourceOid, grantRevision: 'grant1', reviewId: 'review1' },
  historyGrant: { revision: 'history1', sourceOid, targetOid: null },
});
const snapshotOptions = (copyId = 'copyB', path = b): SnapshotOptions => ({
  root: path,
  hostGit: {
    scope: 'disposable-local-fixture',
    hostCallerId: 'fixture-host',
    boundaryRevision: 'boundary1',
    endpoint: `file://${remote}`,
    resourceIdentity: path === a ? 'activeA' : 'activeB',
    configIdentity: 'fixture-config1',
  },
  repositoryId: 'repo1',
  copyId,
  epoch: 'epoch1',
  baseOid: base,
  observedMainOid: base,
  policy: repository.policy,
  maxFiles: 100,
  maxFileBytes: 4096,
  maxTotalBytes: 8192,
  maxOutputBytes: 32_768,
  writerGeneration: () => 1,
  now: () => 1000,
});
async function commit(path = a) {
  await git(path, ['add', '--all']);
  await git(path, ['commit', '-m', 'Fixture']);
  return git(path, ['rev-parse', 'HEAD']);
}
async function advance(path = 'src/new.txt', bytes: string | Buffer = 'main changes') {
  await mkdir(join(a, path, '..'), { recursive: true });
  await writeFile(join(a, path), bytes);
  const tip = await commit();
  await git(a, ['push', 'origin', 'main']);
  return tip;
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'group-git-')));
  a = join(root, 'a');
  b = join(root, 'b');
  remote = join(root, 'remote.git');
  observation = join(root, 'observation.git');
  otherObservation = join(root, 'other-observation.git');
  await mkdir(a);
  await git(a, ['init', '--initial-branch=main']);
  await git(a, ['config', 'user.name', 'Fixture']);
  await git(a, ['config', 'user.email', 'fixture@localhost']);
  await mkdir(join(a, 'src'));
  await writeFile(join(a, 'src/a.txt'), 'original\n');
  await writeFile(join(a, '.gitignore'), 'ignored.txt\nprivate/\nmetadata/\n');
  base = await commit();
  await git(root, ['init', '--bare', '--initial-branch=main', remote]);
  await git(remote, ['config', 'uploadpack.allowFilter', 'true']);
  await git(a, ['remote', 'add', 'origin', `file://${remote}`]);
  await git(a, ['push', 'origin', 'main']);
  await git(root, ['clone', '--no-local', `file://${remote}`, b]);
  await git(b, ['config', 'user.name', 'Fixture']);
  await git(b, ['config', 'user.email', 'fixture@localhost']);
  // Actual create-only server gate in a disposable LOCAL bare remote.
  const hook =
    '#!/bin/sh\nwhile read old new ref; do\n case "$ref" in refs/heads/dock-proposals/*)\n  case "$old" in 0000000000000000000000000000000000000000) ;; *) exit 1 ;; esac\n esac\ndone\n';
  await writeFile(join(remote, 'hooks/pre-receive'), hook, { mode: 0o700 });
  await git(root, ['init', '--bare', '--template=', observation]);
  await git(root, ['init', '--bare', '--template=', otherObservation]);
  db = new SqliteFixtureJournal(join(root, 'journal.sqlite'));
  transport = new FixtureGit();
  repository = {
    repositoryId: 'repo1',
    root: b,
    hostCallerId: 'fixture-host',
    boundaryRevision: 'boundary1',
    active: { resourceIdentity: 'activeB', configIdentity: 'fixture-config1' },
    observation: {
      root: observation,
      resourceIdentity: 'observationB',
      configIdentity: 'fixture-config1',
    },
    endpoint: `file://${remote}`,
    mainRef: 'refs/heads/main',
    verificationScope: 'disposable-local-fixture',
    observedRefs: { 'refs/heads/main': 'refs/dock-observed/repo1/main' },
    policy: {
      revision: 'grant1',
      visibility: (path) =>
        path.startsWith('src/') || path === '.gitignore'
          ? 'content'
          : path.startsWith('metadata/')
            ? 'metadata'
            : 'private',
    },
    maxOutputBytes: 32_768,
    maxTransferBytes: 32_768,
    maxFileBytes: 4096,
    maxViewBytes: 8192,
    maxFiles: 100,
    authorize: async () => true,
  };
  core = new GroupGit(repository, transport, db, views());
});
afterEach(async () => {
  db?.close();
  // Read-only views need write mode restored for fixture cleanup only.
  const writable = async (path: string) => {
    const { readdir, lstat } = await import('node:fs/promises');
    const info = await lstat(path);
    if (info.isDirectory()) {
      await chmod(path, 0o700);
      for (const entry of await readdir(path)) await writable(join(path, entry));
    }
  };
  if (root) {
    await writable(root);
    await rm(root, { recursive: true, force: true });
  }
});

it('fetches allowlisted observations in two clones; preserves HEAD/index/dirty/untracked/private bytes and pinned task base', async () => {
  const initialConfig = await readFile(join(b, '.git/config'));
  await core.observe(mainObserve('initial', base));
  expect(await readFile(join(b, '.git/config'))).toEqual(initialConfig);
  await core.materialize(materialize('pin', 'task1', base, 'task'));
  await writeFile(join(b, 'src/a.txt'), 'staged');
  await git(b, ['add', 'src/a.txt']);
  await writeFile(join(b, 'src/a.txt'), 'unstaged');
  await writeFile(join(b, 'src/draft.txt'), 'untracked');
  await writeFile(join(b, 'ignored.txt'), 'ignored');
  await mkdir(join(b, 'private'));
  await writeFile(join(b, 'private/secret'), 'PRIVATE');
  await mkdir(join(b, 'metadata'));
  await writeFile(join(b, 'metadata/dataset'), 'METADATA');
  const config = await readFile(join(b, '.git/config'));
  const index = await readFile(join(b, '.git/index'));
  const fetchHead = await readFile(join(b, '.git/FETCH_HEAD')).catch(() => null);
  const tip = await advance();
  const result = await core.observe(mainObserve('advance', tip, base));
  expect(result.history).toBe('advanced');
  const latest = await core.materialize(materialize('view', 'latest1', tip));
  expect(latest.baseOid).toBe(tip);
  expect((await views().inspect('task1'))?.baseOid).toBe(base);
  expect(await readFile(join(root, 'views/task1/content/src/a.txt'), 'utf8')).toBe('original\n');
  expect(await readFile(join(root, 'views/latest1/content/src/new.txt'), 'utf8')).toBe(
    'main changes',
  );
  expect(await git(b, ['rev-parse', 'HEAD'])).toBe(base);
  expect(await readFile(join(b, '.git/index'))).toEqual(index);
  expect(await readFile(join(b, '.git/config'))).toEqual(config);
  expect(await git(b, ['config', '--get', 'remote.origin.fetch'])).toBe(
    '+refs/heads/*:refs/remotes/origin/*',
  );
  expect(
    transport.calls
      .filter((c) => c.argv.includes('fetch'))
      .every((c) => c.cwd !== b && c.cwd !== a),
  ).toBe(true);
  expect(await readFile(join(b, '.git/FETCH_HEAD')).catch(() => null)).toEqual(fetchHead);
  for (const [file, expected] of [
    ['src/a.txt', 'unstaged'],
    ['src/draft.txt', 'untracked'],
    ['ignored.txt', 'ignored'],
    ['private/secret', 'PRIVATE'],
    ['metadata/dataset', 'METADATA'],
  ])
    expect(await readFile(join(b, file), 'utf8')).toBe(expected);
  expect(await git(b, ['rev-parse', 'refs/remotes/origin/main'])).toBe(base);
  await git(b, ['fetch', 'origin']); // explicit native user fetch retains normal semantics
  expect(await git(b, ['rev-parse', 'refs/remotes/origin/main'])).toBe(tip);
  expect(await git(b, ['rev-parse', 'HEAD'])).toBe(base);
  expect(await readFile(join(b, '.git/config'))).toEqual(initialConfig);
  const other = new GroupGit(
    {
      ...repository,
      root: a,
      active: { resourceIdentity: 'activeA', configIdentity: 'fixture-config1' },
      observation: {
        root: otherObservation,
        resourceIdentity: 'observationA',
        configIdentity: 'fixture-config1',
      },
    },
    transport,
    db,
    views(),
  );
  expect((await other.observe(mainObserve('other', tip))).oid).toBe(tip);
  expect(await git(a, ['rev-parse', 'HEAD'])).toBe(tip);
  expect(
    transport.calls.some((c) =>
      c.argv.some((arg) => ['reset', 'rebase', 'stash', 'checkout', 'add'].includes(arg)),
    ),
  ).toBe(false);
});

it('reconciles lost fetch acknowledgement and restart using one ID, with exactly one durable outbox event', async () => {
  const tip = await advance();
  transport.lostFetch = true;
  await expect(core.observe(mainObserve('fetch1', tip))).rejects.toThrow('Lost fetch');
  expect(db.operation('fetch1').state).toBe('uncertain');
  db.close();
  db = new SqliteFixtureJournal(join(root, 'journal.sqlite'));
  core = new GroupGit(repository, transport, db, views());
  await core.observe(mainObserve('fetch1', tip));
  await core.observe(mainObserve('fetch1', tip));
  expect(transport.calls.filter((c) => c.argv.includes('fetch'))).toHaveLength(1);
  expect(db.events()).toHaveLength(1);
  await expect(core.observe(mainObserve('fetch1', base))).rejects.toThrow('payload changed');
});

it('reconciles lost immutable-view acknowledgement against its retained manifest even after main advances', async () => {
  await core.observe(mainObserve('fetch1', base));
  let lose = true;
  const backend = views();
  const faulty: ImmutableViews = {
    inspect: (id) => backend.inspect(id),
    create: async (receipt, files) => {
      await backend.create(receipt, files);
      if (lose) {
        lose = false;
        throw new Error('Lost copy acknowledgement');
      }
    },
  };
  core = new GroupGit(repository, transport, db, faulty);
  await expect(core.materialize(materialize('copy1', 'view1', base))).rejects.toThrow('Lost copy');
  const tip = await advance();
  await core.observe(mainObserve('fetch2', tip, base));
  db.close();
  db = new SqliteFixtureJournal(join(root, 'journal.sqlite'));
  core = new GroupGit(repository, transport, db, views());
  expect((await core.materialize(materialize('copy1', 'view1', base))).baseOid).toBe(base);
  expect(db.events().filter((e) => (e as GitEvent).type === 'main-view')).toHaveLength(1);
});

it('detects immutable output tampering and refuses unowned/existing directories', async () => {
  await core.observe(mainObserve('fetch1', base));
  await mkdir(join(root, 'views/unowned'), { recursive: true });
  await expect(core.materialize(materialize('copy1', 'unowned', base))).rejects.toThrow(
    'lacks a view receipt',
  );
  await core.materialize(materialize('copy2', 'view2', base));
  await chmod(join(root, 'views/view2/content/src/a.txt'), 0o600);
  await writeFile(join(root, 'views/view2/content/src/a.txt'), 'tampered');
  await expect(views().inspect('view2')).rejects.toThrow('content changed');
});

it('does not implicitly download huge private blobs, submodule/LFS content, or excluded view resources', async () => {
  const huge = Buffer.alloc(2 * 1024 * 1024, 7);
  await writeFile(join(a, 'huge.bin'), huge);
  await writeFile(join(a, 'private-tracked.txt'), 'SECRET');
  const tip = await advance();
  const hugeOid = await git(a, ['rev-parse', `${tip}:huge.bin`]);
  await core.observe(mainObserve('fetch1', tip));
  await expect(git(observation, ['cat-file', '-e', hugeOid])).rejects.toThrow();
  await core.materialize(materialize('view1', 'main1', tip));
  expect(transport.blobs).toEqual(['.gitignore', 'src/a.txt', 'src/new.txt']);
  expect(JSON.stringify(db.events())).not.toContain('private-tracked');
  expect(JSON.stringify(db.events())).not.toContain('huge.bin');
  expect(await readFile(join(root, 'views/main1/content/huge.bin')).catch(() => null)).toBeNull();
  await expect(core.publishProposal(proposal('publish1', tip))).rejects.toThrow();
  expect(transport.calls.some((c) => c.argv.includes('push'))).toBe(false);
});

it('rejects unsupported filters, transfer quotas, unallowlisted refs and stale observations without fetching', async () => {
  const tip = await advance();
  transport.fetchSafe = false;
  await expect(core.observe(mainObserve('fetch1', tip))).rejects.toThrow('not been verified');
  transport.fetchSafe = true;
  core = new GroupGit({ ...repository, maxTransferBytes: 1 }, transport, db, views());
  await expect(core.observe(mainObserve('fetch2', tip))).rejects.toThrow('quota');
  await expect(
    core.observe({ ...mainObserve('fetch3', tip), remoteRef: 'refs/heads/private' }),
  ).rejects.toThrow('allowlisted');
  await expect(core.observe(mainObserve('fetch4', base))).rejects.toThrow('Remote tip changed');
  expect(
    await git(observation, ['for-each-ref', '--format=%(refname)', 'refs/dock-observed/']),
  ).toBe('');
});

it('tracks byte-sensitive untracked/binary/index/mode edits with stable revisions and durable change-only snapshots', async () => {
  const observer = new GroupGitSnapshots(transport, db);
  const options = snapshotOptions();
  await writeFile(join(b, 'src/draft.bin'), Buffer.from([0, 1, 2]));
  const first = await observer.capture(options);
  expect(first.complete).toBe(true);
  expect(first.untracked).toBe(true);
  const time = await stat(join(b, 'src/draft.bin'));
  await writeFile(join(b, 'src/draft.bin'), Buffer.from([0, 2, 1]));
  await utimes(join(b, 'src/draft.bin'), time.atime, time.mtime);
  const second = await observer.capture(options);
  expect(second.revision).toBe(first.revision + 1);
  const third = await observer.capture(options);
  expect(third.revision).toBe(second.revision);
  await git(b, ['add', 'src/draft.bin']);
  const staged = await observer.capture(options);
  expect(staged.indexDigest).not.toBe(third.indexDigest);
  await chmod(join(b, 'src/draft.bin'), 0o755);
  const mode = await observer.capture(options);
  expect(mode.digest).not.toBe(staged.digest);
  db.close();
  db = new SqliteFixtureJournal(join(root, 'journal.sqlite'));
  expect(db.current('copyB')?.revision).toBe(mode.revision);
  expect(db.events()).toHaveLength(4);
});

it('excludes private/metadata/ignored paths and their bytes from scoped snapshot and intent evidence', async () => {
  const observer = new GroupGitSnapshots(transport, db);
  const first = await observer.capture(snapshotOptions());
  await mkdir(join(b, 'private'));
  await mkdir(join(b, 'metadata'));
  await writeFile(join(b, 'private/secret'), 'NEVER SHARE');
  await writeFile(join(b, 'metadata/data'), 'METADATA BYTES');
  await writeFile(join(b, 'ignored.txt'), 'ignored');
  const second = await observer.capture(snapshotOptions());
  expect(second.digest).toBe(first.digest);
  expect(JSON.stringify(db.events())).not.toContain('NEVER SHARE');
  expect(JSON.stringify(second)).not.toContain('private');
  expect(() =>
    editIntent(
      {
        intentId: 'intent1',
        copyId: 'copyB',
        revision: 1,
        baseOid: base,
        copyRevision: 1,
        paths: ['private/secret'],
        expiresAt: 2000,
        released: false,
      },
      repository.policy,
      1000,
      2000,
    ),
  ).toThrow('not shared');
});

it('keeps prior dirty evidence on incomplete/oversized scans and detects same-length races and writer generation changes', async () => {
  const observer = new GroupGitSnapshots(transport, db);
  await writeFile(join(b, 'src/a.txt'), 'dirty');
  const dirty = await observer.capture(snapshotOptions());
  await writeFile(join(b, 'src/large.bin'), Buffer.alloc(5000));
  const incomplete = await observer.capture(snapshotOptions());
  expect(incomplete.complete).toBe(false);
  expect(incomplete.paths).toContain('src/a.txt');
  expect(incomplete.problems).toContain('limit');
  expect(incomplete.dirty).toBe(true);
  await rm(join(b, 'src/large.bin'));
  const raced = await observer.capture({
    ...snapshotOptions(),
    betweenPasses: async () => {
      await writeFile(join(b, 'src/a.txt'), 'other');
    },
  });
  expect(raced.complete).toBe(false);
  expect(raced.problems).toContain('changed-during-capture');
  expect(raced.revision).toBeGreaterThan(dirty.revision);
  let generation = 1;
  const writer = await observer.capture({
    ...snapshotOptions(),
    writerGeneration: () => generation,
    betweenPasses: async () => {
      generation++;
    },
  });
  expect(writer.complete).toBe(false);
  expect(writer.problems).toContain('changed-during-capture');
});

it('refuses symlink files and symlink ancestors without following private targets', async () => {
  const observer = new GroupGitSnapshots(transport, db);
  await writeFile(join(root, 'outside-secret'), 'OUTSIDE');
  await symlink(join(root, 'outside-secret'), join(b, 'src/link'));
  const link = await observer.capture(snapshotOptions());
  expect(link.complete).toBe(false);
  expect(link.problems).toContain('unsafe-path');
  await rm(join(b, 'src/link'));
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside/secret'), 'OUTSIDE');
  await symlink(join(root, 'outside'), join(b, 'src/linked-dir'));
  const directory = await observer.capture(snapshotOptions());
  expect(directory.complete).toBe(false);
  expect(JSON.stringify(db.events())).not.toContain('OUTSIDE');
});

it('deduplicates cross-copy rename/delete/binary overlap alerts; expiry never clears dirty evidence', async () => {
  const observer = new GroupGitSnapshots(transport, db);
  await git(a, ['mv', 'src/a.txt', 'src/renamed.txt']);
  await writeFile(join(b, 'src/a.txt'), Buffer.from([0, 9, 0]));
  const left = await observer.capture(snapshotOptions('copyA', a));
  const right = await observer.capture(snapshotOptions());
  expect(left.renames).toEqual([['src/a.txt', 'src/renamed.txt']]);
  const alerts = overlapAlerts([right, left], [], 1000);
  expect(alerts).toHaveLength(1);
  expect(alerts[0].paths).toContain('src/a.txt');
  expect(overlapAlerts([left, right], [], 1000)[0].id).toBe(alerts[0].id);
  const intent = editIntent(
    {
      intentId: 'intent1',
      copyId: 'copyB',
      revision: 1,
      baseOid: base,
      copyRevision: right.revision,
      paths: ['src/renamed.txt'],
      expiresAt: 2000,
      released: false,
    },
    repository.policy,
    1000,
    2000,
  );
  expect(overlapAlerts([left, right], [intent], 1500)[0].paths).toContain('src/renamed.txt');
  expect(overlapAlerts([left, right], [intent], 2500)[0].paths).toEqual(['src/a.txt']);
  await rm(join(b, 'src/a.txt'));
  const deleted = await observer.capture(snapshotOptions());
  expect(deleted.paths).toContain('src/a.txt');
  expect(overlapAlerts([left, deleted], [intent], 2500)).toHaveLength(1);
});

it('publishes one reviewed proposal after lost acknowledgement/restart; active concurrent branches and main remain intact', async () => {
  await writeFile(join(b, 'src/proposal.txt'), 'reviewed');
  const source = await commit(b);
  const concurrent = await advance();
  transport.lostPush = true;
  await expect(core.publishProposal(proposal('publication1', source))).rejects.toThrow('Lost push');
  db.close();
  db = new SqliteFixtureJournal(join(root, 'journal.sqlite'));
  core = new GroupGit(repository, transport, db, views());
  const result = await core.publishProposal(proposal('publication1', source));
  await core.publishProposal(proposal('publication1', source));
  expect(transport.calls.filter((c) => c.argv.includes('push'))).toHaveLength(1);
  expect(await git(remote, ['rev-parse', result.ref])).toBe(source);
  expect(await git(remote, ['rev-parse', 'main'])).toBe(concurrent);
  expect(await git(b, ['rev-parse', 'HEAD'])).toBe(source);
  expect(await git(a, ['rev-parse', 'HEAD'])).toBe(concurrent);
  expect(db.events()).toHaveLength(1);
});

it('rejects private deleted history and incomplete history/review grants; no push or shared-main route', async () => {
  await writeFile(join(b, 'secret.txt'), 'PRIVATE HISTORY');
  await commit(b);
  await rm(join(b, 'secret.txt'));
  const source = await commit(b);
  await expect(core.publishProposal(proposal('publication1', source))).rejects.toThrow('ungranted');
  await expect(
    core.publishProposal({
      ...proposal('publication2', source),
      historyGrant: undefined,
    } as unknown as ProposalRequest),
  ).rejects.toThrow('history authorization');
  await expect(
    core.publishProposal({
      ...proposal('publication3', source),
      review: { ...proposal('x', source).review, sourceOid: base },
    }),
  ).rejects.toThrow('authorization');
  expect(transport.calls.some((c) => c.argv.includes('push'))).toBe(false);
  expect('publishMain' in core).toBe(false);
});

it('denies revocation/endpoint/grant changes on retries and refuses unauthorized create-only proposal namespaces', async () => {
  await writeFile(join(b, 'src/proposal.txt'), 'reviewed');
  const source = await commit(b);
  transport.lostPush = true;
  await expect(core.publishProposal(proposal('publication1', source))).rejects.toThrow('Lost push');
  const revoked = new GroupGit(
    { ...repository, authorize: async () => false },
    transport,
    db,
    views(),
  );
  await expect(revoked.publishProposal(proposal('publication1', source))).rejects.toThrow(
    'Authorization changed',
  );
  const moved = new GroupGit(
    { ...repository, endpoint: `file://${join(root, 'other.git')}` },
    transport,
    db,
    views(),
  );
  await expect(moved.publishProposal(proposal('publication1', source))).rejects.toThrow(
    'payload changed',
  );
  const changed = new GroupGit(
    { ...repository, policy: { ...repository.policy, revision: 'grant2' } },
    transport,
    db,
    views(),
  );
  await expect(changed.publishProposal(proposal('publication1', source))).rejects.toThrow(
    'Authorization changed',
  );
  transport.proposalSafe = false;
  await expect(core.publishProposal(proposal('publication2', source))).rejects.toThrow(
    'not been verified',
  );
});

it('blocks a concurrent proposal ref creator with the verified create-only server rule', async () => {
  await writeFile(join(b, 'src/proposal.txt'), 'reviewed');
  const source = await commit(b);
  const request = proposal('publication1', source);
  transport.beforePush = async () => {
    transport.beforePush = undefined;
    await git(a, ['push', 'origin', `${base}:refs/heads/dock-proposals/repo1/publication1`]);
  };
  await expect(core.publishProposal(request)).rejects.toThrow('failed');
  expect(await git(remote, ['rev-parse', 'refs/heads/dock-proposals/repo1/publication1'])).toBe(
    base,
  );
  await expect(core.publishProposal(request)).rejects.toThrow('replay is disabled');
});

it('rejects incomplete LFS/submodule/symlink views without hydration or recursive transfer', async () => {
  await writeFile(
    join(a, 'src/lfs.txt'),
    'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 999999999\n',
  );
  let tip = await commit();
  await git(a, ['push', 'origin', 'main']);
  await core.observe(mainObserve('fetch1', tip));
  await expect(core.materialize(materialize('view1', 'lfs', tip))).rejects.toThrow('LFS');
  await rm(join(a, 'src/lfs.txt'));
  await symlink('../private.txt', join(a, 'src/link'));
  tip = await commit();
  await git(a, ['push', 'origin', 'main']);
  await core.observe(
    mainObserve(
      'fetch2',
      tip,
      db.operation('fetch1').result ? (db.operation('fetch1').result as { oid: string }).oid : base,
    ),
  );
  await expect(core.materialize(materialize('view2', 'symlink', tip))).rejects.toThrow(
    'Symlink/submodule',
  );
  await git(a, ['update-index', '--add', '--cacheinfo', `160000,${base},src/submodule`]);
  await git(a, ['commit', '-m', 'submodule fixture']);
  tip = await git(a, ['rev-parse', 'HEAD']);
  await git(a, ['push', 'origin', 'main']);
  const previous = (db.operation('fetch2').result as { oid: string }).oid;
  await core.observe(mainObserve('fetch3', tip, previous));
  await expect(core.materialize(materialize('view3', 'submodule', tip))).rejects.toThrow(
    'Symlink/submodule',
  );
  expect(
    transport.calls
      .filter((c) => c.argv.includes('fetch'))
      .every((c) => c.argv.includes('--no-recurse-submodules')),
  ).toBe(true);
});

it('reports rewritten observed history without changing either active copy', async () => {
  await core.observe(mainObserve('fetch1', base));
  // A disposable fixture rewrites its bare main directly; the core never force-pushes.
  await git(a, ['checkout', '--orphan', 'fixture-rewritten']);
  await git(a, ['rm', '-rf', '.']);
  await writeFile(join(a, 'src.txt'), 'unrelated');
  const tip = await commit();
  await git(a, ['push', 'origin', `${tip}:refs/heads/fixture-temp`]);
  await git(remote, ['update-ref', 'refs/heads/main', tip, base]);
  const result = await core.observe(mainObserve('fetch2', tip, base));
  expect(result.history).toBe('rewritten');
  expect(await git(b, ['rev-parse', 'HEAD'])).toBe(base);
});

it('coalesces hints, persists stable retry IDs, bounds polling/backoff and rejects reordered settlements', () => {
  const initial: ObservationSchedule = {
    epoch: 'installation1',
    sequence: 1,
    lastAttemptAt: null,
    nextAttemptAt: 0,
    pending: null,
  };
  const candidate = mainObserve('unused', base);
  const planned = planObservation(initial, 1000, candidate);
  expect(planned.request?.operationId).toBe('observe_installation1_1');
  expect(
    planObservation(planned.schedule, 1001, { ...candidate, expectedTip: 'a'.repeat(40) }).request,
  ).toBeNull();
  const uncertain = settleObservation(
    planned.schedule,
    planned.request!.operationId,
    'uncertain',
    2000,
  );
  expect(uncertain.nextAttemptAt).toBeGreaterThanOrEqual(62_000);
  const retried = planObservation(uncertain, uncertain.nextAttemptAt, {
    ...candidate,
    expectedTip: 'a'.repeat(40),
  });
  expect(retried.request).toEqual(planned.request);
  expect(() =>
    settleObservation(retried.schedule, 'other', 'verified', uncertain.nextAttemptAt),
  ).toThrow('Stale');
  const blocked = settleObservation(
    retried.schedule,
    retried.request!.operationId,
    'blocked',
    uncertain.nextAttemptAt,
  );
  expect(
    planObservation(blocked, blocked.nextAttemptAt + 10_000_000, candidate).request,
  ).toBeNull();
  const verified = settleObservation(
    retried.schedule,
    retried.request!.operationId,
    'verified',
    uncertain.nextAttemptAt,
  );
  expect(verified.sequence).toBe(2);
  expect(verified.pending).toBeNull();
});

it('checks explicit history authorization against exact trusted receipts and bounds commit metadata as well as blobs', async () => {
  const guarded = new GroupGit(
    {
      ...repository,
      authorize: async (action, _revision, request) =>
        action !== 'proposal' ||
        ('historyGrant' in request && request.historyGrant.revision === 'trusted-history'),
    },
    transport,
    db,
    views(),
  );
  await expect(guarded.publishProposal(proposal('denied-history', base))).rejects.toThrow(
    'Authorization changed',
  );
  // Large commit metadata is not a content blob but still must not transfer implicitly.
  await git(b, ['commit', '--allow-empty', '-m', 'x'.repeat(40_000)]);
  const source = await git(b, ['rev-parse', 'HEAD']);
  await expect(core.publishProposal(proposal('metadata-quota', source))).rejects.toThrow(
    'History byte limit',
  );
  expect(transport.calls.some((call) => call.argv.includes('push'))).toBe(false);
  expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
});

it('scopes overlap evidence to a repository and never uses stale intent revisions as ownership', async () => {
  const observer = new GroupGitSnapshots(transport, db);
  await writeFile(join(b, 'src/a.txt'), 'dirty');
  await writeFile(join(a, 'src/a.txt'), 'other');
  const left = await observer.capture(snapshotOptions('copyA', a));
  const right = await observer.capture(snapshotOptions());
  expect(overlapAlerts([left, { ...right, repositoryId: 'otherRepo' }], [], 1000)).toEqual([]);
  const stale = editIntent(
    {
      intentId: 'stale',
      copyId: 'copyA',
      revision: 1,
      baseOid: base,
      copyRevision: left.revision + 1,
      paths: ['src/new.txt'],
      expiresAt: 2000,
      released: false,
    },
    repository.policy,
    1000,
    2000,
  );
  expect(overlapAlerts([left, right], [stale], 1500)[0].paths).toEqual(['src/a.txt']);
});

it('detects tracked byte edits even when native assume-unchanged hides the path from Git status', async () => {
  const observer = new GroupGitSnapshots(transport, db);
  await git(b, ['update-index', '--assume-unchanged', 'src/a.txt']);
  await writeFile(join(b, 'src/a.txt'), 'HIDDEN EDIT');
  expect(await git(b, ['status', '--porcelain'])).toBe('');
  const capture = await observer.capture(snapshotOptions());
  expect(capture.complete).toBe(true);
  expect(capture.dirty).toBe(true);
  expect(capture.paths).toContain('src/a.txt');
});

it('requires observed scoped gate records; missing/legacy-boolean adapters and fixture records in production fail closed', async () => {
  const tip = await advance();
  const unverified: GitTransport = {
    run: (call) => transport.run(call),
    observeHostGitBoundary: (request) => transport.observeHostGitBoundary(request),
  };
  await expect(
    new GroupGit(repository, unverified, db, views()).observe(mainObserve('no-adapter', tip)),
  ).rejects.toThrow('not been verified');
  const booleanAdapter: GitTransport = {
    ...unverified,
    observeBloblessGate: async () => true as unknown as GitGateObservation,
  };
  await expect(
    new GroupGit(repository, booleanAdapter, db, views()).observe(
      mainObserve('boolean-adapter', tip),
    ),
  ).rejects.toThrow('not been verified');
  const production = new GroupGit(
    { ...repository, verificationScope: undefined },
    transport,
    db,
    views(),
  );
  await expect(production.observe(mainObserve('production-gate', tip))).rejects.toThrow(
    'not been verified',
  );
  expect(transport.calls.some((call) => call.argv.includes('fetch'))).toBe(false);
  expect(
    () =>
      new GroupGit(
        { ...repository, endpoint: 'https://example.invalid/repository.git' },
        transport,
        db,
        views(),
      ),
  ).toThrow('disposable local');
  await expect(
    new GroupGit(repository, unverified, db, views()).publishProposal(
      proposal('unverified-push', base),
    ),
  ).rejects.toThrow('not been verified');
  await expect(production.publishProposal(proposal('production-push', base))).rejects.toThrow(
    'not been verified',
  );
  expect(transport.calls.some((call) => call.argv.includes('push'))).toBe(false);
  expect(
    (await transport.observeBloblessGate(repository.endpoint, tip, repository.maxTransferBytes))
      ?.mechanism,
  ).toContain('local Git filter probe');
  expect(
    (
      await transport.observeCreateOnlyGate(
        repository.endpoint,
        'refs/heads/dock-proposals/repo1/check',
      )
    )?.mechanism,
  ).toContain('executed disposable pre-receive');
});

it('retains uncertain absent/inaccessible effects across restart and never blindly replays fetch/copy/push', async () => {
  await core.observe(mainObserve('fixture-initial', base));
  const tip = await advance();
  transport.unknownFetch = true;
  const fetch = mainObserve('unknown-fetch', tip, base);
  await expect(core.observe(fetch)).rejects.toThrow('Unknown fetch outcome');
  db.close();
  db = new SqliteFixtureJournal(join(root, 'journal.sqlite'));
  core = new GroupGit(repository, transport, db, views());
  await expect(core.observe(fetch)).rejects.toThrow('replay is disabled');
  expect(
    transport.calls.filter(
      (call) =>
        call.argv.includes('fetch') &&
        call.transfer?.mode === 'blobless' &&
        call.transfer.expectedTip === tip,
    ),
  ).toHaveLength(1);
  expect(db.operation('unknown-fetch').state).toBe('uncertain');
  // The previously observed base remains usable; no new operation retries the unknown fetch.
  let copies = 0;
  const backend = views();
  const unknownView: ImmutableViews = {
    inspect: (id) => backend.inspect(id),
    create: async () => {
      copies++;
      throw new Error('Unknown copy outcome');
    },
  };
  const copying = new GroupGit(repository, transport, db, unknownView);
  const copy = materialize('unknown-copy', 'unknown-view', base);
  await expect(copying.materialize(copy)).rejects.toThrow('Unknown copy outcome');
  await expect(copying.materialize(copy)).rejects.toThrow('replay is disabled');
  expect(copies).toBe(1);
  expect(db.operation('unknown-copy').state).toBe('uncertain');
  transport.unknownPush = true;
  const push = proposal('unknown-push', base);
  await expect(core.publishProposal(push)).rejects.toThrow('Unknown push outcome');
  db.close();
  db = new SqliteFixtureJournal(join(root, 'journal.sqlite'));
  core = new GroupGit(repository, transport, db, views());
  transport.denyRemoteInspection = true;
  await expect(core.publishProposal(push)).rejects.toThrow('inspection unavailable');
  transport.denyRemoteInspection = false;
  await expect(core.publishProposal(push)).rejects.toThrow('replay is disabled');
  expect(transport.calls.filter((call) => call.argv.includes('push'))).toHaveLength(1);
  expect(db.operation('unknown-push').state).toBe('uncertain');
  expect(db.events().filter((event) => (event as GitEvent).type === 'proposal-published')).toEqual(
    [],
  );
});

it('keeps a killed executor lease across SQLite reopen, requires observed child death, and reconciles its running fetch without replay', async () => {
  const tip = await advance();
  const request = mainObserve('crashed-fetch', tip);
  const owner = 'fixture-child-owner';
  db.begin({
    id: request.operationId,
    repositoryId: repository.repositoryId,
    state: 'planned',
    payloadHash: digest([repositoryBinding(repository), ['observe', request]]),
  });
  // Disposable child owns the durable lease, persists running, and executes the exact local
  // Git fetch. SIGKILL deliberately bypasses finally/release to model a real executor crash.
  const program = `
    const { DatabaseSync } = require('node:sqlite');
    const { execFileSync } = require('node:child_process');
    const [file, owner, repository, operation, copy, endpoint, tip] = process.argv.slice(1);
    const sql = new DatabaseSync(file);
    sql.prepare('INSERT INTO leases VALUES (?,?)').run(repository, owner);
    const prior = JSON.parse(sql.prepare('SELECT payload FROM operations WHERE id=?').get(operation).payload);
    prior.state = 'running';
    prior.result = {effectIntent: 'fetch'};
    sql.exec('BEGIN IMMEDIATE');
    sql.prepare('UPDATE operations SET payload=? WHERE id=?').run(JSON.stringify(prior), operation);
    sql.prepare('INSERT INTO transitions(id,state,result) VALUES (?,?,?)').run(operation, 'running', JSON.stringify(prior.result));
    sql.exec('COMMIT');
    execFileSync('git', ['fetch', '--atomic', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
      '--filter=blob:none', endpoint, '+' + tip + ':refs/dock-observed/repo1/main'],
      {cwd: copy, env: process.env, timeout: 15000, maxBuffer: 32768});
    process.send('ready');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(
    process.execPath,
    [
      '-e',
      program,
      join(root, 'journal.sqlite'),
      owner,
      repository.repositoryId,
      request.operationId,
      observation,
      repository.endpoint,
      tip,
    ],
    { env: env(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  const exited = new Promise<string | null>((resolve) =>
    child.on('exit', (_code, signal) => resolve(signal)),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture child readiness timeout')), 5000);
      child.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Fixture child exited before readiness'));
      });
    });
    expect(() => db.recoverDeadFixtureOwner(repository.repositoryId, owner)).toThrow(
      'death not observed',
    );
    await expect(core.observe(request)).rejects.toThrow('UNIQUE');
    expect(transport.calls).toHaveLength(0);
    child.kill('SIGKILL');
    expect(await exited).toBe('SIGKILL');
    db.close();
    db = new SqliteFixtureJournal(join(root, 'journal.sqlite'));
    core = new GroupGit(repository, transport, db, views());
    await expect(core.observe(request)).rejects.toThrow('UNIQUE');
    expect(db.operation(request.operationId).state).toBe('running');
    db.observedDeadOwners.add(owner); // observed executor exit is insufficient alone
    expect(() => db.recoverDeadFixtureOwner(repository.repositoryId, owner)).toThrow('descendant');
    // Child execFileSync returned before readiness; its Git process already exited.
    db.observedQuiescentDescendants.add(owner);
    db.recoverDeadFixtureOwner(repository.repositoryId, owner);
    expect((await core.observe(request)).oid).toBe(tip);
    expect(transport.calls.some((call) => call.argv.includes('fetch'))).toBe(false);
    expect(db.events()).toHaveLength(1);
    expect(await git(b, ['rev-parse', 'HEAD'])).toBe(base);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
}, 15_000);

it('measures actual active-copy filtered-fetch config mutation; core uses a separate registered store', async () => {
  // Reproduction only on this disposable clone; no production copy migration/config edits.
  const before = await readFile(join(b, '.git/config'));
  await git(b, [
    'fetch',
    '--atomic',
    '--no-tags',
    '--no-recurse-submodules',
    '--no-write-fetch-head',
    '--no-auto-maintenance',
    '--filter=blob:none',
    '--',
    repository.endpoint,
    `+${base}:refs/dock-observed/reproduction/main`,
  ]);
  const after = await readFile(join(b, '.git/config'));
  expect(after.equals(before)).toBe(false);
  expect(after.toString()).toContain('promisor = true');
  expect(after.toString()).toContain('partialclonefilter = blob:none');
  expect(await git(b, ['config', 'core.repositoryformatversion'])).toBe('1');
  await core.observe(mainObserve('separate-store', base));
  expect(await readFile(join(b, '.git/config'))).toEqual(after);
  expect(await git(observation, ['rev-parse', 'refs/dock-observed/repo1/main'])).toBe(base);
  expect(
    () =>
      new GroupGit(
        { ...repository, observation: { ...repository.observation, root: b } },
        transport,
        db,
        views(),
      ),
  ).toThrow('Separate');
});

it.each([
  'missing',
  'boolean',
  'fixture',
  'caller',
  'revision',
  'root',
  'endpoint',
  'resource',
  'config',
  'grant',
  'mapping',
  'call',
])(
  'denies %s host boundary records before every production metadata/effect path',
  async (invalid) => {
    const production: GroupRepository = { ...repository, verificationScope: undefined };
    const unsafe: GitTransport = {
      run: (call) => transport.run(call),
      observeHostGitBoundary: async (request) => {
        if (invalid === 'missing') return null;
        if (invalid === 'boolean') return true as unknown as HostGitBoundaryObservation;
        const record: HostGitBoundaryObservation = {
          ...request,
          evidenceId: 'untrusted-test-record',
          mechanism: 'invalid binding canary',
        };
        if (invalid === 'fixture') record.scope = 'disposable-local-fixture';
        const field = {
          caller: 'hostCallerId',
          revision: 'boundaryRevision',
          root: 'root',
          endpoint: 'endpoint',
          resource: 'resourceIdentity',
          config: 'configIdentity',
          grant: 'grantRevision',
          mapping: 'mappingDigest',
          call: 'callDigest',
        }[invalid];
        if (field) (record as unknown as Record<string, string>)[field] = 'changed';
        return record;
      },
    };
    const denied = new GroupGit(production, unsafe, db, views());
    await expect(denied.observe(mainObserve('denied-fetch', base))).rejects.toThrow(
      'Host Git boundary',
    );
    await expect(
      denied.materialize(materialize('denied-view', 'denied-view', base)),
    ).rejects.toThrow('Host Git boundary');
    await expect(denied.publishProposal(proposal('denied-push', base))).rejects.toThrow(
      'Host Git boundary',
    );
    const capture = await new GroupGitSnapshots(unsafe, db).capture({
      ...snapshotOptions(),
      hostGit: { ...snapshotOptions().hostGit, scope: 'production' },
    });
    expect(capture.complete).toBe(false);
    expect(transport.calls).toHaveLength(0);
  },
);

it.each([
  'include',
  'filter',
  'insteadOf',
  'pushInsteadOf',
  'credential',
  'sshCommand',
  'followTags',
  'gitdir',
])(
  'denies hostile disposable %s config/attributes without invoking Git or creating a marker',
  async (vector) => {
    const marker = join(root, 'escape-marker');
    const payload = `touch '${marker}'`;
    const include = join(root, 'hostile-include');
    await writeFile(include, `[filter "escape"]\n clean = ${payload}\n required = true\n`);
    const additions: Record<string, string> = {
      include: `[include]\n path = ${include}\n`,
      filter: `[filter "escape"]\n clean = ${payload}\n required = true\n`,
      insteadOf: `[url "ext::${payload}"]\n insteadOf = file://\n`,
      pushInsteadOf: `[url "ext::${payload}"]\n pushInsteadOf = file://\n`,
      credential: `[credential]\n helper = !${payload}\n`,
      sshCommand: `[core]\n sshCommand = ${payload}\n`,
      followTags: `[push]\n followTags = true\n`,
      gitdir: '',
    };
    await writeFile(join(b, '.gitattributes'), 'src/* filter=escape\n');
    await writeFile(join(b, 'src/a.txt'), 'dirty escape canary');
    for (const path of [join(b, '.git/config'), join(observation, 'config')])
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(additions[vector])]));
    if (vector === 'gitdir') {
      const outside = join(root, 'redirected.git');
      const { rename } = await import('node:fs/promises');
      await rename(join(b, '.git'), outside);
      await writeFile(join(b, '.git'), `gitdir: ${outside}\n`);
    }
    const production = new GroupGit(
      { ...repository, verificationScope: undefined },
      transport,
      db,
      views(),
    );
    await expect(production.observe(mainObserve('hostile-fetch', base))).rejects.toThrow(
      'Host Git boundary',
    );
    await expect(
      production.materialize(materialize('hostile-view', 'hostile', base)),
    ).rejects.toThrow('Host Git boundary');
    await expect(production.publishProposal(proposal('hostile-push', base))).rejects.toThrow(
      'Host Git boundary',
    );
    expect(
      (
        await new GroupGitSnapshots(transport, db).capture({
          ...snapshotOptions(),
          hostGit: { ...snapshotOptions().hostGit, scope: 'production' },
        })
      ).complete,
    ).toBe(false);
    expect(transport.calls).toHaveLength(0);
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('rechecks boundary for each metadata call and passive reconciliation, even after an effect intent', async () => {
  let checks = 0;
  const guarded: GitTransport = {
    run: (call) => transport.run(call),
    observeHostGitBoundary: async (request) =>
      ++checks === 2 ? null : transport.observeHostGitBoundary(request),
  };
  await expect(
    new GroupGit(repository, guarded, db, views()).observe(mainObserve('late-deny', base)),
  ).rejects.toThrow('Host Git boundary');
  expect(transport.calls).toHaveLength(1); // first ref read allowed; ls-remote refused
  transport.calls = [];
  transport.lostFetch = true;
  await expect(core.observe(mainObserve('lost-fetch-boundary', base))).rejects.toThrow(
    'Lost fetch',
  );
  const count = transport.calls.length;
  const passive = new GroupGit(
    { ...repository, verificationScope: undefined },
    transport,
    db,
    views(),
  );
  // Different mapping is refused before recovery. Same mapping with a revoked observer is uncertain.
  await expect(passive.observe(mainObserve('lost-fetch-boundary', base))).rejects.toThrow(
    'payload changed',
  );
  const denied = new GroupGit(repository, { run: (call) => transport.run(call) }, db, views());
  await expect(denied.observe(mainObserve('lost-fetch-boundary', base))).rejects.toThrow(
    'Host Git boundary',
  );
  expect(db.operation('lost-fetch-boundary').state).toBe('uncertain');
  expect(transport.calls).toHaveLength(count);
  transport.calls = [];
  transport.boundaries = [];
  await core.observe(mainObserve('lost-fetch-boundary', base));
  expect(
    transport.calls.every((call) =>
      transport.boundaries.some((boundary) => boundary.callDigest === digest(call)),
    ),
  ).toBe(true);
  expect(transport.calls.some((call) => call.argv.includes('fetch'))).toBe(false);
});

it('recovers offline ls-remote with the same operation ID after reopen and fetches exactly once', async () => {
  const tip = await advance();
  const request = mainObserve('offline-retry', tip);
  transport.denyRemoteInspection = true;
  await expect(core.observe(request)).rejects.toThrow('inspection unavailable');
  expect(db.operation(request.operationId).result).toBeUndefined();
  db.close();
  db = new SqliteFixtureJournal(join(root, 'journal.sqlite'));
  transport.denyRemoteInspection = false;
  const revoked = new GroupGit(
    { ...repository, authorize: async () => false },
    transport,
    db,
    views(),
  );
  await expect(revoked.observe(request)).rejects.toThrow('Authorization changed');
  core = new GroupGit(repository, transport, db, views());
  await core.observe(request);
  await core.observe(request);
  expect(transport.calls.filter((call) => call.argv.includes('fetch'))).toHaveLength(1);
  expect(db.operation(request.operationId).state).toBe('verified');
  expect(db.events()).toHaveLength(1);
});

it('retries pre-intent gate/copy/proposal failures and running-before-intent crash records after reopen', async () => {
  const gate = transport.observeBloblessGate.bind(transport);
  transport.observeBloblessGate = async () => {
    throw new Error('Pre-effect gate unavailable');
  };
  await expect(core.observe(mainObserve('gate-retry', base))).rejects.toThrow('Pre-effect');
  expect(db.operation('gate-retry').result).toBeUndefined();
  transport.observeBloblessGate = gate;
  db.record('gate-retry', 'running'); // executor crashed before an intent; no Git child started
  db.close();
  db = new SqliteFixtureJournal(join(root, 'journal.sqlite'));
  core = new GroupGit(repository, transport, db, views());
  await core.observe(mainObserve('gate-retry', base));
  const read = transport.readApprovedBlob.bind(transport);
  transport.readApprovedBlob = async () => {
    throw new Error('Content read unavailable');
  };
  const view = materialize('pre-copy', 'pre-copy', base);
  await expect(core.materialize(view)).rejects.toThrow('Content read unavailable');
  expect(db.operation('pre-copy').result).toBeUndefined();
  transport.readApprovedBlob = read;
  transport.denyRemoteInspection = true;
  const publish = proposal('pre-push', base);
  await expect(core.publishProposal(publish)).rejects.toThrow('inspection unavailable');
  expect(db.operation('pre-push').result).toBeUndefined();
  db.close();
  db = new SqliteFixtureJournal(join(root, 'journal.sqlite'));
  core = new GroupGit(repository, transport, db, views());
  transport.denyRemoteInspection = false;
  await core.materialize(view);
  await core.publishProposal(publish);
  expect(transport.calls.filter((call) => call.argv.includes('fetch'))).toHaveLength(1);
  expect(transport.calls.filter((call) => call.argv.includes('push'))).toHaveLength(1);
});

it('binds main ref, limits and resource/config mappings to operation IDs; unchanged-tip polls stay quiet', async () => {
  await core.observe(mainObserve('bound-id', base));
  for (const patch of [
    { maxFiles: repository.maxFiles + 1 },
    { maxTransferBytes: repository.maxTransferBytes + 1 },
    { active: { ...repository.active, configIdentity: 'new-config' } },
    { observation: { ...repository.observation, resourceIdentity: 'new-store' } },
    {
      mainRef: 'refs/heads/other',
      observedRefs: {
        ...repository.observedRefs,
        'refs/heads/other': 'refs/dock-observed/repo1/other',
      },
    },
  ])
    await expect(
      new GroupGit({ ...repository, ...patch }, transport, db, views()).observe(
        mainObserve('bound-id', base),
      ),
    ).rejects.toThrow('payload changed');
  await core.observe(mainObserve('unchanged1', base, base));
  await core.observe(mainObserve('unchanged2', base, base));
  await core.observe(mainObserve('unchanged-without-prior', base));
  expect(db.events()).toHaveLength(1);
  expect(db.operation('unchanged2').state).toBe('verified');
});

it('inspects views without mkdir and records definite pre-copy directory refusal as blocked', async () => {
  const absent = join(root, 'absent-view-root');
  expect(
    await new DirectoryGitViews(absent, {
      maxFiles: 2,
      maxFileBytes: 1024,
      maxTotalBytes: 2048,
    }).inspect('absent'),
  ).toBeNull();
  await expect(stat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
  await core.observe(mainObserve('view-main', base));
  await mkdir(join(root, 'views/occupied'), { recursive: true });
  await expect(core.materialize(materialize('occupied', 'occupied', base))).rejects.toThrow(
    'lacks a view receipt',
  );
  expect(db.operation('occupied').state).toBe('blocked');
  expect(db.operation('occupied').result).toBeUndefined();
});

it('does not recover a killed executor lease while its actual descendant Git process survives', async () => {
  const owner = 'surviving-git-owner';
  const release = join(root, 'release-owned-git');
  const program = `
    const {DatabaseSync} = require('node:sqlite');
    const {spawn} = require('node:child_process');
    const [file, owner, copy, release] = process.argv.slice(1);
    const sql = new DatabaseSync(file);
    sql.prepare('INSERT INTO leases VALUES (?,?)').run('repo1', owner);
    const git = spawn('git', ['-c', 'alias.fixture-hold=!f() { while test ! -f "$1"; do sleep 0.05; done; }; f',
      'fixture-hold', release], {cwd: copy, env: process.env, stdio: 'ignore'});
    git.once('spawn', () => process.send({pid: git.pid}));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(
    process.execPath,
    ['-e', program, join(root, 'journal.sqlite'), owner, b, release],
    { env: env(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let gitPid: number | undefined;
  const live = async (pid: number) => {
    try {
      const result = await exec('ps', ['-p', String(pid), '-o', 'stat='], { timeout: 1000 });
      return Boolean(result.stdout.trim()) && !result.stdout.trim().startsWith('Z');
    } catch (error) {
      if ((error as { code?: number }).code === 1) return false;
      throw error;
    }
  };
  try {
    gitPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned descendant readiness timeout')), 5000);
      child.once('message', (message) => {
        clearTimeout(timer);
        resolve((message as { pid: number }).pid);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Executor exited before readiness'));
      });
    });
    expect(await live(gitPid)).toBe(true);
    child.kill('SIGKILL');
    await exited;
    expect(await live(gitPid)).toBe(true);
    db.close();
    db = new SqliteFixtureJournal(join(root, 'journal.sqlite'));
    core = new GroupGit(repository, transport, db, views());
    db.observedDeadOwners.add(owner);
    expect(() => db.recoverDeadFixtureOwner('repo1', owner)).toThrow('descendant');
    await expect(core.observe(mainObserve('still-fenced', base))).rejects.toThrow('UNIQUE');
    expect(transport.calls).toHaveLength(0);
    await writeFile(release, 'finish');
    const deadline = performance.now() + 5000;
    while (await live(gitPid)) {
      if (performance.now() > deadline) throw new Error('Owned Git descendant did not quiesce');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    db.observedQuiescentDescendants.add(owner); // alias shell and sleep exited before Git returned
    db.recoverDeadFixtureOwner('repo1', owner);
    core = new GroupGit(repository, transport, db, views());
    await core.observe(mainObserve('after-quiescence', base));
  } finally {
    await writeFile(release, 'finish');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    if (gitPid && (await live(gitPid))) process.kill(gitPid, 'SIGKILL');
  }
}, 15_000);

it('records a definitely missing source/history object as blocked before publication intent', async () => {
  await expect(core.publishProposal(proposal('missing-source', 'e'.repeat(40)))).rejects.toThrow(
    'available commit',
  );
  expect(db.operation('missing-source').state).toBe('blocked');
  const missingHistory: GitTransport = {
    observeHostGitBoundary: (request) => transport.observeHostGitBoundary(request),
    run: async (call) => {
      if (
        call.argv.some((arg) => arg.startsWith('--batch-check=')) &&
        call.stdin?.toString().trim() !== base
      )
        return Buffer.from(
          `${call.stdin
            ?.toString()
            .trim()
            .split('\n')
            .map((object) => `${object} missing`)
            .join('\n')}\n`,
        );
      return transport.run(call);
    },
  };
  await expect(
    new GroupGit(repository, missingHistory, db, views()).publishProposal(
      proposal('missing-history', base),
    ),
  ).rejects.toThrow('History object unavailable');
  expect(db.operation('missing-history').state).toBe('blocked');
  expect(db.operation('missing-history').result).toBeUndefined();
  expect(transport.calls.some((call) => call.argv.includes('push'))).toBe(false);
});

it('retains a committed verified receipt when the journal acknowledgement itself is lost', async () => {
  const record = db.record.bind(db);
  let lost = false;
  db.record = (id, state, result, event) => {
    record(id, state, result, event);
    if (!lost && state === 'verified') {
      lost = true;
      throw new Error('Lost journal acknowledgement');
    }
  };
  const request = mainObserve('journal-ack', base);
  await expect(core.observe(request)).rejects.toThrow('Lost journal acknowledgement');
  expect(db.operation(request.operationId).state).toBe('verified');
  db.close();
  db = new SqliteFixtureJournal(join(root, 'journal.sqlite'));
  core = new GroupGit(repository, transport, db, views());
  await core.observe(request);
  expect(transport.calls.filter((call) => call.argv.includes('fetch'))).toHaveLength(1);
  expect(db.events()).toHaveLength(1);
});
