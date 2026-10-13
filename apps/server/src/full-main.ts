import {
  computeClusterRunner,
  computeBootstrap,
  computeRuntimeIdentity,
} from './cluster-compute.js';
import { ClusterRemoteAdmission } from './cluster-remote-admission.js';
import { ClusterRuntimeIdle } from './cluster-runtime-idle.js';
import { createClusterControllerServices } from './cluster-controller-services.js';
import { GroupHost } from './group-host.js';
import { createProductionGroupHost } from './group-host-bootstrap.js';
import { GroupFixtureHost } from './group-fixture-host.js';
import { defaultModelPolicy } from '@dock/shared';
import { mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { localEntryOptions, phoneEntryOptions, type SharedEntryServices } from './entry-options.js';
import { binary, dataDir, port, repoRoot } from './paths.js';
import { DemoProvider, seedDemo } from './demo.js';
import { PhoneAccess, readPhoneConfig } from './phone-access.js';
import { Terminals } from './terminal.js';
import { OwnerTerminals } from './owner-terminal.js';
import { NativeConnections } from './native-connections.js';
import { NativeRunnerLaunch } from './native-runner-launch.js';
import { SourceBackups } from './source-backups.js';
import { PublishingAccounts } from './publishing-accounts.js';
import { PhoneTunnel } from './phone-tunnel.js';
import { PhoneSetup } from './phone-setup.js';
import { Hosts } from './hosts.js';
import { PushNotifications, phoneDeviceState } from './push-notifications.js';
import { VscodeMirrors } from './vscode-mirror.js';
import { CodexDaemonChats } from './codex-daemon-chats.js';
import { prepareAgentClient } from './agent-client.js';
import { initializeScheduling } from './pulsar.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';
import { NotebookGateway, readNotebookConfig } from './notebook-gateway.js';
import { selectDevelopmentFixture } from './development-fixture.js';

process.umask(0o077);
const demo = process.argv.includes('--demo');
const fixture = selectDevelopmentFixture(process.argv.slice(2), process.env, repoRoot);
if ((demo || fixture) && process.env.DOCK_CLUSTER_BOOTSTRAP_FILE)
  throw new Error('Development fixtures cannot become cluster runtimes.');
const computeRunner = await computeClusterRunner(process.env.DOCK_CLUSTER_BOOTSTRAP_FILE);
const listenPort = fixture?.port ?? port;
const root = fixture?.data ?? (demo ? join(dataDir, 'demo') : dataDir);
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
let clusterServices: ReturnType<typeof createClusterControllerServices>;
let clusterAdmission: ClusterRemoteAdmission | undefined;
let clusterIdle: ClusterRuntimeIdle | undefined;
let store: Store | undefined;
let runtime: Runtime | undefined;
let groupFixture: GroupFixtureHost | undefined;
let groupHost: GroupHost | undefined;
let tunnel: PhoneTunnel | undefined;
let terminals: Terminals | undefined;
let ownerTerminals: OwnerTerminals | undefined;
let nativeConnections: NativeConnections | undefined;
let nativeRunnerLaunch: NativeRunnerLaunch | undefined;
let backups: SourceBackups | undefined;
let hosts: Hosts | undefined;
let notebookGateway: NotebookGateway | undefined;
let notifications: PushNotifications | undefined;
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
  // Freeze saved allocation intents before awaiting unrelated resource cleanup.
  // A review may finish while those resources are still closing.
  clusterServices?.projects.close();
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
    const nativeLaunchingClose = close(() => nativeRunnerLaunch?.close());
    const runtimeClosing = close(() => runtime?.close());
    await close(() => notebookGateway?.close());
    await close(() => tunnel?.close());
    await close(() => backups?.close());
    await close(() => terminals?.close());
    await close(() => ownerTerminals?.close());
    await nativeLaunchingClose;
    await close(() => nativeConnections?.close());
    await Promise.all([close(() => remote?.close()), close(() => app?.close())]);
    await close(() => clusterServices?.close());
    await close(() => clusterAdmission?.close());
    await close(() => clusterIdle?.close());
    await close(() => hosts?.close());
    await close(() => notifications?.close());
    await runtimeClosing;
    await close(() => groupFixture?.close());
    await close(() => groupHost?.close());
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
  if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535)
    throw new Error(
      'sciencewithagents needs a local port between 1024 and 65535. Ask your setup agent to check its configuration.',
    );
  let phoneConfig: ReturnType<typeof readPhoneConfig> = null;
  let phoneIssue: 'configuration' | null = null;
  if (!demo) {
    try {
      phoneConfig = readPhoneConfig(root);
      if (phoneConfig?.port === listenPort) throw new Error('Separate listener required.');
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
      if (fixture) policy.enabledProviders = ['codex'];
      for (const task of Object.keys(policy.providers) as (keyof typeof policy.providers)[])
        policy.providers[task] = 'codex';
      for (const tier of Object.keys(policy.models.codex) as (keyof typeof policy.models.codex)[])
        policy.models.codex[tier].model = 'demo';
      store.setSetting('model-policy', policy);
    }
    seedDemo(store, fixture?.workspace ?? repoRoot);
  }
  runtime = new Runtime(
    store,
    root,
    binary,
    demo ? async (agent) => new DemoProvider(agent.cwd ?? fixture?.workspace) : undefined,
    demo
      ? {
          inspect: async () => {
            throw new Error('Demo mode does not discover real Claude accounts.');
          },
        }
      : undefined,
    fixture ? { workspace: fixture.workspace } : undefined,
    computeRunner,
  );
  if (computeRunner) {
    const bootstrap = computeBootstrap(process.env.DOCK_CLUSTER_BOOTSTRAP_FILE!);
    runtime.capacity.allocationLimits = { cpus: bootstrap.cpus, memoryMb: bootstrap.memoryMb };
    clusterAdmission = new ClusterRemoteAdmission(
      runtime,
      computeRuntimeIdentity(process.env.DOCK_CLUSTER_BOOTSTRAP_FILE!),
    );
  }
  if (!demo && !computeRunner) clusterServices = createClusterControllerServices(runtime, repoRoot);
  const phone = new PhoneAccess(store, phoneConfig, undefined, phoneIssue);
  if (!demo)
    try {
      notifications = new PushNotifications(root, { deviceState: phoneDeviceState(phone) });
    } catch {
      // Optional: the app runs without push if its private key storage cannot open.
      notifications = undefined;
    }
  let notebookConfig: ReturnType<typeof readNotebookConfig> = null;
  let notebookIssue: string | undefined;
  if (!demo) {
    try {
      notebookConfig = readNotebookConfig(root);
    } catch {
      notebookIssue =
        'Notebook access configuration needs setup. App views still work; check private data/notebook-access.json.';
    }
  }
  if (!fixture)
    notebookGateway = new NotebookGateway(
      notebookConfig,
      runtime.clusterNotebooks,
      ready,
      Date.now,
      notebookIssue,
      () =>
        !notebookConfig ||
        !phone.config ||
        new URL(notebookConfig.origin).hostname !== new URL(phone.config.origin).hostname,
    );
  await notebookGateway?.listen(
    [
      `http://127.0.0.1:${listenPort}`,
      `http://localhost:${listenPort}`,
      ...(phoneConfig ? [phoneConfig.origin] : []),
    ],
    [listenPort, ...(phoneConfig ? [phoneConfig.port] : [])],
  );
  const mirrors = new VscodeMirrors(
    store,
    demo ? undefined : new CodexDaemonChats(binary),
    (text) => runtime!.chatImages.prompt(text),
  );
  if (!fixture) tunnel = new PhoneTunnel(phone, root);
  terminals = new Terminals(runtime);
  ownerTerminals = new OwnerTerminals(
    fixture
      ? {
          shell: join(root, 'disabled-owner-shell'),
          cwd: fixture.workspace,
          computer: 'Development fixture',
        }
      : undefined,
  );
  if (clusterAdmission)
    clusterIdle = new ClusterRuntimeIdle(
      clusterAdmission.identity,
      runtime,
      terminals,
      ownerTerminals,
      process.env.DOCK_CLUSTER_BOOTSTRAP_FILE!,
      computeBootstrap(process.env.DOCK_CLUSTER_BOOTSTRAP_FILE!).idleMinutes,
    );
  nativeConnections = new NativeConnections(store, root, undefined, undefined, !demo && !fixture);
  nativeConnections.beforeOpen = () => ownerTerminals!.beforeOpen();
  nativeRunnerLaunch = NativeRunnerLaunch.production(
    store,
    root,
    nativeConnections,
    runtime.modelPolicy,
    { codex: binary, claude: process.env.DOCK_CLAUDE_BIN ?? 'claude' },
    !demo && !fixture,
  );
  nativeRunnerLaunch.beforeStart = () => ownerTerminals!.beforeOpen();
  ownerTerminals.externalActiveCount = () =>
    nativeConnections!.activeCount() + nativeRunnerLaunch!.activeCount();
  if (!fixture) backups = new SourceBackups(store, root, undefined, demo ? [] : undefined);
  hosts = new Hosts(root, undefined, demo ? [] : undefined);
  // Demo data never checks the real computer's GitHub or Cloudflare sign-in.
  const publishing = demo ? undefined : new PublishingAccounts(store);
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
  if (fixture) groupFixture = new GroupFixtureHost(store, runtime);
  if (!demo && !fixture && !computeRunner)
    groupHost = createProductionGroupHost(root, runtime, ownerTerminals);
  const shared: SharedEntryServices = {
    groupHost,
    clusterProjects: clusterServices?.projects,
    phone,
    notebookGateway,
    terminals,
    ownerTerminals,
    nativeConnections,
    nativeRunnerLaunch,
    mirrors,
    backups,
    hosts,
    publishing,
    notifications,
    ready,
  };
  const activatePhone = () => {
    if (phoneStarting) return phoneStarting;
    phoneStarting = (async () => {
      checkStopping();
      if (remote) return;
      if (!phone.config) throw new Error('Phone setup is incomplete.');
      try {
        remote = await createServer(
          store!,
          runtime!,
          phoneEntryOptions(shared, {
            port: phone.config.port,
            webDir: join(repoRoot, 'apps/web/dist'),
          }),
        );
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
    : new PhoneSetup(phone, root, listenPort, activatePhone, undefined, () => !stopping);
  app = await createServer(
    store,
    runtime,
    localEntryOptions(shared, {
      clusterCompute: !!computeRunner,
      clusterAdmission,
      clusterIdle,
      groupFixture,
      port: listenPort,
      webDir: join(repoRoot, 'apps/web/dist'),
      agentClient: fixture ? undefined : prepareAgentClient(root, listenPort),
      localAccess: demo ? undefined : new LocalAccess(prepareLocalAccess(root, listenPort)),
      devPort: process.env.DOCK_DEV === '1' ? 5178 : undefined,
      demo,
      tunnel,
      phoneSetup,
      repairPhoneListener: activatePhone,
    }),
  );
  checkStopping();
  await app.listen({ host: '127.0.0.1', port: listenPort });
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
  await clusterAdmission?.initialize();
  await runtime.initialize();
  clusterServices?.start();
  groupFixture?.recover();
  if (!demo) {
    runtime.capacity.start(!computeRunner);
    runtime.resources.start();
    runtime.cluster.start();
  }
  checkStopping();
  tunnel?.start();
  backups?.start();
  accepting = true;
  if (groupFixture)
    console.log(
      `Groups test host: http://127.0.0.1:${listenPort}/group-fixture#fixture=${groupFixture.token}`,
    );
  console.log(
    `sciencewithagents${fixture ? ' (stub fixture)' : demo ? ' (demo)' : ''}: http://127.0.0.1:${listenPort}`,
  );
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
