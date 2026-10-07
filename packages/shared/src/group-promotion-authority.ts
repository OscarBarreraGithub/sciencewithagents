import {
  GROUP_PROMOTION_LIMITS as L,
  groupPromotionCommandSchema,
  groupPromotionReceiptSchema,
  groupPromotionDispositionSchema,
  type GroupPromotionCommand,
  type GroupPromotionIdentity,
  type GroupPromotionReceipt,
  type GroupPromotionReply,
} from './group-promotion.js';
import {
  groupIdSchema,
  groupInstallationIdSchema,
  type GroupId,
  type GroupInstallationId,
} from './groups.js';

/** Implement using the existing group DO's sql.exec().toArray()/transactionSync().
 * Node test authorities share ONE database, never one per installation. */
export interface GroupPromotionSql {
  rows<T extends Record<string, string | number | null>>(
    sql: string,
    ...args: (string | number | null)[]
  ): T[];
  transaction<T>(work: () => T): T;
}
export interface GroupPromotionActor {
  groupId: GroupId;
  installationId: GroupInstallationId;
}
export interface GroupPromotionPolicy {
  /** Must synchronously revalidate membership, source registration, shared visibility,
   * immutable version/digest and current capacity in the SAME group transaction. */
  authorize(actor: GroupPromotionActor, identity: GroupPromotionIdentity): void;
  /** Explicit creator/manager policy; a reserve call cannot appoint its own writer. */
  authorizeWriter(actor: GroupPromotionActor, writer: GroupInstallationId): void;
  /** Existing DO allocation/physical/logical/free-tier guard; throw to roll back.
   * Includes these tables in the existing budget, never a second storage allowance. */
  checkCapacity(): void;
  /** Verify the existing delivery authority's committed operation/event in this
   * same transaction. A local event or caller's 'complete' flag is insufficient. */
  verifyPublished(
    actor: GroupPromotionActor,
    identity: GroupPromotionIdentity,
    eventId: string,
    operationId: string,
  ): void;
  /** Explicit owner/manager recovery only. Verify the exact source/version and
   * evidence; verified-not-launched requires proof no admitted turn/effect exists.
   * The promotion controller never invokes this or mutates underlying work. */
  authorizeDisposition(
    actor: GroupPromotionActor,
    identity: GroupPromotionIdentity,
    disposition: ReturnType<typeof groupPromotionDispositionSchema.parse>,
  ): void;
  now(): number;
  id(): string;
}
export const GROUP_PROMOTION_SQL = `
CREATE TABLE IF NOT EXISTS group_promotion_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS group_promotion_writers (
 group_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_promotion_receipts (
 group_id TEXT NOT NULL, source_id TEXT NOT NULL, version TEXT NOT NULL,
 source_hash TEXT NOT NULL, receipt_json TEXT NOT NULL,
 PRIMARY KEY(group_id,source_id,version)
);
CREATE TABLE IF NOT EXISTS group_promotion_transitions (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL, source_id TEXT NOT NULL, version TEXT NOT NULL,
 kind TEXT NOT NULL, receipt_json TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS group_promotion_transition_no_update BEFORE UPDATE ON group_promotion_transitions BEGIN SELECT RAISE(ABORT,'immutable promotion evidence'); END;
CREATE TRIGGER IF NOT EXISTS group_promotion_transition_no_delete BEFORE DELETE ON group_promotion_transitions BEGIN SELECT RAISE(ABORT,'immutable promotion evidence'); END;
CREATE TRIGGER IF NOT EXISTS group_promotion_receipt_no_delete BEFORE DELETE ON group_promotion_receipts BEGIN SELECT RAISE(ABORT,'retain promotion receipt'); END;
CREATE TRIGGER IF NOT EXISTS group_promotion_receipt_identity BEFORE UPDATE ON group_promotion_receipts
WHEN NEW.group_id<>OLD.group_id OR NEW.source_id<>OLD.source_id OR NEW.version<>OLD.version OR NEW.source_hash<>OLD.source_hash
 OR json_extract(NEW.receipt_json,'$.identity') IS NOT json_extract(OLD.receipt_json,'$.identity')
 OR json_extract(NEW.receipt_json,'$.operationId') IS NOT json_extract(OLD.receipt_json,'$.operationId')
 OR json_extract(NEW.receipt_json,'$.entityId') IS NOT json_extract(OLD.receipt_json,'$.entityId')
 OR json_extract(NEW.receipt_json,'$.synthesisId') IS NOT json_extract(OLD.receipt_json,'$.synthesisId')
 OR json_extract(NEW.receipt_json,'$.writerId') IS NOT json_extract(OLD.receipt_json,'$.writerId')
 OR (json_extract(OLD.receipt_json,'$.decision') IS NOT NULL AND json_extract(NEW.receipt_json,'$.decision') IS NOT json_extract(OLD.receipt_json,'$.decision'))
 OR (json_extract(OLD.receipt_json,'$.eventId') IS NOT NULL AND json_extract(NEW.receipt_json,'$.eventId') IS NOT json_extract(OLD.receipt_json,'$.eventId'))
 OR (json_extract(OLD.receipt_json,'$.publicationOperationId') IS NOT NULL AND json_extract(NEW.receipt_json,'$.publicationOperationId') IS NOT json_extract(OLD.receipt_json,'$.publicationOperationId'))
 OR (json_extract(OLD.receipt_json,'$.disposition') IS NOT NULL AND json_extract(NEW.receipt_json,'$.disposition') IS NOT json_extract(OLD.receipt_json,'$.disposition'))
 OR (json_extract(OLD.receipt_json,'$.synthesisStarted')=1 AND json_extract(NEW.receipt_json,'$.synthesisStarted')<>1)
BEGIN SELECT RAISE(ABORT,'immutable promotion identity'); END;
`;
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  return JSON.stringify(v);
};
/** Bounded shared authority, NOT a network authentication implementation. */
export class GroupPromotionAuthority {
  constructor(
    private readonly sql: GroupPromotionSql,
    private readonly policy: GroupPromotionPolicy,
  ) {
    sql.transaction(() => {
      sql.rows(GROUP_PROMOTION_SQL);
      const version = sql.rows<{ version: number }>(
        'SELECT version FROM group_promotion_schema WHERE singleton=1',
      )[0];
      if (version && version.version !== 1) throw new Error('Unsupported promotion schema');
      if (!version) sql.rows('INSERT INTO group_promotion_schema VALUES(1,1)');
      policy.checkCapacity();
    });
  }
  /** Renewal is explicit. Expiry never transfers uncertain synthesis to another executor.
   * Changing writer is blocked while any receipt is unfinished. */
  designate(actor: GroupPromotionActor, writer: GroupInstallationId): void {
    groupIdSchema.parse(actor.groupId);
    groupInstallationIdSchema.parse(writer);
    this.sql.transaction(() => {
      this.policy.authorizeWriter(actor, writer);
      const prior = this.writer(actor.groupId);
      if (prior && prior.installation_id !== writer) {
        const pending = this.sql.rows<{ n: number }>(
          `SELECT count(*) n FROM group_promotion_receipts WHERE group_id=? AND json_extract(receipt_json,'$.publicationOperationId') IS NULL AND json_extract(receipt_json,'$.disposition') IS NULL`,
          actor.groupId,
        )[0].n;
        if (pending) throw new Error('Unfinished promotion retains its designated executor');
      }
      this.sql.rows(
        `INSERT INTO group_promotion_writers VALUES(?,?,?) ON CONFLICT(group_id) DO UPDATE SET installation_id=excluded.installation_id,expires=excluded.expires`,
        actor.groupId,
        writer,
        this.policy.now() + L.leaseMs,
      );
      this.policy.checkCapacity();
    });
  }
  private writer(groupId: GroupId) {
    return this.sql.rows<{ installation_id: string; expires: number }>(
      `SELECT installation_id,expires FROM group_promotion_writers WHERE group_id=?`,
      groupId,
    )[0];
  }
  handle(actor: GroupPromotionActor, raw: GroupPromotionCommand): GroupPromotionReply {
    const c = groupPromotionCommandSchema.parse(raw);
    return this.sql.transaction(() => {
      // Authorization precedes both receipt lookup and any mutation.
      this.policy.authorize(actor, c.identity);
      if (actor.groupId !== c.identity.key.groupId)
        return { kind: 'unavailable', reason: 'denied' };
      const writer = this.writer(actor.groupId);
      if (!writer || writer.expires <= this.policy.now())
        return { kind: 'unavailable', reason: 'writer_unavailable' };
      if (writer.installation_id !== actor.installationId)
        return { kind: 'unavailable', reason: 'not_writer' };
      const { groupId, sourceId, version } = c.identity.key;
      const prior = this.sql.rows<{ source_hash: string; receipt_json: string }>(
        `SELECT source_hash,receipt_json FROM group_promotion_receipts WHERE group_id=? AND source_id=? AND version=?`,
        groupId,
        sourceId,
        version,
      )[0];
      if (prior && prior.source_hash !== c.identity.sourceHash)
        return { kind: 'unavailable', reason: 'collision' };
      let r: GroupPromotionReceipt;
      let acquired = false;
      if (!prior) {
        if (c.kind !== 'reserve') return { kind: 'unavailable', reason: 'denied' };
        if (
          this.sql.rows<{ n: number }>(
            `SELECT count(*) n FROM group_promotion_receipts WHERE group_id=?`,
            groupId,
          )[0].n >= L.receipts
        )
          return { kind: 'unavailable', reason: 'limit' };
        r = groupPromotionReceiptSchema.parse({
          identity: c.identity,
          writerId: actor.installationId,
          operationId: this.policy.id(),
          entityId: this.policy.id(),
          synthesisId: this.policy.id(),
          synthesisStarted: false,
          decision: null,
          eventId: null,
          publicationOperationId: null,
          disposition: null,
        });
        this.sql.rows(
          `INSERT INTO group_promotion_receipts VALUES(?,?,?,?,?)`,
          groupId,
          sourceId,
          version,
          c.identity.sourceHash,
          canonical(r),
        );
        acquired = true;
      } else r = groupPromotionReceiptSchema.parse(JSON.parse(prior.receipt_json));
      if (r.writerId !== actor.installationId) return { kind: 'unavailable', reason: 'not_writer' };
      if (r.disposition && c.kind !== 'reserve' && c.kind !== 'dispose')
        return { kind: 'unavailable', reason: 'denied' };
      if (c.kind === 'startSynthesis' && !r.synthesisStarted && !r.decision) {
        r.synthesisStarted = true;
        acquired = true;
      } else if (c.kind === 'decide') {
        if (r.decision && canonical(r.decision) !== canonical(c.decision))
          return { kind: 'unavailable', reason: 'collision' };
        if (!r.decision) {
          r.decision = c.decision;
          acquired = true;
        }
      } else if (c.kind === 'bindEvent') {
        if (!r.decision || (r.eventId && r.eventId !== c.eventId))
          return { kind: 'unavailable', reason: 'collision' };
        if (!r.eventId) {
          r.eventId = c.eventId;
          acquired = true;
        }
      } else if (c.kind === 'published') {
        if (
          r.eventId !== c.eventId ||
          (r.publicationOperationId && r.publicationOperationId !== c.publicationOperationId)
        )
          return { kind: 'unavailable', reason: 'collision' };
        this.policy.verifyPublished(actor, c.identity, c.eventId, c.publicationOperationId);
        if (!r.publicationOperationId) {
          r.publicationOperationId = c.publicationOperationId;
          acquired = true;
        }
      } else if (c.kind === 'dispose') {
        if (
          r.eventId ||
          (r.disposition && canonical(r.disposition) !== canonical(c.disposition)) ||
          (r.synthesisStarted && !r.decision && c.disposition.reason !== 'verified-not-launched')
        )
          return { kind: 'unavailable', reason: 'collision' };
        this.policy.authorizeDisposition(actor, c.identity, c.disposition);
        if (!r.disposition) {
          r.disposition = c.disposition;
          acquired = true;
        }
      }
      if (acquired) {
        const exact = canonical(r);
        this.sql.rows(
          `UPDATE group_promotion_receipts SET receipt_json=? WHERE group_id=? AND source_id=? AND version=?`,
          exact,
          groupId,
          sourceId,
          version,
        );
        this.sql.rows(
          `INSERT INTO group_promotion_transitions VALUES(?,?,?,?,?,?)`,
          this.policy.id(),
          groupId,
          sourceId,
          version,
          c.kind,
          exact,
        );
        this.policy.checkCapacity();
      }
      return { kind: 'receipt', receipt: r, acquired };
    });
  }
}
