type Entry = { name: string; data?: string | Buffer; type?: string; linkname?: string };
/** Minimal ustar writer so malicious archives are built in-test, never downloaded. */
export function tarHeader(name: string, size: number, type = '0', linkname = '', checksum = true) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(size.toString(8).padStart(11, '0') + '\0', 124);
  block.write('00000000000\0', 136);
  block.fill(0x20, 148, 156);
  block.write(type, 156);
  block.write(linkname, 157, 100);
  block.write('ustar\0', 257);
  block.write('00', 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  if (checksum) block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return block;
}
export function tar(entries: Entry[]) {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    parts.push(tarHeader(entry.name, data.length, entry.type ?? '0', entry.linkname ?? ''));
    parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
