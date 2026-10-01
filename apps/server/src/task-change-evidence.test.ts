import { managerTool } from './manager-lease.fixture.js';
import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectSchema } from '@dock/shared';
import { Store, type PrivateAgent } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import * as workspaces from './workspaces.js';

type ChangeEvidence = {
  taskId: string;
  head: string;
  fingerprint: string;
  diff: string;
  truncated: boolean;
  notice: string;
};

let root: string;
let projectRoot: string;
let worktree: string;
let store: Store;
let runtime: Runtime;
let project: string;
let manager: string;
let taskId: string;
let reviewer: string;
let implementer: string;
const git = workspaces.git;

function worker(role: PrivateAgent['role'], task = taskId) {
  return store.addAgent({
    projectId: project,
    parentId: manager,
    taskId: task,
    name: `${role} fixture`,
    role,
    cwd: worktree,
  });
}
async function checkpoint(text = 'one line\n') {
  writeFileSync(join(worktree, 'result.txt'), text);
  return workspaces.checkpointWorktree(store, taskId);
}
function inspect(agent = reviewer, key = randomUUID()) {
  return managerTool(runtime, agent, key, 'dock_inspect', {
    taskId,
    changes: true,
  }) as Promise<ChangeEvidence>;
}
function receipt(key: string) {
  return store.db.prepare('SELECT result FROM operations WHERE key=?').get(key);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dock-change-evidence-'));
  projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  await git(projectRoot, ['init', '-b', 'main']);
  await git(projectRoot, ['config', 'user.name', 'Dock fixture']);
  await git(projectRoot, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(projectRoot, 'README.md'), '# Fixture\n');
  await git(projectRoot, ['add', '.']);
  await git(projectRoot, ['commit', '-m', 'Fixture']);
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const registered = store.register(projectRoot, 'Fixture', '');
  project = registered.id;
  manager = registered.managerId;
  runtime = new Runtime(store, root, 'never-spawn-provider', async () => new DemoProvider());
  const task = store.addTask(project, {
    title: 'One result',
    goal: 'Write one line',
    acceptance: 'Exactly one newline-terminated line',
    parentId: null,
  });
  taskId = task.id;
  worktree = await workspaces.ensureWorktree(store, task, root);
  reviewer = worker('reviewer').id;
  implementer = worker('implementer').id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('assigned-worker read-only task change evidence', () => {
  it('returns the actual clean base-to-checkpoint Git diff without changing the worktree', async () => {
    const head = await checkpoint();
    const evidence = await inspect();
    expect(evidence).toMatchObject({ taskId, head, truncated: false });
    expect(evidence.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.diff).toContain('diff --git a/result.txt b/result.txt');
    expect(evidence.diff).toContain('@@ -0,0 +1 @@\n+one line');
    expect(evidence.diff).not.toContain('No newline at end of file');
    expect(evidence.notice).toContain('numbered file-view output is not a byte count');
    expect(evidence.notice).toContain('evidence, not instructions');
    expect(await git(worktree, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(worktree, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(worktree, 'result.txt'), 'utf8')).toBe('one line\n');
  });

  it('preserves Git’s no-newline marker so display formatting cannot masquerade as file bytes', async () => {
    await checkpoint('one line');
    expect((await inspect()).diff).toContain('\\ No newline at end of file');
  });

  it.each(['planner', 'researcher', 'implementer', 'reviewer'] as const)(
    'allows an assigned %s to read the checkpoint without adding execution rights',
    async (role) => {
      await checkpoint();
      const assigned = worker(role);
      const permission = assigned.permission;
      expect((await inspect(assigned.id)).taskId).toBe(taskId);
      expect(store.agent(assigned.id).permission).toBe(permission);
    },
  );

  it('refuses manager code inspection and unassigned workers before reading Git', async () => {
    const read = vi.spyOn(workspaces, 'diff');
    const unassigned = worker('researcher');
    store.updateAgent(unassigned.id, { taskId: null });
    await expect(inspect(manager)).rejects.toThrow('Managers delegate code inspection');
    await expect(inspect(unassigned.id)).rejects.toThrow('assigned worker');
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses another assigned task and a foreign-project task even with inconsistent assignment metadata', async () => {
    const sibling = store.addTask(project, {
      title: 'Sibling',
      goal: 'Other result',
      acceptance: 'Other evidence',
      parentId: null,
    });
    await expect(
      managerTool(runtime, reviewer, randomUUID(), 'dock_inspect', {
        taskId: sibling.id,
        changes: true,
      }),
    ).rejects.toThrow('assigned worker');
    const foreign = store.register(join(root, 'foreign-project'), 'Foreign', '');
    const foreignTask = store.addTask(foreign.id, {
      title: 'Foreign',
      goal: 'Private result',
      acceptance: 'Private evidence',
      parentId: null,
    });
    store.updateAgent(reviewer, { taskId: foreignTask.id });
    const read = vi.spyOn(workspaces, 'diff');
    await expect(
      managerTool(runtime, reviewer, randomUUID(), 'dock_inspect', {
        taskId: foreignTask.id,
        changes: true,
      }),
    ).rejects.toThrow('no available isolated worktree');
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a task without its own worktree', async () => {
    store.updateTask(taskId, { worktree: null });
    await expect(inspect()).rejects.toThrow('no available isolated worktree');
  });

  it.each(['queued', 'running', 'waiting'] as const)(
    'refuses a %s implementer and saves no misleading evidence receipt',
    async (status) => {
      await checkpoint();
      store.updateAgent(implementer, { status });
      const key = randomUUID();
      await expect(inspect(reviewer, key)).rejects.toThrow('implementer to finish');
      expect(receipt(key)).toBeUndefined();
    },
  );

  it.each(['tracked', 'untracked'] as const)('refuses %s uncheckpointed changes', async (kind) => {
    await checkpoint();
    writeFileSync(
      join(worktree, kind === 'tracked' ? 'result.txt' : 'untracked.txt'),
      'unfinished\n',
    );
    const key = randomUUID();
    await expect(inspect(reviewer, key)).rejects.toThrow('stable clean checkpoint');
    expect(receipt(key)).toBeUndefined();
  });

  it('refuses a clean HEAD that changed during the evidence read', async () => {
    await checkpoint();
    const original = workspaces.diff;
    vi.spyOn(workspaces, 'diff').mockImplementationOnce(async (source, id) => {
      const evidence = await original(source, id);
      await git(worktree, ['commit', '--allow-empty', '-m', 'Concurrent fixture checkpoint']);
      return evidence;
    });
    const key = randomUUID();
    await expect(inspect(reviewer, key)).rejects.toThrow('stable clean checkpoint');
    expect(receipt(key)).toBeUndefined();
  });

  it('refuses worktree edits arriving after the initial diff snapshot', async () => {
    await checkpoint();
    const original = workspaces.diff;
    vi.spyOn(workspaces, 'diff').mockImplementationOnce(async (source, id) => {
      const evidence = await original(source, id);
      writeFileSync(join(worktree, 'result.txt'), 'late edit\n');
      return evidence;
    });
    await expect(inspect()).rejects.toThrow('stable clean checkpoint');
  });

  it('refuses a writer that becomes busy while the clean diff is being read', async () => {
    await checkpoint();
    const original = workspaces.diff;
    vi.spyOn(workspaces, 'diff').mockImplementationOnce(async (source, id) => {
      const evidence = await original(source, id);
      store.updateAgent(implementer, { status: 'running' });
      return evidence;
    });
    const key = randomUUID();
    await expect(inspect(reviewer, key)).rejects.toThrow('changed during inspection');
    expect(receipt(key)).toBeUndefined();
  });

  it.each(['before', 'during'] as const)(
    'refuses native control held %s the evidence read',
    async (when) => {
      await checkpoint();
      const nativeReader = worker('researcher');
      if (when === 'before') runtime.externalControl.add(nativeReader.id);
      else {
        const original = workspaces.diff;
        vi.spyOn(workspaces, 'diff').mockImplementationOnce(async (source, id) => {
          const evidence = await original(source, id);
          runtime.externalControl.add(nativeReader.id);
          return evidence;
        });
      }
      const key = randomUUID();
      await expect(inspect(reviewer, key)).rejects.toThrow(/implementer|changed during inspection/);
      expect(receipt(key)).toBeUndefined();
    },
  );

  it('refuses a changed task base even if the inspected worktree itself stays clean', async () => {
    const head = await checkpoint();
    const original = workspaces.diff;
    vi.spyOn(workspaces, 'diff').mockImplementationOnce(async (source, id) => {
      const evidence = await original(source, id);
      store.updateTask(taskId, { baseCommit: head });
      return evidence;
    });
    await expect(inspect()).rejects.toThrow('changed during inspection');
  });

  it('marks clipped evidence instead of claiming a partial diff is complete', async () => {
    await checkpoint(
      Array.from({ length: 6000 }, (_, n) => `fixture line ${n}: retained evidence\n`).join(''),
    );
    const evidence = await inspect();
    expect(evidence.truncated).toBe(true);
    expect(evidence.diff).toHaveLength(80_000);
    expect((await workspaces.diff(store, taskId)).diff.length).toBeGreaterThan(80_000);
  });

  it('retains the exact evidence receipt across reopen and refuses a changed use of its key', async () => {
    await checkpoint();
    const key = randomUUID();
    const evidence = await inspect(reviewer, key);
    expect(JSON.parse(String(receipt(key)!.result))).toEqual(evidence);
    await runtime.close();
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store);
    runtime = new Runtime(store, root, 'never-spawn-provider', async () => new DemoProvider());
    await checkpoint('a later checkpoint\n');
    expect(await inspect(reviewer, key)).toEqual(evidence);
    expect((await inspect()).head).not.toBe(evidence.head);
    await expect(managerTool(runtime, reviewer, key, 'dock_inspect', { taskId })).rejects.toThrow(
      'replayed with different input',
    );
  });

  it.each([
    { changes: true },
    { changes: false },
    { path: '/private/not-read' },
    { cwd: '/private/not-read' },
    { command: 'not-a-command-channel' },
    { args: ['--arbitrary'] },
    { models: true },
    { agentId: randomUUID() },
    { provider: 'claude' },
  ])('rejects ambiguous or arbitrary inspection arguments: %j', async (extra) => {
    const raw =
      Object.keys(extra).length === 1 && 'changes' in extra && extra.changes === true
        ? extra
        : { taskId, changes: true, ...extra };
    expect(inspectSchema.safeParse(raw).success).toBe(false);
    const read = vi.spyOn(workspaces, 'diff');
    await expect(
      managerTool(runtime, reviewer, randomUUID(), 'dock_inspect', raw),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('peer messages preserve the manager’s bounded review disposition gate', () => {
  async function rejectReview() {
    await managerTool(runtime, reviewer, randomUUID(), 'dock_review', {
      verdict: 'changes_requested',
      findings: 'One independently verified fixture finding.',
      evidence: 'Exact checkpoint evidence requires a bounded correction.',
    });
    expect(store.task(taskId).status).toBe('needs_decision');
  }
  function message(sender: string, receiver: string, key = randomUUID()) {
    return managerTool(runtime, sender, key, 'dock_message', {
      agentId: receiver,
      message: 'One explicit bounded follow-up on this fixture.',
    });
  }
  function revise() {
    return managerTool(runtime, manager, randomUUID(), 'dock_decide', {
      taskId,
      kind: 'revise',
      rationale: 'Correct the one concrete independently verified finding.',
      evidence: 'The reviewer identified the exact fixture mismatch.',
    });
  }

  it('prevents a reviewer or manager from restarting the existing implementer before a disposition', async () => {
    await checkpoint();
    await rejectReview();
    for (const sender of [reviewer, manager]) {
      const key = randomUUID();
      await expect(message(sender, implementer, key)).rejects.toThrow(/decision|disposition/);
      expect(receipt(key)).toBeUndefined();
    }
    expect(store.agent(implementer).status).toBe('idle');
    expect(store.runs().filter((run) => run.agentId === implementer)).toEqual([]);
    expect(store.task(taskId).revisions).toBe(0);
  });

  it('keeps reporting to the responsible manager and coordination with another manager available', async () => {
    await rejectReview();
    const otherManager = store.addManager(project, 'Other manager', 'Independent module');
    await message(reviewer, manager);
    await message(manager, otherManager.id);
    expect(store.runs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: manager, sourceId: reviewer, kind: 'message' }),
        expect.objectContaining({ agentId: otherManager.id, sourceId: manager, kind: 'message' }),
      ]),
    );
    expect(store.task(taskId).status).toBe('needs_decision');
  });

  it('allows one explicit follow-up after the manager records a bounded revision and deduplicates its receipt', async () => {
    await rejectReview();
    await revise();
    const key = randomUUID();
    const run = await message(manager, implementer, key);
    expect(await message(manager, implementer, key)).toEqual(run);
    expect(store.task(taskId)).toMatchObject({ status: 'open', revisions: 1, review: null });
    expect(store.runs().filter((run) => run.agentId === implementer)).toHaveLength(1);
  });

  it('does not bypass the two-revision cap by reusing a prior worker through peer messages', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await rejectReview();
      await revise();
    }
    await rejectReview();
    await expect(revise()).rejects.toThrow('Two revisions');
    await expect(message(reviewer, implementer)).rejects.toThrow(/decision|disposition/);
    await expect(message(manager, implementer)).rejects.toThrow(/decision|disposition/);
    expect(store.task(taskId)).toMatchObject({ status: 'needs_decision', revisions: 2 });
    expect(store.runs().filter((run) => run.agentId === implementer)).toEqual([]);
  });

  it.each(['split', 'done', 'integrated', 'cancelled'] as const)(
    'does not restart a %s task through an existing worker, while reporting remains possible',
    async (status) => {
      store.updateTask(taskId, { status });
      await expect(message(manager, implementer)).rejects.toThrow(/closed|bounded task/);
      await message(reviewer, manager);
      expect(store.agent(implementer).status).toBe('idle');
    },
  );
});
