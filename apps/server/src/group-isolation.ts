import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';

// Host-only contract. Never deserialize this from a browser launch request.
export const GroupIsolationIdentity = z
  .object({
    installationId: z.string().uuid(),
    groupId: z.string().uuid(),
    memberId: z.string().uuid(),
    contextId: z.string().uuid(),
    visibility: z.enum(['shared', 'private']),
  })
  .strict();
export type GroupIsolationIdentity = z.infer<typeof GroupIsolationIdentity>;
export interface GroupIsolationGrant {
  identity: GroupIsolationIdentity;
  revision: number;
  expiresAt: number;
  workspace: string;
  readResources: string[];
  // Exact executable/dylib files, chosen by the host; no directory grants here.
  executables: string[];
  runtimeFiles: string[];
  stateBase: string;
  // Include host data (agent-client.json), personal native homes, other contexts/chats.
  // Host must supply its complete inventory; there is no ambient home discovery.
  forbiddenPaths: string[];
  broker?: { socket: string; identity: GroupIsolationIdentity; revision: number };
  requireNestedSandbox: boolean;
  // Auth-only route: one native process, no tool/child launches. These are host
  // dependencies, never browser-selected paths/ports or a production fallback.
  authentication?: { socket: string; proxyPort: number };
}
export class GroupIsolationBlocked extends Error {
  readonly code = 'GROUP_ISOLATION_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'GroupIsolationBlocked';
  }
}
/** Same metadata guards for host-selected Linux bind mounts. No file contents
 * are read. Native homes and control/data paths stay outside every guest mount. */
export function groupResourceMounts(
  workspace: string | null,
  reads: readonly string[],
  state: string,
  forbiddenPaths: readonly string[],
) {
  if (!forbiddenPaths.length)
    throw new GroupIsolationBlocked('Host private-resource inventory required.');
  const input = workspace ? bindPath(workspace, 'directory') : null;
  const readInputs = reads.map((path) => bindPath(path));
  const resources = [...(input ? [input] : []), ...readInputs];
  const privatePaths = [...forbiddenPaths, state].map((path) => bindPath(path));
  const broad = [
    '/',
    '/Users',
    homedir(),
    userInfo().homedir,
    '/Applications',
    '/Library',
    '/System',
    '/private',
    '/private/var',
    '/private/tmp',
    '/tmp',
    '/Volumes',
    '/usr',
    '/opt',
    '/dev',
    join(userInfo().homedir, 'Library'),
  ].flatMap((path) => {
    try {
      return [realpathSync.native(path)];
    } catch {
      return [];
    }
  });
  if (
    resources.some(
      (r) =>
        privatePaths.some((p) => overlap(r.canonical, p.canonical)) ||
        broad.some((p) => within(p, r.canonical)),
    ) ||
    (input && readInputs.some((r) => overlap(r.canonical, input.canonical)))
  )
    throw new GroupIsolationBlocked(
      'Mount overlaps private, broad ambient or another writable resource.',
    );
  for (const resource of resources)
    inspectTree(
      resource.canonical,
      resources.map((r) => r.canonical),
    );
  const stateStat = lstatSync(state);
  if (
    stateStat.isSymbolicLink() ||
    !stateStat.isDirectory() ||
    stateStat.uid !== process.getuid!() ||
    stateStat.mode & 0o077
  )
    throw new GroupIsolationBlocked('Private host container state required.');
  return {
    workspace: input?.canonical ?? null,
    reads: readInputs.map((r) => r.canonical),
    check: () => {
      for (const bound of [...resources, ...privatePaths]) unchanged(bound);
    },
  };
}
const blocked = (message: string): never => {
  throw new GroupIsolationBlocked(message);
};
const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
const overlap = (a: string, b: string) => within(a, b) || within(b, a);
const quote = (value: string) => JSON.stringify(value);
const literal = (path: string) => `(literal ${quote(path)})`;
const subtree = (path: string) => `(subpath ${quote(path)})`;
const identityKey = (identity: GroupIsolationIdentity) =>
  JSON.stringify(GroupIsolationIdentity.parse(identity));

