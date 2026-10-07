import {
  type GroupPromotionNativeBinding,
  groupPromotionNativeCodexArgs,
  groupPromotionNativeClaudeArgs,
} from './group-promotion-native-synthesis.js';
import { managedMcpConfig } from './mcp.js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { runNativeGitExport, type NativeGitExportRequest } from './group-native-git-export.js';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { groupSourceSchema } from '@dock/shared';
import { CodexRpc, toolCall } from './codex.js';
import {
  ClaudeSession,
  parseClaudeIdentity,
  type ClaudeEvent,
  type ClaudePermission,
  type ClaudeHostTool,
  normalizeClaudeEvent,
} from './claude-session.js';
import { GroupNativeAuth } from './group-native-auth.js';
import { GroupIsolationBlocked } from './group-isolation.js';
import { GroupContainer, type GroupContainerPlan } from './group-container.js';
import type { NativeProviderBoundary } from './native-provider-boundary.js';
import type { GroupNativeContext, GroupNativeJournal, GroupNativeCheck } from './group-native.js';
import type { PrivateAgent, Store } from './store.js';
import { recordCodexUsage, recordClaudeUsage, recordClaudeStepUsage } from './usage.js';

export interface GroupAdmittedCapability {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}
type GroupSource = z.infer<typeof groupSourceSchema>;
export interface GroupExecutionResources {
  readonly image: string;
  readonly workspace: string | null;
  readonly readResources: readonly string[];
  readonly stateBase: string;
  readonly forbiddenPaths: readonly string[];
  readonly expiresAt: number;
  readonly outbound: GroupContainerPlan['outbound'];
  readonly tools?: ClaudeHostTool[];
}
export interface GroupTurnResult {
  readonly text: string;
  readonly nativeToolItems: number;
  readonly source?: GroupSource;
}

/** Local owning-host capability. Real CLI tools, skills and hooks run inside the
 * namespace; no tool catalog replacement, arbitrary RPC or publication endpoint.
 * Only acceptance may create this capability until real compatibility is proved.
 */
