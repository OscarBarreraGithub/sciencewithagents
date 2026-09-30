import { spawn } from 'node:child_process';
const children = [];
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run this through pnpm dev.');
const build = spawn(process.execPath, [pnpm, '--filter', '@dock/shared', 'build'], {
  stdio: 'inherit',
});
await new Promise((resolve, reject) =>
  build.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('Shared build failed')))),
);
for (const name of ['@dock/server', '@dock/web'])
  children.push(
    spawn(process.execPath, [pnpm, '--filter', name, 'dev'], {
      stdio: 'inherit',
      env: { ...process.env, DOCK_DEV: '1' },
    }),
  );
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
for (const child of children)
  child.on('exit', () => {
    for (const other of children) if (other !== child) other.kill('SIGTERM');
  });
