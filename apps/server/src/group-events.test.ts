import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  GROUP_LIMITS,
  groupAppendSchema,
  groupContextSchema,
  groupDisplayNameSchema,
  groupEntityIdSchema,
  groupOperationIdSchema,
  groupPayloadSchema,
  groupScopeSchema,
  type GroupAppend,
  type GroupContext,
  type GroupScope,
} from '@dock/shared';
import { GROUP_EVENT_SQL, GroupEventRepository, type GroupAccess } from './group-events.js';

let directory: string, path: string, repo: GroupEventRepository;
let alice: ReturnType<GroupEventRepository['createGroup']>;
let bob: ReturnType<GroupEventRepository['addMember']>;
let other: ReturnType<GroupEventRepository['createGroup']>;
let shared: GroupContext,
  privateA: GroupContext,
  sharedB: GroupContext,
  privateB: GroupContext,
  alien: GroupContext;
const context = (member: typeof alice, visibility: 'shared' | 'private') =>
  repo.createContext({
    groupId: member.groupId,
    memberId: member.memberId,
    installationId: member.installationId,
    visibility,
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
const scope = (
  ctx: GroupContext,
  causalRefs: GroupScope['causalRefs'] = [],
  messageId = randomUUID(),
): GroupScope => ({
  groupId: ctx.groupId,
  memberId: ctx.memberId,
  installationId: ctx.installationId,
  visibility: ctx.visibility,
  source: {
    sessionId: ctx.sessionId,
    provider: ctx.provider,
    nativeSessionId: ctx.nativeSessionId,
    messageId,
  },
  causalRefs,
});
const access = (ctx = shared, refs: GroupScope['causalRefs'] = []) =>
  repo.trustedHostScope(scope(ctx, refs));
const payload = (changes: Partial<GroupAppend> = {}): GroupAppend => ({
  operationId: groupOperationIdSchema.parse(randomUUID()),
  entityId: groupEntityIdSchema.parse(randomUUID()),
  expectedRevision: 0,
  category: 'Question',
  condensedText: 'Alice asks whether the experiment needs another control.',
  original: { kind: 'inline', text: 'Exact original prompt\n  with whitespace and 🧬 unicode.' },
  evidenceRefs: [],
  corrects: null,
  ...changes,
});
const feed = (handle: GroupAccess, visibility: 'shared' | 'private' = 'shared', limit = 50) =>
  repo.feed(handle, { visibility, limit, after: 0, cursor: null });
beforeEach(() => {
  const data = resolve(process.env.GROUP_EVENT_TEST_TMPDIR ?? 'data/group-event-tests');
  mkdirSync(data, { recursive: true });
  directory = mkdtempSync(join(data, 'case-'));
  path = join(directory, 'events.sqlite');
  repo = new GroupEventRepository(path);
  alice = repo.createGroup('Alice');
  bob = repo.addMember(alice.groupId, 'Bob');
  other = repo.createGroup('Other');
  shared = context(alice, 'shared');
  privateA = context(alice, 'private');
  sharedB = context({ ...bob, groupId: alice.groupId }, 'shared');
  privateB = context({ ...bob, groupId: alice.groupId }, 'private');
  alien = context(other, 'shared');
});
afterEach(() => {
  repo.close();
  rmSync(directory, { recursive: true, force: true });
});

it('requires typed names and strict complete identities; never accepts a browser scope as authority', () => {
  expect(groupDisplayNameSchema.safeParse('').success).toBe(false);
  expect(groupDisplayNameSchema.safeParse(undefined).success).toBe(false);
  expect(groupScopeSchema.safeParse({ ...scope(shared), displayName: 'Alice' }).success).toBe(
    false,
  );
  expect(
    groupContextSchema.safeParse({ ...shared, parentSessionId: shared.sessionId }).success,
  ).toBe(false);
  expect(groupScopeSchema.safeParse({ ...scope(shared), installationId: 'Alice' }).success).toBe(
    false,
  );
  expect(() => repo.append(scope(shared) as unknown as GroupAccess, payload())).toThrow(
    'Repository-issued',
  );
  expect(() => repo.trustedHostScope({ ...scope(shared), memberId: bob.memberId })).toThrow(
    'membership',
  );
  expect(() =>
    repo.trustedHostScope({
      ...scope(shared),
      source: { ...scope(shared).source, nativeSessionId: 'wrong' },
    }),
  ).toThrow('context identity');
  expect(
    new Set([alice.groupId, alice.memberId, alice.installationId, shared.sessionId]).size,
  ).toBe(4);
});

it('rejects cross-group/private canaries on append, retrieval, expansion and shared publication', () => {
  const common = repo.append(access(), payload()).event;
  const a = repo.append(
    access(privateA),
    payload({ original: { kind: 'inline', text: 'ALICE PRIVATE CANARY' } }),
  ).event;
  const b = repo.append(
    access(privateB),
    payload({ original: { kind: 'inline', text: 'BOB PRIVATE CANARY' } }),
  ).event;
  const x = repo.append(
    access(alien),
    payload({ original: { kind: 'inline', text: 'OTHER GROUP CANARY' } }),
  ).event;
  expect(feed(access(sharedB)).entries.map((e) => e.eventId)).toEqual([common.eventId]);
  expect(feed(access(privateA), 'private').entries.map((e) => e.eventId)).toEqual([a.eventId]);
  expect(feed(access(privateA), 'shared').entries.map((e) => e.eventId)).toEqual([common.eventId]);
  expect(repo.expand(access(privateA), common.eventId).event.eventId).toBe(common.eventId);
  expect(() => feed(access(), 'private')).toThrow('Shared context');
  for (const id of [a.eventId, b.eventId, x.eventId]) {
    expect(() => repo.expand(access(), id)).toThrow('unavailable');
    expect(() => repo.append(access(), payload({ evidenceRefs: [id] }))).toThrow('unavailable');
    expect(() => access(shared, [id])).toThrow('unavailable');
    expect(() => repo.sharedPublication(access(), [common.eventId, id])).toThrow('unavailable');
  }
  expect(() => repo.expand(access(privateA), b.eventId)).toThrow('unavailable');
  expect(() => repo.expand(access(privateA), x.eventId)).toThrow('unavailable');
  expect(() => repo.sharedPublication(access(privateA), [common.eventId])).toThrow(
    'no shared publication',
  );
  expect(() => repo.sharedPublication(access(privateA), [a.eventId])).toThrow(
    'no shared publication',
  );
  expect(JSON.stringify(repo.sharedPublication(access(), [common.eventId]))).not.toContain(
    'CANARY',
  );
  expect(feed(access()).entries).toHaveLength(1);
});

it.each(['shared', 'private'] as const)(
  'exposes only %s stream positions on every response despite unrelated interleaving and restart',
  (visibility) => {
    const target = visibility === 'shared' ? shared : privateA;
    const secondPrivate = context(alice, 'private');
    const alienPrivate = context(other, 'private');
    const firstScope = scope(target);
    const firstInput = payload();
    let handle = repo.trustedHostScope(firstScope);
    const first = repo.append(handle, firstInput);
    const initialPage = feed(handle, visibility, 1);
    const initialExpansion = repo.expand(handle, first.event.eventId);
    const initialPublication =
      visibility === 'shared' ? repo.sharedPublication(handle, [first.event.eventId]) : null;
    const unrelated = [
      privateB,
      secondPrivate,
      alien,
      alienPrivate,
      visibility === 'shared' ? privateA : shared,
    ];
    const interleave = () =>
      unrelated.forEach((ctx) => {
        for (let i = 0; i < 3; i++) repo.append(access(ctx), payload());
      });
    interleave();
    expect(feed(handle, visibility, 1)).toEqual(initialPage);
    expect(repo.expand(handle, first.event.eventId)).toEqual(initialExpansion);
    expect(repo.append(handle, firstInput)).toEqual({ ...first, duplicate: true });
    if (initialPublication)
      expect(repo.sharedPublication(handle, [first.event.eventId])).toEqual(initialPublication);

    const secondScope = scope(target);
    const secondInput = payload({
      entityId: first.event.entityId,
      expectedRevision: 1,
      corrects: first.event.eventId,
      evidenceRefs: [first.event.eventId],
    });
    const second = repo.append(repo.trustedHostScope(secondScope), secondInput);
    expect([first.event.sequence, second.event.sequence]).toEqual([1, 2]);
    expect(second.event.revision).toBe(2);
    const snapshot = feed(handle, visibility, 1);
    expect(snapshot.watermark).toBe(2);
    expect(snapshot.continuation).toMatchObject({ version: 2, after: 1, watermark: 2 });
    const pageQuery = { visibility, limit: 1, after: 999, cursor: snapshot.continuation };
    const tail = repo.feed(handle, pageQuery); // Cursor takes precedence over query.after.
    expect(tail).toEqual({ entries: [second.event], watermark: 2, continuation: null });
    const incremental = { visibility, limit: 1, after: 1, cursor: null };
    expect(repo.feed(handle, incremental)).toEqual(tail);
    const publication =
      visibility === 'shared'
        ? repo.sharedPublication(handle, [first.event.eventId, second.event.eventId])
        : null;
    if (publication) expect(publication.map((item) => item.event.sequence)).toEqual([1, 2]);
    interleave();
    expect(feed(handle, visibility, 1)).toEqual(snapshot);
    expect(repo.feed(handle, pageQuery)).toEqual(tail);
    repo.close();
    repo = new GroupEventRepository(path);
    handle = repo.trustedHostScope(firstScope);
    expect(feed(handle, visibility, 1)).toEqual(snapshot);
    expect(repo.feed(handle, pageQuery)).toEqual(tail);
    expect(repo.feed(handle, incremental)).toEqual(tail);
    expect(repo.append(handle, firstInput)).toEqual({ ...first, duplicate: true });
    expect(repo.append(repo.trustedHostScope(secondScope), secondInput)).toEqual({
      ...second,
      duplicate: true,
    });
    expect(repo.expand(handle, first.event.eventId)).toEqual(initialExpansion);
    expect(repo.expand(handle, second.event.eventId).event).toEqual(second.event);
    if (publication)
      expect(repo.sharedPublication(handle, [first.event.eventId, second.event.eventId])).toEqual(
        publication,
      );
  },
);

it('never reuses a shared native session for a private context or accepts a relabelled scope', () => {
  const { sessionId: _sessionId, ...privateInput } = privateA;
  expect(() =>
    repo.createContext({ ...privateInput, nativeSessionId: shared.nativeSessionId }),
  ).toThrow('UNIQUE');
  expect(() =>
    repo.createContext({ ...privateInput, parentSessionId: shared.sessionId } as unknown as Omit<
      GroupContext,
      'sessionId'
    >),
  ).toThrow();
  expect(() => repo.trustedHostScope({ ...scope(shared), visibility: 'private' })).toThrow(
    'context identity',
  );
  expect(() => repo.trustedHostScope({ ...scope(privateA), visibility: 'shared' })).toThrow(
    'context identity',
  );
});

it('checks revocation before reads, expansion, appends and duplicate acknowledgements, including after restart', () => {
  const authority = scope(shared);
  const handle = repo.trustedHostScope(authority);
  const input = payload();
  const event = repo.append(handle, input).event;
  repo.revokeMember(alice.groupId, alice.memberId);
  for (const work of [
    () => feed(handle),
    () => repo.expand(handle, event.eventId),
    () => repo.append(handle, input),
    () => repo.sharedPublication(handle, [event.eventId]),
    () => repo.trustedHostScope(authority),
  ])
    expect(work).toThrow('membership');
  repo.close();
  repo = new GroupEventRepository(path);
  expect(() => repo.trustedHostScope(authority)).toThrow('membership');
  expect(feed(access(sharedB)).entries.map((e) => e.eventId)).toEqual([event.eventId]);
});

it('persists actor-operation receipts and detects different payload or scope retries', () => {
  const authority = scope(shared);
  const handle = repo.trustedHostScope(authority);
  const input = payload();
  const first = repo.append(handle, input);
  expect(repo.append(handle, input)).toEqual({ ...first, duplicate: true });
  expect(() => repo.append(handle, { ...input, condensedText: 'Different instruction' })).toThrow(
    'different content',
  );
  expect(() => repo.append(access(privateA), input)).toThrow('different content');
  expect(() => repo.append(access(), input)).toThrow('different content');
  repo.close();
  repo = new GroupEventRepository(path);
  const restored = repo.trustedHostScope(authority);
  expect(repo.append(restored, input)).toEqual({ event: first.event, duplicate: true });
  expect(repo.expand(restored, first.event.eventId).original).toBe(
    input.original.kind === 'inline' ? input.original.text : '',
  );
  expect(feed(restored).entries).toHaveLength(1);
  // Different actors can use the same operation ID without aliasing each other's receipts.
  expect(
    repo.append(access(sharedB), { ...input, entityId: groupEntityIdSchema.parse(randomUUID()) })
      .duplicate,
  ).toBe(false);
});

it('keeps originals and feed entries immutable, with new correction entries and causal evidence', () => {
  const original = repo.append(access(), payload()).event;
  const snapshot = feed(access(), 'shared', 1);
  const correction = repo.append(
    access(sharedB, [original.eventId]),
    payload({
      entityId: original.entityId,
      expectedRevision: 1,
      category: 'Decision',
      condensedText: 'Bob confirms a second control is required.',
      corrects: original.eventId,
      evidenceRefs: [original.eventId],
    }),
  ).event;
  expect(correction.revision).toBe(2);
  expect(correction.scope.causalRefs).toEqual([original.eventId]);
  expect(repo.expand(access(), original.eventId).event).toEqual(original);
  expect(feed(access()).entries).toEqual([original, correction]);
  expect(snapshot.entries).toEqual([original]);
  expect(() =>
    repo.append(access(), payload({ entityId: original.entityId, expectedRevision: 0 })),
  ).toThrow('revision changed');
  expect(() =>
    repo.append(
      access(),
      payload({ entityId: original.entityId, expectedRevision: 2, corrects: original.eventId }),
    ),
  ).toThrow('current entity');
  const db = new DatabaseSync(path);
  try {
    expect(() =>
      db.prepare('UPDATE ge_events SET event_json=? WHERE event_id=?').run('{}', original.eventId),
    ).toThrow('immutable');
    expect(() =>
      db.prepare('DELETE FROM ge_events WHERE event_id=?').run(original.eventId),
    ).toThrow('immutable');
    expect(() =>
      db.prepare('UPDATE ge_chunks SET text=? WHERE event_id=?').run('edited', original.eventId),
    ).toThrow('immutable');
  } finally {
    db.close();
  }
});

it('preserves exact oversized originals through bounded UTF-8 chunk manifests; refuses truncation', () => {
  const chunks = ['🧬'.repeat(4096), 'é'.repeat(8192), 'Tail\n  '];
  const input = payload({ original: { kind: 'chunked', chunks } });
  const event = repo.append(access(), input).event;
  expect(event.manifest.bytes).toBe(32768 + 7);
  expect(event.manifest.chunks.map((c) => c.bytes)).toEqual([16384, 16384, 7]);
  expect(repo.expand(access(), event.eventId).original).toBe(chunks.join(''));
  expect(groupPayloadSchema.safeParse({ kind: 'inline', text: '🧬'.repeat(4097) }).success).toBe(
    false,
  );
  expect(groupPayloadSchema.safeParse({ kind: 'chunked', chunks: ['a', 'b'] }).success).toBe(false);
  expect(groupPayloadSchema.safeParse({ kind: 'inline', text: '\ud800' }).success).toBe(false);
  expect(
    groupPayloadSchema.safeParse({ kind: 'chunked', chunks: Array(65).fill('a'.repeat(16384)) })
      .success,
  ).toBe(false);
  expect(groupAppendSchema.safeParse(payload({ condensedText: 'é'.repeat(2049) })).success).toBe(
    false,
  );
  expect(() =>
    repo.append(
      access(),
      payload({ original: { kind: 'inline', text: 'x'.repeat(GROUP_LIMITS.chunkBytes + 1) } }),
    ),
  ).toThrow();
});

it('paginates with a stable scope-bound watermark across new events, corrections and restart', () => {
  const authority = scope(shared);
  let handle = repo.trustedHostScope(authority);
  const events = Array.from({ length: 5 }, () => repo.append(access(), payload()).event);
  repo.append(access(privateA), payload());
  repo.append(access(alien), payload());
  const page1 = feed(handle, 'shared', 2);
  expect(page1.continuation).not.toBeNull();
  const later = repo.append(
    access(),
    payload({ entityId: events[0].entityId, expectedRevision: 1, corrects: events[0].eventId }),
  ).event;
  expect(() =>
    repo.feed(access(sharedB), {
      visibility: 'shared',
      limit: 2,
      after: 0,
      cursor: page1.continuation,
    }),
  ).toThrow('another scope');
  expect(() =>
    repo.feed(handle, { visibility: 'shared', limit: 51, after: 0, cursor: null }),
  ).toThrow();
  repo.close();
  repo = new GroupEventRepository(path);
  handle = repo.trustedHostScope(authority);
  const page2 = repo.feed(handle, {
    visibility: 'shared',
    limit: 2,
    after: 0,
    cursor: page1.continuation,
  });
  const page3 = repo.feed(handle, {
    visibility: 'shared',
    limit: 2,
    after: 0,
    cursor: page2.continuation,
  });
  expect([...page1.entries, ...page2.entries, ...page3.entries]).toEqual(events);
  expect(page3.continuation).toBeNull();
  expect(page2.watermark).toBe(page1.watermark);
  expect(feed(handle).entries.at(-1)).toEqual(later);
  expect(
    repo.feed(handle, { visibility: 'shared', limit: 2, after: page1.watermark, cursor: null })
      .entries,
  ).toEqual([later]);
  expect(() =>
    repo.feed(handle, {
      visibility: 'shared',
      limit: 2,
      after: 0,
      cursor: { ...page1.continuation!, watermark: 999999 },
    }),
  ).toThrow('future snapshot');
});

it('serializes simultaneous revision writers across separate SQLite connections', async () => {
  const first = repo.append(access(), payload()).event;
  const inputs = [shared, sharedB].map((ctx) => ({
    scope: scope(ctx),
    payload: payload({ entityId: first.entityId, expectedRevision: 1 }),
  }));
  // Run the current repository source, never possibly stale dist/group-events.js.
  const module = new URL('./group-events.ts', import.meta.url).href;
  const run = (input: (typeof inputs)[number]) =>
    new Promise<string>((resolveResult, reject) => {
      const code = `import {GroupEventRepository} from ${JSON.stringify(module)};
      const repo = new GroupEventRepository(process.argv[1]);
      const input = JSON.parse(process.argv[2]);
      try { const result=repo.append(repo.trustedHostScope(input.scope),input.payload); console.log('revision:'+result.event.revision); }
      catch(error) { if(error.code==='stale_revision') console.log(error.code); else throw error; }
      finally {repo.close();}`;
      const child = spawn(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        code,
        path,
        JSON.stringify(input),
      ]);
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      child.on('error', reject);
      child.on('close', (exit) =>
        exit === 0 ? resolveResult(stdout.trim()) : reject(new Error(stderr)),
      );
    });
  expect((await Promise.all(inputs.map(run))).sort()).toEqual(['revision:2', 'stale_revision']);
  expect(feed(access()).entries.map((event) => event.revision)).toEqual([1, 2]);
});

it('migrates unversioned v1 history without rewriting originals, receipts or records', () => {
  const authority = scope(shared);
  const input = payload({ original: { kind: 'inline', text: '\0\ufeffExact\r\n🧬\u200d' } });
  const first = repo.append(access(), payload()).event;
  const privateFirst = repo.append(access(privateA), payload()).event;
  for (let i = 0; i < 3; i++) {
    repo.append(access(privateB), payload());
    repo.append(access(alien), payload());
  }
  const second = repo.append(repo.trustedHostScope(authority), input).event;
  const privateSecond = repo.append(access(privateA), payload()).event;
  repo.close();
  const legacyPath = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(legacyPath);
  // Exact v1 tables/triggers, before the versioned append-only position table.
  legacy.exec(GROUP_EVENT_SQL.split('CREATE TABLE IF NOT EXISTS ge_schema')[0]);
  legacy.prepare('ATTACH DATABASE ? AS current').run(path);
  for (const table of ['ge_groups', 'ge_members', 'ge_contexts', 'ge_revisions'])
    legacy.exec(`INSERT INTO ${table} SELECT * FROM current.${table}`);
  legacy.exec(`INSERT INTO ge_events SELECT sequence,event_id,group_id,member_id,
    installation_id,session_id,visibility,operation_id,payload_hash,source_message_id,
    entity_key,revision,json_set(event_json,'$.sequence',sequence) FROM current.ge_events;
    INSERT INTO ge_chunks SELECT * FROM current.ge_chunks`);
  const originals = legacy.prepare('SELECT * FROM ge_events ORDER BY sequence').all();
  const chunks = legacy.prepare('SELECT * FROM ge_chunks ORDER BY event_id,chunk_index').all();
  const contexts = legacy.prepare('SELECT * FROM ge_contexts ORDER BY session_id').all();
  const revisions = legacy.prepare('SELECT * FROM ge_revisions ORDER BY entity_key').all();
  legacy.close();
  repo = new GroupEventRepository(legacyPath);
  const restored = repo.trustedHostScope(authority);
  expect(repo.append(restored, input)).toEqual({ event: second, duplicate: true });
  expect(repo.expand(restored, second.eventId)).toEqual({
    event: second,
    original: '\0\ufeffExact\r\n🧬\u200d',
  });
  expect(feed(restored).entries).toEqual([first, second]);
  expect(feed(access(privateA), 'private').entries).toEqual([privateFirst, privateSecond]);
  expect(
    repo.sharedPublication(restored, [first.eventId, second.eventId]).map((e) => e.event.sequence),
  ).toEqual([1, 2]);
  const page = feed(restored, 'shared', 1);
  const { version: _version, ...legacyCursor } = page.continuation!;
  expect(() =>
    repo.feed(restored, {
      visibility: 'shared',
      limit: 1,
      after: 0,
      cursor: legacyCursor as typeof page.continuation,
    }),
  ).toThrow();
  const inspect = new DatabaseSync(legacyPath);
  try {
    expect(inspect.prepare('SELECT * FROM ge_events ORDER BY sequence').all()).toEqual(originals);
    expect(inspect.prepare('SELECT * FROM ge_chunks ORDER BY event_id,chunk_index').all()).toEqual(
      chunks,
    );
    expect(inspect.prepare('SELECT * FROM ge_contexts ORDER BY session_id').all()).toEqual(
      contexts,
    );
    expect(inspect.prepare('SELECT * FROM ge_revisions ORDER BY entity_key').all()).toEqual(
      revisions,
    );
    expect(inspect.prepare('SELECT version FROM ge_schema').get()).toMatchObject({ version: 2 });
    expect(() =>
      inspect
        .prepare('UPDATE ge_stream_positions SET position=99 WHERE event_id=?')
        .run(first.eventId),
    ).toThrow('immutable');
    expect(() =>
      inspect.prepare('DELETE FROM ge_stream_positions WHERE event_id=?').run(first.eventId),
    ).toThrow('immutable');
  } finally {
    inspect.close();
  }
  const third = repo.append(
    access(),
    payload({ entityId: second.entityId, expectedRevision: 1, corrects: second.eventId }),
  ).event;
  expect(third.sequence).toBe(3);
  expect(third.revision).toBe(2);
  repo.close();
  repo = new GroupEventRepository(legacyPath);
  expect(feed(access()).entries).toEqual([first, second, third]);
  expect(repo.append(repo.trustedHostScope(authority), input)).toEqual({
    event: second,
    duplicate: true,
  });
});

it('fails closed on unsupported schema versions without resetting history', () => {
  const event = repo.append(access(), payload()).event;
  repo.close();
  const db = new DatabaseSync(path);
  const before = db.prepare('SELECT * FROM ge_events').all();
  try {
    db.exec('UPDATE ge_schema SET version=99');
    expect(() => new GroupEventRepository(path)).toThrow(
      'Unsupported group event schema version: 99',
    );
    expect(db.prepare('SELECT * FROM ge_events').all()).toEqual(before);
    expect(db.prepare('SELECT version FROM ge_schema').get()).toMatchObject({ version: 99 });
    db.exec('UPDATE ge_schema SET version=2');
  } finally {
    db.close();
  }
  repo = new GroupEventRepository(path);
  expect(feed(access()).entries).toEqual([event]);
});

it('preserves the original error when SQLite automatically rolls back a failed append', () => {
  const handle = access();
  const input = payload();
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TRIGGER ge_test_rollback BEFORE INSERT ON ge_events
      BEGIN SELECT RAISE(ROLLBACK,'original append failure'); END`);
    expect(() => repo.append(handle, input)).toThrow('original append failure');
    expect(feed(handle).entries).toEqual([]);
    db.exec('DROP TRIGGER ge_test_rollback');
    const result = repo.append(handle, input);
    expect(result.event.sequence).toBe(1);
    expect(result.event.revision).toBe(1);
    expect(repo.append(handle, input)).toEqual({ ...result, duplicate: true });
  } finally {
    db.close();
  }
});

it('indexes shared and private feed positions by the exact stream', () => {
  repo.append(access(), payload());
  repo.append(access(privateA), payload());
  const db = new DatabaseSync(path);
  try {
    for (const [streamKey, predicate, args] of [
      [`shared:${alice.groupId}`, "group_id=? AND visibility='shared'", [alice.groupId]],
      [
        `private:${privateA.sessionId}`,
        "group_id=? AND (visibility='private' AND member_id=? AND installation_id=? AND session_id=?)",
        [alice.groupId, alice.memberId, alice.installationId, privateA.sessionId],
      ],
    ] as const) {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT event_json,position
        FROM ge_stream_positions JOIN ge_events USING(event_id)
        WHERE stream_key=? AND ${predicate} AND position>? AND position<=?
        ORDER BY position LIMIT ?`,
        )
        .all(streamKey, ...args, 0, 2, 2) as { detail: string }[];
      expect(
        plan.some((row) =>
          /SEARCH ge_stream_positions USING INDEX .*\(stream_key=\? AND position>\? AND position<\?\)/.test(
            row.detail,
          ),
        ),
      ).toBe(true);
      expect(
        plan.some((row) => /SEARCH ge_events USING INDEX .*\(event_id=\?\)/.test(row.detail)),
      ).toBe(true);
      expect(plan.some((row) => /SCAN|TEMP B-TREE/.test(row.detail))).toBe(false);
    }
  } finally {
    db.close();
  }
});

