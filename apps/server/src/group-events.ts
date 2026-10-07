import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  GROUP_LIMITS,
  groupAppendSchema,
  groupContextSchema,
  groupDisplayNameSchema,
  groupEventIdSchema,
  groupEventSchema,
  groupFeedQuerySchema,
  groupIdSchema,
  groupInstallationIdSchema,
  groupMemberIdSchema,
  groupScopeSchema,
  groupSessionIdSchema,
  groupUtf8Bytes,
  type GroupAppend,
  type GroupContext,
  type GroupEvent,
  type GroupFeedPage,
  type GroupId,
  type GroupScope,
} from '@dock/shared';

export class GroupEventError extends Error {
  constructor(
    public readonly code:
      | 'forbidden'
      | 'payload_conflict'
      | 'stale_revision'
      | 'invalid_reference'
      | 'invalid_cursor'
      | 'source_conflict',
    message: string,
  ) {
    super(message);
  }
}
export interface GroupAccess {
  readonly __groupAccess: unique symbol;
}
const fail = (code: GroupEventError['code'], message: string): never => {
  throw new GroupEventError(code, message);
};
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
// Canonical receipts survive object key ordering and repository restart.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};
type EventRow = { event_json: string; position: number };
export const GROUP_EVENT_SCHEMA_VERSION = 2;

