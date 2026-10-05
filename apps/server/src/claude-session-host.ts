import { spawn } from 'node:child_process';
const { claudeAuthScanner } = (await import(
  new URL(
    import.meta.url.endsWith('.ts')
      ? './claude-auth-diagnostics.ts'
      : './claude-auth-diagnostics.js',
    import.meta.url,
  ).href
)) as typeof import('./claude-auth-diagnostics.js');

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
child.stderr.on(
  'data',
  claudeAuthScanner((classification) => {
    if (!child.pid) return;
    process.stderr.write(
      JSON.stringify({
        classification,
        observedAt: new Date().toISOString(),
        nativeProcessId: child.pid,
      }) + '\n',
    );
  }),
); // Never forward raw authentication-bearing diagnostics.
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
