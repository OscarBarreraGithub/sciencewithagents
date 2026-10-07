import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { GROUP_LIMITS, groupSourceSchema } from '@dock/shared';
import { GroupEventRepository, type GroupAccess } from './group-events.js';
import {
  PUBLICATION_LIMITS as LIMITS,
  publicationBindingSchema,
  publicationCanonical,
  publicationEffectSchema,
  publicationEnvelope,
  publicationHash,
  publicationHeaderSchema,
  publicationKeySchema,
  publicationReceiptSchema,
  type PublicationBinding,
  type PublicationEffect,
  type PublicationReceipt,
  type PublicationTransport,
} from './group-publication-protocol.js';

export type PublicationState =
  | 'pending'
  | 'complete'
  | 'offline'
  | 'uncertain'
  | 'exhausted'
  | 'collision'
  | 'protocol'
  | 'integrity'
  | 'unauthorized'
  | 'revoked'
  | 'identity_changed'
  | 'invalid'
  | 'capacity'
  | 'storage'
  | 'idle'
  | 'waiting'
  | 'busy';
export class GroupPublicationError extends Error {
  constructor(public readonly code: PublicationState) {
    super(`Group publication: ${code}`);
  }
}
/** Trusted host policy must resolve current persisted membership/context, installation,
 * remote mapping and credential revision. It must never echo browser-supplied identities.
 * Repository-issued access is still independently checked on every boundary.
 */
