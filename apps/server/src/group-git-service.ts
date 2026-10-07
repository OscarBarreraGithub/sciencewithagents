import { randomUUID } from 'node:crypto';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { GroupScope } from '@dock/shared';
import { GroupEventRepository, type GroupAccess } from './group-events.js';
import {
  GroupGit,
  GroupGitBlocked,
  digest,
  sharedPath,
  type GroupRepository,
  type ProposalRequest,
  type ObserveRequest,
  type ViewRequest,
  type ContentPolicy,
} from './group-git.js';
import { SqliteGitJournal } from './group-git-journal.js';
import { HostGitExecutor } from './group-git-executor.js';
import { createGitStore, pinGitResource, verifyResource } from './group-git-host-files.js';
import {
  LocalGitObjectEndpoint,
  HttpsGitObjectEndpoint,
  gitRef,
  type GitObjectEndpoint,
} from './group-git-endpoint.js';
import {
  GitHubGitEndpoint,
  githubBindingSchema,
  type GitHubIdentity,
  type GitHubWire,
} from './group-git-github.js';
import {
  gitNativeExportRequestSchema,
  verifyGitNativeExport,
  type GitNativeExports,
  type GitNativeExportRequest,
  type GitNativeExportLease,
} from './group-git-native-export.js';
import { HostGitTransport } from './group-git-host-transport.js';
import { DirectoryGitViews } from './group-git-views.js';
import {
  editIntent,
  overlapAlerts,
  type EditIntent,
  type CopySnapshot,
  type OverlapAlert,
} from './group-git-snapshot.js';
import {
  planObservation,
  settleObservation,
  type ObservationSchedule,
} from './group-git-schedule.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const pinned = z
  .object({
    id,
    root: z.string().min(1),
    gitDirectory: z.string().min(1),
    rootIdentity: z.string().regex(/^\d+:\d+$/),
    gitIdentity: z.string().regex(/^\d+:\d+$/),
    bare: z.boolean(),
  })
  .strict();
const limits = z
  .object({
    maxFiles: z.number().int().min(1).max(10000),
    maxTransferBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024),
    maxFileBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024),
    maxViewBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024),
    maxOutputBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024),
    maxInputBytes: z
      .number()
      .int()
      .min(1)
      .max(128 * 1024 * 1024),
  })
  .strict();
const registrationSchema = z
  .object({
    repositoryId: id,
    copyId: id,
    resourceId: id,
    grantId: id,
    executorId: id,
    endpointId: id,
    active: pinned,
    observation: pinned,
    endpoint: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('local'),
          resource: pinned,
          proposalOwnership: z.enum(['read-only', 'host-exclusive']),
        })
        .strict(),
      z.object({ kind: z.literal('https'), url: z.string().url(), credentialId: id }).strict(),
      z.strictObject({
        kind: z.literal('github'),
        url: z.string().url(),
        binding: githubBindingSchema,
      }),
    ]),
    mainRef: gitRef,
    boundaryRevision: id,
    configRevision: id,
    limits,
  })
  .strict();
export type GitHostRegistration = z.infer<typeof registrationSchema>;
export interface GitGrant {
  id: string;
  revision: string;
  groupId: string;
  memberId: string;
  installationId: string;
  repositoryId: string;
  resourceId: string;
  endpointId: string;
  executorId: string;
  metadata: boolean;
  paths: Readonly<Record<string, 'metadata' | 'content'>>;
  active: boolean;
}
export interface GitReviewReceipt {
  id: string;
  repositoryId: string;
  sourceOid: string;
  grantRevision: string;
  historyGrantId: string;
  historyRevision: string;
  historySourceOid: string;
  historyTargetOid: null;
  approved: boolean;
}
const grantSchema = z
  .object({
    id,
    revision: id,
    groupId: z.uuid(),
    memberId: z.uuid(),
    installationId: z.uuid(),
    repositoryId: id,
    resourceId: id,
    endpointId: id,
    executorId: id,
    metadata: z.boolean(),
    paths: z
      .record(z.string(), z.enum(['metadata', 'content']))
      .refine((paths) => Object.keys(paths).length <= 10000),
    active: z.boolean(),
  })
  .strict();
const reviewSchema = z
  .object({
    id,
    repositoryId: id,
    sourceOid: z.string().regex(/^[a-f0-9]{40}$/),
    grantRevision: id,
    historyGrantId: id,
    historyRevision: id,
    historySourceOid: z.string().regex(/^[a-f0-9]{40}$/),
    historyTargetOid: z.null(),
    approved: z.boolean(),
  })
  .strict();
