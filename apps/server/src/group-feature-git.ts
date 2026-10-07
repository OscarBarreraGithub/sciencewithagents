import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { GroupContext } from '@dock/shared';
import {
  groupGitHostRequestSchema,
  groupGitHostViewSchema,
  type GroupGitHostView,
} from '@dock/shared/dist/group-git-host.js';
import { createGroupGitHostBinding, type GroupGitHostBinding } from './group-git-host-binding.js';
import { openNativeGitHubIdentity } from './group-git-native-identity.js';
import { digest, sharedPath, type GitEvent } from './group-git.js';
import type { GitGrant, GitHostRegistration, GitReviewReceipt } from './group-git-service.js';
import type { EditIntent } from './group-git-snapshot.js';
import { GroupHostError, type GroupHost } from './group-host.js';
import type { GroupNativeConnector } from './group-native-connector.js';

class GitPlanRefused extends Error {}
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const configSchema = z.strictObject({
  gitExecutable: z.string().min(1),
  ghExecutable: z.string().min(1).optional(),
  resources: z
    .array(
      z.strictObject({
        handle: z.uuid(),
        repositoryId: id,
        label: z.string().min(1).max(160),
        nativeRequestKey: z.uuid(),
        guestRepository: z.string().min(1),
        paths: z.array(z.string().max(4096)).max(10000),
        reviews: z.array(id).max(128),
      }),
    )
    .max(64),
});
type Resource = z.infer<typeof configSchema>['resources'][number];
function configuration(host: GroupHost) {
  const path = join(host.directory, 'git-resources.json');
  if (!existsSync(path)) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid!() ||
      stat.mode & 0o077 ||
      stat.size > 2 * 1024 * 1024
    )
      throw new Error('Private saved Git resource configuration required.');
    const config = configSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
    if (
      !config.gitExecutable.startsWith('/') ||
      (config.ghExecutable && !config.ghExecutable.startsWith('/'))
    )
      throw new Error('Protected installed executable required.');
    if (new Set(config.resources.map((r) => r.repositoryId)).size !== config.resources.length)
      throw new Error('Unique saved Git resources required.');
    for (const resource of config.resources) for (const path of resource.paths) sharedPath(path);
    return config;
  } finally {
    closeSync(fd);
  }
}
const features = new WeakMap<GroupHost, GroupFeatureGit>();
export const groupFeatureGit = (host: GroupHost) => features.get(host);
/** Owner-private saved registrations are the only source of Git authority.
 * Normal controls carry opaque IDs; they cannot pick paths/accounts/endpoints. */
