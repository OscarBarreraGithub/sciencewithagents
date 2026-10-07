import {
  DOCUMENT_TRANSPORT_LIMITS,
  documentTransportCommandSchema,
  documentTransportResultSchema,
  type DocumentTransportCommand,
} from '@dock/shared/dist/group-document-transport.js';
import { groupFeatureDocuments } from './group-feature-documents.js';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { z } from 'zod';
import {
  groupBetaProfileSchema,
  parseGroupBetaSetupCode,
  verifyGroupBetaAdmission,
} from '@dock/shared/dist/group-beta-admission.js';
import {
  GROUP_LIMITS,
  agentSchema,
  groupContextSchema,
  groupMemberSchema,
  groupFeedPageSchema,
  groupEventSchema,
  groupSourceSchema,
  groupOperationIdSchema,
  groupEntityIdSchema,
  type GroupFeedQuery,
  type GroupContext,
  type GroupEvent,
} from '@dock/shared';
import * as host from '@dock/shared/dist/group-host.js';
import {
  MEMBERSHIP_LIMITS,
  membershipReplySchema,
  membershipCommandSchema,
  membershipIdentitySchema,
  type MembershipCommand,
  type MembershipIdentity,
} from '@dock/shared/dist/group-membership.js';
import {
  deliveryCommandSchema,
  publicationEnvelopeSchema,
  type DeliveryReply,
} from '@dock/shared/dist/group-delivery.js';
import { GroupEventRepository } from './group-events.js';
import { GroupPublicationController, type PublicationAccess } from './group-publication.js';
import { HostedPublicationTransport } from './group-publication-host-transport.js';
import { publicationBindingSchema, publicationCanonical } from './group-publication-protocol.js';
import {
  privateGroupDirectory,
  privateGroupFile,
  protectGroupSidecars,
  readGroupServiceConfiguration,
  betaGroupServiceConfiguration,
  groupHostedInvitationServiceSchema,
  type ActiveGroupServiceConfiguration,
  type GroupServiceConfiguration,
} from './group-host-storage.js';
import { publicGroupBetaProfile } from './group-beta-profile.js';
import {
  unavailableGroupNative,
  groupNativeSnapshotSchema,
  type GroupNativeRequest,
  type GroupNativeConnector,
  type GroupNativeConnectorFactory,
} from './group-host-native.js';
import { GroupHostNativeJournal, type GroupHostNativeRecord } from './group-host-native-journal.js';
import type { GroupHostFeatureContext } from './group-host-context.js';
import {
  groupActionCommandSchema,
  groupActionResultSchema,
  type GroupActionCommand,
  groupOwnedTaskReceiptSchema,
  type GroupOwnedTaskReceipt,
} from '@dock/shared/dist/group-actions.js';
import { groupNativeOwnerInputSchema } from '@dock/shared/dist/group-native-owner.js';
import { Conflict, Missing } from './store.js';
import { GroupFeaturePromotion } from './group-feature-promotion.js';
import {
  GROUP_PROMOTION_HOST_LIMITS,
  groupPromotionHostCommandSchema,
  groupPromotionHostResultSchema,
  type GroupPromotionHostCommand,
} from '@dock/shared/dist/group-promotion-host.js';
import type { GroupScope } from '@dock/shared';

const slotSchema = z.strictObject({
  handle: z.uuid(),
  context: groupContextSchema,
  createdAt: z.string(),
});
const recordSchema = z.strictObject({
  handle: z.uuid(),
  name: z.string().min(1).max(120),
  credential: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.string().regex(/^[a-f0-9]{64}$/),
  identity: membershipIdentitySchema,
  binding: publicationBindingSchema.nullable(),
  shared: slotSchema.nullable(),
  private: slotSchema.nullable(),
  creator: z.boolean(),
  invitationSecret: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  serviceHash: z.string().regex(/^[a-f0-9]{64}$/),
  beta: z
    .strictObject({
      admission: z.string().min(1).max(1024),
      creation: z
        .strictObject({
          capability: z.string().regex(/^[a-f0-9]{64}$/),
          operationId: z.uuid(),
        })
        .optional(),
    })
    .optional(),
});
type Record = z.infer<typeof recordSchema>;
type Slot = z.infer<typeof slotSchema>;
const serviceHash = (value: ActiveGroupServiceConfiguration) =>
  createHash('sha256')
    .update(
      publicationCanonical({
        mode: value.mode,
        endpoint: value.endpoint,
        endpointId: value.endpointId,
        ...(value.mode === 'hosted'
          ? {
              hostingOrigin: value.hostingAuthorization.origin,
              freeApprovalId: value.hostingAuthorization.freeApprovalId,
            }
          : {}),
        ...(value.mode === 'beta' ? { serviceId: value.profile.serviceId } : {}),
      }),
    )
    .digest('hex');
const capability = () => randomBytes(32).toString('hex');
export class GroupHostError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const unavailable = () =>
  new GroupHostError(
    503,
    'GROUP_SERVICE_UNAVAILABLE',
    'Groups delivery is unavailable. Reconnect the configured service and retry the same request; its identity is retained.',
  );
