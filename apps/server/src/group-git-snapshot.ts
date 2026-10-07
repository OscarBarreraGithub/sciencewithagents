import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  digest,
  sharedPath,
  requireHostGitBoundary,
  type HostGitContext,
  type ContentPolicy,
  type GitTransport,
  type GitCall,
} from './group-git.js';

export interface CopySnapshot {
  repositoryId: string;
  copyId: string;
  epoch: string;
  revision: number;
  baseOid: string;
  headOid: string;
  observedMainOid: string;
  writerGeneration: number;
  policyRevision: string;
  digest: string;
  indexDigest: string;
  paths: readonly string[];
  renames: readonly (readonly [string, string])[];
  dirty: boolean;
  untracked: boolean;
  conflicts: boolean;
  complete: boolean;
  problems: readonly ('limit' | 'unsafe-path' | 'unreadable' | 'changed-during-capture')[];
  observedAt: number;
  unsavedAwareness: 'unavailable';
}
export interface SnapshotLedger {
  current(copyId: string): CopySnapshot | null;
  /** Durable exact previous epoch/revision CAS; append observation + change-only outbox atomically.
   * An incomplete snapshot MUST retain prior dirty evidence, as computed by capture(). */
  save(previous: CopySnapshot | null, snapshot: CopySnapshot): void;
}
export interface SnapshotOptions {
  root: string;
  /** Trusted host registration; endpoint and config/resource identity, never client assertions. */
  hostGit: Omit<HostGitContext, 'repositoryId' | 'root' | 'grantRevision' | 'mappingDigest'>;
  repositoryId: string;
  copyId: string;
  epoch: string;
  baseOid: string;
  observedMainOid: string;
  policy: ContentPolicy;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxOutputBytes: number;
  writerGeneration(): number;
  now(): number;
  /** Host test hook / optional scheduling yield, never an authorization hook. */
  betweenPasses?(): Promise<void>;
}
interface Metadata {
  head: string;
  index: string;
  trackedEntries: [string, string, string][];
  paths: string[];
  changed: string[];
  untracked: string[];
  renames: [string, string][];
  conflicts: boolean;
}
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const identity = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);

/** Bounded local observation, never staging or advancing a checkout. Not a sandbox against
 * malicious concurrent directory swaps; invoke only within an enforced approved resource boundary. */
