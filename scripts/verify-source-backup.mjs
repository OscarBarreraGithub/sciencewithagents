// Explicit live transport check: creates then removes one unique source-only backup branch.
// It never writes to the owner's app database or starts a provider/server/browser.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../apps/server/dist/store.js';
import {
  SourceBackups,
  sourceBackupStatus,
  backupConfigSchema,
} from '../apps/server/dist/source-backups.js';
import { repoRoot } from '../apps/server/dist/paths.js';

const [repository, confirm] = process.argv.slice(2);
if (!repository || confirm !== '--confirm-private-backup') {
  throw new Error(
    'Agent-only check: supply owner/private-repository and --confirm-private-backup after inspecting the exact destination.',
  );
}
process.umask(0o077);
const exec = promisify(execFile);
const git = async (args) =>
  (
    await exec(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'credential.https://github.com.helper=',
        '-c',
        'credential.https://github.com.helper=!gh auth git-credential',
        ...args,
      ],
      {
        cwd: repoRoot,
        timeout: 30_000,
        maxBuffer: 16_384,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
    )
  ).stdout.trim();
const commit = await git(['rev-parse', 'HEAD']);
const base = await git(['rev-parse', 'HEAD^']);
mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
const fixture = mkdtempSync(join(repoRoot, 'data/tests/source-backup-live-'));
const store = new Store(join(fixture, 'dock.sqlite'));
let backups, ref;
try {
  const project = store.register(
    repoRoot,
    'Source backup transport fixture',
    'Not an owner project or real review.',
  );
  const config = backupConfigSchema.parse([{ projectId: project.id, repository, branch: 'main' }]);
  const task = store.addTask(project.id, {
    title: 'Transport fixture',
    goal: 'Verify source transport only',
    acceptance: 'Exact remote SHA',
    parentId: null,
  });
  const reviewer = store.addAgent({
    projectId: project.id,
    taskId: task.id,
    parentId: project.managerId,
    role: 'reviewer',
    name: 'Fixture marker, not model review',
    cwd: repoRoot,
  });
  ref = `refs/heads/agent-dock/task-${task.id}`;
  if (await git(['ls-remote', '--heads', `https://github.com/${repository}.git`, ref]))
    throw new Error('The generated fixture branch already exists; nothing will be changed.');
  store.updateTask(task.id, {
    status: 'done',
    worktree: repoRoot,
    baseCommit: base,
    reviewedCommit: commit,
    reviewAgentId: reviewer.id,
    review: 'approve',
  });
  backups = new SourceBackups(store, fixture, undefined, config);
  backups.start();
  await backups.idle();
  const status = sourceBackupStatus(store, project.id);
  if (status.state !== 'saved' || status.commit !== commit) throw new Error(status.message);
  console.log(JSON.stringify({ verified: true, repository, ref, commit }));
  const remote = await git(['ls-remote', '--heads', `https://github.com/${repository}.git`, ref]);
  if (remote !== `${commit}\t${ref}`)
    throw new Error('The fixture branch changed; leave it for inspection instead of deleting it.');
  await git([
    'push',
    '--porcelain',
    `https://github.com/${repository}.git`,
    '--delete',
    ref.slice('refs/heads/'.length),
  ]);
  if (await git(['ls-remote', '--heads', `https://github.com/${repository}.git`, ref]))
    throw new Error('Fixture cleanup could not be confirmed.');
  console.log(
    'Temporary verification branch removed. The source commit and main branch are unchanged.',
  );
} catch (error) {
  // Deliberately omit command stderr, which can contain credentials from external helpers.
  console.error(
    error && 'cmd' in error
      ? 'Live GitHub verification needs local inspection; credentials and command output were omitted.'
      : String(error.message),
  );
  if (ref) console.error(`Inspect the scoped fixture branch if present: ${ref}`);
  process.exitCode = 1;
} finally {
  await backups?.close();
  store.close();
  rmSync(fixture, { recursive: true, force: true });
}
