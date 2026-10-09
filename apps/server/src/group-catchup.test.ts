import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  groupEntityIdSchema,
  groupOperationIdSchema,
  type GroupContext,
  type GroupEvent,
  type GroupScope,
} from '@dock/shared';
import {
  groupEvidenceQuerySchema,
  GROUP_EVIDENCE_LIMITS,
  type GroupEvidenceFacts,
} from '@dock/shared/dist/group-evidence.js';
import { groupCatchupAckRequestSchema } from '@dock/shared/dist/group-catchup.js';
import { GroupEventRepository } from './group-events.js';
import { GroupCatchupStore } from './group-catchup.js';
import { GroupEvidenceIndex } from './group-evidence.js';
import { registerGroupCatchupRoutes } from './group-catchup-routes.js';
import { createGroupPrivateEvidenceQuery } from './group-evidence-private.js';
import { createGroupSharedEvidenceQuery } from './group-evidence-shared.js';
import { createGroupEvidenceOriginal } from './group-evidence-original.js';
import type { GroupCatchupReader } from './group-catchup-context.js';

let dir: string, repo: GroupEventRepository, store: GroupCatchupStore, index: GroupEvidenceIndex;
let alice: ReturnType<GroupEventRepository['createGroup']>,
  bob: ReturnType<GroupEventRepository['addMember']>;
