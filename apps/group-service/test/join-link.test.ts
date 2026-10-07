import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import {
  MEMBERSHIP_LIMITS,
  membershipEnvelopeSchema,
  type MembershipResult,
} from '@dock/shared/dist/group-membership.js';
import { creationGroupId, setupHash } from '../src/crypto.js';
import { MEMBERSHIP_CAPACITY } from '../src/capacity.js';

const secret = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
const uuid = () => crypto.randomUUID();
const denied = { ok: false, error: 'denied' };
function identity(result: MembershipResult) {
  if (!result.ok || result.value.kind !== 'identity') throw new Error('Expected identity');
  return result.value.identity;
}
async function fixture() {
  const setup = secret(),
    credential = secret(),
    operationId = uuid();
  const hash = await setupHash(setup);
  Object.assign(env, { HOSTING_MODE: 'local-test', GROUP_SETUP_HASH: hash });
  const groupId = await creationGroupId(hash, operationId);
  const stub = env.GROUPS.getByName(groupId);
  const call = (command: unknown, bearer = credential, setupCapability?: string) =>
    stub.execute(
      membershipEnvelopeSchema.parse({
        groupId,
        credential: bearer,
        command,
        ...(setupCapability ? { setupCapability } : {}),
      }),
    );
  const creator = identity(
    await call(
      { kind: 'initialize', operationId, groupName: 'Reusable link', displayName: 'Creator' },
      credential,
      setup,
    ),
  );
  async function issue() {
    const inviteSecret = secret();
    const result = await call({
      kind: 'invite',
      operationId: uuid(),
      inviteSecret,
      ttlSeconds: MEMBERSHIP_LIMITS.inviteSeconds,
    });
    if (!result.ok || result.value.kind !== 'invitation') throw new Error('Expected invitation');
    return { inviteSecret, ...result.value };
  }
  async function enroll(inviteSecret: string) {
    const bearer = secret();
    const command = {
      kind: 'join',
      operationId: uuid(),
      inviteSecret,
      confirmation: secret(),
      displayName: 'Member',
    };
    return { bearer, command, identity: identity(await call(command, bearer)) };
  }
  async function legacy() {
    const invite = await issue();
    const member = await enroll(invite.inviteSecret);
    // Retained records from the previous release: a successful join had already
    // consumed the invitation and persisted this pending enrollment.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql
        .exec(
          'UPDATE enrollments SET state=? WHERE installation_id=?',
          'pending',
          member.identity.installationId,
        )
        .toArray();
      state.storage.sql
        .exec(
          'UPDATE invitations SET state=?,expires_at=? WHERE invite_id=?',
          'consumed',
          Date.now() - 1,
          invite.inviteId,
        )
        .toArray();
    });
    return { ...member, invite };
  }
  return { groupId, stub, credential, creator, call, issue, enroll, legacy };
}
afterEach(async () => {
  vi.useRealTimers();
  await reset();
  Object.assign(env, { HOSTING_MODE: 'disabled', GROUP_SETUP_HASH: '' });
});

it('keeps a normal invitation usable after fifteen minutes and expires it after seven days', async () => {
  const f = await fixture();
  const started = Date.now();
  vi.setSystemTime(started);
  const invite = await f.issue();
  expect(invite.expiresAt).toBe(started + 7 * 24 * 60 * 60 * 1000);
  expect(
    membershipEnvelopeSchema.safeParse({
      groupId: f.groupId,
      credential: f.credential,
      command: {
        kind: 'invite',
        operationId: uuid(),
        inviteSecret: secret(),
        ttlSeconds: 7 * 24 * 60 * 60 + 1,
      },
    }).success,
  ).toBe(false);
  vi.setSystemTime(started + 16 * 60 * 1000);
  const member = await f.enroll(invite.inviteSecret);
  expect(member.identity.state).toBe('active');
  vi.setSystemTime(invite.expiresAt - 1);
  expect((await f.enroll(invite.inviteSecret)).identity.state).toBe('active');
  vi.setSystemTime(invite.expiresAt + 1);
  expect(await f.call({ ...member.command, operationId: uuid() }, secret())).toEqual(denied);
  expect(identity(await f.call({ kind: 'status' }, member.bearer)).state).toBe('active');
});

