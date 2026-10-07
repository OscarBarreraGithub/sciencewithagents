import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  existsSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { WebSocketServer } from 'ws';
import type { Readable } from 'node:stream';
import { GroupIsolationBlocked, type GroupIsolationIdentity } from './group-isolation.js';
import { publicIPv4 } from './group-network.js';

const id = z.string().regex(/^[a-f0-9]{64}$/);
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const label = 'io.sciencewithagents.group-context';
const runtimeLabel = 'io.sciencewithagents.group-runtime-schema';
const imageDirectory = fileURLToPath(new URL('../../../runtime/group-native/', import.meta.url));
const publicImageFiles = [
  'Dockerfile',
  '.dockerignore',
  'init.mjs',
  'rpc-relay.mjs',
  'connect.mjs',
  'claude-stream.mjs',
  'chromium',
  'canary.py',
  'group-documents.py',
  'seccomp.default.json',
  'LICENSE.seccomp',
];
export class GroupNamespaceStopUnverified extends GroupIsolationBlocked {
  constructor() {
    super(
      'Owned PID namespace stop could not be verified. Retain QUARK admission; no provider fallback or automatic retry.',
    );
  }
}
/** Upstream Moby default stays deny-by-default. The only expansion permits
 * nested native user/mount namespaces inside our private PID/mount/network
 * boundary; not seccomp=unconfined or host CAP_SYS_ADMIN. */
export function groupContainerSeccomp() {
  const bytes = readFileSync(join(imageDirectory, 'seccomp.default.json'));
  if (
    createHash('sha256').update(bytes).digest('hex') !==
    '6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6'
  )
    throw new GroupIsolationBlocked('Reviewed upstream syscall baseline changed.');
  const profile = JSON.parse(bytes.toString()) as {
    defaultAction: string;
    syscalls: Array<{ names: string[]; [key: string]: unknown }>;
  };
  const nested = [
    'clone',
    'clone3',
    'unshare',
    'setns',
    'mount',
    'mount_setattr',
    'umount',
    'umount2',
    'pivot_root',
    'chroot',
  ];
  if (profile.defaultAction !== 'SCMP_ACT_ERRNO')
    throw new GroupIsolationBlocked('Deny-default syscall baseline required.');
  profile.syscalls = profile.syscalls
    .map((rule) => ({ ...rule, names: rule.names.filter((name) => !nested.includes(name)) }))
    .filter((rule) => rule.names.length);
  profile.syscalls.push({ names: nested, action: 'SCMP_ACT_ALLOW' });
  return JSON.stringify(profile);
}
export function groupContainerSourceDigest() {
  const hash = createHash('sha256');
  for (const name of publicImageFiles)
    hash
      .update(name + '\0')
      .update(readFileSync(join(imageDirectory, name)))
      .update('\0');
  return hash.digest('hex');
}
export const groupEngineSockets = [
  '/var/run/docker.sock',
  join(userInfo().homedir, '.docker/run/docker.sock'),
] as const;
/** Reviewable build instruction only. Never builds/pulls/starts a runtime here.
 * Exactly this public directory is the build context, with a default-deny ignore
 * whitelist. Docker gets a NEW config/home; no host credential helpers/config. */
