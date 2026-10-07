import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:https';
import { connect } from 'node:net';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  chmod,
  readdir,
  lstat,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { GroupScope } from '@dock/shared';
import { GroupEventRepository } from './group-events.js';
import { GroupGitService, type GitGrant } from './group-git-service.js';
import {
  GitHubGitEndpoint,
  createGitHubWire,
  githubRepository,
  type GitHubBinding,
} from './group-git-github.js';
import {
  gitObjectManifest,
  metadataClosure,
  type GitObject,
  type ObjectBudget,
} from './group-git-endpoint.js';
import { digest } from './group-git.js';
import { pinGitResource } from './group-git-host-files.js';
import type { GitNativeExports, GitNativeExportLease } from './group-git-native-export.js';
import { pack, unpack } from './group-git-pack.js';

const exec = promisify(execFile);
const bin = '/opt/homebrew/bin/git';
const env = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  LANG: 'C',
};
const git = async (cwd: string, ...args: string[]) =>
  (await exec(bin, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const binding: GitHubBinding = {
  accountId: '42',
  repositoryNumericId: '7',
  repositoryNodeId: 'R_fixture',
  fullName: 'owner/repo',
};
const budget = (remaining = 4 * 1024 * 1024): ObjectBudget => ({
  remaining,
  objects: 0,
  maxObjects: 1000,
  deadline: Date.now() + 30000,
});
let root: string,
  active: string,
  remote: string,
  host: string,
  tip: string,
  server: Server,
  port: number;
let accountId = 42,
  repoId = 7,
  offline = false,
  lostAck = false,
  requests: string[] = [];
let events: GroupEventRepository,
  service: GroupGitService,
  scope: GroupScope,
  grant: GitGrant,
  rid: string;
let leases: Map<string, GitNativeExportLease>;
let corruptReceipt = false,
  corruptUpload = false,
  redirect = false,
  unsafeNative = false;
const nativeExports: GitNativeExports = {
  async acquire(request) {
    // Controlled source owner port only; not production native/guest acceptance.
    const commits = (await git(active, 'rev-list', request.sourceOid)).split('\n');
    for (const commit of unsafeNative ? [] : commits) {
      const rows = (await git(active, 'ls-tree', '-r', commit)).split('\n');
      for (const row of rows) {
        const [meta, path] = row.split('\t');
        const [mode, type, oid] = meta.split(' ');
        if (
          !request.contentPaths.includes(path) ||
          type !== 'blob' ||
          !['100644', '100755'].includes(mode)
        )
          throw new Error('History contains ungranted content');
        const size = Number(await git(active, 'cat-file', '-s', oid));
        if (size > request.maxFileBytes) throw new Error('History byte limit');
        if (
          (await git(active, 'cat-file', 'blob', oid)).startsWith(
            'version https://git-lfs.github.com/spec/v1',
          )
        )
          throw new Error('LFS history');
      }
    }
    const directory = join(root, request.exportId);
    await git(root, 'init', '--bare', '--template=', directory);
    const data = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(bin, ['pack-objects', '--stdout', '--revs'], { cwd: active, env });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (p: Buffer) => chunks.push(p));
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (c) =>
        c === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('Fixture pack')),
      );
      child.stdin.end(request.sourceOid + '\n');
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ['index-pack', '--stdin'], { cwd: directory, env });
      child.stdout.resume();
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (c) => (c === 0 ? resolve() : reject(new Error('Fixture index'))));
      child.stdin.end(data);
    });
    const receipt = {
      exportId: request.exportId,
      requestDigest: corruptReceipt ? '0'.repeat(64) : digest(request),
      sourceOid: request.sourceOid,
      manifestDigest: gitObjectManifest(unpack(data, request.maxBytes, request.maxObjects)),
      nativeReceiptId: 'controlled-native',
      boundary: 'native-immutable-git-export-v1' as const,
    };
    const lease = {
      receipt,
      resource: await pinGitResource(request.exportId, directory, true),
      revalidate: async () => receipt,
    };
    leases.set(request.exportId, lease);
    return lease;
  },
  async inspect(id) {
    return leases.get(id) ?? null;
  },
};
let wire: ReturnType<typeof createGitHubWire>;
const identity = { resolve: async () => ({ token: 'fixture-native-token', accountId: '42' }) };
const endpoint = () =>
  new GitHubGitEndpoint(
    'github',
    'https://github.com/owner/repo.git',
    binding,
    identity,
    async () => {},
    wire,
  );
