import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GroupPromotionEvidenceIndex } from './group-promotion-evidence.js';
import { GroupPromotionDoHandler } from '../../group-service/src/group-promotion.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { groupScopeSchema, type GroupContext, type GroupScope } from '@dock/shared';
import {
  groupPromotionSourceSchema,
  type GroupPromotionCommand,
  type GroupPromotionSource,
} from '@dock/shared/dist/group-promotion.js';
import {
  GroupPromotionAuthority,
  type GroupPromotionSql,
  type GroupPromotionActor,
} from '@dock/shared/dist/group-promotion-authority.js';
import { GroupEventRepository } from './group-events.js';
import { GroupPublicationController } from './group-publication.js';
import {
  publicationCanonical,
  publicationHash,
  type PublicationBinding,
} from './group-publication-protocol.js';
import {
  GroupPromotionController,
  groupPromotionHumanDecision,
  type GroupPromotionPorts,
  type GroupPromotionOutcome,
} from './group-promotion.js';
import {
  GroupPromotionSourceHandlers,
  type GroupPromotionSourceReaders,
} from './group-promotion-sources.js';

let directory: string, authorityDb: DatabaseSync, repo: GroupEventRepository;
let authority: GroupPromotionAuthority,
  controller: GroupPromotionController,
  publication: GroupPublicationController;
let member: ReturnType<GroupEventRepository['createGroup']>,
  shared: GroupContext,
  privateContext: GroupContext;
let actor: GroupPromotionActor, now: number, active: boolean, capacity: boolean, offline: boolean;
let registered: Map<string, string>, ports: GroupPromotionPorts, enqueueCount: number;
const sqlPort = (db: DatabaseSync): GroupPromotionSql => ({
  rows<T extends Record<string, string | number | null>>(
    query: string,
    ...args: (string | number | null)[]
  ): T[] {
    if (query.includes('CREATE TABLE')) {
      db.exec(query);
      return [];
    }
    return db.prepare(query).all(...args) as T[];
  },
  transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
});
const makeAuthority = (db = authorityDb) =>
  new GroupPromotionAuthority(sqlPort(db), {
    authorize(a, i) {
      if (
        !active ||
        a.groupId !== actor.groupId ||
        registered.get(publicationCanonical(i.key)) !== i.sourceHash
      )
        throw new Error('Denied source receipt');
    },
    authorizeWriter(a, w) {
      if (!active || a.groupId !== actor.groupId || w !== actor.installationId)
        throw new Error('Denied designation');
    },
    checkCapacity() {
      if (!capacity) throw new Error('Storage capacity');
    },
    authorizeDisposition() {
      throw new Error('No disposition approval');
    },
    verifyPublished() {
      throw new Error('No hosted commit receipt');
    },
    now: () => now,
    id: randomUUID,
  });
const scope = (context = shared): GroupScope =>
  groupScopeSchema.parse({
    groupId: context.groupId,
    memberId: context.memberId,
    installationId: context.installationId,
    visibility: context.visibility,
    source: {
      sessionId: context.sessionId,
      provider: context.provider,
      nativeSessionId: context.nativeSessionId,
      messageId: randomUUID(),
    },
    causalRefs: [],
  });
const source = (changes: Partial<GroupPromotionSource> = {}): GroupPromotionSource =>
  groupPromotionSourceSchema.parse({
    key: { groupId: actor.groupId, sourceId: randomUUID(), version: '1' },
    writerId: actor.installationId,
    scope: scope(),
    projectionScope: scope(),
    kind: 'human',
    activity: 'substantive',
    contentMode: 'shared-content',
    original: { kind: 'inline', text: 'Should we add a control group?' },
    evidenceRefs: [],
    correction: null,
    decision: null,
    synthesisAuthorized: false,
    ...changes,
  });
