import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as listen, type Server } from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { projectAppsStatusSchema, type ProjectApp } from '@dock/shared';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { DemoProvider } from './demo.js';
import { managerTool } from './manager-lease.fixture.js';
import { modelFixture } from './model-policy.fixture.js';
import { proxyPath } from './hosts.js';
import { ProjectApps, probeLoopbackPort } from './project-apps.js';
import { repoRoot } from './paths.js';

let root: string, store: Store, runtime: Runtime, app: FastifyInstance | undefined;
let managerId: string, projectId: string, otherManagerId: string;
const servers: Server[] = [];
const headers = { host: '127.0.0.1:4999', origin: 'http://127.0.0.1:4999' };
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/project-apps-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(join(root, 'news'), 'AI News', '', 'codex');
  const other = store.register(join(root, 'other'), 'Other project', '', 'codex');
  ({ id: projectId, managerId } = project);
  otherManagerId = other.managerId;
  runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
});
afterEach(async () => {
  // A started server owns the runtime and closes its store.
  if (app) await app.close();
  else store.close();
  app = undefined;
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  rmSync(root, { recursive: true, force: true });
});
const register = (input: unknown, key = randomUUID(), agent = managerId) =>
  managerTool(runtime, agent, key, 'dock_app', input) as Promise<ProjectApp>;
async function openPort() {
  const server = listen();
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as { port: number }).port;
}

it('keeps manager app registrations durable, receipt-idempotent and revision-checked', async () => {
  const key = randomUUID();
  const created = await register(
    { name: 'Daily digest', port: 5173, description: 'Headlines' },
    key,
  );
  expect(created).toMatchObject({ projectId, managerId, port: 5173, path: '/', revision: 1 });
  const appEvents = () =>
    store
      .events(0, 10_000)
      .filter((event) => event.type.startsWith('app.'))
      .map((event) => event.type);
  // A replayed tool call and a repeated registration after compaction are not new apps.
  expect(
    await register({ name: 'Daily digest', port: 5173, description: 'Headlines' }, key),
  ).toEqual(created);
  expect(await register({ name: 'daily digest', port: 5173, description: 'Headlines' })).toEqual(
    created,
  );
  expect(appEvents()).toEqual(['app.registered']);
  await expect(register({ name: 'Daily digest', port: 5174 })).rejects.toThrow(created.id);
  await expect(register({ id: created.id, expectedRevision: 0, port: 5174 })).rejects.toThrow(
    'current revision 1',
  );
  const moved = await register({ id: created.id, expectedRevision: 1, port: 5174, path: '/today' });
  expect(moved).toMatchObject({ id: created.id, port: 5174, path: '/today', revision: 2 });
  for (const invalid of [
    { name: 'Bad', port: 80 },
    { name: 'Bad', port: 5175, path: 'http://example.com' },
    { name: 'Bad', port: 5175, path: '//example.com' },
    { name: 'Bad', port: 5175, path: '/a/../b' },
    { name: 'Bad', port: 5175, remoteUrl: 'http://example.com' },
    { name: 'Bad', port: 5175, remoteUrl: 'https://user:pass@example.com' },
    { name: 'Bad', port: 5175, projectId: randomUUID() },
  ])
    await expect(register(invalid)).rejects.toThrow();
  runtime.apps.reserve([4999]);
  await expect(register({ name: 'Itself', port: 4999 })).rejects.toThrow('sciencewithagents');
  await expect(register({ name: 'Copy', port: 5174, path: '/today' })).rejects.toThrow(
    'already registered',
  );
  // Another project's manager cannot edit or remove this project's app.
  await expect(
    register(
      { id: created.id, expectedRevision: 2, action: 'remove' },
      randomUUID(),
      otherManagerId,
    ),
  ).rejects.toThrow('their own project');
  const worker = store.addAgent({
    projectId,
    taskId: null,
    parentId: managerId,
    name: 'Builder',
    role: 'implementer',
    cwd: root,
  });
  await expect(
    runtime.tool(worker.id, randomUUID(), 'dock_app', { name: 'X', port: 6000 }),
  ).rejects.toThrow('does not have that capability');
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  const restarted = new ProjectApps(store);
  expect(restarted.list(projectId)).toEqual([moved]);
  expect(appEvents()).toEqual(['app.registered', 'app.updated']);
});

it('reports running, stopped and unresponsive apps and removes them by revision', async () => {
  const running = await openPort();
  const stopped = await openPort();
  await new Promise((done) => servers.pop()!.close(done));
  expect(await probeLoopbackPort(running)).toBe('running');
  expect(await probeLoopbackPort(stopped)).toBe('stopped');
  const live = await register({ name: 'Live', port: running, remoteUrl: 'https://news.example' });
  await register({ name: 'Stopped', port: stopped });
  app = await createServer(store, runtime, { port: 4999 });
  const read = async () =>
    projectAppsStatusSchema.parse(
      (await app!.inject({ method: 'GET', url: '/api/apps', headers })).json(),
    );
  const status = await read();
  expect(status.openHere).toBe(true);
  expect(status.apps.map((a) => [a.name, a.state, a.projectName, a.localUrl])).toEqual([
    ['Live', 'running', 'AI News', `http://localhost:${running}/`],
    ['Stopped', 'stopped', 'AI News', `http://localhost:${stopped}/`],
  ]);
  expect(status.apps[0]!.remoteUrl).toBe('https://news.example');
  // A probe failure is shown as not responding, never as running.
  const slow = new ProjectApps(store, async () => {
    throw new Error('timed out');
  });
  expect((await slow.status(false)).apps.map((a) => a.state)).toEqual([
    'not_responding',
    'not_responding',
  ]);
  const remove = (payload: unknown) =>
    app!.inject({ method: 'POST', url: `/api/apps/${live.id}/remove`, headers, payload });
  expect((await remove({ key: randomUUID(), expectedRevision: 2 })).statusCode).toBe(409);
  const key = randomUUID();
  expect((await remove({ key, expectedRevision: 1 })).json()).toEqual({
    removed: true,
    id: live.id,
  });
  expect((await remove({ key, expectedRevision: 1 })).json()).toEqual({
    removed: true,
    id: live.id,
  });
  expect((await read()).apps.map((a) => a.name)).toEqual(['Stopped']);
  expect(proxyPath('GET', '/apps')).toBe('/api/apps');
  expect(proxyPath('POST', `/apps/${live.id}/remove`)).toBe(`/api/apps/${live.id}/remove`);
  for (const [method, path] of [
    ['POST', '/apps'],
    ['GET', '/apps?port=22'],
    ['POST', '/apps/register'],
    ['POST', `/apps/${live.id}/open`],
  ])
    expect(proxyPath(method!, path!)).toBeNull();
});
