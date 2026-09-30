import { expect, it } from 'vitest';
import { decodeGeneratedImage, imageByteLimit } from './images.js';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
it('decodes bounded native PNG bytes without accepting URLs, paths or executable formats', () => {
  expect(decodeGeneratedImage(png)).toMatchObject({
    width: 1,
    height: 1,
    bytes: Buffer.from(png, 'base64'),
  });
  for (const invalid of [
    null,
    '',
    '/private/image.png',
    'https://example.invalid/image.png',
    'data:image/png;base64,' + png,
    png + '\n',
    Buffer.from('<svg onload="alert(1)"/>').toString('base64'),
    'A'.repeat(Math.ceil(imageByteLimit / 3) * 4 + 4),
  ])
    expect(() => decodeGeneratedImage(invalid)).toThrow();
});
it('rejects truncated PNGs and excessive or zero dimensions without inflating image data', () => {
  expect(() =>
    decodeGeneratedImage(Buffer.from(png, 'base64').subarray(0, 32).toString('base64')),
  ).toThrow();
  for (const [width, height] of [
    [0, 1],
    [9000, 1],
    [8192, 8192],
  ]) {
    const bytes = Buffer.from(png, 'base64');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    expect(() => decodeGeneratedImage(bytes.toString('base64'))).toThrow();
  }
});
