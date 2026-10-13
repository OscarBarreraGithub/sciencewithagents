import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, port, repoRoot } from './paths.js';
import { createGroupsServices, type GroupsServices } from './groups-services.js';
import { createGroupsServer } from './groups-server.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';
import { PhoneAccess, readPhoneConfig } from './phone-access.js';
import { PhoneTunnel } from './phone-tunnel.js';

process.umask(0o077);
if (process.env.DOCK_CLUSTER_BOOTSTRAP_FILE)
  throw new Error('Groups-only cannot launch a cluster runtime.');
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Choose a local port between 1024 and 65535.');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const lockPath = join(dataDir, 'server.lock');
function lock() {
  try {
    return openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new Error('Invalid service lock. Ask your setup agent to inspect it.');
    try {
      process.kill(pid, 0);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure;
      unlinkSync(lockPath);
      return openSync(lockPath, 'wx', 0o600);
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
let services: GroupsServices | undefined;
let app: Awaited<ReturnType<typeof createGroupsServer>> | undefined;
let remote: Awaited<ReturnType<typeof createGroupsServer>> | undefined;
let tunnel: PhoneTunnel | undefined;
let stopping = false;
let accepting = false;
let startup: Promise<void> = Promise.resolve();
let closing: Promise<void> | undefined;
const ready = () => accepting && !stopping;
const stop = () => {
  stopping = true;
  accepting = false;
  return (closing ??= (async () => {
    await startup.catch(() => {});
    const errors: unknown[] = [];
    const close = async (action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    await close(() => tunnel?.close());
    await Promise.all([close(() => remote?.close()), close(() => app?.close())]);
    await close(() => services?.close());
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
      throw new AggregateError(errors, 'Groups could not close every owned resource.');
  })());
};
const requestedStop = () => {
  void stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGTERM', requestedStop);
process.once('SIGINT', requestedStop);
if (process.env.DOCK_LAUNCHER_LIFETIME === '1') {
  process.stdin.once('end', requestedStop);
  process.stdin.once('error', requestedStop);
  process.stdin.resume();
}
const checkStopping = () => {
  if (stopping) throw new Error('Groups stopped during startup.');
};
startup = (async () => {
  services = await createGroupsServices(dataDir);
  let config: ReturnType<typeof readPhoneConfig> = null;
  let issue: 'configuration' | null = null;
  try {
    config = readPhoneConfig(dataDir);
    if (config?.port === port) throw new Error('Separate listener required.');
  } catch {
    config = null;
    issue = 'configuration';
  }
  const phone = new PhoneAccess(services.store, config, undefined, issue);
  app = await createGroupsServer(services, {
    port,
    phone,
    ready,
    localAccess: new LocalAccess(prepareLocalAccess(dataDir, port)),
    devPort: process.env.DOCK_DEV === '1' ? 5178 : undefined,
    webDir: join(repoRoot, 'apps/web/dist'),
  });
  checkStopping();
  await app.listen({ host: '127.0.0.1', port });
  checkStopping();
  if (phone.config) {
    try {
      remote = await createGroupsServer(services, {
        port: phone.config.port,
        phone,
        remote: true,
        ready,
        webDir: join(repoRoot, 'apps/web/dist'),
      });
      checkStopping();
      await remote.listen({ host: '127.0.0.1', port: phone.config.port });
      checkStopping();
      phone.listenerReady();
      tunnel = new PhoneTunnel(phone, dataDir);
    } catch (error) {
      await remote?.close();
      remote = undefined;
      phone.unavailable('listener');
      checkStopping();
      console.error(
        error instanceof Error ? error.message : 'Saved phone connection is unavailable.',
      );
    }
  }
  checkStopping();
  accepting = true;
  services.start();
  tunnel?.start();
  console.log(`sciencewithagents Groups: http://127.0.0.1:${port}`);
})();
try {
  await startup;
} catch (error) {
  await stop();

  console.error(error instanceof Error ? error.message : 'Groups could not start.');
  process.exitCode = 1;
}