let shared: GroupContext, aside: GroupContext, bobAside: GroupContext, other: GroupContext;
let reader: GroupCatchupReader, privateReader: GroupCatchupReader;
let facts: Map<string, GroupEvidenceFacts>;
const context = (member: typeof alice, visibility: 'private' | 'shared') =>
  repo.createContext({
    groupId: member.groupId,
    memberId: member.memberId,
    installationId: member.installationId,
    visibility,
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
const scope = (ctx: GroupContext, refs: GroupEvent['eventId'][] = []): GroupScope => ({
  groupId: ctx.groupId,
  memberId: ctx.memberId,
  installationId: ctx.installationId,
  visibility: ctx.visibility,
  source: {
    sessionId: ctx.sessionId,
    provider: ctx.provider,
    nativeSessionId: ctx.nativeSessionId,
    messageId: randomUUID(),
  },
  causalRefs: refs,
});
const makeReader = (ctx: GroupContext): GroupCatchupReader => ({
  context: ctx,
  enrollmentHandle: ctx.installationId,
  revalidate: async () => {
    repo.trustedHostScope(scope(ctx));
  },
  readShared: async (q) => repo.feed(repo.trustedHostScope(scope(ctx)), q),
  original: async (id) => {
    const value = repo.expand(repo.trustedHostScope(scope(ctx)), id);
    if (value.event.scope.visibility !== 'shared') throw new Error('Private evidence unavailable');
    return { eventId: value.event.eventId, text: value.original };
  },
});
const append = (
  category: GroupEvent['category'] = 'Finding',
  ctx = shared,
  refs: GroupEvent['eventId'][] = [],
  entityId = groupEntityIdSchema.parse(randomUUID()),
  revision = 0,
) =>
  repo.append(repo.trustedHostScope(scope(ctx, refs)), {
    operationId: groupOperationIdSchema.parse(randomUUID()),
    entityId,
    expectedRevision: revision,
    category,
    condensedText: `Substantive ${category} ${revision}`,
    original: {
      kind: 'inline',
      text: `  Exact original ${category}\nKeep whitespace 🧬\t${revision}`,
    },
    evidenceRefs: [],
    corrects: null,
  }).event;
const sourceFacts = (
  event: GroupEvent,
  extra: Partial<GroupEvidenceFacts> = {},
): GroupEvidenceFacts => ({
  sourceId: event.scope.source.messageId,
  sourceVersion: 1,
  kinds: ['finding'],
  subjectIds: [event.entityId],
  paths: [],
  instructionIds: [],
  originalIds: { taskId: event.entityId },
  edges: [],
  autonomous: null,
  unresolved: null,
  ...extra,
});
const newIndex = () =>
  new GroupEvidenceIndex(join(dir, 'index.sqlite'), {
    readVerifiedShared: async (r, id) => {
      const event = repo.expand(repo.trustedHostScope(scope(r.context)), id).event;
      return { event, facts: facts.get(id) ?? null };
    },
  });
const acknowledge = (p: Awaited<ReturnType<GroupCatchupStore['start']>>, r = reader) =>
  store.acknowledge(r, p.snapshotId, p.pageId, p.acknowledgementId);

it('escaped shared evidence pages stay byte-bounded and resume the exact snapshot after restart', async () => {
  for (let i = 0; i < 8; i++) {
    const event = append();
    facts.set(
      event.eventId,
      sourceFacts(event, {
        paths: Array.from({ length: 16 }, (_, p) => `file-${p}/` + '\u0001'.repeat(500)),
      }),
    );
  }
  const input = {
    queryId: randomUUID(),
    query: { type: 'offline_changes' as const },
    limit: 8,
    continuation: null as string | null,
  };
  let query = createGroupSharedEvidenceQuery({ resolve: async () => reader, evidence: index });
  const first = await query(input);
  expect(first.records.length).toBeGreaterThan(0);
  expect(first.records.length).toBeLessThan(8);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
    GROUP_EVIDENCE_LIMITS.pageBytes,
  );
  expect(first.continuation).not.toBeNull();
  expect(await query(input)).toEqual(first);
  index.close();
  index = newIndex();
  query = createGroupSharedEvidenceQuery({ resolve: async () => reader, evidence: index });
  const ids = first.records.map((record) => record.event.eventId);
  let cursor = first.continuation;
  while (cursor) {
    const next = await query({ ...input, continuation: cursor });
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(
      GROUP_EVIDENCE_LIMITS.pageBytes,
    );
    ids.push(...next.records.map((record) => record.event.eventId));
    cursor = next.continuation;
  }
  expect(ids.length).toBe(8);
  expect(new Set(ids).size).toBe(8);
});

it('shared native evidence indexes bounded authenticated originals and advances only its own completed offline query', async () => {
  const original = Array.from({ length: 19 }, () => append());
  append('Finding', aside); // Never included in the shared source/index.
  const query = createGroupSharedEvidenceQuery({ resolve: async () => reader, evidence: index });
  const input = {
    queryId: randomUUID(),
    query: { type: 'offline_changes' as const },
    limit: 8,
    continuation: null as string | null,
  };
  const first = await query(input);
  expect(first.records.map((r) => r.event.eventId)).toEqual(
    original.slice(0, 8).map((e) => e.eventId),
  );
  expect(first.watermark).toBe(16);
  expect(first.unknown.join(' ')).toContain('incomplete beyond position 16');
  expect(await index.sharedAcknowledged(reader)).toBe(0);
  expect(await query(input)).toEqual(first);
  input.continuation = first.continuation;
  const second = await query(input);
  expect(second.records.map((r) => r.event.eventId)).toEqual(
    original.slice(8, 16).map((e) => e.eventId),
  );
  expect(second.continuation).toBeNull();
  expect(await index.sharedAcknowledged(reader)).toBe(16);
  expect(await store.acknowledged(privateReader)).toBe(0);
  expect(await index.sharedAcknowledged(makeReader(bobAside))).toBe(0);
  index.close();
  index = newIndex();
  const restored = createGroupSharedEvidenceQuery({ resolve: async () => reader, evidence: index });
  expect(await restored(input)).toEqual(second);
  const third = await restored({ ...input, queryId: randomUUID(), continuation: null });
  expect(third.records.map((r) => r.event.eventId)).toEqual(
    original.slice(16).map((e) => e.eventId),
  );
  expect(await index.sharedAcknowledged(reader)).toBe(19);
  await expect(
    createGroupSharedEvidenceQuery({ resolve: async () => privateReader, evidence: index })({
      ...input,
      queryId: randomUUID(),
      continuation: null,
    }),
  ).rejects.toThrow('shared Group manager');
  repo.revokeMember(alice.groupId, alice.memberId);
  await expect(restored(input)).rejects.toThrow();
});
it('shared refresh retries a failed page and enriches late facts without rewriting an earlier pinned query', async () => {
  const events = Array.from({ length: 3 }, () => append());
  const read = index.source!.readVerifiedShared.bind(index.source);
  let fail = true;
  vi.spyOn(index.source!, 'readVerifiedShared').mockImplementation(async (scope, id) => {
    if (id === events[1]!.eventId && fail) {
      fail = false;
      throw new Error('offline');
    }
    return read(scope, id);
  });
  const query = createGroupSharedEvidenceQuery({ resolve: async () => reader, evidence: index });
  const input = {
    queryId: randomUUID(),
    query: { type: 'who_decided' as const, eventId: events[0]!.eventId },
    limit: 8,
    continuation: null,
  };
  await expect(query(input)).rejects.toThrow('offline');
  const pinned = await query(input);
  expect(pinned.watermark).toBe(3);
  expect(pinned.records[0]!.facts).toBeNull();
  facts.set(events[0]!.eventId, sourceFacts(events[0]!));
  expect(await query(input)).toEqual(pinned);
  const enriched = await query({ ...input, queryId: randomUUID() });
  expect(enriched.records[0]!.facts).toEqual(sourceFacts(events[0]!));
  expect(await query(input)).toEqual(pinned);
});
it('native original expansion preserves exact text and refuses private bodies and invalid offsets', async () => {
  const event = append(),
    privateEvent = append('Finding', aside);
  const tool = createGroupEvidenceOriginal(async () => reader);
  const original = await reader.original(event.eventId);
  let offset = 0,
    collected = '',
    hash: string | undefined;
  do {
    const page = await tool({ eventId: event.eventId, offset, limit: 3 });
    collected += page.text;
    if (hash) expect(page.sha256).toBe(hash);
    hash = page.sha256;
    if (page.nextOffset === null) break;
    expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset;
  } while (true);
  expect(collected).toBe(original.text);
  await expect(tool({ eventId: privateEvent.eventId, offset: 0, limit: 12000 })).rejects.toThrow();
  await expect(
    tool({ eventId: event.eventId, offset: original.text.length + 1, limit: 3 }),
  ).rejects.toThrow('offset');
  repo.revokeMember(alice.groupId, alice.memberId);
  await expect(tool({ eventId: event.eventId, offset: 0, limit: 12000 })).rejects.toThrow();
});
beforeEach(() => {
  mkdirSync(resolve('data/group-catchup-tests'), { recursive: true });
  dir = mkdtempSync(resolve('data/group-catchup-tests/case-'));
  repo = new GroupEventRepository(join(dir, 'events.sqlite'));
  alice = repo.createGroup('Alice');
  bob = repo.addMember(alice.groupId, 'Bob');
  shared = context(alice, 'shared');
  aside = context(alice, 'private');
  bobAside = context({ ...bob, groupId: alice.groupId }, 'private');
  other = context(repo.createGroup('Other'), 'private');
  reader = makeReader(shared);
  privateReader = makeReader(aside);
  facts = new Map();
  store = new GroupCatchupStore(join(dir, 'catchup.sqlite'));
  index = newIndex();
});
afterEach(() => {
  index.close();
  store.close();
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

it('reads more than three pages with exact fixed snapshot across restart, appends, explicit ack and lost ack retries', async () => {
  const events = Array.from({ length: 37 }, () => append());
  const first = await store.start(reader);
  expect(first.entries).toHaveLength(8);
  expect(await store.acknowledged(reader)).toBe(0);
  expect(await store.start(privateReader)).toEqual(first);
  await expect(store.page(reader, first.snapshotId, first.continuation!)).rejects.toThrow(
    'preceding page',
  );
  const ack = await acknowledge(first);
  expect(ack.through).toBe(8);
  expect(await acknowledge(first)).toEqual(ack);
  append('Decision');
  append('Action');
  append('Question', bobAside);
  append('Finding', other);
  store.close();
  store = new GroupCatchupStore(join(dir, 'catchup.sqlite'));
  expect(await acknowledge(first)).toEqual(ack);
  let page = await store.start(reader);
  const seen = [...first.entries];
  while (true) {
    expect(page.watermark).toBe(37);
    seen.push(...page.entries);
    const receipt = await acknowledge(page);
    expect(await acknowledge(page)).toEqual(receipt);
    if (!page.continuation) break;
    const token = page.continuation;
    page = await store.page(reader, page.snapshotId, token);
    expect(await store.page(reader, page.snapshotId, token)).toEqual(page);
  }
  expect(seen.map((e) => e.eventId)).toEqual(events.map((e) => e.eventId));
  expect(await store.acknowledged(reader)).toBe(37);
  const newer = await store.start(reader);
  expect(newer.after).toBe(37);
  expect(newer.entries.map((e) => e.category)).toEqual(['Decision', 'Action']);
  expect(newer.watermark).toBe(39);
  await expect(store.page(reader, first.snapshotId, first.continuation!)).rejects.toThrow('stale');
});
it('rejects gaps, missing tail/continuation, wrong watermark and never advances on fetched pages', async () => {
  Array.from({ length: 20 }, () => append());
  const gap = {
    ...reader,
    readShared: async (q: Parameters<GroupCatchupReader['readShared']>[0]) => {
      const p = await reader.readShared(q);
      return { ...p, entries: p.entries.filter((_, i) => i !== 2) };
    },
  };
  await expect(store.start(gap)).rejects.toThrow();
  expect(await store.acknowledged(reader)).toBe(0);
  const page = await store.start(reader);
  await acknowledge(page);
  const changed = {
    ...reader,
    readShared: async (q: Parameters<GroupCatchupReader['readShared']>[0]) => {
      const p = await reader.readShared(q);
      return {
        ...p,
        watermark: p.watermark + 1,
        continuation: p.continuation ? { ...p.continuation, watermark: p.watermark + 1 } : null,
      };
    },
  };
  await expect(store.page(changed, page.snapshotId, page.continuation!)).rejects.toThrow(
    'Snapshot',
  );
  expect(await store.acknowledged(reader)).toBe(8);
});
it('fails closed on forged/cross-member/group/enrollment tokens, stale continuation and revoked replay', async () => {
  Array.from({ length: 20 }, () => append());
  const p = await store.start(reader);
  for (const r of [
    makeReader(bobAside),
    makeReader(other),
    { ...reader, enrollmentHandle: randomUUID() },
  ]) {
    await expect(store.acknowledge(r, p.snapshotId, p.pageId, p.acknowledgementId)).rejects.toThrow(
      'bound',
    );
    await expect(store.page(r, p.snapshotId, p.continuation!)).rejects.toThrow('bound');
  }
  await expect(store.acknowledge(reader, p.snapshotId, p.pageId, randomUUID())).rejects.toThrow(
    'identity',
  );
  await expect(
    store.acknowledge(reader, p.snapshotId, randomUUID(), p.acknowledgementId),
  ).rejects.toThrow('delivered');
  await acknowledge(p);
  const second = await store.page(reader, p.snapshotId, p.continuation!);
  await acknowledge(second);
  await expect(store.page(reader, p.snapshotId, p.continuation!)).rejects.toThrow('stale');
  repo.revokeMember(alice.groupId, alice.memberId);
  await expect(acknowledge(p)).rejects.toThrow('membership');
  await expect(store.start(reader)).rejects.toThrow('membership');
});
it('two store connections race safely and offline next-page failures retain the exact snapshot and page identity', async () => {
  Array.from({ length: 35 }, () => append());
  const secondStore = new GroupCatchupStore(join(dir, 'catchup.sqlite'));
  try {
    const starts = await Promise.allSettled([store.start(reader), secondStore.start(reader)]);
    expect(starts.some((s) => s.status === 'fulfilled')).toBe(true);
    const p = await store.start(reader);
    expect(await secondStore.start(reader)).toEqual(p);
    await Promise.all([
      acknowledge(p),
      secondStore.acknowledge(reader, p.snapshotId, p.pageId, p.acknowledgementId),
    ]);
    const offline = {
      ...reader,
      readShared: async () => {
        throw new Error('offline');
      },
    };
    await expect(store.page(offline, p.snapshotId, p.continuation!)).rejects.toThrow('offline');
    const next = await store.start(reader);
    expect(next.snapshotId).toBe(p.snapshotId);
    expect(next.after).toBe(8);
    expect(await secondStore.start(reader)).toEqual(next);
  } finally {
    secondStore.close();
  }
});
it('bounded evidence pages cite exact original source IDs/edges, keep snapshot and aside identity across restart', async () => {
  const instruction = append('Instruction');
  facts.set(instruction.eventId, sourceFacts(instruction, { kinds: ['instruction'] }));
  await index.ingestVerifiedShared(reader, instruction.eventId);
  const actions = Array.from({ length: 29 }, () => append('Action', shared, [instruction.eventId]));
  for (const e of actions) {
    facts.set(
      e.eventId,
      sourceFacts(e, {
        sourceId: `group-action:${alice.groupId}:${e.sequence}`,
        kinds: ['action'],
        instructionIds: [instruction.eventId],
        originalIds: { taskId: e.entityId, instructionEventId: instruction.eventId },
        edges: [{ fromId: instruction.eventId, toId: e.entityId, relation: 'instruction' }],
      }),
    );
    await index.ingestVerifiedShared(reader, e.eventId);
  }
  const queryId = randomUUID();
  const q = { type: 'instruction_actions' as const, instructionEventId: instruction.eventId };
  let p = await index.query(privateReader, q, 8, null, store, queryId);
  expect(p.records[0].facts?.sourceId).toBe(`group-action:${alice.groupId}:2`);
  expect(p.records[0].event.scope.causalRefs).toEqual([instruction.eventId]);
  const token = p.continuation!;
  const snapshot = p.watermark;
  append('Action');
  index.close();
  index = newIndex();
  expect(await index.query(privateReader, q, 8, null, store, queryId)).toMatchObject({
    watermark: snapshot,
    continuation: token,
  });
  await expect(index.query(makeReader(bobAside), q, 8, token, store, queryId)).rejects.toThrow(
    'aside',
  );
  await expect(index.query(reader, q, 8, token, store, queryId)).rejects.toThrow('aside');
  await expect(
    index.query(privateReader, { type: 'unresolved' }, 8, token, store, queryId),
  ).rejects.toThrow('query');
  const seen = [...p.records];
  while (p.continuation) {
    p = await index.query(privateReader, q, 8, p.continuation, store, queryId);
    expect(p.watermark).toBe(snapshot);
    seen.push(...p.records);
  }
  expect(seen.map((r) => r.event.eventId)).toEqual(actions.map((e) => e.eventId));
  expect(JSON.stringify(seen)).not.toContain('PRIVATE');
});
it('queries typed responsibility/files/jobs/conflicts/unresolved/autonomous facts and indexed original decision IDs', async () => {
  const responsibility = append('Action');
  facts.set(
    responsibility.eventId,
    sourceFacts(responsibility, {
      kinds: ['responsibility', 'job'],
      subjectIds: [bob.memberId],
      originalIds: { memberId: bob.memberId, taskId: responsibility.entityId },
    }),
  );
  const file = append('Finding');
  facts.set(file.eventId, sourceFacts(file, { kinds: ['file'], paths: ['src/river.ts'] }));
  const blocked = append('Blocker');
  facts.set(
    blocked.eventId,
    sourceFacts(blocked, { kinds: ['blocker', 'conflict', 'unresolved'], unresolved: true }),
  );
  const decision = append('Decision');
  facts.set(
    decision.eventId,
    sourceFacts(decision, {
      kinds: ['decision'],
      autonomous: true,
      originalIds: { managerId: randomUUID() },
    }),
  );
  for (const e of [responsibility, file, blocked, decision])
    await index.ingestVerifiedShared(reader, e.eventId);
  for (const [query, id] of [
    [{ type: 'who_working', memberId: bob.memberId }, responsibility.eventId],
    [{ type: 'file_changes', path: 'src/river.ts' }, file.eventId],
    [{ type: 'why_stopped', subjectId: blocked.entityId }, blocked.eventId],
    [{ type: 'who_decided', eventId: decision.eventId }, decision.eventId],
    [{ type: 'unresolved' }, blocked.eventId],
    [{ type: 'autonomous_decisions' }, decision.eventId],
  ] as const) {
    expect(
      (await index.query(privateReader, query, 8, null, store, randomUUID())).records.map(
        (r) => r.event.eventId,
      ),
    ).toEqual([id]);
    expect(index.queryPlan(query).every((line) => !/^SCAN (t|e|f|newer)/.test(line))).toBe(true);
  }
  const closed = append('Finding', shared, [], blocked.entityId, 1);
  facts.set(closed.eventId, sourceFacts(closed, { unresolved: false }));
  await index.ingestVerifiedShared(reader, closed.eventId);
  expect(
    (await index.query(privateReader, { type: 'unresolved' }, 8, null, store, randomUUID()))
      .records,
  ).toEqual([]);
});
it('marks index gaps/unknown facts explicitly, rejects fabricated facts/private/cross-group sources and bounds', async () => {
  const a = append(),
    b = append();
  await index.observePage(reader, [b]);
  const partial = await index.query(
    privateReader,
    { type: 'offline_changes' },
    8,
    null,
    store,
    randomUUID(),
  );
  expect(partial.watermark).toBe(0);
  expect(partial.unknown.join(' ')).toContain('incomplete');
  expect(partial.records).toEqual([]);
  await index.observePage(reader, [a]);
  expect(
    (await index.query(privateReader, { type: 'offline_changes' }, 8, null, store, randomUUID()))
      .records,
  ).toHaveLength(2);
  const privateEvent = append('Question', aside);
  await expect(index.observePage(reader, [privateEvent])).rejects.toThrow('shared page');
  await expect(index.observePage(reader, [append('Question', other)])).rejects.toThrow(
    'shared page',
  );
  facts.set(a.eventId, sourceFacts(a, { instructionIds: [randomUUID()] }));
  await expect(index.ingestVerifiedShared(reader, a.eventId)).rejects.toThrow('absent');
  await expect(
    index.query(privateReader, { type: 'offline_changes' }, 9, null, store, randomUUID()),
  ).rejects.toThrow('between');
  await expect(
    index.query(privateReader, { type: 'offline_changes' }, 8, randomUUID(), store, randomUUID()),
  ).rejects.toThrow('continuation');
  expect(
    groupEvidenceQuerySchema.safeParse({ type: 'search', text: 'private canary' }).success,
  ).toBe(false);
  expect(
    groupCatchupAckRequestSchema.safeParse({
      handle: randomUUID(),
      memberId: bob.memberId,
      snapshotId: randomUUID(),
      pageId: randomUUID(),
      acknowledgementId: randomUUID(),
    }).success,
  ).toBe(false);
});
it('private native handler reads only authorized shared evidence without publication or shared-session execution', async () => {
  const e = append('Decision');
  await index.observePage(reader, [e]);
  append('Question', aside);
  append('Question', bobAside);
  append('Question', other);
  const tool = createGroupPrivateEvidenceQuery({
    resolve: async () => privateReader,
    evidence: index,
    catchup: store,
  });
  const before = repo.feed(repo.trustedHostScope(scope(shared)), {
    visibility: 'shared',
    limit: 8,
    after: 0,
    cursor: null,
  });
  const result = await tool({
    queryId: randomUUID(),
    query: { type: 'offline_changes' },
    limit: 8,
    continuation: null,
  });
  expect(result.records.map((r) => r.event.eventId)).toEqual([e.eventId]);
  expect(
    repo.feed(repo.trustedHostScope(scope(shared)), {
      visibility: 'shared',
      limit: 8,
      after: 0,
      cursor: null,
    }),
  ).toEqual(before);
  await expect(
    createGroupPrivateEvidenceQuery({
      resolve: async () => reader,
      evidence: index,
      catchup: store,
    })({ queryId: randomUUID(), query: { type: 'unresolved' }, limit: 8, continuation: null }),
  ).rejects.toThrow('Private');
  repo.revokeMember(alice.groupId, alice.memberId);
  await expect(
    tool({ queryId: randomUUID(), query: { type: 'unresolved' }, limit: 8, continuation: null }),
  ).rejects.toThrow('membership');
});
it('guarded concrete routes refuse member-selected identity and require authentication; original reads are shared-only', async () => {
  const e = append('Decision');
  append('Question', aside);
  const app = Fastify();
  registerGroupCatchupRoutes(app, {
    authenticated: (r) => r.headers.authorization === 'local-test',
    resolve: async (handle) => {
      if (handle !== aside.sessionId) throw new Error('unknown handle');
      return privateReader;
    },
    catchup: store,
    evidence: index,
  });
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/groups/catchup/start',
          payload: { handle: aside.sessionId },
        })
      ).statusCode,
    ).toBe(401);
    const headers = { authorization: 'local-test' };
    const start = await app.inject({
      method: 'POST',
      url: '/api/groups/catchup/start',
      headers,
      payload: { handle: aside.sessionId },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().entries.map((v: GroupEvent) => v.eventId)).toEqual([e.eventId]);
    expect(await store.acknowledged(reader)).toBe(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/groups/evidence/query',
          headers,
          payload: {
            handle: aside.sessionId,
            memberId: bob.memberId,
            queryId: randomUUID(),
            query: { type: 'unresolved' },
            limit: 8,
            continuation: null,
          },
        })
      ).statusCode,
    ).toBe(400);
    const original = await app.inject({
      method: 'POST',
      url: '/api/groups/evidence/original',
      headers,
      payload: { handle: aside.sessionId, eventId: e.eventId },
    });
    expect(original.statusCode).toBe(200);
    expect(original.headers['cache-control']).toBe('no-store');
    expect(original.json().text).toContain('Exact original');
  } finally {
    await app.close();
  }
});
it('saved source index is immutable and queries use bounded covering indexes without full-history scans', async () => {
  const e = append();
  await index.observePage(reader, [e]);
  const sql = new DatabaseSync(join(dir, 'index.sqlite'));
  try {
    expect(() => sql.prepare('UPDATE gqe_events SET event_json=?').run('{}')).toThrow('immutable');
    expect(() => sql.prepare('DELETE FROM gqe_events').run()).toThrow('immutable');
  } finally {
    sql.close();
  }
  for (const q of [
    { type: 'offline_changes' },
    { type: 'unresolved' },
    { type: 'autonomous_decisions' },
    { type: 'file_changes', path: 'x' },
    { type: 'why_stopped', subjectId: 'x' },
    { type: 'who_working', memberId: bob.memberId },
    { type: 'who_decided', eventId: e.eventId },
  ] as const) {
    const plan = index.queryPlan(q);
    expect(plan.some((s) => s.includes('SEARCH t USING'))).toBe(true);
    expect(plan.some((s) => s.includes('SCAN e') || s.includes('SCAN t'))).toBe(false);
  }
});
it('query request identity pins index revision so late facts and new source ingests cannot alter a saved snapshot', async () => {
  const events = Array.from({ length: 20 }, () => append('Finding'));
  for (let i = 0; i < events.length; i += 8)
    await index.observePage(reader, events.slice(i, i + 8));
  const queryId = randomUUID();
  const initial = await index.query(
    privateReader,
    { type: 'offline_changes' },
    8,
    null,
    store,
    queryId,
  );
  const fileQueryId = randomUUID();
  const noFiles = await index.query(
    privateReader,
    { type: 'file_changes', path: 'late.ts' },
    8,
    null,
    store,
    fileQueryId,
  );
  expect(noFiles.records).toEqual([]);
  for (const e of events) {
    facts.set(e.eventId, sourceFacts(e, { kinds: ['file'], paths: ['late.ts'] }));
    await index.ingestVerifiedShared(reader, e.eventId);
  }
  expect(
    await index.query(privateReader, { type: 'offline_changes' }, 8, null, store, queryId),
  ).toEqual(initial);
  const next = await index.query(
    privateReader,
    { type: 'offline_changes' },
    8,
    initial.continuation,
    store,
    queryId,
  );
  expect(next.records.every((r) => r.facts === null)).toBe(true);
  expect(
    await index.query(
      privateReader,
      { type: 'file_changes', path: 'late.ts' },
      8,
      null,
      store,
      fileQueryId,
    ),
  ).toEqual(noFiles);
  expect(
    (
      await index.query(
        privateReader,
        { type: 'file_changes', path: 'late.ts' },
        8,
        null,
        store,
        randomUUID(),
      )
    ).records,
  ).toHaveLength(8);
  await expect(
    index.query(privateReader, { type: 'unresolved' }, 8, null, store, queryId),
  ).rejects.toThrow('changed parameters');
  await expect(
    index.query(
      privateReader,
      { type: 'offline_changes' },
      8,
      initial.continuation,
      store,
      randomUUID(),
    ),
  ).rejects.toThrow('continuation');
});
it('empty refresh keeps the same snapshot identity; acknowledgement and offline queries preserve member last-read after restart', async () => {
  const empty = await store.start(reader);
  expect(await store.start(reader)).toEqual(empty);
  for (let i = 0; i < 3; i++) append('Decision');
  const p = await store.start(reader);
  await index.observePage(reader, p.entries);
  await acknowledge(p);
  store.close();
  store = new GroupCatchupStore(join(dir, 'catchup.sqlite'));
  expect(await store.acknowledged(privateReader)).toBe(3);
  const q = await index.query(
    privateReader,
    { type: 'offline_changes' },
    8,
    null,
    store,
    randomUUID(),
  );
  expect(q.records).toEqual([]);
  const emptyNext = await store.start(reader);
  expect(emptyNext.after).toBe(3);
  expect(await store.start(reader)).toEqual(emptyNext);
});
