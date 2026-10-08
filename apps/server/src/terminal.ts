import * as pty from 'node-pty';
import type WebSocket from 'ws';
import { terminalInputSchema } from '@dock/shared';
import type { Runtime } from './runtime.js';
import { Conflict } from './store.js';
import { NativeRelay, type NativeHandoff, type NativeTransition } from './native-relay.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CodexRpc } from './codex.js';

type Session = {
  process: pty.IPty;
  relay: NativeRelay;
  clients: Set<WebSocket>;
  buffer: string;
  exit: number | null;
  ready: Promise<void>;
  isReady: boolean;
};
export class Terminals {
  sessions = new Map<string, Session>();
  private bindings = new WeakMap<WebSocket, { agentId: string; session: Session }>();
  private openings = new Map<string, symbol>();
  private onEvent = (event: { type: string; agentId: string | null }) => {
    if (event.type === 'terminal.session_left' && event.agentId) this.stop(event.agentId);
  };
  constructor(readonly runtime: Runtime) {
    runtime.store.on('event', this.onEvent);
  }
  activeCount() {
    return (
      this.openings.size +
      [...this.sessions.values()].filter((session) => session.exit === null).length
    );
  }
  active(id: string) {
    return this.openings.has(id) || this.sessions.get(id)?.exit === null;
  }
  async connect(agentId: string, socket: WebSocket) {
    // One short attachment lock avoids opposing A→B / B→A transfer deadlocks.
    return this.runtime.withLock('terminal-control', async () => {
      if (socket.readyState !== 1) return;
      const session = await this.ensureSession(agentId);
      if (socket.readyState === 1) this.bind(agentId, session, socket);
    });
  }
  private checkIdle(agentId: string, transferringPeer?: string) {
    this.runtime.requireDirectControl(agentId);
    const agent = this.runtime.store.agent(agentId);
    if (agent.interview)
      throw new Conflict(
        'Use the read-only interview chat. Native controls remain with the original worker.',
      );
    if (agent.provider !== 'codex')
      throw new Conflict(
        'The managed terminal currently belongs to Codex. Use Claude chat here, or share its native VS Code conversation.',
      );
    if (['running', 'waiting', 'queued'].includes(agent.status))
      throw new Conflict('Wait for or stop the active turn before attaching the terminal.');
    if (
      agent.taskId &&
      this.runtime.store
        .agents()
        .some(
          (a) =>
            a.taskId === agent.taskId &&
            a.id !== agent.id &&
            (['running', 'waiting'].includes(a.status) ||
              (a.id !== transferringPeer && this.runtime.externalControl.has(a.id))),
        )
    )
      throw new Conflict(
        'A worker is using this task worktree. Wait for it before taking terminal control.',
      );
    return agent;
  }
  private prepare(
    agentId: string,
    method: string,
    raw: unknown,
  ): NativeTransition | NativeHandoff | null {
    const observation = this.runtime.prepareNativeObservation(agentId, method, raw);
    if (observation) return observation;
    const params = z.object({ threadId: z.string() }).passthrough().safeParse(raw);
    const targetId =
      method === 'thread/resume' && params.success
        ? this.runtime.store.contextOwner(params.data.threadId)
        : null;
    if (!targetId || targetId === agentId)
      return this.runtime.prepareNativeContext(agentId, method, raw);
    const source = this.runtime.store.agent(agentId);
    // Validate the source's idle state, host connection and workspace before reserving a transfer.
    this.runtime.prepareNativeContext(agentId, method, {
      ...params.data,
      threadId: source.threadId,
    });
    let cancelled = false;
    return {
      cancel: () => {
        cancelled = true;
      },
      handoff: () =>
        this.runtime.withLock('terminal-control', () =>
          this.transfer(agentId, targetId, params.data!.threadId, () => cancelled),
        ),
    };
  }
  private async ensureSession(
    agentId: string,
    selectedThreadId?: string,
    transferringPeer?: string,
  ) {
    let session = this.sessions.get(agentId);
    if (
      session?.exit === null &&
      selectedThreadId &&
      this.runtime.store.agent(agentId).threadId !== selectedThreadId
    )
      throw new Conflict(
        'Return the target agent to chat before selecting a different saved context.',
      );
    if (!session || session.exit !== null) {
      const agent = this.checkIdle(agentId, transferringPeer);
      const opening = Symbol();
      this.openings.set(agentId, opening);
      // Reserve before awaiting the provider so the scheduler cannot race attachment.
      this.runtime.externalControl.add(agentId);
      let relay: NativeRelay | undefined;
      const checkOpening = () => {
        if (this.openings.get(agentId) !== opening)
          throw new Conflict('Terminal attachment was cancelled.');
      };
      try {
        // attach creates and names a fresh empty thread before the TUI resumes it.
        // No user input or model turn is needed; native turn admission still owns work.
        const { client } = await this.runtime.attach(agentId);
        if (this.runtime.factory && !(client instanceof CodexRpc))
          throw new Conflict(
            'Native terminal is available with real Codex, not the demo provider.',
          );
        checkOpening();
        if (selectedThreadId) await this.runtime.selectNativeContext(agentId, selectedThreadId);
        checkOpening();
        const threadId = this.runtime.store.agent(agentId).threadId!;
        let resolveReady!: () => void;
        let rejectReady!: (error: Error) => void;
        const readiness = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        // Initial connects can display startup output before readiness is awaited by a transfer.
        void readiness.catch(() => {});
        relay = new NativeRelay(
          join(this.runtime.dataDir, 'sockets', `${randomUUID().slice(0, 8)}.pty`),
          this.runtime.socketPath(agentId),
          (method, params) => {
            const transition = this.prepare(agentId, method, params);
            if (transition && 'handoff' in transition) return transition;
            const resuming = z.object({ threadId: z.literal(threadId) }).safeParse(params).success;
            if (method !== 'thread/resume' || !resuming) return transition;
            return {
              ...transition,
              params: transition?.params ?? params,
              finish: async (result) => {
                await transition?.finish(result);
                const current = this.sessions.get(agentId);
                if (!current || current.relay !== relay)
                  throw new Conflict('Terminal attachment was cancelled.');
                current.isReady = true;
                resolveReady();
                for (const client of current.clients)
                  if (client.readyState === 1) client.send(JSON.stringify({ type: 'ready' }));
              },
              cancel: () => transition?.cancel(),
            };
          },
        );
        await relay.start();
        checkOpening();
        let terminal: pty.IPty;
        try {
          // Remote resume inherits the thread's server-managed permissions.
          // CLI permission overrides are rejected before the TUI can attach.
          terminal = pty.spawn(
            this.runtime.binary,
            ['resume', '--remote', `unix://${relay.path}`, threadId, '--no-alt-screen'],
            {
              name: 'xterm-256color',
              cols: 100,
              rows: 30,
              cwd: agent.cwd,
              env: Object.fromEntries(
                Object.entries({ ...process.env, TERM: 'xterm-256color' }).filter(
                  (entry): entry is [string, string] => typeof entry[1] === 'string',
                ),
              ),
            },
          );
        } catch (error) {
          relay.close();
          throw error;
        }
        session = {
          process: terminal,
          relay,
          clients: new Set(),
          buffer: '',
          exit: null,
          ready: readiness,
          isReady: false,
        };
        this.sessions.set(agentId, session);
        this.runtime.externalControl.add(agentId);
        const current = session;
        terminal.onData((data) => {
          current.buffer = (current.buffer + data).slice(-1_000_000);
          for (const client of current.clients)
            if (client.readyState === 1) {
              if (client.bufferedAmount > 2_000_000)
                client.close(1013, 'Reconnect to refresh the terminal.');
              else client.send(JSON.stringify({ type: 'output', data }));
            }
        });
        terminal.onExit(({ exitCode }) => {
          current.relay.close();
          current.exit = exitCode;
          rejectReady(new Conflict('The target Codex terminal exited before it was ready.'));
          // A delayed exit from an old PTY must not release its replacement's lease.
          if (this.sessions.get(agentId) === current) {
            this.runtime.clearNativeObservation(agentId);
            this.runtime.externalControl.delete(agentId);
          }
          for (const client of current.clients)
            if (client.readyState === 1)
              client.send(JSON.stringify({ type: 'exit', code: exitCode }));
        });
        this.runtime.store.event('terminal.opened', agent.projectId, agentId, {});
      } catch (error) {
        relay?.close();
        if (this.openings.get(agentId) === opening) this.runtime.externalControl.delete(agentId);
        throw error;
      } finally {
        if (this.openings.get(agentId) === opening) this.openings.delete(agentId);
      }
    }
    return session;
  }
  private bind(agentId: string, session: Session, socket: WebSocket) {
    const previous = this.bindings.get(socket);
    previous?.session.clients.delete(socket);
    // One interactive client at a time. Reconnecting takes ownership and closes the old view.
    for (const old of session.clients)
      old.close(4001, 'Terminal control moved to another browser.');
    session.clients.clear();
    session.clients.add(socket);
    this.bindings.set(socket, { agentId, session });
    socket.send(JSON.stringify({ type: 'output', data: session.buffer }));
    if (session.isReady) socket.send(JSON.stringify({ type: 'ready' }));
    if (previous) return;
    socket.on('message', (raw) => {
      try {
        const current = this.bindings.get(socket)?.session;
        if (!current?.clients.has(socket) || current.exit !== null) return;
        if (Buffer.byteLength(raw.toString()) > 32_768) throw new Error('Input limit exceeded');
        const value = terminalInputSchema.parse(JSON.parse(raw.toString()));
        if (value.type === 'input') current.process.write(value.data);
        else current.process.resize(value.cols, value.rows);
      } catch {
        socket.close(1008, 'Invalid terminal input');
      }
    });
    socket.on('close', () => this.bindings.get(socket)?.session.clients.delete(socket));
  }
  private async transfer(
    sourceId: string,
    targetId: string,
    threadId: string,
    cancelled: () => boolean,
  ) {
    const source = this.sessions.get(sourceId);
    if (!source || source.exit !== null || cancelled())
      throw new Conflict('The source terminal has closed.');
    this.checkIdle(sourceId);
    this.checkIdle(targetId, sourceId);
    const hadTarget = this.active(targetId);
    let target: Session | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      target = await this.ensureSession(targetId, threadId, sourceId);
      await Promise.race([
        target.ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Conflict('The target terminal did not become ready. Try again from chat.'),
              ),
            15_000,
          );
        }),
      ]);
      if (
        cancelled() ||
        this.sessions.get(sourceId) !== source ||
        this.sessions.get(targetId) !== target ||
        target.exit !== null
      )
        throw new Conflict('Terminal control changed before the transfer completed.');
      this.checkIdle(sourceId, targetId);
      this.checkIdle(targetId, sourceId);
      const clients = [...source.clients].filter((s) => s.readyState === 1);
      if (!clients.length) throw new Conflict('Reconnect the source terminal before transferring.');
      this.runtime.store.event(
        'terminal.transferred',
        this.runtime.store.agent(targetId).projectId,
        targetId,
        {
          sourceAgentId: sourceId,
          targetAgentId: targetId,
          threadId,
        },
      );
      for (const socket of clients) {
        socket.send(JSON.stringify({ type: 'transferred', agentId: targetId }));
        this.bind(targetId, target, socket);
      }
      this.stop(sourceId);
    } catch (error) {
      if (!hadTarget && target && this.sessions.get(targetId) === target) this.stop(targetId);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  stop(agentId: string) {
    this.runtime.clearNativeObservation(agentId);
    this.openings.delete(agentId);
    const session = this.sessions.get(agentId);
    if (session?.exit === null) session.process.kill();
    session?.relay.close();
    for (const client of session?.clients ?? []) client.close();
    this.sessions.delete(agentId);
    this.runtime.externalControl.delete(agentId);
  }
  close() {
    this.runtime.store.off('event', this.onEvent);
    for (const id of new Set([...this.sessions.keys(), ...this.openings.keys()])) this.stop(id);
  }
}
