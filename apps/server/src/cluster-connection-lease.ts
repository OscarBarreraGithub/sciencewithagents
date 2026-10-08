import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queryOptions } from './cluster.js';

export type HeldClusterClient = {
  close(): void | Promise<void>;
  onExit(listener: () => void): void;
};
export type ClusterLeaseSpawn = (alias: string) => HeldClusterClient;
/** Own one noninteractive mux client, never the owner's master. ProxyCommand=false
 * prevents a missing socket from silently creating another authenticated connection. */
export const spawnClusterLease: ClusterLeaseSpawn = (alias) => {
  const args = [
    // SSH keeps the first value: override the collector's keepalive before
    // queryOptions. An idle mux proxy must not send unsupported global requests.
    '-o',
    'ServerAliveInterval=0',
    ...queryOptions,
    '-O',
    'proxy',
    '-N',
    '-T',
    '-o',
    'ForkAfterAuthentication=no',
    '-o',
    'ProxyCommand=false',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'RemoteCommand=none',
    '--',
    alias,
  ];
  const lifetimeHost = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? './provider-host.ts' : './provider-host.js',
      import.meta.url,
    ),
  );
  // The app's existing lifetime pipe also closes this owned client after a crash.
  const child = spawn(process.execPath, [lifetimeHost, 'ssh', JSON.stringify(args)], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin?.on('error', () => {});
  let ended = false;
  const listeners = new Set<() => void>();
  let escalation: NodeJS.Timeout | null = null;
  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const finish = () => {
    if (ended) return;
    ended = true;
    resolveClosed();
    if (escalation) clearTimeout(escalation);
    for (const listener of listeners) listener();
  };
  child.once('error', finish);
  child.once('close', finish);
  return {
    onExit(listener) {
      if (ended) listener();
      else listeners.add(listener);
    },
    close() {
      if (ended) return closed;
      child.stdin?.end();
      escalation ??= setTimeout(() => {
        if (!ended) child.kill('SIGKILL');
      }, 2000);
      escalation.unref();
      return closed;
    },
  };
};
