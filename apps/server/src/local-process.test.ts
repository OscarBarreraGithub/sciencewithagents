import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fork } from 'node:child_process';
import { LocalProcess } from './local-process.js';

it.each(['source', 'compiled'] as const)(
  'pauses and resumes the %s local process, then closes its supervisor',
  async (mode) => {
    const Process =
      mode === 'source' ? LocalProcess : (await import('../dist/local-process.js')).LocalProcess;
    const root = mkdtempSync(join(tmpdir(), 'swa-process-')),
      path = join(root, 'ticks');
    const code = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(path)},'x'),25)`;
    const child = new Process(process.execPath, ['-e', code], root);
    try {
      for (let n = 0; n < 40 && !existsSync(path); n++) await delay(25);
      expect(existsSync(path)).toBe(true);
      await child.control('pause');
      await delay(50);
      const paused = readFileSync(path, 'utf8');
      await delay(100);
      expect(readFileSync(path, 'utf8')).toBe(paused);
      await child.control('resume');
      await delay(100);
      expect(readFileSync(path, 'utf8').length).toBeGreaterThan(paused.length);
    } finally {
      await child.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it('lifetime IPC loss cleans up the exact owned process group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-parent-')),
    path = join(root, 'pid');
  const worker = `require('node:fs').writeFileSync(${JSON.stringify(path)},String(process.pid));setInterval(()=>{},1000)`;
  const host = new URL('../dist/local-process-host.js', import.meta.url);
  const supervisor = fork(host, [process.execPath, '-e', worker], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: [],
  });
  let pid = 0;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    for (let n = 0; n < 80 && !existsSync(path); n++) await delay(25);
    pid = Number(readFileSync(path, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    supervisor.disconnect();
    for (let n = 0; n < 160 && alive(); n++) await delay(25);
    expect(alive()).toBe(false);
  } finally {
    if (supervisor.connected) supervisor.disconnect();
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});
it('keeps cleanup ownership when the group leader exits before a TERM-resistant descendant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-descendant-')),
    path = join(root, 'pid');
  const code = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(path)},String(process.pid));setInterval(()=>{},1000)`;
  const leader = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(code)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const child = new LocalProcess(
    process.execPath,
    ['-e', leader],
    root,
    new URL('../dist/local-process-host.js', import.meta.url),
  );
  let pid = 0;
  try {
    for (let n = 0; n < 80 && !existsSync(path); n++) await delay(25);
    pid = Number(readFileSync(path, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    await child.close();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await child.close();
    rmSync(root, { recursive: true, force: true });
  }
});
