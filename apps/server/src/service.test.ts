import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { waitForServiceExit } from './service.js';

it('waits for the exact service process to finish asynchronous shutdown', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 300)'], {
    stdio: 'ignore',
  });
  try {
    await waitForServiceExit(child.pid, 3000);
    expect(() => process.kill(child.pid!, 0)).toThrow();
    expect(child.exitCode).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

it('rejects unsafe IDs and times out without killing an unrelated live process', async () => {
  await expect(waitForServiceExit(0)).rejects.toThrow('Invalid');
  await expect(waitForServiceExit(-1)).rejects.toThrow('Invalid');
  await expect(waitForServiceExit(process.pid, 0)).rejects.toThrow('still shutting down');
  expect(() => process.kill(process.pid, 0)).not.toThrow();
});
