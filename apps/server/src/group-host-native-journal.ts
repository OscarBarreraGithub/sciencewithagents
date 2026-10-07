import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { publicationCanonical } from './group-publication-protocol.js';
import { Conflict } from './store.js';
import { GROUP_LIMITS } from '@dock/shared';
import {
  groupNativeRequestSchema,
  groupNativeResultSchema,
  groupNativeStateSchema,
  groupNativeSnapshotSchema,
  type GroupNativeRequest,
  type GroupNativeSnapshot,
} from './group-host-native.js';
const idsSchema = z.strictObject({
  resultId: z.uuid(),
  operationId: z.uuid(),
  entityId: z.uuid(),
  createdAt: z.string(),
});
const receiptSchema = z.strictObject({
  state: groupNativeStateSchema.or(z.literal('prepared')),
  message: z.string().max(1000),
  eventId: z.uuid().nullable(),
  deliveryOperation: z.uuid().nullable(),
});
export const GROUP_NATIVE_JOURNAL_LIMITS = {
  pending: 64,
  bytes: 512 * 1024 * 1024,
  receipts: 128,
} as const;
// Canonical JSON may encode a one-byte control character as six bytes. Include
// bounded context/source JSON and conservative row/index overhead as well.
const ROW_BYTES = 4096;
const RESULT_RESERVE = 6 * GROUP_LIMITS.payloadBytes + 16_384 + ROW_BYTES;
const RECEIPT_RESERVE = 8192 + ROW_BYTES;
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
export type GroupHostNativeRecord = {
  handle: string;
  request: GroupNativeRequest;
  ids: z.infer<typeof idsSchema>;
  receipt: z.infer<typeof receiptSchema>;
  result: z.infer<typeof groupNativeResultSchema> | null;
  resultAt: string | null;
};
/** Append-only host evidence outside normal Store/SSE/native transcript history.
 * A durable handoff marker precedes submit. Restart/retry may inspect that exact
 * request, but cannot turn an uncertain receipt into another tool execution. */
