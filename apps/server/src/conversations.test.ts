import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { modelFixture } from './model-policy.fixture.js';
import { repoRoot } from './paths.js';
import { conversationCharter } from './charters.js';

let root: string, store: Store, runtime: Runtime, app: FastifyInstance;
const headers = {
  host: '127.0.0.1:4999',
  origin: 'http://127.0.0.1:4999',
  'content-type': 'application/json',
};
const input = () => ({ key: randomUUID(), name: 'Thoughts', provider: 'codex' as const });
const post = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/conversations', headers, payload: payload as object });
async function open() {
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  vi.spyOn(runtime.modelPolicy, 'catalog').mockImplementation(async (provider) => [
    {
      id: provider === 'codex' ? 'demo' : 'default',
      label: 'Test default',
      isDefault: true,
      efforts: ['medium', 'high'],
    },
    {
      id: provider === 'codex' ? 'gpt-future-luna' : 'claude-future-sonnet',
      label: 'Explicit native choice',
      isDefault: false,
      efforts: ['low', 'future-effort'],
    },
  ]);
  app = await createServer(store, runtime, { port: 4999 });
}
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/conversations-'));
  await open();
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

it('creates one empty private conversation through duplicate requests without a model turn', async () => {
  const value = input();
  const [first, repeated] = await Promise.all([post(value), post(value)]);
  expect(first.statusCode).toBe(201);
  expect(repeated.json()).toEqual(first.json());
  const agent = store.agent(first.json().id);
  expect(agent).toMatchObject({
    name: 'Thoughts',
    surface: 'misc',
    status: 'idle',
    threadId: null,
    cwd: join(root, 'conversations', value.key),
    modelSelection: 'policy',
    toolPolicy: 'native',
    permission: 'workspace-write',
    assignment: { taskClass: 'reasoning' },
  });
  expect(first.json()).not.toHaveProperty('cwd');
  expect(existsSync(join(agent.cwd, '.git'))).toBe(false);
  expect(store.runs()).toHaveLength(0);
  expect(store.entries(agent.id)).toHaveLength(0);
  expect(store.agents()).toHaveLength(1);
  expect(store.events().filter((event) => event.type === 'conversation.created')).toHaveLength(1);
  expect((await app.inject({ url: '/api/conversations', headers })).json().conversations).toEqual([
    first.json(),
  ]);
  const work = store.register(join(root, 'work-project'), 'Actual project', '');
  const projects = (await app.inject({ url: '/api/snapshot', headers })).json().projects;
  expect(projects.find((project: { id: string }) => project.id === agent.projectId).internal).toBe(
    true,
  );
  expect(projects.find((project: { id: string }) => project.id === work.id).internal).toBe(false);
});

it('retains exact choices, files, settings, and chat history when creation is retried after restart', async () => {
  const value = { ...input(), model: 'gpt-future-luna', effort: 'future-effort' };
  const first = (await post(value)).json();
  expect(first).toMatchObject({
    model: value.model,
    effort: value.effort,
    modelSelection: 'exact',
  });
  const cwd = store.agent(first.id).cwd;
  writeFileSync(join(cwd, 'notes.txt'), 'Keep this');
  store.entry({
    id: randomUUID(),
    agentId: first.id,
    runId: null,
    kind: 'user',
    title: 'You',
    text: 'Retain my question',
    status: 'completed',
    createdAt: new Date().toISOString(),
  });
  store.updateAgent(first.id, { name: 'Renamed later', checkpoint: 'Keep this handoff' });
  await app.close();
  await open();
  vi.mocked(runtime.modelPolicy.catalog).mockRejectedValue(new Error('Offline catalog'));
  expect((await post(value)).json()).toEqual(first);
  expect(store.agent(first.id)).toMatchObject({
    name: 'Renamed later',
    checkpoint: 'Keep this handoff',
    model: value.model,
    effort: value.effort,
  });
  expect(store.entries(first.id)[0].text).toBe('Retain my question');
  expect(readFileSync(join(cwd, 'notes.txt'), 'utf8')).toBe('Keep this');
  expect((await post({ ...value, name: 'Conflicting retry' })).statusCode).toBe(409);
  expect(store.agents()).toHaveLength(1);
});

it('keeps terminal-only Codex records searchable in the same list and rejects Claude terminal creation', async () => {
  const terminal = await post({ ...input(), saveContact: false });
  expect(terminal.statusCode).toBe(201);
  expect(terminal.json().surface).toBe('terminal');
  const claude = await post({
    ...input(),
    provider: 'claude',
    model: 'claude-future-sonnet',
    effort: 'low',
  });
  expect(claude.statusCode).toBe(201);
  expect(claude.json()).toMatchObject({
    surface: 'misc',
    provider: 'claude',
    model: 'claude-future-sonnet',
    effort: 'low',
  });
  expect((await post({ ...input(), provider: 'claude', saveContact: false })).statusCode).toBe(400);
  expect(
    (await app.inject({ url: '/api/conversations', headers })).json().conversations,
  ).toHaveLength(2);
  expect(store.runs()).toHaveLength(0);
});

it('uses the direct conversation charter with native capabilities and retains its private write mode in settings', async () => {
  const agent = (await post(input())).json();
  const settings = await app.inject({
    method: 'POST',
    url: `/api/agents/${agent.id}/settings`,
    headers,
    payload: {
      model: 'demo',
      effort: 'medium',
      permission: 'workspace-write',
      toolPolicy: 'native',
    },
  });
  expect(settings.statusCode).toBe(200);
  const client = await runtime.client(store.agent(agent.id));
  const request = vi.spyOn(client, 'request');
  await runtime.attach(agent.id);
  const start = request.mock.calls.find(([method]) => method === 'thread/start')![1];
  expect(start).toMatchObject({
    cwd: store.agent(agent.id).cwd,
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    developerInstructions: conversationCharter,
    config: { 'sandbox_workspace_write.network_access': true },
  });
  expect(request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  expect(store.runs()).toHaveLength(0);
});

it('rejects unknown catalog choices and caller paths before creating storage', async () => {
  expect((await post({ ...input(), model: 'invented' })).statusCode).toBe(409);
  expect((await post({ ...input(), model: 'demo', effort: 'max' })).statusCode).toBe(409);
  expect((await post({ ...input(), cwd: '/tmp/other-project' })).statusCode).toBe(400);
  expect(existsSync(join(root, 'conversations'))).toBe(false);
  expect(store.agents()).toHaveLength(0);
});

it('recovers a registration failure with the same reserved model and rejects substituted folders', async () => {
  const value = input();
  vi.spyOn(store, 'register').mockImplementationOnce(() => {
    throw new Error('Interrupted registration');
  });
  expect((await post(value)).statusCode).toBe(500);
  await app.close();
  await open();
  vi.mocked(runtime.modelPolicy.catalog).mockRejectedValue(
    new Error('Catalog no longer available'),
  );
  expect((await post(value)).statusCode).toBe(201);
  expect(store.agents()).toHaveLength(1);
  const other = input();
  vi.mocked(runtime.modelPolicy.catalog).mockResolvedValue([
    { id: 'demo', label: 'Demo', isDefault: true, efforts: ['medium'] },
  ]);
  const target = join(root, 'outside');
  mkdirSync(target);
  writeFileSync(join(target, 'keep.txt'), 'untouched');
  symlinkSync(target, join(root, 'conversations', other.key));
  expect((await post(other)).statusCode).toBe(409);
  expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('untouched');
  expect(store.agents()).toHaveLength(1);
});
