import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, writeFile, readdir, readFile, rm, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  documentSchema,
  type SavedDocument,
  type DocumentReading,
  type GroupContext,
} from '@dock/shared';
import {
  GROUP_DOCUMENT_LIMITS as limits,
  groupDocumentManifestSchema,
  groupDocumentGrantRequestSchema,
  groupDocumentActionSchema,
  groupDocumentShareSchema,
  groupDocumentBuildPolicy,
  groupDocumentHref,
  type GroupDocumentManifest,
  type GroupDocumentFile,
  type GroupDocumentOffer,
} from '@dock/shared/dist/group-documents.js';
import { buildReading } from './document-reading.js';
import { buildGroupDocumentReading } from './group-documents-reading.js';
import type {
  GroupDocumentsNative,
  GroupDocumentsAuthority,
  GroupDocumentAuthority,
} from './group-documents-native.js';

const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v !== null && typeof v === 'object'
      ? `{${Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
          .join(',')}}`
      : JSON.stringify(v);
export const groupDocumentVersion = (v: GroupDocumentManifest) => hash(canonical(v));
async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Document operation deadline exceeded.')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export class GroupDocumentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const denied = (): never => {
  throw new GroupDocumentError(
    403,
    'GROUP_DOCUMENT_DENIED',
    'This document is unavailable in this group conversation.',
  );
};
const conflict = (message: string): never => {
  throw new GroupDocumentError(409, 'GROUP_DOCUMENT_CONFLICT', message);
};
const uncertain = (): never => {
  throw new GroupDocumentError(
    503,
    'GROUP_DOCUMENT_UNCERTAIN',
    'The exact export or build receipt is retained. Retry the same request to reconcile it.',
  );
};
type Offer = {
  id: string;
  manifest: GroupDocumentManifest;
  version: string;
  handles: { handle: string; artifactId: string }[];
};
type Grant = {
  id: string;
  offerId: string;
  owner: GroupContext;
  visibility: 'private' | 'shared';
  version: string;
  entry: string;
  selected: string[];
  exportReceipt: string;
  sharedFrom?: string;
};
type Operation = {
  key: string;
  payload: string;
  state: string;
  result: string | null;
  receipt: string | null;
};
export type GroupDocumentReadingBuilder = typeof buildReading;

