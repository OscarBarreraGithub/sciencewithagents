import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import type { Provider } from './codex.js';
import { git } from './workspaces.js';
import { repoRoot } from './paths.js';

let dir: string,
  file: string,
  store: Store,
  runtime: Runtime,
  manager: string,
  client: Provider,
  threadId: string;
const turnId = randomUUID();
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  dir = mkdtempSync(join(repoRoot, 'data/tests/assistant-phase-'));
  const projectRoot = join(dir, 'project');
  mkdirSync(projectRoot);
  await git(projectRoot, ['init', '-b', 'main']);
  await git(projectRoot, ['config', 'user.name', 'Dock Test']);
  await git(projectRoot, ['config', 'user.email', 'dock@example.invalid']);
  writeFileSync(join(projectRoot, 'README.md'), '# Fixture\n');
  await git(projectRoot, ['add', 'README.md']);
  await git(projectRoot, ['commit', '-m', 'Fixture']);
  file = join(dir, 'dock.sqlite');
  store = new Store(file);
  modelFixture(store);
  manager = store.register(projectRoot, 'Phase fixture', '').managerId;
  runtime = new Runtime(store, dir, 'codex', async () => new DemoProvider());
  ({ client, threadId } = await runtime.attach(manager));
});
afterEach(async () => {
  await runtime.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const flush = () => runtime.withLock(`provider:${manager}`, async () => {});
const notify = (method: string, params: unknown) => client.emit('notification', method, params);
const item = async (started: boolean, value: Record<string, unknown>) => {
  notify(started ? 'item/started' : 'item/completed', { threadId, turnId, item: value });
  await flush();
};
const delta = async (itemId: string, text: string) => {
  notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: text });
  await flush();
};
const tool = (n: number) =>
  store.entry({
    id: `${manager}:tool-${n}`,
    agentId: manager,
    runId: null,
    kind: 'tool',
    title: 'Tool',
    text: 'Recorded evidence',
    status: 'complete',
    createdAt: new Date().toISOString(),
  });

it('retains explicit commentary across deltas and an unphased completion after more than one page', async () => {
  const id = `${manager}:note`;
  await item(true, { id: 'note', type: 'agentMessage', text: '', phase: 'commentary' });
  expect(store.savedEntry(manager, id)?.phase).toBe('commentary');
  await delta('note', 'Checking. ');
  expect(store.savedEntry(manager, id)).toMatchObject({ phase: 'commentary', status: 'streaming' });
  for (let n = 0; n < 210; n++) tool(n);
  await delta('note', 'Still checking.');
  await item(false, { id: 'note', type: 'agentMessage', text: 'Checking. Still checking.' });
  const saved = store.savedEntry(manager, id)!;
  expect(saved).toMatchObject({ phase: 'commentary', status: 'complete' });
  expect(store.entries(manager).some((e) => e.id === id)).toBe(false); // Older than one page.
  await runtime.close();
  store.close();
  store = new Store(file);
  runtime = new Runtime(store, dir, 'codex', async () => new DemoProvider());
  expect(store.savedEntry(manager, id)).toEqual(saved);
});

it('maps final_answer to final and leaves absent, null or unrecognized phases unknown', async () => {
  await item(false, { id: 'done', type: 'agentMessage', text: 'Done.', phase: 'final_answer' });
  expect(store.savedEntry(manager, `${manager}:done`)?.phase).toBe('final');
  for (const [key, phase] of [
    ['none', undefined],
    ['null', null],
    ['other', 'final'],
    ['upper', 'FINAL_ANSWER'],
  ] as const) {
    await item(false, { id: key, type: 'agentMessage', text: 'Complete reply.', phase });
    const saved = store.savedEntry(manager, `${manager}:${key}`)!;
    expect(saved.status).toBe('complete');
    expect('phase' in saved).toBe(false);
  }
  // Phase never attaches to non-assistant items, even when a provider includes one.
  await item(false, { id: 'plan', type: 'plan', text: 'Steps', phase: 'final_answer' });
  expect('phase' in store.savedEntry(manager, `${manager}:plan`)!).toBe(false);
  // A later explicit phase on the same item replaces the earlier explicit value.
  await item(true, { id: 'swap', type: 'agentMessage', text: '', phase: 'commentary' });
  await item(false, { id: 'swap', type: 'agentMessage', text: 'Answer.', phase: 'final_answer' });
  expect(store.savedEntry(manager, `${manager}:swap`)?.phase).toBe('final');
});

it('keeps an older phase-unknown reply unknown through deltas, completion and reopen', async () => {
  const id = `${manager}:old`;
  // A reply saved before phase was retained.
  store.entry({
    id,
    agentId: manager,
    runId: null,
    kind: 'assistant',
    title: 'Manager',
    text: 'Earlier ',
    status: 'streaming',
    createdAt: new Date().toISOString(),
  });
  await delta('old', 'reply.');
  await item(false, { id: 'old', type: 'agentMessage', text: 'Earlier reply.' });
  await runtime.close();
  store.close();
  store = new Store(file);
  runtime = new Runtime(store, dir, 'codex', async () => new DemoProvider());
  const saved = store.savedEntry(manager, id)!;
  expect(saved).toMatchObject({ text: 'Earlier reply.', status: 'complete' });
  expect('phase' in saved).toBe(false);
});
