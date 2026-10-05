import { modelFixture } from './model-policy.fixture.js';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { DemoProvider } from './demo.js';
import { PhoneAccess } from './phone-access.js';
import { repoRoot } from './paths.js';
import { ownerAuthorization } from './local-access.js';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const fixtures: {
  root: string;
  child?: ChildProcess;
  finished?: Promise<{ code: number | null; signal: string | null }>;
  blocker?: ReturnType<typeof createHttpServer>;
}[] = [];
async function deadline<T>(promise: Promise<T>, ms = 10_000) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned startup fixture did not finish.')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
async function unusedPort() {
  const socket = createTcpServer();
  await new Promise<void>((done) => socket.listen(0, '127.0.0.1', done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((done) => socket.close(() => done()));
  return port;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dock-startup-safety-'));
  const binary = join(root, 'codex-fixture');
  copyFileSync(join(repoRoot, 'apps/server/src/fixtures/startup-codex.mjs'), binary);
  chmodSync(binary, 0o700);
  const store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const manager = store.register(root, 'Startup preservation fixture', '').managerId;
  store.enqueue(manager, randomUUID(), 'This saved work must not run during a failed start.');
  const original = { runs: store.runs(), entries: store.entries(manager) };
  store.close();
  const value = { root, binary, original, manager };
  fixtures.push(value);
  return value;
}
function calls(root: string): { pid: number; args: string[] }[] {
  const path = join(root, 'calls.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
}
function launch(value: ReturnType<typeof fixture>, port: number, delayed = false) {
  const owned = fixtures.find((item) => item.root === value.root)!;
  owned.child = spawn(process.execPath, [join(repoRoot, 'apps/server/dist/main.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DOCK_DATA_DIR: value.root,
      DOCK_PORT: String(port),
      DOCK_CODEX_BIN: value.binary,
      DOCK_CLAUDE_BIN: join(value.root, 'no-claude'),
      DOCK_CODEXBAR_BIN: join(value.root, 'no-reader'),
      DOCK_CLOUDFLARED_BIN: value.binary,
      DOCK_STARTUP_CALLS: join(value.root, 'calls.jsonl'),
      DOCK_STARTUP_DELAY: delayed ? '600' : '0',
      DOCK_LAUNCHER_LIFETIME: '1',
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  owned.child.stderr!.on('data', (chunk) => {
    diagnostics += String(chunk).slice(0, 2048);
  });
  owned.finished = new Promise((done, fail) => {
    owned.child!.once('exit', (code, signal) => done({ code, signal }));
    owned.child!.once('error', fail);
  });
  return { ...owned, diagnostics: () => diagnostics };
}
async function preserved(value: ReturnType<typeof fixture>, port: number, occupied = false) {
  expect(existsSync(join(value.root, 'server.lock'))).toBe(false);
  expect(calls(value.root).every(({ args }) => args.length === 1 && args[0] === '--version')).toBe(
    true,
  );
  for (const { pid } of calls(value.root)) expect(() => process.kill(pid, 0)).toThrow();
  const store = new Store(join(value.root, 'dock.sqlite'));
  modelFixture(store);
  try {
    expect(store.runs()).toEqual(value.original.runs);
    expect(store.entries(value.manager)).toEqual(value.original.entries);
  } finally {
    store.close();
  }
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(500),
  }).catch(() => null);
  if (occupied) expect(await response?.text()).toBe('Unrelated fixture app');
  else expect(response).toBe(null);
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    if (value.child?.exitCode === null && value.child.signalCode === null) {
      value.child.kill('SIGTERM');
      await deadline(value.finished!, 2000).catch(async () => {
        value.child!.kill('SIGKILL');
        await deadline(value.finished!);
      });
    }
    if (value.blocker) await new Promise<void>((done) => value.blocker!.close(() => done()));
    rmSync(value.root, { recursive: true });
  }
});

describe('main startup safety', () => {
  it('opens saved projects and chats with both providers unavailable and work paused', async () => {
    const value = fixture(),
      port = await unusedPort();
    const settings = new Store(join(value.root, 'dock.sqlite'));
    settings.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
    settings.close();
    rmSync(value.binary);
    const owned = launch(value, port);
    await expect
      .poll(
        async () => {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: AbortSignal.timeout(500),
          }).catch(() => null);
          return response?.status;
        },
        { timeout: 10_000 },
      )
      .toBe(200);
    for (const path of [
      '/api/snapshot',
      `/api/agents/${value.manager}`,
      '/api/pulsar',
      '/api/work-items',
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { Authorization: (await ownerAuthorization(value.root, port, 'GET', path))! },
        signal: AbortSignal.timeout(2000),
      });
      expect(response.status, path).toBe(200);
      const data = await response.json();
      if (path === '/api/snapshot') expect(data.provider.ready).toBe(false);
      if (path.startsWith('/api/agents/')) expect(data.entries).toEqual(value.original.entries);
    }
    expect(owned.child!.exitCode).toBeNull();
    owned.child!.stdin!.end();
    expect((await deadline(owned.finished!)).code, owned.diagnostics()).toBe(0);
    await preserved(value, port);
  });

  it('an invalid local port cannot dispatch queued work and releases its lock', async () => {
    const value = fixture(),
      port = await unusedPort();
    const process = launch(value, 0);
    expect((await deadline(process.finished!)).code, process.diagnostics()).toBe(1);
    expect(calls(value.root)).toEqual([]);
    await preserved(value, port);
  });

  it.each(['invalid configuration', 'same port', 'occupied phone listener'])(
    '%s leaves the local app available without changing saved phone trust or running a connector',
    async (failure) => {
      const value = fixture(),
        port = await unusedPort(),
        other = await unusedPort();
      const settings = new Store(join(value.root, 'dock.sqlite'));
      settings.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
      const original = {
        authentication: 'paired' as const,
        origin: 'https://startup.example.test',
        port: other,
      };
      const phone = new PhoneAccess(settings, original);
      phone.setEnabled(true);
      const trust = settings.getSetting('phone:configuration');
      settings.close();
      writeFileSync(join(value.root, 'cloudflare-tunnel.token'), 'fixture-only', { mode: 0o600 });
      writeFileSync(
        join(value.root, 'phone-access.json'),
        failure === 'invalid configuration'
          ? '{invalid'
          : JSON.stringify({ ...original, port: failure === 'same port' ? port : other }),
      );
      const owned = fixtures.find((item) => item.root === value.root)!;
      if (failure === 'occupied phone listener') {
        owned.blocker = createHttpServer((_request, response) =>
          response.end('Unrelated fixture app'),
        );
        await new Promise<void>((done) => owned.blocker!.listen(other, '127.0.0.1', done));
      }
      const process = launch(value, port);
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
        if (response?.ok) {
          ready = true;
          break;
        }
        await pause(25);
      }
      expect(ready, process.diagnostics()).toBe(true);
      const read = async (path: string) =>
        (
          await fetch(`http://127.0.0.1:${port}${path}`, {
            headers: { Authorization: (await ownerAuthorization(value.root, port, 'GET', path))! },
          })
        ).json();
      const status = await read('/api/phone/status');
      expect(status).toMatchObject({
        enabled: false,
        setupIssue: failure === 'occupied phone listener' ? 'listener' : 'configuration',
      });
      const snapshot = await read('/api/snapshot');
      expect(snapshot.projects).toHaveLength(1);
      if (owned.blocker)
        expect(await (await fetch(`http://127.0.0.1:${other}`)).text()).toBe(
          'Unrelated fixture app',
        );
      const disk = new Store(join(value.root, 'dock.sqlite'));
      expect(disk.getSetting('phone:configuration')).toBe(trust);
      expect(disk.getSetting('phone:enabled')).toBe(true);
      disk.close();
      process.child!.stdin!.end();
      expect((await deadline(process.finished!)).code).toBe(0);
      await preserved(value, port);
    },
  );

  it('an occupied local listener cannot dispatch work or stop the unrelated app', async () => {
    const value = fixture(),
      port = await unusedPort();
    const owned = fixtures.find((item) => item.root === value.root)!;
    owned.blocker = createHttpServer((_request, response) => response.end('Unrelated fixture app'));
    await new Promise<void>((done) => owned.blocker!.listen(port, '127.0.0.1', done));
    const process = launch(value, port);
    expect((await deadline(process.finished!)).code, process.diagnostics()).toBe(1);
    await preserved(value, port, true);
  });

  it('losing the launcher during an awaited startup check cannot dispatch work or orphan the server', async () => {
    const value = fixture(),
      port = await unusedPort();
    const process = launch(value, port, true);
    for (let count = 0; count < 100 && calls(value.root).length === 0; count++) await pause(20);
    expect(calls(value.root)).toHaveLength(1);
    process.child!.stdin!.end();
    expect((await deadline(process.finished!)).code, process.diagnostics()).toBe(0);
    await preserved(value, port);
  });

  it('both startup and shutdown admission reject model actions until the app is ready', async () => {
    const value = fixture();
    const store = new Store(join(value.root, 'dock.sqlite'));
    modelFixture(store);
    const runtime = new Runtime(store, value.root, 'never-called', async () => new DemoProvider());
    let ready = false;
    const app = await createServer(store, runtime, { port: 4599, demo: true, ready: () => ready });
    const options = {
      method: 'POST' as const,
      url: `/api/agents/${value.manager}/messages`,
      headers: {
        host: '127.0.0.1:4599',
        origin: 'http://127.0.0.1:4599',
        'content-type': 'application/json',
      },
      payload: { key: randomUUID(), text: 'Not while starting or stopping.' },
    };
    try {
      expect((await app.inject(options)).statusCode).toBe(503);
      const hint = await app.inject({ url: '/api/host-info', headers: options.headers });
      expect(hint.json()).toMatchObject({ code: 'APP_NOT_READY', protocolVersion: 1 });
      expect(hint.headers['retry-after']).toBe('1');
      ready = true;
      expect(
        (await app.inject({ url: '/api/host-info', headers: options.headers })).statusCode,
      ).toBe(200);
      ready = false;
      expect((await app.inject(options)).statusCode).toBe(503);
      expect(store.runs()).toEqual(value.original.runs);
    } finally {
      await app.close();
    }
  });
});
