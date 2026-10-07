import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  openSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  readFileSync,
  readdirSync,
  chmodSync,
  renameSync,
  fsyncSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync, inflateSync } from 'node:zlib';
import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { groupScopeSchema, type GroupContext } from '@dock/shared';
import { GroupIsolationBlocked } from './group-isolation.js';
import type { GroupNativeExecution } from './group-native-execution.js';
import { nativeGitExportGuest } from './group-native-git-export-guest.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Structurally matches Git candidate8951d2a's owning-host port. No Git peer
 * implementation is copied or imported from a different worktree. */
export const nativeGitExportRequestSchema = z.strictObject({
  exportId: z.uuid(),
  operationId: id,
  repositoryId: id,
  resourceId: id,
  scope: groupScopeSchema,
  grantRevision: id,
  reviewId: id,
  sourceOid: oid,
  historyRevision: id,
  contentPaths: z.array(z.string()).max(10000),
  maxObjects: z.number().int().positive().max(10000),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  maxFileBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024),
});
export type NativeGitExportRequest = z.infer<typeof nativeGitExportRequestSchema>;
const receiptSchema = z.strictObject({
  exportId: z.uuid(),
  requestDigest: hash,
  sourceOid: oid,
  manifestDigest: hash,
  nativeReceiptId: id,
  boundary: z.literal('native-immutable-git-export-v1'),
});
export type NativeGitExportReceipt = z.infer<typeof receiptSchema>;
export interface NativeGitExportLease {
  readonly receipt: NativeGitExportReceipt;
  readonly resource: {
    readonly id: string;
    readonly root: string;
    readonly gitDirectory: string;
    readonly rootIdentity: string;
    readonly gitIdentity: string;
    readonly bare: boolean;
  };
  revalidate(): Promise<NativeGitExportReceipt>;
}
export interface NativeGitExports {
  acquire(request: NativeGitExportRequest): Promise<NativeGitExportLease>;
  inspect(exportId: string): Promise<NativeGitExportLease | null>;
  close(): void;
}
export interface NativeGitExportGrant {
  /** Existing native binding, not an owner anchor or actual provider ID. */
  contextId: string;
  /** Host-selected path in the admitted guest only, never a host filesystem path. */
  guestRepository: string;
  revalidate(): void | Promise<void>;
}
export type NativeGitExportAuthority = (
  request: NativeGitExportRequest,
) => Promise<NativeGitExportGrant>;
export interface NativeGitObject {
  oid: string;
  type: 'commit' | 'tree' | 'blob';
  bytes: Buffer;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const nativeGitDigest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const frame = (object: NativeGitObject) =>
  Buffer.concat([Buffer.from(`${object.type} ${object.bytes.length}\0`), object.bytes]);
export function nativeGitManifest(objects: readonly NativeGitObject[]) {
  return nativeGitDigest(
    [...objects]
      .sort((a, b) => a.oid.localeCompare(b.oid))
      .map((o) => [
        o.oid,
        o.type,
        o.bytes.length,
        createHash('sha256').update(frame(o)).digest('hex'),
      ]),
  );
}
function blocked(reason: string): never {
  throw new GroupIsolationBlocked(`Native Git export denied: ${reason}.`);
}
function contentPath(path: string) {
  if (
    !path ||
    Buffer.byteLength(path) > 4096 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /[\x00-\x1f\x7f]/u.test(path) ||
    path.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')
  )
    blocked('content path');
  return path;
}
export function nativeGitGuestPath(path: string) {
  if (path !== '/workspace') {
    if (!path.startsWith('/workspace/')) blocked('guest resource');
    contentPath(path.slice('/workspace/'.length));
  }
  return path;
}
/** Independent host validation treats guest output as untrusted data. Only the
 * exact reachable closure for the reviewed commit is accepted; no extra object,
 * worktree/index/config/hooks, private historical path or LFS pointer escapes. */
export function validateNativeGitClosure(
  request: NativeGitExportRequest,
  objects: readonly NativeGitObject[],
) {
  if (request.scope.visibility !== 'shared') blocked('private publication');
  const allowed = new Set(request.contentPaths.map(contentPath));
  const map = new Map<string, NativeGitObject>();
  let total = 0;
  for (const object of objects) {
    oid.parse(object.oid);
    if (!['commit', 'tree', 'blob'].includes(object.type) || map.has(object.oid))
      blocked('duplicate/type');
    const bytes = frame(object);
    total += bytes.length;
    if (
      map.size >= request.maxObjects ||
      total > request.maxBytes ||
      (object.type === 'blob' && object.bytes.length > request.maxFileBytes)
    )
      blocked('size');
    if (createHash('sha1').update(bytes).digest('hex') !== object.oid) blocked('object hash');
    if (
      object.type === 'blob' &&
      object.bytes
        .subarray(0, 42)
        .toString()
        .startsWith('version https://git-lfs.github.com/spec/v1')
    )
      blocked('LFS');
    map.set(object.oid, object);
  }
  const reachable = new Set<string>();
  const read = (key: string, type: NativeGitObject['type']) => {
    const object = map.get(oid.parse(key));
    if (!object || object.type !== type) blocked('incomplete/type');
    reachable.add(key);
    return object!;
  };
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const commits = [request.sourceOid],
    seen = new Set<string>(),
    trees = new Set<string>();
  while (commits.length) {
    const current = commits.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const bytes = read(current, 'commit').bytes,
      end = bytes.indexOf('\n\n');
    if (end < 0) blocked('commit');
    const lines = utf8.decode(bytes.subarray(0, end)).split('\n');
    const roots = lines.filter((line) => line.startsWith('tree '));
    if (roots.length !== 1) blocked('commit');
    commits.push(
      ...lines.filter((line) => line.startsWith('parent ')).map((line) => oid.parse(line.slice(7))),
    );
    const pending: Array<[string, string]> = [[oid.parse(roots[0]!.slice(5)), '']];
    while (pending.length) {
      const [tree, prefix] = pending.pop()!,
        key = `${tree}:${prefix}`;
      if (trees.has(key)) continue;
      trees.add(key);
      const data = read(tree, 'tree').bytes,
        names = new Set<string>();
      let offset = 0;
      while (offset < data.length) {
        const space = data.indexOf(32, offset),
          nul = data.indexOf(0, space + 1);
        if (space < offset || nul < space || nul + 21 > data.length) blocked('tree');
        const mode = data.subarray(offset, space).toString('ascii');
        const name = utf8.decode(data.subarray(space + 1, nul));
        if (name.includes('/') || names.has(name)) blocked('tree name');
        names.add(name);
        const path = contentPath(prefix + name),
          child = data.subarray(nul + 1, nul + 21).toString('hex');
        offset = nul + 21;
        if (mode === '40000') {
          if (![...allowed].some((p) => p.startsWith(path + '/'))) blocked('private history');
          pending.push([child, path + '/']);
        } else if (['100644', '100755'].includes(mode)) {
          if (!allowed.has(path)) blocked('private history');
          read(child, 'blob');
        } else blocked('symlink/submodule');
      }
    }
  }
  if (reachable.size !== map.size) blocked('unrelated objects');
  return nativeGitManifest(objects);
}

/** Existing GroupContainer.spawn enforces live admission and owns all children.
 * This helper is fixed public source; request data is stdin, never shell text. */
export async function runNativeGitExport(
  spawn: (argv: readonly string[]) => ChildProcess,
  repository: string,
  request: NativeGitExportRequest,
  admitted: () => void,
) {
  admitted();
  nativeGitExportRequestSchema.parse(request);
  if (request.scope.visibility !== 'shared') blocked('private publication');
  request.contentPaths.forEach(contentPath);
  const child = spawn(['python3', '-c', nativeGitExportGuest, nativeGitGuestPath(repository)]);
  const deadline = setTimeout(() => child.kill('SIGKILL'), 125_000);
  let stopped = false;
  const finished = new Promise<void>((resolve, reject) => {
    child.once('error', () =>
      reject(new GroupIsolationBlocked('Owned Git export process unavailable.')),
    );
    child.once('close', (code) =>
      ((stopped = true), code === 0)
        ? resolve()
        : reject(new GroupIsolationBlocked('Owned Git export validation failed.')),
    );
  });
  void finished.catch(() => {});
  child.stderr?.resume();
  child.stdin?.end(JSON.stringify(request) + '\n');
  if (!child.stdout) blocked('guest stream');
  const iterator = child.stdout![Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  const next = async () => {
    admitted();
    const value = await iterator.next();
    if (value.done) blocked('truncated stream');
    buffer = Buffer.concat([buffer, Buffer.from(value.value)]);
  };
  const line = async () => {
    while (!buffer.includes(10)) {
      if (buffer.length > 4096) blocked('protocol header');
      await next();
    }
    const end = buffer.indexOf(10);
    if (end > 4096) blocked('protocol header');
    const text = buffer.subarray(0, end).toString('utf8');
    buffer = buffer.subarray(end + 1);
    return JSON.parse(text) as unknown;
  };
  const data = async (size: number) => {
    const parts: Buffer[] = [];
    let remaining = size;
    while (remaining) {
      if (!buffer.length) await next();
      const take = Math.min(buffer.length, remaining);
      parts.push(buffer.subarray(0, take));
      buffer = buffer.subarray(take);
      remaining -= take;
    }
    if (!buffer.length) await next();
    if (buffer[0] !== 10) blocked('object framing');
    buffer = buffer.subarray(1);
    return Buffer.concat(parts, size);
  };
  const objectHeader = z.strictObject({
    kind: z.literal('object'),
    oid,
    type: z.enum(['commit', 'tree', 'blob']),
    size: z.number().int().nonnegative(),
  });
  const complete = z.strictObject({
    kind: z.literal('complete'),
    sourceOid: oid,
    manifestDigest: hash,
    objectCount: z.number().int(),
    totalBytes: z.number().int(),
  });
  const objects: NativeGitObject[] = [];
  let total = 0;
  try {
    for (;;) {
      const raw = await line(),
        parsed = objectHeader.safeParse(raw);
      if (parsed.success) {
        const value = parsed.data;
        if (
          objects.length >= request.maxObjects ||
          value.size > request.maxBytes - total ||
          (value.type === 'blob' && value.size > request.maxFileBytes)
        )
          blocked('stream size');
        const bytes = await data(value.size);
        total += Buffer.byteLength(`${value.type} ${bytes.length}\0`) + bytes.length;
        if (total > request.maxBytes) blocked('stream size');
        objects.push({ oid: value.oid, type: value.type, bytes });
        continue;
      }
      const end = complete.safeParse(raw);
      if (!end.success) {
        if (z.object({ kind: z.literal('denied') }).safeParse(raw).success)
          await finished.catch(() => {});
        blocked('guest preflight');
      }
      const manifest = validateNativeGitClosure(request, objects);
      if (
        end.data.sourceOid !== request.sourceOid ||
        end.data.manifestDigest !== manifest ||
        end.data.objectCount !== objects.length ||
        end.data.totalBytes !== total ||
        buffer.length
      )
        blocked('guest attestation');
      const trailing = await iterator.next();
      if (!trailing.done) blocked('trailing bytes');
      await finished;
      admitted();
      return objects;
    }
  } finally {
    clearTimeout(deadline);
    if (!stopped) child.kill('SIGKILL');
  }
}

const resourceSchema = z.strictObject({
  id: z.string(),
  root: z.string(),
  gitDirectory: z.string(),
  rootIdentity: z.string(),
  gitIdentity: z.string(),
  bare: z.literal(true),
});
const proofSchema = z.strictObject({ contextId: z.uuid(), runId: z.uuid(), containerId: hash });
const identity = (path: string) => {
  const s = lstatSync(path, { bigint: true });
  return `${s.dev}:${s.ino}`;
};
function durable(path: string, bytes: string | Buffer, mode = 0o444) {
  const fd = openSync(path, 'wx', mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function immutableDirectory(path: string) {
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid!() ||
    info.mode & 0o222
  )
    blocked('snapshot boundary');
}

/** Host-private append-only attestation and NEW bare snapshots outside guest
 * mounts. Source identity comes from the actual admitted execution callback. */
export function createGroupNativeGitExports(options: {
  directory: string;
  authorize: NativeGitExportAuthority;
  execute: <T>(
    request: NativeGitExportRequest,
    grant: NativeGitExportGrant,
    consume: (execution: GroupNativeExecution) => Promise<T>,
  ) => Promise<T>;
  context: (contextId: string) => GroupContext;
  verifyAdmission: (proof: z.infer<typeof proofSchema>) => void;
}): NativeGitExports {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const root = realpathSync.native(options.directory),
    info = lstatSync(options.directory);
  if (info.isSymbolicLink() || info.uid !== process.getuid!() || info.mode & 0o077)
    blocked('private attestation root');
  const snapshots = join(root, 'snapshots');
  mkdirSync(snapshots, { mode: 0o700, recursive: true });
  const snapshotRoot = lstatSync(snapshots);
  if (
    !snapshotRoot.isDirectory() ||
    snapshotRoot.isSymbolicLink() ||
    snapshotRoot.uid !== process.getuid!() ||
    snapshotRoot.mode & 0o077
  )
    blocked('private snapshot root');
  const database = join(root, 'attestations.sqlite');
  try {
    closeSync(openSync(database, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const saved = lstatSync(database);
  if (
    !saved.isFile() ||
    saved.isSymbolicLink() ||
    saved.uid !== process.getuid!() ||
    saved.mode & 0o077
  )
    blocked('attestation database');
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS ng_intents(export_id TEXT PRIMARY KEY,request_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ng_receipts(export_id TEXT PRIMARY KEY REFERENCES ng_intents(export_id),receipt_json TEXT NOT NULL,resource_json TEXT NOT NULL,proof_json TEXT NOT NULL);
    ${['ng_intents', 'ng_receipts'].flatMap((table) => ['UPDATE', 'DELETE'].map((action) => `CREATE TRIGGER IF NOT EXISTS ${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable native export'); END;`)).join('\n')}`);
  const authorize = async (request: NativeGitExportRequest) => {
    if (request.scope.visibility !== 'shared') blocked('private publication');
    request.contentPaths.forEach(contentPath);
    const grant = await options.authorize(request),
      context = options.context(grant.contextId);
    if (
      context.groupId !== request.scope.groupId ||
      context.memberId !== request.scope.memberId ||
      context.installationId !== request.scope.installationId ||
      context.visibility !== 'shared'
    )
      blocked('context authority');
    nativeGitGuestPath(grant.guestRepository);
    await grant.revalidate();
    return grant;
  };
  const inspect = async (exportId: string): Promise<NativeGitExportLease | null> => {
    z.uuid().parse(exportId);
    const row = db
      .prepare(
        'SELECT i.request_json,r.receipt_json,r.resource_json,r.proof_json FROM ng_intents i JOIN ng_receipts r USING(export_id) WHERE export_id=?',
      )
      .get(exportId);
    if (!row) return null;
    const request = nativeGitExportRequestSchema.parse(JSON.parse(String(row.request_json)));
    const receipt = receiptSchema.parse(JSON.parse(String(row.receipt_json)));
    const resource = resourceSchema.parse(JSON.parse(String(row.resource_json)));
    const proof = proofSchema.parse(JSON.parse(String(row.proof_json)));
    const revalidate = async () => {
      const grant = await authorize(request);
      if (
        grant.contextId !== proof.contextId ||
        receipt.requestDigest !== nativeGitDigest(request) ||
        receipt.sourceOid !== request.sourceOid ||
        resource.root !== join(snapshots, exportId) ||
        resource.gitDirectory !== resource.root ||
        resource.id !== exportId ||
        realpathSync.native(resource.root) !== resource.root ||
        identity(resource.root) !== resource.rootIdentity ||
        resource.rootIdentity !== resource.gitIdentity
      )
        blocked('retained identity');
      options.verifyAdmission(proof);
      immutableDirectory(resource.root);
      const objects: NativeGitObject[] = [];
      const names = readdirSync(resource.root).sort();
      if (JSON.stringify(names) !== JSON.stringify(['HEAD', 'config', 'objects', 'refs']))
        blocked('snapshot controls');
      for (const name of ['HEAD', 'config']) {
        const s = lstatSync(join(resource.root, name));
        if (!s.isFile() || s.isSymbolicLink() || s.mode & 0o222) blocked('snapshot controls');
      }
      if (
        readFileSync(join(resource.root, 'config'), 'utf8') !==
          '[core]\nrepositoryformatversion=0\nbare=true\n[protocol]\nallow=never\n' ||
        readFileSync(join(resource.root, 'HEAD'), 'utf8') !== request.sourceOid + '\n'
      )
        blocked('snapshot controls');
      immutableDirectory(join(resource.root, 'refs'));
      if (readdirSync(join(resource.root, 'refs')).length) blocked('snapshot refs');
      const objectRoot = join(resource.root, 'objects');
      immutableDirectory(objectRoot);
      let total = 0;
      for (const prefix of readdirSync(objectRoot)) {
        if (!/^[a-f0-9]{2}$/.test(prefix)) blocked('snapshot object directory');
        const directory = join(objectRoot, prefix);
        immutableDirectory(directory);
        for (const suffix of readdirSync(directory)) {
          if (!/^[a-f0-9]{38}$/.test(suffix) || objects.length >= request.maxObjects)
            blocked('snapshot objects');
          const file = join(directory, suffix),
            stat = lstatSync(file);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.mode & 0o222 ||
            stat.size > request.maxBytes + 65536
          )
            blocked('snapshot file');
          const decoded = inflateSync(readFileSync(file), {
            maxOutputLength: request.maxBytes - total,
          });
          total += decoded.length;
          const nul = decoded.indexOf(0),
            header = decoded.subarray(0, nul).toString('ascii').split(' ');
          if (
            nul < 0 ||
            header.length !== 2 ||
            !['blob', 'tree', 'commit'].includes(header[0]!) ||
            !/^\d+$/.test(header[1]!) ||
            Number(header[1]) !== decoded.length - nul - 1
          )
            blocked('snapshot object');
          objects.push({
            oid: prefix + suffix,
            type: header[0] as NativeGitObject['type'],
            bytes: decoded.subarray(nul + 1),
          });
        }
      }
      if (validateNativeGitClosure(request, objects) !== receipt.manifestDigest)
        blocked('snapshot manifest');
      await grant.revalidate();
      return receiptSchema.parse(receipt);
    };
    await revalidate();
    return { receipt: Object.freeze(receipt), resource: Object.freeze(resource), revalidate };
  };
  return {
    async acquire(raw) {
      const request = nativeGitExportRequestSchema.parse(raw),
        grant = await authorize(request);
      const prior = db
        .prepare('SELECT request_json FROM ng_intents WHERE export_id=?')
        .get(request.exportId);
      if (prior) {
        if (nativeGitDigest(JSON.parse(String(prior.request_json))) !== nativeGitDigest(request))
          blocked('same-ID request changed');
        const retained = await inspect(request.exportId);
        if (!retained) blocked('uncertain export intent; inspect only, never rerun');
        return retained;
      }
      db.prepare('INSERT INTO ng_intents VALUES (?,?)').run(
        request.exportId,
        JSON.stringify(request),
      );
      await options.execute(request, grant, async (execution) => {
        const proof = proofSchema.parse(execution.gitExportProof());
        if (proof.contextId !== grant.contextId) blocked('admitted context');
        const objects = await execution.exportGitObjects(grant.guestRepository, request);
        const manifestDigest = validateNativeGitClosure(request, objects);
        await grant.revalidate();
        const staging = join(snapshots, request.exportId + '.partial');
        mkdirSync(staging, { mode: 0o700 });
        mkdirSync(join(staging, 'objects'), { mode: 0o700 });
        mkdirSync(join(staging, 'refs'), { mode: 0o555 });
        durable(join(staging, 'HEAD'), request.sourceOid + '\n');
        durable(
          join(staging, 'config'),
          '[core]\nrepositoryformatversion=0\nbare=true\n[protocol]\nallow=never\n',
        );
        for (const object of objects) {
          const directory = join(staging, 'objects', object.oid.slice(0, 2));
          mkdirSync(directory, { mode: 0o700, recursive: true });
          durable(join(directory, object.oid.slice(2)), deflateSync(frame(object)));
        }
        for (const prefix of readdirSync(join(staging, 'objects'))) {
          const path = join(staging, 'objects', prefix);
          syncDirectory(path);
          chmodSync(path, 0o555);
        }
        syncDirectory(join(staging, 'refs'));
        syncDirectory(join(staging, 'objects'));
        chmodSync(join(staging, 'objects'), 0o555);
        syncDirectory(staging);
        chmodSync(staging, 0o555);
        const final = join(snapshots, request.exportId);
        renameSync(staging, final);
        syncDirectory(snapshots);
        const pinned = resourceSchema.parse({
          id: request.exportId,
          root: final,
          gitDirectory: final,
          rootIdentity: identity(final),
          gitIdentity: identity(final),
          bare: true,
        });
        const receipt = receiptSchema.parse({
          exportId: request.exportId,
          requestDigest: nativeGitDigest(request),
          sourceOid: request.sourceOid,
          manifestDigest,
          nativeReceiptId: randomUUID(),
          boundary: 'native-immutable-git-export-v1',
        });
        options.verifyAdmission(proof);
        await grant.revalidate();
        db.prepare('INSERT INTO ng_receipts VALUES (?,?,?,?)').run(
          request.exportId,
          JSON.stringify(receipt),
          JSON.stringify(pinned),
          JSON.stringify(proof),
        );
      });
      return (await inspect(request.exportId)) ?? blocked('completion missing');
    },
    inspect,
    close: () => db.close(),
  };
}
