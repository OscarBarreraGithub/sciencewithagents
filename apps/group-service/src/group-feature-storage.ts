import { DELIVERY_LIMITS as L } from '@dock/shared/dist/group-delivery.js';
import { MEMBERSHIP_CAPACITY as C } from './capacity.js';

export class GroupFeatureStorageLimit extends Error {}
const schema = `
CREATE TABLE IF NOT EXISTS delivery_feature_reservations(id TEXT PRIMARY KEY,logical INTEGER NOT NULL,physical INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS delivery_feature_table_bytes(name TEXT PRIMARY KEY,bytes INTEGER NOT NULL,n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS delivery_feature_capacity_version(singleton INTEGER PRIMARY KEY CHECK(singleton=1));
CREATE TRIGGER IF NOT EXISTS delivery_feature_reservations_insert AFTER INSERT ON delivery_feature_reservations BEGIN UPDATE delivery_control SET future_physical=future_physical+NEW.physical WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS delivery_feature_reservations_update AFTER UPDATE ON delivery_feature_reservations BEGIN UPDATE delivery_control SET future_physical=future_physical+NEW.physical-OLD.physical WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS delivery_feature_reservations_delete AFTER DELETE ON delivery_feature_reservations BEGIN UPDATE delivery_control SET future_physical=future_physical-OLD.physical WHERE singleton=1; END;
`;
/** One shared allocation, including every accepted operation's future growth.
 * Callers hold the current-authority synchronous transaction. No remote quota is reserved. */
