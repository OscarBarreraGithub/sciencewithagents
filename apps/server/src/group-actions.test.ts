import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  groupActionActorSchema,
  groupActionLifecycleOperationId,
  type GroupActionActor,
  type GroupActionCommand,
  type GroupAction,
  type GroupActionWork,
} from '@dock/shared/dist/group-actions.js';
import {
  GroupActionsAuthority,
  GroupActionsAccessDenied,
  type GroupActionsAuthorityAccess,
  type GroupActionsSql,
} from '@dock/shared/dist/group-actions-authority.js';
import {
  dispatchGroupAction,
  groupCoordinationTools,
  type GroupCoordinationPorts,
  type GroupCoordinationLane,
} from './group-coordination.js';
import { registerGroupActionsRoutes } from './group-actions-routes.js';
import Fastify from 'fastify';
import { groupContextSchema } from '@dock/shared';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});
function setup(file = ':memory:') {
  let db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=1000');
  const groupId = randomUUID(),
    owner = actor(groupId, 'Owner'),
    other = actor(groupId, 'Bob');
  const active = new Set([owner.installationId, other.installationId]);
  const sql: GroupActionsSql = {
    initialize: (s) => db.exec(s),
    rows: <T>(s: string, ...args: (string | number | null)[]) => db.prepare(s).all(...args) as T[],
    transaction: (fn) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const v = fn();
        db.exec('COMMIT');
        return v;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  let authority = new GroupActionsAuthority(sql, groupId);
  const access = (who: GroupActionActor): GroupActionsAuthorityAccess => ({
    authorize: () => {
      if (!active.has(who.installationId)) throw new GroupActionsAccessDenied();
      return who;
    },
    admitMutation: () => {},
    accountStorage: (operation) => operation(),
    membership: (a) => (active.has(a.installationId) ? 'active' : 'revoked'),
    reserveLifecycle: () => {},
    releaseLifecycle: () => {},
    requireHumanConfirmation: (p, c, a) => ({
      receiptId: p.proposalId,
      proposalId: p.proposalId,
      revision: c.expectedRevision,
      operationId: c.operationId,
      confirmedBy: a,
      at: p.at,
    }),
    requireActive: (a) => {
      if (!active.has(a.installationId)) throw new GroupActionsAccessDenied();
    },
    verifyOrigin: () => {
      throw new GroupActionsAccessDenied('Unverified or Question/Idea/private source');
    },
    verifyWorkRegistration: () => {},
  });
  const execute = (c: GroupActionCommand, who = owner) => authority.execute(c, access(who));
  const ok = (c: GroupActionCommand, who = owner) => {
    const r = execute(c, who);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const instruction = (who = owner) => {
    const r = ok(
      {
        kind: 'instruction',
        operationId: randomUUID(),
        text: 'Please start the approved shared task.',
      },
      who,
    );
    if (r.kind !== 'instruction') throw new Error('instruction');
    return { kind: 'instruction' as const, eventId: r.instruction.eventId };
  };
  const r = ok({
    kind: 'register-work',
    operationId: randomUUID(),
    title: 'Investigate shared result',
    taskId: randomUUID(),
    managerId: randomUUID(),
    sharedGoalId: randomUUID() as GroupActionWork['sharedGoalId'],
    origin: instruction(),
  });
  if (r.kind !== 'work') throw new Error('work');
  const work = r.work;
  const propose = (action: 'start' | 'stop', revision: number, who = owner) => {
    const p = ok(
      {
        kind: 'propose',
        operationId: randomUUID(),
        workId: work.workId,
        expectedRevision: revision,
        action,
        origin: instruction(who),
      },
      who,
    );
    if (p.kind !== 'proposal') throw new Error('proposal');
    return p.proposal;
  };
  const confirmed = (kind: 'start' | 'stop', rev: number, who = owner) => {
    const p = propose(kind, rev, who);
    const r = ok(
      {
        kind: 'confirm',
        operationId: randomUUID(),
        proposalId: p.proposalId,
        expectedRevision: rev,
        override: p.overrideRequired,
      },
      who,
    );
    if (r.kind !== 'action') throw new Error('action');
    return r.action;
  };
  cleanups.push(() => db.close());
  return {
    execute,
    ok,
    instruction,
    owner,
    other,
    active,
    work,
    propose,
    confirmed,
    access,
    sql,
    get db() {
      return db;
    },
    restart: () => {
      db.close();
      db = new DatabaseSync(file);
      authority = new GroupActionsAuthority(sql, groupId);
    },
  };
}
function actor(groupId: string, displayName: string) {
  return groupActionActorSchema.parse({
    groupId,
    memberId: randomUUID(),
    installationId: randomUUID(),
    displayName,
  });
}
function action(r: ReturnType<ReturnType<typeof setup>['ok']>) {
  if (r.kind !== 'action') throw new Error('action');
  return r.action;
}
describe('authoritative shared actions', () => {
  it('questions/ideas and forged/private origins never mutate work', () => {
    const s = setup();
    expect(
      s.execute({
        kind: 'propose',
        operationId: randomUUID(),
        workId: s.work.workId,
        expectedRevision: 0,
        action: 'start',
        origin: { kind: 'instruction', eventId: randomUUID() as never },
      }),
    ).toMatchObject({ ok: false, error: 'denied' });
    expect(s.db.prepare('SELECT count(*) AS n FROM ga_actions').get()).toMatchObject({ n: 0 });
    expect(s.execute({ kind: 'Question' } as never)).toMatchObject({ ok: false, error: 'invalid' });
  });
  it('proposal alone has no effect; durable same-ID confirmation and changed payload conflict', () => {
    const s = setup(),
      p = s.propose('start', 0);
    expect(s.db.prepare('SELECT count(*) AS n FROM ga_actions').get()).toMatchObject({ n: 0 });
    const c = {
      kind: 'confirm' as const,
      operationId: randomUUID(),
      proposalId: p.proposalId,
      expectedRevision: 0,
      override: false,
    };
    const a = s.ok(c);
    expect(s.ok(c)).toEqual(a);
    expect(s.execute({ ...c, override: true })).toMatchObject({ ok: false, error: 'conflict' });
  });
  it('racing proposals cannot both confirm against one work revision', () => {
    const s = setup(),
      a = s.propose('start', 0),
      b = s.propose('stop', 0, s.other);
    s.ok({
      kind: 'confirm',
      operationId: randomUUID(),
      proposalId: a.proposalId,
      expectedRevision: 0,
      override: false,
    });
    expect(
      s.execute(
        {
          kind: 'confirm',
          operationId: randomUUID(),
          proposalId: b.proposalId,
          expectedRevision: 0,
          override: false,
        },
        s.other,
      ),
    ).toMatchObject({ ok: false, error: 'stale', current: { revision: 1 } });
  });
  it('override shows competing member/time, requires confirmation, notifies affected member', () => {
    const s = setup();
    s.confirmed('start', 0);
    const p = s.propose('stop', 1, s.other);
    expect(p.overrideRequired).toBe(true);
    expect(p.observed.latest.actor.displayName).toBe('Owner');
    const c = {
      kind: 'confirm' as const,
      operationId: randomUUID(),
      proposalId: p.proposalId,
      expectedRevision: 1,
      override: false,
    };
    expect(s.execute(c, s.other)).toMatchObject({ ok: false, error: 'conflict' });
    const a = action(s.ok({ ...c, override: true }, s.other));
    const b = s.ok({ kind: 'board', after: 0, limit: 50 });
    expect(b.kind === 'board' && b.board.notices[0]).toMatchObject({
      actionId: a.actionId,
      affectedMemberId: s.owner.memberId,
    });
  });
  it('another actor cannot confirm a proposal or borrow the original executor', () => {
    const s = setup(),
      p = s.propose('start', 0);
    expect(
      s.execute(
        {
          kind: 'confirm',
          operationId: randomUUID(),
          proposalId: p.proposalId,
          expectedRevision: 0,
          override: false,
        },
        s.other,
      ),
    ).toMatchObject({ error: 'denied' });
    const a = s.confirmed('start', 0);
    expect(
      s.execute(
        {
          kind: 'claim',
          operationId: groupActionLifecycleOperationId(a.actionId, 'claim'),
          actionId: a.actionId,
        },
        s.other,
      ),
    ).toMatchObject({ error: 'denied' });
  });
  it('fresh owner CAS rejects superseded dispatch and requester revocation even on claim replay', () => {
    const s = setup(),
      a = s.confirmed('start', 0, s.other);
    const c = {
      kind: 'claim' as const,
      operationId: groupActionLifecycleOperationId(a.actionId, 'claim'),
      actionId: a.actionId,
    };
    s.ok(c);
    s.active.delete(s.other.installationId);
    expect(s.execute(c)).toMatchObject({ error: 'denied' });
  });
  it('pending action superseded by a new confirmation never dispatches', () => {
    const s = setup(),
      a = s.confirmed('start', 0);
    s.confirmed('stop', 1, s.other);
    expect(
      s.execute({
        kind: 'claim',
        operationId: groupActionLifecycleOperationId(a.actionId, 'claim'),
        actionId: a.actionId,
      }),
    ).toMatchObject({ error: 'stale' });
  });
  it('uncertain dispatch blocks competing confirmation atomically until reconciled', () => {
    const s = setup(),
      a = s.confirmed('start', 0);
    s.ok({
      kind: 'claim',
      operationId: groupActionLifecycleOperationId(a.actionId, 'claim'),
      actionId: a.actionId,
    });
    s.ok({
      kind: 'uncertain',
      operationId: groupActionLifecycleOperationId(a.actionId, 'uncertain'),
      actionId: a.actionId,
    });
    const p = s.propose('stop', 1, s.other);
    expect(
      s.execute(
        {
          kind: 'confirm',
          operationId: randomUUID(),
          proposalId: p.proposalId,
          expectedRevision: 1,
          override: true,
        },
        s.other,
      ),
    ).toMatchObject({ error: 'conflict' });
    const b = s.ok({ kind: 'board', after: 0, limit: 50 });
    expect(b.kind === 'board' && b.board.works[0].revision).toBe(1);
  });
  it('receipt retry survives restart and immutable causal records cannot be rewritten', () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-actions-'));
    cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
    const s = setup(join(dir, 'db')),
      p = s.propose('start', 0);
    const c = {
      kind: 'confirm' as const,
      operationId: randomUUID(),
      proposalId: p.proposalId,
      expectedRevision: 0,
      override: false,
    };
    const prior = s.ok(c);
    s.restart();
    expect(s.ok(c)).toEqual(prior);
    expect(() => s.db.exec("UPDATE ga_events SET kind='forged'")).toThrow('immutable');
    expect(() => s.db.exec('DELETE FROM ga_instructions')).toThrow('immutable');
  });
  it('failed persistence has no confirmation receipt or effect', () => {
    const s = setup(),
      p = s.propose('start', 0);
    s.db.exec(
      "CREATE TRIGGER fail_actions BEFORE INSERT ON ga_actions BEGIN SELECT RAISE(ABORT,'disk failure'); END;",
    );
    expect(
      s.execute({
        kind: 'confirm',
        operationId: randomUUID(),
        proposalId: p.proposalId,
        expectedRevision: 0,
        override: false,
      }),
    ).toMatchObject({ error: 'unavailable' });
    const b = s.ok({ kind: 'board', after: 0, limit: 50 });
    expect(b.kind === 'board' && b.board.works[0].revision).toBe(0);
  });
});
function dispatchSetup(s: ReturnType<typeof setup>) {
  let jobs = 0,
    loseAck = false;
  const receipts = new Map<string, NonNullable<GroupAction['outcome']>>();
  const lane: GroupCoordinationLane = {
    owner: s.owner,
    inspect: async (id) =>
      receipts.has(id) ? { state: 'completed', outcome: receipts.get(id)! } : { state: 'absent' },
    delegate: async (id) => {
      if (!receipts.has(id)) {
        jobs++;
        receipts.set(id, {
          taskId: s.work.taskId,
          workerId: randomUUID(),
          outcomeId: randomUUID(),
          jobId: randomUUID(),
          gitEventId: randomUUID() as GroupActionWork['sharedGoalId'],
          status: 'started',
          message: 'Normal owned worker admitted',
        });
      }
      if (loseAck) throw new Error('lost ack');
      return receipts.get(id)!;
    },
    pauseWorker: async (id) => {
      if (!receipts.has(id)) {
        jobs++;
        receipts.set(id, {
          taskId: s.work.taskId,
          workerId: randomUUID(),
          outcomeId: randomUUID(),
          status: 'stopped',
          message: 'Owned worker stopped',
        });
      }
      return receipts.get(id)!;
    },
  };
  const ports: GroupCoordinationPorts = {
    command: async (c) => s.execute(c),
    revalidate: async () => {},
    ownerLane: async () => lane,
    normal: {
      createTask: async () => s.work,
      prepareDelegate: async () => s.work,
      workForWorker: async () => s.work,
    },
    resolve: async () => ({
      owner: s.owner,
      work: s.work,
      start: {
        taskId: s.work.taskId,
        role: 'implementer',
        name: 'Shared task worker',
        instruction: 'Use approved shared task resources.',
      },
      stop: { agentId: randomUUID(), reason: 'Confirmed shared stop' },
    }),
  };
  return {
    ports,
    lane,
    get jobs() {
      return jobs;
    },
    loseAck: () => {
      loseAck = true;
    },
  };
}
it('offline original owner stays durable pending; reconnect executes exact owner once', async () => {
  const s = setup(),
    a = s.confirmed('start', 0, s.other),
    d = dispatchSetup(s);
  expect((await dispatchGroupAction(a, { ...d.ports, ownerLane: async () => null })).state).toBe(
    'pending-owner',
  );
  expect(d.jobs).toBe(0);
  const done = await dispatchGroupAction(a, d.ports);
  expect(done.outcome?.taskId).toBe(s.work.taskId);
  expect(done.proposal.origin.eventId).toBe(a.proposal.origin.eventId);
  await dispatchGroupAction(a, d.ports);
  expect(d.jobs).toBe(1);
});
it('crash/lost-ack reconciles existing owned receipt without duplicate job', async () => {
  const s = setup(),
    a = s.confirmed('start', 0),
    d = dispatchSetup(s);
  d.loseAck();
  await expect(dispatchGroupAction(a, d.ports)).rejects.toThrow('lost ack');
  const board = s.ok({ kind: 'board', after: 0, limit: 50 });
  expect(board.kind === 'board' && board.board.actions[0].state).toBe('uncertain');
  expect((await dispatchGroupAction(a, d.ports)).state).toBe('completed');
  expect(d.jobs).toBe(1);
});
it('concurrent retries use exactly one native owner idempotency key', async () => {
  const s = setup(),
    a = s.confirmed('start', 0),
    d = dispatchSetup(s);
  await Promise.all([dispatchGroupAction(a, d.ports), dispatchGroupAction(a, d.ports)]);
  expect(d.jobs).toBe(1);
});
it('alternate member lane is rejected before dispatch', async () => {
  const s = setup(),
    a = s.confirmed('start', 0),
    d = dispatchSetup(s);
  await expect(
    dispatchGroupAction(a, { ...d.ports, ownerLane: async () => ({ ...d.lane, owner: s.other }) }),
  ).rejects.toThrow('Another member');
  expect(d.jobs).toBe(0);
});
it('private native catalog has shared board only; authenticated route denies private mutations and browser execution fields', async () => {
  const s = setup(),
    d = dispatchSetup(s),
    context = groupContextSchema.parse({
      groupId: s.owner.groupId,
      memberId: s.owner.memberId,
      installationId: s.owner.installationId,
      sessionId: randomUUID(),
      visibility: 'private',
      provider: 'codex',
      nativeSessionId: 'fresh',
    });
  expect(
    groupCoordinationTools(context, d.ports, async () => s.instruction()).map((t) => t.name),
  ).toEqual(['dock_inspect']);
  const app = Fastify();
  registerGroupActionsRoutes(
    app,
    {
      confirmHuman: async (_handle, c) => s.execute(c),
      authenticatedContext: async () => ({
        visibility: 'private',
        revalidate: async () => {},
        command: async (c) => s.execute(c),
      }),
    },
    (r) => r.headers.authorization === 'owner',
  );
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/groups/actions',
        payload: { handle: randomUUID(), command: { kind: 'board', after: 0, limit: 50 } },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/groups/actions',
        headers: { authorization: 'owner' },
        payload: {
          handle: randomUUID(),
          command: { kind: 'instruction', operationId: randomUUID(), text: 'private instruction' },
        },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/groups/actions',
        headers: { authorization: 'owner' },
        payload: {
          handle: randomUUID(),
          command: { kind: 'claim', operationId: randomUUID(), actionId: randomUUID() },
        },
      })
    ).statusCode,
  ).toBe(403);
  await app.close();
});