export class GroupHostNativeJournal {
  constructor(
    private readonly db: DatabaseSync,
    private readonly byteLimit: number = GROUP_NATIVE_JOURNAL_LIMITS.bytes,
  ) {
    z.number().int().positive().max(GROUP_NATIVE_JOURNAL_LIMITS.bytes).parse(byteLimit);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ghn_requests(handle TEXT NOT NULL,key TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,input TEXT NOT NULL,ids TEXT NOT NULL,PRIMARY KEY(handle,key));
      CREATE TABLE IF NOT EXISTS ghn_results(request_id TEXT PRIMARY KEY,body TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ghn_receipts(sequence INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ghn_receipt_request ON ghn_receipts(request_id,sequence);
      CREATE TRIGGER IF NOT EXISTS ghn_requests_no_update BEFORE UPDATE ON ghn_requests BEGIN SELECT RAISE(ABORT,'immutable native request'); END;
      CREATE TRIGGER IF NOT EXISTS ghn_requests_no_delete BEFORE DELETE ON ghn_requests BEGIN SELECT RAISE(ABORT,'retained native request'); END;
      CREATE TRIGGER IF NOT EXISTS ghn_results_no_update BEFORE UPDATE ON ghn_results BEGIN SELECT RAISE(ABORT,'immutable native result'); END;
      CREATE TRIGGER IF NOT EXISTS ghn_results_no_delete BEFORE DELETE ON ghn_results BEGIN SELECT RAISE(ABORT,'retained native result'); END;
      CREATE TRIGGER IF NOT EXISTS ghn_receipts_no_update BEFORE UPDATE ON ghn_receipts BEGIN SELECT RAISE(ABORT,'immutable native receipt'); END;
      CREATE TRIGGER IF NOT EXISTS ghn_receipts_no_delete BEFORE DELETE ON ghn_receipts BEGIN SELECT RAISE(ABORT,'retained native receipt'); END;
    `);
    // Derived accounting only; original requests/results/receipts stay immutable.
    // Backfill once, then INSERT triggers keep byte accounting constant-time.
    this.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS ghn_storage(singleton INTEGER PRIMARY KEY CHECK(singleton=1),bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ghn_capacity(request_id TEXT PRIMARY KEY,receipts INTEGER NOT NULL,result_saved INTEGER NOT NULL,pending INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS ghn_capacity_pending ON ghn_capacity(pending);`);
      if (!db.prepare('SELECT 1 FROM ghn_storage WHERE singleton=1').get()) {
        db.exec(`INSERT INTO ghn_storage VALUES(1,
          COALESCE((SELECT sum(length(CAST(input AS BLOB))+length(CAST(ids AS BLOB))+length(handle)+length(key)+length(request_id)+${ROW_BYTES}) FROM ghn_requests),0)+
          COALESCE((SELECT sum(length(CAST(body AS BLOB))+length(created_at)+length(request_id)+${ROW_BYTES}) FROM ghn_results),0)+
          COALESCE((SELECT sum(length(CAST(body AS BLOB))+length(request_id)+${ROW_BYTES}) FROM ghn_receipts),0));
          INSERT INTO ghn_capacity SELECT r.request_id,
            (SELECT count(*) FROM ghn_receipts x WHERE x.request_id=r.request_id),
            EXISTS(SELECT 1 FROM ghn_results x WHERE x.request_id=r.request_id),
            CASE WHEN EXISTS(SELECT 1 FROM ghn_results x WHERE x.request_id=r.request_id)
              OR COALESCE((SELECT json_extract(body,'$.state') FROM ghn_receipts x WHERE x.request_id=r.request_id ORDER BY sequence DESC LIMIT 1),'prepared')='blocked' THEN 0 ELSE 1 END
            FROM ghn_requests r;`);
      }
      db.exec(`CREATE TRIGGER IF NOT EXISTS ghn_request_account AFTER INSERT ON ghn_requests BEGIN
          UPDATE ghn_storage SET bytes=bytes+length(CAST(NEW.input AS BLOB))+length(CAST(NEW.ids AS BLOB))+length(NEW.handle)+length(NEW.key)+length(NEW.request_id)+${ROW_BYTES} WHERE singleton=1;
          INSERT INTO ghn_capacity VALUES(NEW.request_id,0,0,1); END;
        CREATE TRIGGER IF NOT EXISTS ghn_result_account AFTER INSERT ON ghn_results BEGIN
          UPDATE ghn_storage SET bytes=bytes+length(CAST(NEW.body AS BLOB))+length(NEW.created_at)+length(NEW.request_id)+${ROW_BYTES} WHERE singleton=1;
          UPDATE ghn_capacity SET result_saved=1,pending=0 WHERE request_id=NEW.request_id; END;
        CREATE TRIGGER IF NOT EXISTS ghn_receipt_account AFTER INSERT ON ghn_receipts BEGIN
          UPDATE ghn_storage SET bytes=bytes+length(CAST(NEW.body AS BLOB))+length(NEW.request_id)+${ROW_BYTES} WHERE singleton=1;
          UPDATE ghn_capacity SET receipts=receipts+1,pending=CASE WHEN result_saved=1 OR json_extract(NEW.body,'$.state')='blocked' THEN 0 ELSE 1 END WHERE request_id=NEW.request_id; END;`);
    });
  }
  private capacity() {
    const row = this.db
      .prepare(
        `SELECT count(*) AS pending,COALESCE(sum(${RESULT_RESERVE}+MAX(0,${GROUP_NATIVE_JOURNAL_LIMITS.receipts}-receipts)*${RECEIPT_RESERVE}),0) AS reserved FROM ghn_capacity WHERE pending=1`,
      )
      .get()!;
    return {
      pending: Number(row.pending),
      bytes:
        Number(this.db.prepare('SELECT bytes FROM ghn_storage WHERE singleton=1').get()!.bytes) +
        Number(row.reserved),
    };
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  get(handle: string, key: string): GroupHostNativeRecord | null {
    const row = this.db
      .prepare('SELECT input,ids FROM ghn_requests WHERE handle=? AND key=?')
      .get(handle, key);
    if (!row) return null;
    const request = groupNativeRequestSchema.parse(JSON.parse(String(row.input)));
    const saved = this.db
      .prepare('SELECT body FROM ghn_receipts WHERE request_id=? ORDER BY sequence DESC LIMIT 1')
      .get(request.requestId);
    const result = this.db
      .prepare('SELECT body,created_at FROM ghn_results WHERE request_id=?')
      .get(request.requestId);
    return {
      handle,
      request,
      ids: idsSchema.parse(JSON.parse(String(row.ids))),
      receipt: receiptSchema.parse(
        saved
          ? JSON.parse(String(saved.body))
          : {
              state: 'prepared',
              message: 'Native request saved before handoff.',
              eventId: null,
              deliveryOperation: null,
            },
      ),
      result: result ? groupNativeResultSchema.parse(JSON.parse(String(result.body))) : null,
      resultAt: result ? String(result.created_at) : null,
    };
  }
  list(handle: string): GroupHostNativeRecord[] {
    return this.db
      .prepare('SELECT key FROM ghn_requests WHERE handle=? ORDER BY rowid DESC LIMIT 200')
      .all(handle)
      .reverse()
      .map((v) => this.get(handle, String(v.key))!);
  }
  prepare(handle: string, raw: Omit<z.input<typeof groupNativeRequestSchema>, 'requestId'>) {
    const input = { ...raw, intent: raw.intent ?? 'ask' };
    z.uuid().parse(handle);
    return this.transaction(() => {
      const prior = this.get(handle, input.key);
      if (prior) {
        const { requestId, ...saved } = prior.request;
        if (publicationCanonical(saved) !== publicationCanonical(input))
          throw new Conflict('Native request retry content or scope changed.');
        return prior;
      }
      const request = groupNativeRequestSchema.parse({ ...input, requestId: randomUUID() });
      const ids = {
        resultId: randomUUID(),
        operationId: randomUUID(),
        entityId: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      const encodedRequest = publicationCanonical(request),
        encodedIds = publicationCanonical(ids);
      const capacity = this.capacity();
      const reserved =
        bytes(encodedRequest) +
        bytes(encodedIds) +
        handle.length +
        input.key.length +
        request.requestId.length +
        ROW_BYTES +
        RESULT_RESERVE +
        GROUP_NATIVE_JOURNAL_LIMITS.receipts * RECEIPT_RESERVE;
      if (
        capacity.pending >= GROUP_NATIVE_JOURNAL_LIMITS.pending ||
        capacity.bytes + reserved > this.byteLimit
      )
        throw new Conflict(
          'Native request journal full. Existing identities/results remain; tools were not submitted.',
        );
      this.db
        .prepare('INSERT INTO ghn_requests VALUES (?,?,?,?,?)')
        .run(handle, input.key, request.requestId, encodedRequest, encodedIds);
      return this.get(handle, input.key)!;
    });
  }
  mark(record: GroupHostNativeRecord, patch: Partial<GroupHostNativeRecord['receipt']>) {
    return this.transaction(() => {
      const current = this.get(record.handle, record.request.key)!;
      const receipt = receiptSchema.parse({ ...current.receipt, ...patch });
      if (current.result && receipt.state !== 'completed')
        throw new Conflict('Completed native result cannot be replaced.');
      if (publicationCanonical(receipt) !== publicationCanonical(current.receipt)) {
        // Keep terminal receipt capacity reserved per accepted request even if
        // an adapter repeatedly varies a pending diagnostic during inspection.
        const count = Number(
          this.db
            .prepare('SELECT count(*) n FROM ghn_receipts WHERE request_id=?')
            .get(current.request.requestId)!.n,
        );
        if (count >= 120 && !['completed', 'blocked'].includes(receipt.state)) return current;
        if (count >= GROUP_NATIVE_JOURNAL_LIMITS.receipts)
          throw new Conflict('Native receipt capacity full; original request/result retained.');
        this.db
          .prepare('INSERT INTO ghn_receipts(request_id,body) VALUES (?,?)')
          .run(current.request.requestId, publicationCanonical(receipt));
        if (this.capacity().bytes > this.byteLimit)
          throw new Conflict('Native receipt journal full; retained identity must be recovered.');
      }
      return this.get(record.handle, record.request.key)!;
    });
  }
  record(record: GroupHostNativeRecord, raw: GroupNativeSnapshot) {
    const snapshot = groupNativeSnapshotSchema.parse(raw);
    if (snapshot.requestId !== record.request.requestId)
      throw new Conflict('Native receipt belongs to another request.');
    this.transaction(() => {
      const existing = this.db
        .prepare('SELECT body FROM ghn_results WHERE request_id=?')
        .get(snapshot.requestId);
      if (
        existing &&
        (!snapshot.result || String(existing.body) !== publicationCanonical(snapshot.result))
      )
        throw new Conflict('Native original result identity changed.');
      if (snapshot.result && !existing)
        this.db
          .prepare('INSERT INTO ghn_results VALUES (?,?,?)')
          .run(snapshot.requestId, publicationCanonical(snapshot.result), new Date().toISOString());
    });
    return this.mark(record, { state: snapshot.state, message: snapshot.message });
  }
}