export function groupContainerBuildRecipe(config: string, socket: string) {
  const stat = lstatSync(config);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid!() ||
    stat.mode & 0o077 ||
    readdirSync(config).length ||
    !groupEngineSockets.includes(socket as (typeof groupEngineSockets)[number])
  )
    throw new GroupIsolationBlocked(
      'Fresh private build configuration and a fixed local Engine socket required.',
    );
  const digest = groupContainerSourceDigest(),
    tag = `sciencewithagents/group-native:${digest}`;
  return {
    executable: '/usr/local/bin/docker',
    args: [
      '--host',
      `unix://${socket}`,
      '--config',
      config,
      'build',
      '--platform',
      'linux/arm64',
      '--build-arg',
      `SOURCE_DIGEST=${digest}`,
      '--tag',
      tag,
      imageDirectory,
    ],
    environment: { PATH: '/usr/bin:/bin', HOME: config, DOCKER_CONFIG: config },
    tag,
    sourceDigest: digest,
  };
}
export interface GroupNetworkResource {
  host: string;
  ports: readonly number[];
}
export interface GroupContainerPlan {
  readonly context: Readonly<GroupIsolationIdentity>;
  readonly image: string;
  readonly workspace: string | null;
  readonly reads: readonly string[];
  readonly expiresAt: number;
  readonly cpuCores: number;
  readonly memoryMb: number;
  readonly outbound: readonly GroupNetworkResource[];
}
const inspection = z.object({
  Id: id,
  Config: z.object({
    Labels: z.record(z.string(), z.string()),
    OpenStdin: z.literal(true),
    StdinOnce: z.literal(true),
    Tty: z.literal(false),
  }),
  HostConfig: z.object({
    NetworkMode: z.literal('none'),
    PidMode: z.literal(''),
    IpcMode: z.literal('private'),
    Privileged: z.literal(false),
    ReadonlyRootfs: z.literal(true),
    RestartPolicy: z.object({ Name: z.literal('no') }),
  }),
  State: z.object({
    Running: z.boolean(),
    Status: z.string(),
    Pid: z.number().int().nonnegative().optional(),
  }),
});
export function assertGroupContainerInspection(
  raw: unknown,
  plan: GroupContainerPlan,
  volume: string,
) {
  const value = inspection.parse(raw);
  const details = z
    .object({
      Config: z.object({
        Image: z.literal(plan.image),
        User: z.literal('0:0'),
        Entrypoint: z.array(z.string()),
        Cmd: z.array(z.string()),
        WorkingDir: z.literal('/'),
      }),
      HostConfig: z.object({
        UTSMode: z.literal(''),
        CapDrop: z.array(z.string()),
        CapAdd: z.array(z.string()),
        SecurityOpt: z.array(z.string()),
        NanoCpus: z.number(),
        Memory: z.number(),
        Tmpfs: z.record(z.string(), z.string()),
        PortBindings: z.record(z.string(), z.unknown()).nullable(),
        LogConfig: z.object({ Type: z.literal('none') }),
        Devices: z.array(z.unknown()).nullable(),
        DeviceRequests: z.array(z.unknown()).nullable(),
      }),
      Mounts: z.array(
        z.object({
          Type: z.string(),
          Source: z.string().optional(),
          Destination: z.string(),
          RW: z.boolean().optional(),
          Name: z.string().optional(),
          Driver: z.string().optional(),
        }),
      ),
    })
    .parse(raw);
  const expected = groupContainerSpec(plan, volume, {}, true);
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.entries(input)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [key, canonical(value)]),
          )
        : input;
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  const host = details.HostConfig;
  if (
    !same(details.Config.Entrypoint, expected.Entrypoint) ||
    !same(details.Config.Cmd, expected.Cmd) ||
    !same(host.CapDrop, ['ALL']) ||
    !same(host.CapAdd, ['CHOWN']) ||
    !same(host.SecurityOpt, expected.HostConfig.SecurityOpt) ||
    host.NanoCpus !== expected.HostConfig.NanoCpus ||
    host.Memory !== expected.HostConfig.Memory ||
    !same(host.Tmpfs, expected.HostConfig.Tmpfs) ||
    Object.keys(host.PortBindings ?? {}).length ||
    host.Devices?.length ||
    host.DeviceRequests?.length
  )
    throw new GroupIsolationBlocked('Runtime capability/resource/entrypoint isolation changed.');
  const mounts = details.Mounts.filter((mount) => mount.Type !== 'tmpfs');
  if (
    details.Mounts.some(
      (mount) => mount.Type === 'tmpfs' && !['/tmp', '/run'].includes(mount.Destination),
    ) ||
    mounts.length !== expected.HostConfig.Mounts.length ||
    expected.HostConfig.Mounts.some((grant) => {
      const mount = mounts.find((entry) => entry.Destination === grant.Target);
      return (
        !mount ||
        mount.Type !== grant.Type ||
        (grant.Type === 'bind'
          ? mount.Source !== grant.Source || mount.RW !== !grant.ReadOnly
          : mount.Name !== volume || mount.Driver !== 'local' || mount.RW !== true)
      );
    })
  )
    throw new GroupIsolationBlocked('Guest mounts differ from the exact host grant.');
  return value;
}

