import { z } from 'zod';
import { groupContextSchema, type GroupContext, type GroupScope } from '@dock/shared';
import type { GroupEventRepository } from './group-events.js';
import { digest, GroupGitBlocked } from './group-git.js';
import {
  GroupGitService,
  type GitGrant,
  type GitHostRegistration,
  type GitReviewReceipt,
  type GroupGitAccess,
  type GroupGitConnector,
} from './group-git-service.js';
import {
  gitNativeExportRequestSchema,
  type GitNativeExportRequest,
  type GitNativeExports,
} from './group-git-native-export.js';

/** Exact protected methods of the normal GroupHost; not a browser DTO or a
 * replacement membership validator. Pass host methods bound to that host. */
export interface GroupGitAuthenticatedContext {
  readonly handle: string;
  readonly enrollmentHandle: string;
  readonly context: Readonly<GroupContext>;
  readonly enrollment: {
    readonly groupId: string;
    readonly memberId: string;
    readonly installationId: string;
    readonly state: 'pending' | 'active' | 'revoked';
  };
  revalidate(): Promise<void>;
}
export interface GroupGitHostCallbacks {
  readonly events: GroupEventRepository;
  readonly native: object;
  readonly nativeJournal: {
    get(
      handle: string,
      key: string,
    ): {
      handle: string;
      request: { key: string; requestId: string; enrollmentHandle: string; context: GroupContext };
      receipt: { state: string };
      result: { context: GroupContext } | null;
    } | null;
  };
  authenticatedContext(input: { handle: string }): Promise<GroupGitAuthenticatedContext>;
  nativeFeatureContext(context: GroupContext): Promise<GroupGitAuthenticatedContext>;
}
export interface GroupGitNativeConnector {
  /** The retained concrete createGroupNativeConnector result, before narrowing
   * it to GroupHost's normal messaging interface. Native owns execution/export. */
  gitExports(authorize: GroupGitExportAuthority): GitNativeExports;
}
export type GroupGitExportAuthority = (request: GitNativeExportRequest) => Promise<{
  contextId: string;
  guestRepository: string;
  revalidate(): Promise<void>;
}>;

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const guestRepository = z
  .string()
  .max(4096)
  .refine(
    (path) =>
      path === '/workspace' ||
      (path.startsWith('/workspace/') &&
        path
          .slice(11)
          .split('/')
          .every(
            (part) =>
              part.length > 0 && part !== '.' && part !== '..' && !/[\\\x00-\x1f\x7f]/.test(part),
          )),
    'Canonical repository in the owning guest /workspace required',
  );
const bindingSchema = z.strictObject({
  handle: z.uuid(),
  enrollmentHandle: z.uuid(),
  repositoryId: id,
  resourceId: id,
  registrationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  ownerContext: groupContextSchema,
  nativeRequestKey: z.uuid(),
  nativeRequestId: z.uuid(),
  nativeContext: groupContextSchema,
  guestRepository,
});
type SavedBinding = z.infer<typeof bindingSchema>;
interface SavedReview {
  bindingDigest: string;
  grantDigest: string;
  receipt: GitReviewReceipt;
}
const connected = new WeakSet<object>();
const scopeFor = (context: Readonly<GroupContext>): GroupScope => ({
  groupId: context.groupId,
  memberId: context.memberId,
  installationId: context.installationId,
  visibility: context.visibility,
  source: {
    sessionId: context.sessionId,
    provider: context.provider,
    nativeSessionId: context.nativeSessionId,
    messageId: 'group-git-host',
  },
  causalRefs: [],
});
const deny = (message: string): never => {
  throw new GroupGitBlocked(message);
};

/** Normal consumer, composed with the SAME concrete connector used by GroupHost.
 * registerResource/setPolicy/approveReview are installation/owner authority hooks:
 * never mount them as arbitrary browser inputs. GitService registration already
 * pins the host resource/endpoint; this module never resolves host filesystem paths.
 * registerResource maps that saved registration to one retained native request and
 * a root-selected guest repository. Native independently proves ownership/admission
 * and enforces complete-history privacy before any object bytes cross its boundary.
 */
