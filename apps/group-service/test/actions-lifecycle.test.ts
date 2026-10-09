import { env } from 'cloudflare:workers';
import { SELF, evictDurableObject, runInDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { groupEventSchema } from '@dock/shared/dist/groups.js';
import { membershipEnvelopeSchema, MEMBERSHIP_LIMITS } from '@dock/shared/dist/group-membership.js';
import {
  publicationEnvelope,
  publicationHash,
  publicationKeySchema,
  DELIVERY_LIMITS,
} from '@dock/shared/dist/group-delivery.js';
import {
  groupActionLifecycleOperationId,
  GROUP_ACTION_LIMITS,
  type GroupAction,
  type GroupActionCommand,
  type GroupActionReply,
  type GroupActionResult,
} from '@dock/shared/dist/group-actions.js';
import { creationGroupId, setupHash } from '../src/crypto.js';
import { MEMBERSHIP_CAPACITY as C } from '../src/capacity.js';
import {
  fillNormalFeatureFence,
  physicalPressureCase,
  pressureMembers,
  revokeIntoProtectedEnvelope,
} from './capacity-pressure.js';

const uuid = () => crypto.randomUUID();
const secret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
function value(result: GroupActionResult): GroupActionReply {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
function action(result: GroupActionResult): GroupAction {
  const reply = value(result);
  if (reply.kind !== 'action') throw new Error('action');
  return reply.action;
}
async function fixture() {
  const setup = secret(),
    credential = secret(),
    init = {
      kind: 'initialize',
      operationId: uuid(),
      groupName: 'Lifecycle',
      displayName: 'Alice',
    };
  Object.assign(env, { HOSTING_MODE: 'local-test', GROUP_SETUP_HASH: await setupHash(setup) });
  const groupId = await creationGroupId(await setupHash(setup), init.operationId),
    stub = env.GROUPS.getByName(groupId);
  const result = await stub.execute(
    membershipEnvelopeSchema.parse({ groupId, credential, setupCapability: setup, command: init }),
  );
  if (!result.ok || result.value.kind !== 'identity') throw new Error('fixture');
  const identity = result.value.identity;
  // Deliberately distinct local source IDs and remote membership aliases.
  const binding = {
    groupId: uuid(),
    installationId: uuid(),
    epoch: uuid(),
    remoteGroupId: groupId,
    endpointId: uuid(),
    credentialRevision: 1,
  };
  const localMemberId = uuid();
  const membership = (command: unknown, token = credential) =>
    stub.execute(membershipEnvelopeSchema.parse({ groupId, credential: token, command }));
  const call = (command: GroupActionCommand, token = credential) =>
    stub.actions({ groupId, credential: token, command });
  async function publish(text: string, category: 'Instruction' | 'Decision', refs: string[] = []) {
    const source = {
      provider: category === 'Instruction' ? ('owner' as const) : ('codex' as const),
      sessionId: uuid(),
      nativeSessionId: uuid(),
      messageId: uuid(),
    };
    expect(
      await stub.deliver({
        groupId,
        credential,
        command: {
          kind: 'registerSource',
          operationId: uuid(),
          binding,
          memberId: localMemberId,
          source,
        },
      }),
    ).toMatchObject({ ok: true });
    const event = groupEventSchema.parse({
      eventId: uuid(),
      sequence: 1,
      scope: {
        groupId: binding.groupId,
        memberId: localMemberId,
        installationId: binding.installationId,
        visibility: 'shared',
        source,
        causalRefs: refs,
      },
      operationId: uuid(),
      entityId: uuid(),
      revision: 1,
      category,
      condensedText: 'Exact evidence',
      evidenceRefs: [],
      corrects: null,
      manifest: {
        bytes: new TextEncoder().encode(text).length,
        sha256: publicationHash(text),
        chunks: [
          { index: 0, bytes: new TextEncoder().encode(text).length, sha256: publicationHash(text) },
        ],
      },
      recordedAt: new Date().toISOString(),
    });
    const envelope = publicationEnvelope(binding, uuid(), { event, original: text });
    const { event: _event, ...rawKey } = envelope.header,
      key = publicationKeySchema.parse(rawKey);
    for (const packet of [
      { kind: 'begin', header: envelope.header } as const,
      ...envelope.chunks.map((chunk) => ({ kind: 'chunk', key, chunk }) as const),
      { kind: 'commit', key } as const,
    ])
      expect(
        await stub.deliver({ groupId, credential, command: { kind: 'effect', packet } }),
      ).toMatchObject({ ok: true });
    return { event, envelope };
  }
  const goal = await publish('Explicit owner shared goal.', 'Instruction');
  const task = {
    kind: 'group-owned-task',
    taskId: uuid(),
    managerId: uuid(),
    sharedGoalId: goal.event.eventId,
    title: 'Exact native task',
  };
  const owned = await publish(JSON.stringify(task), 'Decision', [goal.event.eventId]);
  const origin = {
    kind: 'autonomous' as const,
    eventId: owned.event.eventId,
    sharedGoalId: goal.event.eventId,
    managerId: task.managerId,
  };
  const workReply = value(
    await call({
      kind: 'register-work',
      operationId: uuid(),
      taskId: task.taskId,
      managerId: task.managerId,
      sharedGoalId: task.sharedGoalId,
      title: task.title,
      origin,
    }),
  );
  if (workReply.kind !== 'work') throw new Error('work');
  const work = workReply.work;
  async function propose(kind: 'start' | 'stop', revision: number, token = credential) {
    const instruction = value(
      await call({ kind: 'instruction', operationId: uuid(), text: `Please ${kind}.` }, token),
    );
    if (instruction.kind !== 'instruction') throw new Error('instruction');
    const reply = value(
      await call(
        {
          kind: 'propose',
          operationId: uuid(),
          workId: work.workId,
          expectedRevision: revision,
          action: kind,
          origin: { kind: 'instruction', eventId: instruction.instruction.eventId },
        },
        token,
      ),
    );
    if (reply.kind !== 'proposal') throw new Error('proposal');
    return reply.proposal;
  }
  async function confirm(kind: 'start' | 'stop', revision: number) {
    const p = await propose(kind, revision);
    return action(
      await call({
        kind: 'confirm',
        operationId: uuid(),
        proposalId: p.proposalId,
        expectedRevision: revision,
        override: false,
      }),
    );
  }
  const phase = (a: GroupAction, kind: 'claim' | 'uncertain') =>
    call({
      kind,
      actionId: a.actionId,
      operationId: groupActionLifecycleOperationId(a.actionId, kind),
    });
  const outcome = (a: GroupAction) => ({
    taskId: work.taskId,
    workerId: uuid(),
    outcomeId: uuid(),
    status: a.proposal.kind === 'start' ? ('started' as const) : ('stopped' as const),
    message: 'Exact persisted native receipt.',
  });
  const stats = () =>
    runInDurableObject(stub, (_instance, state) => ({
      control: state.storage.sql.exec('SELECT * FROM delivery_control').one(),
      reserves: state.storage.sql
        .exec('SELECT * FROM ga_lifecycle_reservations ORDER BY action_id')
        .toArray(),
      receipts: state.storage.sql.exec('SELECT * FROM ga_receipts ORDER BY rowid').toArray(),
      events: state.storage.sql.exec('SELECT * FROM ga_events ORDER BY position').toArray(),
    }));
  return {
    groupId,
    credential,
    identity,
    stub,
    call,
    membership,
    publish,
    owned,
    task,
    work,
    origin,
    propose,
    confirm,
    phase,
    outcome,
    stats,
  };
}
afterEach(async () => {
  await reset();
  Object.assign(env, { HOSTING_MODE: 'disabled', GROUP_SETUP_HASH: '' });
});

physicalPressureCase(
  'keeps accepted action lifecycle and authoritative reads after unrelated members use the revocation envelope',
  async () => {
    const f = await fixture(),
      members = await pressureMembers(f.membership),
      a = await f.confirm('start', 0);
    await fillNormalFeatureFence(f.stub);
    return { f, members, a };
  },
  async ({ f, members, a }) => {
    const pressure = await revokeIntoProtectedEnvelope(f.stub, f.membership, members);
    expect(
      await f.call({ kind: 'instruction', operationId: uuid(), text: 'New work remains refused.' }),
    ).toEqual({ ok: false, error: 'limit' });
    await evictDurableObject(f.stub);
    expect(await f.call({ kind: 'board', after: 0, limit: 50 })).toMatchObject({ ok: true });
    expect(action(await f.phase(a, 'claim')).state).toBe('dispatching');
    const complete = {
      kind: 'complete' as const,
      actionId: a.actionId,
      operationId: a.actionId,
      outcome: f.outcome(a),
    };
    const completed = await f.call(complete);
    expect(completed).toMatchObject({ ok: true, value: { action: { state: 'completed' } } });
    await evictDurableObject(f.stub);
    expect(await f.call(complete)).toEqual(completed);
    expect(await f.call({ kind: 'board', after: 0, limit: 50 })).toMatchObject({ ok: true });
    expect(
      await f.call({ kind: 'board', after: 0, limit: 50 }, pressure.revoked.credential),
    ).toEqual({ ok: false, error: 'denied' });
  },
);

it('reserves lifecycle writes before accepting work and completes across admission exhaustion, lost acknowledgements and eviction', async () => {
  const f = await fixture(),
    a = await f.confirm('start', 0);
  const reserved = await f.stats();
  expect(reserved.reserves).toMatchObject([
    {
      action_id: a.actionId,
      remaining_logical: GROUP_ACTION_LIMITS.lifecycleLogicalReserve,
      remaining_physical: GROUP_ACTION_LIMITS.lifecyclePhysicalReserve,
    },
  ]);
  await runInDurableObject(f.stub, (_instance, state) => {
    state.storage.sql
      .exec(
        'UPDATE metadata SET operations=?,day_mutations=? WHERE singleton=1',
        C.normalOperations,
        MEMBERSHIP_LIMITS.dailyMutations,
      )
      .toArray();
    state.storage.sql
      .exec('UPDATE delivery_feature_daily SET mutations=1000 WHERE singleton=1')
      .toArray();
    state.storage.sql
      .exec('UPDATE delivery_control SET logical=? WHERE singleton=1', DELIVERY_LIMITS.logicalBytes)
      .toArray();
    state.storage.transactionSync(() => {
      const response = JSON.stringify({
        kind: 'instruction',
        instruction: {
          eventId: uuid(),
          actor: a.proposal.actor,
          text: 'Retained historical admission.',
          at: new Date().toISOString(),
        },
      });
      for (let i = 0; i < GROUP_ACTION_LIMITS.memberAdmissionReceipts; i++)
        state.storage.sql
          .exec(
            'INSERT INTO ga_receipts VALUES(?,?,?,?)',
            a.proposal.actor.installationId,
            uuid(),
            JSON.stringify([
              a.proposal.actor.groupId,
              a.proposal.actor.memberId,
              { kind: 'instruction' },
            ]),
            response,
          )
          .toArray();
    });
  });
  expect(
    await f.call({ kind: 'instruction', operationId: uuid(), text: 'New admission.' }),
  ).toEqual({ ok: false, error: 'limit' });
  expect(action(await f.phase(a, 'claim')).state).toBe('dispatching');
  const afterClaim = await f.stats();
  await evictDurableObject(f.stub);
  expect(action(await f.phase(a, 'claim')).state).toBe('dispatching');
  expect((await f.stats()).receipts).toEqual(afterClaim.receipts);
  expect(action(await f.phase(a, 'uncertain')).state).toBe('uncertain');
  const complete = {
    kind: 'complete' as const,
    actionId: a.actionId,
    operationId: a.actionId,
    outcome: f.outcome(a),
  };
  const completed = await f.call(complete);
  expect(completed).toMatchObject({ ok: true, value: { action: { state: 'completed' } } });
  await evictDurableObject(f.stub);
  expect(await f.call(complete)).toEqual(completed);
  expect((await f.stats()).reserves).toMatchObject([
    { released: 1, remaining_logical: 0, remaining_physical: 0 },
  ]);
  expect(await f.call({ ...complete, operationId: uuid() })).toEqual({
    ok: false,
    error: 'invalid',
  });
});

it('refuses an unreservable confirmation atomically and preserves old source facts/receipts', async () => {
  const f = await fixture(),
    p = await f.propose('start', 0);
  await runInDurableObject(f.stub, (_instance, state) =>
    state.storage.sql
      .exec(
        'UPDATE delivery_control SET logical=? WHERE singleton=1',
        DELIVERY_LIMITS.logicalBytes - GROUP_ACTION_LIMITS.lifecycleLogicalReserve + 1,
      )
      .toArray(),
  );
  const before = await f.stats();
  expect(
    await f.call({
      kind: 'confirm',
      operationId: uuid(),
      proposalId: p.proposalId,
      expectedRevision: 0,
      override: false,
    }),
  ).toEqual({ ok: false, error: 'limit' });
  expect(await f.stats()).toEqual(before);
});

it('native override boolean cannot mint exact owner confirmation; protected confirmation and claims recheck current membership', async () => {
  const f = await fixture(),
    a = await f.confirm('start', 0);
  const inviteSecret = secret(),
    token = secret();
  expect(
    await f.membership({ kind: 'invite', operationId: uuid(), inviteSecret, ttlSeconds: 900 }),
  ).toMatchObject({ ok: true });
  const joined = await f.membership(
    { kind: 'join', operationId: uuid(), inviteSecret, confirmation: secret(), displayName: 'Bob' },
    token,
  );
  if (!joined.ok || joined.value.kind !== 'identity') throw new Error('join');
  const bob = joined.value.identity,
    p = await f.propose('stop', 1, token);
  expect(p.overrideRequired).toBe(true);
  const command = {
    kind: 'confirm' as const,
    operationId: uuid(),
    proposalId: p.proposalId,
    expectedRevision: 1,
    override: true,
  };
  const envelope = { groupId: f.groupId, credential: token, command };
  expect(await f.stub.actions(envelope)).toEqual({ ok: false, error: 'denied' });
  expect(
    await (
      await SELF.fetch(`http://127.0.0.1/v1/groups/${f.groupId}/actions/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Origin: 'https://untrusted.invalid',
        },
        body: JSON.stringify(command),
      })
    ).json(),
  ).toEqual({ ok: false, error: 'denied' });
  const confirmed = (await (
      await SELF.fetch(`http://127.0.0.1/v1/groups/${f.groupId}/actions/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(command),
      })
    ).json()) as GroupActionResult,
    b = action(confirmed);
  expect(b.humanConfirmation).toMatchObject({
    proposalId: p.proposalId,
    revision: 1,
    operationId: command.operationId,
    confirmedBy: { installationId: bob.installationId },
  });
  await evictDurableObject(f.stub);
  expect(await f.stub.actionsConfirm(envelope)).toEqual(confirmed);
  expect(action(await f.phase(b, 'claim')).state).toBe('dispatching');
  expect(
    await f.membership({ kind: 'revoke', operationId: uuid(), installationId: bob.installationId }),
  ).toMatchObject({ ok: true });
  expect(await f.phase(b, 'claim')).toEqual({ ok: false, error: 'denied' });
  expect((await f.stats()).reserves.find((r) => r.action_id === a.actionId)).toMatchObject({
    released: 1,
  });
});

it('receipt-only original-owner recovery settles exact retained completion after revoke without admitting new effects', async () => {
  const f = await fixture(),
    a = await f.confirm('start', 0);
  action(await f.phase(a, 'claim'));
  const receipt = {
    receiptId: uuid(),
    actionId: a.actionId,
    revision: a.revision,
    owner: f.work.owner,
    effect: 'completed' as const,
    outcome: f.outcome(a),
  };
  expect(
    await f.membership({
      kind: 'revoke',
      operationId: uuid(),
      installationId: f.identity.installationId,
    }),
  ).toMatchObject({ ok: true });
  const envelope = { groupId: f.groupId, credential: f.credential, receipt };
  const settled = (await (
    await SELF.fetch(`http://127.0.0.1/v1/groups/${f.groupId}/actions/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.credential}` },
      body: JSON.stringify(receipt),
    })
  ).json()) as GroupActionResult;
  expect(settled).toMatchObject({
    ok: true,
    value: { action: { state: 'completed', reconciliationReceiptId: receipt.receiptId } },
  });
  await evictDurableObject(f.stub);
  expect(await f.stub.actionsReconcile(envelope)).toEqual(settled);
  expect(
    await f.stub.actionsReconcile({
      ...envelope,
      receipt: { ...receipt, revision: receipt.revision + 1 },
    }),
  ).toEqual({ ok: false, error: 'denied' });
  expect(await f.phase(a, 'claim')).toEqual({ ok: false, error: 'denied' });
  expect(await f.call({ kind: 'instruction', operationId: uuid(), text: 'New work' })).toEqual({
    ok: false,
    error: 'denied',
  });
});

