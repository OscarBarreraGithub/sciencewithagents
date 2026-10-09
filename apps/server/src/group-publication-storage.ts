import type { DatabaseSync } from 'node:sqlite';
import {
  PUBLICATION_LIMITS,
  publicationCanonical,
  publicationReceiptSchema,
  type PublicationReceipt,
} from '@dock/shared/dist/group-delivery.js';

export const GROUP_PUBLICATION_RECEIPT_SLOT_BYTES = 8192;
const overhead = 4096;
const charge = `length(CAST(header_json AS BLOB))+length(CAST(source_json AS BLOB))+coalesce(length(CAST(receipt_json AS BLOB)),0)+${overhead}`;
const qualified = (prefix: 'NEW' | 'OLD') =>
  charge.replace(/\b(header_json|source_json|receipt_json)\b/g, `${prefix}.$1`);
/** Additive counters and fixed-size acknowledgment allocation. No receipt,
 * identity or original is deleted when the admission fence is reached. */
export class GroupPublicationStorage {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS gp_receipt_slots(
      operation_id TEXT PRIMARY KEY REFERENCES gp_operations(operation_id),
      committed INTEGER NOT NULL DEFAULT 0 CHECK(committed IN (0,1)),
      body BLOB NOT NULL CHECK(length(body)=${GROUP_PUBLICATION_RECEIPT_SLOT_BYTES}));
    CREATE TRIGGER IF NOT EXISTS gp_receipt_slots_identity BEFORE UPDATE OF operation_id ON gp_receipt_slots BEGIN SELECT RAISE(ABORT,'immutable receipt identity'); END;
    CREATE TRIGGER IF NOT EXISTS gp_receipt_slots_retain BEFORE DELETE ON gp_receipt_slots BEGIN SELECT RAISE(ABORT,'retained receipt'); END;
    CREATE TRIGGER IF NOT EXISTS gp_receipt_slots_complete BEFORE UPDATE ON gp_receipt_slots WHEN OLD.committed=1 AND (NEW.committed<>1 OR NEW.body<>OLD.body) BEGIN SELECT RAISE(ABORT,'immutable committed receipt'); END;
    CREATE TABLE IF NOT EXISTS gp_storage(singleton INTEGER PRIMARY KEY CHECK(singleton=1),bytes INTEGER NOT NULL CHECK(bytes>=0));
    CREATE TABLE IF NOT EXISTS gp_partition_storage(partition_id TEXT PRIMARY KEY,active INTEGER NOT NULL,pending INTEGER NOT NULL);`);
    if (!db.prepare('SELECT 1 FROM gp_storage WHERE singleton=1').get())
      db.exec(`
    INSERT INTO gp_storage SELECT 1,
      coalesce((SELECT sum(${charge}) FROM gp_operations),0)+
      (SELECT count(*) FROM gp_receipt_slots)*${GROUP_PUBLICATION_RECEIPT_SLOT_BYTES + overhead};
    INSERT INTO gp_partition_storage SELECT partition_id,
      sum(CASE WHEN state!='complete' THEN 1 ELSE 0 END),
      sum(CASE WHEN state NOT IN ('complete','exhausted','collision','protocol','integrity') THEN 1 ELSE 0 END)
      FROM gp_operations GROUP BY partition_id;`);
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS gp_operations_storage_insert AFTER INSERT ON gp_operations BEGIN
      UPDATE gp_storage SET bytes=bytes+(${qualified('NEW')}) WHERE singleton=1;
      INSERT INTO gp_partition_storage VALUES(NEW.partition_id,(NEW.state!='complete'),(NEW.state NOT IN ('complete','exhausted','collision','protocol','integrity'))) ON CONFLICT(partition_id) DO UPDATE SET active=active+excluded.active,pending=pending+excluded.pending;
    END;
    CREATE TRIGGER IF NOT EXISTS gp_operations_storage_update AFTER UPDATE ON gp_operations BEGIN
      UPDATE gp_storage SET bytes=bytes+(${qualified('NEW')})-(${qualified('OLD')}) WHERE singleton=1;
      UPDATE gp_partition_storage SET
        active=active+(NEW.state!='complete')-(OLD.state!='complete'),
        pending=pending+(NEW.state NOT IN ('complete','exhausted','collision','protocol','integrity'))-(OLD.state NOT IN ('complete','exhausted','collision','protocol','integrity'))
        WHERE partition_id=NEW.partition_id;
    END;
    CREATE TRIGGER IF NOT EXISTS gp_receipt_slots_storage_insert AFTER INSERT ON gp_receipt_slots BEGIN
      UPDATE gp_storage SET bytes=bytes+${GROUP_PUBLICATION_RECEIPT_SLOT_BYTES + overhead} WHERE singleton=1;
    END;`);
  }
  usage() {
    return {
      bytes: Number(this.db.prepare('SELECT bytes FROM gp_storage WHERE singleton=1').get()!.bytes),
      limitBytes: PUBLICATION_LIMITS.journalBytes,
    };
  }
  counts(partition: string) {
    const row = this.db
      .prepare('SELECT active,pending FROM gp_partition_storage WHERE partition_id=?')
      .get(partition);
    return { active: Number(row?.active ?? 0), pending: Number(row?.pending ?? 0) };
  }
  admit(header: string, source: string) {
    const extra =
      Buffer.byteLength(header) +
      Buffer.byteLength(source) +
      overhead +
      GROUP_PUBLICATION_RECEIPT_SLOT_BYTES +
      overhead;
    if (this.usage().bytes + extra > PUBLICATION_LIMITS.journalBytes)
      throw new Error('Publication receipt storage full');
  }
  /** The caller allocates this slot in the operation's admission transaction,
   * before handing an effect to the transport. Old pending rows are additive. */
  ensure(operationId: string) {
    if (this.db.prepare('SELECT 1 FROM gp_receipt_slots WHERE operation_id=?').get(operationId))
      return;
    if (
      this.usage().bytes + GROUP_PUBLICATION_RECEIPT_SLOT_BYTES + overhead >
      PUBLICATION_LIMITS.journalBytes
    )
      throw new Error('Publication receipt storage full');
    this.db
      .prepare('INSERT INTO gp_receipt_slots(operation_id,body) VALUES(?,?)')
      .run(operationId, new Uint8Array(GROUP_PUBLICATION_RECEIPT_SLOT_BYTES));
  }
  committed(operationId: string): Extract<PublicationReceipt, { state: 'committed' }> | undefined {
    const row = this.db
      .prepare('SELECT committed,body FROM gp_receipt_slots WHERE operation_id=?')
      .get(operationId);
    if (!row || row.committed !== 1) return;
    const body = row.body;
    if (!(body instanceof Uint8Array) || body.byteLength !== GROUP_PUBLICATION_RECEIPT_SLOT_BYTES)
      throw new Error('Invalid publication receipt slot');
    const bytes = Buffer.from(body),
      length = bytes.readUInt32BE(0);
    if (
      !length ||
      length > PUBLICATION_LIMITS.receiptBytes ||
      bytes.subarray(length + 4).some((byte) => byte !== 0)
    )
      throw new Error('Invalid publication receipt slot');
    const receipt = publicationReceiptSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, length + 4))),
    );
    if (
      receipt.operationId !== operationId ||
      receipt.state !== 'committed' ||
      publicationCanonical(receipt) !== bytes.subarray(4, length + 4).toString('utf8')
    )
      throw new Error('Invalid publication receipt slot');
    return receipt;
  }
  retain(receipt: PublicationReceipt) {
    const old = this.committed(receipt.operationId);
    if (old) {
      if (publicationCanonical(old) !== publicationCanonical(receipt))
        throw new Error('Committed receipt changed');
      return;
    }
    const exact = Buffer.from(publicationCanonical(publicationReceiptSchema.parse(receipt)));
    if (receipt.state !== 'committed' || exact.length > PUBLICATION_LIMITS.receiptBytes)
      throw new Error('Invalid committed receipt');
    const body = Buffer.alloc(GROUP_PUBLICATION_RECEIPT_SLOT_BYTES);
    body.writeUInt32BE(exact.length);
    exact.copy(body, 4);
    const result = this.db
      .prepare(
        'UPDATE gp_receipt_slots SET committed=1,body=? WHERE operation_id=? AND committed=0',
      )
      .run(body, receipt.operationId);
    if (result.changes !== 1) throw new Error('Publication receipt slot missing');
  }
}
