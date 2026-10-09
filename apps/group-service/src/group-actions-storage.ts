import { GROUP_ACTION_LIMITS } from '@dock/shared/dist/group-actions.js';
import {
  GroupActionsStorageLimit,
  type GroupActionsAccountingIntent,
} from '@dock/shared/dist/group-actions-authority.js';
import { GroupFeatureStorage, GroupFeatureStorageLimit } from './group-feature-storage.js';

const schema = `
CREATE TABLE IF NOT EXISTS ga_lifecycle_reservations(action_id TEXT PRIMARY KEY,logical INTEGER NOT NULL,physical INTEGER NOT NULL,remaining_logical INTEGER NOT NULL,remaining_physical INTEGER NOT NULL,released INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER IF NOT EXISTS ga_reserve_capacity_insert AFTER INSERT ON ga_lifecycle_reservations BEGIN UPDATE delivery_control SET future_physical=future_physical+NEW.remaining_physical WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS ga_reserve_capacity_update AFTER UPDATE ON ga_lifecycle_reservations BEGIN UPDATE delivery_control SET future_physical=future_physical+NEW.remaining_physical-OLD.remaining_physical WHERE singleton=1; END;
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
export class GroupActionsStorage {
  private features!: GroupFeatureStorage;
  constructor(private readonly storage: DurableObjectStorage) {}
  private rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...values: SqlStorageValue[]
  ) {
    return this.storage.sql.exec<T>(query, ...values).toArray();
  }
  private logical(): number {
    return this.features.bytes(tables);
  }
  private fence(retained = false) {
    try {
      this.features.fence(retained);
    } catch (error) {
      if (error instanceof GroupFeatureStorageLimit) throw new GroupActionsStorageLimit();
      throw error;
    }
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
    this.features = new GroupFeatureStorage(this.storage);
    this.storage.sql.exec(schema).toArray();
    for (const table of tables) this.features.track(table);
    const logicalBefore = this.logical();
    // Legacy accepted actions acquire the same reservation atomically; failures
    // retain all legacy rows, receipts and events without resetting identities.
    this.rows(
      'CREATE TABLE IF NOT EXISTS ga_capacity_migration(singleton INTEGER PRIMARY KEY CHECK(singleton=1))',
    );
    if (
      !this.rows('SELECT singleton FROM ga_capacity_migration').length &&
      this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='ga_actions'").length
    )
      for (const row of this.rows<{ action_id: string }>(
        "SELECT action_id FROM ga_actions WHERE json_extract(body,'$.state') IN ('pending-owner','dispatching','uncertain') AND NOT EXISTS(SELECT 1 FROM ga_lifecycle_reservations r WHERE r.action_id=ga_actions.action_id)",
      ))
        this.reserve(
          row.action_id,
          GROUP_ACTION_LIMITS.lifecycleLogicalReserve,
          GROUP_ACTION_LIMITS.lifecyclePhysicalReserve,
        );
    this.rows('INSERT OR IGNORE INTO ga_capacity_migration VALUES(1)');
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
    this.fence(intent.kind === 'read' || Boolean(reserved));
    return result;
  }
}
