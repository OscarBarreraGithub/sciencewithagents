import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { groupFeedPageSchema, type GroupFeedCursor, type GroupFeedPage } from '@dock/shared';
import {
  GROUP_CATCHUP_LIMITS as LIMITS,
  groupCatchupPageSchema,
  type GroupCatchupAck,
  type GroupCatchupPage,
} from '@dock/shared/dist/group-catchup.js';
import { catchupMemberKey, catchupFail, type GroupCatchupReader } from './group-catchup-context.js';

type Member = { acknowledged: number; active_snapshot: string | null };
type Snapshot = { snapshot_id: string; member_key: string; watermark: number; closed: number };
type PageRow = { page_json: string; next_cursor: string | null; acked: number };
/** Local private read receipts. No method appends or publishes a shared event. */
export class GroupCatchupStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA max_page_count=16384;
      CREATE TABLE IF NOT EXISTS gc_members(member_key TEXT PRIMARY KEY, acknowledged INTEGER NOT NULL,active_snapshot TEXT);
      CREATE TABLE IF NOT EXISTS gc_snapshots(snapshot_id TEXT PRIMARY KEY,member_key TEXT NOT NULL REFERENCES gc_members(member_key),watermark INTEGER NOT NULL,closed INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS gc_snapshot_member ON gc_snapshots(member_key,snapshot_id);
      CREATE TABLE IF NOT EXISTS gc_pages(page_id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL REFERENCES gc_snapshots(snapshot_id),after_position INTEGER NOT NULL,page_json TEXT NOT NULL,next_cursor TEXT,acked INTEGER NOT NULL,UNIQUE(snapshot_id,after_position));
      CREATE TABLE IF NOT EXISTS gc_continuations(token TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL REFERENCES gc_snapshots(snapshot_id),after_position INTEGER NOT NULL,feed_cursor TEXT NOT NULL,UNIQUE(snapshot_id,after_position));`);
  }
  close() {
    this.#db.close();
  }
  #tx<T>(work: () => T): T {
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
  #member(key: string): Member {
    return (
      (this.#db
        .prepare('SELECT acknowledged,active_snapshot FROM gc_members WHERE member_key=?')
        .get(key) as Member) ?? { acknowledged: 0, active_snapshot: null }
    );
  }
  #snapshot(key: string, id: string): Snapshot {
    const row = this.#db
      .prepare('SELECT * FROM gc_snapshots WHERE snapshot_id=? AND member_key=?')
      .get(id, key) as Snapshot | undefined;
    if (!row) catchupFail('invalid_cursor', 'Snapshot is not bound to this member enrollment.');
    return row;
  }
  #page(id: string, after: number): GroupCatchupPage | undefined {
    const row = this.#db
      .prepare('SELECT * FROM gc_pages WHERE snapshot_id=? AND after_position=?')
      .get(id, after) as PageRow | undefined;
    return row
      ? { ...groupCatchupPageSchema.parse(JSON.parse(row.page_json)), acknowledged: !!row.acked }
      : undefined;
  }
  #capacity() {
    const n = (this.#db.prepare('SELECT count(*) AS n FROM gc_pages').get() as { n: number }).n;
    if (n >= LIMITS.pages)
      catchupFail('limit', 'Saved read receipt capacity reached. No position was reset.');
  }
  #save(id: string, after: number, feed: GroupFeedPage): GroupCatchupPage {
    this.#capacity();
    const page = groupCatchupPageSchema.parse({
      snapshotId: id,
      pageId: randomUUID(),
      acknowledgementId: randomUUID(),
      after,
      through: after + feed.entries.length,
      watermark: feed.watermark,
      entries: feed.entries,
      continuation: feed.continuation ? randomUUID() : null,
      acknowledged: false,
    });
    if (page.through < page.watermark && !feed.continuation)
      catchupFail('discontinuous', 'Snapshot ended before its watermark.');
    if (
      feed.continuation &&
      (feed.continuation.after !== page.through || feed.continuation.watermark !== page.watermark)
    )
      catchupFail('discontinuous', 'Continuation does not match delivered positions.');
    this.#db
      .prepare('INSERT INTO gc_pages VALUES(?,?,?,?,?,0)')
      .run(
        page.pageId,
        id,
        after,
        JSON.stringify(page),
        feed.continuation ? JSON.stringify(feed.continuation) : null,
      );
    if (page.continuation)
      this.#db
        .prepare('INSERT INTO gc_continuations VALUES(?,?,?,?)')
        .run(page.continuation, id, page.through, JSON.stringify(feed.continuation));
    return page;
  }
  async acknowledged(reader: GroupCatchupReader): Promise<number> {
    await reader.revalidate();
    return this.#member(catchupMemberKey(reader)).acknowledged;
  }
  async start(reader: GroupCatchupReader): Promise<GroupCatchupPage> {
    await reader.revalidate();
    const key = catchupMemberKey(reader);
    const before = this.#member(key);
    if (before.active_snapshot) {
      const snapshot = this.#snapshot(key, before.active_snapshot);
      const saved = this.#page(snapshot.snapshot_id, before.acknowledged);
      if (saved) return saved;
      const continuation = this.#db
        .prepare('SELECT token FROM gc_continuations WHERE snapshot_id=? AND after_position=?')
        .get(snapshot.snapshot_id, before.acknowledged) as { token: string } | undefined;
      if (!continuation) catchupFail('discontinuous', 'Saved snapshot has no next delivered page.');
      return this.page(reader, snapshot.snapshot_id, continuation.token);
    }
    const feed = groupFeedPageSchema.parse(
      await reader.readShared({
        visibility: 'shared',
        after: before.acknowledged,
        limit: LIMITS.pageSize,
        cursor: null,
      }),
    );
    await reader.revalidate();
    return this.#tx(() => {
      const current = this.#member(key);
      if (current.acknowledged !== before.acknowledged || current.active_snapshot)
        catchupFail(
          'conflict',
          'Another reader advanced this enrollment. Resume its saved snapshot.',
        );
      if (!this.#db.prepare('SELECT 1 FROM gc_members WHERE member_key=?').get(key)) {
        if (
          (this.#db.prepare('SELECT count(*) AS n FROM gc_members').get() as { n: number }).n >=
          LIMITS.members
        )
          catchupFail('limit', 'Member read capacity reached.');
        this.#db.prepare('INSERT INTO gc_members VALUES(?,0,NULL)').run(key);
      }
      if (feed.watermark < current.acknowledged)
        catchupFail(
          'discontinuous',
          'Shared feed watermark moved behind the acknowledged position.',
        );
      // An empty completed snapshot is reused until new events exist; refresh does not exhaust receipts.
      if (feed.watermark === current.acknowledged) {
        const prior = this.#db
          .prepare(
            'SELECT snapshot_id FROM gc_snapshots WHERE member_key=? AND watermark=? AND closed=1 ORDER BY rowid DESC LIMIT 1',
          )
          .get(key, current.acknowledged) as { snapshot_id: string } | undefined;
        const empty = prior ? this.#page(prior.snapshot_id, current.acknowledged) : undefined;
        if (empty) return empty;
      }
      if (
        (
          this.#db
            .prepare('SELECT count(*) AS n FROM gc_snapshots WHERE member_key=?')
            .get(key) as { n: number }
        ).n >= LIMITS.snapshots
      )
        catchupFail('limit', 'Snapshot capacity reached. Saved identities remain intact.');
      const id = randomUUID();
      this.#db
        .prepare('INSERT INTO gc_snapshots VALUES(?,?,?,?)')
        .run(id, key, feed.watermark, feed.entries.length === 0 ? 1 : 0);
      const page = this.#save(id, current.acknowledged, feed);
      if (feed.entries.length)
        this.#db.prepare('UPDATE gc_members SET active_snapshot=? WHERE member_key=?').run(id, key);
      return page;
    });
  }
  async page(
    reader: GroupCatchupReader,
    snapshotId: string,
    token: string,
  ): Promise<GroupCatchupPage> {
    await reader.revalidate();
    const key = catchupMemberKey(reader);
    const snapshot = this.#snapshot(key, snapshotId);
    const row = this.#db
      .prepare(
        'SELECT after_position,feed_cursor FROM gc_continuations WHERE token=? AND snapshot_id=?',
      )
      .get(token, snapshotId) as { after_position: number; feed_cursor: string } | undefined;
    if (!row || snapshot.closed || this.#member(key).active_snapshot !== snapshotId)
      catchupFail('invalid_cursor', 'Continuation is stale or not bound to this snapshot.');
    if (this.#member(key).acknowledged !== row.after_position)
      catchupFail(
        'discontinuous',
        'Continuation is stale or the preceding page has not been acknowledged.',
      );
    const saved = this.#page(snapshotId, row.after_position);
    if (saved) return saved;
    const cursor = JSON.parse(row.feed_cursor) as GroupFeedCursor;
    const feed = groupFeedPageSchema.parse(
      await reader.readShared({
        visibility: 'shared',
        after: row.after_position,
        limit: LIMITS.pageSize,
        cursor,
      }),
    );
    await reader.revalidate();
    return this.#tx(() => {
      const current = this.#snapshot(key, snapshotId);
      const member = this.#member(key);
      if (current.closed || member.active_snapshot !== snapshotId)
        catchupFail('invalid_cursor', 'Snapshot is no longer active.');
      const replay = this.#page(snapshotId, row.after_position);
      if (replay) return replay;
      if (member.acknowledged !== row.after_position || feed.watermark !== snapshot.watermark)
        catchupFail('discontinuous', 'Snapshot or acknowledged position changed.');
      return this.#save(snapshotId, row.after_position, feed);
    });
  }
  async acknowledge(
    reader: GroupCatchupReader,
    snapshotId: string,
    pageId: string,
    acknowledgementId: string,
  ): Promise<GroupCatchupAck> {
    await reader.revalidate();
    const key = catchupMemberKey(reader);
    return this.#tx(() => {
      const snapshot = this.#snapshot(key, snapshotId);
      const row = this.#db
        .prepare('SELECT * FROM gc_pages WHERE page_id=? AND snapshot_id=?')
        .get(pageId, snapshotId) as PageRow | undefined;
      if (!row)
        catchupFail('invalid_cursor', 'Only an actually delivered page can be acknowledged.');
      const page = groupCatchupPageSchema.parse(JSON.parse(row.page_json));
      if (page.acknowledgementId !== acknowledgementId)
        catchupFail(
          'invalid_cursor',
          'Acknowledgement identity does not match the delivered page.',
        );
      const receipt = {
        snapshotId,
        pageId,
        acknowledgementId,
        through: page.through,
        watermark: page.watermark,
      };
      if (row.acked) return receipt;
      const member = this.#member(key);
      if (
        snapshot.closed ||
        member.active_snapshot !== snapshotId ||
        member.acknowledged !== page.after ||
        page.entries.length === 0
      )
        catchupFail(
          'discontinuous',
          'Acknowledgement would skip an unseen page or use a stale snapshot.',
        );
      this.#db.prepare('UPDATE gc_pages SET acked=1 WHERE page_id=?').run(pageId);
      this.#db
        .prepare('UPDATE gc_members SET acknowledged=?,active_snapshot=? WHERE member_key=?')
        .run(page.through, page.continuation ? snapshotId : null, key);
      if (!page.continuation)
        this.#db.prepare('UPDATE gc_snapshots SET closed=1 WHERE snapshot_id=?').run(snapshotId);
      return receipt;
    });
  }
}