// Portable SQLite tables/indexes; no Node types cross the shared contract boundary.
export const GROUP_EVENT_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS ge_groups (group_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ge_members (
  group_id TEXT NOT NULL REFERENCES ge_groups(group_id), member_id TEXT NOT NULL,
  installation_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)), PRIMARY KEY(group_id,member_id)
);
CREATE TABLE IF NOT EXISTS ge_contexts (
  session_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, member_id TEXT NOT NULL,
  installation_id TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('shared','private')),
  provider TEXT NOT NULL, native_session_id TEXT NOT NULL,
  UNIQUE(provider,native_session_id), FOREIGN KEY(group_id,member_id) REFERENCES ge_members(group_id,member_id)
);
CREATE TABLE IF NOT EXISTS ge_revisions (entity_key TEXT PRIMARY KEY, revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ge_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL, member_id TEXT NOT NULL, installation_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES ge_contexts(session_id), visibility TEXT NOT NULL,
  operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL, source_message_id TEXT NOT NULL,
  entity_key TEXT NOT NULL, revision INTEGER NOT NULL, event_json TEXT NOT NULL,
  UNIQUE(group_id,member_id,installation_id,operation_id), UNIQUE(session_id,source_message_id),
  UNIQUE(entity_key,revision)
);
CREATE INDEX IF NOT EXISTS ge_feed_shared ON ge_events(group_id,visibility,sequence);
CREATE INDEX IF NOT EXISTS ge_feed_private ON ge_events(group_id,visibility,member_id,installation_id,session_id,sequence);
CREATE TABLE IF NOT EXISTS ge_chunks (
  event_id TEXT NOT NULL REFERENCES ge_events(event_id), chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL, PRIMARY KEY(event_id,chunk_index)
);
CREATE TRIGGER IF NOT EXISTS ge_events_no_update BEFORE UPDATE ON ge_events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
CREATE TRIGGER IF NOT EXISTS ge_events_no_delete BEFORE DELETE ON ge_events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
CREATE TRIGGER IF NOT EXISTS ge_chunks_no_update BEFORE UPDATE ON ge_chunks BEGIN SELECT RAISE(ABORT,'immutable original'); END;
CREATE TRIGGER IF NOT EXISTS ge_chunks_no_delete BEFORE DELETE ON ge_chunks BEGIN SELECT RAISE(ABORT,'immutable original'); END;
CREATE TRIGGER IF NOT EXISTS ge_contexts_no_update BEFORE UPDATE ON ge_contexts BEGIN SELECT RAISE(ABORT,'immutable context'); END;
CREATE TRIGGER IF NOT EXISTS ge_contexts_no_delete BEFORE DELETE ON ge_contexts BEGIN SELECT RAISE(ABORT,'immutable context'); END;
CREATE TABLE IF NOT EXISTS ge_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ge_stream_positions (
  event_id TEXT PRIMARY KEY REFERENCES ge_events(event_id), stream_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position>0), UNIQUE(stream_key,position)
);
CREATE TRIGGER IF NOT EXISTS ge_positions_no_update BEFORE UPDATE ON ge_stream_positions BEGIN SELECT RAISE(ABORT,'immutable position'); END;
CREATE TRIGGER IF NOT EXISTS ge_positions_no_delete BEFORE DELETE ON ge_stream_positions BEGIN SELECT RAISE(ABORT,'immutable position'); END;
`;

/** Host-only repository. Provisioning and trustedHostScope must never be browser RPCs.
 * The owning authenticated host resolves persisted context identity, then issues access.
 * Neither this module nor its JSON contracts implement network authentication.
 */
export class GroupEventRepository {
  readonly #db: DatabaseSync;
  readonly #scopes = new WeakMap<GroupAccess, GroupScope>();
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
      this.#transaction(() => {
        const hasVersion = this.#db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ge_schema'")
          .get();
        const version = hasVersion
          ? (
              this.#db.prepare('SELECT version FROM ge_schema WHERE singleton=1').get() as
                | { version: number }
                | undefined
            )?.version
          : undefined;
        if (hasVersion && version !== GROUP_EVENT_SCHEMA_VERSION)
          throw new Error(`Unsupported group event schema version: ${version}`);
        this.#db.exec(GROUP_EVENT_SQL);
        if (!hasVersion) {
          // v1 has immutable database-global ordering. Preserve its rows/JSON/chunks,
          // but backfill an independent public position for each authorized stream.
          this.#db.exec(`INSERT INTO ge_stream_positions(event_id,stream_key,position)
            SELECT event_id,
              CASE WHEN visibility='shared' THEN 'shared:' || group_id
                   ELSE 'private:' || session_id END,
              ROW_NUMBER() OVER (PARTITION BY group_id,visibility,
                CASE WHEN visibility='private' THEN session_id ELSE '' END ORDER BY sequence)
            FROM ge_events`);
          this.#db.prepare('INSERT INTO ge_schema VALUES (1,?)').run(GROUP_EVENT_SCHEMA_VERSION);
        }
      });
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  close(): void {
    this.#db.close();
  }
  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // SQLite may already have rolled back; preserve the original failure.
      }
      throw error;
    }
  }
  /** Authenticated hosted enrollment import. Exact service identities are retained;
   * browser labels cannot provision or revive a revoked enrollment. */
  trustedHostEnroll(input: {
    groupId: string;
    memberId: string;
    installationId: string;
    displayName: string;
  }) {
    const identity = {
      groupId: groupIdSchema.parse(input.groupId),
      memberId: groupMemberIdSchema.parse(input.memberId),
      installationId: groupInstallationIdSchema.parse(input.installationId),
      displayName: groupDisplayNameSchema.parse(input.displayName),
    };
    return this.#transaction(() => {
      const prior = this.#db
        .prepare(
          'SELECT group_id,member_id,installation_id,display_name,active FROM ge_members WHERE member_id=? OR installation_id=?',
        )
        .get(identity.memberId, identity.installationId);
      if (prior) {
        if (
          prior.group_id !== identity.groupId ||
          prior.member_id !== identity.memberId ||
          prior.installation_id !== identity.installationId ||
          prior.display_name !== identity.displayName ||
          prior.active !== 1
        )
          fail('forbidden', 'Enrollment identity unavailable');
        return identity;
      }
      this.#db.prepare('INSERT OR IGNORE INTO ge_groups VALUES (?)').run(identity.groupId);
      this.#db
        .prepare('INSERT INTO ge_members VALUES (?,?,?,?,1)')
        .run(identity.groupId, identity.memberId, identity.installationId, identity.displayName);
      return identity;
    });
  }
  createGroup(displayName: string) {
    const groupId = groupIdSchema.parse(randomUUID());
    return this.#transaction(() => {
      this.#db.prepare('INSERT INTO ge_groups VALUES (?)').run(groupId);
      return { groupId, ...this.#addMember(groupId, displayName) };
    });
  }
  #addMember(groupId: GroupId, displayName: string) {
    const memberId = groupMemberIdSchema.parse(randomUUID());
    const installationId = groupInstallationIdSchema.parse(randomUUID());
    const name = groupDisplayNameSchema.parse(displayName);
    this.#db
      .prepare('INSERT INTO ge_members VALUES (?,?,?,?,1)')
      .run(groupId, memberId, installationId, name);
    return { memberId, installationId, displayName: name };
  }
  addMember(groupId: GroupId, displayName: string) {
    return this.#transaction(() => this.#addMember(groupIdSchema.parse(groupId), displayName));
  }
  revokeMember(groupId: GroupId, memberId: GroupContext['memberId']): void {
    this.#transaction(() => {
      this.#db
        .prepare('UPDATE ge_members SET active=0 WHERE group_id=? AND member_id=?')
        .run(groupIdSchema.parse(groupId), groupMemberIdSchema.parse(memberId));
    });
  }
  createContext(input: Omit<GroupContext, 'sessionId'>): GroupContext {
    const context = groupContextSchema.parse({
      ...groupContextSchema.omit({ sessionId: true }).parse(input),
      sessionId: groupSessionIdSchema.parse(randomUUID()),
    });
    return this.#transaction(() => {
      this.#member(context);
      // Always fresh: same native identity cannot be registered again, even across visibility/groups.
      this.#db
        .prepare('INSERT INTO ge_contexts VALUES (?,?,?,?,?,?,?)')
        .run(
          context.sessionId,
          context.groupId,
          context.memberId,
          context.installationId,
          context.visibility,
          context.provider,
          context.nativeSessionId,
        );
      return context;
    });
  }
  /** Exact shared source context imported from authenticated same-group hosted
   * producer receipts. This host-only port never provisions private contexts or
   * native execution; it preserves the original remote identity for evidence. */
  trustedHostSharedContext(input: GroupContext, displayName: string): GroupContext {
    const context = groupContextSchema.parse(input);
    if (context.visibility !== 'shared') fail('forbidden', 'Shared producer context required');
    this.trustedHostEnroll({ ...context, displayName });
    return this.#transaction(() => {
      const rows = this.#db
        .prepare(
          'SELECT session_id,group_id,member_id,installation_id,visibility,provider,native_session_id FROM ge_contexts WHERE session_id=? OR native_session_id=?',
        )
        .all(context.sessionId, context.nativeSessionId);
      if (rows.length) {
        if (
          rows.length !== 1 ||
          rows[0]!.session_id !== context.sessionId ||
          rows[0]!.group_id !== context.groupId ||
          rows[0]!.member_id !== context.memberId ||
          rows[0]!.installation_id !== context.installationId ||
          rows[0]!.visibility !== 'shared' ||
          rows[0]!.provider !== context.provider ||
          rows[0]!.native_session_id !== context.nativeSessionId
        )
          fail('forbidden', 'Shared producer context collision');
      } else
        this.#db
          .prepare('INSERT INTO ge_contexts VALUES(?,?,?,?,?,?,?)')
          .run(
            context.sessionId,
            context.groupId,
            context.memberId,
            context.installationId,
            context.visibility,
            context.provider,
            context.nativeSessionId,
          );
      return context;
    });
  }
  #member(context: Pick<GroupContext, 'groupId' | 'memberId' | 'installationId'>): void {
    const member = this.#db
      .prepare(
        'SELECT 1 FROM ge_members WHERE group_id=? AND member_id=? AND installation_id=? AND active=1',
      )
      .get(context.groupId, context.memberId, context.installationId);
    if (!member) fail('forbidden', 'Active membership and installation required');
  }
  #authorize(scope: GroupScope): void {
    this.#member(scope);
    const context = this.#db
      .prepare(
        `SELECT 1 FROM ge_contexts WHERE session_id=? AND group_id=? AND member_id=?
      AND installation_id=? AND visibility=? AND provider=? AND native_session_id=?`,
      )
      .get(
        scope.source.sessionId,
        scope.groupId,
        scope.memberId,
        scope.installationId,
        scope.visibility,
        scope.source.provider,
        scope.source.nativeSessionId,
      );
    if (!context) fail('forbidden', 'Persisted context identity required');
  }
  trustedHostScope(input: GroupScope): GroupAccess {
    const scope = groupScopeSchema.parse(input);
    return this.#transaction(() => {
      this.#authorize(scope);
      this.#references(scope, scope.causalRefs);
      const access = Object.freeze({}) as GroupAccess;
      this.#scopes.set(access, scope);
      return access;
    });
  }
  #scope(access: GroupAccess): GroupScope {
    const scope = this.#scopes.get(access);
    if (!scope) return fail('forbidden', 'Repository-issued host access required');
    this.#authorize(scope);
    return scope;
  }
  #predicate(scope: GroupScope, visibility?: 'shared' | 'private') {
    if (visibility === 'shared' || scope.visibility === 'shared') {
      if (visibility === 'private') fail('forbidden', 'Shared context cannot read private records');
      return { sql: "group_id=? AND visibility='shared'", args: [scope.groupId] };
    }
    const privateSql =
      "visibility='private' AND member_id=? AND installation_id=? AND session_id=?";
    return {
      sql:
        visibility === 'private'
          ? `group_id=? AND (${privateSql})`
          : `group_id=? AND (visibility='shared' OR (${privateSql}))`,
      args: [scope.groupId, scope.memberId, scope.installationId, scope.source.sessionId],
    };
  }
  #event(scope: GroupScope, eventId: string, visibility?: 'shared' | 'private'): GroupEvent {
    const predicate = this.#predicate(scope, visibility);
    const row = this.#db
      .prepare(
        `SELECT event_json,position FROM ge_events
        JOIN ge_stream_positions USING(event_id) WHERE event_id=? AND ${predicate.sql}`,
      )
      .get(groupEventIdSchema.parse(eventId), ...predicate.args) as EventRow | undefined;
    if (!row) return fail('invalid_reference', 'Evidence unavailable in this context');
    return this.#decode(row);
  }
  #decode(row: EventRow): GroupEvent {
    return groupEventSchema.parse({ ...JSON.parse(row.event_json), sequence: row.position });
  }
  #streamKey(scope: GroupScope, visibility = scope.visibility): string {
    return visibility === 'shared'
      ? `shared:${scope.groupId}`
      : `private:${scope.source.sessionId}`;
  }
  #references(scope: GroupScope, refs: string[]): void {
    for (const ref of refs) this.#event(scope, ref);
  }
  append(access: GroupAccess, input: GroupAppend): { event: GroupEvent; duplicate: boolean } {
    const payload = groupAppendSchema.parse(input);
    return this.#transaction(() => {
      const scope = this.#scope(access);
      const receiptHash = hash(canonical({ scope, payload }));
      const receipt = this.#db
        .prepare(
          `SELECT event_id,payload_hash FROM ge_events
        WHERE group_id=? AND member_id=? AND installation_id=? AND operation_id=?`,
        )
        .get(scope.groupId, scope.memberId, scope.installationId, payload.operationId) as
        | { event_id: string; payload_hash: string }
        | undefined;
      if (receipt) {
        if (receipt.payload_hash !== receiptHash)
          fail('payload_conflict', 'Operation already has different content or scope');
        // Authorization precedes duplicate acknowledgement, too.
        return { event: this.#event(scope, receipt.event_id, scope.visibility), duplicate: true };
      }
      this.#references(scope, [...scope.causalRefs, ...payload.evidenceRefs]);
      const entityKey = hash(
        canonical([
          scope.groupId,
          scope.visibility,
          scope.visibility === 'private' ? scope.source.sessionId : null,
          payload.entityId,
        ]),
      );
      const current = this.#db
        .prepare('SELECT revision FROM ge_revisions WHERE entity_key=?')
        .get(entityKey) as { revision: number } | undefined;
      const revision = current?.revision ?? 0;
      if (revision !== payload.expectedRevision) fail('stale_revision', 'Entity revision changed');
      if (payload.corrects !== null) {
        const prior = this.#event(scope, payload.corrects, scope.visibility);
        if (prior.entityId !== payload.entityId || prior.revision !== revision)
          fail('invalid_reference', 'Correction must reference current entity evidence');
      }
      const existingSource = this.#db
        .prepare('SELECT 1 FROM ge_events WHERE session_id=? AND source_message_id=?')
        .get(scope.source.sessionId, scope.source.messageId);
      if (existingSource) fail('source_conflict', 'Exact source already recorded');
      const chunks =
        payload.original.kind === 'inline' ? [payload.original.text] : payload.original.chunks;
      const original = chunks.join('');
      const manifest = {
        bytes: groupUtf8Bytes(original),
        sha256: hash(original),
        chunks: chunks.map((text, index) => ({
          index,
          bytes: groupUtf8Bytes(text),
          sha256: hash(text),
        })),
      };
      const eventId = groupEventIdSchema.parse(randomUUID());
      const streamKey = this.#streamKey(scope);
      const next = this.#db
        .prepare(
          'SELECT COALESCE(MAX(position),0)+1 AS position FROM ge_stream_positions WHERE stream_key=?',
        )
        .get(streamKey) as { position: number };
      const event = groupEventSchema.parse({
        eventId,
        sequence: next.position,
        scope,
        operationId: payload.operationId,
        entityId: payload.entityId,
        revision: revision + 1,
        category: payload.category,
        condensedText: payload.condensedText,
        evidenceRefs: payload.evidenceRefs,
        corrects: payload.corrects,
        manifest,
        recordedAt: new Date().toISOString(),
      });
      this.#db
        .prepare(
          `INSERT INTO ge_events
        (event_id,group_id,member_id,installation_id,session_id,visibility,operation_id,payload_hash,source_message_id,entity_key,revision,event_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          eventId,
          scope.groupId,
          scope.memberId,
          scope.installationId,
          scope.source.sessionId,
          scope.visibility,
          payload.operationId,
          receiptHash,
          scope.source.messageId,
          entityKey,
          event.revision,
          JSON.stringify(event),
        );
      this.#db
        .prepare('INSERT INTO ge_stream_positions VALUES (?,?,?)')
        .run(eventId, streamKey, event.sequence);
      const insertChunk = this.#db.prepare('INSERT INTO ge_chunks VALUES (?,?,?)');
      chunks.forEach((text, index) => insertChunk.run(eventId, index, text));
      this.#db
        .prepare(
          `INSERT INTO ge_revisions VALUES (?,?)
        ON CONFLICT(entity_key) DO UPDATE SET revision=excluded.revision`,
        )
        .run(entityKey, event.revision);
      return { event, duplicate: false };
    });
  }
  feed(access: GroupAccess, input: import('@dock/shared').GroupFeedQuery): GroupFeedPage {
    const query = groupFeedQuerySchema.parse(input);
    return this.#transaction(() => {
      const scope = this.#scope(access);
      const predicate = this.#predicate(scope, query.visibility);
      const streamKey = this.#streamKey(scope, query.visibility);
      const scopeKey = hash(
        canonical([
          scope.groupId,
          scope.memberId,
          scope.installationId,
          scope.source.sessionId,
          scope.visibility,
        ]),
      );
      const latest = this.#db
        .prepare('SELECT MAX(position) AS position FROM ge_stream_positions WHERE stream_key=?')
        .get(streamKey) as { position: number | null };
      const watermark = query.cursor?.watermark ?? latest.position ?? 0;
      // A cursor supplies both positions; the separate query.after is only used
      // when starting a snapshot. See the contract/documented precedence.
      if (!query.cursor && query.after > watermark)
        fail('invalid_cursor', 'Read position exceeds snapshot watermark');
      if (
        query.cursor &&
        (query.cursor.scopeKey !== scopeKey ||
          query.cursor.visibility !== query.visibility ||
          watermark > (latest.position ?? 0))
      ) {
        fail('invalid_cursor', 'Cursor belongs to another scope or future snapshot');
      }
      const rows = this.#db
        .prepare(
          `SELECT event_json,position FROM ge_stream_positions
        JOIN ge_events USING(event_id) WHERE stream_key=? AND ${predicate.sql}
        AND position>? AND position<=? ORDER BY position LIMIT ?`,
        )
        .all(
          streamKey,
          ...predicate.args,
          query.cursor?.after ?? query.after,
          watermark,
          query.limit + 1,
        ) as EventRow[];
      const entries = rows.slice(0, query.limit).map((row) => this.#decode(row));
      return {
        entries,
        watermark,
        continuation:
          rows.length > query.limit
            ? {
                version: GROUP_EVENT_SCHEMA_VERSION,
                scopeKey,
                visibility: query.visibility,
                after: entries[entries.length - 1].sequence,
                watermark,
              }
            : null,
      };
    });
  }
  #expand(
    scope: GroupScope,
    eventId: string,
    visibility?: 'shared',
  ): { event: GroupEvent; original: string } {
    const event = this.#event(scope, eventId, visibility);
    const rows = this.#db
      .prepare('SELECT chunk_index,text FROM ge_chunks WHERE event_id=? ORDER BY chunk_index')
      .all(event.eventId) as { chunk_index: number; text: string }[];
    const original = rows.map((row) => row.text).join('');
    if (
      rows.length !== event.manifest.chunks.length ||
      hash(original) !== event.manifest.sha256 ||
      rows.some(
        (row, i) =>
          row.chunk_index !== i ||
          hash(row.text) !== event.manifest.chunks[i].sha256 ||
          groupUtf8Bytes(row.text) !== event.manifest.chunks[i].bytes,
      ) ||
      groupUtf8Bytes(original) !== event.manifest.bytes
    ) {
      throw new Error('Original evidence integrity failure');
    }
    return { event, original };
  }
  expand(access: GroupAccess, eventId: string) {
    return this.#transaction(() => this.#expand(this.#scope(access), eventId));
  }
  /** Allowlisted local publication boundary; no transport or implicit private-to-shared promotion. */
  sharedPublication(access: GroupAccess, eventIds: string[]) {
    if (eventIds.length > GROUP_LIMITS.references)
      throw new Error('Publication batch exceeds bound');
    return this.#transaction(() => {
      const scope = this.#scope(access);
      if (scope.visibility !== 'shared')
        fail('forbidden', 'Private contexts have no shared publication authority');
      return eventIds.map((eventId) => this.#expand(scope, eventId, 'shared'));
    });
  }
}