export interface GroupGitAccess {
  readonly __groupGitAccess: unique symbol;
}
interface AccessScope {
  events: GroupAccess;
  scope: GroupScope;
}
/** Concrete host authorization uses the existing repository-issued identity/membership
 * boundary. Grant/review provisioning is a trusted manager method, never browser RPC.
 * No guessed name allowlist; absent grants and private contexts cannot share Git data. */
export class GroupGitAuthority {
  readonly #access = new WeakMap<GroupGitAccess, AccessScope>();
  constructor(
    private readonly events: GroupEventRepository,
    private readonly journal: SqliteGitJournal,
  ) {}
  issue(scope: GroupScope): GroupGitAccess {
    const events = this.events.trustedHostScope(scope);
    const access = Object.freeze({}) as GroupGitAccess;
    this.#access.set(access, { events, scope: structuredClone(scope) });
    return access;
  }
  grant(input: GitGrant, expectedRevision?: string): boolean {
    const grant = grantSchema.parse(input);
    for (const path of Object.keys(grant.paths)) sharedPath(path);
    return this.journal.transaction(() => {
      const key = `grant:${grant.id}`;
      const refusedKey = `grant-revision-refused:${grant.id}:${grant.revision}`;
      const refused = this.journal.get<GitGrant>(refusedKey);
      if (refused) {
        if (digest(refused) !== digest(grant))
          throw new GroupGitBlocked('Refused grant revision changed');
        return false;
      }
      const prior = this.journal.get<GitGrant>(key);
      if (
        prior &&
        prior.revision === grant.revision &&
        digest({ ...prior, active: true }) !== digest({ ...grant, active: true })
      )
        throw new GroupGitBlocked('Changed grant content requires a new immutable revision');
      const receiptKey = `grant-revision:${grant.id}:${grant.revision}`;
      const applied = this.journal.get<GitGrant>(receiptKey);
      if (applied) {
        if (digest({ ...applied, active: true }) !== digest({ ...grant, active: true }))
          throw new GroupGitBlocked('Retained grant revision changed');
        // A completed older mutation is a receipt, never authority to roll back
        // a later policy or reactivate the same explicitly revoked revision.
        if (prior?.revision !== grant.revision || (!prior.active && grant.active)) return true;
      } else if (expectedRevision !== undefined && prior?.revision !== expectedRevision) {
        this.journal.put(refusedKey, grant);
        return false;
      }
      if (!applied) this.journal.put(receiptKey, grant);
      this.journal.put(key, grant);
      return true;
    });
  }
  review(input: GitReviewReceipt): void {
    const receipt = reviewSchema.parse(input);
    this.journal.transaction(() => {
      const key = `review:${id.parse(receipt.id)}`;
      const prior = this.journal.get(key);
      if (prior && digest(prior) !== digest(receipt))
        throw new GroupGitBlocked('Review receipt is immutable');
      if (!prior) this.journal.put(key, receipt);
    });
  }
  resolve(access: GroupGitAccess, registration: GitHostRegistration): GitGrant {
    const bound = this.#access.get(access);
    if (!bound || bound.scope.visibility !== 'shared')
      throw new GroupGitBlocked('Repository-issued shared Groups access required');
    // Feed with no data projection is the existing current-membership authorization check.
    this.events.feed(bound.events, { visibility: 'shared', limit: 1, after: 0, cursor: null });
    const grant = this.journal.get<GitGrant>(`grant:${registration.grantId}`);
    if (
      !grant?.active ||
      grant.groupId !== bound.scope.groupId ||
      grant.memberId !== bound.scope.memberId ||
      grant.installationId !== bound.scope.installationId ||
      grant.repositoryId !== registration.repositoryId ||
      grant.resourceId !== registration.resourceId ||
      grant.endpointId !== registration.endpointId ||
      grant.executorId !== registration.executorId
    )
      throw new GroupGitBlocked('Current repository/resource/endpoint/executor grant denied');
    return grant;
  }
  scope(access: GroupGitAccess): GroupScope {
    const bound = this.#access.get(access);
    if (!bound || bound.scope.visibility !== 'shared')
      throw new GroupGitBlocked('Shared native export scope required');
    return structuredClone(bound.scope);
  }
  proposal(
    access: GroupGitAccess,
    registration: GitHostRegistration,
    reviewId: string,
    historyGrantId: string,
  ): GitReviewReceipt {
    const grant = this.resolve(access, registration);
    const review = this.journal.get<GitReviewReceipt>(`review:${id.parse(reviewId)}`);
    if (
      !review?.approved ||
      review.repositoryId !== registration.repositoryId ||
      review.grantRevision !== grant.revision ||
      review.historyGrantId !== historyGrantId ||
      review.sourceOid !== review.historySourceOid ||
      review.historyTargetOid !== null
    )
      throw new GroupGitBlocked('Exact trusted review and entire-history receipt required');
    return review;
  }
}

