import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  clusterProjectCreateSchema,
  clusterProjectActionSchema,
  clusterProjectRecordSchema,
  clusterProjectSummarySchema,
  clusterProjectOpenedSchema,
  clusterProjectListSchema,
  clusterProjectOpeningSchema,
  defaultModelPolicy,
  modelPolicySchema,
  type ClusterFolderDescriptor,
  type ClusterProjectRecord,
  type ClusterSettings,
  type SlurmDevelopmentReviewResult,
  type ClusterAccountControls,
} from '@dock/shared';
import { Conflict, Missing, type Store } from './store.js';
import { ClusterProjectRuntimes, developmentInput } from './cluster-runtime.js';
import { DevelopmentReviewHeld, type DevelopmentLease } from './cluster-development.js';
import { WorkspaceState } from './workspace-state.js';

export interface ClusterFolderResolver {
  resolveFolder(folderId: string): Promise<ClusterFolderDescriptor>;
}
export interface ClusterProjectAdmission {
  controls(projectId: string): ClusterAccountControls;
  savePolicy(projectId: string, raw: unknown): Promise<unknown>;
  saveBudget(projectId: string, raw: unknown): Promise<unknown>;
}
const indexKey = 'cluster-projects:index';
type PendingReview = { reviewId: string; token: string; configuration: string };
type SavedOpening = {
  key: string;
  status: unknown;
  pendingAllocation?: { jobId: string; token: string; configuration: string };
  pendingReview?: PendingReview;
};
/** Local destination records are intentionally separate from local filesystem projects. */
export class ClusterProjects {
  admission: ClusterProjectAdmission | undefined;
  private readonly opening = new Map<string, Promise<void>>();
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private pendingCursor = 0;
  /** Only explicit opens in this controller lifetime authorize review continuation. */
  private readonly openIntents = new Map<string, { key: string; continuations: number }>();
  private readonly onStoreEvent = (event: { type: string; data?: unknown }) => {
    if (
      event.type === 'cluster.connection_lease' &&
      z.object({ enabled: z.literal(false) }).safeParse(event.data).success
    )
      this.cancelContinuations();
  };
  constructor(
    private readonly store: Store,
    private readonly folders: ClusterFolderResolver,
    readonly runtimes: ClusterProjectRuntimes,
    private readonly settings: () => ClusterSettings | null,
    private readonly developmentReview: (id: string) => SlurmDevelopmentReviewResult | null = () =>
      null,
  ) {
    for (const id of z.array(z.uuid()).parse(store.getSetting(indexKey) ?? [])) {
      const saved = store.getSetting(`cluster-project-opening:${id}`) as SavedOpening | null;
      if (!saved) continue;
      const status = clusterProjectOpeningSchema.parse(saved.status);
      if (
        status.state === 'preparing' ||
        status.state === 'ready' ||
        saved.pendingAllocation ||
        saved.pendingReview
      )
        store.setSetting(`cluster-project-opening:${id}`, {
          key: saved.key,
          status: {
            ...status,
            state: 'error',
            updatedAt: new Date().toISOString(),
            message:
              'The controller restarted. Explicitly reopen to reconnect this saved project and its native history.',
          },
        });
    }
    store.on('event', this.onStoreEvent);
  }
  requireOpenIntent(id: string) {
    if (this.stopped || !this.openIntents.has(id))
      throw new Conflict('The project open was stopped. Explicitly reopen; nothing was submitted.');
  }
  private cancelContinuations() {
    for (const id of this.openIntents.keys()) {
      const saved = this.store.getSetting(`cluster-project-opening:${id}`) as SavedOpening | null;
      if (
        !saved ||
        !['preparing', 'waiting'].includes(clusterProjectOpeningSchema.parse(saved.status).state)
      )
        continue;
      this.store.setSetting(`cluster-project-opening:${id}`, {
        key: saved.key,
        status: {
          ...clusterProjectOpeningSchema.parse(saved.status),
          state: 'error',
          updatedAt: new Date().toISOString(),
          message:
            'The cluster connection was stopped. Explicitly reopen to continue this saved project.',
        },
      });
    }
    this.openIntents.clear();
  }
  record(id: string) {
    const saved = this.store.getSetting(`cluster-project:${z.uuid().parse(id)}`);
    if (!saved) throw new Missing('This cluster project has not been connected on this computer.');
    return clusterProjectRecordSchema.parse(saved);
  }
  private save(record: ClusterProjectRecord) {
    this.store.setSetting(`cluster-project:${record.id}`, clusterProjectRecordSchema.parse(record));
  }
  summary(id: string) {
    const record = this.record(id),
      lease = this.runtimes.allocations.get(id),
      admission = this.store.getSetting(`cluster-admission:controller-status:${id}`) as {
        state: string;
        observedAt: string;
        message: string;
      } | null;
    return clusterProjectSummarySchema.parse({
      id,
      name: record.name,
      description: record.description,
      alias: record.folder.alias,
      folderId: record.folder.folderId,
      createdAt: record.createdAt,
      provider: record.manager.provider,
      hostId: record.hostId,
      remoteProjectId: record.remoteProjectId,
      remoteManagerId: record.remoteManagerId,
      development: {
        state: lease?.state ?? 'absent',
        jobId: lease?.jobId ?? null,
        node: lease?.node ?? null,
        observedAt: lease?.observedAt ?? null,
        message: lease?.message ?? 'Open this project to request its owned development allocation.',
      },
      review: this.developmentReview(id),
      opening: (() => {
        const opening = this.openingStatus(id);
        return opening?.state === 'ready' && lease?.state !== 'ready'
          ? {
              ...opening,
              state: 'waiting',
              message:
                'The saved development allocation is unavailable. Explicitly reopen to reconnect its retained native history.',
            }
          : opening;
      })(),
      needsTracking: record.folder.gitMarker === false && !record.trackingConsent,
      setupRequired:
        record.folder.gitMarker === false && !record.trackingConsent
          ? 'Start tracking this saved cluster project explicitly before requesting its development allocation.'
          : admission &&
              Date.now() - Date.parse(admission.observedAt) < 30000 &&
              admission.state === 'ready'
            ? null
            : (admission?.message ??
              'Cluster native account and QUARK admission setup must be verified before a manager turn can start.'),
    });
  }
  list() {
    return clusterProjectListSchema.parse(
      z
        .array(z.uuid())
        .max(100)
        .parse(this.store.getSetting(indexKey) ?? [])
        .map((id) => this.summary(id)),
    );
  }
  async create(raw: unknown) {
    const input = clusterProjectCreateSchema.parse(raw);
    // Durable key compares input before remote revalidation. A retry returns its exact destination.
    const saved = this.store.getSetting(`cluster-project-create:${input.key}`) as {
      input: string;
      id: string;
    } | null;
    if (saved) {
      if (saved.input !== JSON.stringify(input))
        throw new Error('This project retry key was already used for different input.');
      return this.summary(saved.id);
    }
    const folder = await this.folders.resolveFolder(input.folderId);
    const controllerHostId = new WorkspaceState(this.store).hostId;
    return this.store.operation(`cluster-project-create:${input.key}`, input, () => {
      const index = z
        .array(z.uuid())
        .max(99)
        .parse(this.store.getSetting(indexKey) ?? []);
      const id = randomUUID();
      const record = clusterProjectRecordSchema.parse({
        id,
        controllerHostId,
        hostId: randomUUID(),
        name: input.name,
        description: input.description,
        createdAt: new Date().toISOString(),
        folder,
        manager: input.manager,
        policy: modelPolicySchema.parse(
          this.store.getSetting('model-policy') ?? defaultModelPolicy,
        ),
        slurmReviewPolicy: this.store.getSetting('slurm-review:policy') ?? null,
        remoteProjectId: null,
        remoteManagerId: null,
        remoteWorkspaceId: null,
      });
      this.save(record);
      this.store.setSetting(indexKey, [...index, id]);
      this.store.setSetting(`cluster-project-create:${input.key}`, {
        input: JSON.stringify(input),
        id,
      });
      this.store.event('cluster.project.created', null, null, {
        id,
        alias: folder.alias,
        folderId: folder.folderId,
        provider: input.manager.provider,
      });
      return this.summary(id);
    });
  }
  async enableTracking(id: string, raw: unknown) {
    const input = clusterProjectActionSchema.parse(raw),
      record = this.record(id);
    const folder = await this.folders.resolveFolder(record.folder.folderId);
    if (
      !record.folder.directoryIdentity ||
      folder.directoryIdentity !== record.folder.directoryIdentity ||
      folder.path !== record.folder.path ||
      folder.username !== record.folder.username ||
      folder.rootId !== record.folder.rootId
    )
      throw new Conflict(
        'The saved cluster folder identity changed. Refresh and choose it again before enabling tracking.',
      );
    return this.store.operation(
      `cluster-project-tracking:${input.key}`,
      { projectId: id, folderIdentity: folder.directoryIdentity },
      () => {
        const current = this.record(id);
        if (!current.trackingConsent)
          this.save({
            ...current,
            trackingConsent: {
              key: input.key,
              folderIdentity: folder.directoryIdentity!,
              confirmedAt: new Date().toISOString(),
            },
          });
        this.store.event('cluster.project.tracking_consented', null, null, {
          projectId: id,
          folderId: folder.folderId,
        });
        return this.summary(id);
      },
    );
  }
  private openingStatus(id: string) {
    const saved = this.store.getSetting(`cluster-project-opening:${id}`) as {
      status: unknown;
    } | null;
    return saved ? clusterProjectOpeningSchema.parse(saved.status) : null;
  }
  opened(id: string) {
    const project = this.summary(id);
    return clusterProjectOpenedSchema.parse({
      project,
      destination:
        project.opening?.state === 'ready' &&
        project.development.state === 'ready' &&
        this.runtimes.hasGateway(id) &&
        project.remoteProjectId &&
        project.remoteManagerId
          ? {
              hostId: project.hostId,
              projectId: project.remoteProjectId,
              managerId: project.remoteManagerId,
            }
          : null,
    });
  }
  async open(id: string, raw: unknown) {
    const input = clusterProjectActionSchema.parse(raw),
      record = this.record(id);
    if (this.stopped)
      throw new Conflict(
        'The controller is stopping. Reopen this saved project after it restarts.',
      );
    this.store.operation(
      `cluster-project-open-request:${input.key}`,
      { projectId: id },
      () => true,
    );
    if (record.folder.gitMarker === false && !record.trackingConsent) return this.opened(id);
    if (this.opening.has(id)) return this.opened(id);
    if (this.openIntents.get(id)?.key !== input.key)
      this.openIntents.set(id, { key: input.key, continuations: 0 });
    this.beginPreparation(id, input.key);
    return this.opened(id);
  }
  private beginPreparation(id: string, key: string, expected?: DevelopmentLease) {
    if (this.stopped || this.opening.has(id)) return;
    const startedAt = this.openingStatus(id)?.startedAt ?? new Date().toISOString();
    const save = (
      state: 'preparing' | 'waiting' | 'ready' | 'error',
      message: string,
      pendingAllocation?: DevelopmentLease,
      pendingReview?: PendingReview,
    ) => {
      if (this.stopped || this.openIntents.get(id)?.key !== key) return;
      this.store.transaction(() => {
        const status = {
          state,
          startedAt,
          updatedAt: new Date().toISOString(),
          message: message.slice(0, 500),
        };
        this.store.setSetting(`cluster-project-opening:${id}`, {
          key,
          status,
          ...(pendingAllocation?.jobId
            ? {
                pendingAllocation: {
                  jobId: pendingAllocation.jobId,
                  token: pendingAllocation.token,
                  configuration: pendingAllocation.configuration,
                },
              }
            : {}),
          ...(pendingReview ? { pendingReview } : {}),
        });
        this.store.event('cluster.project.preparation_changed', null, null, {
          projectId: id,
          ...status,
        });
      });
    };
    // A queued allocation keeps its waiting state while a bounded native read reconciles it.
    if (!expected)
      save(
        'preparing',
        'Preparing the owned compute allocation and remote runtime. Your saved brief has not been sent.',
      );
    let preparing = false;
    const work = Promise.resolve()
      .then(async () => {
        try {
          const result = await this.openOnce(id, { key }, expected, () => {
            this.requireOpenIntent(id);
            if (!preparing) {
              preparing = true;
              save(
                'preparing',
                'The same owned allocation is running. Preparing its remote runtime; your saved brief has not been sent.',
              );
            }
          });
          const lease = this.runtimes.allocations.get(id);
          const waitingAllocation =
            !result.destination && lease?.state === 'pending' && lease.jobId;
          const reviewHeld =
            !expected &&
            !waitingAllocation &&
            result.project.review &&
            !result.project.review.allowed;
          save(
            result.destination ? 'ready' : 'waiting',
            result.destination
              ? 'The exact saved remote project is ready.'
              : reviewHeld
                ? result.project.review!.message
                : result.project.development.message,
            waitingAllocation ? lease : undefined,
          );
        } catch (error) {
          if (error instanceof DevelopmentReviewHeld) {
            save(
              'waiting',
              error.review.message,
              undefined,
              error.review.pending && error.plan
                ? {
                    reviewId: error.review.reviewId,
                    token: error.plan.token,
                    configuration: error.plan.configuration,
                  }
                : undefined,
            );
            return;
          }
          save(
            'error',
            error instanceof Error
              ? error.message
              : 'Remote preparation did not complete. Saved work remains available.',
          );
        }
      })
      .finally(() => this.opening.delete(id));
    this.opening.set(id, work);
  }
  /** Server-owned continuation; cached GET routes never invoke this or native Slurm. */
  async tickPending() {
    if (this.stopped) return;
    const projects = this.list(),
      start = this.pendingCursor;
    for (let offset = 0; offset < projects.length; offset++) {
      const index = (start + offset) % projects.length,
        project = projects[index]!;
      if (this.opening.has(project.id)) continue;
      const saved = this.store.getSetting(
        `cluster-project-opening:${project.id}`,
      ) as SavedOpening | null;
      if (
        !saved ||
        this.openIntents.get(project.id)?.key !== saved.key ||
        clusterProjectOpeningSchema.parse(saved.status).state !== 'waiting'
      )
        continue;
      if (saved.pendingReview) {
        const review = this.developmentReview(project.id);
        if (!review || review.reviewId !== saved.pendingReview.reviewId || !review.allowed)
          continue;
        const plan = this.runtimes.allocations.planned(developmentInput(this.record(project.id))),
          prior = this.runtimes.allocations.get(project.id);
        if (
          (prior && !['released', 'rejected'].includes(prior.state)) ||
          !plan ||
          plan.token !== saved.pendingReview.token ||
          plan.configuration !== saved.pendingReview.configuration
        ) {
          this.cancelReview(
            project.id,
            saved,
            'The saved allocation review plan changed. Explicitly reopen; no replacement was requested.',
          );
          continue;
        }
        const intent = this.openIntents.get(project.id)!;
        if (intent.continuations >= 2) {
          this.cancelReview(
            project.id,
            saved,
            'Review continuation needs another explicit Open. Nothing was submitted.',
          );
          continue;
        }
        if (this.opening.size >= 2) break;
        intent.continuations++;
        this.beginPreparation(project.id, saved.key);
        this.pendingCursor = (index + 1) % projects.length;
        continue;
      }
      if (!saved.pendingAllocation) continue;
      const lease = this.runtimes.allocations.get(project.id),
        identity = saved.pendingAllocation;
      if (
        !lease ||
        lease.jobId !== identity.jobId ||
        lease.token !== identity.token ||
        lease.configuration !== identity.configuration
      ) {
        this.store.setSetting(`cluster-project-opening:${project.id}`, {
          key: saved.key,
          status: {
            ...clusterProjectOpeningSchema.parse(saved.status),
            state: 'error',
            updatedAt: new Date().toISOString(),
            message:
              'The saved allocation continuation changed. Explicitly reopen; no replacement was requested.',
          },
        });
        continue;
      }
      if (this.opening.size >= 2) break;
      this.beginPreparation(project.id, saved.key, lease);
      this.pendingCursor = (index + 1) % projects.length;
    }
    await Promise.all([...this.opening.values()]);
  }
  start() {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => {
      void this.tickPending().catch(() => {
        /* Per-project failures retain their explicit saved preparation state. */
      });
    }, 15000);
    this.timer.unref();
  }
  close() {
    this.stopped = true;
    this.openIntents.clear();
    this.store.off('event', this.onStoreEvent);
    this.runtimes.allocations.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  private cancelReview(id: string, saved: SavedOpening, message: string) {
    this.store.setSetting(`cluster-project-opening:${id}`, {
      key: saved.key,
      status: {
        ...clusterProjectOpeningSchema.parse(saved.status),
        state: 'error',
        updatedAt: new Date().toISOString(),
        message,
      },
    });
    this.openIntents.delete(id);
  }
  private async openOnce(
    id: string,
    raw: unknown,
    expected?: DevelopmentLease,
    onPreparing: () => void = () => {},
  ) {
    clusterProjectActionSchema.parse(raw);
    const record = clusterProjectRecordSchema.parse({
        ...this.record(id),
        slurmReviewPolicy:
          this.store.getSetting('slurm-review:policy') ?? this.record(id).slurmReviewPolicy,
      }),
      settings = this.settings();
    if (!settings?.enabled || settings.alias !== record.folder.alias)
      throw new Error('Restore the saved cluster connection before reopening this project.');
    if (record.folder.gitMarker === false && !record.trackingConsent)
      return clusterProjectOpenedSchema.parse({ project: this.summary(id), destination: null });
    const result = expected
      ? await this.runtimes.continueOpen(record, settings, expected, onPreparing)
      : await this.runtimes.open(record, settings, onPreparing);
    if (this.stopped)
      throw new Conflict('The controller stopped; saved preparation state remains available.');
    if (result.handshake) {
      this.save({
        ...record,
        remoteProjectId: result.handshake.projectId,
        remoteManagerId: result.handshake.managerId,
        remoteWorkspaceId: result.handshake.hostId,
      });
      this.store.event('cluster.project.opened', null, null, {
        id,
        jobId: result.lease.jobId,
        projectId: result.handshake.projectId,
        managerId: result.handshake.managerId,
      });
    }
    return clusterProjectOpenedSchema.parse({
      project: this.summary(id),
      destination: result.handshake
        ? {
            hostId: record.hostId,
            projectId: result.handshake.projectId,
            managerId: result.handshake.managerId,
          }
        : null,
    });
  }
}