async function open() {
  service = await GroupGitService.open({
    hostRoot: host,
    gitExecutable: bin,
    events,
    githubIdentity: async () => identity,
    githubWire: wire,
    nativeExports,
  });
}
const access = () => service.authority.issue(scope);
async function review(sourceOid = tip) {
  service.authority.review({
    id: 'review',
    repositoryId: rid,
    sourceOid,
    grantRevision: 'v1',
    historyGrantId: 'history',
    historyRevision: 'h1',
    historySourceOid: sourceOid,
    historyTargetOid: null,
    approved: true,
  });
}
const propose = (operationId = 'publish', proposalId = 'proposal') =>
  service.propose(access(), rid, {
    operationId,
    proposalId,
    reviewId: 'review',
    historyGrantId: 'history',
  });
async function state() {
  const result: Record<string, string> = {};
  for (const p of [
    '.git/HEAD',
    '.git/index',
    '.git/config',
    '.git/info/exclude',
    'shared.txt',
    'staged.txt',
    'untracked.txt',
    'ignored.txt',
    'private.txt',
  ]) {
    try {
      result[p] = (await readFile(join(active, p))).toString('base64');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return result;
}
beforeEach(async () => {
  accountId = 42;
  repoId = 7;
  offline = false;
  lostAck = false;
  requests = [];
  leases = new Map();
  corruptReceipt = false;
  corruptUpload = false;
  redirect = false;
  unsafeNative = false;
  await mkdir('data/group-git-github-tests', { recursive: true });
  root = await realpath(await mkdtemp(resolve('data/group-git-github-tests/case-')));
  active = join(root, 'active');
  remote = join(root, 'owner/repo.git');
  host = join(root, 'host');
  await mkdir(active);
  await mkdir(join(root, 'owner'));
  await git(active, 'init', '--initial-branch=main', '--template=');
  await git(active, 'config', 'user.name', 'Fixture');
  await git(active, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(active, 'shared.txt'), 'shared reviewed\n');
  await git(active, 'add', 'shared.txt');
  await git(active, 'commit', '-m', 'reviewed\n\noriginal commit');
  tip = await git(active, 'rev-parse', 'HEAD');
  await git(root, 'clone', '--bare', '--no-hardlinks', active, remote);
  await git(remote, 'config', 'http.receivepack', 'true');
  await git(remote, 'config', 'uploadpack.allowFilter', 'true');
  await git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  await writeFile(join(active, 'shared.txt'), 'dirty shared\n');
  await writeFile(join(active, 'staged.txt'), 'staged\n');
  await git(active, 'add', 'staged.txt');
  await writeFile(join(active, 'private.txt'), 'private editor\n');
  await writeFile(join(active, 'untracked.txt'), 'untracked\n');
  await writeFile(join(active, 'ignored.txt'), 'ignored\n');
  await mkdir(join(active, '.git/info'), { recursive: true });
  await writeFile(join(active, '.git/info/exclude'), 'ignored.txt\n');
  await exec(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(root, 'key.pem'),
      '-out',
      join(root, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=github.com',
      '-addext',
      'subjectAltName=DNS:github.com,DNS:api.github.com',
    ],
    { timeout: 10000 },
  );
  server = createServer(
    { key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) },
    async (req, res) => {
      const path = req.url!;
      requests.push(`${req.method} ${path}`);
      if (offline) {
        req.socket.destroy();
        return;
      }
      if (redirect) {
        res.writeHead(302, { Location: 'https://evil.invalid/token' });
        res.end();
        return;
      }
      const api = req.headers.host === 'api.github.com';
      const expected = api
        ? 'Bearer fixture-native-token'
        : `Basic ${Buffer.from('x-access-token:fixture-native-token').toString('base64')}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (api) {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            path === '/user'
              ? { id: accountId }
              : { id: repoId, node_id: 'R_fixture', full_name: 'owner/repo' },
          ),
        );
        return;
      }
      const parsed = new URL(path, 'https://github.com');
      const child = spawn(bin, ['http-backend'], {
        env: {
          ...env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          REMOTE_USER: 'fixture',
          PATH_INFO: parsed.pathname,
          QUERY_STRING: parsed.search.slice(1),
          REQUEST_METHOD: req.method!,
          CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
          CONTENT_LENGTH: String(req.headers['content-length'] ?? ''),
          SERVER_PROTOCOL: 'HTTP/1.1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      req.pipe(child.stdin);
      child.stdin.on('error', () => {});
      const chunks: Buffer[] = [];
      child.stdout.on('data', (part: Buffer) => chunks.push(part));
      child.stderr.resume();
      child.on('close', () => {
        if (lostAck && path.endsWith('/git-receive-pack')) {
          lostAck = false;
          req.socket.destroy();
          return;
        }
        const bytes = Buffer.concat(chunks),
          split = bytes.indexOf(Buffer.from('\r\n\r\n'));
        if (corruptUpload && path.endsWith('/git-upload-pack')) {
          const start = bytes.indexOf(Buffer.from('PACK'), split);
          if (start >= 0) bytes[start + 12] ^= 1;
        }
        const headers = bytes.subarray(0, split).toString();
        let status = 200;
        for (const line of headers.split('\r\n')) {
          const colon = line.indexOf(':');
          if (colon < 0) continue;
          const name = line.slice(0, colon),
            value = line.slice(colon + 1).trim();
          if (name === 'Status') status = parseInt(value);
          else res.setHeader(name, value);
        }
        res.writeHead(status);
        res.end(bytes.subarray(split + 4));
      });
    },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  wire = createGitHubWire({
    dial: () => connect(port, '127.0.0.1'),
    ca: await readFile(join(root, 'cert.pem'), 'utf8'),
  });
  events = new GroupEventRepository(join(root, 'events.sqlite'));
  const member = events.createGroup('Fixture');
  const context = events.createContext({
    groupId: member.groupId,
    memberId: member.memberId,
    installationId: member.installationId,
    visibility: 'shared',
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
  scope = {
    groupId: context.groupId,
    memberId: context.memberId,
    installationId: context.installationId,
    visibility: 'shared',
    source: {
      sessionId: context.sessionId,
      provider: context.provider,
      nativeSessionId: context.nativeSessionId,
      messageId: randomUUID(),
    },
    causalRefs: [],
  };
  await open();
  const registered = await service.register({
    activeRoot: active,
    resourceId: 'resource',
    grantId: 'grant',
    executorId: 'host',
    endpointId: 'github',
    endpoint: { kind: 'github', url: 'https://github.com/owner/repo.git', binding },
  });
  rid = registered.repositoryId;
  grant = {
    id: 'grant',
    revision: 'v1',
    groupId: scope.groupId,
    memberId: scope.memberId,
    installationId: scope.installationId,
    repositoryId: rid,
    resourceId: 'resource',
    endpointId: 'github',
    executorId: 'host',
    metadata: true,
    paths: { 'shared.txt': 'content' },
    active: true,
  };
  service.authority.grant(grant);
});
afterEach(async () => {
  service?.close();
  events?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (root) {
    const unlock = async (path: string): Promise<void> => {
      const info = await lstat(path);
      if (info.isDirectory()) {
        await chmod(path, 0o700);
        for (const name of await readdir(path)) await unlock(join(path, name));
      }
    };
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  }
});

it('selects ordinary canonical GitHub URLs and rejects browser-style alternate origins/secrets', () => {
  expect(githubRepository('https://github.com/owner/repo.git').fullName).toBe('owner/repo');
  for (const url of [
    'http://github.com/owner/repo.git',
    'https://user:secret@github.com/owner/repo.git',
    'https://github.com.evil/owner/repo.git',
    'https://github.com/owner/repo.git?token=x',
    'https://github.com/owner/repo',
    'https://github.com/../repo.git',
  ])
    expect(() => githubRepository(url)).toThrow();
});
it('observes exact production packs and materializes only selected blobs while preserving every active byte', async () => {
  const before = await state();
  const observed = await service.tick(access(), rid, 100000);
  expect(observed.observedVersion).toBe(tip);
  await service.materialize(access(), rid, {
    operationId: 'view',
    viewId: 'view',
    version: tip,
    kind: 'task',
  });
  expect(await readFile(join(host, rid, 'views/view/content/shared.txt'), 'utf8')).toBe(
    'shared reviewed\n',
  );
  expect(await state()).toEqual(before);
  expect(requests.some((r) => r.includes('/owner/repo.git/git-upload-pack'))).toBe(true);
  expect(requests.some((r) => r.includes('/group-git/v1'))).toBe(false);
});
it('binds the actual authenticated account, canonical repository and current resource grant', async () => {
  accountId = 99;
  await expect(endpoint().ref('refs/heads/main', budget())).rejects.toThrow('identity changed');
  accountId = 42;
  repoId = 99;
  await expect(endpoint().ref('refs/heads/main', budget())).rejects.toThrow('identity changed');
  repoId = 7;
  service.authority.grant({ ...grant, active: false });
  await expect(service.tick(access(), rid)).rejects.toThrow('grant denied');
  expect(requests.filter((r) => r.includes('upload-pack'))).toHaveLength(0);
});
it('bounds ciphertext including TLS handshakes, decoded bytes, object count and validates pack hashes', async () => {
  await expect(endpoint().ref('refs/heads/main', budget(128))).rejects.toThrow();
  const e = endpoint(),
    b = budget();
  await e.ref('refs/heads/main', b);
  const objects = await metadataClosure(e, tip, b);
  expect(objects.every((o) => o.type !== 'blob')).toBe(true);
  expect(b.remaining).toBeLessThan(
    4 * 1024 * 1024 - objects.reduce((n, o) => n + o.bytes.length, 0),
  );
  const encoded = pack(objects);
  encoded[encoded.length - 1] ^= 1;
  expect(() => unpack(encoded, 100000, 100)).toThrow();
  expect(() => unpack(pack(objects), 1, 100)).toThrow();
  expect(() => unpack(pack(objects), 100000, 1)).toThrow();
});
it('creates only a new reviewed proposal through the actual receive-pack zero-old-SHA command', async () => {
  const before = await state();
  await review();
  const result = await propose();
  expect(result.oid).toBe(tip);
  expect(await git(remote, 'rev-parse', result.ref)).toBe(tip);
  expect(await git(remote, 'rev-parse', 'main')).toBe(tip);
  expect(await state()).toEqual(before);
  await expect(propose('other-id')).rejects.toThrow('already exists');
});
it('reconciles a lost acknowledgement after restart using the exact ID without a second POST', async () => {
  await review();
  lostAck = true;
  await expect(propose()).rejects.toThrow();
  const count = requests.filter((r) => r === 'POST /owner/repo.git/git-receive-pack').length;
  expect(count).toBe(1);
  service.close();
  await open();
  const result = await propose();
  expect(result.oid).toBe(tip);
  expect(requests.filter((r) => r === 'POST /owner/repo.git/git-receive-pack')).toHaveLength(count);
  service.authority.grant({ ...grant, revision: 'v2' });
  await expect(propose()).rejects.toThrow();
});
it('retains the same offline observation plan across restart and preserves dirty bytes', async () => {
  const before = await state();
  offline = true;
  await expect(service.tick(access(), rid, 100000)).rejects.toThrow();
  service.close();
  await open();
  offline = false;
  expect((await service.tick(access(), rid, 200000)).observedVersion).toBe(tip);
  expect(await state()).toEqual(before);
});
it('excludes private deleted history and metadata-only blobs before any receive-pack request', async () => {
  // Fixture preparation only: commit a secret in history then delete it from the tip.
  await git(active, 'reset', '--mixed', 'HEAD');
  await writeFile(join(active, 'secret.txt'), 'historic secret');
  await git(active, 'add', 'secret.txt');
  await git(active, 'commit', '-m', 'private ancestor');
  await git(active, 'rm', 'secret.txt');
  await git(active, 'commit', '-m', 'delete secret');
  const source = await git(active, 'rev-parse', 'HEAD');
  await review(source);
  await expect(propose()).rejects.toThrow('ungranted content');
  expect(requests.filter((r) => r.includes('receive-pack'))).toHaveLength(0);
});
it('denies metadata-only history before acquiring any export or remote publication', async () => {
  const source = tip;
  service.authority.grant({ ...grant, revision: 'v2', paths: { 'shared.txt': 'metadata' } });
  service.authority.review({
    id: 'review2',
    repositoryId: rid,
    sourceOid: source,
    grantRevision: 'v2',
    historyGrantId: 'history',
    historyRevision: 'h2',
    historySourceOid: source,
    historyTargetOid: null,
    approved: true,
  });
  await expect(
    service.propose(access(), rid, {
      operationId: 'meta',
      proposalId: 'meta',
      reviewId: 'review2',
      historyGrantId: 'history',
    }),
  ).rejects.toThrow('ungranted content');
});
it('enforces simultaneous create-only races in the actual Git protocol server', async () => {
  const source = await exec(bin, ['cat-file', 'commit', tip], {
    cwd: active,
    env,
    encoding: 'buffer',
  });
  const commit: GitObject = { type: 'commit', oid: tip, bytes: source.stdout };
  const tree = await git(active, 'rev-parse', `${tip}^{tree}`);
  const blob = await git(active, 'rev-parse', `${tip}:shared.txt`);
  const objects = [
    commit,
    ...(await Promise.all(
      [
        ['tree', tree],
        ['blob', blob],
      ].map(async ([type, oid]) => ({
        type: type as 'tree' | 'blob',
        oid,
        bytes: (await exec(bin, ['cat-file', type, oid], { cwd: active, env, encoding: 'buffer' }))
          .stdout,
      })),
    )),
  ];
  const ref = 'refs/heads/dock-proposals/r/race',
    a = endpoint(),
    b = endpoint();
  expect(await a.createOnlyMechanism(ref, budget())).toBeTruthy();
  expect(await b.createOnlyMechanism(ref, budget())).toBeTruthy();
  const results = await Promise.allSettled([
    a.create(ref, tip, objects, budget()),
    b.create(ref, tip, objects, budget()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await git(remote, 'rev-parse', ref)).toBe(tip);
});

it('requires a source-bound immutable export receipt and refuses native intent replay', async () => {
  await review();
  corruptReceipt = true;
  await expect(propose()).rejects.toThrow('receipt/request changed');
  expect(requests.filter((r) => r.includes('receive-pack'))).toHaveLength(0);
  service.close();
  await open();
  leases.clear();
  await expect(propose()).rejects.toThrow('Uncertain native export');
  await expect(propose('new-id')).rejects.toThrow('retain same ID');
});

it('preserves non-UTC and signed commit headers byte-for-byte through observation and publication', async () => {
  const original = (
    await exec(bin, ['cat-file', 'commit', tip], { cwd: active, env, encoding: 'buffer' })
  ).stdout;
  const bytes = Buffer.from(
    original
      .toString()
      .replace(/(author [^\n]+) [+-]\d{4}\n/, '$1 -0700\n')
      .replace(
        /(committer [^\n]+) [+-]\d{4}\n\n/,
        '$1 +0530\ngpgsig -----BEGIN PGP SIGNATURE-----\n fixture-invalid-signature-for-byte-preservation\n -----END PGP SIGNATURE-----\n\n',
      ),
  );
  const write = async (cwd: string) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(bin, ['hash-object', '-w', '--stdin', '-t', 'commit'], { cwd, env });
      const parts: Buffer[] = [];
      child.stdout.on('data', (part: Buffer) => parts.push(part));
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve(Buffer.concat(parts).toString().trim())
          : reject(new Error('Fixture commit')),
      );
      child.stdin.end(bytes);
    });
  const oid = await write(active);
  expect(await write(remote)).toBe(oid);
  await git(remote, 'update-ref', 'refs/heads/main', oid);
  const e = endpoint();
  expect(await e.ref('refs/heads/main', budget())).toBe(oid);
  expect((await e.object(oid, budget())).bytes).toEqual(bytes);
  await review(oid);
  expect((await propose()).oid).toBe(oid);
});

it('denies LFS source history before publication', async () => {
  await writeFile(
    join(active, 'shared.txt'),
    'version https://git-lfs.github.com/spec/v1\noid sha256:' +
      '0'.repeat(64) +
      '\nsize 100000000\n',
  );
  await git(active, 'add', 'shared.txt');
  await git(active, 'commit', '-m', 'LFS pointer');
  const lfs = await git(active, 'rev-parse', 'HEAD');
  await review(lfs);
  await expect(propose()).rejects.toThrow('LFS');
  expect(requests.filter((r) => r.includes('receive-pack'))).toHaveLength(0);
});

it('never hydrates LFS or metadata-only content during a selected view', async () => {
  await writeFile(
    join(active, 'shared.txt'),
    'version https://git-lfs.github.com/spec/v1\noid sha256:' +
      '0'.repeat(64) +
      '\nsize 100000000\n',
  );
  await git(active, 'add', 'shared.txt');
  await git(active, 'commit', '-m', 'LFS');
  const oid = await git(active, 'rev-parse', 'HEAD');
  await git(active, 'push', '--no-verify', remote, 'HEAD:main');
  expect((await service.tick(access(), rid, 100000)).observedVersion).toBe(oid);
  await expect(
    service.materialize(access(), rid, {
      operationId: 'lfs-view',
      viewId: 'lfs-view',
      version: oid,
      kind: 'task',
    }),
  ).rejects.toThrow('LFS');
  service.authority.grant({ ...grant, revision: 'v2', paths: { 'shared.txt': 'metadata' } });
  const before = requests.filter((r) => r.startsWith('POST')).length;
  await service.materialize(access(), rid, {
    operationId: 'metadata-view',
    viewId: 'metadata-view',
    version: oid,
    kind: 'task',
  });
  expect(requests.filter((r) => r.startsWith('POST'))).toHaveLength(before);
});

it('denies submodule history before exporting or contacting receive-pack', async () => {
  await git(active, 'update-index', '--add', '--cacheinfo', `160000,${tip},module`);
  await git(active, 'commit', '-m', 'submodule');
  const oid = await git(active, 'rev-parse', 'HEAD');
  await review(oid);
  await expect(propose()).rejects.toThrow('ungranted content');
  expect(requests.filter((r) => r.includes('receive-pack'))).toHaveLength(0);
  expect(leases.size).toBe(0);
});
it('denies large ungranted artifacts before exporting or contacting receive-pack', async () => {
  await writeFile(join(active, 'shared.txt'), Buffer.alloc(1024 * 1024 + 1, 7));
  await git(active, 'add', 'shared.txt');
  await git(active, 'commit', '-m', 'large');
  const oid = await git(active, 'rev-parse', 'HEAD');
  await review(oid);
  await expect(propose()).rejects.toThrow('byte limit');
  expect(requests.filter((r) => r.includes('receive-pack'))).toHaveLength(0);
  expect(leases.size).toBe(0);
});
it('keeps an offline post-intent proposal uncertain without replay or a new-ID bypass', async () => {
  await review();
  const original = wire;
  const failAfterIntent: typeof wire = async (request, budget) => {
    if (request.method === 'POST' && request.url.pathname.endsWith('git-receive-pack'))
      throw new Error('Fixture offline before unknown send');
    return original(request, budget);
  };
  service.close();
  service = await GroupGitService.open({
    hostRoot: host,
    gitExecutable: bin,
    events,
    githubIdentity: async () => identity,
    githubWire: failAfterIntent,
    nativeExports,
  });
  await expect(propose()).rejects.toThrow('offline');
  service.close();
  await open();
  await expect(propose()).rejects.toThrow('replay is disabled');
  await expect(propose('another')).rejects.toThrow('uncertain effect');
  expect(requests.filter((r) => r === 'POST /owner/repo.git/git-receive-pack')).toHaveLength(0);
});
it('requires the native object manifest to match before a remote effect intent', async () => {
  await review();
  const original = nativeExports.acquire;
  const wrong: GitNativeExports = {
    inspect: nativeExports.inspect,
    acquire: async (request) => {
      const lease = await original(request);
      const receipt = { ...lease.receipt, manifestDigest: '0'.repeat(64) };
      return { ...lease, receipt, revalidate: async () => receipt };
    },
  };
  service.close();
  service = await GroupGitService.open({
    hostRoot: host,
    gitExecutable: bin,
    events,
    githubIdentity: async () => identity,
    githubWire: wire,
    nativeExports: wrong,
  });
  await expect(propose()).rejects.toThrow('manifest mismatch');
  expect(service.journal.operation('publish')?.result ?? {}).not.toHaveProperty('effectIntent');
  expect(requests.filter((r) => r.includes('receive-pack'))).toHaveLength(0);
});

it('rejects corrupted production pack responses, per-blob overflow, absent filter capabilities and redirects', async () => {
  const e = endpoint();
  await e.ref('refs/heads/main', budget());
  corruptUpload = true;
  await expect(e.object(tip, budget())).rejects.toThrow('bounded Git pack');
  corruptUpload = false;
  const blob = await git(active, 'rev-parse', `${tip}:shared.txt`);
  const cap = budget();
  cap.maxObjectBytes = 1;
  await expect(endpoint().object(blob, cap, 'blob')).rejects.toThrow();
  await git(remote, 'config', 'uploadpack.allowFilter', 'false');
  await expect(endpoint().object(tip, budget())).rejects.toThrow('partial fetch capability');
  redirect = true;
  await expect(endpoint().ref('refs/heads/main', budget())).rejects.toThrow('redirects');
});
it('independently refuses private native source history before a remote effect even if its export port is defective', async () => {
  await git(active, 'reset', '--mixed', 'HEAD');
  await writeFile(join(active, 'secret.txt'), 'private history');
  await git(active, 'add', 'secret.txt');
  await git(active, 'commit', '-m', 'secret');
  const source = await git(active, 'rev-parse', 'HEAD');
  await review(source);
  unsafeNative = true;
  await expect(propose()).rejects.toThrow('ungranted content');
  expect(leases.size).toBe(1);
  expect(requests.filter((r) => r.includes('receive-pack'))).toHaveLength(0);
});
it('revalidates grant revocation after transfer and before observation mutation', async () => {
  const original = wire;
  const revoked: typeof wire = async (input, budget) => {
    const reply = await original(input, budget);
    if (input.method === 'POST' && input.url.pathname.endsWith('git-upload-pack'))
      service.authority.grant({ ...grant, active: false });
    return reply;
  };
  service.close();
  service = await GroupGitService.open({
    hostRoot: host,
    gitExecutable: bin,
    events,
    githubIdentity: async () => identity,
    githubWire: revoked,
    nativeExports,
  });
  const before = await state();
  await expect(service.tick(access(), rid, 100000)).rejects.toThrow('grant denied');
  expect(await state()).toEqual(before);
  expect(service.journal.get(`observed:${rid}`)).toBeNull();
});
