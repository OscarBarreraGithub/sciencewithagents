import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { membershipEnvelopeSchema } from '@dock/shared/dist/group-membership.js';
import {
  documentPublicationKey,
  DOCUMENT_TRANSPORT_LIMITS as L,
  sharedDocumentManifestSchema,
  type DocumentTransportCommand,
} from '@dock/shared/dist/group-document-transport.js';
import { publicationCanonical, type PublicationBinding } from '@dock/shared/dist/group-delivery.js';
import { groupContextSchema } from '@dock/shared';
import { GroupDocumentPublication } from '../../server/src/group-document-publication.js';
import { creationGroupId, setupHash } from '../src/crypto.js';
import worker from '../src/index.js';
const uuid = () => crypto.randomUUID();
const secret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
async function fixture() {
  const setup = secret(),
    credential = secret(),
    operationId = uuid();
  Object.assign(env, { HOSTING_MODE: 'local-test', GROUP_SETUP_HASH: await setupHash(setup) });
  const groupId = await creationGroupId(await setupHash(setup), operationId),
    stub = env.GROUPS.getByName(groupId);
  const membership = (command: unknown, token = credential) =>
    stub.execute(membershipEnvelopeSchema.parse({ groupId, credential: token, command }));
  const owner = await stub.execute(
    membershipEnvelopeSchema.parse({
      groupId,
      credential,
      setupCapability: setup,
      command: { kind: 'initialize', operationId, groupName: 'Shared reports', displayName: 'A' },
    }),
  );
  if (!owner.ok || owner.value.kind !== 'identity') throw new Error('initialize');
  async function enroll(approve: boolean) {
    const inviteSecret = secret(),
      token = secret(),
      confirmation = secret();
    await membership({ kind: 'invite', operationId: uuid(), inviteSecret, ttlSeconds: 900 });
    const reply = await membership(
      { kind: 'join', operationId: uuid(), inviteSecret, confirmation, displayName: 'B' },
      token,
    );
    if (!reply.ok || reply.value.kind !== 'identity') throw new Error('join');
    if (approve)
      expect(
        (
          await membership({
            kind: 'approve',
            operationId: uuid(),
            installationId: reply.value.identity.installationId,
            confirmation,
          })
        ).ok,
      ).toBe(true);
    return { token, identity: reply.value.identity };
  }
  const b = await enroll(true),
    pending = await enroll(false);
  const binding: PublicationBinding = {
    groupId: uuid(),
    installationId: uuid(),
    remoteGroupId: groupId,
    epoch: uuid(),
    endpointId: uuid(),
    credentialRevision: 1,
  };
  const context = groupContextSchema.parse({
    groupId: binding.groupId,
    installationId: binding.installationId,
    memberId: uuid(),
    sessionId: uuid(),
    provider: 'owner',
    nativeSessionId: uuid(),
    visibility: 'shared',
  });
  expect(
    (
      await stub.deliver({
        groupId,
        credential,
        command: {
          kind: 'registerSource',
          operationId: uuid(),
          binding,
          memberId: context.memberId,
          source: {
            sessionId: context.sessionId,
            provider: context.provider,
            nativeSessionId: context.nativeSessionId,
            messageId: uuid(),
          },
        },
      })
    ).ok,
  ).toBe(true);
  const call = (command: DocumentTransportCommand, token = credential) =>
    stub.documents({ groupId, credential: token, command });
  const http = async (command: DocumentTransportCommand, token: string) => {
    const response = await worker.fetch(
      new Request(`http://127.0.0.1/v1/groups/${groupId}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(command),
      }),
      env,
    );
    return response.json();
  };
  const readerBinding: PublicationBinding = {
    ...binding,
    groupId: uuid(),
    installationId: uuid(),
    epoch: uuid(),
    endpointId: uuid(),
  };
  const readerContext = groupContextSchema.parse({
    ...context,
    groupId: readerBinding.groupId,
    installationId: readerBinding.installationId,
    memberId: uuid(),
    sessionId: uuid(),
    nativeSessionId: uuid(),
  });
  const make = (token: string, command = (c: DocumentTransportCommand) => http(c, token)) =>
    new GroupDocumentPublication({
      binding: token === credential ? binding : readerBinding,
      context: token === credential ? context : readerContext,
      revalidate: async () => {},
      command,
    });
  const bytes = Buffer.from(
      '\\documentclass{article}\n\\begin{document}e\u0301 exact \\end{document}\n',
    ),
    pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(L.chunkBytes + 13, 42)]),
    sourceId = uuid(),
    pdfId = uuid();
  const manifest = sharedDocumentManifestSchema.parse({
    publicationId: uuid(),
    grantId: uuid(),
    version: sha(bytes),
    owner: context,
    title: 'Exact shared scientific content',
    entryId: sourceId,
    files: [
      { id: sourceId, name: 'report.tex', kind: 'source', bytes: bytes.length, sha256: sha(bytes) },
      { id: pdfId, name: 'report.pdf', kind: 'pdf', bytes: pdf.length, sha256: sha(pdf) },
    ],
  });
  const files = new Map<string, Uint8Array>([
    [sourceId, bytes],
    [pdfId, pdf],
  ]);
  return {
    stub,
    groupId,
    credential,
    membership,
    b,
    pending,
    binding,
    context,
    call,
    http,
    make,
    manifest,
    files,
    sourceId,
    pdfId,
    bytes,
    pdf,
  };
}
afterEach(async () => {
  await reset();
  Object.assign(env, { HOSTING_MODE: 'disabled', GROUP_SETUP_HASH: '' });
});
it('two authenticated hosts retain exact source/PDF through lost ACK and eviction; download only on demand; revoke immediately', async () => {
  const f = await fixture();
  let lose = true,
    commits = 0;
  const a = f.make(f.credential, async (c) => {
    const reply = await f.http(c, f.credential);
    if (c.kind === 'commit') {
      commits++;
      if (lose) {
        lose = false;
        throw new Error('offline after commit');
      }
    }
    return reply;
  });
  await expect(a.publish(f.manifest, f.files)).rejects.toThrow('offline');
  const key = await a.publish(f.manifest, f.files);
  expect(commits).toBe(1);
  const readerCommands: string[] = [];
  const b = f.make(f.b.token, async (c) => {
      readerCommands.push(c.kind);
      return f.http(c, f.b.token);
    }),
    listed = await b.list();
  expect(readerCommands).toEqual(['list']);
  expect(listed.kind).toBe('list');
  if (listed.kind !== 'list') throw new Error('list');
  expect(listed.entries[0].manifest).toEqual(f.manifest);
  expect(
    await runInDurableObject(
      f.stub,
      (_, state) =>
        state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) n FROM document_chunks').one().n,
    ),
  ).toBe(3);
  await evictDurableObject(f.stub);
  expect(await b.read(key, f.sourceId)).toEqual(f.bytes);
  expect(await b.read(key, f.pdfId)).toEqual(f.pdf);
  expect(await f.call({ kind: 'manifest', key }, f.pending.token)).toEqual({
    ok: false,
    error: 'denied',
  });
  expect(await f.call({ kind: 'revoke', key }, f.b.token)).toEqual({ ok: false, error: 'denied' });
  await a.revoke(key);
  await expect(b.read(key, f.pdfId)).rejects.toThrow('denied');
  expect(await a.list()).toMatchObject({ kind: 'list', entries: [] });
}, 20000);
it('proves exact shared producer/context, rejects private/collision inputs, and does not double-charge retries', async () => {
  const f = await fixture(),
    key = documentPublicationKey(f.manifest);
  expect(
    sharedDocumentManifestSchema.safeParse({
      ...f.manifest,
      owner: { ...f.context, visibility: 'private' },
    }).success,
  ).toBe(false);
  const changed = sharedDocumentManifestSchema.parse({
    ...f.manifest,
    owner: { ...f.context, sessionId: uuid() },
  });
  expect(
    await f.call({
      kind: 'begin',
      key: documentPublicationKey(changed),
      manifest: changed,
      binding: f.binding,
    }),
  ).toEqual({ ok: false, error: 'denied' });
  expect(
    await f.call({
      kind: 'begin',
      key,
      manifest: f.manifest,
      binding: { ...f.binding, epoch: uuid() },
    }),
  ).toEqual({ ok: false, error: 'denied' });
  expect(
    await f.call({ kind: 'begin', key, manifest: f.manifest, binding: f.binding }),
  ).toMatchObject({ ok: true, value: { receipt: { state: 'staged' } } });
  expect(
    await f.call({
      kind: 'begin',
      key,
      manifest: { ...f.manifest, title: 'changed' },
      binding: f.binding,
    }),
  ).toEqual({ ok: false, error: 'invalid' });
  const chunk = {
    kind: 'chunk' as const,
    key,
    fileId: f.sourceId,
    index: 0,
    base64: f.bytes.toString('base64'),
  };
  const first = await f.call(chunk);
  expect(await f.call(chunk)).toEqual(first);
  expect(
    await runInDurableObject(
      f.stub,
      (_, state) =>
        state.storage.sql.exec<{ written: number }>('SELECT written FROM document_control').one()
          .written,
    ),
  ).toBe(f.bytes.length);
  expect(
    await f.call({ ...chunk, base64: Buffer.alloc(f.bytes.length, 43).toString('base64') }),
  ).toEqual({ ok: false, error: 'conflict' });
  expect(await f.call({ kind: 'commit', key })).toEqual({ ok: false, error: 'conflict' });
  await f.membership({
    kind: 'revoke',
    operationId: uuid(),
    installationId: f.b.identity.installationId,
  });
  expect(await f.call({ kind: 'list', after: 0, limit: 4 }, f.b.token)).toEqual({
    ok: false,
    error: 'denied',
  });
});
it('bounds pending/storage without lifetime cutoff or destroying historical receipts and membership revoke reserve', async () => {
  const f = await fixture(),
    a = f.make(f.credential),
    key = await a.publish(f.manifest, f.files);
  await runInDurableObject(f.stub, (_, state) => {
    const original = state.storage.sql
      .exec<{
        actor: string;
        manifest: string;
      }>('SELECT actor,manifest FROM document_publications LIMIT 1')
      .one();
    for (let i = 0; i < 129; i++) {
      const m = sharedDocumentManifestSchema.parse({
        ...JSON.parse(original.manifest),
        publicationId: uuid(),
      });
      const k = documentPublicationKey(m);
      state.storage.sql
        .exec(
          "INSERT INTO document_publications(id,hash,actor,manifest,state,charge) VALUES(?,?,?,?,'committed',4096)",
          m.publicationId,
          k.manifestHash,
          original.actor,
          publicationCanonical(m),
        )
        .toArray();
    }
    state.storage.sql.exec('UPDATE document_control SET logical=logical+?', 129 * 4096).toArray();
  });
  const next = { ...f.manifest, publicationId: uuid() };
  expect(await a.publish(next, f.files)).toEqual(documentPublicationKey(next));
  await runInDurableObject(f.stub, (_, state) =>
    state.storage.sql.exec('UPDATE document_control SET logical=?', L.logicalBytes).toArray(),
  );
  await expect(a.publish({ ...f.manifest, publicationId: uuid() }, f.files)).rejects.toThrow(
    'limit',
  );
  expect(await a.publish(f.manifest, f.files)).toEqual(key);
  expect(await f.make(f.b.token).read(key, f.sourceId)).toEqual(f.bytes);
  expect(
    (
      await f.membership({
        kind: 'revoke',
        operationId: uuid(),
        installationId: f.b.identity.installationId,
      })
    ).ok,
  ).toBe(true);
}, 20000);
it('limits outstanding stages and refuses a wrong whole-file digest', async () => {
  const f = await fixture();
  for (let i = 0; i < L.pending; i++) {
    const manifest = { ...f.manifest, publicationId: uuid() };
    expect(
      (
        await f.call({
          kind: 'begin',
          key: documentPublicationKey(manifest),
          manifest,
          binding: f.binding,
        })
      ).ok,
    ).toBe(true);
  }
  const manifest = { ...f.manifest, publicationId: uuid() };
  expect(
    await f.call({
      kind: 'begin',
      key: documentPublicationKey(manifest),
      manifest,
      binding: f.binding,
    }),
  ).toEqual({ ok: false, error: 'limit' });
  const staged = await runInDurableObject(f.stub, (_, state) =>
    state.storage.sql
      .exec<{
        id: string;
        hash: string;
      }>('SELECT id,hash FROM document_publications ORDER BY sequence LIMIT 1')
      .one(),
  );
  const oldKey = { publicationId: staged.id, manifestHash: staged.hash };
  const reserved = await runInDurableObject(
    f.stub,
    (_, state) =>
      state.storage.sql.exec<{ logical: number }>('SELECT logical FROM document_control').one()
        .logical,
  );
  expect(await f.call({ kind: 'revoke', key: oldKey })).toMatchObject({
    ok: true,
    value: { receipt: { state: 'revoked' } },
  });
  expect(
    await runInDurableObject(
      f.stub,
      (_, state) =>
        state.storage.sql.exec<{ logical: number }>('SELECT logical FROM document_control').one()
          .logical,
    ),
  ).toBeLessThan(reserved);
  expect(
    (
      await f.call({
        kind: 'begin',
        key: documentPublicationKey(manifest),
        manifest,
        binding: f.binding,
      })
    ).ok,
  ).toBe(true);
  expect(await f.call({ kind: 'receipt', key: oldKey })).toMatchObject({
    ok: true,
    value: { receipt: { state: 'revoked' } },
  });
  const g = await fixture(),
    bad = { ...g.manifest, files: [{ ...g.manifest.files[0], sha256: '0'.repeat(64) }] },
    key = documentPublicationKey(bad);
  await g.call({ kind: 'begin', key, manifest: bad, binding: g.binding });
  await g.call({
    kind: 'chunk',
    key,
    fileId: g.sourceId,
    index: 0,
    base64: g.bytes.toString('base64'),
  });
  expect(await g.call({ kind: 'commit', key })).toEqual({ ok: false, error: 'conflict' });
});

it('resumes the same staged upload after an acknowledged chunk loses its response', async () => {
  const f = await fixture();
  let lose = true;
  const sent: string[] = [];
  const a = f.make(f.credential, async (c) => {
    sent.push(c.kind === 'chunk' ? `${c.fileId}:${c.index}` : c.kind);
    const result = await f.http(c, f.credential);
    if (c.kind === 'chunk' && c.fileId === f.pdfId && c.index === 0 && lose) {
      lose = false;
      throw new Error('lost chunk ACK');
    }
    return result;
  });
  await expect(a.publish(f.manifest, f.files)).rejects.toThrow('lost chunk ACK');
  sent.length = 0;
  const key = await a.publish(f.manifest, f.files);
  expect(sent.filter((v) => v.includes(':'))).toEqual([`${f.pdfId}:1`]);
  expect(await f.make(f.b.token).read(key, f.pdfId)).toEqual(f.pdf);
});
