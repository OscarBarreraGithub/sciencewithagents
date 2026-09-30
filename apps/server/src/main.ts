import { defaultModelPolicy } from '@dock/shared';
import { mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { binary, dataDir, port, repoRoot } from './paths.js';
import { DemoProvider, seedDemo } from './demo.js';
import { PhoneAccess, readPhoneConfig } from './phone-access.js';
import { Terminals } from './terminal.js';
import { SourceBackups } from './source-backups.js';
import { PhoneTunnel } from './phone-tunnel.js';
import { PhoneSetup } from './phone-setup.js';
import { Hosts } from './hosts.js';
import { VscodeMirrors } from './vscode-mirror.js';
import { prepareAgentClient } from './agent-client.js';
import { initializeScheduling } from './pulsar.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';

process.umask(0o077);
const demo = process.argv.includes('--demo');
const root = demo ? join(dataDir, 'demo') : dataDir;
mkdirSync(root, { recursive: true, mode: 0o700 });
const lockPath = join(root, 'server.lock');
function lock() {
  try {
    return openSync(lockPath, 'wx', 0o600);
  } catch {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new Error('Invalid service lock. Inspect data/server.lock before starting.');
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        unlinkSync(lockPath);
        return openSync(lockPath, 'wx', 0o600);
      }
      throw error;
    }
    throw new Error('sciencewithagents is already running with this data directory.');
  }
}
const fd = lock();
try {
  writeSync(fd, String(process.pid));
} catch (error) {
  unlinkSync(lockPath);
  throw error;
} finally {
  closeSync(fd);
}

