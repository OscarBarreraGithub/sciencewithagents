import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { DemoProvider } from './demo.js';
import { repoRoot } from './paths.js';
import { checkpointWorktree, ensureWorktree, git } from './workspaces.js';

let root: string, store: Store, app: FastifyInstance;
let openEditor = vi.fn(async (_root: string) => {});
const headers = {
  host: '127.0.0.1:4999',
  origin: 'http://127.0.0.1:4999',
  'content-type': 'application/json',
};
const input = () => ({
  key: randomUUID(),
  name: 'My garden',
  description: 'Keep a gardening journal.',
});
const post = (payload: unknown, requestHeaders = headers) =>
  app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: requestHeaders,
    payload: payload as object,
  });
async function open() {
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  app = await createServer(store, runtime, { port: 4999, editorOpener: openEditor });
}
beforeEach(async () => {
  openEditor = vi.fn(async (_root: string) => {});
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/projects-'));
  await open();
});

it('opens only a registered project in the editor once per receipt and retains project workflow choices', async () => {
  const project = (await post(input())).json();
  const url = `/api/projects/${project.id}/open-in-editor`;
  const payload = { key: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await app.inject({ method: 'POST', url, headers, payload });
    expect(result.statusCode).toBe(200);
    expect(result.json().opened).toBe(true);
  }
  expect(openEditor).toHaveBeenCalledExactlyOnceWith(store.project(project.id).root);
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { ...payload, root: '/unregistered' },
      })
    ).statusCode,
  ).toBe(400);
  const workflowUrl = `/api/projects/${project.id}/workflow`;
  const workflow = (await app.inject({ url: workflowUrl, headers })).json();
  expect(workflow).toMatchObject({
    reviewPlan: true,
    ambiguity: 'continue',
    applyChanges: 'manager',
  });
  const save = {
    key: randomUUID(),
    expectedRevision: workflow.revision,
    workflow: { ...workflow, ambiguity: 'ask-human', reviewPlan: false },
  };
  const saved = await app.inject({ method: 'POST', url: workflowUrl, headers, payload: save });
  expect(saved.statusCode).toBe(200);
  await app.close();
  await open();
  const repeated = await app.inject({ method: 'POST', url: workflowUrl, headers, payload: save });
  expect(repeated.json()).toEqual(saved.json());
  expect((await app.inject({ url: workflowUrl, headers })).json()).toMatchObject({
    reviewPlan: false,
    ambiguity: 'ask-human',
  });
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

it('creates one private ready-to-work project, without a model call or personal Git setup', async () => {
  const value = input();
  const [first, duplicate] = await Promise.all([post(value), post(value)]);
  expect(first.statusCode).toBe(201);
  expect(duplicate.json()).toEqual(first.json());
  const project = store.project(first.json().id);
  expect(first.json()).not.toHaveProperty('root');
  expect(project.root).toMatch(new RegExp(`^${root}/projects/[a-f0-9-]+$`));
  expect(store.projects()).toHaveLength(1);
  expect(store.agents()).toHaveLength(1);
  expect(store.agent(project.managerId)).toMatchObject({
    role: 'manager',
    status: 'idle',
    threadId: null,
  });
  expect(store.runs()).toHaveLength(0);
  expect(store.entries(project.managerId)).toHaveLength(0);
  expect(await git(project.root, ['status', '--porcelain'])).toBe('');
  expect(await git(project.root, ['rev-list', '--count', 'HEAD'])).toBe('1');
  expect(await git(project.root, ['log', '-1', '--format=%an <%ae>'])).toBe(
    'sciencewithagents <agent-dock@localhost>',
  );
  const task = store.addTask(project.id, {
    title: 'Write a note',
    goal: 'A harmless note',
    acceptance: 'The note is saved',
    parentId: null,
  });
  const worktree = await ensureWorktree(store, task, root);
  writeFileSync(join(worktree, 'note.txt'), 'A gardening note.\n');
  await checkpointWorktree(store, task.id);
  expect(await git(worktree, ['status', '--porcelain'])).toBe('');
  expect(await git(worktree, ['log', '-1', '--format=%an <%ae>'])).toBe(
    'sciencewithagents <agent-dock@localhost>',
  );
  expect(store.events().filter((event) => event.type === 'project.created')).toHaveLength(1);
});

