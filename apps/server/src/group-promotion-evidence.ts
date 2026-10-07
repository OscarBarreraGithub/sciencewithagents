import { DatabaseSync } from 'node:sqlite';
import {
  groupPromotionEvidenceSchema,
  type GroupPromotionEvidence,
} from '@dock/shared/dist/group-promotion.js';
import { GROUP_PROMOTION_LIMITS } from '@dock/shared/dist/group-promotion.js';
import { GroupEventRepository, type GroupAccess } from './group-events.js';
import { publicationCanonical } from './group-publication-protocol.js';

/** Local verified shared evidence index, never a source-selection/global-history
 * database. Exact originals remain in GroupEventRepository's immutable chunks. */
export class GroupPromotionEvidenceIndex {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly events: GroupEventRepository,
  ) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA max_page_count=2048;
        CREATE TABLE IF NOT EXISTS group_promotion_evidence (
          event_id TEXT PRIMARY KEY, local_group_id TEXT NOT NULL,
          authority_group_id TEXT NOT NULL, source_id TEXT NOT NULL, version TEXT NOT NULL,
          evidence_json TEXT NOT NULL, UNIQUE(authority_group_id,source_id,version)
        );
        CREATE TRIGGER IF NOT EXISTS group_promotion_evidence_no_update BEFORE UPDATE ON group_promotion_evidence BEGIN SELECT RAISE(ABORT,'immutable promotion evidence'); END;
        CREATE TRIGGER IF NOT EXISTS group_promotion_evidence_no_delete BEFORE DELETE ON group_promotion_evidence BEGIN SELECT RAISE(ABORT,'retain promotion evidence'); END;`);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  close() {
    this.db.close();
  }
  /** Called only after source verification and event append; repeats compare exact
   * immutable evidence. No private originals, summary context, or tool lines here. */
  record(raw: GroupPromotionEvidence): void {
    const value = groupPromotionEvidenceSchema.parse(raw);
    if (value.scope.visibility !== 'shared') throw new Error('Shared evidence required');
    const access = this.events.trustedHostScope(value.scope);
    const event = this.events.sharedPublication(access, [value.eventId])[0].event;
    if (
      event.scope.groupId !== value.scope.groupId ||
      publicationCanonical(event.scope.causalRefs) !== publicationCanonical(value.causalRefs) ||
      publicationCanonical(value.scope.causalRefs) !== publicationCanonical(value.causalRefs) ||
      publicationCanonical(event.evidenceRefs) !== publicationCanonical(value.evidenceRefs) ||
      event.corrects !== value.corrects
    )
      throw new Error('Evidence differs from verified event');
    const exact = publicationCanonical(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db
        .prepare(
          'SELECT evidence_json FROM group_promotion_evidence WHERE event_id=? OR (authority_group_id=? AND source_id=? AND version=?)',
        )
        .get(
          value.eventId,
          value.identity.key.groupId,
          value.identity.key.sourceId,
          value.identity.key.version,
        ) as { evidence_json: string } | undefined;
      if (prior) {
        if (prior.evidence_json !== exact) throw new Error('Promotion evidence collision');
      } else {
        const count = this.db
          .prepare('SELECT count(*) n FROM group_promotion_evidence WHERE local_group_id=?')
          .get(value.scope.groupId) as { n: number };
        if (count.n >= GROUP_PROMOTION_LIMITS.receipts)
          throw new Error('Promotion evidence capacity');
        this.db
          .prepare('INSERT INTO group_promotion_evidence VALUES(?,?,?,?,?,?)')
          .run(
            value.eventId,
            value.scope.groupId,
            value.identity.key.groupId,
            value.identity.key.sourceId,
            value.identity.key.version,
            exact,
          );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  /** Bounded catch-up port. Repository authorizes EVERY event before index lookup;
   * private aside access may read shared events but never another private source. */
  records(access: GroupAccess, eventIds: string[]): GroupPromotionEvidence[] {
    if (eventIds.length > 50 || new Set(eventIds).size !== eventIds.length)
      throw new Error('Bounded unique evidence IDs required');
    return eventIds.flatMap((id) => {
      const { event } = this.events.expand(access, id);
      if (event.scope.visibility !== 'shared') throw new Error('Shared evidence required');
      const row = this.db
        .prepare(
          'SELECT evidence_json FROM group_promotion_evidence WHERE event_id=? AND local_group_id=?',
        )
        .get(event.eventId, event.scope.groupId) as { evidence_json: string } | undefined;
      return row ? [groupPromotionEvidenceSchema.parse(JSON.parse(row.evidence_json))] : [];
    });
  }
}
