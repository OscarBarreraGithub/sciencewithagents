import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/server/dist/store.js';
import { Runtime } from '../apps/server/dist/runtime.js';
import assert from 'node:assert/strict';
import { git, integrationPreview, integrate } from '../apps/server/dist/workspaces.js';

// Explicit real-provider smoke. One tiny delegated research task, no external actions.
if (!process.argv.includes('--run'))
  throw new Error('Pass --run to run a bounded real Codex smoke using your existing login.');
process.umask(0o077);
const root = resolve('data', 'smoke', randomUUID().slice(0, 8));
console.log(`Smoke fixture ${root}`);
const projectRoot = join(root, 'project');
mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
await git(projectRoot, ['init', '-b', 'main']);
await git(projectRoot, ['config', 'user.name', 'Agent Dock Smoke']);
await git(projectRoot, ['config', 'user.email', 'smoke@example.invalid']);
writeFileSync(
  join(projectRoot, 'README.md'),
  '# Smoke fixture\n\nThe verification marker is DOCK-SMOKE-READY.\n',
  { mode: 0o600 },
);
await git(projectRoot, ['add', '.']);
await git(projectRoot, ['commit', '-m', 'Create bounded smoke fixture']);
const store = new Store(join(root, 'dock.sqlite'));
const project = store.register(
  projectRoot,
  'Smoke fixture',
  'A disposable test repository containing a README marker.',
);
const build = process.argv.includes('--build');
const native = process.argv.includes('--native');
assert(!native || build, 'The native write check requires --build.');
const providerCompletions = new Set();
const nativeCheckpoints = [];
const binary = process.env.DOCK_CODEX_BIN ?? 'codex';
const runtime = new Runtime(store, root, binary);
if (native) {
  // Observe the normal production provider. No fixture policy, charter or feature overrides.
  const originalClient = runtime.client.bind(runtime);
  const observed = new WeakSet();
  runtime.client = async (agent) => {
    const client = await originalClient(agent);
    if (!observed.has(client)) {
      observed.add(client);
      client.prependListener('notification', (method, params) => {
        if (method === 'turn/completed' && params.turn.status === 'completed')
          providerCompletions.add(params.threadId);
      });
    }
    return client;
  };
}
const managerId = process.argv.includes('--module')
  ? store.addManager(
      project.id,
      'Fixture module manager',
      'The disposable fixture and its verification marker.',
    ).id
  : project.managerId;