const register = (s: GroupPromotionSource) => {
  registered.set(publicationCanonical(s.key), publicationHash(publicationCanonical(s)));
  return s;
};
const promote = (s: GroupPromotionSource) => controller.promote(async () => s);
const assertPromoted = (result: GroupPromotionOutcome) => {
  if (result.state !== 'promoted') throw new Error(JSON.stringify(result));
  return result;
};
const count = (table: string) =>
  (authorityDb.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
const outboxCount = () => {
  const db = new DatabaseSync(join(directory, 'outbox.sqlite'), { readOnly: true });
  try {
    return (db.prepare('SELECT count(*) n FROM gp_operations').get() as { n: number }).n;
  } finally {
    db.close();
  }
};
const openPublication = () => {
  const binding: PublicationBinding = {
    groupId: member.groupId,
    installationId: member.installationId,
    epoch: randomUUID(),
    remoteGroupId: actor.groupId,
    endpointId: randomUUID(),
    credentialRevision: 1,
  };
  // Binding is saved once, reused on restart.
  return binding;
};
let binding: PublicationBinding;
let index: GroupPromotionEvidenceIndex;
beforeEach(() => {
  mkdirSync(resolve('data/group-promotion-tests'), { recursive: true });
  directory = mkdtempSync(resolve('data/group-promotion-tests/case-'));
  repo = new GroupEventRepository(join(directory, 'events.sqlite'));
  member = repo.createGroup('Alice');
  const { displayName: _name, ...identity } = member;
  shared = repo.createContext({
    ...identity,
    visibility: 'shared',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  privateContext = repo.createContext({
    ...identity,
    visibility: 'private',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  actor = { groupId: member.groupId, installationId: member.installationId };
  now = 1000;
  active = true;
  capacity = true;
  offline = false;
  registered = new Map();
  enqueueCount = 0;
  authorityDb = new DatabaseSync(join(directory, 'authority.sqlite'));
  authority = makeAuthority();
  authority.designate(actor, actor.installationId);
  binding = openPublication();
  publication = new GroupPublicationController(join(directory, 'outbox.sqlite'), repo, {
    receipt: async () => {
      throw new Error('offline');
    },
    effect: async () => {
      throw new Error('offline');
    },
  });
  ports = {
    command: async (c) => {
      if (offline) throw new Error('offline');
      return authority.handle(actor, c);
    },
    enqueue: async (s, id) => {
      enqueueCount++;
      const access = repo.trustedHostScope(s);
      const grant = publication.trustedHostRegister(binding, () => ({ access, binding }));
      const operationId = publication.enqueue(grant, [id]).operations[0];
      return { operationId, state: 'pending' };
    },
  };
  index = new GroupPromotionEvidenceIndex(join(directory, 'evidence.sqlite'), repo);
  controller = new GroupPromotionController(repo, ports, index);
});
afterEach(() => {
  publication.close();
  index.close();
  repo.close();
  authorityDb.close();
  rmSync(directory, { recursive: true, force: true });
});

it.each([
  ['Question', 'Should we add a control group?'],
  ['Idea', 'I suggest adding a placebo arm.'],
  ['Decision', 'We decided to use a blinded design.'],
  ['Instruction', 'Please rerun the analysis with the corrected labels.'],
  ['Conflict', 'Conflict: two instructions select different reference datasets.'],
  ['Blocker', 'We cannot proceed until the shared dataset is available.'],
  ['Finding', 'Result: the treatment reduced variance by 12 percent.'],
  ['Action', 'Job 123 completed after processing all 24 samples.'],
] as const)('promotes substance as %s without truncation', async (category, text) => {
  const s = register(source({ original: { kind: 'inline', text } }));
  const result = assertPromoted(await promote(s));
  expect(result.event.category).toBe(category);
  expect(result.event.condensedText).toBe(text);
  expect(repo.expand(repo.trustedHostScope(s.scope), result.event.eventId).original).toBe(text);
  expect(result.event.scope.causalRefs).toEqual([]);
  expect(outboxCount()).toBe(1);
});

it('does not pretend an arbitrary prefix or ambiguous message is a summary', async () => {
  for (const text of [
    'An unclassified assertion.',
    'Please run X. Why was Y stopped?',
    `Should we ${'consider '.repeat(180)}the experiment?`,
  ]) {
    const s = register(source({ original: { kind: 'inline', text } }));
    expect(await promote(s)).toEqual({ state: 'needs-summary' });
  }
  expect(count('group_promotion_receipts')).toBe(0);
  expect(outboxCount()).toBe(0);
});

it('filters private/unrelated/metadata/tool noise before reading content or creating receipts', async () => {
  const canary = 'PRIVATE-CANARY-DO-NOT-READ';
  for (const changes of [
    { scope: scope(privateContext) },
    { contentMode: 'metadata-only' },
    { contentMode: 'private' },
    { activity: 'tool-line' },
    { activity: 'progress' },
    { activity: 'heartbeat' },
    { activity: 'metadata' },
  ]) {
    const raw = { ...source(), ...changes };
    Object.defineProperty(raw, 'original', {
      get() {
        throw new Error(canary);
      },
    });
    expect(await controller.promote(async () => raw)).toEqual({ state: 'suppressed' });
  }
  expect(
    await promote(register(source({ original: { kind: 'inline', text: 'Thanks!' } }))),
  ).toEqual({ state: 'suppressed' });
  const other = repo.createGroup('Other');
  const ctx = repo.createContext({
    groupId: other.groupId,
    memberId: other.memberId,
    installationId: other.installationId,
    visibility: 'shared',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  const s = source();
  s.scope.groupId = ctx.groupId;
  await expect(promote(s)).rejects.toThrow();
  expect(count('group_promotion_receipts')).toBe(0);
  expect(count('group_promotion_transitions')).toBe(0);
  expect(enqueueCount).toBe(0);
});

it('has one authority receipt and one durable outbox event on duplicate, racing controllers and restart', async () => {
  const s = register(source());
  const secondDb = new DatabaseSync(join(directory, 'authority.sqlite'));
  const secondAuthority = makeAuthority(secondDb);
  const competitor = new GroupPromotionController(
    repo,
    {
      ...ports,
      command: async (c) => secondAuthority.handle(actor, c),
    },
    index,
  );
  const both = await Promise.all([promote(s), competitor.promote(async () => s)]);
  expect(assertPromoted(both[0]).event.eventId).toBe(assertPromoted(both[1]).event.eventId);
  secondDb.close();
  const id = assertPromoted(both[0]).event.eventId;
  publication.close();
  index.close();
  repo.close();
  authorityDb.close();
  repo = new GroupEventRepository(join(directory, 'events.sqlite'));
  authorityDb = new DatabaseSync(join(directory, 'authority.sqlite'));
  authority = makeAuthority();
  publication = new GroupPublicationController(join(directory, 'outbox.sqlite'), repo, {
    receipt: async () => {
      throw new Error('offline');
    },
    effect: async () => {
      throw new Error('offline');
    },
  });
  index = new GroupPromotionEvidenceIndex(join(directory, 'evidence.sqlite'), repo);
  controller = new GroupPromotionController(repo, ports, index);
  expect(assertPromoted(await promote(s)).event.eventId).toBe(id);
  expect(count('group_promotion_receipts')).toBe(1);
  expect(count('group_promotion_transitions')).toBe(3);
  expect(outboxCount()).toBe(1);
});

it('refuses another installation, expired writer and unauthorized designation without summarization', async () => {
  const s = register(source());
  let wakes = 0;
  const alternate = {
    ...actor,
    installationId: repo.addMember(member.groupId, 'Bob').installationId,
  };
  const competitor = new GroupPromotionController(
    repo,
    {
      ...ports,
      command: async (c) => authority.handle(alternate, c),
      synthesis: {
        submit: async () => {
          wakes++;
          return { state: 'pending' };
        },
        inspect: async () => {
          wakes++;
          return { state: 'pending' };
        },
      },
    },
    index,
  );
  expect(await competitor.promote(async () => s)).toEqual({
    state: 'unavailable',
    reason: 'not_writer',
  });
  now += 60_001;
  expect(await promote(s)).toEqual({ state: 'unavailable', reason: 'writer_unavailable' });
  expect(() => authority.designate(alternate, alternate.installationId)).toThrow();
  authority.designate(actor, actor.installationId);
  expect((await promote(s)).state).toBe('promoted');
  expect(wakes).toBe(0);
});

it('reconciles offline/lost remote acknowledgement without another source receipt', async () => {
  const s = register(source());
  offline = true;
  expect(await promote(s)).toEqual({ state: 'offline' });
  expect(count('group_promotion_receipts')).toBe(0);
  offline = false;
  let lose = true;
  ports.command = async (c) => {
    const reply = authority.handle(actor, c);
    if (c.kind === 'bindEvent' && lose) {
      lose = false;
      throw new Error('lost acknowledgement');
    }
    return reply;
  };
  expect(await promote(s)).toEqual({ state: 'offline' });
  expect(outboxCount()).toBe(0);
  const r = assertPromoted(await promote(s));
  expect(r.receipt.eventId).toBe(r.event.eventId);
  expect(count('group_promotion_receipts')).toBe(1);
  expect(outboxCount()).toBe(1);
});

it('recovers a publication enqueue failure after binding the event', async () => {
  const s = register(source());
  const enqueue = ports.enqueue;
  let fail = true;
  ports.enqueue = async (sc, id) => {
    if (fail) {
      fail = false;
      throw new Error('Disk unavailable');
    }
    return await enqueue(sc, id);
  };
  await expect(promote(s)).rejects.toThrow('Disk unavailable');
  expect(assertPromoted(await promote(s)).event.sequence).toBe(1);
  expect(outboxCount()).toBe(1);
});

it('appends exact large chunks, verified causal/evidence links and a correction without rewriting', async () => {
  const first = register(source());
  const original = assertPromoted(await promote(first));
  const chunks = [' Exact 🧬\n'.repeat(1000), '第二章 e\u0301\n'.repeat(900)];
  const next = source({
    kind: 'worker',
    original: { kind: 'chunked', chunks },
    evidenceRefs: [original.event.eventId],
    decision: {
      category: 'Finding',
      sentences: [
        'The worker found a mislabeled control; the corrected labels change the variance estimate.',
      ],
      evidenceRefs: [original.event.eventId],
    },
    correction: { eventId: original.event.eventId, entityId: original.event.entityId, revision: 1 },
  });
  next.scope.causalRefs = [original.event.eventId];
  next.projectionScope.causalRefs = [original.event.eventId];
  register(next);
  const fixed = assertPromoted(await promote(next));
  expect(fixed.event.corrects).toBe(original.event.eventId);
  expect(fixed.event.revision).toBe(2);
  expect(repo.expand(repo.trustedHostScope(next.scope), fixed.event.eventId).original).toBe(
    chunks.join(''),
  );
  expect(fixed.evidence.causalRefs).toEqual([original.event.eventId]);
  expect(fixed.evidence.evidenceRefs).toEqual([original.event.eventId]);
  expect(repo.expand(repo.trustedHostScope(first.scope), original.event.eventId).original).toBe(
    'Should we add a control group?',
  );
});

it('denies private/cross-group/fabricated evidence before receipt, and never invents causality', async () => {
  const privateScope = scope(privateContext);
  const privateEvent = repo.append(repo.trustedHostScope(privateScope), {
    operationId: randomUUID() as never,
    entityId: randomUUID() as never,
    expectedRevision: 0,
    category: 'Finding',
    condensedText: 'Private canary',
    original: { kind: 'inline', text: 'PRIVATE EVIDENCE CANARY' },
    evidenceRefs: [],
    corrects: null,
  }).event;
  const s = register(source({ evidenceRefs: [privateEvent.eventId] }));
  await expect(promote(s)).rejects.toThrow();
  expect(count('group_promotion_receipts')).toBe(0);
  const fabricated = register(
    source({
      decision: {
        category: 'Decision',
        sentences: ['The group chose a control arm.'],
        evidenceRefs: [privateEvent.eventId],
      },
    }),
  );
  await expect(promote(fabricated)).rejects.toThrow('source-authorized');
  expect(count('group_promotion_receipts')).toBe(0);
  const ok = assertPromoted(await promote(register(source())));
  expect(ok.evidence.causalRefs).toEqual([]);
});

it('uses at most one admitted synthesis submit under race and read-only same-ID recovery', async () => {
  const s = register(
    source({
      kind: 'native',
      original: { kind: 'inline', text: 'Long detailed interpretation of the experiment.' },
      synthesisAuthorized: true,
    }),
  );
  let submits = 0,
    inspects = 0;
  let completed = false;
  let synthesisId = '';
  ports.synthesis = {
    submit: async (req) => {
      submits++;
      synthesisId = req.synthesisId;
      expect(req.evidence).toEqual([]);
      expect(req.source.original).toEqual(s.original);
      throw new Error('Uncertain admitted turn');
    },
    inspect: async (id, identity) => {
      inspects++;
      expect(id).toBe(synthesisId);
      return completed
        ? {
            state: 'completed',
            identity,
            decision: {
              category: 'Finding',
              sentences: [
                'The experiment identifies a control-label mismatch that needs correction.',
              ],
              evidenceRefs: [],
            },
          }
        : { state: 'unknown' };
    },
  };
  const race = await Promise.all([promote(s), promote(s)]);
  expect(race.map((v) => v.state)).toEqual(['unknown', 'unknown']);
  authorityDb.close();
  authorityDb = new DatabaseSync(join(directory, 'authority.sqlite'));
  authority = makeAuthority();
  completed = true;
  expect((await promote(s)).state).toBe('promoted');
  expect(submits).toBe(1);
  expect(inspects).toBe(2);
  expect(outboxCount()).toBe(1);
});

it('holds uncertain synthesis launch intent after lost acknowledgement and prevents writer transfer', async () => {
  const s = register(source({ kind: 'native', synthesisAuthorized: true }));
  let launches = 0;
  ports.synthesis = {
    submit: async () => {
      launches++;
      return { state: 'pending' };
    },
    inspect: async () => ({ state: 'unknown' }),
  };
  let lose = true;
  ports.command = async (c) => {
    const reply = authority.handle(actor, c);
    if (c.kind === 'startSynthesis' && lose) {
      lose = false;
      throw new Error('lost');
    }
    return reply;
  };
  expect(await promote(s)).toEqual({ state: 'offline' });
  expect(await promote(s)).toEqual({ state: 'unknown' });
  expect(launches).toBe(0);
  const other = repo.addMember(member.groupId, 'Bob').installationId;
  const permissive = new GroupPromotionAuthority(sqlPort(authorityDb), {
    authorize: () => {},
    authorizeWriter: () => {},
    checkCapacity: () => {},
    authorizeDisposition() {
      throw new Error('No disposition approval');
    },
    verifyPublished() {
      throw new Error('No hosted commit receipt');
    },
    now: () => now,
    id: randomUUID,
  });
  expect(() => permissive.designate(actor, other)).toThrow('Unfinished promotion');
});

it('excludes unapproved synthesis, oversized context and revoked sources without launch or receipt', async () => {
  let launches = 0;
  ports.synthesis = {
    submit: async () => {
      launches++;
      return { state: 'pending' };
    },
    inspect: async () => {
      launches++;
      return { state: 'pending' };
    },
  };
  expect(await promote(register(source({ kind: 'native' })))).toEqual({ state: 'needs-summary' });
  expect(
    await promote(
      register(
        source({
          kind: 'native',
          synthesisAuthorized: true,
          original: { kind: 'chunked', chunks: ['a'.repeat(16_384), 'b'.repeat(16_384), 'c'] },
        }),
      ),
    ),
  ).toEqual({ state: 'needs-summary' });
  active = false;
  expect(await promote(register(source()))).toEqual({ state: 'offline' });
  expect(count('group_promotion_receipts')).toBe(0);
  expect(launches).toBe(0);
});

it('rejects receipt collisions, source changes and capacity failures atomically', async () => {
  const s = register(source());
  await promote(s);
  const key = s.key;
  const changed = source({
    ...s,
    key,
    original: { kind: 'inline', text: 'Should we use the opposite control?' },
  });
  register(changed);
  expect(await promote(changed)).toEqual({ state: 'unavailable', reason: 'collision' });
  const fresh = register(source());
  capacity = false;
  expect(await promote(fresh)).toEqual({ state: 'offline' });
  expect(count('group_promotion_receipts')).toBe(1);
  expect(count('group_promotion_transitions')).toBe(3);
});

it('requires each concrete producer handler to read its matching durable source receipt', async () => {
  const names = {
    humanSend: 'human',
    nativeResult: 'native',
    managerAction: 'manager',
    workerResult: 'worker',
    quarkTransition: 'quark',
    fileChange: 'file',
    jobTransition: 'job',
  } as const;
  const readers = {} as GroupPromotionSourceReaders;
  const receipts = new Map<string, GroupPromotionSource>();
  for (const [name, kind] of Object.entries(names)) {
    const s = register(
      source({
        kind,
        decision: {
          category: kind === 'job' ? 'Action' : 'Finding',
          sentences: [
            kind === 'job'
              ? 'Job 123 completed all samples.'
              : 'The shared work identified a concrete labeling error.',
          ],
          evidenceRefs: [],
        },
      }),
    );
    receipts.set(name, s);
    readers[name as keyof GroupPromotionSourceReaders] = async (id) => {
      expect(id).toBe(name);
      return receipts.get(id);
    };
  }
  const handlers = new GroupPromotionSourceHandlers(controller, readers);
  for (const name of Object.keys(names) as (keyof typeof names)[])
    expect((await handlers[name](name)).state).toBe('promoted');
  readers.nativeResult = async () => receipts.get('humanSend');
  await expect(handlers.nativeResult('wrong')).rejects.toThrow('kind mismatch');
  expect(count('group_promotion_receipts')).toBe(7);
});

it('validates summary sentences without permitting oversized/truncated text or mutable decisions', () => {
  expect(groupPromotionHumanDecision('First statement. Second. Third.')).toBeNull();
  const s = register(source());
  const identity = { key: s.key, sourceHash: publicationHash(publicationCanonical(s)) };
  const cmd: GroupPromotionCommand = { kind: 'reserve', identity };
  authority.handle(actor, cmd);
  const first = {
    category: 'Decision' as const,
    sentences: ['The group chose a blinded control.'],
    evidenceRefs: [],
  };
  authority.handle(actor, { kind: 'decide', identity, decision: first });
  expect(
    authority.handle(actor, {
      kind: 'decide',
      identity,
      decision: { ...first, sentences: ['The group chose the opposite control.'] },
    }),
  ).toEqual({ kind: 'unavailable', reason: 'collision' });
  expect(() =>
    authorityDb.prepare('UPDATE group_promotion_transitions SET kind=?').run('rewritten'),
  ).toThrow('immutable');
});

it('retains original author separately from the designated writer and serves authorized durable evidence after restart', async () => {
  const bob = repo.addMember(member.groupId, 'Bob');
  const bobContext = repo.createContext({
    groupId: member.groupId,
    memberId: bob.memberId,
    installationId: bob.installationId,
    visibility: 'shared',
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
  const s = register(
    source({
      scope: scope(bobContext),
      kind: 'worker',
      decision: {
        category: 'Finding',
        sentences: [
          'Bob’s worker found the mislabeled control and reported the corrected analysis.',
        ],
        evidenceRefs: [],
      },
    }),
  );
  const result = assertPromoted(await promote(s));
  expect(result.event.scope.memberId).toBe(member.memberId);
  expect(result.evidence.scope.memberId).toBe(bob.memberId);
  index.close();
  index = new GroupPromotionEvidenceIndex(join(directory, 'evidence.sqlite'), repo);
  expect(
    index.records(repo.trustedHostScope(scope(privateContext)), [result.event.eventId]),
  ).toEqual([result.evidence]);
  repo.revokeMember(member.groupId, bob.memberId);
  await expect(promote(s)).rejects.toThrow();
  const other = repo.createGroup('Other');
  const c = repo.createContext({
    groupId: other.groupId,
    memberId: other.memberId,
    installationId: other.installationId,
    visibility: 'shared',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  expect(() => index.records(repo.trustedHostScope(scope(c)), [result.event.eventId])).toThrow();
});

it('uses the concrete same-DO adapter with authorization and capacity inside the synchronous transaction', () => {
  const s = register(source());
  const identity = { key: s.key, sourceHash: publicationHash(publicationCanonical(s)) };
  let inTransaction = false,
    verified = false;
  const base = sqlPort(authorityDb);
  const handler = new GroupPromotionDoHandler(
    {
      sql: {
        exec(query, ...args) {
          return { toArray: () => base.rows(query, ...args) };
        },
      },
      transactionSync(work) {
        return base.transaction(() => {
          inTransaction = true;
          try {
            return work();
          } finally {
            inTransaction = false;
          }
        });
      },
    },
    {
      authorize(a, i) {
        expect(inTransaction).toBe(true);
        if (a.installationId !== actor.installationId || i.sourceHash !== identity.sourceHash)
          throw new Error('Denied');
        verified = true;
      },
      authorizeWriter() {
        expect(inTransaction).toBe(true);
      },
      checkCapacity() {
        expect(inTransaction).toBe(true);
      },
      authorizeDisposition() {
        throw new Error('No disposition approval');
      },
      verifyPublished() {
        throw new Error('No hosted commit');
      },
      now: () => now,
      id: randomUUID,
    },
  );
  expect(handler.command(actor, { kind: 'reserve', identity }).kind).toBe('receipt');
  expect(verified).toBe(true);
  expect(() =>
    handler.command(
      { ...actor, installationId: randomUUID() as never },
      { kind: 'reserve', identity },
    ),
  ).toThrow('Denied');
  expect(count('group_promotion_receipts')).toBe(1);
});

it('proves one global reserve across simultaneous Node processes and competing installation identities', async () => {
  const s = register(source());
  const identity = { key: s.key, sourceHash: publicationHash(publicationCanonical(s)) };
  const run = (installationId: string) =>
    new Promise<unknown>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('./group-promotion-race.fixture.ts', import.meta.url)),
          join(directory, 'authority.sqlite'),
          actor.groupId,
          installationId,
          JSON.stringify(identity),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '',
        err = '';
      child.stdout.on('data', (data) => {
        out += String(data);
      });
      child.stderr.on('data', (data) => {
        err += String(data);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error(err));
        else {
          try {
            resolve(JSON.parse(out));
          } catch (e) {
            reject(e);
          }
        }
      });
    });
  const writer = await Promise.all([run(actor.installationId), run(actor.installationId)]);
  const receipts = writer as { kind: string; receipt: { operationId: string } }[];
  expect(receipts[0].kind).toBe('receipt');
  expect(receipts[0].receipt.operationId).toBe(receipts[1].receipt.operationId);
  const competitors = await Promise.all([run(actor.installationId), run(randomUUID())]);
  expect(competitors[1]).toEqual({ kind: 'unavailable', reason: 'not_writer' });
  expect(count('group_promotion_receipts')).toBe(1);
}, 15_000);

it('requires an authoritative committed publication before releasing the writer and keeps identity immutable', async () => {
  const s = register(source());
  const r = assertPromoted(await promote(s));
  expect(r.receipt.publicationOperationId).toBeNull();
  const other = repo.addMember(member.groupId, 'Bob').installationId;
  const permissive = new GroupPromotionAuthority(sqlPort(authorityDb), {
    authorize: () => {},
    authorizeWriter: () => {},
    checkCapacity: () => {},
    authorizeDisposition() {
      throw new Error('No disposition approval');
    },
    verifyPublished: () => {
      throw new Error('No committed delivery');
    },
    now: () => now,
    id: randomUUID,
  });
  expect(() => permissive.designate(actor, other)).toThrow('Unfinished');
  expect(() =>
    permissive.handle(actor, {
      kind: 'published',
      identity: r.receipt.identity,
      eventId: r.event.eventId,
      publicationOperationId: randomUUID(),
    }),
  ).toThrow('No committed delivery');
  expect(() =>
    authorityDb.prepare('UPDATE group_promotion_receipts SET source_hash=?').run('0'.repeat(64)),
  ).toThrow('immutable');
});

it('requires explicit evidenced disposition for an unlaunched/stale source and retains its original receipt', async () => {
  const s = register(source());
  const identity = { key: s.key, sourceHash: publicationHash(publicationCanonical(s)) };
  authority.handle(actor, { kind: 'reserve', identity });
  const disposition = { reason: 'verified-not-launched' as const, operationId: randomUUID() };
  expect(() => authority.handle(actor, { kind: 'dispose', identity, disposition })).toThrow(
    'No disposition approval',
  );
  const managerAuthority = new GroupPromotionAuthority(sqlPort(authorityDb), {
    authorize: () => {},
    authorizeWriter: () => {},
    checkCapacity: () => {},
    verifyPublished: () => {
      throw new Error('No hosted commit');
    },
    authorizeDisposition(a, i, d) {
      expect(a).toEqual(actor);
      expect(i).toEqual(identity);
      expect(d).toEqual(disposition);
    },
    now: () => now,
    id: randomUUID,
  });
  const terminal = managerAuthority.handle(actor, { kind: 'dispose', identity, disposition });
  expect(terminal.kind).toBe('receipt');
  expect(await promote(s)).toEqual({ state: 'unavailable', reason: 'verified-not-launched' });
  expect(count('group_promotion_receipts')).toBe(1);
  expect(outboxCount()).toBe(0);
  expect(managerAuthority.handle(actor, { kind: 'startSynthesis', identity })).toEqual({
    kind: 'unavailable',
    reason: 'denied',
  });
  managerAuthority.designate(actor, repo.addMember(member.groupId, 'Bob').installationId);
});

it('bounds retained global source/version receipts without evicting old evidence', () => {
  for (let i = 0; i < 512; i++) {
    const s = register(source());
    const identity = { key: s.key, sourceHash: publicationHash(publicationCanonical(s)) };
    expect(authority.handle(actor, { kind: 'reserve', identity }).kind).toBe('receipt');
  }
  const extra = register(source());
  const identity = { key: extra.key, sourceHash: publicationHash(publicationCanonical(extra)) };
  expect(authority.handle(actor, { kind: 'reserve', identity })).toEqual({
    kind: 'unavailable',
    reason: 'limit',
  });
  expect(count('group_promotion_receipts')).toBe(512);
  expect(count('group_promotion_transitions')).toBe(512);
});

it('bounds a nonresponsive authenticated receipt transport without launching or dropping source identity', async () => {
  const s = register(source());
  ports.command = async () => new Promise<never>(() => {});
  vi.useFakeTimers();
  try {
    const pending = promote(s);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toEqual({ state: 'offline' });
    expect(count('group_promotion_receipts')).toBe(0);
    expect(outboxCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