// Split only at Unicode code-point boundaries and preserve the exact original.
function nativeOriginal(
  text: string,
): { kind: 'inline'; text: string } | { kind: 'chunked'; chunks: string[] } {
  if (Buffer.byteLength(text, 'utf8') <= GROUP_LIMITS.chunkBytes) return { kind: 'inline', text };
  const chunks: string[] = [];
  let part = '',
    bytes = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > GROUP_LIMITS.chunkBytes) {
      chunks.push(part);
      part = '';
      bytes = 0;
    }
    part += point;
    bytes += size;
  }
  if (part) chunks.push(part);
  if (chunks.length > GROUP_LIMITS.chunks)
    throw new GroupHostError(
      503,
      'GROUP_NATIVE_ORIGINAL_CAPACITY',
      'The exact native result is retained, but its Unicode chunk manifest exceeds shared delivery capacity. Ask for a shorter new result; this original will not be rewritten.',
    );
  return { kind: 'chunked', chunks };
}
/** Normal-app host. No Runtime/store-event subscription and no native history projection. */
export class GroupHost {
  readonly directory: string;
  readonly db: DatabaseSync;
  readonly events: GroupEventRepository;
  readonly native: GroupNativeConnector;
  readonly nativeJournal: GroupHostNativeJournal;
  readonly promotion: GroupFeaturePromotion;
  private controllers = new Map<
    string,
    {
      controller: GroupPublicationController;
      access: PublicationAccess;
      transport: HostedPublicationTransport;
    }
  >();
  private locks = new Map<string, Promise<unknown>>();
  private nativeReadOffsets = new Map<string, number>();
  constructor(
    root: string,
    options: {
      native?: GroupNativeConnector;
      nativeFactory?: GroupNativeConnectorFactory;
      http?: typeof fetch;
      /** Internal test seam; a browser/setup code cannot select a profile. */
      betaProfile?: z.infer<typeof groupBetaProfileSchema> | null;
    } = {},
  ) {
    this.directory = privateGroupDirectory(root);
    this.http = options.http ?? fetch;
    const profile =
      options.betaProfile === undefined ? publicGroupBetaProfile : options.betaProfile;
    this.betaConfiguration = profile ? betaGroupServiceConfiguration(profile) : null;
    this.explicitBetaDefault = options.betaProfile !== undefined && options.betaProfile !== null;
    const path = join(this.directory, 'host.sqlite');
    privateGroupFile(path);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS gh_groups(handle TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gh_operations(key TEXT PRIMARY KEY,input TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gh_sends(handle TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(handle,key));
      CREATE TABLE IF NOT EXISTS gh_drafts(handle TEXT PRIMARY KEY,text TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gh_draft_receipts(handle TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(handle,key));
      CREATE TABLE IF NOT EXISTS gh_pending(handle TEXT NOT NULL,request_id TEXT NOT NULL,identity TEXT NOT NULL,PRIMARY KEY(handle,request_id));`);
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS gh_coordination_receipts(key TEXT PRIMARY KEY,context_session_id TEXT NOT NULL,event_id TEXT NOT NULL,delivery_operation TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS gh_coordination_receipts_no_update BEFORE UPDATE ON gh_coordination_receipts BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER IF NOT EXISTS gh_coordination_receipts_no_delete BEFORE DELETE ON gh_coordination_receipts BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    protectGroupSidecars(path);
    const ep = join(this.directory, 'events.sqlite');
    privateGroupFile(ep);
    this.events = new GroupEventRepository(ep);
    protectGroupSidecars(ep);
    this.nativeJournal = new GroupHostNativeJournal(this.db);
    this.native =
      options.native ??
      options.nativeFactory?.({ directory: this.directory, events: this.events }) ??
      unavailableGroupNative;
    this.promotion = new GroupFeaturePromotion(this);
  }
  private readonly http: typeof fetch;
  private readonly betaConfiguration: ReturnType<typeof betaGroupServiceConfiguration> | null;
  private readonly explicitBetaDefault: boolean;
  async close() {
    await this.promotion.close();
    await this.native.close?.();
    for (const { controller } of this.controllers.values()) controller.close();
    this.controllers.clear();
    this.events.close();
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  configuration(): GroupServiceConfiguration | null {
    const saved = readGroupServiceConfiguration(this.directory);
    if (saved) return saved;
    // Retain already enrolled/pending beta work, without enrolling fresh installs
    // in the maintainer's account merely by opening Groups.
    const retainedBeta = this.db
      .prepare(
        `SELECT 1 FROM gh_groups WHERE json_extract(body,'$.beta') IS NOT NULL
        UNION ALL SELECT 1 FROM gh_operations WHERE json_extract(body,'$.beta') IS NOT NULL LIMIT 1`,
      )
      .get();
    return this.explicitBetaDefault || retainedBeta ? this.betaConfiguration : null;
  }
  private configured() {
    const value = this.configuration();
    if (!value || value.mode === 'disabled')
      throw new GroupHostError(
        503,
        'GROUP_SETUP_REQUIRED',
        'Copy the Cloudflare setup prompt in Groups into your setup agent. The group creator hosts delivery in their own Cloudflare account; joining members use the creator’s invitation and service.',
      );
    return value;
  }
  private records() {
    return this.db
      .prepare('SELECT body FROM gh_groups ORDER BY rowid')
      .all()
      .map((r) => recordSchema.parse(JSON.parse(String(r.body))));
  }
  private record(handle: string) {
    const raw = this.db.prepare('SELECT body FROM gh_groups WHERE handle=?').get(handle);
    if (!raw) throw new Missing('Group unavailable. Return to Groups and reopen it.');
    return recordSchema.parse(JSON.parse(String(raw.body)));
  }
  private save(value: Record) {
    this.db
      .prepare(
        'INSERT INTO gh_groups VALUES (?,?) ON CONFLICT(handle) DO UPDATE SET body=excluded.body',
      )
      .run(value.handle, JSON.stringify(recordSchema.parse(value)));
  }
  private async bounded(response: Response, limit: number) {
    if (
      !response.body ||
      response.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      throw unavailable();
    const reader = response.body.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel();
          throw unavailable();
        }
        chunks.push(value);
      }
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      ) as unknown;
    } finally {
      reader.releaseLock();
    }
  }
  private serviceHeaders(
    value: Record,
    create = false,
    config = this.configured(),
  ): { [name: string]: string } {
    if (serviceHash(config) !== value.serviceHash || (config.mode === 'beta') !== !!value.beta)
      throw new GroupHostError(
        503,
        'GROUP_SERVICE_CHANGED',
        'Restore the original Groups service mapping before retrying this saved request.',
      );
    if (config.mode === 'beta') {
      if (!value.beta || (create && !value.beta.creation))
        throw new GroupHostError(
          403,
          'GROUP_BETA_SETUP_REQUIRED',
          'Use a beta setup code to create a group, or join with a complete invitation.',
        );
      return {
        'X-Group-Admission': value.beta.admission,
        ...(create ? { 'X-Group-Setup': value.beta.creation!.capability } : {}),
      };
    }
    if (create && !config.setupCapability)
      throw new GroupHostError(
        403,
        'GROUP_CREATOR_SETUP_REQUIRED',
        'This computer is configured to join the creator’s service. To create your own groups, give your setup agent the Cloudflare creator prompt.',
      );
    return {
      ...(create ? { 'X-Group-Setup': config.setupCapability! } : {}),
      ...(config.mode === 'hosted'
        ? { 'X-Hosting-Approval': config.hostingAuthorization.approvalCapability }
        : {}),
    };
  }
  private async membership(value: Record, command: MembershipCommand, groupId?: string) {
    const config = this.configured();
    const create = command.kind === 'initialize';
    try {
      const response = await this.http(
        `${config.endpoint.replace(/\/$/, '')}${create ? '/v1/create' : `/v1/groups/${groupId}`}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${value.credential}`,
            ...this.serviceHeaders(value, create, config),
          },
          body: JSON.stringify(membershipCommandSchema.parse(command)),
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: AbortSignal.timeout(5000),
        },
      );
      const parsed = z
        .discriminatedUnion('ok', [
          z.strictObject({ ok: z.literal(true), value: membershipReplySchema }),
          z.strictObject({
            ok: z.literal(false),
            error: z.enum([
              'denied',
              'invalid',
              'conflict',
              'limit',
              'unavailable',
              'hosting_disabled',
              'creation_expired',
            ]),
          }),
        ])
        .parse(await this.bounded(response, 64000));
      if (!parsed.ok) {
        if (parsed.error === 'creation_expired')
          throw new GroupHostError(
            410,
            'GROUP_BETA_CREATION_EXPIRED',
            'This beta code expired before its group was created. The original setup request is retained. Ask the beta operator for a new code; established groups continue to work.',
          );
        if (parsed.error === 'denied')
          throw new GroupHostError(
            403,
            'GROUP_ACCESS_DENIED',
            'The invitation or saved group access is unavailable. Ask the creator for a current invitation.',
          );
        if (parsed.error === 'conflict' && create && value.beta)
          throw new GroupHostError(
            409,
            'GROUP_BETA_CODE_USED',
            'This beta setup code has already been used. The original setup request is retained. Ask the beta operator for a new code, or join the existing group by invitation.',
          );
        if (parsed.error === 'conflict')
          throw new Conflict(
            'Groups request conflicts with its retained identity. Retry the original request.',
          );
        throw unavailable();
      }
      return parsed.value;
    } catch (error) {
      if (error instanceof GroupHostError || error instanceof Conflict) throw error;
      throw unavailable();
    }
  }
  private async initialize(value: Record, operationId: string) {
    if (value.beta) {
      if (!value.beta.creation) throw unavailable();
      // The service checks its exact initialization receipt before code expiry.
      // Retry the retained request even after expiry; never race it with a read
      // or generate another operation/credential after an ambiguous response.
      operationId = value.beta.creation.operationId;
    }
    return this.membership(value, {
      kind: 'initialize',
      operationId: groupOperationIdSchema.parse(operationId),
      groupName: host.groupHostCreateSchema.shape.projectName.parse(value.name),
      displayName: value.identity.displayName,
    });
  }
  private provision(value: Record, identity: MembershipIdentity) {
    const config = this.configured();
    this.serviceHeaders(value, false, config);
    if (
      identity.groupId !== value.identity.groupId ||
      value.identity.memberId !== identity.memberId ||
      value.identity.installationId !== identity.installationId
    )
      throw new Conflict('Hosted enrollment identity changed.');
    // Status replies can arrive concurrently after joining. Adopt the durable
    // context tuple already issued by the first reply rather than replacing it.
    const saved = this.db.prepare('SELECT body FROM gh_groups WHERE handle=?').get(value.handle);
    if (saved) {
      const retained = recordSchema.parse(JSON.parse(String(saved.body)));
      if (
        retained.identity.groupId !== identity.groupId ||
        retained.identity.memberId !== identity.memberId ||
        retained.identity.installationId !== identity.installationId
      )
        throw new Conflict('Retained enrollment identity changed.');
      value.shared = retained.shared;
      value.private = retained.private;
      value.binding = retained.binding;
      if (retained.identity.state === 'revoked' && identity.state !== 'revoked')
        throw new GroupHostError(403, 'GROUP_REVOKED', 'Revoked enrollment cannot be reactivated.');
    }
    if (identity.state === 'revoked') {
      if (value.shared)
        this.events.revokeMember(value.shared.context.groupId, value.shared.context.memberId);
      value.identity = identity;
      this.save(value);
      throw new GroupHostError(
        403,
        'GROUP_REVOKED',
        'Group enrollment revoked. Shared delivery and private access are refused.',
      );
    }
    value.identity = identity;
    if (identity.state === 'active' && !value.shared) {
      const member = this.events.trustedHostEnroll(identity);
      const slot = (visibility: 'shared' | 'private'): Slot => ({
        handle: randomUUID(),
        createdAt: new Date().toISOString(),
        context: this.events.createContext({
          groupId: member.groupId,
          memberId: member.memberId,
          installationId: member.installationId,
          visibility,
          provider: 'owner',
          nativeSessionId: randomUUID(),
        }),
      });
      value.shared = slot('shared');
      value.private = slot('private');
      value.binding = publicationBindingSchema.parse({
        groupId: identity.groupId,
        installationId: identity.installationId,
        epoch: randomUUID(),
        remoteGroupId: identity.groupId,
        endpointId: config.endpointId,
        credentialRevision: 1,
      });
    }
    this.save(value);
    return value;
  }
  private async active(handle: string) {
    let value = this.record(handle);
    if (serviceHash(this.configured()) !== value.serviceHash)
      throw new GroupHostError(
        503,
        'GROUP_SERVICE_CHANGED',
        'The service mapping changed. Restore the original protected mapping to reconcile retained send identities; ask your setup agent before migrating enrollment.',
      );
    let status;
    try {
      status = await this.membership(value, { kind: 'status' }, value.identity.groupId);
    } catch (error) {
      if (error instanceof GroupHostError && error.status === 403)
        throw new GroupHostError(
          403,
          'GROUP_REVOKED',
          'This enrollment is revoked or no longer authenticated. Group views and effects are refused; ask the creator or setup agent to check the saved enrollment.',
        );
      throw error;
    }

    if (status.kind !== 'identity') throw unavailable();
    value = this.provision(value, status.identity);
    if (value.identity.state !== 'active' || !value.shared || !value.private || !value.binding)
      throw new GroupHostError(
        403,
        'GROUP_PENDING',
        'The group service has not activated this enrollment. Retry or ask your setup agent to update the creator’s group service.',
      );
    return value;
  }
  private summary(value: Record): host.GroupHostSummary {
    return host.groupHostSummarySchema.parse({
      id: value.identity.groupId,
      handle: value.handle,
      name: value.name,
      members: 1,
      sync:
        value.identity.state === 'active'
          ? 'Authenticated shared delivery'
          : value.identity.state === 'pending'
            ? 'Waiting for group service activation'
            : 'Access revoked',
      state: value.identity.state,
    });
  }
  async list() {
    let configured = false,
      message =
        'Set up the creator’s own Cloudflare service with the copyable prompt below, or use the join prompt with their invitation.';
    let setupCodeRequired = false;
    try {
      const value = this.configuration();
      configured = !!value && value.mode !== 'disabled';
      if (configured)
        message =
          value!.mode === 'beta'
            ? 'Hosted Groups beta is available. Creating a project needs one beta setup code; joining needs only an invitation. Your provider sign-in stays on this computer.'
            : value!.mode === 'hosted'
              ? 'Your configured Cloudflare group service is ready for connection checks. Your setup agent must verify live sharing; provider sign-in stays on this computer.'
              : 'Configured owned loopback service. No deployed or two-installation completion is claimed.';
      setupCodeRequired = value?.mode === 'beta';
    } catch (error) {
      message = (error as Error).message;
    }
    return host.groupHostListSchema.parse({
      groups: this.records().map((v) => this.summary(v)),
      service: { configured, message, setupCodeRequired },
      native: await this.nativeAvailability(),
    });
  }
  private intent(key: string, input: unknown, make: () => unknown) {
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT input,body FROM gh_operations WHERE key=?').get(key);
      const exact = publicationCanonical(input);
      if (prior) {
        if (prior.input !== exact)
          throw new Conflict(
            'Request changed while its acknowledgement is pending. Retry the original entries.',
          );
        return JSON.parse(String(prior.body)) as unknown;
      }
      if (Number(this.db.prepare('SELECT count(*) n FROM gh_operations').get()!.n) >= 2048)
        throw new Conflict('Groups operation history is full. Existing receipts are retained.');
      const value = make();
      this.db
        .prepare('INSERT INTO gh_operations VALUES (?,?,?)')
        .run(key, exact, JSON.stringify(value));
      return value;
    });
  }
  async create(raw: unknown) {
    const input = host.groupHostCreateSchema.parse(raw);
    const config = this.configured();
    if (config.mode === 'hosted' && !config.setupCapability)
      throw new GroupHostError(
        403,
        'GROUP_CREATOR_SETUP_REQUIRED',
        'This computer is configured to join the creator’s service. Use an invitation, or give your setup agent the Cloudflare creator prompt to host your own groups.',
      );
    let beta: Record['beta'], groupId: string | undefined;
    if (config.mode === 'beta') {
      try {
        const code = parseGroupBetaSetupCode(input.setupCode ?? '');
        const payload = await verifyGroupBetaAdmission(code.admission, config.profile);
        if (
          payload.createCapabilityHash !==
          createHash('sha256').update(`dock-group-setup-v1:${code.createCapability}`).digest('hex')
        )
          throw new Error('capability mismatch');
        beta = {
          admission: code.admission,
          creation: { capability: code.createCapability, operationId: payload.createOperationId },
        };
        groupId = payload.groupId;
      } catch {
        throw new GroupHostError(
          400,
          'GROUP_BETA_SETUP_INVALID',
          'Paste the complete beta setup code issued for this Groups service. Ask the beta operator for a code if you do not have one.',
        );
      }
    } else if (input.setupCode) {
      throw new GroupHostError(
        409,
        'GROUP_SERVICE_CHANGED',
        'This computer already uses another protected Groups service. Ask your setup agent to reconcile it before using a beta setup code.',
      );
    }
    const safeInput = {
      key: input.key,
      projectName: input.projectName,
      displayName: input.displayName,
      ...(input.setupCode
        ? { setupCodeHash: createHash('sha256').update(input.setupCode).digest('hex') }
        : {}),
    };
    return this.lock(
      beta ? `beta-create:${beta.creation!.operationId}` : `create:${input.key}`,
      async () => {
        const make = () => {
          if (this.records().length >= 32) throw new Conflict('Groups limit reached.');
          return {
            handle: randomUUID(),
            name: input.projectName,
            credential: capability(),
            confirmation: capability(),
            identity: {
              groupId: groupId ?? randomUUID(),
              memberId: randomUUID(),
              installationId: randomUUID(),
              displayName: input.displayName,
              state: 'pending',
            },
            binding: null,
            shared: null,
            private: null,
            creator: true,
            invitationSecret: null,
            serviceHash: serviceHash(config),
            ...(beta ? { beta } : {}),
          };
        };
        // The operator fixes one creation identity. Re-entering its code after tab
        // storage loss must reuse the original local bearer and exact request.
        const fixed = beta
          ? this.intent(
              `beta-create:${beta.creation!.operationId}`,
              {
                projectName: safeInput.projectName,
                displayName: safeInput.displayName,
                setupCodeHash: safeInput.setupCodeHash,
              },
              make,
            )
          : undefined;
        const value = recordSchema.parse(
          this.intent(`create:${input.key}`, safeInput, () => fixed ?? make()),
        );
        if (serviceHash(this.configured()) !== value.serviceHash)
          throw new GroupHostError(
            503,
            'GROUP_SERVICE_CHANGED',
            'Restore the original Groups service mapping before retrying this request.',
          );
        const reply = await this.initialize(value, input.key);
        if (reply.kind !== 'identity' || reply.identity.state !== 'active') throw unavailable();
        const saved = this.db
          .prepare('SELECT body FROM gh_groups WHERE handle=?')
          .get(value.handle);
        const current = saved
          ? recordSchema.parse(JSON.parse(String(saved.body)))
          : { ...value, identity: reply.identity };
        this.provision(current, reply.identity);
        return this.open({ handle: value.handle });
      },
    );
  }
  async join(raw: unknown) {
    const input = host.groupHostJoinSchema.parse(raw);
    const config = this.configured();
    let invitation: {
      groupId: string;
      secret: string;
      name: string;
      serviceId?: string;
      admission?: string;
      service?: z.infer<typeof groupHostedInvitationServiceSchema>;
    };
    let beta: Record['beta'];
    try {
      const url = new URL(input.invitation);
      if (!['http:', 'https:'].includes(url.protocol) || url.search || url.username || url.password)
        throw new Error();
      const encoded = new URLSearchParams(url.hash.replace(/^#\/?groups\??/, ''));
      invitation = z
        .strictObject({
          groupId: z.uuid(),
          secret: z.string().regex(/^[a-f0-9]{64}$/),
          name: z.string().min(1).max(120),
          serviceId: z.uuid().optional(),
          admission: z.string().min(1).max(1024).optional(),
          service: groupHostedInvitationServiceSchema.optional(),
        })
        .parse(JSON.parse(encoded.get('invite') ?? ''));
      if (config.mode === 'beta') {
        if (invitation.serviceId !== config.profile.serviceId || !invitation.admission)
          throw new Error('service mismatch');
        const payload = await verifyGroupBetaAdmission(invitation.admission, config.profile);
        if (payload.groupId !== invitation.groupId) throw new Error('group mismatch');
        beta = { admission: invitation.admission };
      } else if (invitation.serviceId || invitation.admission) {
        throw new Error('protected service mismatch');
      }
    } catch {
      throw new GroupHostError(
        400,
        'INVALID_INVITATION',
        'Paste the complete invitation for the Groups service on this computer. Invitations cannot change a protected service or choose an endpoint.',
      );
    }
    if (
      invitation.service &&
      (config.mode !== 'hosted' ||
        serviceHash(invitation.service) !== serviceHash(config) ||
        invitation.service.hostingAuthorization.approvalCapability !==
          config.hostingAuthorization.approvalCapability)
    )
      throw new GroupHostError(
        400,
        'INVALID_INVITATION',
        'This invitation belongs to another Groups service. Your existing groups are unchanged. Ask your setup agent to check the invitation’s service and your saved Groups configuration before continuing.',
      );
    return this.lock(`join-group:${serviceHash(config)}:${invitation.groupId}`, async () => {
      const safeInput = {
        ...input,
        invitation: createHash('sha256').update(input.invitation).digest('hex'),
      };
      const value = recordSchema.parse(
        this.intent(`join:${input.key}`, safeInput, () => {
          const saved = this.records().find(
            (record) =>
              record.identity.groupId === invitation.groupId &&
              record.serviceHash === serviceHash(config),
          );
          if (saved) return saved;
          // Reopening the link after a lost response must retain the first
          // credential and operation, including before gh_groups was saved.
          const retained = this.db
            .prepare(
              `SELECT body FROM gh_operations WHERE key LIKE 'join:%'
              AND json_extract(body,'$.identity.groupId')=?
              AND json_extract(body,'$.serviceHash')=?
              AND json_extract(input,'$.invitation')=? ORDER BY rowid LIMIT 1`,
            )
            .get(invitation.groupId, serviceHash(config), safeInput.invitation);
          if (retained) return recordSchema.parse(JSON.parse(String(retained.body)));
          if (this.records().length >= 32) throw new Conflict('Groups limit reached.');
          return {
            handle: randomUUID(),
            name: invitation.name,
            credential: capability(),
            confirmation: capability(),
            identity: {
              groupId: invitation.groupId,
              memberId: randomUUID(),
              installationId: randomUUID(),
              displayName: input.displayName,
              state: 'pending',
            },
            binding: null,
            shared: null,
            private: null,
            creator: false,
            invitationSecret: invitation.secret,
            serviceHash: serviceHash(config),
            ...(beta ? { beta } : {}),
          };
        }),
      );
      const current = await this.completeJoin(value);
      return { group: this.summary(current), confirmation: value.confirmation };
    });
  }
  private async completeJoin(value: Record) {
    if (serviceHash(this.configured()) !== value.serviceHash)
      throw new GroupHostError(
        503,
        'GROUP_SERVICE_CHANGED',
        'Restore the original Groups service mapping before retrying this request.',
      );
    if (!this.db.prepare('SELECT 1 FROM gh_groups WHERE handle=?').get(value.handle)) {
      const original = this.db
        .prepare(
          `SELECT key,body FROM gh_operations WHERE key LIKE 'join:%'
          AND json_extract(body,'$.handle')=? ORDER BY rowid LIMIT 1`,
        )
        .get(value.handle);
      if (!original) throw unavailable();
      const retained = recordSchema.parse(JSON.parse(String(original.body)));
      const reply = await this.membership(
        retained,
        {
          kind: 'join',
          operationId: groupOperationIdSchema.parse(String(original.key).slice('join:'.length)),
          inviteSecret: retained.invitationSecret!,
          confirmation: retained.confirmation,
          displayName: retained.identity.displayName,
        },
        retained.identity.groupId,
      );
      if (reply.kind !== 'identity') throw unavailable();
      this.provision({ ...retained, identity: reply.identity }, reply.identity);
    }
    // Historical join receipts retain their original pending state. Current
    // authenticated status activates them without a confirmation exchange.
    return this.active(value.handle);
  }
  async resume(raw: unknown) {
    const input = z.strictObject({ key: z.uuid(), kind: z.enum(['create', 'join']) }).parse(raw);
    return this.lock(`${input.kind}:${input.key}`, async () => {
      const row = this.db
        .prepare('SELECT body FROM gh_operations WHERE key=?')
        .get(`${input.kind}:${input.key}`);
      if (!row)
        throw new Missing(
          'No retained setup with this request identity. Paste your invitation again or start setup.',
        );
      const value = recordSchema.parse(JSON.parse(String(row.body)));
      if (serviceHash(this.configured()) !== value.serviceHash)
        throw new GroupHostError(
          503,
          'GROUP_SERVICE_CHANGED',
          'Restore the original service mapping before resuming setup.',
        );
      if (input.kind === 'join') {
        const current = await this.completeJoin(value);
        return { group: this.summary(current), confirmation: value.confirmation };
      }
      const reply = await this.initialize(value, input.key);
      if (reply.kind !== 'identity') throw unavailable();
      const saved = this.db.prepare('SELECT body FROM gh_groups WHERE handle=?').get(value.handle);
      const current = saved
        ? recordSchema.parse(JSON.parse(String(saved.body)))
        : { ...value, identity: reply.identity };
      this.provision(current, reply.identity);
      return {
        group: this.summary(current),
        confirmation: null,
      };
    });
  }
  private agent(slot: Slot) {
    return agentSchema.parse({
      id: slot.handle,
      projectId: slot.context.groupId,
      parentId: null,
      taskId: null,
      name: slot.context.visibility === 'private' ? 'Private notes' : 'Group messages',
      role: 'manager',
      status: 'idle',
      provider: 'codex',
      model: null,
      effort: 'medium',
      permission: 'read-only',
      checkpoint: '',
      createdAt: slot.createdAt,
      updatedAt: slot.createdAt,
    });
  }
  private publicSlot(slot: Slot) {
    return { handle: slot.handle, context: slot.context, agent: this.agent(slot) };
  }
  async open(raw: unknown) {
    const { handle } = host.groupHostSelectSchema.parse(raw);
    const value = await this.active(handle);
    const roster = await this.membership(
      value,
      { kind: 'roster', after: 0, limit: 50 },
      value.identity.groupId,
    );
    if (roster.kind !== 'members') throw unavailable();
    const members = roster.entries.map((e) =>
      groupMemberSchema.parse({
        groupId: e.identity.groupId,
        memberId: e.identity.memberId,
        installationId: e.identity.installationId,
        displayName: e.identity.displayName,
        active: e.identity.state === 'active',
      }),
    );
    return host.groupHostOpenSchema.parse({
      group: { ...this.summary(value), members: members.length },
      member: {
        groupId: value.identity.groupId,
        memberId: value.identity.memberId,
        installationId: value.identity.installationId,
        displayName: value.identity.displayName,
        active: true,
      },
      members,
      shared: this.publicSlot(value.shared!),
      private: this.publicSlot(value.private!),
      native: await this.nativeAvailability(),
      feedWriter: this.promotion.summary(value.handle, value.creator),
    });
  }
  private async resolve(handle: string) {
    for (const raw of this.records()) {
      const slot = [raw.shared, raw.private].find((s) => s?.handle === handle);
      if (slot) {
        const value = await this.active(raw.handle);
        return {
          value,
          slot: slot.context.visibility === 'shared' ? value.shared! : value.private!,
        };
      }
    }
    throw new Missing('Saved group context unavailable. Reopen the group.');
  }
  /** Host-only feature adapter port. Browser routes never return this object. */
  async authenticatedContext(raw: unknown): Promise<GroupHostFeatureContext> {
    const { handle } = host.groupHostSelectSchema.parse(raw);
    const { value, slot } = await this.resolve(handle);
    const context = Object.freeze({ ...slot.context });
    const revalidate = async () => {
      const current = await this.resolve(handle);
      if (publicationCanonical(current.slot.context) !== publicationCanonical(context))
        throw new Conflict('Feature context binding changed. Reopen the saved group.');
      return current;
    };
    return Object.freeze({
      handle,
      enrollmentHandle: value.handle,
      context,
      enrollment: Object.freeze({ ...value.identity }),
      revalidate: async () => {
        await revalidate();
      },
      readShared: async (query: GroupFeedQuery) => {
        const current = await revalidate();
        // A member's private aside may read shared evidence without publishing
        // its query or opening another member's aside.
        return this.remoteFeed(current.value, current.value.shared!, query);
      },
      original: async (eventId: Parameters<GroupHostFeatureContext['original']>[0]) => {
        const current = await revalidate();
        return this.original({ handle: current.value.shared!.handle, eventId });
      },
    });
  }
  /** Protected feature transport. The browser supplies only a saved context
   * handle; enrollment capability and approved destination stay on this host. */
  /** Exact retained owner anchor for native report authority; no latest-native or path lookup. */
  async authenticatedOwnerContext(raw: GroupContext) {
    const context = groupContextSchema.parse(raw);
    if (context.provider !== 'owner') throw new Conflict('Saved owner context required.');
    const record = this.records().find(
      (r) =>
        r.identity.groupId === context.groupId &&
        r.identity.memberId === context.memberId &&
        r.identity.installationId === context.installationId,
    );
    const slot = context.visibility === 'shared' ? record?.shared : record?.private;
    if (!slot || publicationCanonical(slot.context) !== publicationCanonical(context))
      throw new Missing('Exact saved owner context unavailable.');
    return this.authenticatedContext({ handle: slot.handle });
  }
  async actionContext(handle: string) {
    const feature = await this.authenticatedContext({ handle });
    return {
      ...feature,
      visibility: feature.context.visibility,
      command: async (raw: GroupActionCommand) => {
        const command = groupActionCommandSchema.parse(raw);
        if (
          feature.context.visibility !== 'shared' &&
          !['board', 'work', 'evidence'].includes(command.kind)
        )
          throw new GroupHostError(
            403,
            'GROUP_PRIVATE_ACTION',
            'Use shared actions from the group.',
          );
        await feature.revalidate();
        const { value } = await this.resolve(handle);
        const config = this.configured();
        const response = await this.http(
          `${config.endpoint.replace(/\/$/, '')}/v1/groups/${value.identity.groupId}/actions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${value.credential}`,
              ...this.serviceHeaders(value, false, config),
            },
            body: JSON.stringify(command),
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            signal: AbortSignal.timeout(5000),
          },
        );
        const result = groupActionResultSchema.parse(await this.bounded(response, 1_000_000));
        // A late service response does not preserve a revoked local permission.
        await feature.revalidate();
        return result;
      },
    };
  }
  async actionContextForEnrollment(enrollmentHandle: string) {
    const value = await this.active(enrollmentHandle);
    return this.actionContext(value.shared!.handle);
  }
  /** Internal same-owner promotion port. Protected credentials, source
   * registration and publication never enter the browser protocol. */
  /** Same authenticated enrollment/DO as chat; no browser path or endpoint. */
  async documentContext(handle: string) {
    const feature = await this.authenticatedContext({ handle });
    if (feature.context.visibility !== 'shared')
      throw new Conflict('Open shared reports from the shared group.');
    const { value } = await this.resolve(handle);
    return {
      binding: value.binding!,
      context: feature.context,
      revalidate: feature.revalidate,
      command: async (raw: DocumentTransportCommand) => {
        const command = documentTransportCommandSchema.parse(raw);
        await feature.revalidate();
        if (command.kind === 'begin') {
          // Sharing can be the first shared operation in this enrollment.
          const ids = this.intent(`document-context:${value.handle}`, feature.context, () => ({
            operationId: randomUUID(),
            messageId: randomUUID(),
          })) as { operationId: string; messageId: string };
          await this.registerSource(
            value,
            {
              sessionId: feature.context.sessionId,
              provider: feature.context.provider,
              nativeSessionId: feature.context.nativeSessionId,
              messageId: ids.messageId,
            },
            ids.operationId,
          );
        }
        const config = this.configured();
        const response = await this.http(
          `${config.endpoint.replace(/\/$/, '')}/v1/groups/${value.identity.groupId}/documents`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${value.credential}`,
              ...this.serviceHeaders(value, false, config),
            },
            body: JSON.stringify(command),
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            signal: AbortSignal.timeout(5000),
          },
        );
        const result = documentTransportResultSchema.parse(
          await this.bounded(response, DOCUMENT_TRANSPORT_LIMITS.bodyBytes * 6),
        );
        await feature.revalidate();
        return result;
      },
    };
  }
  async promotionContext(enrollmentHandle: string) {
    const value = await this.active(enrollmentHandle),
      context = value.shared!.context;
    const feature = await this.authenticatedContext({ handle: value.shared!.handle });
    return {
      context,
      enrollment: value.identity,
      creator: value.creator,
      revalidate: feature.revalidate,
      command: async (raw: GroupPromotionHostCommand, signal?: AbortSignal) => {
        const command = groupPromotionHostCommandSchema.parse(raw);
        await feature.revalidate();
        const config = this.configured();
        const response = await this.http(
          `${config.endpoint.replace(/\/$/, '')}/v1/groups/${value.identity.groupId}/promotion`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${value.credential}`,
              ...this.serviceHeaders(value, false, config),
            },
            body: JSON.stringify(command),
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
              : AbortSignal.timeout(5000),
          },
        );
        const result = groupPromotionHostResultSchema.parse(
          await this.bounded(response, GROUP_PROMOTION_HOST_LIMITS.bodyBytes),
        );
        await feature.revalidate();
        return result;
      },
      registerSource: (source: z.infer<typeof groupSourceSchema>, operationId: string) =>
        this.registerSource(value, source, operationId),
      enqueue: async (scope: GroupScope, eventId: GroupEvent['eventId']) => {
        await feature.revalidate();
        if (
          scope.groupId !== context.groupId ||
          scope.memberId !== context.memberId ||
          scope.installationId !== context.installationId ||
          scope.visibility !== 'shared'
        )
          throw new Conflict('Projection is outside this writer.');
        const pub = this.publication(value),
          operationId = pub.controller.enqueue(pub.access, [eventId]).operations[0]!;
        const retained = pub.controller.inspect(pub.access, operationId);
        if (
          ['uncertain', 'offline', 'pending', 'retry'].includes(retained.state) &&
          (retained.nextAttemptAt ?? 0) <= Date.now()
        )
          await pub.controller.step(pub.access, operationId);
        await this.drive(pub, operationId);
        await feature.revalidate();
        return {
          operationId,
          state:
            pub.controller.inspect(pub.access, operationId).state === 'complete'
              ? ('committed' as const)
              : ('pending' as const),
        };
      },
    };
  }
  async configurePromotion(raw: unknown) {
    const input = host.groupHostSelectSchema.extend({ key: z.uuid() }).parse(raw);
    const { value, slot } = await this.resolve(input.handle);
    if (slot.context.visibility !== 'shared')
      throw new Conflict('Select the shared group to configure its writer.');
    if (!value.creator)
      throw new GroupHostError(
        403,
        'GROUP_CREATOR_REQUIRED',
        'Only the group creator can select its feed writer.',
      );
    try {
      return await this.promotion.enable(value.handle, input.key);
    } catch {
      throw new GroupHostError(
        503,
        'GROUP_FEED_WRITER_UNAVAILABLE',
        'Feed writer selection is pending. Retry the same saved request; originals remain retained.',
      );
    }
  }
  /** Resolve a provisioned native context back to its own saved enrollment.
   * The native tool gets its distinct session, never another member's aside. */
  async nativeFeatureContext(raw: GroupContext): Promise<GroupHostFeatureContext> {
    const context = groupContextSchema.parse(raw);
    if (context.provider === 'owner') throw new Conflict('Native feature context required.');
    const verifyNative = () =>
      this.events.trustedHostScope({
        groupId: context.groupId,
        memberId: context.memberId,
        installationId: context.installationId,
        visibility: context.visibility,
        source: {
          sessionId: context.sessionId,
          provider: context.provider,
          nativeSessionId: context.nativeSessionId,
          messageId: 'native-feature-context',
        },
        causalRefs: [],
      });
    verifyNative();
    const record = this.records().find(
      (value) =>
        value.identity.groupId === context.groupId &&
        value.identity.memberId === context.memberId &&
        value.identity.installationId === context.installationId,
    );
    const slot = context.visibility === 'shared' ? record?.shared : record?.private;
    if (!slot) throw new Missing('Native context enrollment unavailable.');
    const owner = await this.authenticatedContext({ handle: slot.handle });
    return Object.freeze({
      ...owner,
      context: Object.freeze(context),
      revalidate: async () => {
        await owner.revalidate();
        verifyNative();
      },
    });
  }
  /** Protected typed feature producer. No browser route accepts this capability;
   * feature owners supply concise metadata only, never implicit work authority. */
  async publishFeatureEvent(handle: string, key: string, text: string, summary: string) {
    z.string().min(1).max(1000).parse(key);
    z.string()
      .max(32 * 1024)
      .parse(text);
    z.string().min(1).max(2000).parse(summary);
    const actor = await this.authenticatedContext({ handle });
    if (actor.context.visibility !== 'shared')
      throw new Conflict('Shared feature context required.');
    const resolved = await this.resolve(handle);
    const result = await this.publishCoordination(
      resolved.value.handle,
      actor.context,
      `feature:${key}`,
      text,
      'Decision',
      [],
      summary,
    );
    await actor.revalidate();
    return result;
  }
  /** Internal runtime callback, never a browser action. All receipt fields come
   * from the admitted manager's authoritative operation and provisioned context. */
  async publishOwnedTask(key: string, raw: GroupOwnedTaskReceipt, nativeContext: GroupContext) {
    const binding = groupOwnedTaskReceiptSchema.parse(raw);
    if (nativeContext.provider === 'owner' || nativeContext.visibility !== 'shared')
      throw new Conflict('An admitted shared native manager context is required.');
    const value = this.records().find(
      (record) =>
        record.identity.groupId === nativeContext.groupId &&
        record.identity.memberId === nativeContext.memberId &&
        record.identity.installationId === nativeContext.installationId,
    );
    if (!value) throw new Missing('Owning group enrollment unavailable.');
    return this.publishCoordination(
      value.handle,
      nativeContext,
      `owned-task:${key}`,
      JSON.stringify(binding),
      'Decision',
      [binding.sharedGoalId],
    );
  }
  async sharedGoalForRequest(requestId: string): Promise<GroupEvent['eventId']> {
    z.uuid().parse(requestId);
    const row = this.db
      .prepare('SELECT handle,key FROM ghn_requests WHERE request_id=?')
      .get(requestId);
    if (!row) throw new Missing('Shared native request unavailable.');
    const record = this.nativeJournal.get(String(row.handle), String(row.key))!;
    if (record.request.context.visibility !== 'shared' || record.request.intent !== 'work')
      throw new Conflict('Only an explicit shared work instruction authorizes coordination.');
    const goal = await this.publishCoordination(
      record.request.enrollmentHandle,
      record.request.context,
      `native-goal:${requestId}`,
      record.request.text,
      'Instruction',
      [],
    );
    return goal.eventId;
  }
  private async publishCoordination(
    enrollmentHandle: string,
    context: GroupContext,
    key: string,
    text: string,
    category: 'Instruction' | 'Decision',
    causalRefs: GroupEvent['eventId'][],
    featureSummary?: string,
  ) {
    return this.lock(`coordination:${key}`, async () => {
      const value = await this.active(enrollmentHandle);
      if (
        context.visibility !== 'shared' ||
        context.groupId !== value.identity.groupId ||
        context.memberId !== value.identity.memberId ||
        context.installationId !== value.identity.installationId
      )
        throw new Conflict('Shared coordination enrollment changed.');
      const input = {
        context,
        text,
        category,
        causalRefs,
        ...(featureSummary ? { featureSummary } : {}),
      };
      const ids = z
        .object({ operationId: z.uuid(), entityId: z.uuid(), messageId: z.uuid() })
        .parse(
          this.intent(`coordination:${key}`, input, () => ({
            operationId: randomUUID(),
            entityId: randomUUID(),
            messageId: randomUUID(),
          })),
        );
      const source = {
        sessionId: context.sessionId,
        provider: context.provider,
        nativeSessionId: context.nativeSessionId,
        messageId: ids.messageId,
      };
      const access = this.events.trustedHostScope({
        groupId: context.groupId,
        memberId: context.memberId,
        installationId: context.installationId,
        visibility: 'shared',
        source,
        causalRefs,
      });
      const { event } = this.events.append(access, {
        operationId: groupOperationIdSchema.parse(ids.operationId),
        entityId: groupEntityIdSchema.parse(ids.entityId),
        expectedRevision: 0,
        category,
        condensedText:
          featureSummary ??
          (category === 'Instruction'
            ? `Agent instruction · ${Array.from(text).slice(0, 240).join('')}`
            : `Owned task · ${groupOwnedTaskReceiptSchema.parse(JSON.parse(text)).title}`),
        original: nativeOriginal(text),
        evidenceRefs: causalRefs,
        corrects: null,
      });
      await this.registerSource(value, source, ids.operationId);
      const pub = this.publication(value);
      const operation = pub.controller.enqueue(pub.access, [event.eventId]).operations[0];
      await this.drive(pub, operation);
      if (pub.controller.inspect(pub.access, operation).state !== 'complete') throw unavailable();
      await this.active(enrollmentHandle);
      this.db
        .prepare('INSERT OR IGNORE INTO gh_coordination_receipts VALUES(?,?,?,?)')
        .run(key, context.sessionId, event.eventId, operation);
      return { eventId: event.eventId };
    });
  }
  /** Authenticated owner routes only; members and publications never receive this capability. */
  async nativeOwnerControl(raw: unknown) {
    const input = groupNativeOwnerInputSchema.parse(raw);
    const scope = await this.authenticatedContext({ handle: input.handle });
    if (!this.native.owner)
      throw new GroupHostError(
        503,
        'GROUP_NATIVE_SETUP_REQUIRED',
        'Native owner setup is unavailable on this installation.',
      );
    let retainedRequest: GroupNativeRequest | undefined;
    let retainedRecord: GroupHostNativeRecord | undefined;
    if ('requestId' in input && input.requestId) {
      const record = this.nativeJournal
        .list(input.handle)
        .find((r) => r.request.requestId === input.requestId);
      if (
        !record ||
        publicationCanonical(record.request.context) !== publicationCanonical(scope.context) ||
        record.request.enrollmentHandle !== scope.enrollmentHandle
      )
        throw new GroupHostError(
          404,
          'GROUP_NATIVE_REQUEST_MISSING',
          'This saved request does not belong to this group context.',
        );
      retainedRequest = record.request;
      retainedRecord = record;
    }
    const result = await this.native.owner.control(scope, input, true, retainedRequest);
    if (input.action === 'reconnect' && retainedRecord)
      // Re-open receipt inspection after proved pre-input owner recovery. This
      // never returns to prepared, so native submission cannot be repeated.
      this.nativeJournal.mark(retainedRecord, {
        state: 'unknown',
        message: 'Explicit owner reconnection requested; inspect this same native request.',
      });
    return result;
  }
  private access(slot: Slot, messageId: string) {
    const { sessionId, provider, nativeSessionId, ...scope } = slot.context;
    return this.events.trustedHostScope({
      ...scope,
      source: { sessionId, provider, nativeSessionId, messageId },
      causalRefs: [],
    });
  }
  private publication(value: Record) {
    let existing = this.controllers.get(value.handle);
    if (existing) return existing;
    const binding = value.binding!;
    const transport = new HostedPublicationTransport(
      (b) => {
        const current = this.record(value.handle),
          config = this.configuration();
        if (current.identity.state !== 'active') return { kind: 'unavailable', reason: 'revoked' };
        if (
          !config ||
          config.mode === 'disabled' ||
          config.endpointId !== b.endpointId ||
          (config.mode === 'beta' && !current.beta) ||
          serviceHash(config) !== current.serviceHash ||
          publicationCanonical(current.binding) !== publicationCanonical(b)
        )
          return { kind: 'unavailable', reason: 'unauthorized' };
        return {
          kind: 'enrolled',
          binding: b,
          endpoint: config.endpoint,
          credential: current.credential,
          remoteInstallationId: current.identity.installationId,
          remoteMemberId: current.identity.memberId,
          ...(config.mode === 'hosted'
            ? { hostingAuthorization: config.hostingAuthorization }
            : {}),
          ...(config.mode === 'beta'
            ? { betaAuthorization: { profile: config.profile, admission: current.beta!.admission } }
            : {}),
        };
      },
      this.configured().mode,
      this.http,
    );
    const path = join(this.directory, `publication-${value.handle}.sqlite`);
    privateGroupFile(path);
    const controller = new GroupPublicationController(path, this.events, transport);
    const sharedAccess = this.access(value.shared!, 'publication');
    const access = controller.trustedHostRegister(binding, () => {
      const current = this.record(value.handle);
      if (
        current.identity.state !== 'active' ||
        !current.shared ||
        publicationCanonical(current.binding) !== publicationCanonical(binding)
      )
        throw new Error('authority unavailable');
      return { binding, access: sharedAccess };
    });
    existing = { controller, access, transport };
    this.controllers.set(value.handle, existing);
    protectGroupSidecars(path);
    return existing;
  }
  private async registerSource(
    value: Record,
    source: z.infer<typeof groupSourceSchema>,
    operationId: string,
  ) {
    const { transport } = this.publication(value);
    const parsed = deliveryCommandSchema.safeParse({
      kind: 'registerSource',
      operationId,
      binding: value.binding,
      memberId: value.identity.memberId,
      source,
    });
    if (!parsed.success)
      throw new GroupHostError(
        503,
        'GROUP_SOURCE_ADAPTER_REQUIRED',
        'Hosted delivery needs the exact trusted source registration adapter. This message is retained; retry the same message after the reviewed service update.',
      );
    const reply = await transport.query(value.binding!, parsed.data, AbortSignal.timeout(5000));
    if (reply.kind !== 'registered') throw unavailable();
    return reply.sourceId;
  }
  private async drive(pub: ReturnType<GroupHost['publication']>, operationId: string) {
    for (let i = 0; i < 4; i++) {
      const prior = pub.controller.inspect(pub.access, operationId);
      if (
        prior.state === 'complete' ||
        [
          'uncertain',
          'offline',
          'unauthorized',
          'revoked',
          'exhausted',
          'collision',
          'protocol',
          'integrity',
        ].includes(prior.state)
      )
        return;
      const delay = Math.max(0, (prior.nextAttemptAt ?? 0) - Date.now());
      if (delay > 500) return;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      await pub.controller.step(pub.access, operationId);
    }
  }
  async send(raw: unknown) {
    const input = host.groupHostSendSchema.parse(raw);
    return this.lock(`send:${input.handle}:${input.key}`, async () => {
      const { value, slot } = await this.resolve(input.handle);
      const send = z
        .strictObject({
          messageId: z.uuid(),
          operationId: z.uuid(),
          entityId: z.uuid(),
          runId: z.uuid(),
          eventId: z.uuid().nullable(),
          deliveryOperation: z.uuid().nullable(),
          promotionReceiptId: z.string().optional(),
          promotionState: z.string().max(200).optional(),
          createdAt: z.string().optional(),
        })
        .parse(
          this.transaction(() => {
            const prior = this.db
              .prepare('SELECT input,body FROM gh_sends WHERE handle=? AND key=?')
              .get(input.handle, input.key);
            const exact = publicationCanonical(input);
            if (prior) {
              if (prior.input !== exact)
                throw new Conflict('Send retry content changed. Retry the original message.');
              return JSON.parse(String(prior.body));
            }
            if (
              Number(
                this.db.prepare('SELECT count(*) n FROM gh_sends WHERE handle=?').get(input.handle)!
                  .n,
              ) >= 2048
            )
              throw new Conflict('Context send history is full. Existing receipts remain.');
            const result = {
              messageId: randomUUID(),
              operationId: randomUUID(),
              entityId: randomUUID(),
              runId: randomUUID(),
              eventId: null,
              deliveryOperation: null,
              createdAt: new Date().toISOString(),
            };
            this.db
              .prepare('INSERT INTO gh_sends VALUES (?,?,?,?)')
              .run(input.handle, input.key, exact, JSON.stringify(result));
            return result;
          }),
        );
      const result = this.events.append(this.access(slot, send.messageId), {
        operationId: groupOperationIdSchema.parse(send.operationId),
        entityId: groupEntityIdSchema.parse(send.entityId),
        expectedRevision: 0,
        category: 'Question',
        condensedText: send.eventId
          ? this.events.expand(this.access(slot, send.messageId), send.eventId).event.condensedText
          : 'Human original retained on its source computer',
        original: { kind: 'inline', text: input.text },
        evidenceRefs: [],
        corrects: null,
      });
      send.eventId = result.event.eventId;
      this.db
        .prepare('UPDATE gh_sends SET body=? WHERE handle=? AND key=?')
        .run(JSON.stringify(send), input.handle, input.key);
      let delivery = 'Private note saved on this computer';
      if (slot.context.visibility === 'shared') {
        const sourceId = await this.registerSource(
          value,
          groupSourceSchema.parse({
            sessionId: slot.context.sessionId,
            provider: slot.context.provider,
            nativeSessionId: slot.context.nativeSessionId,
            messageId: send.messageId,
          }),
          send.operationId,
        );
        if (send.deliveryOperation) {
          const pub = this.publication(value);
          await this.drive(pub, send.deliveryOperation);
          delivery = pub.controller.inspect(pub.access, send.deliveryOperation).state;
        } else {
          send.promotionReceiptId = `human:${input.handle}:${input.key}`;
          delivery = await this.promotion.retain({
            receiptId: send.promotionReceiptId,
            enrollmentHandle: value.handle,
            sourceId,
            scope: result.event.scope,
            kind: 'human',
            original: { kind: 'inline', text: input.text },
          });
          send.promotionState = delivery;
        }
        this.db
          .prepare('UPDATE gh_sends SET body=? WHERE handle=? AND key=?')
          .run(JSON.stringify(send), input.handle, input.key);
      }
      return host.groupHostReceiptSchema.parse({
        key: input.key,
        runId: send.runId,
        status: 'accepted',
        delivery,
      });
    });
  }
  async status(raw: unknown) {
    const input = host.groupHostSelectSchema
      .extend({ key: z.uuid(), retry: z.boolean().default(false) })
      .parse(raw);
    const { value, slot } = await this.resolve(input.handle);
    const prior = this.db
      .prepare('SELECT input,body FROM gh_sends WHERE handle=? AND key=?')
      .get(input.handle, input.key);
    if (!prior) throw new Missing('No retained send with this identity.');
    const send = JSON.parse(String(prior.body)) as {
      deliveryOperation: string | null;
      promotionReceiptId?: string;
      promotionState?: string;
    };
    if (slot.context.visibility === 'private') return { delivery: 'private' };
    if (send.promotionReceiptId)
      return {
        delivery: send.promotionState?.startsWith('full:')
          ? send.promotionState
          : await this.promotion.status(send.promotionReceiptId),
      };
    if (!send.deliveryOperation) {
      if (input.retry) {
        const receipt = await this.send(JSON.parse(String(prior.input)));
        return { delivery: receipt.delivery };
      }
      return { delivery: 'source_registration_pending' };
    }
    const pub = this.publication(value);
    if (input.retry) {
      const scheduled = pub.controller.inspect(pub.access, send.deliveryOperation);
      const delay = Math.max(0, (scheduled.nextAttemptAt ?? 0) - Date.now());
      // Honor durable backoff. A short remaining cooldown can be reconciled in
      // this explicit request; longer cooldowns retain their state for later retry.
      if (delay > 0 && delay <= 1000) await new Promise((resolve) => setTimeout(resolve, delay));
      await pub.controller.step(pub.access, send.deliveryOperation);
      await this.drive(pub, send.deliveryOperation);
    }
    return { delivery: pub.controller.inspect(pub.access, send.deliveryOperation).state };
  }
  private draft(handle: string) {
    const r = this.db.prepare('SELECT text,revision FROM gh_drafts WHERE handle=?').get(handle);
    return host.groupHostDraftStateSchema.parse(r ?? { text: '', revision: 0 });
  }
  async saveDraft(raw: unknown) {
    const input = host.groupHostDraftSchema.parse(raw);
    await this.resolve(input.handle);
    return this.transaction(() => {
      const prior = this.db
        .prepare('SELECT input,body FROM gh_draft_receipts WHERE handle=? AND key=?')
        .get(input.handle, input.key);
      const exact = publicationCanonical(input);
      if (prior) {
        if (prior.input !== exact) throw new Conflict('Draft retry content changed.');
        return JSON.parse(String(prior.body)) as unknown;
      }
      const base = this.draft(input.handle);
      if (base.revision !== input.revision)
        throw new Conflict('Draft changed in another view. Choose which version to keep.');
      if (
        Number(
          this.db
            .prepare('SELECT count(*) n FROM gh_draft_receipts WHERE handle=?')
            .get(input.handle)!.n,
        ) >= 4096
      )
        throw new Conflict(
          'Draft receipt history full. Copy your draft; existing versions remain.',
        );
      const value = { text: input.text, revision: base.revision + 1 };
      this.db
        .prepare(
          'INSERT INTO gh_drafts VALUES (?,?,?) ON CONFLICT(handle) DO UPDATE SET text=excluded.text,revision=excluded.revision',
        )
        .run(input.handle, value.text, value.revision);
      this.db
        .prepare('INSERT INTO gh_draft_receipts VALUES (?,?,?,?)')
        .run(input.handle, input.key, exact, JSON.stringify(value));
      return value;
    });
  }
  async chat(raw: unknown) {
    const { handle } = host.groupHostSelectSchema.parse(raw);
    const { value, slot } = await this.resolve(handle);
    const pendingNative = this.nativeJournal
      .list(handle)
      .filter((v) => !v.result && !['prepared', 'blocked'].includes(v.receipt.state));
    const offset = this.nativeReadOffsets.get(handle) ?? 0;
    for (let i = 0; i < Math.min(2, pendingNative.length); i++) {
      const pending = pendingNative[(offset + i) % pendingNative.length];
      await this.lock(`native:${handle}:${pending.request.key}`, async () => {
        const current = this.nativeJournal.get(handle, pending.request.key)!;
        try {
          await this.advanceNative(value, current);
        } catch {
          const retained = this.nativeJournal.get(handle, pending.request.key)!;
          if (!retained.result)
            this.nativeJournal.mark(retained, {
              state: 'unknown',
              message:
                'Native receipt or publication is unavailable. Recover this exact request; tools will not be submitted again.',
            });
        }
      });
    }
    this.nativeReadOffsets.set(handle, offset + 2);
    const rows = this.db
      .prepare('SELECT input,body FROM gh_sends WHERE handle=? ORDER BY rowid DESC LIMIT 201')
      .all(handle)
      .reverse();
    const entries = rows.slice(-200).map((row) => {
      const send = JSON.parse(String(row.body)) as {
        messageId: string;
        runId: string;
        eventId: string | null;
        createdAt?: string;
      };
      const input = host.groupHostSendSchema.parse(JSON.parse(String(row.input)));
      return {
        id: send.messageId,
        agentId: slot.handle,
        runId: send.runId,
        kind: 'user',
        title: 'Human message',
        text: input.text,
        status: send.eventId ? 'complete' : 'uncertain',
        createdAt: send.createdAt ?? slot.createdAt,
      };
    });
    const nativeRows = this.nativeJournal.list(handle);
    const nativeEntries = nativeRows.flatMap((record) => [
      {
        id: record.request.requestId,
        agentId: slot.handle,
        runId: record.request.requestId,
        kind: 'user',
        title: 'Agent request',
        text: record.request.text,
        status: record.receipt.state,
        createdAt: record.ids.createdAt,
      },
      ...(record.result
        ? [
            {
              id: record.ids.resultId,
              agentId: slot.handle,
              runId: record.request.requestId,
              kind: 'assistant',
              title: `${record.result.context.provider === 'codex' ? 'Codex' : 'Claude'} response · ${record.result.nativeToolItems} native tool items`,
              text: record.result.text,
              status: 'complete',
              createdAt: record.resultAt!,
            },
          ]
        : []),
    ]);
    const combined = [...entries, ...nativeEntries].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    return host.groupHostChatSchema.parse({
      detail: {
        agent: this.agent(slot),
        entries: combined.slice(-200),
        runs: [],
        hasMore: rows.length > 200 || combined.length > 200,
      },
      draft: this.draft(handle),
      nativeRequests: await Promise.all(
        nativeRows.map((record) => this.nativeReceipt(value, record)),
      ),
      deliveries: rows.slice(-200).map((row) => {
        const input = host.groupHostSendSchema.parse(JSON.parse(String(row.input)));
        const send = JSON.parse(String(row.body)) as {
          runId: string;
          deliveryOperation: string | null;
          promotionReceiptId?: string;
          promotionState?: string;
        };
        return {
          key: input.key,
          runId: send.runId,
          state:
            slot.context.visibility === 'private'
              ? 'private'
              : send.promotionReceiptId
                ? send.promotionState?.startsWith('full:')
                  ? send.promotionState
                  : this.promotion.peek(send.promotionReceiptId)
                : send.deliveryOperation
                  ? this.publication(value).controller.inspect(
                      this.publication(value).access,
                      send.deliveryOperation,
                    ).state
                  : 'source_registration_pending',
        };
      }),
    });
  }
  async feed(raw: unknown) {
    const { handle, query } = host.groupHostFeedSchema.parse(raw);
    const { value, slot } = await this.resolve(handle);
    if (slot.context.visibility !== 'shared')
      throw new GroupHostError(403, 'PRIVATE_SCOPE', 'Use the shared feed context.');
    return this.remoteFeed(value, slot, query, true);
  }
  private async remoteFeed(value: Record, slot: Slot, query: GroupFeedQuery, withOrigin = false) {
    const scopeKey = createHash('sha256')
      .update(`${value.handle}:${slot.handle}:shared`)
      .digest('hex');
    if (query.cursor && query.cursor.scopeKey !== scopeKey)
      throw new Conflict('Feed cursor belongs to a different context.');
    const reply = await this.publication(value).transport.query(
      value.binding!,
      {
        kind: 'feed',
        after: query.after,
        limit: Math.min(query.limit, 8),
        cursor: query.cursor
          ? {
              version: 1,
              groupId: value.identity.groupId,
              after: query.cursor.after,
              watermark: query.cursor.watermark,
            }
          : null,
      },
      AbortSignal.timeout(5000),
    );
    if (reply.kind !== 'feed') throw unavailable();
    const origins =
      withOrigin && reply.entries.length
        ? await this.promotionOrigins(
            value.handle,
            reply.entries.map((e) => e.header.event.eventId),
          )
        : [];
    return groupFeedPageSchema.parse({
      entries: reply.entries.map((e) => ({
        ...e.header.event,
        sequence: e.remoteSequence,
        ...(origins.find((o) => o.eventId === e.header.event.eventId)
          ? { origin: origins.find((o) => o.eventId === e.header.event.eventId)!.origin }
          : {}),
      })),
      watermark: reply.watermark,
      continuation: reply.continuation
        ? {
            version: 2,
            scopeKey,
            visibility: 'shared',
            after: reply.continuation.after,
            watermark: reply.continuation.watermark,
          }
        : null,
    });
  }
  async original(raw: unknown) {
    const { handle, eventId } = host.groupHostOriginalSchema.parse(raw);
    const result = await this.sharedOriginal(handle, eventId);
    return host.groupHostOriginalResultSchema.parse({ eventId, text: result.text });
  }
  /** Internal source adapters obtain the exact hosted position alongside the
   * verified original; local repository sequence numbers are never substituted. */
  async sharedEvidence(enrollmentHandle: string, eventId: GroupEvent['eventId']) {
    const value = await this.active(enrollmentHandle);
    return this.sharedOriginal(value.shared!.handle, eventId);
  }
  async sharedEvidenceHeader(enrollmentHandle: string, eventId: GroupEvent['eventId']) {
    const value = await this.active(enrollmentHandle);
    const reply = await this.publication(value).transport.query(
      value.binding!,
      { kind: 'expand', eventId, start: 0, count: 1 },
      AbortSignal.timeout(5000),
    );
    if (reply.kind !== 'expansion' || reply.header.event.eventId !== eventId) throw unavailable();
    await this.active(enrollmentHandle);
    const origin = (await this.promotionOrigins(enrollmentHandle, [eventId]))[0]?.origin;
    return {
      event: groupEventSchema.parse({ ...reply.header.event, sequence: reply.remoteSequence }),
      origin,
      // A compact typed receipt may be read without expanding arbitrary large
      // originals. The transport verifies this delivered chunk's exact digest.
      compactOriginal:
        reply.header.event.manifest.chunks.length === 1 && reply.header.event.manifest.bytes <= 2048
          ? (reply.chunks[0]?.text ?? null)
          : null,
    };
  }
  private async promotionOrigins(enrollmentHandle: string, eventIds: GroupEvent['eventId'][]) {
    const port = await this.promotionContext(enrollmentHandle);
    const result = await port.command({ kind: 'attribution', eventIds });
    if (!result.ok || result.value.kind !== 'attribution') throw unavailable();
    if (
      result.value.entries.some(
        (e) =>
          !eventIds.includes(e.eventId) ||
          e.origin.key.groupId !== port.enrollment.groupId ||
          e.origin.scope.groupId !== port.context.groupId,
      )
    )
      throw unavailable();
    return result.value.entries;
  }
  private async sharedOriginal(handle: string, eventId: GroupEvent['eventId']) {
    const { value, slot } = await this.resolve(handle);
    if (slot.context.visibility !== 'shared')
      throw new GroupHostError(
        403,
        'PRIVATE_SCOPE',
        'Private originals cannot enter the shared feed.',
      );
    const pub = this.publication(value);
    let start = 0;
    const chunks: Extract<DeliveryReply, { kind: 'expansion' }>['chunks'] = [];
    let header: Extract<DeliveryReply, { kind: 'expansion' }>['header'] | undefined;
    let remoteSequence: number | undefined;
    for (let i = 0; i < 16; i++) {
      const reply = await pub.transport.query(
        value.binding!,
        { kind: 'expand', eventId, start, count: 4 },
        AbortSignal.timeout(5000),
      );
      if (
        reply.kind !== 'expansion' ||
        (header &&
          (publicationCanonical(header) !== publicationCanonical(reply.header) ||
            remoteSequence !== reply.remoteSequence))
      )
        throw unavailable();
      header = reply.header;
      remoteSequence = reply.remoteSequence;
      chunks.push(...reply.chunks);
      if (reply.next === null) break;
      start = reply.next;
    }
    if (!header) throw unavailable();
    publicationEnvelopeSchema.parse({ header, chunks });
    return {
      event: groupEventSchema.parse({ ...header.event, sequence: remoteSequence }),
      text: chunks.map((c) => c.text).join(''),
    };
  }
  async catchUp(raw: unknown) {
    const { handle } = host.groupHostSelectSchema.parse(raw);
    const { value, slot } = await this.resolve(handle);
    if (slot.context.visibility !== 'private')
      throw new GroupHostError(403, 'PRIVATE_SCOPE', 'Catch-up belongs to your private aside.');
    const page = await this.remoteFeed(value, value.shared!, {
      visibility: 'shared',
      after: 0,
      limit: 8,
      cursor: null,
    });
    return {
      text: `Shared evidence snapshot through ${page.watermark}. This is a bounded excerpt, not an AI summary.\n${page.entries.map((e) => `${e.sequence}. ${e.condensedText}`).join('\n')}`,
    };
  }
  async invite(raw: unknown) {
    const input = host.groupHostSelectSchema.extend({ key: z.uuid() }).parse(raw);
    const value = await this.active(input.handle);
    if (!value.creator)
      throw new GroupHostError(
        403,
        'CREATOR_REQUIRED',
        'Only the group creator can invite members.',
      );
    const secret = z.string().parse(this.intent(`invite:${input.key}`, input, capability));
    const reply = await this.membership(
      value,
      {
        kind: 'invite',
        operationId: groupOperationIdSchema.parse(input.key),
        inviteSecret: secret,
        ttlSeconds: MEMBERSHIP_LIMITS.inviteSeconds,
      },
      value.identity.groupId,
    );
    if (reply.kind !== 'invitation') throw unavailable();
    const config = this.configured();
    return {
      fragment: `/groups?invite=${encodeURIComponent(
        JSON.stringify({
          groupId: value.identity.groupId,
          secret,
          name: value.name,
          ...(config.mode === 'beta' && value.beta
            ? { serviceId: config.profile.serviceId, admission: value.beta.admission }
            : {}),
          ...(config.mode === 'hosted'
            ? {
                service: groupHostedInvitationServiceSchema.parse({
                  version: config.version,
                  mode: config.mode,
                  endpoint: config.endpoint,
                  endpointId: config.endpointId,
                  hostingAuthorization: config.hostingAuthorization,
                }),
              }
            : {}),
        }),
      )}`,
      expiresAt: reply.expiresAt,
    };
  }
  async pending(raw: unknown) {
    const { handle } = host.groupHostSelectSchema.parse(raw);
    const value = await this.active(handle);
    if (!value.creator)
      throw new GroupHostError(403, 'CREATOR_REQUIRED', 'Only the creator can approve members.');
    const reply = await this.membership(
      value,
      { kind: 'pending', after: 0, limit: 32 },
      value.identity.groupId,
    );
    if (reply.kind !== 'members') throw unavailable();
    this.transaction(() => {
      for (const entry of reply.entries)
        this.db
          .prepare(
            'INSERT INTO gh_pending VALUES (?,?,?) ON CONFLICT(handle,request_id) DO UPDATE SET identity=excluded.identity',
          )
          .run(handle, entry.identity.installationId, JSON.stringify(entry.identity));
    });
    return {
      requests: reply.entries.map((e) => ({
        requestId: e.identity.installationId,
        displayName: e.identity.displayName,
      })),
    };
  }
  async approve(raw: unknown) {
    const input = host.groupHostApprovalSchema
      .extend({ confirmation: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(raw);
    const value = await this.active(input.handle);
    if (
      !value.creator ||
      !this.db
        .prepare('SELECT 1 FROM gh_pending WHERE handle=? AND request_id=?')
        .get(input.handle, input.requestId)
    )
      throw new GroupHostError(
        403,
        'CREATOR_REQUIRED',
        'Refresh pending requests and verify the exact member confirmation.',
      );
    this.intent(
      `approve:${input.key}`,
      { ...input, confirmation: createHash('sha256').update(input.confirmation).digest('hex') },
      () => true,
    );
    const reply = await this.membership(
      value,
      {
        kind: 'approve',
        operationId: groupOperationIdSchema.parse(input.key),
        installationId: membershipIdentitySchema.shape.installationId.parse(input.requestId),
        confirmation: input.confirmation,
      },
      value.identity.groupId,
    );
    return reply;
  }
  async revoke(raw: unknown) {
    const input = host.groupHostApprovalSchema.parse(raw);
    const prior = this.db
      .prepare('SELECT input FROM gh_operations WHERE key=?')
      .get(`revoke:${input.key}`);
    // Only a previously persisted exact revoke may bypass the service's blocked read
    // probe. The service still authenticates and commits/replays that same revoke.
    const value = prior ? this.record(input.handle) : await this.active(input.handle);
    if (!value.creator || serviceHash(this.configured()) !== value.serviceHash)
      throw new GroupHostError(
        403,
        'CREATOR_REQUIRED',
        'Restore the creator enrollment and original service mapping before removing a member.',
      );
    if (prior) {
      if (prior.input !== publicationCanonical(input))
        throw new Conflict('Revocation retry identity changed.');
    } else {
      const roster = await this.membership(
        value,
        { kind: 'roster', after: 0, limit: 50 },
        value.identity.groupId,
      );
      if (
        roster.kind !== 'members' ||
        !roster.entries.some((e) => e.identity.installationId === input.requestId)
      )
        throw new GroupHostError(
          403,
          'ENROLLMENT_UNAVAILABLE',
          'Choose an active enrollment from this group.',
        );
      this.intent(`revoke:${input.key}`, input, () => true);
    }
    return this.membership(
      value,
      {
        kind: 'revoke',
        operationId: groupOperationIdSchema.parse(input.key),
        installationId: membershipIdentitySchema.shape.installationId.parse(input.requestId),
      },
      value.identity.groupId,
    );
  }
  private receiveNative(record: GroupHostNativeRecord, raw: unknown) {
    try {
      const snapshot = groupNativeSnapshotSchema.parse(
        JSON.parse(JSON.stringify(groupNativeSnapshotSchema.parse(raw))),
      );
      if (snapshot.requestId !== record.request.requestId) throw new Error();
      if (snapshot.result) {
        const result = snapshot.result,
          context = result.context,
          anchor = record.request.context;
        if (
          context.groupId !== anchor.groupId ||
          context.memberId !== anchor.memberId ||
          context.installationId !== anchor.installationId ||
          context.visibility !== anchor.visibility ||
          context.sessionId === anchor.sessionId ||
          context.nativeSessionId === anchor.nativeSessionId
        )
          throw new Error();
        if (context.visibility === 'shared' && !result.source) throw new Error();
        const source = result.source ?? {
          sessionId: context.sessionId,
          provider: context.provider,
          nativeSessionId: context.nativeSessionId,
          messageId: record.ids.resultId,
        };
        if (
          source.sessionId !== context.sessionId ||
          source.provider !== context.provider ||
          source.nativeSessionId !== context.nativeSessionId ||
          !z.uuid().safeParse(source.messageId).success
        )
          throw new Error();
        // The native journal must already have issued this exact context in the
        // same repository. Host result ingestion cannot provision/relabel it.
        this.events.trustedHostScope({
          groupId: context.groupId,
          memberId: context.memberId,
          installationId: context.installationId,
          visibility: context.visibility,
          source,
          causalRefs: [],
        });
      }
      return this.nativeJournal.record(record, snapshot);
    } catch {
      throw new GroupHostError(
        503,
        'GROUP_NATIVE_RECEIPT_INVALID',
        'Native result receipt is not verified for this exact enrollment and context. The request identity is retained; recover it through the owning adapter.',
      );
    }
  }
  private async nativeAvailability() {
    try {
      return host.groupHostNativeStatusSchema.parse(
        await this.nativeCall(async () => this.native.availability()),
      );
    } catch {
      // Readiness failure cannot admit tools or expose native diagnostics in group views.
      return host.groupHostNativeStatusSchema.parse(await unavailableGroupNative.availability());
    }
  }
  private async nativeCall<T>(call: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(call),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Native receipt deadline')), 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async projectNative(value: Record, record: GroupHostNativeRecord, retry = false) {
    if (!record.result) return record;
    if (record.receipt.state !== 'completed')
      record = this.nativeJournal.mark(record, {
        state: 'completed',
        message: 'Verified native result retained.',
      });
    if (record.request.context.visibility === 'private') return record;
    // Original result is durable before this second active-enrollment check and
    // before any shared event or hosted effect. Private results never reach here.
    value = await this.active(value.handle);
    const result = record.result!,
      context = result.context,
      source = result.source!;
    const access = this.events.trustedHostScope({
      groupId: context.groupId,
      memberId: context.memberId,
      installationId: context.installationId,
      visibility: 'shared',
      source,
      causalRefs: [],
    });
    const appended = this.events.append(access, {
      operationId: groupOperationIdSchema.parse(record.ids.operationId),
      entityId: groupEntityIdSchema.parse(record.ids.entityId),
      expectedRevision: 0,
      category: 'Finding',
      condensedText: record.receipt.eventId
        ? this.events.expand(access, record.receipt.eventId).event.condensedText
        : 'Verified native original retained on its source computer',
      original: nativeOriginal(result.text),
      evidenceRefs: [],
      corrects: null,
    });
    record = this.nativeJournal.mark(record, { eventId: appended.event.eventId });
    const sourceId = await this.registerSource(value, source, record.ids.operationId);
    if (!record.receipt.deliveryOperation) {
      const state = await this.promotion.retain({
        receiptId: `native:${record.request.requestId}`,
        enrollmentHandle: value.handle,
        sourceId,
        scope: appended.event.scope,
        kind: 'native',
        original: nativeOriginal(result.text),
      });
      if (state.startsWith('full:'))
        record = this.nativeJournal.mark(record, {
          message:
            'Native result retained; shared source capacity reached. Existing sources remain available.',
        });
      return record;
    }
    const pub = this.publication(value);
    const deliveryOperation =
      record.receipt.deliveryOperation ??
      pub.controller.enqueue(pub.access, [appended.event.eventId]).operations[0];
    record = this.nativeJournal.mark(record, { deliveryOperation });
    if (retry) {
      const scheduled = pub.controller.inspect(pub.access, deliveryOperation);
      const delay = Math.max(0, (scheduled.nextAttemptAt ?? 0) - Date.now());
      if (delay > 0 && delay <= 1000) await new Promise((resolve) => setTimeout(resolve, delay));
      await pub.controller.step(pub.access, deliveryOperation);
    }
    await this.drive(pub, deliveryOperation);
    return record;
  }
  private async advanceNative(value: Record, record: GroupHostNativeRecord, start = false) {
    if (record.result) return this.projectNative(value, record, start);
    if (record.receipt.state === 'blocked') return record;
    const submit = start && record.receipt.state === 'prepared';
    if (submit) {
      const available = await this.nativeAvailability();
      if (!available.available || available.productionReady !== true)
        throw new GroupHostError(503, 'GROUP_NATIVE_SETUP_REQUIRED', available.message);
      // After this marker, only inspection is permitted, even if the process
      // restarts between native submission and acknowledgement.
      record = this.nativeJournal.mark(record, {
        state: 'unknown',
        message: 'Native handoff may have occurred. Inspect this exact request before retry.',
      });
    }
    try {
      const snapshot = await this.nativeCall(() =>
        submit
          ? this.native.submit(record.request)
          : this.native.inspect({ requestId: record.request.requestId }),
      );
      record = this.receiveNative(record, snapshot);
    } catch (error) {
      if (error instanceof GroupHostError) throw error;
      this.nativeJournal.mark(record, {
        state: 'unknown',
        message:
          'Native acknowledgement unavailable. Only the exact retained receipt may be inspected; tools are not submitted again.',
      });
      throw new GroupHostError(
        503,
        'GROUP_NATIVE_RECEIPT_UNAVAILABLE',
        'Native acknowledgement unavailable. Retry this exact agent request to inspect its saved result; tools will not be submitted again.',
      );
    }
    return this.projectNative(value, record);
  }
  private async nativeReceipt(value: Record, record: GroupHostNativeRecord) {
    return {
      ...groupFeatureDocuments(this)?.receipt(record),
      key: record.request.key,
      text: record.request.text,
      intent: record.request.intent,
      requestId: record.request.requestId,
      resultId: record.result ? record.ids.resultId : null,
      state: record.receipt.state === 'prepared' ? 'unknown' : record.receipt.state,
      message: record.receipt.message,
      delivery:
        record.request.context.visibility === 'private'
          ? 'private'
          : record.receipt.deliveryOperation
            ? this.publication(value).controller.inspect(
                this.publication(value).access,
                record.receipt.deliveryOperation,
              ).state
            : this.promotion.peek(`native:${record.request.requestId}`),
      ...(record.request.context.visibility === 'shared' && record.result?.source
        ? { source: record.result.source }
        : {}),
    };
  }
  async documentOffer(raw: unknown) {
    const input = host.groupHostSelectSchema.extend({ key: z.uuid() }).parse(raw);
    await this.authenticatedContext({ handle: input.handle });
    const documents = groupFeatureDocuments(this);
    if (!documents)
      throw new GroupHostError(
        503,
        'GROUP_DOCUMENT_SETUP_REQUIRED',
        'Native report capture is not connected on this owner.',
      );
    if (!this.nativeJournal.get(input.handle, input.key)?.result)
      throw new GroupHostError(
        404,
        'GROUP_DOCUMENT_REPLY_MISSING',
        'Select a completed report from this conversation.',
      );
    try {
      return await documents.offer(input.handle, input.key);
    } catch {
      throw new GroupHostError(
        503,
        'GROUP_DOCUMENT_CAPTURE_PENDING',
        'Verified report capture is pending. Retry this same saved reply after reconnecting.',
      );
    }
  }
  async requestAgent(raw: unknown) {
    const input = host.groupHostAgentRequestSchema.parse(raw);
    return this.lock(`native:${input.handle}:${input.key}`, async () => {
      const { value, slot } = await this.resolve(input.handle);
      const prior = this.nativeJournal.get(input.handle, input.key);
      if (!prior) {
        const available = await this.nativeAvailability();
        if (!available.available || available.productionReady !== true)
          throw new GroupHostError(503, 'GROUP_NATIVE_SETUP_REQUIRED', available.message);
      }
      let record = this.nativeJournal.prepare(input.handle, {
        key: input.key,
        text: input.text,
        intent: input.intent,
        context: slot.context,
        enrollmentHandle: value.handle,
      });
      if (record.request.context.visibility === 'shared' && record.request.intent === 'work')
        await this.sharedGoalForRequest(record.request.requestId);
      record = await this.advanceNative(value, record, true);
      if (record.receipt.state === 'blocked')
        throw new GroupHostError(503, 'GROUP_NATIVE_BLOCKED', record.receipt.message);
      return this.nativeReceipt(value, record);
    });
  }
}
