import { createGroupPromotionNativeSynthesis } from './group-promotion-native-synthesis.js';
import type { GroupPromotionSynthesisRequest, GroupPromotionSynthesis } from './group-promotion.js';
import {
  createGroupDocumentsNativeRuntime,
  type GroupDocumentsNativeRuntime,
} from './group-documents-native-runtime.js';
import type { GroupDocumentsAuthority } from './group-documents-native.js';
import { createGroupNativeCoordination } from './group-coordination-runtime-native.js';
import type { GroupCoordinationNativePort } from './group-coordination-runtime.js';
import { mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { groupSourceSchema, type GroupContext } from '@dock/shared';
import { GroupDockerEngine } from './group-container.js';
import { GroupIsolationBlocked } from './group-isolation.js';
import { GroupNativeBridge, GroupNativeJournal, type GroupNativeContext } from './group-native.js';
import {
  GroupNativeIntents,
  nativeHandoffSchema,
  type GroupNativeHandoff,
} from './group-native-production.js';
import type { Runtime } from './runtime.js';
import type { GroupEventRepository } from './group-events.js';
import type { GroupExecutionResources, GroupNativeExecution } from './group-native-execution.js';
import type { ClaudeHostTool } from './claude-session.js';
import {
  createGroupNativeGitExports,
  type NativeGitExports,
  type NativeGitExportAuthority,
} from './group-native-git-export.js';

export interface GroupNativeSnapshot {
  requestId: string;
  state: 'queued' | 'pending-consent' | 'running' | 'completed' | 'unknown' | 'blocked';
  message: string;
  result?: {
    context: GroupContext;
    text: string;
    nativeToolItems: number;
    source?: z.infer<typeof groupSourceSchema>;
  };
}
export interface GroupNativeConnector {
  beforeTurn(callback: (context: GroupContext, requestId: string) => Promise<void>): void;
  promotionSynthesis(
    authorize: (
      request: GroupPromotionSynthesisRequest,
      signal: AbortSignal,
    ) => Promise<{ context: GroupContext; enrollmentHandle: string; writerId: string }>,
  ): GroupPromotionSynthesis & { close(): Promise<void> };
  documents(authority: GroupDocumentsAuthority): GroupDocumentsNativeRuntime;
  readonly coordination?: GroupCoordinationNativePort;
  availability(): Promise<{
    available: boolean;
    productionReady: boolean;
    authState: 'unavailable' | 'signed-out' | 'per-context' | 'ready';
    message: string;
  }>;
  submit(input: GroupNativeHandoff): Promise<GroupNativeSnapshot>;
  inspect(input: { requestId: string }): Promise<GroupNativeSnapshot>;
  /** Local authenticated owning service only. Never group feed/device codes or a generic native RPC. */
  ownerExecution(requestId: string): GroupNativeExecution | null;
  canRecoverPendingConsent(requestId: string): boolean;
  recoverPendingConsent(input: GroupNativeHandoff): Promise<GroupNativeSnapshot>;
  continueAfterConsent(requestId: string): Promise<GroupNativeSnapshot>;
  /** Root-owned Git authority and native resources, never a browser configuration. */
  gitExports(authorize: NativeGitExportAuthority): NativeGitExports;
  ownerAcceptance(input: { context: GroupContext; enrollmentHandle: string }): {
    context: GroupContext;
    runId: string;
    admitted: Promise<GroupNativeExecution>;
    approve(reviewedCommit: string): ReturnType<GroupNativeJournal['approveNativeArtifact']>;
  };
  close(): Promise<void>;
}
export type GroupNativeCapability = 'coordination' | 'private-history' | 'documents';
const capabilities = new WeakMap<
  Runtime,
  Map<GroupNativeCapability, (context: GroupContext) => ClaudeHostTool[]>
>();
/** Root installs the scoped feature owners' existing handlers, never a broad
 * Runtime RPC/catalog. Native CLI tools remain native additions beside these. */
export function registerGroupNativeCapabilities(
  runtime: Runtime,
  kind: GroupNativeCapability,
  factory: (context: GroupContext) => ClaudeHostTool[],
) {
  const slots = capabilities.get(runtime) ?? new Map();
  if (slots.has(kind))
    throw new GroupIsolationBlocked('Scoped capability owner already registered.');
  slots.set(kind, factory);
  capabilities.set(runtime, slots);
  return () => {
    if (slots.get(kind) === factory) slots.delete(kind);
  };
}
export const groupNativeHostRouteSchema = z.strictObject({
  projectId: z.uuid(),
  provider: z.enum(['codex', 'claude']),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  resources: z.strictObject({
    workspace: z.string().min(1).nullable(),
    stateBase: z.string().min(1),
    readResources: z.array(z.string()),
    forbiddenPaths: z.array(z.string()).min(1),
    outbound: z.array(
      z.strictObject({
        host: z.string().min(1),
        ports: z.array(z.number().int().min(1).max(65535)).min(1),
      }),
    ),
  }),
});
const routeSchema = groupNativeHostRouteSchema;
export type GroupNativeHostRoute = z.infer<typeof routeSchema>;
/** Root-reviewed local installation setting, not a browser/API switch. Artifact
 * readiness is independently derived from actual receipts + exact review. */
export function configureGroupNativeRoute(runtime: Runtime, route: GroupNativeHostRoute) {
  const parsed = routeSchema.parse(route);
  runtime.store.project(parsed.projectId);
  mkdirSync(parsed.resources.stateBase, { recursive: true, mode: 0o700 });
  const state = lstatSync(parsed.resources.stateBase);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    state.uid !== process.getuid!() ||
    state.mode & 0o077
  )
    throw new GroupIsolationBlocked('Privately owned native host control state required.');
  parsed.resources.stateBase = realpathSync.native(parsed.resources.stateBase);
  runtime.store.setSetting('group:native-route', parsed);
}
export function createGroupNativeConnector(
  runtime: Runtime,
  {
    directory,
    events,
    scopedTools,
  }: {
    directory: string;
    events: GroupEventRepository;
    scopedTools?: (context: GroupContext) => ClaudeHostTool[];
  },
): GroupNativeConnector {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = realpathSync.native(directory);
  const journal = new GroupNativeJournal(join(root, 'native-identities.sqlite'), events);
  const intents = new GroupNativeIntents(join(root, 'native-intents.sqlite'));
  const bridge = new GroupNativeBridge(journal, runtime.store, runtime.modelPolicy, runtime.quark);
  const active = new Map<
    string,
    {
      handle: GroupNativeContext;
      agentId: string;
      execution?: GroupNativeExecution;
      processing?: Promise<void>;
    }
  >();
  const acceptanceAgents = new Set<string>();
  let gitPort: NativeGitExports | undefined, gitAuthority: NativeGitExportAuthority | undefined;
  const gitExecutions = new Map<string, GroupNativeExecution>();
  const gitAgents = new Set<string>();
  let synthesisPort: (GroupPromotionSynthesis & { close(): Promise<void> }) | undefined;
  let synthesisAuthority: Parameters<GroupNativeConnector['promotionSynthesis']>[0] | undefined;
  let documentsPort: GroupDocumentsNativeRuntime | undefined;
  let documentsRuntime: GroupDocumentsNativeRuntime | undefined;
  let documentsAuthority: GroupDocumentsAuthority | undefined;
  const route = () => routeSchema.parse(runtime.store.getSetting('group:native-route'));
  const blocked = (requestId: string, message: string): GroupNativeSnapshot => ({
    requestId,
    state: 'blocked',
    message,
  });
  const snapshot = (requestId: string, handle: GroupNativeContext): GroupNativeSnapshot => {
    const row = journal.resolve(handle),
      receipt = journal.request(handle, requestId);
    if (!receipt)
      return blocked(requestId, 'Native intent has no execution receipt; inspect before retry.');
    if (receipt.state === 'completed') {
      if (
        receipt.text === undefined ||
        receipt.nativeToolItems === undefined ||
        (row.context.visibility === 'shared' && !receipt.source)
      )
        throw new GroupIsolationBlocked('Complete exact native result/source receipt required.');
      return {
        requestId,
        state: 'completed',
        message: 'Native result retained.',
        result: {
          context: row.context,
          text: receipt.text,
          nativeToolItems: receipt.nativeToolItems,
          ...(receipt.source ? { source: receipt.source } : {}),
        },
      };
    }
    return {
      requestId,
      state:
        receipt.state === 'pending-consent'
          ? 'pending-consent'
          : ['write-intent', 'native-started', 'unknown'].includes(receipt.state)
            ? active.has(requestId)
              ? 'running'
              : 'unknown'
            : receipt.state === 'failed'
              ? 'blocked'
              : 'queued',
      message:
        receipt.reason ??
        (receipt.state === 'pending-consent'
          ? 'Fresh guest native sign-in is required in the owning host.'
          : 'QUARK admission or native completion is pending; uncertain native tools are never repeated.'),
    };
  };
  const resources = (
    handle: GroupNativeContext,
    includeGroupTools = true,
  ): GroupExecutionResources => {
    const configured = route();
    const tools = includeGroupTools
      ? (scopedTools?.(journal.resolve(handle).context) ??
        [...(capabilities.get(runtime)?.values() ?? [])].flatMap((factory) =>
          factory(journal.resolve(handle).context),
        ))
      : [];
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
      throw new GroupIsolationBlocked('Scoped native tool names have multiple owners.');
    return {
      ...configured.resources,
      image: configured.image,
      expiresAt: Date.now() + 60 * 60 * 1000,
      tools,
    };
  };
  let beforeTurn: ((context: GroupContext, requestId: string) => Promise<void>) | undefined;
  const runTurn = async (requestId: string, text: string) => {
    const live = active.get(requestId)!;
    try {
      await beforeTurn?.(journal.resolve(live.handle).context, requestId);
      await live.execution!.turn(text, requestId);
      if (documentsPort && journal.request(live.handle, requestId)?.state === 'completed') {
        try {
          await documentsPort.captureCompletedRequest(requestId, live.execution!);
        } catch {
          runtime.store.event('group.document_capture_pending', null, live.agentId, {
            requestId,
            message: 'Exact document capture needs reconciliation; native completion is retained.',
          });
        }
      }
    } catch {
      const receipt = journal.request(live.handle, requestId)!;
      if (receipt.state !== 'completed')
        journal.requestEvent(live.handle, requestId, {
          state: ['write-intent', 'native-started'].includes(receipt.state) ? 'unknown' : 'failed',
          reason:
            'Native execution did not produce a verified completion. Inspect retained state; never resend uncertain tools.',
        });
    } finally {
      await live.execution!.close();
      active.delete(requestId);
    }
  };
  // Text lives in the host request ledger and this admitted call only. A consent
  // continuation retains it in memory; restart cannot blindly recover/resend it.
  const pendingText = new Map<string, string>();
  const coordination = createGroupNativeCoordination({
    runtime,
    journal,
    bridge,
    route,
    resources,
    active,
    pendingText,
    runTurn,
  });
  const connector: GroupNativeConnector = {
    beforeTurn(callback) {
      if (beforeTurn) throw new GroupIsolationBlocked('Native pre-turn owner already registered.');
      beforeTurn = callback;
    },
    promotionSynthesis(authorize) {
      if (synthesisPort) {
        if (synthesisAuthority !== authorize)
          throw new GroupIsolationBlocked('Native synthesis authority is already bound.');
        return synthesisPort;
      }
      synthesisAuthority = authorize;
      synthesisPort = createGroupPromotionNativeSynthesis({
        path: join(root, 'promotion-native.sqlite'),
        runtime,
        journal,
        bridge,
        events,
        authorize: async (request, signal) => {
          const owner = await authorize(request, signal);
          if (owner.context.visibility !== 'shared' || owner.context.provider !== 'owner')
            throw new GroupIsolationBlocked('Exact shared owner anchor required.');
          const contextId = intents.findBinding(owner);
          if (!contextId)
            throw new GroupIsolationBlocked('Set up the designated writer shared account first.');
          const saved = journal.resolve(journal.reopen(contextId));
          const configured = route(),
            pin = runtime.store.getSetting(`group:native-resources:${saved.agentId}`);
          if (
            JSON.stringify(pin) !==
            JSON.stringify({ image: configured.image, resources: configured.resources })
          )
            throw new GroupIsolationBlocked(
              'Existing writer resource grant must match current native setup.',
            );
          return { sharedContextId: contextId, writerId: owner.writerId };
        },
        availability: () => connector.availability(),
        route: () => {
          const value = route();
          return {
            image: value.image,
            stateBase: value.resources.stateBase,
            forbiddenPaths: value.resources.forbiddenPaths,
            outbound: value.resources.outbound,
          };
        },
      });
      return synthesisPort;
    },
    documents(authority) {
      if (documentsAuthority && documentsAuthority !== authority)
        throw new GroupIsolationBlocked('Native document authority owner is already bound.');
      documentsAuthority = authority;
      if (documentsPort) return documentsPort;
      const current = () =>
        (documentsRuntime ??= createGroupDocumentsNativeRuntime({
          directory: join(root, 'document-runtime'),
          hostJournalPath: join(root, 'host.sqlite'),
          nativeJournalPath: join(root, 'native-identities.sqlite'),
          image: route().image,
          authority,
        }));
      documentsPort = {
        get imageSourceDigest() {
          return current().imageSourceDigest;
        },
        describe: (id) => current().describe(id),
        export: (input) => current().export(input),
        build: (input) => current().build!(input),
        captureCompletedRequest: (id, execution) =>
          current().captureCompletedRequest(id, execution),
        captureCompletedResult: (id, execution) => current().captureCompletedResult(id, execution),
        close: async () => {
          await documentsRuntime?.close();
        },
      };
      return documentsPort;
    },
    gitExports(authorize) {
      if (gitPort) {
        if (authorize !== gitAuthority)
          throw new GroupIsolationBlocked('Native Git authority owner is already bound.');
        return gitPort;
      }
      gitAuthority = authorize;
      gitPort = createGroupNativeGitExports({
        directory: join(root, 'git-exports'),
        authorize: async (request) => {
          events.trustedHostScope(request.scope);
          const grant = await authorize(request),
            context = journal.resolve(journal.reopen(grant.contextId)).context;
          const ownNativeSource =
            request.scope.source.sessionId === context.sessionId &&
            request.scope.source.nativeSessionId === context.nativeSessionId &&
            request.scope.source.provider === context.provider;
          if (!ownNativeSource && !intents.ownsAnchor(request.scope, grant.contextId))
            throw new GroupIsolationBlocked(
              'Git scope must bind the exact owning anchor or native context.',
            );
          return grant;
        },
        context: (contextId) => journal.resolve(journal.reopen(contextId)).context,
        verifyAdmission: (proof) => {
          const handle = journal.reopen(proof.contextId),
            row = journal.resolve(handle);
          const run = runtime.store.run(proof.runId),
            agent = runtime.store.agent(row.agentId);
          const ledger = runtime.quark.runLedger(run.id);
          if (
            run.agentId !== agent.id ||
            !ledger ||
            ledger.agentId !== agent.id ||
            ledger.provider !== agent.provider ||
            ledger.model !== agent.model ||
            !runtime.pulsar.hasReservation(run.id) ||
            !journal.containerReceipt(handle, proof.containerId, 'created') ||
            runtime.store.getSetting(`group:native-stop-intent:${run.id}`) ||
            runtime.store.getSetting(`group:native-stop-unverified:${run.id}`)
          )
            throw new GroupIsolationBlocked(
              'Retained native Git admission proof is invalid or stopping.',
            );
          if (run.status === 'running') {
            const execution =
              gitExecutions.get(run.id) ??
              [...active.values()].find((live) => live.agentId === agent.id && live.execution)
                ?.execution;
            if (
              !execution ||
              execution.gitExportProof().runId !== run.id ||
              execution.gitExportProof().containerId !== proof.containerId ||
              runtime.quark.reason(run)
            )
              throw new GroupIsolationBlocked('Actual live native Git admission required.');
          } else if (
            !['completed', 'interrupted'].includes(run.status) ||
            !journal.containerReceipt(handle, proof.containerId, 'stopped')
          )
            throw new GroupIsolationBlocked(
              'Verified owned namespace stop required for retained Git export.',
            );
        },
        execute: async (_request, grant, consume) => {
          const handle = journal.reopen(grant.contextId),
            row = journal.resolve(handle);
          const live = [...active.values()].find(
            (value) =>
              value.execution &&
              journal.resolve(value.handle).context.sessionId === grant.contextId,
          );
          if (live?.execution) return consume(live.execution);
          // Read-only export of the original guest volume: ordinary central
          // policy/QUARK admission, no native model turn or auth-store transfer.
          const queued = runtime.queueGroupNativeRequest(bridge, handle, resources(handle));
          gitAgents.add(row.agentId);
          const execution = await queued.admitted;
          gitExecutions.set(queued.runId, execution);
          try {
            return await consume(execution);
          } finally {
            await execution.close();
            await execution.closed;
            gitExecutions.delete(queued.runId);
          }
        },
      });
      return gitPort;
    },
    coordination,
    async availability() {
      try {
        const configured = route(),
          actual = await new GroupDockerEngine().availability(configured.image);
        const ready =
          actual.state === 'ready' &&
          journal.artifactReady(configured.image, configured.provider, actual.runtimeSignature);
        return {
          available: ready,
          productionReady: ready,
          authState: ready ? 'per-context' : 'unavailable',
          message: ready
            ? 'Reviewed Linux native route; macOS native app control is unavailable.'
            : actual.state === 'unavailable'
              ? actual.reason
              : 'Real native tools/browser/nesting/crash/explicit-stop acceptance and exact independent review are pending.',
        };
      } catch {
        return {
          available: false,
          productionReady: false,
          authState: 'unavailable',
          message: 'Root-reviewed native installation route is not configured.',
        };
      }
    },
    async submit(raw) {
      const input = nativeHandoffSchema.parse(raw);
      if (input.context.provider !== 'owner')
        throw new GroupIsolationBlocked('Validated owner anchor required.');
      // Persisted membership/context verification, never browser authority.
      events.trustedHostScope({
        groupId: input.context.groupId,
        memberId: input.context.memberId,
        installationId: input.context.installationId,
        visibility: input.context.visibility,
        source: {
          sessionId: input.context.sessionId,
          provider: 'owner',
          nativeSessionId: input.context.nativeSessionId,
          messageId: 'native-host-anchor',
        },
        causalRefs: [],
      });
      const available = await connector.availability();
      if (!available.productionReady) return blocked(input.requestId, available.message);
      const configured = route();
      let contextId = intents.find(input.requestId) ?? intents.findBinding(input),
        handle: GroupNativeContext;
      if (contextId) handle = journal.reopen(contextId);
      else {
        const project = runtime.store.project(configured.projectId);
        const agent = runtime.store.addAgent({
          projectId: project.id,
          parentId: null,
          taskId: null,
          name: input.context.visibility === 'shared' ? 'Group manager' : 'Group private context',
          role: input.context.visibility === 'shared' ? 'manager' : 'implementer',
          cwd: configured.resources.workspace ?? project.root,
          provider: configured.provider,
        });
        handle = journal.issue(input.context, agent.id, configured.provider);
        contextId = journal.resolve(handle).context.sessionId;
        intents.bind(input, contextId);
      }
      const fresh = intents.claim(input, contextId);
      if (!fresh) return connector.inspect({ requestId: input.requestId });
      journal.beginRequest(handle, input.requestId, input.text);
      const nativeAgentId = journal.resolve(handle).agentId;
      const grantKey = `group:native-resources:${nativeAgentId}`,
        grant = { image: configured.image, resources: configured.resources };
      const previousGrant = runtime.store.getSetting(grantKey);
      if (previousGrant && JSON.stringify(previousGrant) !== JSON.stringify(grant))
        throw new GroupIsolationBlocked(
          'Native context resource grant changed; explicit new context required.',
        );
      if (!previousGrant) runtime.store.setSetting(grantKey, grant);
      let queued: ReturnType<Runtime['queueGroupNativeRequest']>;
      try {
        queued = runtime.queueGroupNativeRequest(bridge, handle, resources(handle));
      } catch {
        journal.requestEvent(handle, input.requestId, {
          state: 'failed',
          reason: 'Owning native lane cannot admit this request; no ordinary provider fallback.',
        });
        return snapshot(input.requestId, handle);
      }
      journal.requestEvent(handle, input.requestId, { runId: queued.runId });
      runtime.store.setSetting(`group:native-request:${queued.runId}`, input.requestId);
      const live: {
        handle: GroupNativeContext;
        agentId: string;
        execution?: GroupNativeExecution;
        processing?: Promise<void>;
      } = { handle, agentId: journal.resolve(handle).agentId };
      active.set(input.requestId, live);
      pendingText.set(input.requestId, input.text);
      live.processing = queued.admitted
        .then(async (execution) => {
          live.execution = execution;
          void execution.closed
            .then(() => {
              const receipt = journal.request(handle, input.requestId);
              if (receipt && !['completed', 'failed', 'unknown'].includes(receipt.state))
                journal.requestEvent(handle, input.requestId, {
                  state: ['write-intent', 'native-started'].includes(receipt.state)
                    ? 'unknown'
                    : 'failed',
                  reason:
                    'Owned native namespace closed before a retained completion. Uncertain input is never replayed.',
                });
              active.delete(input.requestId);
              pendingText.delete(input.requestId);
            })
            .catch(() => {});
          journal.requestEvent(handle, input.requestId, { state: 'admitted' });
          if ((await execution.authentication()) !== 'authenticated') {
            journal.requestEvent(handle, input.requestId, { state: 'pending-consent' });
            return;
          }
          pendingText.delete(input.requestId);
          await runTurn(input.requestId, input.text);
        })
        .catch(() => {
          const receipt = journal.request(handle, input.requestId)!;
          if (receipt.state !== 'completed')
            journal.requestEvent(handle, input.requestId, {
              state: 'failed',
              reason: 'Owned native admission/preparation failed; no ordinary provider fallback.',
            });
          active.delete(input.requestId);
          pendingText.delete(input.requestId);
        });
      return snapshot(input.requestId, handle);
    },
    async inspect({ requestId }) {
      const contextId = intents.find(requestId);
      if (!contextId) return blocked(requestId, 'No locally retained native handoff.');
      const handle = journal.reopen(contextId),
        receipt = journal.request(handle, requestId);
      if (
        !active.has(requestId) &&
        receipt &&
        ['queued', 'admitted', 'pending-consent'].includes(receipt.state)
      ) {
        journal.requestEvent(handle, requestId, {
          state: 'unknown',
          reason:
            'Prior host stopped before a native completion. Inspection never re-delivers input; owning consent/recovery must be explicit.',
        });
      }
      // Pre-input consent recovery needs explicit owner authorization; read-only
      // inspection must not open/close a replacement runtime first.
      if (!active.has(requestId) && journal.canRecoverPendingConsent(handle, requestId))
        return snapshot(requestId, handle);
      if (
        !active.has(requestId) &&
        receipt &&
        !receipt.reconciled &&
        ['write-intent', 'native-started', 'unknown'].includes(receipt.state)
      ) {
        // Reconcile through the same real QUARK route and exact owned guest
        // volume. No turn/start, Claude submit, new request or input re-delivery.
        if (!(await connector.availability()).productionReady) return snapshot(requestId, handle);
        let queued: ReturnType<Runtime['queueGroupNativeRequest']>;
        try {
          queued = runtime.queueGroupNativeRequest(bridge, handle, resources(handle));
        } catch {
          return snapshot(requestId, handle);
        }
        journal.requestEvent(handle, requestId, { state: 'unknown', runId: queued.runId });
        const live = { handle, agentId: journal.resolve(handle).agentId } as {
          handle: GroupNativeContext;
          agentId: string;
          execution?: GroupNativeExecution;
          processing?: Promise<void>;
        };
        active.set(requestId, live);
        live.processing = queued.admitted
          .then(async (execution) => {
            live.execution = execution;
            try {
              await execution.reconcile(requestId);
              if (journal.request(handle, requestId)?.state !== 'completed')
                journal.requestEvent(handle, requestId, {
                  state: 'unknown',
                  reconciled: true,
                  reason:
                    'Actual retained native state has no verified completed result for this exact turn; no automatic replay.',
                });
            } finally {
              await execution.close();
              active.delete(requestId);
            }
          })
          .catch(() => {
            active.delete(requestId);
          });
      }
      return snapshot(requestId, handle);
    },
    canRecoverPendingConsent(requestId) {
      const contextId = intents.find(requestId);
      return Boolean(
        contextId &&
          !active.has(requestId) &&
          journal.canRecoverPendingConsent(journal.reopen(contextId), requestId),
      );
    },
    async recoverPendingConsent(raw) {
      const input = nativeHandoffSchema.parse(raw),
        contextId = intents.find(input.requestId);
      if (!contextId) throw new GroupIsolationBlocked('Exact retained native request required.');
      const handle = journal.reopen(contextId),
        row = journal.resolve(handle);
      // Reject changed text/scope/key before admission, including older Ask hashes.
      if (intents.claim(input, contextId))
        throw new GroupIsolationBlocked('Existing native handoff required for recovery.');
      if (active.has(input.requestId)) return snapshot(input.requestId, handle);
      if (
        !journal.canRecoverPendingConsent(handle, input.requestId) ||
        route().provider !== row.context.provider
      )
        throw new GroupIsolationBlocked(
          'Only the same proved unsubmitted native context can reconnect.',
        );
      if (!(await connector.availability()).productionReady)
        throw new GroupIsolationBlocked('Exact reviewed native route is not ready.');
      if (active.has(input.requestId)) return snapshot(input.requestId, handle);
      if (
        [...active.values()].some(
          (live) => journal.resolve(live.handle).context.sessionId === contextId,
        )
      )
        throw new GroupIsolationBlocked('Wait for this same native context’s current operation.');
      const configured = route();
      const pinnedGrant = runtime.store.getSetting(`group:native-resources:${row.agentId}`);
      if (
        !pinnedGrant ||
        JSON.stringify(pinnedGrant) !==
          JSON.stringify({
            image: configured.image,
            resources: configured.resources,
          })
      )
        throw new GroupIsolationBlocked(
          'Retained native resource grant is missing or changed; recovery cannot replace it.',
        );
      const queued = runtime.queueGroupNativeRequest(bridge, handle, resources(handle));
      runtime.store.setSetting(`group:native-request:${queued.runId}`, input.requestId);
      const live: {
        handle: GroupNativeContext;
        agentId: string;
        execution?: GroupNativeExecution;
        processing?: Promise<void>;
      } = { handle, agentId: row.agentId };
      active.set(input.requestId, live);
      live.processing = queued.admitted
        .then(async (execution) => {
          live.execution = execution;
          // prepareExecution returned only after all prior reserved namespaces
          // were verified stopped; the original volume/account was retained.
          journal.restorePendingConsent(handle, input.requestId, input.text, queued.runId);
          pendingText.set(input.requestId, input.text);
          void execution.closed
            .then(() => {
              const receipt = journal.request(handle, input.requestId);
              if (receipt && !['completed', 'failed', 'unknown'].includes(receipt.state))
                journal.requestEvent(handle, input.requestId, {
                  state: ['write-intent', 'native-started'].includes(receipt.state)
                    ? 'unknown'
                    : 'failed',
                  reason:
                    'Owned native namespace closed before completion. No uncertain input is replayed.',
                });
              pendingText.delete(input.requestId);
              active.delete(input.requestId);
            })
            .catch(() => {});
        })
        .catch(async () => {
          pendingText.delete(input.requestId);
          try {
            await live.execution?.close();
          } catch {
            return;
          } // Keep unverified owned stop capability.
          active.delete(input.requestId);
        });
      // Reconnection itself performs no sign-in, native thread/turn/start or input delivery.
      return snapshot(input.requestId, handle);
    },
    ownerExecution(requestId) {
      z.uuid().parse(requestId);
      return active.get(requestId)?.execution ?? null;
    },
    ownerAcceptance(raw) {
      const input = nativeHandoffSchema.parse({
        ...raw,
        requestId: randomUUID(),
        key: randomUUID(),
        text: 'Owner native execution acceptance',
      });
      if (input.context.provider !== 'owner')
        throw new GroupIsolationBlocked('Persisted owner anchor required.');
      events.trustedHostScope({
        groupId: input.context.groupId,
        memberId: input.context.memberId,
        installationId: input.context.installationId,
        visibility: input.context.visibility,
        source: {
          sessionId: input.context.sessionId,
          provider: 'owner',
          nativeSessionId: input.context.nativeSessionId,
          messageId: 'native-host-acceptance',
        },
        causalRefs: [],
      });
      if (intents.findBinding(input))
        throw new GroupIsolationBlocked(
          'Acceptance requires a fresh native binding; inspect prior context instead of repeating.',
        );
      const configured = route(),
        project = runtime.store.project(configured.projectId);
      const agent = runtime.store.addAgent({
        projectId: project.id,
        parentId: null,
        taskId: null,
        name: 'Group native context',
        role: 'implementer',
        cwd: configured.resources.workspace ?? project.root,
        provider: configured.provider,
      });
      const handle = journal.issue(input.context, agent.id, configured.provider);
      const context = journal.resolve(handle).context;
      intents.bind(input, context.sessionId);
      // Acceptance uses native provider tools in a fresh implementer guest. It
      // has no group Work request or manager/child authority for app group tools.
      const queued = runtime.queueGroupExecutionProbe(bridge, handle, resources(handle, false));
      acceptanceAgents.add(agent.id);
      return {
        context,
        ...queued,
        approve: (commit) => journal.approveNativeArtifact(handle, commit, 'linux-guest-tools'),
      };
    },
    async continueAfterConsent(requestId) {
      const live = active.get(requestId),
        text = pendingText.get(requestId);
      if (
        !live?.execution ||
        !text ||
        journal.request(live.handle, requestId)?.state !== 'pending-consent'
      )
        throw new GroupIsolationBlocked('Exact unsubmitted pending guest consent required.');
      if ((await live.execution.authentication()) !== 'authenticated')
        return snapshot(requestId, live.handle);
      pendingText.delete(requestId);
      live.processing = runTurn(requestId, text);
      return snapshot(requestId, live.handle);
    },
    async close() {
      await synthesisPort?.close();
      for (const agentId of new Set([
        ...acceptanceAgents,
        ...gitAgents,
        ...[...active.values()].map((live) => live.agentId),
      ]))
        await runtime.interrupt(agentId);
      for (const live of active.values()) await live.execution?.close();
      await Promise.all([...active.values()].map((live) => live.processing));
      if (active.size)
        throw new GroupIsolationBlocked(
          'Queued group admission must be cancelled through owning Runtime before closing journal.',
        );
      await documentsPort?.close();
      gitPort?.close();
      intents.close();
      journal.close();
    },
  };
  return connector;
}
