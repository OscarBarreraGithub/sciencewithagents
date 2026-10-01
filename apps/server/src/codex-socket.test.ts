import { it, expect } from 'vitest';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, lstatSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { providerSocketPath, CodexRpc } from './codex.js';

it('binds a private Unix socket for a deeply nested installation without mixing installations', async () => {
  const root = mkdtempSync('/tmp/swa-socket-test-');
  const requested = join(root, 'long-project-folder-'.repeat(12), 'data/sockets/agent.sock');
  const path = providerSocketPath(requested);
  expect(Buffer.byteLength(path)).toBeLessThan(100);
  expect(providerSocketPath(requested)).toBe(path);
  expect(providerSocketPath(requested.replace('agent.sock', 'another.sock'))).not.toBe(path);
  mkdirSync(dirname(path), { mode: 0o700 });
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    expect(lstatSync(path).isSocket()).toBe(true);
    expect(lstatSync(dirname(path)).mode & 0o077).toBe(0);
    const rpc = new CodexRpc('unused', requested, root, false);
    expect(rpc.socketPath).toBe(path);
    expect(providerSocketPath(join(root, 'short.sock'))).toBe(join(root, 'short.sock'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dirname(path), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

it('refuses an exposed temporary directory before launching a provider', async () => {
  const root = mkdtempSync('/tmp/swa-socket-test-');
  const requested = join(root, 'nested-'.repeat(20), 'agent.sock');
  const rpc = new CodexRpc('unused', requested, root, false);
  mkdirSync(dirname(rpc.socketPath), { mode: 0o755 });
  chmodSync(dirname(rpc.socketPath), 0o755);
  try {
    await expect(rpc.start()).rejects.toThrow('not owned exclusively');
    expect(rpc.process).toBeNull();
  } finally {
    await rpc.close();
    rmSync(dirname(rpc.socketPath), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
