import { execFile, spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import * as pty from 'node-pty';
import { z } from 'zod';
import type { NativeConnectionTarget } from '@dock/shared';
import type { NativeConnectionProfile } from './native-connections-config.js';
import { Conflict } from './store.js';

export type NativeTargetProof = {
  generation: string;
  session: string;
  pane: string;
  pid: number;
  started: string;
  sessionCreated: string;
  panePid: string;
  serverTime: string;
};
export type NativeDiscovery = {
  state: 'available' | 'unavailable' | 'unsupported';
  message: string;
  targets: { proof: NativeTargetProof; view: Omit<NativeConnectionTarget, 'id' | 'sourceId'> }[];
};
export interface NativeClient {
  onOutput(callback: (data: string) => void): void;
  onExit(callback: (code: number) => void): void;
  input(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}
export interface NativeTerminalDriver {
  discover(profile: NativeConnectionProfile): Promise<NativeDiscovery>;
  open(
    profile: NativeConnectionProfile,
    proof: NativeTargetProof,
    mode: 'observe' | 'control',
    takeover: boolean,
  ): Promise<NativeClient>;
  submit(
    profile: NativeConnectionProfile,
    proof: NativeTargetProof,
    client: NativeClient,
    text: string,
  ): Promise<'not_sent' | 'delivered' | 'uncertain'>;
}
export const profileSignature = (profile: NativeConnectionProfile) =>
  createHash('sha256').update(JSON.stringify(profile)).digest('hex');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function nativeSshInvocation(
  profile: NativeConnectionProfile,
  args: readonly string[],
  terminal = false,
) {
  if (!profile.sshAlias) throw new Conflict('This is not a configured SSH source.');
  return {
    executable: 'ssh',
    args: [
      terminal ? '-tt' : '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'ConnectionAttempts=1',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=2',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '-o',
      'PermitLocalCommand=no',
      '-o',
      'StrictHostKeyChecking=yes',
      profile.sshAlias,
      `exec ${args.map(quote).join(' ')}`,
    ],
  };
}
function invocation(profile: NativeConnectionProfile, args: readonly string[], terminal = false) {
  const executable = profile.binary ?? profile.kind;
  const native =
    profile.kind === 'tmux'
      ? [executable, '-N', '-S', profile.socket, ...args]
      : ['env', `HERDR_SOCKET_PATH=${profile.socket}`, executable, ...args];
  return profile.sshAlias
    ? nativeSshInvocation(profile, native, terminal)
    : { executable: profile.kind === 'tmux' ? executable : 'env', args: native.slice(1) };
}
function nativeEnv() {
  return Object.fromEntries(
    Object.entries({ ...process.env, TERM: 'xterm-256color' }).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !/^(DOCK_|TMUX$|TMUX_PANE$|HERDR_)/.test(entry[0]),
    ),
  );
}
function command(program: string, args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      program,
      [...args],
      { timeout: 8000, maxBuffer: 2_000_000, env: nativeEnv() },
      (error, stdout) =>
        error
          ? reject(new Conflict('The native connection command failed or timed out.'))
          : resolve(stdout),
    );
    // Early native refusal can close stdin before execFile reports its exit.
    // The exit callback remains the authoritative command result.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
const native = (p: NativeConnectionProfile, args: readonly string[], input?: string) => {
  const i = invocation(p, args);
  return command(i.executable, i.args, input);
};
const safeId = z.string().regex(/^[a-zA-Z0-9_$:%.-]{1,200}$/);
const cleanLabel = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500);
async function processStart(profile: NativeConnectionProfile, pid: number) {
  const metadata = async (args: string[]) => {
    const i = profile.sshAlias
      ? nativeSshInvocation(profile, args)
      : { executable: args[0]!, args: args.slice(1) };
    return command(i.executable, i.args);
  };
  try {
    const stat = await metadata(['cat', `/proc/${pid}/stat`]);
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    const boot = (await metadata(['cat', '/proc/sys/kernel/random/boot_id'])).trim();
    if (/^\d+$/.test(fields[19] ?? '') && /^[0-9a-f-]{36}$/.test(boot))
      return `linux:${boot}:${fields[19]}`;
  } catch {
    // macOS has no /proc; its socket birth timestamp and ps identity bind the generation.
  }
  const args = ['ps', '-p', String(pid), '-o', 'lstart='];
  const i = profile.sshAlias
    ? nativeSshInvocation(profile, args)
    : { executable: 'ps', args: args.slice(1) };
  const value = (await command(i.executable, i.args)).trim();
  if (!value || value.length > 100)
    throw new Conflict('Cannot prove this native server generation.');
  return value;
}
async function socketGeneration(profile: NativeConnectionProfile) {
  if (profile.sshAlias) {
    // Fixed metadata probes only; never an owner/browser shell command.
    let value: string;
    try {
      const i = nativeSshInvocation(profile, [
        'stat',
        '-c',
        '%d:%i:%W:%u:%F',
        '--',
        profile.socket,
      ]);
      value = (await command(i.executable, i.args)).trim();
    } catch {
      const i = nativeSshInvocation(profile, ['stat', '-f', '%d:%i:%B:%u:%HT', profile.socket]);
      value = (await command(i.executable, i.args)).trim().toLowerCase();
    }
    if (!/^[0-9:]+:socket$/.test(value))
      throw new Conflict('Remote socket generation requires the supported Unix stat metadata.');
    const owner = nativeSshInvocation(profile, ['id', '-u']);
    if (value.split(':')[3] !== (await command(owner.executable, owner.args)).trim())
      throw new Conflict('The configured native socket must belong to the SSH account.');
    return value;
  }
  const socket = realpathSync(profile.socket),
    stat = lstatSync(socket, { bigint: true });
  if (!stat.isSocket() || stat.uid !== BigInt(process.getuid?.() ?? -1))
    throw new Conflict('The native socket must belong to this computer’s owner.');
  // tmux intentionally changes socket permissions (and ctime) when clients attach.
  return `${socket}:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}
const frameSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('terminal.frame'),
      seq: z.number().int().nonnegative(),
      encoding: z.literal('ansi'),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      full: z.boolean(),
      bytes: z
        .string()
        .max(1_400_000)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    })
    .strict(),
  z.object({ type: z.literal('terminal.closed'), reason: z.string().max(2000) }).strict(),
]);

/** CLI-only adapter. It never starts a native server, kills a pane, or installs a tool. */
export class NativeCliDriver implements NativeTerminalDriver {
  async discover(profile: NativeConnectionProfile): Promise<NativeDiscovery> {
    try {
      const generation = await socketGeneration(profile);
      if (profile.kind === 'tmux') {
        const version = (await native(profile, ['-V'])).trim();
        const match = /^tmux (\d+)\.(\d+)/.exec(version);
        if (!match)
          return {
            state: 'unsupported',
            message: 'This tmux version cannot be verified.',
            targets: [],
          };
        const control = Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 2);
        if (!control)
          return {
            state: 'unsupported',
            message:
              'tmux3.2+ is required for attachment without resizing existing native clients.',
            targets: [],
          };
        const output = await native(profile, [
          'list-panes',
          '-a',
          '-F',
          '#{pid}\t#{start_time}\t#{session_id}\t#{session_created}\t#{pane_id}\t#{pane_pid}\t#{session_name}\t#{window_active}\t#{pane_active}',
        ]);
        const lines = output.trim().split('\n').filter(Boolean);
        if (lines.length > 512)
          throw new Conflict('This source has too many panes to display safely.');
        const starts = new Map<number, string>();
        const targets: NativeDiscovery['targets'] = [];
        for (const line of lines) {
          const fields = line.split('\t');
          if (
            fields.length !== 9 ||
            !/^\d+$/.test(fields[0]!) ||
            !/^\d+$/.test(fields[1]!) ||
            !/^\$\d+$/.test(fields[2]!) ||
            !/^\d+$/.test(fields[3]!) ||
            !/^%\d+$/.test(fields[4]!) ||
            !/^\d+$/.test(fields[5]!) ||
            !/^[01]$/.test(fields[7]!) ||
            !/^[01]$/.test(fields[8]!)
          )
            throw new Conflict('The native pane metadata is not supported.');
          // A tmux attachment shares the session's current view. Never select a
          // window or pane on behalf of the browser, including in observe mode.
          if (fields[7] !== '1' || fields[8] !== '1') continue;
          if (targets.some((target) => target.proof.session === fields[2]))
            throw new Conflict('The native session has ambiguous active pane metadata.');
          const pid = Number(fields[0]);
          const started = starts.get(pid) ?? (await processStart(profile, pid));
          starts.set(pid, started);
          targets.push({
            proof: {
              generation,
              session: fields[2]!,
              pane: fields[4]!,
              pid,
              started,
              sessionCreated: fields[3]!,
              panePid: fields[5]!,
              serverTime: fields[1]!,
            },
            view: {
              kind: 'tmux',
              label: cleanLabel(fields[6]!),
              nativeStatus: 'unknown',
              canObserve: true,
              canControl: control,
              controlPolicy: 'shared',
              controller: 'unknown',
            },
          });
        }
        if (generation !== (await socketGeneration(profile)))
          throw new Conflict('Native server changed during discovery.');
        return {
          state: 'available',
          message:
            'tmux clients share the session’s current view and native input. No existing client is detached.',
          targets,
        };
      }
      // Match the installed public 0.9.3 terminal-session JSON protocol; unknown versions fail closed.
      if ((await native(profile, ['--version'])).trim() !== 'herdr 0.9.3')
        return {
          state: 'unsupported',
          message: 'This Herdr terminal protocol has not been verified.',
          targets: [],
        };
      const schema = JSON.parse(await native(profile, ['api', 'schema', '--json'])) as {
        schemas?: unknown;
      };
      if (!schema.schemas) throw new Conflict('Herdr must expose its installed API schema.');
      const pidArgs = ['lsof', '-n', '-P', '-a', '-U', '-Fp', '--', profile.socket];
      const pidInvocation = profile.sshAlias
        ? nativeSshInvocation(profile, pidArgs)
        : { executable: 'lsof', args: pidArgs.slice(1) };
      const pids = [
        ...new Set(
          (await command(pidInvocation.executable, pidInvocation.args))
            .split('\n')
            .filter((s) => /^p[1-9][0-9]*$/.test(s))
            .map((s) => Number(s.slice(1))),
        ),
      ];
      if (pids.length !== 1)
        throw new Conflict('Cannot prove the Herdr socket’s exact server process.');
      const pid = pids[0]!,
        started = await processStart(profile, pid);
      const response = z
        .object({
          result: z
            .object({
              type: z.literal('pane_list'),
              panes: z
                .array(
                  z
                    .object({
                      pane_id: safeId,
                      terminal_id: safeId,
                      label: z.string().nullable().optional(),
                      agent_status: z.enum(['idle', 'working', 'blocked', 'done', 'unknown']),
                    })
                    .passthrough(),
                )
                .max(512),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(JSON.parse(await native(profile, ['pane', 'list'])));
      if (generation !== (await socketGeneration(profile)))
        throw new Conflict('Herdr server changed during discovery.');
      return {
        state: 'available',
        message:
          'Herdr0.9.3 observation and free-controller acquisition are supported. Native control refuses an occupied controller; takeover is unavailable.',
        targets: response.result.panes.map((pane) => ({
          proof: {
            generation,
            pid,
            started,
            session: 'herdr',
            pane: pane.terminal_id,
            sessionCreated: '',
            panePid: '',
            serverTime: '',
          },
          view: {
            kind: 'herdr',
            label: cleanLabel(pane.label || pane.pane_id),
            nativeStatus: pane.agent_status === 'done' ? 'idle' : pane.agent_status,
            canObserve: true,
            canControl: true,
            controlPolicy: 'exclusive',
            controller: 'unknown',
          },
        })),
      };
    } catch (error) {
      return {
        state: 'unavailable',
        message:
          error instanceof Conflict
            ? error.message
            : 'This optional native source is unavailable, or its server identity cannot be verified. Ask your setup agent to check the configured tool and socket.',
        targets: [],
      };
    }
  }
  async verify(profile: NativeConnectionProfile, proof: NativeTargetProof) {
    const discovered = await this.discover(profile);
    const target = discovered.targets.find(
      (target) => JSON.stringify(target.proof) === JSON.stringify(proof),
    );
    if (!target)
      throw new Conflict(
        'This native server or pane changed. Refresh connections and choose its current identity.',
      );
    return target;
  }
  async open(
    profile: NativeConnectionProfile,
    proof: NativeTargetProof,
    mode: 'observe' | 'control',
    takeover: boolean,
  ): Promise<NativeClient> {
    const target = await this.verify(profile, proof);
    if (takeover || (mode === 'control' && !target.view.canControl))
      throw new Conflict('This native source cannot grant the requested control safely.');
    const output = new Set<(data: string) => void>(),
      exit = new Set<(code: number) => void>();
    let endedCode: number | undefined;
    if (profile.kind === 'tmux') {
      const i = invocation(
        profile,
        [
          'attach-session',
          ...(mode === 'observe' ? ['-r'] : []),
          ...(target.view.canControl ? ['-f', 'ignore-size'] : []),
          '-t',
          proof.session,
        ],
        true,
      );
      // Direct native argv; no shell input, no -d, and no stored screen replay.
      const child = pty.spawn(i.executable, i.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: homedir(),
        env: nativeEnv(),
      });
      child.onData((data) => {
        for (const callback of output) callback(data);
      });
      child.onExit(({ exitCode }) => {
        endedCode = exitCode;
        for (const callback of exit) callback(exitCode);
      });
      return {
        onOutput: (fn) => {
          output.add(fn);
        },
        onExit: (fn) => {
          exit.add(fn);
          if (endedCode !== undefined) fn(endedCode);
        },
        input: (data) => child.write(data),
        resize: (cols, rows) => child.resize(cols, rows),
        close: () => child.kill(),
      };
    }
    const i = invocation(profile, [
      'terminal',
      'session',
      mode,
      proof.pane,
      '--cols',
      '80',
      '--rows',
      '24',
    ]);
    const child = spawn(i.executable, i.args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: nativeEnv(),
    });
    const decoder = new StringDecoder('utf8');
    let pending = '';
    // Retain only the latest full startup screen and its subsequent updates
    // until the first subscriber. This is not screen history or reconnect replay.
    let startupFrame: string | undefined;
    let startupBytes = 0;
    let lastSequence: number | undefined;
    let failed = false;
    let acquired = false;
    let resolveReady: () => void = () => {},
      rejectReady: (error: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const timer = setTimeout(() => {
      rejectReady(new Conflict('Herdr attachment timed out; the native session was left running.'));
      child.kill();
    }, 8000);
    timer.unref();
    const fail = () => {
      failed = true;
      startupFrame = undefined;
      clearTimeout(timer);
      rejectReady(
        new Conflict(
          'Herdr startup screen is incomplete or too large. The native session was left running.',
        ),
      );
      child.kill();
    };
    child.stdout.on('data', (data: Buffer) => {
      if (failed) return;
      pending += decoder.write(data);
      if (pending.length > 1_500_000) {
        fail();
        return;
      }
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const frame = frameSchema.parse(JSON.parse(line));
          if (frame.type === 'terminal.frame') {
            if (
              (!acquired && !frame.full) ||
              (lastSequence !== undefined && frame.seq <= lastSequence) ||
              (!frame.full && lastSequence !== undefined && frame.seq !== lastSequence + 1)
            ) {
              fail();
              return;
            }
            lastSequence = frame.seq;
            const data = Buffer.from(frame.bytes, 'base64').toString('utf8');
            if (!output.size) {
              if (frame.full) {
                startupFrame = data;
                startupBytes = Buffer.byteLength(data);
              } else {
                startupFrame = (startupFrame ?? '') + data;
                startupBytes += Buffer.byteLength(data);
              }
              // Existing terminal output frames are bounded to one MiB.
              if (startupBytes > 1_000_000) {
                fail();
                return;
              }
            } else for (const fn of output) fn(data);
            if (!acquired) {
              acquired = true;
              clearTimeout(timer);
              resolveReady();
            }
          } else child.kill();
        } catch {
          fail();
          return;
        }
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      rejectReady(new Conflict('Herdr attachment is unavailable.'));
      endedCode = 1;
      for (const callback of exit) callback(1);
    });
    child.stdin.on('error', () => {
      endedCode = 1;
      clearTimeout(timer);
      rejectReady(
        new Conflict(
          'The Herdr control stream closed. No reconnect or input replay was attempted.',
        ),
      );
      for (const callback of exit) callback(1);
      child.kill();
    });
    child.on('exit', (code) => {
      endedCode = code ?? 1;
      clearTimeout(timer);
      rejectReady(
        new Conflict(
          'Herdr control may be occupied or the attachment unavailable. Existing native clients were left unchanged.',
        ),
      );
      for (const callback of exit) callback(code ?? 1);
    });
    const client: NativeClient = {
      onOutput: (fn) => {
        output.add(fn);
        if (startupFrame !== undefined) {
          const first = startupFrame;
          startupFrame = undefined;
          startupBytes = 0;
          fn(first);
        }
      },
      onExit: (fn) => {
        exit.add(fn);
        if (endedCode !== undefined) fn(endedCode);
      },
      input: (text) => {
        if (mode !== 'control') throw new Conflict('Herdr observation does not accept input.');
        child.stdin.write(JSON.stringify({ type: 'terminal.input', text }) + '\n');
      },
      resize: (cols, rows) => {
        if (mode === 'control')
          child.stdin.write(JSON.stringify({ type: 'terminal.resize', cols, rows }) + '\n');
      },
      close: () => {
        if (mode === 'control')
          child.stdin.end(JSON.stringify({ type: 'terminal.release' }) + '\n');
        child.kill();
      },
    };
    await ready;
    if (failed) throw new Conflict('Herdr startup screen is incomplete or too large.');
    return client;
  }
  async submit(
    profile: NativeConnectionProfile,
    proof: NativeTargetProof,
    _client: NativeClient,
    text: string,
  ) {
    const target = await this.verify(profile, proof);
    if (!target.view.canControl)
      throw new Conflict('This connection does not support saved prompt submission.');
    if (profile.kind === 'herdr') {
      _client.input(text + '\r');
      return 'uncertain' as const; // The controller stream has no per-input ACK; never infer acceptance.
    }
    // Native ACK only: do not infer an agent turn, native exclusivity, or outcome.
    // Paste bytes instead of keys or shell interpolation. The literal text travels only on stdin.
    const name = `swa-${randomUUID()}`;
    await native(profile, ['load-buffer', '-b', name, '-'], text);
    try {
      await this.verify(profile, proof);
      const condition = `#{&&:#{==:#{pid},${proof.pid}},#{&&:#{==:#{start_time},${proof.serverTime}},#{&&:#{==:#{session_created},${proof.sessionCreated}},#{&&:#{==:#{session_id},${proof.session}},#{&&:#{==:#{pane_id},${proof.pane}},#{==:#{pane_pid},${proof.panePid}}}}}}}`;
      const result = await native(profile, [
        'if-shell',
        '-F',
        '-t',
        proof.session,
        condition,
        `paste-buffer -d -p -b ${name} -t ${proof.pane} ; send-keys -t ${proof.pane} Enter`,
        'display-message -p __SWA_NOT_SENT__',
      ]);
      if (result.includes('__SWA_NOT_SENT__')) return 'not_sent' as const;
      return 'delivered' as const;
    } finally {
      await native(profile, ['delete-buffer', '-b', name]).catch(() => {});
    }
  }
}
