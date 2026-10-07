import { env } from 'cloudflare:workers';
import {
  SELF,
  evictDurableObject,
  runInDurableObject,
  reset,
  abortAllDurableObjects,
} from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  membershipCommandSchema,
  membershipEnvelopeSchema,
  membershipIdentitySchema,
  MEMBERSHIP_LIMITS as L,
  type MembershipResult,
  type MembershipIdentity,
} from '@dock/shared/dist/group-membership.js';
import { capabilityHash, creationGroupId, digest, setupHash } from '../src/crypto.js';
import { MEMBERSHIP_CAPACITY as C } from '../src/capacity.js';
import worker from '../src/index.js';

// Independent installation secrets are generated in memory, never fixtures on disk.
const secret = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const operationId = () => crypto.randomUUID();
const setup = secret();
// Only the test harness changes bindings; production config stays disabled with no setup hash.
const configure = async () => {
  Object.assign(env, { HOSTING_MODE: 'local-test', GROUP_SETUP_HASH: await setupHash(setup) });
};
async function call(
  groupId: string,
  credential: string,
  command: unknown,
  setupCapability?: string,
): Promise<MembershipResult> {
  return env.GROUPS.getByName(groupId).execute(
    membershipEnvelopeSchema.parse({
      groupId,
      credential,
      command,
      ...(setupCapability === undefined ? {} : { setupCapability }),
    }),
  );
}
function identity(result: MembershipResult): MembershipIdentity {
  if (!result.ok || result.value.kind !== 'identity')
    throw new Error(`Unexpected result ${JSON.stringify(result)}`);
  return result.value.identity;
}
async function create(displayName = 'Alice', groupName = 'Group') {
  await configure();
  const credential = secret();
  const init = membershipCommandSchema.parse({
    kind: 'initialize',
    operationId: operationId(),
    groupName,
    displayName,
  });
  if (init.kind !== 'initialize') throw new Error('fixture');
  const groupId = await creationGroupId(await setupHash(setup), init.operationId);
  const alice = identity(await call(groupId, credential, init, setup));
  return { groupId, credential, alice, init, stub: env.GROUPS.getByName(groupId) };
}
it('actions share the membership mutation budget, preserve same-ID replay and retain revocation reserve', async () => {
  const a = await create();
  const command = {
    kind: 'instruction',
    operationId: operationId(),
    text: 'Explicit shared instruction.',
  };
  const envelope = { groupId: a.groupId, credential: a.credential, command };
  const first = await a.stub.actions(envelope);
  expect(first).toMatchObject({ ok: true, value: { kind: 'instruction' } });
  const operations = () =>
    runInDurableObject(
      a.stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ operations: number }>('SELECT operations FROM metadata WHERE singleton=1')
          .one().operations,
    );
  const before = await operations();
  expect(await a.stub.actions(envelope)).toEqual(first);
  expect(await operations()).toBe(before);
  await runInDurableObject(a.stub, (_instance, state) => {
    state.storage.sql
      .exec('UPDATE metadata SET operations=? WHERE singleton=1', C.normalOperations)
      .toArray();
  });
  expect(
    await a.stub.actions({ ...envelope, command: { ...command, operationId: operationId() } }),
  ).toEqual({ ok: false, error: 'limit' });
  expect(await a.stub.actions(envelope)).toEqual(first);
  expect(
    await call(a.groupId, a.credential, {
      kind: 'revoke',
      operationId: operationId(),
      installationId: a.alice.installationId,
    }),
  ).toMatchObject({ ok: true });
  expect(await a.stub.actions(envelope)).toEqual({ ok: false, error: 'denied' });
});
async function legacyPending(groupId: string, aliceCredential: string, displayName = 'Bob') {
  const inviteSecret = secret();
  const invitation = await call(groupId, aliceCredential, {
    kind: 'invite',
    operationId: operationId(),
    inviteSecret,
    ttlSeconds: 900,
  });
  if (!invitation.ok || invitation.value.kind !== 'invitation') throw new Error('fixture invite');
  const issued = invitation.value;
  const credential = secret();
  const confirmation = secret();
  const join = {
    kind: 'join',
    operationId: operationId(),
    inviteSecret,
    confirmation,
    displayName,
  };
  // Retained records from releases that required approval. Seed their historical
  // pending join receipt explicitly; current joins are active and reusable.
  const bob = membershipIdentitySchema.parse({
    groupId,
    memberId: crypto.randomUUID(),
    installationId: crypto.randomUUID(),
    displayName,
    state: 'pending',
  });
  const parsedJoin = membershipCommandSchema.parse(join);
  if (parsedJoin.kind !== 'join') throw new Error('legacy fixture join');
  const credentialHash = await capabilityHash(groupId, 'installation', credential);
  const confirmationHash = await capabilityHash(groupId, 'confirmation', confirmation);
  const requestHash = await digest(
    JSON.stringify([
      groupId,
      {
        ...parsedJoin,
        inviteSecret: await capabilityHash(groupId, 'invite', inviteSecret),
        confirmation: confirmationHash,
      },
    ]),
  );
  await runInDurableObject(env.GROUPS.getByName(groupId), (_instance, state) => {
    const now = Date.now(),
      day = Math.floor(now / 86_400_000);
    state.storage.transactionSync(() => {
      state.storage.sql
        .exec(
          'INSERT INTO enrollments(member_id,installation_id,credential_hash,display_name,state,invite_id,confirmation_hash) VALUES(?,?,?,?,?,?,?)',
          bob.memberId,
          bob.installationId,
          credentialHash,
          displayName,
          'pending',
          issued.inviteId,
          confirmationHash,
        )
        .toArray();
      state.storage.sql
        .exec(
          'UPDATE invitations SET state=?,expires_at=? WHERE invite_id=?',
          'consumed',
          now - 1,
          issued.inviteId,
        )
        .toArray();
      state.storage.sql
        .exec(
          'INSERT INTO receipts(credential_hash,operation_id,request_hash,response) VALUES(?,?,?,?)',
          credentialHash,
          join.operationId,
          requestHash,
          JSON.stringify({ kind: 'identity', identity: bob }),
        )
        .toArray();
      state.storage.sql
        .exec(
          'INSERT INTO audit(kind,actor_installation_id,target_id,recorded_at) VALUES(?,?,?,?)',
          'join',
          bob.installationId,
          bob.installationId,
          now,
        )
        .toArray();
      state.storage.sql
        .exec(
          'UPDATE metadata SET operations=operations+1,day_mutations=CASE WHEN day=? THEN day_mutations+1 ELSE 1 END,day=? WHERE singleton=1',
          day,
          day,
        )
        .toArray();
    });
  });
  const approval = {
    kind: 'approve',
    operationId: operationId(),
    installationId: bob.installationId,
    confirmation,
  };
  return { credential, confirmation, join, bob, approval, invitation: invitation.value };
}
async function snapshot(stub: ReturnType<typeof env.GROUPS.getByName>) {
  return runInDurableObject(stub, (_instance, state) => ({
    metadata: state.storage.sql.exec('SELECT * FROM metadata ORDER BY singleton').toArray(),
    enrollments: state.storage.sql.exec('SELECT * FROM enrollments ORDER BY position').toArray(),
    invitations: state.storage.sql.exec('SELECT * FROM invitations ORDER BY rowid').toArray(),
    receipts: state.storage.sql.exec('SELECT * FROM receipts ORDER BY rowid').toArray(),
    audit: state.storage.sql.exec('SELECT * FROM audit ORDER BY sequence').toArray(),
  }));
}
const deny = { ok: false, error: 'denied' };
afterEach(async () => {
  await reset();
  Object.assign(env, { HOSTING_MODE: 'disabled', GROUP_SETUP_HASH: '' });
});

