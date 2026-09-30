import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../apps/server/dist/store.js';
import { Runtime } from '../apps/server/dist/runtime.js';
import { git } from '../apps/server/dist/workspaces.js';

if (!process.argv.includes('--run'))
  throw new Error(
    'Pass --run to use the existing Codex login for a bounded disposable frontdesk check.',
  );
process.umask(0o077);
const root = resolve('data/smoke', `frontdesk-${randomUUID().slice(0, 8)}`);
const projectRoot = join(root, 'project');
mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
await git(projectRoot, ['init', '--template=', '--initial-branch=main']);
await git(projectRoot, [
  '-c',
  'user.name=Agent Dock Smoke',
  '-c',
  'user.email=smoke@example.invalid',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '--allow-empty',
  '-m',
  'Create disposable status fixture',
]);
const exec = promisify(execFile);
const binary = process.env.DOCK_CODEX_BIN ?? 'codex';
const { stdout: version } = await exec(binary, ['--version'], { timeout: 10_000 });
let store = new Store(join(root, 'dock.sqlite'));
let runtime = new Runtime(store, root, binary);
const providerPids = new Set();
const observed = new WeakSet();
let startedTurns = 0;
let stopping = false;
process.once('SIGINT', () => {
  stopping = true;
});
process.once('SIGTERM', () => {
  stopping = true;
});
function observe(current) {
  const client = current.client.bind(current);
  current.client = async (agent) => {
    const provider = await client(agent);
    if (provider.process?.pid && !providerPids.has(provider.process.pid)) {
      providerPids.add(provider.process.pid);
      console.log(`Owned provider host PID ${provider.process.pid}`);
    }
    if (!observed.has(provider)) {
      observed.add(provider);
      provider.on('notification', (method) => {
        if (method === 'turn/started') startedTurns++;
      });
    }
    return provider;
  };
}
observe(runtime);
store.on('event', (event) => {
  if (
    [
      'frontdesk.routed',
      'frontdesk.delivery_updated',
      'run.completed',
      'run.failed',
      'run.interrupted',
    ].includes(event.type)
  )
    console.log(`${event.id}: ${event.type}`);
});
console.log(`Frontdesk fixture ${root}; ${version.trim()}`);
try {
  const project = store.register(projectRoot, 'Status fixture', 'Disposable saved status only.');
  const hidden = store.register(
    join(root, 'unselected'),
    'Unselected fixture',
    'Must not be shared with this assistant.',
  );
  store.decision({
    projectId: project.id,
    taskId: null,
    agentId: project.managerId,
    kind: 'note',
    rationale: 'The host’s saved verification marker for this disposable status fixture.',
    evidence: 'FRONTDESK-STATUS-READY',
  });
  store.decision({
    projectId: hidden.id,
    taskId: null,
    agentId: hidden.managerId,
    kind: 'note',
    rationale: 'An unselected project’s private fixture marker.',
    evidence: 'UNSELECTED-PRIVATE-MARKER',
  });
  const assistant = runtime.frontdesk.create({ key: randomUUID() });
  assert(assistant.agentId);
  assert.equal(store.runs().length, 0, 'Creating the assistant must not start a turn.');
  runtime.frontdesk.save({
    key: randomUUID(),
    expectedRevision: 0,
    visibleProjectIds: [project.id],
    preferences: 'Keep status replies concise and source-linked.',
    priorities: 'Verify one recorded manager reply.',
    commitments: 'No code inspection, workers, execution or external actions in this fixture.',
  });
  await runtime.initialize();
  const owner = store.transaction(() =>
    store.enqueue(
      assistant.agentId,
      randomUUID(),
      `This is one bounded real-provider routing check in a disposable fixture. Use dock_frontdesk_route exactly once to ask the existing manager ${project.managerId} of selected project ${project.id} for its already-saved host status and verification marker from its recorded decisions. Ask it to report the saved marker and current active-task count. This is reading existing host status, not research or code inspection: neither you nor the manager should create tasks, delegate workers, plan, execute tools, inspect files, request permissions, change source, call networks or create further work. After routing, finish this turn. When the host forwards the manager's response, summarize its actual saved marker and source once, then stop. Do not route a second request from the report turn.`,
    ),
  );
  runtime.kick();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (stopping) throw new Error('Smoke interrupted; the fixture is retained.');
    if (store.approvals().some((approval) => approval.status === 'pending'))
      throw new Error(
        'An original approval is pending. It was retained and not answered automatically.',
      );
    if (store.runs().some((run) => ['failed', 'interrupted'].includes(run.status)))
      throw new Error('A smoke turn stopped. Inspect the retained fixture; no automatic retry.');
    const report = store
      .runs()
      .find(
        (run) =>
          run.agentId === assistant.agentId && run.kind === 'report' && run.status === 'completed',
      );
    if (report && store.runs().every((run) => run.status === 'completed')) break;
    if (
      store.run(owner.id).status === 'completed' &&
      !store.runs().some((run) => run.agentId === project.managerId)
    )
      throw new Error('The assistant finished without routing. Its actual reply is retained.');
    await delay(250);
  }
  const runs = store.runs();
  assert.equal(
    runs.length,
    3,
    'Expected one assistant request, one manager response and one assistant report.',
  );
  assert(
    runs.every((run) => run.status === 'completed'),
    'The bounded three-minute smoke did not complete.',
  );
  assert.equal(startedTurns, 3, 'Provider-start notifications must match the three actual turns.');
  assert.equal(store.tasks().length, 0, 'Saved-status routing does not need any task or worker.');
  assert(store.agents().every((agent) => agent.role === 'manager'));
  assert.equal(store.runs().filter((run) => run.agentId === hidden.managerId).length, 0);
  const managerRun = runs.find((run) => run.agentId === project.managerId);
  const report = runs.find((run) => run.agentId === assistant.agentId && run.kind === 'report');
  assert.equal(report.sourceId, project.managerId);
  assert(report.text.includes(managerRun.id), 'The report must reference its exact source run.');
  const answers = store.entries(assistant.agentId).filter((entry) => entry.kind === 'assistant');
  assert(
    answers.some(
      (entry) => entry.runId === report.id && entry.text.includes('FRONTDESK-STATUS-READY'),
    ),
    'The report turn must contain the manager’s actual recorded marker.',
  );
  assert(!JSON.stringify(store.entries(assistant.agentId)).includes('UNSELECTED-PRIVATE-MARKER'));
  const identities = [assistant.agentId, project.managerId].map((id) => ({
    id,
    threadId: store.agent(id).threadId,
    entries: store
      .entries(id, undefined, 5000)
      .map((entry) => ({ id: entry.id, text: entry.text })),
  }));
  assert(identities.every((identity) => identity.threadId));
  await runtime.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  runtime = new Runtime(store, root, binary);
  observe(runtime);
  await runtime.initialize();
  for (const identity of identities) {
    await runtime.attach(identity.id);
    assert.equal(store.agent(identity.id).threadId, identity.threadId);
    assert.deepEqual(
      store
        .entries(identity.id, undefined, 5000)
        .map((entry) => ({ id: entry.id, text: entry.text })),
      identity.entries,
    );
  }
  await delay(300);
  assert.equal(startedTurns, 3, 'Restart attachment must not start another model turn.');
  assert.equal(
    store.runs().length,
    3,
    'Restart must not duplicate manager delivery or user input.',
  );
  writeFileSync(
    join(root, 'verification.json'),
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        version: version.trim(),
        startedTurns,
        providerHostPids: [...providerPids],
        projectId: project.id,
        assistantId: assistant.agentId,
        managerId: project.managerId,
        managerRunId: managerRun.id,
        reportRunId: report.id,
        identities: identities.map(({ id, threadId, entries }) => ({
          id,
          threadId,
          entryIds: entries.map((entry) => entry.id),
        })),
        checks: [
          'explicit selected-project visibility',
          'exact saved manager source and once-only reply',
          'no tasks, workers, approvals or external actions',
          'same-thread and exact archive restart without a fourth model turn',
        ],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `PASS: current-provider assistant route, manager status, once-only report and exact same-thread restart. ${startedTurns} model turns. Private evidence: ${root}`,
  );
} finally {
  await runtime.close();
  if (store.db.isOpen) store.close();
  const survivors = [...providerPids].filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(survivors, [], 'An owned provider host was left running.');
  console.log('Closed every owned provider host; no HTTP listener or browser was started.');
}
