import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  digest,
  GroupGitBlocked,
  type GitEvent,
  type GitJournal,
  type GitOperation,
  type OperationState,
} from './group-git.js';
import type { CopySnapshot, SnapshotLedger } from './group-git-snapshot.js';

export interface GitExecutor {
  readonly id: string;
  /** This is a host supervisor, never a browser assertion. Unknown includes an unrecorded
   * spawn window, surviving descendants and PID reuse. Only positive quiescence permits release. */
  quiescent(executorId: string, repositoryId: string): Promise<boolean>;
}
const json = (value: unknown): string => {
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > 2 * 1024 * 1024)
    throw new GroupGitBlocked('Git journal record limit');
  return result;
};
const schema = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA max_page_count=16384;
PRAGMA busy_timeout=3000;
CREATE TABLE IF NOT EXISTS gg_schema(version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gg_operations(id TEXT PRIMARY KEY, repository TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gg_transitions(sequence INTEGER PRIMARY KEY, id TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gg_leases(repository TEXT PRIMARY KEY, executor TEXT NOT NULL, token TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gg_outbox(id TEXT PRIMARY KEY, repository TEXT NOT NULL, grant_revision TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gg_acks(id TEXT PRIMARY KEY REFERENCES gg_outbox(id));
CREATE TABLE IF NOT EXISTS gg_state(key TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gg_history(sequence INTEGER PRIMARY KEY, key TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS gg_transitions_immutable_update BEFORE UPDATE ON gg_transitions BEGIN SELECT RAISE(ABORT,'immutable Git transition'); END;
CREATE TRIGGER IF NOT EXISTS gg_transitions_immutable_delete BEFORE DELETE ON gg_transitions BEGIN SELECT RAISE(ABORT,'immutable Git transition'); END;
CREATE TRIGGER IF NOT EXISTS gg_outbox_immutable_update BEFORE UPDATE ON gg_outbox BEGIN SELECT RAISE(ABORT,'immutable Git event'); END;
CREATE TRIGGER IF NOT EXISTS gg_outbox_immutable_delete BEFORE DELETE ON gg_outbox BEGIN SELECT RAISE(ABORT,'immutable Git event'); END;
CREATE TRIGGER IF NOT EXISTS gg_history_immutable_update BEFORE UPDATE ON gg_history BEGIN SELECT RAISE(ABORT,'immutable Git history'); END;
CREATE TRIGGER IF NOT EXISTS gg_history_immutable_delete BEFORE DELETE ON gg_history BEGIN SELECT RAISE(ABORT,'immutable Git history'); END;
`;

/** Durable cross-process exclusion has no timeout/lease expiry. Recovery always consults
 * the original executor's supervisor. Receipts/history are retained at the bounded capacity. */
export class SqliteGitJournal implements GitJournal, SnapshotLedger {
  readonly #db: DatabaseSync;
  readonly #held = new Set<string>();
  constructor(
    path: string,
    readonly executor: GitExecutor,
    private readonly maxRecords = 8192,
  ) {
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(schema);
      const rows = this.#db.prepare('SELECT version FROM gg_schema').all();
      if (rows.length && (rows.length !== 1 || rows[0].version !== 1))
        throw new Error('Unsupported Git journal schema');
      if (!rows.length) this.#db.prepare('INSERT INTO gg_schema VALUES (1)').run();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  close(): void {
    if (this.#held.size) throw new Error('Git executor still holds exclusion');
    this.#db.close();
  }
  transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  #capacity(table: 'gg_operations' | 'gg_transitions' | 'gg_outbox' | 'gg_state' | 'gg_history') {
    const count = this.#db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n as number;
    if (count >= this.maxRecords * (table === 'gg_transitions' || table === 'gg_history' ? 16 : 1))
      throw new GroupGitBlocked('Git journal capacity; retain history and request archival');
  }
  async exclusive<T>(repositoryId: string, work: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    this.transaction(() => {
      if (this.#db.prepare('SELECT 1 FROM gg_leases WHERE repository=?').get(repositoryId))
        throw new GroupGitBlocked('Git resource is fenced by an existing executor');
      this.#db
        .prepare('INSERT INTO gg_leases VALUES (?,?,?)')
        .run(repositoryId, this.executor.id, token);
    });
    this.#held.add(repositoryId);
    try {
      return await work();
    } finally {
      try {
        if (await this.executor.quiescent(this.executor.id, repositoryId))
          this.#db
            .prepare('DELETE FROM gg_leases WHERE repository=? AND token=?')
            .run(repositoryId, token);
      } finally {
        this.#held.delete(repositoryId);
      }
    }
  }
  async recover(repositoryId: string): Promise<boolean> {
    const row = this.#db
      .prepare('SELECT executor,token FROM gg_leases WHERE repository=?')
      .get(repositoryId) as { executor: string; token: string } | undefined;
    if (!row) return true;
    if (!(await this.executor.quiescent(row.executor, repositoryId))) return false;
    return (
      this.#db
        .prepare('DELETE FROM gg_leases WHERE repository=? AND executor=? AND token=?')
        .run(repositoryId, row.executor, row.token).changes === 1
    );
  }
  operation(id: string): GitOperation | null {
    const row = this.#db.prepare('SELECT payload FROM gg_operations WHERE id=?').get(id);
    return row ? (JSON.parse(row.payload as string) as GitOperation) : null;
  }
  begin(operation: GitOperation): GitOperation {
    return this.transaction(() => {
      const prior = this.operation(operation.id);
      if (prior) {
        if (
          prior.payloadHash !== operation.payloadHash ||
          prior.repositoryId !== operation.repositoryId
        )
          throw new GroupGitBlocked(
            'Operation payload changed; explicit retained-operation disposition required',
          );
        return prior;
      }
      const uncertain = this.#db
        .prepare(
          `SELECT id FROM gg_operations
        WHERE repository=? AND json_extract(payload,'$.state') IN ('running','uncertain')
        AND json_type(payload,'$.result.effectIntent') IS NOT NULL LIMIT 1`,
        )
        .get(operation.repositoryId);
      if (uncertain)
        throw new GroupGitBlocked(
          'Resource has an uncertain effect; new IDs cannot bypass passive reconciliation',
        );
      this.#capacity('gg_operations');
      this.#db
        .prepare('INSERT INTO gg_operations VALUES (?,?,?)')
        .run(operation.id, operation.repositoryId, json(operation));
      return structuredClone(operation);
    });
  }
  record(id: string, state: OperationState, result?: unknown, event?: GitEvent): void {
    this.transaction(() => {
      const prior = this.operation(id);
      if (!prior) throw new Error('Unknown Git operation');
      if (prior.state === 'verified' || prior.state === 'blocked') {
        if (
          prior.state === state &&
          (result === undefined || digest(prior.result) === digest(result))
        )
          return;
        throw new GroupGitBlocked('Terminal Git receipt is immutable');
      }
      this.#capacity('gg_transitions');
      const next = { ...prior, state, ...(result === undefined ? {} : { result }) };
      this.#db.prepare('UPDATE gg_operations SET payload=? WHERE id=?').run(json(next), id);
      this.#db.prepare('INSERT INTO gg_transitions(id,payload) VALUES (?,?)').run(id, json(next));
      if (event)
        this.enqueue(
          event.id,
          event.repositoryId,
          this.get<{ grantRevision: string }>(`scope:${event.repositoryId}`)?.grantRevision ?? '',
          event,
        );
    });
  }
  get<T>(key: string): T | null {
    const row = this.#db.prepare('SELECT payload FROM gg_state WHERE key=?').get(key);
    return row ? (JSON.parse(row.payload as string) as T) : null;
  }
  /** Call in transaction when combining scope/schedule/intent changes with outbox events. */
  put(key: string, value: unknown, expected?: unknown): void {
    const prior = this.get(key);
    if (expected !== undefined && digest(prior) !== digest(expected))
      throw new GroupGitBlocked('Git state revision changed');
    if (digest(prior) === digest(value)) return;
    if (!prior) this.#capacity('gg_state');
    this.#capacity('gg_history');
    const payload = json(value);
    this.#db
      .prepare(
        'INSERT INTO gg_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload',
      )
      .run(key, payload);
    this.#db.prepare('INSERT INTO gg_history(key,payload) VALUES (?,?)').run(key, payload);
  }
  enqueue(id: string, repositoryId: string, grantRevision: string, value: unknown): void {
    const payload = json(value);
    const prior = this.#db
      .prepare('SELECT repository,grant_revision,payload FROM gg_outbox WHERE id=?')
      .get(id);
    if (prior) {
      if (
        prior.repository !== repositoryId ||
        prior.grant_revision !== grantRevision ||
        prior.payload !== payload
      )
        throw new GroupGitBlocked('Git event ID collision');
      return;
    }
    this.#capacity('gg_outbox');
    this.#db
      .prepare('INSERT INTO gg_outbox VALUES (?,?,?,?)')
      .run(id, repositoryId, grantRevision, payload);
  }
  pending(
    repositoryId: string,
    grantRevision: string,
    limit = 32,
  ): { id: string; value: unknown }[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 128)
      throw new Error('Git outbox page limit');
    return this.#db
      .prepare(
        'SELECT id,payload FROM gg_outbox WHERE repository=? AND grant_revision=? AND id NOT IN (SELECT id FROM gg_acks) ORDER BY rowid LIMIT ?',
      )
      .all(repositoryId, grantRevision, limit)
      .map((row) => ({ id: row.id as string, value: JSON.parse(row.payload as string) }));
  }
  acknowledge(repositoryId: string, grantRevision: string, id: string): void {
    this.#db
      .prepare(
        'INSERT OR IGNORE INTO gg_acks SELECT id FROM gg_outbox WHERE id=? AND repository=? AND grant_revision=?',
      )
      .run(id, repositoryId, grantRevision);
  }
  current(copyId: string): CopySnapshot | null {
    return this.get(`snapshot:${copyId}`);
  }
  save(previous: CopySnapshot | null, snapshot: CopySnapshot): void {
    this.transaction(() => {
      this.put(`snapshot:${snapshot.copyId}`, snapshot, previous);
      if (previous?.revision !== snapshot.revision || previous.epoch !== snapshot.epoch)
        this.enqueue(
          `snapshot_${snapshot.copyId}_${snapshot.epoch}_${snapshot.revision}`,
          snapshot.repositoryId,
          snapshot.policyRevision,
          snapshot,
        );
    });
  }
}
