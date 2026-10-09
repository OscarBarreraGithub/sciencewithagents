import {
  groupNativeActivitySchema,
  groupNativeActivityReadSchema,
  groupNativeActivityOriginalSchema,
  groupNativeActivityStatusSchema,
  type GroupNativeActivity,
} from '@dock/shared/dist/group-native-activity.js';
import type { Store } from './store.js';
import type { GroupHost } from './group-host.js';
import {
  initializeGroupActivity,
  readGroupNativeFinalOriginal,
} from './group-native-activity-producers.js';
import { z } from 'zod';
import { Conflict, Missing } from './store.js';

const activityPorts = new WeakMap<GroupHost, GroupHostNativeActivity>();
export const groupHostActivity = (host: GroupHost) => activityPorts.get(host);
export function registerGroupHostActivity(host: GroupHost, activity: GroupHostNativeActivity) {
  activityPorts.set(host, activity);
  return () => {
    if (activityPorts.get(host) === activity) activityPorts.delete(host);
  };
}

/** Finite publication pass over producer receipts only. The existing member feed
 * owns summary launches; neither source capture nor this pass makes model calls. */
export class GroupHostNativeActivity {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private closed = false;
  private cursor = 0;
  constructor(
    private store: Store,
    private host: Pick<GroupHost, 'sharedGoalForRequest' | 'publishNativeActivity'>,
  ) {
    initializeGroupActivity(store);
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.pass(), 20_000);
    this.timer.unref();
  }
  pass(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.running ??= this.run().finally(() => {
      this.running = undefined;
    }));
  }
  private async run() {
    const read = (after: number) =>
      this.store.db
        .prepare(
          "SELECT r.rowid,r.id,r.enrollment,r.body FROM group_native_activity r JOIN group_native_activity_delivery d ON d.id=r.id WHERE d.state='pending' AND r.rowid>? ORDER BY r.rowid LIMIT 8",
        )
        .all(after);
    let rows = read(this.cursor);
    if (!rows.length) rows = read(0);
    for (const row of rows) {
      if (this.closed) return;
      this.cursor = Number(row.rowid);
      try {
        const source = groupNativeActivitySchema.parse(JSON.parse(String(row.body))),
          autonomous = source.origin?.kind === 'autonomous';
        const prior = this.store.db
          .prepare('SELECT result FROM operations WHERE key=?')
          .get(`group:activity-projection:${source.receiptId}`);
        let projection: GroupNativeActivity;
        if (prior) projection = groupNativeActivitySchema.parse(JSON.parse(String(prior.result)));
        else {
          const instruction =
            source.instructionEventId ??
            (autonomous ? null : await this.host.sharedGoalForRequest(source.requestId));
          if (this.closed) return;
          projection = this.store.operation(
            `group:activity-projection:${source.receiptId}`,
            source,
            () =>
              groupNativeActivitySchema.parse({
                ...source,
                instructionEventId: instruction,
                sharedGoalId: source.sharedGoalId ?? instruction,
              }),
          );
        }
        const result = await this.host.publishNativeActivity(String(row.enrollment), projection);
        if (result.state === 'committed')
          this.store.db
            .prepare("UPDATE group_native_activity_delivery SET state='complete' WHERE id=?")
            .run(source.receiptId);
      } catch {
        // Original receipts survive authority loss, capacity and lost acknowledgements.
        // Another group/source may proceed; no provider retry is authorized here.
      }
    }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  async status(host: GroupHost, raw: unknown) {
    const { handle } = z.strictObject({ handle: z.uuid() }).parse(raw),
      actor = await host.authenticatedContext({ handle });
    const rows = this.store.db
        .prepare(
          'SELECT d.state,count(*) n FROM group_native_activity r JOIN group_native_activity_delivery d ON d.id=r.id WHERE r.enrollment=? GROUP BY d.state',
        )
        .all(actor.enrollmentHandle),
      gaps = this.store.db
        .prepare(
          'SELECT reason,count FROM group_native_activity_gaps WHERE enrollment=? ORDER BY reason',
        )
        .all(actor.enrollmentHandle);
    await actor.revalidate();
    return groupNativeActivityStatusSchema.parse({
      retained: rows.reduce((n, r) => n + Number(r.n), 0),
      pending: Number(rows.find((r) => r.state === 'pending')?.n ?? 0),
      gaps: gaps.map((r) => ({ reason: String(r.reason), count: Number(r.count) })),
      limits: { receipts: 8192, receiptBytes: 64 * 1024 * 1024, originalBytes: 64 * 1024 * 1024 },
    });
  }
  /** Owner/paired-device read only, exact local receipt ID and bounded byte range.
   * This does not publish overflow output or grant work/library/file authority. */
  async original(host: GroupHost, raw: unknown) {
    const input = groupNativeActivityReadSchema.parse(raw),
      actor = await host.authenticatedContext({ handle: input.handle }),
      row =
        this.store.db
          .prepare(
            'SELECT bytes,sha256,substr(body,?,?) body FROM group_native_activity_bodies WHERE id=? AND enrollment=?',
          )
          .get(input.start + 1, input.count * 16384, input.receiptId, actor.enrollmentHandle) ??
        readGroupNativeFinalOriginal(
          this.store,
          input.receiptId,
          actor.enrollmentHandle,
          input.start,
          input.count * 16384,
        );
    if (!row)
      throw new Missing('This exact native activity original is unavailable on this computer.');
    const bytes = Number(row.bytes);
    if (input.start > bytes)
      throw new Conflict('Native activity original range is outside the retained body.');
    await actor.revalidate();
    const body = Buffer.from(row.body as Uint8Array),
      end = input.start + body.byteLength;
    return groupNativeActivityOriginalSchema.parse({
      receiptId: input.receiptId,
      bytes,
      sha256: row.sha256,
      encoding: 'base64',
      start: input.start,
      next: end < bytes ? end : null,
      data: body.toString('base64'),
    });
  }
}
