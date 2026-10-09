import { runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import { DELIVERY_LIMITS as L } from '@dock/shared/dist/group-delivery.js';
import type { MembershipResult } from '@dock/shared/dist/group-membership.js';
import type { GroupMembership } from '../src/membership.js';
import { MEMBERSHIP_CAPACITY as C } from '../src/capacity.js';

type Stub = DurableObjectStub<GroupMembership>;
type Membership = (command: unknown, credential?: string) => Promise<MembershipResult>;
const uuid = () => crypto.randomUUID();
const secret = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');

export async function pressureMembers(membership: Membership) {
  const members: { installationId: string; credential: string }[] = [];
  for (let i = 0; i < 32; i++) {
    const inviteSecret = secret(),
      credential = secret(),
      confirmation = secret();
    const invited = await membership({
      kind: 'invite',
      operationId: uuid(),
      inviteSecret,
      ttlSeconds: 900,
    });
    if (!invited.ok || invited.value.kind !== 'invitation') throw new Error('Expected invitation');
    const joined = await membership(
      {
        kind: 'join',
        operationId: uuid(),
        inviteSecret,
        confirmation,
        displayName: ('Member ' + i + ' ').padEnd(120, 'x'),
      },
      credential,
    );
    if (!joined.ok || joined.value.kind !== 'identity') throw new Error('Expected joined member');
    expect(
      await membership({
        kind: 'approve',
        operationId: uuid(),
        installationId: joined.value.identity.installationId,
        confirmation,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await membership({
        kind: 'revokeInvite',
        operationId: uuid(),
        inviteId: invited.value.inviteId,
      }),
    ).toMatchObject({ ok: true });
    members.push({ installationId: joined.value.identity.installationId, credential });
  }
  return members;
}

export async function fillNormalFeatureFence(stub: Stub) {
  return runInDurableObject(stub, (_, state) => {
    const sql = state.storage.sql;
    sql.exec('CREATE TABLE delivery_test_revocation_pressure(body BLOB)').toArray();
    const future = sql
      .exec<{ future_physical: number }>('SELECT future_physical FROM delivery_control')
      .one().future_physical;
    const target = C.normalDatabaseBytes + L.databaseBytes - future;
    for (const size of [2 * 1024 ** 2, 4096])
      for (;;) {
        try {
          state.storage.transactionSync(() => {
            sql
              .exec('INSERT INTO delivery_test_revocation_pressure VALUES(zeroblob(?))', size)
              .toArray();
            if (sql.databaseSize > target) throw new Error('physical fence');
          });
        } catch {
          break;
        }
      }
    expect(target - sql.databaseSize).toBeLessThan(8192);
    // Fill the existing charged feature allocation; accepted future remains part of it.
    sql.exec('UPDATE delivery_control SET allocated=?', L.databaseBytes).toArray();
    return { bytes: sql.databaseSize, future };
  });
}

export async function revokeIntoProtectedEnvelope(
  stub: Stub,
  membership: Membership,
  members: Awaited<ReturnType<typeof pressureMembers>>,
) {
  for (const member of members) {
    expect(
      await membership({
        kind: 'revoke',
        operationId: uuid(),
        installationId: member.installationId,
      }),
    ).toMatchObject({ ok: true });
    const size = await runInDurableObject(stub, (_, state) => ({
      bytes: state.storage.sql.databaseSize,
      future: state.storage.sql
        .exec<{ future_physical: number }>('SELECT future_physical FROM delivery_control')
        .one().future_physical,
    }));
    if (size.bytes + size.future > C.normalDatabaseBytes + L.databaseBytes + 8192) {
      expect(size.bytes + size.future).toBeLessThan(C.reservedDatabaseBytes + L.databaseBytes);
      return { ...size, revoked: member };
    }
  }
  throw new Error('Actual revocations did not grow past the normal admission fence');
}
