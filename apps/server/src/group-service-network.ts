import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { publicIPv4 } from './group-network.js';

const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const workersHostname = new RegExp(`^${label}\\.${label}\\.workers\\.dev$`);
export function workersServiceUrl(url: URL, protocol: 'https:' | 'wss:' = 'https:') {
  return (
    url.protocol === protocol &&
    workersHostname.test(url.hostname) &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

/** Pin the checked answer into native TLS; reject mixed/public-private DNS too.
 * IPv6-only services fail closed, matching the existing native network broker. */
export const publicWorkersLookup: LookupFunction = (hostname, options, callback) => {
  if (!workersHostname.test(hostname)) {
    callback(new Error('Public Workers service required.'), '', 4);
    return;
  }
  void lookup(hostname, { all: true, family: 4 })
    .then((answers) => {
      if (!answers.length || answers.some(({ address }) => !publicIPv4(address)))
        throw new Error('Public Workers service unavailable.');
      if (options.all) callback(null, answers);
      else callback(null, answers[0]!.address, 4);
    })
    .catch(() => callback(new Error('Public Workers service unavailable.'), '', 4));
};

/** The app's JSON POST transport for ordinary hosted services. Trusted native
 * custom-domain/local routes retain their existing transport. No redirects,
 * cookies, alternate port or second DNS lookup can forward local credentials. */
export const groupServiceFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!workersHostname.test(url.hostname)) return fetch(input, init);
  if (!workersServiceUrl(url) || init?.method !== 'POST' || typeof init.body !== 'string')
    throw new Error('Protected Workers transport requires a JSON POST.');
  const headers = new Headers(init.headers);
  if (headers.has('cookie') || headers.has('proxy-authorization'))
    throw new Error('Protected Workers transport refuses forwarded credentials.');
  headers.set('accept-encoding', 'identity');
  return new Promise<Response>((resolve, reject) => {
    const pending = request(
      url,
      {
        method: 'POST',
        headers: Object.fromEntries(headers),
        lookup: publicWorkersLookup,
        agent: false,
        rejectUnauthorized: true,
        signal: init.signal ?? undefined,
      },
      (reply) => {
        const status = reply.statusCode ?? 502;
        if (
          status < 200 ||
          status > 599 ||
          (status >= 300 && status < 400) ||
          (reply.headers['content-encoding'] && reply.headers['content-encoding'] !== 'identity')
        ) {
          reply.destroy();
          reject(new Error('Protected Workers response unavailable.'));
          return;
        }
        try {
          const responseHeaders = new Headers();
          for (let i = 0; i < reply.rawHeaders.length; i += 2)
            responseHeaders.append(reply.rawHeaders[i]!, reply.rawHeaders[i + 1]!);
          const empty = status === 204 || status === 205;
          if (empty) reply.resume();
          resolve(
            new Response(empty ? null : Readable.toWeb(reply), {
              status,
              headers: responseHeaders,
            }),
          );
        } catch {
          reply.destroy();
          reject(new Error('Protected Workers response unavailable.'));
        }
      },
    );
    pending.once('error', reject);
    pending.end(init.body);
  });
};
