import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { proxyPath } from './hosts.js';

it('proxies only typed formatter actions and opaque reading-copy IDs to the selected computer', () => {
  const document = randomUUID(),
    copy = randomUUID();
  const format = `/documents/${document}/format`;
  for (const path of [format, `${format}/automatic`, `/documents/${document}/formatted/${copy}`])
    expect(proxyPath('GET', path)).toBe(`/api${path}`);
  for (const path of [format, `${format}/automatic`, `${format}/automatic/request`])
    expect(proxyPath('POST', path)).toBe(`/api${path}`);
  for (const [method, path] of [
    ['GET', `${format}/automatic/request`],
    ['POST', `/documents/${document}/formatted/${copy}`],
    ['DELETE', `${format}/automatic`],
    ['POST', `${format}/automatic/enable`],
    ['GET', `/documents/${document}/formatted/source.tex`],
    ['GET', `${format}/automatic?path=/tmp/paper.tex`],
    ['POST', `${format}/automatic?enabled=true`],
  ])
    expect(proxyPath(method, path)).toBeNull();
});
