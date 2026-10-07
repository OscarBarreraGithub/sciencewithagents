import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync, unlinkSync, lstatSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { z } from 'zod';
import { disabledMcpOverride } from './mcp.js';
import type { Agent } from '@dock/shared';
import type { NativeProviderBoundary } from './native-provider-boundary.js';
const responseByteLimit = 16 * 1024 * 1024; // Bounded provider output, including encoded images.

/** macOS Unix socket names have a 104-byte bound, including the terminator. */
export function providerSocketPath(requested: string) {
  if (Buffer.byteLength(requested) < 100) return requested;
  const identity = createHash('sha256').update(resolve(requested)).digest('hex').slice(0, 24);
  return join('/tmp', `swa-rpc-${process.getuid?.() ?? 'local'}-${identity}`, 'rpc.sock');
}

const envelope = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).passthrough().optional(),
});
export const threadResponse = z
  .object({
    thread: z.object({ id: z.string(), turns: z.array(z.unknown()).default([]) }).passthrough(),
    model: z.string().optional(),
  })
  .passthrough();
export const turnResponse = z
  .object({ turn: z.object({ id: z.string(), status: z.string() }).passthrough() })
  .passthrough();
export const toolCall = z.object({
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
});
export type DynamicTool = {
  type: 'function';
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading: boolean;
};
export interface Provider extends EventEmitter {
  ready: boolean;
  readonly ownedProcessId?: number | null;
  request(method: string, params?: unknown): Promise<unknown>;
  respond(id: string | number, result: unknown): void;
  close(): Promise<void>;
}

