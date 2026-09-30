import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative, sep, isAbsolute } from 'node:path';
import { z } from 'zod';
import { backupStatusSchema, backupRepositorySchema, type BackupStatus } from '@dock/shared';
import { Conflict, type Store, type PrivateTask } from './store.js';
import { repoRoot } from './paths.js';

const exec = promisify(execFile);
const sha = /^[a-f0-9]{40,64}$/;
const repository = backupRepositorySchema;
const destinationSchema = z
  .object({
    projectId: z.string().uuid(),
    repository,
    branch: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/)
      .default('main'),
  })
  .strict();
export const backupConfigSchema = z
  .array(destinationSchema)
  .max(100)
  .refine(
    (items) => new Set(items.map((item) => item.projectId)).size === items.length,
    'Each project needs one backup destination.',
  );
type Destination = z.infer<typeof destinationSchema>;
type Receipt = { commit: string; verified: boolean };
class BackupProblem extends Error {}
async function run(cwd: string, args: string[], signal: AbortSignal, timeout = 30_000) {
  const { stdout } = await exec(
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
      cwd,
      signal,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  );
  return stdout.trimEnd();
}
const url = (repo: string) => `https://github.com/${repository.parse(repo)}.git`;
export interface BackupTransport {
  privateRepository(repo: string, signal: AbortSignal): Promise<boolean>;
  head(cwd: string, repo: string, ref: string, signal: AbortSignal): Promise<string | null>;
  push(cwd: string, repo: string, ref: string, commit: string, signal: AbortSignal): Promise<void>;
}
const github: BackupTransport = {
  async privateRepository(repo, signal) {
    const { stdout } = await exec(
      'gh',
      [
        'repo',
        'view',
        `https://github.com/${repository.parse(repo)}`,
        '--json',
        'nameWithOwner,isPrivate',
      ],
      {
        signal,
        timeout: 15_000,
        maxBuffer: 16_384,
      },
    );
    const value = z
      .object({ nameWithOwner: z.string(), isPrivate: z.boolean() })
      .parse(JSON.parse(stdout));
    return value.isPrivate && value.nameWithOwner.toLowerCase() === repo.toLowerCase();
  },
  async head(cwd, repo, ref, signal) {
    const result = await run(cwd, ['ls-remote', '--heads', url(repo), ref], signal);
    if (!result) return null;
    const [commit, actualRef] = result.split(/\s+/);
    if (!sha.test(commit) || actualRef !== ref)
      throw new BackupProblem('The backup branch could not be verified.');
    return commit;
  },
  async push(cwd, repo, ref, commit, signal) {
    await run(cwd, ['push', '--porcelain', url(repo), `${commit}:${ref}`], signal, 120_000);
  },
};