interface BoundPath {
  original: string;
  canonical: string;
  dev: number;
  ino: number;
}
function bindPath(path: string, kind?: 'directory' | 'file' | 'socket'): BoundPath {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path))
    blocked('An absolute, printable host path is required.');
  // Native resolution returns filesystem casing/Unicode spelling on the supported Mac.
  // Do not fold case or normalize Unicode independently of filesystem resolution.
  const canonical = realpathSync.native(path);
  const stat = lstatSync(canonical);
  if (
    (kind === 'directory' && !stat.isDirectory()) ||
    (kind === 'file' && !stat.isFile()) ||
    (kind === 'socket' && !stat.isSocket())
  )
    blocked(`Wrong resource type: ${path}`);
  return { original: path, canonical, dev: stat.dev, ino: stat.ino };
}
function unchanged(bound: BoundPath) {
  const now = bindPath(bound.original);
  if (now.canonical !== bound.canonical || now.dev !== bound.dev || now.ino !== bound.ino)
    blocked('A granted path changed identity; request a new grant.');
}
// Metadata-only inspection: never reads file contents, including native credentials.
function inspectTree(path: string, readable: string[], limit = { remaining: 20_000 }) {
  if (--limit.remaining < 0)
    blocked('Resource inventory exceeds bounded admission; use a smaller snapshot.');
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    const target = realpathSync.native(path);
    if (!readable.some((root) => within(target, root)))
      blocked('A resource symlink leaves the approved roots.');
  } else if (stat.isFile() && stat.nlink > 1) {
    blocked('Hard-linked resources require an independent snapshot.');
  } else if (stat.isDirectory()) {
    for (const name of readdirSync(path)) inspectTree(join(path, name), readable, limit);
  } else if (!stat.isFile())
    blocked('Resources must contain only regular files, directories and in-scope symlinks.');
}

export interface CanaryResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}
export interface IsolationCompatibility {
  platform: string;
  architecture: string;
  sandbox: '/usr/bin/sandbox-exec';
  shell: true;
  nestedSandbox: 'passed' | 'not-requested';
  // This result never admits a real provider, authentication, MCP or browser integration.
  providerIntegration: 'unverified';
}

/** One-shot, bounded canary boundary, deliberately unconnected to native provider adapters. */
export class GroupIsolation {
  readonly identity: Readonly<GroupIsolationIdentity>;
  readonly revision: number;
  readonly home: string;
  readonly temp: string;
  readonly scratch: string;
  readonly manifestDigest: string;
  private readonly bindings: BoundPath[];
  private readonly executables: string[];
  private readonly profile: string;
  private readonly workspace: string;
  private readonly context: BoundPath;
  private readonly expiresAt: number;
  private readonly requireNested: boolean;
  private readonly active = new Set<() => void>();
  private closed = false;
  private readonly authentication?: GroupIsolationGrant['authentication'];

