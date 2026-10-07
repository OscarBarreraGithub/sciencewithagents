import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
  rmSync,
  readdirSync,
  lstatSync,
  chmodSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { groupScopeSchema, type GroupContext } from '@dock/shared';
import {
  createGroupNativeGitExports,
  nativeGitExportRequestSchema,
  nativeGitDigest,
  runNativeGitExport,
  validateNativeGitClosure,
  type NativeGitExportRequest,
} from './group-native-git-export.js';
import { nativeGitExportGuest } from './group-native-git-export-guest.js';
import { GroupNativeExecution } from './group-native-execution.js';
import { GroupNativeJournal } from './group-native.js';
import { GroupEventRepository } from './group-events.js';
import { Store } from './store.js';
import type { GroupContainer } from './group-container.js';

let root: string, repository: string, tip: string, scope: NativeGitExportRequest['scope'];
let env: Record<string, string>;
const git = (...argv: string[]) =>
  execFileSync('/usr/bin/git', argv, {
    cwd: repository,
    env,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
beforeEach(() => {
  mkdirSync('data/tests', { recursive: true });
  root = realpathSync.native(mkdtempSync('data/tests/native-git-export-'));
  repository = join(root, 'source');
  mkdirSync(repository);
  mkdirSync(join(root, 'empty-home'));
  env = {
    PATH: '/usr/bin:/bin',
    HOME: join(root, 'empty-home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_AUTHOR_NAME: 'Public canary',
    GIT_AUTHOR_EMAIL: 'canary@example.invalid',
    GIT_COMMITTER_NAME: 'Public canary',
    GIT_COMMITTER_EMAIL: 'canary@example.invalid',
  };
  git('init', '--quiet', '--template=');
  writeFileSync(join(repository, 'public.txt'), 'committed public canary\n');
  git('add', 'public.txt');
  git('commit', '--quiet', '-m', 'public canary');
  tip = git('rev-parse', 'HEAD');
  scope = groupScopeSchema.parse({
    groupId: randomUUID(),
    memberId: randomUUID(),
    installationId: randomUUID(),
    visibility: 'shared',
    source: {
      sessionId: randomUUID(),
      nativeSessionId: randomUUID(),
      provider: 'owner',
      messageId: randomUUID(),
    },
    causalRefs: [],
  });
});
afterEach(() => {
  const writable = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) writable(join(path, entry));
  };
  writable(root);
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function request(overrides: Partial<NativeGitExportRequest> = {}) {
  return nativeGitExportRequestSchema.parse({
    exportId: randomUUID(),
    operationId: 'public-op',
    repositoryId: 'repository',
    resourceId: 'resource',
    scope,
    grantRevision: 'grant-v1',
    reviewId: 'review',
    sourceOid: tip,
    historyRevision: 'history-v1',
    contentPaths: ['public.txt'],
    maxObjects: 100,
    maxBytes: 1024 * 1024,
    maxFileBytes: 65536,
    ...overrides,
  });
}
/** Actual public Git/Python compatibility canary, with an explicitly substituted
 * synthetic local path. This does NOT prove a guest, QUARK or OS boundary. */
function publicSpawn(argv: readonly string[]) {
  expect(argv.slice(0, 3)).toEqual(['python3', '-c', nativeGitExportGuest]);
  expect(argv[3]).toBe('/workspace');
  return spawn('/usr/bin/python3', ['-c', nativeGitExportGuest, repository], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
it('actual public helper exports exact packed complete parent history, excludes dirty bytes and ignores hostile hooks/config', async () => {
  writeFileSync(join(repository, 'public.txt'), 'second committed value\n');
  git('add', 'public.txt');
  git('commit', '--quiet', '-m', 'second');
  tip = git('rev-parse', 'HEAD');
  git('gc', '--quiet');
  writeFileSync(join(repository, 'public.txt'), 'ACTIVE DIRTY BYTES MUST NEVER EXPORT\n');
  git('add', 'public.txt'); // A staged index is still not the reviewed commit.
  const hook = join(repository, '.git/hooks/post-checkout');
  mkdirSync(join(repository, '.git/hooks'), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\ntouch ' + join(root, 'hook-ran') + '\n', { mode: 0o700 });
  writeFileSync(
    join(repository, '.git/config'),
    '[include]\npath=/missing/config\n[core]\nrepositoryformatversion=0\n',
  );
  const admitted = vi.fn(),
    input = request();
  const objects = await runNativeGitExport(publicSpawn, '/workspace', input, admitted);
  expect(objects.filter((o) => o.type === 'commit')).toHaveLength(2);
  const text = objects.filter((o) => o.type === 'blob').map((o) => o.bytes.toString());
  expect(text).toEqual(
    expect.arrayContaining(['committed public canary\n', 'second committed value\n']),
  );
  expect(text.join('')).not.toContain('ACTIVE DIRTY');
  expect(readdirSync(root)).not.toContain('hook-ran');
  expect(validateNativeGitClosure(input, objects)).toMatch(/^[a-f0-9]{64}$/);
  expect(admitted).toHaveBeenCalled();
});

it('actual public helper supports bare sources and exports the reviewed ancestor rather than current refs', async () => {
  const reviewed = tip;
  writeFileSync(join(repository, 'future-private.txt'), 'unreviewed synthetic future bytes');
  git('add', 'future-private.txt');
  git('commit', '--quiet', '-m', 'future private fixture');
  const bare = join(root, 'bare-source');
  execFileSync(
    '/usr/bin/git',
    ['clone', '--quiet', '--bare', '--no-hardlinks', '--template=', repository, bare],
    { env, stdio: 'pipe' },
  );
  repository = bare;
  const objects = await runNativeGitExport(
    publicSpawn,
    '/workspace',
    request({ sourceOid: reviewed }),
    () => {},
  );
  expect(objects.filter((o) => o.type === 'commit')).toHaveLength(1);
  expect(objects.filter((o) => o.type === 'blob').map((o) => o.bytes.toString())).toEqual([
    'committed public canary\n',
  ]);
});

it.each([
  'deleted-private',
  'lfs',
  'symlink',
  'submodule',
  'bytes',
  'objects',
  'file',
  'alternates',
] as const)(
  'actual guest program denies %s before the first object crosses stdout',
  async (kind) => {
    let input = request();
    if (kind === 'deleted-private') {
      writeFileSync(join(repository, 'private.txt'), 'synthetic private historical bytes');
      git('add', 'private.txt');
      git('commit', '--quiet', '-m', 'private');
      git('rm', '--quiet', 'private.txt');
      git('commit', '--quiet', '-m', 'delete');
      input = request({ sourceOid: git('rev-parse', 'HEAD') });
    } else if (kind === 'lfs') {
      writeFileSync(
        join(repository, 'public.txt'),
        'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n',
      );
      git('add', 'public.txt');
      git('commit', '--quiet', '-m', 'lfs');
      input = request({ sourceOid: git('rev-parse', 'HEAD') });
    } else if (kind === 'symlink') {
      rmSync(join(repository, 'public.txt'));
      symlinkSync('missing-public-target', join(repository, 'public.txt'));
      git('add', 'public.txt');
      git('commit', '--quiet', '-m', 'symlink');
      input = request({ sourceOid: git('rev-parse', 'HEAD') });
    } else if (kind === 'submodule') {
      git('update-index', '--cacheinfo', `160000,${tip},public.txt`);
      git('commit', '--quiet', '-m', 'submodule');
      input = request({ sourceOid: git('rev-parse', 'HEAD') });
    } else if (kind === 'bytes') input = request({ maxBytes: 1 });
    else if (kind === 'objects') input = request({ maxObjects: 1 });
    else if (kind === 'file') input = request({ maxFileBytes: 1 });
    else {
      mkdirSync(join(repository, '.git/objects/info'), { recursive: true });
      writeFileSync(join(repository, '.git/objects/info/alternates'), '/ungranted/objects\n');
    }
    const child = publicSpawn(['python3', '-c', nativeGitExportGuest, '/workspace']);
    child.stderr!.resume();
    child.stdin!.end(JSON.stringify(input) + '\n');
    const output: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => output.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(code).toBe(1);
    const denied = JSON.parse(Buffer.concat(output).toString());
    expect(denied).toMatchObject({ kind: 'denied' });
    expect(Object.keys(denied).sort()).toEqual(['kind', 'reason']);
  },
);

it('independent host verifier rejects ungranted parents, extra objects and altered object bytes', async () => {
  const input = request(),
    objects = await runNativeGitExport(publicSpawn, '/workspace', input, () => {});
  expect(() => validateNativeGitClosure({ ...input, contentPaths: [] }, objects)).toThrow(
    /private history/,
  );
  const blob = { type: 'blob' as const, bytes: Buffer.from('unrelated public fixture'), oid: '' };
  blob.oid = createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${blob.bytes.length}\0`), blob.bytes]))
    .digest('hex');
  expect(() => validateNativeGitClosure(input, [...objects, blob])).toThrow(/unrelated objects/);
  expect(() =>
    validateNativeGitClosure(
      input,
      objects.map((o) => (o.type === 'blob' ? { ...o, bytes: Buffer.from('altered') } : o)),
    ),
  ).toThrow(/object hash/);
});

it('durably freezes a new read-only bare snapshot and attestation, same-ID recovery never reacquires guest bytes', async () => {
  const events = new GroupEventRepository(join(root, 'events.sqlite')),
    journal = new GroupNativeJournal(join(root, 'identities.sqlite'), events),
    store = new Store(join(root, 'store.sqlite'));
  const group = events.createGroup('Export public fixture'),
    project = store.register(repository, 'Public', '');
  const handle = journal.issue(
    {
      groupId: group.groupId,
      memberId: group.memberId,
      installationId: group.installationId,
      visibility: 'shared',
    },
    project.managerId,
    'codex',
  );
  const context = journal.resolve(handle).context;
  scope = groupScopeSchema.parse({
    ...scope,
    groupId: context.groupId,
    memberId: context.memberId,
    installationId: context.installationId,
  });
  const input = request(),
    run = store.enqueue(project.managerId, randomUUID(), 'Public unit capability');
  // Transport fixture only: actual GroupNativeExecution.exportGitObjects is
  // exercised, but no Engine/admission/privacy claim is made by this callback.
  const container = {
    id: 'a'.repeat(64),
    spawn: publicSpawn,
    close: async () => {},
  } as unknown as GroupContainer;
  const execution = new GroupNativeExecution(
    container,
    store.agent(project.managerId),
    store,
    run.id,
    journal,
    handle,
    () => {},
  );
  let revoked = false;
  const grant = {
    contextId: context.sessionId,
    guestRepository: '/workspace',
    revalidate: async () => {
      if (revoked) throw new Error('revoked');
    },
  };
  const execute = vi.fn(
    async (
      _request: NativeGitExportRequest,
      _grant: unknown,
      consume: (value: GroupNativeExecution) => Promise<unknown>,
    ) => consume(execution),
  );
  const options = {
    directory: join(root, 'private-exports'),
    authorize: async () => grant,
    context: () => context,
    verifyAdmission: vi.fn(),
    execute: execute as Parameters<typeof createGroupNativeGitExports>[0]['execute'],
  };
  let port = createGroupNativeGitExports(options);
  try {
    const lease = await port.acquire(input);
    expect(lease.receipt.requestDigest).toBe(nativeGitDigest(input));
    expect(lease.resource.bare).toBe(true);
    expect(lease.resource.root).not.toBe(repository);
    expect(lstatSync(lease.resource.root).mode & 0o222).toBe(0);
    const exported = execFileSync(
      '/usr/bin/git',
      ['--git-dir=' + lease.resource.root, 'cat-file', 'blob', tip + ':public.txt'],
      { env, encoding: 'utf8' },
    );
    expect(exported).toBe('committed public canary\n');
    writeFileSync(join(repository, 'public.txt'), 'active source changed after export');
    port.close();
    port = createGroupNativeGitExports(options);
    const retained = await port.inspect(input.exportId);
    expect(retained?.receipt).toEqual(lease.receipt);
    expect((await port.acquire(input)).receipt).toEqual(lease.receipt);
    expect(execute).toHaveBeenCalledOnce();
    await expect(port.acquire({ ...input, sourceOid: 'b'.repeat(40) })).rejects.toThrow(/same-ID/);
    revoked = true;
    await expect(retained!.revalidate()).rejects.toThrow(/revoked/);
    revoked = false;
    chmodSync(join(lease.resource.root, 'HEAD'), 0o644);
    await expect(retained!.revalidate()).rejects.toThrow(/snapshot controls/);
  } finally {
    port.close();
    await execution.close();
    journal.close();
    events.close();
    store.close();
  }
});

it('unknown intent is inspect-only after restart and private/mismatched grants export no bytes', async () => {
  const input = request(),
    context = {
      ...scope,
      sessionId: randomUUID(),
      nativeSessionId: randomUUID(),
      provider: 'codex',
    } as unknown as GroupContext;
  const consume = vi.fn(async () => {
    throw new Error('uncertain owned guest transport');
  });
  const options = {
    directory: join(root, 'private-exports'),
    authorize: async () => ({
      contextId: context.sessionId,
      guestRepository: '/workspace',
      revalidate: () => {},
    }),
    context: () => context,
    verifyAdmission: () => {},
    execute: consume,
  };
  let port = createGroupNativeGitExports(options);
  try {
    await expect(port.acquire(input)).rejects.toThrow(/uncertain/);
    port.close();
    port = createGroupNativeGitExports(options);
    expect(await port.inspect(input.exportId)).toBeNull();
    await expect(port.acquire(input)).rejects.toThrow(/inspect only/);
    expect(consume).toHaveBeenCalledOnce();
    await expect(
      port.acquire({
        ...input,
        exportId: randomUUID(),
        scope: { ...scope, visibility: 'private' },
      }),
    ).rejects.toThrow(/private/);
    await expect(
      port.acquire({
        ...input,
        exportId: randomUUID(),
        scope: { ...scope, memberId: groupScopeSchema.shape.memberId.parse(randomUUID()) },
      }),
    ).rejects.toThrow(/context authority/);
    expect(consume).toHaveBeenCalledOnce();
  } finally {
    port.close();
  }
});