export class CodexRpc extends EventEmitter implements Provider {
  readonly socketPath: string;
  private readonly shortSocket: boolean;
  process: ChildProcess | null = null;
  socket: WebSocket | null = null;
  ready = false;
  get ownedProcessId() {
    return this.process?.exitCode === null && this.process.signalCode === null
      ? (this.process.pid ?? null)
      : null;
  }
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private stopping = false;
  private cancelConnect: (() => void) | null = null;
  constructor(
    readonly binary: string,
    socketPath: string,
    readonly cwd: string,
    readonly manager: boolean,
    readonly pluginsEnabled = false,
    readonly nativeChildrenMode: 'off' | 'classic' | 'v2' = 'off',
    readonly webSearch: Agent['webSearch'] = 'disabled',
    readonly imageGeneration = false,
    readonly inheritNative = false,
    private readonly socketTiming = { openingMs: 20_000, handshakeMs: 5_000 },
    readonly boundary?: NativeProviderBoundary,
  ) {
    super();
    this.socketPath = providerSocketPath(socketPath);
    this.shortSocket = this.socketPath !== socketPath;
  }
  async start() {
    // Group admission precedes socket cleanup, config inventory and any process.
    await this.boundary?.check('codex');
    if (this.boundary && !this.inheritNative)
      throw new Error(
        'Confined native launch requires native inheritance; unmanaged configuration discovery is forbidden.',
      );
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (this.shortSocket) {
      const directory = lstatSync(dirname(this.socketPath));
      if (
        !directory.isDirectory() ||
        directory.mode & 0o077 ||
        (process.getuid && directory.uid !== process.getuid())
      )
        throw new Error(
          'The private provider socket directory is not owned exclusively by this account.',
        );
    }
    // A socket belongs to this exact runtime. Do not delete a live listener.
    if (!this.boundary?.codexSocketManaged && existsSync(this.socketPath)) {
      const before = lstatSync(this.socketPath);
      if (!before.isSocket()) throw new Error('The private provider socket path is not a socket.');
      const existing = await this.connect(performance.now() + this.socketTiming.handshakeMs);
      if (existing === 'connected') {
        this.socket?.terminate();
        this.socket = null;
        throw new Error(
          'A previous agent runtime is still alive. Stop that runtime before starting a replacement.',
        );
      }
      if (existing !== 'absent' || this.stopping)
        throw new Error('The previous private socket may still be alive; it was not removed.');
      if (existsSync(this.socketPath)) {
        const after = lstatSync(this.socketPath);
        if (before.ino !== after.ino || before.dev !== after.dev)
          throw new Error('The private provider socket changed during its liveness check.');
        unlinkSync(this.socketPath);
      }
    }
    if (this.stopping) throw new Error('Codex was stopped during startup.');
    const disabledFeatures = [
      'apps',
      'plugins',
      'hooks',
      'multi_agent',
      'multi_agent_v2',
      'computer_use',
      'browser_use',
      'browser_use_external',
      'in_app_browser',
      'image_generation',
      'workspace_dependencies',
      'skill_mcp_dependency_install',
    ];
    if (this.manager)
      disabledFeatures.push('shell_tool', 'unified_exec', 'view_image', 'skill_search');
    const inventoryArgs = disabledFeatures.flatMap((feature) => ['--disable', feature]);
    const featureArgs = disabledFeatures.flatMap((feature) => [
      !this.manager &&
      ((this.pluginsEnabled && ['plugins', 'apps'].includes(feature)) ||
        (this.imageGeneration && feature === 'image_generation') ||
        (this.nativeChildrenMode !== 'off' && feature === 'multi_agent') ||
        (this.nativeChildrenMode === 'v2' && feature === 'multi_agent_v2'))
        ? '--enable'
        : '--disable',
      feature,
    ]);
    const args = [
      'app-server',
      '--listen',
      `unix://${this.socketPath}`,
      '-c',
      'analytics.enabled=false',
      ...(this.boundary?.codexArgs ?? []),
      ...(this.inheritNative
        ? []
        : [
            // Inventory only standalone servers. Plugin-derived entries have no
            // standalone transport and are governed by the separate plugin policy.
            '-c',
            await disabledMcpOverride(this.binary, this.cwd, inventoryArgs),
            '-c',
            `web_search=${JSON.stringify(this.manager ? 'disabled' : this.webSearch)}`,
            ...featureArgs,
          ]),
    ];
    const host = fileURLToPath(
      new URL(
        import.meta.url.endsWith('.ts') ? './provider-host.ts' : './provider-host.js',
        import.meta.url,
      ),
    );
    const env: NodeJS.ProcessEnv = {
      ...(this.boundary ? this.boundary.environment : process.env),
      RUST_LOG: 'error',
    };
    // A launch from VS Code must identify as this app, not inherit the editor's
    // originator override. Native sign-in, settings and capabilities still inherit.
    delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    if (this.stopping) throw new Error('Codex was stopped during startup.');
    const launch = this.boundary ? this.boundary.spawn.bind(this.boundary) : spawn;
    this.process = launch(
      this.boundary?.codexDirect ? this.binary : process.execPath,
      this.boundary?.codexDirect ? args : [host, this.binary, JSON.stringify(args)],
      {
        cwd: this.cwd,
        stdio: ['pipe', 'ignore', 'pipe'],
        detached: false,
        env,
      },
    );
    this.process.stderr?.on('data', () => {
      /* Never copy credential-bearing diagnostics into server logs. */
    });
    this.process.on('error', () => {
      this.cancelConnect?.();
      this.fail(new Error('Codex could not start. Run pnpm dock doctor.'));
    });
    this.process.on('exit', () => {
      this.cancelConnect?.();
      this.fail(new Error('The Codex runtime exited. History is retained; resume to reconnect.'));
    });
    try {
      const deadline = performance.now() + this.socketTiming.openingMs;
      while (!this.stopping && performance.now() < deadline) {
        if (this.process.exitCode !== null || this.process.signalCode !== null)
          throw new Error('Codex exited during startup.');
        if (
          (await this.connect(
            Math.min(deadline, performance.now() + this.socketTiming.handshakeMs),
          )) === 'connected'
        )
          break;
        const remaining = deadline - performance.now();
        if (remaining > 0 && !this.stopping) await delay(Math.min(50, remaining));
      }
      if (!this.socket || this.stopping) throw new Error('Codex did not open its private socket.');
      this.socket.on('message', (data) => {
        try {
          if (Buffer.byteLength(data.toString()) > responseByteLimit)
            throw new Error('Codex message exceeded its limit.');
          const value = envelope.parse(JSON.parse(data.toString()));
          if (value.method) {
            if (value.id !== undefined) this.emit('request', value.id, value.method, value.params);
            else this.emit('notification', value.method, value.params);
          } else if (typeof value.id === 'number') {
            const pending = this.pending.get(value.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(value.id);
            if (value.error) pending.reject(new Error(value.error.message.slice(0, 1500)));
            else pending.resolve(value.result);
          }
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error('Invalid Codex message.'));
        }
      });
      this.socket.on('close', () => this.fail(new Error('The Codex connection closed.')));
      this.socket.on('error', () => this.fail(new Error('The Codex connection failed.')));
      await this.request('initialize', {
        clientInfo: { name: 'agent_dock', title: 'sciencewithagents', version: '0.1.0' },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [
            'item/reasoning/textDelta',
            'item/reasoning/summaryTextDelta',
            'item/reasoning/summaryPartAdded',
          ],
        },
      });
      this.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
      if (this.stopping) throw new Error('Codex was stopped during startup.');
      this.ready = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private connect(deadline: number): Promise<'connected' | 'absent' | 'uncertain'> {
    if (this.stopping || performance.now() >= deadline) return Promise.resolve('uncertain');
    return new Promise((resolve) => {
      const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
      const socket = new WebSocket(`ws+unix://${this.socketPath}:/rpc`, {
        headers: { Host: 'localhost' },
        perMessageDeflate: false,
        handshakeTimeout: remaining,
        maxPayload: responseByteLimit,
      });
      let settled = false;
      const finish = (result: 'connected' | 'absent' | 'uncertain') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.cancelConnect === cancel) this.cancelConnect = null;
        if (result === 'connected' && !this.stopping && performance.now() < deadline)
          this.socket = socket;
        else {
          if (result === 'connected') result = 'uncertain';
          socket.terminate();
        }
        resolve(result);
      };
      const cancel = () => finish('uncertain');
      const timer = setTimeout(cancel, remaining);
      this.cancelConnect = cancel;
      socket.once('open', () => finish('connected'));
      // Keep the handler through termination: aborting CONNECTING emits an error asynchronously.
      socket.on('error', (error: NodeJS.ErrnoException) =>
        finish(['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '') ? 'absent' : 'uncertain'),
      );
      socket.once('close', () => finish('uncertain'));
    });
  }
  request(method: string, params: unknown = {}): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Codex is disconnected.'));
    if (this.pending.size >= 64)
      return Promise.reject(new Error('Too many pending Codex requests.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out; inspect the session before retrying.`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  respond(id: string | number, result: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('Codex disconnected before the response was sent.');
    this.socket.send(JSON.stringify({ id, result }));
  }
  private fail(error: Error) {
    this.ready = false;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    if (!this.stopping) this.emit('unavailable', error);
  }
  async close() {
    this.stopping = true;
    this.ready = false;
    this.cancelConnect?.();
    this.socket?.terminate();
    this.socket = null;
    this.process?.kill('SIGTERM');
    if (this.process && this.process.exitCode === null && this.process.signalCode === null) {
      const proc = this.process;
      await Promise.race([
        new Promise<void>((resolve) => proc.once('exit', () => resolve())),
        delay(1500),
      ]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    this.fail(new Error('Codex was stopped.'));
    this.removeAllListeners();
    if (
      !this.boundary?.codexSocketManaged &&
      this.shortSocket &&
      this.process &&
      (this.process.exitCode !== null || this.process.signalCode !== null)
    ) {
      try {
        unlinkSync(this.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      }
      try {
        rmdirSync(dirname(this.socketPath));
      } catch {
        // Never remove another runtime's files or a directory still in use.
      }
    }
  }
}
