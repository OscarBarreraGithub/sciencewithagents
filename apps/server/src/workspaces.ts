import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync, statSync, mkdirSync, lstatSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { integrationPreviewSchema, integrationRequestSchema } from '@dock/shared';
import { Conflict, publicTask, type Store, type PrivateTask } from './store.js';
import { appNotificationTitle, reconcileRunKey } from './app-notifications.js';
import { projectWorkflow } from './project-workflow.js';

const exec = promisify(execFile);
export async function git(cwd: string, args: string[]) {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trimEnd();
}
export async function validateRoot(root: string, dataDir: string) {
  if (!isAbsolute(root)) throw new Error('Use an absolute project path.');
  const canonical = realpathSync(root);
  if (
    !statSync(canonical).isDirectory() ||
    canonical === '/' ||
    canonical === resolve(dataDir) ||
    canonical.startsWith(`${resolve(dataDir)}/`)
  )
    throw new Error('Register a project directory outside runtime storage.');
  const top = realpathSync(await git(canonical, ['rev-parse', '--show-toplevel']));
  if (top !== canonical) throw new Error('Register the Git repository root.');
  await git(canonical, ['rev-parse', '--verify', 'HEAD']);
  return canonical;
}
export async function ensureWorktree(store: Store, task: PrivateTask, dataDir: string) {
  if (task.worktree) {
    await git(task.worktree, ['rev-parse', '--verify', 'HEAD']);
    return task.worktree;
  }
  const project = store.project(task.projectId);
  const baseCommit = await git(project.root, ['rev-parse', 'HEAD']);
  const worktree = join(dataDir, 'worktrees', task.id);
  mkdirSync(join(dataDir, 'worktrees'), { recursive: true, mode: 0o700 });
  // Each task owns one branch. Workers on a task are serialized around its writer.
  await git(project.root, ['worktree', 'add', '-b', `dock/${task.id}`, worktree, baseCommit]);
  store.updateTask(task.id, { worktree, baseCommit });
  return worktree;
}
export async function diff(store: Store, taskId: string) {
  const task = store.task(taskId);
  if (!task.worktree || !task.baseCommit)
    return { diff: '', status: '', head: '', fingerprint: '' };
  const [changes, status, head, untracked] = await Promise.all([
    git(task.worktree, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      task.baseCommit,
      '--',
    ]),
    git(task.worktree, ['status', '--short']),
    git(task.worktree, ['rev-parse', 'HEAD']),
    git(task.worktree, ['ls-files', '--others', '--exclude-standard']),
  ]);
  return {
    diff: changes,
    status,
    head,
    fingerprint: createHash('sha256')
      .update(JSON.stringify([changes, status, head, untracked]))
      .digest('hex'),
  };
}
export async function checkpointWorktree(store: Store, taskId: string) {
  const task = store.task(taskId);
  if (!task.worktree) throw new Conflict('There is no worktree yet.');
  const status = await git(task.worktree, ['status', '--porcelain']);
  if (status) {
    await checkCheckpointFiles(task.worktree);
    await git(task.worktree, ['add', '--all']);
    await git(task.worktree, ['-c', 'commit.gpgsign=false', 'commit', '-m', `Task: ${task.title}`]);
  }
  return git(task.worktree, ['rev-parse', 'HEAD']);
}
export async function checkCheckpointFiles(worktree: string) {
  const changed = await git(worktree, ['diff', '--name-only', '-z', 'HEAD', '--']);
  const untracked = await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const name of new Set(`${changed}\0${untracked}`.split('\0').filter(Boolean))) {
    const path = join(worktree, name);
    if (!existsSync(path)) continue; // Deleting a mistakenly tracked secret is allowed.
    const sample = /(?:^|\/)\.env\.(?:example|sample|template)$/.test(name);
    if (
      (!sample &&
        /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|id_rsa|id_ed25519)(?:$|\/)/i.test(
          name,
        )) ||
      /\.(?:pem|p12|pfx|key|sqlite|sqlite3|db|log)$/i.test(name) ||
      /(?:^|\/)(?:uploads|logs)\//i.test(name)
    ) {
      throw new Conflict(
        'Automatic checkpoint blocked a likely credential or runtime file. Inspect the task worktree locally and remove private files from the proposed commit.',
      );
    }
    const stat = lstatSync(path);
    if (!stat.isFile()) continue;
    if (stat.size > 4 * 1024 * 1024)
      throw new Conflict(
        'Automatic checkpoint requires local inspection of a file larger than 4 MB.',
      );
    const content = readFileSync(path, 'utf8');
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16})\b/.test(
        content,
      )
    ) {
      throw new Conflict(
        'Automatic checkpoint blocked a likely secret value. Inspect the task worktree locally; no secret value is included in this error.',
      );
    }
  }
}
export async function integrationPreview(store: Store, taskId: string) {
  const task = store.task(taskId);
  if (task.status !== 'done' || !task.worktree || !task.reviewedCommit)
    throw new Conflict('Finish and review the task before integration.');
  const project = store.project(task.projectId);
  const [target, source, status, sourceStatus] = await Promise.all([
    git(project.root, ['rev-parse', 'HEAD']),
    git(task.worktree, ['rev-parse', 'HEAD']),
    git(project.root, ['status', '--porcelain']),
    git(task.worktree, ['status', '--porcelain']),
  ]);
  if (status || sourceStatus)
    throw new Conflict('Both the project and task worktree must be clean before integration.');
  if (source !== task.reviewedCommit)
    throw new Conflict('The task changed after review. Review the current commit first.');
  const ancestor = async (older: string, newer: string) => {
    try {
      await git(project.root, ['merge-base', '--is-ancestor', older, newer]);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return false;
      throw error;
    }
  };
  const forward = await ancestor(target, source);
  const included = !forward && (await ancestor(source, target));
  const relation = forward ? 'fast-forward' : included ? 'already-present' : 'diverged';
  // A divergent two-tip diff would falsely describe other tasks' additions as
  // deletions. Show this task's changes from the shared base until reconciled.
  const range = included
    ? [target, target]
    : forward
      ? [target, source]
      : [`${target}...${source}`];
  const [changes, patch] = await Promise.all([
    git(task.worktree, ['diff', '--no-ext-diff', '--no-textconv', '--stat', ...range, '--']),
    git(task.worktree, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', ...range, '--']),
  ]);
  return integrationPreviewSchema.parse({
    taskId,
    source,
    target,
    changes,
    patch,
    relation,
    canApply: relation !== 'diverged' && !task.reconciliationTaskId,
    reconciliationTaskId: task.reconciliationTaskId ?? null,
  });
}
export async function integrate(
  store: Store,
  taskId: string,
  expected: { source: string; target: string },
) {
  const preview = await integrationPreview(store, taskId);
  if (preview.source !== expected.source || preview.target !== expected.target)
    throw new Conflict('The integration preview is stale. Review a new preview.');
  if (!preview.canApply)
    throw new Conflict(
      'This project advanced while the task was being built. Prepare updated changes and review the follow-up before applying.',
    );
  const project = store.project(store.task(taskId).projectId);
  // A reconciliation is its own reviewed task. This final step stays exact and fast-forward only.
  await git(project.root, ['merge', '--ff-only', '--', preview.source]);
  store.updateTask(taskId, { status: 'integrated' });
  store.event('task.integrated', project.id, null, preview);
  return preview;
}

/**
 * Owner or manager action: preserve the reviewed task and prepare a separately reviewed
 * follow-up. The manager's handoff is an app notification, never an owner message.
 */
export async function reconcileTask(store: Store, taskId: string, raw: unknown) {
  const input = integrationRequestSchema.parse(raw),
    original = store.task(taskId);
  if (original.status !== 'done' || input.source !== original.reviewedCommit)
    throw new Conflict('Review the current finished task before preparing updated changes.');
  if (!original.reconciliationTaskId) {
    const preview = await integrationPreview(store, taskId);
    if (preview.source !== input.source || preview.target !== input.target)
      throw new Conflict(
        'The project changed. Refresh the preview before preparing updated changes.',
      );
    if (preview.relation !== 'diverged')
      throw new Conflict('These changes do not need reconciliation. Refresh the preview.');
  }
  return store.operation(input.key, { kind: 'task.reconcile', taskId, ...input }, () => {
    const current = store.task(taskId);
    if (current.reconciliationTaskId) return publicTask(store.task(current.reconciliationTaskId));
    const task = store.addTask(original.projectId, {
      title: `Update: ${original.title}`.slice(0, 160),
      goal: 'Bring the original reviewed changes up to date with the current project. Preserve the original task and all other completed work.',
      acceptance:
        "The original outcome still works, other completed work is preserved, conflicts are resolved in this separate task, and an independent reviewer approves the new checkpoint before its exact apply preview is applied under the project's saved apply policy.",
      parentId: original.id,
      managerId: original.managerId,
      scheduling: original.scheduling,
    });
    store.updateTask(original.id, { reconciliationTaskId: task.id });
    const apply =
      projectWorkflow(store, original.projectId).applyChanges === 'human'
        ? "This project requires the owner's review before applying changes: return the exact apply preview for the owner's confirmation."
        : 'Under the saved project policy the manager applies independently reviewed changes: inspect the exact apply preview and apply it. Owner confirmation is not required.';
    // Native delivery stays a user-role turn; the retained entry shows the app as its origin.
    const run = store.enqueue(
      task.managerId,
      reconcileRunKey(original.id),
      `App notification (generated by the app, not written by the owner): task ${original.id} (${original.title}) needs updated changes because the project advanced after its review. Manage follow-up task ${task.id}. The original reviewed source is ${input.source}; the project preview was ${input.target}. Delegate a worker in the NEW task worktree to incorporate the original reviewed outcome into the current project, resolve any conflicts there, and preserve other work. Inspect the original task for its goal and acceptance criteria. Do not modify the original task worktree or apply changes to the main checkout. Obtain an independent review of the new checkpoint. ${apply} This follow-up inherits the original task's allowance caps.`,
      'user',
    );
    const entry = store.entries(task.managerId).find((item) => item.id === run.id);
    if (entry) store.entry({ ...entry, kind: 'system', title: appNotificationTitle });
    store.setSetting(`pulsar:task:${run.id}`, task.id);
    store.event('task.reconciliation_requested', original.projectId, original.managerId, {
      taskId: original.id,
      followupTaskId: task.id,
      source: input.source,
      target: input.target,
    });
    return publicTask(task);
  });
}
