import {
  DELIVERY_LIMITS as L,
  deliveryEnvelopeSchema,
  deliveryReplySchema,
  publicationCanonical as canonical,
  publicationEnvelopeSchema,
  publicationHeaderSchema,
  publicationReceiptSchema,
  type DeliveryEnvelope,
  type DeliveryResult,
  type DeliveryCommand,
  type DeliveryAuthor,
  type PublicationBinding,
  type PublicationHeader,
  type PublicationKey,
  type PublicationReceipt,
} from '@dock/shared/dist/group-delivery.js';
import { MEMBERSHIP_LIMITS } from '@dock/shared/dist/group-membership.js';
import { capabilityHash, hostingEnvironment } from './crypto.js';
import { MEMBERSHIP_CAPACITY as C } from './capacity.js';
import {
  GroupFeatureStorage,
  GroupFeatureStorageLimit,
  publicationGrowthReserve,
  documentGrowthReserve,
} from './group-feature-storage.js';
import { chatDeliveryConflict } from './chat-source-delivery.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS delivery_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), allocated INTEGER NOT NULL DEFAULT 0,
 logical INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, probe INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO delivery_control(singleton) VALUES(1);
CREATE TABLE IF NOT EXISTS delivery_sources (
 source_id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL, operation_id TEXT NOT NULL,
 binding TEXT NOT NULL, member_id TEXT NOT NULL, provider TEXT NOT NULL,
 native_id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL UNIQUE, session_id TEXT UNIQUE,
 UNIQUE(credential_hash,operation_id)
);
CREATE TABLE IF NOT EXISTS delivery_operations (
 operation_id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL,
 header TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('staged','committed')), sequence INTEGER UNIQUE, receipt TEXT
);
CREATE TABLE IF NOT EXISTS delivery_chunks (
 operation_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk TEXT NOT NULL,
 PRIMARY KEY(operation_id,chunk_index)
);
CREATE TRIGGER IF NOT EXISTS delivery_chunks_no_update BEFORE UPDATE ON delivery_chunks
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_chunks_no_delete BEFORE DELETE ON delivery_chunks
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_operations_no_delete BEFORE DELETE ON delivery_operations
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_operations_immutable BEFORE UPDATE ON delivery_operations
WHEN OLD.state='committed' OR NEW.header<>OLD.header OR NEW.event_id<>OLD.event_id
 OR NEW.operation_id<>OLD.operation_id OR NEW.credential_hash<>OLD.credential_hash OR NEW.source_id<>OLD.source_id
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_sources_no_delete BEFORE DELETE ON delivery_sources
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_sources_immutable BEFORE UPDATE ON delivery_sources
WHEN OLD.session_id IS NOT NULL OR NEW.source_id<>OLD.source_id OR NEW.binding<>OLD.binding
 OR NEW.member_id<>OLD.member_id OR NEW.provider<>OLD.provider OR NEW.native_id<>OLD.native_id
 OR NEW.message_id<>OLD.message_id OR NEW.credential_hash<>OLD.credential_hash OR NEW.operation_id<>OLD.operation_id
