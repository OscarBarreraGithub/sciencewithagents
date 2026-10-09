import { DELIVERY_LIMITS } from '@dock/shared/dist/group-delivery.js';
import { GROUP_ACTION_LIMITS } from '@dock/shared/dist/group-actions.js';
import {
  GroupActionsStorageLimit,
  type GroupActionsAccountingIntent,
} from '@dock/shared/dist/group-actions-authority.js';
import { MEMBERSHIP_CAPACITY as C } from './capacity.js';

const schema = `
CREATE TABLE IF NOT EXISTS ga_lifecycle_reservations(action_id TEXT PRIMARY KEY,logical INTEGER NOT NULL,physical INTEGER NOT NULL,remaining_logical INTEGER NOT NULL,remaining_physical INTEGER NOT NULL,released INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER IF NOT EXISTS ga_lifecycle_reservations_retain BEFORE DELETE ON ga_lifecycle_reservations BEGIN SELECT RAISE(ABORT,'retained action reservation'); END;
CREATE TRIGGER IF NOT EXISTS ga_lifecycle_reservations_identity BEFORE UPDATE ON ga_lifecycle_reservations WHEN NEW.action_id<>OLD.action_id OR NEW.logical<>OLD.logical OR NEW.physical<>OLD.physical OR NEW.remaining_logical>OLD.remaining_logical OR NEW.remaining_physical>OLD.remaining_physical OR OLD.released=1 BEGIN SELECT RAISE(ABORT,'immutable action reservation'); END;`;
const tables = [
  'ga_instructions',
  'ga_manager_bindings',
  'ga_work',
  'ga_proposals',
  'ga_actions',
  'ga_receipts',
  'ga_events',
  'ga_notices',
  'ga_human_confirmations',
  'ga_retained_receipts',
  'ga_lifecycle_reservations',
] as const;
/** Included in delivery_control totals, so ordinary delivery/document writes
 * cannot spend accepted actions' future receipt space. No additional budget. */
