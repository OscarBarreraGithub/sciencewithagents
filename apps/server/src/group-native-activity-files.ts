import type { Store } from './store.js';
import { git } from './workspaces.js';
import { groupNativePrivatePath } from './group-native-private-path.js';
import {
  captureGroupFileChange,
  groupNativeActivityBinding,
} from './group-native-activity-producers.js';

/** Exact checkpoint commit, read from the server-selected task worktree. Never
 * publish host paths, file contents, credentials or a mutable directory listing. */
export async function captureGroupFileCheckpoint(
  store: Store,
  runId: string,
  taskId: string,
  commit: string,
) {
  if (!groupNativeActivityBinding(store, runId)) return;
  const task = store.task(taskId),
    run = store.run(runId),
    agent = store.agent(run.agentId);
  if (
    agent.taskId !== taskId ||
    !task.worktree ||
    agent.cwd !== task.worktree ||
    !/^[a-f0-9]{40,64}$/.test(commit)
  )
    return;
  const raw = await git(task.worktree, [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '--name-only',
    '-r',
    '-z',
    commit,
  ]);
  const all = raw.split('\0').filter(Boolean),
    safe = all.filter(
      (path) =>
        !groupNativePrivatePath(path) &&
        path.length <= 512 &&
        !path.startsWith('/') &&
        !/[\\\0\r\n]/.test(path) &&
        !path
          .split('/')
          .some(
            (part) =>
              part === '..' ||
              part.startsWith('.') ||
              /^(?:private|drafts?|credentials?|secrets?)(?:[._-]|$)/i.test(part),
          ) &&
        !/(?:^|\/)(?:auth\.json|cookies\.json|id_rsa|id_ed25519|[^/]*\.(?:pem|key|p12|pfx|sqlite3?|db|log))$/i.test(
          path,
        ) &&
        !/(?:^|\/)(?:uploads|logs)\//i.test(path),
    );
  captureGroupFileChange(
    store,
    runId,
    commit,
    safe.slice(0, 16),
    all.length > safe.length || safe.length > 16,
  );
}
