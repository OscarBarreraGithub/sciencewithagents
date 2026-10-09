import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  GROUP_DOCUMENT_LIMITS as limits,
  groupDocumentManifestSchema,
  groupDocumentNameSchema,
  type GroupDocumentManifest,
} from '@dock/shared/dist/group-documents.js';
import type { GroupHost } from './group-host.js';
import type { GroupHostNativeRecord } from './group-host-native-journal.js';
import type {
  GroupHostNativeCompletion,
  GroupHostNativeWorkspaceProof,
} from './group-native-host-runtime.js';
import type { GroupDocumentsNative, GroupDocumentsAuthority } from './group-documents-native.js';
import { GroupDocumentCaptureError } from './group-documents-native.js';
import { groupDocumentVersion } from './group-documents.js';
import { publicationCanonical } from './group-publication-protocol.js';
import { privateGroupFile, protectGroupSidecars } from './group-host-storage.js';
import { Conflict } from './store.js';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const equal = (a: unknown, b: unknown) => publicationCanonical(a) === publicationCanonical(b);
const helper = fileURLToPath(
  new URL('../../../runtime/group-native/group-documents-host-capture.py', import.meta.url),
);

/** Only links in the exact completed reply, relative to the server-selected workspace.
 * Absolute native links are accepted only when they name that same workspace. */
export function hostDocumentResultNames(text: string, workspace: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)\s*\)/g)) {
    let value = match[1]!.replace(/^<|>$/g, '');
    try {
      if (value.startsWith('file://')) {
        const url = new URL(value);
        if (url.hostname && url.hostname !== 'localhost') continue;
        value = url.pathname;
      }
      value = decodeURIComponent(value);
      if (!/\.(tex|pdf)$/i.test(value)) continue;
      if (value.startsWith('/')) value = relative(workspace, value);
      else if (/^[a-z]+:/i.test(value)) continue;
      const parsed = groupDocumentNameSchema.safeParse(value);
      if (parsed.success) names.push(parsed.data);
    } catch {
      /* A link confers no authority. */
    }
  }
  if (!names.length) return [];
  for (const match of text.matchAll(/<!--\s*group-document-inputs:\s*(\[[\s\S]{0,8192}?\])\s*-->/g))
    names.push(...z.array(groupDocumentNameSchema).max(limits.files).parse(JSON.parse(match[1]!)));
  const unique = [...new Set(names)];
  if (unique.length > limits.files) throw new Conflict('Too many report inputs.');
  return unique;
}

/** Fixed isolated Python performs descriptor-relative reads on macOS and Linux.
 * This reads bytes only: it never evaluates TeX, runs a model or invokes a compiler. */
export function captureHostDocumentFiles(workspace: string, names: string[], identity?: string) {
  const output = spawnSync('python3', ['-I', '-B', helper], {
    input: JSON.stringify({ workspace, names, ...(identity ? { identity } : {}) }),
    encoding: 'utf8',
    timeout: 5_000,
    killSignal: 'SIGKILL',
    maxBuffer: 12 * 1024 ** 2,
    env: { PATH: process.env.PATH, LANG: 'C' },
    windowsHide: true,
  });
  if (output.error || output.status !== 0)
    throw new Conflict(
      'Exact report capture is unavailable; Python 3 and regular workspace inputs are required.',
    );
  const parsed = z
    .strictObject({
      files: z
        .array(
          z.strictObject({ name: groupDocumentNameSchema, base64: z.string().max(12 * 1024 ** 2) }),
        )
        .min(1)
        .max(limits.files),
    })
    .parse(JSON.parse(output.stdout));
  const files = parsed.files.map((file) => ({
    name: file.name,
    content: Buffer.from(file.base64, 'base64'),
  }));
  if (
    files.reduce((n, file) => n + file.content.length, 0) > limits.bytes ||
    new Set(files.map((file) => file.name)).size !== files.length
  )
    throw new Conflict('Report capture exceeds the exact input limit.');
  return files;
}

type Capture = {
  manifest: GroupDocumentManifest;
  requestDigest: string;
  resultDigest: string;
  runId: string;
  workspace: string;
};
/** Dedicated capture journal, never the personal Library or arbitrary browser paths.
 * Completed bytes and failed capture identities survive retries/restart. A missed
 * completion is never recreated from later mutable working files. No host TeX build. */
