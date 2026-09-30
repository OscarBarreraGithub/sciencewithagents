import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PhoneAccess, PhoneConfig } from './phone-access.js';
import { inspectTailscale, tailscaleBinary, tailscaleRouteReady } from './tailscale.js';

type Connector = { ready(): Promise<boolean>; close(): Promise<void>; alive(): boolean };
type Connect = (tokenFile: string) => Promise<Connector>;

/** Only the configured tunnel is supervised. No shell, cloud API or browser-supplied arguments. */
export class PhoneTunnel {
  private connector: Connector | null = null;
  private closed = false;
  private started = false;
  private queue = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private retries = 0;
  private retryAt = 0;
  private healthySince: number | null = null;
  private readonly tokenFile: string;
  private readonly change = () => {
    void this.sync();
  };
  constructor(
    private readonly phone: PhoneAccess,
    root: string,
    private readonly connect: Connect = connectCloudflare,
    private readonly privateConnect: (config: PhoneConfig) => Promise<Connector> = connectTailscale,
  ) {
    this.tokenFile = join(root, 'cloudflare-tunnel.token');
    if (phone.config && (phone.config.transport === 'tailscale' || existsSync(this.tokenFile)))
      phone.connection = 'off';
  }
  start() {
    if (
      this.started ||
      this.closed ||
      this.phone.setupIssue ||
      this.phone.connection === 'external'
    )
      return;
    this.started = true;
    this.phone.on('change', this.change);
    this.timer = setInterval(() => {
      void this.sync();
    }, 3000);
    this.timer.unref();
    void this.sync();
  }
  retry() {
    return this.sync(true);
  }
  private sync(retry = false) {
    let retryable = false;
    this.queue = this.queue
      .then(async () => {
        if (!this.started) return;
        if (this.closed || !this.phone.enabled) {
          await this.stop();
          this.retries = 0;
          this.retryAt = 0;
          this.healthySince = null;
          this.phone.connection = 'off';
          return;
        }
        if (retry) {
          this.retries = 0;
          this.retryAt = 0;
          if (this.phone.connection === 'error' || this.connector?.alive() === false)
            await this.stop();
        }
        if (Date.now() < this.retryAt) return;
        if (!this.connector) {
          if (this.phone.connection === 'error' && !retry) return;
          this.phone.connection = 'connecting';
          if (this.phone.config?.transport === 'tailscale') {
            retryable = true;
            this.connector = await this.privateConnect(this.phone.config);
          } else {
            const stat = lstatSync(this.tokenFile);
            if (!stat.isFile() || (stat.mode & 0o077) !== 0)
              throw new Error('Private token file required');
            retryable = true;
            this.connector = await this.connect(this.tokenFile);
          }
        }
        retryable = true;
        if (!this.connector.alive()) throw new Error('Connector exited');
        const ready = await this.connector.ready();
        this.phone.connection = ready ? 'connected' : 'connecting';
        this.healthySince = ready ? (this.healthySince ?? Date.now()) : null;
        // A brief healthy probe must not let a repeatedly crashing connector loop forever.
        if (this.healthySince !== null && Date.now() - this.healthySince >= 120_000)
          this.retries = 0;
      })
      .catch(async () => {
        // Never expose connector diagnostics, arguments or credentials through the API or logs.
        await this.stop();
        this.healthySince = null;
        if (this.closed || !this.phone.enabled) this.phone.connection = 'off';
        else if (retryable && this.retries < 3) {
          this.retryAt = Date.now() + [5000, 15_000, 60_000][this.retries++]!;
          this.phone.connection = 'connecting';
        } else this.phone.connection = 'error';
      });
    return this.queue;
  }
  private async stop() {
    const connector = this.connector;
    this.connector = null;
    this.healthySince = null;
    await connector?.close();
  }
  async close() {
    this.closed = true;
    this.phone.off('change', this.change);
    if (this.timer) clearInterval(this.timer);
    await this.sync();
  }
}

async function connectCloudflare(tokenFile: string): Promise<Connector> {
  // Reserve an ephemeral loopback metrics address; never reuse another connector's fixed port.
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('No metrics address');
  await new Promise<void>((resolve, reject) =>
    reservation.close((e) => (e ? reject(e) : resolve())),
  );
  const env = { ...process.env };
  delete env.TUNNEL_TOKEN;
  delete env.TUNNEL_TOKEN_FILE;
  return ownConnector(
    process.env.DOCK_CLOUDFLARED_BIN ?? 'cloudflared',
    [
      'tunnel',
      '--no-autoupdate',
      '--metrics',
      `127.0.0.1:${address.port}`,
      'run',
      '--token-file',
      tokenFile,
    ],
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/ready`, {
          signal: AbortSignal.timeout(1000),
          redirect: 'error',
        });
        await response.body?.cancel();
        return response.ok;
      } catch {
        return false;
      }
    },
    env,
  );
}

async function connectTailscale(config: PhoneConfig): Promise<Connector> {
  const state = await inspectTailscale();
  if (
    state.state !== 'ready' ||
    state.origin !== config.origin ||
    state.node !== config.tailscaleNode
  )
    throw new Error('The original private address is not ready or already in use.');
  // Foreground Serve is removed by Tailscale when this owned connection exits.
  // Never use Funnel, reset another app's routes, or install an always-on service.
  return ownConnector(
    tailscaleBinary(),
    ['serve', '--bg=false', '--https=443', '--yes', `http://127.0.0.1:${config.port}`],
    () => tailscaleRouteReady(config),
  );
}

function ownConnector(
  binary: string,
  args: string[],
  ready: () => Promise<boolean>,
  env = process.env,
): Connector {
  const host = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? './provider-host.ts' : './provider-host.js',
      import.meta.url,
    ),
  );
  // Reuse the existing lifetime-pipe host: a gateway crash also terminates its tunnel group.
  const child: ChildProcess = spawn(process.execPath, [host, binary, JSON.stringify(args)], {
    stdio: ['pipe', 'ignore', 'ignore'],
    env,
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once('error', () => {
      exited = true;
      resolve();
    });
    child.once('exit', () => {
      exited = true;
      resolve();
    });
  });
  child.stdin?.on('error', () => {});
  return {
    alive: () => !exited,
    async ready() {
      return (await ready()) && !exited;
    },
    async close() {
      if (exited) return;
      child.stdin?.end();
      await exit;
    },
  };
}
