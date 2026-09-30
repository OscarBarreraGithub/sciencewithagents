import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Paths/arguments come only from host-owned typed stages, never a browser command. */
export class LocalProcess {
  private child: ChildProcess;
  private pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  readonly done: Promise<void>;
  get ownedProcessId() {
    return this.child.exitCode === null && this.child.signalCode === null
      ? (this.child.pid ?? null)
      : null;
  }
  constructor(
    binary: string,
    args: string[],
    cwd: string,
    host = new URL(
      import.meta.url.endsWith('.ts') ? './local-process-host.ts' : './local-process-host.js',
      import.meta.url,
    ),
  ) {
    this.child = fork(fileURLToPath(host), [binary, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: [],
    });
    // Drain bounded private diagnostics without exposing command output or remote metadata.
    this.child.stdout?.on('data', () => {});
    this.child.stderr?.on('data', () => {});
    this.child.on('message', (raw: unknown) => {
      const value = raw as { type?: string; id?: string } | null;
      if (value?.type === 'control' && value.id) {
        const pending = this.pending.get(value.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(value.id);
        pending.resolve();
      }
    });
    this.done = new Promise<void>((resolve, reject) => {
      this.child.once('error', () => reject(new Error('Local tool could not start.')));
      this.child.once('exit', (code) => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('The local process ended.'));
        }
        this.pending.clear();
        code === 0 ? resolve() : reject(new Error('The local tool did not complete.'));
      });
    });
    void this.done.catch(() => {});
  }
  control(action: 'pause' | 'resume' | 'cancel') {
    if (!this.child.connected)
      return Promise.reject(new Error('The original local process is no longer connected.'));
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Control confirmation was lost. Check current job status.'));
      }, 2000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, action });
    });
  }
  async close() {
    try {
      await this.control('cancel');
    } catch {
      /* Host disconnect also closes its group. */
    }
    if (this.child.connected) this.child.disconnect();
    await this.done.catch(() => {});
  }
}
