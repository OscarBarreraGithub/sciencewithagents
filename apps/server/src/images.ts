/** Native image output only: never fetch a URL or open a provider-supplied path. */
export const imageByteLimit = 8 * 1024 * 1024;
export function decodeGeneratedImage(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(imageByteLimit / 3) * 4)
    throw new Error('Missing image bytes or image exceeds the 8 MiB archive limit.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > imageByteLimit || bytes.toString('base64') !== value)
    throw new Error('The provider did not return supported image bytes.');
  return { bytes, ...inspectPng(bytes) };
}
export function inspectPng(bytes: Buffer) {
  if (
    bytes.length < 45 ||
    bytes.length > imageByteLimit ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.subarray(-12).toString('hex') !== '0000000049454e44ae426082'
  )
    throw new Error('Only bounded PNG image output can be retained.');
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 32_000_000)
    throw new Error('The generated image dimensions exceed the archive limit.');
  return { width, height };
}
