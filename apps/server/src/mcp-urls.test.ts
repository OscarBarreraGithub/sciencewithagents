import { expect, it } from 'vitest';
import { mcpUrlRequestSchema, mcpUrlSchema } from '@dock/shared';

it('keeps URL request destinations canonical, with HTTPS or explicit loopback HTTP only', () => {
  for (const url of [
    'https://example.invalid/continue?state=fixture%2Btoken#step',
    'http://127.0.0.1:4321/continue',
    'http://localhost:4321/continue',
    'http://[::1]:4321/continue',
  ])
    expect(mcpUrlSchema.parse(url)).toBe(url);
  expect(mcpUrlSchema.parse('HTTPS://EXAMPLE.INVALID:443')).toBe('https://example.invalid/');
  expect(mcpUrlSchema.parse('https://bücher.invalid:8443/')).toBe(
    'https://xn--bcher-kva.invalid:8443/',
  );
  expect(
    mcpUrlRequestSchema.parse({ serverName: 'fixture', url: 'https://example.invalid' }),
  ).toEqual({ serverName: 'fixture', url: 'https://example.invalid/' });
});

it('rejects non-web, remote plaintext, credential-bearing and ambiguous URL requests', () => {
  for (const url of [
    '',
    'javascript:alert(1)',
    'data:text/html,fixture',
    'file:///tmp/fixture',
    '//example.invalid',
    '/relative',
    'https:example.invalid',
    'https:///example.invalid',
    'http://example.invalid',
    'http://192.168.1.2',
    'http://127.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://localhost.evil.invalid',
    'http://localhost.',
    'http://%6cocalhost',
    'https://user:password@example.invalid',
    'https://user@example.invalid',
    'https://@example.invalid',
    ' https://example.invalid',
    'https://example.invalid/a b',
    'https://example.invalid/\npath',
    'https://example.invalid\\@elsewhere.invalid',
    'https://example.invalid/\u202ehidden',
    'https://example.invalid:99999',
    'https://example.invalid/' + 'x'.repeat(8000),
  ])
    expect(mcpUrlSchema.safeParse(url).success, url).toBe(false);
  expect(
    mcpUrlRequestSchema.safeParse({ serverName: '', url: 'https://example.invalid' }).success,
  ).toBe(false);
  expect(
    mcpUrlRequestSchema.safeParse({
      serverName: 'fixture',
      url: 'https://example.invalid',
      extra: true,
    }).success,
  ).toBe(false);
});