it('legacy unresolved rows receive additive reservations without rewriting immutable events or originals', async () => {
  const f = await fixture(),
    a = await f.confirm('start', 0);
  await runInDurableObject(f.stub, (_instance, state) => {
    // Simulate the preceding release, which retained actions but had no reserve table.
    state.storage.sql
      .exec(
        'UPDATE delivery_control SET logical=logical-?,allocated=allocated-? WHERE singleton=1',
        GROUP_ACTION_LIMITS.lifecycleLogicalReserve,
        GROUP_ACTION_LIMITS.lifecyclePhysicalReserve,
      )
      .toArray();
    state.storage.sql
      .exec('DROP TABLE ga_lifecycle_reservations; DROP TABLE ga_capacity_migration')
      .toArray();
    state.storage.sql
      .exec("DELETE FROM delivery_feature_table_bytes WHERE name='ga_lifecycle_reservations'")
      .toArray();
    state.storage.sql
      .exec(
        'UPDATE delivery_control SET future_physical=future_physical-?',
        GROUP_ACTION_LIMITS.lifecyclePhysicalReserve,
      )
      .toArray();
  });
  await evictDurableObject(f.stub);
  const before = await runInDurableObject(f.stub, (_instance, state) =>
    state.storage.sql.exec('SELECT * FROM ga_events ORDER BY position').toArray(),
  );
  expect(await f.call({ kind: 'board', after: 0, limit: 50 })).toMatchObject({ ok: true });
  expect((await f.stats()).events).toEqual(before);
  expect((await f.stats()).reserves).toMatchObject([{ action_id: a.actionId, released: 0 }]);
  expect(action(await f.phase(a, 'claim')).state).toBe('dispatching');
});
it('pending retained actions require known revocation and exact no-effect proof, never a fabricated completed effect', async () => {
  const f = await fixture(),
    a = await f.confirm('start', 0);
  const receipt = {
    receiptId: uuid(),
    actionId: a.actionId,
    revision: a.revision,
    owner: f.work.owner,
    effect: 'absent' as const,
    outcome: {
      taskId: f.work.taskId,
      workerId: null,
      outcomeId: uuid(),
      status: 'blocked' as const,
      message: 'Original journal proves no effect.',
    },
  };
  const raw = { groupId: f.groupId, credential: f.credential, receipt };
  expect(await f.stub.actionsReconcile(raw)).toEqual({ ok: false, error: 'conflict' });
  expect(
    await f.membership({
      kind: 'revoke',
      operationId: uuid(),
      installationId: f.identity.installationId,
    }),
  ).toMatchObject({ ok: true });
  expect(
    await f.stub.actionsReconcile({
      ...raw,
      receipt: { ...receipt, effect: 'completed', outcome: f.outcome(a) },
    }),
  ).toEqual({ ok: false, error: 'conflict' });
  expect(await f.stub.actionsReconcile(raw)).toMatchObject({
    ok: true,
    value: { action: { state: 'revoked', outcome: { status: 'blocked', workerId: null } } },
  });
});

