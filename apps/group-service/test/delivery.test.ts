import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { groupEventSchema } from '@dock/shared/dist/groups.js';
import {
  membershipEnvelopeSchema,
  type MembershipIdentity,
} from '@dock/shared/dist/group-membership.js';
import {
  DELIVERY_LIMITS as L,
  publicationEnvelope,
  publicationKeySchema,
  deliveryEnvelopeSchema,
  type DeliveryCommand,
  type PublicationBinding,
} from '@dock/shared/dist/group-delivery.js';
import { creationGroupId, setupHash } from '../src/crypto.js';
const uuid = () => crypto.randomUUID();
const keyOf = (header: Parameters<typeof publicationKeySchema.parse>[0]) => {
  const { event: _event, ...key } =
    header as import('@dock/shared/dist/group-delivery.js').PublicationHeader;
  return publicationKeySchema.parse(key);
};
const secret = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
async function fixture() {
  const setup = secret(),
    credential = secret(),
    init = { kind: 'initialize', operationId: uuid(), groupName: 'Research', displayName: 'Alice' };
  Object.assign(env, { HOSTING_MODE: 'local-test', GROUP_SETUP_HASH: await setupHash(setup) });
  const groupId = await creationGroupId(await setupHash(setup), init.operationId),
    stub = env.GROUPS.getByName(groupId);
  const member = await stub.execute(
    membershipEnvelopeSchema.parse({ groupId, credential, setupCapability: setup, command: init }),
  );
  if (!member.ok || member.value.kind !== 'identity') throw new Error('fixture');
  const identity = member.value.identity;
  const binding: PublicationBinding = {
    groupId: uuid(),
    installationId: uuid(),
    epoch: uuid(),
    remoteGroupId: groupId,
    endpointId: uuid(),
    credentialRevision: 1,
  };
  const call = (command: DeliveryCommand, token = credential) =>
    stub.deliver(deliveryEnvelopeSchema.parse({ groupId, credential: token, command }));
  const membership = (command: unknown, token = credential) =>
    stub.execute(membershipEnvelopeSchema.parse({ groupId, credential: token, command }));
  const memberId = uuid(),
    sessionId = uuid(),
    nativeSessionId = uuid();
  async function event(text = 'e\u0301 🧬 exact', count = 1) {
    const source = { sessionId, provider: 'owner' as const, nativeSessionId, messageId: uuid() };
    expect(
      (await call({ kind: 'registerSource', operationId: uuid(), binding, memberId, source })).ok,
    ).toBe(true);
    const { publicationHash } = await import('@dock/shared/dist/group-delivery.js');
    const chunks = Array.from({ length: count }, () => text);
    const original = chunks.join('');
    const record = groupEventSchema.parse({
      eventId: uuid(),
      sequence: 1,
      scope: {
        groupId: binding.groupId,
        memberId,
        installationId: binding.installationId,
        visibility: 'shared',
        source: {
          sessionId,
          provider: 'owner',
          nativeSessionId: source.nativeSessionId,
          messageId: source.messageId,
        },
        causalRefs: [],
      },
      operationId: uuid(),
      entityId: uuid(),
      revision: 1,
      category: 'Finding',
      condensedText: 'Exact',
      evidenceRefs: [],
      corrects: null,
      manifest: {
        bytes: new TextEncoder().encode(original).length,
        sha256: publicationHash(original),
        chunks: chunks.map((s, index) => ({
          index,
          bytes: new TextEncoder().encode(s).length,
          sha256: publicationHash(s),
        })),
      },
      recordedAt: new Date().toISOString(),
    });
    return publicationEnvelope(binding, uuid(), { event: record, original });
  }
  async function publish(envelope: Awaited<ReturnType<typeof event>>) {
    await call({ kind: 'effect', packet: { kind: 'begin', header: envelope.header } });
    const key = keyOf(envelope.header);
    for (const chunk of envelope.chunks)
      await call({ kind: 'effect', packet: { kind: 'chunk', key, chunk } });
    return call({ kind: 'effect', packet: { kind: 'commit', key } });
  }
  return {
    stub,
    groupId,
    credential,
    identity,
    binding,
    memberId,
    sessionId,
    nativeSessionId,
    call,
    membership,
    event,
    publish,
  };
}
afterEach(async () => {
  await reset();
  Object.assign(env, { HOSTING_MODE: 'disabled', GROUP_SETUP_HASH: '' });
});
it('persists exact receipts/chunks across eviction, immutable originals and authoritative snapshot cursors', async () => {
  const f = await fixture(),
    a = await f.event(' e\u0301 é 🧬 \u202e\n exact', 3);
  const committed = await f.publish(a);
  expect(committed).toMatchObject({
    ok: true,
    value: {
      kind: 'receipt',
      receipt: { state: 'committed', remoteSequence: 1, eventId: a.header.event.eventId },
    },
  });
  await evictDurableObject(f.stub);
  expect(await f.call({ kind: 'receipt', key: keyOf(a.header) })).toEqual(committed);
  expect(await f.publish(a)).toEqual(committed);
  const b = await f.event();
  await f.publish(b);
  const page = await f.call({ kind: 'feed', after: 0, limit: 1, cursor: null });
  if (!page.ok || page.value.kind !== 'feed' || !page.value.continuation) throw new Error('page');
  expect(page.value.entries[0].header).toEqual(a.header);
  const c = await f.event();
  await f.publish(c);
  const next = await f.call({ kind: 'feed', after: 0, limit: 1, cursor: page.value.continuation });
  expect(next).toMatchObject({
    ok: true,
    value: {
      kind: 'feed',
      watermark: 2,
      continuation: null,
      entries: [{ header: b.header, remoteSequence: 2 }],
    },
  });
  const expansion = await f.call({
    kind: 'expand',
    eventId: a.header.event.eventId,
    start: 0,
    count: 4,
  });
  expect(expansion).toMatchObject({
    ok: true,
    value: { kind: 'expansion', header: a.header, chunks: a.chunks, next: null },
  });
  await runInDurableObject(f.stub, (_instance, state) => {
    expect(() =>
      state.storage.sql.exec('UPDATE delivery_chunks SET chunk=?', 'changed').toArray(),
    ).toThrow();
    expect(() => state.storage.sql.exec('DELETE FROM delivery_operations').toArray()).toThrow();
  });
});
it('rejects ambient source IDs, wrong authors, private/cross-group headers and forged cursor scopes', async () => {
  const f = await fixture(),
    e = await f.event();
  for (const field of ['nativeSessionId', 'messageId', 'sessionId'] as const) {
    const header = structuredClone(e.header);
    header.event.scope.source = groupEventSchema.shape.scope.shape.source.parse({
      ...header.event.scope.source,
      [field]: uuid(),
    });
    expect(await f.call({ kind: 'effect', packet: { kind: 'begin', header } })).toEqual({
      ok: false,
      error: 'denied',
    });
  }
  const header = structuredClone(e.header);
  header.event.scope.memberId = uuid() as typeof header.event.scope.memberId;
  expect(await f.call({ kind: 'effect', packet: { kind: 'begin', header } })).toEqual({
    ok: false,
    error: 'denied',
  });
  const cross = structuredClone(e.header);
  cross.binding.remoteGroupId = uuid();
  expect(await f.call({ kind: 'effect', packet: { kind: 'begin', header: cross } })).toEqual({
    ok: false,
    error: 'denied',
  });
  const privateHeader = structuredClone(e.header);
  privateHeader.event.scope.visibility = 'private';
  expect(
    await f.stub.deliver({
      groupId: f.groupId,
      credential: f.credential,
      command: { kind: 'effect', packet: { kind: 'begin', header: privateHeader } },
    }),
  ).toEqual({ ok: false, error: 'invalid' });
  expect(
    await f.call({
      kind: 'feed',
      after: 0,
      limit: 1,
      cursor: { version: 1, groupId: uuid(), after: 0, watermark: 0 },
    }),
  ).toEqual({ ok: false, error: 'denied' });
});
it('authenticates inside mutations and receipt/read transactions during revocation races', async () => {
  const f = await fixture();
  const inviteSecret = secret(),
    credential = secret(),
    confirmation = secret();
  await f.membership({ kind: 'invite', operationId: uuid(), inviteSecret, ttlSeconds: 900 });
  const joined = await f.membership(
    { kind: 'join', operationId: uuid(), inviteSecret, confirmation, displayName: 'Bob' },
    credential,
  );
  if (!joined.ok || joined.value.kind !== 'identity') throw new Error('join');
  const bob: MembershipIdentity = joined.value.identity;
  await f.membership({
    kind: 'approve',
    operationId: uuid(),
    installationId: bob.installationId,
    confirmation,
  });
  const e = await f.event();
  await f.publish(e);
  const key = keyOf(e.header);
  const [revoke, read] = await Promise.all([
    f.membership(
      { kind: 'revoke', operationId: uuid(), installationId: f.identity.installationId },
      credential,
    ),
    f.call({ kind: 'receipt', key }),
  ]);
  expect(revoke.ok).toBe(true);
  expect(read.ok || (!read.ok && read.error === 'denied')).toBe(true);
  await evictDurableObject(f.stub);
  for (const command of [
    { kind: 'receipt', key },
    { kind: 'effect', packet: { kind: 'commit', key } },
    { kind: 'feed', after: 0, limit: 1, cursor: null },
    { kind: 'expand', eventId: e.header.event.eventId, start: 0, count: 1 },
  ] as DeliveryCommand[]) {
    expect(await f.call(command)).toEqual({ ok: false, error: 'denied' });
  }
});
it('fences event quotas without consuming membership history or blocking revocation reserve', async () => {
  const f = await fixture(),
    e = await f.event();
  await runInDurableObject(f.stub, (_instance, state) => {
    state.storage.sql.exec('UPDATE delivery_control SET logical=?', L.logicalBytes).toArray();
  });
  expect(await f.call({ kind: 'effect', packet: { kind: 'begin', header: e.header } })).toEqual({
    ok: false,
    error: 'limit',
  });
  const before = await runInDurableObject(f.stub, (_instance, state) =>
    state.storage.sql.exec('SELECT operations FROM metadata').one(),
  );
  expect(
    (
      await f.membership({
        kind: 'invite',
        operationId: uuid(),
        inviteSecret: secret(),
        ttlSeconds: 10,
      })
    ).ok,
  ).toBe(true);
  await runInDurableObject(f.stub, (_instance, state) => {
    state.storage.sql
      .exec('UPDATE delivery_control SET logical=0,allocated=?', L.databaseBytes)
      .toArray();
  });
  expect(await f.call({ kind: 'effect', packet: { kind: 'begin', header: e.header } })).toEqual({
    ok: false,
    error: 'limit',
  });
  expect(
    (
      await f.membership({
        kind: 'revoke',
        operationId: uuid(),
        installationId: f.identity.installationId,
      })
    ).ok,
  ).toBe(true);
  const after = await runInDurableObject(f.stub, (_instance, state) =>
    state.storage.sql.exec('SELECT operations FROM metadata').one(),
  );
  expect(after.operations).toBe(Number(before.operations) + 2);
});
it('rolls back physical event growth at the fence and holds authorization closed after platform write failures', async () => {
  const f = await fixture(),
    e = await f.event();
  await runInDurableObject(f.stub, (_instance, state) => {
    state.storage.sql
      .exec(
        'CREATE TABLE pad(x BLOB); CREATE TRIGGER pad_event AFTER INSERT ON delivery_operations BEGIN INSERT INTO pad VALUES(zeroblob(1048576)); END;',
      )
      .toArray();
    state.storage.sql
      .exec('UPDATE delivery_control SET allocated=?', L.databaseBytes - 4096)
      .toArray();
  });
  expect(await f.call({ kind: 'effect', packet: { kind: 'begin', header: e.header } })).toEqual({
    ok: false,
    error: 'limit',
  });
  await runInDurableObject(f.stub, (_instance, state) => {
    expect(state.storage.sql.exec('SELECT count(*) AS n FROM pad').one().n).toBe(0);
    expect(state.storage.sql.exec('SELECT count(*) AS n FROM delivery_operations').one().n).toBe(0);
    state.storage.sql
      .exec(
        "CREATE TRIGGER fail_auth BEFORE UPDATE ON delivery_control BEGIN SELECT RAISE(ABORT,'fault'); END",
      )
      .toArray();
  });
  expect(await f.call({ kind: 'feed', after: 0, limit: 1, cursor: null })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  expect(await f.membership({ kind: 'roster', after: 0, limit: 1 })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  await evictDurableObject(f.stub);
  expect(await f.call({ kind: 'receipt', key: keyOf(e.header) })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  await runInDurableObject(f.stub, (_i, state) =>
    state.storage.sql.exec('DROP TRIGGER fail_auth').toArray(),
  );
  await evictDurableObject(f.stub);
  expect((await f.call({ kind: 'feed', after: 0, limit: 1, cursor: null })).ok).toBe(true);
  expect((await f.membership({ kind: 'roster', after: 0, limit: 1 })).ok).toBe(true);
});
it('retains failed revocation requests across eviction and resumes remaining members after exact retry', async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, (_instance, state) => {
    state.storage.sql
      .exec(
        "CREATE TRIGGER fail_revoke BEFORE UPDATE ON enrollments BEGIN SELECT RAISE(ABORT,'fault'); END",
      )
      .toArray();
  });
  const pendingSecret = secret(),
    token = secret(),
    confirmation = secret();
  await f.membership({
    kind: 'invite',
    operationId: uuid(),
    inviteSecret: pendingSecret,
    ttlSeconds: 900,
  });
  const joined = await f.membership(
    {
      kind: 'join',
      operationId: uuid(),
      inviteSecret: pendingSecret,
      confirmation,
      displayName: 'Bob',
    },
    token,
  );
  if (!joined.ok || joined.value.kind !== 'identity') throw new Error('join');
  // Remove the injected fault to approve, then restore it for the real revoke.
  await runInDurableObject(f.stub, (_i, state) =>
    state.storage.sql.exec('DROP TRIGGER fail_revoke').toArray(),
  );
  await f.membership({
    kind: 'approve',
    operationId: uuid(),
    installationId: joined.value.identity.installationId,
    confirmation,
  });
  await runInDurableObject(f.stub, (_i, state) =>
    state.storage.sql
      .exec(
        "CREATE TRIGGER fail_revoke BEFORE UPDATE ON enrollments BEGIN SELECT RAISE(ABORT,'fault'); END",
      )
      .toArray(),
  );
  const revoke = {
    kind: 'revoke',
    operationId: uuid(),
    installationId: joined.value.identity.installationId,
  };
  expect(await f.membership(revoke)).toEqual({ ok: false, error: 'unavailable' });
  await runInDurableObject(f.stub, (_i, state) => {
    expect(
      state.storage.sql
        .exec('SELECT state FROM enrollments WHERE installation_id=?', revoke.installationId)
        .one().state,
    ).toBe('active');
    expect(
      state.storage.sql
        .exec('SELECT state FROM delivery_revocations WHERE target_id=?', revoke.installationId)
        .one().state,
    ).toBe('open');
  });
  expect(await f.call({ kind: 'feed', after: 0, limit: 1, cursor: null })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  await evictDurableObject(f.stub);
  expect(await f.membership({ kind: 'roster', after: 0, limit: 1 })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  await runInDurableObject(f.stub, (_i, state) =>
    state.storage.sql.exec('DROP TRIGGER fail_revoke').toArray(),
  );
  expect((await f.membership(revoke)).ok).toBe(true);
  await evictDurableObject(f.stub);
  expect((await f.call({ kind: 'feed', after: 0, limit: 1, cursor: null })).ok).toBe(true);
  expect((await f.membership({ kind: 'roster', after: 0, limit: 1 })).ok).toBe(true);
  expect(await f.call({ kind: 'feed', after: 0, limit: 1, cursor: null }, token)).toEqual({
    ok: false,
    error: 'denied',
  });
});

it('bounds operation/source lifetime and denies cross-credential receipt/effect adoption', async () => {
  const f = await fixture(),
    e = await f.event();
  await f.publish(e);
  const key = keyOf(e.header),
    changed = { ...key, payloadHash: 'f'.repeat(64) };
  expect(await f.call({ kind: 'receipt', key: changed })).toMatchObject({
    ok: true,
    value: { kind: 'receipt', receipt: { state: 'collision' } },
  });
  const changedHeader = structuredClone(e.header);
  changedHeader.event.condensedText = 'Changed after commit';
  expect(
    await f.call({ kind: 'effect', packet: { kind: 'begin', header: changedHeader } }),
  ).toMatchObject({ ok: true, value: { kind: 'receipt', receipt: { state: 'collision' } } });
  const inviteSecret = secret(),
    credential = secret(),
    confirmation = secret();
  await f.membership({ kind: 'invite', operationId: uuid(), inviteSecret, ttlSeconds: 900 });
  const joined = await f.membership(
    { kind: 'join', operationId: uuid(), inviteSecret, confirmation, displayName: 'Bob' },
    credential,
  );
  if (!joined.ok || joined.value.kind !== 'identity') throw new Error('join');
  await f.membership({
    kind: 'approve',
    operationId: uuid(),
    installationId: joined.value.identity.installationId,
    confirmation,
  });
  expect(await f.call({ kind: 'receipt', key }, credential)).toEqual({
    ok: false,
    error: 'denied',
  });
  expect(await f.call({ kind: 'effect', packet: { kind: 'commit', key } }, credential)).toEqual({
    ok: false,
    error: 'denied',
  });
  const sourceCommand = {
    kind: 'registerSource' as const,
    operationId: uuid(),
    binding: f.binding,
    memberId: f.memberId,
    source: {
      sessionId: f.sessionId,
      nativeSessionId: f.nativeSessionId,
      messageId: uuid(),
      provider: 'owner' as const,
    },
  };
  const original = await f.call(sourceCommand);
  expect(original.ok).toBe(true);
  await evictDurableObject(f.stub);
  expect(await f.call(sourceCommand)).toEqual(original);
  expect(await f.call({ ...sourceCommand, memberId: uuid() })).toEqual({
    ok: false,
    error: 'conflict',
  });
  const next = await f.event();
  await runInDurableObject(f.stub, (_instance, state) => {
    for (let i = 1; i < L.operations; i++)
      state.storage.sql
        .exec(
          'INSERT INTO delivery_operations(operation_id,credential_hash,header,event_id,source_id,state) VALUES(?,?,?,?,?,?)',
          uuid(),
          'seed',
          '{}',
          uuid(),
          uuid(),
          'committed',
        )
        .toArray();
  });
  expect(await f.call({ kind: 'effect', packet: { kind: 'begin', header: next.header } })).toEqual({
    ok: false,
    error: 'limit',
  });
  await runInDurableObject(f.stub, (_instance, state) => {
    const n = Number(state.storage.sql.exec('SELECT count(*) AS n FROM delivery_messages').one().n);
    for (let i = n; i < L.sources; i++)
      state.storage.sql
        .exec(
          'INSERT INTO delivery_sources(source_id,credential_hash,operation_id,binding,member_id,provider,native_id,message_id) VALUES(?,?,?,?,?,?,?,?)',
          uuid(),
          'seed',
          uuid(),
          '{}',
          uuid(),
          'owner',
          uuid(),
          uuid(),
        )
        .toArray();
  });
  expect(
    await f.call({
      ...sourceCommand,
      operationId: uuid(),
      source: { ...sourceCommand.source, messageId: uuid() },
    }),
  ).toEqual({
    ok: false,
    error: 'limit',
  });
  expect(await f.call(sourceCommand)).toEqual(original);
});

it('keeps revocation admissible at combined physical event and membership capacity', async () => {
  const f = await fixture();
  const inviteSecret = secret(),
    credential = secret(),
    confirmation = secret();
  await f.membership({ kind: 'invite', operationId: uuid(), inviteSecret, ttlSeconds: 900 });
  const joined = await f.membership(
    { kind: 'join', operationId: uuid(), inviteSecret, confirmation, displayName: 'Bob' },
    credential,
  );
  if (!joined.ok || joined.value.kind !== 'identity') throw new Error('join');
  const bob = joined.value.identity;
  await f.membership({
    kind: 'approve',
    operationId: uuid(),
    installationId: bob.installationId,
    confirmation,
  });
  const e = await f.event();
  const C = (await import('../src/capacity.js')).MEMBERSHIP_CAPACITY;
  await runInDurableObject(f.stub, (_instance, state) => {
    // Seed quota/history occupancy as in the approved membership pressure fixture.
    // The database bytes themselves are actual local SQLite pages, not an estimated size.
    state.storage.sql.exec('CREATE TABLE combined_pressure(x BLOB)').toArray();
    while (state.storage.sql.databaseSize < C.normalDatabaseBytes + L.databaseBytes)
      state.storage.sql.exec('INSERT INTO combined_pressure VALUES(zeroblob(131072))').toArray();
    state.storage.sql
      .exec('UPDATE delivery_control SET allocated=?,logical=?', L.databaseBytes, L.logicalBytes)
      .toArray();
    state.storage.sql
      .exec(
        'UPDATE metadata SET operations=?,day=?,day_mutations=?',
        C.normalOperations,
        Math.floor(Date.now() / 86400000),
        500,
      )
      .toArray();
    expect(C.pointerMapPages).toBe(58);
    expect(C.reservedDatabaseBytes + L.databaseBytes).toBeLessThan(250000000);
  });
  expect(await f.call({ kind: 'effect', packet: { kind: 'begin', header: e.header } })).toEqual({
    ok: false,
    error: 'limit',
  });
  expect(
    await f.membership({
      kind: 'invite',
      operationId: uuid(),
      inviteSecret: secret(),
      ttlSeconds: 10,
    }),
  ).toEqual({ ok: false, error: 'limit' });
  const revoke = { kind: 'revoke', operationId: uuid(), installationId: bob.installationId };
  await runInDurableObject(f.stub, (_i, state) =>
    state.storage.sql
      .exec(
        "CREATE TRIGGER pressure_fault BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'fault'); END",
      )
      .toArray(),
  );
  expect(await f.membership(revoke)).toEqual({ ok: false, error: 'unavailable' });
  await evictDurableObject(f.stub);
  expect(await f.call({ kind: 'feed', after: 0, limit: 1, cursor: null })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  await runInDurableObject(f.stub, (_i, state) => {
    expect(
      state.storage.sql
        .exec('SELECT state FROM delivery_revocations WHERE target_id=?', bob.installationId)
        .one().state,
    ).toBe('open');
    state.storage.sql.exec('DROP TRIGGER pressure_fault').toArray();
  });
  expect((await f.membership(revoke)).ok).toBe(true);
  await evictDurableObject(f.stub);
  expect(await f.call({ kind: 'feed', after: 0, limit: 1, cursor: null }, credential)).toEqual({
    ok: false,
    error: 'denied',
  });
  expect((await f.call({ kind: 'feed', after: 0, limit: 1, cursor: null })).ok).toBe(true);
});

it('registers exact stable contexts with many messages; conflicts and spoofed local authors never lock the group', async () => {
  const f = await fixture();
  const a = await f.event(),
    b = await f.event();
  expect(b.header.event.scope.source.sessionId).toBe(a.header.event.scope.source.sessionId);
  expect(b.header.event.scope.source.nativeSessionId).toBe(
    a.header.event.scope.source.nativeSessionId,
  );
  await f.publish(a);
  await evictDurableObject(f.stub);
  await f.publish(b);
  const source = { ...a.header.event.scope.source, messageId: uuid() };
  for (const command of [
    {
      kind: 'registerSource',
      operationId: uuid(),
      binding: f.binding,
      memberId: f.memberId,
      source: { ...source, nativeSessionId: uuid() },
    },
    {
      kind: 'registerSource',
      operationId: uuid(),
      binding: f.binding,
      memberId: f.memberId,
      source: { ...source, sessionId: uuid() },
    },
    { kind: 'registerSource', operationId: uuid(), binding: f.binding, memberId: uuid(), source },
    {
      kind: 'registerSource',
      operationId: uuid(),
      binding: { ...f.binding, installationId: uuid() },
      memberId: f.memberId,
      source: { ...source, sessionId: uuid(), nativeSessionId: uuid() },
    },
    {
      kind: 'registerSource',
      operationId: uuid(),
      binding: f.binding,
      memberId: f.memberId,
      source: a.header.event.scope.source,
    },
  ] as DeliveryCommand[])
    expect(await f.call(command)).toEqual({ ok: false, error: 'conflict' });
  expect((await f.membership({ kind: 'roster', after: 0, limit: 1 })).ok).toBe(true);
  const feed = await f.call({ kind: 'feed', after: 0, limit: 8, cursor: null });
  expect(feed).toMatchObject({
    ok: true,
    value: {
      kind: 'feed',
      entries: [
        {
          header: a.header,
          author: {
            groupId: f.groupId,
            memberId: f.identity.memberId,
            installationId: f.identity.installationId,
          },
        },
        { header: b.header },
      ],
    },
  });
  expect((await f.call({ kind: 'receipt', key: keyOf(a.header) })).ok).toBe(true);
});

it('pins both directions of enrollment/local author ownership and survives credential rotation without orphaning receipts', async () => {
  const f = await fixture(),
    e = await f.event();
  await f.publish(e);
  const invitation = secret(),
    token = secret(),
    confirmation = secret();
  await f.membership({
    kind: 'invite',
    operationId: uuid(),
    inviteSecret: invitation,
    ttlSeconds: 900,
  });
  const joined = await f.membership(
    {
      kind: 'join',
      operationId: uuid(),
      inviteSecret: invitation,
      confirmation,
      displayName: 'Bob',
    },
    token,
  );
  if (!joined.ok || joined.value.kind !== 'identity') throw new Error('join');
  await f.membership({
    kind: 'approve',
    operationId: uuid(),
    installationId: joined.value.identity.installationId,
    confirmation,
  });
  expect(
    await f.call(
      {
        kind: 'registerSource',
        operationId: uuid(),
        binding: { ...f.binding, installationId: uuid() },
        memberId: f.memberId,
        source: {
          sessionId: uuid(),
          provider: 'owner',
          nativeSessionId: uuid(),
          messageId: uuid(),
        },
      },
      token,
    ),
  ).toEqual({ ok: false, error: 'conflict' });
  const replacement = secret();
  const { capabilityHash } = await import('../src/crypto.js');
  const hash = await capabilityHash(f.groupId, 'installation', replacement);
  await runInDurableObject(f.stub, (_i, state) =>
    state.storage.sql
      .exec(
        'UPDATE enrollments SET credential_hash=? WHERE installation_id=?',
        hash,
        f.identity.installationId,
      )
      .toArray(),
  );
  await evictDurableObject(f.stub);
  expect(await f.call({ kind: 'receipt', key: keyOf(e.header) })).toEqual({
    ok: false,
    error: 'denied',
  });
  expect(await f.call({ kind: 'receipt', key: keyOf(e.header) }, replacement)).toMatchObject({
    ok: true,
    value: { kind: 'receipt', receipt: { state: 'committed' } },
  });
  expect(
    await f.call({ kind: 'effect', packet: { kind: 'commit', key: keyOf(e.header) } }, replacement),
  ).toMatchObject({ ok: true, value: { kind: 'receipt', receipt: { state: 'committed' } } });
});

it('reports a completely unwritable failed revoke as unacknowledged and recovers via an explicit retry without false revocation', async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, (_i, state) => {
    state.storage.sql
      .exec(
        "CREATE TRIGGER fail_revoke BEFORE UPDATE ON enrollments BEGIN SELECT RAISE(ABORT,'fault'); END; CREATE TRIGGER fail_marker BEFORE INSERT ON delivery_revocations BEGIN SELECT RAISE(ABORT,'fault'); END; CREATE TRIGGER fail_probe BEFORE UPDATE ON delivery_control BEGIN SELECT RAISE(ABORT,'fault'); END",
      )
      .toArray();
  });
  const revoke = { kind: 'revoke', operationId: uuid(), installationId: f.identity.installationId };
  expect(await f.membership(revoke)).toEqual({ ok: false, error: 'unavailable' });
  await evictDurableObject(f.stub);
  expect(await f.call({ kind: 'feed', after: 0, limit: 1, cursor: null })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  await runInDurableObject(f.stub, (_i, state) => {
    expect(state.storage.sql.exec('SELECT state FROM enrollments').one().state).toBe('active');
    expect(state.storage.sql.exec('SELECT count(*) AS n FROM delivery_revocations').one().n).toBe(
      0,
    );
    state.storage.sql
      .exec('DROP TRIGGER fail_revoke; DROP TRIGGER fail_marker; DROP TRIGGER fail_probe')
      .toArray();
  });
  expect((await f.membership(revoke)).ok).toBe(true);
  await evictDurableObject(f.stub);
  expect(await f.call({ kind: 'feed', after: 0, limit: 1, cursor: null })).toEqual({
    ok: false,
    error: 'denied',
  });
});

it('requires the configured HTTPS origin and separate hosting approval capability for the real Worker route', async () => {
  const f = await fixture(),
    approval = secret();
  const { hostingApprovalHash } = await import('../src/crypto.js');
  const worker = (await import('../src/index.js')).default;
  Object.assign(env, {
    HOSTING_MODE: 'hosted',
    HOSTING_ORIGIN: 'https://approved.example.invalid',
    HOSTING_APPROVAL_HASH: await hostingApprovalHash(approval),
  });
  const command = { kind: 'feed', after: 0, limit: 1, cursor: null };
  const request = (origin: string, cap: string | undefined) =>
    new Request(`${origin}/v1/groups/${f.groupId}/delivery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${f.credential}`,
        ...(cap ? { 'X-Hosting-Approval': cap } : {}),
      },
      body: JSON.stringify(command),
    });
  for (const [origin, cap] of [
    ['http://approved.example.invalid', approval],
    ['https://other.example.invalid', approval],
    ['https://approved.example.invalid', undefined],
    ['https://approved.example.invalid', secret()],
  ] as const) {
    expect(await (await worker.fetch(request(origin, cap), env)).json()).toEqual({
      ok: false,
      error: 'hosting_disabled',
    });
  }
  expect(
    await (await worker.fetch(request('https://approved.example.invalid', approval), env)).json(),
  ).toMatchObject({ ok: true, value: { kind: 'feed' } });
  Object.assign(env, { HOSTING_MODE: 'disabled' });
  expect(
    await (await worker.fetch(request('https://approved.example.invalid', approval), env)).json(),
  ).toEqual({ ok: false, error: 'hosting_disabled' });
});

it('additively binds compatible v1 originals and exact receipts without rewriting archived source/header/chunk IDs', async () => {
  const f = await fixture(),
    e = await f.event();
  const committed = await f.publish(e);
  const { DeliveryStorage } = await import('../src/delivery.js');
  const before = await runInDurableObject(f.stub, (_i, state) => {
    const sql = state.storage.sql;
    const row = sql.exec('SELECT * FROM delivery_messages').one();
    const hash = sql.exec('SELECT credential_hash FROM enrollments').one().credential_hash;
    sql
      .exec(
        'INSERT INTO delivery_sources VALUES(?,?,?,?,?,?,?,?,?)',
        row.source_id,
        hash,
        row.operation_id,
        row.binding,
        row.member_id,
        row.provider,
        row.native_id,
        row.message_id,
        row.session_id,
      )
      .toArray();
    const originals = {
      sources: sql.exec('SELECT * FROM delivery_sources').toArray(),
      ops: sql.exec('SELECT * FROM delivery_operations').toArray(),
      chunks: sql.exec('SELECT * FROM delivery_chunks').toArray(),
    };
    // Disposable test-only simulation of the prior checkpoint's persisted schema.
    sql
      .exec(
        'DROP TABLE delivery_version; DROP TABLE delivery_authors; DROP TABLE delivery_messages; DROP TABLE delivery_contexts; DROP TABLE delivery_identities; DROP TABLE delivery_revocations',
      )
      .toArray();
    new DeliveryStorage(state.storage);
    expect({
      sources: sql.exec('SELECT * FROM delivery_sources').toArray(),
      ops: sql.exec('SELECT * FROM delivery_operations').toArray(),
      chunks: sql.exec('SELECT * FROM delivery_chunks').toArray(),
    }).toEqual(originals);
    return originals;
  });
  expect(before.ops[0].event_id).toBe(e.header.event.eventId);
  await evictDurableObject(f.stub);
  expect(await f.call({ kind: 'receipt', key: keyOf(e.header) })).toEqual(committed);
  expect(
    await f.call({ kind: 'expand', eventId: e.header.event.eventId, start: 0, count: 1 }),
  ).toMatchObject({
    ok: true,
    value: {
      kind: 'expansion',
      header: e.header,
      chunks: e.chunks,
      author: { memberId: f.identity.memberId, installationId: f.identity.installationId },
    },
  });
  const next = await f.event('new message in existing migrated context');
  expect((await f.publish(next)).ok).toBe(true);
});

it.each(['full migration', 'unknown version', 'temporary migration fault'])(
  'fences %s without rewriting originals or denying membership revocation',
  async (mode) => {
    const f = await fixture(),
      e = await f.event();
    await f.publish(e);
    await runInDurableObject(f.stub, (_i, state) => {
      const sql = state.storage.sql;
      if (mode === 'unknown version') {
        sql.exec('UPDATE delivery_version SET version=99').toArray();
        return;
      }
      const row = sql.exec('SELECT * FROM delivery_messages').one();
      const hash = sql.exec('SELECT credential_hash FROM enrollments').one().credential_hash;
      sql
        .exec(
          'INSERT INTO delivery_sources VALUES(?,?,?,?,?,?,?,?,?)',
          row.source_id,
          hash,
          row.operation_id,
          row.binding,
          row.member_id,
          row.provider,
          row.native_id,
          row.message_id,
          row.session_id,
        )
        .toArray();
      // Test-owned prior-schema fixture; originals and membership history remain untouched.
      sql
        .exec(
          'DROP TABLE delivery_version; DROP TABLE delivery_authors; DROP TABLE delivery_messages; DROP TABLE delivery_contexts; DROP TABLE delivery_identities',
        )
        .toArray();
      if (mode === 'full migration')
        sql.exec('UPDATE delivery_control SET logical=?', L.logicalBytes).toArray();
      else
        sql
          .exec(
            "CREATE TRIGGER migration_fault BEFORE UPDATE ON delivery_control BEGIN SELECT RAISE(ABORT,'fault'); END",
          )
          .toArray();
    });
    await evictDurableObject(f.stub);
    expect(await f.call({ kind: 'feed', after: 0, limit: 1, cursor: null })).toEqual({
      ok: false,
      error: 'unavailable',
    });
    await runInDurableObject(f.stub, (_i, state) => {
      expect(
        JSON.parse(
          String(state.storage.sql.exec('SELECT header FROM delivery_operations').one().header),
        ),
      ).toEqual(e.header);
      expect(
        JSON.parse(String(state.storage.sql.exec('SELECT chunk FROM delivery_chunks').one().chunk)),
      ).toEqual(e.chunks[0]);
      if (mode === 'full migration')
        expect(
          state.storage.sql
            .exec("SELECT count(*) AS n FROM sqlite_master WHERE name='delivery_identities'")
            .one().n,
        ).toBe(0);
    });
    if (mode === 'temporary migration fault') {
      await runInDurableObject(f.stub, (_i, state) =>
        state.storage.sql.exec('DROP TRIGGER migration_fault').toArray(),
      );
      expect((await f.call({ kind: 'feed', after: 0, limit: 1, cursor: null })).ok).toBe(true);
    }
    const revoke = {
      kind: 'revoke',
      operationId: uuid(),
      installationId: f.identity.installationId,
    };
    expect((await f.membership(revoke)).ok).toBe(true);
    await evictDurableObject(f.stub);
    expect(await f.call({ kind: 'receipt', key: keyOf(e.header) })).toEqual({
      ok: false,
      error: 'denied',
    });
  },
);