/** Inspect every newly exported commit, including blobs deleted from a later tree. */
async function inspectHistory(
  cwd: string,
  commit: string,
  remoteHeads: string[],
  signal: AbortSignal,
  dataDir: string,
) {
  // A research project's data/log/database files are source chosen for backup, not
  // necessarily this application's private runtime. Protect the actual host-owned
  // directory when it is inside the project, plus this clone's conventional data/.
  const source = realpathSync(cwd);
  const runtime = relative(source, realpathSync(dataDir));
  const runtimePaths = [
    ...(source === realpathSync(repoRoot) ? ['data'] : []),
    ...(!isAbsolute(runtime) && runtime !== '..' && !runtime.startsWith(`..${sep}`)
      ? [runtime.split(sep).join('/')]
      : []),
  ];
  const known: string[] = [];
  for (const head of remoteHeads) {
    if (!sha.test(head)) continue;
    try {
      await run(cwd, ['cat-file', '-e', `${head}^{commit}`], signal);
      known.push(head);
    } catch {
      signal.throwIfAborted();
    }
  }
  const history = (
    await run(cwd, ['rev-list', '--max-count=129', commit, '--not', ...known], signal)
  )
    .split('\n')
    .filter(Boolean);
  if (history.length > 128)
    throw new BackupProblem(
      'This initial backup needs an agent to inspect its larger history first. Nothing was pushed.',
    );
  const checked = new Set<string>();
  const checkedPaths = new Set<string>();
  let total = 0;
  for (const version of history) {
    const tree = await run(cwd, ['ls-tree', '-r', '-l', '-z', version], signal);
    for (const entry of tree.split('\0').filter(Boolean)) {
      const match = /^(\d+) (blob|commit) ([a-f0-9]+) +([\d-]+)\t([\s\S]+)$/.exec(entry);
      if (!match)
        throw new BackupProblem(
          'This backup needs an agent to inspect its file list. Nothing was pushed.',
        );
      const [, , type, object, size, path] = match;
      const sample = /(?:^|\/)\.env\.(example|sample|template)$/.test(path);
      if (
        (!sample &&
          /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|id_rsa|id_ed25519)(?:$|\/)/i.test(
            path,
          )) ||
        /\.(pem|p12|pfx|key)$/i.test(path) ||
        runtimePaths.some(
          (prefix) =>
            !prefix ||
            path.toLowerCase() === prefix.toLowerCase() ||
            path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`),
        )
      )
        throw new BackupProblem(
          'A private or runtime file was found in the proposed history. Nothing was pushed; ask your agent to inspect it locally.',
        );
      // Check every path before reusing a blob scan: renaming previously harmless
      // content to a credential path must still refuse the export.
      checkedPaths.add(`${object}\0${path}`);
      if (checkedPaths.size > 20_000)
        throw new BackupProblem(
          'This backup needs an agent to inspect its file list. Nothing was pushed.',
        );
      if (type !== 'blob' || checked.has(object)) continue;
      checked.add(object);
      total += Number(size);
      if (Number(size) > 4 * 1024 * 1024 || total > 32 * 1024 * 1024)
        throw new BackupProblem(
          'This backup needs an agent to inspect its larger files first. Nothing was pushed.',
        );
      const content = await run(cwd, ['cat-file', 'blob', object], signal);
      if (
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|cf[ua]t_[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/.test(
          content,
        )
      )
        throw new BackupProblem(
          'A possible credential was found in the proposed history. Nothing was pushed; ask your agent to inspect it locally.',
        );
    }
  }
}

export function sourceBackupStatus(store: Store, projectId: string): BackupStatus {
  return backupStatusSchema.parse(
    store.getSetting(`backup-status:${projectId}`) ?? {
      projectId,
      configured: false,
      state: 'not_configured',
      commit: null,
      checkedAt: null,
      message: 'Private GitHub source backup is not configured.',
    },
  );
}

/** Event-driven source backup, not an agent, Git hook, filesystem watcher, or runtime backup. */
export class SourceBackups {
  private queue: Promise<void> = Promise.resolve();
  private pending = new Set<string>();
  private controller = new AbortController();
  private destinations: Destination[];
  private onEvent = (event: { type: string; data: unknown }) => {
    if (event.type !== 'task.updated') return;
    const parsed = z.object({ id: z.string().uuid() }).safeParse(event.data);
    if (parsed.success) this.enqueue(this.store.task(parsed.data.id));
  };
  constructor(
    readonly store: Store,
    private readonly dataDir: string,
    private transport: BackupTransport = github,
    configuration?: unknown,
  ) {
    const file = join(dataDir, 'source-backups.json');
    let configurationFailed = false;
    try {
      this.destinations = backupConfigSchema.parse(
        configuration ?? (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []),
      );
    } catch {
      this.destinations = [];
      configurationFailed = true;
    }
    for (const project of store.projects()) {
      const destination = this.destinations.find((item) => item.projectId === project.id);
      const configured = !!destination;
      const previous = sourceBackupStatus(store, project.id);
      const changed =
        this.store.getSetting(`backup-destination:${project.id}`) !==
        JSON.stringify(destination ?? null);
      if (changed) this.store.setSetting(`backup-issues:${project.id}`, {});
      this.store.setSetting(
        `backup-destination:${project.id}`,
        JSON.stringify(destination ?? null),
      );
      store.setSetting(`backup-status:${project.id}`, {
        ...previous,
        configured,
        ...(changed ? { commit: null, checkedAt: null } : {}),
        state: configurationFailed
          ? 'needs_attention'
          : configured
            ? !changed && previous.configured
              ? previous.state
              : 'waiting'
            : 'not_configured',
        message: configurationFailed
          ? 'Source-backup configuration needs attention. Local work is unaffected; ask your setup agent to check it.'
          : configured
            ? !changed && previous.configured
              ? previous.message
              : 'Verified source checkpoints will be backed up to private GitHub.'
            : 'Private GitHub source backup is not configured.',
      });
    }
    store.on('event', this.onEvent);
  }
  start() {
    for (const task of this.store.tasks()) this.enqueue(task);
  }
  destination(projectId: string): Destination | null {
    this.store.project(projectId);
    return this.destinations.find((item) => item.projectId === projectId) ?? null;
  }
  get signal() {
    return this.controller.signal;
  }
  /** Initial opt-in only. Keep one config file and the existing export queue. */
  connectInitial(raw: unknown) {
    const destination = destinationSchema.parse(raw);
    this.store.project(destination.projectId);
    if (this.controller.signal.aborted) throw new Conflict('Source backups are stopping.');
    const file = join(this.dataDir, 'source-backups.json');
    let saved: Destination[];
    try {
      saved = backupConfigSchema.parse(
        existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [],
      );
    } catch {
      throw new Conflict('Existing backup settings need repair. No destination was replaced.');
    }
    const others = (items: Destination[]) =>
      JSON.stringify(
        items
          .filter((item) => item.projectId !== destination.projectId)
          .sort((a, b) => a.projectId.localeCompare(b.projectId)),
      );
    if (others(saved) !== others(this.destinations))
      throw new Conflict(
        'Other backup settings changed outside the app. Reopen the app before connecting; those settings were kept.',
      );
    const existing = saved.find((item) => item.projectId === destination.projectId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(destination))
      throw new Conflict(
        'This project already has a different backup. No destination was replaced.',
      );
    if (!existing) {
      const current = this.destination(destination.projectId);
      if (current)
        throw new Conflict(
          'This project already has backup settings. Reopen the app to inspect them.',
        );
      const next = backupConfigSchema.parse([...saved, destination]);
      const temporary = join(this.dataDir, `source-backups-${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      try {
        renameSync(temporary, file);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
      saved = next;
    }
    this.destinations = saved;
    this.store.transaction(() => {
      this.store.setSetting(
        `backup-destination:${destination.projectId}`,
        JSON.stringify(destination),
      );
      this.store.setSetting(`backup-issues:${destination.projectId}`, {});
      this.status(
        destination.projectId,
        'waiting',
        null,
        'Connected. Reviewed source checkpoints will be backed up to private GitHub.',
      );
    });
    this.retry(destination.projectId);
  }
  retry(projectId: string) {
    this.store.project(projectId);
    for (const task of this.store.tasks().filter((task) => task.projectId === projectId))
      this.enqueue(task, true);
  }
  private enqueue(task: PrivateTask, inspect = false) {
    const destination = this.destinations.find((item) => item.projectId === task.projectId);
    if (
      !destination ||
      !['done', 'integrated'].includes(task.status) ||
      !task.worktree ||
      !task.reviewedCommit ||
      !task.reviewAgentId ||
      !['approve', 'accepted_tradeoff'].includes(task.review ?? '') ||
      task.reviewedCommit === task.baseCommit
    )
      return;
    const commit = task.reviewedCommit;
    if (!sha.test(commit)) return;
    const ref = `refs/heads/${task.status === 'integrated' ? destination.branch : `agent-dock/task-${task.id}`}`;
    const pendingKey = `${task.projectId}:${ref}:${commit}`;
    if (this.pending.has(pendingKey)) return;
    this.pending.add(pendingKey);
    this.queue = this.queue
      .then(async () => {
        if (this.controller.signal.aborted) return;
        await this.backup(task, destination, ref, commit, inspect);
      })
      .catch(() => {
        /* backup records sanitized failures; never emit an unhandled rejection */
      })
      .finally(() => {
        this.pending.delete(pendingKey);
      });
  }
  private status(
    projectId: string,
    state: BackupStatus['state'],
    commit: string | null,
    message: string,
  ) {
    const issues = Object.values(
      (this.store.getSetting(`backup-issues:${projectId}`) as Record<string, string> | null) ?? {},
    );
    if (state === 'saved' && issues.length) {
      state = 'needs_attention';
      message = `${issues.length} source backup(s) still need attention. ${issues[0]}`;
    }
    const value = backupStatusSchema.parse({
      projectId,
      configured: true,
      state,
      commit,
      checkedAt: new Date().toISOString(),
      message,
    });
    this.store.setSetting(`backup-status:${projectId}`, value);
    this.store.event('backup.updated', projectId, null, value);
  }
  private async backup(
    task: PrivateTask,
    destination: Destination,
    ref: string,
    commit: string,
    inspect: boolean,
  ) {
    const signal = this.controller.signal,
      cwd = this.store.project(task.projectId).root;
    const key = `backup-receipt:${task.projectId}:${destination.repository}:${ref}`;
    const previous = this.store.getSetting(key) as Receipt | null;
    if (!inspect && previous?.verified && previous.commit === commit) return;
    this.status(task.projectId, 'saving', commit, 'Backing up a verified source checkpoint…');
    try {
      await run(cwd, ['check-ref-format', ref], signal);
      if (!(await this.transport.privateRepository(destination.repository, signal)))
        throw new BackupProblem(
          'The configured GitHub repository is not private. No source was pushed.',
        );
      const remote = await this.transport.head(cwd, destination.repository, ref, signal);
      let present = remote === commit;
      if (remote && !present) {
        try {
          await run(cwd, ['merge-base', '--is-ancestor', commit, remote], signal);
          present = true;
        } catch {
          signal.throwIfAborted();
        }
      }
      if (!present) {
        const main =
          ref === `refs/heads/${destination.branch}`
            ? remote
            : await this.transport.head(
                cwd,
                destination.repository,
                `refs/heads/${destination.branch}`,
                signal,
              );
        await inspectHistory(
          cwd,
          commit,
          [remote, main].filter((value): value is string => !!value),
          signal,
          this.dataDir,
        );
        signal.throwIfAborted();
        this.store.setSetting(key, { commit, verified: false });
        await this.transport.push(cwd, destination.repository, ref, commit, signal);
        if ((await this.transport.head(cwd, destination.repository, ref, signal)) !== commit)
          throw new BackupProblem(
            'The remote checkpoint could not be confirmed. Local work is safe; retry will inspect before pushing.',
          );
      }
      this.store.setSetting(key, { commit, verified: true });
      const issues =
        (this.store.getSetting(`backup-issues:${task.projectId}`) as Record<
          string,
          string
        > | null) ?? {};
      delete issues[ref];
      this.store.setSetting(`backup-issues:${task.projectId}`, issues);
      this.status(
        task.projectId,
        'saved',
        commit,
        'Verified source checkpoint backed up to private GitHub.',
      );
    } catch (error) {
      const message = signal.aborted
        ? 'Backup interrupted. Local work is safe; the next start will inspect the remote first.'
        : error instanceof BackupProblem
          ? error.message
          : 'GitHub backup needs attention. Local work is safe. Ask your agent to check sign-in, connectivity and branch history; no force-push is allowed.';
      this.store.setSetting(`backup-issues:${task.projectId}`, {
        ...(this.store.getSetting(`backup-issues:${task.projectId}`) as object),
        [ref]: message,
      });
      this.status(task.projectId, 'needs_attention', commit, message);
    }
  }
  async idle() {
    // Store notifications run in microtasks and can append work while a caller waits.
    let pending: Promise<void>;
    do {
      pending = this.queue;
      await pending;
    } while (pending !== this.queue);
  }
  async close() {
    this.store.off('event', this.onEvent);
    this.controller.abort();
    await this.queue;
  }
}
