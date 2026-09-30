import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../apps/server/dist/store.js';
import { CodexRpc } from '../apps/server/dist/codex.js';
import { git } from '../apps/server/dist/workspaces.js';
import {
  workspaceRestoreResultsSchema,
  workspaceSnapshotSchema,
  workspaceUpdateResultSchema,
} from '../packages/shared/dist/index.js';

const scriptPath = fileURLToPath(import.meta.url);
const repository = resolve(scriptPath, '../..');
const mainPath = join(repository, 'apps/server/dist/main.js');

// Read-only observation loaded before the actual production main process. No
// fake provider, alternate charter, approval answer, runtime or request behavior.
if (process.argv[1] === mainPath && process.env.DOCK_WORKSPACE_SMOKE_PHASE) {
  const root = resolve(process.env.DOCK_DATA_DIR ?? '');
  const phase = process.env.DOCK_WORKSPACE_SMOKE_PHASE;
  assert(root.startsWith(join(repository, 'data/smoke/workspace-')));
  assert(['before', 'after'].includes(phase));
  const record = (value) =>
    appendFileSync(
      join(root, `provider-${phase}.jsonl`),
      `${JSON.stringify({ time: Date.now(), ...value })}\n`,
      { mode: 0o600 },
    );
  const originalStart = CodexRpc.prototype.start;
  CodexRpc.prototype.start = async function () {
    this.on('notification', (method, params) => {
      if (['turn/started', 'turn/completed'].includes(method))
        record({
          kind: 'notification',
          method,
          threadId: params?.threadId,
          turnId: params?.turn?.id,
        });
    });
    try {
      return await originalStart.call(this);
    } finally {
      if (this.process?.pid) record({ kind: 'provider-host', pid: this.process.pid });
    }
  };
  const originalRequest = CodexRpc.prototype.request;
  CodexRpc.prototype.request = function (method, params) {
    // Deliberately omit prompts, response content, credentials and tool arguments.
    record({ kind: 'request', method, threadId: params?.threadId });
    return originalRequest.call(this, method, params).then((result) => {
      if (['thread/start', 'thread/resume'].includes(method))
        record({
          kind: 'thread-identity',
          method,
          threadId: result?.thread?.id,
          model: result?.model,
        });
      return result;
    });
  };
} else {
  assert(
    process.argv.includes('--run'),
    'Pass --run to create five disposable conversations using the existing Codex login, then crash/restart only this smoke host.',
  );
  await run();
}