export class GroupNativeExecution extends EventEmitter implements GroupAdmittedCapability {
  #adapter: CodexRpc | ClaudeSession | undefined;
  #auth: GroupNativeAuth | undefined;
  #thread: string | undefined;
  #closing: Promise<void> | undefined;
  #resolveClosed!: () => void;
  #busy = false;
  #crashCanary = false;
  #requestId: string | undefined;
  #abort = new AbortController();
  #toolCalls = new Map<string, Promise<unknown>>();
  #descendants: { counts: Map<string, number>; stopped: Promise<void> } | undefined;
  #requests = new Map<string, { id: string | number; method: string }>();
  readonly closed = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });
  get admissionId() {
    return this.runId;
  }
  get provider() {
    return this.agent.provider;
  }
  constructor(
    readonly container: GroupContainer,
    private readonly agent: PrivateAgent,
    private readonly store: Store,
    private readonly runId: string,
    private readonly journal: GroupNativeJournal,
    private readonly handle: GroupNativeContext,
    private readonly admitted: () => void,
    private readonly options: {
      retained?: boolean;
      synthesisBinding?: GroupPromotionNativeBinding;
      workspace?: string;
      tools?: ClaudeHostTool[];
      recordCheck?: (kind: GroupNativeCheck, detail: unknown) => void;
    } = {},
  ) {
    super();
  }
  get workspace() {
    const path = this.options.workspace ?? '/workspace';
    if (
      path !== '/workspace' &&
      !(
        this.options.synthesisBinding
          ? /^\/tmp\/group-synthesis\/[a-f0-9-]{36}$/
          : /^\/workspace\/tasks\/[a-f0-9-]{36}$/
      ).test(path)
    )
      throw new GroupIsolationBlocked('Host-issued task workspace required.');
    return path;
  }
  get synthesisBinding() {
    return this.options.synthesisBinding;
  }
  async initialize() {
    this.admitted();
    await this.container.start();
    if (this.workspace !== '/workspace')
      await this.container.nativeJson([
        'python3',
        '-c',
        "import os,json,sys; os.makedirs(sys.argv[1],mode=0o700,exist_ok=True); print(json.dumps({'created':True}))",
        this.workspace,
      ]);
    void this.container.closed.then(() => this.close()).catch(() => {});
    // No human sign-in before this very route can run native tools, a nested
    // user/mount sandbox and Chromium's sandbox. Failed checks stop the guest.
    z.object({
      uid: z.literal(1000),
      forbiddenDenied: z.literal(true),
      capabilitiesZero: z.literal(true),
      noNewPrivileges: z.literal(true),
    }).parse(await this.container.nativeJson(['python3', '/opt/dock/canary.py', 'privacy']));
    z.object({ nested: z.literal(true), chromiumNativeSandbox: z.literal(true) }).parse(
      await this.container.nativeJson(['python3', '/opt/dock/canary.py', 'nested']),
    );
    this.options.recordCheck?.('guest-sandbox', { privacy: true, nested: true, browser: true });
    if (this.agent.provider !== 'codex') {
      if (!this.options.retained)
        z.object({ loggedIn: z.literal(false) }).parse(
          await this.container.nativeJson(['/usr/local/bin/claude', 'auth', 'status', '--json']),
        );
      return; // Native Claude login is owner-terminal only.
    }
    const socket = await this.container.openCodexSocket();
    const boundary = this.#boundary();
    const adapter = new CodexRpc(
      '/usr/local/bin/codex',
      socket,
      this.workspace,
      false,
      this.agent.pluginsEnabled,
      this.synthesisBinding ? 'off' : 'v2',
      this.agent.webSearch,
      this.agent.imageGeneration,
      true,
      undefined,
      boundary,
    );
    this.#adapter = adapter;
    adapter.on('notification', (method: string, raw: unknown) => {
      if (method === 'thread/tokenUsage/updated') recordCodexUsage(this.store, this.agent.id, raw);
    });
    adapter.on('unavailable', () => {
      if (!this.#crashCanary) void this.close().catch(() => {});
    });
    // Native interaction is surfaced to the owning host; never silently discard
    // an approval/elicitation/tool class or accept an arbitrary browser RPC.
    adapter.on('request', (id: string | number, method: string, params: unknown) => {
      if (method === 'item/tool/call') {
        void this.#hostTool(adapter, id, params).catch(() => this.close().catch(() => {}));
        return;
      }
      const supported = [
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/tool/requestUserInput',
        'mcpServer/elicitation/request',
      ];
      if (!supported.includes(method) || this.#requests.size >= 16) {
        this.emit('interaction-required', { provider: 'codex', method, supported: false });
        void this.close().catch(() => {});
        return;
      }
      const requestId = randomUUID();
      this.#requests.set(requestId, { id, method });
      this.emit('codex-interaction', { requestId, method, params }); // Local owning host only.
    });
    await adapter.start();
    this.#auth = new GroupNativeAuth(adapter, this.admitted, () => this.close(), 'file');
    if (!this.options.retained && (await this.#auth.inspect()) !== 'signed-out')
      throw new GroupIsolationBlocked(
        'Fresh guest unexpectedly already has native authorization. No account reuse.',
      );
  }
  #boundary(): NativeProviderBoundary {
    return {
      codexDirect: true,
      codexSocketManaged: true,
      claudeDirect: true,
      codexArgs: [
        '-c',
        'cli_auth_credentials_store="file"',
        ...(this.synthesisBinding ? groupPromotionNativeCodexArgs() : []),
      ],
      environment: Object.freeze({
        HOME: '/home/agent',
        CODEX_HOME: '/home/agent/.codex',
        CLAUDE_CONFIG_DIR: '/home/agent/.claude',
      }),
      check: async () => {
        this.admitted();
      },
      spawn: (binary, args, options) => {
        this.admitted();
        if (
          !['/usr/local/bin/codex', '/usr/local/bin/claude'].includes(binary) ||
          options.cwd !== this.workspace
        )
          throw new GroupIsolationBlocked(
            'Only the existing host-selected native adapter is admitted.',
          );
        // The listen path is the existing CodexRpc host socket translated to the
        // private guest socket. No provider feature/config/tool list is rewritten.
        const actual = [...args];
        if (binary.endsWith('/codex')) {
          const index = actual.indexOf('--listen');
          if (index < 0 || !actual[index + 1]?.startsWith('unix://'))
            throw new GroupIsolationBlocked('Private native Unix transport required.');
          actual[index + 1] = 'unix:///tmp/group-native.sock';
        }
        return this.container.spawn(
          binary.endsWith('/claude')
            ? [
                'node',
                '/opt/dock/claude-stream.mjs',
                ...actual,
                ...(this.synthesisBinding ? groupPromotionNativeClaudeArgs() : []),
              ]
            : [binary, ...actual],
          this.workspace,
        );
      },
      verifyClaudeIdentity: async () =>
        parseClaudeIdentity(
          await this.container.nativeJson(['/usr/local/bin/claude', 'auth', 'status', '--json']),
        ),
    };
  }
  async authentication() {
    this.admitted();
    if (this.#auth) return this.#auth.inspect();
    try {
      parseClaudeIdentity(
        await this.container.nativeJson(['/usr/local/bin/claude', 'auth', 'status', '--json']),
      );
      return 'authenticated' as const;
    } catch {
      return 'signed-out' as const;
    }
  }
  /** Local owning resource bridge only; no browser path or generic guest exec. */
  gitExportProof() {
    this.admitted();
    return {
      runId: this.runId,
      contextId: this.journal.resolve(this.handle).context.sessionId,
      containerId: this.container.id,
    };
  }
  async exportGitObjects(repository: string, request: NativeGitExportRequest) {
    try {
      return await runNativeGitExport(
        (argv) => this.container.spawn(argv),
        repository,
        request,
        this.admitted,
      );
    } catch (error) {
      // An invalid/uncertain helper must not leave a detached guest writer.
      await this.close();
      throw error;
    }
  }
  beginDeviceSignIn() {
    this.admitted();
    if (!this.#auth)
      throw new GroupIsolationBlocked(
        'Use native Claude subscription login in this owned guest terminal.',
      );
    // Same capability can immediately execute a real turn after native consent.
    return this.#auth.beginDeviceSignIn();
  }
  canRestartDeviceSignIn() {
    return Boolean(
      this.#auth && !this.#closing && !this.#busy && !this.#thread && !this.#requestId,
    );
  }
  restartDeviceSignIn() {
    this.admitted();
    if (!this.canRestartDeviceSignIn())
      throw new GroupIsolationBlocked(
        'Only a retained, unsubmitted Codex sign-in may restart. Inspect uncertain or already submitted native work.',
      );
    return this.#auth!.restartDeviceSignIn();
  }
  /** Concrete owner terminal invocation for Claude. Host only; never browser
   * command selection, a credentials RPC, or an unmanaged provider launch. */
  ownerClaudeLogin() {
    this.admitted();
    if (this.agent.provider !== 'claude' || this.#adapter || this.#busy)
      throw new GroupIsolationBlocked('Fresh owned Claude login required.');
    return {
      executable: this.container.engine.binary,
      args: [
        '--host',
        `unix://${this.container.engine.socket}`,
        '--config',
        this.container.config,
        'exec',
        '--interactive',
        '--tty',
        '--user',
        '1000:1000',
        this.container.id,
        '/usr/local/bin/claude',
        'auth',
        'login',
        '--claudeai',
      ] as const,
    };
  }
  answerClaude(
    requestId: string,
    decision: 'accept' | 'decline',
    answers?: Record<string, string[]>,
  ) {
    this.admitted();
    if (!(this.#adapter instanceof ClaudeSession))
      throw new GroupIsolationBlocked('No owned Claude interaction.');
    this.#adapter.answer(requestId, decision, answers);
  }
  answerCodex(requestId: string, response: unknown) {
    this.admitted();
    const pending = this.#requests.get(requestId);
    if (!pending || !(this.#adapter instanceof CodexRpc))
      throw new GroupIsolationBlocked('Original native interaction unavailable.');
    const schema =
      pending.method === 'item/tool/requestUserInput'
        ? z.strictObject({
            answers: z.record(z.string(), z.strictObject({ answers: z.array(z.string()) })),
          })
        : pending.method === 'mcpServer/elicitation/request'
          ? z.strictObject({
              action: z.enum(['accept', 'decline', 'cancel']),
              content: z.record(z.string(), z.unknown()).nullish(),
            })
          : z.strictObject({ decision: z.enum(['accept', 'decline', 'cancel']) });
    const value = schema.parse(response);
    this.#requests.delete(requestId);
    this.#adapter.respond(pending.id, value);
  }
  #messageSource(nativeId: string) {
    if (this.synthesisBinding) return undefined; // Not a chat/feed source; no private-message alias either.
    if (this.journal.resolve(this.handle).context.visibility === 'shared')
      return this.journal.publicationSource(this.handle, nativeId);
    this.journal.retainPrivateMessage(this.handle, nativeId);
    return undefined;
  }
  async #hostTool(adapter: CodexRpc, rpcId: string | number, raw: unknown) {
    this.admitted();
    const call = toolCall.parse(raw);
    if (
      !this.#busy ||
      !this.#thread ||
      call.threadId !== this.#thread ||
      call.turnId !== this.store.run(this.runId).turnId
    )
      throw new GroupIsolationBlocked('Scoped tool belongs to a different native turn.');
    const tool = this.options.tools?.find((tool) => tool.name === call.tool);
    if (!tool) {
      adapter.respond(rpcId, {
        success: false,
        contentItems: [{ type: 'inputText', text: 'Unknown group capability.' }],
      });
      return;
    }
    let pending = this.#toolCalls.get(call.callId);
    if (!pending) {
      pending = tool.invoke(z.record(z.string(), z.unknown()).parse(call.arguments), {
        sessionId: this.#thread,
        requestId: call.callId,
        signal: this.#abort.signal,
      });
      this.#toolCalls.set(call.callId, pending);
    }
    const result = z
      .object({
        content: z
          .array(z.object({ type: z.literal('text'), text: z.string().max(500000) }))
          .max(100),
        isError: z.boolean().optional(),
      })
      .parse(await pending);
    this.admitted();
    adapter.respond(rpcId, {
      success: !result.isError,
      contentItems: result.content.map((item) => ({ type: 'inputText', text: item.text })),
    });
  }
  async turn(prompt: string, requestId?: string): Promise<GroupTurnResult> {
    this.admitted();
    if (
      this.synthesisBinding &&
      (this.options.tools?.length || this.agent.permission !== 'read-only')
    )
      throw new GroupIsolationBlocked('Synthesis must have no work mutation capabilities.');
    z.string().trim().min(1).max(200000).parse(prompt);
    if (this.#closing || this.#busy)
      throw new GroupIsolationBlocked('Owned native turn is unavailable or busy.');
    if ((await this.authentication()) !== 'authenticated')
      throw new GroupIsolationBlocked(
        'Native guest subscription sign-in required before the real tool turn.',
      );
    if (requestId) {
      const receipt = this.journal.request(this.handle, requestId);
      if (!receipt || !['admitted', 'pending-consent'].includes(receipt.state))
        throw new GroupIsolationBlocked(
          'Durable unsubmitted admitted request required; never replay native write intent.',
        );
    }
    this.#requestId = requestId;
    this.#busy = true;
    try {
      const result =
        this.agent.provider === 'codex'
          ? await this.#codexTurn(prompt)
          : await this.#claudeTurn(prompt);
      if (requestId)
        this.journal.requestEvent(this.handle, requestId, { state: 'completed', ...result });
      return result;
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      this.#busy = false;
      this.#requestId = undefined;
    }
  }
  async #codexTurn(prompt: string) {
    const adapter = this.#adapter as CodexRpc;
    if (!this.#thread) {
      const retainedId = this.options.retained ? this.journal.nativeId(this.handle) : null;
      const response = z.object({ thread: z.object({ id: z.string().min(1) }) }).parse(
        await adapter.request(retainedId ? 'thread/resume' : 'thread/start', {
          ...(retainedId ? { threadId: retainedId } : {}),
          ...(this.synthesisBinding
            ? {
                config: {
                  mcp_servers: await managedMcpConfig(adapter, []),
                  web_search: 'disabled',
                },
              }
            : {}),
          dynamicTools: (this.options.tools ?? []).map(({ name, description, inputSchema }) => ({
            type: 'function',
            name,
            description,
            inputSchema,
            deferLoading: false,
          })),
          cwd: this.workspace,
          sandbox: this.agent.permission === 'read-only' ? 'read-only' : 'danger-full-access',
          approvalPolicy: 'never',
          model: this.agent.model,
          developerInstructions: this.synthesisBinding
            ? 'Synthesize only the source supplied in this turn. Return the requested JSON decision. Do not use tools, read history, mutate work or publish messages.'
            : 'Use only resources mounted for this group. Host project input, when granted, is read-only at /resources/workspace; explicit read grants are /resources/0, /resources/1, etc. Your writable task workspace is the native current working directory in this context’s private guest volume. Copy approved input there when editing. Native homes, hooks and history remain inside this guest; no automatic host export or publication.',
        }),
      );
      this.journal.bindNative(this.handle, response.thread.id);
      this.#thread = response.thread.id;
      this.store.updateAgent(this.agent.id, { threadId: this.#thread });
    }
    return this.#observeCodexTurn(adapter, this.#thread, prompt);
  }
  async #observeCodexTurn(
    adapter: CodexRpc,
    threadId: string,
    prompt: string,
  ): Promise<GroupTurnResult> {
    let text = '',
      nativeToolItems = 0,
      source: GroupSource | undefined;
    let observedTurn: string | undefined;
    let finish!: (value: GroupTurnResult) => void, fail!: (error: Error) => void;
    const completed = new Promise<GroupTurnResult>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    void completed.catch(() => {});
    const unavailable = () =>
      fail(
        new GroupIsolationBlocked(
          'Native execution stopped before completion. Inspect the local receipt; never replay automatically.',
        ),
      );
    const notification = (method: string, raw: unknown) => {
      const parsed = z
        .object({
          threadId: z.literal(threadId),
          turnId: z.string().optional(),
          item: z.unknown().optional(),
          turn: z.unknown().optional(),
        })
        .safeParse(raw);
      if (!parsed.success) return;
      if (method === 'item/completed') {
        if (!observedTurn || !parsed.data.turnId) {
          unavailable();
          return;
        }
        if (parsed.data.turnId !== observedTurn) return;
        const item = z
          .object({ id: z.string(), type: z.string(), text: z.string().optional() })
          .passthrough()
          .safeParse(parsed.data.item);
        if (item.success && item.data.type === 'agentMessage') {
          text += item.data.text ?? '';
          source = this.#messageSource(item.data.id);
        }
        if (
          item.success &&
          [
            'commandExecution',
            'fileChange',
            'mcpToolCall',
            'webSearch',
            'imageGeneration',
            'computerUse',
          ].includes(item.data.type)
        )
          nativeToolItems++;
      }
      if (method === 'turn/started') {
        const turn = z.object({ id: z.string() }).safeParse(parsed.data.turn);
        if (turn.success) {
          if (observedTurn && observedTurn !== turn.data.id) {
            unavailable();
            return;
          }
          observedTurn = turn.data.id;
          if (this.#requestId)
            this.journal.requestEvent(this.handle, this.#requestId, {
              state: 'native-started',
              nativeTurnId: turn.data.id,
            });
          this.store.updateRun(this.runId, { turnId: turn.data.id });
          this.store.updateAgent(this.agent.id, { turnId: turn.data.id });
        }
      }
      if (method === 'turn/completed') {
        const turn = z
          .object({ id: z.string(), status: z.literal('completed') })
          .safeParse(parsed.data.turn);
        if (turn.success && turn.data.id !== observedTurn) return;
        if (turn.success) finish({ text, nativeToolItems, ...(source ? { source } : {}) });
        else unavailable();
      }
    };
    adapter.on('notification', notification);
    adapter.on('unavailable', unavailable);
    void this.closed.then(unavailable);
    // Observe before submission, including completion-before-acknowledgement.
    try {
      if (this.#requestId)
        this.journal.requestEvent(this.handle, this.#requestId, { state: 'write-intent' });
      const ack = z.object({ turn: z.object({ id: z.string() }) }).parse(
        await adapter.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
          model: this.agent.model,
          effort: this.agent.effort,
          clientUserMessageId: this.#requestId ?? randomUUID(),
        }),
      );
      if (observedTurn && observedTurn !== ack.turn.id)
        throw new GroupIsolationBlocked('Native acknowledgement disagreed with the observed turn.');
      if (this.#requestId)
        this.journal.requestEvent(this.handle, this.#requestId, {
          state: 'native-started',
          nativeTurnId: ack.turn.id,
        });
      return await completed;
    } finally {
      adapter.off('notification', notification);
      adapter.off('unavailable', unavailable);
    }
  }
  async #claudeTurn(prompt: string): Promise<GroupTurnResult> {
    if (!this.#adapter) {
      const identity = parseClaudeIdentity(
        await this.container.nativeJson(['/usr/local/bin/claude', 'auth', 'status', '--json']),
      );
      const row = this.journal.resolve(this.handle);
      const previousNativeId = this.journal.nativeId(this.handle);
      this.journal.bindNative(this.handle, row.freshClaudeId!);
      this.#thread = row.freshClaudeId!;
      this.store.updateAgent(this.agent.id, { threadId: this.#thread });
      this.#adapter = new ClaudeSession({
        binary: '/usr/local/bin/claude',
        cwd: this.workspace,
        sessionId: this.#thread,
        resume: !!previousNativeId,
        accountAffinity: identity.affinity,
        role: this.agent.permission === 'read-only' ? 'read-only' : 'implementer',
        inheritNative: true,
        model: this.agent.model!,
        effort: this.agent.effort!,
        charter: this.synthesisBinding
          ? 'Synthesize only the source supplied in this turn. Return the requested JSON decision. Do not use tools, read history, mutate work or publish messages.'
          : 'Use only resources mounted for this group. Host project input, when granted, is read-only at /resources/workspace; read grants are /resources/0, /resources/1, etc. Your writable task workspace is the native current working directory in this context’s guest volume. Copy approved input there when editing. No automatic host export or publication.',
        tools: this.options.tools ?? [],
        beforeWrite: (id) => {
          if (this.#requestId)
            this.journal.requestEvent(this.handle, this.#requestId, {
              state: 'write-intent',
              nativeTurnId: id,
            });
        },
        boundary: this.#boundary(),
        hook: () => {
          this.admitted();
          return {};
        },
      });
    }
    const adapter = this.#adapter as ClaudeSession,
      deliveryId = this.#requestId ?? randomUUID();
    this.store.updateRun(this.runId, { turnId: deliveryId });
    this.store.updateAgent(this.agent.id, { turnId: deliveryId });
    let nativeToolItems = 0,
      finish!: (value: GroupTurnResult) => void,
      fail!: (error: Error) => void;
    const completed = new Promise<GroupTurnResult>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    void completed.catch(() => {});
    const event = (value: ClaudeEvent) => {
      if (value.type === 'tool') nativeToolItems++;
      if (value.type === 'permission')
        this.emit('claude-permission', value.request satisfies ClaudePermission);
      if (value.type === 'usage')
        recordClaudeStepUsage(this.store, this.agent.id, {
          sessionId: value.sessionId,
          deliveryId,
          messageId: value.id,
          usage: value.usage,
        });
      if (value.type === 'result' && value.deliveryId === deliveryId) {
        recordClaudeUsage(this.store, this.agent.id, {
          sessionId: value.sessionId,
          deliveryId,
          resultId: value.id,
          usage: value.usage,
          ...(value.modelUsage ? { modelUsage: value.modelUsage } : {}),
        });
        if (value.status === 'completed') {
          const source = this.#messageSource(value.id);
          finish({ text: value.text, nativeToolItems, ...(source ? { source } : {}) });
        } else fail(new GroupIsolationBlocked('Native Claude turn did not complete.'));
      }
      if (value.type === 'unavailable')
        fail(new GroupIsolationBlocked('Native Claude execution unavailable.'));
    };
    adapter.on('event', event);
    void this.closed.then(() => fail(new GroupIsolationBlocked('Owned namespace closed.')));
    try {
      await adapter.submit({ deliveryId, text: prompt });
      return await completed;
    } finally {
      adapter.off('event', event);
    }
  }
  /** Read the exact same locally owned native turn; this method never submits
   * input. Missing acknowledgements/results remain uncertain, never replayed. */
  async reconcile(requestId: string): Promise<void> {
    this.admitted();
    const receipt = this.journal.request(this.handle, requestId);
    if (!receipt || receipt.state === 'completed') return;
    const nativeId = this.journal.nativeId(this.handle);
    if (!nativeId || !receipt.nativeTurnId) return;
    if (this.agent.provider === 'claude') {
      const saved = z
        .discriminatedUnion('found', [
          z.object({ found: z.literal(false) }),
          z.object({
            found: z.literal(true),
            result: z.unknown(),
            nativeToolItems: z.number().int().nonnegative(),
          }),
        ])
        .parse(
          await this.container.nativeJson([
            'node',
            '/opt/dock/claude-stream.mjs',
            '--read-result',
            nativeId,
            receipt.nativeTurnId,
          ]),
        );
      if (!saved.found) return;
      const result = normalizeClaudeEvent(saved.result, receipt.nativeTurnId).find(
        (event) => event.type === 'result',
      );
      if (
        !result ||
        result.type !== 'result' ||
        result.sessionId !== nativeId ||
        result.deliveryId !== receipt.nativeTurnId ||
        result.status !== 'completed'
      )
        return;
      recordClaudeUsage(this.store, this.agent.id, {
        sessionId: nativeId,
        deliveryId: receipt.nativeTurnId,
        resultId: result.id,
        usage: result.usage,
        ...(result.modelUsage ? { modelUsage: result.modelUsage } : {}),
      });
      const source = this.#messageSource(result.id);
      this.journal.requestEvent(this.handle, requestId, {
        state: 'completed',
        text: result.text,
        nativeToolItems: saved.nativeToolItems,
        ...(source ? { source } : {}),
      });
      return;
    }
    if (!(this.#adapter instanceof CodexRpc)) return;
    const response = z
      .object({
        thread: z.object({
          id: z.literal(nativeId),
          turns: z.array(
            z.object({
              id: z.string(),
              status: z.string(),
              items: z.array(
                z
                  .object({ id: z.string(), type: z.string(), text: z.string().optional() })
                  .passthrough(),
              ),
            }),
          ),
        }),
      })
      .parse(
        await this.#adapter.request('thread/read', { threadId: nativeId, includeTurns: true }),
      );
    const turn = response.thread.turns.find((turn) => turn.id === receipt.nativeTurnId);
    if (!turn || turn.status !== 'completed') return;
    const messages = turn.items.filter((item) => item.type === 'agentMessage');
    if (!messages.length) return;
    const source = this.#messageSource(messages.at(-1)!.id);
    this.journal.requestEvent(this.handle, requestId, {
      state: 'completed',
      text: messages.map((item) => item.text ?? '').join(''),
      nativeToolItems: turn.items.filter((item) =>
        [
          'commandExecution',
          'fileChange',
          'mcpToolCall',
          'webSearch',
          'imageGeneration',
          'computerUse',
        ].includes(item.type),
      ).length,
      ...(source ? { source } : {}),
    });
  }
  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      // Kernel namespace stop is authoritative. Failure retains the capability
      // and QUARK reservation; never claim completion after an unproved stop.
      this.#abort.abort();
      await this.container.close();
      this.#auth?.disposeObservation();
      await this.#adapter?.close();
      this.#resolveClosed();
    })());
  }
  async archiveAndClose() {
    this.admitted();
    if (this.#adapter instanceof CodexRpc && this.#thread)
      await this.#adapter.request('thread/archive', { threadId: this.#thread });
    await this.close();
  }
  startDescendantCanary() {
    this.admitted();
    if (this.#busy)
      throw new GroupIsolationBlocked('Wait for the native turn before the owned stop canary.');
    if (this.#descendants)
      throw new GroupIsolationBlocked('Owned descendant canary already started.');
    const child = this.container.spawn(['python3', '/opt/dock/canary.py', 'descendants']);
    const counts = new Map<string, number>();
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      if (line.length > 256) return;
      try {
        const value = z
          .object({
            kind: z.enum(['fork', 'setsid', 'double-fork']),
            heartbeat: z.number().int().nonnegative(),
          })
          .safeParse(JSON.parse(line));
        if (value.success) counts.set(value.data.kind, value.data.heartbeat);
      } catch {
        /* Only synthetic fixed-format heartbeats. */
      }
    });
    child.stderr?.on('data', () => {});
    const stopped = new Promise<void>((resolve) => {
      child.once('close', () => {
        lines.close();
        resolve();
      });
    });
    this.#descendants = { counts, stopped };
    return child;
  }
  /** Real provider acceptance: observe a native tool event AND read back only
   * the synthetic nonce file through the same owned guest. A textual claim or
   * fake adapter test alone cannot satisfy this method in the real host route. */
  async acceptanceToolTurn() {
    this.admitted();
    const nonce = randomUUID();
    const result = await this.turn(
      'Use your native shell tool to write /workspace/native-canary.json containing exactly ' +
        JSON.stringify({ canary: 'group-native-ok', nonce }) +
        ', then read it with that tool and report success.',
    );
    const receipt = z
      .object({ toolReceiptVerified: z.literal(true) })
      .parse(await this.container.nativeJson(['python3', '/opt/dock/canary.py', 'receipt', nonce]));
    if (result.nativeToolItems < 1)
      throw new GroupIsolationBlocked('No real native tool event was observed.');
    this.options.recordCheck?.('native-tool', {
      ...receipt,
      nativeToolItems: result.nativeToolItems,
    });
    return {
      ...receipt,
      nativeToolItems: result.nativeToolItems,
      provider: this.agent.provider,
      model: this.agent.model,
      effort: this.agent.effort,
      ...(result.source ? { source: result.source } : {}),
    };
  }
  async #requireDescendants() {
    const observed = this.#descendants;
    if (!observed)
      throw new GroupIsolationBlocked('Start the actual descendant heartbeat canary first.');
    for (let attempt = 0; attempt < 30; attempt++) {
      if (['double-fork', 'fork', 'setsid'].every((kind) => (observed.counts.get(kind) ?? 0) >= 2))
        return;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new GroupIsolationBlocked('All three actual changing descendant heartbeats required.');
  }
  async #recordStop(kind: 'namespace-crash' | 'namespace-explicit') {
    const observed = this.#descendants!;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        observed.stopped,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new GroupIsolationBlocked('Owned descendant stream did not close.')),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const before = JSON.stringify([...observed.counts]);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    if (JSON.stringify([...observed.counts]) !== before)
      throw new GroupIsolationBlocked('Owned descendant heartbeats survived stop.');
    this.options.recordCheck?.(kind, {
      stopped: true,
      descendantClasses: ['double-fork', 'fork', 'setsid'],
      heartbeatsCeased: true,
    });
  }
  async explicitStopCanary() {
    this.admitted();
    await this.#requireDescendants();
    await this.archiveAndClose();
    await this.#recordStop('namespace-explicit');
    return { stopped: true as const, heartbeatsCeased: true as const };
  }
  async crashStopCanary() {
    this.admitted();
    if (this.#busy)
      throw new GroupIsolationBlocked('Wait for the real native turn before crash acceptance.');
    if (this.#adapter instanceof CodexRpc && this.#thread)
      await this.#adapter.request('thread/archive', { threadId: this.#thread });
    await this.#requireDescendants();
    this.#crashCanary = true;
    this.#auth?.disposeObservation();
    try {
      const result = await this.container.crashStopCanary();
      if (!result.stoppedWithoutHostKill)
        throw new GroupIsolationBlocked(
          'Guest self-stop failed; host cleanup does not prove crash acceptance.',
        );
      await this.#recordStop('namespace-crash');
      return result;
    } finally {
      await this.close();
    }
  }
}
