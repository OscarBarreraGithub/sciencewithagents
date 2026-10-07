/// <reference types="node" />
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  DOCUMENT_TRANSPORT_LIMITS as L,
  documentTransportEnvelopeSchema,
  documentPublicationKey,
  documentTransportReplySchema,
  type DocumentTransportResult,
  type SharedDocumentManifest,
} from '@dock/shared/dist/group-document-transport.js';
import {
  publicationCanonical as canonical,
  DELIVERY_LIMITS,
} from '@dock/shared/dist/group-delivery.js';
import { MEMBERSHIP_CAPACITY as C } from './capacity.js';
import { capabilityHash } from './crypto.js';
const schema = `
CREATE TABLE IF NOT EXISTS document_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),logical INTEGER NOT NULL DEFAULT 0,day INTEGER NOT NULL DEFAULT 0,written INTEGER NOT NULL DEFAULT 0,read INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO document_control(singleton) VALUES(1);
CREATE TABLE IF NOT EXISTS document_publications(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,hash TEXT NOT NULL,actor TEXT NOT NULL,manifest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('staged','committed','revoked')),charge INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS document_chunks(publication TEXT NOT NULL,file TEXT NOT NULL,idx INTEGER NOT NULL,bytes BLOB NOT NULL,sha TEXT NOT NULL,PRIMARY KEY(publication,file,idx));
CREATE TRIGGER IF NOT EXISTS document_chunks_no_update BEFORE UPDATE ON document_chunks BEGIN SELECT RAISE(ABORT,'immutable artifact'); END;
CREATE TRIGGER IF NOT EXISTS document_chunks_no_delete BEFORE DELETE ON document_chunks BEGIN SELECT RAISE(ABORT,'retained artifact'); END;
CREATE TRIGGER IF NOT EXISTS document_publications_no_delete BEFORE DELETE ON document_publications BEGIN SELECT RAISE(ABORT,'retained artifact'); END;
CREATE TRIGGER IF NOT EXISTS document_publications_immutable BEFORE UPDATE ON document_publications WHEN NEW.id<>OLD.id OR NEW.hash<>OLD.hash OR NEW.actor<>OLD.actor OR NEW.manifest<>OLD.manifest OR NEW.charge<>OLD.charge OR OLD.state='revoked' OR (OLD.state='committed' AND NEW.state<>'revoked') BEGIN SELECT RAISE(ABORT,'immutable artifact'); END;
`;
type Row = {
  sequence: number;
  id: string;
  hash: string;
  actor: string;
  manifest: string;
  state: 'staged' | 'committed' | 'revoked';
  charge: number;
};
export class GroupDocumentTransportCapacity extends Error {}
class Refusal extends Error {
  constructor(readonly code: 'denied' | 'conflict' | 'limit' | 'invalid') {
    super(code);
  }
}
const fail = (code: Refusal['code']): never => {
  if (code === 'limit') throw new GroupDocumentTransportCapacity();
  throw new Refusal(code);
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Shares membership's SQLite and existing delivery allocation; no increased total ceiling. */
export class GroupDocumentTransport {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly ports: { probe(): void; admitMutation(): void },
  ) {
    storage.transactionSync(() => {
      const before = storage.sql.databaseSize;
      storage.sql.exec(schema).toArray();
      this.charge(before);
    });
  }
  private rows<T extends Record<string, SqlStorageValue>>(sql: string, ...args: SqlStorageValue[]) {
    return this.storage.sql.exec<T>(sql, ...args).toArray();
  }
  private charge(before: number) {
    this.rows(
      'UPDATE delivery_control SET allocated=allocated+? WHERE singleton=1',
      Math.max(0, this.storage.sql.databaseSize - before),
    );
    const a = this.rows<{ allocated: number }>(
      'SELECT allocated FROM delivery_control WHERE singleton=1',
    )[0].allocated;
    if (
      a > DELIVERY_LIMITS.databaseBytes ||
      this.storage.sql.databaseSize > C.normalDatabaseBytes + DELIVERY_LIMITS.databaseBytes
    )
      fail('limit');
  }
  async execute(raw: unknown): Promise<DocumentTransportResult> {
    let size: number;
    try {
      size = new TextEncoder().encode(JSON.stringify(raw)).length;
    } catch {
      return { ok: false, error: 'invalid' };
    }
    const parsed = documentTransportEnvelopeSchema.safeParse(raw);
    if (size > L.bodyBytes + 256 || !parsed.success) return { ok: false, error: 'invalid' };
    const { groupId, credential, command: c } = parsed.data;
    const credentialHash = await capabilityHash(groupId, 'installation', credential);
    try {
      return this.storage.transactionSync(() => {
        this.ports.probe();
        const before = this.storage.sql.databaseSize;
        const actor = this.rows<{ installation_id: string; member_id: string; state: string }>(
          'SELECT installation_id,member_id,state FROM enrollments WHERE credential_hash=?',
          credentialHash,
        )[0];
        if (
          this.rows<{ group_id: string }>('SELECT group_id FROM metadata WHERE singleton=1')[0]
            ?.group_id !== groupId ||
          actor?.state !== 'active'
        )
          fail('denied');
        const day = Math.floor(Date.now() / 86400000);
        this.rows(
          'UPDATE document_control SET written=CASE WHEN day=? THEN written ELSE 0 END,read=CASE WHEN day=? THEN read ELSE 0 END,day=? WHERE singleton=1',
          day,
          day,
          day,
        );
        const control = () =>
          this.rows<{ logical: number; written: number; read: number }>(
            'SELECT logical,written,read FROM document_control WHERE singleton=1',
          )[0];
        const emit = (value: unknown): DocumentTransportResult => {
          const reply = documentTransportReplySchema.parse(value);
          const responseBytes = new TextEncoder().encode(JSON.stringify(reply)).length;
          if (responseBytes > 512000) fail('limit');
          if (c.kind !== 'revoke') {
            if (control().read + responseBytes > L.dailyBytes * 2) fail('limit');
            this.rows('UPDATE document_control SET read=read+? WHERE singleton=1', responseBytes);
          }
          this.charge(before);
          return { ok: true, value: reply };
        };
        if (c.kind === 'list') {
          const rows = this.rows<Row>(
            "SELECT * FROM document_publications WHERE state='committed' AND sequence>? ORDER BY sequence LIMIT ?",
            c.after,
            c.limit + 1,
          );
          const page = rows.slice(0, c.limit);
          return emit({
            kind: 'list',
            entries: page.map((r) => ({
              sequence: r.sequence,
              key: { publicationId: r.id, manifestHash: r.hash },
              manifest: JSON.parse(r.manifest),
            })),
            next: rows.length > c.limit ? page.at(-1)!.sequence : null,
          });
        }
        let row = this.rows<Row>(
          'SELECT * FROM document_publications WHERE id=?',
          c.key.publicationId,
        )[0];
        if (row && row.hash !== c.key.manifestHash) fail('conflict');
        if (c.kind === 'begin') {
          if (
            c.key.publicationId !== c.manifest.publicationId ||
            canonical(c.key) !== canonical(documentPublicationKey(c.manifest))
          )
            fail('invalid');
          const context = c.manifest.owner,
            binding = c.binding;
          const identity = this.rows<{ binding: string; local_member_id: string }>(
            'SELECT binding,local_member_id FROM delivery_identities WHERE installation_id=?',
            actor.installation_id,
          )[0];
          const source = this.rows<{
            installation_id: string;
            binding: string;
            member_id: string;
            provider: string;
            native_id: string;
          }>(
            'SELECT installation_id,binding,member_id,provider,native_id FROM delivery_contexts WHERE session_id=?',
            context.sessionId,
          )[0];
          if (
            binding.remoteGroupId !== groupId ||
            binding.groupId !== context.groupId ||
            binding.installationId !== context.installationId ||
            identity?.binding !== canonical(binding) ||
            identity.local_member_id !== context.memberId ||
            source?.installation_id !== actor.installation_id ||
            source.binding !== canonical(binding) ||
            source.member_id !== context.memberId ||
            source.provider !== context.provider ||
            source.native_id !== context.nativeSessionId
          )
            fail('denied');
          if (row) {
            if (row.actor !== actor.installation_id || row.manifest !== canonical(c.manifest))
              fail('conflict');
          } else {
            const text = canonical(c.manifest);
            const charge =
              c.manifest.files.reduce(
                (n, f) => n + f.bytes + Math.ceil(f.bytes / L.chunkBytes) * 512,
                0,
              ) +
              new TextEncoder().encode(text).length +
              4096;
            if (
              control().logical + charge > L.logicalBytes ||
              this.rows<{ n: number }>(
                "SELECT COUNT(*) n FROM document_publications WHERE state='staged'",
              )[0].n >= L.pending
            )
              fail('limit');
            this.ports.admitMutation();
            this.rows(
              "INSERT INTO document_publications(id,hash,actor,manifest,state,charge) VALUES(?,?,?,?,'staged',?)",
              c.key.publicationId,
              c.key.manifestHash,
              actor.installation_id,
              text,
              charge,
            );
            this.rows('UPDATE document_control SET logical=logical+? WHERE singleton=1', charge);
            row = this.rows<Row>(
              'SELECT * FROM document_publications WHERE id=?',
              c.key.publicationId,
            )[0];
          }
        }
        if (!row) {
          if (c.kind === 'receipt')
            return emit({ kind: 'receipt', receipt: { key: c.key, state: 'absent', next: [] } });
          fail('denied');
        }
        const m = JSON.parse(row.manifest) as SharedDocumentManifest;
        if (
          ['chunk', 'commit', 'revoke', 'receipt'].includes(c.kind) &&
          row.actor !== actor.installation_id
        )
          fail('denied');
        if (c.kind === 'revoke' && row.state !== 'revoked') {
          if (row.state === 'staged') {
            const actual = this.rows<{ bytes: number; n: number }>(
              'SELECT COALESCE(SUM(length(bytes)),0) bytes,COUNT(*) n FROM document_chunks WHERE publication=?',
              row.id,
            )[0];
            const retained =
              actual.bytes + actual.n * 512 + new TextEncoder().encode(row.manifest).length + 4096;
            this.rows(
              'UPDATE document_control SET logical=logical-? WHERE singleton=1',
              Math.max(0, row.charge - retained),
            );
          }
          this.rows("UPDATE document_publications SET state='revoked' WHERE id=?", row.id);
        }
        if (c.kind === 'chunk') {
          if (row.state !== 'staged') fail('conflict');
          const file = m.files.find((f) => f.id === c.fileId);
          if (!file) return fail('invalid');
          const bytes = Buffer.from(c.base64, 'base64');
          const expected = Math.min(L.chunkBytes, file.bytes - c.index * L.chunkBytes);
          if (bytes.length !== expected || expected <= 0 || bytes.toString('base64') !== c.base64)
            fail('invalid');
          const old = this.rows<{ bytes: ArrayBuffer }>(
            'SELECT bytes FROM document_chunks WHERE publication=? AND file=? AND idx=?',
            row.id,
            c.fileId,
            c.index,
          )[0];
          if (old) {
            if (!Buffer.from(old.bytes).equals(bytes)) fail('conflict');
          } else {
            const next = this.rows<{ n: number }>(
              'SELECT COUNT(*) n FROM document_chunks WHERE publication=? AND file=?',
              row.id,
              c.fileId,
            )[0].n;
            if (c.index !== next) fail('conflict');
            if (control().written + bytes.length > L.dailyBytes) fail('limit');
            this.rows(
              'INSERT INTO document_chunks VALUES(?,?,?,?,?)',
              row.id,
              c.fileId,
              c.index,
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
              sha(bytes),
            );
            this.rows(
              'UPDATE document_control SET written=written+? WHERE singleton=1',
              bytes.length,
            );
          }
        }
        if (c.kind === 'commit' && row.state === 'staged') {
          for (const f of m.files) {
            const h = createHash('sha256');
            for (let i = 0; i < Math.ceil(f.bytes / L.chunkBytes); i++) {
              const part = this.rows<{ bytes: ArrayBuffer }>(
                'SELECT bytes FROM document_chunks WHERE publication=? AND file=? AND idx=?',
                row.id,
                f.id,
                i,
              )[0];
              if (!part) fail('conflict');
              h.update(Buffer.from(part.bytes));
            }
            if (h.digest('hex') !== f.sha256) fail('conflict');
          }
          this.rows("UPDATE document_publications SET state='committed' WHERE id=?", row.id);
        }
        if (c.kind === 'read' || c.kind === 'manifest') {
          if (row.state !== 'committed') fail('denied');
          if (c.kind === 'manifest') return emit({ kind: 'manifest', key: c.key, manifest: m });
          const part = this.rows<{ bytes: ArrayBuffer; sha: string }>(
            'SELECT bytes,sha FROM document_chunks WHERE publication=? AND file=? AND idx=?',
            row.id,
            c.fileId,
            c.index,
          )[0];
          if (!part) fail('denied');
          const bytes = Buffer.from(part.bytes);
          if (control().read + bytes.length > L.dailyBytes * 2) fail('limit');
          this.rows('UPDATE document_control SET read=read+? WHERE singleton=1', bytes.length);
          return emit({
            kind: 'chunk',
            key: c.key,
            fileId: c.fileId,
            index: c.index,
            base64: bytes.toString('base64'),
            sha256: part.sha,
          });
        }
        const state = this.rows<{ state: Row['state'] }>(
          'SELECT state FROM document_publications WHERE id=?',
          row.id,
        )[0].state;
        return emit({
          kind: 'receipt',
          receipt: {
            key: c.key,
            state,
            next:
              state === 'staged'
                ? m.files.map((f) => ({
                    fileId: f.id,
                    index: this.rows<{ n: number }>(
                      'SELECT COUNT(*) n FROM document_chunks WHERE publication=? AND file=?',
                      row.id,
                      f.id,
                    )[0].n,
                  }))
                : [],
          },
        });
      });
    } catch (e) {
      return {
        ok: false,
        error:
          e instanceof GroupDocumentTransportCapacity
            ? 'limit'
            : e instanceof Refusal
              ? e.code
              : 'unavailable',
      };
    }
  }
}