export class GroupFeatureGit {
  private readonly config: ReturnType<typeof configuration>;
  private binding?: GroupGitHostBinding;
  private ready: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closing = false;
  private position = 0;
  private unavailable =
    'Ask your setup agent to connect an approved saved repository. Repository files stay private until you select sharing.';
  constructor(
    readonly host: GroupHost,
    native: GroupNativeConnector,
  ) {
    host.db
      .exec(`CREATE TABLE IF NOT EXISTS gh_git_commands(handle TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,planned TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(handle,key));
      CREATE TRIGGER IF NOT EXISTS gh_git_commands_identity BEFORE UPDATE OF handle,key,input,planned ON gh_git_commands BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    try {
      this.config = configuration(host);
    } catch {
      this.config = null;
      this.unavailable =
        'Saved Git setup needs repair. Human Groups messages and existing copies remain available.';
    }
    this.ready = this.initialize(native).catch(() => {
      this.unavailable =
        'Saved Git setup is unavailable. Ask your setup agent to repair its protected resource configuration; current copies are preserved.';
    });
    features.set(host, this);
  }
  private async initialize(native: GroupNativeConnector) {
    if (!this.config) return;
    this.binding = await createGroupGitHostBinding({
      host: this.host,
      connector: native,
      service: {
        hostRoot: join(this.host.directory, 'git'),
        gitExecutable: this.config.gitExecutable,
        ...(this.config.ghExecutable
          ? {
              githubIdentity: (accountId: string) =>
                openNativeGitHubIdentity(this.config!.ghExecutable!, accountId),
            }
          : {}),
      },
    });
  }
  private resource(handle: string, repositoryId: string) {
    const resource = this.config?.resources.find(
      (r) => r.handle === handle && r.repositoryId === repositoryId,
    );
    if (!resource)
      throw new GroupHostError(
        403,
        'GROUP_GIT_DENIED',
        'Select a saved repository from this shared group.',
      );
    return resource;
  }
  private registration(resource: Resource) {
    const registration = this.binding!.service.journal.get<GitHostRegistration>(
      `registration:${resource.repositoryId}`,
    );
    if (!registration)
      throw new GroupHostError(
        409,
        'GROUP_GIT_SETUP_REQUIRED',
        'The saved repository registration needs setup on its original owner.',
      );
    return registration;
  }
  private grant(resource: Resource) {
    const registration = this.registration(resource);
    return this.binding!.service.journal.get<GitGrant>(`grant:${registration.grantId}`);
  }
  private async bind(resource: Resource) {
    const registration = this.registration(resource),
      owner = await this.host.authenticatedContext({ handle: resource.handle });
    const grant = this.grant(resource) ?? {
      id: registration.grantId,
      revision: `private_${digest(resource).slice(0, 32)}`,
      groupId: owner.context.groupId,
      memberId: owner.context.memberId,
      installationId: owner.context.installationId,
      repositoryId: registration.repositoryId,
      resourceId: registration.resourceId,
      endpointId: registration.endpointId,
      executorId: registration.executorId,
      metadata: false,
      paths: {},
      active: true,
    };
    await this.binding!.registerResource({ ...resource, grant });
    return this.binding!.select(resource.handle, resource.repositoryId);
  }
  private paths(resource: Resource) {
    return resource.paths.map((name) => ({
      id: `path_${digest([resource.repositoryId, name]).slice(0, 40)}`,
      name,
    }));
  }
  private requestedPaths(resource: Resource, ids: readonly string[]) {
    const paths = this.paths(resource);
    if (new Set(ids).size !== ids.length) throw new GitPlanRefused('Choose each saved file once.');
    return ids.map(
      (id) =>
        paths.find((p) => p.id === id)?.name ??
        (() => {
          throw new GitPlanRefused('Saved file selection changed.');
        })(),
    );
  }
  private visibility(grant: GitGrant | null | undefined): 'private' | 'metadata' | 'content' {
    return !grant?.active || !grant.metadata
      ? 'private'
      : Object.values(grant.paths).includes('content')
        ? 'content'
        : 'metadata';
  }
  private async view(handle: string, selectedId?: string, message = ''): Promise<GroupGitHostView> {
    await this.ready;
    await this.host.authenticatedContext({ handle });
    const resources = this.config?.resources.filter((r) => r.handle === handle) ?? [];
    if (!this.binding) return { message: this.unavailable, repositories: [], selected: null };
    const repositories = resources.map((resource) => {
      const registration = this.registration(resource),
        grant = this.grant(resource);
      const reviews = resource.reviews.flatMap((id) => {
        const review = this.binding!.service.journal.get<GitReviewReceipt>(`review:${id}`);
        return review?.approved &&
          review.repositoryId === resource.repositoryId &&
          review.grantRevision === grant?.revision
          ? [{ id, sourceOid: review.sourceOid }]
          : [];
      });
      return {
        id: resource.repositoryId,
        label: resource.label,
        branch: registration.mainRef,
        visibility: this.visibility(grant),
        paths: this.paths(resource).map((p) => ({
          ...p,
          visibility: grant?.active ? (grant.paths[p.name] ?? 'private') : 'private',
        })),
        reviews,
      };
    });
    let selected: GroupGitHostView['selected'] = null;
    if (selectedId) {
      const resource = this.resource(handle, selectedId),
        registration = this.registration(resource),
        saved = await this.bind(resource);
      const status = await saved.status(),
        snapshot = this.binding.service.journal.current(registration.copyId);
      const warnings =
        this.binding.service.journal.get<{ message: string; paths: string[] }[]>(
          `normal-warnings:${selectedId}`,
        ) ?? [];
      selected = {
        id: selectedId,
        branch: registration.mainRef,
        observedOid: status.observedVersion,
        nextAttemptAt: status.nextAttemptAt,
        pending: status.pendingOperationId !== null,
        snapshot: snapshot
          ? {
              copyId: snapshot.copyId,
              revision: snapshot.revision,
              headOid: snapshot.headOid,
              baseOid: snapshot.baseOid,
              dirty: snapshot.dirty,
              untracked: snapshot.untracked,
              conflicts: snapshot.conflicts,
              complete: snapshot.complete,
              writerGeneration: snapshot.writerGeneration,
              paths: [...snapshot.paths],
              renames: snapshot.renames.map((r) => [...r] as [string, string]),
              unsavedAwareness: 'unavailable',
            }
          : null,
        warnings,
      };
    }
    return groupGitHostViewSchema.parse({ message, repositories, selected });
  }
  async request(raw: unknown) {
    const { handle, command } = groupGitHostRequestSchema.parse(raw);
    const owner = await this.host.authenticatedContext({ handle });
    if (owner.context.visibility !== 'shared')
      throw new GroupHostError(403, 'GROUP_GIT_SHARED_REQUIRED', 'Open Git from the shared group.');
    await this.ready;
    if (command.kind === 'list') return this.view(handle);
    if (!this.binding) return this.view(handle);
    const resource = this.resource(handle, command.repositoryId);
    let saved = await this.bind(resource);
    let message = '';
    if (command.kind === 'observe') {
      await saved.tick();
      message = 'Observed the approved branch. Its one-minute retry schedule is retained.';
    }
    if (command.kind === 'snapshot') {
      await saved.snapshot();
      message = 'Compared the saved copy without changing its files.';
    }
    if (command.kind === 'reconcile') {
      await saved.reconcile();
      message = 'Reconciled the original executor; no replacement operation was created.';
    }
    if (command.kind === 'warnings') {
      const related = (this.config?.resources.filter((r) => r.handle === handle) ?? [])
        .filter((r) => this.registration(r).endpointId === this.registration(resource).endpointId)
        .map((r) => r.repositoryId);
      const warnings = (await saved.warnings(related)).map((w) => ({
        message: `Possible overlapping edits${w.sameBase ? ' on the same base' : ' across different bases'}${w.incomplete ? '; comparison is incomplete' : ''}. Advisory only.`,
        paths: [...w.paths],
      }));
      this.binding.service.journal.transaction(() =>
        this.binding!.service.journal.put(`normal-warnings:${resource.repositoryId}`, warnings),
      );
    }
    if ('key' in command) {
      const input = JSON.stringify(command),
        prior = this.host.db
          .prepare('SELECT input,planned,completed FROM gh_git_commands WHERE handle=? AND key=?')
          .get(handle, command.key);
      if (prior && prior.input !== input)
        throw new GroupHostError(
          409,
          'GROUP_GIT_CHANGED',
          'Retry the exact saved Git change first.',
        );
      if (prior?.completed === -1)
        return {
          ...(await this.view(handle, resource.repositoryId)),
          receipt: {
            key: command.key,
            state: 'refused' as const,
            message:
              (JSON.parse(String(prior.planned)).refusal as string | undefined) ??
              'A newer sharing policy superseded this unapplied change. The current restriction is preserved.',
          },
        };
      let plan: unknown;
      try {
        if (prior) plan = JSON.parse(String(prior.planned));
        else {
          const registration = this.registration(resource);
          if (command.kind === 'policy') {
            const paths =
              command.visibility === 'private'
                ? []
                : command.visibility === 'metadata'
                  ? resource.paths
                  : this.requestedPaths(resource, command.paths);
            plan = {
              expectedRevision: this.grant(resource)?.revision,
              grant: {
                ...this.grant(resource),
                id: registration.grantId,
                revision: command.key,
                groupId: owner.context.groupId,
                memberId: owner.context.memberId,
                installationId: owner.context.installationId,
                repositoryId: registration.repositoryId,
                resourceId: registration.resourceId,
                endpointId: registration.endpointId,
                executorId: registration.executorId,
                metadata: command.visibility !== 'private',
                paths: Object.fromEntries(
                  paths.map((p) => [p, command.visibility === 'content' ? 'content' : 'metadata']),
                ),
                active: true,
              },
            };
          } else if (command.kind === 'intent') {
            const snapshot = this.binding.service.journal.current(registration.copyId);
            if (!snapshot?.complete || snapshot.revision < 1)
              throw new GitPlanRefused(
                'Compare the current copy before publishing an edit intention.',
              );
            plan = {
              intentId: command.key,
              copyId: snapshot.copyId,
              revision: 0,
              baseOid: snapshot.baseOid,
              copyRevision: snapshot.revision,
              paths: this.requestedPaths(resource, command.paths).map((path) => {
                if (this.grant(resource)?.paths[path] !== 'content')
                  throw new GitPlanRefused(
                    'Select currently shared content files for an edit intention.',
                  );
                return path;
              }),
              expiresAt: Date.now() + 120000,
              released: false,
            };
          } else if (command.kind === 'propose') {
            if (!resource.reviews.includes(command.reviewId))
              throw new GitPlanRefused('Select a saved approved review.');
            const review = this.binding.service.journal.get<GitReviewReceipt>(
              `review:${command.reviewId}`,
            );
            if (!review) throw new GitPlanRefused('The saved independent review is unavailable.');
            if (review.grantRevision !== this.grant(resource)?.revision)
              throw new GitPlanRefused(
                'The saved review belongs to an older sharing policy. Ask for a review of the current policy.',
              );
            await this.binding.approveReview(handle, resource.repositoryId, review);
            plan = {
              operationId: command.key,
              proposalId: command.key,
              reviewId: review.id,
              historyGrantId: review.historyGrantId,
            };
          } else {
            const status = await saved.status();
            if (!status.observedVersion)
              throw new GitPlanRefused(
                'Observe the approved branch before opening an independent view.',
              );
            plan = {
              operationId: command.key,
              viewId: command.key,
              version: status.observedVersion,
              kind: command.view,
            };
          }
          this.host.db
            .prepare('INSERT INTO gh_git_commands(handle,key,input,planned) VALUES(?,?,?,?)')
            .run(handle, command.key, input, JSON.stringify(plan));
        }
      } catch (error) {
        if (
          !(error instanceof GitPlanRefused) ||
          this.host.db
            .prepare('SELECT 1 FROM gh_git_commands WHERE handle=? AND key=?')
            .get(handle, command.key)
        )
          throw error;
        await owner.revalidate();
        this.host.db
          .prepare(
            'INSERT INTO gh_git_commands(handle,key,input,planned,completed) VALUES(?,?,?,?, -1)',
          )
          .run(handle, command.key, input, JSON.stringify({ refusal: error.message }));
        return {
          ...(await this.view(handle, resource.repositoryId)),
          receipt: { key: command.key, state: 'refused' as const, message: error.message },
        };
      }
      await owner.revalidate();
      if (!prior?.completed) {
        if (command.kind === 'policy') {
          const policy = plan as { grant?: GitGrant; expectedRevision?: string };
          if (!policy.grant || !policy.expectedRevision)
            throw new GroupHostError(
              409,
              'GROUP_GIT_POLICY_RECONCILIATION',
              'This earlier policy needs owner reconciliation; the current sharing restriction is preserved.',
            );
          const applied = await this.binding.setPolicy(
            handle,
            resource.repositoryId,
            policy.grant,
            policy.expectedRevision,
          );
          if (!applied) {
            await owner.revalidate();
            this.host.db
              .prepare('UPDATE gh_git_commands SET completed=-1 WHERE handle=? AND key=?')
              .run(handle, command.key);
            return {
              ...(await this.view(handle, resource.repositoryId)),
              receipt: {
                key: command.key,
                state: 'refused' as const,
                message:
                  'A newer sharing policy superseded this unapplied change. The current restriction is preserved.',
              },
            };
          }
        }
        if (command.kind === 'intent') {
          const retained = this.binding.service.journal.get<EditIntent>(`intent:${command.key}`);
          if (retained && digest(retained) !== digest(plan))
            throw new GroupHostError(409, 'GROUP_GIT_CHANGED', 'Retained edit intention changed.');
          if (!retained) await saved.intent(plan as EditIntent);
        }
        if (command.kind === 'propose')
          await saved.propose(plan as Parameters<typeof saved.propose>[0]);
        if (command.kind === 'view')
          await saved.materialize(plan as Parameters<typeof saved.materialize>[0]);
        await owner.revalidate();
        this.host.db
          .prepare('UPDATE gh_git_commands SET completed=1 WHERE handle=? AND key=?')
          .run(handle, command.key);
      }
      message =
        command.kind === 'policy'
          ? 'Saved repository visibility. Existing reviews must match this exact new policy before proposing.'
          : command.kind === 'intent'
            ? 'Published this bounded advisory edit intention.'
            : command.kind === 'propose'
              ? 'Created the reviewed independent proposal ref; main is unchanged.'
              : 'Created an independent view; your working copy is preserved.';
      saved = await this.bind(resource);
    }
    if (this.visibility(this.grant(resource)) !== 'private')
      await this.deliver(resource, saved).catch(() => {
        message += ' Shared notification is retained for retry.';
      });
    const view = await this.view(handle, resource.repositoryId, message);
    return 'key' in command
      ? { ...view, receipt: { key: command.key, state: 'completed' as const, message } }
      : view;
  }
  private async deliver(
    resource: Resource,
    saved: Awaited<ReturnType<GroupGitHostBinding['select']>>,
  ) {
    for (const entry of (await saved.outbox()).slice(0, 2)) {
      const event = entry.value as GitEvent;
      if (event.repositoryId !== resource.repositoryId || event.id !== entry.id)
        throw new Error('Saved Git outbox identity changed.');
      const summaries: Record<GitEvent['type'], string> = {
        'main-observed': 'Observed an updated approved branch.',
        'main-view': 'Opened an independent branch view.',
        'task-pinned': 'Pinned an independent task view.',
        'proposal-published': 'Published a reviewed proposal on its independent ref.',
      };
      const summary = summaries[event.type];
      if (!summary) throw new Error('Unknown typed Git event.');
      await this.host.publishFeatureEvent(
        resource.handle,
        `git:${resource.repositoryId}:${entry.id}`,
        JSON.stringify({
          kind: 'group-git-event',
          repositoryId: resource.repositoryId,
          eventId: event.id,
          type: event.type,
          summary,
        }),
        `${resource.label}: ${summary}`,
      );
      await saved.acknowledge(entry.id);
    }
  }
  /** Actual native pre-turn callback, not a browser generation field. Ask and
   * other native contexts never synchronize or announce this saved copy. */
  async beforeWork(context: GroupContext, requestId: string) {
    if (context.visibility !== 'shared') return;
    const row = this.host.db
      .prepare('SELECT handle,key FROM ghn_requests WHERE request_id=?')
      .get(requestId);
    if (!row) return;
    const record = this.host.nativeJournal.get(String(row.handle), String(row.key));
    if (record?.request.intent !== 'work') return;
    await this.ready;
    if (!this.binding) return;
    for (const resource of this.config?.resources ?? []) {
      const source = this.host.nativeJournal.get(resource.handle, resource.nativeRequestKey)?.result
        ?.context;
      if (source?.sessionId !== context.sessionId) continue;
      const saved = await this.bind(resource);
      // Tick retains the approved branch's one-minute floor/backoff. No dirty
      // local file is overwritten; snapshots and independent views stay explicit.
      if (this.visibility(this.grant(resource)) !== 'private') {
        await saved.tick();
        await saved.snapshot();
      }
      await saved.writerStarted();
    }
  }
  start() {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => {
      void this.pass();
    }, 20000);
    this.timer.unref();
  }
  pass() {
    if (this.closing) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.runPass()
      .catch(() => {})
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async runPass() {
    await this.ready;
    if (!this.binding || !this.config?.resources.length) return;
    const resource = this.config.resources[this.position++ % this.config.resources.length];
    if (this.visibility(this.grant(resource)) === 'private') return;
    const saved = await this.bind(resource);
    await saved.tick();
    await this.deliver(resource, saved);
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    await this.ready;
    await this.binding?.service.close();
    features.delete(this.host);
  }
}
