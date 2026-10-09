import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  renameSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { DemoProvider } from './demo.js';
import { tmpdir } from 'node:os';
import { git } from './workspaces.js';
import { FolderConnections, type FolderPicker } from './folder-picker.js';

let root: string, projectRoot: string, store: Store, app: FastifyInstance;
const picker = vi.fn<FolderPicker>();
const headers = {
  host: '127.0.0.1:4999',
  origin: 'http://127.0.0.1:4999',
  'content-type': 'application/json',
};
const track = (key: string) =>
  app.inject({
    method: 'POST',
    url: '/api/projects/track-folder',
    headers,
    payload: { key, confirmedTracking: true },
  });
const post = (key = randomUUID()) =>
  app.inject({ method: 'POST', url: '/api/projects/connect-folder', headers, payload: { key } });
async function open() {
  const dataDir = join(root, 'runtime');
  store = new Store(join(dataDir, 'dock.sqlite'));
  modelFixture(store);
  const runtime = new Runtime(store, dataDir, 'codex', async () => new DemoProvider());
  app = await createServer(store, runtime, { port: 4999, folderPicker: picker });
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'swa-folders-'));
  projectRoot = join(root, 'My project');
  mkdirSync(projectRoot);
  await git(projectRoot, ['init', '--template=', '--initial-branch=main']);
  await git(projectRoot, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'Original',
  ]);
  picker.mockReset().mockResolvedValue(projectRoot);
  await open();
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

it('connects only the native-selected folder without changing its files, Git history or config', async () => {
  writeFileSync(join(projectRoot, 'owner.txt'), 'Keep my unfinished work.');
  const config = readFileSync(join(projectRoot, '.git/config'), 'utf8');
  const head = await git(projectRoot, ['rev-parse', 'HEAD']);
  const key = randomUUID();
  const response = await post(key);
  expect(response.statusCode).toBe(200);
  expect(response.json().project.name).toBe('My project');
  expect(response.body).not.toContain(projectRoot);
  expect(store.projects()).toHaveLength(1);
  expect(store.runs()).toHaveLength(0);
  const events = store.events();
  await app.close();
  await open();
  expect((await post(key)).json()).toEqual(response.json());
  expect(picker).toHaveBeenCalledTimes(1);
  expect(store.events()).toEqual(events);
  expect(await git(projectRoot, ['rev-parse', 'HEAD'])).toBe(head);
  expect(readFileSync(join(projectRoot, 'owner.txt'), 'utf8')).toBe('Keep my unfinished work.');
  expect(readFileSync(join(projectRoot, '.git/config'), 'utf8')).toBe(config);
});

it('cancellation does not create a project or stop another user journey', async () => {
  picker.mockResolvedValueOnce(null);
  expect((await post()).json()).toEqual({ project: null });
  expect(store.projects()).toHaveLength(0);
  expect(store.events()).toHaveLength(0);
  expect((await post()).json().project.name).toBe('My project');
});

it('shared selection trusts only retained folder identities outside private app storage and its ancestors', async () => {
  const folders = new FolderConnections(store, join(root, 'runtime'), picker);
  const key = randomUUID();
  await folders.connect(key, undefined, true);
  expect(folders.sharedSelection(key)).toMatchObject({ key, root: realpathSync(projectRoot) });
  expect(() => folders.sharedSelection(randomUUID())).toThrow('Choose the shared folder');
  await expect(folders.connect(randomUUID(), undefined, true, projectRoot)).rejects.toThrow();
  expect(store.projects()).toEqual([]);
  const parentKey = randomUUID();
  await git(root, ['init', '--template=', '--initial-branch=main']);
  await git(root, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'Ancestor fixture',
  ]);
  picker.mockResolvedValue(root);
  await folders.connect(parentKey, undefined, true);
  expect(() => folders.sharedSelection(parentKey)).toThrow('private storage');
  const renamed = `${projectRoot}-original`;
  renameSync(projectRoot, renamed);
  mkdirSync(projectRoot);
  expect(() => folders.sharedSelection(key)).toThrow('changed or is unavailable');
  expect(store.projects()).toEqual([]);
  expect(store.runs()).toEqual([]);
});

