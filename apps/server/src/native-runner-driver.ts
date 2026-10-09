import { execFile, type ChildProcess } from 'node:child_process';
import { accessSync, constants, lstatSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { NativeRunnerModelResolution, ProviderId } from '@dock/shared';
import { independentClaudeEnvironment } from './claude-session.js';
import { Conflict } from './store.js';
import type { NativeConnectionProfile } from './native-connections-config.js';
import { NativeCliDriver, type NativeDiscovery } from './native-terminal-driver.js';

export type CreatedNativeRunner = NativeDiscovery['targets'][number];
type ExecutableProof = { readonly path: string; readonly identity: string };
export type NativeRunnerPrepared = {
  readonly profile: NativeConnectionProfile;
  readonly tmux: ExecutableProof;
  readonly provider: ExecutableProof;
  readonly socket: { readonly filesystem: string; readonly server: string } | null;
  readonly args: readonly string[];
  readonly nonce: string;
};
export class NativeRunnerNotStarted extends Conflict {}
export interface NativeRunnerDriver {
  source(profile: NativeConnectionProfile): Promise<{ available: boolean; message: string }>;
  provider(provider: ProviderId): Promise<{ installed: boolean; version: string; message: string }>;
  prepare(
    profile: NativeConnectionProfile,
    folder: string,
    nonce: string,
    resolution: NativeRunnerModelResolution,
  ): Promise<NativeRunnerPrepared>;
  create(prepared: NativeRunnerPrepared): Promise<CreatedNativeRunner>;
}
const markers = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
  'CLAUDE_CODE_SSE_PORT',
];
const env = () =>
  Object.fromEntries(
    Object.entries(independentClaudeEnvironment(process.env)).filter(
      ([name, value]) => value !== undefined && !/^(DOCK_|TMUX$|TMUX_PANE$|HERDR_)/.test(name),
    ),
  );
