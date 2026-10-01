import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store } from './store.js';
import { historyPage, historyRead } from './history.js';
import { repoRoot } from './paths.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { modelFixture } from './model-policy.fixture.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);
it('retains and searches more than 1000 Unicode multiline entries through paging and database reopen', () => {
  const base = join(repoRoot, 'data/beta-campaign-20261001/13-history');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'durability-'));
  let store = new Store(join(root, 'dock.sqlite'));
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = store.register(root, 'Long chat', '');
  const text = 'EARLIEST_NEEDLE 🧪 café 漢字\nSecond line\n' + 'x'.repeat(16000);
  const ids: string[] = [];
  for (let index = 0; index < 1205; index++) {
    const id = randomUUID();
    ids.push(id);
    store.entry({
      id,
      agentId: project.managerId,
      runId: null,
      kind: 'assistant',
      title: 'Saved reply',
      text: index === 0 ? text : `Reply ${index}`,
      status: 'complete',
      createdAt: '2026-10-01T10:00:00.000Z',
    });
  }
  const readAll = () => {
    let page = store.entries(project.managerId);
    const found = [...page];
    while (page.length) {
      page = store.entries(project.managerId, page[0].id);
      expect(page.length).toBeLessThanOrEqual(200);
      found.unshift(...page);
    }
    expect(found.map((entry) => entry.id)).toEqual(ids);
    expect(found[0].text).toBe(text);
    const search = historyPage(store, project.id, { query: 'EARLIEST_NEEDLE', limit: 20 });
    expect(search.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(
      historyRead(store, project.id, { source: 'entry', id: search.items[0].id, limit: 24000 })
        .text,
    ).toBe(text);
  };
  readAll();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  readAll();
});

it('a completed-worker consultation preserves done status and the original review after a duplicate send', async () => {
  const base = join(repoRoot, 'data/beta-campaign-20261001/13-history');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'consultation-'));
  const store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(root, 'Completed work', '');
  const task = store.addTask(project.id, {
    title: 'Finished work',
    goal: 'Saved result',
    acceptance: 'Checked',
    parentId: null,
  });
  store.updateTask(task.id, {
    status: 'done',
    review: 'Independent approval',
    reviewedCommit: 'reviewed-source',
  });
  const worker = store.addAgent({
    projectId: project.id,
    taskId: task.id,
    parentId: project.managerId,
    name: 'Old worker',
    role: 'researcher',
    cwd: root,
  });
  store.updateAgent(worker.id, { model: 'demo', modelSelection: 'exact' });
  const before = store.task(task.id);
  const original = store.agent(worker.id);
  const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  const app = await createServer(store, runtime, { port: 4373 });
  const headers = { host: '127.0.0.1:4373', origin: 'http://127.0.0.1:4373' };
  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers, payload });
  try {
    const discussion = (
      await post(`/api/agents/${worker.id}/interviews`, { key: randomUUID() })
    ).json();
    expect(discussion.permission).toBe('read-only');
    const input = { key: randomUUID(), text: 'Explain the recorded result 🧪\nDo not reopen it.' };
    const response = await post(`/api/agents/${discussion.id}/messages`, input);
    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(store.run(response.json().id).status).toBe('completed'));
    expect((await post(`/api/agents/${discussion.id}/messages`, input)).json().id).toBe(
      response.json().id,
    );
    expect(store.runs().filter((run) => run.agentId === discussion.id)).toHaveLength(1);
    expect(store.task(task.id)).toEqual(before);
    expect(store.agent(worker.id)).toEqual(original);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
