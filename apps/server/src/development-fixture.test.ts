import { afterEach, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer as tcpServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { defaultModelPolicy } from '@dock/shared';
import { selectDevelopmentFixture, type DevelopmentFixture } from './development-fixture.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider, seedDemo } from './demo.js';
import { createServer } from './server.js';
import { repoRoot } from './paths.js';
import { CodexRpc } from './codex.js';
import { OwnerTerminals } from './owner-terminal.js';
import { freeLoopbackPort } from './cluster-notebooks.js';

const owned: string[] = [];
let app: Awaited<ReturnType<typeof createServer>> | undefined;
let runtime: Runtime | undefined;
let store: Store | undefined;
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) await closeChild(child);
  children.clear();
  await app?.close();
  app = undefined;
  await runtime?.close();
  runtime = undefined;
  store?.close();
  store = undefined;
  vi.restoreAllMocks();
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});
function newRoot() {
  mkdirSync(join(repoRoot, 'data/fixtures'), { recursive: true });
  const root = mkdtempSync(join(repoRoot, 'data/fixtures/test-'));
  owned.push(root);
  return root;
}
function select(root = newRoot(), port = 45421) {
  return selectDevelopmentFixture(
    ['--demo', '--fixture'],
    {
      DOCK_FIXTURE_ROOT: root,
      DOCK_PORT: String(port),
    },
    repoRoot,
  )!;
}
function demoStore(fixture: DevelopmentFixture) {
  const value = new Store(join(fixture.data, 'dock.sqlite'));
  const policy = structuredClone(defaultModelPolicy);
  policy.enabledProviders = ['codex'];
  for (const task of Object.keys(policy.providers) as (keyof typeof policy.providers)[])
    policy.providers[task] = 'codex';
  for (const tier of Object.keys(policy.models.codex) as (keyof typeof policy.models.codex)[])
    policy.models.codex[tier].model = 'demo';
  value.setSetting('model-policy', policy);
  seedDemo(value, fixture.workspace);
  return value;
}
async function closeChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Fixture did not reach expected state.');
}

it('fails visibly for incomplete, ambient, reserved, occupied-root and symlink selections', () => {
  const root = newRoot();
  const env = { DOCK_FIXTURE_ROOT: root, DOCK_PORT: '45421' };
  expect(() => selectDevelopmentFixture([], env, repoRoot)).toThrow('refusing production fallback');
  expect(() => selectDevelopmentFixture(['--fixture'], env, repoRoot)).toThrow('requires --demo');
  for (const port of ['', '0', '4330', '4331', '5178', '65536', 'nope'])
    expect(() =>
      selectDevelopmentFixture(['--demo', '--fixture'], { ...env, DOCK_PORT: port }, repoRoot),
    ).toThrow('DOCK_PORT');
  expect(() =>
    selectDevelopmentFixture(
      ['--demo', '--fixture'],
      { ...env, DOCK_DATA_DIR: '/ambient' },
      repoRoot,
    ),
  ).toThrow('DOCK_DATA_DIR');
  expect(() => select(repoRoot, 45421)).toThrow('data/fixtures');
  writeFileSync(join(root, 'existing.txt'), 'preserve');
  expect(() => select(root)).toThrow('not empty');
  expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('preserve');
  const target = newRoot(),
    linked = newRoot();
  symlinkSync(target, join(linked, 'alias'));
  expect(() => select(join(linked, 'alias'))).toThrow('symlink');
  const fixture = select();
  symlinkSync(target, join(fixture.data, 'dock.sqlite'));
  expect(() => select(fixture.root)).toThrow('Symlinks');
  const hardlinkFixture = select();
  linkSync(join(root, 'existing.txt'), join(hardlinkFixture.data, 'dock.sqlite'));
  expect(() => select(hardlinkFixture.root)).toThrow('hard links');
  expect(selectDevelopmentFixture([], {}, repoRoot)).toBeUndefined();
});