export interface GitPublicStatus {
  repositoryId: string;
  copyId: string;
  grantRevision: string;
  observedVersion: string | null;
  pendingOperationId: string | null;
  pendingState: string | null;
  nextAttemptAt: number;
  autoMain: false;
  unsavedAwareness: 'unavailable';
}
export interface GroupGitConnector {
  status(access: GroupGitAccess, repositoryId: string): Promise<GitPublicStatus>;
  tick(access: GroupGitAccess, repositoryId: string, now?: number): Promise<GitPublicStatus>;
  materialize(
    access: GroupGitAccess,
    repositoryId: string,
    input: { operationId: string; viewId: string; version: string; kind: 'main' | 'task' },
  ): Promise<{ viewId: string; version: string }>;
  snapshot(access: GroupGitAccess, repositoryId: string): Promise<CopySnapshot>;
  intent(access: GroupGitAccess, repositoryId: string, input: EditIntent): Promise<EditIntent>;
  warnings(
    access: GroupGitAccess,
    repositoryId: string,
    copyRepositoryIds: readonly string[],
  ): Promise<OverlapAlert[]>;
  propose(
    access: GroupGitAccess,
    repositoryId: string,
    input: { operationId: string; proposalId: string; reviewId: string; historyGrantId: string },
  ): Promise<{ ref: string; oid: string }>;
  outbox(access: GroupGitAccess, repositoryId: string): Promise<{ id: string; value: unknown }[]>;
  acknowledge(access: GroupGitAccess, repositoryId: string, eventId: string): Promise<void>;
  reconcile(access: GroupGitAccess, repositoryId: string): Promise<boolean>;
}
/** Bounded host tick, no independent timer/model call. The normal authenticated Groups
 * host resolves repository IDs and supplies authority-issued access; its existing scheduler
 * invokes tick(). Persisted schedules and exact requests survive offline/restart/lost ACK. */