export class GroupFeatureStorage {
  constructor(private readonly storage: DurableObjectStorage) {
    const sql = storage.sql;
    if (
      !sql
        .exec<{ name: string }>('PRAGMA table_info(delivery_control)')
        .toArray()
        .some((r) => r.name === 'future_physical')
    )
      sql
        .exec('ALTER TABLE delivery_control ADD COLUMN future_physical INTEGER NOT NULL DEFAULT 0')
        .toArray();
    sql.exec(schema).toArray();
    if (!sql.exec('SELECT singleton FROM delivery_feature_capacity_version').toArray().length) {
      const actions = sql
        .exec("SELECT name FROM sqlite_master WHERE name='ga_lifecycle_reservations'")
        .toArray().length
        ? sql
            .exec<{
              n: number;
            }>(
              'SELECT coalesce(sum(remaining_physical),0) n FROM ga_lifecycle_reservations WHERE released=0',
            )
            .one().n
        : 0;
      sql
        .exec('UPDATE delivery_control SET future_physical=? WHERE singleton=1', actions)
        .toArray();
      sql.exec('INSERT INTO delivery_feature_capacity_version VALUES(1)').toArray();
    }
  }
  control() {
    return this.storage.sql
      .exec<{
        allocated: number;
        logical: number;
        future_physical: number;
      }>('SELECT allocated,logical,future_physical FROM delivery_control WHERE singleton=1')
      .one();
  }
  fence(retained = false) {
    const c = this.control();
    if (
      c.logical > L.logicalBytes ||
      c.allocated > L.databaseBytes ||
      this.storage.sql.databaseSize + c.future_physical >
        (retained ? C.reservedDatabaseBytes : C.normalDatabaseBytes) + L.databaseBytes
    )
      throw new GroupFeatureStorageLimit();
  }
  reserve(id: string, logical: number, physical: number) {
    if (
      this.storage.sql.exec('SELECT id FROM delivery_feature_reservations WHERE id=?', id).toArray()
        .length
    )
      return;
    this.storage.sql
      .exec('INSERT INTO delivery_feature_reservations VALUES(?,?,?)', id, logical, physical)
      .toArray();
    this.storage.sql
      .exec(
        'UPDATE delivery_control SET logical=logical+?,allocated=allocated+? WHERE singleton=1',
        logical,
        physical,
      )
      .toArray();
    this.fence();
  }
  reservation(id: string) {
    return this.storage.sql
      .exec<{
        logical: number;
        physical: number;
      }>('SELECT logical,physical FROM delivery_feature_reservations WHERE id=?', id)
      .toArray()[0];
  }
  /** Consume only this exact operation's reservation; other admission cannot borrow it. */
  account(work: () => void, logical: number, id?: string) {
    const c = this.control();
    const reserve = id ? this.reservation(id) : undefined;
    if (logical < 0 || (!reserve && c.logical + logical > L.logicalBytes))
      throw new GroupFeatureStorageLimit();
    const before = this.storage.sql.databaseSize;
    work();
    this.consume(before, logical, id);
  }
  consume(before: number, logical: number, id?: string, retainedRead = false) {
    const reserve = id ? this.reservation(id) : undefined;
    const delta = this.storage.sql.databaseSize - before;
    const physical = Math.max(0, delta);
    if (reserve) {
      if (logical > reserve.logical || physical > reserve.physical)
        throw new GroupFeatureStorageLimit();
      this.storage.sql
        .exec(
          'UPDATE delivery_feature_reservations SET logical=logical-?,physical=physical-? WHERE id=?',
          logical,
          physical,
          id!,
        )
        .toArray();
    } else
      this.storage.sql
        .exec(
          'UPDATE delivery_control SET logical=logical+?,allocated=allocated+? WHERE singleton=1',
          logical,
          physical,
        )
        .toArray();
    if (delta < 0)
      this.storage.sql
        .exec('UPDATE delivery_control SET allocated=allocated+? WHERE singleton=1', delta)
        .toArray();
    // Revocation may grow the membership trees into their protected envelope.
    // Existing exact reservations and authorized reads keep that separate space;
    // every new reservation still passes the ordinary admission fence above.
    this.fence(Boolean(reserve) || retainedRead);
  }
  release(id: string) {
    const r = this.reservation(id);
    if (!r) return;
    this.storage.sql
      .exec(
        'UPDATE delivery_control SET logical=logical-?,allocated=allocated-? WHERE singleton=1',
        r.logical,
        r.physical,
      )
      .toArray();
    this.storage.sql.exec('DELETE FROM delivery_feature_reservations WHERE id=?', id).toArray();
  }
  /** Once per table backfill; UTF-8 bytes and row counts update in O(1).
   * Table/column names come only from fixed server schemas, never request values. */
  track(table: string) {
    if (
      this.storage.sql
        .exec('SELECT name FROM delivery_feature_table_bytes WHERE name=?', table)
        .toArray().length
    )
      return;
    const columns = this.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((r) => r.name);
    if (!columns.length) return;
    const expr = (prefix: string) =>
      columns.map((c) => `coalesce(length(CAST(${prefix}${c} AS BLOB)),0)`).join('+') + '+128';
    this.storage.sql
      .exec(
        `INSERT INTO delivery_feature_table_bytes SELECT ?,coalesce(sum(${expr('')}),0),count(*) FROM ${table}`,
        table,
      )
      .toArray();
    this.storage.sql
      .exec(
        `CREATE TRIGGER ${table}_capacity_insert AFTER INSERT ON ${table} BEGIN UPDATE delivery_feature_table_bytes SET bytes=bytes+${expr('NEW.')},n=n+1 WHERE name='${table}'; END;
CREATE TRIGGER ${table}_capacity_update AFTER UPDATE ON ${table} BEGIN UPDATE delivery_feature_table_bytes SET bytes=bytes+(${expr('NEW.')})-(${expr('OLD.')} ) WHERE name='${table}'; END;
CREATE TRIGGER ${table}_capacity_delete AFTER DELETE ON ${table} BEGIN UPDATE delivery_feature_table_bytes SET bytes=bytes-(${expr('OLD.')}),n=n-1 WHERE name='${table}'; END;`,
      )
      .toArray();
  }
  bytes(tables: readonly string[]) {
    return tables.reduce(
      (n, table) =>
        n +
        (this.storage.sql
          .exec<{
            bytes: number;
          }>('SELECT bytes FROM delivery_feature_table_bytes WHERE name=?', table)
          .toArray()[0]?.bytes ?? 0),
      0,
    );
  }
  count(table: string) {
    this.track(table);
    return (
      this.storage.sql
        .exec<{ n: number }>('SELECT n FROM delivery_feature_table_bytes WHERE name=?', table)
        .toArray()[0]?.n ?? 0
    );
  }
}
/** Worst JSON escaping (six bytes per source byte), two payload copies/pages,
 * chunk tree overhead and bounded control/index rebalancing. Unused space is released. */
export const publicationGrowthReserve = (bytes: number, chunks: number) => ({
  logical: bytes * 6 + chunks * 512 + 4096,
  physical: (bytes * 6 + chunks * 512 + 4096) * 2 + chunks * 65536 + 512 * 1024,
});
export const documentGrowthReserve = (bytes: number, chunks: number) =>
  bytes * 2 + chunks * 65536 + 512 * 1024;