/** Fixed local Engine socket only, scrubbed Docker CLI config. No context lookup,
 * credential-helper invocation, image pull, Desktop start or external Docker API.
 * No method of this class is exposed to browsers or native group tools. */
export class GroupDockerEngine {
  #version: string | undefined;
  #owned = new Map<string, { plan: GroupContainerPlan; volume: string }>();
  readonly socket: string;
  constructor(
    socket?: string,
    readonly binary = '/usr/local/bin/docker',
  ) {
    this.socket =
      socket ?? (existsSync(groupEngineSockets[1]) ? groupEngineSockets[1] : groupEngineSockets[0]);
    if (
      !groupEngineSockets.includes(this.socket as (typeof groupEngineSockets)[number]) ||
      binary !== '/usr/local/bin/docker'
    )
      throw new GroupIsolationBlocked('Only the inspected local Docker installation is supported.');
  }
  async #json(method: string, path: string, body?: unknown): Promise<unknown> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socket,
          method,
          path,
          headers: data
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
            : {},
          timeout: 10_000,
        },
        (response) => {
          let text = '';
          response.on('data', (chunk: Buffer) => {
            text += chunk.toString();
            if (Buffer.byteLength(text) > 2 * 1024 * 1024) req.destroy();
          });
          response.on('end', () => {
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(
                new GroupIsolationBlocked(
                  `Local container operation unavailable (${response.statusCode ?? 0}). No diagnostics exported.`,
                ),
              );
              return;
            }
            try {
              resolve(text ? JSON.parse(text) : null);
            } catch {
              reject(new GroupIsolationBlocked('Invalid local container response.'));
            }
          });
          response.on('error', () =>
            reject(new GroupIsolationBlocked('Local container response failed.')),
          );
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () =>
        reject(
          new GroupIsolationBlocked(
            'The inspected Docker Engine is unavailable. Start the existing runtime only after owner approval.',
          ),
        ),
      );
      req.end(data);
    });
  }
  async availability(image: string) {
    imageId.parse(image);
    try {
      const version = z
        .object({ ApiVersion: z.string().regex(/^1\.\d{2}$/), Version: z.string().min(1) })
        .parse(await this.#json('GET', '/version'));
      this.#version = `/v${version.ApiVersion}`;
      const info = z
        .object({
          OSType: z.literal('linux'),
          Architecture: z.enum(['aarch64', 'arm64']),
          KernelVersion: z.string().min(1),
          NCPU: z.number().positive(),
          MemTotal: z.number().positive(),
        })
        .parse(await this.#json('GET', `${this.#version}/info`));
      const artifact = z
        .object({ Id: imageId, Config: z.object({ Labels: z.record(z.string(), z.string()) }) })
        .parse(await this.#json('GET', `${this.#version}/images/${image}/json`));
      if (
        artifact.Id !== image ||
        artifact.Config.Labels[runtimeLabel] !== '1' ||
        artifact.Config.Labels['io.sciencewithagents.group-source'] !== groupContainerSourceDigest()
      )
        throw new GroupIsolationBlocked('The reviewed local image does not match this source.');
      return {
        state: 'ready' as const,
        runtimeSignature: createHash('sha256')
          .update(
            JSON.stringify({
              api: version.ApiVersion,
              engine: version.Version,
              kernel: info.KernelVersion,
              architecture: info.Architecture,
            }),
          )
          .digest('hex'),
        cpuCores: info.NCPU,
        memoryMb: Math.floor(info.MemTotal / 1048576),
        nativeDesktop: 'Linux guest only; macOS native app control is unavailable' as const,
      };
    } catch (error) {
      return {
        state: 'unavailable' as const,
        reason:
          error instanceof GroupIsolationBlocked
            ? error.message
            : 'Reviewed Linux runtime/image validation failed.',
      };
    }
  }
  async create(plan: GroupContainerPlan, volume: string, name: string, retained = false) {
    if ((await this.availability(plan.image)).state !== 'ready')
      throw new GroupIsolationBlocked(
        'Reviewed local runtime/image is unavailable. No pull/start fallback.',
      );
    const labels = { [label]: plan.context.contextId, [runtimeLabel]: '1' };
    if (retained) {
      const saved = z
        .object({
          Name: z.literal(volume),
          Driver: z.literal('local'),
          Options: z.null(),
          Labels: z.record(z.string(), z.string()),
        })
        .parse(await this.#json('GET', `${this.#version}/volumes/${volume}`));
      if (saved.Labels[label] !== plan.context.contextId || saved.Labels[runtimeLabel] !== '1')
        throw new GroupIsolationBlocked(
          'Exact context-owned guest volume required; no auth import or foreign volume adoption.',
        );
    } else {
      // Docker volumes/create adopts existing names: exclude that behavior even
      // though the generated names have high entropy.
      let exists = true;
      try {
        await this.#json('GET', `${this.#version}/volumes/${volume}`);
      } catch (error) {
        if (!(error instanceof GroupIsolationBlocked) || !error.message.includes('404'))
          throw error;
        exists = false;
        await this.#json('POST', `${this.#version}/volumes/create`, {
          Name: volume,
          Labels: labels,
        });
      }
      if (exists)
        throw new GroupIsolationBlocked('Fresh guest volume name is already used; no adoption.');
    }
    const body = groupContainerSpec(plan, volume, labels);
    const container = z
      .object({ Id: id })
      .parse(
        await this.#json(
          'POST',
          `${this.#version}/containers/create?name=${encodeURIComponent(name)}`,
          body,
        ),
      ).Id;
    this.#owned.set(container, { plan, volume });
    return container;
  }
  async inspect(container: string, context: string) {
    id.parse(container);
    const owned = this.#owned.get(container);
    if (!owned || owned.plan.context.contextId !== context)
      throw new GroupIsolationBlocked('Saved exact container ownership required.');
    const result = assertGroupContainerInspection(
      await this.#json('GET', `${this.#version}/containers/${container}/json`),
      owned.plan,
      owned.volume,
    );
    if (
      result.Id !== container ||
      result.Config.Labels[label] !== context ||
      result.Config.Labels[runtimeLabel] !== '1'
    )
      throw new GroupIsolationBlocked(
        'Container ownership or isolation changed. No unrelated container action.',
      );
    return result;
  }
  /** Local journal manifest only. Inspect exact old namespace before retiring
   * it; a missing owned ID is already stopped, never select by name or PID. */
  async retire(container: string, plan: GroupContainerPlan, volume: string) {
    id.parse(container);
    this.#owned.set(container, { plan, volume });
    try {
      await this.inspect(container, plan.context.contextId);
    } catch (error) {
      if (error instanceof GroupIsolationBlocked && error.message.includes('(404)')) {
        this.#owned.delete(container);
        return;
      }
      throw new GroupNamespaceStopUnverified();
    }
    await this.stop(container, plan.context.contextId);
  }
  /** Recover ambiguous create-before-ID acknowledgement using only the exact
   * permanently reserved generated name, with full manifest inspection first. */
  async retireReservation(name: string, plan: GroupContainerPlan, volume: string) {
    z.string()
      .regex(/^swa-group-[a-f0-9-]{36}$/)
      .parse(name);
    let raw: unknown;
    try {
      raw = await this.#json('GET', `${this.#version}/containers/${name}/json`);
    } catch (error) {
      if (error instanceof GroupIsolationBlocked && error.message.includes('(404)')) return;
      throw new GroupNamespaceStopUnverified();
    }
    let observed: ReturnType<typeof assertGroupContainerInspection>;
    try {
      observed = assertGroupContainerInspection(raw, plan, volume);
      if (
        observed.Config.Labels[label] !== plan.context.contextId ||
        observed.Config.Labels[runtimeLabel] !== '1'
      )
        throw new GroupIsolationBlocked('Reserved namespace ownership changed.');
    } catch {
      throw new GroupNamespaceStopUnverified();
    }
    await this.retire(observed.Id, plan, volume);
  }
  attach(container: string, config: string): ChildProcess {
    id.parse(container);
    return this.execHost(['start', '--attach', '--interactive', container], config);
  }
  exec(
    container: string,
    argv: readonly string[],
    config: string,
    input = true,
    workspace = '/workspace',
  ): ChildProcess {
    id.parse(container);
    if (
      workspace !== '/workspace' &&
      !/^\/workspace\/tasks\/[a-f0-9-]{36}$/.test(workspace) &&
      !/^\/tmp\/group-synthesis\/[a-f0-9-]{36}$/.test(workspace)
    )
      throw new GroupIsolationBlocked('Host-issued task workspace required.');
    return this.execHost(
      [
        'exec',
        ...(input ? ['--interactive'] : []),
        '--user',
        '1000:1000',
        '--workdir',
        workspace,
        container,
        ...argv,
      ],
      config,
    );
  }
  private execHost(argv: readonly string[], config: string) {
    return spawn(this.binary, ['--host', `unix://${this.socket}`, '--config', config, ...argv], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: config, DOCKER_CONFIG: config },
      detached: false,
    });
  }
  async stop(container: string, context: string) {
    const before = await this.inspect(container, context);
    if (before.State.Running) {
      try {
        await this.#json('POST', `${this.#version}/containers/${container}/kill?signal=KILL`);
      } catch (error) {
        // PID1 may honor the private stop/EOF between inspection and kill.
        // A failed kill never proves closure: reconcile the exact owned scope.
        const reconciled = await this.inspect(container, context);
        if (
          reconciled.State.Running ||
          reconciled.State.Status !== 'exited' ||
          reconciled.State.Pid !== 0
        )
          throw error;
      }
    }
    const after = await this.inspect(container, context);
    if (after.State.Running)
      throw new GroupIsolationBlocked(
        'Namespace stop is not verified; retain the owning reservation.',
      );
    await this.#json('DELETE', `${this.#version}/containers/${container}?force=false&v=false`);
    this.#owned.delete(container);
    // No volume removal, credential export, logs, or unrelated-container cleanup.
  }
}