it('immutable registered aliases and complete content hashes are required for native task authority', async () => {
  const f = await fixture();
  const forged = {
    kind: 'register-work' as const,
    operationId: uuid(),
    taskId: f.task.taskId,
    managerId: f.task.managerId,
    title: f.task.title,
    sharedGoalId: f.task.sharedGoalId,
    origin: { ...f.origin, eventId: uuid() as typeof f.origin.eventId },
  };
  expect(await f.call(forged)).toEqual({ ok: false, error: 'denied' });
  await runInDurableObject(f.stub, (_instance, state) => {
    // Simulate corrupted retained storage; normal writers cannot update originals.
    state.storage.sql.exec('DROP TRIGGER delivery_chunks_no_update').toArray();
    const row = state.storage.sql
      .exec<{
        chunk: string;
      }>(
        'SELECT chunk FROM delivery_chunks WHERE operation_id=?',
        f.owned.envelope.header.operationId,
      )
      .one();
    const chunk = JSON.parse(row.chunk);
    chunk.text = chunk.text.replace('Exact native task', 'Other native task');
    state.storage.sql
      .exec(
        'UPDATE delivery_chunks SET chunk=? WHERE operation_id=?',
        JSON.stringify(chunk),
        f.owned.envelope.header.operationId,
      )
      .toArray();
  });
  expect(await f.call({ ...forged, operationId: uuid(), origin: f.origin })).toEqual({
    ok: false,
    error: 'unavailable',
  });
});