export function actionReservedPhysical(sql: SqlStorage): number {
  if (
    !sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ga_lifecycle_reservations'",
      )
      .toArray().length
  )
    return 0;
  return Number(
    sql
      .exec<{
        n: number;
      }>(
        'SELECT coalesce(sum(remaining_physical),0) n FROM ga_lifecycle_reservations WHERE released=0',
      )
      .one().n,
  );
}
export class GroupActionsStorage {
  constructor(private readonly storage: DurableObjectStorage) {}
  private rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...values: SqlStorageValue[]
  ) {
    return this.storage.sql.exec<T>(query, ...values).toArray();
  }
  private logical(): number {
    let bytes = 0;
    for (const table of tables) {
      if (!this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).length)
        continue;
      // Count every stored column, including receipt requests/responses and IDs.
      const columns = this.rows<{ name: string }>(`PRAGMA table_info(${table})`).map(
        (row) => row.name,
      );
      const expression = columns
        .map((column) => `coalesce(length(CAST(${column} AS BLOB)),0)`)
        .join('+');
      bytes += Number(
        this.rows<{ n: number }>(`SELECT coalesce(sum(${expression}+128),0) n FROM ${table}`)[0].n,
      );
    }
    return bytes;
  }
  private control() {
    return this.rows<{ logical: number; allocated: number }>(
      'SELECT logical,allocated FROM delivery_control WHERE singleton=1',
    )[0];
  }
  private fence() {
    const control = this.control();
    if (
      control.logical > DELIVERY_LIMITS.logicalBytes ||
      control.allocated > DELIVERY_LIMITS.databaseBytes ||
      this.storage.sql.databaseSize + actionReservedPhysical(this.storage.sql) >
        C.normalDatabaseBytes + DELIVERY_LIMITS.databaseBytes
    )
      throw new GroupActionsStorageLimit();
  }
  reserve(actionId: string, logical: number, physical: number) {
    if (
      logical !== GROUP_ACTION_LIMITS.lifecycleLogicalReserve ||
      physical !== GROUP_ACTION_LIMITS.lifecyclePhysicalReserve
    )
      throw new GroupActionsStorageLimit();
    const prior = this.rows(
      'SELECT action_id FROM ga_lifecycle_reservations WHERE action_id=?',
      actionId,
    )[0];
    if (prior) return;
    this.rows(
      'INSERT INTO ga_lifecycle_reservations VALUES(?,?,?,?,?,0)',
      actionId,
      logical,
      physical,
      logical,
      physical,
    );
    this.rows(
      'UPDATE delivery_control SET logical=logical+?,allocated=allocated+? WHERE singleton=1',
      logical,
      physical,
    );
    this.fence();
  }
  release(actionId: string) {
    const prior = this.rows<{
      remaining_logical: number;
      remaining_physical: number;
      released: number;
    }>(
      'SELECT remaining_logical,remaining_physical,released FROM ga_lifecycle_reservations WHERE action_id=?',
      actionId,
    )[0];
    if (!prior || prior.released) return;
    this.rows(
      'UPDATE delivery_control SET logical=logical-?,allocated=allocated-? WHERE singleton=1',
      prior.remaining_logical,
      prior.remaining_physical,
    );
    this.rows(
      'UPDATE ga_lifecycle_reservations SET remaining_logical=0,remaining_physical=0,released=1 WHERE action_id=?',
      actionId,
    );
  }
  /** Caller already holds the current-membership synchronous transaction. */
  account<T>(operation: () => T, intent: GroupActionsAccountingIntent): T {
    const physicalBefore = this.storage.sql.databaseSize;
    const logicalBefore = this.logical();
    this.storage.sql.exec(schema).toArray();
    // Legacy accepted actions acquire the same reservation atomically; failures
    // retain all legacy rows, receipts and events without resetting identities.
    if (this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='ga_actions'").length)
      for (const row of this.rows<{ action_id: string }>(
        "SELECT action_id FROM ga_actions WHERE json_extract(body,'$.state') IN ('pending-owner','dispatching','uncertain') AND NOT EXISTS(SELECT 1 FROM ga_lifecycle_reservations r WHERE r.action_id=ga_actions.action_id)",
      ))
        this.reserve(
          row.action_id,
          GROUP_ACTION_LIMITS.lifecycleLogicalReserve,
          GROUP_ACTION_LIMITS.lifecyclePhysicalReserve,
        );
    const reserved =
      intent.kind === 'lifecycle'
        ? this.rows<{ remaining_logical: number; remaining_physical: number; released: number }>(
            'SELECT remaining_logical,remaining_physical,released FROM ga_lifecycle_reservations WHERE action_id=?',
            intent.actionId,
          )[0]
        : undefined;
    const result = operation();
    const logical = Math.max(0, this.logical() - logicalBefore);
    const physical = Math.max(0, this.storage.sql.databaseSize - physicalBefore);
    if (reserved && !reserved.released) {
      if (logical > reserved.remaining_logical || physical > reserved.remaining_physical)
        throw new GroupActionsStorageLimit();
      const current = this.rows<{ released: number }>(
        'SELECT released FROM ga_lifecycle_reservations WHERE action_id=?',
        intent.kind === 'lifecycle' ? intent.actionId : '',
      )[0];
      if (current?.released) {
        // release() removed unused reservation during this operation; account
        // its actual immutable writes after that release.
        this.rows(
          'UPDATE delivery_control SET logical=logical+?,allocated=allocated+? WHERE singleton=1',
          logical,
          physical,
        );
      } else {
        this.rows(
          'UPDATE ga_lifecycle_reservations SET remaining_logical=remaining_logical-?,remaining_physical=remaining_physical-? WHERE action_id=?',
          logical,
          physical,
          intent.kind === 'lifecycle' ? intent.actionId : '',
        );
      }
    } else
      this.rows(
        'UPDATE delivery_control SET logical=logical+?,allocated=allocated+? WHERE singleton=1',
        logical,
        physical,
      );
    this.fence();
    return result;
  }
}