it('rolls back failed references and rejects source reuse without consuming revisions or receipts', () => {
  const handle = access();
  const input = payload();
  const missing = groupAppendSchema.parse({ ...input, evidenceRefs: [randomUUID()] });
  expect(() => repo.append(handle, missing)).toThrow('unavailable');
  expect(feed(handle).entries).toEqual([]);
  const first = repo.append(handle, input).event;
  expect(first.revision).toBe(1);
  expect(first.sequence).toBe(1);
  expect(() => repo.append(handle, payload())).toThrow('source already recorded');
  const next = repo.append(
    access(),
    payload({ entityId: first.entityId, expectedRevision: 1 }),
  ).event;
  expect(next.revision).toBe(2);
  expect(next.sequence).toBe(2);
});

it('keeps private revisions and private cursors separate even for the same member', () => {
  const secondPrivate = context(alice, 'private');
  const entityId = groupEntityIdSchema.parse(randomUUID());
  const first = repo.append(access(privateA), payload({ entityId })).event;
  const second = repo.append(access(secondPrivate), payload({ entityId })).event;
  repo.append(access(privateA), payload());
  const page = feed(access(privateA), 'private', 1);
  expect(page.continuation).not.toBeNull();
  expect(() =>
    repo.feed(access(secondPrivate), {
      visibility: 'private',
      limit: 1,
      after: 0,
      cursor: page.continuation,
    }),
  ).toThrow('another scope');
  expect(() => repo.expand(access(secondPrivate), first.eventId)).toThrow('unavailable');
  expect(second.revision).toBe(1);
  expect(feed(access(secondPrivate), 'private').entries).toEqual([second]);
});
