import { accessSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import * as pty from 'node-pty';
import type WebSocket from 'ws';
import { terminalInputSchema, type OwnerTerminalSession } from '@dock/shared';
import { Conflict, Missing } from './store.js';

type Session = {
  info: OwnerTerminalSession;
  process: pty.IPty;
  buffer: string;
  clients: Set<WebSocket>;
};

/** Ephemeral owner shells survive network loss, never restart or replay commands. */
export class OwnerTerminals {
  private sessions = new Map<string, Session>();
  private openings = new Map<string, string>();
  private stopped = false;
  constructor(
    private configuration = (() => {
      const owner = userInfo();
      return {
        shell: owner.shell || process.env.SHELL || '/bin/sh',
        cwd: owner.homedir,
        computer: hostname(),
      };
    })(),
  ) {}
  open(key: string) {
    if (this.stopped) throw new Conflict('The computer terminal service is stopping.');
    const existing = this.openings.get(key);
    if (existing) return this.read(existing);
    if ([...this.sessions.values()].filter((s) => s.info.status === 'running').length >= 4)
      throw new Conflict('Close an existing owner terminal before opening another.');
    if (!isAbsolute(this.configuration.shell))
      throw new Conflict('The computer’s login shell must be configured with an absolute path.');
    accessSync(this.configuration.shell, constants.X_OK);
    // Only trusted server configuration selects the native executable and starting folder.
    const process = pty.spawn(this.configuration.shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: this.configuration.cwd,
      env: Object.fromEntries(
        Object.entries({ ...globalThis.process.env, TERM: 'xterm-256color' }).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' && !entry[0].startsWith('DOCK_'),
        ),
      ),
    });
    const id = randomUUID();
    const session: Session = {
      info: { id, ...this.configuration, status: 'running', exitCode: null },
      process,
      buffer: '',
      clients: new Set(),
    };
    this.sessions.set(id, session);
    this.openings.set(key, id);
    process.onData((data) => {
      session.buffer = (session.buffer + data).slice(-262_144);
      this.emit(session, { type: 'output', data });
    });
    process.onExit(({ exitCode }) => {
      session.info = { ...session.info, status: 'exited', exitCode };
      this.emit(session, { type: 'exit', code: exitCode });
      for (const client of session.clients) client.close(1000, 'Shell exited');
      session.clients.clear();
      this.prune();
    });
    return this.read(id);
  }
  read(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Missing('This terminal ended with the app. Open a new terminal.');
    return { ...session.info };
  }
  connect(id: string, socket: WebSocket) {
    this.read(id);
    const session = this.sessions.get(id)!;
    if (session.info.status !== 'running') throw new Conflict('This shell has exited.');
    // An explicit reconnect takes input ownership; the previous browser cannot keep typing.
    for (const previous of session.clients)
      previous.close(4001, 'Terminal moved to another browser');
    session.clients.clear();
    session.clients.add(socket);
    socket.send(JSON.stringify({ type: 'output', data: session.buffer }));
    socket.send(JSON.stringify({ type: 'ready' }));
    socket.on('message', (raw, binary) => {
      if (!session.clients.has(socket) || session.info.status !== 'running') return;
      try {
        if (binary || Buffer.byteLength(raw.toString()) > 32_768) throw new Error('Invalid input');
        const input = terminalInputSchema.parse(JSON.parse(raw.toString()));
        if (input.type === 'input') session.process.write(input.data);
        else session.process.resize(input.cols, input.rows);
      } catch {
        session.clients.delete(socket);
        socket.close(1008, 'Invalid terminal input');
      }
    });
    socket.once('close', () => session.clients.delete(socket));
    socket.once('error', () => session.clients.delete(socket));
  }
  private emit(session: Session, value: unknown) {
    for (const socket of session.clients) {
      if (socket.readyState !== 1) continue;
      if (socket.bufferedAmount > 1_000_000) {
        session.clients.delete(socket);
        socket.close(1013, 'Reconnect to refresh output');
      } else socket.send(JSON.stringify(value));
    }
  }
  stop(id: string) {
    this.read(id);
    const session = this.sessions.get(id)!;
    if (session.info.status !== 'running') return;
    // Kill only this owned PTY; no provider session or unrelated process is touched.
    session.process.kill();
    session.info = { ...session.info, status: 'exited', exitCode: null };
    for (const client of session.clients) client.close(1000, 'Terminal closed');
    session.clients.clear();
    this.prune();
  }
  private prune() {
    // Bound retained closed receipts/output without evicting an active shell.
    for (const [key, value] of this.openings) {
      if (this.openings.size <= 64) break;
      if (this.sessions.get(value)?.info.status === 'exited') {
        this.openings.delete(key);
        this.sessions.delete(value);
      }
    }
  }
  close() {
    this.stopped = true;
    for (const id of this.sessions.keys()) this.stop(id);
  }
}