it('same-storage service derives actor from current enrollment and revocation gates receipt replay', async () => {
  const { GroupActionsService } = await import('@dock/shared/dist/group-actions-service.js');
  const s = setup(),
    credential = 'a'.repeat(64);
  s.db.exec(
    'CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,group_id TEXT);CREATE TABLE enrollments(member_id TEXT,installation_id TEXT,display_name TEXT,state TEXT,credential_hash TEXT);',
  );
  s.db.prepare('INSERT INTO metadata VALUES(1,?)').run(s.owner.groupId);
  s.db
    .prepare('INSERT INTO enrollments VALUES(?,?,?,?,?)')
    .run(s.owner.memberId, s.owner.installationId, s.owner.displayName, 'active', 'bound-hash');
  const service = new GroupActionsService(s.owner.groupId, {
    sql: s.sql,
    hostingEnabled: () => true,
    matchesObject: (g) => g === s.owner.groupId,
    credentialHash: async (_, c) => (c === credential ? 'bound-hash' : 'missing'),
    probeDelivery: () => {},
    admitMutation: () => {},
    accountStorage: (operation) => operation(),
    reserveLifecycle: () => {},
    releaseLifecycle: () => {},
    verifyCommittedSource: () => {
      throw new GroupActionsAccessDenied();
    },
    verifyManager: () => {
      throw new GroupActionsAccessDenied();
    },
    verifyOwnedTask: () => {
      throw new GroupActionsAccessDenied();
    },
  });
  const command = {
    kind: 'instruction' as const,
    operationId: randomUUID(),
    text: 'Shared instruction attributable to authenticated enrollment.',
  };
  const raw = { groupId: s.owner.groupId, credential, command };
  const first = await service.execute(raw);
  expect(first).toMatchObject({
    ok: true,
    value: {
      kind: 'instruction',
      instruction: {
        actor: { memberId: s.owner.memberId, installationId: s.owner.installationId },
      },
    },
  });
  expect(await service.execute({ ...raw, credential: 'b'.repeat(64) })).toMatchObject({
    error: 'denied',
  });
  expect(await service.execute({ ...raw, groupId: randomUUID() })).toMatchObject({
    error: 'denied',
  });
  s.db
    .prepare("UPDATE enrollments SET state='revoked' WHERE installation_id=?")
    .run(s.owner.installationId);
  expect(await service.execute(raw)).toMatchObject({ error: 'denied' });
  expect(await service.execute({ ...raw, actor: s.other })).toMatchObject({ error: 'invalid' });
});
it('authenticated owner and paired confirmation use the protected proof lane and reject browser-supplied proof fields', async () => {
  const app = Fastify(),
    s = setup(),
    p = s.propose('start', 0);
  let humanCalls = 0,
    commandCalls = 0;
  registerGroupActionsRoutes(
    app,
    {
      authenticatedContext: async () => ({
        visibility: 'shared',
        revalidate: async () => {},
        command: async (c) => {
          commandCalls++;
          return s.execute(c);
        },
      }),
      confirmHuman: async (_handle, c) => {
        humanCalls++;
        return s.execute(c);
      },
    },
    (request) => ['owner', 'paired'].includes(String(request.headers.authorization)),
  );
  const handle = randomUUID(),
    command = {
      kind: 'confirm',
      operationId: randomUUID(),
      proposalId: p.proposalId,
      expectedRevision: 0,
      override: false,
    };
  for (const authorization of ['owner', 'paired']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/groups/actions',
      headers: { authorization },
      payload: { handle, command },
    });
    expect(response.json()).toMatchObject({ ok: true, value: { kind: 'action' } });
  }
  expect(humanCalls).toBe(2);
  expect(commandCalls).toBe(0);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/groups/actions',
        headers: { authorization: 'owner' },
        payload: { handle, command: { ...command, humanConfirmationId: randomUUID() } },
      })
    ).statusCode,
  ).toBe(400);
  expect(humanCalls).toBe(2);
  await app.close();
});
it('normal native tool adapter reuses typed task/worker ports with stable causal keys', async () => {
  const s = setup(),
    d = dispatchSetup(s),
    keys: string[] = [];
  const origin = s.instruction();
  const context = groupContextSchema.parse({
    groupId: s.owner.groupId,
    memberId: s.owner.memberId,
    installationId: s.owner.installationId,
    sessionId: randomUUID(),
    visibility: 'shared',
    provider: 'codex',
    nativeSessionId: 'fresh-shared',
  });
  const ports = {
    ...d.ports,
    normal: {
      ...d.ports.normal,
      prepareDelegate: async (key: string) => {
        keys.push(key);
        return s.work;
      },
      workForWorker: async () => ({ ...s.work, owner: s.other }),
    },
  };
  const tools = groupCoordinationTools(context, ports, async () => origin);
  expect(tools.map((t) => t.name)).toEqual([
    'dock_inspect',
    'dock_task_create',
    'dock_delegate',
    'dock_pause_worker',
    'dock_propose_action',
    'dock_confirm_action',
  ]);
  const delegate = tools.find((t) => t.name === 'dock_delegate')!,
    input = {
      taskId: s.work.taskId,
      role: 'implementer',
      name: 'Shared worker',
      instruction: 'Approved scoped task instruction',
    };
  const invocation = {
    sessionId: 'native',
    requestId: 'native-tool-id',
    signal: new AbortController().signal,
  };
  const first = await delegate.invoke(input, invocation);
  expect(await delegate.invoke(input, invocation)).toEqual(first);
  expect(keys[0]).toBe(keys[1]);
  expect(d.jobs).toBe(0);
  await expect(delegate.invoke({ ...input, executable: '/bin/sh' }, invocation)).rejects.toThrow();
  const foreign = {
    ...ports,
    normal: {
      ...ports.normal,
      workForWorker: async () => ({ ...s.work, owner: actor(randomUUID(), 'Foreign') }),
    },
  };
  await expect(
    groupCoordinationTools(context, foreign, async () => origin)
      .find((t) => t.name === 'dock_pause_worker')!
      .invoke({ agentId: randomUUID(), reason: 'stop' }, invocation),
  ).rejects.toThrow('outside this group');
});
it('autonomous proposals preserve manager/shared-goal origin and original owner under verified source authority', () => {
  const s = setup();
  const origin = {
    kind: 'autonomous' as const,
    eventId: randomUUID() as GroupActionWork['sharedGoalId'],
    sharedGoalId: s.work.sharedGoalId,
    managerId: s.work.managerId,
  };
  const access: GroupActionsAuthorityAccess = {
    ...s.access(s.owner),
    authorize: () => s.owner,
    requireActive: () => {},
    admitMutation: () => {},
    verifyWorkRegistration: () => {},
    verifyOrigin: (o, _, w) => {
      if (
        o.kind !== 'autonomous' ||
        o.sharedGoalId !== w?.sharedGoalId ||
        o.managerId !== w?.managerId
      )
        throw new GroupActionsAccessDenied();
    },
  };
  const authority = new GroupActionsAuthority(s.sql, s.owner.groupId);
  const p = authority.execute(
    {
      kind: 'propose',
      operationId: randomUUID(),
      workId: s.work.workId,
      expectedRevision: 0,
      action: 'start',
      origin,
    },
    access,
  );
  expect(p).toMatchObject({
    ok: true,
    value: {
      proposal: {
        origin,
        observed: {
          owner: s.owner,
          sharedGoalId: s.work.sharedGoalId,
          taskId: s.work.taskId,
          managerId: s.work.managerId,
        },
      },
    },
  });
  const evidence = s.ok({ kind: 'evidence', after: 0, limit: 25 });
  if (evidence.kind !== 'evidence') throw new Error('evidence');
  const source = evidence.records.at(-1)!;
  expect(source).toMatchObject({
    kind: 'proposal',
    instructionEventId: null,
    autonomousEventId: origin.eventId,
    facts: {
      autonomous: true,
      instructionIds: [],
      originalIds: {
        instructionEventId: null,
        sharedGoalId: s.work.sharedGoalId,
        managerId: s.work.managerId,
        taskId: s.work.taskId,
      },
    },
  });
  expect(JSON.parse(source.originalJson).origin).toEqual(origin);
});
it('asynchronous or repeated trusted accounting hooks roll back all mutation and receipt writes', () => {
  const s = setup(),
    authority = new GroupActionsAuthority(s.sql, s.owner.groupId);
  const before = s.sql.rows('SELECT * FROM ga_events ORDER BY position');
  const command = {
    kind: 'instruction' as const,
    operationId: randomUUID(),
    text: 'Must roll back.',
  };
  const asyncAccounting = <T>(operation: () => T): T => Promise.resolve(operation()) as T;
  expect(
    authority.execute(command, { ...s.access(s.owner), accountStorage: asyncAccounting }),
  ).toEqual({ ok: false, error: 'unavailable' });
  expect(s.sql.rows('SELECT * FROM ga_events ORDER BY position')).toEqual(before);
  expect(
    authority.execute(command, {
      ...s.access(s.owner),
      accountStorage: <T>(operation: () => T) => {
        operation();
        return operation();
      },
    }),
  ).toEqual({ ok: false, error: 'unavailable' });
  expect(s.sql.rows('SELECT * FROM ga_events ORDER BY position')).toEqual(before);
});
it('bounded immutable causal evidence retains exact instruction text and action/task/worker outcome links', async () => {
  const s = setup(),
    exact = '  Start the shared work.\nPreserve my original spacing.  ';
  const original = s.ok({ kind: 'instruction', operationId: randomUUID(), text: exact });
  expect(original.kind === 'instruction' && original.instruction.text).toBe(exact);
  const a = s.confirmed('start', 0),
    d = dispatchSetup(s);
  await dispatchGroupAction(a, d.ports);
  const page = s.ok({ kind: 'evidence', after: 0, limit: 2 });
  expect(page.kind === 'evidence' && page.continuation).not.toBeNull();
  const all = s.ok({ kind: 'evidence', after: 0, limit: 25 });
  if (all.kind !== 'evidence') throw new Error('evidence');
  const completion = all.records.find((r) => r.kind === 'completed')!;
  expect(completion).toMatchObject({
    instructionEventId: a.proposal.origin.eventId,
    proposalId: a.proposal.proposalId,
    actionId: a.actionId,
    taskId: s.work.taskId,
    managerId: s.work.managerId,
    sharedGoalId: s.work.sharedGoalId,
  });
  expect(completion.workerId).not.toBeNull();
  expect(completion.outcomeId).not.toBeNull();
  expect(completion.jobId).not.toBeNull();
  expect(completion.gitEventId).not.toBeNull();
  const replay = s.ok({ kind: 'evidence', after: 0, limit: 25 });
  expect(replay).toEqual(all);
});
it('exact authenticated work read reaches beyond fifty snapshot rows and reflects current revisions', () => {
  const f = setup(),
    target = { ...f.work, workId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', revision: 9 };
  for (let i = 0; i < 71; i++) {
    const work = { ...f.work, workId: randomUUID() };
    f.sql.rows('INSERT INTO ga_work(work_id,body) VALUES(?,?)', work.workId, JSON.stringify(work));
  }
  f.sql.rows(
    'INSERT INTO ga_work(work_id,body) VALUES(?,?)',
    target.workId,
    JSON.stringify(target),
  );
  const board = f.ok({ kind: 'board', after: 0, limit: 50 });
  expect(board.kind === 'board' && board.board.works).toHaveLength(50);
  expect(board.kind === 'board' && board.board.works.some((w) => w.workId === target.workId)).toBe(
    false,
  );
  const authority = new GroupActionsAuthority(f.sql, f.owner.groupId);
  const result = authority.execute(
    { kind: 'work', workId: target.workId },
    {
      ...f.access(f.owner),
      authorize: () => f.owner,
      admitMutation: () => {
        throw new Error('Read must not require mutation admission');
      },
      requireActive: () => {},
      verifyOrigin: () => {
        throw new Error('Unused');
      },
      verifyWorkRegistration: () => {
        throw new Error('Unused');
      },
    },
  );
  expect(result).toEqual({ ok: true, value: { kind: 'work', work: target } });
  f.active.delete(f.owner.installationId);
  expect(f.execute({ kind: 'work', workId: target.workId })).toEqual({
    ok: false,
    error: 'denied',
  });
});