it('counts unexpired legacy consumed grants against the reusable invitation limit', async () => {
  const f = await fixture();
  const grants = await Promise.all(
    Array.from({ length: MEMBERSHIP_LIMITS.openInvites }, () => f.issue()),
  );
  await runInDurableObject(f.stub, (_instance, state) =>
    state.storage.sql.exec('UPDATE invitations SET state=?', 'consumed').toArray(),
  );
  const command = { kind: 'invite', operationId: uuid(), inviteSecret: secret(), ttlSeconds: 900 };
  expect(await f.call(command)).toEqual({ ok: false, error: 'limit' });
  await runInDurableObject(f.stub, (_instance, state) =>
    state.storage.sql
      .exec(
        'UPDATE invitations SET expires_at=? WHERE invite_id=?',
        Date.now() - 1,
        grants[0].inviteId,
      )
      .toArray(),
  );
  expect((await f.call(command)).ok).toBe(true);
});

it('one invitation admits multiple distinct active members and preserves exact concurrent retry receipts', async () => {
  const f = await fixture(),
    invite = await f.issue();
  const [a, b] = await Promise.all([f.enroll(invite.inviteSecret), f.enroll(invite.inviteSecret)]);
  expect(a.identity.state).toBe('active');
  expect(b.identity.state).toBe('active');
  expect(a.identity.installationId).not.toBe(b.identity.installationId);
  await evictDurableObject(f.stub);
  const repeated = await Promise.all([f.call(a.command, a.bearer), f.call(a.command, a.bearer)]);
  expect(repeated.map(identity)).toEqual([a.identity, a.identity]);
  expect(await f.call({ ...a.command, displayName: 'Changed' }, a.bearer)).toEqual({
    ok: false,
    error: 'conflict',
  });
  const compatibility = {
    kind: 'approve',
    operationId: uuid(),
    installationId: a.identity.installationId,
    confirmation: a.command.confirmation,
  };
  expect(identity(await f.call(compatibility))).toEqual(a.identity);
  expect(await f.call({ ...compatibility, operationId: uuid(), confirmation: secret() })).toEqual(
    denied,
  );
  const roster = await f.call({ kind: 'roster', after: 0, limit: 50 }, b.bearer);
  expect(roster.ok && roster.value.kind === 'members' && roster.value.entries.length).toBe(3);
  expect(
    await runInDurableObject(
      f.stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{
            state: string;
          }>('SELECT state FROM invitations WHERE invite_id=?', invite.inviteId)
          .one().state,
    ),
  ).toBe('open');
});

it('retains join expiry, revoked grant, inactive issuer and revoked bearer checks for reusable links', async () => {
  const f = await fixture(),
    invite = await f.issue();
  const member = await f.enroll(invite.inviteSecret);
  // Legacy consumed links can also accept a different installation until expiry.
  await runInDurableObject(f.stub, (_instance, state) =>
    state.storage.sql
      .exec('UPDATE invitations SET state=? WHERE invite_id=?', 'consumed', invite.inviteId)
      .toArray(),
  );
  const other = await f.enroll(invite.inviteSecret);
  expect(other.identity.state).toBe('active');
  const freshJoin = () => ({ ...member.command, operationId: uuid() });
  await runInDurableObject(f.stub, (_instance, state) =>
    state.storage.sql
      .exec(
        'UPDATE invitations SET expires_at=? WHERE invite_id=?',
        Date.now() - 1,
        invite.inviteId,
      )
      .toArray(),
  );
  expect(await f.call(freshJoin(), secret())).toEqual(denied);
  const revoked = await f.issue();
  expect(
    (await f.call({ kind: 'revokeInvite', operationId: uuid(), inviteId: revoked.inviteId })).ok,
  ).toBe(true);
  expect(await f.call({ ...freshJoin(), inviteSecret: revoked.inviteSecret }, secret())).toEqual(
    denied,
  );
  expect(
    (
      await f.call({
        kind: 'revoke',
        operationId: uuid(),
        installationId: member.identity.installationId,
      })
    ).ok,
  ).toBe(true);
  expect(await f.call(member.command, member.bearer)).toEqual(denied);
  const orphaned = await f.issue();
  expect(
    (
      await f.call(
        { kind: 'revoke', operationId: uuid(), installationId: f.creator.installationId },
        other.bearer,
      )
    ).ok,
  ).toBe(true);
  expect(await f.call({ ...freshJoin(), inviteSecret: orphaned.inviteSecret }, secret())).toEqual(
    denied,
  );
});

