import { env } from 'cloudflare:workers';
import { SELF, reset, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { membershipEnvelopeSchema } from '@dock/shared/dist/group-membership.js';
import {
  groupExportResultSchema,
  type GroupExportRequest,
  type GroupExportPage,
} from '@dock/shared/dist/group-hosted-export.js';
import { creationGroupId, setupHash } from '../src/crypto.js';
const id = () => crypto.randomUUID(),
  secret = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join('');
async function fixture() {
  const setup = secret(),
    credential = secret(),
    operationId = id();
  Object.assign(env, { HOSTING_MODE: 'local-test', GROUP_SETUP_HASH: await setupHash(setup) });
  const groupId = await creationGroupId(await setupHash(setup), operationId),
    stub = env.GROUPS.getByName(groupId);
  const created = await stub.execute(
    membershipEnvelopeSchema.parse({
      groupId,
      credential,
      setupCapability: setup,
      command: {
        kind: 'initialize',
        operationId,
        groupName: 'Private archive',
        displayName: 'Creator',
      },
    }),
  );
  if (!created.ok || created.value.kind !== 'identity') throw new Error('fixture');
  const membership = (command: unknown, token = credential) =>
    stub.execute(membershipEnvelopeSchema.parse({ groupId, credential: token, command }));
  const page = (request: GroupExportRequest, token = credential, capability = setup) =>
    stub.exportHosted({ groupId, credential: token, setupCapability: capability, request });
  const snapshot = () =>
    runInDurableObject(stub, (_instance, state) => {
      const schema = state.storage.sql
        .exec<{ type: string; name: string }>('SELECT * FROM sqlite_master ORDER BY type,name')
        .toArray();
      return {
        schema,
        data: schema
          .filter((row) => row.type === 'table')
          .map((table) => ({
            name: table.name,
            rows: state.storage.sql
              .exec(
                `SELECT CAST(_rowid_ AS TEXT) exact_rowid,* FROM "${table.name.replaceAll('"', '""')}" ORDER BY _rowid_`,
              )
              .toArray(),
          })),
      };
    });
  return {
    setup,
    credential,
    groupId,
    stub,
    identity: created.value.identity,
    membership,
    page,
    snapshot,
  };
}
afterEach(async () => {
  await reset();
  Object.assign(env, { HOSTING_MODE: 'disabled', GROUP_SETUP_HASH: '' });
});
it('creator export retains exact schemas, sparse row identities, 64-bit integers, binary report chunks and membership/action receipts without writes', async () => {
  const f = await fixture();
  expect(
    await f.stub.actions({
      groupId: f.groupId,
      credential: f.credential,
      command: { kind: 'instruction', operationId: id(), text: 'Retained action receipt' },
    }),
  ).toMatchObject({ ok: true });
  await runInDurableObject(f.stub, (_instance, state) => {
    state.storage.sql
      .exec(
        "CREATE TABLE ga_export_fixture(id TEXT PRIMARY KEY,exact INTEGER,body TEXT);CREATE INDEX ga_export_fixture_body ON ga_export_fixture(body);CREATE TRIGGER ga_export_fixture_retain BEFORE DELETE ON ga_export_fixture BEGIN SELECT RAISE(ABORT,'retain'); END;CREATE TABLE document_chunks(publication TEXT,file TEXT,idx INTEGER,bytes BLOB,sha TEXT);",
      )
      .toArray();
    state.storage.sql
      .exec(
        "INSERT INTO ga_export_fixture(rowid,id,exact,body) VALUES(3,'receipt',9223372036854775807,?)",
        '  Exact receipt\n🧬\u0000',
      )
      .toArray();
    state.storage.sql
      .exec(
        'INSERT INTO document_chunks(rowid,publication,file,idx,bytes,sha) VALUES(7,?,?,?,?,?)',
        'publication',
        'report.pdf',
        0,
        new Uint8Array([0, 255, 1, 128, 13, 10]).buffer,
        'exact',
      )
      .toArray();
    for (let n = 0; n < 140; n++)
      state.storage.sql
        .exec('INSERT INTO ga_export_fixture(id,exact,body) VALUES(?,?,?)', id(), n, 'retained')
        .toArray();
    state.storage.sql
      .exec(
        "INSERT INTO ga_export_fixture(rowid,id,exact,body) VALUES(9223372036854775806,'tail-before',0.1,'retained'),(9223372036854775807,'tail-last',-9223372036854775808,'retained')",
      )
      .toArray();
  });
  const before = await f.snapshot(),
    pages: GroupExportPage[] = [];
  let request: GroupExportRequest = { snapshot: null, cursor: null };
  for (let n = 0; n < 100; n++) {
    const result = await f.page(request);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    pages.push(result.value);
    if (!result.value.next) break;
    request = { snapshot: result.value.snapshot, cursor: result.value.next };
    if (n === 1) await evictDurableObject(f.stub);
  }
  expect(pages.at(-1)?.next).toBeNull();
  expect(await f.snapshot()).toEqual(before);
  const tables = pages[0].tables!,
    fixtureIndex = tables.findIndex((t) => t.name === 'ga_export_fixture'),
    chunksIndex = tables.findIndex((t) => t.name === 'document_chunks');
  expect(pages[0].schema).toEqual(
    expect.arrayContaining([
      {
        type: 'trigger',
        name: 'ga_export_fixture_retain',
        table: 'ga_export_fixture',
        sql: "CREATE TRIGGER ga_export_fixture_retain BEFORE DELETE ON ga_export_fixture BEGIN SELECT RAISE(ABORT,'retain'); END",
      },
    ]),
  );
  const receipt = pages
    .filter((p) => p.table === fixtureIndex)
    .flatMap((p) => p.rows)
    .find((row) => row.rowid === '3');
  expect(receipt?.cells).toEqual([
    { type: 'text', value: 'receipt' },
    { type: 'integer', value: '9223372036854775807' },
    { type: 'text', value: '  Exact receipt\n🧬\u0000' },
  ]);
  const tail = pages
    .filter((p) => p.table === fixtureIndex)
    .flatMap((p) => p.rows)
    .slice(-2);
  expect(tail.map((row) => row.rowid)).toEqual(['9223372036854775806', '9223372036854775807']);
  expect(tail[0].cells[1].type).toBe('real');
  expect(Number('value' in tail[0].cells[1] && tail[0].cells[1].value)).toBe(0.1);
  expect(tail[1].cells[1]).toEqual({ type: 'integer', value: '-9223372036854775808' });
  expect(pages.find((p) => p.table === chunksIndex)?.rows[0]).toMatchObject({
    rowid: '7',
    cells: expect.arrayContaining([{ type: 'blob', value: 'AP8BgA0K' }]),
  });
  expect(tables.some((t) => t.name === 'receipts' && t.rows > 0)).toBe(true);
  expect(tables.some((t) => t.name === 'ga_receipts' && t.rows > 0)).toBe(true);
});
it('setup capability alone and joining membership alone cannot inspect export; current creator revocation denies all pages', async () => {
  const f = await fixture(),
    inviteSecret = secret(),
    token = secret();
  expect(
    await f.membership({ kind: 'invite', operationId: id(), inviteSecret, ttlSeconds: 900 }),
  ).toMatchObject({ ok: true });
  expect(
    await f.membership(
      {
        kind: 'join',
        operationId: id(),
        inviteSecret,
        confirmation: secret(),
        displayName: 'Joining member',
      },
      token,
    ),
  ).toMatchObject({ ok: true });
  expect(await f.page({ snapshot: null, cursor: null }, token)).toEqual({
    ok: false,
    error: 'denied',
  });
  expect(await f.page({ snapshot: null, cursor: null }, secret())).toEqual({
    ok: false,
    error: 'denied',
  });
  expect(await f.page({ snapshot: null, cursor: null }, f.credential, secret())).toEqual({
    ok: false,
    error: 'denied',
  });
  const first = await f.page({ snapshot: null, cursor: null });
  if (!first.ok || !first.value.next) throw new Error('first');
  expect(
    await f.membership({
      kind: 'revoke',
      operationId: id(),
      installationId: f.identity.installationId,
    }),
  ).toMatchObject({ ok: true });
  expect(await f.page({ snapshot: first.value.snapshot, cursor: first.value.next })).toEqual({
    ok: false,
    error: 'denied',
  });
});
it('changes invalidate the pinned snapshot, a new export restarts, and arbitrary SQL/path fields fail', async () => {
  const f = await fixture(),
    first = await f.page({ snapshot: null, cursor: null });
  if (!first.ok || !first.value.next) throw new Error('first');
  expect(
    await f.membership({
      kind: 'invite',
      operationId: id(),
      inviteSecret: secret(),
      ttlSeconds: 900,
    }),
  ).toMatchObject({ ok: true });
  expect(await f.page({ snapshot: first.value.snapshot, cursor: first.value.next })).toEqual({
    ok: false,
    error: 'changed',
  });
  expect(await f.page({ snapshot: null, cursor: null })).toMatchObject({ ok: true });
  const response = await SELF.fetch(`http://127.0.0.1/v1/groups/${f.groupId}/export`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${f.credential}`,
      'X-Group-Setup': f.setup,
    },
    body: JSON.stringify({
      snapshot: null,
      cursor: null,
      sql: 'SELECT * FROM enrollments',
      path: '/tmp/arbitrary',
    }),
  });
  expect(groupExportResultSchema.parse(await response.json())).toEqual({
    ok: false,
    error: 'invalid',
  });
  const valid = await SELF.fetch(`http://127.0.0.1/v1/groups/${f.groupId}/export`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${f.credential}`,
      'X-Group-Setup': f.setup,
    },
    body: JSON.stringify({ snapshot: null, cursor: null }),
  });
  expect(groupExportResultSchema.parse(await valid.json())).toMatchObject({ ok: true });
  expect(valid.headers.get('Cache-Control')).toBe('no-store');
});
it('unsupported application tables or hidden KV/alarm state fail closed rather than make an incomplete archive', async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, (_instance, state) =>
    state.storage.kv.put('future-hidden-state', 'retained'),
  );
  expect(await f.page({ snapshot: null, cursor: null })).toEqual({
    ok: false,
    error: 'unsupported',
  });
  await runInDurableObject(f.stub, (_instance, state) => {
    state.storage.kv.delete('future-hidden-state');
    return state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await f.page({ snapshot: null, cursor: null })).toEqual({
    ok: false,
    error: 'unsupported',
  });
  await runInDurableObject(f.stub, async (_instance, state) => {
    await state.storage.deleteAlarm();
    state.storage.sql.exec('CREATE TABLE future_state(id INTEGER)').toArray();
  });
  expect(await f.page({ snapshot: null, cursor: null })).toEqual({
    ok: false,
    error: 'unsupported',
  });
});