describe('actual SQLite DO membership', () => {
  it('two installations enroll explicitly, recover lost acknowledgements across eviction/restart, and share equal permissions', async () => {
    const a = await create();
    await evictDurableObject(a.stub);
    expect(identity(await call(a.groupId, a.credential, a.init, setup))).toEqual(a.alice);
    const b = await legacyPending(a.groupId, a.credential);
    expect(b.bob.state).toBe('pending');
    expect(await call(a.groupId, b.credential, { kind: 'roster', after: 0, limit: 50 })).toEqual(
      deny,
    );
    await evictDurableObject(a.stub);
    expect(identity(await call(a.groupId, b.credential, b.join))).toEqual(b.bob);
    const approved = identity(await call(a.groupId, a.credential, b.approval));
    expect(approved.installationId).toBe(b.bob.installationId);
    expect(approved.state).toBe('active');
    await abortAllDurableObjects();
    expect(identity(await call(a.groupId, a.credential, b.approval))).toEqual(approved);
    expect(identity(await call(a.groupId, b.credential, { kind: 'status' }))).toEqual(approved);
    const roster = await call(a.groupId, b.credential, { kind: 'roster', after: 0, limit: 1 });
    expect(roster.ok && roster.value.kind === 'members' && roster.value.entries.length).toBe(1);
    if (!roster.ok || roster.value.kind !== 'members') throw new Error('roster');
    const next = await call(a.groupId, b.credential, {
      kind: 'roster',
      after: roster.value.next,
      limit: 1,
    });
    expect(
      next.ok && next.value.kind === 'members' && next.value.entries[0].identity.installationId,
    ).toBe(b.bob.installationId);
    // Bob can invite and revoke the creator; there are no owner/admin roles.
    const inviteCommand = {
      kind: 'invite',
      operationId: operationId(),
      inviteSecret: secret(),
      ttlSeconds: 10,
    };
    expect((await call(a.groupId, b.credential, inviteCommand)).ok).toBe(true);
    expect(
      (
        await call(a.groupId, b.credential, {
          kind: 'revoke',
          operationId: operationId(),
          installationId: a.alice.installationId,
        })
      ).ok,
    ).toBe(true);
    expect(await call(a.groupId, a.credential, a.init, setup)).toEqual(deny);
    expect(await call(a.groupId, a.credential, { kind: 'roster', after: 0, limit: 50 })).toEqual(
      deny,
    );
  });

  it('checks auth before receipts, never resurrects revoked credentials, and requires a fresh invite AND credential to rejoin', async () => {
    const a = await create();
    const b = await legacyPending(a.groupId, a.credential);
    await call(a.groupId, a.credential, b.approval);
    const invite = {
      kind: 'invite',
      operationId: operationId(),
      inviteSecret: secret(),
      ttlSeconds: 900,
    };
    await call(a.groupId, b.credential, invite);
    const revoke = {
      kind: 'revoke',
      operationId: operationId(),
      installationId: b.bob.installationId,
    };
    const revoked = await call(a.groupId, a.credential, revoke);
    expect(await call(a.groupId, a.credential, revoke)).toEqual(revoked);
    await evictDurableObject(a.stub);
    for (const command of [
      b.join,
      invite,
      b.approval,
      { kind: 'status' },
      { kind: 'pending', after: 0, limit: 50 },
      { kind: 'audit', after: 0, limit: 50 },
    ]) {
      expect(await call(a.groupId, b.credential, command)).toEqual(deny);
    }
    expect(await call(a.groupId, a.credential, b.approval)).toEqual(deny);
    const fresh = secret();
    await call(a.groupId, a.credential, {
      kind: 'invite',
      operationId: operationId(),
      inviteSecret: fresh,
      ttlSeconds: 900,
    });
    expect(
      await call(a.groupId, b.credential, {
        ...b.join,
        operationId: operationId(),
        inviteSecret: fresh,
      }),
    ).toEqual(deny);
    const rejoined = identity(
      await call(a.groupId, secret(), {
        ...b.join,
        operationId: operationId(),
        inviteSecret: fresh,
      }),
    );
    expect(rejoined.installationId).not.toBe(b.bob.installationId);
    expect(rejoined.memberId).not.toBe(b.bob.memberId);
    expect(rejoined.state).toBe('active');
  });

  it('reuses one invitation under simultaneous joins and converges identical concurrent retries', async () => {
    const a = await create();
    const inviteSecret = secret();
    const issue = { kind: 'invite', operationId: operationId(), inviteSecret, ttlSeconds: 900 };
    const issued = await Promise.all([
      call(a.groupId, a.credential, issue),
      call(a.groupId, a.credential, issue),
    ]);
    expect(issued[0]).toEqual(issued[1]);
    const commands = [0, 1].map(() => ({
      kind: 'join',
      operationId: operationId(),
      inviteSecret,
      confirmation: secret(),
      displayName: 'Same typed name',
    }));
    const credentials = [secret(), secret()];
    const results = await Promise.all(
      commands.map((command, i) => call(a.groupId, credentials[i], command)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.map(identity).every((entry) => entry.state === 'active')).toBe(true);
    const winner = 0;
    const retries = await Promise.all([
      call(a.groupId, credentials[winner], commands[winner]),
      call(a.groupId, credentials[winner], commands[winner]),
    ]);
    expect(retries).toEqual([results[winner], results[winner]]);
    expect(
      await call(a.groupId, credentials[winner], { ...commands[winner], displayName: 'Changed' }),
    ).toEqual({ ok: false, error: 'conflict' });
    const counts = await runInDurableObject(
      a.stub,
      (_instance, state) =>
        state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM enrollments').one().n,
    );
    expect(counts).toBe(3);
  });

  it('serializes both approval/revocation orders and races with exact final states', async () => {
    for (const kind of ['target', 'issuer', 'invite'] as const) {
      for (const order of ['approve-first', 'revoke-first', 'concurrent'] as const) {
        const a = await create();
        const admin = await legacyPending(a.groupId, a.credential);
        await call(a.groupId, a.credential, admin.approval);
        const b = await legacyPending(a.groupId, a.credential);
        const revocation =
          kind === 'invite'
            ? { kind: 'revokeInvite', operationId: operationId(), inviteId: b.invitation.inviteId }
            : {
                kind: 'revoke',
                operationId: operationId(),
                installationId: kind === 'target' ? b.bob.installationId : a.alice.installationId,
              };
        let approve: MembershipResult;
        let revoke: MembershipResult;
        if (order === 'concurrent') {
          [approve, revoke] = await Promise.all([
            call(a.groupId, admin.credential, b.approval),
            call(a.groupId, admin.credential, revocation),
          ]);
        } else if (order === 'approve-first') {
          approve = await call(a.groupId, admin.credential, b.approval);
          revoke = await call(a.groupId, admin.credential, revocation);
          expect(approve.ok).toBe(true);
        } else {
          revoke = await call(a.groupId, admin.credential, revocation);
          approve = await call(a.groupId, admin.credential, b.approval);
          expect(approve).toEqual(deny);
        }
        expect(revoke.ok).toBe(true);
        if (!approve.ok) expect(approve).toEqual(deny);
        await evictDurableObject(a.stub);
        const final = await call(a.groupId, b.credential, { kind: 'status' });
        const replay = await call(a.groupId, admin.credential, b.approval);
        const roster = await call(a.groupId, b.credential, { kind: 'roster', after: 0, limit: 50 });
        if (kind === 'target') {
          expect(final).toEqual(deny);
          expect(roster).toEqual(deny);
          expect(replay).toEqual(deny);
        } else if (approve.ok) {
          expect(identity(final)).toEqual({ ...b.bob, state: 'active' });
          expect(replay).toEqual(approve);
          if (!roster.ok || roster.value.kind !== 'members') throw new Error('roster');
          expect(roster.value.entries.map((entry) => entry.identity.installationId)).toContain(
            b.bob.installationId,
          );
        } else {
          expect(final).toEqual(deny);
          expect(roster).toEqual(deny);
          expect(replay).toEqual(deny);
        }
        await runInDurableObject(a.stub, (_instance, state) => {
          expect(
            state.storage.sql
              .exec<{
                state: string;
              }>('SELECT state FROM enrollments WHERE installation_id=?', b.bob.installationId)
              .one().state,
          ).toBe(kind === 'target' ? 'revoked' : approve.ok ? 'active' : 'pending');
          expect(
            state.storage.sql
              .exec<{
                state: string;
              }>('SELECT state FROM invitations WHERE invite_id=?', b.invitation.inviteId)
              .one().state,
          ).toBe(kind === 'invite' ? 'revoked' : 'consumed');
        });
      }
    }
  });

  it('approves accepted pending requests after invitation expiry while preserving join and revocation checks', async () => {
    const a = await create();
    const accepted = await legacyPending(a.groupId, a.credential);
    const revoked = await legacyPending(a.groupId, a.credential);
    const inactiveIssuer = await legacyPending(a.groupId, a.credential);
    const unusedSecret = secret();
    expect(
      (
        await call(a.groupId, a.credential, {
          kind: 'invite',
          operationId: operationId(),
          inviteSecret: unusedSecret,
          ttlSeconds: 1,
        })
      ).ok,
    ).toBe(true);
    await runInDurableObject(a.stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE invitations SET expires_at=?', Date.now() - 1).toArray();
    });
    await evictDurableObject(a.stub);
    expect(
      await call(a.groupId, a.credential, { ...accepted.approval, confirmation: secret() }),
    ).toEqual(deny);
    expect(await call(a.groupId, secret(), accepted.approval)).toEqual(deny);
    expect(
      await call(a.groupId, secret(), {
        ...accepted.join,
        operationId: operationId(),
        inviteSecret: unusedSecret,
      }),
    ).toEqual(deny);
    expect(
      (
        await call(a.groupId, a.credential, {
          kind: 'revokeInvite',
          operationId: operationId(),
          inviteId: revoked.invitation.inviteId,
        })
      ).ok,
    ).toBe(true);
    expect(await call(a.groupId, a.credential, revoked.approval)).toEqual(deny);
    const approved = identity(await call(a.groupId, a.credential, accepted.approval));
    expect(approved.state).toBe('active');
    expect(identity(await call(a.groupId, accepted.credential, { kind: 'status' }))).toEqual(
      approved,
    );
    expect(
      (
        await call(a.groupId, accepted.credential, {
          kind: 'revoke',
          operationId: operationId(),
          installationId: a.alice.installationId,
        })
      ).ok,
    ).toBe(true);
    expect(await call(a.groupId, accepted.credential, inactiveIssuer.approval)).toEqual(deny);
    expect(await call(a.groupId, a.credential, inactiveIssuer.approval)).toEqual(deny);
  });

  it('requires confirmation, rejects revoked invites, and denies setup/cross-group/read probes uniformly', async () => {
    const a = await create();
    const other = await create();
    const b = await legacyPending(a.groupId, a.credential);
    expect(await call(a.groupId, a.credential, { ...b.approval, confirmation: secret() })).toEqual(
      deny,
    );
    expect(
      await call(other.groupId, a.credential, { kind: 'roster', after: 0, limit: 50 }),
    ).toEqual(deny);
    expect(
      await call(other.groupId, a.credential, { ...b.approval, operationId: operationId() }),
    ).toEqual(deny);
    expect(await call(a.groupId, setup, { kind: 'status' })).toEqual(deny);
    expect(await call(a.groupId, secret(), a.init, setup)).toEqual(deny);
    expect(await call(a.groupId, a.credential, { kind: 'status' }, setup)).toEqual(deny);
    expect(
      await call(a.groupId, a.credential, {
        kind: 'approve',
        operationId: operationId(),
        installationId: crypto.randomUUID(),
        confirmation: secret(),
      }),
    ).toEqual(deny);
    const mismatched = membershipEnvelopeSchema.parse({
      groupId: other.groupId,
      credential: other.credential,
      command: { kind: 'status' },
    });
    expect(await a.stub.execute(mismatched)).toEqual(deny);
    const c = await legacyPending(a.groupId, a.credential);
    await call(a.groupId, a.credential, {
      kind: 'revokeInvite',
      operationId: operationId(),
      inviteId: c.invitation.inviteId,
    });
    expect(await call(a.groupId, a.credential, c.approval)).toEqual(deny);
    expect(await call(a.groupId, secret(), { ...c.join, operationId: operationId() })).toEqual(
      deny,
    );
  });

  it('has append-only secret-free audit/receipts and rejects private/provider canaries in strict inputs', async () => {
    const a = await create();
    const b = await legacyPending(a.groupId, a.credential);
    await call(a.groupId, a.credential, b.approval);
    const snapshot = await runInDurableObject(a.stub, (_instance, state) => {
      const tables = ['metadata', 'enrollments', 'invitations', 'receipts', 'audit'];
      const data = Object.fromEntries(
        tables.map((table) => [table, state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()]),
      );
      expect(() => state.storage.sql.exec('DELETE FROM audit').toArray()).toThrow('append only');
      expect(() => state.storage.sql.exec('UPDATE audit SET kind=?', 'private').toArray()).toThrow(
        'append only',
      );
      return JSON.stringify(data);
    });
    for (const cap of [a.credential, b.credential, setup, b.confirmation, b.join.inviteSecret])
      expect(snapshot).not.toContain(cap);
    const invalid = {
      ...a.init,
      privateChat: 'PRIVATE-ASIDE-CANARY',
      providerSession: 'PERSONAL-SESSION-CANARY',
    };
    const envelope = { groupId: a.groupId, credential: a.credential, command: invalid };
    // A typed caller cannot construct this; HTTP exercises the actual untrusted boundary below.
    expect(membershipEnvelopeSchema.safeParse(envelope).success).toBe(false);
    const audit = await call(a.groupId, a.credential, { kind: 'audit', after: 0, limit: 50 });
    expect(
      audit.ok && audit.value.kind === 'audit' && audit.value.entries.map((e) => e.kind),
    ).toEqual(['initialize', 'invite', 'join', 'approve']);
  });

  it('rolls back actual SQLite writes/receipts/audit together on storage failure', async () => {
    const a = await create();
    await runInDurableObject(a.stub, (_instance, state) => {
      state.storage.sql
        .exec(
          "CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'test capacity'); END",
        )
        .toArray();
    });
    const command = {
      kind: 'invite',
      operationId: operationId(),
      inviteSecret: secret(),
      ttlSeconds: 900,
    };
    expect(await call(a.groupId, a.credential, command)).toEqual({
      ok: false,
      error: 'unavailable',
    });
    await runInDurableObject(a.stub, (_instance, state) => {
      expect(
        state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM invitations').one().n,
      ).toBe(0);
      expect(state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM audit').one().n).toBe(
        1,
      );
      expect(
        state.storage.sql.exec<{ operations: number }>('SELECT operations FROM metadata').one()
          .operations,
      ).toBe(1);
      state.storage.sql.exec('DROP TRIGGER fail_receipt').toArray();
    });
    // Recovery requires a current successful probe and durably commits the same request.
    await evictDurableObject(a.stub);
    expect((await call(a.groupId, a.credential, command)).ok).toBe(true);
    expect((await call(a.groupId, a.credential, { kind: 'roster', after: 0, limit: 50 })).ok).toBe(
      true,
    );
  });

  it('bounds invitations, pending enrollments, history and daily mutation work without pruning', async () => {
    const a = await create();
    for (let i = 0; i < L.openInvites; i++)
      expect(
        (
          await call(a.groupId, a.credential, {
            kind: 'invite',
            operationId: operationId(),
            inviteSecret: secret(),
            ttlSeconds: 900,
          })
        ).ok,
      ).toBe(true);
    expect(
      await call(a.groupId, a.credential, {
        kind: 'invite',
        operationId: operationId(),
        inviteSecret: secret(),
        ttlSeconds: 900,
      }),
    ).toEqual({ ok: false, error: 'limit' });
    await runInDurableObject(a.stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE metadata SET day_mutations=?', L.dailyMutations).toArray();
    });
    expect(
      await call(a.groupId, a.credential, {
        kind: 'invite',
        operationId: operationId(),
        inviteSecret: secret(),
        ttlSeconds: 900,
      }),
    ).toEqual({ ok: false, error: 'limit' });
    // Reserved administration still works at the normal mutation budget.
    expect(
      (
        await call(a.groupId, a.credential, {
          kind: 'revoke',
          operationId: operationId(),
          installationId: a.alice.installationId,
        })
      ).ok,
    ).toBe(true);
    const history = await runInDurableObject(
      a.stub,
      (_instance, state) =>
        state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM audit').one().n,
    );
    expect(history).toBe(L.openInvites + 2);
  });

  it('bounds active-member and lifetime enrollment counts while reconciling legacy pending records', async () => {
    const a = await create();
    for (let i = 0; i < L.pending; i++) await legacyPending(a.groupId, a.credential);
    const inviteSecret = secret();
    expect(
      (
        await call(a.groupId, a.credential, {
          kind: 'invite',
          operationId: operationId(),
          inviteSecret,
          ttlSeconds: 900,
        })
      ).ok,
    ).toBe(true);
    const join = {
      kind: 'join',
      operationId: operationId(),
      inviteSecret,
      confirmation: secret(),
      displayName: 'Overflow',
    };
    const credential = secret();
    expect(identity(await call(a.groupId, credential, join)).state).toBe('active');
    // Pending records no longer gate new links; an active read reconciles them.
    const list = await call(a.groupId, a.credential, { kind: 'pending', after: 0, limit: 50 });
    if (!list.ok || list.value.kind !== 'members') throw new Error('pending');
    expect(list.value.entries.length).toBe(0);
    expect((await call(a.groupId, credential, join)).ok).toBe(true);

    const full = await create();
    let last: Awaited<ReturnType<typeof legacyPending>> | undefined;
    for (let i = 1; i < L.members; i++) {
      last = await legacyPending(full.groupId, full.credential);
      expect((await call(full.groupId, full.credential, last.approval)).ok).toBe(true);
    }
    const extra = await legacyPending(full.groupId, full.credential);
    expect(await call(full.groupId, full.credential, extra.approval)).toEqual({
      ok: false,
      error: 'limit',
    });
    await call(full.groupId, full.credential, {
      kind: 'revoke',
      operationId: operationId(),
      installationId: last!.bob.installationId,
    });
    expect((await call(full.groupId, full.credential, extra.approval)).ok).toBe(true);

    // Seed only the remaining historical revoked rows to exercise the fixed lifetime cap.
    await runInDurableObject(full.stub, (_instance, state) => {
      const count = state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM enrollments')
        .one().n;
      state.storage.transactionSync(() => {
        for (let i = count; i < L.enrollments; i++)
          state.storage.sql
            .exec(
              'INSERT INTO enrollments(member_id,installation_id,credential_hash,display_name,state) VALUES(?,?,?,?,?)',
              crypto.randomUUID(),
              crypto.randomUUID(),
              secret(),
              'Retired',
              'revoked',
            )
            .toArray();
      });
    });
    const cap = secret();
    await call(full.groupId, full.credential, {
      kind: 'invite',
      operationId: operationId(),
      inviteSecret: cap,
      ttlSeconds: 900,
    });
    expect(
      await call(full.groupId, secret(), {
        ...join,
        operationId: operationId(),
        inviteSecret: cap,
      }),
    ).toEqual({ ok: false, error: 'limit' });
  });

  it.each([C.normalOperations, L.historyOperations])(
    'revokes atomically at history %i, full day and 16 MiB storage without burning reserve',
    async (historyOperations) => {
      // 120 UTF-16 units: maximum JSON-escaped name width, preserved by the contract.
      const wide = '\u0001'.repeat(120);
      const a = await create(wide, '\u0800'.repeat(120));
      const b = await legacyPending(a.groupId, a.credential, wide);
      await call(a.groupId, a.credential, b.approval);
      const inviteCommand = {
        kind: 'invite',
        operationId: operationId(),
        inviteSecret: secret(),
        ttlSeconds: 900,
      };
      const issued = await call(a.groupId, b.credential, inviteCommand);
      if (!issued.ok || issued.value.kind !== 'invitation') throw new Error('invite');
      // Retain 32 outstanding invitations; the wide growth fixture below also
      // checks revocation of all 32 while they remain unexpired.
      for (let i = 1; i < L.openInvites; i++) {
        expect(
          (
            await call(a.groupId, b.credential, {
              ...inviteCommand,
              operationId: operationId(),
              inviteSecret: secret(),
            })
          ).ok,
        ).toBe(true);
      }
      // Also retain expired and consumed invitations; cleanup has only normal admission.
      const validJoinSecret = secret();
      const expiredSecret = secret();
      const revokedSecret = secret();
      // Make room by expiring three of Bob's outstanding invites.
      await runInDurableObject(a.stub, (_instance, state) => {
        state.storage.sql
          .exec(
            'UPDATE invitations SET expires_at=? WHERE invite_id IN (SELECT invite_id FROM invitations WHERE state=? LIMIT 3)',
            Date.now() - 1,
            'open',
          )
          .toArray();
      });
      for (const inviteSecret of [validJoinSecret, expiredSecret, revokedSecret]) {
        expect(
          (
            await call(a.groupId, a.credential, {
              ...inviteCommand,
              operationId: operationId(),
              inviteSecret,
            })
          ).ok,
        ).toBe(true);
      }
      const expiredHash = await capabilityHash(a.groupId, 'invite', expiredSecret);
      const revokedHash = await capabilityHash(a.groupId, 'invite', revokedSecret);
      await runInDurableObject(a.stub, (_instance, state) => {
        state.storage.sql
          .exec(
            'UPDATE invitations SET expires_at=? WHERE secret_hash=?',
            Date.now() - 1,
            expiredHash,
          )
          .toArray();
        state.storage.sql
          .exec('UPDATE invitations SET state=? WHERE secret_hash=?', 'revoked', revokedHash)
          .toArray();
      });
      const actorHash = await capabilityHash(a.groupId, 'installation', a.credential);
      const response = JSON.stringify({
        kind: 'identity',
        identity: { ...b.bob, state: 'revoked' },
      });
      expect(new TextEncoder().encode(response).length).toBeGreaterThan(900);
      await runInDurableObject(a.stub, (_instance, state) => {
        state.storage.transactionSync(() => {
          const n = state.storage.sql
            .exec<{ operations: number }>('SELECT operations FROM metadata')
            .one().operations;
          for (let i = n; i < historyOperations; i++) {
            state.storage.sql
              .exec(
                'INSERT INTO audit(kind,actor_installation_id,target_id,recorded_at) VALUES(?,?,?,?)',
                'approve',
                a.alice.installationId,
                b.bob.installationId,
                Date.now(),
              )
              .toArray();
            state.storage.sql
              .exec(
                'INSERT INTO receipts(credential_hash,operation_id,request_hash,response) VALUES(?,?,?,?)',
                actorHash,
                operationId(),
                secret(),
                response,
              )
              .toArray();
          }
          state.storage.sql
            .exec(
              'UPDATE metadata SET operations=?,day=?,day_mutations=?',
              historyOperations,
              Math.floor(Date.now() / 86_400_000),
              L.dailyMutations,
            )
            .toArray();
          state.storage.sql.exec('CREATE TABLE capacity_fixture (padding BLOB)').toArray();
          while (state.storage.sql.databaseSize < C.normalDatabaseBytes) {
            state.storage.sql
              .exec(
                'INSERT INTO capacity_fixture VALUES(zeroblob(?))',
                Math.min(1_048_576, C.normalDatabaseBytes - state.storage.sql.databaseSize),
              )
              .toArray();
          }
        });
        expect(state.storage.sql.databaseSize).toBeGreaterThanOrEqual(16_777_216);
        expect(
          state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM audit').one().n,
        ).toBe(historyOperations);
        expect(
          state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM receipts').one().n,
        ).toBe(historyOperations);
      });
      const before = await snapshot(a.stub);
      expect(identity(await call(a.groupId, b.credential, b.join))).toEqual(b.bob);
      expect(await call(a.groupId, a.credential, b.approval)).toEqual({
        ok: true,
        value: {
          kind: 'identity',
          identity: { ...b.bob, state: 'active' },
        },
      });
      const fresh = { ...b.join, operationId: operationId() };
      for (const inviteSecret of [secret(), expiredSecret, revokedSecret, b.join.inviteSecret]) {
        expect(await call(a.groupId, secret(), { ...fresh, inviteSecret })).toEqual(deny);
      }
      expect(await call(a.groupId, secret(), { ...fresh, inviteSecret: validJoinSecret })).toEqual({
        ok: false,
        error: 'limit',
      });
      const expiredId = await runInDurableObject(
        a.stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{
              invite_id: string;
            }>('SELECT invite_id FROM invitations WHERE secret_hash=?', expiredHash)
            .one().invite_id,
      );
      for (const inviteId of [issued.value.inviteId, expiredId, b.invitation.inviteId]) {
        expect(
          await call(a.groupId, a.credential, {
            kind: 'revokeInvite',
            operationId: operationId(),
            inviteId,
          }),
        ).toEqual({ ok: false, error: 'limit' });
      }
      const revoke = {
        kind: 'revoke',
        operationId: operationId(),
        installationId: b.bob.installationId,
      };
      // A forced receipt failure rolls back the enrollment, all invitation updates,
      // audit, receipt and BOTH counters despite bypassing normal admission.
      await runInDurableObject(a.stub, (_instance, state) => {
        state.storage.sql
          .exec(
            "CREATE TRIGGER fail_revoke_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'fixture'); END",
          )
          .toArray();
      });
      expect(await call(a.groupId, a.credential, revoke)).toEqual({
        ok: false,
        error: 'unavailable',
      });
      expect(await snapshot(a.stub)).toEqual(before);
      await runInDurableObject(a.stub, (_instance, state) => {
        state.storage.sql.exec('DROP TRIGGER fail_revoke_receipt').toArray();
      });
      const revoked = await call(a.groupId, a.credential, revoke);
      expect(identity(revoked)).toEqual({ ...b.bob, state: 'revoked' });
      await evictDurableObject(a.stub);
      expect(await call(a.groupId, a.credential, revoke)).toEqual(revoked);
      const after = await snapshot(a.stub);
      expect(after.audit.slice(0, -1)).toEqual(before.audit);
      expect(after.receipts.slice(0, -1)).toEqual(before.receipts);
      expect(after.audit).toHaveLength(historyOperations + 1);
      expect(after.receipts).toHaveLength(historyOperations + 1);
      expect(after.audit.at(-1)).toMatchObject({
        kind: 'revoke',
        actor_installation_id: a.alice.installationId,
        target_id: b.bob.installationId,
      });
      expect(after.metadata[0]).toMatchObject({
        operations: historyOperations + 1,
        day_mutations: L.dailyMutations + 1,
      });
      for (const command of [
        { kind: 'status' },
        { kind: 'roster', after: 0, limit: 50 },
        { kind: 'pending', after: 0, limit: 50 },
        { kind: 'audit', after: 0, limit: 50 },
        inviteCommand,
        b.join,
      ])
        expect(await call(a.groupId, b.credential, command)).toEqual(deny);
      expect(
        await call(a.groupId, secret(), { ...fresh, inviteSecret: inviteCommand.inviteSecret }),
      ).toEqual({ ok: false, error: 'denied' });
      expect(await call(a.groupId, a.credential, b.approval)).toEqual({
        ok: false,
        error: 'denied',
      });
      for (let i = 0; i < 10; i++) {
        expect(
          await call(a.groupId, a.credential, { ...revoke, operationId: operationId() }),
        ).toEqual(deny);
        expect(
          await call(a.groupId, a.credential, {
            ...revoke,
            operationId: operationId(),
            installationId: crypto.randomUUID(),
          }),
        ).toEqual(deny);
      }
      expect(await snapshot(a.stub)).toEqual(after);
      const selfRevoke = {
        ...revoke,
        operationId: operationId(),
        installationId: a.alice.installationId,
      };
      expect(identity(await call(a.groupId, a.credential, selfRevoke)).state).toBe('revoked');
      const final = await snapshot(a.stub);
      expect(await call(a.groupId, a.credential, selfRevoke)).toEqual(deny);
      expect(
        await call(a.groupId, a.credential, { ...selfRevoke, operationId: operationId() }),
      ).toEqual(deny);
      expect(await snapshot(a.stub)).toEqual(final);
    },
  );

  it('rolls back a normal write that crosses the actual storage fence', async () => {
    const a = await create();
    const paddingRows = await runInDurableObject(a.stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec('CREATE TABLE capacity_fixture (padding BLOB)').toArray();
      const allocated = Number(sql.exec('SELECT allocated FROM delivery_control').one().allocated);
      const ceiling = C.normalDatabaseBytes + allocated;
      while (sql.databaseSize < ceiling - 65_536)
        sql
          .exec(
            'INSERT INTO capacity_fixture VALUES(zeroblob(?))',
            Math.min(1_048_576, ceiling - sql.databaseSize - 65_536),
          )
          .toArray();
      expect(sql.databaseSize).toBeLessThan(ceiling);
      sql
        .exec(
          'CREATE TRIGGER grow_receipt AFTER INSERT ON receipts BEGIN INSERT INTO capacity_fixture VALUES(zeroblob(131072)); END',
        )
        .toArray();
      return sql.exec<{ n: number }>('SELECT count(*) AS n FROM capacity_fixture').one().n;
    });
    const before = await snapshot(a.stub);
    expect(
      await call(a.groupId, a.credential, {
        kind: 'invite',
        operationId: operationId(),
        inviteSecret: secret(),
        ttlSeconds: 900,
      }),
    ).toEqual({ ok: false, error: 'limit' });
    expect(await snapshot(a.stub)).toEqual(before);
    await runInDurableObject(a.stub, (_instance, state) => {
      expect(
        state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM capacity_fixture').one().n,
      ).toBe(paddingRows);
      expect(
        state.storage.sql.databaseSize -
          Number(state.storage.sql.exec('SELECT allocated FROM delivery_control').one().allocated),
      ).toBeLessThanOrEqual(C.normalDatabaseBytes);
    });
  });

  it('measures wide-field SQLite/index/page growth for all 512 lifetime revocations', async ({
    annotate,
  }) => {
    expect(C.reservedDatabaseBytes).toBeLessThanOrEqual(C.designBudgetBytes);
    const names = ['\u0001'.repeat(120), '\u0800'.repeat(120), '\u202e'.repeat(120)];
    const a = await create(names[0], names[1]);
    // Retained pending join fixtures and real revoke transitions retain 416 historical
    // enrollments. Advance the fixture day separately from the storage measurement.
    for (let i = 0; i < L.enrollments - L.members - L.pending; i++) {
      if (i % 64 === 0)
        await runInDurableObject(a.stub, (_instance, state) => {
          state.storage.sql.exec('UPDATE metadata SET day=?', -1).toArray();
        });
      const old = await legacyPending(a.groupId, a.credential, names[i % names.length]);
      expect(
        (
          await call(a.groupId, a.credential, {
            kind: 'revoke',
            operationId: operationId(),
            installationId: old.bob.installationId,
          })
        ).ok,
      ).toBe(true);
    }
    await runInDurableObject(a.stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE metadata SET day=?', -1).toArray();
    });
    const live: Awaited<ReturnType<typeof legacyPending>>[] = [];
    for (let i = 0; i < L.members - 1 + L.pending; i++) {
      const member = await legacyPending(a.groupId, a.credential, names[i % names.length]);
      if (i < L.members - 1)
        expect((await call(a.groupId, a.credential, member.approval)).ok).toBe(true);
      live.push(member);
    }
    // One issuer owns the maximum 32 unexpired invitations at closure.
    const issuer = live[0];
    for (let i = 0; i < L.openInvites; i++)
      expect(
        (
          await call(a.groupId, issuer.credential, {
            kind: 'invite',
            operationId: operationId(),
            inviteSecret: secret(),
            ttlSeconds: 900,
          })
        ).ok,
      ).toBe(true);
    const actorHash = await capabilityHash(a.groupId, 'installation', a.credential);
    const responses = names.map((displayName) =>
      JSON.stringify({
        kind: 'identity',
        identity: {
          ...issuer.bob,
          displayName,
          state: 'revoked',
        },
      }),
    );
    const before = await runInDurableObject(a.stub, (_instance, state) => {
      const sql = state.storage.sql;
      expect(sql.exec<{ page_size: number }>('PRAGMA page_size').one().page_size).toBe(C.pageBytes);
      expect(sql.exec<{ n: number }>('SELECT count(*) AS n FROM enrollments').one().n).toBe(
        L.enrollments,
      );
      expect(
        sql
          .exec<{ n: number }>('SELECT count(*) AS n FROM enrollments WHERE state=?', 'active')
          .one().n,
      ).toBe(L.members);
      expect(
        sql
          .exec<{ n: number }>('SELECT count(*) AS n FROM enrollments WHERE state=?', 'pending')
          .one().n,
      ).toBe(L.pending);
      state.storage.transactionSync(() => {
        const n = sql
          .exec<{ operations: number }>('SELECT operations FROM metadata')
          .one().operations;
        // Seed bounded historical receipt/audit occupancy with maximum-width legal
        // cells, and expired invites to grow the relevant B-trees.
        for (let i = n; i < C.normalOperations; i++) {
          sql
            .exec(
              'INSERT INTO receipts(credential_hash,operation_id,request_hash,response) VALUES(?,?,?,?)',
              actorHash,
              operationId(),
              secret(),
              responses[i % responses.length],
            )
            .toArray();
          sql
            .exec(
              'INSERT INTO audit(kind,actor_installation_id,target_id,recorded_at) VALUES(?,?,?,?)',
              'approve',
              a.alice.installationId,
              issuer.bob.installationId,
              Date.now(),
            )
            .toArray();
          sql
            .exec(
              'INSERT INTO invitations(invite_id,secret_hash,issuer_id,expires_at,state) VALUES(?,?,?,?,?)',
              crypto.randomUUID(),
              secret(),
              issuer.bob.installationId,
              Date.now() - 1,
              'open',
            )
            .toArray();
        }
        const inviteCount = sql
          .exec<{ n: number }>('SELECT count(*) AS n FROM invitations')
          .one().n;
        for (let i = inviteCount; i < C.normalOperations; i++)
          sql
            .exec(
              'INSERT INTO invitations(invite_id,secret_hash,issuer_id,expires_at,state) VALUES(?,?,?,?,?)',
              crypto.randomUUID(),
              secret(),
              issuer.bob.installationId,
              Date.now() - 1,
              'open',
            )
            .toArray();
        sql
          .exec(
            'UPDATE metadata SET operations=?,day=?,day_mutations=?',
            C.normalOperations,
            Math.floor(Date.now() / 86_400_000),
            L.dailyMutations,
          )
          .toArray();
        expect(sql.databaseSize).toBeLessThan(C.normalDatabaseBytes);
        sql.exec('CREATE TABLE capacity_fixture (padding BLOB)').toArray();
        while (sql.databaseSize < C.normalDatabaseBytes)
          sql
            .exec(
              'INSERT INTO capacity_fixture VALUES(zeroblob(?))',
              Math.min(1_048_576, C.normalDatabaseBytes - sql.databaseSize),
            )
            .toArray();
      });
      return {
        bytes: sql.databaseSize,
        invites: sql.exec<{ n: number }>('SELECT count(*) AS n FROM invitations').one().n,
        roots: sql
          .exec(
            'SELECT name,rootpage FROM sqlite_schema WHERE type=? AND name NOT LIKE ? ORDER BY name',
            'index',
            'sqlite_autoindex%',
          )
          .toArray(),
      };
    });
    const sizes = [before.bytes];
    for (const member of live) {
      expect(
        identity(
          await call(a.groupId, a.credential, {
            kind: 'revoke',
            operationId: operationId(),
            installationId: member.bob.installationId,
          }),
        ),
      ).toEqual({ ...member.bob, state: 'revoked' });
      sizes.push(
        await runInDurableObject(a.stub, (_instance, state) => state.storage.sql.databaseSize),
      );
    }
    expect(
      identity(
        await call(a.groupId, a.credential, {
          kind: 'revoke',
          operationId: operationId(),
          installationId: a.alice.installationId,
        }),
      ).state,
    ).toBe('revoked');
    const after = await runInDurableObject(a.stub, (_instance, state) => {
      const sql = state.storage.sql;
      expect(
        sql.exec<{ n: number }>('SELECT count(*) AS n FROM audit WHERE kind=?', 'revoke').one().n,
      ).toBe(L.enrollments);
      expect(
        sql
          .exec<{ n: number }>('SELECT count(*) AS n FROM enrollments WHERE state=?', 'revoked')
          .one().n,
      ).toBe(L.enrollments);
      const updatedInvites = sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM invitations WHERE state=?', 'revoked')
        .one().n;
      expect(updatedInvites).toBe(L.openInvites);
      return { bytes: sql.databaseSize, updatedInvites };
    });
    sizes.push(after.bytes);
    const growth = after.bytes - before.bytes;
    expect(growth).toBeGreaterThan(0);
    expect(growth).toBeLessThanOrEqual(C.revocationReserveBytes);
    expect(after.bytes).toBeLessThan(C.reservedDatabaseBytes);
    const maxStep = Math.max(...sizes.slice(1).map((bytes, i) => bytes - sizes[i]));
    expect(before.roots.map((row) => row.name)).toEqual([
      'enrollment_state',
      'invitation_state_expiry',
    ]);
    expect(maxStep).toBeLessThan(65_536);
    expect(before.invites).toBe(C.normalOperations);
    // Keep numeric, secret-free runtime evidence with the test result, rather than
    // treating a previous allocation measurement as a version-independent limit.
    await annotate(
      JSON.stringify({
        beforeBytes: before.bytes,
        afterBytes: after.bytes,
        growthBytes: growth,
        maxStepBytes: maxStep,
        inviteRows: before.invites,
        lifetimeRevokes: L.enrollments,
        closureRevokes: live.length + 1,
        updatedInvites: after.updatedInvites,
        reserveBytes: C.revocationReserveBytes,
        ceilingBytes: C.reservedDatabaseBytes,
      }),
      'sqlite-growth',
    );
  }, 30_000);

  it('denies join after expiry, approvals after issuer revocation, and conflicting receipt kinds', async () => {
    const a = await create();
    const approved = await legacyPending(a.groupId, a.credential);
    await call(a.groupId, a.credential, approved.approval);
    const b = await legacyPending(a.groupId, a.credential);
    expect(
      await call(a.groupId, a.credential, {
        kind: 'invite',
        operationId: a.init.operationId,
        inviteSecret: secret(),
        ttlSeconds: 10,
      }),
    ).toEqual({ ok: false, error: 'conflict' });
    const expired = secret();
    const issued = await call(a.groupId, a.credential, {
      kind: 'invite',
      operationId: operationId(),
      inviteSecret: expired,
      ttlSeconds: 1,
    });
    if (!issued.ok || issued.value.kind !== 'invitation') throw new Error('fixture');
    const id = issued.value.inviteId;
    await runInDurableObject(a.stub, (_instance, state) => {
      state.storage.sql
        .exec('UPDATE invitations SET expires_at=? WHERE invite_id=?', Date.now() - 1, id)
        .toArray();
    });
    expect(
      await call(a.groupId, secret(), {
        ...b.join,
        operationId: operationId(),
        inviteSecret: expired,
      }),
    ).toEqual(deny);
    await call(a.groupId, approved.credential, {
      kind: 'revoke',
      operationId: operationId(),
      installationId: a.alice.installationId,
    });
    expect(await call(a.groupId, approved.credential, b.approval)).toEqual(deny);
    expect(await call(a.groupId, secret(), { ...b.join, operationId: operationId() })).toEqual(
      deny,
    );
  });
});