export class GroupHostNativeDocuments implements GroupDocumentsNative {
  private readonly db: DatabaseSync;
  private readonly workspaceRoot: string;
  private authority?: GroupDocumentsAuthority;
  private closed = false;
  private readonly captures = new Map<string, Promise<void>>();
  constructor(
    private readonly host: GroupHost,
    private readonly completionWorkspace?: (
      completion: GroupHostNativeCompletion,
    ) => GroupHostNativeWorkspaceProof,
  ) {
    this.workspaceRoot = join(realpathSync.native(host.directory), 'host-workspaces');
    mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
    if (lstatSync(this.workspaceRoot).isSymbolicLink())
      throw new Conflict('Regular group workspace root required.');
    const path = join(host.directory, 'host-native-documents.sqlite');
    privateGroupFile(path);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS hnd_intents(result_id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL UNIQUE,input TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hnd_results(result_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hnd_files(result_id TEXT NOT NULL,artifact_id TEXT NOT NULL,body BLOB NOT NULL,PRIMARY KEY(result_id,artifact_id));
      CREATE TABLE IF NOT EXISTS hnd_exports(key TEXT PRIMARY KEY,input TEXT NOT NULL,receipt_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hnd_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,result_id TEXT NOT NULL,kind TEXT NOT NULL);
      ${['hnd_intents', 'hnd_results', 'hnd_files', 'hnd_exports', 'hnd_events'].flatMap((table) => ['UPDATE', 'DELETE'].map((action) => `CREATE TRIGGER IF NOT EXISTS ${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable report capture'); END;`)).join('\n')}`);
    protectGroupSidecars(path);
  }
  documents(authority: GroupDocumentsAuthority): GroupDocumentsNative {
    if (this.authority) throw new Conflict('Report authority already registered.');
    this.authority = authority;
    return this;
  }
  documentAvailable(resultId: string): boolean {
    return (
      !this.closed &&
      Boolean(this.db.prepare('SELECT 1 FROM hnd_results WHERE result_id=?').get(resultId))
    );
  }
  documentCaptureState(
    resultId: string,
    selected?: GroupHostNativeRecord,
  ): 'pending' | 'unavailable' | undefined {
    if (this.closed) return 'pending';
    if (this.documentAvailable(resultId)) return undefined;
    // Polling already has the exact retained record; do not scan the request journal per reply.
    let record = selected?.ids.resultId === resultId ? selected : undefined;
    if (!record) {
      const request = this.host.db
        .prepare("SELECT handle,key FROM ghn_requests WHERE json_extract(ids,'$.resultId')=?")
        .get(resultId);
      record = request
        ? (this.host.nativeJournal.get(String(request.handle), String(request.key)) ?? undefined)
        : undefined;
    }
    if (record && this.captures.has(record.request.requestId)) return 'pending';
    if (
      record?.receipt.state === 'completed' &&
      record.result &&
      record.request.intent === 'work' &&
      record.request.context.visibility === 'shared'
    ) {
      try {
        // Link detection explains a missing immutable capture; it grants no path/file access.
        if (hostDocumentResultNames(record.result.text, this.workspaceRoot).length)
          return 'unavailable';
      } catch {
        return 'unavailable';
      }
    }
    return undefined;
  }
  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = body();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private capacity(additional: number) {
    const actual = Number(
      this.db
        .prepare(
          `SELECT
      COALESCE((SELECT sum(length(body)+1024) FROM hnd_files),0)+
      COALESCE((SELECT sum(length(CAST(body AS BLOB))+1024) FROM hnd_results),0)+
      COALESCE((SELECT sum(length(CAST(input AS BLOB))+1024) FROM hnd_intents),0)+
      COALESCE((SELECT sum(length(CAST(input AS BLOB))+1024) FROM hnd_exports),0)+
      (SELECT count(*)*1024 FROM hnd_events) n`,
        )
        .get()!.n,
    );
    const unresolved = Number(
      this.db
        .prepare(
          `SELECT count(*) n FROM hnd_intents i
      WHERE NOT EXISTS(SELECT 1 FROM hnd_results r WHERE r.result_id=i.result_id)
      AND NOT EXISTS(SELECT 1 FROM hnd_events e WHERE e.result_id=i.result_id)`,
        )
        .get()!.n,
    );
    if (actual + unresolved * (limits.bytes + 128 * 1024) + additional > 512 * 1024 ** 2)
      throw new Conflict('Local report storage is full. Existing reports remain available.');
  }
  private record(resultId: string, requireProjection: boolean): Capture {
    if (this.closed) throw new GroupDocumentCaptureError('pending');
    z.uuid().parse(resultId);
    const row = this.db.prepare('SELECT body FROM hnd_results WHERE result_id=?').get(resultId);
    if (!row) {
      throw new GroupDocumentCaptureError(this.documentCaptureState(resultId) ?? 'unavailable');
    }
    const captured = JSON.parse(String(row.body)) as Capture;
    groupDocumentManifestSchema.parse(captured.manifest);
    const reserved = this.host.db
      .prepare("SELECT handle,key,input FROM ghn_requests WHERE json_extract(ids,'$.resultId')=?")
      .get(resultId);
    if (
      !reserved ||
      hash(publicationCanonical(JSON.parse(String(reserved.input)))) !== captured.requestDigest
    )
      throw new Conflict('Exact report request binding changed.');
    if (requireProjection) {
      const record = this.host.nativeJournal.get(String(reserved.handle), String(reserved.key));
      if (
        !record ||
        record.receipt.state !== 'completed' ||
        record.ids.resultId !== resultId ||
        hash(publicationCanonical(record.result)) !== captured.resultDigest
      )
        throw new Conflict('Report must match its exact completed owning reply.');
    }
    return captured;
  }
  captureCompleted(completion: GroupHostNativeCompletion): Promise<void> {
    const requestId = completion.request.requestId;
    const active = this.captures.get(requestId);
    if (active) return active;
    const capture = this.captureExact(completion);
    this.captures.set(requestId, capture);
    void capture.finally(() => this.captures.delete(requestId)).catch(() => {});
    return capture;
  }
  private async captureExact(completion: GroupHostNativeCompletion): Promise<void> {
    if (
      this.closed ||
      completion.request.intent !== 'work' ||
      completion.request.context.visibility !== 'shared'
    )
      return;
    const reservation = this.host.db
      .prepare('SELECT ids,input FROM ghn_requests WHERE request_id=?')
      .get(completion.request.requestId);
    if (!reservation || !equal(JSON.parse(String(reservation.input)), completion.request)) return;
    const resultId = z.uuid().parse(JSON.parse(String(reservation.ids)).resultId);
    if (this.db.prepare('SELECT 1 FROM hnd_intents WHERE result_id=?').get(resultId)) return;
    // Persist intent BEFORE file access; interrupted captures are terminal and cannot
    // silently substitute later files on restart or a browser retry.
    const receiptId = randomUUID();
    this.transaction(() => {
      this.capacity(limits.bytes + 128 * 1024);
      this.db
        .prepare('INSERT INTO hnd_intents VALUES (?,?,?)')
        .run(resultId, receiptId, hash(publicationCanonical(completion)));
    });
    try {
      if (!this.authority) throw new Conflict('Report authority is unavailable.');
      await this.authority.revalidateOwner(completion.request.context);
      const proof = this.completionWorkspace?.(completion);
      let workspace = proof?.root;
      if (!workspace) {
        const child = relative(resolve(this.workspaceRoot), resolve(completion.cwd));
        z.uuid().parse(child);
        workspace = join(this.workspaceRoot, child);
      }
      if (workspace !== completion.cwd)
        throw new Conflict('Exact completed group workspace required.');
      if (lstatSync(workspace).isSymbolicLink() || realpathSync.native(workspace) !== workspace)
        throw new Conflict('Server-selected group workspace required.');
      const names = hostDocumentResultNames(completion.result.text, workspace);
      if (!names.length) {
        this.db
          .prepare('INSERT INTO hnd_events(result_id,kind) VALUES (?,?)')
          .run(resultId, 'no-report');
        return;
      }
      const files = captureHostDocumentFiles(workspace, names, proof?.identity);
      await this.authority.revalidateOwner(completion.request.context);
      if (proof && !equal(this.completionWorkspace!(completion), proof))
        throw new Conflict('Completed group workspace changed during capture.');
      const manifest = groupDocumentManifestSchema.parse({
        receiptId,
        requestId: completion.request.requestId,
        resultId,
        context: completion.request.context,
        nativeContext: completion.result.context,
        source: completion.result.source,
        files: files.map((file) => ({
          artifactId: randomUUID(),
          name: file.name,
          bytes: file.content.length,
          sha256: hash(file.content),
        })),
      });
      const captured: Capture = {
        manifest,
        requestDigest: hash(publicationCanonical(completion.request)),
        resultDigest: hash(publicationCanonical(completion.result)),
        runId: completion.runId,
        workspace,
      };
      this.transaction(() => {
        this.db
          .prepare('INSERT INTO hnd_results VALUES (?,?)')
          .run(resultId, JSON.stringify(captured));
        for (const [index, file] of files.entries())
          this.db
            .prepare('INSERT INTO hnd_files VALUES (?,?,?)')
            .run(resultId, manifest.files[index]!.artifactId, file.content);
        this.db
          .prepare('INSERT INTO hnd_events(result_id,kind) VALUES (?,?)')
          .run(resultId, 'captured');
      });
    } catch {
      this.db
        .prepare('INSERT INTO hnd_events(result_id,kind) VALUES (?,?)')
        .run(resultId, 'capture-unavailable');
    }
  }
  async describe(resultId: string): Promise<GroupDocumentManifest> {
    const { manifest } = this.record(resultId, true);
    if (!this.authority) throw new Conflict('Report authority is unavailable.');
    await this.authority.revalidateOwner(manifest.context);
    return manifest;
  }
  async export(input: Parameters<GroupDocumentsNative['export']>[0]) {
    z.uuid().parse(input.key);
    const manifest = await this.describe(input.manifest.resultId);
    if (
      !equal(manifest, input.manifest) ||
      !input.artifactIds.length ||
      new Set(input.artifactIds).size !== input.artifactIds.length ||
      input.artifactIds.some((id) => !manifest.files.some((file) => file.artifactId === id))
    )
      throw new Conflict('Exact captured report selection required.');
    const exact = publicationCanonical({ manifest, artifactIds: input.artifactIds });
    const receiptId = this.transaction(() => {
      const prior = this.db
        .prepare('SELECT input,receipt_id FROM hnd_exports WHERE key=?')
        .get(input.key);
      if (prior && prior.input !== exact) throw new Conflict('Report export retry changed.');
      if (prior) return String(prior.receipt_id);
      this.capacity(Buffer.byteLength(exact) + 4096);
      const receipt = randomUUID();
      this.db.prepare('INSERT INTO hnd_exports VALUES (?,?,?)').run(input.key, exact, receipt);
      return receipt;
    });
    const files = input.artifactIds.map((artifactId) => {
      const descriptor = manifest.files.find((file) => file.artifactId === artifactId)!;
      const row = this.db
        .prepare('SELECT body FROM hnd_files WHERE result_id=? AND artifact_id=?')
        .get(manifest.resultId, artifactId);
      if (!row) throw new Conflict('Captured bytes are unavailable.');
      const bytes = Buffer.from(row.body as Uint8Array);
      if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256)
        throw new Conflict('Captured report failed integrity verification.');
      return { artifactId, bytes };
    });
    if (
      files.reduce((n, file) => n + file.bytes.length, 0) >
      Math.min(input.limits.bytes, limits.bytes)
    )
      throw new Conflict('Selected report exceeds export limit.');
    await this.authority!.revalidateOwner(manifest.context);
    return {
      state: 'completed' as const,
      receiptId,
      sourceReceiptId: manifest.receiptId,
      version: groupDocumentVersion(manifest),
      files,
    };
  }
  async close() {
    if (!this.closed) {
      this.closed = true;
      await Promise.allSettled(this.captures.values());
      this.db.close();
    }
  }
}
