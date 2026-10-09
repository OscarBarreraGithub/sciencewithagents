import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { groupScopeSchema, type GroupScope, type groupPayloadSchema } from '@dock/shared';
import { groupPromotionSourceSchema } from '@dock/shared/dist/group-promotion.js';
import type { z } from 'zod';
import {
  GroupPromotionController,
  type GroupPromotionSynthesis,
  type GroupPromotionSynthesisRequest,
} from './group-promotion.js';
import { GroupPromotionEvidenceIndex } from './group-promotion-evidence.js';
import { publicationCanonical } from './group-publication-protocol.js';
import { privateGroupFile, protectGroupSidecars } from './group-host-storage.js';
import type { GroupHost } from './group-host.js';
import {
  initializeGroupLocalReceiptCapacity,
  admitGroupLocalReceipt,
} from './group-local-receipt-capacity.js';
import { Conflict } from './store.js';

const quietHuman = /^(?:thanks?|thank you|ok(?:ay)?|got it|noted|ack(?:nowledged)?|👍)[.!\s]*$/iu;
/** One normal-host delivery lifecycle, not one timer/model turn per source.
 * Raw producer receipts precede registration; adopted projections are durable
 * before synthesis. Unknown synthesis is inspected through the controller. */
export class GroupFeaturePromotion {
  private readonly index: GroupPromotionEvidenceIndex;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private closed = false;
  private synthesis?: GroupPromotionSynthesis;
  private inputCursor = 0;
  private writerCursor = 0;
  constructor(private readonly host: GroupHost) {
    host.db.exec(`
      CREATE TABLE IF NOT EXISTS gh_promotion_inputs(receipt_id TEXT PRIMARY KEY,enrollment_handle TEXT NOT NULL,source_json TEXT NOT NULL,registered INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gh_promotion_writers(enrollment_handle TEXT PRIMARY KEY,enabled INTEGER NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gh_promotion_enable_receipts(key TEXT PRIMARY KEY,enrollment_handle TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gh_promotion_projections(source_id TEXT NOT NULL,version TEXT NOT NULL,enrollment_handle TEXT NOT NULL,source_json TEXT NOT NULL,registration_operation TEXT NOT NULL,PRIMARY KEY(source_id,version));
      CREATE TRIGGER IF NOT EXISTS gh_promotion_inputs_identity BEFORE UPDATE ON gh_promotion_inputs WHEN NEW.receipt_id<>OLD.receipt_id OR NEW.enrollment_handle<>OLD.enrollment_handle OR NEW.source_json<>OLD.source_json BEGIN SELECT RAISE(ABORT,'immutable producer input'); END;
      CREATE TRIGGER IF NOT EXISTS gh_promotion_projections_no_update BEFORE UPDATE ON gh_promotion_projections BEGIN SELECT RAISE(ABORT,'immutable projection'); END;
      CREATE TRIGGER IF NOT EXISTS gh_promotion_projections_no_delete BEFORE DELETE ON gh_promotion_projections BEGIN SELECT RAISE(ABORT,'retained projection'); END;
    `);
    initializeGroupLocalReceiptCapacity(host.db);
    const path = join(host.directory, 'promotion-evidence.sqlite');
    privateGroupFile(path);
    this.index = new GroupPromotionEvidenceIndex(path, host.events);
    protectGroupSidecars(path);
  }
  start(synthesis?: GroupPromotionSynthesis) {
    this.synthesis = synthesis;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pass();
    }, 20_000);
    this.timer.unref();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
    this.index.close();
  }
  /** Exact saved writer projection plus authoritative same-DO synthesis receipt.
   * Original B attribution is separate from the designated A account context. */
  async authorizeNative(request: GroupPromotionSynthesisRequest, signal: AbortSignal) {
    const row = this.host.db
      .prepare(
        'SELECT source_json,enrollment_handle FROM gh_promotion_projections WHERE source_id=? AND version=?',
      )
      .get(request.identity.key.sourceId, request.identity.key.version);
    if (!row || String(row.source_json) !== publicationCanonical(request.source))
      throw new Error('Exact retained writer projection required.');
    if (
      !this.host.localVisible(String(row.enrollment_handle)) ||
      !this.host.localContributing(String(row.enrollment_handle))
    )
      throw new Error(
        'Local contributions are paused; optional summaries wait for Contribute and a visible group.',
      );
    const port = await this.host.promotionContext(String(row.enrollment_handle));
    if (
      port.context.visibility !== 'shared' ||
      request.source.writerId !== port.enrollment.installationId ||
      request.source.projectionScope.memberId !== port.context.memberId ||
      request.source.projectionScope.installationId !== port.context.installationId
    )
      throw new Error('Designated owning writer required.');
    const renewed = await port.command({ kind: 'renew' }, signal);
    if (
      !renewed.ok ||
      renewed.value.kind !== 'designated' ||
      renewed.value.writerId !== request.source.writerId
    )
      throw new Error('Current writer lease required.');
    const checked = await port.command(
      { kind: 'command', command: { kind: 'reserve', identity: request.identity } },
      signal,
    );
    if (
      !checked.ok ||
      checked.value.kind !== 'receipt' ||
      !checked.value.receipt.synthesisStarted ||
      checked.value.receipt.synthesisId !== request.synthesisId ||
      checked.value.receipt.writerId !== request.source.writerId ||
      publicationCanonical(checked.value.receipt.identity) !==
        publicationCanonical(request.identity) ||
      checked.value.receipt.disposition
    )
      throw new Error('Exact authoritative synthesis receipt required.');
    await port.revalidate();
    if (!this.host.localContributing(String(row.enrollment_handle)))
      throw new Error('Read-only; optional summaries are paused.');
    return {
      context: port.context,
      enrollmentHandle: String(row.enrollment_handle),
      writerId: request.source.writerId,
    };
  }
  async retain(input: {
    receiptId: string;
    enrollmentHandle: string;
    sourceId: string;
    scope: GroupScope;
    kind: 'human' | 'native';
    original: z.infer<typeof groupPayloadSchema>;
  }) {
    if (input.scope.visibility !== 'shared') return 'suppressed';
    const text =
      input.original.kind === 'inline' ? input.original.text : input.original.chunks.join('');
    if (input.kind === 'human' && quietHuman.test(text.trim())) return 'suppressed';
    const port = await this.host.promotionContext(input.enrollmentHandle);
    const source = groupPromotionSourceSchema.parse({
      key: { groupId: port.enrollment.groupId, sourceId: input.sourceId, version: '1' },
      writerId: port.enrollment.installationId,
      scope: input.scope,
      projectionScope: input.scope,
      kind: input.kind,
      activity: 'substantive',
      contentMode: 'shared-content',
      original: input.original,
      evidenceRefs: [],
      correction: null,
      decision: null,
      synthesisAuthorized: true,
    });
    this.host.events.trustedHostScope(source.scope);
    const exact = publicationCanonical(source);
    const old = this.host.db
      .prepare('SELECT enrollment_handle,source_json FROM gh_promotion_inputs WHERE receipt_id=?')
      .get(input.receiptId);
    if (old && (old.enrollment_handle !== input.enrollmentHandle || old.source_json !== exact))
      throw new Error('Producer receipt changed.');
    if (!old) {
      try {
        admitGroupLocalReceipt(this.host.db, 'gh_promotion_inputs', exact, 'pending');
      } catch (error) {
        if (error instanceof Conflict)
          return 'full: original retained; local summary receipt storage is full';
        throw error;
      }
      this.host.db
        .prepare(
          'INSERT INTO gh_promotion_inputs(receipt_id,enrollment_handle,source_json,state) VALUES(?,?,?,?)',
        )
        .run(input.receiptId, input.enrollmentHandle, exact, 'pending');
    }
    await this.register(input.receiptId);
    return String(
      this.host.db
        .prepare('SELECT state FROM gh_promotion_inputs WHERE receipt_id=?')
        .get(input.receiptId)!.state,
    );
  }
  peek(id: string) {
    return String(
      this.host.db.prepare('SELECT state FROM gh_promotion_inputs WHERE receipt_id=?').get(id)
        ?.state ?? 'source_registration_pending',
    );
  }
  summary(handle: string, creator: boolean) {
    const writer = this.host.db
      .prepare('SELECT enabled,state FROM gh_promotion_writers WHERE enrollment_handle=?')
      .get(handle);
    const full = this.host.db
      .prepare(
        "SELECT state FROM gh_promotion_inputs WHERE enrollment_handle=? AND state LIKE 'full:%' LIMIT 1",
      )
      .get(handle);
    return {
      canSelect: creator,
      enabled: writer?.enabled === 1,
      message: String(
        full?.state ??
          writer?.state ??
          'No shared feed writer selected on this computer. Shared originals remain pending until the designated writer resumes.',
      ),
    };
  }
  async status(id: string) {
    await this.register(id);
    const row = this.host.db
      .prepare(
        'SELECT enrollment_handle,source_json,registered FROM gh_promotion_inputs WHERE receipt_id=?',
      )
      .get(id);
    if (row?.registered === 1) {
      try {
        const port = await this.host.promotionContext(String(row.enrollment_handle));
        const source = groupPromotionSourceSchema.parse(JSON.parse(String(row.source_json)));
        const result = await port.command({ kind: 'state', key: source.key });
        if (result.ok && result.value.kind === 'status')
          this.host.db
            .prepare('UPDATE gh_promotion_inputs SET state=? WHERE receipt_id=?')
            .run(result.value.state, id);
      } catch {}
    }
    return this.peek(id);
  }
  private async register(id: string) {
    const row = this.host.db
      .prepare('SELECT * FROM gh_promotion_inputs WHERE receipt_id=?')
      .get(id);
    if (!row || row.registered === 1) return;
    try {
      const port = await this.host.promotionContext(String(row.enrollment_handle));
      const result = await port.command({
        kind: 'register',
        source: groupPromotionSourceSchema.parse(JSON.parse(String(row.source_json))),
      });
      if (!result.ok || result.value.kind !== 'retained') {
        this.host.db
          .prepare('UPDATE gh_promotion_inputs SET state=? WHERE receipt_id=?')
          .run(
            result.ok
              ? 'pending'
              : result.error === 'limit'
                ? 'full: original retained; shared source capacity reached'
                : 'pending',
            id,
          );
        return;
      }
      this.host.db
        .prepare(
          "UPDATE gh_promotion_inputs SET registered=1,state='pending: awaiting shared feed writer' WHERE receipt_id=?",
        )
        .run(id);
    } catch {
      /* Exact input stays pending for the finite host delivery pass. */
    }
  }
  async enable(handle: string, key: string) {
    const port = await this.host.promotionContext(handle);
    if (!port.creator) throw new Error('Only the group creator can select its feed writer.');
    const old = this.host.db
      .prepare('SELECT enrollment_handle FROM gh_promotion_enable_receipts WHERE key=?')
      .get(key);
    if (old && old.enrollment_handle !== handle) throw new Error('Writer request changed group.');
    if (!old) {
      if (
        Number(
          this.host.db.prepare('SELECT count(*) n FROM gh_promotion_enable_receipts').get()!.n,
        ) >= 512
      )
        throw new Error('Writer request capacity.');
      this.host.db.prepare('INSERT INTO gh_promotion_enable_receipts VALUES(?,?)').run(key, handle);
    }
    const result = await port.command({
      kind: 'designate',
      writerId: port.enrollment.installationId,
    });
    if (!result.ok || result.value.kind !== 'designated')
      throw new Error('Shared feed writer selection is unavailable.');
    this.host.db
      .prepare(
        "INSERT INTO gh_promotion_writers(enrollment_handle,enabled,state) VALUES(?,1,'ready') ON CONFLICT(enrollment_handle) DO UPDATE SET enabled=1,state='ready'",
      )
      .run(handle);
    void this.pass();
    return {
      state: 'ready',
      message:
        'This computer retains shared sources and resumes their concise feed delivery under native admission.',
    };
  }
  pass(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.runPass()
      .catch(() => {})
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async runPass() {
    // Bounded round-robin over finite local producer and writer journals.
    let pending = this.host.db
      .prepare(
        "SELECT rowid,receipt_id,enrollment_handle FROM gh_promotion_inputs WHERE rowid>? AND state NOT IN ('complete','suppressed') ORDER BY rowid LIMIT 2",
      )
      .all(this.inputCursor);
    if (!pending.length) {
      this.inputCursor = 0;
      pending = this.host.db
        .prepare(
          "SELECT rowid,receipt_id,enrollment_handle FROM gh_promotion_inputs WHERE state NOT IN ('complete','suppressed') ORDER BY rowid LIMIT 2",
        )
        .all();
    }
    for (const row of pending) {
      if (this.closed) return;
      this.inputCursor = Number(row.rowid);
      if (
        !this.host.localVisible(String(row.enrollment_handle)) ||
        !this.host.localContributing(String(row.enrollment_handle))
      )
        continue;
      await this.status(String(row.receipt_id));
    }
    const writers = this.host.db
      .prepare(
        'SELECT enrollment_handle,cursor FROM gh_promotion_writers WHERE enabled=1 ORDER BY rowid LIMIT 32',
      )
      .all();
    for (let n = 0; n < Math.min(2, writers.length); n++) {
      const writer = writers[this.writerCursor++ % writers.length]!;
      if (this.closed) return;
      const handle = String(writer.enrollment_handle);
      if (!this.host.localVisible(handle) || !this.host.localContributing(handle)) continue;
      let stage = 'writer enrollment';
      try {
        const port = await this.host.promotionContext(handle);
        const pending = await port.command({ kind: 'pending', after: Number(writer.cursor) });
        if (!pending.ok || pending.value.kind !== 'pending')
          throw new Error('pending sources unavailable');
        const source = pending.value.source;
        this.host.db
          .prepare('UPDATE gh_promotion_writers SET cursor=?,state=? WHERE enrollment_handle=?')
          .run(
            pending.value.position,
            `${pending.value.pending} pending; ${pending.value.retained}/${pending.value.capacity} retained`,
            handle,
          );
        if (!source) continue;
        const renewed = await port.command({ kind: 'renew' });
        if (!renewed.ok) throw new Error('writer unavailable');
        if (source.scope.groupId !== port.context.groupId)
          throw new Error('Producer group alias unavailable.');
        stage = 'original source context';
        this.host.events.trustedHostSharedContext(
          {
            groupId: source.scope.groupId,
            memberId: source.scope.memberId,
            installationId: source.scope.installationId,
            visibility: 'shared',
            provider: source.scope.source.provider,
            nativeSessionId: source.scope.source.nativeSessionId,
            sessionId: source.scope.source.sessionId,
          },
          pending.value.displayName!,
        );
        stage = 'projection binding';
        let saved = this.host.db
          .prepare(
            'SELECT source_json,registration_operation,enrollment_handle FROM gh_promotion_projections WHERE source_id=? AND version=?',
          )
          .get(source.key.sourceId, source.key.version);
        if (!saved) {
          const projected = groupPromotionSourceSchema.parse({
            ...source,
            writerId: port.enrollment.installationId,
            projectionScope: groupScopeSchema.parse({
              groupId: port.context.groupId,
              memberId: port.context.memberId,
              installationId: port.context.installationId,
              visibility: 'shared',
              source: {
                sessionId: port.context.sessionId,
                provider: port.context.provider,
                nativeSessionId: port.context.nativeSessionId,
                messageId: randomUUID(),
              },
              causalRefs: source.scope.causalRefs,
            }),
          });
          this.host.db
            .prepare('INSERT INTO gh_promotion_projections VALUES(?,?,?,?,?)')
            .run(
              source.key.sourceId,
              source.key.version,
              handle,
              publicationCanonical(projected),
              randomUUID(),
            );
          saved = this.host.db
            .prepare(
              'SELECT source_json,registration_operation,enrollment_handle FROM gh_promotion_projections WHERE source_id=? AND version=?',
            )
            .get(source.key.sourceId, source.key.version)!;
        }
        if (saved.enrollment_handle !== handle)
          throw new Error('Existing projection retains its original writer.');
        const selected = groupPromotionSourceSchema.parse(JSON.parse(String(saved.source_json)));
        stage = 'projection source registration';
        await port.registerSource(
          selected.projectionScope.source,
          String(saved.registration_operation),
        );
        stage = 'source adoption';
        const adopted = await port.command({ kind: 'adopt', source: selected });
        if (!adopted.ok || adopted.value.kind !== 'registered')
          throw new Error('Source adoption unavailable.');
        const controller = new GroupPromotionController(
          this.host.events,
          {
            command: async (command, signal) => {
              const result = await port.command({ kind: 'command', command }, signal);
              if (!result.ok)
                return {
                  kind: 'unavailable',
                  reason: result.error === 'limit' ? 'limit' : 'denied',
                };
              return result.value;
            },
            enqueue: (scope, eventId) => port.enqueue(scope, eventId),
            synthesis: this.synthesis,
          },
          this.index,
        );
        stage = 'promotion';
        const result = await controller.promote(async () => {
          await port.revalidate();
          return selected;
        });
        this.host.db
          .prepare('UPDATE gh_promotion_writers SET state=? WHERE enrollment_handle=?')
          .run(
            `${result.state}; ${pending.value.pending} pending; ${pending.value.retained}/${pending.value.capacity} retained`,
            handle,
          );
      } catch {
        this.host.db
          .prepare('UPDATE gh_promotion_writers SET state=? WHERE enrollment_handle=?')
          .run(`pending: ${stage} unavailable; originals retained`, handle);
      }
    }
  }
}