// Main retains ownership even if configuration, a listener, or startup fails halfway.
let store: Store | undefined;
let runtime: Runtime | undefined;
let tunnel: PhoneTunnel | undefined;
let terminals: Terminals | undefined;
let backups: SourceBackups | undefined;
let hosts: Hosts | undefined;
let app: Awaited<ReturnType<typeof createServer>> | undefined;
let remote: Awaited<ReturnType<typeof createServer>> | undefined;
let phoneStarting: Promise<void> | undefined;
let accepting = false;
let stopping = false;
let requested = false;
let startup: Promise<void> = Promise.resolve();
let closing: Promise<void> | undefined;
const ready = () => accepting && !stopping;
function checkStopping() {
  if (stopping) throw new Error('sciencewithagents stopped during startup.');
}
function stop() {
  stopping = true;
  accepting = false;
  return (closing ??= (async () => {
    // A signal can arrive during an awaited version check or server construction.
    // Finish acquiring that resource before cleanup, without allowing model dispatch.
    await startup.catch(() => {});
    await phoneStarting?.catch(() => {});
    const errors: unknown[] = [];
    const close = async (action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    // Close marks Runtime stopped synchronously; do not dispatch new queued work while
    // slower network, backup, or browser connections are still draining below.
    const runtimeClosing = close(() => runtime?.close());
    await close(() => tunnel?.close());
    await close(() => backups?.close());
    await close(() => terminals?.close());
    await Promise.all([close(() => remote?.close()), close(() => app?.close())]);
    await close(() => hosts?.close());
    await runtimeClosing;
    await close(() => store?.close());
    if (process.env.DOCK_LAUNCHER_LIFETIME === '1') {
      process.stdin.removeListener('end', requestedStop);
      process.stdin.removeListener('error', requestedStop);
      process.stdin.destroy();
    }
    await close(() => {
      try {
        if (readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
    if (errors.length)
      throw new AggregateError(errors, 'sciencewithagents could not close every resource cleanly.');
  })());
}
const requestedStop = () => {
  requested = true;
  void stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGTERM', requestedStop);
process.once('SIGINT', requestedStop);
if (process.env.DOCK_LAUNCHER_LIFETIME === '1') {
  // The local launcher owns this pipe. Losing it must not orphan its server or workers.
  process.stdin.once('end', requestedStop);
  process.stdin.once('error', requestedStop);
  process.stdin.resume();
}

startup = (async () => {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(
      'sciencewithagents needs a local port between 1024 and 65535. Ask your setup agent to check its configuration.',
    );
  let phoneConfig: ReturnType<typeof readPhoneConfig> = null;
  let phoneIssue: 'configuration' | null = null;
  if (!demo) {
    try {
      phoneConfig = readPhoneConfig(root);
      if (phoneConfig?.port === port) throw new Error('Separate listener required.');
    } catch {
      phoneConfig = null;
      phoneIssue = 'configuration';
    }
  }
  store = new Store(join(root, 'dock.sqlite'));
  if (!demo) initializeScheduling(store);
  if (demo) {
    if (!store.getSetting('model-policy')) {
      const policy = structuredClone(defaultModelPolicy);
      for (const task of Object.keys(policy.providers) as (keyof typeof policy.providers)[])
        policy.providers[task] = 'codex';
      for (const tier of Object.keys(policy.models.codex) as (keyof typeof policy.models.codex)[])
        policy.models.codex[tier].model = 'demo';
      store.setSetting('model-policy', policy);
    }
    seedDemo(store, repoRoot);
  }
  runtime = new Runtime(
    store,
    root,
    binary,
    demo ? async (agent) => new DemoProvider(agent.cwd) : undefined,
    demo
      ? {
          inspect: async () => {
            throw new Error('Demo mode does not discover real Claude accounts.');
          },
        }
      : undefined,
  );
  const phone = new PhoneAccess(store, phoneConfig, undefined, phoneIssue);
  const mirrors = new VscodeMirrors(store);
  tunnel = new PhoneTunnel(phone, root);
  terminals = new Terminals(runtime);
  backups = new SourceBackups(store, root, undefined, demo ? [] : undefined);
  hosts = new Hosts(root, undefined, demo ? [] : undefined);
  if (demo)
    runtime.health = { ready: true, version: 'demo', message: 'Demo mode · no model calls' };
  else {
    try {
      const { stdout } = await promisify(execFile)(binary, ['--version'], { timeout: 5000 });
      runtime.health = {
        ready: true,
        version: stdout.trim(),
        message: 'Codex installed · ready to connect',
      };
    } catch {
      runtime.health = {
        ready: false,
        version: '',
        message:
          'Codex is not available yet. Ask your setup agent to finish its installation and sign-in, then reopen sciencewithagents.',
      };
    }
  }
  checkStopping();
  const activatePhone = () => {
    if (phoneStarting) return phoneStarting;
    phoneStarting = (async () => {
      checkStopping();
      if (remote) return;
      if (!phone.config) throw new Error('Phone setup is incomplete.');
      try {
        remote = await createServer(store!, runtime!, {
          port: phone.config.port,
          webDir: join(repoRoot, 'apps/web/dist'),
          phone,
          terminals,
          mirrors,
          backups,
          hosts,
          remote: true,
          ownsRuntime: false,
          ready,
        });
        checkStopping();
        await remote.listen({ host: '127.0.0.1', port: phone.config.port });
        checkStopping();
        phone.listenerReady();
        if (accepting) tunnel!.start();
      } catch {
        await remote?.close();
        remote = undefined;
        phone.unavailable('listener');
        throw new Error(
          'The phone connection could not start. Its settings are saved; choose Retry connection.',
        );
      }
    })().finally(() => {
      phoneStarting = undefined;
    });
    return phoneStarting;
  };
  const phoneSetup = demo
    ? undefined
    : new PhoneSetup(phone, root, port, activatePhone, undefined, () => !stopping);
  app = await createServer(store, runtime, {
    port,
    webDir: join(repoRoot, 'apps/web/dist'),
    agentClient: prepareAgentClient(root, port),
    localAccess: demo ? undefined : new LocalAccess(prepareLocalAccess(root, port)),
    devPort: process.env.DOCK_DEV === '1' ? 5178 : undefined,
    demo,
    phone,
    tunnel,
    phoneSetup,
    repairPhoneListener: activatePhone,
    mirrors,
    terminals,
    backups,
    hosts,
    ownsRuntime: false,
    ready,
  });
  checkStopping();
  await app.listen({ host: '127.0.0.1', port });
  checkStopping();
  if (phone.config) {
    try {
      await activatePhone();
    } catch {
      checkStopping();
    }
  }
  checkStopping();
  // The local entry is required. An unavailable optional phone entry has no connector
  // and grants no remote access; it does not disable already authorized local work.
  // Browser actions remain gated until startup reconciliation has completed.
  await runtime.initialize();
  if (!demo) {
    runtime.capacity.start();
    runtime.resources.start();
  }
  checkStopping();
  tunnel.start();
  backups.start();
  accepting = true;
  console.log(`sciencewithagents${demo ? ' (demo)' : ''}: http://127.0.0.1:${port}`);
})();
try {
  await startup;
} catch (error) {
  await stop();
  if (!requested) {
    console.error(
      runtime?.errorText(error) ??
        (error instanceof Error ? error.message : 'sciencewithagents could not start.'),
    );
    process.exitCode = 1;
  }
}
