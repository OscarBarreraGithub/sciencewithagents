import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, realpathSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { type GroupContext } from '@dock/shared';
import {
  GROUP_DOCUMENT_LIMITS as limits,
  groupDocumentManifestSchema,
  groupDocumentNameSchema,
  groupDocumentBuildPolicy,
  type GroupDocumentManifest,
} from '@dock/shared/dist/group-documents.js';
import {
  GroupContainer,
  GroupDockerEngine,
  groupContainerSourceDigest,
  type GroupContainerPlan,
} from './group-container.js';
import { GroupIsolationBlocked } from './group-isolation.js';
import { groupDocumentVersion } from './group-documents.js';
import type { GroupDocumentsNative, GroupDocumentsAuthority } from './group-documents-native.js';
import {
  GroupDocumentNativeResultIndex,
  assertPrivateDocumentFile,
  documentNativeDigest,
  type DocumentNativeResult,
} from './group-documents-native-runtime-receipts.js';
import { runGroupDocumentGuest } from './group-documents-native-runtime-process.js';

const hash = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
const denied = (reason: string): never => {
  throw new GroupIsolationBlocked(`Native document denied: ${reason}.`);
};
const descriptor = z.strictObject({
  name: groupDocumentNameSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative().max(limits.bytes),
});
const captured = z.strictObject({
  state: z.literal('completed'),
  files: z.array(descriptor).min(1).max(limits.files),
});
const extracted = z.strictObject({
  state: z.literal('completed'),
  files: z
    .array(descriptor.extend({ base64: z.string().max(Math.ceil((limits.bytes * 4) / 3) + 4) }))
    .min(1)
    .max(limits.files),
});
const built = z.strictObject({
  state: z.literal('completed'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(5).max(limits.pdfBytes),
  base64: z.string().max(Math.ceil((limits.pdfBytes * 4) / 3) + 4),
});
const proofSchema = z.strictObject({
  contextId: z.uuid(),
  runId: z.uuid(),
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
});
type Guest = Pick<GroupContainer, 'start' | 'spawn' | 'close' | 'volume' | 'id' | 'plan'>;
/** Actual GroupNativeExecution implements this existing admitted proof method.
 * Called immediately after turn() and before connector finally closes its container.
 */
export interface GroupDocumentCompletedExecution {
  container: Guest;
  gitExportProof(): z.infer<typeof proofSchema>;
}
export interface GroupDocumentsNativeRuntime extends GroupDocumentsNative {
  captureCompletedRequest(
    requestId: string,
    execution: GroupDocumentCompletedExecution,
  ): Promise<GroupDocumentManifest | null>;
  captureCompletedResult(
    resultId: string,
    execution: GroupDocumentCompletedExecution,
  ): Promise<GroupDocumentManifest | null>;
  close(): Promise<void>;
  readonly imageSourceDigest: string;
}
type Saved = {
  manifest: GroupDocumentManifest;
  resultDigest: string;
  volume: string;
  plan: GroupContainerPlan;
  proof: z.infer<typeof proofSchema>;
};
/** Exact report/dependency names can only originate in the saved native reply.
 * Optional dependency comment advertises extra exact inputs; it does NOT authorize export.
 */
export function nativeDocumentResultNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)\s*\)/g)) {
    let path = m[1]!.replace(/^<|>$/g, '');
    try {
      if (path.startsWith('file://')) {
        const url = new URL(path);
        if (url.hostname && url.hostname !== 'localhost') continue;
        path = url.pathname;
      }
      path = decodeURIComponent(path);
    } catch {
      continue;
    }
    if (!/\.(tex|pdf)$/i.test(path)) continue;
    if (path.startsWith('/workspace/')) path = path.slice('/workspace/'.length);
    else if (path.startsWith('/') || /^[a-z]+:/i.test(path)) continue;
    names.push(groupDocumentNameSchema.parse(path));
  }
  if (!names.length) return [];
  for (const m of text.matchAll(/<!--\s*group-document-inputs:\s*(\[[\s\S]{0,8192}?\])\s*-->/g))
    names.push(...z.array(groupDocumentNameSchema).max(limits.files).parse(JSON.parse(m[1]!)));
  const result = [...new Set(names)];
  if (result.length > limits.files) denied('too many exact inputs');
  return result;
}

