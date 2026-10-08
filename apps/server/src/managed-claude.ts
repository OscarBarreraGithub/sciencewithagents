import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import {
  providerDefaultEffort,
  claudeSignInStatusSchema,
  signInRequestSchema,
  type Model,
} from '@dock/shared';
import { openClaudeSignIn } from './claude-sign-in.js';
import type { DynamicTool } from './codex.js';
import { Conflict, Store, type PrivateAgent } from './store.js';
import { beginClaudeUsageSession } from './usage.js';
import {
  ClaudeSession,
  ClaudePreflightError,
  inspectClaudeRuntime,
  readClaudeIdentity,
  readClaudeAccountState,
  type ClaudeEvent,
  type ClaudeHook,
  type ClaudeSessionOptions,
} from './claude-session.js';

export type ManagedClaudeDependencies = {
  binary?: string;
  inspect?: typeof inspectClaudeRuntime;
  identity?: typeof readClaudeIdentity;
  account?: typeof readClaudeAccountState;
  openSignIn?: typeof openClaudeSignIn;
  session?: (options: ClaudeSessionOptions) => ClaudeSession;
};
type Callbacks = {
  charter(agent: PrivateAgent): string;
  tools(agent: PrivateAgent): DynamicTool[];
  invoke(agentId: string, key: string, name: string, input: unknown): Promise<unknown>;
  beforeSubmit?(agentId: string, runId: string, phase?: 'input' | 'fork'): void;
  hook?(
    agentId: string,
    event: ClaudeHook,
    runId: string,
    receipt?: string,
  ): Record<string, unknown>;
  event(agentId: string, event: ClaudeEvent): void;
};