/** Reviewable exact spec: no host home/control/agent sockets, no Docker socket,
 * no host namespaces, no published ports, no native capability flag disabling.
 * Resource limits come from the admitted Pulsar lease, not a new usage ceiling. */
export function groupContainerSpec(
  plan: GroupContainerPlan,
  volume: string,
  labels: Record<string, string>,
  expiredForInspection = false,
) {
  imageId.parse(plan.image);
  if (
    !Number.isFinite(plan.expiresAt) ||
    (!expiredForInspection && plan.expiresAt <= Date.now()) ||
    !Number.isFinite(plan.cpuCores) ||
    plan.cpuCores <= 0 ||
    !Number.isFinite(plan.memoryMb) ||
    plan.memoryMb <= 0 ||
    !/^swa-group-[a-f0-9-]{36}$/.test(volume)
  )
    throw new GroupIsolationBlocked('Current admitted container resources required.');
  return {
    Image: plan.image,
    User: '0:0',
    Entrypoint: ['node', '/opt/dock/init.mjs'],
    Cmd: [String(plan.expiresAt)],
    WorkingDir: '/',
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Labels: labels,
    HostConfig: {
      NetworkMode: 'none',
      PidMode: '',
      IpcMode: 'private',
      UTSMode: '',
      Privileged: false,
      ReadonlyRootfs: true,
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'none', Config: {} },
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN'],
      SecurityOpt: ['no-new-privileges:true', `seccomp=${groupContainerSeccomp()}`],
      NanoCpus: Math.ceil(plan.cpuCores * 1e9),
      Memory: Math.ceil(plan.memoryMb * 1048576),
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,mode=1777', '/run': 'rw,nosuid,nodev,mode=755' },
      Mounts: [
        // Host input is always read-only. Native Git control files/hooks and
        // edits live in the owned guest volume, never executed later by host Git.
        ...(plan.workspace
          ? [
              {
                Type: 'bind',
                Source: plan.workspace,
                Target: '/resources/workspace',
                ReadOnly: true,
              },
            ]
          : []),
        ...plan.reads.map((source, index) => ({
          Type: 'bind',
          Source: source,
          Target: `/resources/${index}`,
          ReadOnly: true,
        })),
        { Type: 'volume', Source: volume, Target: '/home/agent', VolumeOptions: { NoCopy: true } },
      ],
    },
  };
}