export async function createGroupGitHostBinding(input: {
  host: GroupGitHostCallbacks;
  connector: GroupGitNativeConnector;
  service: Omit<Parameters<typeof GroupGitService.open>[0], 'events' | 'nativeExports'>;
}) {
  const { host, connector } = input;
  if (host.native !== connector) deny('Use the same concrete native connector as GroupHost');
  if (connected.has(connector)) deny('Normal Git consumer already owns this native connector');
  connected.add(connector);
  let service: GroupGitService | undefined;
  const currentService = () => service ?? deny('Normal Git binding is not initialized');
  const registration = (repositoryId: string) =>
    currentService().journal.get<GitHostRegistration>(`registration:${id.parse(repositoryId)}`) ??
    deny('Saved Git repository registration unavailable');

  async function owner(handle: string) {
    z.uuid().parse(handle);
    const value = await host.authenticatedContext({ handle });
    const context = groupContextSchema.parse(value.context);
    if (
      value.handle !== handle ||
      context.visibility !== 'shared' ||
      context.provider !== 'owner' ||
      value.enrollment.state !== 'active' ||
      value.enrollment.groupId !== context.groupId ||
      value.enrollment.memberId !== context.memberId ||
      value.enrollment.installationId !== context.installationId
    )
      deny('Exact saved active shared owner context required');
    await value.revalidate();
    return value;
  }
  async function retained(handle: string, key: string, value: GroupGitAuthenticatedContext) {
    z.uuid().parse(key);
    const record = host.nativeJournal.get(handle, key);
    if (
      !record ||
      record.handle !== handle ||
      record.request.key !== key ||
      record.request.enrollmentHandle !== value.enrollmentHandle ||
      digest(record.request.context) !== digest(value.context) ||
      record.receipt.state !== 'completed' ||
      !record.result
    )
      deny('Exact completed retained native request required');
    const context = groupContextSchema.parse(record!.result!.context);
    if (
      context.visibility !== 'shared' ||
      context.provider === 'owner' ||
      context.groupId !== value.context.groupId ||
      context.memberId !== value.context.memberId ||
      context.installationId !== value.context.installationId
    )
      deny('Retained native context belongs to another scope');
    const native = await host.nativeFeatureContext(context);
    if (
      native.handle !== handle ||
      native.enrollmentHandle !== value.enrollmentHandle ||
      digest(native.context) !== digest(context) ||
      digest(native.enrollment) !== digest(value.enrollment)
    )
      deny('Native feature context does not resolve to the saved shared handle');
    await native.revalidate();
    return { requestId: z.uuid().parse(record!.request.requestId), context, native };
  }
  async function resolveSaved(handle: string, repositoryId: string) {
    const saved = bindingSchema.parse(
      currentService().journal.get(`git-host-binding:${id.parse(repositoryId)}`),
    );
    if (saved.handle !== handle) deny('Repository is not granted to this saved shared handle');
    const value = await owner(handle),
      config = registration(repositoryId);
    if (
      digest(value.context) !== digest(saved.ownerContext) ||
      value.enrollmentHandle !== saved.enrollmentHandle ||
      config.resourceId !== saved.resourceId ||
      digest(config) !== saved.registrationDigest
    )
      deny('Saved Git resource or owner binding changed');
    const native = await retained(handle, saved.nativeRequestKey, value);
    if (
      native.requestId !== saved.nativeRequestId ||
      digest(native.context) !== digest(saved.nativeContext)
    )
      deny('Retained native request/context binding changed');
    const access = currentService().authority.issue(scopeFor(value.context));
    const grant = currentService().authority.resolve(access, config);
    return { saved, value, native, config, access, grant };
  }
  function reviewed(
    bound: Awaited<ReturnType<typeof resolveSaved>>,
    reviewId: string,
    historyGrantId: string,
  ) {
    const receipt = currentService().authority.proposal(
      bound.access,
      bound.config,
      reviewId,
      historyGrantId,
    );
    const saved = currentService().journal.get<SavedReview>(
      `git-host-review:${id.parse(reviewId)}`,
    );
    if (
      !saved ||
      saved.bindingDigest !== digest(bound.saved) ||
      saved.grantDigest !== digest(bound.grant) ||
      digest(saved.receipt) !== digest(receipt)
    )
      deny('Exact saved resource policy, review and complete-history authorization required');
    return receipt;
  }
  async function checkExport(raw: GitNativeExportRequest) {
    const request = gitNativeExportRequestSchema.parse(raw);
    const saved = bindingSchema.parse(
      currentService().journal.get(`git-host-binding:${request.repositoryId}`),
    );
    const bound = await resolveSaved(saved.handle, request.repositoryId);
    const review =
      currentService().journal.get<SavedReview>(`git-host-review:${request.reviewId}`) ??
      deny('Saved review unavailable');
    const receipt = reviewed(bound, request.reviewId, review.receipt.historyGrantId);
    const expected = {
      ...request,
      resourceId: bound.config.resourceId,
      scope: scopeFor(bound.value.context),
      grantRevision: bound.grant.revision,
      sourceOid: receipt.sourceOid,
      historyRevision: receipt.historyRevision,
      contentPaths: Object.keys(bound.grant.paths)
        .filter((p) => bound.grant.paths[p] === 'content')
        .sort(),
      maxObjects: bound.config.limits.maxFiles,
      maxBytes: bound.config.limits.maxTransferBytes,
      maxFileBytes: bound.config.limits.maxFileBytes,
    };
    if (
      digest(request) !== digest(expected) ||
      digest(currentService().journal.get(`native-export:${request.operationId}`)) !==
        digest(request)
    )
      deny('Native export differs from the exact durable Git effect intent');
    return bound.saved;
  }
  const authorizeNativeExport: GroupGitExportAuthority = async (raw) => {
    const request = gitNativeExportRequestSchema.parse(raw);
    const saved = await checkExport(request);
    return {
      contextId: saved.nativeContext.sessionId,
      guestRepository: saved.guestRepository,
      revalidate: async () => {
        await checkExport(request);
      },
    };
  };
  // Bind once. No native submit/inspect, provider turn, account copy, or second connector.
  const nativeExports = connector.gitExports(authorizeNativeExport);
  service = await GroupGitService.open({ ...input.service, events: host.events, nativeExports });
  const concreteService = service;

  return {
    service: concreteService,
    authorizeNativeExport,
    /** Existing protected GitService.register result, not an arbitrary host path. */
    async registerResource(raw: {
      handle: string;
      repositoryId: string;
      nativeRequestKey: string;
      guestRepository: string;
      grant: GitGrant;
    }): Promise<void> {
      const value = await owner(raw.handle),
        config = registration(raw.repositoryId);
      const native = await retained(raw.handle, raw.nativeRequestKey, value);
      const saved: SavedBinding = bindingSchema.parse({
        handle: raw.handle,
        enrollmentHandle: value.enrollmentHandle,
        repositoryId: config.repositoryId,
        resourceId: config.resourceId,
        registrationDigest: digest(config),
        ownerContext: value.context,
        nativeRequestKey: raw.nativeRequestKey,
        nativeRequestId: native.requestId,
        nativeContext: native.context,
        guestRepository: raw.guestRepository,
      });
      if (
        raw.grant.id !== config.grantId ||
        raw.grant.repositoryId !== config.repositoryId ||
        raw.grant.resourceId !== config.resourceId ||
        raw.grant.endpointId !== config.endpointId ||
        raw.grant.executorId !== config.executorId ||
        raw.grant.groupId !== value.context.groupId ||
        raw.grant.memberId !== value.context.memberId ||
        raw.grant.installationId !== value.context.installationId
      )
        deny('Saved policy does not grant this exact GroupHost resource');
      const key = `git-host-binding:${config.repositoryId}`,
        prior = concreteService.journal.get(key);
      if (prior && digest(prior) !== digest(saved))
        deny('Saved native Git resource binding is immutable');
      concreteService.authority.grant(raw.grant);
      concreteService.authority.resolve(
        concreteService.authority.issue(scopeFor(value.context)),
        config,
      );
      concreteService.journal.transaction(() => {
        concreteService.journal.put(key, saved, prior);
      });
    },
    /** Protected policy revision/revocation hook; authority owns its immutable revisions. */
    async setPolicy(
      handle: string,
      repositoryId: string,
      grant: GitGrant,
      expectedRevision?: string,
    ): Promise<boolean> {
      // Resolve identity without requiring the old grant to remain active, allowing recovery
      // after revocation. registerResource checks the full tuple and immutable native mapping.
      const saved = bindingSchema.parse(
        concreteService.journal.get(`git-host-binding:${id.parse(repositoryId)}`),
      );
      if (saved.handle !== handle) deny('Saved resource policy belongs to another shared handle');
      const value = await owner(handle);
      if (
        digest(value.context) !== digest(saved.ownerContext) ||
        value.enrollmentHandle !== saved.enrollmentHandle
      )
        deny('Saved owner context changed');
      const config = registration(repositoryId);
      if (
        digest(config) !== saved.registrationDigest ||
        grant.id !== config.grantId ||
        grant.repositoryId !== repositoryId ||
        grant.resourceId !== config.resourceId ||
        grant.endpointId !== config.endpointId ||
        grant.executorId !== config.executorId ||
        grant.groupId !== value.context.groupId ||
        grant.memberId !== value.context.memberId ||
        grant.installationId !== value.context.installationId
      )
        deny('Saved policy does not grant this exact GroupHost resource');
      const native = await retained(handle, saved.nativeRequestKey, value);
      if (
        native.requestId !== saved.nativeRequestId ||
        digest(native.context) !== digest(saved.nativeContext)
      )
        deny('Retained native request/context binding changed');
      return concreteService.authority.grant(grant, expectedRevision);
    },
    /** Protected reviewed immutable commit + entire-history approval, never inferred from HEAD. */
    async approveReview(
      handle: string,
      repositoryId: string,
      receipt: GitReviewReceipt,
    ): Promise<void> {
      const bound = await resolveSaved(handle, repositoryId);
      if (
        !receipt.approved ||
        receipt.repositoryId !== repositoryId ||
        receipt.grantRevision !== bound.grant.revision ||
        receipt.sourceOid !== receipt.historySourceOid ||
        receipt.historyTargetOid !== null
      )
        deny('Exact reviewed entire-history receipt required');
      const saved: SavedReview = {
        bindingDigest: digest(bound.saved),
        grantDigest: digest(bound.grant),
        receipt,
      };
      const key = `git-host-review:${id.parse(receipt.id)}`,
        prior = concreteService.journal.get(key);
      if (prior && digest(prior) !== digest(saved)) deny('Saved Git host review is immutable');
      concreteService.authority.review(receipt);
      concreteService.journal.transaction(() => concreteService.journal.put(key, saved, prior));
    },
    /** Normal routes select only saved handles/IDs. Each call resolves actual membership,
     * immutable source and current policy again; no authority/access object reaches the client. */
    async select(handle: string, repositoryId: string) {
      const first = await resolveSaved(handle, repositoryId);
      async function call<T>(fn: (access: GroupGitAccess) => Promise<T>): Promise<T> {
        const bound = await resolveSaved(handle, repositoryId);
        const result = await fn(bound.access);
        await resolveSaved(handle, repositoryId);
        return result;
      }
      return {
        repositoryId,
        selectedBranch: first.config.mainRef,
        status: () => call((a) => concreteService.status(a, repositoryId)),
        tick: (now?: number) => call((a) => concreteService.tick(a, repositoryId, now)),
        materialize: (value: Parameters<GroupGitConnector['materialize']>[2]) =>
          call((a) => concreteService.materialize(a, repositoryId, value)),
        snapshot: () => call((a) => concreteService.snapshot(a, repositoryId)),
        /** Protected native pre-turn hook; normal HTTP catalog does not expose it. */
        writerStarted: () => call((a) => concreteService.writerStarted(a, repositoryId)),
        intent: (value: Parameters<GroupGitConnector['intent']>[2]) =>
          call((a) => concreteService.intent(a, repositoryId, value)),
        warnings: (repositories: readonly string[]) =>
          call(async (a) => {
            for (const other of repositories) await resolveSaved(handle, other);
            return concreteService.warnings(a, repositoryId, repositories);
          }),
        propose: (value: Parameters<GroupGitConnector['propose']>[2]) =>
          call(async (a) => {
            reviewed(
              await resolveSaved(handle, repositoryId),
              value.reviewId,
              value.historyGrantId,
            );
            return concreteService.propose(a, repositoryId, value);
          }),
        outbox: () => call((a) => concreteService.outbox(a, repositoryId)),
        acknowledge: (eventId: string) =>
          call((a) => concreteService.acknowledge(a, repositoryId, eventId)),
        reconcile: () => call((a) => concreteService.reconcile(a, repositoryId)),
      };
    },
  };
}

export type GroupGitHostBinding = Awaited<ReturnType<typeof createGroupGitHostBinding>>;
export type GroupGitSavedRepository = Awaited<ReturnType<GroupGitHostBinding['select']>>;