it('keeps normal saved chat/API paths while rejecting injected native/network canaries', async () => {
  const fixture = select();
  store = demoStore(fixture);
  runtime = new Runtime(
    store,
    fixture.data,
    '/never-provider',
    async (agent) => new DemoProvider(agent.cwd ?? fixture.workspace),
    undefined,
    { workspace: fixture.workspace },
  );
  const forbidden = () => {
    throw new Error('FORBIDDEN_CANARY_EXECUTED');
  };
  const spies = [
    vi.spyOn(CodexRpc.prototype, 'start').mockImplementation(forbidden),
    vi.spyOn(OwnerTerminals.prototype, 'open').mockImplementation(forbidden),
    vi.spyOn(runtime.capacity, 'start').mockImplementation(forbidden),
    vi.spyOn(runtime.capacity, 'refresh').mockImplementation(forbidden),
    vi.spyOn(runtime.resources, 'start').mockImplementation(forbidden),
    vi.spyOn(runtime.cluster, 'start').mockImplementation(forbidden),
    vi.spyOn(runtime.cluster, 'refresh').mockImplementation(forbidden),
    vi.spyOn(runtime.clusterSignIn, 'start').mockImplementation(forbidden),
    vi.spyOn(runtime.clusterNotebooks, 'open').mockImplementation(forbidden),
    vi.spyOn(runtime.codexSignIn, 'start').mockImplementation(forbidden),
    vi.spyOn(runtime.setup, 'refresh').mockImplementation(forbidden),
    vi.spyOn(runtime.claude, 'prepare').mockImplementation(forbidden),
    vi.spyOn(runtime.claude, 'account').mockImplementation(forbidden),
    vi.spyOn(runtime.browserSetup, 'check').mockImplementation(forbidden),
    vi.spyOn(runtime.claudeTranscripts, 'poll').mockImplementation(forbidden),
    vi.spyOn(runtime.providerMaintenance, 'tick').mockImplementation(forbidden),
    vi.spyOn(runtime.coordinator, 'tick').mockImplementation(forbidden),
    vi.spyOn(runtime.localJobs, 'start').mockImplementation(forbidden),
    vi.spyOn(globalThis, 'fetch').mockImplementation(forbidden),
  ];
  app = await createServer(store, runtime, { port: fixture.port, demo: true, ownsRuntime: false });
  await runtime.initialize();
  const manager = store.projects()[0]!.managerId;
  const headers = {
    host: `127.0.0.1:${fixture.port}`,
    origin: `http://127.0.0.1:${fixture.port}`,
    'content-type': 'application/json',
  };
  const blocked = [
    '/api/setup/sign-in',
    '/api/setup/check',
    '/api/setup/claude-sign-in',
    '/api/browser/check',
    '/api/providers/check',
    '/api/providers/update',
    '/api/capacity/refresh',
    '/api/cluster/refresh',
    '/api/cluster/sign-in',
    '/api/cluster/notebooks/open',
    '/api/phone/setup/check',
    '/api/phone/reconnect',
    '/api/owner-terminal',
    '/api/local-jobs',
    '/api/app-update/check',
    '/api/projects',
    '/api/projects/connect-folder',
    '/api/projects/track-folder',
    `/api/projects/${store.projects()[0]!.id}/backup/retry`,
    `/api/agents/${manager}/commands`,
    `/api/agents/${manager}/settings`,
    '/api/vscode/bridge',
    '/api/agent-client/register',
  ];
  for (const url of blocked) {
    const response = await app.inject({ method: 'POST', url, headers, payload: {} });
    expect(response.statusCode, url).toBe(403);
    expect(response.json().code).toBe('FIXTURE_ROUTE_DISABLED');
  }
  for (const url of [
    '/api/not-a-route',
    '/api/project-folders',
    `/api/projects/${store.projects()[0]!.id}/sessions`,
    `/api/agents/${manager}/mcp`,
    `/api/agents/${manager}/terminal`,
    '/api/owner-terminal/id/socket',
  ]) {
    const response = await app.inject({ url, headers });
    expect(response.statusCode, url).toBe(403);
  }
  const unsupported = await app.inject({ url: '/api/models?provider=claude', headers });
  expect(unsupported.statusCode).toBe(409);
  await expect(runtime.tool(manager, randomUUID(), 'dock_transcribe', {})).rejects.toThrow(
    'do not execute',
  );
  const sent = await app.inject({
    method: 'POST',
    url: `/api/agents/${manager}/messages`,
    headers,
    payload: { key: randomUUID(), text: 'Fixture chat stays local.' },
  });
  expect(sent.statusCode).toBe(202);
  await waitFor(
    async () => store!.runsForAgent(manager),
    (runs) => runs.some((r) => r.status === 'completed'),
  );
  expect(
    store
      .entries(manager)
      .some((e) => e.kind === 'assistant' && e.text.includes('no model was called')),
  ).toBe(true);
  const conversation = await app.inject({
    method: 'POST',
    url: '/api/conversations',
    headers,
    payload: {
      key: randomUUID(),
      name: 'Fixture conversation',
      provider: 'codex',
      model: 'demo',
      effort: 'medium',
    },
  });
  expect(conversation.statusCode).toBe(201);
  expect(store.agent(conversation.json().id).cwd.startsWith(fixture.data)).toBe(true);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

it('rejects copied native/foreign records before fixture startup can dispatch', () => {
  const fixture = select();
  store = demoStore(fixture);
  const manager = store.projects()[0]!.managerId;
  store.updateAgent(manager, { cwd: repoRoot });
  expect(
    () =>
      new Runtime(store!, fixture.data, '/never', async () => new DemoProvider(), undefined, {
        workspace: fixture.workspace,
      }),
  ).toThrow('unavailable');
});

function launch(fixture: DevelopmentFixture, env: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    [join(repoRoot, 'apps/server/dist/main.js'), '--demo', '--fixture'],
    {
      cwd: repoRoot,
      env: { ...env, DOCK_FIXTURE_ROOT: fixture.root, DOCK_PORT: String(fixture.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  let output = '';
  child.stdout!.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    output += String(chunk);
  });
  return { child, output: () => output };
}

it('starts the real main demo entry, serves built UI, retains a stub chat on restart and closes owned SSE/lock', async () => {
  const fixture = select(newRoot(), await freeLoopbackPort());
  const bin = join(fixture.root, 'canary-bin');
  mkdirSync(bin);
  const home = join(fixture.root, 'fake-home');
  mkdirSync(home);
  const canary = join(bin, 'canary');
  // Every accidental native executable in this bounded smoke writes only to this fixture.
  writeFileSync(canary, '#!/bin/sh\n: > "$FIXTURE_CANARY_FILE"\nexit 91\n', { mode: 0o700 });
  for (const name of [
    'codex',
    'claude',
    'ssh',
    'gh',
    'git',
    'cloudflared',
    'tailscale',
    'codexbar',
    'yt-dlp',
    'curl',
    'open',
    'launchctl',
    'tectonic',
    'latexmk',
    'pandoc',
    'ps',
    'vm_stat',
  ]) {
    writeFileSync(join(bin, name), readFileSync(canary), { mode: 0o700 });
  }
  const marker = join(fixture.root, 'canary-executed');
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    DOCK_CODEX_BIN: canary,
    DOCK_CLAUDE_BIN: canary,
    DOCK_CODEXBAR_BIN: canary,
    DOCK_CLOUDFLARED_BIN: canary,
    FIXTURE_CANARY_FILE: marker,
  };
  const origin = `http://127.0.0.1:${fixture.port}`;
  const peerFixture = select(newRoot(), await freeLoopbackPort());
  const peer = launch(peerFixture, env);
  await waitFor(
    async () => peer.output(),
    (output) => output.includes('(stub fixture):'),
  );
  const peerOrigin = `http://127.0.0.1:${peerFixture.port}`;
  const authenticatedFetch: typeof fetch = (url, init) => {
    const output = String(url).startsWith(peerOrigin) ? peer.output() : running.output();
    const token = /#fixture=([a-f0-9]{64})/.exec(output)?.[1];
    return fetch(url, { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } });
  };
  const peerSnapshot = await authenticatedFetch(`${peerOrigin}/api/snapshot`).then((r) => r.json());
  let running = launch(fixture, env);
  await waitFor(
    async () => running.output(),
    (output) => output.includes('(stub fixture):'),
  );
  const health = await authenticatedFetch(`${origin}/api/health`).then((r) => r.json());
  expect(health.demo).toBe(true);
  const html = await authenticatedFetch(origin).then((r) => r.text());
  expect(html).toContain('<div id="root">');
  expect(html).toContain('/assets/');
  const asset = /src="([^"]+\/assets\/[^"]+|\/assets\/[^"]+)"/.exec(html)?.[1];
  expect(asset).toBeDefined();
  expect((await authenticatedFetch(`${origin}${asset}`)).status).toBe(200);
  const snapshot = await authenticatedFetch(`${origin}/api/snapshot`).then((r) => r.json());

  const manager = snapshot.projects[0].managerId;
  expect(manager).not.toBe(peerSnapshot.projects[0].managerId);
  const request = {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ key: randomUUID(), text: 'Retain this fixture message.' }),
  };
  expect(
    (await authenticatedFetch(`${origin}/api/agents/${manager}/messages`, request)).status,
  ).toBe(202);
  const detail = await waitFor(
    async () => authenticatedFetch(`${origin}/api/agents/${manager}`).then((r) => r.json()),
    (value) => value.runs.some((r: { status: string }) => r.status === 'completed'),
  );
  expect(detail.entries.some((e: { text: string }) => e.text.includes('no model was called'))).toBe(
    true,
  );
  const stream = await authenticatedFetch(`${origin}/api/events`);
  const reader = stream.body!.getReader();
  await reader.read();
  await closeChild(running.child);
  await reader.cancel();
  expect(running.child.exitCode).toBe(0);
  expect(existsSync(join(fixture.data, 'server.lock'))).toBe(false);
  const persisted = new Store(join(fixture.data, 'dock.sqlite'));
  try {
    expect(persisted.projects()[0]!.root).toBe(fixture.workspace);
  } finally {
    persisted.close();
  }
  const peerDetail = await authenticatedFetch(
    `${peerOrigin}/api/agents/${peerSnapshot.projects[0].managerId}`,
  ).then((r) => r.json());
  expect(peerDetail.runs).toHaveLength(0);
  expect(peer.child.exitCode).toBeNull();
  running = launch(fixture, env);
  await waitFor(
    async () => running.output(),
    (output) => output.includes('(stub fixture):'),
  );
  const reloaded = await authenticatedFetch(`${origin}/api/agents/${manager}`).then((r) =>
    r.json(),
  );
  expect(reloaded.entries).toEqual(detail.entries);
  expect(existsSync(marker)).toBe(false);
  await closeChild(peer.child);
  expect(peer.child.exitCode).toBe(0);
  expect(existsSync(join(peerFixture.data, 'server.lock'))).toBe(false);
  await closeChild(running.child);
  expect(existsSync(join(fixture.data, 'server.lock'))).toBe(false);
}, 30000);

it('cleans an owned lock on listener failure and leaves the unrelated listener alive', async () => {
  const listener = tcpServer((socket) => socket.end('unrelated'));
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  try {
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('No listener');
    const fixture = select(newRoot(), address.port);
    const running = launch(fixture, { PATH: '', HOME: fixture.root });
    if (running.child.exitCode === null) await once(running.child, 'exit');
    expect(running.child.exitCode).toBe(1);
    expect(running.output()).toContain('EADDRINUSE');
    expect(existsSync(join(fixture.data, 'server.lock'))).toBe(false);
    expect(listener.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 15000);