export class GroupGitService implements GroupGitConnector {
  readonly authority: GroupGitAuthority;
  readonly journal: SqliteGitJournal;
  readonly #registrations = new Map<string, GitHostRegistration>();
  readonly #inFlight = new Set<string>();
  private constructor(
    readonly hostRoot: string,
    private readonly executor: HostGitExecutor,
    events: GroupEventRepository,
    private readonly credentials: (id: string) => Promise<string>,
    private readonly githubIdentity?: (accountId: string) => Promise<GitHubIdentity>,
    private readonly githubWire?: GitHubWire,
    private readonly nativeExports?: GitNativeExports,
  ) {
    this.journal = new SqliteGitJournal(join(hostRoot, 'git.sqlite'), executor);
    this.authority = new GroupGitAuthority(events, this.journal);
    for (const repositoryId of this.journal.get<string[]>('repositories') ?? []) {
      const saved = registrationSchema.parse(this.journal.get(`registration:${repositoryId}`));
      this.#registrations.set(repositoryId, saved);
    }
  }
  static async open(input: {
    hostRoot: string;
    gitExecutable: string;
    events: GroupEventRepository;
    credentials?: (id: string) => Promise<string>;
    githubIdentity?: (accountId: string) => Promise<GitHubIdentity>;
    githubWire?: GitHubWire;
    nativeExports?: GitNativeExports;
  }): Promise<GroupGitService> {
    await mkdir(input.hostRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(input.hostRoot);
    if (
      (await realpath(input.hostRoot)) !== resolve(input.hostRoot) ||
      !info.isDirectory() ||
      info.mode & 0o077
    )
      throw new GroupGitBlocked('Git host storage must be canonical and private');
    const executor = await HostGitExecutor.open(
      join(input.hostRoot, 'git.sqlite'),
      input.gitExecutable,
    );
    return new GroupGitService(
      input.hostRoot,
      executor,
      input.events,
      input.credentials ??
        (async () => {
          throw new GroupGitBlocked('Endpoint credential is not configured');
        }),
      input.githubIdentity,
      input.githubWire,
      input.nativeExports,
    );
  }
  /** Trusted installation/manager only. Paths never appear in the connector or browser.
   * Host-owned resources must be excluded from native agent writes by the native boundary. */
  async register(input: {
    resourceId: string;
    grantId: string;
    executorId: string;
    endpointId: string;
    activeRoot: string;
    endpoint:
      | { kind: 'local'; root: string; proposalOwnership: 'read-only' | 'host-exclusive' }
      | { kind: 'https'; url: string; credentialId: string }
      | { kind: 'github'; url: string; binding: z.infer<typeof githubBindingSchema> };
    mainRef?: string;
    limits?: Partial<z.infer<typeof limits>>;
  }): Promise<{ repositoryId: string; copyId: string }> {
    if (this.#registrations.size >= 64)
      throw new GroupGitBlocked('Git repository registration limit');
    const repositoryId = randomUUID();
    const copyId = randomUUID();
    const directory = join(this.hostRoot, repositoryId);
    await mkdir(directory, { mode: 0o700 });
    const observationRoot = join(directory, 'observation.git');
    await createGitStore(observationRoot);
    await mkdir(join(directory, 'views'), { mode: 0o700 });
    const registration = registrationSchema.parse({
      repositoryId,
      copyId,
      resourceId: input.resourceId,
      grantId: input.grantId,
      executorId: input.executorId,
      endpointId: input.endpointId,
      active: await pinGitResource(input.resourceId, input.activeRoot),
      observation: await pinGitResource(`observation_${repositoryId}`, observationRoot, true),
      endpoint:
        input.endpoint.kind === 'local'
          ? {
              kind: 'local',
              resource: await pinGitResource(input.endpointId, input.endpoint.root, true),
              proposalOwnership: input.endpoint.proposalOwnership,
            }
          : input.endpoint,
      mainRef: input.mainRef ?? 'refs/heads/main',
      boundaryRevision: 'config-free-shadow-v1',
      configRevision: digest(['metadata-object-protocol-v1', input.endpoint]),
      limits: {
        maxFiles: 4096,
        maxTransferBytes: 8 * 1024 * 1024,
        maxFileBytes: 1024 * 1024,
        maxViewBytes: 8 * 1024 * 1024,
        maxOutputBytes: 4 * 1024 * 1024,
        maxInputBytes: 64 * 1024 * 1024,
        ...input.limits,
      },
    });
    if (registration.endpoint.kind === 'https')
      new HttpsGitObjectEndpoint(registration.endpointId, registration.endpoint.url, () =>
        this.credentials(
          registration.endpoint.kind === 'https' ? registration.endpoint.credentialId : '',
        ),
      );
    if (registration.endpoint.kind === 'github') {
      if (!this.githubIdentity)
        throw new GroupGitBlocked('Existing native GitHub identity resolver required');
      new GitHubGitEndpoint(
        registration.endpointId,
        registration.endpoint.url,
        registration.endpoint.binding,
        await this.githubIdentity(registration.endpoint.binding.accountId),
        async () => {},
        this.githubWire,
      );
    }
    this.journal.transaction(() => {
      this.journal.put(`registration:${repositoryId}`, registration);
      this.journal.put('repositories', [...this.#registrations.keys(), repositoryId]);
      this.journal.put(`schedule:${repositoryId}`, {
        epoch: randomUUID(),
        sequence: 0,
        lastAttemptAt: null,
        nextAttemptAt: 0,
        pending: null,
      } satisfies ObservationSchedule);
    });
    this.#registrations.set(repositoryId, registration);
    return { repositoryId, copyId };
  }
  async #githubIdentity(accountId: string): Promise<GitHubIdentity> {
    if (!this.githubIdentity)
      throw new GroupGitBlocked('Existing native GitHub identity resolver required');
    return this.githubIdentity(accountId);
  }
  #registration(repositoryId: string): GitHostRegistration {
    const registration = this.#registrations.get(id.parse(repositoryId));
    if (!registration) throw new GroupGitBlocked('Repository unavailable');
    return registration;
  }
  async #engine(
    access: GroupGitAccess,
    repositoryId: string,
    source?: { lease: GitNativeExportLease; request: GitNativeExportRequest },
  ): Promise<{
    registration: GitHostRegistration;
    grant: GitGrant;
    repository: GroupRepository;
    transport: HostGitTransport;
    core: GroupGit;
  }> {
    const registration = this.#registration(repositoryId);
    const grant = this.authority.resolve(access, registration);
    await verifyResource(registration.active);
    await verifyResource(registration.observation);
    const active = source?.lease.resource ?? registration.active;
    if (source) {
      await verifyGitNativeExport(source.lease, source.request);
      if (active.root === registration.active.root || active.root === registration.observation.root)
        throw new GroupGitBlocked('Separate immutable native export required');
    }
    const revalidate = async () => {
      if (digest(this.authority.resolve(access, registration)) !== digest(grant))
        throw new GroupGitBlocked('Endpoint grant changed');
      if (source) await verifyGitNativeExport(source.lease, source.request);
    };
    const endpoint: GitObjectEndpoint =
      registration.endpoint.kind === 'local'
        ? new LocalGitObjectEndpoint(
            registration.endpointId,
            registration.endpoint.resource,
            this.executor,
            repositoryId,
            this.hostRoot,
            registration.limits.maxInputBytes,
            registration.endpoint.proposalOwnership,
            revalidate,
          )
        : registration.endpoint.kind === 'github'
          ? new GitHubGitEndpoint(
              registration.endpointId,
              registration.endpoint.url,
              registration.endpoint.binding,
              await this.#githubIdentity(registration.endpoint.binding.accountId),
              revalidate,
              this.githubWire,
            )
          : new HttpsGitObjectEndpoint(
              registration.endpointId,
              registration.endpoint.url,
              () =>
                this.credentials(
                  registration.endpoint.kind === 'https' ? registration.endpoint.credentialId : '',
                ),
              revalidate,
            );
    const policy: ContentPolicy = {
      revision: grant.revision,
      visibility: (path) => grant.paths[path] ?? 'private',
    };
    const repository: GroupRepository = {
      repositoryId,
      root: active.root,
      endpoint: registration.endpointId,
      observation: {
        root: registration.observation.root,
        resourceIdentity: registration.observation.id,
        configIdentity: registration.configRevision,
      },
      active: {
        resourceIdentity: source?.lease.resource.id ?? registration.resourceId,
        configIdentity: source
          ? digest([registration.configRevision, source.lease.receipt])
          : registration.configRevision,
      },
      hostCallerId: registration.executorId,
      boundaryRevision: registration.boundaryRevision,
      mainRef: registration.mainRef,
      observedRefs: { [registration.mainRef]: 'refs/dock-observed/main' },
      policy,
      ...registration.limits,
      authorize: async (action, revision, request) => {
        await revalidate();
        const current = this.authority.resolve(access, registration);
        if (current.revision !== revision || digest(current) !== digest(grant)) return false;
        if (action === 'observe') return current.metadata;
        if (action === 'proposal') {
          const proposal = request as ProposalRequest;
          const saved = this.journal.get<GitReviewReceipt>(`review:${proposal.review.reviewId}`);
          if (!saved) return false;
          const receipt = this.authority.proposal(
            access,
            registration,
            proposal.review.reviewId,
            saved.historyGrantId,
          );
          return (
            receipt.sourceOid === proposal.sourceOid &&
            receipt.historyRevision === proposal.historyGrant.revision
          );
        }
        return true;
      },
    };
    const transport = new HostGitTransport(
      repository,
      endpoint,
      active,
      registration.observation,
      this.executor,
      this.hostRoot,
      registration.limits.maxInputBytes,
      source?.lease.receipt.manifestDigest,
    );
    const core = new GroupGit(
      repository,
      transport,
      this.journal,
      new DirectoryGitViews(join(this.hostRoot, repositoryId, 'views'), {
        maxFiles: registration.limits.maxFiles,
        maxFileBytes: registration.limits.maxFileBytes,
        maxTotalBytes: registration.limits.maxViewBytes,
      }),
    );
    this.journal.transaction(() =>
      this.journal.put(`scope:${repositoryId}`, { grantRevision: grant.revision }),
    );
    return { registration, grant, repository, transport, core };
  }
  async #serial<T>(repositoryId: string, work: () => Promise<T>): Promise<T> {
    if (this.#inFlight.has(repositoryId))
      throw new GroupGitBlocked('Git repository operation is already active');
    this.#inFlight.add(repositoryId);
    try {
      return await work();
    } finally {
      this.#inFlight.delete(repositoryId);
    }
  }
  async status(access: GroupGitAccess, repositoryId: string): Promise<GitPublicStatus> {
    const registration = this.#registration(repositoryId);
    const grant = this.authority.resolve(access, registration);
    const schedule = this.journal.get<ObservationSchedule>(`schedule:${repositoryId}`)!;
    return {
      repositoryId,
      copyId: registration.copyId,
      grantRevision: grant.revision,
      observedVersion: this.journal.get<string>(`observed:${repositoryId}`),
      pendingOperationId: schedule.pending?.request.operationId ?? null,
      pendingState: schedule.pending
        ? (this.journal.operation(schedule.pending.request.operationId)?.state ?? 'planned')
        : null,
      nextAttemptAt: schedule.nextAttemptAt,
      autoMain: false,
      unsavedAwareness: 'unavailable',
    };
  }
  async tick(
    access: GroupGitAccess,
    repositoryId: string,
    now = Date.now(),
  ): Promise<GitPublicStatus> {
    return this.#serial(repositoryId, async () => {
      const { grant, repository, transport, core } = await this.#engine(access, repositoryId);
      const schedule = this.journal.get<ObservationSchedule>(`schedule:${repositoryId}`)!;
      if (now < schedule.nextAttemptAt || schedule.pending?.blocked)
        return this.status(access, repositoryId);
      const prior = this.journal.get<string>(`observed:${repositoryId}`);
      // For a fresh attempt, retain its generated ID before the first offline-prone read.
      // The endpoint hint is exact and scoped. A failed hint advances only the saved deadline.
      let tip = schedule.pending?.request.expectedTip;
      if (!tip) {
        const request: ObserveRequest = {
          operationId: `probe_${schedule.epoch}_${schedule.sequence}`,
          remoteRef: repository.mainRef,
          expectedTip: '0'.repeat(40),
          expectedPrevious: prior,
          grantRevision: grant.revision,
        };
        try {
          tip =
            (await transport.operation('observe', request, () =>
              transport.ref(repository.mainRef),
            )) ?? undefined;
        } catch (error) {
          this.journal.transaction(() =>
            this.journal.put(
              `schedule:${repositoryId}`,
              { ...schedule, lastAttemptAt: now, nextAttemptAt: now + 60000 },
              schedule,
            ),
          );
          throw error;
        }
        if (!tip) throw new GroupGitBlocked('Approved remote ref is unavailable');
      }
      const plan = planObservation(schedule, now, {
        remoteRef: repository.mainRef,
        expectedPrevious: prior,
        expectedTip: tip,
        grantRevision: grant.revision,
      });
      this.journal.transaction(() =>
        this.journal.put(`schedule:${repositoryId}`, plan.schedule, schedule),
      );
      if (!plan.request) return this.status(access, repositoryId);
      try {
        const result = await transport.operation('observe', plan.request, () =>
          core.observe(plan.request!),
        );
        this.journal.transaction(() => {
          this.journal.put(`observed:${repositoryId}`, result.oid);
          this.journal.put(
            `schedule:${repositoryId}`,
            settleObservation(plan.schedule, plan.request!.operationId, 'verified', now),
            plan.schedule,
          );
        });
      } catch (error) {
        const state = this.journal.operation(plan.request.operationId)?.state;
        const outcome = state === 'blocked' ? 'blocked' : 'uncertain';
        this.journal.transaction(() =>
          this.journal.put(
            `schedule:${repositoryId}`,
            settleObservation(plan.schedule, plan.request!.operationId, outcome, now),
            plan.schedule,
          ),
        );
        throw error;
      }
      return this.status(access, repositoryId);
    });
  }
  async materialize(
    access: GroupGitAccess,
    repositoryId: string,
    input: { operationId: string; viewId: string; version: string; kind: 'main' | 'task' },
  ): Promise<{ viewId: string; version: string }> {
    return this.#serial(repositoryId, async () => {
      const { grant, transport, core, registration } = await this.#engine(access, repositoryId);
      const request: ViewRequest = {
        operationId: input.operationId,
        viewId: input.viewId,
        expectedMain: input.version,
        kind: input.kind,
        grantRevision: grant.revision,
      };
      const view = await transport.operation('view', request, () => core.materialize(request));
      this.authority.resolve(access, registration);
      return { viewId: view.id, version: view.baseOid };
    });
  }
  async snapshot(access: GroupGitAccess, repositoryId: string): Promise<CopySnapshot> {
    return this.#serial(repositoryId, async () => {
      const { registration, repository, grant, transport } = await this.#engine(
        access,
        repositoryId,
      );
      const main = this.journal.get<string>(`observed:${repositoryId}`);
      if (!main) throw new GroupGitBlocked('Observe the approved base first');
      return this.journal.exclusive(repositoryId, async () => {
        const request: ViewRequest = {
          operationId: `snapshot_${registration.copyId}`,
          viewId: 'snapshot',
          expectedMain: main,
          grantRevision: grant.revision,
          kind: 'task',
        };
        const snapshot = await transport.operation('view', request, async () => {
          const base =
            this.journal.get<string>(`base:${repositoryId}`) ?? (await transport.activeHead());
          if (!this.journal.get(`base:${repositoryId}`))
            this.journal.transaction(() => this.journal.put(`base:${repositoryId}`, base));
          return transport.capture(
            {
              root: registration.active.root,
              repositoryId,
              copyId: registration.copyId,
              epoch: registration.copyId,
              baseOid: base,
              observedMainOid: main,
              policy: repository.policy,
              hostGit: {
                scope: 'production',
                hostCallerId: repository.hostCallerId,
                boundaryRevision: repository.boundaryRevision,
                endpoint: repository.endpoint,
                resourceIdentity: repository.active.resourceIdentity,
                configIdentity: repository.active.configIdentity,
              },
              maxFiles: repository.maxFiles,
              maxFileBytes: repository.maxFileBytes,
              maxTotalBytes: repository.maxViewBytes,
              maxOutputBytes: repository.maxOutputBytes,
              writerGeneration: () => this.journal.get<number>(`writer:${repositoryId}`) ?? 0,
              now: () => Date.now(),
            },
            this.journal,
          );
        });
        this.authority.resolve(access, registration);
        return snapshot;
      });
    });
  }
  async intent(
    access: GroupGitAccess,
    repositoryId: string,
    input: EditIntent,
  ): Promise<EditIntent> {
    const { registration, repository } = await this.#engine(access, repositoryId);
    if (input.copyId !== registration.copyId)
      throw new GroupGitBlocked('Edit intent copy resource mismatch');
    const snapshot = this.journal.current(input.copyId);
    if (!snapshot || snapshot.revision !== input.copyRevision || snapshot.baseOid !== input.baseOid)
      throw new GroupGitBlocked('Edit intent snapshot is stale');
    const intent = editIntent(input, repository.policy, Date.now(), 300000);
    this.journal.transaction(() => {
      const previous = this.journal.get<EditIntent>(`intent:${input.intentId}`);
      if (
        previous &&
        (previous.copyId !== input.copyId || previous.revision >= input.revision) &&
        digest(previous) !== digest(intent)
      )
        throw new GroupGitBlocked('Edit intent revision conflict');
      this.journal.put(`intent:${input.intentId}`, intent);
      const ids = this.journal.get<string[]>(`intents:${repositoryId}`) ?? [];
      if (!ids.includes(intent.intentId)) {
        if (ids.length >= 256) throw new GroupGitBlocked('Edit intent history limit');
        this.journal.put(`intents:${repositoryId}`, [...ids, intent.intentId]);
      }
    });
    return intent;
  }
  /** Trusted native pre-write hook; never a client-supplied generation. */
  async writerStarted(access: GroupGitAccess, repositoryId: string): Promise<void> {
    this.authority.resolve(access, this.#registration(repositoryId));
    this.journal.transaction(() =>
      this.journal.put(
        `writer:${repositoryId}`,
        (this.journal.get<number>(`writer:${repositoryId}`) ?? 0) + 1,
      ),
    );
  }
  async warnings(
    access: GroupGitAccess,
    repositoryId: string,
    copyRepositoryIds: readonly string[],
  ): Promise<OverlapAlert[]> {
    const { grant, registration } = await this.#engine(access, repositoryId);
    const ids = [...new Set([repositoryId, ...copyRepositoryIds])];
    if (ids.length > 64) throw new GroupGitBlocked('Warning copy limit');
    const snapshots: CopySnapshot[] = [];
    const intents: EditIntent[] = [];
    for (const sourceId of ids) {
      const source = this.#registration(sourceId);
      const current = this.authority.resolve(access, source);
      if (
        source.endpointId !== registration.endpointId ||
        source.mainRef !== registration.mainRef ||
        digest(source.endpoint) !== digest(registration.endpoint)
      )
        throw new GroupGitBlocked('Warning endpoint/resource mismatch');
      const saved = this.journal.current(source.copyId);
      if (saved) {
        if (saved.policyRevision !== current.revision)
          throw new GroupGitBlocked('Warning snapshot grant changed; recapture required');
        const eligible = (path: string) =>
          grant.paths[path] === 'content' && current.paths[path] === 'content';
        snapshots.push({
          ...saved,
          repositoryId,
          paths: saved.paths.filter(eligible),
          renames: saved.renames.filter((pair) => pair.every(eligible)),
        });
        for (const intentId of this.journal.get<string[]>(`intents:${sourceId}`) ?? []) {
          const intent = this.journal.get<EditIntent>(`intent:${intentId}`);
          if (intent) intents.push({ ...intent, paths: intent.paths.filter(eligible) });
        }
      }
    }
    const alerts = overlapAlerts(snapshots, intents, Date.now());
    this.journal.transaction(() => {
      for (const alert of alerts)
        this.journal.enqueue(alert.id, repositoryId, grant.revision, alert);
    });
    return alerts;
  }
  async propose(
    access: GroupGitAccess,
    repositoryId: string,
    input: { operationId: string; proposalId: string; reviewId: string; historyGrantId: string },
  ): Promise<{ ref: string; oid: string }> {
    return this.#serial(repositoryId, async () => {
      const registration = this.#registration(repositoryId);
      const grant = this.authority.resolve(access, registration);
      const receipt = this.authority.proposal(
        access,
        registration,
        input.reviewId,
        input.historyGrantId,
      );
      let source: { lease: GitNativeExportLease; request: GitNativeExportRequest } | undefined;
      if (registration.endpoint.kind === 'github') {
        if (!this.nativeExports)
          throw new GroupGitBlocked('Required native immutable Git export bridge unavailable');
        const key = `native-export:${input.operationId}`;
        const prior = this.journal.get<GitNativeExportRequest>(key);
        const request = gitNativeExportRequestSchema.parse({
          exportId: prior?.exportId ?? randomUUID(),
          operationId: input.operationId,
          repositoryId,
          resourceId: registration.resourceId,
          scope: this.authority.scope(access),
          grantRevision: grant.revision,
          reviewId: receipt.id,
          sourceOid: receipt.sourceOid,
          historyRevision: receipt.historyRevision,
          contentPaths: Object.keys(grant.paths)
            .filter((p) => grant.paths[p] === 'content')
            .sort(),
          maxObjects: registration.limits.maxFiles,
          maxBytes: registration.limits.maxTransferBytes,
          maxFileBytes: registration.limits.maxFileBytes,
        });
        const pending = this.journal.get<string>(`native-export-pending:${repositoryId}`);
        if (
          (pending && pending !== input.operationId) ||
          (prior && digest(prior) !== digest(request))
        )
          throw new GroupGitBlocked(
            'Native export intent identity/authorization changed; retain same ID',
          );
        if (!prior)
          this.journal.transaction(() => {
            this.journal.put(key, request);
            this.journal.put(`native-export-pending:${repositoryId}`, input.operationId);
          });
        const lease = prior
          ? await this.nativeExports.inspect(request.exportId)
          : await this.nativeExports.acquire(request);
        if (!lease) throw new GroupGitBlocked('Uncertain native export; same-ID inspection only');
        await verifyGitNativeExport(lease, request);
        const priorReceipt = this.journal.get(`native-export-receipt:${input.operationId}`);
        if (priorReceipt && digest(priorReceipt) !== digest(lease.receipt))
          throw new GroupGitBlocked('Immutable native export receipt changed');
        this.journal.transaction(() => {
          if (!priorReceipt)
            this.journal.put(`native-export-receipt:${input.operationId}`, lease.receipt);
          this.journal.put(`native-export-pending:${repositoryId}`, null);
        });
        source = { lease, request };
      }
      const { transport, core } = await this.#engine(access, repositoryId, source);
      const request: ProposalRequest = {
        operationId: input.operationId,
        proposalId: input.proposalId,
        sourceOid: receipt.sourceOid,
        expectedTarget: null,
        grantRevision: grant.revision,
        review: {
          approved: true,
          sourceOid: receipt.sourceOid,
          grantRevision: grant.revision,
          reviewId: receipt.id,
        },
        historyGrant: {
          revision: receipt.historyRevision,
          sourceOid: receipt.historySourceOid,
          targetOid: null,
        },
      };
      return transport.operation('proposal', request, () => core.publishProposal(request));
    });
  }
  async outbox(
    access: GroupGitAccess,
    repositoryId: string,
  ): Promise<{ id: string; value: unknown }[]> {
    const registration = this.#registration(repositoryId);
    const grant = this.authority.resolve(access, registration);
    return this.journal.pending(repositoryId, grant.revision);
  }
  async acknowledge(access: GroupGitAccess, repositoryId: string, eventId: string): Promise<void> {
    const grant = this.authority.resolve(access, this.#registration(repositoryId));
    this.journal.acknowledge(repositoryId, grant.revision, eventId);
  }
  async reconcile(access: GroupGitAccess, repositoryId: string): Promise<boolean> {
    this.authority.resolve(access, this.#registration(repositoryId));
    return this.journal.recover(repositoryId);
  }
  /** S1/S2: explicit manager disposition; never replay or abandon an effect-intent. IDs
   * generated before terminal pre-intent refusal remain in history. Changed grants/config
   * on an uncertain operation require restoring that exact authorization or keeping it fenced. */
  async dismissBlocked(
    access: GroupGitAccess,
    repositoryId: string,
    operationId: string,
    decisionId: string,
  ): Promise<void> {
    this.authority.resolve(access, this.#registration(repositoryId));
    id.parse(decisionId);
    this.journal.transaction(() => {
      const schedule = this.journal.get<ObservationSchedule>(`schedule:${repositoryId}`)!;
      const operation = this.journal.operation(operationId);
      if (
        schedule.pending?.request.operationId !== operationId ||
        operation?.state !== 'blocked' ||
        (operation.result &&
          typeof operation.result === 'object' &&
          Object.hasOwn(operation.result, 'effectIntent'))
      )
        throw new GroupGitBlocked(
          'Only terminal pre-intent blocked operations permit a new reviewed ID',
        );
      this.journal.put(`disposition:${operationId}`, {
        decisionId,
        operationId,
        action: 'retained-pre-intent-block',
      });
      this.journal.put(
        `schedule:${repositoryId}`,
        { ...schedule, sequence: schedule.sequence + 1, pending: null },
        schedule,
      );
    });
  }
  close(): void {
    if (this.#inFlight.size) throw new Error('Git host operations still active');
    this.journal.close();
    this.executor.close();
  }
}