/** Native Claude lifecycle; never pretends to implement Codex RPC or copies credentials. */
export class ManagedClaude {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly starting = new Map<string, Promise<ClaudeSession>>();
  private stopped = false;
  private catalog: Model[] = [];
  private catalogRead: Promise<Model[]> | null = null;
  private readonly binary: string;
  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
    private readonly callbacks: Callbacks,
    private readonly dependencies: ManagedClaudeDependencies = {},
  ) {
    this.binary = dependencies.binary ?? process.env.DOCK_CLAUDE_BIN ?? 'claude';
  }
  async models(): Promise<Model[]> {
    if (this.stopped) throw new Conflict('sciencewithagents is stopping.');
    if (this.catalogRead) return this.catalogRead;
    const pending = this.readModels();
    this.catalogRead = pending;
    try {
      return await pending;
    } finally {
      if (this.catalogRead === pending) this.catalogRead = null;
    }
  }
  async account() {
    // Setup reads only readiness. Worker admission separately verifies affinity.
    if (this.dependencies.identity && !this.dependencies.account) {
      await this.dependencies.identity(this.binary);
      return 'signed-in' as const;
    }
    return (this.dependencies.account ?? readClaudeAccountState)(this.binary);
  }
  signInStatus() {
    return claudeSignInStatusSchema.parse({
      available: process.platform === 'darwin' || !!this.dependencies.openSignIn,
      attempt: this.store.getSetting('setup:claude-native-sign-in'),
    });
  }
  async signIn(raw: unknown) {
    const { key } = signInRequestSchema.parse(raw);
    if (this.stopped) throw new Conflict('Sign-in is stopping. Reopen the app to continue.');
    if (!this.signInStatus().available)
      throw new Conflict('Native sign-in window opening is currently available on Mac.');
    return this.store.externalOperation(`setup:claude-sign-in:${key}`, { key }, async () => {
      if ((await this.account()) !== 'sign-in')
        throw new Conflict(
          'Claude already has an account or custom authentication. This action will not replace it. Check this computer instead.',
        );
      if (this.stopped) throw new Conflict('The app closed before sign-in opened.');
      const attempt = { key, state: 'uncertain', openedAt: new Date().toISOString() };
      this.store.setSetting('setup:claude-native-sign-in', attempt);
      await (this.dependencies.openSignIn ?? openClaudeSignIn)(this.binary);
      this.store.setSetting('setup:claude-native-sign-in', { ...attempt, state: 'opened' });
      return this.signInStatus();
    });
  }
  private async readModels(): Promise<Model[]> {
    const cwd = join(this.dataDir, 'claude-discovery');
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const discovered = await (this.dependencies.inspect ?? inspectClaudeRuntime)(
      this.binary,
      cwd,
      (diagnostic) =>
        this.store.event('provider.auth_diagnostic', null, null, {
          provider: 'claude',
          source: 'model-discovery',
          ...diagnostic,
        }),
    );
    if (this.stopped) throw new Conflict('sciencewithagents is stopping.');
    // Effort is optional native metadata, not a prerequisite for model access.
    // Unreported/unsupported levels leave the provider's own behavior untouched.
    this.catalog = discovered.models.map((model) => ({
      id: model.value,
      label: model.displayName,
      isDefault: model.value === 'default',
      efforts: [
        ...new Set([
          ...(model.supportsEffort !== false ? (model.supportedEffortLevels ?? []) : []),
          providerDefaultEffort,
        ]),
      ],
    }));
    // Keep rolling aliases, and also expose provider-reported concrete IDs for exact pins.
    // Never invent release identifiers or turn a context-size alias into a different variant.
    for (const native of discovered.models) {
      if (
        !native.resolvedModel ||
        native.value.includes('[') ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(native.resolvedModel) ||
        this.catalog.some((model) => model.id === native.resolvedModel)
      )
        continue;
      const labelled =
        discovered.models.find(
          (model) =>
            model.resolvedModel === native.resolvedModel &&
            model.value !== 'default' &&
            !model.value.includes('['),
        ) ?? native;
      const alias = this.catalog.find((model) => model.id === labelled.value)!;
      this.catalog.push({
        ...alias,
        id: native.resolvedModel,
        label: `${labelled.displayName} (exact version)`,
        isDefault: false,
      });
    }
    if (!this.catalog.length)
      throw new Conflict(
        'This Claude installation did not report usable model settings. Nothing was started.',
      );
    return this.catalog;
  }
  get(agentId: string) {
    return this.sessions.get(agentId);
  }
  async prepare(agent: PrivateAgent): Promise<ClaudeSession> {
    if (this.stopped)
      throw new Conflict('sciencewithagents is stopping. Your history is retained.');
    if (agent.provider !== 'claude' || agent.nativeRootId)
      throw new Conflict('This is not a standalone managed Claude conversation.');
    const existing = this.sessions.get(agent.id);
    if (existing) {
      const describe = (tools: { name: string; description: string; inputSchema: unknown }[]) =>
        JSON.stringify(
          tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        );
      if (
        existing.options.charter === this.callbacks.charter(agent) &&
        describe(existing.options.tools ?? []) === describe(this.callbacks.tools(agent))
      )
        return existing;
      // prepare is called at the next managed turn boundary, never to interrupt
      // active work. Rejoin the same native session with the current host contract.
      await this.forget(agent.id);
    }
    const starting = this.starting.get(agent.id);
    if (starting) return starting;
    const promise = this.open(agent);
    this.starting.set(agent.id, promise);
    try {
      return await promise;
    } finally {
      this.starting.delete(agent.id);
    }
  }
  private async open(original: PrivateAgent) {
    const identity = await (this.dependencies.identity ?? readClaudeIdentity)(this.binary);
    if (this.stopped) throw new Conflict('Claude reconnection was cancelled.');
    const agent = this.store.agent(original.id);
    const affinityKey = `claude:account:${agent.id}`;
    const saved = this.store.getSetting(affinityKey);
    if ((saved && saved !== identity.affinity) || (agent.threadId && !saved))
      throw new ClaudePreflightError(
        'account_changed',
        'This Claude conversation belongs to its original local account. Restore that sign-in; sciencewithagents will not share its history with another account.',
      );
    const models = this.catalog.length ? this.catalog : await this.models();
    if (this.stopped || this.store.agent(agent.id).updatedAt !== agent.updatedAt)
      throw new Conflict(
        'The conversation changed during connection. Retry with its current settings.',
      );
    const model = agent.model
      ? models.find((item) => item.id === agent.model)
      : models.find((item) => item.isDefault);
    if (!model || !model.efforts.includes(agent.effort))
      throw new Conflict(
        'Choose a model and thinking level from this computer’s Claude catalog. No turn was sent.',
      );
    if (
      agent.toolPolicy !== 'native' &&
      (agent.mcpServers.length ||
        agent.pluginsEnabled ||
        agent.imageGeneration ||
        agent.webSearch !== 'disabled')
    )
      throw new Conflict(
        'Managed Claude currently supports its restricted project tools only. Use Claude in VS Code for plugins, external MCPs and other native features.',
      );
    const cwd =
      agent.role === 'manager' && !agent.surface
        ? join(this.dataDir, 'managers', agent.id)
        : agent.cwd;
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    // A project manager keeps its private native session folder and also writes
    // the project folder it manages; sessions stay keyed by the original cwd.
    const writableDirectories =
      agent.toolPolicy === 'native' &&
      agent.permission === 'workspace-write' &&
      !agent.resourceAssistant &&
      cwd !== agent.cwd
        ? [agent.cwd]
        : [];
    const threadId = agent.threadId ?? randomUUID();
    const resume =
      this.store.getSetting(`claude:started:${threadId}`) === true ||
      this.store.getSetting(`claude:attempted:${threadId}`) === true ||
      this.store.getSetting(`claude:fork-attempted:${threadId}`) === true;
    const nativeDiscussion = agent.interview?.continuity === 'native-fork';
    if (nativeDiscussion && (!agent.interview?.sourceThreadId || !agent.interview.sourceMessageId))
      throw new Conflict(
        'This discussion has no saved native boundary. Open the original worker and choose Saved evidence only.',
      );
    const forkFrom =
      nativeDiscussion && !resume
        ? {
            sessionId: agent.interview!.sourceThreadId!,
            messageId: agent.interview!.sourceMessageId!,
          }
        : undefined;
    const options: ClaudeSessionOptions = {
      binary: this.binary,
      cwd,
      sessionId: threadId,
      resume,
      forkFrom,
      accountAffinity: identity.affinity,
      writableDirectories,
      inheritNative: agent.toolPolicy === 'native',
      nativeChrome: agent.nativeChrome,
      unattended: agent.toolPolicy === 'native',
      role:
        agent.surface || agent.resourceAssistant?.mode === 'interactive'
          ? agent.permission === 'workspace-write'
            ? 'implementer'
            : 'read-only'
          : agent.role === 'manager'
            ? agent.toolPolicy !== 'native' || agent.permission === 'workspace-write'
              ? 'manager'
              : 'read-only'
            : agent.role === 'implementer' && agent.permission === 'workspace-write'
              ? 'implementer'
              : 'read-only',
      model: model.id,
      authDiagnostic: (diagnostic) =>
        this.store.event('provider.auth_diagnostic', agent.projectId, agent.id, {
          provider: 'claude',
          source: 'managed-session',
          ...diagnostic,
        }),
      effort: agent.effort,
      charter: this.callbacks.charter(agent),
      beforeStart: forkFrom
        ? () => {
            const current = this.store.agent(agent.id);
            const run = current.turnId ? this.store.run(current.turnId) : null;
            if (
              this.stopped ||
              current.threadId !== threadId ||
              !run ||
              run.agentId !== agent.id ||
              run.status !== 'running'
            )
              throw new Conflict(
                'This discussion was cancelled before Claude could copy its history.',
              );
            this.callbacks.beforeSubmit?.(agent.id, run.id, 'fork');
            // Native startup may write the fork before receiving our first question.
            // After an uncertain start, resume only this known target; never fork again.
            this.store.setSetting(`claude:fork-attempted:${threadId}`, true);
          }
        : undefined,
      beforeWrite: (deliveryId) => {
        const current = this.store.agent(agent.id);
        const run = this.store.run(deliveryId);
        if (
          this.stopped ||
          current.threadId !== threadId ||
          current.turnId !== deliveryId ||
          run.agentId !== agent.id ||
          run.status !== 'running'
        )
          throw new Conflict('This submission was cancelled before it reached Claude.');
        this.callbacks.beforeSubmit?.(agent.id, deliveryId);
        this.store.setSetting(`claude:attempted:${threadId}`, true);
      },
      hook: this.callbacks.hook
        ? (event, runId, receipt) => this.callbacks.hook!(agent.id, event, runId, receipt)
        : undefined,
      tools: this.callbacks.tools(agent).map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        invoke: async (input, context) => {
          if (
            this.stopped ||
            context.signal.aborted ||
            this.store.agent(agent.id).threadId !== threadId
          )
            throw new Conflict('That original Claude turn is no longer connected.');
          try {
            const result = await this.callbacks.invoke(
              agent.id,
              `claude-tool:${agent.id}:${threadId}:${context.requestId}`,
              definition.name,
              input,
            );
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    error instanceof Conflict
                      ? error.message
                      : error instanceof ZodError
                        ? `Invalid coordination input: ${error.issues
                            .slice(0, 5)
                            .map(
                              (issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`,
                            )
                            .join('; ')
                            .slice(0, 1000)}. Correct the input before retrying.`
                        : 'Coordination failed. Inspect the recorded task before retrying.',
                },
              ],
              isError: true,
            };
          }
        },
      })),
    };
    const session = this.dependencies.session?.(options) ?? new ClaudeSession(options);
    if (this.stopped) {
      await session.close();
      throw new Conflict('sciencewithagents is stopping.');
    }
    // A durable identity exists before the first process/write. A restart constructs
    // only this inert handle; it never starts --resume until an explicit queued turn.
    this.store.transaction(() => {
      this.store.setSetting(affinityKey, identity.affinity);
      beginClaudeUsageSession(this.store, agent.id, threadId, options.resume || nativeDiscussion);
      if (!agent.threadId) {
        this.store.updateAgent(agent.id, { threadId, model: model.id });
        this.store.observeContext(threadId, 'claude');
        this.store.event('session.started', agent.projectId, agent.id, {
          provider: 'claude',
          continuity: nativeDiscussion ? 'native-fork' : agent.checkpoint ? 'reconstructed' : 'new',
        });
      }
    });
    this.sessions.set(agent.id, session);
    session.on('event', (event: ClaudeEvent) => {
      if (this.stopped || this.sessions.get(agent.id) !== session) return;
      if (event.type === 'session') this.store.setSetting(`claude:started:${threadId}`, true);
      this.callbacks.event(agent.id, event);
    });
    return session;
  }
  async forget(agentId: string) {
    const starting = this.starting.get(agentId);
    if (starting) await starting.catch(() => {});
    const session = this.sessions.get(agentId);
    this.sessions.delete(agentId);
    await session?.close();
  }
  async close() {
    this.stopped = true;
    await this.catalogRead?.catch(() => {});
    await Promise.allSettled(this.starting.values());
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }
}
