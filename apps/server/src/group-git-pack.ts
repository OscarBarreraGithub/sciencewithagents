import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { GroupGitBlocked } from './group-git.js';
import { objectFrame, verifyGitObject, type GitObject } from './group-git-endpoint.js';

const fail = (): never => {
  throw new GroupGitBlocked('Invalid or unsupported bounded Git pack');
};
export function packet(bytes: Buffer | string): Buffer {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (body.length + 4 > 65520) fail();
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}
export function packets(bytes: Buffer): (Buffer | null)[] {
  const result: (Buffer | null)[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) fail();
    const size = parseInt(header, 16);
    offset += 4;
    if (size === 0) {
      result.push(null);
      continue;
    }
    if (size < 4 || size > 65520 || offset + size - 4 > bytes.length) fail();
    result.push(bytes.subarray(offset, offset + size - 4));
    offset += size - 4;
  }
  return result;
}
const kinds = new Map([
  [1, 'commit'],
  [2, 'tree'],
  [3, 'blob'],
] as const);
/** Full packs only. No thin-pack, tag objects or external bases; delta expansion is bounded
 * independently of compressed bytes. Neither Git, hooks nor filters execute here. */
export function unpack(bytes: Buffer, maxBytes: number, maxObjects: number): GitObject[] {
  if (
    bytes.length < 32 ||
    bytes.subarray(0, 4).toString() !== 'PACK' ||
    bytes.readUInt32BE(4) !== 2 ||
    !createHash('sha1').update(bytes.subarray(0, -20)).digest().equals(bytes.subarray(-20))
  )
    fail();
  const count = bytes.readUInt32BE(8);
  if (count > maxObjects) fail();
  let offset = 12,
    total = 0;
  const nodes: {
    offset: number;
    kind: number;
    data: Buffer;
    base?: number | string;
    object?: GitObject;
  }[] = [];
  const take = () => {
    if (offset >= bytes.length - 20) fail();
    return bytes[offset++];
  };
  for (let i = 0; i < count; i++) {
    const start = offset;
    let value = take();
    const kind = (value >> 4) & 7;
    let size = value & 15,
      shift = 4;
    while (value & 128) {
      value = take();
      size += (value & 127) * 2 ** shift;
      shift += 7;
      if (shift > 46) fail();
    }
    if (size > maxBytes || !Number.isSafeInteger(size)) fail();
    let base: number | string | undefined;
    if (kind === 6) {
      value = take();
      let distance = value & 127;
      while (value & 128) {
        value = take();
        distance = (distance + 1) * 128 + (value & 127);
        if (!Number.isSafeInteger(distance)) fail();
      }
      base = start - distance;
      if (base < 12 || base >= start) fail();
    } else if (kind === 7) {
      if (offset + 20 > bytes.length - 20) fail();
      base = bytes.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!kinds.has(kind as 1)) fail();
    const inflated = inflateSync(bytes.subarray(offset, -20), {
      info: true,
      maxOutputLength: Math.max(1, Math.min(size + 1, maxBytes - total + 1)),
    });
    const decoded = inflated as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const data = decoded.buffer;
    if (data.length !== size || !decoded.engine.bytesWritten) fail();
    offset += decoded.engine.bytesWritten;
    total += data.length;
    if (total > maxBytes) fail();
    nodes.push({ offset: start, kind, data, base });
  }
  if (offset !== bytes.length - 20) fail();
  const byOffset = new Map(nodes.map((n) => [n.offset, n]));
  const byOid = new Map<string, GitObject>();
  let unresolved = count;
  for (let round = 0; unresolved && round <= count; round++) {
    let progress = false;
    for (const node of nodes) {
      if (node.object) continue;
      const kind = kinds.get(node.kind as 1);
      const base =
        typeof node.base === 'number'
          ? byOffset.get(node.base)?.object
          : byOid.get(node.base ?? '');
      if (!kind && !base) continue;
      const content = kind ? node.data : applyDelta(base!.bytes, node.data, maxBytes - total);
      if (!kind) {
        total += content.length;
        if (total > maxBytes) fail();
      }
      const type = kind ?? base!.type;
      const object = {
        type,
        bytes: content,
        oid: createHash('sha1')
          .update(objectFrame({ type, bytes: content, oid: '' }))
          .digest('hex'),
      };
      node.object = object;
      byOid.set(object.oid, object);
      unresolved--;
      progress = true;
    }
    if (!progress && unresolved) fail();
  }
  return nodes.map((n) => n.object ?? fail());
}
function applyDelta(base: Buffer, delta: Buffer, limit: number): Buffer {
  let pos = 0;
  const take = () => {
    if (pos >= delta.length) fail();
    return delta[pos++];
  };
  const number = () => {
    let n = 0,
      shift = 0,
      b;
    do {
      b = take();
      n += (b & 127) * 2 ** shift;
      shift += 7;
      if (shift > 46) fail();
    } while (b & 128);
    return n;
  };
  if (number() !== base.length) fail();
  const size = number();
  if (size > limit) fail();
  const out = Buffer.alloc(size);
  let target = 0;
  while (pos < delta.length) {
    const command = take();
    let length = 0;
    if (command & 128) {
      let source = 0;
      for (let i = 0; i < 4; i++) if (command & (1 << i)) source += take() * 2 ** (i * 8);
      for (let i = 0; i < 3; i++) if (command & (1 << (i + 4))) length += take() * 2 ** (i * 8);
      length ||= 65536;
      if (source + length > base.length || target + length > size) fail();
      base.copy(out, target, source, source + length);
    } else {
      length = command;
      if (!length || pos + length > delta.length || target + length > size) fail();
      delta.copy(out, target, pos, pos + length);
      pos += length;
    }
    target += length;
  }
  if (target !== size) fail();
  return out;
}
export function pack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const chunks = [header];
  for (const object of objects) {
    verifyGitObject(object);
    const kind = object.type === 'commit' ? 1 : object.type === 'tree' ? 2 : 3;
    let size = object.bytes.length;
    const encoded = [(kind << 4) | (size & 15)];
    size = Math.floor(size / 16);
    while (size) {
      encoded[encoded.length - 1] |= 128;
      encoded.push(size & 127);
      size = Math.floor(size / 128);
    }
    chunks.push(Buffer.from(encoded), deflateSync(object.bytes));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
