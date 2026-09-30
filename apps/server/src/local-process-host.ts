/** Own one local job process group; parent IPC loss terminates only that group. */
import { spawn } from 'node:child_process';
const [binary, ...args] = process.argv.slice(2);
if (!binary || !process.send) process.exit(2);
const child = spawn(binary, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});
let closing = false;
let timer: NodeJS.Timeout | null = null;
const signal = (name: NodeJS.Signals) => {
  if (!child.pid) return;
  try {
    process.platform === 'win32' ? child.kill(name) : process.kill(-child.pid, name);
  } catch {
    /* Already gone. */
  }
};
const close = () => {
  if (closing) return;
  closing = true;
  signal('SIGCONT');
  signal('SIGTERM');
  timer = setTimeout(() => {
    signal('SIGKILL');
    process.exit(1);
  }, 2000);
};
child.stdout.on('data', (data: Buffer) => process.stdout.write(data));
child.stderr.on('data', (data: Buffer) => process.stderr.write(data));
child.once('error', () => {
  if (process.connected) process.send?.({ type: 'exit', code: 1 });
  process.exitCode = 1;
  process.disconnect?.();
});
child.once('exit', (code) => {
  // Keep the grace timer alive if the group leader exits before its descendants.
  if (closing) return;
  closing = true;
  if (timer) clearTimeout(timer);
  if (process.connected) process.send?.({ type: 'exit', code: code ?? 1 });
  process.exitCode = code ?? 1;
  if (process.connected) process.disconnect();
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 0);
      signal('SIGTERM');
      setTimeout(() => {
        signal('SIGKILL');
        process.exit(code ?? 1);
      }, 2000);
    } catch {
      /* The complete owned group has exited. */
    }
  }
});
process.on('message', (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as { id?: string; action?: string };
  if (!value.id || !['pause', 'resume', 'cancel'].includes(value.action ?? '')) return;
  if (value.action === 'pause') signal('SIGSTOP');
  if (value.action === 'resume') signal('SIGCONT');
  if (value.action === 'cancel') close();
  if (process.connected) process.send?.({ type: 'control', id: value.id, action: value.action });
});
process.once('disconnect', close);
process.once('SIGTERM', close);
process.once('SIGINT', close);
