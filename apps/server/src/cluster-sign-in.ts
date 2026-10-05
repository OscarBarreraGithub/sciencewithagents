import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import * as pty from 'node-pty';
import { z } from 'zod';
import {
  clusterSignInRespondSchema,
  clusterSignInSchema,
  clusterSignInStartSchema,
  type ClusterSettings,
  type ClusterSignIn,
} from '@dock/shared';
import { Conflict } from './store.js';
import type { ClusterMonitor } from './cluster.js';

export type SignInTerminal = {
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(): void;
};
export type SignInSpawn = (args: string[]) => SignInTerminal;

/** Native OpenSSH in a private pseudo-terminal; its output never leaves this process. */
export const spawnSignIn: SignInSpawn = (args) =>
  pty.spawn('ssh', args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: homedir(),
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' &&
          !['SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'].includes(entry[0]),
      ),
    ),
  });

const strip = (text: string) =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
/** The prompt only; "(account@host)" prefixes and earlier output stay inside the terminal. */
export function signInPrompt(output: string) {
  const line = strip(output).split('\n').at(-1)!.trim();
  if (/\(yes\/no/i.test(line) || /fingerprint/i.test(line)) return { kind: 'host-key' as const };
  if (!/[:?]$/.test(line) || line.length > 200) return null;
  const label = line
    .replace(/^\([^)]*\)\s*/, '')
    .replace(/\S+@\S+/g, '')
    .trim()
    .slice(0, 80);
  if (/password|passphrase/i.test(line))
    return { kind: 'password' as const, label: label || 'Password:' };
  if (/verification|passcode|one[- ]?time|otp|token|code|pin|option/i.test(line))
    return { kind: 'code' as const, label: label || 'Verification code:' };
  return null;
}

type Session = ClusterSignIn & {
  /** The alias this attempt signs in to; answers never reach a terminal for another alias. */
  alias: string;
  terminal: SignInTerminal | null;
  output: string;
  timer: NodeJS.Timeout;
};
const idle = (): ClusterSignIn => ({
  id: null,
  state: 'idle',
  prompt: null,
  message: '',
  startedAt: null,
});
const active = (session: Session | null) =>
  !!session && ['starting', 'prompt', 'waiting'].includes(session.state);
const changedMessage = 'The cluster settings changed while signing in. Start again.';

/**
 * Restores the owner's shared SSH sign-in from the app. Passwords and codes go straight
 * into the native SSH prompt; they are never stored, logged, echoed or given to agents.
 */
