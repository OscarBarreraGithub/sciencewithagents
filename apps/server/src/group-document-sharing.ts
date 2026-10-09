import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { documentSchema, type DocumentReading } from '@dock/shared';
import {
  groupDocumentActionSchema,
  groupDocumentShareSchema,
} from '@dock/shared/dist/group-documents.js';
import {
  sharedDocumentManifestSchema,
  type SharedDocumentManifest,
  type DocumentPublicationKey,
} from '@dock/shared/dist/group-document-transport.js';
import { GroupDocumentPublication } from './group-document-publication.js';
import { GroupDocumentError, type GroupDocuments } from './group-documents.js';
import { buildGroupDocumentReading } from './group-documents-reading.js';
import {
  privateGroupFile,
  privateGroupDirectory,
  protectGroupSidecars,
} from './group-host-storage.js';
import { publicationCanonical } from './group-publication-protocol.js';
import { GroupHostError, type GroupHost } from './group-host.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
export const sharedReportHref = (key: DocumentPublicationKey) =>
  `#/groups/report/${key.publicationId}/${key.manifestHash}`;
/** Normal report delivery owns no native launch, account or browser-selected path.
 * Only explicit owner publication exports the already-selected immutable local grant. */
export class GroupDocumentSharing {
  private readonly cache: DatabaseSync;
  private readonly directory: string;
  private closed = false;
  private readingQueue: Promise<unknown> = Promise.resolve();
  private readingCount = 0;
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(
    readonly host: GroupHost,
    readonly documents: GroupDocuments,
  ) {
    const path = join(host.directory, 'shared-report-cache.sqlite');
    privateGroupFile(path);
    this.directory = privateGroupDirectory(join(host.directory, 'shared-report-reading'));
    this.cache = new DatabaseSync(path);
    this.cache.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS report_files(publication_id TEXT NOT NULL,manifest_hash TEXT NOT NULL,file_id TEXT NOT NULL,sha256 TEXT NOT NULL,body BLOB NOT NULL,PRIMARY KEY(publication_id,manifest_hash,file_id));
      CREATE TABLE IF NOT EXISTS report_assets(publication_id TEXT NOT NULL,manifest_hash TEXT NOT NULL,name TEXT NOT NULL,body BLOB NOT NULL,PRIMARY KEY(publication_id,manifest_hash,name));
      CREATE TABLE IF NOT EXISTS report_reading(publication_id TEXT NOT NULL,manifest_hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(publication_id,manifest_hash));`);
    protectGroupSidecars(path);
    host.db
      .exec(`CREATE TABLE IF NOT EXISTS gh_document_publications(key TEXT PRIMARY KEY,input TEXT NOT NULL,manifest TEXT NOT NULL,source_handle TEXT NOT NULL,source_grant TEXT NOT NULL,target_handle TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS gh_document_publications_no_update BEFORE UPDATE ON gh_document_publications BEGIN SELECT RAISE(ABORT,'immutable report publication'); END;
      CREATE TRIGGER IF NOT EXISTS gh_document_publications_no_delete BEFORE DELETE ON gh_document_publications BEGIN SELECT RAISE(ABORT,'retained report publication'); END;`);
  }
  private async serialize<T>(key: string, work: () => Promise<T>) {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  private used() {
    return ['report_files', 'report_assets', 'report_reading'].reduce(
      (bytes, table) =>
        bytes +
        Number(
          this.cache
            .prepare(`SELECT coalesce(sum(length(CAST(body AS BLOB))),0) AS n FROM ${table}`)
            .get()!.n,
        ),
      0,
    );
  }
  private async port(handle: string) {
    if (this.closed)
      throw new GroupDocumentError(
        503,
        'GROUP_REPORT_RESTARTING',
        'The report reader is restarting.',
      );
    return new GroupDocumentPublication(await this.host.documentContext(handle));
  }
  async preflight(handle: string, id: string, version: string, raw: unknown) {
    const input = z.strictObject({ sharedHandle: z.uuid() }).parse(raw);
    const bundle = await this.documents.previewSharedBundle(
      handle,
      id,
      version,
      input.sharedHandle,
    );
    const manifest = sharedDocumentManifestSchema.parse({
      publicationId: randomUUID(),
      grantId: randomUUID(),
      version: bundle.version,
      owner: bundle.owner,
      title: bundle.title,
      entryId: bundle.entryId,
      files: bundle.files.map(({ id, name, kind, bytes, sha256 }) => ({
        id,
        name,
        kind,
        bytes,
        sha256,
      })),
    });
    try {
      return await (await this.port(input.sharedHandle)).capacity(manifest);
    } catch (error) {
      if (error instanceof Error && error.message === 'Shared report invalid')
        throw new GroupDocumentError(
          409,
          'GROUP_REPORT_HOSTING_UPDATE',
          'The group creator needs to update the hosted Groups service before checking report capacity. No report was uploaded.',
        );
      throw error;
    }
  }
  publish(handle: string, id: string, version: string, raw: unknown) {
    return this.serialize(`${handle}:${id}`, () => this.publishExact(handle, id, version, raw));
  }
  private async publishExact(handle: string, id: string, version: string, raw: unknown) {
    const input = groupDocumentShareSchema.parse(raw);
    const keyInput = publicationCanonical({ handle, id, version, target: input.sharedHandle });
    let row = this.host.db
      .prepare('SELECT input,manifest FROM gh_document_publications WHERE key=?')
      .get(input.key);
    if (row && row.input !== keyInput)
      throw new GroupDocumentError(
        409,
        'GROUP_REPORT_CHANGED',
        'Retry the same saved report publication.',
      );
    if (!row) {
      if (!this.host.localContributing(input.sharedHandle))
        throw new GroupHostError(
          409,
          'GROUP_LOCAL_READ_ONLY',
          'This group is Read-only on this computer. Choose Contribute before sharing a new report. Existing saved publications can still reconcile.',
        );
      const capacity = await this.preflight(handle, id, version, {
        sharedHandle: input.sharedHandle,
      });
      if (!capacity.fits)
        throw new GroupDocumentError(
          507,
          'GROUP_REPORT_CAPACITY',
          'The hosted group has insufficient report space or too many pending uploads. Keep this report in your project files/Git, or ask the creator about hosted capacity; no upload started.',
        );
    }
    const bundle = await this.documents.exportSharedBundle(handle, id, version, input.sharedHandle);
    if (!row) {
      if (!this.host.localContributing(input.sharedHandle))
        throw new GroupHostError(
          409,
          'GROUP_LOCAL_READ_ONLY',
          'This group became Read-only before a new report publication was admitted.',
        );
      const manifest = sharedDocumentManifestSchema.parse({
        publicationId: randomUUID(),
        grantId: randomUUID(),
        version: bundle.version,
        owner: bundle.owner,
        title: bundle.title,
        entryId: bundle.entryId,
        files: bundle.files.map(({ id, name, kind, bytes, sha256 }) => ({
          id,
          name,
          kind,
          bytes,
          sha256,
        })),
      });
      this.host.db
        .prepare('INSERT INTO gh_document_publications VALUES(?,?,?,?,?,?)')
        .run(input.key, keyInput, publicationCanonical(manifest), handle, id, input.sharedHandle);
      row = this.host.db
        .prepare('SELECT input,manifest FROM gh_document_publications WHERE key=?')
        .get(input.key)!;
    }
    const manifest = sharedDocumentManifestSchema.parse(JSON.parse(String(row.manifest)));
    const content = new Map(bundle.files.map((file) => [file.id, file.content]));
    const port = await this.port(input.sharedHandle);
    const publication = await port.publish(manifest, content);
    await this.documents.exportSharedBundle(handle, id, version, input.sharedHandle);
    // The publication is authoritative before a feed notification is attempted.
    // Notification retries never allocate a new artifact publication.
    await this.host
      .publishFeatureEvent(
        input.sharedHandle,
        `report:${publication.publicationId}`,
        JSON.stringify({
          kind: 'shared-report',
          title: manifest.title,
          href: sharedReportHref(publication),
          publication,
        }),
        `Shared report · ${manifest.title}`,
      )
      .catch(() => {});
    return {
      grantId: publication.publicationId,
      version: publication.manifestHash,
      visibility: 'shared' as const,
      href: sharedReportHref(publication),
    };
  }
  async list(handle: string, after: number) {
    return (await this.port(handle)).list(after);
  }
  private async current(handle: string, key: DocumentPublicationKey) {
    const port = await this.port(handle),
      manifest = await port.manifest(key);
    return { port, manifest };
  }
  private async file(handle: string, key: DocumentPublicationKey, fileId: string) {
    const { port, manifest } = await this.current(handle, key),
      file = manifest.files.find((f) => f.id === fileId);
    if (!file)
      throw new GroupDocumentError(
        403,
        'GROUP_REPORT_FILE_DENIED',
        'This shared report file is unavailable.',
      );
    const row = this.cache
      .prepare(
        'SELECT sha256,body FROM report_files WHERE publication_id=? AND manifest_hash=? AND file_id=?',
      )
      .get(key.publicationId, key.manifestHash, fileId);
    if (row) {
      const bytes = Buffer.from(row.body as Uint8Array);
      if (
        row.sha256 !== file.sha256 ||
        bytes.length !== file.bytes ||
        digest(bytes) !== file.sha256
      )
        throw new GroupDocumentError(
          409,
          'GROUP_REPORT_INTEGRITY',
          'Cached report integrity failed.',
        );
      await port.manifest(key);
      return bytes;
    }
    const bytes = await port.read(key, fileId);
    const used = this.used();
    // Cache capacity never makes the immutable remote report disappear.
    if (used + bytes.length <= 32 * 1024 ** 2)
      this.cache
        .prepare('INSERT OR IGNORE INTO report_files VALUES(?,?,?,?,?)')
        .run(key.publicationId, key.manifestHash, fileId, file.sha256, bytes);
    return bytes;
  }
  private saved(key: DocumentPublicationKey, manifest: SharedDocumentManifest) {
    const entry = manifest.files.find((f) => f.id === manifest.entryId)!;
    return documentSchema.parse({
      id: key.publicationId,
      name: manifest.title,
      folder: 'Shared group report',
      kind: entry.name.endsWith('.tex') ? 'tex' : 'pdf',
      state:
        entry.name.endsWith('.pdf') || manifest.files.some((f) => f.kind === 'pdf')
          ? 'ready'
          : 'source',
      hasPdf: entry.name.endsWith('.pdf') || manifest.files.some((f) => f.kind === 'pdf'),
      builtAt: null,
      openedAt: null,
      error: null,
      href: sharedReportHref(key),
    });
  }
  async get(handle: string, key: DocumentPublicationKey) {
    return this.saved(key, (await this.current(handle, key)).manifest);
  }
  async source(handle: string, key: DocumentPublicationKey) {
    const { manifest } = await this.current(handle, key);
    return this.file(handle, key, manifest.entryId);
  }
  async pdf(handle: string, key: DocumentPublicationKey) {
    const { manifest } = await this.current(handle, key),
      entry = manifest.files.find((f) => f.id === manifest.entryId)!;
    const pdf = entry.name.endsWith('.pdf') ? entry : manifest.files.find((f) => f.kind === 'pdf');
    if (!pdf)
      throw new GroupDocumentError(
        409,
        'GROUP_REPORT_PDF_PENDING',
        'The owner shared source only. Reading is available; ask the owner to build and share its PDF.',
      );
    return this.file(handle, key, pdf.id);
  }
  async open(handle: string, key: DocumentPublicationKey, raw: unknown) {
    groupDocumentActionSchema.parse(raw);
    return this.get(handle, key);
  }
  async revoke(handle: string, key: DocumentPublicationKey, raw: unknown) {
    groupDocumentActionSchema.parse(raw);
    return (await this.port(handle)).revoke(key);
  }
  revokeOriginal(handle: string, id: string) {
    return this.serialize(`${handle}:${id}`, async () => {
      const rows = this.host.db
        .prepare(
          'SELECT manifest,target_handle FROM gh_document_publications WHERE source_handle=? AND source_grant=?',
        )
        .all(handle, id);
      const { documentPublicationKey } = await import(
        '@dock/shared/dist/group-document-transport.js'
      );
      for (const row of rows) {
        const manifest = sharedDocumentManifestSchema.parse(JSON.parse(String(row.manifest))),
          key = documentPublicationKey(manifest);
        const context = await this.host.documentContext(String(row.target_handle));
        const receipt = await context.command({ kind: 'receipt', key });
        if (
          receipt.ok &&
          receipt.value.kind === 'receipt' &&
          receipt.value.receipt.state === 'absent'
        )
          continue;
        await (await this.port(String(row.target_handle))).revoke(key);
      }
    });
  }
  async reading(handle: string, key: DocumentPublicationKey): Promise<DocumentReading> {
    const { manifest, port } = await this.current(handle, key);
    const cached = this.cache
      .prepare('SELECT body FROM report_reading WHERE publication_id=? AND manifest_hash=?')
      .get(key.publicationId, key.manifestHash);
    if (cached) {
      await port.manifest(key);
      return JSON.parse(String(cached.body)) as DocumentReading;
    }
    const entry = manifest.files.find((f) => f.id === manifest.entryId)!;
    const source = entry.name.endsWith('.tex')
      ? entry
      : manifest.files.find((f) => f.name === entry.name.replace(/\.pdf$/, '.tex'));
    if (!source) return { available: false, html: '', warnings: [], labels: {} };
    if (this.readingCount >= 8)
      throw new GroupDocumentError(
        503,
        'GROUP_REPORT_BUSY',
        'The report reader is busy. Retry shortly.',
      );
    this.readingCount++;
    const work = this.readingQueue.then(async () => {
      const root = await mkdtemp(join(this.directory, 'reading-'));
      try {
        const inputs = join(root, 'inputs'),
          assets = join(root, 'assets');
        await mkdir(inputs, { mode: 0o700 });
        for (const file of manifest.files.filter((f) => f.kind !== 'pdf')) {
          const path = join(inputs, file.name);
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(path, await this.file(handle, key, file.id), { flag: 'wx', mode: 0o600 });
        }
        const result = await buildGroupDocumentReading(join(inputs, source.name), inputs, assets);
        if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 ** 2)
          throw new GroupDocumentError(
            409,
            'GROUP_REPORT_READING_LIMIT',
            'Reading output exceeds the report limit.',
          );
        const exported: { name: string; bytes: Buffer }[] = [];
        let size = 0;
        for (const name of await readdir(assets).catch(() => [] as string[])) {
          if (!/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/.test(name))
            throw new Error('Invalid derived report asset');
          const path = join(assets, name),
            st = await lstat(path);
          if (!st.isFile() || st.isSymbolicLink() || (size += st.size) > 16 * 1024 ** 2)
            throw new Error('Derived report asset limit');
          exported.push({ name, bytes: await readFile(path) });
        }
        await port.manifest(key);
        this.cache.exec('BEGIN IMMEDIATE');
        try {
          const needed = size + Buffer.byteLength(JSON.stringify(result));
          if (this.used() + needed > 32 * 1024 ** 2) {
            // These are reproducible downloads/derivations, never source grants or
            // publication receipts. Keep current Reading and its figures together.
            this.cache.exec(
              'DELETE FROM report_files; DELETE FROM report_assets; DELETE FROM report_reading;',
            );
          }
          if (needed <= 32 * 1024 ** 2) {
            for (const item of exported)
              this.cache
                .prepare('INSERT OR IGNORE INTO report_assets VALUES(?,?,?,?)')
                .run(key.publicationId, key.manifestHash, item.name, item.bytes);
            this.cache
              .prepare('INSERT OR IGNORE INTO report_reading VALUES(?,?,?)')
              .run(key.publicationId, key.manifestHash, JSON.stringify(result));
          }
          this.cache.exec('COMMIT');
        } catch (error) {
          this.cache.exec('ROLLBACK');
          throw error;
        }
        return result;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    const done = work.finally(() => {
      this.readingCount--;
    });
    this.readingQueue = done.catch(() => {});
    return done;
  }
  async asset(handle: string, key: DocumentPublicationKey, name: string) {
    await this.current(handle, key);
    if (!/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/.test(name))
      throw new GroupDocumentError(403, 'GROUP_REPORT_ASSET_DENIED', 'Report asset unavailable.');
    const lookup = () =>
      this.cache
        .prepare(
          'SELECT body FROM report_assets WHERE publication_id=? AND manifest_hash=? AND name=?',
        )
        .get(key.publicationId, key.manifestHash, name);
    let row = lookup();
    if (!row) {
      // A different report may have reclaimed this reproducible cache family
      // while its Reading view was still open. Reauthorize and regenerate it.
      await this.reading(handle, key);
      row = lookup();
    }
    if (!row)
      throw new GroupDocumentError(
        404,
        'GROUP_REPORT_ASSET_PENDING',
        'Open Reading to prepare this report figure.',
      );
    const bytes = Buffer.from(row.body as Uint8Array);
    if (digest(bytes) !== name.split('.')[0])
      throw new GroupDocumentError(
        409,
        'GROUP_REPORT_INTEGRITY',
        'Cached report figure integrity failed.',
      );
    return bytes;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.locks.values(), this.readingQueue]);
    this.cache.close();
  }
}
export function registerGroupReportRoutes(
  app: FastifyInstance,
  sharing: GroupDocumentSharing,
  authenticated: (request: FastifyRequest) => boolean,
) {
  const params = z.strictObject({
    handle: z.uuid(),
    id: z.uuid(),
    version: z.string().regex(/^[a-f0-9]{64}$/),
  });
  const guard = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (!authenticated(request))
      return reply.code(401).send({
        code: 'GROUP_AUTH_REQUIRED',
        error: 'Open an authenticated owner browser or paired device.',
      });
  };
  const run =
    (fn: (request: FastifyRequest, reply: import('fastify').FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
      try {
        return await fn(request, reply);
      } catch (error) {
        reply.type('application/json');
        if (error instanceof GroupDocumentError || error instanceof GroupHostError)
          return reply.code(error.status).send({ code: error.code, error: error.message });
        if (error instanceof Error && error.message === 'Shared report denied')
          return reply.code(403).send({
            code: 'GROUP_REPORT_DENIED',
            error: 'This shared report is unavailable to the current member.',
          });
        if (error instanceof z.ZodError)
          return reply
            .code(400)
            .send({ code: 'GROUP_REPORT_INVALID', error: 'Select a valid saved report.' });
        return reply.code(503).send({
          code: 'GROUP_REPORT_UNAVAILABLE',
          error:
            'Shared report delivery is unavailable. Reconnect and retry the same saved request; no other report is substituted.',
        });
      }
    };
  app.post(
    '/api/groups/reports',
    { onRequest: guard, bodyLimit: 4096 },
    run(async (request) => {
      const input = z
        .strictObject({ handle: z.uuid(), after: z.number().int().nonnegative().default(0) })
        .parse(request.body);
      return sharing.list(input.handle, input.after);
    }),
  );
  app.post(
    '/api/groups/documents/:handle/:id/:version/publish',
    { onRequest: guard, bodyLimit: 4096 },
    run(async (request) => {
      const p = params.parse(request.params);
      return sharing.publish(p.handle, p.id, p.version, request.body);
    }),
  );
  app.post(
    '/api/groups/documents/:handle/:id/:version/preflight',
    { onRequest: guard, bodyLimit: 4096 },
    run(async (request) => {
      const p = params.parse(request.params);
      return sharing.preflight(p.handle, p.id, p.version, request.body);
    }),
  );
  const base = '/api/groups/reports/:handle/:id/:version';
  app.get(
    base,
    { onRequest: guard },
    run(async (request) => {
      const p = params.parse(request.params);
      return sharing.get(p.handle, { publicationId: p.id, manifestHash: p.version });
    }),
  );
  for (const action of ['open', 'build', 'revoke'] as const)
    app.post(
      `${base}/${action}`,
      { onRequest: guard, bodyLimit: 4096 },
      run(async (request) => {
        const p = params.parse(request.params),
          key = { publicationId: p.id, manifestHash: p.version };
        return action === 'revoke'
          ? sharing.revoke(p.handle, key, request.body)
          : sharing.open(p.handle, key, request.body);
      }),
    );
  for (const kind of ['source', 'pdf', 'reading'] as const)
    app.get(
      `${base}/${kind}`,
      { onRequest: guard },
      run(async (request, reply) => {
        const p = params.parse(request.params);
        if (kind === 'pdf') reply.type('application/pdf');
        if (kind === 'source') reply.type('application/octet-stream');
        return sharing[kind](p.handle, { publicationId: p.id, manifestHash: p.version });
      }),
    );
  app.get(
    `${base}/assets/:asset`,
    { onRequest: guard },
    run(async (request, reply) => {
      const p = params
        .extend({ asset: z.string().regex(/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/) })
        .parse(request.params);
      reply.type(
        p.asset.endsWith('.png')
          ? 'image/png'
          : p.asset.endsWith('.webp')
            ? 'image/webp'
            : p.asset.endsWith('.gif')
              ? 'image/gif'
              : 'image/jpeg',
      );
      return sharing.asset(p.handle, { publicationId: p.id, manifestHash: p.version }, p.asset);
    }),
  );
}
