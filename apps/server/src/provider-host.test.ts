import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './paths.js';

it('kills the provider process group after lifetime-pipe loss, including a TERM-resistant descendant', async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  const root = mkdtempSync(join(repoRoot, 'data/tests/lifetime-'));
  const pidPath = join(root, 'pid');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'}); setInterval(() => {}, 1000);`;
  const host = spawn(
    process.execPath,
    [
      join(repoRoot, 'apps/server/src/provider-host.ts'),
      process.execPath,
      JSON.stringify(['-e', parent]),
    ],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  );
  let descendantPid: number | undefined;
  try {
    await expect.poll(() => existsSync(pidPath), { timeout: 3000 }).toBe(true);
    descendantPid = Number(readFileSync(pidPath, 'utf8'));
    host.stdin.end();
    await expect
      .poll(
        () => {
          try {
            process.kill(descendantPid!, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 4000 },
      )
      .toBe(false);
    await expect.poll(() => host.exitCode).toBe(0);
  } finally {
    host.kill('SIGTERM');
    if (descendantPid) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
});