export type PublicationAuthority = () => { access: GroupAccess; binding: PublicationBinding };
export interface PublicationAccess {
  readonly __publicationAccess: unique symbol;
}
export interface PublicationScheduling {
  now(): number;
  /** Schedule a deadline only; return its cancellation function. No retry timers are created. */
  deadline(callback: () => void, delayMs: number): () => void;
}
const nativeScheduling: PublicationScheduling = {
  now: Date.now,
  deadline(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
const availabilitySchema = z.enum(['offline', 'unauthorized', 'revoked']);
const receiptReplySchema = z.strictObject({
  kind: z.literal('receipt'),
  receipt: publicationReceiptSchema,
});
const queryReplySchema = z.discriminatedUnion('kind', [
  receiptReplySchema,
  z.strictObject({ kind: z.literal('unavailable'), reason: availabilitySchema }),
]);
const effectReplySchema = z.discriminatedUnion('kind', [
  receiptReplySchema,
  z.strictObject({ kind: z.literal('not_sent'), reason: availabilitySchema }),
]);
const refsSchema = z
  .array(z.uuid())
  .min(1)
  .max(GROUP_LIMITS.references)
  .refine((ids) => new Set(ids).size === ids.length);
type Registration = {
  binding: PublicationBinding;
  partition: string;
  authority: PublicationAuthority;
  repositoryAccess?: GroupAccess;
};
type Row = {
  operation_id: string;
  event_id: string;
  header_json: string;
  payload_hash: string;
  header_hash: string;
  source_json: string;
  compact: number;
  receipt_json: string | null;
  state: PublicationState;
  attempts: number;
  budget: number;
  failures: number;
  next_at: number;
  intent: number;
  lease_owner: string | null;
  lease_until: number;
};
// Exhausted rows still admit receipt-only reconciliation; completed/quarantined rows do not.
const terminal = new Set<PublicationState>(['complete', 'collision', 'protocol', 'integrity']);
const fail = (state: PublicationState): never => {
  throw new GroupPublicationError(state);
};
const safeCode = (error: unknown): PublicationState =>
  error instanceof GroupPublicationError ? error.code : 'storage';
// Reserve the old eight-partition active header budget, then budget 8 KiB per
// retained identity (escaped source, receipt, counters and index/page overhead).
// This is a logical bound, not a guarantee of physical fit: SQLite may fill earlier.
const ACTIVE_OPERATIONS = LIMITS.lifetimeOperations;
const HISTORY_OPERATIONS = Math.floor(
  (LIMITS.journalBytes - LIMITS.partitions * ACTIVE_OPERATIONS * LIMITS.headerBytes) / 8192,
);
const compactHeader = (header: string) => publicationHash(header);
const SQL = `
CREATE TABLE IF NOT EXISTS gp_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gp_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1),group_id TEXT NOT NULL,installation_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gp_partitions (partition_id TEXT PRIMARY KEY,binding_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gp_operations (
  operation_id TEXT PRIMARY KEY,partition_id TEXT NOT NULL REFERENCES gp_partitions(partition_id),
  event_id TEXT NOT NULL,header_json TEXT NOT NULL,payload_hash TEXT NOT NULL,
  header_hash TEXT NOT NULL DEFAULT '',source_json TEXT NOT NULL DEFAULT '',
  compact INTEGER NOT NULL DEFAULT 0 CHECK(compact IN (0,1)),
  state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,budget INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,intent INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,receipt_json TEXT,
  UNIQUE(partition_id,event_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS gp_event_identity ON gp_operations(event_id);
CREATE INDEX IF NOT EXISTS gp_due ON gp_operations(partition_id,next_at,operation_id);
CREATE TRIGGER IF NOT EXISTS gp_identity_immutable BEFORE UPDATE OF
  operation_id,partition_id,event_id,payload_hash,header_hash,source_json ON gp_operations
  BEGIN SELECT RAISE(ABORT,'immutable publication identity'); END;
CREATE TRIGGER IF NOT EXISTS gp_header_immutable BEFORE UPDATE OF header_json,compact ON gp_operations
  WHEN COALESCE((OLD.compact=0 AND NEW.compact=1 AND NEW.header_json='' AND
    NEW.state='complete' AND NEW.intent=0 AND NEW.lease_owner IS NULL AND NEW.lease_until=0 AND
    json_extract(NEW.receipt_json,'$.state')='committed' AND
    json_extract(NEW.receipt_json,'$.eventId')=OLD.event_id AND
    json_extract(NEW.receipt_json,'$.operationId')=OLD.operation_id AND
    json_extract(NEW.receipt_json,'$.payloadHash')=OLD.payload_hash AND
    json_extract(NEW.receipt_json,'$.binding')=(SELECT binding_json FROM gp_partitions WHERE partition_id=OLD.partition_id)),0)=0
  BEGIN SELECT RAISE(ABORT,'immutable publication header'); END;
CREATE TRIGGER IF NOT EXISTS gp_complete_immutable BEFORE UPDATE ON gp_operations WHEN OLD.compact=1
  BEGIN SELECT RAISE(ABORT,'retained completed publication'); END;
CREATE TRIGGER IF NOT EXISTS gp_operation_no_delete BEFORE DELETE ON gp_operations
  BEGIN SELECT RAISE(ABORT,'retained publication identity'); END;
CREATE TRIGGER IF NOT EXISTS gp_partition_no_update BEFORE UPDATE ON gp_partitions
  BEGIN SELECT RAISE(ABORT,'immutable publication binding'); END;
CREATE TRIGGER IF NOT EXISTS gp_partition_no_delete BEFORE DELETE ON gp_partitions
  BEGIN SELECT RAISE(ABORT,'retained publication binding'); END;
CREATE TRIGGER IF NOT EXISTS gp_owner_no_update BEFORE UPDATE ON gp_owner
  BEGIN SELECT RAISE(ABORT,'immutable journal owner'); END;
CREATE TRIGGER IF NOT EXISTS gp_owner_no_delete BEFORE DELETE ON gp_owner
  BEGIN SELECT RAISE(ABORT,'retained journal owner'); END;
`;

/** Local-only durable outbox. No runtime route, provider calls, background loop or secrets.
 * The host chooses the database path and authenticated transport, never the browser.
 */
export class GroupPublicationController {
  readonly #db: DatabaseSync;
  readonly #registrations = new WeakMap<PublicationAccess, Registration>();
  constructor(
    path: string,
    readonly repository: GroupEventRepository,
    readonly transport: PublicationTransport,
    readonly scheduling: PublicationScheduling = nativeScheduling,
  ) {
    let opened: DatabaseSync | undefined;
    try {
      opened = new DatabaseSync(path);
      this.#db = opened;
      this.#db.exec(
        'PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE',
      );
      const pageSize = (this.#db.prepare('PRAGMA page_size').get() as { page_size: number })
        .page_size;
      const maxPages = Math.floor(LIMITS.journalBytes / pageSize);
      const actualLimit = this.#db.prepare(`PRAGMA max_page_count=${maxPages}`).get() as {
        max_page_count: number;
      };
      if (actualLimit.max_page_count > maxPages) fail('storage');
      this.#transaction(() => {
        const exists = this.#db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gp_schema'")
          .get();
        const version = exists
          ? (
              this.#db.prepare('SELECT version FROM gp_schema WHERE singleton=1').get() as
                | { version: number }
                | undefined
            )?.version
          : undefined;
        if (exists && version !== 1 && version !== 2 && version !== 3) fail('storage');
        if (!exists) {
          // An unversioned existing history must never be mistaken for a fresh journal.
          if (this.#db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'gp_%'").get())
            fail('storage');
          this.#db.exec(SQL);
          this.#db.prepare('INSERT INTO gp_schema VALUES (1,3)').run();
        } else if (version !== 3) {
          if (version === 1) {
            this.#db.exec('ALTER TABLE gp_operations ADD COLUMN budget INTEGER NOT NULL DEFAULT 0');
            this.#db
              .prepare('UPDATE gp_operations SET budget=MIN(attempts,?)')
              .run(LIMITS.attempts);
          }
          this.#db.exec(`
            ALTER TABLE gp_operations ADD COLUMN header_hash TEXT NOT NULL DEFAULT '';
            ALTER TABLE gp_operations ADD COLUMN source_json TEXT NOT NULL DEFAULT '';
            ALTER TABLE gp_operations ADD COLUMN compact INTEGER NOT NULL DEFAULT 0 CHECK(compact IN (0,1));
            DROP TRIGGER gp_identity_immutable;
          `);
          // Stream bounded rows; no original reconstruction, remote I/O or history reset.
          for (const raw of this.#db.prepare('SELECT * FROM gp_operations').iterate()) {
            const row = raw as Row;
            const header = publicationHeaderSchema.parse(JSON.parse(row.header_json));
            if (publicationCanonical(header) !== row.header_json) fail('storage');
            this.#db
              .prepare('UPDATE gp_operations SET header_hash=?,source_json=? WHERE operation_id=?')
              .run(
                compactHeader(row.header_json),
                publicationCanonical(header.event.scope.source),
                row.operation_id,
              );
          }
          // The unique index rejects duplicates; every legacy identity, receipt and
          // recovery counter is validated before completed representation is changed.
          this.#db.exec(SQL);
          this.#validateHistory();
          this.#db.exec("UPDATE gp_operations SET header_json='',compact=1 WHERE state='complete'");
          this.#db.prepare('UPDATE gp_schema SET version=3 WHERE singleton=1').run();
        }
        this.#validateHistory();
      });
    } catch {
      opened?.close();
      throw new GroupPublicationError('storage');
    }
  }
  #validateHistory(): void {
    const owner = this.#db.prepare('SELECT * FROM gp_owner').all() as {
      singleton: number;
      group_id: string;
      installation_id: string;
    }[];
    const partitions = this.#db.prepare('SELECT * FROM gp_partitions').all() as {
      partition_id: string;
      binding_json: string;
    }[];
    if (
      owner.length > 1 ||
      partitions.length > LIMITS.partitions ||
      (partitions.length > 0 && owner.length !== 1)
    )
      fail('storage');
    const bindings = new Map<string, PublicationBinding>();
    for (const partition of partitions) {
      const binding = publicationBindingSchema.parse(JSON.parse(partition.binding_json));
      if (
        publicationCanonical(binding) !== partition.binding_json ||
        partition.partition_id !==
          publicationHash(
            publicationCanonical([binding.groupId, binding.installationId, binding.epoch]),
          ) ||
        owner[0]?.singleton !== 1 ||
        binding.groupId !== owner[0].group_id ||
        binding.installationId !== owner[0].installation_id
      )
        fail('storage');
      bindings.set(partition.partition_id, binding);
    }
    const events = new Set<string>();
    const active = new Map<string, number>();
    for (const raw of this.#db.prepare('SELECT * FROM gp_operations').iterate()) {
      const row = raw as Row & { partition_id: string };
      const binding = bindings.get(row.partition_id);
      if (
        !binding ||
        events.has(row.event_id) ||
        !z.uuid().safeParse(row.event_id).success ||
        !z.uuid().safeParse(row.operation_id).success ||
        !/^[a-f0-9]{64}$/.test(row.payload_hash) ||
        !/^[a-f0-9]{64}$/.test(row.header_hash) ||
        ![0, 1].includes(row.compact) ||
        ![
          'pending',
          'complete',
          'offline',
          'uncertain',
          'exhausted',
          'collision',
          'protocol',
          'integrity',
          'unauthorized',
          'revoked',
        ].includes(row.state) ||
        ![0, 1].includes(row.intent) ||
        !Number.isSafeInteger(row.attempts) ||
        row.attempts < 0 ||
        row.attempts > 2147483647 ||
        !Number.isSafeInteger(row.budget) ||
        row.budget < 0 ||
        row.budget > LIMITS.attempts ||
        !Number.isSafeInteger(row.failures) ||
        row.failures < 0 ||
        row.failures > LIMITS.attempts ||
        !Number.isSafeInteger(row.next_at) ||
        row.next_at < 0 ||
        !Number.isSafeInteger(row.lease_until) ||
        row.lease_until < 0 ||
        (row.lease_owner !== null && !z.uuid().safeParse(row.lease_owner).success)
      )
        fail('storage');
      events.add(row.event_id);
      if (events.size > HISTORY_OPERATIONS) fail('storage');
      const source = groupSourceSchema.parse(JSON.parse(row.source_json));
      if (publicationCanonical(source) !== row.source_json) fail('storage');
      if (row.compact) {
        if (row.header_json !== '' || row.state !== 'complete') fail('storage');
      } else {
        const header = publicationHeaderSchema.parse(JSON.parse(row.header_json));
        if (
          publicationCanonical(header) !== row.header_json ||
          compactHeader(row.header_json) !== row.header_hash ||
          header.event.eventId !== row.event_id ||
          header.operationId !== row.operation_id ||
          header.payloadHash !== row.payload_hash ||
          publicationCanonical(header.binding) !== publicationCanonical(binding) ||
          publicationCanonical(header.event.scope.source) !== row.source_json
        )
          fail('storage');
        const count = (active.get(row.partition_id) ?? 0) + (row.state === 'complete' ? 0 : 1);
        active.set(row.partition_id, count);
        if (count > ACTIVE_OPERATIONS) fail('storage');
      }
      if (row.state === 'complete') {
        if (
          row.intent !== 0 ||
          row.lease_owner !== null ||
          row.lease_until !== 0 ||
          row.next_at !== 0 ||
          !row.receipt_json
        )
          fail('storage');
        const receipt = publicationReceiptSchema.parse(JSON.parse(row.receipt_json!));
        if (
          publicationCanonical(receipt) !== row.receipt_json ||
          receipt.state !== 'committed' ||
          receipt.eventId !== row.event_id ||
          receipt.operationId !== row.operation_id ||
          receipt.payloadHash !== row.payload_hash ||
          publicationCanonical(receipt.binding) !== publicationCanonical(binding)
        )
          fail('storage');
      } else if (row.receipt_json !== null) fail('storage');
    }
  }
  close(): void {
    this.#db.close();
  }
  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* Preserve sanitized failure. */
      }
      throw error;
    }
  }
  #now(): number {
    const now = this.scheduling.now();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - LIMITS.maxBackoffMs
    )
      fail('invalid');
    return now;
  }
  #authorize(registration: Registration): GroupAccess {
    let current: ReturnType<PublicationAuthority>;
    try {
      current = registration.authority();
    } catch (error) {
      if (error instanceof GroupPublicationError && error.code === 'revoked') throw error;
      return fail('unauthorized');
    }
    // Check live repository authority before exposing identity-change information.
    try {
      this.repository.sharedPublication(current.access, []);
    } catch {
      return fail('unauthorized');
    }
    if (
      registration.repositoryAccess !== undefined &&
      current.access !== registration.repositoryAccess
    )
      fail('unauthorized');
    const binding = publicationBindingSchema.safeParse(current.binding);
    if (!binding.success) return fail('unauthorized');
    if (publicationCanonical(binding.data) !== publicationCanonical(registration.binding))
      fail('identity_changed');
    return current.access;
  }
  #registration(access: PublicationAccess): Registration {
    const registration = this.#registrations.get(access);
    if (!registration) return fail('unauthorized');
    this.#authorize(registration);
    return registration;
  }
  #partition(registration: Registration): void {
    const row = this.#db
      .prepare('SELECT binding_json FROM gp_partitions WHERE partition_id=?')
      .get(registration.partition) as { binding_json: string } | undefined;
    if (!row || row.binding_json !== publicationCanonical(registration.binding))
      fail('identity_changed');
  }
  trustedHostRegister(
    input: PublicationBinding,
    authority: PublicationAuthority,
  ): PublicationAccess {
    try {
      const parsed = publicationBindingSchema.safeParse(input);
      if (!parsed.success) return fail('invalid');
      const binding = parsed.data;
      const registration: Registration = {
        binding,
        authority,
        partition: publicationHash(
          publicationCanonical([binding.groupId, binding.installationId, binding.epoch]),
        ),
      };
      registration.repositoryAccess = this.#authorize(registration);
      this.#transaction(() => {
        const journalOwner = this.#db
          .prepare('SELECT group_id,installation_id FROM gp_owner WHERE singleton=1')
          .get() as { group_id: string; installation_id: string } | undefined;
        if (
          journalOwner &&
          (journalOwner.group_id !== binding.groupId ||
            journalOwner.installation_id !== binding.installationId)
        )
          fail('unauthorized');
        if (!journalOwner)
          this.#db
            .prepare('INSERT INTO gp_owner VALUES (1,?,?)')
            .run(binding.groupId, binding.installationId);
        const existing = this.#db
          .prepare('SELECT 1 FROM gp_partitions WHERE partition_id=?')
          .get(registration.partition);
        if (!existing) {
          const count = (
            this.#db.prepare('SELECT COUNT(*) AS n FROM gp_partitions').get() as { n: number }
          ).n;
          if (count >= LIMITS.partitions) fail('capacity');
          this.#db
            .prepare('INSERT INTO gp_partitions VALUES (?,?)')
            .run(registration.partition, publicationCanonical(binding));
        }
        // Existing differing bindings remain immutable; operations will report identity_changed.
      });
      const handle = Object.freeze({}) as PublicationAccess;
      this.#registrations.set(handle, registration);
      return handle;
    } catch (error) {
      throw new GroupPublicationError(safeCode(error));
    }
  }
  enqueue(access: PublicationAccess, eventIds: string[]): { operations: string[] } {
    try {
      const registration = this.#registration(access);
      const parsed = refsSchema.safeParse(eventIds);
      if (!parsed.success) return fail('invalid');
      const handle = this.#authorize(registration);
      let records: ReturnType<GroupEventRepository['sharedPublication']>;
      try {
        records = this.repository.sharedPublication(handle, parsed.data);
      } catch {
        return fail('unauthorized');
      }
      // This outbox publishes locally authored events for its enrolled installation only.
      if (
        records.some(
          ({ event }) =>
            event.scope.groupId !== registration.binding.groupId ||
            event.scope.installationId !== registration.binding.installationId,
        )
      )
        fail('unauthorized');
      this.#authorize(registration);
      return this.#transaction(() => {
        this.#partition(registration);
        const operations = records.map((record) => {
          const prior = this.#db
            .prepare(
              'SELECT operation_id,partition_id,payload_hash,header_json,header_hash,source_json,compact FROM gp_operations WHERE event_id=?',
            )
            .get(record.event.eventId) as
            | (Pick<
                Row,
                | 'operation_id'
                | 'payload_hash'
                | 'header_json'
                | 'header_hash'
                | 'source_json'
                | 'compact'
              > & {
                partition_id: string;
              })
            | undefined;
          if (prior && prior.partition_id !== registration.partition) fail('identity_changed');
          let envelope;
          try {
            envelope = publicationEnvelope(
              registration.binding,
              prior?.operation_id ?? randomUUID(),
              record,
            );
          } catch {
            return fail('integrity');
          }
          const header = publicationCanonical(envelope.header);
          if (prior) {
            if (
              prior.payload_hash !== envelope.header.payloadHash ||
              prior.header_hash !== compactHeader(header) ||
              prior.source_json !== publicationCanonical(record.event.scope.source) ||
              (!prior.compact && prior.header_json !== header)
            )
              fail('integrity');
            return prior.operation_id;
          }
          const counts = this.#db
            .prepare(
              `SELECT SUM(CASE WHEN state!='complete' THEN 1 ELSE 0 END) AS total,
            SUM(CASE WHEN state NOT IN ('complete','exhausted','collision','protocol','integrity') THEN 1 ELSE 0 END) AS pending
            FROM gp_operations WHERE partition_id=?`,
            )
            .get(registration.partition) as { total: number; pending: number | null };
          if (
            counts.total >= ACTIVE_OPERATIONS ||
            (this.#db.prepare('SELECT COUNT(*) AS n FROM gp_operations').get() as { n: number })
              .n >= HISTORY_OPERATIONS ||
            (counts.pending ?? 0) >= LIMITS.pendingOperations
          )
            fail('capacity');
          this.#db
            .prepare(
              `INSERT INTO gp_operations(operation_id,partition_id,event_id,header_json,payload_hash,header_hash,source_json,state)
            VALUES (?,?,?,?,?,?,?,'pending')`,
            )
            .run(
              envelope.header.operationId,
              registration.partition,
              record.event.eventId,
              header,
              envelope.header.payloadHash,
              compactHeader(header),
              publicationCanonical(record.event.scope.source),
            );
          return envelope.header.operationId;
        });
        return { operations };
      });
    } catch (error) {
      throw new GroupPublicationError(safeCode(error));
    }
  }
  inspect(
    access: PublicationAccess,
    operationId: string,
  ): {
    state: PublicationState;
    attempts?: number;
    budgetAttempts?: number;
    nextAttemptAt?: number;
    uncertain?: boolean;
  } {
    try {
      const registration = this.#registration(access);
      if (!z.uuid().safeParse(operationId).success) return { state: 'invalid' };
      this.#partition(registration);
      const row = this.#db
        .prepare(
          'SELECT state,attempts,budget,next_at,intent FROM gp_operations WHERE partition_id=? AND operation_id=?',
        )
        .get(registration.partition, operationId) as
        | Pick<Row, 'state' | 'attempts' | 'budget' | 'next_at' | 'intent'>
        | undefined;
      return row
        ? {
            state: row.state,
            attempts: row.attempts,
            budgetAttempts: row.budget,
            nextAttemptAt: row.next_at,
            uncertain: row.intent === 1,
          }
        : { state: 'idle' };
    } catch (error) {
      return { state: safeCode(error) };
    }
  }
  #acquire(
    registration: Registration,
    operationId: string | undefined,
    owner: string,
  ): Row | PublicationState {
    return this.#transaction(() => {
      this.#partition(registration);
      const now = this.#now();
      const row = (
        operationId
          ? this.#db
              .prepare('SELECT * FROM gp_operations WHERE partition_id=? AND operation_id=?')
              .get(registration.partition, operationId)
          : this.#db
              .prepare(
                `SELECT * FROM gp_operations WHERE partition_id=? AND state NOT IN ('complete','collision','protocol','integrity')
                AND next_at<=? AND (lease_owner IS NULL OR lease_until<=?)
                ORDER BY next_at,operation_id LIMIT 1`,
              )
              .get(registration.partition, now, now)
      ) as Row | undefined;
      if (!row) {
        if (operationId) return 'idle';
        const blocked = this.#db
          .prepare(
            `SELECT lease_owner,lease_until FROM gp_operations WHERE partition_id=?
          AND state NOT IN ('complete','collision','protocol','integrity')
          ORDER BY next_at,operation_id LIMIT 1`,
          )
          .get(registration.partition) as Pick<Row, 'lease_owner' | 'lease_until'> | undefined;
        return !blocked
          ? 'idle'
          : blocked.lease_owner !== null && blocked.lease_until > now
            ? 'busy'
            : 'waiting';
      }
      if (terminal.has(row.state)) return row.state;
      if (row.lease_owner !== null && row.lease_until > now) return 'busy';
      if (row.next_at > now) return 'waiting';
      this.#db
        .prepare(
          'UPDATE gp_operations SET attempts=MIN(attempts+1,2147483647),lease_owner=?,lease_until=? WHERE operation_id=?',
        )
        .run(owner, now + LIMITS.leaseMs, row.operation_id);
      return {
        ...row,
        attempts: Math.min(row.attempts + 1, 2_147_483_647),
        lease_owner: owner,
        lease_until: now + LIMITS.leaseMs,
      };
    });
  }
  #owned(registration: Registration, row: Row): void {
    this.#authorize(registration);
    this.#partition(registration);
    const current = this.#db
      .prepare(
        'SELECT lease_owner,lease_until FROM gp_operations WHERE partition_id=? AND operation_id=?',
      )
      .get(registration.partition, row.operation_id) as
      | Pick<Row, 'lease_owner' | 'lease_until'>
      | undefined;
    if (!current || current.lease_owner !== row.lease_owner || current.lease_until <= this.#now())
      fail('busy');
  }
  #finish(
    registration: Registration,
    row: Row,
    state: PublicationState,
    uncertain: boolean,
    receipt?: PublicationReceipt,
  ): PublicationState {
    this.#owned(registration, row);
    const exhausted = row.state === 'exhausted' || row.budget >= LIMITS.attempts;
    const progress = state === 'pending' && !exhausted;
    const failures = progress ? 0 : Math.min(row.failures + 1, LIMITS.attempts);
    const delay = progress
      ? LIMITS.progressMs
      : Math.min(LIMITS.maxBackoffMs, LIMITS.backoffMs * 2 ** Math.min(failures - 1, 6));
    const finalState = !terminal.has(state) && exhausted ? 'exhausted' : state;
    // Receipt retention and completion are a single FULL-synchronous SQLite transaction.
    this.#transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE gp_operations SET state=?,budget=?,failures=?,next_at=?,intent=?,
        lease_owner=NULL,lease_until=0,receipt_json=?${finalState === 'complete' ? ",header_json='',compact=1" : ''} WHERE operation_id=? AND lease_owner=? AND lease_until>?`,
        )
        .run(
          finalState,
          row.budget,
          failures,
          terminal.has(finalState) ? 0 : this.#now() + delay,
          uncertain ? 1 : 0,
          receipt ? publicationCanonical(receipt) : null,
          row.operation_id,
          row.lease_owner,
          this.#now(),
        );
      if (result.changes !== 1) fail('busy');
    });
    return finalState;
  }
  async #remote<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController();
    let cancel = () => {};
    try {
      const timeout = new Promise<never>((_, reject) => {
        cancel = this.scheduling.deadline(() => {
          abort.abort();
          reject(new Error('Publication deadline'));
        }, LIMITS.timeoutMs);
      });
      return await Promise.race([
        timeout,
        Promise.resolve().then(() => {
          if (abort.signal.aborted) throw new Error('Publication deadline');
          return work(abort.signal);
        }),
      ]);
    } finally {
      cancel();
    }
  }
  #receipt(raw: unknown, envelope: ReturnType<typeof publicationEnvelope>): PublicationReceipt {
    const parsed = publicationReceiptSchema.safeParse(raw);
    if (!parsed.success) return fail('protocol');
    const receipt = parsed.data;
    const { version, binding, operationId, payloadHash } = envelope.header;
    const key = publicationKeySchema.parse({ version, binding, operationId, payloadHash });
    // Parse a separately constructed key: strict schemas reject the extra receipt/header fields.
    if (
      publicationCanonical({
        version: receipt.version,
        binding: receipt.binding,
        operationId: receipt.operationId,
        payloadHash: receipt.payloadHash,
      }) !== publicationCanonical(key)
    )
      fail('protocol');
    if (receipt.state === 'committed' && receipt.eventId !== envelope.header.event.eventId)
      fail('protocol');
    if (receipt.state === 'staged' && receipt.missing.some((i) => i >= envelope.chunks.length))
      fail('protocol');
    return receipt;
  }
  /** One bounded attempt: <=1 authenticated receipt query and <=1 idempotent effect.
   * Call again only at nextAttemptAt or after an explicit connectivity/owner wake.
   */
  async step(
    access: PublicationAccess,
    operationId?: string,
  ): Promise<{ state: PublicationState }> {
    let registration: Registration | undefined;
    let row: Row | undefined;
    try {
      registration = this.#registration(access);
      if (operationId !== undefined && !z.uuid().safeParse(operationId).success)
        return { state: 'invalid' };
      const acquired = this.#acquire(registration, operationId, randomUUID());
      if (typeof acquired === 'string') return { state: acquired };
      row = acquired;
      this.#owned(registration, row);
      let record;
      try {
        record = this.repository.sharedPublication(this.#authorize(registration), [
          row.event_id,
        ])[0];
      } catch {
        return fail('unauthorized');
      }
      let envelope;
      try {
        envelope = publicationEnvelope(registration.binding, row.operation_id, record);
      } catch {
        return fail('integrity');
      }
      if (
        publicationCanonical(envelope.header) !== row.header_json ||
        envelope.header.payloadHash !== row.payload_hash
      )
        fail('integrity');
      const { version, binding, operationId: id, payloadHash } = envelope.header;
      const key = publicationKeySchema.parse({ version, binding, operationId: id, payloadHash });
      this.#owned(registration, row);
      let rawQuery;
      try {
        rawQuery = await this.#remote((signal) => {
          this.#owned(registration!, row!);
          return this.transport.receipt(structuredClone(key), signal);
        });
      } catch {
        return {
          state: this.#finish(
            registration,
            row,
            row.intent ? 'uncertain' : 'offline',
            row.intent === 1,
          ),
        };
      }
      this.#owned(registration, row);
      const query = queryReplySchema.safeParse(rawQuery);
      if (!query.success) return fail('protocol');
      if (query.data.kind === 'unavailable')
        return { state: this.#finish(registration, row, query.data.reason, row.intent === 1) };
      const receipt = this.#receipt(query.data.receipt, envelope);
      if (receipt.state === 'collision')
        return { state: this.#finish(registration, row, 'collision', row.intent === 1) };
      if (receipt.state === 'committed')
        return { state: this.#finish(registration, row, 'complete', false, receipt) };
      // Exhaustion limits effects, not receipt reconciliation. Keep prior intent
      // and identity; only a committed receipt above may finish without a new effect.
      if (row.state === 'exhausted' || row.budget >= LIMITS.attempts)
        return { state: this.#finish(registration, row, 'exhausted', row.intent === 1) };
      let effect: PublicationEffect;
      if (receipt.state === 'absent') effect = { kind: 'begin', header: envelope.header };
      else if (receipt.missing.length)
        effect = { kind: 'chunk', key, chunk: envelope.chunks[receipt.missing[0]] };
      else effect = { kind: 'commit', key };
      effect = publicationEffectSchema.parse(effect);
      this.#owned(registration, row);
      // Commit effect intent before handing any bytes to the transport.
      // Every newly attempted effect gets its own slot, including retries after an
      // authoritative absent/staged receipt. Receipt-only work never spends a slot.
      const budget = row.budget + 1;
      const intent = this.#db
        .prepare(
          'UPDATE gp_operations SET intent=1,budget=? WHERE operation_id=? AND lease_owner=? AND lease_until>?',
        )
        .run(budget, row.operation_id, row.lease_owner, this.#now());
      if (intent.changes !== 1) fail('busy');
      row.budget = budget;
      row.intent = 1;
      this.#owned(registration, row);
      let rawEffect;
      try {
        rawEffect = await this.#remote((signal) => {
          this.#owned(registration!, row!);
          return this.transport.effect(structuredClone(effect), signal);
        });
      } catch {
        return { state: this.#finish(registration, row, 'uncertain', true) };
      }
      this.#owned(registration, row);
      const reply = effectReplySchema.safeParse(rawEffect);
      if (!reply.success) return fail('protocol');
      if (reply.data.kind === 'not_sent') {
        // The query reconciled previous intent and this effect definitely did not occur.
        // Refund only this step's reserved slot; diagnostic attempts remain saturating.
        row.budget--;
        return { state: this.#finish(registration, row, reply.data.reason, false) };
      }
      const result = this.#receipt(reply.data.receipt, envelope);
      if (result.state === 'collision')
        return { state: this.#finish(registration, row, 'collision', true) };
      if (
        result.state === 'absent' ||
        (effect.kind === 'chunk' &&
          result.state === 'staged' &&
          result.missing.includes(effect.chunk.index)) ||
        (effect.kind === 'commit' && result.state !== 'committed')
      )
        fail('protocol');
      return {
        state: this.#finish(
          registration,
          row,
          result.state === 'committed' ? 'complete' : 'pending',
          false,
          result.state === 'committed' ? result : undefined,
        ),
      };
    } catch (error) {
      const state = safeCode(error);
      // Never touch or disclose the journal after failed authorization. An abandoned lease expires.
      if (registration && row && (state === 'protocol' || state === 'integrity')) {
        try {
          return { state: this.#finish(registration, row, state, row.intent === 1) };
        } catch (finishError) {
          return { state: safeCode(finishError) };
        }
      }
      return { state };
    }
  }
}
