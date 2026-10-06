import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http, { Agent, createServer, type RequestOptions, type Server } from 'node:http';
import { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { bridgeTarget, checkPrivateSocket, MirrorTransport } from './transport.js';

let root = '',
  server: Server | undefined,
  ws: WebSocketServer | undefined;
const transports: MirrorTransport[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.stop();
  vi.restoreAllMocks();
  for (const client of ws?.clients ?? []) client.terminate();
  if (ws) await new Promise<void>((resolve) => ws!.close(() => resolve()));
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  ws = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});
function privatePath(name = 'bridge.sock') {
  // macOS /var is linked; use its canonical /private path for the permission contract.
  root = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'swa-ws-'));
  chmodSync(root, 0o700);
  return join(root, name);
}
async function listen(socketPath?: string) {
  server = createServer();
  ws = new WebSocketServer({ server });
  const requests: { url?: string; origin?: string; host?: string }[] = [];
  server.on('upgrade', (req) =>
    requests.push({ url: req.url, origin: req.headers.origin, host: req.headers.host }),
  );
  await new Promise<void>((resolve) =>
    socketPath ? server!.listen(socketPath, resolve) : server!.listen(0, '127.0.0.1', resolve),
  );
  if (socketPath) chmodSync(socketPath, 0o600);
  return requests;
}
function transport(
  target: () => ReturnType<typeof bridgeTarget>,
  onConnect: (peer: WebSocket) => void,
) {
  const result = new MirrorTransport(target, onConnect, () => {}, 15);
  transports.push(result);
  result.start();
  return result;
}
describe('private editor transport', () => {
  it('requires explicit Remote SSH socket configuration without falling back to cluster TCP', () => {
    expect(bridgeTarget(4330, '')).toEqual({ port: 4330 });
    expect(() => bridgeTarget(4330, '', 'ssh-remote')).toThrow('remote socket path');
    expect(() => bridgeTarget(4330, '/tmp/a', 'dev-container')).toThrow('Remote SSH');
    expect(() => bridgeTarget(4330, 'relative')).toThrow('absolute');
    expect(() => bridgeTarget(4330, '/tmp/a/../socket')).toThrow('canonical');
    expect(() => bridgeTarget(4330, '/tmp/' + 'a'.repeat(100))).toThrow('100 bytes');
    expect(() => bridgeTarget(1, '')).toThrow('port');
  });
  it('refuses socket names that ws IPC URL parsing would change or split', () => {
    for (const name of ['a:b', 'a b', 'café', 'a?b', 'a#b', 'a"b', 'a\tb'])
      expect(() => bridgeTarget(4330, `/tmp/${name}`, 'ssh-remote')).toThrow('socket path');
    expect(bridgeTarget(4330, '/tmp/socket-_.+%20.sock', 'ssh-remote').socketPath).toBe(
      '/tmp/socket-_.+%20.sock',
    );
  });
  it('checks owned socket and directory modes and refuses linked/non-socket paths', async () => {
    const socketPath = privatePath();
    await listen(socketPath);
    expect(() => checkPrivateSocket(socketPath)).not.toThrow();
    chmodSync(socketPath, 0o666);
    expect(() => checkPrivateSocket(socketPath)).toThrow('0600');
    chmodSync(socketPath, 0o600);
    chmodSync(root, 0o755);
    expect(() => checkPrivateSocket(socketPath)).toThrow('0700');
    chmodSync(root, 0o700);
    symlinkSync(socketPath, join(root, 'linked'));
    expect(() => checkPrivateSocket(join(root, 'linked'))).toThrow('0600');
    writeFileSync(join(root, 'file'), '', { mode: 0o600 });
    expect(() => checkPrivateSocket(join(root, 'file'))).toThrow('0600');
    mkdirSync(join(root, 'private'), { mode: 0o700 });
    symlinkSync(join(root, 'private'), join(root, 'dir-link'));
    expect(() => checkPrivateSocket(join(root, 'dir-link', 'absent'))).toThrow();
  });
  it('waits for first-run forwarding, exchanges bounded commands without Origin, and reconnects without replay', async () => {
    const socketPath = privatePath();
    let connected = 0;
    const received: string[] = [];
    const mirror = transport(
      () => bridgeTarget(4330, socketPath, 'ssh-remote'),
      (peer) => {
        connected++;
        peer.on('message', (data) => received.push(data.toString()));
      },
    );
    expect(mirror.issue).toContain('unavailable');
    const requests = await listen(socketPath);
    const messages: string[] = [];
    ws!.on('connection', (peer) => {
      peer.on('message', (data) => messages.push(data.toString()));
      peer.send('typed fixture command');
    });
    await expect.poll(() => connected).toBe(1);
    await expect.poll(() => received).toEqual(['typed fixture command']);
    mirror.socket!.send('first message');
    await expect.poll(() => messages).toEqual(['first message']);
    expect(requests).toEqual([
      { url: '/api/vscode/bridge', origin: undefined, host: '127.0.0.1:4330' },
    ]);
    ws!.clients.values().next().value!.terminate();
    await expect.poll(() => connected).toBe(2);
    expect(messages).toEqual(['first message']);
    chmodSync(socketPath, 0o666);
    ws!.clients.values().next().value!.terminate();
    await expect.poll(() => mirror.issue).toContain('0600');
    expect(connected).toBe(2);
    chmodSync(socketPath, 0o600);
    await expect.poll(() => connected).toBe(3);
    mirror.stop();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(connected).toBe(3);
    expect(mirror.socket).toBeUndefined();
  });
  it('uses HTTP socketPath through the extension host proxy patch with an explicit gateway Host', async () => {
    // Literal percent escapes must remain literal filenames, not be decoded.
    const socketPath = privatePath('bridge-_.+%20.sock');
    const requests = await listen(socketPath);
    let proxyRequests = 0;
    let tcpAttempts = 0;
    const proxy = new Agent();
    proxy.createConnection = () => {
      tcpAttempts++;
      const socket = new Socket();
      queueMicrotask(() =>
        socket.destroy(
          Object.assign(new Error('Fixture proxy cannot reach cluster loopback'), {
            code: 'ECONNREFUSED',
          }),
        ),
      );
      return socket;
    };
    const request = http.request;
    // VS Code proxy-agent passes socketPath through; otherwise its default
    // override installs an Agent, bypassing request-level createConnection.
    vi.spyOn(http, 'request').mockImplementation(((
      options: RequestOptions,
      callback?: Parameters<typeof request>[1],
    ) => {
      if (!options.socketPath) {
        proxyRequests++;
        return request({ ...options, agent: proxy }, callback);
      }
      return request(options, callback);
    }) as typeof request);
    let connected = 0;
    const received: string[] = [];
    ws!.on('connection', (peer) => peer.send('typed fixture command'));
    transport(
      () => bridgeTarget(54321, socketPath, 'ssh-remote'),
      (peer) => {
        connected++;
        peer.on('message', (data) => received.push(data.toString()));
      },
    );
    await expect.poll(() => connected).toBe(1);
    await expect.poll(() => received).toEqual(['typed fixture command']);
    expect(requests).toEqual([
      { url: '/api/vscode/bridge', origin: undefined, host: '127.0.0.1:54321' },
    ]);
    expect(proxyRequests).toBe(0);
    expect(tcpAttempts).toBe(0);
    proxy.destroy();
  });
  it('preserves local loopback transport and reconnects when its configured destination changes', async () => {
    await listen();
    const port = (server!.address() as { port: number }).port;
    let connected = 0;
    const mirror = transport(
      () => bridgeTarget(port, ''),
      () => connected++,
    );
    await expect.poll(() => connected).toBe(1);
    mirror.start();
    await expect.poll(() => connected).toBe(2);
    expect(mirror.socket?.readyState).toBe(WebSocket.OPEN);
  });
});
