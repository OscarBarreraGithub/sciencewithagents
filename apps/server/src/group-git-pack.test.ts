import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { objectFrame, type GitObject } from './group-git-endpoint.js';
import { pack, unpack, packet, packets } from './group-git-pack.js';
const object = (type: GitObject['type'], bytes: Buffer): GitObject => ({
  type,
  bytes,
  oid: createHash('sha1')
    .update(objectFrame({ type, bytes, oid: '' }))
    .digest('hex'),
});
const seal = (body: Buffer) => Buffer.concat([body, createHash('sha1').update(body).digest()]);
it('verifies full raw packs and packet framing without a native helper', () => {
  const objects = [
    object('blob', Buffer.from('raw\0bytes')),
    object('commit', Buffer.from('tree ' + '1'.repeat(40) + '\n\nmessage\n')),
  ];
  expect(unpack(pack(objects), 10000, 2)).toEqual(objects);
  expect(packets(Buffer.concat([packet('NAK\n'), Buffer.from('0000')]))).toEqual([
    Buffer.from('NAK\n'),
    null,
  ]);
  for (const frame of ['0001', '0003', 'ffffabc', 'zzzz', '0008x'])
    expect(() => packets(Buffer.from(frame))).toThrow();
});
it('resolves REF deltas against a later full base and refuses thin/external bases', () => {
  const base = object('blob', Buffer.from('abc'));
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(2, 8);
  const delta = Buffer.from([3, 4, 0x90, 3, 1, 0x64]); // copy abc then insert d
  const body = Buffer.concat([
    header,
    Buffer.from([0x76]),
    Buffer.from(base.oid, 'hex'),
    deflateSync(delta),
    Buffer.from([0x33]),
    deflateSync(base.bytes),
  ]);
  const result = unpack(seal(body), 1000, 2);
  expect(result[0]).toEqual(object('blob', Buffer.from('abcd')));
  expect(result[1]).toEqual(base);
  const bad = Buffer.from(body);
  bad.fill(0, 13, 33);
  expect(() => unpack(seal(bad), 1000, 2)).toThrow();
});
it('bounds delta lengths, offsets, compression expansion, counts and checksums', () => {
  const base = object('blob', Buffer.alloc(100000, 7));
  const data = pack([base]);
  expect(() => unpack(data, 1000, 10)).toThrow();
  const wrong = Buffer.from(data);
  wrong[15] ^= 7;
  expect(() => unpack(wrong, 1000000, 10)).toThrow();
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);
  expect(() =>
    unpack(
      seal(Buffer.concat([header, Buffer.from([0x61, 0]), deflateSync(Buffer.from([0]))])),
      1000,
      2,
    ),
  ).toThrow();
});
