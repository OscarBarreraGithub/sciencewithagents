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
import type { FolderPicker } from './folder-picker.js';

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
