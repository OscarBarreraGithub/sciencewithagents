import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { id, projectCreateSchema, projectSchema, projectWorkflowSchema } from '@dock/shared';
import { Conflict, type Store } from './store.js';
import { git } from './workspaces.js';

function directory(path: string) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // Never follow a substituted managed folder into someone else's files.
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
    throw new Error('The managed project folder is not a directory.');
}

/** Caller serializes by request key. Only newly allocated, private folders are writable. */
export async function createProject(store: Store, dataDir: string, raw: unknown) {
  const input = projectCreateSchema.parse(raw);
  const key = `project-create:${input.key}`;
  const saved = store.getSetting(key) as {
    directoryId: string;
    name: string;
    description: string;
    provider?: 'codex' | 'claude';
    requestedProvider?: 'codex' | 'claude' | 'policy';
    executionMode?: 'direct' | 'managed';
  } | null;
  if (
    saved &&
    (saved.name !== input.name ||
      saved.description !== input.description ||
      (saved.requestedProvider ?? saved.provider ?? 'policy') !== (input.provider ?? 'policy') ||
      (input.executionMode && input.executionMode !== (saved.executionMode ?? 'managed')))
  )
    throw new Conflict(
      'This request already belongs to a different project. Reopen the form to start another.',
    );
  const intent = saved ?? {
    directoryId: randomUUID(),
    name: input.name,
    description: input.description,
    provider: store.defaultProvider('manager', input.provider),
    requestedProvider: input.provider ?? 'policy',
    executionMode: input.executionMode ?? 'managed',
  };
  id.parse(intent.directoryId);
  if (!saved)
    store.transaction(() => {
      store.setSetting(key, intent);
      store.event('project.creation_requested', null, null, { key: input.key });
    });
  try {
    const parent = join(realpathSync(dataDir), 'projects');
    const root = join(parent, intent.directoryId);
    const existing = store.projects().find((project) => project.root === root);
    const configure = (project: ReturnType<Store['register']>) => {
      if (!store.getSetting(`project-workflow:${project.id}`))
        store.setSetting(
          `project-workflow:${project.id}`,
          projectWorkflowSchema.parse({
            providerMix: intent.provider === 'claude' ? 'claude-only' : 'codex-only',
          }),
        );
      return projectSchema.parse(project);
    };
    if (existing) return configure(existing);
    directory(parent);
    directory(root);
    // A retry may encounter our partial Git setup, but must not adopt unrelated files.
    if (readdirSync(root).some((name) => name !== '.git'))
      throw new Error('Unexpected files in an unfinished project.');
    if (readdirSync(root).includes('.git')) directory(join(root, '.git'));
    const run = (args: string[]) =>
      git(root, ['--git-dir', join(root, '.git'), '--work-tree', root, ...args]);
    await run(['init', '--template=', '--initial-branch=main', '--', root]);
    // Local identity keeps automatic saves usable without global Git setup or credentials.
    await run(['config', '--local', 'user.name', 'sciencewithagents']);
    await run(['config', '--local', 'user.email', 'agent-dock@localhost']);
    let head = '';
    try {
      head = await run(['rev-parse', '--verify', 'HEAD']);
    } catch {
      // Only an empty managed repository needs its initial checkpoint.
    }
    if (!head)
      await run(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Start project']);
    // Registration and its manager/event are atomic. A lost acknowledgement or restart
    // resolves this same reserved root; it cannot create a second project or initial commit.
    return configure(
      store.register(
        root,
        input.name,
        input.description,
        intent.provider,
        undefined,
        intent.executionMode ?? 'managed',
      ),
    );
  } catch {
    store.event('project.creation_failed', null, null, { key: input.key });
    throw new Conflict(
      'We couldn’t finish setting up your project. Your details are saved. Try Create project again; if it still fails, ask the person who installed sciencewithagents to check its storage and Git installation.',
    );
  }
}
