import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  groupNativeGitRequestSchema,
  groupNativeGitViewSchema,
  type GroupNativeGitView,
} from '@dock/shared/dist/group-native-git.js';
import { integrationPreviewSchema, type GroupContext } from '@dock/shared';
import type { Runtime } from './runtime.js';
import type { GroupHostNativeRuntime } from './group-native-host-runtime.js';
import type { GroupHost } from './group-host.js';
import { Conflict } from './store.js';
import { git, integrationPreview, integrate } from './workspaces.js';
import { groupNativePrivatePath } from './group-native-private-path.js';

type Binding = ReturnType<GroupHostNativeRuntime['resolveLocalContext']>;
type Settings = { githubUsername: string; autoSync: boolean };
const adapters = new WeakMap<GroupHost, GroupHostNativeGit>();
export const groupHostNativeGit = (host: GroupHost) => adapters.get(host);
const defaults: Settings = { githubUsername: '', autoSync: false };
const oid = /^[a-f0-9]{40,64}$/;
const exec = promisify(execFile);
const secret =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16})\b/;

/** The native shared checkout is host-selected. This adapter synchronizes approved
 * commits; native tools, task worktrees and independent Runtime review remain intact. */
export class GroupHostNativeGit {
  private timer?: ReturnType<typeof setInterval>;
  private closing = false;
  private readonly active = new Map<string, Promise<unknown>>();
  private readonly last = new Map<string, number>();
  private readonly notices = new Map<string, string>();
  private readonly starting = new Map<string, { requestId: string; until: number }>();
  private background?: Promise<void>;
  constructor(
    readonly host: GroupHost,
    private readonly runtime: Runtime,
    private readonly connector: GroupHostNativeRuntime,
    private readonly localFixture = false,
  ) {
    host.db.exec(`
      CREATE TABLE IF NOT EXISTS gng_settings(handle TEXT NOT NULL,key TEXT PRIMARY KEY,input TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gng_baselines(handle TEXT NOT NULL,origin TEXT NOT NULL,oid TEXT NOT NULL,PRIMARY KEY(handle,oid));
      CREATE TABLE IF NOT EXISTS gng_operations(key TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS gng_applies(key TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gng_repositories(handle TEXT PRIMARY KEY,origin TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS gng_settings_immutable BEFORE UPDATE ON gng_settings BEGIN SELECT RAISE(ABORT,'retained Git settings'); END;
      CREATE TRIGGER IF NOT EXISTS gng_baselines_immutable BEFORE UPDATE ON gng_baselines BEGIN SELECT RAISE(ABORT,'retained Git baseline'); END;
      CREATE TRIGGER IF NOT EXISTS gng_operations_identity BEFORE UPDATE OF key,input ON gng_operations BEGIN SELECT RAISE(ABORT,'retained Git operation'); END;
      CREATE TRIGGER IF NOT EXISTS gng_applies_immutable BEFORE UPDATE ON gng_applies BEGIN SELECT RAISE(ABORT,'retained exact Git preview'); END;
      CREATE TRIGGER IF NOT EXISTS gng_repositories_immutable BEFORE UPDATE ON gng_repositories BEGIN SELECT RAISE(ABORT,'retained Git remote'); END;
    `);
    adapters.set(host, this);
  }
  private settings(handle: string): Settings {
    const row = this.host.db
      .prepare('SELECT body FROM gng_settings WHERE handle=? ORDER BY rowid DESC LIMIT 1')
      .get(handle);
    return row ? (JSON.parse(String(row.body)) as Settings) : defaults;
  }
  private busy(binding: Binding, ownRequest?: string) {
    const starting = this.starting.get(binding.cwd);
    if (starting && starting.requestId !== ownRequest) {
      const run = this.connector.context(starting.requestId)?.runId;
      if (!run && Date.now() < starting.until) return true;
      this.starting.delete(binding.cwd);
    }
    if (
      this.runtime.store
        .agents()
        .some(
          (agent) =>
            agent.projectId === binding.projectId &&
            (['queued', 'running', 'waiting'].includes(agent.status) ||
              this.runtime.externalControl?.has(agent.id)),
        )
    )
      return true;
    return this.runtime.store
      .runs()
      .some(
        (run) =>
          ['queued', 'running'].includes(run.status) &&
          this.runtime.store.agent(run.agentId).projectId === binding.projectId,
      );
  }
  private async optional(cwd: string, args: string[]) {
    try {
      return await git(cwd, args);
    } catch {
      return '';
    }
  }
  private async repository(binding: Binding) {
    const cwd = binding.cwd;
    if (!existsSync(join(cwd, '.git'))) return null;
    if (
      realpathSync(cwd) !== resolve(cwd) ||
      lstatSync(join(cwd, '.git')).isSymbolicLink() ||
      (await git(cwd, ['rev-parse', '--show-toplevel'])) !== cwd
    )
      throw new Conflict('The saved shared repository needs repair; its files were preserved.');
    const origin = await this.optional(cwd, ['remote', 'get-url', 'origin']);
    if (!origin) return null; // Local task worktrees do not require GitHub or a remote.
    const https = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;
    const ssh = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
    if (!https.test(origin) && !ssh.test(origin) && !(this.localFixture && origin.startsWith('/')))
      throw new Conflict(
        'Connect the shared workspace to its intended GitHub repository with your setup agent.',
      );
    const canonical = (url: string) =>
      url
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/\/$/, '')
        .replace(/\.git$/, '')
        .toLowerCase();
    const pushes = (await git(cwd, ['remote', 'get-url', '--push', '--all', 'origin']))
      .split('\n')
      .filter(Boolean);
    if (pushes.length !== 1 || canonical(pushes[0]!) !== canonical(origin))
      throw new Conflict(
        'The fetch and push destinations differ. Ask your setup agent to reconcile them before syncing.',
      );
    const retained = this.host.db
      .prepare('SELECT origin FROM gng_repositories WHERE handle=?')
      .get(binding.anchor.sessionId);
    if (retained && retained.origin !== origin)
      throw new Conflict(
        'The repository remote changed. Ask your setup agent to reconcile it before syncing.',
      );
    this.host.db
      .prepare('INSERT OR IGNORE INTO gng_repositories VALUES (?,?)')
      .run(binding.anchor.sessionId, origin);
    return {
      cwd,
      origin,
      label: origin.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git\/?$/, ''),
    };
  }
  private async lock<T>(cwd: string, body: () => Promise<T>): Promise<T> {
    const prior = this.active.get(cwd);
    const pending = (prior ?? Promise.resolve()).catch(() => {}).then(body);
    this.active.set(cwd, pending);
    try {
      return await pending;
    } finally {
      if (this.active.get(cwd) === pending) this.active.delete(cwd);
    }
  }
  private baseline(binding: Binding, origin: string, head: string) {
    if (!oid.test(head)) throw new Conflict('A valid shared commit is required.');
    this.host.db
      .prepare('INSERT OR IGNORE INTO gng_baselines VALUES (?,?,?)')
      .run(binding.anchor.sessionId, origin, head);
  }
  private async ancestor(cwd: string, older: string, newer: string) {
    try {
      await git(cwd, ['merge-base', '--is-ancestor', older, newer]);
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return false;
      throw error;
    }
  }
  private async fetchDefault(binding: Binding, repo: { cwd: string; origin: string }) {
    const remote = await git(repo.cwd, ['ls-remote', '--symref', 'origin', 'HEAD']);
    const main = /^ref: refs\/heads\/([^\s]+)\s+HEAD$/m.exec(remote)?.[1] ?? 'main';
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,200}$/.test(main) || main.includes('..'))
      throw new Conflict('The remote default branch needs inspection.');
    const remoteHead = /^([a-f0-9]{40,64})\s+HEAD$/m.exec(remote)?.[1] ?? null;
    if (remoteHead) {
      await git(repo.cwd, [
        'fetch',
        '--no-tags',
        '--no-prune',
        '--no-prune-tags',
        '--no-recurse-submodules',
        'origin',
        `refs/heads/${main}`,
      ]);
      const fetched = await git(repo.cwd, ['rev-parse', 'FETCH_HEAD']);
      if (fetched !== remoteHead)
        throw new Conflict('The remote advanced during sync. Retry safely.');
      this.baseline(binding, repo.origin, fetched);
    }
    return { main, remoteHead };
  }
  private reviewed(binding: Binding, head: string): string | null {
    const baselines = new Set(
      this.host.db
        .prepare('SELECT oid FROM gng_baselines WHERE handle=?')
        .all(binding.anchor.sessionId)
        .map((row) => String(row.oid)),
    );
    const rows = this.runtime.store.db
      .prepare(
        "SELECT data FROM events WHERE type='task.integrated' AND project_id=? ORDER BY id DESC LIMIT 256",
      )
      .all(binding.projectId);
    let current = head;
    for (let round = 0; round < 128; round++) {
      if (baselines.has(current)) return current;
      const preview = rows
        .map((row) => integrationPreviewSchema.safeParse(JSON.parse(String(row.data))))
        .find((item) => item.success && item.data.source === current);
      if (!preview?.success) return null;
      const task = this.runtime.store.task(preview.data.taskId);
      if (
        task.projectId !== binding.projectId ||
        task.status !== 'integrated' ||
        task.reviewedCommit !== current ||
        !task.reviewAgentId ||
        task.reviewAgentId === task.managerId ||
        preview.data.target === current
      )
        return null;
      current = preview.data.target;
    }
    return null;
  }
  /** Scan every newly published checkpoint, including files deleted by a later commit. */
  private async shareable(cwd: string, base: string, head: string) {
    const commits = (await git(cwd, ['rev-list', '--max-count=129', `${base}..${head}`]))
      .split('\n')
      .filter(Boolean);
    if (commits.length > 128)
      throw new Conflict('This publication needs a bounded history review with your setup agent.');
    let count = 0,
      bytes = 0;
    for (const commit of commits) {
      const names = (
        await git(cwd, [
          'diff-tree',
          '--root',
          '-m',
          '--no-commit-id',
          '--name-only',
          '-r',
          '-z',
          commit,
        ])
      )
        .split('\0')
        .filter(Boolean);
      for (const name of names) {
        if (++count > 1000)
          throw new Conflict('This publication exceeds the shared file review limit.');
        if (groupNativePrivatePath(name))
          throw new Conflict(
            'Publication stopped at a likely private or runtime file. Inspect the shared task locally.',
          );
        const type = await this.optional(cwd, ['cat-file', '-t', `${commit}:${name}`]);
        if (!type) continue; // Deleted in this checkpoint.
        if (type !== 'blob')
          throw new Conflict('Publication needs inspection of non-file content.');
        const size = Number(await git(cwd, ['cat-file', '-s', `${commit}:${name}`]));
        bytes += size;
        if (size > 4 * 1024 * 1024 || bytes > 32 * 1024 * 1024)
          throw new Conflict('Publication exceeds the shared content review limit.');
        if (secret.test(await git(cwd, ['show', `${commit}:${name}`])))
          throw new Conflict('Publication stopped at a likely credential. No credential was sent.');
      }
    }
  }
  async beforeWork(context: GroupContext, requestId: string) {
    const request = this.connector.context(requestId);
    if (!request || request.intent !== 'work' || context.visibility !== 'shared') return;
    const scope = await this.host.nativeFeatureContext(context);
    await this.lock(request.cwd, async () => {
      const repo = await this.repository(request);
      if (!repo) return; // Ordinary native work still works without GitHub.
      if (this.busy(request, requestId) || (await git(repo.cwd, ['status', '--porcelain'])))
        throw new Conflict(
          'Finish active shared work and keep its checkpoint before starting another work branch.',
        );
      await scope.revalidate();
      let head = await this.optional(repo.cwd, ['rev-parse', '--verify', 'HEAD']);
      const member = createHash('sha256')
        .update(`${context.memberId}:${context.installationId}`)
        .digest('hex')
        .slice(0, 12);
      const branch = `swa/member-${member}/work-${requestId}`;
      const current = await git(repo.cwd, ['symbolic-ref', '--short', 'HEAD']);
      if (current === branch) {
        this.starting.set(repo.cwd, { requestId, until: Date.now() + 30_000 });
        return;
      }
      if (await this.optional(repo.cwd, ['rev-parse', '--verify', `refs/heads/${branch}`]))
        throw new Conflict(
          'This retained work branch already exists. Inspect it rather than switching or replaying work.',
        );
      const { remoteHead } = await this.fetchDefault(request, repo);
      if (head && remoteHead && !(await this.ancestor(repo.cwd, head, remoteHead)))
        throw new Conflict(
          'Your prior work branch has unpublished or divergent commits. Sync its reviewed changes or review a correction before starting another branch.',
        );
      if (!head && !remoteHead) {
        // Only an empty index/tree may receive this generated baseline. Never stage user files.
        if (await git(repo.cwd, ['ls-files']))
          throw new Conflict('Inspect the initial shared files before making a checkpoint.');
        const args = ['-c', 'commit.gpgsign=false'];
        if (!(await this.optional(repo.cwd, ['config', 'user.name'])))
          args.push('-c', 'user.name=sciencewithagents');
        if (!(await this.optional(repo.cwd, ['config', 'user.email'])))
          args.push('-c', 'user.email=noreply@localhost');
        await git(repo.cwd, [
          ...args,
          'commit',
          '--allow-empty',
          '-m',
          'Initialize shared workspace',
        ]);
        head = await git(repo.cwd, ['rev-parse', 'HEAD']);
        this.baseline(request, repo.origin, head);
      }
      await scope.revalidate();
      if (this.busy(request, requestId) || (await git(repo.cwd, ['status', '--porcelain'])))
        throw new Conflict(
          'Shared work started while preparing its branch. Its files were preserved.',
        );
      await git(repo.cwd, [
        'checkout',
        '--no-overwrite-ignore',
        '--no-track',
        '-b',
        branch,
        remoteHead ?? head,
      ]);
      this.starting.set(repo.cwd, { requestId, until: Date.now() + 30_000 });
      this.notices.set(
        scope.handle,
        'Shared Work has its own member/request branch. Workers use task worktrees; review and exact apply precede publication.',
      );
    });
  }
  private async synchronize(binding: Binding, revalidate: () => Promise<void>) {
    return this.lock(binding.cwd, async () => {
      const repo = await this.repository(binding);
      if (!repo)
        throw new Conflict(
          'Ask your setup agent to clone the intended shared GitHub repository into this group workspace.',
        );
      await revalidate();
      const { main, remoteHead } = await this.fetchDefault(binding, repo);
      if (this.busy(binding) || (await git(repo.cwd, ['status', '--porcelain'])))
        return 'Fetched shared commits. Active or uncommitted work was preserved; sync again when it is settled.';
      let head = await this.optional(repo.cwd, ['rev-parse', '--verify', 'HEAD']);
      const branch = await this.optional(repo.cwd, ['symbolic-ref', '--short', 'HEAD']);
      if (!head && remoteHead && branch === main) {
        await revalidate();
        if (this.busy(binding) || (await git(repo.cwd, ['status', '--porcelain'])))
          return 'Shared work started; sync again when it is settled.';
        await git(repo.cwd, ['merge', '--ff-only', '--no-overwrite-ignore', '--', remoteHead]);
        head = await git(repo.cwd, ['rev-parse', 'HEAD']);
      }
      if (!head || !branch)
        return 'The shared repository is empty. Start explicit Work to prepare its empty baseline and separate work branch.';
      if (
        branch === main &&
        remoteHead &&
        head !== remoteHead &&
        (await this.ancestor(repo.cwd, head, remoteHead))
      ) {
        await revalidate();
        if (this.busy(binding) || (await git(repo.cwd, ['status', '--porcelain'])))
          return 'Shared work started; fetched commits remain available for the next clean sync.';
        await git(repo.cwd, ['merge', '--ff-only', '--no-overwrite-ignore', '--', remoteHead]);
        head = await git(repo.cwd, ['rev-parse', 'HEAD']);
      }
      if (head === remoteHead) return 'Shared files are up to date. No model call was made.';
      const base = this.reviewed(binding, head);
      if (!base)
        return 'Local commits await independent task review and exact apply before they can be shared.';
      if (base === head && remoteHead && branch !== main)
        return 'Fetched shared commits. Your separate work branch was preserved; there is no newly reviewed work to publish.';
      await this.shareable(repo.cwd, base, head);
      await revalidate();
      if (
        this.busy(binding) ||
        (await git(repo.cwd, ['status', '--porcelain'])) ||
        (await git(repo.cwd, ['rev-parse', 'HEAD'])) !== head ||
        (await git(repo.cwd, ['symbolic-ref', '--short', 'HEAD'])) !== branch
      )
        throw new Conflict(
          'Shared work changed during sync. Its files were preserved; retry after it settles.',
        );
      // Explicit commits only; never stage, reset, rebase, force push or delete refs.
      const push = [
        '-c',
        'remote.origin.mirror=false',
        'push',
        '--porcelain',
        '--no-follow-tags',
        '--recurse-submodules=no',
        'origin',
      ];
      await git(repo.cwd, [...push, `${head}:refs/heads/${branch}`]);
      if (remoteHead && !(await this.ancestor(repo.cwd, remoteHead, head)))
        return 'Reviewed work branch shared. The default branch advanced separately; prepare and review a correction before merging.';
      await revalidate();
      await git(repo.cwd, [...push, `${head}:refs/heads/${main}`]);
      this.baseline(binding, repo.origin, head);
      return 'Reviewed committed work shared; the default branch advanced without rewriting history.';
    });
  }
  private async view(
    handle: string,
    binding: Binding,
    preview: GroupNativeGitView['preview'] = null,
  ): Promise<GroupNativeGitView> {
    const settings = this.settings(handle),
      repo = await this.repository(binding);
    return groupNativeGitViewSchema.parse({
      available: !!repo,
      repository: repo?.label ?? null,
      workspacePath: binding.cwd,
      branch: repo
        ? (await this.optional(binding.cwd, ['symbolic-ref', '--short', 'HEAD'])) || null
        : null,
      ...settings,
      dirty: !!repo && !!(await git(binding.cwd, ['status', '--porcelain'])),
      busy: this.busy(binding),
      message:
        this.notices.get(handle) ??
        (repo
          ? 'Shared repository connected. Sync is off until you enable it. Only reviewed, applied checkpoints are published.'
          : 'Ask your setup agent to clone the shared repository into this group workspace. Existing files stay local.'),
      localEdits: await this.localEdits(binding),
      tasks: this.runtime.store
        .tasks()
        .filter((task) => task.projectId === binding.projectId)
        .slice(-100)
        .map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          reviewed: !!task.reviewedCommit && !!task.reviewAgentId,
        })),
      preview,
    });
  }
  /** Owner-only metadata from server-selected group/task workspaces. Returns no
   * file contents and never stages/publishes pending edits. */
  private async localEdits(binding: Binding): Promise<GroupNativeGitView['localEdits']> {
    const tasks = this.runtime.store
      .tasks()
      .filter((t) => t.projectId === binding.projectId && t.worktree)
      .slice(-50);
    const workspaces = [
      { taskId: null as string | null, label: 'Group workspace', cwd: binding.cwd },
      ...tasks.map((t) => ({ taskId: t.id, label: t.title.slice(0, 200), cwd: t.worktree! })),
    ];
    const result: GroupNativeGitView['localEdits'] = [];
    const signal = AbortSignal.timeout(2500);
    for (const workspace of workspaces) {
      try {
        if (realpathSync(workspace.cwd) !== resolve(workspace.cwd))
          throw new Error('Workspace moved');
        const { stdout } = await exec(
          'git',
          [
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.fsmonitor=false',
            '--no-optional-locks',
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=normal',
            '--ignore-submodules=all',
          ],
          {
            cwd: workspace.cwd,
            timeout: 5000,
            maxBuffer: 64 * 1024,
            signal,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
          },
        );
        const rows = stdout.split('\0'),
          files: { path: string; status: string }[] = [];
        let changed = 0,
          withheld = 0;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          if (!row) continue;
          const status = row.slice(0, 2),
            path = row.slice(3);
          changed++;
          if (/[RC]/u.test(status)) i++;
          if (
            groupNativePrivatePath(path) ||
            path.length > 512 ||
            path.startsWith('/') ||
            path.split('/').includes('..') ||
            /[\0\r\n\\]/u.test(path)
          ) {
            withheld++;
            continue;
          }
          if (files.length < 16) files.push({ path, status });
        }
        result.push({
          taskId: workspace.taskId,
          label: workspace.label,
          state: changed ? 'changed' : 'clean',
          changed,
          withheld,
          truncated: changed - withheld > files.length,
          files,
        });
      } catch {
        result.push({
          taskId: workspace.taskId,
          label: workspace.label,
          state: 'unavailable',
          changed: 0,
          withheld: 0,
          truncated: false,
          files: [],
        });
      }
    }
    return result;
  }
  async request(raw: unknown): Promise<GroupNativeGitView> {
    const input = groupNativeGitRequestSchema.parse(raw);
    const scope = await this.host.authenticatedContext({ handle: input.handle });
    if (scope.context.visibility !== 'shared')
      throw new Conflict('Shared files belong to the shared group conversation.');
    let binding: Binding;
    try {
      binding = this.connector.resolveLocalContext(scope.context, scope.enrollmentHandle);
    } catch {
      if (input.action !== 'status')
        throw new Conflict('Enable agents on this computer before changing shared Git setup.');
      return groupNativeGitViewSchema.parse({
        available: false,
        repository: null,
        workspacePath: null,
        branch: null,
        ...defaults,
        dirty: false,
        busy: false,
        tasks: [],
        preview: null,
        message: 'Enable agents on this computer to open its shared workspace setup.',
      });
    }
    let preview: GroupNativeGitView['preview'] = null;
    if ('key' in input) {
      const exact = JSON.stringify(input),
        old = this.host.db
          .prepare('SELECT input,result FROM gng_operations WHERE key=?')
          .get(input.key);
      if (old && old.input !== exact) throw new Conflict('Retry the exact saved Git operation.');
      if (old?.result) return groupNativeGitViewSchema.parse(JSON.parse(String(old.result)));
      if (!old) {
        if (Number(this.host.db.prepare('SELECT count(*) n FROM gng_operations').get()!.n) >= 4096)
          throw new Conflict('Shared Git operation history is full; retained work is preserved.');
        this.host.db.prepare('INSERT INTO gng_operations VALUES (?,?,NULL)').run(input.key, exact);
      }
    }
    if (input.action === 'configure') {
      await scope.revalidate();
      if (input.autoSync && !(await this.repository(binding)))
        throw new Conflict('Connect the intended shared repository before enabling sync.');
      this.host.db
        .prepare('INSERT OR IGNORE INTO gng_settings VALUES (?,?,?,?)')
        .run(
          input.handle,
          input.key,
          JSON.stringify(input),
          JSON.stringify({ githubUsername: input.githubUsername, autoSync: input.autoSync }),
        );
      this.notices.set(
        input.handle,
        input.autoSync
          ? 'Automatic sync enabled. It fetches shared commits, advances only clean copies and publishes reviewed applied work. Unreviewed files stay local.'
          : 'Automatic sync is off. Your files and branches are preserved.',
      );
    }
    if (input.action === 'sync')
      this.notices.set(input.handle, await this.synchronize(binding, scope.revalidate));
    if (input.action === 'preview' || input.action === 'apply') {
      const task = this.runtime.store.task(input.taskId);
      if (task.projectId !== binding.projectId)
        throw new Conflict('This task belongs to a different workspace.');
      if (!task.reviewAgentId || task.reviewAgentId === task.managerId)
        throw new Conflict('An independent task review is required before applying shared files.');
      if (input.action === 'preview')
        preview = await integrationPreview(this.runtime.store, task.id);
      if (input.action === 'apply') {
        await scope.revalidate();
        await this.lock(binding.cwd, async () => {
          if (this.busy(binding))
            throw new Conflict('Wait for shared agents and workers to settle before applying.');
          const retained = this.host.db
            .prepare('SELECT body FROM gng_applies WHERE key=?')
            .get(input.key);
          const prepared = retained
            ? integrationPreviewSchema.parse(JSON.parse(String(retained.body)))
            : null;
          const events = this.runtime.store.db
            .prepare(
              "SELECT data FROM events WHERE type='task.integrated' AND project_id=? ORDER BY id DESC LIMIT 256",
            )
            .all(binding.projectId);
          const acknowledged =
            prepared &&
            events.some((event) => {
              const value = integrationPreviewSchema.safeParse(JSON.parse(String(event.data)));
              return (
                value.success &&
                value.data.taskId === input.taskId &&
                value.data.source === input.source &&
                value.data.target === input.target
              );
            });
          if (acknowledged) return;
          if (
            prepared &&
            prepared.source === input.source &&
            prepared.target === input.target &&
            task.reviewedCommit === input.source &&
            task.worktree &&
            (await git(binding.cwd, ['rev-parse', 'HEAD'])) === input.source &&
            (await git(task.worktree, ['rev-parse', 'HEAD'])) === input.source &&
            !(await git(binding.cwd, ['status', '--porcelain'])) &&
            !(await git(task.worktree, ['status', '--porcelain']))
          ) {
            // The Git step completed before its acknowledgement. Retain the exact
            // authorized preview rather than applying again or inventing a new target.
            this.runtime.store.transaction(() => {
              this.runtime.store.updateTask(task.id, { status: 'integrated' });
              this.runtime.store.event('task.integrated', binding.projectId, null, prepared);
            });
            return;
          }
          const fresh = await integrationPreview(this.runtime.store, task.id);
          if (fresh.source !== input.source || fresh.target !== input.target || !fresh.canApply)
            throw new Conflict(
              'The integration preview changed. Refresh and inspect its exact changes.',
            );
          this.host.db
            .prepare('INSERT OR IGNORE INTO gng_applies VALUES (?,?)')
            .run(input.key, JSON.stringify(fresh));
          preview = await integrate(this.runtime.store, task.id, input);
        });
        this.notices.set(
          input.handle,
          'Applied the exact independently reviewed task. Sync shares its committed result when enabled.',
        );
        preview = null;
      }
    }
    const result = await this.view(input.handle, binding, preview);
    if ('key' in input)
      this.host.db
        .prepare('UPDATE gng_operations SET result=? WHERE key=? AND result IS NULL')
        .run(JSON.stringify(result), input.key);
    return result;
  }
  start() {
    this.timer = setInterval(() => {
      if (!this.background)
        this.background = this.pass().finally(() => {
          this.background = undefined;
        });
    }, 20_000);
    this.timer.unref();
  }
  private async pass() {
    if (this.closing) return;
    const handles = this.host.db.prepare('SELECT DISTINCT handle FROM gng_settings').all();
    for (const row of handles) {
      if (this.closing) return;
      const handle = String(row.handle);
      if (!this.host.localVisible(handle)) continue;
      if (!this.settings(handle).autoSync || Date.now() - (this.last.get(handle) ?? 0) < 60_000)
        continue;
      this.last.set(handle, Date.now());
      try {
        const scope = await this.host.authenticatedContext({ handle });
        const binding = this.connector.resolveLocalContext(scope.context, scope.enrollmentHandle);
        this.notices.set(handle, await this.synchronize(binding, scope.revalidate));
      } catch (error) {
        this.notices.set(
          handle,
          error instanceof Conflict
            ? error.message
            : 'Shared Git sync could not finish. Check native GitHub sign-in or retry; files and branches were preserved.',
        );
      }
    }
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.background;
    await Promise.allSettled(this.active.values());
    adapters.delete(this.host);
  }
}
