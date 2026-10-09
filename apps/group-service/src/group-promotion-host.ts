import { GROUP_LIMITS, groupUtf8Bytes } from '@dock/shared';
import type { GroupPromotionIdentity } from '@dock/shared/dist/group-promotion.js';
import type { GroupPromotionPolicy } from '@dock/shared/dist/group-promotion-authority.js';
import {
  publicationCanonical,
  publicationBindingSchema,
} from '@dock/shared/dist/group-delivery.js';
import {
  groupPromotionHostEnvelopeSchema,
  GROUP_PROMOTION_HOST_LIMITS,
  groupPromotionAttributionSchema,
  type GroupPromotionHostResult,
} from '@dock/shared/dist/group-promotion-host.js';
import { GroupPromotionDoHandler } from './group-promotion.js';
import { capabilityHash, digest } from './crypto.js';
import { chatSourceDelivered, directChatDelivered } from './chat-source-delivery.js';

type Actor = {
  member_id: string;
  installation_id: string;
  state: string;
  position: number;
  display_name: string;
};
const schema = `
CREATE TABLE IF NOT EXISTS group_promotion_producers (
 source_id TEXT NOT NULL, version TEXT NOT NULL, producer_installation TEXT NOT NULL,
 display_name TEXT NOT NULL, source_json TEXT NOT NULL, PRIMARY KEY(source_id,version)
);
CREATE TABLE IF NOT EXISTS group_promotion_sources (
 source_id TEXT NOT NULL, version TEXT NOT NULL, source_hash TEXT NOT NULL,
 source_json TEXT NOT NULL, original_hash TEXT NOT NULL, original_bytes INTEGER NOT NULL, PRIMARY KEY(source_id,version)
);
CREATE TABLE IF NOT EXISTS group_promotion_pending(source_id TEXT NOT NULL,version TEXT NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(source_id,version));
CREATE TABLE IF NOT EXISTS group_promotion_pending_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),pending INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS group_promotion_pending_insert AFTER INSERT ON group_promotion_pending BEGIN UPDATE group_promotion_pending_control SET pending=pending+NEW.active WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS group_promotion_pending_update AFTER UPDATE ON group_promotion_pending BEGIN UPDATE group_promotion_pending_control SET pending=pending+NEW.active-OLD.active WHERE singleton=1; END;
CREATE INDEX IF NOT EXISTS group_promotion_pending_active ON group_promotion_pending(active,source_id,version);
CREATE TRIGGER IF NOT EXISTS group_promotion_producer_pending AFTER INSERT ON group_promotion_producers BEGIN INSERT INTO group_promotion_pending VALUES(NEW.source_id,NEW.version,CASE WHEN json_extract(NEW.source_json,'$.kind') IN ('human','native') AND EXISTS(SELECT 1 FROM delivery_operations WHERE source_id=NEW.source_id AND state='committed') THEN 0 ELSE 1 END); END;
CREATE TRIGGER IF NOT EXISTS group_promotion_producers_no_update BEFORE UPDATE ON group_promotion_producers BEGIN SELECT RAISE(ABORT,'immutable producer original'); END;
CREATE TRIGGER IF NOT EXISTS group_promotion_producers_no_delete BEFORE DELETE ON group_promotion_producers BEGIN SELECT RAISE(ABORT,'retained producer original'); END;
CREATE TRIGGER IF NOT EXISTS group_promotion_sources_no_update BEFORE UPDATE ON group_promotion_sources BEGIN SELECT RAISE(ABORT,'immutable promotion source'); END;
CREATE TRIGGER IF NOT EXISTS group_promotion_sources_no_delete BEFORE DELETE ON group_promotion_sources BEGIN SELECT RAISE(ABORT,'retained promotion source'); END;
`;
export class GroupPromotionHostCapacity extends Error {}
class Refusal extends Error {
  constructor(readonly code: 'denied' | 'conflict' | 'limit') {
    super(code);
  }
}
const fail = (code: 'denied' | 'conflict' | 'limit'): never => {
  throw new Refusal(code);
};
const producer = (
  source: ReturnType<typeof groupPromotionHostEnvelopeSchema.parse>['command'] & {
    kind: 'register' | 'adopt';
  },
) => {
  const { writerId: _writer, projectionScope: _projection, ...original } = source.source;
  return publicationCanonical(original);
};
/** Immutable producer registration precedes designated-writer adoption. Both
 * stages, originals and publication proof share membership's transaction/budget. */
