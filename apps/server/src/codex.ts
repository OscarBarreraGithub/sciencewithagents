import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { z } from 'zod';
import { disabledMcpOverride } from './mcp.js';
import type { Agent } from '@dock/shared';
const responseByteLimit = 16 * 1024 * 1024; // Bounded provider output, including encoded images.

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
  constructor(
    readonly binary: string,
    readonly socketPath: string,
    readonly cwd: string,
    readonly manager: boolean,
    readonly pluginsEnabled = false,
    readonly nativeChildrenMode: 'off' | 'classic' | 'v2' = 'off',
    readonly webSearch: Agent['webSearch'] = 'disabled',
    readonly imageGeneration = false,
    readonly inheritNative = false,
  ) {
    super();
  }
  async start() {
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    // A socket belongs to this exact runtime. Do not delete a live listener.
    if (existsSync(this.socketPath)) {
      if (await this.connect(300)) {
        this.socket?.close();
        throw new Error(
          'A previous agent runtime is still alive. Stop that runtime before starting a replacement.',
        );
      }
      unlinkSync(this.socketPath);
    }
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
    this.process = spawn(process.execPath, [host, this.binary, JSON.stringify(args)], {
      cwd: this.cwd,
      stdio: ['pipe', 'ignore', 'pipe'],
      detached: false,
      env: { ...process.env, RUST_LOG: 'error' },
    });
    this.process.stderr?.on('data', () => {
      /* Never copy credential-bearing diagnostics into server logs. */
    });
    this.process.on('error', () =>
      this.fail(new Error('Codex could not start. Run pnpm dock doctor.')),
    );
    this.process.on('exit', () =>
      this.fail(new Error('The Codex runtime exited. History is retained; resume to reconnect.')),
    );
    for (let attempt = 0; attempt < 80; attempt++) {
      if (this.process.exitCode !== null) throw new Error('Codex exited during startup.');
      if (await this.connect(150)) break;
      await delay(50);
    }
    if (!this.socket) {
      await this.close();
      throw new Error('Codex did not open its private socket.');
    }
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
    this.ready = true;
  }
  private connect(timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws+unix://${this.socketPath}:/rpc`, {
        headers: { Host: 'localhost' },
        perMessageDeflate: false,
        handshakeTimeout: timeout,
        maxPayload: responseByteLimit,
      });
      socket.once('open', () => {
        this.socket = socket;
        resolve(true);
      });
      socket.once('error', () => {
        socket.close();
        resolve(false);
      });
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
    this.socket?.close();
    this.process?.kill('SIGTERM');
    if (this.process && this.process.exitCode === null) {
      const proc = this.process;
      await Promise.race([
        new Promise<void>((resolve) => proc.once('exit', () => resolve())),
        delay(1500),
      ]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    this.fail(new Error('Codex was stopped.'));
    this.removeAllListeners();
  }
}
