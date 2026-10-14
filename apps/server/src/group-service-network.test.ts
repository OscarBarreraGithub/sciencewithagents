import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import * as dns from 'node:dns/promises';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import {
  groupServiceFetch,
  publicWorkersLookup,
  workersServiceUrl,
} from './group-service-network.js';
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '100.64.1.1'])(
  'refuses mixed public/private DNS %s before TLS dialing',
  async (address) => {
    vi.mocked(dns.lookup).mockResolvedValue([
      { address: '104.18.30.15', family: 4 },
      { address, family: 4 },
    ] as never);
    const result = await new Promise((resolve) =>
      publicWorkersLookup('groups.creator.workers.dev', {}, (...args) => resolve(args)),
    );
    expect(result).toEqual([expect.any(Error), '', 4]);
  },
);
it('pins one public lookup for TLS without a second lookup, including all-address callers', async () => {
  const answers = [
    { address: '104.18.30.15', family: 4 },
    { address: '104.18.31.15', family: 4 },
  ];
  vi.mocked(dns.lookup).mockResolvedValue(answers as never);
  expect(
    await new Promise((resolve) =>
      publicWorkersLookup('groups.creator.workers.dev', {}, (...args) => resolve(args)),
    ),
  ).toEqual([null, answers[0].address, 4]);
  expect(dns.lookup).toHaveBeenCalledOnce();
  expect(
    await new Promise((resolve) =>
      publicWorkersLookup('groups.creator.workers.dev', { all: true }, (...args) => resolve(args)),
    ),
  ).toEqual([null, answers]);
});
it.each([
  'https://groups.creator.workers.dev.attacker.test/',
  'https://workers.dev/',
  'https://groups.creator.workers.dev:8443/',
  'http://groups.creator.workers.dev/',
  'https://user:password@groups.creator.workers.dev/',
  'https://groups.creator.workers.dev/?redirect=private',
])('ordinary route does not admit %s', (url) =>
  expect(workersServiceUrl(new URL(url))).toBe(false),
);

it.each([200, 302, 600])(
  'Workers JSON POST verifies native TLS, streams replies and never follows a redirect (%s)',
  async (status) => {
    const reply = Object.assign(new PassThrough(), {
      statusCode: status,
      headers: {},
      rawHeaders: ['content-type', 'application/json'],
    });
    const pending = Object.assign(new EventEmitter(), {
      end: vi.fn(() => {
        reply.end('{"ok":true}');
      }),
    });
    vi.mocked(https.request).mockImplementation(((
      url: URL,
      options: object,
      callback: (reply: IncomingMessage) => void,
    ) => {
      expect(url.href).toBe('https://groups.creator.workers.dev/v1/groups/one');
      expect(options).toMatchObject({
        lookup: publicWorkersLookup,
        agent: false,
        rejectUnauthorized: true,
      });
      queueMicrotask(() => callback(reply as unknown as IncomingMessage));
      return pending;
    }) as typeof https.request);
    const response = groupServiceFetch('https://groups.creator.workers.dev/v1/groups/one', {
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer member-only' },
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(1000),
    });
    if (status !== 200) await expect(response).rejects.toThrow(/response unavailable/);
    else expect(await (await response).json()).toEqual({ ok: true });
    expect(https.request).toHaveBeenCalledOnce();
    expect(pending.end).toHaveBeenCalledWith('{}');
  },
);
it('Workers requests refuse browser cookies and credential forwarding before dialing', async () => {
  await expect(
    groupServiceFetch('https://groups.creator.workers.dev/v1/groups/one', {
      method: 'POST',
      body: '{}',
      headers: { Cookie: 'owner=private' },
    }),
  ).rejects.toThrow(/forwarded credentials/);
  expect(https.request).not.toHaveBeenCalled();
});