export class GroupGitSnapshots {
  constructor(
    private readonly git: GitTransport,
    private readonly ledger: SnapshotLedger,
  ) {}
  private async metadata(options: SnapshotOptions): Promise<Metadata> {
    const run = async (argv: string[]) => {
      const call: GitCall = {
        cwd: options.root,
        argv: [
          '--no-optional-locks',
          '--no-replace-objects',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'status.renames=true',
          ...argv,
        ],
        timeoutMs: 30_000,
        maxOutputBytes: options.maxOutputBytes,
        environment: { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_LFS_SKIP_SMUDGE: '1' },
      };
      await requireHostGitBoundary(
        this.git,
        {
          ...options.hostGit,
          repositoryId: options.repositoryId,
          root: options.root,
          grantRevision: options.policy.revision,
          mappingDigest: digest([
            options.hostGit,
            options.repositoryId,
            options.copyId,
            options.epoch,
            options.root,
            options.baseOid,
            options.observedMainOid,
            options.policy.revision,
            options.maxFiles,
            options.maxFileBytes,
            options.maxTotalBytes,
            options.maxOutputBytes,
          ]),
        },
        call,
      );
      const value = await this.git.run(call);
      if (value.length > options.maxOutputBytes) throw new Error('limit');
      // Git permits arbitrary filename bytes. Do not collapse invalid UTF-8 into shared identities.
      const text = value.toString('utf8');
      if (!Buffer.from(text).equals(value)) throw new Error('unsafe-path');
      return text;
    };
    const head = oid.parse((await run(['rev-parse', '--verify', 'HEAD'])).trim());
    const stage = (await run(['ls-files', '--stage', '-z'])).split('\0').filter(Boolean);
    const untrackedRaw = (await run(['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean);
    if (stage.length + untrackedRaw.length > options.maxFiles) throw new Error('limit');
    const allowed = (path: string) => {
      if (options.policy.visibility(path) !== 'content') return false;
      sharedPath(path);
      return true;
    };
    const tracked: string[] = [];
    const trackedEntries: [string, string, string][] = [];
    const index: string[] = [];
    let conflicts = false;
    for (const row of stage) {
      const tab = row.indexOf('\t');
      if (tab < 0) throw new Error('unsafe-path');
      const path = row.slice(tab + 1);
      if (!allowed(path)) continue;
      const [mode, object, stageNumber] = row.slice(0, tab).split(' ');
      oid.parse(object);
      if (!['0', '1', '2', '3'].includes(stageNumber)) throw new Error('unsafe-path');
      if (stageNumber !== '0') conflicts = true;
      if (stageNumber === '0') trackedEntries.push([path, object, mode]);
      tracked.push(path);
      index.push(`${mode} ${object} ${stageNumber}\t${path}`);
    }
    const untracked = untrackedRaw.filter(allowed);
    const statuses = (
      await run([
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=no',
        '--ignore-submodules=all',
      ])
    )
      .split('\0')
      .filter(Boolean);
    const changed = new Set<string>();
    const renames: [string, string][] = [];
    for (let i = 0; i < statuses.length; i++) {
      const status = statuses[i].slice(0, 2);
      const path = statuses[i].slice(3);
      const from = /[RC]/.test(status) ? statuses[++i] : undefined;
      if (allowed(path)) changed.add(path);
      if (from && allowed(from)) changed.add(from);
      if (from && allowed(from) && allowed(path)) renames.push([from, path]);
    }
    return {
      head,
      trackedEntries,
      index: digest(index.sort()),
      paths: [...new Set([...tracked, ...untracked])].sort(),
      changed: [...changed].sort(),
      untracked: untracked.sort(),
      renames: renames.sort(),
      conflicts,
    };
  }
  private async file(
    options: SnapshotOptions,
    path: string,
    oidLength: number,
  ): Promise<{ hash: string; bytes: number; objectOid: string | null; mode: string }> {
    sharedPath(path);
    const root = await realpath(options.root);
    if (root !== resolve(options.root)) throw new Error('unsafe-path');
    const absolute = join(root, path);
    const parents: { path: string; ino: bigint; dev: bigint }[] = [];
    let parent = dirname(absolute);
    while (parent !== root) {
      const info = await lstat(parent, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe-path');
      parents.push({ path: parent, ino: info.ino, dev: info.dev });
      parent = dirname(parent);
    }
    let before;
    try {
      before = await lstat(absolute, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { hash: 'deleted', bytes: 0, objectOid: null, mode: 'deleted' };
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('unsafe-path');
    if (before.size > BigInt(options.maxFileBytes)) throw new Error('limit');
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.ino !== before.ino || opened.dev !== before.dev)
        throw new Error('changed-during-capture');
      // A bounded buffer prevents a file growing during read from allocating without limit.
      const buffer = Buffer.alloc(Math.min(Number(before.size) + 1, options.maxFileBytes + 1));
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > options.maxFileBytes) throw new Error('limit');
      const after = await handle.stat({ bigint: true });
      const pathname = await lstat(absolute, { bigint: true });
      if (
        before.ino !== pathname.ino ||
        before.dev !== pathname.dev ||
        opened.size !== after.size ||
        opened.mtimeNs !== after.mtimeNs ||
        opened.ctimeNs !== after.ctimeNs ||
        pathname.isSymbolicLink()
      )
        throw new Error('changed-during-capture');
      for (const directory of parents) {
        const current = await lstat(directory.path, { bigint: true });
        if (
          !current.isDirectory() ||
          current.ino !== directory.ino ||
          current.dev !== directory.dev
        )
          throw new Error('changed-during-capture');
      }
      return {
        hash: createHash('sha256')
          .update(`${after.mode.toString()}\0`)
          .update(buffer.subarray(0, length))
          .digest('hex'),
        bytes: length,
        objectOid: createHash(oidLength === 64 ? 'sha256' : 'sha1')
          .update(`blob ${length}\0`)
          .update(buffer.subarray(0, length))
          .digest('hex'),
        mode: after.mode & BigInt(0o111) ? '100755' : '100644',
      };
    } finally {
      await handle.close();
    }
  }
  async capture(options: SnapshotOptions): Promise<CopySnapshot> {
    identity.parse(options.repositoryId);
    identity.parse(options.copyId);
    identity.parse(options.epoch);
    oid.parse(options.baseOid);
    oid.parse(options.observedMainOid);
    z.number().int().positive().max(10_000).parse(options.maxFiles);
    for (const n of [
      options.maxFiles,
      options.maxFileBytes,
      options.maxTotalBytes,
      options.maxOutputBytes,
    ])
      z.number()
        .int()
        .positive()
        .max(64 * 1024 * 1024)
        .parse(n);
    const previous = this.ledger.current(options.copyId);
    if (
      previous &&
      (previous.epoch !== options.epoch || previous.repositoryId !== options.repositoryId)
    )
      throw new Error('Copy epoch changed; explicit host registration required');
    const generation = z.number().int().nonnegative().parse(options.writerGeneration());
    const problems = new Set<CopySnapshot['problems'][number]>();
    let seenMetadata: Metadata | undefined;
    const pass = async () => {
      const metadata = await this.metadata(options);
      seenMetadata = metadata;
      let total = 0;
      const hashes: [string, string][] = [];
      const indexed = new Map(
        metadata.trackedEntries.map(([path, object, mode]) => [path, { object, mode }]),
      );
      for (const path of metadata.paths) {
        const file = await this.file(options, path, metadata.head.length);
        const entry = indexed.get(path);
        if (entry && (entry.object !== file.objectOid || entry.mode !== file.mode)) {
          metadata.changed = [...new Set([...metadata.changed, path])].sort();
        }
        total += file.bytes;
        if (total > options.maxTotalBytes) throw new Error('limit');
        hashes.push([path, file.hash]);
      }
      return { metadata, hash: digest([metadata, hashes]) };
    };
    let first: Awaited<ReturnType<typeof pass>> | undefined;
    let second: Awaited<ReturnType<typeof pass>> | undefined;
    try {
      first = await pass();
      await options.betweenPasses?.();
      second = await pass();
      if (first.hash !== second.hash || generation !== options.writerGeneration())
        problems.add('changed-during-capture');
    } catch (error) {
      const message = (error as Error).message;
      problems.add(
        ['limit', 'unsafe-path', 'changed-during-capture'].includes(message)
          ? (message as CopySnapshot['problems'][number])
          : 'unreadable',
      );
    }
    const metadata = second?.metadata ?? first?.metadata ?? seenMetadata;
    const complete = problems.size === 0;
    const paths = [
      ...new Set([
        ...(metadata?.changed ?? []),
        ...(metadata?.untracked ?? []),
        ...(!complete ? (previous?.paths ?? []) : []),
      ]),
    ]
      .filter((path) => options.policy.visibility(path) === 'content')
      .sort();
    const renames = [
      ...new Map(
        [...(metadata?.renames ?? []), ...(!complete ? (previous?.renames ?? []) : [])]
          .filter(
            ([from, to]) =>
              options.policy.visibility(from) === 'content' &&
              options.policy.visibility(to) === 'content',
          )
          .map((pair) => [digest(pair), pair] as const),
      ).values(),
    ].sort();
    const content = {
      repositoryId: options.repositoryId,
      copyId: options.copyId,
      epoch: options.epoch,
      baseOid: options.baseOid,
      headOid: metadata?.head ?? previous?.headOid ?? options.baseOid,
      observedMainOid: options.observedMainOid,
      writerGeneration: generation,
      policyRevision: options.policy.revision,
      indexDigest: metadata?.index ?? '',
      byteDigest: second?.hash ?? first?.hash ?? '',
      paths,
      renames,
      dirty: paths.length > 0 || (!complete && (previous?.dirty ?? false)),
      untracked: Boolean(metadata?.untracked.length || (!complete && previous?.untracked)),
      conflicts: Boolean(metadata?.conflicts || (!complete && previous?.conflicts)),
      complete,
      problems: [...problems].sort(),
    };
    const hash = digest(content);
    const { byteDigest: _byteDigest, ...publicContent } = content;
    const snapshot: CopySnapshot = {
      ...publicContent,
      digest: hash,
      revision: previous?.digest === hash ? previous.revision : (previous?.revision ?? 0) + 1,
      observedAt: options.now(),
      unsavedAwareness: 'unavailable',
    };
    this.ledger.save(previous, snapshot);
    return snapshot;
  }
}

export interface EditIntent {
  intentId: string;
  copyId: string;
  revision: number;
  baseOid: string;
  copyRevision: number;
  paths: readonly string[];
  expiresAt: number;
  released: boolean;
}
export function editIntent(
  input: EditIntent,
  policy: ContentPolicy,
  now: number,
  maxTtlMs: number,
): EditIntent {
  identity.parse(input.intentId);
  identity.parse(input.copyId);
  oid.parse(input.baseOid);
  z.number().int().nonnegative().parse(input.revision);
  z.number().int().positive().parse(input.copyRevision);
  z.number().int().positive().max(300_000).parse(maxTtlMs);
  if (
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= now ||
    input.expiresAt > now + maxTtlMs ||
    input.paths.length > 256
  )
    throw new Error('Invalid advisory expiry or path count');
  for (const path of input.paths) {
    sharedPath(path);
    if (policy.visibility(path) !== 'content') throw new Error('Intent path is not shared content');
  }
  return { ...input, paths: [...new Set(input.paths)].sort() };
}
export interface OverlapAlert {
  id: string;
  copies: readonly [string, string];
  revisions: readonly [number, number];
  paths: readonly string[];
  bases: readonly [string, string];
  sameBase: boolean;
  evidence: 'advisory';
  incomplete: boolean;
}
/** Caller atomically inserts alert ID in durable outbox. No model wake-up or ownership claim. */
export function overlapAlerts(
  snapshots: readonly CopySnapshot[],
  intents: readonly EditIntent[],
  now: number,
): OverlapAlert[] {
  const copies = [...snapshots].sort((a, b) => a.copyId.localeCompare(b.copyId));
  if (new Set(copies.map((c) => c.copyId)).size !== copies.length)
    throw new Error('Duplicate copy snapshot');
  const alerts: OverlapAlert[] = [];
  for (let i = 0; i < copies.length; i++)
    for (let j = i + 1; j < copies.length; j++) {
      const a = copies[i];
      const b = copies[j];
      if (a.repositoryId !== b.repositoryId) continue;
      const active = (copy: CopySnapshot) =>
        intents.filter(
          (intent) =>
            intent.copyId === copy.copyId &&
            !intent.released &&
            intent.expiresAt > now &&
            intent.copyRevision === copy.revision &&
            intent.baseOid === copy.baseOid,
        );
      const aIntents = active(a);
      const bIntents = active(b);
      const paths = (copy: CopySnapshot, live: EditIntent[]) =>
        new Set([...copy.paths, ...copy.renames.flat(), ...live.flatMap((v) => v.paths)]);
      const aPaths = paths(a, aIntents);
      const bPaths = paths(b, bIntents);
      const common = [...aPaths].filter((path) => bPaths.has(path)).sort();
      if (!common.length) continue;
      const evidence = [
        a.repositoryId,
        a.copyId,
        a.epoch,
        a.revision,
        b.copyId,
        b.epoch,
        b.revision,
        common,
        [...aIntents, ...bIntents].map((v) => [v.intentId, v.revision]).sort(),
      ];
      alerts.push({
        id: `overlap_${digest(evidence)}`,
        copies: [a.copyId, b.copyId],
        revisions: [a.revision, b.revision],
        paths: common,
        bases: [a.baseOid, b.baseOid],
        sameBase: a.baseOid === b.baseOid,
        evidence: 'advisory',
        incomplete: !a.complete || !b.complete,
      });
    }
  return alerts;
}
