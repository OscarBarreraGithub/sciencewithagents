import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { connectClusterLoopback } from './cluster-transport.js';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('delivers a newline-free binary body before its native keepalive stream exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dock-slurm-pipe-'));
  const previousPath = process.env.PATH;
  const projectId = randomUUID(),
    token = randomUUID();
  const body = Buffer.from([0, 1, 10, 13, 255, 0, 3]);
  const sockets = new Set<Socket>();
  const remote = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length,
      Connection: 'keep-alive',
    });
    response.end(body);
  });
  remote.keepAliveTimeout = 60_000;
  remote.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  const remotePort = (remote.address() as { port: number }).port;
  // Emulate Slurm's output buffering while running the actual Python TCP pipe.
  // Without --unbuffered, header lines pass but the final binary tail waits for EOF.
  function fakeSsh() {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const args = process.argv.slice(2);
    const decode = (value: string) => value.slice(1, -1).split("'\\''").join("'");
    const child = spawn('python3', ['-c', decode(args.at(-2)!), decode(args.at(-1)!)], {
      env: { ...process.env, SLURM_JOB_ID: '12345' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let pending = Buffer.alloc(0);
    process.stdin.pipe(child.stdin);
    child.stderr.pipe(process.stderr);
    child.stdout.on('data', (data: Buffer) => {
      if (args.includes('--unbuffered')) return void process.stdout.write(data);
      pending = Buffer.concat([pending, data]);
      const end = pending.lastIndexOf(10) + 1;
      if (end) {
        process.stdout.write(pending.subarray(0, end));
        pending = pending.subarray(end);
      }
    });
    child.once('exit', (code) => {
      process.stdout.write(pending);
      process.exit(code ?? 0);
    });
    process.once('SIGTERM', () => child.kill('SIGTERM'));
    child.stdin.on('error', () => {});
  }
  writeFileSync(join(root, 'ssh'), `#!${process.execPath}\n(${fakeSsh.toString()})();\n`, {
    mode: 0o700,
  });
  writeFileSync(
    join(root, 'scontrol'),
    `#!/bin/sh\nprintf '%s\\n' 'JobId=12345 UserId=owner(${process.getuid!()}) Comment=swa-development:${projectId}:${token} Account=owner_lab'\n`,
    { mode: 0o700 },
  );
  process.env.PATH = `${root}:${previousPath}`;
  const transport = await connectClusterLoopback(
    {
      projectId,
      alias: 'fixture',
      username: 'owner',
      account: 'owner_lab',
      path: '/fixture',
      resources: {
        cpus: 2,
        memoryMb: 8192,
        timeMinutes: 60,
        idleMinutes: 20,
        partition: 'test',
        qos: null,
      },
    },
    {
      projectId,
      token,
      username: 'owner',
      alias: 'fixture',
      configuration: 'a'.repeat(64),
      state: 'ready',
      jobId: '12345',
      node: 'compute1',
      createdAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      message: 'Fixture',
    },
    remotePort,
    async () => true,
  );
  const agent = transport.agent;
  try {
    const received = await new Promise<Buffer>((resolve, reject) => {
      get(
        `http://127.0.0.1:${transport.port}/binary`,
        {
          agent,
          signal: AbortSignal.timeout(2500),
        },
        (response) => {
          expect(response.statusCode).toBe(200);
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('end', () => resolve(Buffer.concat(chunks)));
          response.once('error', reject);
        },
      ).once('error', reject);
    });
    expect(received).toEqual(body);
    expect([...sockets].some((socket) => !socket.destroyed)).toBe(true);
  } finally {
    await transport.close();
    await vi.waitFor(() => expect(sockets.size).toBe(0));
    process.env.PATH = previousPath;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

it('bounds pending ownership checks and closes them without spawning SSH', async () => {
  const projectId = randomUUID();
  let validations = 0;
  let release!: (valid: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const transport = await connectClusterLoopback(
    {
      projectId,
      alias: 'fixture',
      username: 'owner',
      account: 'owner_lab',
      path: '/fixture/project',
      resources: {
        cpus: 2,
        memoryMb: 8192,
        timeMinutes: 120,
        idleMinutes: 20,
        partition: 'test',
        qos: null,
      },
    },
    {
      projectId,
      token: randomUUID(),
      username: 'owner',
      alias: 'fixture',
      configuration: 'a'.repeat(64),
      state: 'ready',
      jobId: '12345',
      node: 'compute1',
      createdAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      message: 'Fixture',
    },
    4330,
    () => (++validations === 1 ? Promise.resolve(true) : pending),
  );
  const sockets: Socket[] = [];
  try {
    expect(transport.connectionStartTimeoutMs).toBe(15_000);
    await Promise.all(
      Array.from(
        { length: 25 },
        () =>
          new Promise<void>((resolve, reject) => {
            const socket = createConnection({ host: '127.0.0.1', port: transport.port });
            sockets.push(socket);
            socket.once('connect', resolve);
            socket.once('error', reject);
          }),
      ),
    );
    await vi.waitFor(() => {
      expect(validations).toBe(25); // Initial allocation check plus 24 reserved streams.
      expect(sockets.filter((socket) => socket.destroyed)).toHaveLength(1);
    });
    await transport.close();
    release(false);
    expect(transport.alive()).toBe(false);
    expect(validations).toBe(25);
  } finally {
    release(false);
    for (const socket of sockets) socket.destroy();
    await transport.close();
  }
});
