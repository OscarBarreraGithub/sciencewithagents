import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { groupContextSchema, type GroupContext } from '@dock/shared';
import {
  groupDocumentManifestSchema,
  groupDocumentBuildPolicy,
} from '@dock/shared/dist/group-documents.js';
import {
  GroupDocuments,
  groupDocumentVersion,
  type GroupDocumentReadingBuilder,
} from './group-documents.js';
import type { GroupDocumentsNative, GroupDocumentsAuthority } from './group-documents-native.js';
import { registerGroupDocumentsRoutes } from './group-documents-routes.js';
import { expandReadingSource } from './document-reading.js';
const id = () => randomUUID(),
  digest = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
async function fixture(
  visibility: 'shared' | 'private' = 'private',
  convert?: GroupDocumentReadingBuilder,
) {
  const root = await mkdtemp(join(tmpdir(), 'group-documents-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const context = groupContextSchema.parse({
    groupId: id(),
    memberId: id(),
    installationId: id(),
    sessionId: id(),
    visibility,
    provider: 'codex',
    nativeSessionId: id(),
  });
  const shared = groupContextSchema.parse({
    ...context,
    sessionId: id(),
    visibility: 'shared',
    nativeSessionId: id(),
  });
  const other = groupContextSchema.parse({
    ...shared,
    memberId: id(),
    installationId: id(),
    sessionId: id(),
    nativeSessionId: id(),
  });
  const foreign = groupContextSchema.parse({ ...other, groupId: id() });
  const handles = new Map<string, GroupContext>();
  const handle = id(),
    sharedHandle = id(),
    otherHandle = id(),
    foreignHandle = id();
  handles.set(handle, context);
  handles.set(sharedHandle, shared);
  handles.set(otherHandle, other);
  handles.set(foreignHandle, foreign);
  let ownerActive = true,
    active = true,
    exports = 0,
    builds = 0,
    unknown = false,
    bad = false,
    afterExport: undefined | (() => void),
    afterBuild: undefined | (() => void);
  const content = new Map<string, Buffer>([
    [
      id(),
      Buffer.from(
        '\\documentclass{article}\n\\begin{document}Hello \\input{chapter}\\end{document}',
      ),
    ],
    [id(), Buffer.from('Chapter')],
    [id(), Buffer.from('secret dependency')],
  ]);
  const names = ['report.tex', 'chapter.tex', 'private.tex'];
  const manifest = groupDocumentManifestSchema.parse({
    receiptId: id(),
    requestId: id(),
    resultId: id(),
    context,
    nativeContext: context,
    source: {
      sessionId: context.sessionId,
      provider: 'codex',
      nativeSessionId: context.nativeSessionId,
      messageId: id(),
    },
    files: [...content].map(([artifactId, bytes], i) => ({
      artifactId,
      name: names[i],
      sha256: digest(bytes),
      bytes: bytes.length,
    })),
  });
  const authority: GroupDocumentsAuthority = {
    async resolve(h) {
      const context = handles.get(h);
      if (!context) throw new Error('Denied slot');
      return {
        context,
        async revalidate() {
          if (!active) throw new Error('unavailable');
        },
      };
    },
    async revalidateOwner() {
      if (!ownerActive) throw new Error('unavailable');
    },
  };
  const exportReceipt = id(),
    buildReceipt = id();
  const native: GroupDocumentsNative = {
    async describe() {
      return manifest;
    },
    async export(input) {
      exports++;
      expect(input.manifest).toEqual(manifest);
      if (unknown) return { state: 'unknown', receiptId: exportReceipt };
      afterExport?.();
      return {
        state: 'completed',
        receiptId: exportReceipt,
        sourceReceiptId: manifest.receiptId,
        version: groupDocumentVersion(manifest),
        files: input.artifactIds.map((artifactId) => ({
          artifactId,
          bytes: bad ? Buffer.from('changed') : content.get(artifactId)!,
        })),
      };
    },
    async build(input) {
      builds++;
      expect(input.policy).toEqual(groupDocumentBuildPolicy);
      expect(input.files.map((f) => f.artifactId)).not.toContain(manifest.files[2]!.artifactId);
      if (!input.files.some((f) => f.name === 'chapter.tex'))
        throw new Error('Ungranted dependency denied');
      afterBuild?.();
      return {
        state: 'completed',
        receiptId: buildReceipt,
        grantId: input.grantId,
        version: input.version,
        pdf: Buffer.from('%PDF-1.7\nfixture'),
      };
    },
  };
  const path = join(root, 'docs.sqlite');
  let service = new GroupDocuments(path, join(root, 'reading'), authority, native, convert);
  cleanups.push(() => service.close());
  const offer = await service.offer(handle, manifest.resultId);
  const grantInput = {
    key: id(),
    offer: offer.handle,
    entry: offer.files[0]!.handle,
    dependencies: [offer.files[1]!.handle],
  };
  return {
    root,
    path,
    handle,
    sharedHandle,
    otherHandle,
    foreignHandle,
    manifest,
    offer,
    grantInput,
    native,
    authority,
    get service() {
      return service;
    },
    async restart() {
      await service.close();
      service = new GroupDocuments(path, join(root, 'reading'), authority, native, convert);
    },
    async grant() {
      return service.grant(handle, grantInput);
    },
    set ownerActive(v: boolean) {
      ownerActive = v;
    },
    set active(v: boolean) {
      active = v;
    },
    set unknown(v: boolean) {
      unknown = v;
    },
    set bad(v: boolean) {
      bad = v;
    },
    set afterExport(v: undefined | (() => void)) {
      afterExport = v;
    },
    set afterBuild(v: undefined | (() => void)) {
      afterBuild = v;
    },
    get exports() {
      return exports;
    },
    get builds() {
      return builds;
    },
  };
}
describe('scoped native documents', () => {
  it('exports exact selected receipt/version bytes once under concurrent retry and restart', async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.grant(), f.grant()]);
    expect(a).toEqual(b);
    expect(f.exports).toBe(1);
    expect((await f.service.source(f.handle, a.grantId, a.version)).toString()).toContain('Hello');
    await f.restart();
    expect(await f.grant()).toEqual(a);
    expect(f.exports).toBe(1);
    await expect(f.service.grant(f.handle, { ...f.grantInput, dependencies: [] })).rejects.toThrow(
      'different document inputs',
    );
  });
  it('denies private/other group/version reads and explicit share is auditable and revocable', async () => {
    const f = await fixture(),
      g = await f.grant();
    for (const h of [f.sharedHandle, f.otherHandle, f.foreignHandle])
      await expect(f.service.source(h, g.grantId, g.version)).rejects.toThrow('unavailable');
    await expect(f.service.source(f.handle, g.grantId, '0'.repeat(64))).rejects.toThrow(
      'unavailable',
    );
    const key = id(),
      s = await f.service.share(f.handle, g.grantId, { key, sharedHandle: f.sharedHandle });
    expect(
      await f.service.share(f.handle, g.grantId, { key, sharedHandle: f.sharedHandle }),
    ).toEqual(s);
    expect((await f.service.source(f.otherHandle, s.grantId, s.version)).length).toBeGreaterThan(0);
    await expect(f.service.source(f.foreignHandle, s.grantId, s.version)).rejects.toThrow(
      'unavailable',
    );
    const db = new DatabaseSync(f.path);
    expect(db.prepare("SELECT 1 FROM gd_events WHERE kind='explicit-share'").get()).toBeTruthy();
    db.close();
    await f.service.revoke(f.handle, g.grantId, { key: id() });
    await expect(f.service.source(f.otherHandle, s.grantId, s.version)).rejects.toThrow(
      'unavailable',
    );
    await f.restart();
    await expect(f.service.get(f.handle, g.grantId, g.version)).rejects.toThrow('unavailable');
  });
  it('rechecks source owner and reader on ALL operations, including completed key replay', async () => {
    const f = await fixture('shared'),
      g = await f.grant();
    await f.service.build(f.handle, g.grantId, g.version, { key: id() });
    f.ownerActive = false;
    for (const name of ['get', 'source', 'pdf', 'reading'] as const)
      await expect(f.service[name](f.otherHandle, g.grantId, g.version)).rejects.toThrow(
        'unavailable',
      );
    await expect(
      f.service.asset(f.otherHandle, g.grantId, g.version, 'a'.repeat(64) + '.png'),
    ).rejects.toThrow('unavailable');
    await expect(f.service.build(f.handle, g.grantId, g.version, { key: id() })).rejects.toThrow(
      'unavailable',
    );
    await expect(f.grant()).rejects.toThrow('unavailable');
    f.ownerActive = true;
    f.active = false;
    await expect(f.service.get(f.handle, g.grantId, g.version)).rejects.toThrow('unavailable');
  });
  it('retains uncertain export receipt and reconciles same key after restart', async () => {
    const f = await fixture();
    f.unknown = true;
    await expect(f.grant()).rejects.toThrow('receipt is retained');
    await f.restart();
    f.unknown = false;
    const g = await f.grant();
    expect(g.grantId).toBeTruthy();
    expect(f.exports).toBe(2);
    const db = new DatabaseSync(f.path);
    expect(
      db.prepare("SELECT COUNT(*) n FROM gd_events WHERE kind='unknown'").get()?.n,
    ).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) n FROM gd_grants').get()?.n).toBe(1);
    db.close();
  });
  it('rejects fabricated/cross-receipt bytes and revocation during export without registration', async () => {
    const f = await fixture();
    f.bad = true;
    await expect(f.grant()).rejects.toThrow('immutable manifest');
    f.bad = false;
    f.afterExport = () => {
      f.ownerActive = false;
    };
    await expect(f.grant()).rejects.toThrow('unavailable');
    const db = new DatabaseSync(f.path);
    expect(db.prepare('SELECT COUNT(*) n FROM gd_grants').get()?.n).toBe(0);
    expect(db.prepare('SELECT receipt FROM gd_operations').get()?.receipt).toBeTruthy();
    db.close();
  });
  it('passes only granted build inputs and policy; denies missing dependency and preserves build uncertainty', async () => {
    const f = await fixture(),
      g = await f.grant(),
      key = id();
    expect((await f.service.build(f.handle, g.grantId, g.version, { key })).hasPdf).toBe(true);
    await f.restart();
    await f.service.build(f.handle, g.grantId, g.version, { key });
    expect(f.builds).toBe(1);
    const small = await f.service.grant(f.handle, { ...f.grantInput, key: id(), dependencies: [] });
    await expect(
      f.service.build(f.handle, small.grantId, small.version, { key: id() }),
    ).rejects.toThrow('receipt is retained');
  });
  it('does not save native build output when membership is revoked in flight', async () => {
    const f = await fixture(),
      g = await f.grant();
    f.afterBuild = () => {
      f.ownerActive = false;
    };
    await expect(f.service.build(f.handle, g.grantId, g.version, { key: id() })).rejects.toThrow(
      'unavailable',
    );
    const db = new DatabaseSync(f.path);
    expect(db.prepare('SELECT COUNT(*) n FROM gd_pdf').get()?.n).toBe(0);
    expect(
      db.prepare("SELECT receipt FROM gd_operations WHERE state='unknown'").get()?.receipt,
    ).toBeTruthy();
    db.close();
  });
  it('converts only granted staging files, denies include escape, keeps derived assets grant-local', async () => {
    const asset = 'a'.repeat(64) + '.png';
    const converter: GroupDocumentReadingBuilder = async (source, root, assets) => {
      expect(await readFile(source, 'utf8')).toContain('Hello');
      await expect(readFile(join(root, 'private.tex'))).rejects.toThrow();
      expect(await expandReadingSource(source, root)).toContain('Chapter');
      await import('node:fs/promises').then((fs) => fs.mkdir(assets));
      await writeFile(join(assets, asset), 'figure');
      return {
        available: true,
        html: `<img src="reader-asset:${asset}">`,
        warnings: [],
        labels: {},
      };
    };
    const f = await fixture('shared', converter),
      g = await f.grant();
    expect((await f.service.reading(f.handle, g.grantId, g.version)).available).toBe(true);
    expect((await f.service.asset(f.otherHandle, g.grantId, g.version, asset)).toString()).toBe(
      'figure',
    );
    const other = await f.service.grant(f.handle, { ...f.grantInput, key: id(), dependencies: [] });
    await expect(f.service.asset(f.handle, other.grantId, other.version, asset)).rejects.toThrow(
      'unavailable',
    );
    await expect(f.service.reading(f.handle, other.grantId, other.version)).rejects.toThrow();
  });
  it('rejects traversal, macro include paths and case-colliding manifest names', async () => {
    const f = await fixture();
    for (const name of [
      '../x.tex',
      '/etc/x.tex',
      'a/../../x.tex',
      'a\\b.tex',
      'a//b.tex',
      '.hidden/x.tex',
      'https://evil/x.tex',
    ])
      expect(
        groupDocumentManifestSchema.safeParse({
          ...f.manifest,
          files: [{ ...f.manifest.files[0], name }],
        }).success,
      ).toBe(false);
    expect(
      groupDocumentManifestSchema.safeParse({
        ...f.manifest,
        files: [
          { ...f.manifest.files[0], name: 'Report.tex' },
          { ...f.manifest.files[1], name: 'report.tex' },
        ],
      }).success,
    ).toBe(false);
    const outside = join(f.root, 'outside.tex');
    await writeFile(outside, 'PRIVATE');
    const input = join(f.root, 'reading');
    await import('node:fs/promises').then((fs) => fs.mkdir(input));
    const source = join(input, 'report.tex');
    await writeFile(source, '\\input{../outside}');
    await expect(expandReadingSource(source, input)).rejects.toThrow('outside');
    await import('node:fs/promises').then((fs) => fs.symlink(outside, join(input, 'alias.tex')));
    await writeFile(source, '\\input{alias}');
    await expect(expandReadingSource(source, input)).rejects.toThrow('outside');
  });
  it('keeps one durable native build key across different browser keys and uncertainty/restart', async () => {
    const f = await fixture(),
      g = await f.grant();
    const keys: string[] = [];
    let unknown = true;
    f.native.build = async (input) => {
      keys.push(input.key);
      if (unknown) return { state: 'unknown', receiptId: id() };
      return {
        state: 'completed',
        receiptId: id(),
        grantId: input.grantId,
        version: input.version,
        pdf: Buffer.from('%PDF-test'),
      };
    };
    await expect(f.service.build(f.handle, g.grantId, g.version, { key: id() })).rejects.toThrow(
      'receipt is retained',
    );
    await f.restart();
    unknown = false;
    const [a, b] = await Promise.all([
      f.service.build(f.handle, g.grantId, g.version, { key: id() }),
      f.service.build(f.handle, g.grantId, g.version, { key: id() }),
    ]);
    expect(a.hasPdf && b.hasPdf).toBe(true);
    expect(new Set(keys).size).toBe(1);
    expect(keys.length).toBe(2);
  });
  it('does not call export for revoked owner and reads with no native compiler keep Reading available', async () => {
    const f = await fixture();
    f.ownerActive = false;
    await expect(f.grant()).rejects.toThrow('unavailable');
    expect(f.exports).toBe(0);
    f.ownerActive = true;
    delete f.native.build;
    const g = await f.grant();
    expect((await f.service.open(f.handle, g.grantId, g.version, { key: id() })).error).toContain(
      'Reading mode remains available',
    );
  });
  it('rechecks revocation after conversion and never stores late figures', async () => {
    let revoke: () => void = () => {};
    const convert: GroupDocumentReadingBuilder = async () => {
      revoke();
      return { available: true, html: 'private', warnings: [], labels: {} };
    };
    const f = await fixture('private', convert),
      g = await f.grant();
    revoke = () => {
      f.active = false;
    };
    await expect(f.service.reading(f.handle, g.grantId, g.version)).rejects.toThrow('unavailable');
  });
  it('does not duplicate grant effects when two repository instances race the same durable key', async () => {
    const f = await fixture();
    const second = new GroupDocuments(f.path, join(f.root, 'second'), f.authority, f.native);
    cleanups.push(() => second.close());
    const [a, b] = await Promise.all([f.grant(), second.grant(f.handle, f.grantInput)]);
    expect(a).toEqual(b);
    const db = new DatabaseSync(f.path);
    expect(db.prepare('SELECT COUNT(*) n FROM gd_grants').get()?.n).toBe(1);
    expect(
      db.prepare('SELECT state FROM gd_operations WHERE key=?').get(f.grantInput.key)?.state,
    ).toBe('completed');
    db.close();
  });
  it('native manifest/result mismatch and mixed-offer handles are refused before export', async () => {
    const f = await fixture();
    await expect(f.service.offer(f.handle, id())).rejects.toThrow('unavailable');
    await expect(
      f.service.grant(f.handle, { ...f.grantInput, key: id(), dependencies: [id()] }),
    ).rejects.toThrow('unavailable');
    await expect(f.service.grant(f.sharedHandle, f.grantInput)).rejects.toThrow('unavailable');
    expect(f.exports).toBe(0);
  });
  it('checks direct PDF registration without a compiler, receipt mismatch and immutable receipt drift', async () => {
    const f = await fixture();
    const bytes = Buffer.from('%PDF-1.7\nfixture'),
      artifactId = id(),
      manifest = groupDocumentManifestSchema.parse({
        ...f.manifest,
        receiptId: id(),
        resultId: id(),
        requestId: id(),
        files: [{ artifactId, name: 'report.pdf', sha256: digest(bytes), bytes: bytes.length }],
      });
    f.native.describe = async () => manifest;
    f.native.export = async () => ({
      state: 'completed',
      receiptId: id(),
      sourceReceiptId: manifest.receiptId,
      version: groupDocumentVersion(manifest),
      files: [{ artifactId, bytes }],
    });
    const offer = await f.service.offer(f.handle, manifest.resultId),
      g = await f.service.grant(f.handle, {
        key: id(),
        offer: offer.handle,
        entry: offer.files[0]!.handle,
        dependencies: [],
      });
    expect((await f.service.open(f.handle, g.grantId, g.version, { key: id() })).hasPdf).toBe(true);
    expect(await f.service.pdf(f.handle, g.grantId, g.version)).toEqual(bytes);
    expect((await f.service.reading(f.handle, g.grantId, g.version)).available).toBe(false);
    await expect(f.service.pdf(f.otherHandle, g.grantId, g.version)).rejects.toThrow('unavailable');
    f.native.export = async () => ({
      state: 'completed',
      receiptId: id(),
      sourceReceiptId: id(),
      version: groupDocumentVersion(manifest),
      files: [{ artifactId, bytes }],
    });
    await expect(
      f.service.grant(f.handle, {
        key: id(),
        offer: offer.handle,
        entry: offer.files[0]!.handle,
        dependencies: [],
      }),
    ).rejects.toThrow('exact granted source receipt');
    f.native.describe = async () => ({
      ...manifest,
      files: [{ ...manifest.files[0]!, name: 'changed.pdf' }],
    });
    await expect(f.service.offer(f.handle, manifest.resultId)).rejects.toThrow(
      'immutable artifact manifest',
    );
  });
  it('routes require normal auth, version and scope on source/PDF/Reading/assets and never expose offers/library', async () => {
    const f = await fixture(),
      g = await f.grant(),
      app = Fastify();
    cleanups.push(() => app.close());
    registerGroupDocumentsRoutes(app, f.service, (r) => r.headers['x-owner'] === 'yes');
    const base = `/api/groups/documents/${f.handle}/${g.grantId}/${g.version}`;
    for (const resource of [
      '',
      '/source',
      '/pdf',
      '/reading',
      '/assets/' + 'a'.repeat(64) + '.png',
    ])
      expect((await app.inject(base + resource)).statusCode).toBe(401);
    expect(
      (await app.inject({ url: base + '/source', headers: { 'x-owner': 'yes' } })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: base.replace(f.handle, f.otherHandle) + '/source',
          headers: { 'x-owner': 'yes' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: base + '/source', headers: { 'x-owner': 'yes' } })).headers[
        'cache-control'
      ],
    ).toBe('no-store');
    expect(
      (await app.inject({ url: '/api/groups/documents', headers: { 'x-owner': 'yes' } }))
        .statusCode,
    ).toBe(404);
    const revokeKey = id();
    const req = {
      method: 'POST' as const,
      url: base + '/revoke',
      headers: { 'x-owner': 'yes' },
      payload: { key: revokeKey },
    };
    expect((await app.inject(req)).statusCode).toBe(200);
    expect((await app.inject(req)).statusCode).toBe(200);
    expect(
      (await app.inject({ url: base + '/source', headers: { 'x-owner': 'yes' } })).statusCode,
    ).toBe(403);
  });
});