export class ClusterSignIns {
  private session: Session | null = null;
  /** Concurrent starts share one preflight, so at most one terminal is ever opened. */
  private starting: Promise<ClusterSignIn> | null = null;
  constructor(
    private cluster: ClusterMonitor,
    private spawn: SignInSpawn = spawnSignIn,
    private timeoutMs = 180_000,
  ) {
    cluster.onTargetChange(({ alias }) => {
      const session = this.session;
      if (session && active(session) && session.alias !== alias)
        this.end(session, 'cancelled', 'Sign-in cancelled because the cluster alias changed.');
    });
  }
  status(): ClusterSignIn {
    if (!this.session) return idle();
    const {
      alias: _alias,
      terminal: _terminal,
      output: _output,
      timer: _timer,
      ...visible
    } = this.session;
    return clusterSignInSchema.parse(visible);
  }
  async start(raw: unknown) {
    clusterSignInStartSchema.parse(raw);
    const settings = this.cluster.settings();
    if (!settings?.enabled) throw new Conflict('Connect a cluster in QUARK first.');
    if (this.session && active(this.session) && this.session.alias === settings.alias)
      return this.status();
    this.starting ??= this.begin(settings).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  private async begin(settings: ClusterSettings) {
    const target = this.cluster.target();
    const revision = this.cluster.revision();
    const unchanged = () => {
      if (
        !this.cluster.isCurrent(target) ||
        this.cluster.revision() !== revision ||
        !this.cluster.settings()?.enabled
      )
        throw new Conflict(changedMessage);
    };
    this.finish();
    const master = await this.cluster.masterState(settings.alias);
    unchanged();
    if (master === 'running') {
      this.session = this.closed(
        settings.alias,
        'connected',
        'Your shared sign-in is already active.',
      );
      this.cluster.signedIn();
      return this.status();
    }
    const sockets = await this.cluster.controlSockets();
    unchanged();
    if (!sockets.length)
      throw new Conflict(
        'Add ControlMaster and ControlPath for this host in your SSH configuration so one sign-in can be shared. The app does not change SSH settings.',
      );
    const id = randomUUID();
    const terminal = this.spawn([
      '-M',
      '-N',
      '-f',
      '-o',
      'BatchMode=no',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=20',
      '--',
      settings.alias,
    ]);
    const session: Session = {
      id,
      alias: settings.alias,
      state: 'starting',
      prompt: null,
      message: 'Contacting the cluster…',
      startedAt: new Date().toISOString(),
      terminal,
      output: '',
      timer: setTimeout(() => {
        if (this.live(session)) this.end(session, 'expired', 'Sign-in timed out. Try again.');
      }, this.timeoutMs),
    };
    this.session = session;
    let prompts = 0;
    terminal.onData((data) => {
      if (this.session !== session || !session.terminal) return;
      session.output = (session.output + data).slice(-4096);
      const prompt = signInPrompt(session.output);
      if (!prompt || session.state === 'prompt') return;
      if (prompt.kind === 'host-key') {
        this.end(
          session,
          'failed',
          'The cluster host key is unknown or changed. Check it yourself in a terminal; the app never accepts host keys.',
        );
        return;
      }
      if (++prompts > 6) {
        this.end(session, 'failed', 'Too many sign-in prompts. Try again from the beginning.');
        return;
      }
      session.state = 'prompt';
      session.prompt = { id: prompts, kind: prompt.kind, label: prompt.label };
      session.message = '';
      session.output = '';
    });
    terminal.onExit(({ exitCode }) => {
      if (this.session !== session || !session.terminal) return;
      const output = strip(session.output);
      session.terminal = null;
      session.output = '';
      void (async () => {
        // `-f` returns once authenticated; allow the background master a moment to listen.
        let master = exitCode === 0 ? await this.cluster.masterState(session.alias) : 'absent';
        for (let attempt = 0; exitCode === 0 && master !== 'running' && attempt < 5; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (!this.live(session)) return;
          master = await this.cluster.masterState(session.alias);
        }
        // A cancelled, expired or replaced attempt keeps the outcome it already has.
        if (!this.live(session)) return;
        if (master === 'running') {
          this.end(session, 'connected', 'Signed in. Cluster readings are refreshing.');
          this.cluster.signedIn();
        } else
          this.end(
            session,
            'failed',
            /Permission denied|Authentication failed/i.test(output)
              ? 'Sign-in was not accepted. Check your password and code, then try again.'
              : /Host key verification failed|IDENTIFICATION HAS CHANGED/i.test(output)
                ? 'The cluster host key is unknown or changed. Check it yourself in a terminal; the app never accepts host keys.'
                : /Could not resolve|timed out|unreachable|Connection refused/i.test(output)
                  ? 'The cluster could not be reached from this computer.'
                  : 'Sign-in did not complete. Try again.',
          );
      })().catch(() => {
        if (this.live(session)) this.end(session, 'failed', 'Sign-in did not complete. Try again.');
      });
    });
    return this.status();
  }
  /** Still the current, unfinished attempt for the configured alias. */
  private live(session: Session) {
    return (
      this.session === session &&
      active(session) &&
      this.cluster.settings()?.alias === session.alias
    );
  }
  /** Writes one answer to the current prompt. A replayed or late answer is ignored. */
  respond(raw: unknown) {
    const input = clusterSignInRespondSchema.parse(raw);
    const session = this.session;
    if (!session || session.id !== input.id)
      throw new Conflict('This sign-in has ended. Start again.');
    if (session.alias !== this.cluster.settings()?.alias) {
      if (active(session)) this.end(session, 'cancelled', changedMessage);
      throw new Conflict(changedMessage);
    }
    if (session.state !== 'prompt' || session.prompt?.id !== input.promptId || !session.terminal)
      return this.status();
    session.state = 'waiting';
    session.prompt = null;
    session.message = 'Checking…';
    session.terminal.write(`${input.response}\r`);
    return this.status();
  }
  cancel(raw: unknown) {
    const input = z.object({ id: z.string().uuid() }).strict().parse(raw);
    // Also covers the moment after SSH exits while its background session is being checked.
    if (this.session && this.session.id === input.id && active(this.session))
      this.end(this.session, 'cancelled', 'Sign-in cancelled.');
    return this.status();
  }
  close() {
    this.finish();
  }
  private closed(alias: string, state: ClusterSignIn['state'], message: string): Session {
    return {
      id: randomUUID(),
      alias,
      state,
      prompt: null,
      message,
      startedAt: new Date().toISOString(),
      terminal: null,
      output: '',
      timer: setTimeout(() => {}, 0),
    };
  }
  private end(session: Session, state: ClusterSignIn['state'], message: string) {
    clearTimeout(session.timer);
    if (session.state !== state) this.cluster.store.event('cluster.sign_in', null, null, { state });
    // A foreground SSH still waiting for input has no sign-in to keep.
    session.terminal?.kill();
    session.terminal = null;
    session.output = '';
    session.state = state;
    session.prompt = null;
    session.message = message;
  }
  /** Ends whatever attempt came before; an unfinished one is recorded as cancelled. */
  private finish() {
    const session = this.session;
    if (!session) return;
    if (active(session)) this.end(session, 'cancelled', 'Sign-in cancelled.');
    else this.end(session, session.state, session.message);
  }
}