async function http(path: string, credential: string, command: unknown, setupCapability?: string) {
  return SELF.fetch(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential}`,
      ...(setupCapability ? { 'X-Group-Setup': setupCapability } : {}),
    },
    body: JSON.stringify(command),
  });
}
describe('thin typed HTTP and fail-closed activation', () => {
  it('fails closed by default for Free/Paid/trial/unknown/stale strings and non-loopback local overrides', async () => {
    for (const mode of ['disabled', 'free', 'paid', 'trial', 'unknown', 'stale']) {
      Object.assign(env, { HOSTING_MODE: mode });
      const response = await SELF.fetch('http://127.0.0.1/v1/create');
      expect(await response.json()).toEqual({ ok: false, error: 'hosting_disabled' });
    }
    await configure();
    for (const url of [
      'https://127.0.0.1/v1/create',
      'https://service.workers.dev/v1/create',
      'http://example.com/v1/create',
    ]) {
      expect((await SELF.fetch(url)).status).toBe(503);
    }
  });

  it('bounds streaming bodies without Content-Length and rejects declared oversize/auth/shape probes', async () => {
    const a = await create();
    const path = `/v1/groups/${a.groupId}`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
        controller.close();
      },
    });
    const response = await SELF.fetch(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.credential}` },
      body: stream,
    });
    expect(await response.json()).toEqual({ ok: false, error: 'invalid' });
    const declared = await SELF.fetch(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${a.credential}`,
        'Content-Length': '4097',
      },
      body: '{}',
    });
    expect(declared.status).toBe(400);
    const bareAuth = await SELF.fetch(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: a.credential },
      body: JSON.stringify({ kind: 'status' }),
    });
    expect(bareAuth.status).toBe(403);
    expect(
      (
        await http(path, a.credential, {
          kind: 'invite',
          operationId: operationId(),
          inviteSecret: secret(),
          ttlSeconds: 901,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await http(
          '/v1/create',
          a.credential,
          { kind: 'initialize', operationId: operationId(), groupName: 'Group' },
          setup,
        )
      ).status,
    ).toBe(400);
    const audits = await call(a.groupId, a.credential, { kind: 'audit', after: 0, limit: 50 });
    expect(audits.ok && audits.value.kind === 'audit' && audits.value.entries.length).toBe(1);
  });

  it('creates, joins, approves, reads and revokes through HTTP with body/query/prefetch/privacy limits', async () => {
    await configure();
    const aliceCredential = secret();
    const init = {
      kind: 'initialize',
      operationId: operationId(),
      groupName: 'HTTP group',
      displayName: 'Alice',
    };
    const created = identity(
      await (await http('/v1/create', aliceCredential, init, setup)).json<MembershipResult>(),
    );
    const path = `/v1/groups/${created.groupId}`;
    expect(
      identity(
        await (await http('/v1/create', aliceCredential, init, setup)).json<MembershipResult>(),
      ),
    ).toEqual(created);
    const inviteSecret = secret();
    expect(
      (
        await http(path, aliceCredential, {
          kind: 'invite',
          operationId: operationId(),
          inviteSecret,
          ttlSeconds: 900,
        })
      ).status,
    ).toBe(200);
    const bobCredential = secret();
    const confirmation = secret();
    const joined = identity(
      await (
        await http(path, bobCredential, {
          kind: 'join',
          operationId: operationId(),
          inviteSecret,
          confirmation,
          displayName: 'Bob',
        })
      ).json<MembershipResult>(),
    );
    expect(
      (
        await http(path, aliceCredential, {
          kind: 'approve',
          operationId: operationId(),
          installationId: joined.installationId,
          confirmation,
        })
      ).status,
    ).toBe(200);
    const roster = await http(path, bobCredential, { kind: 'roster', after: 0, limit: 50 });
    expect(roster.status).toBe(200);
    expect(roster.headers.get('Cache-Control')).toBe('no-store');
    expect(roster.headers.get('Referrer-Policy')).toBe('no-referrer');
    const text = await roster.text();
    for (const cap of [aliceCredential, bobCredential, confirmation, inviteSecret, setup])
      expect(text).not.toContain(cap);
    expect((await SELF.fetch(`http://127.0.0.1${path}`, { method: 'GET' })).status).toBe(400);
    expect(
      (await http(`${path}?credential=${bobCredential}`, bobCredential, { kind: 'status' })).status,
    ).toBe(400);
    expect(
      (
        await http(path, bobCredential, {
          kind: 'status',
          privateChat: 'PRIVATE-ASIDE-CANARY',
          providerSession: 'PERSONAL-SESSION-CANARY',
        })
      ).status,
    ).toBe(400);
    expect((await http(path, bobCredential, { kind: 'roster', after: 0, limit: 51 })).status).toBe(
      400,
    );
    expect(
      (
        await http(path, bobCredential, {
          kind: 'join',
          operationId: operationId(),
          inviteSecret,
          confirmation,
          displayName: ' ',
        })
      ).status,
    ).toBe(400);
    expect(
      (await http(path, bobCredential, { kind: 'status', extra: 'x'.repeat(L.bodyBytes) })).status,
    ).toBe(400);
    const response = await http(path, bobCredential, {
      kind: 'status',
      extra: 'SECRET-ERROR-CANARY',
    });
    expect(await response.text()).not.toContain('SECRET-ERROR-CANARY');
    expect(
      (
        await http(path, aliceCredential, {
          kind: 'revoke',
          operationId: operationId(),
          installationId: joined.installationId,
        })
      ).status,
    ).toBe(200);
    expect((await http(path, bobCredential, { kind: 'status' })).status).toBe(403);
    // Direct entrypoint has the same production gate, independent of SELF fixture.
    Object.assign(env, { HOSTING_MODE: 'disabled' });
    const direct = await worker.fetch(new Request('http://127.0.0.1/v1/create'), env);
    expect(direct.status).toBe(503);
  });
});