export class GroupPromotionHost {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly ports: {
      admitMutation(retained?: boolean): void;
      checkCapacity(retained?: boolean): void;
      probe(): void;
      accountStorage<T>(work: () => T, reservation?: string, retainedRead?: boolean): T;
      reserveSource(id: string, bytes: number): void;
      releaseSource(id: string): void;
      retained(table: string): number;
    },
  ) {
    storage.transactionSync(() => {
      const before = storage.sql.databaseSize;
      const work = () => {
        storage.sql.exec(schema).toArray();
        if (!this.rows('SELECT singleton FROM group_promotion_pending_control').length) {
          this.rows('INSERT INTO group_promotion_pending_control VALUES(1,0)');
          this.rows(
            "INSERT OR IGNORE INTO group_promotion_pending SELECT p.source_id,p.version,CASE WHEN EXISTS(SELECT 1 FROM delivery_operations o WHERE o.source_id=p.source_id AND o.state='committed') AND json_extract(p.source_json,'$.kind') IN ('human','native') THEN 0 ELSE 1 END FROM group_promotion_producers p",
          );
        }
        ports.checkCapacity(storage.sql.databaseSize === before);
      };
      ports.accountStorage(work, undefined, true);
    });
  }
  private rows<T extends Record<string, string | number | null>>(
    query: string,
    ...args: (string | number | null)[]
  ) {
    return this.storage.sql.exec<T>(query, ...args).toArray();
  }
  async execute(raw: unknown): Promise<GroupPromotionHostResult> {
    try {
      if (
        new TextEncoder().encode(JSON.stringify(raw)).length >
        GROUP_PROMOTION_HOST_LIMITS.bodyBytes + 256
      )
        return { ok: false, error: 'invalid' };
    } catch {
      return { ok: false, error: 'invalid' };
    }
    const parsed = groupPromotionHostEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid' };
    const { groupId, credential, command } = parsed.data;
    const hash = await capabilityHash(groupId, 'installation', credential);
    const sourceHash =
      command.kind === 'adopt' ? await digest(publicationCanonical(command.source)) : null;
    const original =
      command.kind === 'adopt'
        ? command.source.original.kind === 'inline'
          ? command.source.original.text
          : command.source.original.chunks.join('')
        : null;
    const originalHash = original === null ? null : await digest(original);
    try {
      const sourceKey =
        command.kind === 'register' || command.kind === 'adopt'
          ? command.source.key
          : command.kind === 'command'
            ? command.command.identity.key
            : null;
      const reservation = sourceKey
        ? 'promotion:' + sourceKey.sourceId + ':' + sourceKey.version
        : undefined;
      return this.storage.transactionSync(() => {
        const retainedRead = ['state', 'pending', 'attribution'].includes(command.kind);
        const retained =
          retainedRead ||
          Boolean(
            reservation &&
              this.rows('SELECT id FROM delivery_feature_reservations WHERE id=?', reservation)
                .length,
          );
        const work = (): GroupPromotionHostResult => {
          this.ports.probe();
          const meta = this.rows<{ group_id: string }>(
            'SELECT group_id FROM metadata WHERE singleton=1',
          )[0];
          const actor = this.rows<Actor>(
            'SELECT member_id,installation_id,state,position,display_name FROM enrollments WHERE credential_hash=?',
            hash,
          )[0];
          if (meta?.group_id !== groupId || actor?.state !== 'active') fail('denied');
          const writer = () =>
            this.rows<{ installation_id: string; expires: number }>(
              'SELECT installation_id,expires FROM group_promotion_writers WHERE group_id=?',
              groupId,
            )[0];
          const requireWriter = (fresh = true) => {
            const w = writer();
            if (w?.installation_id !== actor.installation_id || (fresh && w.expires <= Date.now()))
              fail('denied');
          };
          const source = (identity: GroupPromotionIdentity, requireActiveProducer = true) => {
            const row = this.rows<{
              source_hash: string;
              source_json: string;
              producer_installation: string;
            }>(
              'SELECT s.source_hash,s.source_json,p.producer_installation FROM group_promotion_sources s JOIN group_promotion_producers p USING(source_id,version) WHERE s.source_id=? AND s.version=?',
              identity.key.sourceId,
              identity.key.version,
            )[0];
            if (identity.key.groupId !== groupId || row?.source_hash !== identity.sourceHash)
              fail('denied');
            if (
              requireActiveProducer &&
              this.rows<{ state: string }>(
                'SELECT state FROM enrollments WHERE installation_id=?',
                row.producer_installation,
              )[0]?.state !== 'active'
            )
              fail('denied');
          };
          const policy: GroupPromotionPolicy = {
            authorize: (_a, identity) => {
              source(identity);
              if (directChatDelivered(this.storage.sql, identity.key.sourceId)) fail('denied');
            },
            authorizeWriter: (_a, writerId) => {
              const renewal =
                command.kind === 'renew' &&
                writer()?.installation_id === actor.installation_id &&
                writerId === actor.installation_id;
              if (
                (!renewal && actor.position !== 1) ||
                this.rows<{ state: string }>(
                  'SELECT state FROM enrollments WHERE installation_id=?',
                  writerId,
                )[0]?.state !== 'active'
              )
                fail('denied');
            },
            checkCapacity: () => this.ports.checkCapacity(retained),
            receiptAdmission: () => true,
            verifyPublished: (_a, identity, eventId, operationId) => {
              // Historical shared attribution survives producer revocation; new
              // promotion commands still require its current active membership.
              source(identity, command.kind !== 'attribution');
              const published = this.rows<{ header: string; installation_id: string }>(
                "SELECT o.header,a.installation_id FROM delivery_operations o JOIN delivery_authors a ON a.operation_id=o.operation_id WHERE o.operation_id=? AND o.event_id=? AND o.state='committed'",
                operationId,
                eventId,
              )[0];
              const receipt = this.rows<{ receipt_json: string }>(
                'SELECT receipt_json FROM group_promotion_receipts WHERE group_id=? AND source_id=? AND version=?',
                groupId,
                identity.key.sourceId,
                identity.key.version,
              )[0];
              const current = receipt
                ? (JSON.parse(receipt.receipt_json) as {
                    writerId: string;
                    operationId: string;
                    entityId: string;
                    eventId: string | null;
                    decision: { category: string; sentences: string[] } | null;
                  })
                : null;
              const header = published
                ? (JSON.parse(published.header) as {
                    event: {
                      operationId: string;
                      entityId: string;
                      eventId: string;
                      scope: unknown;
                      category: string;
                      condensedText: string;
                      manifest: { sha256: string; bytes: number };
                      evidenceRefs: string[];
                      corrects: string | null;
                    };
                  })
                : null;
              const adopted = this.rows<{
                source_json: string;
                original_hash: string;
                original_bytes: number;
              }>(
                'SELECT source_json,original_hash,original_bytes FROM group_promotion_sources WHERE source_id=? AND version=?',
                identity.key.sourceId,
                identity.key.version,
              )[0];
              const candidate = adopted
                ? (JSON.parse(adopted.source_json) as {
                    projectionScope: unknown;
                    correction: { entityId: string; eventId: string } | null;
                    evidenceRefs: string[];
                  })
                : null;
              if (
                !current ||
                !header ||
                published.installation_id !== current.writerId ||
                current.eventId !== eventId ||
                header.event.operationId !== current.operationId ||
                !candidate ||
                header.event.entityId !== (candidate.correction?.entityId ?? current.entityId) ||
                publicationCanonical(header.event.scope) !==
                  publicationCanonical(candidate.projectionScope) ||
                header.event.manifest.sha256 !== adopted.original_hash ||
                header.event.manifest.bytes !== adopted.original_bytes ||
                header.event.category !== current.decision?.category ||
                header.event.condensedText !== current.decision.sentences.join(' ') ||
                publicationCanonical(header.event.evidenceRefs) !==
                  publicationCanonical(candidate.evidenceRefs) ||
                header.event.corrects !== (candidate.correction?.eventId ?? null)
              )
                fail('denied');
            },
            authorizeDisposition: () => {
              fail('denied');
            },
            now: () => Date.now(),
            id: () => crypto.randomUUID(),
          };
          // Already inside the one authoritative transaction; nested callbacks are synchronous.
          const handler = new GroupPromotionDoHandler(
            { sql: this.storage.sql, transactionSync: (work) => work() },
            policy,
          );
          this
            .rows(`CREATE TRIGGER IF NOT EXISTS group_promotion_receipt_pending_insert AFTER INSERT ON group_promotion_receipts WHEN json_extract(NEW.receipt_json,'$.publicationOperationId') IS NOT NULL OR json_extract(NEW.receipt_json,'$.disposition') IS NOT NULL BEGIN UPDATE group_promotion_pending SET active=0 WHERE source_id=NEW.source_id AND version=NEW.version; END;
CREATE TRIGGER IF NOT EXISTS group_promotion_receipt_pending_update AFTER UPDATE ON group_promotion_receipts WHEN json_extract(NEW.receipt_json,'$.publicationOperationId') IS NOT NULL OR json_extract(NEW.receipt_json,'$.disposition') IS NOT NULL BEGIN UPDATE group_promotion_pending SET active=0 WHERE source_id=NEW.source_id AND version=NEW.version; END;`);
          this.rows(
            'CREATE TABLE IF NOT EXISTS group_promotion_pending_migration(singleton INTEGER PRIMARY KEY CHECK(singleton=1))',
          );
          if (!this.rows('SELECT singleton FROM group_promotion_pending_migration').length) {
            this.rows(
              "UPDATE group_promotion_pending SET active=0 WHERE EXISTS(SELECT 1 FROM group_promotion_receipts r WHERE r.source_id=group_promotion_pending.source_id AND r.version=group_promotion_pending.version AND (json_extract(r.receipt_json,'$.publicationOperationId') IS NOT NULL OR json_extract(r.receipt_json,'$.disposition') IS NOT NULL))",
            );
            this.rows('INSERT INTO group_promotion_pending_migration VALUES(1)');
          }
          const authorityActor = {
            groupId: parsed.data.groupId,
            installationId: actor.installation_id as Parameters<
              GroupPromotionDoHandler['designate']
            >[0]['installationId'],
          };
          if (command.kind === 'designate' || command.kind === 'renew') {
            this.ports.admitMutation();
            const writerId =
              command.kind === 'designate' ? command.writerId : authorityActor.installationId;
            handler.designate(authorityActor, writerId);
            return { ok: true, value: { kind: 'designated', writerId } };
          }
          if (command.kind === 'attribution') {
            const entries = command.eventIds.flatMap((eventId) => {
              const row = this.rows<{
                source_json: string;
                display_name: string;
                receipt_json: string;
                operation_id: string;
              }>(
                "SELECT s.source_json,p.display_name,r.receipt_json,o.operation_id FROM group_promotion_receipts r JOIN group_promotion_sources s USING(source_id,version) JOIN group_promotion_producers p USING(source_id,version) JOIN delivery_operations o ON o.event_id=json_extract(r.receipt_json,'$.eventId') AND o.state='committed' WHERE r.group_id=? AND json_extract(r.receipt_json,'$.eventId')=?",
                groupId,
                eventId,
              )[0];
              if (!row) return [];
              const receipt = JSON.parse(row.receipt_json);
              // Delivery can commit before its writer observes the acknowledgement.
              // Reuse exact same-DO proof; never infer provenance from a bound ID alone.
              policy.verifyPublished(authorityActor, receipt.identity, eventId, row.operation_id);
              const s = JSON.parse(row.source_json);
              return [
                groupPromotionAttributionSchema.parse({
                  eventId,
                  origin: {
                    key: s.key,
                    scope: s.scope,
                    kind: s.kind,
                    writerId: JSON.parse(row.receipt_json).writerId,
                    displayName: row.display_name,
                  },
                }),
              ];
            });
            return { ok: true, value: { kind: 'attribution', entries } };
          }
          if (command.kind === 'state') {
            if (command.key.groupId !== groupId) fail('denied');
            const p = this.rows<{ producer_installation: string }>(
              'SELECT producer_installation FROM group_promotion_producers WHERE source_id=? AND version=?',
              command.key.sourceId,
              command.key.version,
            )[0];
            if (
              !p ||
              this.rows<{ state: string }>(
                'SELECT state FROM enrollments WHERE installation_id=?',
                p.producer_installation,
              )[0]?.state !== 'active'
            )
              fail('denied');
            const r = this.rows<{ receipt_json: string }>(
              'SELECT receipt_json FROM group_promotion_receipts WHERE group_id=? AND source_id=? AND version=?',
              groupId,
              command.key.sourceId,
              command.key.version,
            )[0];
            const receipt = r
              ? (JSON.parse(r.receipt_json) as {
                  publicationOperationId: string | null;
                  disposition: unknown | null;
                })
              : null;
            return {
              ok: true,
              value: {
                kind: 'status',
                state:
                  receipt?.publicationOperationId ||
                  chatSourceDelivered(this.storage.sql, command.key.sourceId)
                    ? 'complete'
                    : receipt?.disposition
                      ? 'suppressed'
                      : 'pending',
              },
            };
          }
          if (command.kind === 'pending') {
            requireWriter(false);
            const pendingSql = `FROM group_promotion_producers p JOIN group_promotion_pending q USING(source_id,version) WHERE q.active=1`;
            const row = this.rows<{
              source_json: string;
              display_name: string;
              position: number;
            }>(
              `SELECT p.source_json,p.display_name,p.rowid AS position ${pendingSql} AND p.rowid>? ORDER BY p.rowid LIMIT 1`,
              command.after,
            )[0];
            return {
              ok: true,
              value: {
                kind: 'pending',
                source: row ? JSON.parse(row.source_json) : null,
                displayName: row?.display_name ?? null,
                position: row?.position ?? 0,
                retained: this.ports.retained('group_promotion_producers'),
                pending: this.rows<{ pending: number }>(
                  'SELECT pending FROM group_promotion_pending_control WHERE singleton=1',
                )[0].pending,
                capacity: 0 as const,
              },
            };
          }
          if (command.kind === 'register' || command.kind === 'adopt') {
            const s = command.source;
            if (
              groupUtf8Bytes(
                s.original.kind === 'inline' ? s.original.text : s.original.chunks.join(''),
              ) > GROUP_LIMITS.payloadBytes
            )
              fail('limit');
            if (
              s.key.groupId !== groupId ||
              s.contentMode !== 'shared-content' ||
              s.scope.visibility !== 'shared' ||
              s.projectionScope.visibility !== 'shared'
            )
              fail('denied');
            const matches = (scope: typeof s.scope, sourceId?: string) => {
              const row = this.rows<{
                source_id: string;
                installation_id: string;
                binding: string;
                member_id: string;
                provider: string;
                native_id: string;
                message_id: string;
                session_id: string;
              }>('SELECT * FROM delivery_messages WHERE message_id=?', scope.source.messageId)[0];
              if (
                !row ||
                (sourceId && row.source_id !== sourceId) ||
                row.installation_id !== actor.installation_id ||
                row.member_id !== scope.memberId ||
                row.provider !== scope.source.provider ||
                row.native_id !== scope.source.nativeSessionId ||
                row.session_id !== scope.source.sessionId
              )
                fail('denied');
              const binding = publicationBindingSchema.parse(JSON.parse(row.binding));
              if (
                binding.remoteGroupId !== groupId ||
                binding.groupId !== scope.groupId ||
                binding.installationId !== scope.installationId
              )
                fail('denied');
            };
            const prior = this.rows<{ source_json: string; producer_installation: string }>(
              'SELECT source_json,producer_installation FROM group_promotion_producers WHERE source_id=? AND version=?',
              s.key.sourceId,
              s.key.version,
            )[0];
            if (command.kind === 'register') {
              matches(s.scope, s.key.sourceId);
              if (
                (s.kind === 'human') !== (s.scope.source.provider === 'owner') ||
                s.writerId !== actor.installation_id
              )
                fail('denied');
              for (const eventId of [...s.scope.causalRefs, ...s.evidenceRefs])
                if (
                  !this.rows(
                    "SELECT event_id FROM delivery_operations WHERE event_id=? AND state='committed'",
                    eventId,
                  )[0]
                )
                  fail('denied');
              if (
                prior &&
                (prior.source_json !== publicationCanonical(s) ||
                  prior.producer_installation !== actor.installation_id)
              )
                fail('conflict');
              if (!prior) {
                if (
                  !(
                    ['human', 'native'].includes(s.kind) &&
                    this.rows(
                      "SELECT operation_id FROM delivery_operations WHERE source_id=? AND state='committed'",
                      s.key.sourceId,
                    ).length
                  )
                )
                  this.ports.reserveSource(reservation!, groupUtf8Bytes(publicationCanonical(s)));
                this.ports.admitMutation();
                this.rows(
                  'INSERT INTO group_promotion_producers VALUES(?,?,?,?,?)',
                  s.key.sourceId,
                  s.key.version,
                  actor.installation_id,
                  actor.display_name,
                  publicationCanonical(s),
                );
                this.ports.checkCapacity();
              }
              return { ok: true, value: { kind: 'retained', key: s.key } };
            }
            requireWriter();
            if (directChatDelivered(this.storage.sql, s.key.sourceId)) fail('denied');
            matches(s.projectionScope);
            if (
              !prior ||
              producer({ kind: 'register', source: JSON.parse(prior.source_json) }) !==
                producer(command) ||
              s.writerId !== actor.installation_id ||
              this.rows<{ state: string }>(
                'SELECT state FROM enrollments WHERE installation_id=?',
                prior.producer_installation,
              )[0]?.state !== 'active'
            )
              fail('denied');
            const adopted = this.rows<{ source_hash: string }>(
              'SELECT source_hash FROM group_promotion_sources WHERE source_id=? AND version=?',
              s.key.sourceId,
              s.key.version,
            )[0];
            if (adopted && adopted.source_hash !== sourceHash) fail('conflict');
            if (!adopted) {
              this.ports.admitMutation();
              this.rows(
                'INSERT INTO group_promotion_sources VALUES(?,?,?,?,?,?)',
                s.key.sourceId,
                s.key.version,
                sourceHash!,
                publicationCanonical(s),
                originalHash!,
                new TextEncoder().encode(original!).length,
              );
              this.ports.checkCapacity();
            }
            return {
              ok: true,
              value: { kind: 'registered', identity: { key: s.key, sourceHash: sourceHash! } },
            };
          }
          const before = this.ports.retained('group_promotion_transitions');
          const value = handler.command(authorityActor, command.command);
          if (this.ports.retained('group_promotion_transitions') !== before)
            this.ports.admitMutation(retained);
          this.ports.checkCapacity(retained);
          return { ok: true, value };
        };
        const result = this.ports.accountStorage(work, reservation, retainedRead);
        if (
          reservation &&
          result.ok &&
          result.value.kind === 'receipt' &&
          (result.value.receipt.publicationOperationId !== null ||
            result.value.receipt.disposition !== null)
        )
          this.ports.releaseSource(reservation);
        return result;
      });
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof GroupPromotionHostCapacity
            ? 'limit'
            : error instanceof Refusal
              ? error.code
              : 'unavailable',
      };
    }
  }
}
