import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { groupContextSchema, localJobSchema, type GroupContext } from '@dock/shared';
import { groupWorkspaceViewSchema } from '@dock/shared/dist/group-workspace.js';
import {
  groupNativeGitRequestSchema,
  groupNativeGitViewSchema,
  type GroupNativeGitView,
} from '@dock/shared/dist/group-native-git.js';
import { groupExternalFilesRequestSchema } from '@dock/shared/dist/group-external-files.js';
import {
  GroupWorkspaceChoices,
  assertGroupWorkspaceFolder,
  type WorkspaceChange,
  type GroupWorkspacePort,
} from './group-workspace-choices.js';
import { GroupExternalFiles, type ExternalFileScope } from './group-external-files.js';
import { GroupGitRepository } from './group-git-repository.js';
import { initializeGroupGitStorage } from './group-git-storage.js';
import { GroupsConversationJournal } from './groups-conversation-journal.js';
import { groupsConversationHold } from './groups-conversation-worker.js';
import { privateGroupFile, protectGroupSidecars } from './group-host-storage.js';
import { GroupHostError, type GroupHost } from './group-host.js';
import { Conflict, type Store } from './store.js';
import { groupSharingGit as git } from './group-sharing-git.js';

type Workspace = { cwd: string; scopeKey: string; enrollment: string; identity: string };
type Settings = { githubUsername: string; autoSync: boolean };
/** External-native files only. No agent provisioning and no background checkout mutation. */
export class GroupsFiles implements GroupWorkspacePort {
  private readonly db: DatabaseSync;
  private readonly choices: GroupWorkspaceChoices;
  private readonly repository: GroupGitRepository;
  private readonly external: GroupExternalFiles;
  private readonly active = new Map<string, Promise<unknown>>();
  private readonly notices = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private background?: Promise<void>;
  private closing = false;
  private readonly last = new Map<string, number>();
  constructor(
    readonly host: GroupHost,
    private readonly store: Store,
    private readonly root: string,
    private readonly fixture?: {
      localRepository: true;
      verifyPrivateAccess(cwd: string, origin: string): Promise<void>;
    },
  ) {
    const path = join(host.directory, 'host-native.sqlite');
    privateGroupFile(path);
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
    this.choices = new GroupWorkspaceChoices(this.db);
    protectGroupSidecars(path);
    initializeGroupGitStorage(host.db);
    this.repository = new GroupGitRepository(host.db, () => root, !!fixture?.localRepository);
    this.external = new GroupExternalFiles(host.db, (handle) => this.externalScope(handle));
  }
  private anchor(context: GroupContext, enrollment: string) {
    groupContextSchema.parse(context);
    z.uuid().parse(enrollment);
    if (context.provider !== 'owner' || context.visibility !== 'shared')
      throw new Conflict('Open the shared group before choosing files.');
    this.host.events.trustedHostScope({
      groupId: context.groupId,
      memberId: context.memberId,
      installationId: context.installationId,
      visibility: context.visibility,
      source: {
        sessionId: context.sessionId,
        provider: context.provider,
        nativeSessionId: context.nativeSessionId,
        messageId: 'host-native-owner',
      },
      causalRefs: [],
    });
  }
  private scope(context: GroupContext, enrollment: string): Workspace | null {
    this.anchor(context, enrollment);
    const choice = this.choices.get(context, enrollment);
    if (!choice) return null;
    assertGroupWorkspaceFolder(choice.selection);
    return {
      cwd: choice.selection.root,
      identity: choice.selection.identity,
      scopeKey: choice.key,
      enrollment,
    };
  }
  private retainedWorkBusy(enrollment: string, paths: string[]) {
    const projects = new Set(
      this.store
        .projects()
        .filter((project) => paths.includes(project.root))
        .map((project) => project.id),
    );
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='hnr_bindings'").get())
      for (const row of this.db
        .prepare("SELECT body FROM hnr_bindings WHERE json_extract(body,'$.enrollmentHandle')=?")
        .all(enrollment)) {
        const binding = z.object({ projectId: z.uuid() }).parse(JSON.parse(String(row.body)));
        projects.add(binding.projectId);
      }
    if (
      this.store
        .agents()
        .some(
          (agent) =>
            projects.has(agent.projectId) &&
            (['queued', 'running', 'waiting'].includes(agent.status) || !!agent.turnId),
        ) ||
      this.store
        .runs()
        .some(
          (run) =>
            ['queued', 'running'].includes(run.status) &&
            projects.has(this.store.agent(run.agentId).projectId),
        ) ||
      this.store.db
        .prepare('SELECT body FROM local_jobs')
        .all()
        .some((row) => {
          const job = localJobSchema.parse(JSON.parse(String(row.body)));
          return (
            !!job.projectId &&
            projects.has(job.projectId) &&
            ['queued', 'running', 'paused'].includes(job.status)
          );
        })
    )
      return true;
    for (const table of ['hnr_inputs', 'hnr_requests']) {
      if (!this.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table)) continue;
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='hnr_results'").get())
        return true;
      if (
        this.db
          .prepare(
            `SELECT 1 FROM ${table} p WHERE json_extract(input,'$.enrollmentHandle')=? AND json_extract(input,'$.context.visibility')='shared' AND NOT EXISTS(SELECT 1 FROM hnr_results r WHERE r.request_id=p.request_id) LIMIT 1`,
          )
          .get(enrollment)
      )
        return true;
    }
    return false;
  }
  assertWorkspaceIdle(handle: string) {
    const scope = this.host.localSharedContext(handle),
      workspace = this.scope(scope.context, scope.enrollmentHandle);
    if (groupsConversationHold(this.host, this.root, scope.enrollmentHandle))
      throw new Conflict(
        'Stop sharing, close Claude and its jobs, and confirm closure in Manage before changing the folder.',
      );
    if (
      workspace &&
      (this.active.has(workspace.cwd) ||
        this.retainedWorkBusy(scope.enrollmentHandle, [workspace.cwd]))
    )
      throw new Conflict('Settle retained work and file operations before changing folders.');
    if (
      this.host.db
        .prepare(
          "SELECT 1 FROM gng_operations WHERE json_extract(input,'$.handle')=? AND result IS NULL LIMIT 1",
        )
        .get(handle)
    )
      throw new Conflict('Recover the original saved Git operation before changing folders.');
  }
  workspace(context: GroupContext, enrollment: string, change?: WorkspaceChange) {
    this.anchor(context, enrollment);
    const choice = change
      ? this.choices.select(context, enrollment, change, (selectedRoot) => {
          const current = this.choices.get(context, enrollment),
            selected = this.selection(enrollment);
          const slot = this.host.db
            .prepare(
              "SELECT json_extract(body,'$.shared.handle') handle FROM gh_groups WHERE handle=?",
            )
            .get(enrollment);
          if (
            slot &&
            this.host.db
              .prepare(
                "SELECT 1 FROM gng_operations WHERE json_extract(input,'$.handle')=? AND result IS NULL LIMIT 1",
              )
              .get(slot.handle)
          )
            throw new Conflict('Recover the original saved Git operation before changing folders.');
          const initialMatch =
            !current && selected?.enabled && selected.folder?.cwd === selectedRoot;
          if (
            (!initialMatch && groupsConversationHold(this.host, this.root, enrollment)) ||
            (current && this.active.has(current.selection.root)) ||
            this.retainedWorkBusy(enrollment, [
              selectedRoot,
              ...(current ? [current.selection.root] : []),
            ])
          )
            throw new Conflict(
              'Close the selected Claude and settle saved work before changing shared folders.',
            );
        })
      : this.choices.get(context, enrollment);
    let available = !!choice;
    try {
      if (choice) assertGroupWorkspaceFolder(choice.selection);
    } catch {
      available = false;
    }
    return groupWorkspaceViewSchema.parse({
      revision: choice?.revision ?? 0,
      selectionKey: choice?.selection.key ?? null,
      workspacePath: choice?.selection.root ?? null,
      available,
      message: choice
        ? available
          ? 'This folder is selected. Verify its private repository; files publish only after exact owner review.'
          : 'The selected folder is unavailable. Its original receipt and files are retained.'
        : 'Choose the folder used by your existing Claude Code. Selecting it starts no agent and publishes no files.',
    });
  }
  private connected(handle: string, workspace: Workspace, origin?: string) {
    return !!this.host.db
      .prepare(
        'SELECT 1 FROM gng_connections WHERE handle=? AND scope_key=? AND (? IS NULL OR origin=?)',
      )
      .get(handle, workspace.scopeKey, origin ?? null, origin ?? null);
  }
  private settings(handle: string, workspace: Workspace): Settings {
    const row = this.host.db
      .prepare('SELECT body FROM gng_settings WHERE handle=? ORDER BY rowid DESC LIMIT 1')
      .get(handle);
    const saved = row
      ? z
          .object({ githubUsername: z.string(), autoSync: z.boolean() })
          .parse(JSON.parse(String(row.body)))
      : { githubUsername: '', autoSync: true };
    return { ...saved, autoSync: saved.autoSync && this.connected(handle, workspace) };
  }
  private selection(enrollment: string) {
    if (!existsSync(join(this.root, 'groups-conversations.sqlite'))) return null;
    const journal = new GroupsConversationJournal(this.root);
    try {
      const selected = journal.selection(enrollment);
      return selected ? { ...selected, folder: journal.sessionFolder(selected.sessionId) } : null;
    } finally {
      journal.close();
    }
  }
  private async verify(cwd: string, origin: string, write = false) {
    if (this.fixture) await this.fixture.verifyPrivateAccess(cwd, origin);
    else await this.repository.privateAccess(cwd, origin, write);
  }
  private async lock<T>(cwd: string, body: () => Promise<T>): Promise<T> {
    const next = (this.active.get(cwd) ?? Promise.resolve()).catch(() => {}).then(body);
    this.active.set(cwd, next);
    try {
      return await next;
    } finally {
      if (this.active.get(cwd) === next) this.active.delete(cwd);
    }
  }
  private async externalScope(handle: string, reading = false): Promise<ExternalFileScope> {
    if (this.closing)
      throw new Conflict('File sharing is closing. Keep the original checkpoint for retry.');
    const scope = await this.host.authenticatedContext({ handle });
    if (
      scope.context.visibility !== 'shared' ||
      !this.host.localVisible(handle) ||
      (!reading && !this.host.localContributing(handle))
    )
      throw new Conflict(
        'Resume automatic sharing for this visible shared group before sharing files.',
      );
    const workspace = this.scope(scope.context, scope.enrollmentHandle);
    if (!workspace) throw new Conflict('Choose the selected Claude’s shared folder first.');
    const repo = await this.repository.repository(workspace);
    if (!repo) throw new Conflict('Connect the intended private repository first.');
    const selected = this.selection(scope.enrollmentHandle);
    if (!selected || (!reading && !selected.enabled))
      throw new Conflict(
        'Select your existing Claude conversation before proposing or publishing files.',
      );
    if (
      !reading &&
      (!selected.folder ||
        selected.folder.cwd !== workspace.cwd ||
        selected.folder.identity !== workspace.identity)
    )
      throw new Conflict(
        'Reload the Groups hooks in your selected Claude folder, then select that same folder in Manage. No files were shared.',
      );
    const revalidate = async () => {
      await scope.revalidate();
      const current = this.scope(scope.context, scope.enrollmentHandle),
        selection = this.selection(scope.enrollmentHandle);
      if (
        !this.host.localVisible(handle) ||
        !this.host.localContributing(handle) ||
        !current ||
        current.scopeKey !== workspace.scopeKey ||
        current.cwd !== workspace.cwd ||
        !selection?.enabled ||
        selection.sessionId !== selected.sessionId ||
        selection.generation !== selected.generation ||
        selection.folder?.cwd !== workspace.cwd ||
        selection.folder.identity !== workspace.identity
      )
        throw new Conflict(
          'The selection, contribution mode or folder changed. Make a fresh proposal.',
        );
      if ((await this.repository.repository(current))?.origin !== repo.origin)
        throw new Conflict('The repository changed; no new destination was used.');
    };
    return {
      handle: scope.enrollmentHandle,
      cwd: workspace.cwd,
      scopeKey: workspace.scopeKey,
      origin: repo.origin,
      repository: repo.label,
      sessionId: selected.sessionId,
      generation: selected.generation,
      author: `${scope.context.groupId}:${scope.context.memberId}:${scope.context.installationId}`,
      connected: this.connected(handle, workspace, repo.origin),
      autoSync: this.settings(handle, workspace).autoSync,
      revalidate,
      verify: async () => {
        await revalidate();
        await this.verify(repo.cwd, repo.origin, true);
      },
      fetch: () => this.repository.fetchDefault(workspace, repo),
      scan: (base, head) => this.repository.shareable(workspace.cwd, base, head),
      announce: async (input) =>
        (await this.host.send({ ...input, handle })).delivery === 'complete',
      lock: (body) => this.lock(workspace.cwd, body),
    };
  }
  async externalRequest(raw: unknown, humanReview = false) {
    const input = groupExternalFilesRequestSchema.parse(raw);
    if (input.action === 'status' || input.action === 'preview') {
      const scope = await this.host.authenticatedContext({ handle: input.handle });
      if (scope.context.visibility !== 'shared' || !this.host.localVisible(input.handle))
        throw new Conflict('Open this visible shared group.');
      await scope.revalidate();
      const current = await this.externalScope(input.handle, true).catch(() => null);
      const selected = this.selection(scope.enrollmentHandle);
      const writable =
        current &&
        this.host.localContributing(input.handle) &&
        selected?.enabled &&
        selected.folder?.cwd === current.cwd &&
        selected.folder.identity === this.scope(scope.context, scope.enrollmentHandle)?.identity;
      return this.external.readRetained(
        scope.enrollmentHandle,
        current,
        input.action === 'preview' ? input.id : undefined,
        !!writable,
      );
    }
    return this.external.request(input, humanReview);
  }
  private async view(handle: string, workspace: Workspace | null): Promise<GroupNativeGitView> {
    const repo = workspace ? await this.repository.repository(workspace) : null;
    const selected = workspace ? this.selection(workspace.enrollment) : null;
    const hold = workspace && groupsConversationHold(this.host, this.root, workspace.enrollment);
    return groupNativeGitViewSchema.parse({
      available: !!repo,
      repository: repo?.label ?? null,
      workspacePath: workspace?.cwd ?? null,
      branch: repo
        ? await this.repository.optional(repo.cwd, ['symbolic-ref', '--short', 'HEAD'])
        : null,
      ...(workspace ? this.settings(handle, workspace) : { githubUsername: '', autoSync: false }),
      connected: !!workspace && this.connected(handle, workspace, repo?.origin),
      dirty: !!repo && !!(await git(repo.cwd, ['status', '--porcelain'])),
      busy: !!hold,
      busyReason: hold ? 'external-claude' : undefined,
      externalClosureGeneration:
        hold && selected && !selected.enabled ? selected.generation : undefined,
      message:
        this.notices.get(handle) ??
        'Automatic sync fetches shared history and publishes only exact owner-approved Claude checkpoints. It never stages, commits or changes your checkout.',
      tasks: [],
      preview: null,
      nativeReviewAvailable: false,
    });
  }
  async request(raw: unknown, humanReview = false): Promise<GroupNativeGitView> {
    if (this.closing)
      throw new Conflict('File sharing is closing. Keep the original checkpoint for retry.');
    const input = groupNativeGitRequestSchema.parse(raw);
    if (
      input.action === 'preview' ||
      input.action === 'apply' ||
      input.action === 'preview-native' ||
      input.action === 'approve-native'
    )
      throw new Conflict(
        'Use your existing Claude to propose a committed checkpoint. App-owned Work is unavailable here.',
      );
    const scope = await this.host.authenticatedContext({ handle: input.handle });
    await scope.revalidate();
    if (this.closing)
      throw new Conflict('File sharing is closing. Keep the original checkpoint for retry.');
    if (scope.context.visibility !== 'shared' || !this.host.localVisible(input.handle))
      throw new Conflict('Open this visible shared group.');
    const workspace = this.scope(scope.context, scope.enrollmentHandle);
    if (!workspace) {
      if (input.action === 'status') return this.view(input.handle, null);
      throw new Conflict('Choose the intended shared folder first.');
    }
    if (input.action === 'confirm-external-closed') {
      if (!humanReview)
        throw new Conflict(
          'Only the authenticated app owner can confirm that Claude and its jobs are closed.',
        );
      const journal = new GroupsConversationJournal(this.root);
      try {
        journal.confirmClosed({
          key: input.key,
          generation: input.generation,
          handle: scope.enrollmentHandle,
        });
      } catch (error) {
        throw new Conflict(error instanceof Error ? error.message : 'Closure was not confirmed.');
      } finally {
        journal.close();
      }
      return this.view(input.handle, workspace);
    }
    if (input.action === 'status') return this.view(input.handle, workspace);
    const exact = JSON.stringify({ ...input, workspaceChoiceKey: workspace.scopeKey }),
      old = this.host.db
        .prepare('SELECT input,result FROM gng_operations WHERE key=?')
        .get(input.key);
    if (old && old.input !== exact)
      throw new Conflict('Retry the exact original Git operation in its selected folder.');
    const replay = (raw: string) => {
      const result = JSON.parse(raw) as Record<string, unknown>;
      // This retained refusal marker is also understood by full SWA.
      if (typeof result.nativeApprovalRejected === 'string')
        throw new Conflict(result.nativeApprovalRejected);
      return groupNativeGitViewSchema.parse(result);
    };
    if (old?.result) return replay(String(old.result));
    if (!old) {
      if (Number(this.host.db.prepare('SELECT count(*) n FROM gng_operations').get()!.n) >= 4096)
        throw new Conflict(
          'Shared Git operation history is full; prior receipts remain preserved.',
        );
      this.host.db.prepare('INSERT INTO gng_operations VALUES(?,?,NULL)').run(input.key, exact);
    }
    const replayed = await this.lock(workspace.cwd, async () => {
      await scope.revalidate();
      const saved = this.host.db
        .prepare('SELECT result FROM gng_operations WHERE key=?')
        .get(input.key);
      if (saved?.result) return replay(String(saved.result));
      // An older NULL receipt may have crossed an effect boundary before a crash.
      // Only this fresh attempt can prove that a refusal preceded every effect.
      let attempted = !!old;
      try {
        if (this.closing)
          throw new Conflict('File sharing is closing. Keep the original checkpoint for retry.');
        const current = this.scope(scope.context, scope.enrollmentHandle);
        if (!current || current.scopeKey !== workspace.scopeKey || current.cwd !== workspace.cwd)
          throw new Conflict('The selected folder changed. Start a new Git operation.');
        const repo = await this.repository.repository(workspace);
        if (input.action === 'connect') {
          if (!repo)
            throw new Conflict(
              'Use your setup agent to connect this folder to the intended private GitHub repository.',
            );
          await this.verify(repo.cwd, repo.origin);
          await git(repo.cwd, ['ls-remote', '--symref', 'origin', 'HEAD']);
          await scope.revalidate();
          const current = this.scope(scope.context, scope.enrollmentHandle);
          if (
            !current ||
            current.scopeKey !== workspace.scopeKey ||
            (await this.repository.repository(current))?.origin !== repo.origin
          )
            throw new Conflict('The folder or repository changed during verification.');
          attempted = true;
          this.host.db
            .prepare('INSERT OR IGNORE INTO gng_connections VALUES(?,?,?,?)')
            .run(input.handle, workspace.scopeKey, repo.origin, input.key);
        }
        if (input.action === 'configure') {
          if (input.autoSync && (!repo || !this.connected(input.handle, workspace, repo.origin)))
            throw new Conflict('Verify the intended private repository before enabling sync.');
          attempted = true;
          this.host.db
            .prepare('INSERT OR IGNORE INTO gng_settings VALUES(?,?,?,?)')
            .run(
              input.handle,
              input.key,
              JSON.stringify(input),
              JSON.stringify({ githubUsername: input.githubUsername, autoSync: input.autoSync }),
            );
        }
        if (input.action === 'sync') {
          if (!repo || !this.connected(input.handle, workspace, repo.origin))
            throw new Conflict('Verify the intended private repository before fetching.');
          await this.verify(repo.cwd, repo.origin);
          attempted = true;
          await this.repository.fetchDefault(workspace, repo);
        }
        this.notices.set(
          input.handle,
          'Repository status saved. Only immutable approved checkpoints publish; your checkout and local branches stay unchanged.',
        );
      } catch (error) {
        if (attempted)
          throw new GroupHostError(
            503,
            'GROUP_GIT_OPERATION_UNCERTAIN',
            'The saved Git operation is unresolved. Retain its original request and retry it before changing folders.',
          );
        const message =
          error instanceof Conflict
            ? error.message
            : 'The Git operation was refused before connecting, configuring or fetching. Check setup before trying a new operation.';
        this.host.db
          .prepare('UPDATE gng_operations SET result=? WHERE key=? AND result IS NULL')
          .run(JSON.stringify({ nativeApprovalRejected: message }), input.key);
        throw new Conflict(message);
      }
    });
    if (replayed) return replayed;
    if (input.action === 'sync' && this.settings(input.handle, workspace).autoSync)
      await this.external
        .sync(input.handle)
        .catch((error) =>
          this.notices.set(
            input.handle,
            error instanceof Error ? error.message : 'Checkpoint publication is waiting.',
          ),
        );
    const result = await this.view(input.handle, workspace);
    this.host.db
      .prepare('UPDATE gng_operations SET result=? WHERE key=? AND result IS NULL')
      .run(JSON.stringify(result), input.key);
    return result;
  }
  start() {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => {
      if (!this.background)
        this.background = this.pass()
          .catch(() => {})
          .finally(() => {
            this.background = undefined;
          });
    }, 20_000);
    this.timer.unref();
  }
  private async pass() {
    for (const row of this.host.db
      .prepare('SELECT handle FROM gng_settings UNION SELECT handle FROM gng_connections')
      .all()) {
      if (this.closing) return;
      const handle = String(row.handle);
      if (Date.now() - (this.last.get(handle) ?? 0) < 60_000) continue;
      this.last.set(handle, Date.now());
      try {
        const scope = await this.host.authenticatedContext({ handle });
        if (!this.host.localVisible(handle)) continue;
        const workspace = this.scope(scope.context, scope.enrollmentHandle);
        if (!workspace || !this.settings(handle, workspace).autoSync) continue;
        const repo = await this.repository.repository(workspace);
        if (!repo || !this.connected(handle, workspace, repo.origin)) continue;
        await this.lock(workspace.cwd, async () => {
          await this.verify(repo.cwd, repo.origin);
          await scope.revalidate();
          await this.repository.fetchDefault(workspace, repo);
        });
        if (this.host.localContributing(handle)) await this.external.sync(handle);
      } catch (error) {
        this.notices.set(
          handle,
          error instanceof Error ? error.message : 'Shared files are waiting.',
        );
      }
    }
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await this.background;
    await Promise.allSettled(this.active.values());
    this.db.close();
  }
}