it('Spawn starts a fresh manager in a previously connected folder, with durable retries and separate settings', async () => {
  const original = (await post()).json().project;
  store.updateAgent(original.managerId, {
    threadId: 'old-provider-conversation',
    checkpoint: 'September work',
    createdAt: '2026-09-07T18:05:16.092Z',
  });
  const oldProject = { ...store.project(original.id), internal: true };
  store.db
    .prepare('UPDATE projects SET body=? WHERE id=?')
    .run(JSON.stringify(oldProject), original.id);
  const oldManager = store.agent(original.managerId);
  const oldWorkflow = store.getSetting(`project-workflow:${original.id}`);
  writeFileSync(
    join(projectRoot, 'old-session.jsonl'),
    '{"text":"Do not adopt this conversation"}\n',
  );
  const key = randomUUID();
  await app.inject({
    method: 'POST',
    url: '/api/projects/connect-folder',
    headers,
    payload: { key, selectOnly: true },
  });
  const input = {
    method: 'POST' as const,
    url: '/api/projects/connect-folder',
    headers,
    payload: { key, name: 'My new app', provider: 'claude', fresh: true },
  };
  const result = await app.inject(input);
  expect(result.statusCode).toBe(200);
  const created = result.json().project;
  expect(created.id).not.toBe(original.id);
  expect(created.managerId).not.toBe(original.managerId);
  expect(created.name).toBe('My new app');
  expect(created.internal).not.toBe(true);
  expect(store.agent(created.managerId)).toMatchObject({
    threadId: null,
    checkpoint: '',
    provider: 'claude',
  });
  expect(store.entries(created.managerId)).toEqual([]);
  expect(store.runs()).toEqual([]);
  expect(store.project(created.id).root).toBe(oldProject.root);
  expect(store.project(original.id)).toEqual(oldProject);
  expect(store.agent(original.managerId)).toEqual(oldManager);
  expect(store.getSetting(`project-workflow:${original.id}`)).toEqual(oldWorkflow);
  await app.close();
  await open();
  const [first, second] = await Promise.all([app.inject(input), app.inject(input)]);
  expect(first.json()).toEqual(result.json());
  expect(second.json()).toEqual(result.json());
  expect(store.projects()).toHaveLength(2);
  expect(
    (await app.inject({ ...input, payload: { ...input.payload, name: 'Changed' } })).statusCode,
  ).toBe(409);
  expect(readFileSync(join(projectRoot, 'old-session.jsonl'), 'utf8')).toContain('Do not adopt');
});