async function run() {
  process.umask(0o077);
  const root = join(repository, 'data/smoke', `workspace-${randomUUID().slice(0, 8)}`);
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  const exec = promisify(execFile);
  const binary = process.env.DOCK_CODEX_BIN ?? 'codex';
  const { stdout: version } = await exec(binary, ['--version'], { timeout: 10_000 });
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
    'Create disposable restart fixture',
  ]);
  const store = new Store(join(root, 'dock.sqlite'));
  let ids;
  try {
    const project = store.register(
      projectRoot,
      'Restart fixture',
      'Disposable transport evidence only.',
    );
    ids = [
      project.managerId,
      ...Array.from(
        { length: 4 },
        (_, i) =>
          store.addManager(
            project.id,
            `Restart manager ${i + 2}`,
            'Disposable session continuity check.',
          ).id,
      ),
    ];
  } finally {
    store.close();
  }
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 180_000;
  const mainProcesses = [];
  const descendants = new Map();
  let db;
  let stopped = false;
  const stopRequested = () => {
    stopped = true;
  };
  process.once('SIGINT', stopRequested);
  process.once('SIGTERM', stopRequested);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  const observe = (phase) => {
    const path = join(root, `provider-${phase}.jsonl`);
    return existsSync(path)
      ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
  };
  async function waitFor(check, message, milliseconds = 15_000) {
    const until = Math.min(deadline, Date.now() + milliseconds);
    while (Date.now() < until) {
      if (stopped) throw new Error('Smoke interrupted; its private fixture is retained.');
      if (await check()) return;
      await delay(100);
    }
    throw new Error(message);
  }
  async function api(path, body, timeout = 10_000) {
    const response = await fetch(`${origin}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(timeout, deadline - Date.now()))),
    });
    const value = await response.json();
    assert(
      response.ok,
      `${path} returned ${response.status}: ${JSON.stringify(value).slice(0, 800)}`,
    );
    return value;
  }
  async function start(phase) {
    const child = spawn(process.execPath, ['--import', scriptPath, mainPath], {
      cwd: repository,
      env: {
        ...process.env,
        DOCK_DATA_DIR: root,
        DOCK_PORT: String(port),
        DOCK_CODEX_BIN: binary,
        DOCK_WORKSPACE_SMOKE_PHASE: phase,
        DOCK_LAUNCHER_LIFETIME: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mainProcesses.push(child);
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) =>
        appendFileSync(join(root, `host-${phase}.log`), chunk, { mode: 0o600 }),
      );
    child.on('error', () => {});
    console.log(`Owned ${phase} host PID ${child.pid}, port ${port}`);
    await waitFor(async () => {
      assert(
        child.exitCode === null && child.signalCode === null,
        'The smoke host exited during startup.',
      );
      try {
        const health = await api('/health', undefined, 1000);
        return health.ok && health.pid === child.pid && !health.demo;
      } catch {
        return false;
      }
    }, 'The disposable production host did not become ready.');
    return child;
  }
  async function collectDescendants(child) {
    const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { timeout: 5000 });
    const rows = stdout
      .trim()
      .split('\n')
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
        return match
          ? { pid: Number(match[1]), ppid: Number(match[2]), started: match[3], command: match[4] }
          : null;
      })
      .filter(Boolean);
    const selected = new Set([child.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows)
        if (selected.has(row.ppid) && !selected.has(row.pid)) {
          selected.add(row.pid);
          descendants.set(row.pid, row);
          changed = true;
        }
    }
    return [...selected].filter((pid) => pid !== child.pid);
  }
  const read = (table) =>
    db
      .prepare(`SELECT body FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => JSON.parse(row.body));
  const evidence = () => ({
    agents: ids.map((id) => {
      const agent = read('agents').find((value) => value.id === id);
      const {
        threadId,
        model,
        effort,
        permission,
        mcpServers,
        pluginsEnabled,
        webSearch,
        imageGeneration,
      } = agent;
      return {
        id,
        threadId,
        model,
        effort,
        permission,
        mcpServers,
        pluginsEnabled,
        webSearch,
        imageGeneration,
      };
    }),
    runs: read('runs'),
    entries: read('entries'),
  });
  try {
    console.log(`Five-session crash/restart fixture ${root}; ${version.trim()}`);
    const first = await start('before');
    db = new DatabaseSync(join(root, 'dock.sqlite'), { readOnly: true });
    assert.equal(read('runs').length, 0, 'Fixture creation alone must not execute a model.');
    assert(read('agents').every((agent) => agent.threadId === null));
    const runs = await Promise.all(
      ids.map((id, index) =>
        api(`/agents/${id}/messages`, {
          key: randomUUID(),
          text: `This is an owner-authorized disposable transport check, not project work. Reply exactly RESTART-READY-${index + 1} and stop. Do not use tools, create tasks, delegate, inspect files, save a checkpoint, plan or perform any external action.`,
        }),
      ),
    );
    await waitFor(
      () => {
        assert.equal(
          read('approvals').length,
          0,
          'An original approval appeared; it was not auto-answered.',
        );
        assert.equal(read('tasks').length, 0, 'A transport fixture must not create work.');
        const current = read('runs');
        assert(
          !current.some((run) => ['failed', 'interrupted'].includes(run.status)),
          'A real provider turn failed; no automatic retry.',
        );
        return current.length === 5 && current.every((run) => run.status === 'completed');
      },
      'Five brief real provider turns did not complete within the bounded window.',
      130_000,
    );
    assert.equal(
      observe('before').filter(
        (event) => event.kind === 'notification' && event.method === 'turn/started',
      ).length,
      5,
    );
    for (const [index, id] of ids.entries())
      assert(
        read('entries').some(
          (entry) =>
            entry.agentId === id &&
            entry.kind === 'assistant' &&
            entry.text.trim() === `RESTART-READY-${index + 1}`,
        ),
      );
    assert(
      !read('entries').some((entry) => entry.kind === 'tool'),
      'The five readiness replies must not call tools.',
    );
    let views = workspaceSnapshotSchema.parse(
      await api('/workspace/clients', { key: randomUUID(), label: 'Disposable desktop' }),
    );
    for (const id of ids) {
      const update = workspaceUpdateResultSchema.parse(
        await api(`/workspace/${views.client.id}`, {
          key: randomUUID(),
          hostId: views.hostId,
          revision: views.client.revision,
          action: { kind: 'open', agentId: id },
        }),
      );
      assert.equal(update.status, 'applied');
      views = update.state;
    }
    const before = evidence();
    assert(before.agents.every((agent) => agent.threadId && agent.model));
    assert.equal(new Set(before.agents.map((agent) => agent.threadId)).size, 5);
    const providerBefore = observe('before')
      .filter((event) => event.kind === 'provider-host')
      .map((event) => event.pid);
    assert.equal(providerBefore.length, 5);
    const treeBefore = await collectDescendants(first);
    assert(providerBefore.every((pid) => treeBefore.includes(pid)));
    assert(
      treeBefore.length >= 10,
      'Expected the five owned provider hosts and their Codex children.',
    );
    first.kill('SIGKILL'); // Exact owned PID only; simulate abrupt gateway/power loss.
    await waitFor(() => first.signalCode === 'SIGKILL', 'The owned host did not stop.');
    await waitFor(
      () => treeBefore.every((pid) => !alive(pid)),
      'Provider descendants survived lifetime-pipe loss.',
      5000,
    );
    console.log(
      `Crash cleanup verified for ${treeBefore.length} exact owned provider descendants.`,
    );
    db.close();
    const second = await start('after');
    db = new DatabaseSync(join(root, 'dock.sqlite'), { readOnly: true });
    assert.deepEqual(
      workspaceSnapshotSchema.parse(await api(`/workspace/${views.client.id}`)),
      views,
    );
    const restored = workspaceRestoreResultsSchema.parse(
      await api(`/workspace/${views.client.id}/restore`, { hostId: views.hostId }, 55_000),
    );
    assert.deepEqual(
      restored.map((result) => result.agentId),
      ids,
    );
    assert(
      restored.every((result) => result.state === 'connected'),
      'Every saved conversation must reconnect.',
    );
    assert.deepEqual(
      evidence(),
      before,
      'Reconnection must preserve exact provider identities, settings, runs and archive.',
    );
    await delay(1200); // Exercise the ordinary queue timer after reattachment.
    assert.deepEqual(evidence(), before, 'No queued input may be replayed after restoration.');
    const afterEvents = observe('after');
    assert.equal(
      afterEvents.filter((event) => event.kind === 'request' && event.method === 'thread/resume')
        .length,
      5,
    );
    assert.deepEqual(
      afterEvents
        .filter((event) => event.kind === 'thread-identity' && event.method === 'thread/resume')
        .map((event) => event.threadId)
        .sort(),
      before.agents.map((agent) => agent.threadId).sort(),
      'The provider must acknowledge the same five saved identities.',
    );
    assert(
      !afterEvents.some(
        (event) =>
          event.kind === 'request' &&
          ['thread/start', 'turn/start', 'turn/steer'].includes(event.method),
      ),
    );
    assert(
      !afterEvents.some(
        (event) => event.kind === 'notification' && event.method === 'turn/started',
      ),
    );
    const treeAfter = await collectDescendants(second);
    const providerAfter = afterEvents
      .filter((event) => event.kind === 'provider-host')
      .map((event) => event.pid);
    assert.equal(providerAfter.length, 5);
    assert(providerAfter.every((pid) => treeAfter.includes(pid)));
    second.kill('SIGTERM');
    await waitFor(() => second.exitCode === 0, 'The restarted host did not shut down cleanly.');
    await waitFor(
      () => treeAfter.every((pid) => !alive(pid)),
      'A restored provider descendant survived shutdown.',
      5000,
    );
    writeFileSync(
      join(root, 'verification.json'),
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          version: version.trim(),
          hostPids: mainProcesses.map((child) => child.pid),
          providerHostPids: [...providerBefore, ...providerAfter],
          descendants: [...descendants.values()],
          modelTurnsBefore: 5,
          modelTurnsAfter: 0,
          providerResumeRequests: 5,
          hostId: views.hostId,
          clientId: views.client.id,
          identities: before.agents,
          runIds: runs.map((run) => run.id),
          entryIds: before.entries.map((entry) => entry.id),
          archiveSha256: createHash('sha256').update(JSON.stringify(before.entries)).digest('hex'),
          checks: [
            'five real saved threads',
            'exact owned main SIGKILL and lifetime-pipe descendant cleanup',
            'persisted workspace restored through typed HTTP API',
            'same thread IDs, model/settings, runs and exact archive',
            'five thread/resume calls and zero new model turns, replayed input or reconstructed history',
            'clean restarted-host/provider shutdown; no browser, phone tunnel or backup configured',
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      `PASS: five real saved sessions survived owned host crash/restart; five initial model turns, zero on restore. Private evidence: ${root}`,
    );
  } finally {
    if (db?.isOpen) db.close();
    for (const child of mainProcesses) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await collectDescendants(child).catch(() => {});
      child.kill('SIGTERM');
      const until = Date.now() + 10_000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < until)
        await delay(100);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    // Fallback cleanup only of exact descendants already proved owned by this fixture.
    await delay(1200);
    for (const [pid, original] of descendants)
      if (alive(pid)) {
        const current = await exec('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 3000 })
          .then(({ stdout }) => stdout.trim())
          .catch(() => null);
        // A recycled PID is not authority to stop another process.
        if (current !== original.started) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    const until = Date.now() + 3000;
    while ([...descendants.keys()].some(alive) && Date.now() < until) await delay(100);
    assert(
      mainProcesses.every((child) => !alive(child.pid)),
      'An owned smoke main process remains.',
    );
    assert(
      [...descendants.keys()].every((pid) => !alive(pid)),
      'An owned provider descendant remains.',
    );
    process.off('SIGINT', stopRequested);
    process.off('SIGTERM', stopRequested);
    console.log('All owned hosts and provider descendants are closed; no browser was started.');
  }
}

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
