import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  groupNativeGitRequestSchema,
  groupNativeGitViewSchema,
  groupNativeCommitPreviewSchema,
  type GroupNativeCommitPreview,
  type GroupNativeGitView,
} from '@dock/shared/dist/group-native-git.js';
import { integrationPreviewSchema, type GroupContext } from '@dock/shared';
import type { Runtime } from './runtime.js';
import type {
  GroupHostNativeRuntime,
  GroupHostNativeWorkspace,
} from './group-native-host-runtime.js';
import type { GroupHost } from './group-host.js';
import { Conflict, Missing } from './store.js';
import { git, integrationPreview, integrate } from './workspaces.js';
import { groupNativePrivatePath } from './group-native-private-path.js';
import {
  assertGroupGitBlob,
  groupProjectDataAllowed,
  GROUP_NATIVE_GIT_FILE_LIMITS,
} from './group-native-git-files.js';

type Binding = GroupHostNativeWorkspace;
type Settings = { githubUsername: string; autoSync: boolean };
const adapters = new WeakMap<GroupHost, GroupHostNativeGit>();
export const groupHostNativeGit = (host: GroupHost) => adapters.get(host);
const defaults: Settings = { githubUsername: '', autoSync: false };
const oid = /^[a-f0-9]{40,64}$/;
const nativePreviewIdentitySchema = groupNativeCommitPreviewSchema.omit({
  files: true,
  patch: true,
});
type NativePreviewIdentity = z.infer<typeof nativePreviewIdentitySchema>;
const exec = promisify(execFile);

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
    /** Internal fixture seam; no browser/config can replace native access verification. */
    private readonly verifyPrivateAccess?: (cwd: string, origin: string) => Promise<void>,
  ) {
    host.db.exec(`
      CREATE TABLE IF NOT EXISTS gng_settings(handle TEXT NOT NULL,key TEXT PRIMARY KEY,input TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gng_baselines(handle TEXT NOT NULL,origin TEXT NOT NULL,oid TEXT NOT NULL,PRIMARY KEY(handle,oid));
      CREATE TABLE IF NOT EXISTS gng_operations(key TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS gng_applies(key TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gng_repositories(handle TEXT PRIMARY KEY,origin TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gng_connections(handle TEXT NOT NULL,scope_key TEXT NOT NULL,origin TEXT NOT NULL,key TEXT PRIMARY KEY,UNIQUE(handle,scope_key,origin));
      CREATE TABLE IF NOT EXISTS gng_native_previews(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,origin TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(scope_key,origin,fingerprint));
      CREATE INDEX IF NOT EXISTS gng_native_previews_head ON gng_native_previews(scope_key,origin,json_extract(body,'$.preview.head'),json_extract(body,'$.preview.branch'));
      CREATE TABLE IF NOT EXISTS gng_native_reviews(key TEXT PRIMARY KEY,preview_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS gng_native_previews_immutable BEFORE UPDATE ON gng_native_previews BEGIN SELECT RAISE(ABORT,'retained native commit preview'); END;
      CREATE TRIGGER IF NOT EXISTS gng_native_previews_retain BEFORE DELETE ON gng_native_previews BEGIN SELECT RAISE(ABORT,'retained native commit preview'); END;
      CREATE TRIGGER IF NOT EXISTS gng_native_reviews_immutable BEFORE UPDATE ON gng_native_reviews BEGIN SELECT RAISE(ABORT,'retained owner review'); END;
      CREATE TRIGGER IF NOT EXISTS gng_native_reviews_retain BEFORE DELETE ON gng_native_reviews BEGIN SELECT RAISE(ABORT,'retained owner review'); END;
      CREATE TRIGGER IF NOT EXISTS gng_connections_immutable BEFORE UPDATE ON gng_connections BEGIN SELECT RAISE(ABORT,'retained verified Git connection'); END;
      CREATE TRIGGER IF NOT EXISTS gng_connections_retain BEFORE DELETE ON gng_connections BEGIN SELECT RAISE(ABORT,'retained verified Git connection'); END;
      CREATE TRIGGER IF NOT EXISTS gng_settings_immutable BEFORE UPDATE ON gng_settings BEGIN SELECT RAISE(ABORT,'retained Git settings'); END;
      CREATE TRIGGER IF NOT EXISTS gng_baselines_immutable BEFORE UPDATE ON gng_baselines BEGIN SELECT RAISE(ABORT,'retained Git baseline'); END;
      CREATE TRIGGER IF NOT EXISTS gng_operations_identity BEFORE UPDATE OF key,input ON gng_operations BEGIN SELECT RAISE(ABORT,'retained Git operation'); END;
      CREATE TRIGGER IF NOT EXISTS gng_applies_immutable BEFORE UPDATE ON gng_applies BEGIN SELECT RAISE(ABORT,'retained exact Git preview'); END;
      CREATE TRIGGER IF NOT EXISTS gng_repositories_immutable BEFORE UPDATE ON gng_repositories BEGIN SELECT RAISE(ABORT,'retained Git remote'); END;
    `);
    adapters.set(host, this);
  }
  private scopeKey(binding: Binding) {
    return binding.workspaceChoiceKey ?? binding.anchor.sessionId;
  }
  private connected(handle: string, binding: Binding) {
    return !!this.host.db
      .prepare('SELECT 1 FROM gng_connections WHERE handle=? AND scope_key=?')
      .get(handle, this.scopeKey(binding));
  }
  private settings(handle: string, binding?: Binding): Settings {
    const row = this.host.db
      .prepare('SELECT body FROM gng_settings WHERE handle=? ORDER BY rowid DESC LIMIT 1')
      .get(handle);
    const saved = row ? (JSON.parse(String(row.body)) as Settings) : defaults;
    if (!binding) return saved;
    const connected = this.connected(handle, binding);
    return {
      ...saved,
      autoSync: row ? saved.autoSync && (!binding.workspaceChoiceKey || connected) : connected,
    };
  }
  assertWorkspaceIdle(handle: string) {
    if (
      this.host.db
        .prepare(
          "SELECT 1 FROM gng_operations WHERE json_extract(input,'$.handle')=? AND result IS NULL LIMIT 1",
        )
        .get(handle)
    )
      throw new Conflict(
        'Settle or retry the original pending shared-file operation before changing folders. Its exact target is retained.',
      );
    const scope = this.host.localSharedContext(handle);
    const workspace = this.connector.workspaceScope?.(scope.context, scope.enrollmentHandle);
    const starting = workspace ? this.starting.get(workspace.cwd) : null;
    if (
      starting &&
      (this.connector.context(starting.requestId)?.runId || Date.now() >= starting.until)
    )
      this.starting.delete(workspace!.cwd);
    if (workspace && (this.active.has(workspace.cwd) || this.starting.has(workspace.cwd)))
      throw new Conflict(
        'Wait for the current shared-file preparation or sync to finish before changing folders.',
      );
  }
  private async privateAccess(cwd: string, origin: string) {
    const label = origin
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/\.git\/?$/, '')
      .replace(/\/$/, '');
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(label))
      throw new Conflict('Connect the chosen folder to the intended private GitHub repository.');
    try {
      const { stdout } = await exec(
        'gh',
        ['repo', 'view', label, '--json', 'nameWithOwner,isPrivate,viewerPermission'],
        {
          cwd,
          timeout: 10_000,
          maxBuffer: 16_384,
          env: { ...process.env, GH_PROMPT_DISABLED: '1' },
        },
      );
      const result = z
        .object({
          nameWithOwner: z.string().max(300),
          isPrivate: z.literal(true),
          viewerPermission: z.enum(['READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN']),
        })
        .parse(JSON.parse(stdout));
      if (`https://github.com/${result.nameWithOwner}`.toLowerCase() !== label.toLowerCase())
        throw Error('Repository changed');
    } catch {
      throw new Conflict(
        'Verify native GitHub sign-in and access to this intended private repository with your setup agent, then retry the same saved connection.',
      );
    }
  }
  private busy(binding: Binding, ownRequest?: string) {
    const projects = new Set(
      this.runtime.store
        .projects()
        .filter((project) => project.root === binding.cwd)
        .map((project) => project.id),
    );
    if (binding.projectId) projects.add(binding.projectId);
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
            projects.has(agent.projectId) &&
            (['queued', 'running', 'waiting'].includes(agent.status) ||
              this.runtime.externalControl?.has(agent.id)),
        )
    )
      return true;
    if (
      this.runtime.localJobs
        ?.all()
        .some(
          (job) =>
            job.projectId &&
            projects.has(job.projectId) &&
            ['queued', 'running', 'paused'].includes(job.status),
        )
    )
      return true;
    return this.runtime.store
      .runs()
      .some(
        (run) =>
          ['queued', 'running'].includes(run.status) &&
          projects.has(this.runtime.store.agent(run.agentId).projectId),
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
      .get(this.scopeKey(binding));
    if (retained && retained.origin !== origin)
      throw new Conflict(
        'The repository remote changed. Ask your setup agent to reconcile it before syncing.',
      );
    this.host.db
      .prepare('INSERT OR IGNORE INTO gng_repositories VALUES (?,?)')
      .run(this.scopeKey(binding), origin);
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
      .run(this.scopeKey(binding), origin, head);
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
        .all(this.scopeKey(binding))
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
  private direct(binding: Binding) {
    try {
      return (
        !!binding.agentId && this.runtime.store.agent(binding.agentId).executionMode === 'direct'
      );
    } catch (error) {
      if (error instanceof Missing) return false;
      throw error;
    }
  }
  private async nativeReviewed(binding: Binding, origin: string, head: string, branch: string) {
    if (!this.direct(binding) || !(await this.completedWorkBranch(binding, branch))) return null;
    const rows = this.host.db
      .prepare(
        `SELECT p.body preview,r.body review FROM gng_native_previews p
       JOIN gng_native_reviews r ON r.preview_id=p.id
       WHERE p.scope_key=? AND p.origin=? AND json_extract(p.body,'$.preview.head')=? AND json_extract(p.body,'$.preview.branch')=?`,
      )
      .all(this.scopeKey(binding), origin, head, branch);
    for (const row of rows) {
      const saved = JSON.parse(String(row.preview)) as {
        preview: NativePreviewIdentity;
        context: GroupContext;
        agentId: string;
        runId: string;
      };
      const p = nativePreviewIdentitySchema.parse(saved.preview);
      if (p.head !== head || p.branch !== branch || saved.agentId !== binding.agentId) continue;
      const request = this.connector.context(p.requestId);
      const review = JSON.parse(String(row.review)) as {
        previewId: string;
        fingerprint: string;
        kind: string;
      };
      if (
        !request ||
        request.runId !== saved.runId ||
        JSON.stringify(request.context) !== JSON.stringify(saved.context) ||
        review.kind !== 'owner-preview' ||
        review.previewId !== p.id ||
        review.fingerprint !== p.fingerprint ||
        this.workBranch(binding.context, p.requestId) !== branch ||
        (await git(binding.cwd, ['rev-parse', 'HEAD^{tree}'])) !== p.tree
      )
        continue;
      return p.base;
    }
    return null;
  }
  private async previewNative(binding: Binding, revalidate: () => Promise<void>) {
    return this.lock(binding.cwd, async () => {
      if (!this.direct(binding))
        throw new Conflict('This preview is for a native Group conversation.');
      const repo = await this.repository(binding);
      if (!repo) throw new Conflict('Connect the intended private shared repository first.');
      await revalidate();
      await this.fetchDefault(binding, repo);
      const head = await git(repo.cwd, ['rev-parse', 'HEAD']);
      const branch = await git(repo.cwd, ['symbolic-ref', '--short', 'HEAD']);
      if (
        this.busy(binding) ||
        (await git(repo.cwd, ['status', '--porcelain'])) ||
        !(await this.completedWorkBranch(binding, branch))
      )
        throw new Conflict(
          'Finish the exact Group Work request and commit its files before reviewing them for sharing.',
        );
      const requestId = branch.slice(this.workBranch(binding.context, '').length);
      const request = this.connector.context(requestId)!;
      const baselines = new Set(
        this.host.db
          .prepare('SELECT oid FROM gng_baselines WHERE handle=? AND origin=?')
          .all(this.scopeKey(binding), repo.origin)
          .map((row) => String(row.oid)),
      );
      const base = (await git(repo.cwd, ['rev-list', '--max-count=129', head]))
        .split('\n')
        .find((oid) => baselines.has(oid));
      if (!base || base === head)
        throw new Conflict(
          'There is no bounded new checkpoint to review against a verified shared baseline.',
        );
      await this.shareable(repo.cwd, base, head);
      const files = (await git(repo.cwd, ['diff', '--name-only', '-z', base, head, '--']))
        .split('\0')
        .filter(Boolean);
      // Include every new commit, including changes removed by a later checkpoint.
      const patch = await git(repo.cwd, [
        'log',
        '--reverse',
        '--format=Commit %H%n%s',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '-p',
        '--diff-merges=separate',
        `${base}..${head}`,
        '--',
      ]).catch((error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        )
          throw new Conflict(
            'This checkpoint is too large for the exact review screen. Prepare a smaller checkpoint; nothing was shared.',
          );
        throw error;
      });
      if (
        Buffer.byteLength(patch) > 131072 ||
        files.length > 1000 ||
        files.some((file) => file.length > 512)
      )
        throw new Conflict(
          'This checkpoint is too large for the exact review screen. Prepare a smaller checkpoint; nothing was shared.',
        );
      const tree = await git(repo.cwd, ['rev-parse', 'HEAD^{tree}']);
      const evidence = {
        requestId,
        base,
        head,
        tree,
        branch,
        repository: repo.label,
        files,
        patch,
      };
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            ...evidence,
            scope: this.scopeKey(binding),
            origin: repo.origin,
            agentId: binding.agentId,
            runId: request.runId,
            context: request.context,
          }),
        )
        .digest('hex');
      const preview = groupNativeCommitPreviewSchema.parse({
        id: randomUUID(),
        fingerprint,
        ...evidence,
      });
      await revalidate();
      if (
        this.busy(binding) ||
        (await git(repo.cwd, ['status', '--porcelain'])) ||
        (await git(repo.cwd, ['rev-parse', 'HEAD'])) !== head ||
        (await git(repo.cwd, ['symbolic-ref', '--short', 'HEAD'])) !== branch ||
        (await this.repository(binding))?.origin !== repo.origin ||
        !(await this.completedWorkBranch(binding, branch))
      )
        throw new Conflict(
          'Shared work changed during review preparation. Refresh the exact preview.',
        );
      const old = this.host.db
        .prepare(
          'SELECT id FROM gng_native_previews WHERE scope_key=? AND origin=? AND fingerprint=?',
        )
        .get(this.scopeKey(binding), repo.origin, fingerprint);
      if (old) return { ...preview, id: String(old.id) };
      // Git already retains the exact content. Keep compact identities and digests locally,
      // rather than copying every full diff into either local or hosted chat storage.
      const { files: _files, patch: _patch, ...identityInput } = preview;
      const identity = nativePreviewIdentitySchema.parse(identityInput);
      this.host.db.prepare('INSERT INTO gng_native_previews VALUES(?,?,?,?,?)').run(
        preview.id,
        this.scopeKey(binding),
        repo.origin,
        fingerprint,
        JSON.stringify({
          preview: identity,
          context: request.context,
          agentId: binding.agentId,
          runId: request.runId,
        }),
      );
      return preview;
    });
  }
  private async approveNative(
    binding: Binding,
    input: { key: string; previewId: string; fingerprint: string },
    revalidate: () => Promise<void>,
  ) {
    await this.lock(binding.cwd, async () => {
      const row = this.host.db
        .prepare('SELECT * FROM gng_native_previews WHERE id=? AND scope_key=?')
        .get(input.previewId, this.scopeKey(binding));
      if (!row) throw new Conflict('Review the exact saved preview for this shared folder first.');
      const saved = JSON.parse(String(row.body)) as {
        preview: NativePreviewIdentity;
        context: GroupContext;
        agentId: string;
        runId: string;
      };
      const preview = nativePreviewIdentitySchema.parse(saved.preview);
      if (
        input.fingerprint !== preview.fingerprint ||
        saved.agentId !== binding.agentId ||
        !this.direct(binding)
      )
        throw new Conflict('The exact native review identity changed. Refresh the preview.');
      const request = this.connector.context(preview.requestId);
      await revalidate();
      if (
        !request ||
        request.runId !== saved.runId ||
        JSON.stringify(request.context) !== JSON.stringify(saved.context) ||
        this.busy(binding) ||
        (await this.repository(binding))?.origin !== row.origin ||
        (await git(binding.cwd, ['status', '--porcelain'])) ||
        (await git(binding.cwd, ['rev-parse', 'HEAD'])) !== preview.head ||
        (await git(binding.cwd, ['rev-parse', 'HEAD^{tree}'])) !== preview.tree ||
        (await git(binding.cwd, ['symbolic-ref', '--short', 'HEAD'])) !== preview.branch ||
        !(await this.completedWorkBranch(binding, preview.branch))
      )
        throw new Conflict(
          'These files or the completed Group request changed. Nothing was approved; refresh the preview.',
        );
      await revalidate();
      this.host.db.prepare('INSERT OR IGNORE INTO gng_native_reviews VALUES(?,?,?)').run(
        input.key,
        preview.id,
        JSON.stringify({
          kind: 'owner-preview',
          previewId: preview.id,
          fingerprint: preview.fingerprint,
          memberId: binding.context.memberId,
          installationId: binding.context.installationId,
        }),
      );
    });
  }
  /** Scan every newly published checkpoint, including files deleted by a later commit. */
  private async shareable(cwd: string, base: string, head: string) {
    const allowProjectData = groupProjectDataAllowed(cwd, this.runtime.dataDir);
    const scanned = new Set<string>();
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
        if (groupNativePrivatePath(name, allowProjectData))
          throw new Conflict(
            'Publication stopped at a likely private or runtime file. Inspect the shared task locally.',
          );
        const type = await this.optional(cwd, ['cat-file', '-t', `${commit}:${name}`]);
        if (!type) continue; // Deleted in this checkpoint.
        if (type !== 'blob')
          throw new Conflict('Publication needs inspection of non-file content.');
        const blob = await git(cwd, ['rev-parse', '--verify', `${commit}:${name}`]);
        if (scanned.has(blob)) continue;
        const size = Number(await git(cwd, ['cat-file', '-s', blob]));
        bytes += size;
        if (bytes > GROUP_NATIVE_GIT_FILE_LIMITS.scanBytes)
          throw new Conflict(
            'This sync exceeds 512 MiB of changed files. No files were sent; ask your setup agent to review smaller checkpoints.',
          );
        await assertGroupGitBlob(cwd, blob, size);
        scanned.add(blob);
      }
    }
  }
  private workBranch(context: GroupContext, requestId: string) {
    const member = createHash('sha256')
      .update(`${context.memberId}:${context.installationId}`)
      .digest('hex')
      .slice(0, 12);
    return `swa/member-${member}/work-${requestId}`;
  }
  private async completedWorkBranch(binding: Binding, branch: string) {
    const prefix = this.workBranch(binding.context, '');
    if (!branch.startsWith(prefix)) return false;
    const id = z.uuid().safeParse(branch.slice(prefix.length));
    if (!id.success) return false;
    if (!this.connector.completionPending || this.connector.completionPending(id.data))
      return false;
    const request = this.connector.context(id.data);
    if (
      !request ||
      request.intent !== 'work' ||
      !request.runId ||
      request.cwd !== binding.cwd ||
      request.projectId !== binding.projectId ||
      request.agentId !== binding.agentId ||
      request.enrollmentHandle !== binding.enrollmentHandle ||
      request.anchor.sessionId !== binding.anchor.sessionId ||
      this.scopeKey(request) !== this.scopeKey(binding)
    )
      return false;
    try {
      const run = this.runtime.store.run(request.runId);
      if (run.agentId !== request.agentId || run.key !== id.data || run.status !== 'completed')
        return false;
      const snapshot = await this.connector.inspect({ requestId: id.data });
      return (
        !this.connector.completionPending(id.data) &&
        snapshot.requestId === id.data &&
        snapshot.state === 'completed' &&
        snapshot.result?.context.sessionId === request.context.sessionId
      );
    } catch {
      return false; // Missing or uncertain exact completion never grants a checkout change.
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
      const branch = this.workBranch(context, requestId);
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
  private async synchronize(
    binding: Binding,
    revalidate: () => Promise<void>,
    handle: string,
    operationKey?: string,
  ) {
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
      let branch = await this.optional(repo.cwd, ['symbolic-ref', '--short', 'HEAD']);
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
        branch !== main &&
        remoteHead &&
        (await this.completedWorkBranch(binding, branch)) &&
        (await this.ancestor(repo.cwd, head, remoteHead))
      ) {
        const pending = () =>
          this.host.db
            .prepare(
              "SELECT 1 FROM gng_operations WHERE json_extract(input,'$.handle')=? AND result IS NULL AND key<>? LIMIT 1",
            )
            .get(handle, operationKey ?? '');
        if (pending())
          return 'Fetched shared commits. An original shared-file operation is unresolved; its work branch and files remain in place.';
        const localDefault = await this.optional(repo.cwd, [
          'rev-parse',
          '--verify',
          `refs/heads/${main}`,
        ]);
        if (localDefault && !(await this.ancestor(repo.cwd, localDefault, remoteHead)))
          return 'Fetched shared commits. The local default branch has unpublished or divergent history; files and branches remain in place.';
        await revalidate();
        if (
          !(await this.completedWorkBranch(binding, branch)) ||
          this.busy(binding) ||
          pending() ||
          (await git(repo.cwd, ['status', '--porcelain'])) ||
          (await git(repo.cwd, ['rev-parse', 'HEAD'])) !== head ||
          (await git(repo.cwd, ['symbolic-ref', '--short', 'HEAD'])) !== branch ||
          (await this.optional(repo.cwd, ['rev-parse', '--verify', `refs/heads/${main}`])) !==
            localDefault
        )
          return 'Shared work changed before returning to the default branch; its files and original branch were preserved.';
        // The completed branch is already fully in the shared default. Keep its
        // exact ref and request history; only the idle checkout resumes receiving.
        await git(
          repo.cwd,
          localDefault
            ? ['checkout', '--no-overwrite-ignore', main]
            : ['checkout', '--no-overwrite-ignore', '--no-track', '-b', main, remoteHead],
        );
        branch = main;
        head = await git(repo.cwd, ['rev-parse', 'HEAD']);
      }
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
      const base =
        this.reviewed(binding, head) ??
        (await this.nativeReviewed(binding, repo.origin, head, branch));
      if (!base)
        return this.direct(binding)
          ? 'Your committed Group files are ready for review. Review the exact changes before sharing; nothing was uploaded.'
          : 'Local commits await independent task review and exact apply before they can be shared.';
      if (base === head && remoteHead && branch !== main)
        return 'Fetched shared commits. Your separate work branch was preserved; there is no newly reviewed work to publish.';
      await this.shareable(repo.cwd, base, head);
      if (this.verifyPrivateAccess) await this.verifyPrivateAccess(repo.cwd, repo.origin);
      else if (!this.localFixture) await this.privateAccess(repo.cwd, repo.origin);
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
      if ((await this.repository(binding))?.origin !== repo.origin)
        throw new Conflict(
          'The shared repository changed. Nothing was sent to the new destination.',
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
      if (
        (await this.repository(binding))?.origin !== repo.origin ||
        (await git(repo.cwd, ['rev-parse', 'HEAD'])) !== head ||
        this.busy(binding) ||
        (await git(repo.cwd, ['status', '--porcelain'])) ||
        (await git(repo.cwd, ['symbolic-ref', '--short', 'HEAD'])) !== branch
      )
        throw new Conflict(
          'Shared work changed before publishing to the default branch; the exact work branch remains preserved.',
        );
      await git(repo.cwd, [...push, `${head}:refs/heads/${main}`]);
      this.baseline(binding, repo.origin, head);
      return 'Reviewed committed work shared; the default branch advanced without rewriting history.';
    });
  }
  private async view(
    handle: string,
    binding: Binding,
    preview: GroupNativeGitView['preview'] = null,
    nativePreview: GroupNativeCommitPreview | null = null,
  ): Promise<GroupNativeGitView> {
    const settings = this.settings(handle, binding),
      repo = await this.repository(binding);
    return groupNativeGitViewSchema.parse({
      available: !!repo,
      repository: repo?.label ?? null,
      workspacePath: binding.cwd,
      branch: repo
        ? (await this.optional(binding.cwd, ['symbolic-ref', '--short', 'HEAD'])) || null
        : null,
      ...settings,
      connected: this.connected(handle, binding),
      dirty: !!repo && !!(await git(binding.cwd, ['status', '--porcelain'])),
      busy: this.busy(binding),
      message:
        this.notices.get(handle) ??
        (repo
          ? settings.autoSync
            ? 'Shared files sync is on. Only reviewed, applied checkpoints are published.'
            : 'Shared files sync is paused or awaits connection verification. Existing files stay local.'
          : 'Use your setup agent to connect this chosen folder to the intended private GitHub repository. Existing files stay in place.'),
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
      nativePreview,
      nativeReviewAvailable:
        !!repo &&
        this.direct(binding) &&
        !this.busy(binding) &&
        !(await git(binding.cwd, ['status', '--porcelain'])) &&
        (await this.completedWorkBranch(
          binding,
          (await this.optional(binding.cwd, ['symbolic-ref', '--short', 'HEAD'])) || '',
        )),
    });
  }
  /** Owner-only metadata from server-selected group/task workspaces. Returns no
   * file contents and never stages/publishes pending edits. */
  private async localEdits(binding: Binding): Promise<GroupNativeGitView['localEdits']> {
    // Task names are relative to this selected project, even when their worktrees
    // live under private app storage. The external project proof owns this allowance.
    const allowProjectData = groupProjectDataAllowed(binding.cwd, this.runtime.dataDir);
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
            groupNativePrivatePath(path, allowProjectData) ||
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
  /** Human review authority is supplied only by the browser/paired route, never by input. */
  async request(raw: unknown, humanReview = false): Promise<GroupNativeGitView> {
    const input = groupNativeGitRequestSchema.parse(raw);
    if (input.action === 'approve-native' && !humanReview)
      throw new Conflict(
        'Approve the exact changes from your authenticated app or paired device. Native agents cannot attest owner review.',
      );
    const scope = await this.host.authenticatedContext({ handle: input.handle });
    if (scope.context.visibility !== 'shared')
      throw new Conflict('Shared files belong to the shared group conversation.');
    let binding: Binding | null;
    try {
      binding = this.connector.workspaceScope
        ? this.connector.workspaceScope(scope.context, scope.enrollmentHandle)
        : this.connector.resolveLocalContext(scope.context, scope.enrollmentHandle);
      if (!binding) throw new Conflict('Choose this group’s shared folder first.');
    } catch {
      if (input.action !== 'status')
        throw new Conflict('Choose an accessible shared folder before connecting its Git setup.');
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
        message: 'Choose a shared folder; GitHub and agent access can be connected afterward.',
      });
    }
    let preview: GroupNativeGitView['preview'] = null;
    let nativePreview: GroupNativeCommitPreview | null = null;
    if ('key' in input) {
      const exact = JSON.stringify({
          ...input,
          ...(binding.workspaceChoiceKey ? { workspaceChoiceKey: binding.workspaceChoiceKey } : {}),
        }),
        old = this.host.db
          .prepare('SELECT input,result FROM gng_operations WHERE key=?')
          .get(input.key);
      if (old && old.input !== exact) {
        const { workspaceChoiceKey: _, ...oldInput } = JSON.parse(String(old.input)) as Record<
          string,
          unknown
        >;
        if (!old.result || JSON.stringify(oldInput) !== JSON.stringify(input))
          throw new Conflict('Retry the exact saved Git operation in its original shared folder.');
      }
      if (old?.result) {
        const result = JSON.parse(String(old.result)) as Record<string, unknown>;
        if (typeof result.nativeApprovalRejected === 'string')
          throw new Conflict(result.nativeApprovalRejected);
        return groupNativeGitViewSchema.parse(result);
      }
      if (!old) {
        if (Number(this.host.db.prepare('SELECT count(*) n FROM gng_operations').get()!.n) >= 4096)
          throw new Conflict('Shared Git operation history is full; retained work is preserved.');
        this.host.db.prepare('INSERT INTO gng_operations VALUES (?,?,NULL)').run(input.key, exact);
      }
    }
    if (input.action === 'preview-native')
      nativePreview = await this.previewNative(binding, scope.revalidate);
    if (input.action === 'approve-native') {
      const recorded = this.host.db
        .prepare(
          `SELECT r.body FROM gng_native_reviews r
        JOIN gng_native_previews p ON p.id=r.preview_id
        WHERE r.preview_id=? AND p.scope_key=? AND json_extract(p.body,'$.agentId')=?`,
        )
        .get(input.previewId, this.scopeKey(binding), binding.agentId);
      const approved =
        recorded && JSON.parse(String(recorded.body)).fingerprint === input.fingerprint;
      if (!approved) {
        try {
          await this.approveNative(binding, input, scope.revalidate);
        } catch (error) {
          const message =
            error instanceof Conflict
              ? error.message
              : 'The exact review could not be recorded. No files were shared.';
          // A known refusal cannot become approval on a later retry or block folder changes.
          this.host.db
            .prepare('UPDATE gng_operations SET result=? WHERE key=? AND result IS NULL')
            .run(JSON.stringify({ nativeApprovalRejected: message }), input.key);
          throw new Conflict(message);
        }
      }
      this.notices.set(
        input.handle,
        'Your exact file review was recorded. Automatic sync can now share this checkpoint. Later changes require a fresh review.',
      );
    }
    if (input.action === 'connect') {
      await scope.revalidate();
      const repository = await this.repository(binding);
      if (!repository)
        throw new Conflict(
          'Use your setup agent to connect the chosen folder to its intended private GitHub repository first.',
        );
      if (this.verifyPrivateAccess)
        await this.verifyPrivateAccess(repository.cwd, repository.origin);
      else await this.privateAccess(repository.cwd, repository.origin);
      await git(repository.cwd, ['ls-remote', '--symref', 'origin', 'HEAD']);
      await scope.revalidate();
      const current = this.connector.workspaceScope
        ? this.connector.workspaceScope(scope.context, scope.enrollmentHandle)
        : binding;
      if (
        !current ||
        current.cwd !== binding.cwd ||
        this.scopeKey(current) !== this.scopeKey(binding) ||
        (await this.repository(current))?.origin !== repository.origin
      )
        throw new Conflict(
          'Shared folder or repository changed during verification. Refresh and verify the selected connection.',
        );
      this.host.db
        .prepare('INSERT OR IGNORE INTO gng_connections VALUES (?,?,?,?)')
        .run(input.handle, this.scopeKey(binding), repository.origin, input.key);
      this.notices.set(
        input.handle,
        this.settings(input.handle, binding).autoSync
          ? 'Private repository access verified. Automatic sync is on; unfinished and unreviewed changes stay local.'
          : 'Private repository access verified. Your saved automatic sync Off choice was preserved.',
      );
    }
    if (input.action === 'configure') {
      await scope.revalidate();
      if (input.autoSync && !(await this.repository(binding)))
        throw new Conflict('Connect the intended shared repository before enabling sync.');
      if (input.autoSync && binding.workspaceChoiceKey && !this.connected(input.handle, binding))
        throw new Conflict(
          'Verify the intended private repository connection before enabling sync.',
        );
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
      this.notices.set(
        input.handle,
        await this.synchronize(binding, scope.revalidate, input.handle, input.key),
      );
    if (input.action === 'preview' || input.action === 'apply') {
      if (!binding.projectId)
        throw new Conflict('No shared agent work has been created in this chosen folder yet.');
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
    const result = await this.view(input.handle, binding, preview, nativePreview);
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
    const handles = this.host.db
      .prepare('SELECT handle FROM gng_settings UNION SELECT handle FROM gng_connections')
      .all();
    for (const row of handles) {
      if (this.closing) return;
      const handle = String(row.handle);
      if (!this.host.localVisible(handle)) continue;
      if (Date.now() - (this.last.get(handle) ?? 0) < 60_000) continue;
      this.last.set(handle, Date.now());
      try {
        const scope = await this.host.authenticatedContext({ handle });
        const binding = this.connector.workspaceScope
          ? this.connector.workspaceScope(scope.context, scope.enrollmentHandle)
          : this.connector.resolveLocalContext(scope.context, scope.enrollmentHandle);
        if (!binding || !this.settings(handle, binding).autoSync) continue;
        this.notices.set(handle, await this.synchronize(binding, scope.revalidate, handle));
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
