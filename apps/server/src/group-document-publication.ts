import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  DOCUMENT_TRANSPORT_LIMITS as L,
  documentPublicationKey,
  sharedDocumentManifestSchema,
  documentTransportResultSchema,
  type SharedDocumentManifest,
  type DocumentPublicationKey,
  type DocumentTransportCommand,
} from '@dock/shared/dist/group-document-transport.js';
import { publicationCanonical, type PublicationBinding } from '@dock/shared/dist/group-delivery.js';
import type { GroupContext } from '@dock/shared';
/** Protected host port: browser supplies opaque IDs, never credentials, endpoints or bytes. */
export class GroupDocumentPublication {
  constructor(
    private readonly ports: {
      binding: PublicationBinding;
      context: GroupContext;
      revalidate(): Promise<void>;
      command(command: DocumentTransportCommand): Promise<unknown>;
    },
  ) {}
  private async call(command: DocumentTransportCommand) {
    await this.ports.revalidate();
    const result = documentTransportResultSchema.parse(await this.ports.command(command));
    await this.ports.revalidate();
    if (!result.ok) throw new Error(`Shared report ${result.error}`);
    const reply = result.value;
    if ('key' in command) {
      const actual =
        'key' in reply ? reply.key : reply.kind === 'receipt' ? reply.receipt.key : null;
      if (!actual || publicationCanonical(actual) !== publicationCanonical(command.key))
        throw new Error('Shared report reply identity mismatch');
    }
    return reply;
  }
  async publish(raw: SharedDocumentManifest, files: ReadonlyMap<string, Uint8Array>) {
    const manifest = sharedDocumentManifestSchema.parse(raw);
    if (
      this.ports.context.visibility !== 'shared' ||
      publicationCanonical(manifest.owner) !== publicationCanonical(this.ports.context)
    )
      throw new Error('Shared owner context mismatch');
    for (const file of manifest.files) {
      const bytes = files.get(file.id);
      if (
        !bytes ||
        bytes.length !== file.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== file.sha256
      )
        throw new Error('Shared artifact bytes mismatch');
    }
    const key = documentPublicationKey(manifest);
    let r = await this.call({ kind: 'receipt', key });
    if (r.kind !== 'receipt') throw new Error('Shared report receipt mismatch');
    if (r.receipt.state === 'revoked') throw new Error('Shared report revoked');
    if (r.receipt.state === 'committed') return key;
    r = await this.call({ kind: 'begin', key, binding: this.ports.binding, manifest });
    if (r.kind !== 'receipt' || r.receipt.state !== 'staged')
      throw new Error('Shared report staging mismatch');
    for (const file of manifest.files) {
      const bytes = files.get(file.id)!;
      const start = r.receipt.next.find((n) => n.fileId === file.id)?.index;
      if (start === undefined) throw new Error('Shared report progress mismatch');
      for (let index = start; index < Math.ceil(bytes.length / L.chunkBytes); index++)
        await this.call({
          kind: 'chunk',
          key,
          fileId: file.id,
          index,
          base64: Buffer.from(
            bytes.subarray(index * L.chunkBytes, (index + 1) * L.chunkBytes),
          ).toString('base64'),
        });
    }
    const done = await this.call({ kind: 'commit', key });
    if (done.kind !== 'receipt' || done.receipt.state !== 'committed')
      throw new Error('Shared report commit uncertain');
    return key;
  }
  async manifest(key: DocumentPublicationKey) {
    const reply = await this.call({ kind: 'manifest', key });
    if (
      reply.kind !== 'manifest' ||
      publicationCanonical(reply.key) !== publicationCanonical(key) ||
      publicationCanonical(documentPublicationKey(reply.manifest)) !== publicationCanonical(key)
    )
      throw new Error('Shared report manifest mismatch');
    return reply.manifest;
  }
  async read(key: DocumentPublicationKey, fileId: string) {
    const manifest = await this.manifest(key);
    const file = manifest.files.find((f) => f.id === fileId);
    if (!file) throw new Error('Shared file unavailable');
    const output = Buffer.alloc(file.bytes);
    for (let index = 0; index < Math.ceil(file.bytes / L.chunkBytes); index++) {
      const reply = await this.call({ kind: 'read', key, fileId, index });
      if (
        reply.kind !== 'chunk' ||
        publicationCanonical(reply.key) !== publicationCanonical(key) ||
        reply.fileId !== fileId ||
        reply.index !== index
      )
        throw new Error('Shared report chunk mismatch');
      const bytes = Buffer.from(reply.base64, 'base64');
      if (
        bytes.toString('base64') !== reply.base64 ||
        bytes.length !== Math.min(L.chunkBytes, file.bytes - index * L.chunkBytes) ||
        createHash('sha256').update(bytes).digest('hex') !== reply.sha256
      )
        throw new Error('Shared report chunk digest mismatch');
      bytes.copy(output, index * L.chunkBytes);
    }
    if (createHash('sha256').update(output).digest('hex') !== file.sha256)
      throw new Error('Shared report file digest mismatch');
    await this.manifest(key);
    return output;
  }
  list(after = 0, limit = 4) {
    return this.call({ kind: 'list', after, limit });
  }
  revoke(key: DocumentPublicationKey) {
    return this.call({ kind: 'revoke', key });
  }
}
