import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../apps/server/dist/store.js';
import { Runtime } from '../apps/server/dist/runtime.js';
import { CodexRpc } from '../apps/server/dist/codex.js';
import { Sessions } from '../apps/server/dist/sessions.js';

const fixture = process.argv[2];
if (!/^[a-f0-9]{8}$/.test(fixture ?? '') || !process.argv.includes('--run'))
  throw new Error(
    'Usage: node scripts/smoke-session-import.mjs <successful-fixture-id> --run [--researcher]',
  );
// Only an existing disposable fixture. Forking its stored worker history makes no model call.
process.umask(0o077);
const root = resolve('data/smoke', fixture);
const store = new Store(join(root, 'dock.sqlite'));
const project = store.projects()[0];
const sourceRole = process.argv.includes('--researcher') ? 'researcher' : 'implementer';
const source = store.agents().find((a) => a.role === sourceRole && a.threadId);
assert(project && source, `A successful ${sourceRole} fixture is required.`);
assert(
  store.runs().every((r) => !['running', 'queued'].includes(r.status)),
  'Fixture must be idle.',
);
const binary = process.env.DOCK_CODEX_BIN ?? 'codex';
const exec = promisify(execFile);
const { stdout: version } = await exec(binary, ['--version'], { timeout: 10_000 });
const rpc = new CodexRpc(binary, join(root, 'import-probe.sock'), project.root, true);
const runtime = new Runtime(store, root, binary);
const providerPids = new Set();
const observed = new WeakSet();
let startedTurns = 0;
function observeProvider(provider) {
  if (provider.process?.pid && !providerPids.has(provider.process.pid)) {
    providerPids.add(provider.process.pid);
    console.log(`Owned import provider host PID ${provider.process.pid}`);
  }
  if (!observed.has(provider)) {
    observed.add(provider);
    provider.on('notification', (method) => {
      if (method === 'turn/started') startedTurns++;
    });
  }
}
function observeRuntime(current) {
  const client = current.client.bind(current);
  current.client = async (agent) => {
    const provider = await client(agent);
    observeProvider(provider);
    return provider;
  };
}
observeRuntime(runtime);
try {
  await rpc.start();
  observeProvider(rpc);
  const { thread: sourceMetadata } = await rpc.request('thread/read', {
    threadId: source.threadId,
    includeTurns: false,
  });
  assert.equal(
    sourceMetadata.historyMode,
    'legacy',
    'This smoke specifically checks supported legacy history, not the unsupported paginated mode.',
  );
  assert(
    sourceMetadata.path?.endsWith('.jsonl'),
    'The provider must identify legacy JSONL-backed history. Its unstable path is never accepted by the web API or read by this smoke.',
  );
  const { thread } = await rpc.request('thread/fork', {
    threadId: source.threadId,
    cwd: project.root,
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    excludeTurns: true,
    deferGoalContinuation: true,
  });
  await rpc.request('thread/name/set', { threadId: thread.id, name: 'Saved session import smoke' });
  await rpc.close();
  const sessions = new Sessions(runtime);
  const page = await sessions.list(project.id);
  assert(
    page.data.some((t) => t.id === thread.id),
    'Discovery must include App Server history from this root.',
  );
  const runCount = store.runs().length;
  const agentCount = store.agents().length;
  const input = {
    key: randomUUID(),
    threadId: thread.id,
    managerId: source.parentId,
    confirmedStopped: true,
  };
  const imported = await sessions.import(project.id, input);
  assert.equal(store.agent(imported.id).permission, 'read-only');
  assert.equal(store.agent(imported.id).threadId, thread.id);
  assert.equal(
    store.agent(imported.id).nativeRootId,
    null,
    'Import must not invent historical native parentage.',
  );
  assert.equal(store.agent(imported.id).nativePath, null);
  assert.equal(
    store.agent(imported.id).parentId,
    source.parentId,
    'The chosen responsible manager is current ownership, not reconstructed native provenance.',
  );
  assert.equal(
    store.agents().length,
    agentCount + 1,
    'Import must add one identity, not synthesize a missing historical team.',
  );
  assert(
    store.entries(imported.id).some((e) => e.kind === 'assistant'),
    'Visible answers must be retained.',
  );
  const entryIds = store.entries(imported.id).map((e) => e.id);
  assert.equal((await sessions.import(project.id, input)).id, imported.id);
  assert.deepEqual(
    store.entries(imported.id).map((e) => e.id),
    entryIds,
  );
  assert.equal(store.runs().length, runCount, 'Import must not execute a turn.');
  const env = { ...process.env, DOCK_DATA_DIR: root };
  const listing = await exec(
    process.execPath,
    ['apps/server/dist/cli.js', 'sessions', project.id],
    { env, timeout: 30_000 },
  );
  assert(listing.stdout.includes(thread.id), 'The CLI must use the same discovery scope.');
  const retry = await exec(
    process.execPath,
    [
      'apps/server/dist/cli.js',
      'import',
      project.id,
      thread.id,
      '--stopped',
      '--manager',
      source.parentId,
    ],
    { env, timeout: 30_000 },
  );
  assert(retry.stdout.includes(imported.id), 'CLI retry must reuse the registered identity.');
  assert.deepEqual(
    store.entries(imported.id).map((e) => e.id),
    entryIds,
  );
  assert.equal(store.runs().length, runCount);
  await runtime.close();
  store.close();
  const reopened = new Store(join(root, 'dock.sqlite'));
  const replacement = new Runtime(reopened, root, binary);
  observeRuntime(replacement);
  try {
    await replacement.attach(imported.id);
    assert.equal(reopened.agent(imported.id).threadId, thread.id);
    assert.deepEqual(
      reopened.entries(imported.id).map((e) => e.id),
      entryIds,
    );
  } finally {
    await replacement.close();
    reopened.close();
  }
  assert.equal(
    startedTurns,
    0,
    'Discovery, import and stored-thread attachment must not start a model turn.',
  );
  writeFileSync(
    join(root, 'import-verification.json'),
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        version: version.trim(),
        sourceRole,
        sourceThreadId: source.threadId,
        sourceCliVersion: sourceMetadata.cliVersion,
        historyMode: sourceMetadata.historyMode,
        providerReportedStorage: 'jsonl',
        importedThreadId: thread.id,
        importedAgentId: imported.id,
        managerId: source.parentId,
        importedEntryIds: entryIds,
        startedTurns,
        providerHostPids: [...providerPids],
        checks: [
          'saved legacy JSONL discovery through public thread APIs',
          'paged atomic import and exact retry identity',
          'read-only import without invented historical native parentage',
          'same-thread and exact archive restart with no model turn',
        ],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    'PASS: real legacy JSONL saved-session discovery, paged history import, CLI/UI adapter retry, read-only ownership, no invented native parentage and restart persistence. No new model turn.',
  );
} finally {
  await rpc.close();
  if (store.db.isOpen) {
    await runtime.close();
    store.close();
  }
  assert.deepEqual(
    [...providerPids].filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }),
    [],
    'An owned import provider host was left running.',
  );
}
