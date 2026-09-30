import { spawn } from 'node:child_process';

// The parent holds stdin open as a lifetime pipe. EOF after a crash stops its managed child
// (Codex or the configured phone connector),
// including when the gateway never got a chance to run its signal handlers.
const [binary, serialized] = process.argv.slice(2);
if (!binary || !serialized) throw new Error('This is an internal provider host.');
const args: unknown = JSON.parse(serialized);
if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
  throw new Error('Invalid provider arguments.');
const child = spawn(binary, args as string[], {
  stdio: ['ignore', 'ignore', 'pipe'],
  detached: true,
  env: process.env,
});
child.stderr?.on('data', () => {});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (child.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  setTimeout(() => {
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    process.exit(0);
  }, 1000);
}
process.stdin.resume();
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('error', () => process.exit(1));
// Keep the grace timer alive even if Codex exits before one of its descendants.
child.on('exit', (code) => {
  if (!stopping) process.exit(code ?? 1);
});