  private constructor(
    grant: GroupIsolationGrant,
    bindings: BoundPath[],
    context: BoundPath,
    resources: BoundPath[],
    executables: BoundPath[],
    runtime: BoundPath[],
    forbidden: BoundPath[],
    broker?: BoundPath,
  ) {
    this.identity = Object.freeze(GroupIsolationIdentity.parse(grant.identity));
    this.revision = grant.revision;
    this.expiresAt = grant.expiresAt;
    this.requireNested = grant.requireNestedSandbox;
    this.authentication = grant.authentication;
    this.bindings = [...bindings, context];
    this.context = context;
    this.workspace = resources[0]!.canonical;
    this.executables = executables.map((entry) => entry.canonical);
    this.home = join(context.canonical, 'native-home');
    this.temp = join(context.canonical, 'temp');
    this.scratch = join(context.canonical, 'scratch');
    for (const path of [this.home, this.temp, this.scratch]) {
      mkdirSync(path, { mode: 0o700 });
      this.bindings.push(bindPath(path, 'directory'));
    }
    const read = [
      this.workspace,
      ...resources.slice(1).map((entry) => entry.canonical),
      this.home,
      this.temp,
      this.scratch,
    ];
    const writable = [
      ...(this.identity.visibility === 'shared' ? [this.workspace] : []),
      this.home,
      this.temp,
      this.scratch,
    ];
    const files = [
      ...this.executables,
      ...executables.map((entry) => entry.original),
      ...runtime.flatMap((entry) => [entry.canonical, entry.original]),
      '/bin/sh',
      '/bin/bash',
      '/private/var/select/sh',
      '/usr/bin/sandbox-exec',
      '/',
      '/dev/null',
      '/dev/random',
      '/dev/urandom',
    ];
    // dyld probes versioned aliases in library directories. Grant only names
    // resolving to an already approved file, never a sibling metadata subtree.
    const runtimeMetadata = new Set<string>();
    const runtimeRoots = [...executables, ...runtime];
    const runtimeCanonical = new Set(runtimeRoots.map((file) => file.canonical));
    const runtimeDirs = new Set(
      runtimeRoots.flatMap((file) => [dirname(file.canonical), dirname(file.original)]),
    );
    let metadataEntries = 0;
    for (const dir of runtimeDirs) {
      runtimeMetadata.add(dir);
      for (const name of readdirSync(dir)) {
        if (++metadataEntries > 20_000)
          blocked('Runtime metadata inventory exceeds bounded admission.');
        const candidate = join(dir, name);
        try {
          if (runtimeCanonical.has(realpathSync.native(candidate))) runtimeMetadata.add(candidate);
        } catch {
          /* Unresolvable sibling receives no allowance. */
        }
      }
    }
    this.profile = [
      '(version 1)',
      '(deny default)',
      grant.authentication ? '(deny process-fork)' : '(allow process-fork)',
      `(allow process-exec ${[...this.executables, '/bin/sh', '/bin/bash', '/usr/bin/sandbox-exec'].map(literal).join(' ')})`,
      '(allow signal (target self))',
      // Numeric KERN_PROCARGS2 bypasses named sysctl filters on the tested Mac.
      // An explicit process-info deny is required; deny-default alone is insufficient.
      '(deny process-info* (target others))',
      '(deny sysctl-read (sysctl-name-regex #"^kern\\.proc"))',
      // Never admit kern.procargs/kern.procargs2 or same-user process environment.
      '(allow sysctl-read (sysctl-name-regex #"^hw\\.") (sysctl-name "vm.pagesize") (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osversion") (sysctl-name "kern.osproductversion") (sysctl-name "kern.argmax"))',
      `(allow file-read* ${read.map(subtree).join(' ')} ${files.map(literal).join(' ')} (subpath "/System/Library") (subpath "/usr/lib"))`,
      `(allow file-read-metadata ${[...read, ...files, ...(broker ? [broker.canonical] : [])]
        .filter((path) => path !== '/')
        .map((path) => `(path-ancestors ${quote(path)})`)
        .join(' ')})`,
      // dyld stats intermediate versioned symlink names within each granted library directory.
      `(allow file-read-metadata ${[...runtimeMetadata].map(literal).join(' ')})`,
      `(allow file-write* ${writable.map(subtree).join(' ')} (literal "/dev/null"))`,
      ...(broker
        ? [
            `(allow network-outbound ${literal(broker.canonical)})`,
            `(allow file-read* file-write-data ${literal(broker.canonical)})`,
          ]
        : []),
      ...(grant.authentication
        ? [
            `(allow network-outbound (remote tcp "localhost:${grant.authentication.proxyPort}"))`,
            `(allow network-bind network-inbound ${literal(grant.authentication.socket)})`,
            `(allow file-write-create file-write-unlink file-write-data file-read* ${literal(grant.authentication.socket)})`,
            `(allow file-read-metadata (path-ancestors ${quote(grant.authentication.socket)}))`,
            // Certificate verification, not account Keychain access/securityd.
            '(allow mach-lookup (global-name "com.apple.trustd"))',
          ]
        : []),
      // Explicit denies override system/runtime allowances and remain inherited by children.
      ...forbidden.map((path) => `(deny file-read* file-write* ${subtree(path.canonical)})`),
    ].join('\n');
    this.manifestDigest = createHash('sha256')
      .update(
        JSON.stringify({
          identity: this.identity,
          revision: this.revision,
          expiresAt: this.expiresAt,
          bindings: this.bindings,
          profile: this.profile,
        }),
      )
      .digest('hex');
  }

