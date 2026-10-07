import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { groupContextSchema } from '@dock/shared';
import { GroupHostNativeJournal } from './group-host-native-journal.js';
const input = () => ({
  key: randomUUID(),
  text: 'Exact native intent  🧬\n',
  enrollmentHandle: randomUUID(),
  context: groupContextSchema.parse({
    groupId: randomUUID(),
    memberId: randomUUID(),
    installationId: randomUUID(),
    sessionId: randomUUID(),
    visibility: 'private',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  }),
});
it('native journal retains append-only original identities and reserves terminal result receipt capacity', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new GroupHostNativeJournal(db),
      handle = randomUUID(),
      request = input();
    const first = journal.prepare(handle, request);
    expect(journal.prepare(handle, request)).toEqual(first);
    expect(() => journal.prepare(handle, { ...request, text: 'changed' })).toThrow('retry content');
    let current = journal.mark(first, { state: 'unknown', message: 'Handoff may have occurred' });
    for (let i = 0; i < 130; i++)
      current = journal.mark(current, { message: `Pending diagnostic ${i}` });
    expect(db.prepare('SELECT count(*) n FROM ghn_receipts').get()!.n).toBe(120);
    const context = groupContextSchema.parse({
      ...request.context,
      provider: 'codex',
      sessionId: randomUUID(),
      nativeSessionId: randomUUID(),
    });
    const snapshot = {
      requestId: first.request.requestId,
      state: 'completed' as const,
      message: 'Real adapter receipt retained',
      result: { context, text: 'Original result \n🧬', nativeToolItems: 2 },
    };
    const completed = journal.record(current, snapshot);
    expect(completed.result!.text).toBe(snapshot.result.text);
    expect(completed.ids).toEqual(first.ids);
    expect(journal.record(completed, snapshot)).toEqual(completed);
    expect(() =>
      journal.record(completed, { ...snapshot, result: { ...snapshot.result, text: 'rewritten' } }),
    ).toThrow('identity changed');
    expect(() => journal.mark(completed, { state: 'running' })).toThrow('cannot be replaced');
    for (const table of ['ghn_requests', 'ghn_results', 'ghn_receipts']) {
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow();
      expect(() =>
        db.exec(`UPDATE ${table} SET ${table === 'ghn_requests' ? 'input' : 'body'}='{}'`),
      ).toThrow();
    }
  } finally {
    db.close();
  }
});
it('native journal refuses new handoff identities at its reserved result bound without evicting originals', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new GroupHostNativeJournal(db),
      handle = randomUUID();
    const firstInput = input(),
      first = journal.prepare(handle, firstInput);
    for (let i = 1; i < 64; i++) journal.prepare(handle, input());
    expect(() => journal.prepare(handle, input())).toThrow('journal full');
    expect(journal.prepare(handle, firstInput)).toEqual(first);
    expect(journal.list(handle)).toHaveLength(64);
    expect(db.prepare('SELECT count(*) n FROM ghn_requests').get()!.n).toBe(64);
  } finally {
    db.close();
  }
});

const complete = (
  journal: GroupHostNativeJournal,
  record: ReturnType<GroupHostNativeJournal['prepare']>,
  text = 'Small exact result',
) =>
  journal.record(record, {
    requestId: record.request.requestId,
    state: 'completed',
    message: 'Retained original',
    result: {
      context: groupContextSchema.parse({
        ...record.request.context,
        provider: 'codex',
        sessionId: randomUUID(),
        nativeSessionId: randomUUID(),
      }),
      text,
      nativeToolItems: 1,
    },
  });

it('admits more than 64 completed small requests, keeps bounded read pages and every historical retry identity', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new GroupHostNativeJournal(db),
      handle = randomUUID(),
      original = input();
    const first = complete(journal, journal.prepare(handle, original));
    for (let i = 1; i < 240; i++) complete(journal, journal.prepare(handle, input()));
    expect(journal.list(handle)).toHaveLength(200);
    expect(journal.prepare(handle, original)).toEqual(first);
    expect(journal.prepare(handle, input()).receipt.state).toBe('prepared');
    expect(db.prepare('SELECT count(*) n FROM ghn_requests').get()!.n).toBe(241);
    expect(db.prepare('SELECT count(*) n FROM ghn_results').get()!.n).toBe(240);
  } finally {
    db.close();
  }
});

it('does not treat 8192 retained diagnostic receipts as a lifetime stop when actual storage remains available', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new GroupHostNativeJournal(db),
      handle = randomUUID();
    const insert = db.prepare('INSERT INTO ghn_receipts(request_id,body) VALUES (?,?)');
    let first: ReturnType<typeof complete> | undefined;
    for (let i = 0; i < 70; i++) {
      const record = journal.prepare(handle, input());
      for (let diagnostic = 0; diagnostic < 120; diagnostic++)
        insert.run(
          record.request.requestId,
          JSON.stringify({
            state: 'unknown',
            message: `Diagnostic ${diagnostic}`,
            eventId: null,
            deliveryOperation: null,
          }),
        );
      const done = complete(journal, record);
      first ??= done;
    }
    expect(Number(db.prepare('SELECT count(*) n FROM ghn_receipts').get()!.n)).toBeGreaterThan(
      8192,
    );
    expect(journal.get(handle, first!.request.key)).toEqual(first);
    const next = journal.prepare(handle, input());
    expect(journal.mark(next, { state: 'queued' }).receipt.state).toBe('queued');
  } finally {
    db.close();
  }
});

it('accounts actual completed bytes plus outstanding worst-case reservations before allocating a new request, including legacy backfill', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new GroupHostNativeJournal(db, 8 * 1024 * 1024),
      handle = randomUUID(),
      original = input();
    const first = complete(journal, journal.prepare(handle, original), 'x'.repeat(1024 * 1024));
    expect(() => journal.prepare(handle, input())).toThrow('journal full');
    expect(db.prepare('SELECT count(*) n FROM ghn_requests').get()!.n).toBe(1);
    expect(journal.prepare(handle, original)).toEqual(first);
    db.exec(
      'DROP TRIGGER ghn_request_account; DROP TRIGGER ghn_result_account; DROP TRIGGER ghn_receipt_account; DROP TABLE ghn_capacity; DROP TABLE ghn_storage;',
    );
    const migrated = new GroupHostNativeJournal(db, 8 * 1024 * 1024);
    expect(migrated.prepare(handle, original)).toEqual(first);
    expect(() => migrated.prepare(handle, input())).toThrow('journal full');
    expect(db.prepare('SELECT count(*) n FROM ghn_results').get()!.n).toBe(1);
  } finally {
    db.close();
  }
});
