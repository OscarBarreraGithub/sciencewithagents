import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { z } from 'zod';
import {
  codexTranscript,
  isBackgroundCodexThread,
  mirrorControlSchema,
  mirrorPage,
  mirrorPageQuerySchema,
  mirrorSendSchema,
  type MirrorControl,
  type MirrorPageQuery,
  type MirrorResult,
  type MirrorSend,
  type MirrorState,
} from '@dock/shared';

const execute = promisify(execFile);
const responseLimit = 32 * 1024 * 1024;
const loadedLimit = 100;
const nativeId = z.string().min(1).max(128);
const loadedSchema = z.object({ data: z.array(nativeId).max(loadedLimit) });
const threadSchema = z
  .object({
    id: nativeId,
    ephemeral: z.boolean(),
    canAcceptDirectInput: z.boolean().optional(),
    name: z.string().nullable().optional(),
    preview: z.string().optional(),
    status: z.unknown(),
    turns: z.array(z.unknown()).optional(),
  })
  .passthrough();
type Thread = z.infer<typeof threadSchema>;
type Window = Omit<MirrorState, 'entries'>;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');

class NativeRejected extends Error {}

async function runningSocket(binary: string): Promise<string | null> {
  // This command observes an existing daemon. Never invoke daemon start/restart.
  const { stdout } = await execute(binary, ['app-server', 'daemon', 'version'], {
    timeout: 2000,
    maxBuffer: 64 * 1024,
  });
  const result = z
    .object({ status: z.string(), socketPath: z.string().optional() })
    .parse(JSON.parse(stdout));
  if (result.status !== 'running' || !result.socketPath) return null;
  if (!isAbsolute(result.socketPath) || result.socketPath.includes('\0')) return null;
  // The managed daemon publishes a symlink. Validate and connect its resolved
  // target so a later change of that link cannot redirect this connection.
  const path = await realpath(result.socketPath);
  if (path.includes(':')) return null;
  const stat = await lstat(path);
  if (!stat.isSocket() || typeof process.getuid !== 'function' || stat.uid !== process.getuid())
    return null;
  return path;
}