it('reconciles already accepted pending records after expiry through status or an active member read exactly once', async () => {
  for (const kind of ['status', 'roster', 'pending'] as const) {
    const f = await fixture(),
      old = await f.legacy();
    await evictDurableObject(f.stub);
    const counts = () =>
      runInDurableObject(f.stub, (_instance, state) => ({
        operations: state.storage.sql.exec<{ n: number }>('SELECT operations n FROM metadata').one()
          .n,
        audit: state.storage.sql.exec<{ n: number }>('SELECT count(*) n FROM audit').one().n,
      }));
    const before = await counts();
    const read = () =>
      kind === 'status' ? f.call({ kind }, old.bearer) : f.call({ kind, after: 0, limit: 50 });
    expect((await read()).ok).toBe(true);
    expect(identity(await f.call({ kind: 'status' }, old.bearer)).state).toBe('active');
    expect(await counts()).toEqual({ operations: before.operations + 1, audit: before.audit + 1 });
    await evictDurableObject(f.stub);
    expect((await read()).ok).toBe(true);
    expect(await counts()).toEqual({ operations: before.operations + 1, audit: before.audit + 1 });
  }
});

it('never reconciles revoked pending grants, revoked pending members or inactive issuers, and respects admission limits', async () => {
  const f = await fixture();
  const active = await f.enroll((await f.issue()).inviteSecret);
  const revokedGrant = await f.legacy(),
    revokedMember = await f.legacy(),
    inactiveIssuer = await f.legacy();
  expect(
    (
      await f.call({
        kind: 'revokeInvite',
        operationId: uuid(),
        inviteId: revokedGrant.invite.inviteId,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await f.call({
        kind: 'revoke',
        operationId: uuid(),
        installationId: revokedMember.identity.installationId,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await f.call(
        { kind: 'revoke', operationId: uuid(), installationId: f.creator.installationId },
        active.bearer,
      )
    ).ok,
  ).toBe(true);
  for (const old of [revokedGrant, revokedMember, inactiveIssuer])
    expect(await f.call({ kind: 'status' }, old.bearer)).toEqual(denied);
  const roster = await f.call({ kind: 'roster', after: 0, limit: 50 }, active.bearer);
  expect(roster.ok && roster.value.kind === 'members' && roster.value.entries.length).toBe(1);
  const limited = await fixture(),
    pending = await limited.legacy();
  await runInDurableObject(limited.stub, (_instance, state) =>
    state.storage.sql
      .exec('UPDATE metadata SET operations=?', MEMBERSHIP_CAPACITY.normalOperations)
      .toArray(),
  );
  expect(await limited.call({ kind: 'status' }, pending.bearer)).toEqual({
    ok: false,
    error: 'limit',
  });
  const retainedRoster = await limited.call({ kind: 'roster', after: 0, limit: 50 });
  expect(
    retainedRoster.ok &&
      retainedRoster.value.kind === 'members' &&
      retainedRoster.value.entries.length,
  ).toBe(1);
  expect(
    await runInDurableObject(
      limited.stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{
            state: string;
          }>(
            'SELECT state FROM enrollments WHERE installation_id=?',
            pending.identity.installationId,
          )
          .one().state,
    ),
  ).toBe('pending');
});