it('retains a completed creation receipt through restart without touching later project work', async () => {
  const value = input();
  const first = (await post(value)).json();
  writeFileSync(join(store.project(first.id).root, 'owner-note.txt'), 'Keep this.');
  const archive = store.events();
  await app.close();
  await open();
  expect((await post(value)).json()).toEqual(first);
  expect(readFileSync(join(store.project(first.id).root, 'owner-note.txt'), 'utf8')).toBe(
    'Keep this.',
  );
  expect(store.events()).toEqual(archive);
  expect((await post({ ...value, name: 'Different' })).statusCode).toBe(409);
  expect(store.projects()).toHaveLength(1);
});

it('recovers a setup interrupted after Git initialization without a duplicate commit or project', async () => {
  const value = input();
  vi.spyOn(store, 'register').mockImplementationOnce(() => {
    throw new Error(`/private/secret/path could not save`);
  });
  const failed = await post(value);
  expect(failed.statusCode).toBe(409);
  expect(failed.body).not.toContain('/private/secret');
  expect(store.projects()).toHaveLength(0);
  expect(store.agents()).toHaveLength(0);
  const projectRoot = join(root, 'projects', readdirSync(join(root, 'projects'))[0]);
  const head = await git(projectRoot, ['rev-parse', 'HEAD']);
  await app.close();
  await open();
  expect((await post(value)).statusCode).toBe(201);
  expect(store.projects()).toHaveLength(1);
  expect(await git(projectRoot, ['rev-parse', 'HEAD'])).toBe(head);
  expect(
    store.events().filter((event) => event.type === 'project.creation_requested'),
  ).toHaveLength(1);
  expect(store.events().filter((event) => event.type === 'project.creation_failed')).toHaveLength(
    1,
  );
});

it('rejects paths, commands, invalid names and cross-origin creation before any filesystem work', async () => {
  for (const payload of [
    { ...input(), root: '/tmp/anything' },
    { ...input(), command: 'whoami' },
    { ...input(), name: '   ' },
    { ...input(), name: 'x'.repeat(101) },
    { ...input(), key: '../elsewhere' },
    { ...input(), name: 'bad\u0000name' },
  ])
    expect((await post(payload)).statusCode).toBe(400);
  expect((await post(input(), { ...headers, origin: 'https://example.invalid' })).statusCode).toBe(
    403,
  );
  expect(readdirSync(root)).not.toContain('projects');
  expect(store.projects()).toHaveLength(0);
});

it('does not follow a substituted managed project directory', async () => {
  const target = join(root, 'unrelated');
  mkdirSync(target);
  writeFileSync(join(target, 'keep.txt'), 'Do not touch.');
  symlinkSync(target, join(root, 'projects'), 'dir');
  expect((await post(input())).statusCode).toBe(409);
  expect(readdirSync(target)).toEqual(['keep.txt']);
  expect(store.projects()).toHaveLength(0);
});

it('does not adopt an unfinished reserved folder containing unexpected files or a Git symlink', async () => {
  for (const kind of ['file', 'symlink']) {
    const value = input(),
      directoryId = randomUUID();
    store.setSetting(`project-create:${value.key}`, {
      directoryId,
      name: value.name,
      description: value.description,
    });
    const reserved = join(root, 'projects', directoryId);
    mkdirSync(reserved, { recursive: true });
    if (kind === 'file') writeFileSync(join(reserved, 'keep.txt'), 'Leave this alone.');
    else symlinkSync(root, join(reserved, '.git'), 'dir');
    expect((await post(value)).statusCode).toBe(409);
    expect(readdirSync(reserved)).toEqual([kind === 'file' ? 'keep.txt' : '.git']);
  }
  expect(store.projects()).toHaveLength(0);
});