/** Dedicated immutable storage. Never calls Store.agent/savedEntry or registers in the personal library. */
export class GroupDocuments {
  readonly #db: DatabaseSync;
  readonly #nativeBuilds = new Map<
    string,
    ReturnType<NonNullable<GroupDocumentsNative['build']>>
  >();
  readonly #jobs = new Map<string, Promise<unknown>>();
  #readingCount = 0;
  #readingQueue: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(
    path: string,
    private readonly directory: string,
    private readonly authority: GroupDocumentsAuthority,
    private readonly native: GroupDocumentsNative,
    private readonly convert: GroupDocumentReadingBuilder = buildGroupDocumentReading,
  ) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS gd_offers(id TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gd_grants(id TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gd_content(grant_id TEXT NOT NULL,artifact_id TEXT NOT NULL,body BLOB NOT NULL,PRIMARY KEY(grant_id,artifact_id));
CREATE TABLE IF NOT EXISTS gd_assets(grant_id TEXT NOT NULL,name TEXT NOT NULL,body BLOB NOT NULL,PRIMARY KEY(grant_id,name));
CREATE TABLE IF NOT EXISTS gd_pdf(grant_id TEXT PRIMARY KEY,body BLOB NOT NULL,receipt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gd_build_keys(grant_id TEXT PRIMARY KEY,key TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS gd_revoked(grant_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS gd_operations(key TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,result TEXT,receipt TEXT);
CREATE TABLE IF NOT EXISTS gd_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,body TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS gd_events_no_update BEFORE UPDATE ON gd_events BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
CREATE TRIGGER IF NOT EXISTS gd_events_no_delete BEFORE DELETE ON gd_events BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
CREATE TRIGGER IF NOT EXISTS gd_offers_no_update BEFORE UPDATE ON gd_offers BEGIN SELECT RAISE(ABORT,'immutable offer'); END;
CREATE TRIGGER IF NOT EXISTS gd_offers_no_delete BEFORE DELETE ON gd_offers BEGIN SELECT RAISE(ABORT,'immutable offer'); END;
CREATE TRIGGER IF NOT EXISTS gd_grants_no_delete BEFORE DELETE ON gd_grants BEGIN SELECT RAISE(ABORT,'immutable grant'); END;
CREATE TRIGGER IF NOT EXISTS gd_content_no_update BEFORE UPDATE ON gd_content BEGIN SELECT RAISE(ABORT,'immutable content'); END;
CREATE TRIGGER IF NOT EXISTS gd_content_no_delete BEFORE DELETE ON gd_content BEGIN SELECT RAISE(ABORT,'immutable content'); END;
CREATE TRIGGER IF NOT EXISTS gd_pdf_no_update BEFORE UPDATE ON gd_pdf BEGIN SELECT RAISE(ABORT,'immutable PDF'); END;
CREATE TRIGGER IF NOT EXISTS gd_pdf_no_delete BEFORE DELETE ON gd_pdf BEGIN SELECT RAISE(ABORT,'immutable PDF'); END;
CREATE TRIGGER IF NOT EXISTS gd_assets_no_update BEFORE UPDATE ON gd_assets BEGIN SELECT RAISE(ABORT,'immutable figure'); END;
CREATE TRIGGER IF NOT EXISTS gd_assets_no_delete BEFORE DELETE ON gd_assets BEGIN SELECT RAISE(ABORT,'immutable figure'); END;
CREATE TRIGGER IF NOT EXISTS gd_revoked_no_delete BEFORE DELETE ON gd_revoked BEGIN SELECT RAISE(ABORT,'durable revocation'); END;
CREATE TRIGGER IF NOT EXISTS gd_grants_no_update BEFORE UPDATE ON gd_grants BEGIN SELECT RAISE(ABORT,'immutable grant'); END;`);
  }
  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#jobs.values(), this.#readingQueue]);
    this.#db.close();
  }
  #transaction<T>(f: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const v = f();
      this.#db.exec('COMMIT');
      return v;
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }
  #event(kind: string, body: unknown) {
    this.#db.prepare('INSERT INTO gd_events(kind,body) VALUES(?,?)').run(kind, canonical(body));
  }
  #record<T>(table: 'gd_grants' | 'gd_offers', id: string): T {
    z.uuid().parse(id);
    const row = this.#db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id);
    if (!row) return denied();
    return JSON.parse(String(row.body)) as T;
  }
  async #actor(handle: string) {
    if (this.#closed) conflict('The scoped reader is restarting.');
    const id = z.uuid().parse(handle);
    let actor: GroupDocumentAuthority;
    try {
      actor = await this.authority.resolve(id);
    } catch {
      return denied();
    }
    await this.#live(actor);
    return actor;
  }
  async #live(actor: GroupDocumentAuthority) {
    try {
      await actor.revalidate();
    } catch {
      return denied();
    }
  }
  async #owner(context: GroupContext) {
    try {
      await this.authority.revalidateOwner(context);
    } catch {
      return denied();
    }
  }
  async #check(actor: GroupDocumentAuthority, g: Grant) {
    await this.#live(actor);
    await this.#owner(g.owner);
    await this.#live(actor);
    if (
      actor.context.groupId !== g.owner.groupId ||
      (g.visibility === 'private' && !equal(actor.context, g.owner)) ||
      this.#db.prepare('SELECT 1 FROM gd_revoked WHERE grant_id=?').get(g.id) ||
      (g.sharedFrom &&
        this.#db.prepare('SELECT 1 FROM gd_revoked WHERE grant_id=?').get(g.sharedFrom))
    )
      denied();
  }
  #files(g: Grant) {
    const offer = this.#record<Offer>('gd_offers', g.offerId);
    return g.selected.map((id) => offer.manifest.files.find((f) => f.artifactId === id)!);
  }
  #content(g: Grant, f: GroupDocumentFile) {
    const row = this.#db
      .prepare('SELECT body FROM gd_content WHERE grant_id=? AND artifact_id=?')
      .get(g.id, f.artifactId);
    if (!row) return denied();
    const bytes = Buffer.from(row.body as Uint8Array);
    if (bytes.byteLength !== f.bytes || hash(bytes) !== f.sha256)
      conflict('Immutable document content failed verification.');
    return bytes;
  }
  #link(g: Grant) {
    return {
      grantId: g.id,
      version: g.version,
      visibility: g.visibility,
      href: groupDocumentHref(g.id, g.version),
    };
  }
  #saved(g: Grant): SavedDocument {
    const f = this.#files(g).find((f) => f.artifactId === g.entry)!;
    const pdf = !!this.#db.prepare('SELECT 1 FROM gd_pdf WHERE grant_id=?').get(g.id);
    const build = this.#db
      .prepare(
        "SELECT state FROM gd_operations WHERE json_extract(payload,'$.kind')='build' AND json_extract(payload,'$.grantId')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(g.id);
    return documentSchema.parse({
      id: g.id,
      name: f.name.split('/').at(-1),
      folder: g.visibility === 'private' ? 'Private group report' : 'Shared group report',
      kind: f.name.endsWith('.tex') ? 'tex' : 'pdf',
      state: pdf
        ? 'ready'
        : build?.state === 'intent'
          ? 'building'
          : build?.state === 'unknown'
            ? 'failed'
            : 'source',
      hasPdf: pdf,
      builtAt: null,
      openedAt: null,
      error:
        build?.state === 'unknown' ? 'Build outcome is uncertain; retry the same request.' : null,
      href: groupDocumentHref(g.id, g.version),
    });
  }
  async #operation<T>(key: string, payload: unknown, f: (op: Operation) => Promise<T>): Promise<T> {
    const text = canonical(payload),
      prior = this.#db.prepare('SELECT * FROM gd_operations WHERE key=?').get(key) as
        | Operation
        | undefined;
    if (prior && prior.payload !== text)
      conflict('This request key is already bound to different document inputs.');
    if (prior?.state === 'completed') return JSON.parse(prior.result!) as T;
    const busy = this.#jobs.get(key);
    if (busy) return busy as Promise<T>;
    if (!prior)
      this.#transaction(() => {
        this.#db.prepare("INSERT INTO gd_operations VALUES(?,?,'intent',NULL,NULL)").run(key, text);
        this.#event('intent', { key, payload });
      });
    const job = f(prior ?? { key, payload: text, state: 'intent', result: null, receipt: null });
    this.#jobs.set(key, job);
    try {
      return await job;
    } finally {
      this.#jobs.delete(key);
    }
  }
  #finish<T>(key: string, result: T, effect: () => void): T {
    return this.#transaction(() => {
      const prior = this.#db.prepare('SELECT state,result FROM gd_operations WHERE key=?').get(key);
      if (prior?.state === 'completed') return JSON.parse(String(prior.result)) as T;
      effect();
      this.#db
        .prepare("UPDATE gd_operations SET state='completed',result=? WHERE key=?")
        .run(JSON.stringify(result), key);
      this.#event('completed', { key, result });
      return result;
    });
  }
  #unknown(key: string, receipt: string | null) {
    this.#transaction(() => {
      this.#db
        .prepare(
          "UPDATE gd_operations SET state='unknown',receipt=? WHERE key=? AND state!='completed'",
        )
        .run(receipt, key);
      this.#event('unknown', { key, receipt });
    });
  }
  /** Trusted normal/native result projection only. Browser has no result/path lookup endpoint. */
  async offer(handle: string, resultId: string): Promise<GroupDocumentOffer> {
    const actor = await this.#actor(handle),
      manifest = groupDocumentManifestSchema.parse(
        await deadline(this.native.describe(z.uuid().parse(resultId)), limits.readingMs),
      );
    if (manifest.resultId !== resultId || !equal(actor.context, manifest.context)) denied();
    await this.#live(actor);
    await this.#owner(manifest.context);
    const version = groupDocumentVersion(manifest),
      existing = this.#db
        .prepare("SELECT body FROM gd_offers WHERE json_extract(body,'$.version')=?")
        .get(version);
    const prior = this.#db
      .prepare("SELECT body FROM gd_offers WHERE json_extract(body,'$.manifest.receiptId')=?")
      .get(manifest.receiptId);
    if (prior && (JSON.parse(String(prior.body)) as Offer).version !== version)
      conflict('A native source receipt changed its immutable artifact manifest.');
    const offer: Offer = existing
      ? JSON.parse(String(existing.body))
      : {
          id: randomUUID(),
          manifest,
          version,
          handles: manifest.files.map((f) => ({ handle: randomUUID(), artifactId: f.artifactId })),
        };
    if (!existing)
      this.#transaction(() => {
        this.#db.prepare('INSERT INTO gd_offers VALUES(?,?)').run(offer.id, JSON.stringify(offer));
        this.#event('offered', { offerId: offer.id, resultId, version });
      });
    return {
      handle: offer.id,
      resultId,
      version,
      files: offer.handles.map((h) => {
        const f = manifest.files.find((f) => f.artifactId === h.artifactId)!;
        return {
          handle: h.handle,
          name: f.name,
          bytes: f.bytes,
          kind: /\.tex$/.test(f.name) ? 'tex' : /\.pdf$/.test(f.name) ? 'pdf' : 'dependency',
        };
      }),
    };
  }
  async grant(handle: string, raw: unknown) {
    const input = groupDocumentGrantRequestSchema.parse(raw),
      actor = await this.#actor(handle),
      offer = this.#record<Offer>('gd_offers', input.offer);
    if (!equal(actor.context, offer.manifest.context)) denied();
    await this.#owner(offer.manifest.context);
    const selected = [input.entry, ...input.dependencies].map(
      (h) => offer.handles.find((f) => f.handle === h)?.artifactId ?? denied(),
    );
    const entry = offer.manifest.files.find((f) => f.artifactId === selected[0])!;
    if (!/\.(tex|pdf)$/.test(entry.name)) conflict('Select one LaTeX or PDF artifact.');
    const result = await this.#operation(
      input.key,
      { kind: 'grant', context: actor.context, input },
      async () => {
        await this.#live(actor);
        await this.#owner(offer.manifest.context);
        let output: Awaited<ReturnType<GroupDocumentsNative['export']>>;
        try {
          output = await deadline(
            this.native.export({
              key: input.key,
              manifest: offer.manifest,
              artifactIds: selected,
              limits: { bytes: limits.bytes, timeoutMs: limits.readingMs },
            }),
            limits.readingMs,
          );
        } catch {
          this.#unknown(input.key, null);
          return uncertain();
        }
        z.uuid().parse(output.receiptId);
        if (output.state === 'unknown') {
          this.#unknown(input.key, output.receiptId);
          return uncertain();
        }
        if (
          output.sourceReceiptId !== offer.manifest.receiptId ||
          output.version !== offer.version ||
          output.files.length !== selected.length ||
          new Set(output.files.map((f) => f.artifactId)).size !== selected.length
        ) {
          this.#unknown(input.key, output.receiptId);
          conflict('Native export does not match the exact granted source receipt.');
        }
        let total = 0;
        for (const f of output.files) {
          const meta = offer.manifest.files.find((x) => x.artifactId === f.artifactId);
          if (
            !meta ||
            !selected.includes(f.artifactId) ||
            f.bytes.length !== meta.bytes ||
            hash(f.bytes) !== meta.sha256 ||
            (total += f.bytes.length) > limits.bytes
          ) {
            this.#unknown(input.key, output.receiptId);
            conflict('Native export content does not match the immutable manifest.');
          }
        }
        this.#unknown(input.key, output.receiptId);
        await this.#live(actor);
        await this.#owner(offer.manifest.context);
        const g: Grant = {
          id: randomUUID(),
          offerId: offer.id,
          owner: offer.manifest.context,
          visibility: offer.manifest.context.visibility,
          version: offer.version,
          entry: entry.artifactId,
          selected,
          exportReceipt: output.receiptId,
        };
        return this.#finish(input.key, this.#link(g), () => {
          this.#db.prepare('INSERT INTO gd_grants VALUES(?,?)').run(g.id, JSON.stringify(g));
          for (const f of output.files)
            this.#db
              .prepare('INSERT INTO gd_content VALUES(?,?,?)')
              .run(g.id, f.artifactId, f.bytes);
          if (entry.name.endsWith('.pdf')) {
            const pdf = output.files.find((f) => f.artifactId === entry.artifactId)!.bytes;
            if (Buffer.from(pdf).subarray(0, 5).toString() !== '%PDF-')
              conflict('The selected PDF is invalid.');
            this.#db.prepare('INSERT INTO gd_pdf VALUES(?,?,?)').run(g.id, pdf, output.receiptId);
          }
          this.#event('granted', {
            grantId: g.id,
            owner: g.owner,
            selected,
            version: g.version,
            receipt: output.receiptId,
          });
        });
      },
    );
    await this.#check(actor, this.#record<Grant>('gd_grants', result.grantId));
    return result;
  }
  async share(handle: string, id: string, raw: unknown) {
    const input = groupDocumentShareSchema.parse(raw),
      actor = await this.#actor(handle),
      g = this.#record<Grant>('gd_grants', id),
      target = await this.#actor(input.sharedHandle);
    await this.#check(actor, g);
    if (
      !equal(actor.context, g.owner) ||
      g.visibility !== 'private' ||
      target.context.visibility !== 'shared' ||
      target.context.groupId !== g.owner.groupId ||
      target.context.memberId !== g.owner.memberId ||
      target.context.installationId !== g.owner.installationId
    )
      denied();
    const result = await this.#operation(
      input.key,
      { kind: 'share', id, context: actor.context, target: target.context },
      async () => {
        await this.#check(actor, g);
        await this.#live(target);
        const shared: Grant = { ...g, id: randomUUID(), visibility: 'shared', sharedFrom: g.id };
        return this.#finish(input.key, this.#link(shared), () => {
          this.#db
            .prepare('INSERT INTO gd_grants VALUES(?,?)')
            .run(shared.id, JSON.stringify(shared));
          this.#db
            .prepare(
              'INSERT INTO gd_content SELECT ?,artifact_id,body FROM gd_content WHERE grant_id=?',
            )
            .run(shared.id, g.id);
          this.#db
            .prepare('INSERT INTO gd_pdf SELECT ?,body,receipt FROM gd_pdf WHERE grant_id=?')
            .run(shared.id, g.id);
          this.#event('explicit-share', {
            privateGrant: g.id,
            sharedGrant: shared.id,
            actor: actor.context,
            target: target.context,
            key: input.key,
          });
        });
      },
    );
    await this.#check(target, this.#record<Grant>('gd_grants', result.grantId));
    return result;
  }
  async revoke(handle: string, id: string, raw: unknown, version?: string) {
    const input = groupDocumentActionSchema.parse(raw),
      actor = await this.#actor(handle),
      g = this.#record<Grant>('gd_grants', id);
    if (!equal(actor.context, g.owner) || (version !== undefined && version !== g.version))
      denied();
    return this.#operation(input.key, { kind: 'revoke', id, context: actor.context }, async () => {
      await this.#live(actor);
      return this.#finish(input.key, { revoked: true }, () => {
        this.#db.prepare('INSERT OR IGNORE INTO gd_revoked VALUES(?)').run(id);
        this.#event('revoked', { id, key: input.key, actor: actor.context });
      });
    });
  }
  async #authorized(handle: string, id: string, version: string) {
    const actor = await this.#actor(handle),
      g = this.#record<Grant>('gd_grants', id);
    if (g.version !== version) denied();
    await this.#check(actor, g);
    return { actor, g };
  }
  async get(handle: string, id: string, version: string) {
    const { g } = await this.#authorized(handle, id, version);
    return this.#saved(g);
  }
  /** Protected explicit sharing snapshot. It excludes the private owner/native
   * contexts and every file not selected by the original local grant. */
  async exportSharedBundle(handle: string, id: string, version: string, sharedHandle: string) {
    const { actor, g } = await this.#authorized(handle, id, version);
    const target = await this.#actor(sharedHandle);
    if (
      !equal(actor.context, g.owner) ||
      target.context.visibility !== 'shared' ||
      target.context.groupId !== g.owner.groupId ||
      target.context.memberId !== g.owner.memberId ||
      target.context.installationId !== g.owner.installationId
    )
      denied();
    const files = this.#files(g).map((file) => ({
      ...file,
      id: file.artifactId,
      kind: 'source' as const,
      content: this.#content(g, file),
    }));
    const entry = files.find((f) => f.id === g.entry)!;
    const pdf = this.#db.prepare('SELECT body,receipt FROM gd_pdf WHERE grant_id=?').get(g.id);
    const output: {
      id: string;
      name: string;
      kind: 'source' | 'asset' | 'pdf';
      bytes: number;
      sha256: string;
      content: Buffer;
    }[] = files;
    if (pdf && !entry.name.endsWith('.pdf')) {
      const content = Buffer.from(pdf.body as Uint8Array);
      // Persisted build receipt fixes the PDF identity across exact share retries.
      const pdfId = this.#db
        .prepare(
          "SELECT body FROM gd_events WHERE kind='publication-pdf' AND json_extract(body,'$.grantId')=?",
        )
        .get(g.id);
      const identity = pdfId ? (JSON.parse(String(pdfId.body)).id as string) : randomUUID();
      if (!pdfId) this.#event('publication-pdf', { grantId: g.id, id: identity });
      output.push({
        id: identity,
        name: `compiled-${g.entry}.pdf`,
        kind: 'pdf',
        bytes: content.length,
        sha256: hash(content),
        content,
      });
    }
    await this.#check(actor, g);
    await this.#live(target);
    return {
      owner: target.context,
      title: entry.name.split('/').at(-1)!,
      entryId: g.entry,
      version: g.version,
      files: output,
    };
  }
  async source(handle: string, id: string, version: string) {
    const { actor, g } = await this.#authorized(handle, id, version),
      f = this.#files(g).find((f) => f.artifactId === g.entry)!;
    const data = this.#content(g, f);
    await this.#check(actor, g);
    return data;
  }
  async pdf(handle: string, id: string, version: string) {
    const { actor, g } = await this.#authorized(handle, id, version),
      row = this.#db.prepare('SELECT body FROM gd_pdf WHERE grant_id=?').get(g.id);
    if (!row) conflict('PDF is not ready.');
    const bytes = Buffer.from(row!.body as Uint8Array);
    await this.#check(actor, g);
    return bytes;
  }
  async build(handle: string, id: string, version: string, raw: unknown) {
    const input = groupDocumentActionSchema.parse(raw),
      { actor, g } = await this.#authorized(handle, id, version),
      files = this.#files(g),
      entry = files.find((f) => f.artifactId === g.entry)!;
    if (entry.name.endsWith('.pdf')) return this.#saved(g);
    if (!this.native.build)
      throw new GroupDocumentError(
        503,
        'GROUP_DOCUMENT_BUILD_UNAVAILABLE',
        'A confined native document builder is not connected. Reading mode is available; retry PDF after it is connected.',
      );
    await this.#operation(
      input.key,
      { kind: 'build', grantId: id, version, context: actor.context },
      async () => {
        if (this.#db.prepare('SELECT 1 FROM gd_pdf WHERE grant_id=?').get(id))
          return this.#finish(input.key, { id }, () =>
            this.#event('build-reused', { id, key: input.key }),
          );
        const nativeKey = this.#transaction(() => {
          const prior = this.#db.prepare('SELECT key FROM gd_build_keys WHERE grant_id=?').get(id);
          if (prior) return String(prior.key);
          const key = randomUUID();
          this.#db.prepare('INSERT INTO gd_build_keys VALUES(?,?)').run(id, key);
          this.#event('build-intent', { id, nativeKey: key, version });
          return key;
        });
        let output: Awaited<ReturnType<NonNullable<GroupDocumentsNative['build']>>>;
        try {
          let task = this.#nativeBuilds.get(id);
          if (!task) {
            task = deadline(
              this.native.build!({
                key: nativeKey,
                grantId: id,
                version,
                sourceReceiptId: this.#record<Offer>('gd_offers', g.offerId).manifest.receiptId,
                context: g.owner,
                entry,
                files: files.map((f) => ({ ...f, content: this.#content(g, f) })),
                policy: groupDocumentBuildPolicy,
              }),
              limits.buildMs,
            );
            this.#nativeBuilds.set(id, task);
            void task.finally(() => this.#nativeBuilds.delete(id)).catch(() => {});
          }
          output = await task;
        } catch {
          this.#unknown(input.key, null);
          return uncertain();
        }
        z.uuid().parse(output.receiptId);
        if (output.state === 'unknown') {
          this.#unknown(input.key, output.receiptId);
          return uncertain();
        }
        if (
          output.grantId !== id ||
          output.version !== version ||
          output.pdf.length > limits.pdfBytes ||
          Buffer.from(output.pdf).subarray(0, 5).toString() !== '%PDF-'
        ) {
          this.#unknown(input.key, output.receiptId);
          return conflict('Build output does not match this exact grant.');
        }
        this.#unknown(input.key, output.receiptId);
        await this.#check(actor, g);
        return this.#finish(input.key, { id }, () => {
          this.#db
            .prepare('INSERT INTO gd_pdf VALUES(?,?,?) ON CONFLICT(grant_id) DO NOTHING')
            .run(id, output.pdf, output.receiptId);
          this.#event('built', {
            id,
            version,
            key: input.key,
            receipt: output.receiptId,
            sha256: hash(output.pdf),
          });
        });
      },
    );
    await this.#check(actor, g);
    return this.#saved(g);
  }
  async open(handle: string, id: string, version: string, raw: unknown) {
    groupDocumentActionSchema.parse(raw);
    const doc = await this.get(handle, id, version);
    if (doc.hasPdf) return doc;
    if (!this.native.build)
      return {
        ...doc,
        state: 'failed' as const,
        error:
          'A confined native document builder is not connected. Reading mode remains available.',
      };
    return this.build(handle, id, version, raw);
  }
  async reading(handle: string, id: string, version: string): Promise<DocumentReading> {
    const { actor, g } = await this.#authorized(handle, id, version),
      files = this.#files(g),
      entry = files.find((f) => f.artifactId === g.entry)!;
    const source = entry.name.endsWith('.tex')
      ? entry
      : files.find((f) => f.name === entry.name.replace(/\.pdf$/, '.tex'));
    if (!source) return { available: false, html: '', warnings: [], labels: {} };
    if (this.#readingCount >= 8)
      throw new GroupDocumentError(
        503,
        'GROUP_DOCUMENT_BUSY',
        'The scoped reader is busy. Retry reading mode shortly.',
      );
    this.#readingCount++;
    const work = this.#readingQueue.then(async () => {
      await this.#check(actor, g);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const root = await mkdtemp(join(resolve(this.directory), 'reading-'));
      try {
        const inputs = join(root, 'inputs'),
          assets = join(root, 'assets');
        await mkdir(inputs, { mode: 0o700 });
        for (const f of files) {
          const path = join(inputs, f.name);
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(path, this.#content(g, f), { mode: 0o600, flag: 'wx' });
        }
        const result = await this.convert(join(inputs, source.name), inputs, assets).catch(() => {
          throw new GroupDocumentError(
            422,
            'GROUP_DOCUMENT_READING_FAILED',
            'Reading needs its selected supporting files and available conversion tools. Retry Reading or open Original PDF.',
          );
        });
        if (Buffer.byteLength(JSON.stringify(result)) > limits.outputBytes)
          conflict('Reading output exceeds its limit.');
        let bytes = 0;
        const exported: { name: string; data: Buffer }[] = [];
        for (const name of await readdir(assets).catch(() => [] as string[])) {
          if (!/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/.test(name))
            conflict('Invalid derived figure.');
          const path = join(assets, name),
            info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink() || info.size > limits.bytes)
            conflict('Invalid derived figure.');
          const data = await readFile(path);
          if ((bytes += data.length) > limits.outputBytes)
            conflict('Reading figures exceed their limit.');
          exported.push({ name, data });
        }
        await this.#check(actor, g);
        this.#transaction(() => {
          for (const f of exported) {
            const prior = this.#db
              .prepare('SELECT body FROM gd_assets WHERE grant_id=? AND name=?')
              .get(id, f.name);
            if (prior && hash(prior.body as Uint8Array) !== hash(f.data))
              conflict('A derived figure changed under an immutable name.');
            this.#db
              .prepare('INSERT OR IGNORE INTO gd_assets VALUES(?,?,?)')
              .run(id, f.name, f.data);
          }
          this.#event('reading', { id, version, assets: exported.map((f) => f.name) });
        });
        return result;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    const counted = work.finally(() => {
      this.#readingCount--;
    });
    this.#readingQueue = counted.catch(() => {});
    return counted;
  }
  async asset(handle: string, id: string, version: string, name: string) {
    const { actor, g } = await this.#authorized(handle, id, version);
    if (!/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/.test(name)) denied();
    const row = this.#db
      .prepare('SELECT body FROM gd_assets WHERE grant_id=? AND name=?')
      .get(id, name);
    if (!row) denied();
    const bytes = Buffer.from(row!.body as Uint8Array);
    await this.#check(actor, g);
    return bytes;
  }
}