const networkFrame = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('ready'),
    pid: z.literal(1),
    uid: z.literal(0),
    network: z.literal('none'),
  }),
  z.strictObject({
    type: z.literal('open'),
    id: z.uuid(),
    host: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
    port: z.number().int().min(1).max(65535),
  }),
  z.strictObject({
    type: z.literal('data'),
    id: z.uuid(),
    data: z
      .string()
      .max(87384)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }),
  z.strictObject({ type: z.literal('end'), id: z.uuid() }),
]);
/** Bound an unfinished line before readline can accumulate an unbounded frame. */
export function boundGroupLines(stream: Readable, limit: number, stop: () => void) {
  let length = 0,
    failed = false;
  stream.on('data', (chunk: Buffer) => {
    for (const byte of chunk) {
      length = byte === 10 ? 0 : length + 1;
      if (length > limit && !failed) {
        failed = true;
        stream.destroy();
        stop();
        break;
      }
    }
  });
}

/** Owning container lifetime + group-scoped network relay. Neither shell commands
 * nor authentication bodies are interpreted/rebuilt. Native TLS is end-to-end.
 * The provider/tools have no host network; approved native HTTPS/SSH/browser
 * traffic passes a loopback guest proxy and this exact DNS/port grant. */
export class GroupContainer {
  readonly volume: string;
  readonly name = `swa-group-${randomUUID()}`;
  #id: string | undefined;
  #lifetime: ChildProcess | undefined;
  #peers = new Map<string, Socket>();
  #opening = new Set<string>();
  #children = new Set<ChildProcess>();
  #closing: Promise<void> | undefined;
  #watch: NodeJS.Timeout | undefined;
  #crashCanary = false;
  #rpcServer: ReturnType<typeof createServer> | undefined;
  #webSockets: WebSocketServer | undefined;
  #socketDirectory: string | undefined;
  #resolveClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });
  readonly config: string;
  constructor(
    readonly engine: GroupDockerEngine,
    readonly plan: GroupContainerPlan,
    private readonly admitted: () => void,
    readonly hostState: string,
    private readonly record: (kind: string, detail: Record<string, string>) => void,
    private readonly retainedVolume?: string,
  ) {
    this.volume = retainedVolume
      ? z
          .string()
          .regex(/^swa-group-[a-f0-9-]{36}$/)
          .parse(retainedVolume)
      : `swa-group-${randomUUID()}`;
    this.config = join(hostState, 'docker-config');
    mkdirSync(this.config, { mode: 0o700 });
  }
  get id() {
    if (!this.#id) throw new GroupIsolationBlocked('Owned container is not prepared.');
    return this.#id;
  }
  #current() {
    try {
      this.admitted();
      return !this.#closing && Date.now() < this.plan.expiresAt;
    } catch {
      return false;
    }
  }
  #send(frame: unknown) {
    const input = this.#lifetime?.stdin;
    if (input && input.writableLength > 16 * 1024 * 1024) {
      void this.close().catch(() => {});
      return;
    }
    input?.write(JSON.stringify(frame) + '\n');
  }
  async start() {
    this.admitted();
    this.record('container-reserved', {
      volume: this.volume,
      name: this.name,
      manifest: JSON.stringify(this.plan),
    });
    this.#id = await this.engine.create(this.plan, this.volume, this.name, !!this.retainedVolume);
    this.record('container-created', { container: this.id, volume: this.volume });
    await this.engine.inspect(this.id, this.plan.context.contextId);
    this.admitted();
    this.#lifetime = this.engine.attach(this.id, this.config);
    this.#lifetime.stderr?.on('data', () => {}); // Never provider/runtime diagnostics.
    this.#lifetime.stdin?.on('error', () => {});
    boundGroupLines(this.#lifetime.stdout!, 100000, () => {
      void this.close().catch(() => {});
    });
    const input = createInterface({ input: this.#lifetime.stdout! });
    const ready = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new GroupIsolationBlocked('Owned guest readiness timed out.')),
        10_000,
      );
      this.#lifetime!.once('error', () => {
        clearTimeout(deadline);
        reject(new GroupIsolationBlocked('Owned guest attach failed.'));
      });
      this.#lifetime!.once('exit', () => {
        clearTimeout(deadline);
        reject(new GroupIsolationBlocked('Owned guest exited before readiness.'));
      });
      input.on('line', (line) => {
        let value: unknown;
        try {
          value = line.length <= 100000 ? JSON.parse(line) : null;
        } catch {
          value = null;
        }
        const parsed = networkFrame.safeParse(value);
        if (!parsed.success) {
          clearTimeout(deadline);
          reject(new GroupIsolationBlocked('Invalid owned guest protocol.'));
          void this.close().catch(() => {});
          return;
        }
        const frame = parsed.data;
        if (frame.type === 'ready') {
          clearTimeout(deadline);
          resolve();
        } else if (frame.type === 'open') void this.#open(frame.id, frame.host, frame.port);
        else if (frame.type === 'data') {
          const peer = this.#peers.get(frame.id);
          if (peer && peer.writableLength > 16 * 1024 * 1024) {
            void this.close().catch(() => {});
            return;
          }
          peer?.write(Buffer.from(frame.data, 'base64'));
        } else this.#peers.get(frame.id)?.destroy();
      });
    });
    await ready;
    this.#lifetime.once('exit', () => {
      if (!this.#crashCanary) void this.close().catch(() => {});
    });
    this.#watch = setInterval(() => {
      if (!this.#current()) void this.close().catch(() => {});
      else if (!this.#crashCanary) this.#send({ type: 'ping' });
    }, 100);
    const display = this.spawn([
      '/usr/bin/Xvfb',
      ':99',
      '-screen',
      '0',
      '1280x900x24',
      '-nolisten',
      'tcp',
    ]);
    display.stderr?.on('data', () => {});
    display.stdout?.on('data', () => {});
    display.once('exit', () => {
      if (!this.#crashCanary) void this.close().catch(() => {});
    });
    display.once('error', () => {
      void this.close().catch(() => {});
    });
  }
  async #open(connection: string, host: string, port: number) {
    const deny = () => this.#send({ type: 'error', id: connection });
    if (
      !this.#current() ||
      this.#peers.has(connection) ||
      this.#opening.has(connection) ||
      !this.plan.outbound.some((r) => r.host === host && r.ports.includes(port))
    ) {
      deny();
      return;
    }
    this.#opening.add(connection);
    try {
      const answers = await lookup(host, { family: 4, all: true });
      if (!this.#current() || !answers.length || answers.some((a) => !publicIPv4(a.address))) {
        deny();
        return;
      }
      const peer = connect({ host: answers[0]!.address, port });
      this.#peers.set(connection, peer);
      peer.on('error', deny);
      peer.on('close', () => {
        this.#peers.delete(connection);
        this.#send({ type: 'end', id: connection });
      });
      peer.once('connect', () => {
        if (this.#current()) this.#send({ type: 'opened', id: connection });
        else peer.destroy();
      });
      peer.on('data', (chunk) => {
        for (let i = 0; i < chunk.length; i += 65536)
          this.#send({
            type: 'data',
            id: connection,
            data: chunk.subarray(i, i + 65536).toString('base64'),
          });
        if (this.#lifetime?.stdin?.writableNeedDrain) {
          peer.pause();
          this.#lifetime.stdin.once('drain', () => peer.resume());
        }
      });
    } catch {
      deny();
    } finally {
      this.#opening.delete(connection);
    }
  }
  spawn(argv: readonly string[], workspace = '/workspace'): ChildProcess {
    this.admitted();
    if (!this.#current()) throw new GroupIsolationBlocked('Guest admission expired.');
    const child = this.engine.exec(this.id, argv, this.config, true, workspace);
    this.#children.add(child);
    child.once('exit', () => this.#children.delete(child));
    child.once('error', () => this.#children.delete(child));
    return child;
  }
  async nativeJson(argv: readonly string[]) {
    const child = this.spawn(argv);
    child.stdin?.end();
    return new Promise<unknown>((resolve, reject) => {
      let output = '',
        failed = false;
      const timer = setTimeout(() => {
        failed = true;
        void this.close().catch(() => {});
        reject(new GroupIsolationBlocked('Owned native projection timed out.'));
      }, 30_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > 65536) {
          failed = true;
          void this.close().catch(() => {});
          reject(new GroupIsolationBlocked('Owned native projection exceeded its bound.'));
        }
      });
      child.stderr?.on('data', () => {});
      child.once('error', () => {
        clearTimeout(timer);
        reject(new GroupIsolationBlocked('Owned native command failed.'));
      });
      child.once('close', () => {
        clearTimeout(timer);
        if (failed) return;
        try {
          this.admitted();
          resolve(JSON.parse(output));
        } catch {
          reject(
            new GroupIsolationBlocked(
              'Owned native projection unavailable. No diagnostics exported.',
            ),
          );
        }
      });
    });
  }
  async openCodexSocket() {
    this.admitted();
    this.#socketDirectory = join(realpathSync.native('/tmp'), `swa-group-rpc-${randomUUID()}`);
    mkdirSync(this.#socketDirectory, { mode: 0o700 });
    const socket = join(this.#socketDirectory, 'rpc.sock');
    this.#rpcServer = createServer((_req, res) => res.writeHead(403).end());
    this.#webSockets = new WebSocketServer({
      server: this.#rpcServer,
      perMessageDeflate: false,
      maxPayload: 16 * 1024 * 1024,
    });
    this.#webSockets.on('connection', (peer) => {
      if (!this.#current()) {
        peer.close();
        return;
      }
      const relay = this.spawn(['node', '/opt/dock/rpc-relay.mjs', '/tmp/group-native.sock']);
      boundGroupLines(relay.stdout!, 16 * 1024 * 1024, () => {
        peer.close();
        void this.close().catch(() => {});
      });
      const lines = createInterface({ input: relay.stdout! });
      lines.on('line', (line) => {
        if (Buffer.byteLength(line) > 16 * 1024 * 1024 || peer.bufferedAmount > 16 * 1024 * 1024) {
          peer.close();
          return;
        }
        relay.stdout?.pause();
        peer.send(line, () => relay.stdout?.resume());
      });
      relay.stderr?.on('data', () => {});
      peer.on('message', (message) => {
        if (this.#current() && (relay.stdin?.writableLength ?? 0) <= 16 * 1024 * 1024)
          relay.stdin?.write(message.toString() + '\n');
        else peer.close();
      });
      peer.on('close', () => relay.stdin?.end());
      peer.on('error', () => relay.stdin?.end());
      relay.once('exit', () => peer.close());
      relay.once('error', () => peer.close());
    });
    await new Promise<void>((resolve, reject) => {
      this.#rpcServer!.once('error', reject);
      this.#rpcServer!.listen(socket, resolve);
    });
    chmodSync(socket, 0o600);
    return socket;
  }
  /** Root acceptance only. Drop THIS attached lifetime client and all pings,
   * discriminate guest self-stop from the later host cleanup/Engine kill. */
  async crashStopCanary() {
    this.admitted();
    if (this.#closing || this.plan.expiresAt - Date.now() < 10000 || !this.#lifetime)
      throw new GroupIsolationBlocked(
        'A live owned guest with time for crash discrimination is required.',
      );
    this.#crashCanary = true;
    this.#lifetime.kill('SIGKILL');
    let stoppedWithoutHostKill = false;
    try {
      for (let attempt = 0; attempt < 65 && !this.#closing; attempt++) {
        const current = await this.engine.inspect(this.id, this.plan.context.contextId);
        if (!current.State.Running) {
          stoppedWithoutHostKill = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      return { stoppedWithoutHostKill };
    } finally {
      await this.close();
    }
  }
  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      clearInterval(this.#watch);
      for (const peer of this.#peers.values()) peer.destroy();
      this.#send({ type: 'stop' });
      this.#lifetime?.stdin?.end();
      // Kill PID 1 through the owned Engine, not setsid groups or ancestry scans.
      // The reservation/state is retained on failure until stopped is verified.
      if (this.#id) {
        try {
          await this.engine.stop(this.id, this.plan.context.contextId);
        } catch {
          this.record('container-stop-unverified', { container: this.#id, volume: this.volume });
          throw new GroupNamespaceStopUnverified();
        }
      }
      // These are only this route's Docker client wrappers, after the guest's
      // entire namespace has stopped. Do not wait on a native CLI EOF heuristic.
      for (const child of this.#children) child.kill('SIGKILL');
      this.#lifetime?.kill('SIGKILL');
      for (const peer of this.#webSockets?.clients ?? []) peer.terminate();
      this.#webSockets?.close();
      if (this.#rpcServer)
        await new Promise<void>((resolve) => this.#rpcServer!.close(() => resolve()));
      if (this.#socketDirectory) rmSync(this.#socketDirectory, { recursive: true, force: true });
      this.record('container-stopped', {
        container: this.#id ?? 'not-created',
        volume: this.volume,
      });
      this.#resolveClosed();
    })());
  }
}
