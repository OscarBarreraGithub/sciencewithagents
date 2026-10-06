import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './paths.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';

class Controlled extends DemoProvider {
  starts = 0;
  responses: { id: string | number; result: unknown }[] = [];
  override async request(method: string, raw?: unknown): Promise<unknown> {
    if (method === 'turn/start') {
      this.starts++;
      return { turn: { id: randomUUID(), status: 'inProgress' } };
    }
    return super.request(method, raw);
  }
  override respond(id: string | number, result: unknown) {
    this.responses.push({ id, result });
  }
}
let root: string, path: string, store: Store, runtime: Runtime, manager: string, project: string;
let client: Controlled;
const createRuntime = () =>
  new Runtime(store, root, 'never-launch-real-provider', async () => (client = new Controlled()));
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/request-continuity-'));
  path = join(root, 'dock.sqlite');
  store = new Store(path);
  modelFixture(store);
  const registered = store.register(root, 'Continuity fixture', '');
  manager = registered.managerId;
  project = registered.id;
  runtime = createRuntime();
});
afterEach(async () => {
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
async function invoke(tool: string, args: unknown = {}) {
  const state = store.agent(manager),
    requestId = randomUUID();
  client.emit('request', requestId, 'item/tool/call', {
    threadId: state.threadId,
    turnId: state.turnId,
    callId: randomUUID(),
    tool,
    arguments: args,
  });
  await vi.waitFor(() => expect(client.responses.some((r) => r.id === requestId)).toBe(true));
  const reply = client.responses.find((r) => r.id === requestId)!.result as {
    contentItems: { text: string }[];
  };
  return JSON.parse(reply.contentItems[0].text);
}
const state = () =>
  JSON.parse(runtime.context(store.agent(manager)).split('\n').slice(1).join('\n'));

it('keeps earlier open work visible through steering, checkpoints, compaction and restart', async () => {
  const run = store.enqueue(manager, randomUUID(), 'Original bounded objective');
  runtime.kick();
  await vi.waitFor(() => expect(store.agent(manager).turnId).toBeTruthy());
  const original = runtime.workItems.ownerRequests(manager).items[0]!;
  const task = store.addTask(project, {
    title: 'Earlier analysis',
    goal: 'Finish the earlier analysis',
    acceptance: 'Evidence attached',
    parentId: null,
  });
  // The oldest unresolved item carries ownership, next action, evidence and a blocker.
  const earlier = runtime.workItems.saveForManager(manager, {
    key: randomUUID(),
    taskId: task.id,
    title: 'Earlier analysis',
    detail: 'Next: rerun check B. Evidence: run 1 log. Blocker: waiting on dataset access.',
    status: 'waiting',
    sourceMessages: [{ agentId: manager, entryId: original.entryId }],
    sourceDisposition: 'One independent ask, linked to this item.',
  });
  const longDetail =
    'Recorded context. '.repeat(20) +
    'Next: check the saved output. Evidence: retained log. Blocker: dataset permission.';
  for (let index = 0; index < 6; index++)
    runtime.workItems.saveForManager(manager, {
      key: randomUUID(),
      title: `Step ${index}`,
      ...(index === 5 ? { detail: longDetail } : {}),
    });
  const finished = runtime.workItems.saveForManager(manager, {
    key: randomUUID(),
    title: 'Finished step',
    status: 'done',
  });

  const first = await invoke('dock_inspect');
  expect(first.quarkUpdate.openWork).toMatchObject({ total: 7, omitted: 2 });
  expect(first.quarkUpdate.openWork.items).toHaveLength(5);
  const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id);
  expect(ids(first.quarkUpdate.openWork)).not.toContain(finished.id);
  expect(await invoke('dock_inspect')).not.toHaveProperty('quarkUpdate');
  expect(first.quarkUpdate.openWork.items[0]).toMatchObject({
    title: 'Step 5',
    detail: longDetail.slice(0, 240),
    truncated: true,
  });
  const fullFirstPage = await invoke('dock_inspect', { workItems: {} });
  expect(fullFirstPage.items).toContainEqual(
    expect.objectContaining({ title: 'Step 5', detail: longDetail }),
  );

  // An adjacent status/privacy question adds a pending request; earlier work stays open.
  runtime.ownerSteering(manager, randomUUID(), 'Status and privacy question.', 'submitted');
  const steering = await invoke('dock_inspect');
  expect(steering.quarkUpdate.ownerRequests.items).toContainEqual(
    expect.objectContaining({ text: 'Status and privacy question.' }),
  );
  expect(steering.quarkUpdate.openWork.total).toBe(7);
  // Older items beyond the preview are retrievable with the same cursor.
  const page = await invoke('dock_inspect', {
    workItems: { cursor: steering.quarkUpdate.openWork.nextCursor },
  });
  expect(page.items).toContainEqual(
    expect.objectContaining({
      id: earlier.id,
      status: 'waiting',
      managerId: manager,
      taskId: task.id,
      detail: earlier.detail,
      sourceMessages: [{ agentId: manager, entryId: original.entryId }],
    }),
  );
  expect(page.nextCursor).toBeNull();

  // Saving a summary reports remaining coverage and resolves nothing.
  const saved = await invoke('dock_checkpoint', { summary: `Open: ${earlier.id} waiting.` });
  expect(saved).toMatchObject({
    saved: true,
    coverage: { openWorkItems: 7, ownerRequestsAwaitingTriage: 1 },
  });
  expect(runtime.workItems.get(earlier.id).status).toBe('waiting');

  // Changed revisions are coalesced within the window and delivered afterwards.
  const updated = runtime.workItems.saveForManager(manager, {
    key: randomUUID(),
    id: (steering.quarkUpdate.openWork.items as { id: string }[])[0]!.id,
    expectedRevision: 1,
    status: 'in_progress',
  });
  expect(await invoke('dock_inspect')).not.toHaveProperty('quarkUpdate');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
  try {
    expect((await invoke('dock_inspect')).quarkUpdate.openWork.items).toContainEqual(
      expect.objectContaining({ id: updated.id, revision: 2, status: 'in_progress' }),
    );
    expect(await invoke('dock_inspect')).not.toHaveProperty('quarkUpdate');
  } finally {
    clock.mockRestore();
  }

  client.emit('notification', 'thread/compacted', { threadId: store.agent(manager).threadId });
  await vi.waitFor(() =>
    expect(store.entries(manager).some((entry) => entry.title === 'Context compacted')).toBe(true),
  );
  expect((await invoke('dock_inspect')).quarkUpdate.openWork.total).toBe(7);
  // Surfacing or updating work never starts another model turn.
  expect(client.starts).toBe(1);
  expect(store.runs().filter((item) => item.agentId === manager)).toEqual([
    expect.objectContaining({ id: run.id }),
  ]);

  await runtime.close();
  store.close();
  store = new Store(path);
  runtime = createRuntime();
  const restored = state();
  expect(store.agent(manager).checkpoint).toBe(`Open: ${earlier.id} waiting.`);
  expect(restored.workItemsPage.total).toBe(7);
  expect(restored.workItems).toContainEqual(
    expect.objectContaining({ id: earlier.id, status: 'waiting', taskId: task.id }),
  );
  expect(ids({ items: restored.workItems })).not.toContain(finished.id);
  expect(runtime.workItems.page(project, { includeDone: true }).total).toBe(8);
});
