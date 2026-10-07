/** Disposable acceptance harness around NORMAL createServer + LocalAccess + GroupHost.
 * No --fixture, demo provider, Runtime.initialize/kick or native command is used. */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { repoRoot } from './paths.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { PhoneAccess } from './phone-access.js';
import { GroupHost } from './group-host.js';
import { createServer } from './server.js';
import type { GroupNativeSnapshot } from './group-host-native.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';
async function freePort() {
  const s = netServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r, j) => s.close((e) => (e ? j(e) : r())));
  return p;
}
mkdirSync(join(repoRoot, 'data/normal-groups'), { recursive: true });
const root = mkdtempSync(join(repoRoot, 'data/normal-groups/browser-'));
const setup = randomBytes(32).toString('hex'),
  hash = createHash('sha256').update(`dock-group-setup-v1:${setup}`).digest('hex');
const workerPort = await freePort();
let worker: ChildProcess | undefined;
const closers: (() => Promise<void>)[] = [];
let closing = false;
const controlledAgent = process.argv.includes('--controlled-agent');
const nativeSnapshots = new Map<string, GroupNativeSnapshot>();
let nativeSubmits = 0;
let loseNativeAck = true;
async function close() {
  if (closing) return;
  closing = true;
  for (const closeInstallation of closers.reverse()) await closeInstallation();
  if (worker && worker.exitCode === null) {
    const exited = new Promise<void>((r) => worker!.once('exit', () => r()));
    worker.kill('SIGTERM');
    await exited;
  }
  if (controlledAgent && process.env.GROUP_HOST_ACCEPTANCE_RECEIPT)
    writeFileSync(
      process.env.GROUP_HOST_ACCEPTANCE_RECEIPT,
      JSON.stringify({
        nativeSubmits,
        nativeRequests: nativeSnapshots.size,
        providerCalls: 0,
        closed: true,
      }),
      { mode: 0o600 },
    );
  rmSync(root, { recursive: true, force: true });
}
process.on('SIGINT', () => void close().then(() => process.exit()));
process.on('SIGTERM', () => void close().then(() => process.exit()));
async function launchInstallation(name: string, configured = true) {
  const directory = join(root, name),
    port = await freePort();
  mkdirSync(directory, { mode: 0o700 });
  const store = new Store(join(directory, 'dock.sqlite'));
  let runtime: Runtime | undefined,
    host: GroupHost | undefined,
    app: Awaited<ReturnType<typeof createServer>> | undefined;
  closers.push(async () => {
    await app?.close();
    await runtime?.close();
    await host?.close();
    store.close();
  });
  runtime = new Runtime(store, directory, join(root, 'unavailable-native'), async () => {
    throw new Error('Acceptance harness never launches a provider');
  });
  let loseCommit = name === 'primary' && !controlledAgent;
  host = new GroupHost(directory, {
    ...(controlledAgent
      ? {
          native: {
            availability: () => ({
              available: true,
              productionReady: true,
              authState: 'ready' as const,
              message: 'Controlled typed native port; no provider/account readiness claim.',
            }),
            submit: async (input: import('./group-host-native.js').GroupNativeRequest) => {
              nativeSubmits++;
              const value: GroupNativeSnapshot = {
                requestId: input.requestId,
                state: 'queued',
                message: 'Controlled native acceptance, no model turn.',
              };
              nativeSnapshots.set(input.requestId, value);
              if (loseNativeAck) {
                loseNativeAck = false;
                throw new Error('Lost controlled native admission acknowledgement');
              }
              return value;
            },
            inspect: async ({ requestId }: { requestId: string }) =>
              nativeSnapshots.get(requestId)!,
          },
        }
      : {}),
    http: async (...args) => {
      const response = await fetch(...args);
      const command = JSON.parse(String(args[1]?.body ?? '{}'));
      if (loseCommit && command.kind === 'effect' && command.packet.kind === 'commit') {
        loseCommit = false;
        throw new Error('Lost successful commit acknowledgement in owned acceptance harness');
      }
      return response;
    },
  });
  if (configured)
    writeFileSync(
      join(host.directory, 'service.json'),
      JSON.stringify({
        version: 1,
        mode: 'local-test',
        endpoint: `http://127.0.0.1:${workerPort}/`,
        endpointId: randomUUID(),
        setupCapability: setup,
      }),
      { mode: 0o600 },
    );
  const access = new LocalAccess(prepareLocalAccess(directory, port));
  app = await createServer(store, runtime, {
    port,
    phone: new PhoneAccess(store, null),
    localAccess: access,
    groupHost: host,
    webDir: join(repoRoot, 'apps/web/dist'),
    ownsRuntime: false,
  });
  await app.listen({ host: '127.0.0.1', port });
  const cookie = access.consumeHandoff(access.issueHandoff().ticket).split(';')[0];
  return { origin: access.browserOrigin, cookie, port };
}
try {
  worker = spawn(
    process.execPath,
    [
      join(repoRoot, 'apps/group-service/node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(workerPort),
      '--inspector-port',
      '0',
      '--persist-to',
      join(root, 'workerd'),
      '--var',
      'HOSTING_MODE:local-test',
      '--var',
      `GROUP_SETUP_HASH:${hash}`,
      '--log-level',
      'error',
    ],
    {
      cwd: join(repoRoot, 'apps/group-service'),
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: 'pipe',
    },
  );
  worker.stdout?.resume();
  worker.stderr?.resume();
  const deadline = Date.now() + 20000;
  for (;;) {
    if (worker.exitCode !== null || Date.now() > deadline)
      throw new Error('Owned workerd startup failed');
    try {
      const r = await fetch(`http://127.0.0.1:${workerPort}/v1/create`, {
        method: 'POST',
        signal: AbortSignal.timeout(300),
      });
      if (r.status === 403 || r.status === 400) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const primary = await launchInstallation('primary'),
    secondary = await launchInstallation('secondary'),
    unconfigured = await launchInstallation('unconfigured', false);
  // Only stdout is the parent-test ready pipe. Never register/publish this test cookie.
  process.stdout.write(JSON.stringify({ ...primary, secondary, unconfigured }) + '\n');
} catch (error) {
  await close();
  process.stderr.write(error instanceof Error ? error.message : 'Acceptance startup failed');
  process.exit(1);
}