/** Production factory: concrete journal validation, actual guest capture/export and fresh compiler.
 * No browser paths/commands, Store, credentials RPC, provider launch or host compiler fallback.
 * Native + normal journal paths and the reviewed IMAGE ID are trusted host configuration only.
 */
export function createGroupDocumentsNativeRuntime(
  options: {
    directory: string;
    hostJournalPath: string;
    nativeJournalPath: string;
    image: string;
    authority: Pick<GroupDocumentsAuthority, 'revalidateOwner'>;
  },
  dependencies: {
    engine?: GroupDockerEngine;
    container?: (
      plan: GroupContainerPlan,
      state: string,
      admitted: () => void,
      record: (kind: string, detail: Record<string, string>) => void,
      retained?: string,
    ) => Guest;
    index?: GroupDocumentNativeResultIndex;
  } = {},
): GroupDocumentsNativeRuntime {
  z.string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .parse(options.image);
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const root = realpathSync.native(options.directory),
    info = lstatSync(options.directory);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.uid !== process.getuid!() ||
    info.mode & 0o077
  )
    denied('private runtime storage');
  const path = join(root, 'native-documents.sqlite');
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  assertPrivateDocumentFile(path);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS nd_capture(result_id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL UNIQUE,result_digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nd_results(result_id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nd_ops(key TEXT PRIMARY KEY,kind TEXT NOT NULL,digest TEXT NOT NULL,receipt_id TEXT NOT NULL,state TEXT NOT NULL,result TEXT,body BLOB);
    CREATE TABLE IF NOT EXISTS nd_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),pid INTEGER NOT NULL,token TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nd_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL);
    ${['nd_capture', 'nd_results', 'nd_events'].flatMap((t) => ['UPDATE', 'DELETE'].map((a) => `CREATE TRIGGER IF NOT EXISTS ${t}_${a} BEFORE ${a} ON ${t} BEGIN SELECT RAISE(ABORT,'immutable native document evidence'); END;`)).join('\n')}`);
  let index: GroupDocumentNativeResultIndex;
  try {
    index =
      dependencies.index ??
      new GroupDocumentNativeResultIndex(options.hostJournalPath, options.nativeJournalPath);
  } catch (error) {
    db.close();
    throw error;
  }
  const engine = dependencies.engine ?? new GroupDockerEngine();
  const jobs = new Map<string, Promise<unknown>>();
  let closed = false;
  const transaction = <T>(f: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = f();
      db.exec('COMMIT');
      return value;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  const event = (key: string, kind: string, body: unknown) =>
    db
      .prepare('INSERT INTO nd_events(key,kind,body) VALUES(?,?,?)')
      .run(key, kind, JSON.stringify(body));
  // Permanent IDs/results do not consume a lifetime request allowance. Pending
  // work reserves its worst-case payload; completed work retains its actual
  // snapshot/cache bytes and conservative SQLite/metadata overhead instead.
  const metadataReserve = 128 * 1024;
  const reservation = {
    capture: limits.bytes + metadataReserve,
    export: Math.ceil((limits.bytes * 4) / 3) + metadataReserve,
    build: limits.pdfBytes + metadataReserve,
  };
  const quota = (
    reserve?: keyof typeof reservation,
    addedBytes = 0,
    releasingOperation = '',
    releasingCapture = '',
  ) => {
    const captures = Number(
      db
        .prepare(
          `SELECT COUNT(*) n FROM nd_capture c
      WHERE c.result_id!=? AND NOT EXISTS(SELECT 1 FROM nd_results r WHERE r.result_id=c.result_id)`,
        )
        .get(releasingCapture)!.n,
    );
    const pending = db
      .prepare(
        `SELECT kind,COUNT(*) n FROM nd_ops
      WHERE state!='completed' AND key!=? GROUP BY kind`,
      )
      .all(releasingOperation);
    let operations = 0,
      reserved = captures * reservation.capture;
    for (const row of pending) {
      const kind = z.enum(['export', 'build']).parse(row.kind);
      operations += Number(row.n);
      reserved += Number(row.n) * reservation[kind];
    }
    let retained = 0;
    for (const table of ['nd_capture', 'nd_results', 'nd_ops', 'nd_owner', 'nd_events']) {
      const payload =
        table === 'nd_results' || table === 'nd_events'
          ? 'COALESCE(SUM(length(CAST(body AS BLOB))),0)'
          : table === 'nd_ops'
            ? 'COALESCE(SUM(length(body)),0)+COALESCE(SUM(length(CAST(result AS BLOB))),0)'
            : '0';
      // Fixed table names only; all caller values remain bound parameters.
      const row = db.prepare(`SELECT COUNT(*)*512+${payload} n FROM ${table}`).get()!;
      retained += Number(row.n);
    }
    retained += Number(
      db
        .prepare(
          `SELECT COALESCE(SUM(json_extract(f.value,'$.bytes')),0) n
      FROM nd_results r,json_each(r.body,'$.manifest.files') f`,
        )
        .get()!.n,
    );
    if (
      (reserve === 'capture' ? captures >= 128 : reserve && operations >= 128) ||
      retained + reserved + addedBytes + (reserve ? reservation[reserve] : 0) > 512 * 1024 ** 2
    )
      denied('retained receipt capacity');
  };
  // A concurrent factory must never retire namespaces owned by a live host.
  const ownerToken = randomUUID();
  try {
    transaction(() => {
      const previous = db.prepare('SELECT pid FROM nd_owner WHERE singleton=1').get();
      if (previous) {
        try {
          process.kill(Number(previous.pid), 0);
          denied('document runtime already owned by a live host');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      db.prepare('INSERT OR REPLACE INTO nd_owner VALUES(1,?,?)').run(process.pid, ownerToken);
      event(ownerToken, 'runtime-owned', { pid: process.pid });
    });
  } catch (error) {
    index.close();
    db.close();
    throw error;
  }
  const result = async (id: string, projected = true): Promise<DocumentNativeResult> => {
    if (closed) denied('reader restarting');
    const row = index.read(id, projected);
    await options.authority.revalidateOwner(row.context);
    return row;
  };
  const saved = async (resultId: string): Promise<Saved> => {
    const row = await result(resultId);
    const stored = db.prepare('SELECT body FROM nd_results WHERE result_id=?').get(resultId);
    if (!stored) denied('no result-time guest artifact snapshot');
    const value = JSON.parse(String(stored!.body)) as Saved;
    groupDocumentManifestSchema.parse(value.manifest);
    if (
      row.resultDigest !== value.resultDigest ||
      row.volume !== value.volume ||
      groupDocumentVersion(value.manifest) !==
        groupDocumentVersion({
          ...value.manifest,
          context: row.context,
          nativeContext: row.nativeContext,
        })
    )
      denied('immutable result/context changed');
    return value;
  };
  const complete = (key: string, meta: unknown, bytes: Uint8Array) =>
    transaction(() => {
      quota(undefined, bytes.length + 2 * Buffer.byteLength(JSON.stringify(meta)) + 1024, key);
      db.prepare(
        "UPDATE nd_ops SET state='completed',result=?,body=? WHERE key=? AND state!='completed'",
      ).run(JSON.stringify(meta), bytes, key);
      event(key, 'completed', meta);
    });
  const operation = async <T>(
    key: string,
    kind: string,
    input: unknown,
    work: (receiptId: string) => Promise<T>,
  ): Promise<T | { state: 'unknown'; receiptId: string }> => {
    z.uuid().parse(key);
    const digest = documentNativeDigest(input),
      prior = db.prepare('SELECT * FROM nd_ops WHERE key=?').get(key);
    if (prior && (prior.digest !== digest || prior.kind !== kind)) denied('same request changed');
    const busy = jobs.get(key);
    if (busy) return busy as Promise<T | { state: 'unknown'; receiptId: string }>;
    if (!prior)
      transaction(() => {
        quota(z.enum(['export', 'build']).parse(kind));
        db.prepare("INSERT INTO nd_ops VALUES(?,?,?,?,'intent',NULL,NULL)").run(
          key,
          kind,
          digest,
          randomUUID(),
        );
        event(key, 'intent', { kind, digest });
      });
    const receiptId = String(
      (prior ?? db.prepare('SELECT receipt_id FROM nd_ops WHERE key=?').get(key)!).receipt_id,
    );
    const task = work(receiptId).catch(() => {
      transaction(() => {
        db.prepare("UPDATE nd_ops SET state='unknown' WHERE key=? AND state!='completed'").run(key);
        event(key, 'unknown', { receiptId });
      });
      return { state: 'unknown' as const, receiptId };
    });
    jobs.set(key, task);
    try {
      return await task;
    } finally {
      jobs.delete(key);
    }
  };
  const namespace = async <T>(
    key: string,
    context: GroupContext,
    retained: string | undefined,
    consume: (guest: Guest) => Promise<T>,
    identityContext = context,
  ): Promise<T> => {
    // Reconcile every exact prior epoch before replay of this deterministic, effect-contained operation.
    if ((await engine.availability(options.image)).state !== 'ready')
      denied('reviewed compiler image unavailable');
    const epochs = db
      .prepare("SELECT body FROM nd_events WHERE key=? AND kind='container-reserved'")
      .all(key);
    for (const row of epochs) {
      const old = JSON.parse(String(row.body));
      await engine.retireReservation(old.name, JSON.parse(old.manifest), old.volume);
    }
    if (epochs.length >= 8) denied('bounded namespace retry capacity; inspect retained receipts');
    const state = join(root, `operation-${randomUUID()}`);
    mkdirSync(state, { mode: 0o700 });
    let live = true,
      checking = false;
    const identity = {
      groupId: context.groupId,
      memberId: context.memberId,
      installationId: context.installationId,
      contextId: retained ? identityContext.sessionId : randomUUID(),
      visibility: context.visibility,
    };
    const plan: GroupContainerPlan = {
      context: identity,
      image: options.image,
      workspace: null,
      reads: [],
      outbound: [],
      expiresAt: Date.now() + limits.buildMs,
      cpuCores: 1,
      memoryMb: 768,
    };
    const admitted = () => {
      if (!live || closed || Date.now() >= plan.expiresAt)
        denied('current bounded document admission');
    };
    const record = (kind: string, detail: Record<string, string>) => event(key, kind, detail);
    const guest = dependencies.container
      ? dependencies.container(plan, state, admitted, record, retained)
      : new GroupContainer(engine, plan, admitted, state, record, retained);
    const watch = setInterval(() => {
      if (checking) return;
      checking = true;
      void options.authority
        .revalidateOwner(context)
        .catch(() => {
          live = false;
          void guest.close().catch(() => {});
        })
        .finally(() => {
          checking = false;
        });
    }, 1000);
    try {
      await options.authority.revalidateOwner(context);
      await guest.start();
      const value = await consume(guest);
      await options.authority.revalidateOwner(context);
      return value;
    } finally {
      clearInterval(watch);
      await guest.close();
      live = false;
    }
  };
  const adapter: GroupDocumentsNativeRuntime = {
    imageSourceDigest: groupContainerSourceDigest(),
    async captureCompletedRequest(requestId, execution) {
      return adapter.captureCompletedResult(index.resultIdForRequest(requestId), execution);
    },
    async captureCompletedResult(resultId, execution) {
      const row = await result(resultId, false),
        names = nativeDocumentResultNames(row.text);
      if (!names.length) return null;
      const proof = proofSchema.parse(execution.gitExportProof());
      const nativeReceipt = index.read(resultId, false);
      if (
        proof.contextId !== row.nativeContext.sessionId ||
        proof.runId !== row.runId ||
        proof.containerId !== row.containerId ||
        execution.container.id !== proof.containerId ||
        execution.container.volume !== row.volume ||
        execution.container.plan.context.contextId !== row.nativeContext.sessionId ||
        documentNativeDigest(execution.container.plan.context) !==
          documentNativeDigest(row.plan.context) ||
        nativeReceipt.resultDigest !== row.resultDigest
      )
        denied('actual admitted completion proof');
      const jobKey = 'capture:' + resultId,
        busy = jobs.get(jobKey);
      if (busy) return busy as Promise<GroupDocumentManifest | null>;
      const perform = async () => {
        const prior = db
          .prepare('SELECT receipt_id,result_digest FROM nd_capture WHERE result_id=?')
          .get(resultId);
        if (prior && prior.result_digest !== row.resultDigest) denied('capture identity changed');
        if (!prior)
          transaction(() => {
            quota('capture');
            db.prepare('INSERT INTO nd_capture VALUES(?,?,?)').run(
              resultId,
              randomUUID(),
              row.resultDigest,
            );
            event(resultId, 'capture-intent', {
              requestId: row.requestId,
              resultDigest: row.resultDigest,
              proof,
            });
          });
        const receiptId = String(
          (
            prior ??
            db.prepare('SELECT receipt_id FROM nd_capture WHERE result_id=?').get(resultId)!
          ).receipt_id,
        );
        const existing = db.prepare('SELECT body FROM nd_results WHERE result_id=?').get(resultId);
        if (existing)
          return groupDocumentManifestSchema.parse(JSON.parse(String(existing.body)).manifest);
        const output = captured.parse(
          await runGroupDocumentGuest(
            execution.container,
            'capture',
            { receiptId, resultDigest: row.resultDigest, names },
            limits.readingMs,
            64 * 1024,
          ),
        );
        const manifest = groupDocumentManifestSchema.parse({
          receiptId,
          resultId,
          requestId: row.requestId,
          context: row.context,
          nativeContext: row.nativeContext,
          source: row.source ?? {
            sessionId: row.nativeContext.sessionId,
            provider: row.nativeContext.provider,
            nativeSessionId: row.nativeContext.nativeSessionId,
            messageId: row.nativeTurnId,
          },
          files: output.files.map((f) => ({ ...f, artifactId: randomUUID() })),
        });
        await options.authority.revalidateOwner(row.context);
        if (index.read(resultId, false).resultDigest !== row.resultDigest)
          denied('completion changed during capture');
        transaction(() => {
          const body = JSON.stringify({
            manifest,
            resultDigest: row.resultDigest,
            volume: row.volume,
            plan: row.plan,
            proof,
          } satisfies Saved);
          quota(
            undefined,
            Buffer.byteLength(body) + manifest.files.reduce((n, f) => n + f.bytes, 0) + 2048,
            '',
            resultId,
          );
          db.prepare('INSERT INTO nd_results VALUES(?,?)').run(resultId, body);
          event(resultId, 'captured', {
            receiptId,
            version: groupDocumentVersion(manifest),
            proof,
          });
        });
        return manifest;
      };
      const task = perform().catch((error) => {
        event(resultId, 'capture-unknown', { resultDigest: row.resultDigest, proof });
        throw error;
      });
      jobs.set(jobKey, task);
      try {
        return await task;
      } finally {
        jobs.delete(jobKey);
      }
    },
    async describe(resultId) {
      return (await saved(resultId)).manifest;
    },
    async export(input) {
      const current = await saved(input.manifest.resultId),
        manifest = current.manifest;
      if (
        groupDocumentVersion(manifest) !== groupDocumentVersion(input.manifest) ||
        input.limits.bytes !== limits.bytes ||
        input.limits.timeoutMs !== limits.readingMs ||
        !input.artifactIds.length ||
        new Set(input.artifactIds).size !== input.artifactIds.length
      )
        denied('exact export grant');
      const selected = input.artifactIds.map(
        (id) => manifest.files.find((f) => f.artifactId === id) ?? denied('ungranted artifact'),
      );
      return operation(
        input.key,
        'export',
        { version: groupDocumentVersion(manifest), selected: input.artifactIds },
        async (receiptId) => {
          const old = db
            .prepare('SELECT state,result,body FROM nd_ops WHERE key=?')
            .get(input.key)!;
          if (old.state === 'completed') {
            await saved(manifest.resultId);
            const meta = JSON.parse(String(old.result));
            if (
              meta.state !== 'completed' ||
              meta.receiptId !== receiptId ||
              meta.sourceReceiptId !== manifest.receiptId ||
              meta.version !== groupDocumentVersion(manifest) ||
              documentNativeDigest(meta.selected) !== documentNativeDigest(input.artifactIds)
            )
              denied('cached export receipt changed');
            const cached = z
              .array(
                z.strictObject({ artifactId: z.uuid(), base64: z.string().max(12 * 1024 ** 2) }),
              )
              .length(selected.length)
              .parse(JSON.parse(Buffer.from(old.body as Uint8Array).toString()));
            const files = cached.map((f) => {
              const expected =
                selected.find((item) => item.artifactId === f.artifactId) ??
                denied('mixed cached export');
              const bytes = Buffer.from(f.base64, 'base64');
              if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256)
                denied('cached export digest');
              return { artifactId: f.artifactId, bytes };
            });
            if (new Set(files.map((f) => f.artifactId)).size !== selected.length)
              denied('duplicate cached export');
            return {
              ...meta,
              files,
            };
          }
          const output = await namespace(
            input.key,
            manifest.context,
            current.volume,
            (guest) =>
              runGroupDocumentGuest(
                guest,
                'export',
                {
                  receiptId: manifest.receiptId,
                  resultDigest: current.resultDigest,
                  files: selected.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
                },
                limits.readingMs,
                12 * 1024 ** 2,
              ),
            manifest.nativeContext,
          );
          const parsed = extracted.parse(output);
          if (parsed.files.length !== selected.length) denied('export count');
          const files = parsed.files.map((f) => {
            const meta = selected.find((m) => m.name === f.name) ?? denied('mixed export');
            const bytes = Buffer.from(f.base64, 'base64');
            if (
              bytes.length !== meta.bytes ||
              f.bytes !== meta.bytes ||
              f.sha256 !== meta.sha256 ||
              hash(bytes) !== meta.sha256
            )
              denied('immutable export digest');
            return { artifactId: meta.artifactId, bytes };
          });
          if (new Set(files.map((f) => f.artifactId)).size !== selected.length)
            denied('duplicate export');
          await saved(manifest.resultId);
          const meta = {
            state: 'completed' as const,
            receiptId,
            sourceReceiptId: manifest.receiptId,
            version: groupDocumentVersion(manifest),
            selected: input.artifactIds,
          };
          complete(
            input.key,
            meta,
            Buffer.from(
              JSON.stringify(
                files.map((f) => ({
                  artifactId: f.artifactId,
                  base64: f.bytes.toString('base64'),
                })),
              ),
            ),
          );
          return { ...meta, files };
        },
      );
    },
    async build(input) {
      const record = db
        .prepare("SELECT body FROM nd_results WHERE json_extract(body,'$.manifest.receiptId')=?")
        .get(input.sourceReceiptId);
      if (!record) denied('unknown native source receipt');
      const current = await saved((JSON.parse(String(record!.body)) as Saved).manifest.resultId),
        manifest = current.manifest;
      if (
        input.version !== groupDocumentVersion(manifest) ||
        documentNativeDigest(input.context) !== documentNativeDigest(manifest.context) ||
        documentNativeDigest(input.policy) !== documentNativeDigest(groupDocumentBuildPolicy)
      )
        denied('build scope/policy');
      const ids = input.files.map((f) => f.artifactId);
      if (!ids.includes(input.entry.artifactId) || new Set(ids).size !== ids.length)
        denied('build inputs');
      for (const file of input.files) {
        const expected = manifest.files.find((f) => f.artifactId === file.artifactId);
        if (
          !expected ||
          documentNativeDigest(expected) !==
            documentNativeDigest({
              artifactId: file.artifactId,
              name: file.name,
              bytes: file.bytes,
              sha256: file.sha256,
            }) ||
          file.content.length !== expected.bytes ||
          hash(file.content) !== expected.sha256
        )
          denied('build bytes not in exact native receipt');
      }
      if (
        documentNativeDigest(input.entry) !==
        documentNativeDigest(manifest.files.find((f) => f.artifactId === input.entry.artifactId))
      )
        denied('entry metadata changed');
      if (
        !db
          .prepare("SELECT result FROM nd_ops WHERE kind='export' AND state='completed'")
          .all()
          .some((r) => {
            const v = JSON.parse(String(r.result));
            return (
              v.sourceReceiptId === input.sourceReceiptId &&
              v.version === input.version &&
              documentNativeDigest([...v.selected].sort()) === documentNativeDigest([...ids].sort())
            );
          })
      )
        denied('no completed exact export grant');
      return operation(
        input.key,
        'build',
        {
          grantId: input.grantId,
          version: input.version,
          entry: input.entry.artifactId,
          files: ids,
          context: input.context,
        },
        async (receiptId) => {
          const old = db
            .prepare('SELECT state,result,body FROM nd_ops WHERE key=?')
            .get(input.key)!;
          if (old.state === 'completed') {
            await saved(manifest.resultId);
            const meta = JSON.parse(String(old.result)),
              pdf = Buffer.from(old.body as Uint8Array);
            if (
              meta.state !== 'completed' ||
              meta.receiptId !== receiptId ||
              meta.grantId !== input.grantId ||
              meta.version !== input.version ||
              meta.bytes !== pdf.length ||
              meta.sha256 !== hash(pdf) ||
              pdf.length > limits.pdfBytes ||
              pdf.subarray(0, 5).toString() !== '%PDF-'
            )
              denied('cached PDF attestation');
            return { ...meta, pdf };
          }
          const raw = await namespace(input.key, manifest.context, undefined, (guest) =>
            runGroupDocumentGuest(
              guest,
              'build',
              {
                entry: input.entry.name,
                files: input.files.map((f) => ({
                  name: f.name,
                  bytes: f.bytes,
                  sha256: f.sha256,
                  base64: Buffer.from(f.content).toString('base64'),
                })),
              },
              limits.buildMs,
              Math.ceil((limits.pdfBytes * 4) / 3) + 65536,
            ),
          );
          const output = built.parse(raw),
            pdf = Buffer.from(output.base64, 'base64');
          if (
            pdf.length !== output.bytes ||
            hash(pdf) !== output.sha256 ||
            pdf.subarray(0, 5).toString() !== '%PDF-'
          )
            denied('PDF attestation');
          await saved(manifest.resultId);
          const meta = {
            state: 'completed' as const,
            receiptId,
            grantId: input.grantId,
            version: input.version,
            sha256: output.sha256,
            bytes: output.bytes,
          };
          complete(input.key, meta, pdf);
          return { ...meta, pdf };
        },
      );
    },
    async close() {
      closed = true;
      await Promise.allSettled([...jobs.values()]);
      db.prepare('DELETE FROM nd_owner WHERE token=?').run(ownerToken);
      event(ownerToken, 'runtime-closed', { pid: process.pid });
      index.close();
      db.close();
    },
  };
  return adapter;
}
