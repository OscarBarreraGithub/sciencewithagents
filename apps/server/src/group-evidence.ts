import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { groupEventSchema, type GroupEvent } from '@dock/shared';
import {
  GROUP_EVIDENCE_LIMITS as LIMITS,
  groupEvidenceFactsSchema,
  groupEvidenceQuerySchema,
  groupEvidenceRecordSchema,
  groupEvidencePageSchema,
  type GroupEvidenceFacts,
  type GroupEvidenceQuery,
  type GroupEvidenceRecord,
  type GroupEvidencePage,
} from '@dock/shared/dist/group-evidence.js';
import {
  catchupCanonical,
  catchupFail,
  evidenceReaderKey,
  type GroupCatchupReader,
} from './group-catchup-context.js';
import type { GroupCatchupStore } from './group-catchup.js';
/** Promotion owns this authenticated source lookup. No browser/agent write operation exposes it. */
export interface GroupEvidenceSourcePort {
  readVerifiedShared(
    reader: GroupCatchupReader,
    eventId: GroupEvent['eventId'],
  ): Promise<GroupEvidenceRecord>;
}
type Cursor = {
  index_revision: number;
  query_id: string;
  reader_key: string;
  query_json: string;
  watermark: number;
  after_position: number;
  limit_count: number;
  unknown_json: string;
};
const categoryKind = {
  Decision: 'decision',
  Action: 'action',
  Finding: 'finding',
  Conflict: 'conflict',
  Blocker: 'blocker',
  Instruction: 'instruction',
  Question: 'question',
  Idea: 'idea',
} as const;
export class GroupEvidenceIndex {
  readonly #db: DatabaseSync;
  #writingRevision = 0;
  constructor(
    path: string,
    readonly source?: GroupEvidenceSourcePort,
  ) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA max_page_count=16384;
      CREATE TABLE IF NOT EXISTS gqe_events(group_id TEXT NOT NULL,sequence INTEGER NOT NULL,event_id TEXT NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(group_id,sequence),UNIQUE(group_id,event_id));
      CREATE TABLE IF NOT EXISTS gqe_facts(group_id TEXT NOT NULL,event_id TEXT NOT NULL,facts_json TEXT NOT NULL,indexed_revision INTEGER NOT NULL,PRIMARY KEY(group_id,event_id));
      CREATE TABLE IF NOT EXISTS gqe_terms(group_id TEXT NOT NULL,term_type TEXT NOT NULL,term_value TEXT NOT NULL,sequence INTEGER NOT NULL,event_id TEXT NOT NULL,indexed_revision INTEGER NOT NULL,PRIMARY KEY(group_id,term_type,term_value,sequence));
      CREATE TABLE IF NOT EXISTS gqe_clock(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO gqe_clock VALUES(1,0);
      CREATE TABLE IF NOT EXISTS gqe_groups(group_id TEXT PRIMARY KEY,watermark INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gqe_cursors(token TEXT PRIMARY KEY,query_id TEXT NOT NULL,reader_key TEXT NOT NULL,query_json TEXT NOT NULL,watermark INTEGER NOT NULL,after_position INTEGER NOT NULL,limit_count INTEGER NOT NULL,unknown_json TEXT NOT NULL,index_revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gqe_requests(query_id TEXT NOT NULL,reader_key TEXT NOT NULL,query_json TEXT NOT NULL,watermark INTEGER NOT NULL,after_position INTEGER NOT NULL,limit_count INTEGER NOT NULL,unknown_json TEXT NOT NULL,index_revision INTEGER NOT NULL,PRIMARY KEY(query_id,reader_key));
      CREATE UNIQUE INDEX IF NOT EXISTS gqe_cursor_replay ON gqe_cursors(query_id,reader_key,query_json,watermark,after_position,limit_count,unknown_json,index_revision);
      CREATE TRIGGER IF NOT EXISTS gqe_terms_immutable_update BEFORE UPDATE ON gqe_terms BEGIN SELECT RAISE(ABORT,'immutable terms'); END;
      CREATE TRIGGER IF NOT EXISTS gqe_terms_immutable_delete BEFORE DELETE ON gqe_terms BEGIN SELECT RAISE(ABORT,'immutable terms'); END;
      CREATE TRIGGER IF NOT EXISTS gqe_events_immutable_update BEFORE UPDATE ON gqe_events BEGIN SELECT RAISE(ABORT,'immutable shared index'); END;
      CREATE TRIGGER IF NOT EXISTS gqe_events_immutable_delete BEFORE DELETE ON gqe_events BEGIN SELECT RAISE(ABORT,'immutable shared index'); END;
      CREATE TRIGGER IF NOT EXISTS gqe_facts_immutable_update BEFORE UPDATE ON gqe_facts BEGIN SELECT RAISE(ABORT,'immutable facts'); END;
      CREATE TRIGGER IF NOT EXISTS gqe_facts_immutable_delete BEFORE DELETE ON gqe_facts BEGIN SELECT RAISE(ABORT,'immutable facts'); END;`);
  }
  close() {
    this.#db.close();
  }
  #tx<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const v = fn();
      this.#db.exec('COMMIT');
      return v;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  #advance() {
    this.#db.prepare('UPDATE gqe_clock SET revision=revision+1 WHERE singleton=1').run();
    this.#writingRevision = (
      this.#db.prepare('SELECT revision FROM gqe_clock WHERE singleton=1').get() as {
        revision: number;
      }
    ).revision;
  }
  #term(event: GroupEvent, type: string, value: string) {
    this.#db
      .prepare('INSERT OR IGNORE INTO gqe_terms VALUES(?,?,?,?,?,?)')
      .run(event.scope.groupId, type, value, event.sequence, event.eventId, this.#writingRevision);
  }
  #save(event: GroupEvent, facts: GroupEvidenceFacts | null) {
    const group = event.scope.groupId;
    const json = catchupCanonical(event);
    const old = this.#db
      .prepare('SELECT event_json FROM gqe_events WHERE group_id=? AND (event_id=? OR sequence=?)')
      .get(group, event.eventId, event.sequence) as { event_json: string } | undefined;
    if (old && old.event_json !== json)
      catchupFail('conflict', 'Verified shared source identity changed.');
    if (!old) {
      this.#advance();
      if (
        (this.#db.prepare('SELECT count(*) AS n FROM gqe_events').get() as { n: number }).n >=
        LIMITS.records
      )
        catchupFail('limit', 'Shared source index capacity reached.');
      this.#db
        .prepare('INSERT INTO gqe_events VALUES(?,?,?,?)')
        .run(group, event.sequence, event.eventId, json);
      this.#term(event, 'all', '*');
      this.#term(event, 'event', event.eventId);
      this.#term(event, 'kind', categoryKind[event.category]);
      this.#term(event, 'subject', event.entityId);
      for (const id of event.scope.causalRefs) this.#term(event, 'causal', id);
      this.#db.prepare('INSERT OR IGNORE INTO gqe_groups VALUES(?,0)').run(group);
      const prior = (
        this.#db.prepare('SELECT watermark FROM gqe_groups WHERE group_id=?').get(group) as {
          watermark: number;
        }
      ).watermark;
      let position = prior;
      while (
        this.#db
          .prepare('SELECT 1 FROM gqe_events WHERE group_id=? AND sequence=?')
          .get(group, position + 1)
      )
        position++;
      this.#db.prepare('UPDATE gqe_groups SET watermark=? WHERE group_id=?').run(position, group);
    }
    if (facts) {
      const originalIds = Object.values(facts.originalIds).filter(
        (id): id is string => id !== null,
      );
      const known = new Set([
        event.eventId,
        event.entityId,
        event.scope.memberId,
        event.scope.source.messageId,
        facts.sourceId,
        ...originalIds,
        ...event.scope.causalRefs,
        ...event.evidenceRefs,
      ]);
      if (
        facts.instructionIds.some(
          (id) =>
            !event.scope.causalRefs.includes(id as GroupEvent['eventId']) &&
            !event.evidenceRefs.includes(id as GroupEvent['eventId']),
        ) ||
        facts.subjectIds.some((id) => !known.has(id)) ||
        facts.edges.some((e) => !known.has(e.fromId) || !known.has(e.toId))
      )
        catchupFail(
          'conflict',
          'Source facts reference identifiers absent from the verified original record.',
        );
      const fjson = catchupCanonical(facts);
      const prior = this.#db
        .prepare('SELECT facts_json FROM gqe_facts WHERE group_id=? AND event_id=?')
        .get(group, event.eventId) as { facts_json: string } | undefined;
      if (prior && prior.facts_json !== fjson)
        catchupFail('conflict', 'Immutable source facts changed.');
      if (!prior) {
        this.#advance();
        this.#db
          .prepare('INSERT INTO gqe_facts VALUES(?,?,?,?)')
          .run(group, event.eventId, fjson, this.#writingRevision);
        for (const kind of facts.kinds) this.#term(event, 'kind', kind);
        for (const id of facts.subjectIds) this.#term(event, 'subject', id);
        for (const path of facts.paths) this.#term(event, 'path', path);
        for (const id of facts.instructionIds) this.#term(event, 'instruction', id);
        if (facts.autonomous === true && facts.kinds.includes('decision'))
          this.#term(event, 'autonomous', 'true');
        if (facts.unresolved !== null) {
          this.#term(event, 'unresolved_state', event.entityId);
          if (facts.unresolved) this.#term(event, 'unresolved', 'true');
        }
      }
    }
  }
  /** Cache already authenticated shared pages. Rich facts only come from the promotion port. */
  async observePage(reader: GroupCatchupReader, events: GroupEvent[]): Promise<void> {
    await reader.revalidate();
    const parsed = events.map((e) => groupEventSchema.parse(e));
    if (
      parsed.length > 8 ||
      parsed.some(
        (e) => e.scope.visibility !== 'shared' || e.scope.groupId !== reader.context.groupId,
      )
    )
      catchupFail('conflict', "Only this enrollment's authenticated shared page may be indexed.");
    this.#tx(() => parsed.forEach((e) => this.#save(e, null)));
  }
  async pageEvidence(
    reader: GroupCatchupReader,
    events: GroupEvent[],
  ): Promise<{ eventId: string; facts: GroupEvidenceFacts | null }[]> {
    await reader.revalidate();
    if (events.length > 8) catchupFail('limit', 'At most eight delivered sources may be expanded.');
    return events.map((event) => {
      if (event.scope.groupId !== reader.context.groupId || event.scope.visibility !== 'shared')
        catchupFail('conflict', 'Shared source does not belong to this enrollment.');
      const row = this.#db
        .prepare(
          'SELECT e.event_json,f.facts_json FROM gqe_events e LEFT JOIN gqe_facts f ON f.group_id=e.group_id AND f.event_id=e.event_id WHERE e.group_id=? AND e.event_id=?',
        )
        .get(event.scope.groupId, event.eventId) as
        | { event_json: string; facts_json: string | null }
        | undefined;
      if (row && row.event_json !== catchupCanonical(event))
        catchupFail('conflict', 'Indexed original differs from the delivered shared source.');
      return {
        eventId: event.eventId,
        facts: row?.facts_json ? groupEvidenceFactsSchema.parse(JSON.parse(row.facts_json)) : null,
      };
    });
  }
  async ingestVerifiedShared(
    reader: GroupCatchupReader,
    eventId: GroupEvent['eventId'],
  ): Promise<void> {
    if (!this.source) catchupFail('conflict', 'Verified promotion source port is unavailable.');
    await reader.revalidate();
    const record = groupEvidenceRecordSchema.parse(
      await this.source.readVerifiedShared(reader, eventId),
    );
    if (
      record.event.eventId !== eventId ||
      record.event.scope.groupId !== reader.context.groupId ||
      record.event.scope.visibility !== 'shared'
    )
      catchupFail('conflict', 'Promotion source is not an exact shared record.');
    // A known immutable original can arrive before its authoritative task/action
    // registration. Keep unknown facts absent so later verified indexing can add
    // them without rewriting any previously asserted fact or pinned query.
    if (!record.facts) return;
    const page = await reader.readShared({
      visibility: 'shared',
      after: record.event.sequence - 1,
      limit: 1,
      cursor: null,
    });
    if (!page.entries[0] || catchupCanonical(page.entries[0]) !== catchupCanonical(record.event))
      catchupFail(
        'conflict',
        'Promotion record is not the hosted shared source at this exact position.',
      );
    await reader.revalidate();
    this.#tx(() => this.#save(record.event, groupEvidenceFactsSchema.parse(record.facts)));
  }
  #anchor(query: GroupEvidenceQuery): [string, string] {
    switch (query.type) {
      case 'who_working':
        return ['subject', query.memberId];
      case 'why_stopped':
        return ['subject', query.subjectId];
      case 'instruction_actions':
        return ['instruction', query.instructionEventId];
      case 'file_changes':
        return ['path', query.path];
      case 'unresolved':
        return ['unresolved', 'true'];
      case 'autonomous_decisions':
        return ['autonomous', 'true'];
      case 'who_decided':
        return ['event', query.eventId];
      default:
        return ['all', '*'];
    }
  }
  #sql(query: GroupEvidenceQuery): string {
    const extra =
      query.type === 'who_decided'
        ? ' AND e.event_id=?'
        : query.type === 'unresolved'
          ? ` AND NOT EXISTS(SELECT 1 FROM gqe_terms newer WHERE newer.group_id=e.group_id AND newer.term_type='unresolved_state' AND newer.term_value=json_extract(e.event_json,'$.entityId') AND newer.sequence>e.sequence AND newer.sequence<=? AND newer.indexed_revision<=?)`
          : '';
    return `SELECT e.event_json,f.facts_json FROM gqe_terms t JOIN gqe_events e ON e.group_id=t.group_id AND e.sequence=t.sequence LEFT JOIN gqe_facts f ON f.group_id=e.group_id AND f.event_id=e.event_id AND f.indexed_revision<=? WHERE t.group_id=? AND t.term_type=? AND t.term_value=? AND t.sequence>? AND t.sequence<=? AND t.indexed_revision<=?${extra} ORDER BY t.sequence LIMIT ?`;
  }
  #params(
    group: string,
    query: GroupEvidenceQuery,
    after: number,
    watermark: number,
    limit: number,
    indexRevision: number,
  ): (string | number)[] {
    return [
      indexRevision,
      group,
      ...this.#anchor(query),
      after,
      watermark,
      indexRevision,
      ...(query.type === 'who_decided'
        ? [query.eventId]
        : query.type === 'unresolved'
          ? [watermark, indexRevision]
          : []),
      limit,
    ];
  }
  queryPlan(query: GroupEvidenceQuery): string[] {
    const q = groupEvidenceQuerySchema.parse(query);
    return this.#db
      .prepare(`EXPLAIN QUERY PLAN ${this.#sql(q)}`)
      .all(...this.#params('plan', q, 0, 1, 1, 1))
      .map((r) => String(r.detail));
  }
  async query(
    reader: GroupCatchupReader,
    raw: GroupEvidenceQuery,
    limit: number,
    continuation: string | null,
    catchup: GroupCatchupStore,
    queryId: string,
  ): Promise<GroupEvidencePage> {
    const query = groupEvidenceQuerySchema.parse(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.pageSize)
      catchupFail('limit', 'Query page limit must be between one and eight.');
    await reader.revalidate();
    const key = evidenceReaderKey(reader);
    if (!z.uuid().safeParse(queryId).success)
      catchupFail('invalid_cursor', 'An exact generated query identity is required.');
    const qjson = catchupCanonical(query);
    const group = reader.context.groupId;
    let watermark: number, after: number, unknown: string[], indexRevision: number;
    if (continuation) {
      const cursor = this.#db
        .prepare('SELECT * FROM gqe_cursors WHERE token=? AND reader_key=? AND query_id=?')
        .get(continuation, key, queryId) as Cursor | undefined;
      if (!cursor || cursor.query_json !== qjson || cursor.limit_count !== limit)
        catchupFail(
          'invalid_cursor',
          'Query continuation belongs to another aside, member, group or query.',
        );
      ({ watermark, after_position: after, index_revision: indexRevision } = cursor);
      unknown = JSON.parse(cursor.unknown_json) as string[];
    } else {
      const request = this.#db
        .prepare('SELECT * FROM gqe_requests WHERE query_id=? AND reader_key=?')
        .get(queryId, key) as Cursor | undefined;
      if (request) {
        if (request.query_json !== qjson || request.limit_count !== limit)
          catchupFail('conflict', 'Query identity was reused with changed parameters.');
        ({ watermark, after_position: after, index_revision: indexRevision } = request);
        unknown = JSON.parse(request.unknown_json) as string[];
      } else {
        indexRevision = (
          this.#db.prepare('SELECT revision FROM gqe_clock WHERE singleton=1').get() as {
            revision: number;
          }
        ).revision;
        watermark =
          (
            this.#db.prepare('SELECT watermark FROM gqe_groups WHERE group_id=?').get(group) as
              | { watermark: number }
              | undefined
          )?.watermark ?? 0;
        const latest = await reader.readShared({
          visibility: 'shared',
          after: watermark,
          limit: 1,
          cursor: null,
        });
        if (latest.watermark < watermark)
          catchupFail(
            'discontinuous',
            'Hosted shared watermark moved behind the verified source index.',
          );
        after = query.type === 'offline_changes' ? await catchup.acknowledged(reader) : 0;
        unknown = [
          'Only explicit indexed shared evidence is reported; missing responsibility, state or causal edges remain unknown.',
        ];
        if (latest.watermark > watermark)
          unknown.push(
            `Shared source index is incomplete beyond position ${watermark}; hosted watermark is ${latest.watermark}.`,
          );
        if (query.type === 'instruction_actions') {
          const instruction = this.#db
            .prepare('SELECT event_json FROM gqe_events WHERE group_id=? AND event_id=?')
            .get(group, query.instructionEventId) as { event_json: string } | undefined;
          const event = instruction
            ? groupEventSchema.parse(JSON.parse(instruction.event_json))
            : undefined;
          if (
            !event ||
            event.category !== 'Instruction' ||
            event.scope.memberId !== reader.context.memberId
          )
            catchupFail(
              'conflict',
              'Select an indexed original instruction authored by this authenticated member.',
            );
        }
      }
    }
    await reader.revalidate();
    return this.#tx(() => {
      const request = this.#db
        .prepare('SELECT * FROM gqe_requests WHERE query_id=? AND reader_key=?')
        .get(queryId, key) as Cursor | undefined;
      if (request) {
        if (request.query_json !== qjson || request.limit_count !== limit)
          catchupFail('conflict', 'Query identity was reused with changed parameters.');
        if (!continuation) {
          ({ watermark, after_position: after, index_revision: indexRevision } = request);
          unknown = JSON.parse(request.unknown_json) as string[];
        }
      } else {
        if (
          (this.#db.prepare('SELECT count(*) AS n FROM gqe_requests').get() as { n: number }).n >=
          LIMITS.queries
        )
          catchupFail('limit', 'Private query identity capacity reached.');
        this.#db
          .prepare('INSERT INTO gqe_requests VALUES(?,?,?,?,?,?,?,?)')
          .run(
            queryId,
            key,
            qjson,
            watermark,
            after,
            limit,
            JSON.stringify(unknown),
            indexRevision,
          );
      }
      const rows = this.#db
        .prepare(this.#sql(query))
        .all(...this.#params(group, query, after, watermark, limit + 1, indexRevision)) as {
        event_json: string;
        facts_json: string | null;
      }[];
      const records = rows.slice(0, limit).map((r) =>
        groupEvidenceRecordSchema.parse({
          event: JSON.parse(r.event_json),
          facts: r.facts_json ? JSON.parse(r.facts_json) : null,
        }),
      );
      let next: string | null = null;
      if (rows.length > limit) {
        // Exact replay keeps the same continuation identity, including after restart.
        const last = records[records.length - 1].event.sequence;
        const prior = this.#db
          .prepare(
            'SELECT token FROM gqe_cursors WHERE query_id=? AND reader_key=? AND query_json=? AND watermark=? AND after_position=? AND limit_count=? AND unknown_json=? AND index_revision=? LIMIT 1',
          )
          .get(
            queryId,
            key,
            qjson,
            watermark,
            last,
            limit,
            JSON.stringify(unknown),
            indexRevision,
          ) as { token: string } | undefined;
        if (
          !prior &&
          (this.#db.prepare('SELECT count(*) AS n FROM gqe_cursors').get() as { n: number }).n >=
            LIMITS.queries
        )
          catchupFail('limit', 'Private query continuation capacity reached.');
        next = prior?.token ?? randomUUID();
        if (!prior)
          this.#db
            .prepare('INSERT INTO gqe_cursors VALUES(?,?,?,?,?,?,?,?,?)')
            .run(
              next,
              queryId,
              key,
              qjson,
              watermark,
              last,
              limit,
              JSON.stringify(unknown),
              indexRevision,
            );
      }
      if (!records.length)
        unknown = [...unknown, 'No matching explicit indexed evidence; the answer is unknown.'];
      return groupEvidencePageSchema.parse({
        records,
        watermark,
        continuation: next,
        coverage: 'indexed_shared_sources',
        unknown,
      });
    });
  }
}