BEGIN SELECT RAISE(ABORT,'immutable'); END;
`;
type Operation = {
  operation_id: string;
  credential_hash: string;
  header: string;
  event_id: string;
  source_id: string;
  state: string;
  sequence: number | null;
  receipt: string | null;
};
type Actor = { installation_id: string; member_id: string; state: string };
type Source = {
  source_id: string;
  installation_id: string;
  operation_id: string;
  binding: string;
  member_id: string;
  provider: string;
  native_id: string;
  message_id: string;
  session_id: string;
};
export type RevocationFailure = {
  actorId: string;
  credentialHash: string;
  operationId: string;
  requestHash: string;
  targetId: string;
};
const REVOCATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS delivery_revocations (
 target_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, credential_hash TEXT NOT NULL,
 operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','resolved'))
);
CREATE TRIGGER IF NOT EXISTS delivery_revocations_immutable BEFORE UPDATE ON delivery_revocations
WHEN NEW.target_id<>OLD.target_id OR NEW.actor_id<>OLD.actor_id OR NEW.credential_hash<>OLD.credential_hash
 OR NEW.operation_id<>OLD.operation_id OR NEW.request_hash<>OLD.request_hash OR OLD.state='resolved'
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_revocations_no_delete BEFORE DELETE ON delivery_revocations BEGIN SELECT RAISE(ABORT,'retained'); END;
`;
const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS delivery_identities (
 installation_id TEXT PRIMARY KEY, remote_member_id TEXT NOT NULL, local_group_id TEXT NOT NULL,
 local_installation_id TEXT NOT NULL, local_member_id TEXT NOT NULL, binding TEXT NOT NULL,
 UNIQUE(local_group_id,local_installation_id), UNIQUE(local_group_id,local_member_id)
);
CREATE TABLE IF NOT EXISTS delivery_contexts (
 session_id TEXT PRIMARY KEY, native_id TEXT NOT NULL UNIQUE, installation_id TEXT NOT NULL,
 binding TEXT NOT NULL, member_id TEXT NOT NULL, provider TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_messages (
 source_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 binding TEXT NOT NULL, member_id TEXT NOT NULL, provider TEXT NOT NULL,
 native_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
 UNIQUE(installation_id,operation_id)
);
CREATE TABLE IF NOT EXISTS delivery_authors (
 operation_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, member_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_version (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS delivery_identities_no_update BEFORE UPDATE ON delivery_identities BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_identities_no_delete BEFORE DELETE ON delivery_identities BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_contexts_no_update BEFORE UPDATE ON delivery_contexts BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_contexts_no_delete BEFORE DELETE ON delivery_contexts BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_messages_no_update BEFORE UPDATE ON delivery_messages BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_messages_no_delete BEFORE DELETE ON delivery_messages BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_authors_no_update BEFORE UPDATE ON delivery_authors BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_authors_no_delete BEFORE DELETE ON delivery_authors BEGIN SELECT RAISE(ABORT,'immutable'); END;

`;
class Denial extends Error {
  constructor(readonly code: 'denied' | 'invalid' | 'conflict' | 'limit' | 'unavailable') {
    super(code);
  }
}
function deny(code: Denial['code']): never {
  throw new Denial(code);
}
const keyOf = (command: DeliveryCommand): PublicationKey | null =>
  command.kind === 'receipt'
    ? command.key
    : command.kind === 'effect'
      ? command.packet.kind === 'begin'
        ? command.packet.header
        : command.packet.key
      : null;

/** Same SQLite object as membership. No awaits are allowed in the auth/effect transaction. */
export class DeliveryStorage {
  private ready = false;
  private features!: GroupFeatureStorage;
  constructor(private readonly storage: DurableObjectStorage) {
    // Marker trees belong to the bounded membership reserve, never event allocation.
    storage.transactionSync(() => storage.sql.exec(REVOCATION_SCHEMA).toArray());
    this.initialize();
  }
  recover(): void {
    if (!this.ready) this.initialize();
  }
  private initialize(): void {
    const storage = this.storage;
    try {
      storage.transactionSync(() => {
        const before = storage.sql.databaseSize;
        storage.sql.exec(SCHEMA).toArray();
        storage.sql.exec(V2_SCHEMA).toArray();
        const version = this.rows<{ version: number }>(
          'SELECT version FROM delivery_version WHERE singleton=1',
        )[0];
        if (version && version.version !== 2) deny('unavailable');
        let logical = 0;
        if (!version) {
          logical = this.migrateLegacy();
          this.rows('INSERT INTO delivery_version VALUES(1,2)');
        }
        this.features = new GroupFeatureStorage(storage);
        storage.sql
          .exec(
            `CREATE TABLE IF NOT EXISTS delivery_actor_pending(installation_id TEXT PRIMARY KEY,n INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS delivery_pending_insert AFTER INSERT ON delivery_operations WHEN NEW.state='staged' BEGIN INSERT INTO delivery_actor_pending SELECT installation_id,1 FROM delivery_authors WHERE operation_id=NEW.operation_id ON CONFLICT(installation_id) DO UPDATE SET n=n+1; END;
CREATE TRIGGER IF NOT EXISTS delivery_pending_complete AFTER UPDATE OF state ON delivery_operations WHEN OLD.state='staged' AND NEW.state='committed' BEGIN UPDATE delivery_actor_pending SET n=n-1 WHERE installation_id=(SELECT installation_id FROM delivery_authors WHERE operation_id=NEW.operation_id); END;`,
          )
          .toArray();
        if (
          !this.rows(
            "SELECT name FROM delivery_feature_table_bytes WHERE name='delivery_operations'",
          ).length
        ) {
          this.rows(
            "INSERT OR REPLACE INTO delivery_actor_pending SELECT a.installation_id,count(*) FROM delivery_operations o JOIN delivery_authors a USING(operation_id) WHERE o.state='staged' GROUP BY a.installation_id",
          );
          this.features.track('delivery_operations');
        }
        this.rows(
          'CREATE TABLE IF NOT EXISTS delivery_feature_legacy_reservations(singleton INTEGER PRIMARY KEY CHECK(singleton=1))',
        );
        if (!this.rows('SELECT singleton FROM delivery_feature_legacy_reservations').length) {
          for (const old of this.rows<Operation>(
            "SELECT * FROM delivery_operations WHERE state='staged'",
          )) {
            const header = publicationHeaderSchema.parse(JSON.parse(old.header));
            const reserve = publicationGrowthReserve(
              header.event.manifest.bytes,
              header.event.manifest.chunks.length,
            );
            this.features.reserve(
              'delivery:' + old.operation_id,
              reserve.logical,
              reserve.physical,
            );
            if (old.receipt === null)
              this.rows(
                'UPDATE delivery_operations SET receipt=? WHERE operation_id=?',
                ' '.repeat(8192),
                old.operation_id,
              );
          }
          if (this.rows("SELECT name FROM sqlite_master WHERE name='document_publications'").length)
            for (const old of this.rows<{ id: string; manifest: string }>(
              "SELECT id,manifest FROM document_publications WHERE state='staged'",
            )) {
              const manifest = JSON.parse(old.manifest) as { files: { bytes: number }[] };
              this.features.reserve(
                'document:' + old.id,
                0,
                documentGrowthReserve(
                  manifest.files.reduce((n, f) => n + f.bytes, 0),
                  manifest.files.reduce((n, f) => n + Math.ceil(f.bytes / 49152), 0),
                ) +
                  new TextEncoder().encode(old.manifest).length * 2,
              );
            }
          if (
            this.rows("SELECT name FROM sqlite_master WHERE name='group_promotion_producers'")
              .length
          ) {
            const receipts = this.rows(
              "SELECT name FROM sqlite_master WHERE name='group_promotion_receipts'",
            ).length;
            for (const old of this.rows<{
              source_id: string;
              version: string;
              source_json: string;
            }>('SELECT * FROM group_promotion_producers')) {
              const source = JSON.parse(old.source_json) as { kind: string };
              if (
                ['human', 'native'].includes(source.kind) &&
                this.rows(
                  "SELECT operation_id FROM delivery_operations WHERE source_id=? AND state='committed'",
                  old.source_id,
                ).length
              )
                continue;
              if (
                receipts &&
                this.rows(
                  "SELECT source_id FROM group_promotion_receipts WHERE source_id=? AND version=? AND (json_extract(receipt_json,'$.publicationOperationId') IS NOT NULL OR json_extract(receipt_json,'$.disposition') IS NOT NULL)",
                  old.source_id,
                  old.version,
                ).length
              )
                continue;
              const bytes = new TextEncoder().encode(old.source_json).length;
              this.features.reserve(
                'promotion:' + old.source_id + ':' + old.version,
                bytes * 2 + 128 * 1024,
                bytes * 4 + 1024 * 1024,
              );
            }
          }
          this.rows('INSERT INTO delivery_feature_legacy_reservations VALUES(1)');
        }
        const growth = Math.max(0, storage.sql.databaseSize - before);
        const control = this.rows<{ allocated: number; logical: number }>(
          'SELECT allocated,logical FROM delivery_control WHERE singleton=1',
        )[0];
        if (
          control.allocated + growth > L.databaseBytes ||
          control.logical + logical > L.logicalBytes ||
          (growth > 0 && storage.sql.databaseSize > C.normalDatabaseBytes + L.databaseBytes)
        )
          deny('limit');
        if (growth > 0 || logical > 0)
          this.rows(
            'UPDATE delivery_control SET allocated=allocated+?,logical=logical+? WHERE singleton=1',
            growth,
            logical,
          );
        if (growth > 0) this.features.fence();
      });
      this.ready = true;
    } catch {
      // No reset or reserve consumption on incompatible/full legacy delivery migration.
      // Membership revocation and its marker/retry path remain available.
    }
  }
  private rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...args: SqlStorageValue[]
  ): T[] {
    return this.storage.sql.exec<T>(query, ...args).toArray();
  }
  allocated(): number {
    return this.rows<{ allocated: number }>(
      'SELECT allocated FROM delivery_control WHERE singleton=1',
    )[0].allocated;
  }
  normalSize(): number {
    return (
      this.storage.sql.databaseSize - (this.allocated() - this.features.control().future_physical)
    );
  }
  /** Probe current write admission. A failed, unacknowledged revoke is not a completed revoke. */
  probe(): void {
    if (!this.ready) deny('unavailable');
    // Legacy ambiguous blocked state is retained, never silently reset.
    if (
      this.rows<{ blocked: number }>('SELECT blocked FROM delivery_control WHERE singleton=1')[0]
        .blocked
    )
      deny('unavailable');
    this.rows(
      "UPDATE delivery_revocations SET state='resolved' WHERE state='open' AND EXISTS(SELECT 1 FROM enrollments WHERE installation_id=target_id AND state='revoked')",
    );
    if (this.rows("SELECT target_id FROM delivery_revocations WHERE state='open' LIMIT 1")[0])
      deny('unavailable');
    this.rows('UPDATE delivery_control SET probe=1-probe WHERE singleton=1');
  }
  async failClosed(marker?: RevocationFailure): Promise<void> {
    // Ordinary transient storage faults recover only through the mandatory real write probe.
    // Only a failed authorized revoke leaves a bounded durable request-specific marker.
    if (!marker) return;
    try {
      this.storage.transactionSync(() => {
        const existing = this.rows(
          'SELECT target_id FROM delivery_revocations WHERE target_id=?',
          marker.targetId,
        )[0];
        if (
          !existing &&
          this.rows<{ n: number }>('SELECT count(*) AS n FROM delivery_revocations')[0].n >=
            MEMBERSHIP_LIMITS.enrollments
        )
          deny('unavailable');
        this.rows(
          "INSERT INTO delivery_revocations(target_id,actor_id,credential_hash,operation_id,request_hash,state) VALUES(?,?,?,?,?,'open') ON CONFLICT(target_id) DO NOTHING",
          marker.targetId,
          marker.actorId,
          marker.credentialHash,
          marker.operationId,
          marker.requestHash,
        );
      });
      await this.storage.sync();
    } catch {
      /* Entirely unwritable failures cannot claim a persisted intent; retry remains explicit. */
    }
  }
  resolveRevocation(targetId: string): void {
    this.rows(
      "UPDATE delivery_revocations SET state='resolved' WHERE target_id=? AND state='open'",
      targetId,
    );
  }
  recoveredRevocation(marker: RevocationFailure): boolean {
    const row = this.rows<{
      actor_id: string;
      credential_hash: string;
      operation_id: string;
      request_hash: string;
    }>('SELECT * FROM delivery_revocations WHERE target_id=?', marker.targetId)[0];
    return (
      !!row &&
      row.actor_id === marker.actorId &&
      row.credential_hash === marker.credentialHash &&
      row.operation_id === marker.operationId &&
      row.request_hash === marker.requestHash
    );
  }
  private author(operationId: string, groupId: string): DeliveryAuthor {
    const row = this.rows<{ installation_id: string; member_id: string }>(
      'SELECT installation_id,member_id FROM delivery_authors WHERE operation_id=?',
      operationId,
    )[0];
    if (!row) deny('unavailable');
    return { groupId, installationId: row.installation_id, memberId: row.member_id };
  }
  private identity(binding: PublicationBinding, memberId: string, actor: Actor): void {
    const previous = this.rows<{
      local_group_id: string;
      local_installation_id: string;
      local_member_id: string;
      binding: string;
      remote_member_id: string;
    }>('SELECT * FROM delivery_identities WHERE installation_id=?', actor.installation_id)[0];
    if (previous) {
      if (
        previous.local_group_id !== binding.groupId ||
        previous.local_installation_id !== binding.installationId ||
        previous.local_member_id !== memberId ||
        previous.binding !== canonical(binding) ||
        previous.remote_member_id !== actor.member_id
      )
        deny('conflict');
      return;
    }
    if (
      this.rows(
        'SELECT installation_id FROM delivery_identities WHERE (local_group_id=? AND local_installation_id=?) OR (local_group_id=? AND local_member_id=?)',
        binding.groupId,
        binding.installationId,
        binding.groupId,
        memberId,
      )[0]
    )
      deny('conflict');
    this.rows(
      'INSERT INTO delivery_identities VALUES(?,?,?,?,?,?)',
      actor.installation_id,
      actor.member_id,
      binding.groupId,
      binding.installationId,
      memberId,
      canonical(binding),
    );
  }
  private migrateLegacy(): number {
    // Additive, atomic migration; archived v1 sources/operations/chunks/receipts stay byte-exact.
    const rows = this.rows<{
      source_id: string;
      credential_hash: string;
      operation_id: string;
      binding: string;
      member_id: string;
      provider: string;
      native_id: string;
      message_id: string;
      session_id: string | null;
    }>('SELECT * FROM delivery_sources');
    let logical = 0;
    for (const row of rows) {
      if (row.session_id === null) continue;
      const actor = this.rows<Actor>(
        'SELECT installation_id,member_id,state FROM enrollments WHERE credential_hash=?',
        row.credential_hash,
      )[0];
      if (!actor) deny('unavailable');
      logical += 2048;
      const binding = JSON.parse(row.binding) as PublicationBinding;
      this.identity(binding, row.member_id, actor);
      this.rows(
        'INSERT INTO delivery_contexts VALUES(?,?,?,?,?,?)',
        row.session_id,
        row.native_id,
        actor.installation_id,
        row.binding,
        row.member_id,
        row.provider,
      );
      this.rows(
        'INSERT INTO delivery_messages VALUES(?,?,?,?,?,?,?,?,?)',
        row.source_id,
        actor.installation_id,
        row.operation_id,
        row.binding,
        row.member_id,
        row.provider,
        row.native_id,
        row.message_id,
        row.session_id,
      );
    }
    const operations = this.rows<Operation>('SELECT * FROM delivery_operations');
    for (const op of operations) {
      logical += 128;
      const source = this.rows<Source>(
        'SELECT * FROM delivery_messages WHERE source_id=?',
        op.source_id,
      )[0];
      const actor = this.rows<Actor>(
        'SELECT installation_id,member_id,state FROM enrollments WHERE credential_hash=?',
        op.credential_hash,
      )[0];
      if (!source || !actor || source.installation_id !== actor.installation_id)
        deny('unavailable');
      this.rows(
        'INSERT INTO delivery_authors VALUES(?,?,?)',
        op.operation_id,
        actor.installation_id,
        actor.member_id,
      );
    }
    return logical;
  }
  private write(work: () => void, bytes: number, reservation?: string): void {
    if (this.rows<{ page_size: number }>('PRAGMA page_size')[0].page_size !== C.pageBytes)
      deny('unavailable');
    try {
      this.features.account(work, bytes, reservation);
    } catch (error) {
      if (error instanceof GroupFeatureStorageLimit) deny('limit');
      throw error;
    }
  }
  private binding(binding: PublicationBinding, groupId: string, actor: Actor): void {
    if (binding.remoteGroupId !== groupId) deny('denied');
    const owner = this.rows<{ installation_id: string; binding: string }>(
      'SELECT installation_id,binding FROM delivery_identities WHERE local_group_id=? AND local_installation_id=?',
      binding.groupId,
      binding.installationId,
    )[0];
    if (
      owner &&
      (owner.installation_id !== actor.installation_id || owner.binding !== canonical(binding))
    )
      deny('denied');
  }
  private receipt(key: PublicationKey, actor: Actor): PublicationReceipt {
    const op = this.rows<Operation>(
      'SELECT * FROM delivery_operations WHERE operation_id=?',
      key.operationId,
    )[0];
    if (!op) return { ...key, state: 'absent' };
    if (
      this.author(op.operation_id, key.binding.remoteGroupId).installationId !==
      actor.installation_id
    )
      deny('denied');
    const header = JSON.parse(op.header) as PublicationHeader;
    if (
      canonical(header.binding) !== canonical(key.binding) ||
      header.payloadHash !== key.payloadHash
    )
      return { ...key, state: 'collision' };
    if (op.state === 'committed') return publicationReceiptSchema.parse(JSON.parse(op.receipt!));
    const present = new Set(
      this.rows<{ chunk_index: number }>(
        'SELECT chunk_index FROM delivery_chunks WHERE operation_id=?',
        key.operationId,
      ).map((r) => r.chunk_index),
    );
    return {
      ...key,
      state: 'staged',
      missing: header.event.manifest.chunks
        .filter((c) => !present.has(c.index))
        .map((c) => c.index),
    };
  }
  private effect(
    command: Extract<DeliveryCommand, { kind: 'effect' }>,
    actor: Actor,
    hash: string,
  ): PublicationReceipt {
    const packet = command.packet;
    const rawKey = packet.kind === 'begin' ? packet.header : packet.key;
    const key: PublicationKey = {
      version: rawKey.version,
      binding: rawKey.binding,
      operationId: rawKey.operationId,
      payloadHash: rawKey.payloadHash,
    };
    let receipt = this.receipt(key, actor);
    if (packet.kind === 'begin' && receipt.state !== 'absent') {
      const existing = this.rows<Operation>(
        'SELECT * FROM delivery_operations WHERE operation_id=?',
        key.operationId,
      )[0];
      if (existing.header !== canonical(packet.header)) return { ...key, state: 'collision' };
    }
    if (receipt.state === 'collision' || receipt.state === 'committed') return receipt;
    if (packet.kind === 'begin') {
      const header = packet.header;
      const source = this.rows<Source>(
        'SELECT * FROM delivery_messages WHERE native_id=? AND message_id=?',
        header.event.scope.source.nativeSessionId,
        header.event.scope.source.messageId,
      )[0];
      if (
        !source ||
        source.installation_id !== actor.installation_id ||
        source.binding !== canonical(header.binding) ||
        source.member_id !== header.event.scope.memberId ||
        source.provider !== header.event.scope.source.provider ||
        source.session_id !== header.event.scope.source.sessionId
      )
        deny('denied');
      if (receipt.state === 'staged') {
        const existing = this.rows<Operation>(
          'SELECT * FROM delivery_operations WHERE operation_id=?',
          key.operationId,
        )[0];
        if (existing.header !== canonical(header)) return { ...key, state: 'collision' };
        return receipt;
      }
      if (
        this.rows(
          'SELECT operation_id FROM delivery_operations WHERE event_id=? OR source_id=?',
          header.event.eventId,
          source.source_id,
        )[0]
      )
        return { ...key, state: 'collision' };
      // Evidence IDs must already denote committed shared originals in this exact group.
      const refs = new Set([
        ...header.event.scope.causalRefs,
        ...header.event.evidenceRefs,
        ...(header.event.corrects === null ? [] : [header.event.corrects]),
      ]);
      for (const ref of refs)
        if (
          !this.rows(
            "SELECT event_id FROM delivery_operations WHERE event_id=? AND state='committed'",
            ref,
          )[0]
        )
          deny('denied');
      if (
        this.rows<{ n: number }>(
          'SELECT coalesce(n,0) n FROM delivery_actor_pending WHERE installation_id=?',
          actor.installation_id,
        )[0]?.n >= L.staged
      )
        deny('limit');
      const text = canonical(header);
      const reserve = publicationGrowthReserve(
        header.event.manifest.bytes,
        header.event.manifest.chunks.length,
      );
      try {
        this.features.reserve('delivery:' + key.operationId, reserve.logical, reserve.physical);
      } catch (error) {
        if (error instanceof GroupFeatureStorageLimit) deny('limit');
        throw error;
      }
      this.write(() => {
        this.rows(
          'INSERT INTO delivery_authors VALUES(?,?,?)',
          key.operationId,
          actor.installation_id,
          actor.member_id,
        );
        this.rows(
          'INSERT INTO delivery_operations(operation_id,credential_hash,header,event_id,source_id,state,receipt) VALUES(?,?,?,?,?,?,?)',
          key.operationId,
          hash,
          text,
          header.event.eventId,
          source.source_id,
          'staged',
          ' '.repeat(8192),
        );
      }, new TextEncoder().encode(text).length);
    } else if (receipt.state === 'staged') {
      const op = this.rows<Operation>(
        'SELECT * FROM delivery_operations WHERE operation_id=?',
        key.operationId,
      )[0];
      const header = JSON.parse(op.header) as PublicationHeader;
      const reservation = 'delivery:' + key.operationId;
      if (!this.features.reservation(reservation)) {
        const reserve = publicationGrowthReserve(
          header.event.manifest.bytes,
          header.event.manifest.chunks.length,
        );
        try {
          this.features.reserve(reservation, reserve.logical, reserve.physical);
        } catch (error) {
          if (error instanceof GroupFeatureStorageLimit) deny('limit');
          throw error;
        }
      }
      if (packet.kind === 'chunk') {
        const manifest = header.event.manifest.chunks[packet.chunk.index];
        if (
          !manifest ||
          manifest.bytes !== packet.chunk.bytes ||
          manifest.sha256 !== packet.chunk.sha256
        )
          return { ...key, state: 'collision' };
        const old = this.rows<{ chunk: string }>(
          'SELECT chunk FROM delivery_chunks WHERE operation_id=? AND chunk_index=?',
          key.operationId,
          packet.chunk.index,
        )[0];
        const text = canonical(packet.chunk);
        if (old) {
          if (old.chunk !== text) return { ...key, state: 'collision' };
        } else
          this.write(
            () =>
              this.rows(
                'INSERT INTO delivery_chunks VALUES(?,?,?)',
                key.operationId,
                packet.chunk.index,
                text,
              ),
            new TextEncoder().encode(text).length,
            reservation,
          );
      } else if (receipt.missing.length === 0) {
        const chunks = this.rows<{ chunk: string }>(
          'SELECT chunk FROM delivery_chunks WHERE operation_id=? ORDER BY chunk_index',
          key.operationId,
        ).map((r) => JSON.parse(r.chunk) as unknown);
        if (!publicationEnvelopeSchema.safeParse({ header, chunks }).success)
          return { ...key, state: 'collision' };
        const original = chunks.map((chunk) => (chunk as { text: string }).text).join('');
        if (chatDeliveryConflict(this.storage.sql, op.source_id, original))
          return { ...key, state: 'collision' };
        const sequence = this.rows<{ n: number }>(
          'SELECT COALESCE(MAX(sequence),0)+1 AS n FROM delivery_operations',
        )[0].n;
        if (!Number.isSafeInteger(sequence)) deny('limit');
        const committed = publicationReceiptSchema.parse({
          ...key,
          state: 'committed',
          eventId: header.event.eventId,
          remoteSequence: sequence,
        });
        const text = canonical(committed);
        this.write(
          () => {
            // Reuse the preallocated receipt column before growing the sequence index.
            this.rows(
              'UPDATE delivery_operations SET receipt=? WHERE operation_id=?',
              text,
              key.operationId,
            );
            this.rows(
              "UPDATE delivery_operations SET state='committed',sequence=? WHERE operation_id=?",
              sequence,
              key.operationId,
            );
          },
          new TextEncoder().encode(text).length,
          reservation,
        );
        this.features.release(reservation);
        if (
          this.rows("SELECT name FROM sqlite_master WHERE name='group_promotion_producers'").length
        )
          for (const original of this.rows<{ version: string }>(
            "SELECT version FROM group_promotion_producers WHERE source_id=? AND json_extract(source_json,'$.kind') IN ('human','native')",
            op.source_id,
          )) {
            this.features.release('promotion:' + op.source_id + ':' + original.version);
            if (
              this.rows("SELECT name FROM sqlite_master WHERE name='group_promotion_pending'")
                .length
            )
              this.rows(
                'UPDATE group_promotion_pending SET active=0 WHERE source_id=? AND version=?',
                op.source_id,
                original.version,
              );
          }
      }
    }
    receipt = this.receipt(key, actor);
    return publicationReceiptSchema.parse(receipt);
  }
  async execute(
    input: DeliveryEnvelope,
    ctx: DurableObjectState,
    env: Env,
  ): Promise<DeliveryResult> {
    try {
      if (!hostingEnvironment(env)) return { ok: false, error: 'hosting_disabled' };
      if (new TextEncoder().encode(JSON.stringify(input)).length > L.bodyBytes + 256)
        deny('invalid');
      const parsed = deliveryEnvelopeSchema.safeParse(input);
      if (!parsed.success) deny('invalid');
      const { groupId, credential, command } = parsed.data;
      if (!ctx.id.equals(env.GROUPS.idFromName(groupId))) deny('denied');
      const hash = await capabilityHash(groupId, 'installation', credential);
      this.recover();
      const result = ctx.storage.transactionSync(() => {
        const meta = this.rows<{ group_id: string }>(
          'SELECT group_id FROM metadata WHERE singleton=1',
        )[0];
        const actor = this.rows<Actor>(
          'SELECT installation_id,member_id,state FROM enrollments WHERE credential_hash=?',
          hash,
        )[0];
        if (meta?.group_id !== groupId || actor?.state !== 'active') deny('denied');
        this.probe();
        const key = keyOf(command);
        if (key) this.binding(key.binding, groupId, actor!);
        let value;
        if (command.kind === 'registerSource') {
          this.binding(command.binding, groupId, actor!);
          const existing = this.rows<Source>(
            'SELECT * FROM delivery_messages WHERE installation_id=? AND operation_id=?',
            actor!.installation_id,
            command.operationId,
          )[0];
          const { source } = command;
          if (existing) {
            if (
              existing.binding !== canonical(command.binding) ||
              existing.member_id !== command.memberId ||
              existing.provider !== source.provider ||
              existing.session_id !== source.sessionId ||
              existing.native_id !== source.nativeSessionId ||
              existing.message_id !== source.messageId
            )
              deny('conflict');
            value = {
              kind: 'registered',
              sourceId: existing.source_id,
              source,
              author: {
                groupId,
                installationId: actor!.installation_id,
                memberId: actor!.member_id,
              },
            };
          } else {
            const context = this.rows<{
              session_id: string;
              native_id: string;
              installation_id: string;
              binding: string;
              member_id: string;
              provider: string;
            }>(
              'SELECT * FROM delivery_contexts WHERE session_id=? OR native_id=?',
              source.sessionId,
              source.nativeSessionId,
            );
            if (
              context.some(
                (c) =>
                  c.session_id !== source.sessionId ||
                  c.native_id !== source.nativeSessionId ||
                  c.installation_id !== actor!.installation_id ||
                  c.binding !== canonical(command.binding) ||
                  c.member_id !== command.memberId ||
                  c.provider !== source.provider,
              )
            )
              deny('conflict');
            if (
              this.rows(
                'SELECT source_id FROM delivery_messages WHERE message_id=?',
                source.messageId,
              )[0] ||
              this.rows(
                'SELECT source_id FROM delivery_sources WHERE message_id=? AND session_id IS NULL',
                source.messageId,
              )[0]
            )
              deny('conflict');
            const sourceId = crypto.randomUUID();
            this.write(() => {
              this.identity(command.binding, command.memberId, actor!);
              if (context.length === 0)
                this.rows(
                  'INSERT INTO delivery_contexts VALUES(?,?,?,?,?,?)',
                  source.sessionId,
                  source.nativeSessionId,
                  actor!.installation_id,
                  canonical(command.binding),
                  command.memberId,
                  source.provider,
                );
              this.rows(
                'INSERT INTO delivery_messages VALUES(?,?,?,?,?,?,?,?,?)',
                sourceId,
                actor!.installation_id,
                command.operationId,
                canonical(command.binding),
                command.memberId,
                source.provider,
                source.nativeSessionId,
                source.messageId,
                source.sessionId,
              );
            }, 2048);
            value = {
              kind: 'registered',
              sourceId,
              source,
              author: {
                groupId,
                installationId: actor!.installation_id,
                memberId: actor!.member_id,
              },
            };
          }
        } else if (command.kind === 'receipt')
          value = { kind: 'receipt', receipt: this.receipt(command.key, actor!) };
        else if (command.kind === 'effect')
          value = { kind: 'receipt', receipt: this.effect(command, actor!, hash) };
        else if (command.kind === 'feed') {
          const max = this.rows<{ n: number }>(
            'SELECT COALESCE(MAX(sequence),0) AS n FROM delivery_operations',
          )[0].n;
          const cursor = command.cursor;
          if (cursor && (cursor.groupId !== groupId || cursor.watermark > max)) deny('denied');
          const watermark = cursor?.watermark ?? max,
            after = cursor?.after ?? command.after;
          const rows = this.rows<Operation>(
            "SELECT * FROM delivery_operations WHERE state='committed' AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?",
            after,
            watermark,
            command.limit + 1,
          );
          const entries = rows.slice(0, command.limit).map((r) => ({
            header: JSON.parse(r.header) as PublicationHeader,
            author: this.author(r.operation_id, groupId),
            remoteSequence: r.sequence!,
          }));
          value = {
            kind: 'feed',
            entries,
            watermark,
            continuation:
              rows.length > command.limit
                ? { version: 1, groupId, after: entries.at(-1)!.remoteSequence, watermark }
                : null,
          };
        } else {
          const op = this.rows<Operation>(
            "SELECT * FROM delivery_operations WHERE event_id=? AND state='committed'",
            command.eventId,
          )[0];
          if (!op) deny('denied');
          const header = JSON.parse(op.header) as PublicationHeader;
          if (command.start >= header.event.manifest.chunks.length) deny('invalid');
          const chunks = this.rows<{ chunk: string }>(
            'SELECT chunk FROM delivery_chunks WHERE operation_id=? AND chunk_index>=? ORDER BY chunk_index LIMIT ?',
            op.operation_id,
            command.start,
            command.count,
          ).map((r) => JSON.parse(r.chunk) as unknown);
          const next = command.start + chunks.length;
          value = {
            kind: 'expansion',
            header,
            author: this.author(op.operation_id, groupId),
            remoteSequence: op.sequence!,
            start: command.start,
            chunks,
            next: next < header.event.manifest.chunks.length ? next : null,
          };
        }
        const checked = deliveryReplySchema.parse(value);
        if (new TextEncoder().encode(canonical(checked)).length > L.responseBytes) deny('limit');
        return { ok: true as const, value: checked };
      });
      await ctx.storage.sync();
      return result;
    } catch (error) {
      if (!(error instanceof Denial)) await this.failClosed();
      return { ok: false, error: error instanceof Denial ? error.code : 'unavailable' };
    }
  }
}