function windowId(threadId: string): string {
  const hash = createHash('sha256').update(`codex-daemon:${threadId}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A second client of an already running native daemon, never a provider launcher. */
export class CodexDaemonChats {
  private socket: WebSocket | undefined;
  private connecting: Promise<void> | undefined;
  private discovering: Promise<void> | undefined;
  private lastDiscovery = -Infinity;
  private discoveryInterval = 2000;
  private closed = false;
  private nextId = 0;
  private readonly summaries = new Map<string, Window>();
  private readonly mutations = new Set<string>();
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly binary: string,
    private readonly options: {
      socketPath?: (binary: string) => Promise<string | null>;
      connect?: (path: string) => WebSocket;
      timeoutMs?: number;
    } = {},
  ) {}

  private disconnect(error: Error, socket = this.socket) {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.summaries.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    socket?.terminate(); // Only this client's connection, never the shared daemon.
  }

  private async connect() {
    if (this.closed) throw new Error('Native conversation sharing is closed.');
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const connecting = (async () => {
      const path = await (this.options.socketPath ?? runningSocket)(this.binary);
      if (!path)
        throw new Error('Open Codex on this computer to connect its native conversations.');
      if (this.closed) throw new Error('Native conversation sharing is closed.');
      const socket =
        this.options.connect?.(path) ??
        new WebSocket(`ws+unix://${path}:/rpc`, {
          headers: { Host: 'localhost' },
          handshakeTimeout: 2000,
          perMessageDeflate: false,
          maxPayload: responseLimit,
        });
      this.socket = socket;
      socket.on('error', () =>
        this.disconnect(new Error('The native Codex connection failed.'), socket),
      );
      socket.on('close', () =>
        this.disconnect(new Error('The native Codex connection closed.'), socket),
      );
      socket.on('message', (data) => {
        try {
          if (Buffer.byteLength(data.toString()) > responseLimit)
            throw new Error('This native conversation exceeds the 32 MiB read limit.');
          const frame = object(JSON.parse(data.toString()));
          // Provider requests and notifications belong to the native client. Never answer them.
          if (frame.method || typeof frame.id !== 'number') return;
          const request = this.pending.get(frame.id);
          if (!request) return;
          this.pending.delete(frame.id);
          clearTimeout(request.timer);
          if (frame.error)
            request.reject(
              new NativeRejected(
                text(object(frame.error).message).slice(0, 700) || 'Codex rejected the request.',
              ),
            );
          else request.resolve(frame.result);
        } catch (error) {
          this.disconnect(
            error instanceof Error ? error : new Error('Invalid native response.'),
            socket,
          );
        }
      });
      await new Promise<void>((resolve, reject) => {
        if (socket.readyState === WebSocket.OPEN) return resolve();
        socket.once('open', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('The native Codex connection closed.')));
      });
      await this.request(
        'initialize',
        {
          clientInfo: { name: 'sciencewithagents_shared_chats', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        },
        2000,
      );
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    })();
    this.connecting = connecting;
    try {
      await connecting;
    } catch (error) {
      this.disconnect(error instanceof Error ? error : new Error('Native connection failed.'));
      throw error;
    } finally {
      if (this.connecting === connecting) this.connecting = undefined;
    }
  }

  private request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('The native Codex connection is unavailable.'));
    if (this.pending.size >= 12) return Promise.reject(new Error('Native Codex is catching up.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.disconnect(
          new Error('Codex did not respond. No request will be retried automatically.'),
          socket,
        );
      }, this.options.timeoutMs ?? timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) this.disconnect(error, socket);
        });
      } catch (error) {
        this.disconnect(
          error instanceof Error ? error : new Error('Native delivery failed.'),
          socket,
        );
      }
    });
  }

  private async loaded(): Promise<Set<string>> {
    await this.connect();
    // Never page through saved history or resume unloaded threads.
    return new Set(
      loadedSchema.parse(
        await this.request('thread/loaded/list', { limit: loadedLimit }, 2000),
      ).data,
    );
  }

  private async thread(threadId: string, includeTurns: boolean): Promise<Thread> {
    const result = object(
      await this.request('thread/read', { threadId, includeTurns }, includeTurns ? 15_000 : 2000),
    );
    const thread = threadSchema.parse(result.thread);
    if (thread.id !== threadId || isBackgroundCodexThread(thread))
      throw new Error('This native conversation is no longer available for sharing.');
    if (includeTurns && !Array.isArray(thread.turns))
      throw new Error('Codex did not return complete history. Read this conversation in Codex.');
    return thread;
  }

  private summary(thread: Thread): Window {
    const status = object(thread.status);
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    const active = thread.turns?.map(object).filter((turn) => turn.status === 'inProgress');
    let state: MirrorState['status'] =
      status.type === 'idle' ? 'idle' : status.type === 'active' ? 'busy' : 'attention';
    if (
      flags.length ||
      (status.activeFlags !== undefined && !Array.isArray(status.activeFlags)) ||
      (state === 'idle' && active?.length) ||
      (state === 'busy' && active && active.length !== 1)
    )
      state = 'attention';
    const token = state === 'busy' && active?.length === 1 ? text(active[0].id) : '';
    const value: Window = {
      windowId: windowId(thread.id),
      provider: 'codex',
      source: 'codex-daemon',
      label: 'Codex on this computer',
      threadId: thread.id,
      title: (thread.name || thread.preview || 'Codex conversation').slice(0, 500),
      status: state,
      message:
        state === 'attention'
          ? 'Check Codex on the computer for its current request or status.'
          : '',
      canSteer: true,
      paged: true,
      groupedActivity: true,
      ...(token && token.length <= 128 ? { stopToken: token, steerToken: token } : {}),
    };
    return value;
  }

  async discover(): Promise<void> {
    if (this.closed) return;
    if (this.discovering) return this.discovering;
    if (Date.now() - this.lastDiscovery < this.discoveryInterval) return;
    const discovering = (async () => {
      try {
        const ids = [...(await this.loaded())];
        this.discoveryInterval = 2000;
        const windows = new Map<string, Window>();
        // Keep the foreground bounded without flooding the shared daemon with metadata reads.
        for (let start = 0; start < ids.length; start += 4) {
          await Promise.all(
            ids.slice(start, start + 4).map(async (id) => {
              try {
                const summary = this.summary(await this.thread(id, false));
                windows.set(summary.windowId, summary);
              } catch {
                /* A thread can unload while metadata is being read. */
              }
            }),
          );
        }
        if (this.closed || this.socket?.readyState !== WebSocket.OPEN) return;
        this.summaries.clear();
        for (const [id, window] of windows) this.summaries.set(id, window);
      } catch {
        this.summaries.clear();
        this.discoveryInterval = 20_000;
      } finally {
        this.lastDiscovery = Date.now();
      }
    })();
    this.discovering = discovering;
    try {
      await discovering;
    } finally {
      if (this.discovering === discovering) this.discovering = undefined;
    }
  }

  windows(): Window[] {
    return [...this.summaries.values()].map((window) => ({ ...window }));
  }

  private async selected(windowId: string, includeTurns = true): Promise<Thread> {
    await this.discover();
    const threadId = this.summaries.get(windowId)?.threadId;
    if (!threadId || !(await this.loaded()).has(threadId)) {
      this.summaries.delete(windowId);
      throw new Error('This conversation is no longer loaded. Open it in Codex on the computer.');
    }
    const thread = await this.thread(threadId, includeTurns);
    this.summaries.set(windowId, this.summary(thread));
    return thread;
  }

  async read(windowId: string, page: MirrorPageQuery = {}): Promise<MirrorState> {
    page = mirrorPageQuerySchema.parse(page);
    try {
      const thread = await this.selected(windowId);
      return mirrorPage(
        { ...this.summary(thread), entries: codexTranscript(thread, 'Codex on this computer') },
        page,
      );
    } catch (error) {
      if (!(error instanceof NativeRejected) || error.message !== 'list_turns is not supported yet')
        throw error;
      const thread = await this.selected(windowId, false);
      return mirrorPage(
        {
          ...this.summary(thread),
          entries: [],
          historyUnavailable: true,
          message:
            'Codex has not exposed this session’s history yet. You can send a message or read it on the computer.',
        },
        page,
      );
    }
  }

  private async mutate(windowId: string, input: MirrorSend | MirrorControl): Promise<MirrorResult> {
    if ((input.provider ?? 'codex') !== 'codex' || this.mutations.has(windowId))
      return {
        state: 'not_sent',
        message: 'This conversation is unavailable or another request is pending.',
      };
    if ('mode' in input && input.mode === 'queue')
      return {
        state: 'not_sent',
        message: 'Codex supports guidance to its active reply, not queued follow-ups.',
      };
    this.mutations.add(windowId);
    let submitted = false;
    try {
      let thread = await this.selected(windowId, false);
      if ('action' in input || input.expectedTurnId) thread = await this.thread(thread.id, true);
      const current = this.summary(thread);
      if (thread.id !== input.threadId)
        return {
          state: 'not_sent',
          message: 'The conversation identity changed. Nothing was sent.',
        };
      let method: string, params: Record<string, unknown>;
      if ('action' in input) {
        if (current.status !== 'busy' || current.stopToken !== input.token)
          return {
            state: 'not_sent',
            message: 'That reply is no longer active. Nothing else was stopped.',
          };
        method = 'turn/interrupt';
        params = { threadId: thread.id, turnId: input.token };
      } else {
        const steering = !!input.expectedTurnId;
        if (
          steering
            ? current.status !== 'busy' || current.steerToken !== input.expectedTurnId
            : current.status !== 'idle'
        )
          return {
            state: 'not_sent',
            message:
              'The native conversation changed or needs attention. Keep your draft and refresh.',
          };
        method = steering ? 'turn/steer' : 'turn/start';
        // No model, permissions, cwd, or configuration overrides: inherit the loaded native thread.
        params = {
          threadId: thread.id,
          input: [{ type: 'text', text: input.text, text_elements: [] }],
          ...(steering ? { expectedTurnId: input.expectedTurnId } : {}),
        };
      }
      submitted = true;
      const result = object(await this.request(method, params));
      if (method === 'turn/steer' && result.turnId !== (input as MirrorSend).expectedTurnId)
        throw new Error('Codex did not identify the expected turn in its acknowledgement.');
      if (method === 'turn/start' && !nativeId.safeParse(object(result.turn).id).success)
        throw new Error('Codex did not identify the accepted turn.');
      this.lastDiscovery = -Infinity;
      return {
        state: 'sent',
        message:
          method === 'turn/interrupt'
            ? 'Stop requested for this reply. Completed actions are not undone.'
            : 'Accepted by the existing Codex conversation. Native clients share this conversation.',
      };
    } catch (error) {
      if (error instanceof NativeRejected || !submitted)
        return {
          state: 'not_sent',
          message: (error instanceof Error ? error.message : 'Codex is unavailable.').slice(
            0,
            1000,
          ),
        };
      return {
        state: 'uncertain',
        message:
          'Codex did not confirm delivery. Check the native conversation; this request will not be resent automatically.',
      };
    } finally {
      this.mutations.delete(windowId);
    }
  }

  send(windowId: string, input: MirrorSend): Promise<MirrorResult> {
    return this.mutate(windowId, mirrorSendSchema.parse(input));
  }
  control(windowId: string, input: MirrorControl): Promise<MirrorResult> {
    return this.mutate(windowId, mirrorControlSchema.parse(input));
  }
  close(): void {
    this.closed = true;
    this.disconnect(new Error('Native conversation sharing closed.'));
  }
}
