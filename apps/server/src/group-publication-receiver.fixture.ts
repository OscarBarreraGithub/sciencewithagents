// Disposable local test receiver. This is not a production adapter or Cloudflare service.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  PUBLICATION_LIMITS,
  publicationCanonical,
  publicationEffectSchema,
  publicationEnvelopeSchema,
  publicationHash,
  publicationKeySchema,
  publicationReceiptSchema,
  type PublicationBinding,
  type PublicationChunk,
  type PublicationEffect,
  type PublicationEffectReply,
  type PublicationHeader,
  type PublicationKey,
  type PublicationReceipt,
  type PublicationReply,
  type PublicationTransport,
} from './group-publication-protocol.js';

type Stored = { header_json: string; payload_hash: string; state: string; sequence: number | null };
export class PublicationReceiverFixture {
  readonly secret = randomBytes(32).toString('hex');
  readonly db: DatabaseSync;
  readonly trace: { kind: 'receipt' | PublicationEffect['kind']; operationId: string }[] = [];
  revoked = false;
  dropAcknowledgement: PublicationEffect['kind'] | null = null;
  #server: Server | undefined;
  url = '';
  constructor(
    path: string,
    readonly binding: PublicationBinding,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS operations(operation_id TEXT PRIMARY KEY,header_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,state TEXT NOT NULL,sequence INTEGER);
      CREATE TABLE IF NOT EXISTS chunks(operation_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,text TEXT NOT NULL,
        PRIMARY KEY(operation_id,chunk_index));
      CREATE UNIQUE INDEX IF NOT EXISTS accepted_sequence ON operations(sequence) WHERE sequence IS NOT NULL;`);
  }
  #transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  #row(key: PublicationKey): Stored | undefined {
    return this.db.prepare('SELECT * FROM operations WHERE operation_id=?').get(key.operationId) as
      | Stored
      | undefined;
  }
  #receipt(key: PublicationKey): PublicationReceipt {
    const row = this.#row(key);
    if (!row) return { ...key, state: 'absent' };
    if (row.payload_hash !== key.payloadHash || row.state === 'collision')
      return { ...key, state: 'collision' };
    const header = JSON.parse(row.header_json) as PublicationHeader;
    if (row.state === 'committed')
      return {
        ...key,
        state: 'committed',
        eventId: header.event.eventId,
        remoteSequence: row.sequence!,
      };
    const chunks = this.db
      .prepare('SELECT chunk_index FROM chunks WHERE operation_id=?')
      .all(key.operationId) as { chunk_index: number }[];
    return {
      ...key,
      state: 'staged',
      missing: header.event.manifest.chunks
        .map((item) => item.index)
        .filter((index) => !chunks.some((chunk) => chunk.chunk_index === index)),
    };
  }
  #effect(packet: PublicationEffect): PublicationReceipt {
    const { version, binding, operationId, payloadHash } =
      packet.kind === 'begin' ? packet.header : packet.key;
    const key: PublicationKey = { version, binding, operationId, payloadHash };
    return this.#transaction(() => {
      const row = this.#row(key);
      if (row && row.payload_hash !== key.payloadHash) return { ...key, state: 'collision' };
      if (packet.kind === 'begin') {
        if (!row) {
          if (
            (this.db.prepare('SELECT COUNT(*) AS n FROM operations').get() as { n: number }).n >=
            512
          )
            throw new Error('Fixture capacity');
          this.db
            .prepare("INSERT INTO operations VALUES (?,?,?,'staged',NULL)")
            .run(key.operationId, publicationCanonical(packet.header), key.payloadHash);
        } else if (row.header_json !== publicationCanonical(packet.header))
          return { ...key, state: 'collision' };
      } else {
        if (!row) throw new Error('Missing begin');
        if (row.state === 'collision' || row.state === 'committed') return this.#receipt(key);
        const header = JSON.parse(row.header_json) as PublicationHeader;
        if (packet.kind === 'chunk') {
          const expected = header.event.manifest.chunks[packet.chunk.index];
          if (
            !expected ||
            expected.sha256 !== packet.chunk.sha256 ||
            expected.bytes !== packet.chunk.bytes ||
            publicationHash(packet.chunk.text) !== expected.sha256 ||
            Buffer.byteLength(packet.chunk.text, 'utf8') !== expected.bytes
          )
            return { ...key, state: 'collision' };
          const prior = this.db
            .prepare('SELECT text FROM chunks WHERE operation_id=? AND chunk_index=?')
            .get(key.operationId, packet.chunk.index) as { text: string } | undefined;
          if (prior && prior.text !== packet.chunk.text) return { ...key, state: 'collision' };
          if (!prior)
            this.db
              .prepare('INSERT INTO chunks VALUES (?,?,?)')
              .run(key.operationId, packet.chunk.index, packet.chunk.text);
        } else {
          const rows = this.db
            .prepare(
              'SELECT chunk_index,text FROM chunks WHERE operation_id=? ORDER BY chunk_index',
            )
            .all(key.operationId) as { chunk_index: number; text: string }[];
          const chunks: PublicationChunk[] = rows.map((chunk) => ({
            ...header.event.manifest.chunks[chunk.chunk_index],
            text: chunk.text,
          }));
          publicationEnvelopeSchema.parse({ header, chunks });
          // One exact event cannot acquire another remote effect under a different operation ID.
          const accepted = this.db
            .prepare("SELECT header_json FROM operations WHERE state='committed'")
            .all() as { header_json: string }[];
          if (
            accepted.some(
              (item) =>
                (JSON.parse(item.header_json) as PublicationHeader).event.eventId ===
                header.event.eventId,
            )
          ) {
            this.db
              .prepare("UPDATE operations SET state='collision' WHERE operation_id=?")
              .run(key.operationId);
            return { ...key, state: 'collision' };
          }
          const sequence = (
            this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM operations').get() as {
              n: number;
            }
          ).n;
          this.db
            .prepare("UPDATE operations SET state='committed',sequence=? WHERE operation_id=?")
            .run(sequence, key.operationId);
        }
      }
      return this.#receipt(key);
    });
  }
  async listen(): Promise<void> {
    const server = createServer(async (request, response) => {
      try {
        if (
          request.method !== 'POST' ||
          !['/receipt', '/effect'].includes(request.url ?? '') ||
          request.headers.authorization !== `Bearer ${this.secret}` ||
          this.revoked
        ) {
          response.writeHead(403).end();
          return;
        }
        const buffers: Buffer[] = [];
        let size = 0;
        for await (const buffer of request) {
          size += Buffer.byteLength(buffer);
          if (size > PUBLICATION_LIMITS.packetBytes) {
            response.writeHead(413).end();
            request.destroy();
            return;
          }
          buffers.push(Buffer.from(buffer));
        }
        const raw: unknown = JSON.parse(Buffer.concat(buffers).toString('utf8'));
        const query = request.url === '/receipt';
        const packet = query ? publicationKeySchema.parse(raw) : publicationEffectSchema.parse(raw);
        const key =
          'kind' in packet ? (packet.kind === 'begin' ? packet.header : packet.key) : packet;
        if (publicationCanonical(key.binding) !== publicationCanonical(this.binding)) {
          response.writeHead(403).end();
          return;
        }
        const kind = 'kind' in packet ? packet.kind : 'receipt';
        if (this.trace.length >= 1_000) throw new Error('Fixture trace capacity');
        this.trace.push({ kind, operationId: key.operationId });
        const receipt = 'kind' in packet ? this.#effect(packet) : this.#receipt(packet);
        if (kind === this.dropAcknowledgement) {
          this.dropAcknowledgement = null;
          request.socket.destroy();
          return;
        }
        const body = publicationCanonical(publicationReceiptSchema.parse(receipt));
        response.writeHead(200, { 'content-type': 'application/json' }).end(body);
      } catch {
        response.writeHead(400).end();
      }
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address');
    this.url = `http://127.0.0.1:${address.port}`;
  }
  async close(): Promise<void> {
    const server = this.#server;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      this.#server = undefined;
    }
    this.db.close();
  }
}
/** Test-only HTTP adapter. Its generated credential stays in a header/closure. */
export class PublicationLoopbackFixture implements PublicationTransport {
  offline = false;
  constructor(
    readonly url: string,
    readonly secret: string,
  ) {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' || parsed.protocol !== 'http:')
      throw new Error('Loopback fixture only');
  }
  async #request(
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<PublicationReceipt | null> {
    const response = await fetch(`${this.url}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
      body: publicationCanonical(body),
      signal,
    });
    if (response.status === 403) return null;
    if (!response.ok) throw new Error('Fixture transport failure');
    const reader = response.body!.getReader();
    const buffers: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > PUBLICATION_LIMITS.receiptBytes) {
          await reader.cancel();
          throw new Error('Fixture response bound');
        }
        buffers.push(value);
      }
      return publicationReceiptSchema.parse(JSON.parse(Buffer.concat(buffers).toString('utf8')));
    } finally {
      reader.releaseLock();
    }
  }
  async receipt(key: PublicationKey, signal: AbortSignal): Promise<PublicationReply> {
    if (this.offline) return { kind: 'unavailable', reason: 'offline' };
    const receipt = await this.#request('receipt', key, signal);
    return receipt ? { kind: 'receipt', receipt } : { kind: 'unavailable', reason: 'revoked' };
  }
  async effect(packet: PublicationEffect, signal: AbortSignal): Promise<PublicationEffectReply> {
    if (this.offline) return { kind: 'not_sent', reason: 'offline' };
    const receipt = await this.#request('effect', packet, signal);
    // A transmitted request without a receipt always remains uncertain.
    if (!receipt) throw new Error('Fixture denied');
    return { kind: 'receipt', receipt };
  }
}
