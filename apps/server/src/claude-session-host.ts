import { spawn } from 'node:child_process';

// Private stdio supervisor. Parent EOF kills only this invocation's process group,
// including tool descendants; it never searches for or kills another Claude process.
const [binary, serialized] = process.argv.slice(2);
const args: unknown = JSON.parse(serialized ?? 'null');
if (!binary || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
  throw new Error('Invalid private Claude invocation.');
const child = spawn(binary, args as string[], {
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: true,
  env: process.env,
});
child.stderr.on('data', () => {}); // Never forward authentication-bearing diagnostics.
child.stdout.pipe(process.stdout, { end: false });
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
let stopping = false;
function signal(value: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, value);
  } catch {
    /* Already exited. */
  }
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  signal('SIGTERM');
  setTimeout(() => {
    signal('SIGKILL');
    process.exit(code);
  }, 500);
}
process.stdin.on('end', () => stop());
process.stdin.on('error', () => stop(1));
process.stdout.on('error', () => stop(1));
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
child.on('error', () => stop(1));
child.on('close', (code) => stop(code ?? 1));
