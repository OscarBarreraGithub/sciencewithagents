import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PhoneConfig } from './phone-access.js';

const exec = promisify(execFile);
const object = z.record(z.string(), z.unknown());
export function tailscaleBinary() {
  if (process.env.DOCK_TAILSCALE_BIN) return process.env.DOCK_TAILSCALE_BIN;
  const mac = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  return process.platform === 'darwin' && existsSync(mac) ? mac : 'tailscale';
}
export type TailscaleRead = (args: string[]) => Promise<unknown>;
export const readTailscale: TailscaleRead = async (args) => {
  const { stdout } = await exec(tailscaleBinary(), args, {
    timeout: 5000,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout);
};
export type TailscaleState = {
  state: 'unavailable' | 'connect' | 'https' | 'conflict' | 'ready';
  message: string;
  origin: string | null;
  node: string | null;
};
function configs(raw: unknown): Record<string, unknown>[] {
  const top = object.parse(raw ?? {});
  const children = object.parse(top.Foreground ?? {});
  return [top, ...Object.values(children).map((value) => object.parse(value))];
}
function node(raw: unknown) {
  const status = z
    .object({
      BackendState: z.string(),
      Self: z
        .object({
          ID: z.string().min(1),
          DNSName: z.string(),
          CapMap: object.nullish(),
          Capabilities: z.array(z.string()).nullish(),
        })
        .nullish(),
      CertDomains: z.array(z.string()).nullish(),
    })
    .parse(raw);
  if (status.BackendState !== 'Running' || !status.Self) return null;
  const hostname = status.Self.DNSName.replace(/\.$/, '').toLowerCase();
  if (!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(hostname)) return null;
  return {
    origin: `https://${hostname}`,
    node: createHash('sha256')
      .update(JSON.stringify([status.Self.ID, hostname]))
      .digest('hex'),
    https:
      !!status.CertDomains?.includes(hostname) ||
      status.Self.Capabilities?.includes('https') === true ||
      Object.hasOwn(status.Self.CapMap ?? {}, 'https'),
  };
}
/** Only this computer's readiness is projected; peers, user details and keys stay private. */
export async function inspectTailscale(
  read: TailscaleRead = readTailscale,
): Promise<TailscaleState> {
  try {
    const current = node(await read(['status', '--json', '--peers=false']));
    if (!current)
      return {
        state: 'connect',
        origin: null,
        node: null,
        message:
          'Open Tailscale on this computer and finish connecting. Use the same private network on your phone.',
      };
    if (!current.https)
      return {
        ...current,
        state: 'https',
        message:
          'Enable HTTPS certificates in Tailscale, then check again. This lets your phone save and use a passkey.',
      };
    const occupied = configs(await read(['serve', 'status', '--json'])).some(
      (config) =>
        Object.hasOwn(object.parse(config.TCP ?? {}), '443') ||
        Object.keys(object.parse(config.Web ?? {})).some((key) => key.endsWith(':443')) ||
        object.parse(config.AllowFunnel ?? {})[`${new URL(current.origin).hostname}:443`] === true,
    );
    if (occupied)
      return {
        ...current,
        state: 'conflict',
        message:
          'Tailscale is already serving another connection. Keep that connection; ask your setup agent to choose a separate address for this app.',
      };
    return {
      ...current,
      state: 'ready',
      message: 'This computer is ready for a private phone connection.',
    };
  } catch {
    return {
      state: 'unavailable',
      origin: null,
      node: null,
      message:
        'Tailscale could not be reached. Install or open it on this computer, finish its sign-in, then check again.',
    };
  }
}
/** An owned foreground route must remain private and attached to its original node. */
export async function tailscaleRouteReady(
  config: PhoneConfig,
  read: TailscaleRead = readTailscale,
) {
  const current = node(await read(['status', '--json', '--peers=false']));
  if (!current?.https || current.origin !== config.origin || current.node !== config.tailscaleNode)
    throw new Error('The original Tailscale connection is unavailable.');
  const routes = configs(await read(['serve', 'status', '--json']));
  if (
    routes.some(
      (route) =>
        object.parse(route.AllowFunnel ?? {})[`${new URL(config.origin).hostname}:443`] === true,
    )
  )
    throw new Error('The private route changed.');
  const authority = `${new URL(config.origin).hostname}:443`;
  return routes.slice(1).some((route) => {
    const web = object.parse(route.Web ?? {});
    const host = object.parse(web[authority] ?? {});
    const handlers = object.parse(host.Handlers ?? {});
    return (
      object.parse(handlers['/'] ?? {}).Proxy === `http://127.0.0.1:${config.port}` &&
      object.parse(object.parse(route.TCP ?? {})['443'] ?? {}).HTTPS === true
    );
  });
}
