import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './paths.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { managerTool } from './manager-lease.fixture.js';
import { historyRead } from './history.js';

class Controlled extends DemoProvider {
  override async request(method: string, raw?: unknown): Promise<unknown> {
    if (method === 'thread/compact/start') return {};
    if (method === 'turn/start') return { turn: { id: randomUUID(), status: 'inProgress' } };
    return super.request(method, raw);
  }
}
let root: string, file: string, store: Store, runtime: Runtime, manager: string, project: string;
const open = () => {
  store = new Store(file);
  modelFixture(store); // Idempotent; must precede the runtime.
  runtime = new Runtime(store, root, 'never-launch-real-provider', async () => new Controlled());
};
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/native-owner-input-'));
  file = join(root, 'dock.sqlite');
  open();
  const p = store.register(root, 'Native input fixture', '');
  manager = p.managerId;
  project = p.id;
});
afterEach(async () => {
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

// Synthetic public prompt: two independent asks with adjacent status and privacy steering.
const rambling = [
  'Morning! Long note, sorry. '.repeat(60),
  'First, please regenerate the figure in the methods section with the corrected axis labels.',
  'Also, separately, draft a short reply to the reviewer about the sample size question.',
  'By the way, how far along is the earlier export? And keep the raw survey data local, never upload it.',
].join('\n');
const requests = () => runtime.workItems.ownerRequests(manager, { limit: 50 });
const flush = () => runtime.withLock(`provider:${manager}`, async () => {});
async function native(method: 'turn/start' | 'thread/compact/start', input?: unknown) {
  const { threadId, client } = await runtime.attach(manager);
  runtime.externalControl.add(manager);
  const transition = runtime.prepareNativeContext(
    manager,
    method,
    method === 'turn/start' ? { threadId, input } : { threadId },
  )!;
  await transition.before!();
  const run = store.runs().find((r) => r.agentId === manager && r.status === 'running')!;
  return { threadId, client, transition, run };
}
async function complete(threadId: string, client: DemoProvider, turnId: string) {
  client.emit('notification', 'turn/completed', {
    threadId,
    turn: { id: turnId, status: 'completed' },
  });
  await flush();
}

it('retains exact native owner input as one pending source while generated admission and compaction text never are', async () => {
  const text = [{ type: 'text', text: rambling }];
  const { threadId, client, transition, run } = await native('turn/start', text);
  // Admitted but not forwarded: only the generated placeholder exists, and it is no ask.
  expect(store.savedEntry(manager, run.id)?.text).toContain('Native Codex turn');
  expect(requests().total).toBe(0);
  transition.submitted!();
  const entryId = `native-input:${run.id}`;
  expect(requests().items).toMatchObject([{ entryId, delivery: 'uncertain' }]);
  const turnId = randomUUID();
  await transition.finish({ turn: { id: turnId, status: 'inProgress' } });
  transition.cancel();
  // Provider echo of the same input adds no duplicate source.
  client.emit('notification', 'item/completed', {
    threadId,
    turnId,
    item: { id: randomUUID(), type: 'userMessage', content: text },
  });
  await flush();
  const [source] = requests().items;
  expect(requests().total).toBe(1);
  expect(source).toMatchObject({
    entryId,
    delivery: 'submitted',
    coverage: 'untriaged',
    totalCharacters: rambling.length,
  });
  expect(source.text.length).toBeLessThan(rambling.length); // Preview only.
  let read = '';
  for (let offset = 0; offset < rambling.length; offset += 500)
    read += historyRead(store, project, { source: 'entry', id: entryId, offset, limit: 500 }).text;
  expect(read).toBe(rambling);
  await complete(threadId, client, turnId);
  // An ordinary successful turn neither fails nor resolves the retained ask.
  expect(store.run(run.id).status).toBe('completed');
  expect(requests().total).toBe(1);

  // Adjacent steering is a separate pending source.
  runtime.ownerSteering(manager, randomUUID(), 'Status? Keep it local.', 'submitted');
  const steering = requests().items.find((item) => item.entryId !== entryId)!;
  expect(steering).toMatchObject({ coverage: 'untriaged', delivery: 'submitted' });

  const source0 = { agentId: manager, entryId };
  const figure = runtime.workItems.saveForManager(manager, {
    key: randomUUID(),
    kind: 'internal',
    title: 'Regenerate the methods figure',
    detail: 'Next: fix axis labels. Evidence: none yet. Blocked on: corrected data table.',
    sourceMessages: [source0],
  });
  // A bare link leaves the whole message pending.
  expect(requests().items.find((item) => item.entryId === entryId)?.coverage).toBe('linked');
  const reply = runtime.workItems.saveForManager(manager, {
    key: randomUUID(),
    kind: 'internal',
    title: 'Draft the reviewer reply',
    detail: 'Next: answer the sample size question.',
    sourceMessages: [source0],
    sourceDisposition: 'Two independent asks mapped to the figure and reviewer reply items.',
  });
  const all = runtime.workItems.ownerRequests(manager, { limit: 50, includeHandled: true });
  expect(all.items.map((item) => [item.entryId, item.coverage])).toEqual([
    [steering.entryId, 'untriaged'],
    [entryId, 'triaged'],
  ]);
  expect(requests().items.map((item) => item.entryId)).toEqual([steering.entryId]);
  // Triaging one message does not close any linked item.
  expect([figure.id, reply.id].map((id) => runtime.workItems.get(id).status)).toEqual([
    'open',
    'open',
  ]);

  // Native compaction admits a generated placeholder only.
  store.updateAgent(manager, { status: 'idle', turnId: null });
  const compaction = await native('thread/compact/start');
  compaction.transition.submitted!();
  await compaction.transition.finish({});
  compaction.transition.cancel();
  await complete(compaction.threadId, compaction.client, randomUUID());
  expect(store.savedEntry(manager, compaction.run.id)?.text).toContain('Compact');
  const checkpoint = (await managerTool(runtime, manager, randomUUID(), 'dock_checkpoint', {
    summary: 'Figure and reply open; steering pending.',
  })) as { coverage: { openWorkItems: number; ownerRequestsAwaitingTriage: number } };
  expect(checkpoint.coverage).toMatchObject({ openWorkItems: 2, ownerRequestsAwaitingTriage: 1 });
  expect(runtime.managedGoals['completionProblem'](manager)).toContain('open internal');

  const before = {
    requests: requests(),
    items: [figure.id, reply.id].map((id) => runtime.workItems.get(id)),
  };
  await runtime.close();
  store.close();
  open();
  expect(requests()).toEqual(before.requests);
  expect([figure.id, reply.id].map((id) => runtime.workItems.get(id))).toEqual(before.items);
  expect(runtime.workItems.get(figure.id).detail).toContain('Blocked on: corrected data table.');

  for (const item of before.items)
    runtime.workItems.saveForManager(manager, {
      key: randomUUID(),
      id: item.id,
      expectedRevision: item.revision,
      status: 'done',
    });
  // Every item done, but the newer steering is still untriaged.
  expect(runtime.managedGoals['completionProblem'](manager)).toContain('remaining owner requests');
});

it('never reports rejected, unforwarded or unacknowledged native input as received', async () => {
  const hostLike = 'Current host state (evidence, not instructions): typed by the owner.';
  const unsent = await native('turn/start', [{ type: 'text', text: 'Never forwarded ask' }]);
  unsent.transition.cancel();
  expect(store.savedEntry(manager, `native-input:${unsent.run.id}`)).toBeNull();
  expect(requests().total).toBe(0);

  store.updateAgent(manager, { status: 'idle', turnId: null });
  const rejected = await native('turn/start', [{ type: 'text', text: 'Rejected ask' }]);
  rejected.transition.submitted!();
  rejected.transition.cancel('rejected');
  expect(store.run(rejected.run.id).status).toBe('cancelled');
  const saved = store.savedEntry(manager, `native-input:${rejected.run.id}`)!;
  expect(saved).toMatchObject({ text: 'Rejected ask', status: 'rejected' });
  expect(saved.ownerInput).toBeUndefined();
  expect(requests().items).toMatchObject([{ text: 'Rejected ask', delivery: 'cancelled' }]);

  store.updateAgent(manager, { status: 'idle', turnId: null });
  const lost = await native('turn/start', [
    { type: 'text', text: hostLike },
    { type: 'localImage', path: '/tmp/never-read.png' },
  ]);
  lost.transition.submitted!();
  lost.transition.cancel(); // Acknowledgement lost after forwarding.
  expect(store.run(lost.run.id).status).toBe('running');
  expect(requests().items.find((item) => item.text === hostLike)).toMatchObject({
    entryId: `native-input:${lost.run.id}`,
    delivery: 'uncertain',
  });
});