const identity = (path: string) => {
  accessSync(path, constants.X_OK);
  const info = statSync(path, { bigint: true });
  if (!info.isFile()) throw new Error('Not an executable file.');
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
};
const executable = (name: string): ExecutableProof => {
  const candidates = isAbsolute(name)
    ? [resolve(name)]
    : (process.env.PATH ?? '')
        .split(':')
        .filter(Boolean)
        .map((path) => resolve(path, name));
  for (const candidate of candidates) {
    try {
      // Preserve the discovered filename: version-manager shims select by argv0.
      return Object.freeze({ path: candidate, identity: identity(candidate) });
    } catch {
      /* Optional executable absent from this path. */
    }
  }
  throw new NativeRunnerNotStarted(
    'This optional native executable is not installed or executable. Nothing was started.',
  );
};
const verifyExecutable = (proof: ExecutableProof) => {
  try {
    if (identity(proof.path) === proof.identity) return;
  } catch {
    /* Removed or replaced executable. */
  }
  throw new NativeRunnerNotStarted(
    'A prepared native executable changed or disappeared. Nothing was started.',
  );
};
const command = (program: string, args: string[], mutation = false) =>
  new Promise<string>((resolve, reject) => {
    let spawned = false;
    let child: ChildProcess;
    try {
      child = execFile(
        program,
        args,
        { timeout: 8000, maxBuffer: 2_000_000, env: env() },
        (error, output) =>
          error
            ? reject(
                mutation && !spawned
                  ? new NativeRunnerNotStarted(
                      'The native creation executable could not be started. Nothing was started.',
                    )
                  : new Conflict(
                      'The native runner command failed or timed out. Inspect its saved start receipt before doing anything else.',
                    ),
              )
            : resolve(output),
      );
    } catch {
      reject(
        mutation
          ? new NativeRunnerNotStarted(
              'The native creation command could not be dispatched. Nothing was started.',
            )
          : new Conflict('The native metadata command could not be dispatched.'),
      );
      return;
    }
    // A spawn failure (ENOENT/EACCES) cannot have reached tmux. Once spawned,
    // every timeout, failed native command, or lost ACK remains uncertain.
    child.once('spawn', () => {
      spawned = true;
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
/** All command arguments originate in the host adapter or validated native model catalog. */
export function nativeRunnerArguments(
  profile: NativeConnectionProfile,
  folder: string,
  nonce: string,
  resolution: NativeRunnerModelResolution,
  providerBinary: string,
) {
  const providerArgs = [
    providerBinary,
    ...(resolution.model ? [`--model=${resolution.model}`] : []),
    ...(resolution.effort
      ? resolution.provider === 'codex'
        ? ['--config', `model_reasoning_effort=${JSON.stringify(resolution.effort)}`]
        : [`--effort=${resolution.effort}`]
      : []),
  ];
  return [
    '-S',
    profile.socket,
    'new-session',
    '-d',
    '-P',
    '-F',
    '#{session_id}\t#{pane_id}',
    '-s',
    `swa-${nonce}`,
    '-c',
    folder,
    '-e',
    `SWA_NATIVE_LAUNCH_ID=${nonce}`,
    '--',
    '/usr/bin/env',
    ...markers.flatMap((name) => ['-u', name]),
    ...providerArgs,
  ];
}
/** Explicit local tmux creation only; no discovery-start, shell command string, scheduler, or provider handle. */
export class NativeRunnerCliDriver implements NativeRunnerDriver {
  private native = new NativeCliDriver();
  constructor(private binaries: Record<ProviderId, string>) {}
  async source(profile: NativeConnectionProfile) {
    if (profile.kind !== 'tmux' || profile.sshAlias)
      return {
        available: false,
        message:
          'Folder launch currently supports local tmux only. Existing Herdr and SSH sessions can still be connected.',
      };
    try {
      const version = (await command(executable(profile.binary ?? 'tmux').path, ['-V'])).trim();
      const match = /^tmux (\d+)\.(\d+)/.exec(version);
      if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 2))
        throw new Conflict('tmux3.2+ is required to start and safely attach this native runner.');
      return {
        available: true,
        message: `${version} · explicitly starting creates a new independent native session.`,
      };
    } catch (error) {
      return {
        available: false,
        message: error instanceof Conflict ? error.message : 'Optional tmux is unavailable.',
      };
    }
  }
  async provider(provider: ProviderId) {
    try {
      const version = (
        await command(executable(this.binaries[provider]).path, ['--version'])
      ).trim();
      if (!version || version.length > 200)
        throw new Conflict('Native provider version could not be verified.');
      return {
        installed: true,
        version,
        message:
          'Installed. Native sign-in, settings, permissions, skills and hooks remain in the native program.',
      };
    } catch {
      return {
        installed: false,
        version: '',
        message:
          'This optional native provider is unavailable. Ask your setup agent to install it before starting.',
      };
    }
  }
  private async socket(profile: NativeConnectionProfile) {
    try {
      lstatSync(profile.socket);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new NativeRunnerNotStarted(
        'The configured native socket is inaccessible. Nothing was started.',
      );
    }
    try {
      const path = realpathSync(profile.socket),
        info = lstatSync(path, { bigint: true });
      if (!info.isSocket() || info.uid !== BigInt(process.getuid?.() ?? -1))
        throw new Error('Unowned socket.');
      const discovery = await this.native.discover(profile),
        proof = discovery.targets[0]?.proof;
      if (discovery.state !== 'available' || !proof) throw new Error('Unverifiable server.');
      return Object.freeze({
        filesystem: `${path}:${info.dev}:${info.ino}:${info.birthtimeNs}`,
        server: JSON.stringify([proof.generation, proof.pid, proof.started, proof.serverTime]),
      });
    } catch {
      throw new NativeRunnerNotStarted(
        'The existing tmux socket or server identity cannot be verified. Nothing was started; no replacement was requested.',
      );
    }
  }
  async prepare(
    profile: NativeConnectionProfile,
    folder: string,
    nonce: string,
    resolution: NativeRunnerModelResolution,
  ) {
    if (profile.kind !== 'tmux' || profile.sshAlias)
      throw new NativeRunnerNotStarted(
        'Native folder launch supports local tmux only. Nothing was started.',
      );
    const tmux = executable(profile.binary ?? 'tmux'),
      provider = executable(this.binaries[resolution.provider]);
    const selected = Object.freeze({ ...profile, binary: tmux.path });
    const source = await this.source(selected);
    if (!source.available) throw new NativeRunnerNotStarted(source.message);
    const socket = await this.socket(selected);
    verifyExecutable(tmux);
    verifyExecutable(provider);
    return Object.freeze({
      profile: selected,
      tmux,
      provider,
      socket,
      args: Object.freeze(
        nativeRunnerArguments(selected, folder, nonce, resolution, provider.path),
      ),
      nonce,
    });
  }
  async create(prepared: NativeRunnerPrepared) {
    const { profile, tmux, provider, nonce } = prepared;
    verifyExecutable(tmux);
    verifyExecutable(provider);
    if (JSON.stringify(await this.socket(profile)) !== JSON.stringify(prepared.socket))
      throw new NativeRunnerNotStarted(
        'The prepared native server appeared, disappeared or changed. Nothing was started.',
      );
    verifyExecutable(tmux);
    verifyExecutable(provider);
    // The socket can change immediately after this check; only the exact new
    // session ACK, marker and generation below can establish successful creation.
    const result = (await command(tmux.path, [...prepared.args], true)).trim();
    if (!/^\$\d+\t%\d+$/.test(result))
      throw new Conflict('Native creation acknowledgement was unavailable.');
    const [session, pane] = result.split('\t');
    const marker = (
      await command(tmux.path, [
        '-N',
        '-S',
        profile.socket,
        'show-environment',
        '-t',
        session!,
        'SWA_NATIVE_LAUNCH_ID',
      ])
    ).trim();
    const discovered = await this.native.discover(profile);
    const target = discovered.targets.find(
      (value) =>
        value.proof.session === session &&
        value.proof.pane === pane &&
        value.view.label === `swa-${nonce}`,
    );
    if (marker !== `SWA_NATIVE_LAUNCH_ID=${nonce}` || !target)
      throw new Conflict(
        'Native creation cannot be tied to its original session. Read the saved uncertain receipt.',
      );
    return target;
  }
}