  static prepare(grant: GroupIsolationGrant): GroupIsolation {
    let created: string | undefined;
    try {
      if (process.platform !== 'darwin' || process.arch !== 'arm64')
        blocked('Only the verified Apple Silicon macOS target is admitted.');
      GroupIsolationIdentity.parse(grant.identity);
      if (
        !Number.isSafeInteger(grant.revision) ||
        grant.revision < 1 ||
        !Number.isFinite(grant.expiresAt) ||
        grant.expiresAt <= Date.now()
      )
        blocked('A current, expiring resource grant is required.');
      if (!grant.forbiddenPaths.length) blocked('Host private-resource inventory is required.');
      bindPath('/usr/bin/sandbox-exec', 'file');
      const resources = [
        bindPath(grant.workspace, 'directory'),
        ...grant.readResources.map((path) => bindPath(path)),
      ];
      const stateBase = bindPath(grant.stateBase, 'directory');
      const executables = grant.executables.map((path) => bindPath(path, 'file'));
      const runtime = grant.runtimeFiles.map((path) => bindPath(path, 'file'));
      const forbidden = grant.forbiddenPaths.map((path) => bindPath(path));
      const broker = grant.broker ? bindPath(grant.broker.socket, 'socket') : undefined;
      if (grant.authentication) {
        const { socket, proxyPort } = grant.authentication;
        if (
          !isAbsolute(socket) ||
          /[\u0000-\u001f\u007f]/u.test(socket) ||
          Buffer.byteLength(socket) >= 100 ||
          !Number.isSafeInteger(proxyPort) ||
          proxyPort < 1 ||
          proxyPort > 65535
        )
          blocked('Invalid host authentication transport.');
        const parent = bindPath(dirname(socket), 'directory');
        const stat = lstatSync(parent.canonical);
        if (
          parent.canonical !== dirname(socket) ||
          lstatSync(parent.original).isSymbolicLink() ||
          stat.uid !== process.getuid!() ||
          (stat.mode & 0o077) !== 0 ||
          [...resources, stateBase, ...forbidden].some((root) =>
            overlap(root.canonical, parent.canonical),
          )
        )
          blocked('Authentication socket requires a separate privately owned host directory.');
        try {
          lstatSync(socket);
          blocked('Authentication socket must be fresh.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        // Pin the directory below; it is never a file-content grant.
      }
      if (
        grant.broker &&
        (identityKey(grant.broker.identity) !== identityKey(grant.identity) ||
          grant.broker.revision !== grant.revision)
      )
        blocked('Broker identity/revision does not match this context.');
      if (broker) {
        const stat = lstatSync(broker.canonical);
        if (
          stat.uid !== process.getuid!() ||
          (stat.mode & 0o077) !== 0 ||
          [...resources, stateBase].some((root) => overlap(root.canonical, broker.canonical))
        )
          blocked('Broker must be privately owned and outside resource/native-state roots.');
      }
      const all = [
        ...resources,
        stateBase,
        ...executables,
        ...runtime,
        ...(broker ? [broker] : []),
        ...(grant.authentication
          ? [bindPath(dirname(grant.authentication.socket), 'directory')]
          : []),
      ];
      if (
        all
          .filter((path) => path !== stateBase)
          .some((path) => forbidden.some((deny) => overlap(path.canonical, deny.canonical))) ||
        forbidden.some((deny) => within(stateBase.canonical, deny.canonical))
      )
        blocked('A grant overlaps host-private resources.');
      if (
        resources.some((path) => overlap(path.canonical, stateBase.canonical)) ||
        resources.slice(1).some((path) => overlap(path.canonical, resources[0]!.canonical)) ||
        [...executables, ...runtime].some((path) => within(path.canonical, resources[0]!.canonical))
      )
        blocked('Mutable workspace, read grants, state and runtime must be disjoint.');
      // Reject these ambient roots and their ancestors, while allowing scoped projects
      // beneath them. This guard does not replace the host's private-resource inventory.
      const ambientRoots = [
        '/',
        '/Users',
        homedir(),
        join(homedir(), 'Library'),
        userInfo().homedir,
        join(userInfo().homedir, 'Library'),
        tmpdir(),
        '/Library',
        '/Applications',
        '/Volumes',
        '/private',
        '/private/etc',
        '/private/var',
        '/private/var/run',
        '/tmp',
        '/private/tmp',
        '/opt',
        '/opt/homebrew',
        '/System',
        '/System/Library',
        '/System/Volumes',
        '/System/Volumes/Data',
        '/usr',
        '/usr/lib',
        '/usr/bin',
        '/usr/sbin',
        '/usr/local',
        '/bin',
        '/sbin',
        '/dev',
      ].flatMap((path) => {
        try {
          return [realpathSync.native(path)];
        } catch (error) {
          // Optional roots absent on this host cannot be granted in bindPath either.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw error;
        }
      });
      if (all.some((path) => ambientRoots.some((root) => within(root, path.canonical))))
        blocked('Broad ambient roots cannot be resource grants.');
      for (const resource of resources)
        inspectTree(
          resource.canonical,
          resources.map((path) => path.canonical),
        );
      const identity = grant.identity;
      const parent = join(
        stateBase.canonical,
        identity.installationId,
        identity.groupId,
        identity.memberId,
        identity.visibility,
      );
      let ancestor = stateBase.canonical;
      // Check each existing ancestor before making the next directory, not after following a symlink.
      for (const segment of [
        identity.installationId,
        identity.groupId,
        identity.memberId,
        identity.visibility,
      ]) {
        ancestor = join(ancestor, segment);
        try {
          mkdirSync(ancestor, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const stat = lstatSync(ancestor);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          realpathSync.native(ancestor) !== ancestor ||
          stat.uid !== process.getuid!() ||
          (stat.mode & 0o022) !== 0
        )
          blocked('Native-state ancestry must be owned, non-symlink and privately writable.');
      }
      // Permanent claims survive close/restart; failed preparation burns the identity too.
      // Keep claims outside all process grants. No provider can clear this ledger.
      for (const [kind, key] of [
        ['contexts', identity.contextId],
        ...(broker
          ? [['brokers', createHash('sha256').update(broker.canonical).digest('hex')]]
          : []),
      ]) {
        const claims = join(stateBase.canonical, `.claimed-${kind}`);
        try {
          mkdirSync(claims, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const stat = lstatSync(claims);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid!() ||
          (stat.mode & 0o077) !== 0
        )
          blocked('Invalid permanent identity ledger.');
        mkdirSync(join(claims, key!), { mode: 0o700 });
      }
      const contextPath = join(parent, identity.contextId);
      mkdirSync(contextPath, { mode: 0o700 });
      created = contextPath;
      const context = bindPath(contextPath, 'directory');
      if (forbidden.some((deny) => overlap(context.canonical, deny.canonical)))
        blocked('Context overlaps host-private resources.');
      return new GroupIsolation(
        grant,
        [...all, ...forbidden],
        context,
        resources,
        executables,
        runtime,
        forbidden,
        broker,
      );
    } catch (error) {
      if (created) rmSync(created, { recursive: true, force: true });
      if (error instanceof GroupIsolationBlocked) throw error;
      return blocked(
        `Resource admission failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private validate(
    admit: (
      identity: Readonly<GroupIsolationIdentity>,
      revision: number,
      digest: string,
    ) => boolean,
  ) {
    if (
      this.closed ||
      this.expiresAt <= Date.now() ||
      !admit(this.identity, this.revision, this.manifestDigest)
    )
      blocked('Context closed, grant expired, or host admission was revoked.');
    try {
      for (const path of this.bindings) unchanged(path);
    } catch (error) {
      blocked(
        `Path revalidation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private run(
    executable: string,
    argv: readonly string[],
    timeoutMs: number,
  ): Promise<CanaryResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', this.profile, executable, ...argv], {
        cwd: this.workspace,
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // No ambient env, stdio descriptors, proxy, MCP, browser, provider config or host socket.
        env: {
          PATH: '/usr/bin:/bin',
          HOME: this.home,
          TMPDIR: this.temp,
          TMP: this.temp,
          TEMP: this.temp,
          XDG_CONFIG_HOME: this.home,
          XDG_CACHE_HOME: this.scratch,
          XDG_DATA_HOME: this.home,
          XDG_STATE_HOME: this.home,
          CODEX_HOME: join(this.home, 'codex'),
          CLAUDE_CONFIG_DIR: join(this.home, 'claude'),
          OPENSSL_CONF: '/dev/null',
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
        },
      });
      let stdout = '',
        stderr = '',
        failure: Error | undefined;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        // Kill only the detached process group created by this spawn, never global processes.
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = error as Error;
          }
        }
      };
      this.active.add(stop);
      const timer = setTimeout(() => {
        failure = new GroupIsolationBlocked('Canary deadline exceeded.');
        stop();
        // An escaped descendant may retain a pipe; it must not hold the host promise open.
        child.stdout.destroy();
        child.stderr.destroy();
      }, timeoutMs);
      const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        if (stream === 'stdout') stdout += chunk.toString();
        else stderr += chunk.toString();
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 64 * 1024) {
          failure = new GroupIsolationBlocked('Canary output limit exceeded.');
          stop();
          child.stdout.destroy();
          child.stderr.destroy();
        }
      };
      child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
      child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
      child.on('error', (error) => {
        failure = error;
      });
      // exit precedes close; clean inherited-pipe descendants immediately, not after EOF.
      child.on('exit', stop);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        stop();
        this.active.delete(stop);
        if (failure) reject(new GroupIsolationBlocked(failure.message));
        else resolveResult({ code, signal, stdout, stderr });
      });
    });
  }

  async checkCompatibility(
    admit: (
      identity: Readonly<GroupIsolationIdentity>,
      revision: number,
      digest: string,
    ) => boolean,
  ): Promise<IsolationCompatibility> {
    this.validate(admit);
    const shell = await this.run('/bin/sh', ['-c', 'printf group-sandbox-ok'], 3_000);
    if (shell.code !== 0 || shell.stdout !== 'group-sandbox-ok')
      blocked(
        `OS sandbox startup failed (${shell.code ?? shell.signal}): ${shell.stderr.slice(0, 500)}`,
      );
    if (this.requireNested) {
      this.validate(admit);
      const nested = await this.run(
        '/usr/bin/sandbox-exec',
        ['-p', '(version 1)(allow default)', '/bin/sh', '-c', 'printf nested-ok'],
        3_000,
      );
      if (nested.code !== 0 || nested.stdout !== 'nested-ok')
        blocked(
          `Nested sandbox unsupported (${nested.code ?? nested.signal}): ${nested.stderr.slice(0, 500)}`,
        );
    }
    return {
      platform: process.platform,
      architecture: process.arch,
      sandbox: '/usr/bin/sandbox-exec',
      shell: true,
      nestedSandbox: this.requireNested ? 'passed' : 'not-requested',
      providerIntegration: 'unverified',
    };
  }

  async executeCanary(
    executable: string,
    argv: readonly string[],
    admit: (
      identity: Readonly<GroupIsolationIdentity>,
      revision: number,
      digest: string,
    ) => boolean,
    timeoutMs = 3_000,
  ): Promise<CanaryResult> {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 10_000 ||
      argv.length > 256 ||
      argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
      Buffer.byteLength(argv.join('')) > 64 * 1024
    )
      blocked('Invalid bounded canary arguments.');
    const canonical = bindPath(executable, 'file').canonical;
    if (!this.executables.includes(canonical)) blocked('Executable was not approved by the host.');
    await this.checkCompatibility(admit);
    this.validate(admit);
    return this.run(canonical, argv, timeoutMs);
  }

  /** Actual native auth process, confined before exec. Fork is denied at the
   * kernel boundary, so exact-PID stop is sufficient here. This cannot run a
   * native tool turn and must never substitute for production compatibility. */
  spawnAuthentication(
    executable: string,
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
    admit: () => boolean,
  ): ChildProcess {
    this.validate(admit);
    if (!this.authentication) blocked('An auth-only transport grant is required.');
    const binary = bindPath(executable, 'file').canonical;
    if (!this.executables.includes(binary)) blocked('Native executable was not host-approved.');
    const child = spawn('/usr/bin/sandbox-exec', ['-p', this.profile, binary, ...argv], {
      cwd: this.workspace,
      detached: true,
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
      env,
    });
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    this.active.add(stop);
    const watch = setInterval(() => {
      try {
        this.validate(admit);
      } catch {
        stop();
      }
    }, 100);
    const lifetime = setTimeout(stop, Math.max(1, this.expiresAt - Date.now()));
    const release = () => {
      clearInterval(watch);
      clearTimeout(lifetime);
      this.active.delete(stop);
    };
    child.once('exit', release);
    child.once('error', release);
    return child;
  }

  environment(): Readonly<NodeJS.ProcessEnv> {
    return Object.freeze({
      PATH: '/usr/bin:/bin',
      HOME: this.home,
      TMPDIR: this.temp,
      TMP: this.temp,
      TEMP: this.temp,
      XDG_CONFIG_HOME: this.home,
      XDG_CACHE_HOME: this.scratch,
      XDG_DATA_HOME: this.home,
      XDG_STATE_HOME: this.home,
      CODEX_HOME: join(this.home, 'codex'),
      CLAUDE_CONFIG_DIR: join(this.home, 'claude'),
      OPENSSL_CONF: '/dev/null',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    });
  }

  close() {
    this.closed = true;
    for (const stop of this.active) stop();
    // The caller awaits every canary before deleting its state.
    if (this.active.size) blocked('Await running canaries before releasing state.');
    unchanged(this.context);
    rmSync(this.context.canonical, { recursive: true, force: true });
  }
}

/** Broker implementations must authenticate the connection separately; socket reachability is not identity. */
export function authorizeGroupBroker(
  bound: { identity: GroupIsolationIdentity; revision: number },
  request: { identity: GroupIsolationIdentity; revision: number; operation: string },
  isCurrentMember: (identity: GroupIsolationIdentity, revision: number) => boolean,
): boolean {
  try {
    const identity = GroupIsolationIdentity.parse(request.identity);
    return (
      identityKey(bound.identity) === identityKey(identity) &&
      bound.revision === request.revision &&
      isCurrentMember(identity, request.revision) &&
      (identity.visibility === 'private'
        ? ['read-shared', 'read-own-private']
        : ['read-shared', 'propose-shared']
      ).includes(request.operation)
    );
  } catch {
    return false;
  }
}
