import type { DatabaseSync } from 'node:sqlite';
import { Conflict } from './store.js';

/** Local retained receipt accounting, separate from hosted/account quotas. */
export const GROUP_LOCAL_RECEIPT_BYTES = 2 * 1024 ** 3;
export const GROUP_LOCAL_RECEIPT_CONTROL_BYTES = 4 * 1024 ** 2;
const normalLimit = GROUP_LOCAL_RECEIPT_BYTES - GROUP_LOCAL_RECEIPT_CONTROL_BYTES;
const rowOverhead = 4096;
// Human send results contain generated IDs and bounded status/summary fields.
// Reserve their future mutable body before recording or delivering the message.
const sendBodyReserve = 8192;
const expressions = {
  gh_operations: `length(CAST(input AS BLOB))+length(CAST(body AS BLOB))+${rowOverhead}`,
  gh_sends: `length(CAST(input AS BLOB))+max(${sendBodyReserve},length(CAST(body AS BLOB)))+${rowOverhead}`,
  gh_draft_receipts: `length(CAST(input AS BLOB))+length(CAST(body AS BLOB))+${rowOverhead}`,
  gh_promotion_inputs: `length(CAST(source_json AS BLOB))+max(1024,length(CAST(state AS BLOB)))+${rowOverhead}`,
} as const;
type ReceiptTable = keyof typeof expressions;
const qualified = (expression: string, prefix: 'NEW' | 'OLD') =>
  expression.replace(/\b(input|body|source_json|state)\b/g, `${prefix}.$1`);

/** Initialized once from old rows; inserts/updates maintain constant-time counters.
 * Existing over-budget installations remain readable and retryable. No row is retired.
 */
export function initializeGroupLocalReceiptCapacity(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS gh_receipt_storage(
    bucket TEXT PRIMARY KEY,bytes INTEGER NOT NULL CHECK(bytes>=0));`);
    for (const [table, expression] of Object.entries(expressions)) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        continue;
      const exists = db.prepare('SELECT 1 FROM gh_receipt_storage WHERE bucket=?').get(table);
      if (!exists)
        db.exec(`INSERT INTO gh_receipt_storage SELECT '${table}',
        COALESCE(sum(${expression}),0) FROM ${table};`);
      db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_storage_insert AFTER INSERT ON ${table}
        BEGIN UPDATE gh_receipt_storage SET bytes=bytes+(${qualified(expression, 'NEW')}) WHERE bucket='${table}'; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_storage_update AFTER UPDATE ON ${table}
        BEGIN UPDATE gh_receipt_storage SET bytes=bytes+(${qualified(expression, 'NEW')})-(${qualified(expression, 'OLD')}) WHERE bucket='${table}'; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_storage_delete AFTER DELETE ON ${table}
        BEGIN UPDATE gh_receipt_storage SET bytes=bytes-(${qualified(expression, 'OLD')}) WHERE bucket='${table}'; END;
    `);
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS gh_sends_reserved_body BEFORE UPDATE OF body ON gh_sends
    WHEN length(CAST(NEW.body AS BLOB))>max(${sendBodyReserve},length(CAST(OLD.body AS BLOB)))
    BEGIN SELECT RAISE(ABORT,'Human send receipt exceeds its retained body reservation'); END;`);
    if (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gh_promotion_inputs'")
        .get()
    )
      db.exec(`CREATE TRIGGER IF NOT EXISTS gh_promotion_reserved_state BEFORE UPDATE OF state ON gh_promotion_inputs
      WHEN length(CAST(NEW.state AS BLOB))>max(1024,length(CAST(OLD.state AS BLOB)))
      BEGIN SELECT RAISE(ABORT,'Summary receipt exceeds its retained status reservation'); END;`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function groupLocalReceiptCapacity(db: DatabaseSync) {
  const bytes = Number(
    db.prepare('SELECT COALESCE(sum(bytes),0) n FROM gh_receipt_storage').get()!.n,
  );
  return { bytes, limitBytes: normalLimit, full: bytes >= normalLimit };
}

/** Call inside the caller's existing receipt transaction, only for a new key. */
export function admitGroupLocalReceipt(
  db: DatabaseSync,
  table: ReceiptTable,
  input: string,
  body: string,
  control = false,
) {
  const charge =
    Buffer.byteLength(input, 'utf8') +
    (table === 'gh_sends' || table === 'gh_promotion_inputs'
      ? Math.max(table === 'gh_sends' ? sendBodyReserve : 1024, Buffer.byteLength(body, 'utf8'))
      : Buffer.byteLength(body, 'utf8')) +
    rowOverhead;
  if (
    groupLocalReceiptCapacity(db).bytes + charge >
    (control ? GROUP_LOCAL_RECEIPT_BYTES : normalLimit)
  )
    throw new Conflict(
      'Local Groups receipt storage is full. Existing messages, drafts and exact retries remain; no new request was delivered. Copy your unsent draft before asking your setup agent for help.',
    );
}
