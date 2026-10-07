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

// Independent event loop: the listener can upgrade while the gateway's JS is stalled.
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { vi } from 'vitest';
const require = createRequire(import.meta.url);
type Connectable = { connect(deadline: number): Promise<'connected' | 'absent' | 'uncertain'> };
async function mockListener(root: string, mode: 'upgrade' | 'hang' | 'late' = 'upgrade') {
  const path = join(root, 'rpc.sock');
  const fixture = join(root, 'listener.cjs');
  writeFileSync(
    fixture,
    `
const http=require('node:http');const {WebSocketServer}=require(${JSON.stringify(require.resolve('ws'))});
const server=http.createServer(),ws=new WebSocketServer({noServer:true}),sockets=new Set();
server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
server.on('upgrade',(req,socket,head)=>{process.send?.({kind:'request'});
 if(${JSON.stringify(mode)}==='hang')return;
 setTimeout(()=>{if(socket.destroyed)return;ws.handleUpgrade(req,socket,head,client=>{client.on('error',()=>{});process.send?.({kind:'upgraded'});});},${mode === 'late' ? 150 : 20});});
server.listen(process.argv[2],()=>process.send?.({kind:'ready'}));
process.on('message',m=>{if(m==='stop'){for(const s of sockets)s.destroy();server.close(()=>process.exit(0));}});
`,
  );
  const child = fork(fixture, [path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await message(child, 'ready');
  return {
    path,
    child,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.send('stop');
      await exited;
    },
  };
}
function message(child: ChildProcess, kind: string) {
  return new Promise<void>((resolve, reject) => {
    const listener = (value: { kind?: string }) => {
      if (value.kind === kind) {
        child.off('message', listener);
        resolve();
      }
    };
    child.on('message', listener);
    child.once('error', reject);
  });
}
function stallOnUpgrade(child: ChildProcess) {
  let stalled = false;
  child.once('message', (value: { kind?: string }) => {
    if (value.kind === 'request') {
      stalled = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  });
  return () => stalled;
}
it('opens a healthy independent listener across a 300ms client event-loop stall', async () => {
  const root = mkdtempSync('/tmp/swa-socket-lag-'),
    listener = await mockListener(root);
  const rpc = new CodexRpc('unused', listener.path, root, false);
  try {
    const stalled = stallOnUpgrade(listener.child);
    expect(await (rpc as unknown as Connectable).connect(performance.now() + 5000)).toBe(
      'connected',
    );
    expect(stalled()).toBe(true);
    expect(rpc.socket).not.toBeNull();
  } finally {
    await rpc.close();
    await listener.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('preserves a live existing listener across client starvation without spawning a replacement', async () => {
  const root = mkdtempSync('/tmp/swa-socket-live-'),
    listener = await mockListener(root);
  const rpc = new CodexRpc('unused', listener.path, root, false);
  try {
    const stalled = stallOnUpgrade(listener.child);
    await expect(rpc.start()).rejects.toThrow('still alive');
    expect(stalled()).toBe(true);
    expect(existsSync(listener.path)).toBe(true);
    expect(rpc.process).toBeNull();
  } finally {
    await rpc.close();
    await listener.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('never removes an existing socket after an ambiguous handshake timeout', async () => {
  const root = mkdtempSync('/tmp/swa-socket-uncertain-'),
    listener = await mockListener(root, 'hang');
  const rpc = new CodexRpc('unused', listener.path, root, false);
  const target = rpc as unknown as Connectable,
    connect = target.connect.bind(target);
  const probe = vi.spyOn(target, 'connect').mockImplementation((deadline) => {
    expect(deadline - performance.now()).toBeGreaterThan(4900);
    return connect(performance.now() + 40);
  });
  try {
    await expect(rpc.start()).rejects.toThrow('may still be alive');
    expect(existsSync(listener.path)).toBe(true);
    expect(rpc.process).toBeNull();
    expect(rpc.socket).toBeNull();
  } finally {
    probe.mockRestore();
    await rpc.close();
    await listener.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it.each(['close', 'deadline'] as const)(
  'cancels an in-flight socket on %s and never installs a late upgrade',
  async (mode) => {
    const root = mkdtempSync('/tmp/swa-socket-abort-'),
      listener = await mockListener(root, 'late');
    const rpc = new CodexRpc('unused', listener.path, root, false);
    try {
      const requested = message(listener.child, 'request');
      const connecting = (rpc as unknown as Connectable).connect(
        performance.now() + (mode === 'close' ? 5000 : 40),
      );
      await requested;
      if (mode === 'close') await rpc.close();
      expect(await connecting).toBe('uncertain');
      expect(rpc.socket).toBeNull();
      await new Promise((r) => setTimeout(r, 200));
      expect(rpc.socket).toBeNull();
      expect(rpc.ready).toBe(false);
    } finally {
      await rpc.close();
      await listener.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it('bounds the whole owned socket-opening phase and closes its mock process after timeout', async () => {
  const root = mkdtempSync('/tmp/swa-socket-budget-'),
    binary = join(root, 'provider.cjs'),
    pidFile = join(root, 'pid');
  writeFileSync(
    binary,
    `#!${process.execPath}\nconst http=require('node:http');require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const path=process.argv[process.argv.indexOf('--listen')+1].replace('unix://','');const server=http.createServer();server.on('upgrade',()=>{});server.listen(path);`,
    { mode: 0o700 },
  );
  const rpc = new CodexRpc(
    binary,
    join(root, 'rpc.sock'),
    root,
    false,
    false,
    'off',
    'disabled',
    false,
    true,
    { openingMs: 400, handshakeMs: 80 },
  );
  const target = rpc as unknown as Connectable,
    connect = target.connect.bind(target);
  const deadlines: number[] = [];
  vi.spyOn(target, 'connect').mockImplementation((deadline) => {
    deadlines.push(deadline);
    return connect(deadline);
  });
  try {
    const started = performance.now();
    await expect(rpc.start()).rejects.toThrow('did not open');
    expect(deadlines.length).toBeGreaterThan(0);
    expect(deadlines.every((deadline) => deadline <= started + 450)).toBe(true);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(390);
    expect(elapsed).toBeLessThan(3500);
    expect(rpc.socket).toBeNull();
    expect(rpc.ownedProcessId).toBeNull();
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await rpc.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

it('closes its owned mock process when stopped during a pending startup handshake', async () => {
  const root = mkdtempSync('/tmp/swa-socket-owned-abort-'),
    binary = join(root, 'provider.cjs'),
    pidFile = join(root, 'pid');
  writeFileSync(
    binary,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const server=require('node:http').createServer();server.on('upgrade',()=>{});server.listen(process.argv[process.argv.indexOf('--listen')+1].replace('unix://',''));`,
    { mode: 0o700 },
  );
  const rpc = new CodexRpc(
    binary,
    join(root, 'rpc.sock'),
    root,
    false,
    false,
    'off',
    'disabled',
    false,
    true,
  );
  try {
    // Attach the rejection assertion before close can reject startup.
    const starting = expect(rpc.start()).rejects.toThrow('did not open');
    await expect.poll(() => existsSync(pidFile), { timeout: 2000 }).toBe(true);
    await rpc.close();
    await starting;
    expect(rpc.ready).toBe(false);
    expect(rpc.socket).toBeNull();
    expect(rpc.ownedProcessId).toBeNull();
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow();
  } finally {
    await rpc.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 8000);

it('existing Codex transport preserves a host-managed private Unix relay without provider feature rewrites', async () => {
  const { createServer } = await import('node:http');
  const { WebSocketServer } = await import('ws');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { chmodSync } = await import('node:fs');
  const root = mkdtempSync('/tmp/swa-relay-test-'),
    socket = join(root, 'rpc.sock');
  const server = createServer(),
    relay = new WebSocketServer({ server });
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: () => {
      child.exitCode = 0;
      child.emit('exit', 0);
      return true;
    },
  });
  let launched: string[] = [];
  relay.on('connection', (peer) =>
    peer.on('message', (bytes) => {
      const value = JSON.parse(bytes.toString());
      if (value.id !== undefined) peer.send(JSON.stringify({ id: value.id, result: {} }));
    }),
  );
  const boundary: import('./native-provider-boundary.js').NativeProviderBoundary = {
    codexDirect: true,
    codexSocketManaged: true,
    environment: {},
    check: async () => {},
    spawn: (_binary, args) => {
      launched = args;
      return child as unknown as import('node:child_process').ChildProcess;
    },
    verifyClaudeIdentity: async () => {
      throw new Error('unused');
    },
  };
  const rpc = new CodexRpc(
    'unit-unused-native',
    socket,
    root,
    false,
    false,
    'v2',
    'disabled',
    false,
    true,
    undefined,
    boundary,
  );
  try {
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    chmodSync(socket, 0o600);
    await rpc.start();
    expect(rpc.ready).toBe(true);
    expect(launched).toContain('app-server');
    expect(launched).not.toContain('--disable');
    expect(lstatSync(socket).isSocket()).toBe(true);
  } finally {
    await rpc.close();
    for (const peer of relay.clients) peer.terminate();
    relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