const deadline = Date.now() + (build ? 300_000 : 180_000);
store.on('event', (event) => {
  if (native && event.type === 'task.checkpointed') {
    const family = store
      .agents()
      .filter((a) => a.id === event.agentId || a.nativeRootId === event.agentId);
    nativeCheckpoints.push({
      event,
      allCompleted: family.every((a) => providerCompletions.has(a.threadId)),
      children: family.filter((a) => a.nativeRootId).length,
    });
  }
  if (
    [
      'agent.created',
      'run.queued',
      'run.completed',
      'run.failed',
      'run.interrupted',
      'decision.recorded',
    ].includes(event.type)
  )
    console.log(`${event.id}: ${event.type}`);
});
let success = false;
try {
  await runtime.initialize();
  const prompt = native
    ? 'This is a bounded native write-group integration smoke in a disposable fixture. Create exactly ONE task with this outcome and acceptance: add parent.txt containing exactly PARENT-WRITE-READY followed by a newline, and child.txt containing exactly CHILD-WRITE-READY followed by a newline; README must be unchanged and no other files changed. Delegate ONE implementer with this explicit assignment: write only parent.txt yourself, spawn exactly ONE native subagent named fixture_writer to write only child.txt, and save separate PARENT-WRITE-READY and CHILD-WRITE-READY dock_checkpoint summaries on the parent and child respectively. Tell the child not to spawn more children, modify other files or run Git mutations. The implementer must not write child.txt or perform Git mutations either. Native coordination is explicitly requested by the owner for this one child. After the implementer finishes, delegate ONE independent reviewer to inspect the exact two file contents, unchanged README and clean host checkpoint, then submit dock_review. No planner is needed. The host commits the combined implementation automatically after the entire native family finishes. Once the independent review approves and its reviewer finishes, use dock_decide complete and save your own checkpoint. Then report NATIVE-WRITE-GROUP-READY and stop. No follow-up tasks, network, credentials, external actions, pushing or deployment.'
    : build
      ? 'This is a bounded integration smoke in a disposable fixture. Create exactly ONE task: add result.txt containing exactly DOCK-BUILD-READY followed by a newline. Acceptance: the file has exactly that content and README is unchanged. Delegate ONE implementer; after it finishes, delegate ONE independent reviewer. No planner is needed. The host commits the implementation automatically after the implementer finishes. Once review approves and the reviewer finishes, use dock_decide complete to finish the task and save a checkpoint. Then report DOCK-BUILD-READY and stop. Do not create follow-up work. No external actions, network access, credentials, pushing or deployment.'
      : 'This is a bounded integration smoke. Create exactly ONE atomic task: read the README and report its verification marker. Delegate exactly ONE researcher. Do not plan or implement anything. Do not start a reviewer. After the researcher reports, save a checkpoint containing the marker and respond with it. Then stop. Do not create more tasks or ask follow-up questions.';
  const run = store.transaction(() => store.enqueue(managerId, randomUUID(), prompt));
  runtime.kick();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const workers = store.agents().filter((a) => a.role !== 'manager');
    const completedWorker = workers.some((a) =>
      store.runs().some((r) => r.agentId === a.id && r.status === 'completed'),
    );
    const finalManager = store
      .runs()
      .some((r) => r.agentId === managerId && r.kind === 'report' && r.status === 'completed');
    if (store.approvals().some((a) => a.status === 'pending'))
      throw new Error(
        'Smoke needs an owner approval. The request is retained; no automatic approval is sent.',
      );
    if (
      build
        ? store.tasks().some((t) => t.status === 'done') && store.agent(managerId).status === 'idle'
        : completedWorker &&
          finalManager &&
          store
            .entries(managerId)
            .some((e) => e.kind === 'assistant' && e.text.includes('DOCK-SMOKE-READY'))
    ) {
      success = true;
      break;
    }
    if (store.agent(managerId).status === 'failed')
      throw new Error(store.entries(managerId).at(-1)?.text ?? 'Manager failed');
    if (workers.some((a) => a.status === 'failed'))
      throw new Error('A worker failed. Inspect the retained smoke transcript.');
    if (store.run(run.id).status === 'completed' && workers.length === 0)
      throw new Error(
        'The manager finished without delegating. Inspect its retained response for the cause.',
      );
  }
  if (!success) throw new Error('Smoke did not finish before its three-minute deadline.');
  if (build) {
    const task = store.tasks().find((t) => t.status === 'done');
    const preview = await integrationPreview(store, task.id);
    if (native) {
      const implementers = store
        .agents()
        .filter((a) => a.role === 'implementer' && !a.nativeRootId);
      const children = store.agents().filter((a) => a.nativeRootId);
      const reviewers = store.agents().filter((a) => a.role === 'reviewer');
      assert.equal(implementers.length, 1);
      assert.equal(children.length, 1);
      assert.equal(reviewers.length, 1);
      const parent = implementers[0],
        child = children[0],
        reviewer = reviewers[0];
      assert.equal(child.nativeRootId, parent.id);
      assert.equal(child.parentId, parent.id);
      assert.equal(child.cwd, task.worktree);
      assert.equal(parent.cwd, task.worktree);
      assert.equal(child.taskId, task.id);
      assert.equal(child.permission, 'workspace-write');
      assert.equal(child.checkpoint, 'CHILD-WRITE-READY');
      assert.equal(parent.checkpoint, 'PARENT-WRITE-READY');
      assert.equal(reviewer.nativeRootId, null);
      assert.equal(reviewer.parentId, managerId);
      assert.equal(task.reviewAgentId, reviewer.id);
      assert.equal(task.reviewedCommit, preview.source);
      assert.equal(nativeCheckpoints.length, 1);
      assert.equal(nativeCheckpoints[0].children, 1);
      assert(
        nativeCheckpoints[0].allCompleted,
        'The combined Git checkpoint must wait for both provider completions',
      );
      assert.equal(
        store.runs().filter((r) => r.kind === 'report' && r.sourceId === parent.id).length,
        1,
      );
      assert.equal(
        store.runs().filter((r) => r.kind === 'report' && r.sourceId === child.id).length,
        0,
      );
      assert(
        store
          .entries(child.id)
          .some(
            (e) => e.kind === 'tool' && e.title === 'File changes' && e.text.includes('child.txt'),
          ),
        'The native child must perform its own visible file write',
      );
      assert(
        !store
          .entries(parent.id)
          .some(
            (e) => e.kind === 'tool' && e.title === 'File changes' && e.text.includes('child.txt'),
          ),
        'The parent cannot substitute its own write for the child',
      );
      assert.equal(
        await git(task.worktree, ['diff', '--name-only', task.baseCommit, 'HEAD']),
        'child.txt\nparent.txt',
      );
      assert.equal(
        await git(task.worktree, ['rev-list', '--count', `${task.baseCommit}..HEAD`]),
        '1',
      );
    }
    await integrate(store, task.id, preview);
    if (native) {
      assert.equal(readFileSync(join(projectRoot, 'parent.txt'), 'utf8'), 'PARENT-WRITE-READY\n');
      assert.equal(readFileSync(join(projectRoot, 'child.txt'), 'utf8'), 'CHILD-WRITE-READY\n');
      assert.equal(
        readFileSync(join(projectRoot, 'README.md'), 'utf8'),
        '# Smoke fixture\n\nThe verification marker is DOCK-SMOKE-READY.\n',
      );
      assert.equal(await git(projectRoot, ['rev-parse', 'HEAD']), preview.source);
      console.log(
        'PASS: real native child write, one whole-group checkpoint, independent review and exact two-file integration.',
      );
    } else if (readFileSync(join(projectRoot, 'result.txt'), 'utf8') !== 'DOCK-BUILD-READY\n')
      throw new Error('Integrated output did not match acceptance.');
    console.log(
      'PASS: independent review, exact commit preview, and integration into the disposable fixture.',
    );
  }
  if (store.tasks().length !== 1 || store.tasks()[0].managerId !== managerId)
    throw new Error('The task did not retain the selected manager.');
  if (
    store.agents().some((a) => a.role !== 'manager' && !a.nativeRootId && a.parentId !== managerId)
  )
    throw new Error('A worker was assigned to the wrong manager.');
  if (managerId !== project.managerId && store.runs().some((r) => r.agentId === project.managerId))
    throw new Error('Module work unexpectedly started the project manager.');
  const managerThread = store.agent(managerId).threadId;
  const messageCount = store.entries(managerId).filter((e) => e.kind === 'assistant').length;
  await runtime.close();
  const replacement = new Runtime(store, root, process.env.DOCK_CODEX_BIN ?? 'codex');
  try {
    await replacement.attach(managerId);
    if (store.agent(managerId).threadId !== managerThread)
      throw new Error('Restart changed the manager thread.');
    if (store.entries(managerId).filter((e) => e.kind === 'assistant').length !== messageCount)
      throw new Error('Restart duplicated assistant messages.');
  } finally {
    await replacement.close();
  }
  console.log(
    `PASS: manager delegation, real worker tools, completion report, checkpoint, and same-thread restart. ${store.runs().length} turns. Private evidence: ${root}`,
  );
} finally {
  await runtime.close();
  store.close();
}
