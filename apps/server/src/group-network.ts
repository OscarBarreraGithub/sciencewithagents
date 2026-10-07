import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';

/** Credentials remain inside end-to-end native TLS. This host broker only
 * authorizes CONNECT to exact granted public DNS names, never auth tokens,
 * requests, response bodies, private IPs, plain HTTP or arbitrary local RPC. */
export class GroupNetworkProxy {
  readonly #server = createServer((_request, response) => response.writeHead(403).end());
  readonly #sockets = new Set<Socket>();
  readonly #secret = randomBytes(32).toString('hex');
  #port = 0;
  #closed = false;
  #watch: NodeJS.Timeout | undefined;
  private constructor(
    readonly domains: readonly string[],
    readonly current: () => boolean,
  ) {
    this.#server.maxHeadersCount = 32;
    this.#server.headersTimeout = 10_000;
    this.#server.requestTimeout = 10_000;
    this.#server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => this.#sockets.delete(socket));
    });
    this.#server.on('connect', (request, socket, head) => {
      const denied = () => socket.destroy();
      const expected = Buffer.from(
        `Basic ${Buffer.from(`group:${this.#secret}`).toString('base64')}`,
      );
      const actual = Buffer.from(request.headers['proxy-authorization'] ?? '');
      const match = /^([a-z0-9.-]+):443$/.exec(request.url ?? '');
      if (
        this.#closed ||
        !this.current() ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected) ||
        !match ||
        !this.domains.includes(match[1]!)
      ) {
        denied();
        return;
      }
      // Pin the checked DNS answer into connect. Never let a second lookup
      // rebind to a private host; reject any mixed private/public answer too.
      void lookup(match[1]!, { all: true, family: 4 })
        .then((answers) => {
          if (
            this.#closed ||
            !this.current() ||
            socket.destroyed ||
            !answers.length ||
            answers.some(({ address }) => !publicIPv4(address))
          ) {
            denied();
            return;
          }
          const upstream = connect({ host: answers[0]!.address, port: 443 });
          this.#sockets.add(upstream);
          upstream.setTimeout(30_000, () => upstream.destroy());
          upstream.on('error', denied);
          upstream.on('close', () => {
            this.#sockets.delete(upstream);
            denied();
          });
          socket.on('close', () => upstream.destroy());
          upstream.once('connect', () => {
            if (this.#closed || !this.current() || socket.destroyed) {
              upstream.destroy();
              return;
            }
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            socket.pipe(upstream);
            upstream.pipe(socket);
          });
        })
        .catch(denied);
    });
    // No raw URLs, headers, response bodies or diagnostics are logged.
    this.#server.on('clientError', (_error, socket) => socket.destroy());
  }
  static async open(domains: readonly string[], current: () => boolean) {
    if (
      !current() ||
      !domains.length ||
      domains.some((name) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(name))
    )
      throw new Error('Current host admission and exact DNS grants required.');
    const proxy = new GroupNetworkProxy(Object.freeze([...new Set(domains)]), current);
    await new Promise<void>((resolve, reject) => {
      proxy.#server.once('error', reject);
      proxy.#server.listen(0, '127.0.0.1', resolve);
    });
    const address = proxy.#server.address();
    if (!address || typeof address === 'string') {
      await proxy.close();
      throw new Error('Proxy unavailable.');
    }
    proxy.#port = address.port;
    proxy.#watch = setInterval(() => {
      if (!current()) void proxy.close();
    }, 100);
    return proxy;
  }
  get port() {
    return this.#port;
  }
  get url() {
    return `http://group:${this.#secret}@127.0.0.1:${this.#port}`;
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#watch);
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

// Fail closed for IANA special-purpose IPv4 ranges; IPv6-only destinations
// currently fail explicitly. Native TLS hostname verification remains native.
export function publicIPv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255))
    return false;
  const [a, b, c] = parts.map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a! >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