it('removes idle managers durably, cancels queued work and retains files and conversation history', async () => {
  const first = (await post()).json().project;
  const second = store.addManager(first.id, 'Another manager', 'Independent work');
  writeFileSync(join(projectRoot, 'owner.txt'), 'Keep this file.');
  const queued = store.enqueue(first.managerId, randomUUID(), 'A queued idea');
  const other = store.enqueue(second.id, randomUUID(), 'Another idea');
  const task = store.addTask(first.id, {
    title: 'Child work',
    goal: 'Verify removal',
    acceptance: 'Retained files',
    parentId: null,
  });
  const worker = store.addAgent({
    projectId: first.id,
    parentId: first.managerId,
    taskId: task.id,
    name: 'Worker',
    role: 'implementer',
    cwd: projectRoot,
  });
  const workerRun = store.enqueue(worker.id, randomUUID(), 'Worker idea');
  const history = store.entries(first.managerId);
  const input = {
    method: 'POST' as const,
    url: `/api/agents/${first.managerId}/remove`,
    headers,
    payload: { key: randomUUID() },
  };
  store.updateAgent(first.managerId, { status: 'running' });
  expect((await app.inject(input)).statusCode).toBe(409);
  expect(store.agent(first.managerId).archivedAt).toBeUndefined();
  expect(store.run(queued.id).status).toBe('queued');
  store.updateAgent(first.managerId, { status: 'queued' });
  store.updateAgent(worker.id, { status: 'running' });
  expect((await app.inject(input)).statusCode).toBe(409);
  store.updateAgent(worker.id, { status: 'queued' });
  const response = await app.inject(input);
  expect(response.statusCode).toBe(200);
  expect(response.json().archivedAt).toBeTruthy();
  expect(store.run(queued.id).status).toBe('cancelled');
  expect(store.run(workerRun.id).status).toBe('cancelled');
  expect(store.task(task.id).status).toBe('cancelled');
  expect(store.agent(worker.id).archivedAt).toBeTruthy();
  expect(() => store.enqueue(worker.id, randomUUID(), 'Restart worker')).toThrow('removed');
  expect(store.run(other.id).status).toBe('queued');
  expect(store.agent(second.id).archivedAt).toBeUndefined();
  expect(store.entries(first.managerId)).toEqual(history);
  expect(() => store.enqueue(first.managerId, randomUUID(), 'Restart')).toThrow('removed');
  await app.close();
  await open();
  expect((await app.inject(input)).json()).toEqual(response.json());
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/agents/${first.managerId}/messages`,
        headers,
        payload: { key: randomUUID(), text: 'Try again' },
      })
    ).statusCode,
  ).toBe(409);
  expect(readFileSync(join(projectRoot, 'owner.txt'), 'utf8')).toBe('Keep this file.');
  expect(store.events().filter((event) => event.type === 'manager.removed')).toHaveLength(1);
});

it.each([false, true])(
  'selects first without creating a manager or history (needs tracking: %s)',
  async (needsTracking) => {
    const folder = needsTracking ? join(root, 'Untracked notes') : projectRoot;
    if (needsTracking) {
      mkdirSync(folder);
      writeFileSync(join(folder, 'notes.txt'), 'Keep my notes.');
    }
    picker.mockResolvedValue(folder);
    const key = randomUUID();
    const select = () =>
      app.inject({
        method: 'POST',
        url: '/api/projects/connect-folder',
        headers,
        payload: { key, selectOnly: true },
      });
    const selected = await select();
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toEqual({
      project: null,
      selection: {
        key,
        name: needsTracking ? 'Untracked notes' : 'My project',
        needsTracking,
        workspacePath: realpathSync(folder),
      },
    });
    expect(selected.json().selection.workspacePath).toBe(realpathSync(folder));
    expect(store.projects()).toEqual([]);
    expect(store.agents()).toEqual([]);
    if (needsTracking) expect(existsSync(join(folder, '.git'))).toBe(false);
    // Selecting a folder survives restart without another picker, and does not
    // pin the manager provider before the person finishes the setup form.
    await app.close();
    await open();
    expect((await select()).json()).toEqual(selected.json());
    expect(picker).toHaveBeenCalledTimes(1);
    const spawn = () =>
      app.inject({
        method: 'POST',
        url: '/api/projects/connect-folder',
        headers,
        payload: { key, provider: 'claude', name: 'Planetary observations', fresh: true },
      });
    let result = await spawn();
    expect(result.statusCode).toBe(200);
    if (needsTracking) {
      expect(result.json().tracking.key).toBe(key);
      expect(existsSync(join(folder, '.git'))).toBe(false);
      result = await track(key);
    }
    expect(store.projects()).toHaveLength(1);
    expect(result.json().project.name).toBe('Planetary observations');
    expect(store.projects()[0]!.root).toBe(await git(folder, ['rev-parse', '--show-toplevel']));
    expect(store.agent(result.json().project.managerId).name).toBe('Planetary observations');
    expect(store.agent(result.json().project.managerId).provider).toBe('claude');
    await app.close();
    await open();
    expect((await spawn()).json()).toEqual(result.json());
    const changed = await app.inject({
      method: 'POST',
      url: '/api/projects/connect-folder',
      headers,
      payload: { key, provider: 'claude', name: 'Different name', fresh: true },
    });
    expect(changed.statusCode).toBe(409);
    expect(picker).toHaveBeenCalledTimes(1);
    expect(store.runs()).toEqual([]);
    expect((await post()).json().project).toEqual(result.json().project);
  },
);

it('does not submit a replacement for the folder selected earlier', async () => {
  const key = randomUUID();
  await app.inject({
    method: 'POST',
    url: '/api/projects/connect-folder',
    headers,
    payload: { key, selectOnly: true },
  });
  renameSync(projectRoot, join(root, 'Original'));
  mkdirSync(projectRoot);
  expect((await post(key)).statusCode).toBe(409);
  expect(store.projects()).toEqual([]);
  expect(existsSync(join(projectRoot, '.git'))).toBe(false);
});

it('pins a selected Claude manager to the folder receipt without changing existing projects or starting work', async () => {
  const key = randomUUID();
  const input = {
    method: 'POST' as const,
    url: '/api/projects/connect-folder',
    headers,
    payload: { key, provider: 'claude' },
  };
  const response = await app.inject(input);
  expect(response.statusCode).toBe(200);
  expect(store.agent(response.json().project.managerId).provider).toBe('claude');
  expect((await app.inject(input)).json()).toEqual(response.json());
  expect((await post(key)).statusCode).toBe(409);
  expect(picker).toHaveBeenCalledTimes(1);
  expect(store.runs()).toEqual([]);
  expect((await post()).json()).toEqual(response.json());
  expect(store.agent(response.json().project.managerId).provider).toBe('claude');
});

it('shares a matching pending chooser and refuses a second unrelated chooser', async () => {
  let finish!: (value: string | null) => void;
  picker.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const key = randomUUID();
  const first = post(key);
  await vi.waitFor(() => expect(picker).toHaveBeenCalledTimes(1));
  const duplicate = post(key);
  expect((await post()).statusCode).toBe(409);
  finish(projectRoot);
  expect((await duplicate).json()).toEqual((await first).json());
  expect(picker).toHaveBeenCalledTimes(1);
  expect(store.projects()).toHaveLength(1);
});

it('rejects browser-selected paths and invalid native selections without leaking paths', async () => {
  const forged = await app.inject({
    method: 'POST',
    url: '/api/projects/connect-folder',
    headers,
    payload: { key: randomUUID(), path: projectRoot },
  });
  expect(forged.statusCode).toBe(400);
  expect(picker).not.toHaveBeenCalled();
  picker.mockResolvedValueOnce(root);
  const invalid = await post();
  expect(invalid.statusCode).toBe(409);
  expect(invalid.body).not.toContain(root);
  expect(store.projects()).toHaveLength(0);
});

it('cancels the native chooser during gateway shutdown rather than leaving a hanging request', async () => {
  picker.mockImplementationOnce(
    (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(null))),
  );
  const pending = post();
  await vi.waitFor(() => expect(picker).toHaveBeenCalledTimes(1));
  await app.close();
  expect((await pending).json()).toEqual({ project: null });
  await open();
  expect(store.projects()).toHaveLength(0);
});

it('previews an ordinary folder, then saves an explicit local starting version without modifying its files', async () => {
  const folder = join(root, 'Ordinary notes');
  mkdirSync(folder);
  writeFileSync(join(folder, 'notes.txt'), 'Keep this evidence.');
  writeFileSync(join(folder, '.gitignore'), 'scratch.txt\n');
  writeFileSync(join(folder, 'scratch.txt'), 'Untracked by owner');
  writeFileSync(join(folder, '.env'), 'PRIVATE=value');
  mkdirSync(join(folder, 'node_modules'));
  writeFileSync(join(folder, 'node_modules', 'dependency.js'), 'Do not copy');
  picker.mockResolvedValueOnce(folder);
  const key = randomUUID(),
    selected = await post(key);
  expect(selected.statusCode).toBe(200);
  expect(selected.json()).toEqual({ project: null, tracking: { key, name: 'Ordinary notes' } });
  expect(selected.body).not.toContain(folder);
  expect(existsSync(join(folder, '.git'))).toBe(false);
  expect(store.projects()).toHaveLength(0);
  await app.close();
  await open();
  expect((await post(key)).json()).toEqual(selected.json());
  const result = await track(key);
  expect(result.statusCode).toBe(200);
  expect(result.json().project.name).toBe('Ordinary notes');
  expect(await git(folder, ['ls-files'])).toBe('.gitignore\nnotes.txt');
  expect(readFileSync(join(folder, 'notes.txt'), 'utf8')).toBe('Keep this evidence.');
  expect(readFileSync(join(folder, '.env'), 'utf8')).toBe('PRIVATE=value');
  expect(readFileSync(join(folder, '.gitignore'), 'utf8')).toBe('scratch.txt\n');
  const head = await git(folder, ['rev-parse', 'HEAD']);
  await app.close();
  await open();
  expect((await track(key)).json()).toEqual(result.json());
  expect((await post(key)).json()).toEqual(result.json());
  expect(await git(folder, ['rev-parse', 'HEAD'])).toBe(head);
  expect(store.projects()).toHaveLength(1);
  expect(store.runs()).toHaveLength(0);
  expect(picker).toHaveBeenCalledTimes(1);
});

it('retries partial tracking setup and coalesces duplicate confirmations for the original provider', async () => {
  const folder = join(root, 'Partial');
  mkdirSync(folder);
  picker.mockResolvedValueOnce(folder);
  const key = randomUUID();
  await app.inject({
    method: 'POST',
    url: '/api/projects/connect-folder',
    headers,
    payload: { key, provider: 'claude' },
  });
  const path = process.env.PATH;
  try {
    process.env.PATH = join(root, 'missing-tools');
    expect((await track(key)).statusCode).toBe(409);
  } finally {
    process.env.PATH = path;
  }
  expect(store.projects()).toHaveLength(0);
  expect(existsSync(join(folder, '.git', 'sciencewithagents-init'))).toBe(true);
  await app.close();
  await open();
  const newKey = randomUUID();
  picker.mockResolvedValueOnce(folder);
  expect((await post(newKey)).json().tracking.key).toBe(newKey);
  const [first, second] = await Promise.all([track(key), track(newKey)]);
  expect(first.statusCode).toBe(200);
  expect(second.json()).toEqual(first.json());
  expect(store.agent(first.json().project.managerId).provider).toBe('claude');
  expect(await git(folder, ['rev-list', '--count', 'HEAD'])).toBe('1');
  expect(store.runs()).toHaveLength(0);
});

it('refuses substituted folders, newly created unrelated history and invented confirmation paths', async () => {
  const folder = join(root, 'Selected');
  mkdirSync(folder);
  picker.mockResolvedValueOnce(folder);
  const key = randomUUID();
  await post(key);
  renameSync(folder, join(root, 'Moved'));
  mkdirSync(folder);
  expect((await track(key)).statusCode).toBe(409);
  expect(existsSync(join(folder, '.git'))).toBe(false);
  const second = randomUUID();
  picker.mockResolvedValueOnce(folder);
  await post(second);
  await git(folder, ['init', '--template=', '--initial-branch=owner']);
  const config = readFileSync(join(folder, '.git/config'), 'utf8');
  expect((await track(second)).statusCode).toBe(409);
  expect(readFileSync(join(folder, '.git/config'), 'utf8')).toBe(config);
  expect((await track(randomUUID())).statusCode).toBe(409);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/projects/track-folder',
        headers,
        payload: { key, confirmedTracking: true, path: folder },
      })
    ).statusCode,
  ).toBe(400);
  expect(store.projects()).toHaveLength(0);
});
