import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  effortSchema,
  nativeRateLimitTypes,
  providerDefaultEffort,
  nativeCommandNameSchema,
} from '@dock/shared';
import type { NativeProviderBoundary } from './native-provider-boundary.js';
import {
  claudeAuthDiagnosticReader,
  claudeAuthScanner,
  type ClaudeAuthDiagnostic,
  type ClaudeSessionAuthDiagnostic,
} from './claude-auth-diagnostics.js';

// First-party protocol evidence, not Codex RPC emulation:
// https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py
// https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/transport/subprocess_cli.py
// Kept private: browsers cannot choose CLI paths, arguments, MCP transports or RPC methods.
const jsonObject = z.record(z.string(), z.unknown());
const id = z.string().min(1).max(256);
const uuid = z.uuid();
const frameLimit = 4 * 1024 * 1024;
const coordinationName = /^dock_[a-z_]+$/;
const execute = promisify(execFile);

export type ClaudePreflightCode =
  | 'signed_out'
  | 'unsupported_auth'
  | 'malformed_status'
  | 'timeout'
  | 'unavailable'
  | 'account_changed'
  | 'conflicting_environment';
/** Sanitized native metadata failure, thrown only before this turn's input write. */
export class ClaudePreflightError extends Error {
  constructor(
    readonly code: ClaudePreflightCode,
    message: string,
  ) {
    super(message);
    this.name = 'ClaudePreflightError';
  }
}

/** Refuse routing/billing overrides instead of dropping credentials or silently
 * switching the owner's account. Values are never included in errors or logs.
 * Names/precedence: https://code.claude.com/docs/en/env-vars
 */
export function assertClaudeSubscriptionEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const credentialsOrRoutes =
    /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS|AWS_API_KEY|AWS_BASE_URL|BEDROCK_BASE_URL|BEDROCK_MANTLE_BASE_URL|FOUNDRY_API_KEY|FOUNDRY_AUTH_TOKEN|FOUNDRY_BASE_URL|FOUNDRY_RESOURCE|VERTEX_BASE_URL)|AWS_BEARER_TOKEN_BEDROCK|CLAUDE_CODE_OAUTH_(?:TOKEN|REFRESH_TOKEN|SCOPES))$/;
  const providerFlags =
    /^CLAUDE_CODE_(?:USE_(?:ANTHROPIC_AWS|BEDROCK|VERTEX|FOUNDRY|MANTLE)|SKIP_(?:ANTHROPIC_AWS|BEDROCK|VERTEX|FOUNDRY|MANTLE)_AUTH|PROVIDER_MANAGED_BY_HOST|SIMPLE)$/;
  for (const [name, value] of Object.entries(env)) {
    if (!value?.trim()) continue;
    if (
      credentialsOrRoutes.test(name) ||
      (providerFlags.test(name) && !/^(?:0|false|no|off)$/i.test(value.trim()))
    )
      throw new ClaudePreflightError(
        'conflicting_environment',
        'Conflicting Claude authentication, API billing or provider-routing environment is configured. Managed Claude requires the existing local subscription sign-in; no request was sent.',
      );
  }
}

export type ClaudeIdentity = { affinity: string; authMethod: 'claude.ai'; provider: 'firstParty' };

/** Read the native CLI's sanitized identity projection, never its credential files. */
export function parseClaudeIdentity(value: unknown): ClaudeIdentity {
  const summary = z.object({ loggedIn: z.boolean() }).passthrough().safeParse(value);
  if (summary.success && !summary.data.loggedIn)
    throw new ClaudePreflightError(
      'signed_out',
      'Claude reports that it is signed out of its local subscription on this computer. Sign in through Claude, then retry this message. No model request was sent.',
    );
  if (
    summary.success &&
    ((typeof summary.data.authMethod === 'string' && summary.data.authMethod !== 'claude.ai') ||
      (typeof summary.data.apiProvider === 'string' && summary.data.apiProvider !== 'firstParty'))
  )
    throw new ClaudePreflightError(
      'unsupported_auth',
      'Claude is using a different authentication or billing route. Restore the local subscription sign-in, then retry this message. No model request was sent.',
    );
  const status = z
    .object({
      loggedIn: z.literal(true),
      authMethod: z.literal('claude.ai'),
      apiProvider: z.literal('firstParty'),
      email: z.string().trim().min(1),
      orgId: z.string().trim().min(1),
    })
    .safeParse(value);
  if (!status.success)
    throw new ClaudePreflightError(
      'malformed_status',
      'Claude returned an incomplete subscription sign-in status. Its account could not be verified; no model request was sent. Retry this message after checking the connection.',
    );
  return {
    affinity: createHash('sha256')
      .update(
        JSON.stringify([
          status.data.authMethod,
          status.data.apiProvider,
          status.data.email.toLowerCase(),
          status.data.orgId,
        ]),
      )
      .digest('hex'),
    authMethod: 'claude.ai',
    provider: 'firstParty',
  };
}
type IdentityCommand = (binary: string) => Promise<{ stdout: string }>;
const nativeIdentityCommand: IdentityCommand = (binary) =>
  execute(binary, ['auth', 'status', '--json'], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
export async function readClaudeIdentity(
  binary: string,
  command: IdentityCommand = nativeIdentityCommand,
): Promise<ClaudeIdentity> {
  // A local metadata timeout can be transient (for example a busy keychain).
  // Retry that read once, before any provider input. Never retry signed-out,
  // malformed or changed-account results, and never replay a model turn here.
  try {
    return await readClaudeIdentityOnce(binary, command);
  } catch (error) {
    if (!(error instanceof ClaudePreflightError) || error.code !== 'timeout') throw error;
    return readClaudeIdentityOnce(binary, command);
  }
}
async function readClaudeIdentityOnce(
  binary: string,
  command: IdentityCommand,
): Promise<ClaudeIdentity> {
  assertClaudeSubscriptionEnvironment();
  try {
    const { stdout } = await command(binary);
    try {
      return parseClaudeIdentity(JSON.parse(stdout));
    } catch (error) {
      if (error instanceof ClaudePreflightError) throw error;
      throw new ClaudePreflightError(
        'malformed_status',
        'Claude returned an unreadable sign-in status. Its account could not be verified; no model request was sent. Retry this message after checking the connection.',
      );
    }
  } catch (error) {
    if (error instanceof ClaudePreflightError) throw error;
    const failed = (error ?? {}) as {
      code?: unknown;
      stdout?: unknown;
      killed?: unknown;
      signal?: unknown;
    };
    if (failed.code === 1 && typeof failed.stdout === 'string') {
      try {
        const status: unknown = JSON.parse(failed.stdout);
        if (z.object({ loggedIn: z.literal(false) }).safeParse(status).success)
          return parseClaudeIdentity(status);
      } catch (parsed) {
        if (parsed instanceof ClaudePreflightError) throw parsed;
      }
    }
    const timeout = failed.code === 'ETIMEDOUT' || (failed.killed === true && !!failed.signal);
    throw new ClaudePreflightError(
      timeout ? 'timeout' : 'unavailable',
      timeout
        ? 'Claude’s sign-in check timed out. This does not mean you are signed out. No model request was sent; retry this message.'
        : 'Claude’s sign-in check is unavailable. Its account could not be verified; no model request was sent. Check the connection, then retry this message.',
    );
  }
}

/** Setup distinguishes a verified signed-out CLI from an unavailable command. */
export function claudeAccountState(value: unknown): 'signed-in' | 'sign-in' | 'custom' {
  const status = z.object({ loggedIn: z.boolean() }).passthrough().parse(value);
  if (!status.loggedIn) return 'sign-in';
  if (status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty') return 'custom';
  parseClaudeIdentity(status);
  return 'signed-in';
}
export async function readClaudeAccountState(binary: string) {
  assertClaudeSubscriptionEnvironment();
  try {
    const { stdout } = await execute(binary, ['auth', 'status', '--json'], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return claudeAccountState(JSON.parse(stdout));
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown };
    // The native CLI can exit 1 for a valid signed-out status. Other errors do
    // not prove it is safe to initiate a new account sign-in.
    try {
      if (
        failed.code === 1 &&
        typeof failed.stdout === 'string' &&
        claudeAccountState(JSON.parse(failed.stdout)) === 'sign-in'
      )
        return 'sign-in' as const;
    } catch {
      /* Never project a native command's raw output or parse error. */
    }
    throw new Error(
      'Claude sign-in status could not be verified. Check its native installation and retry.',
    );
  }
}

export type ClaudeHostTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  invoke(
    input: Record<string, unknown>,
    context: {
      sessionId: string;
      requestId: string;
      signal: AbortSignal;
    },
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
};
export type ClaudePermission = {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
};
// Native AskUserQuestion uses question text as its answer key. Keep the complete
// original input for forwarding; this projection only supplies the app's form.
const questionInput = z.object({
  questions: z
    .array(
      z.object({
        question: z
          .string()
          .min(1)
          .max(8000)
          .refine((value) => !!value.trim()),
        header: z.string().min(1).max(500),
        options: z
          .array(z.object({ label: z.string().min(1).max(8000), description: z.string() }))
          .max(50),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(16),
});
export function claudeQuestions(input: unknown) {
  const { questions } = questionInput.parse(input);
  if (new Set(questions.map((q) => q.question)).size !== questions.length)
    throw new Error('Claude sent duplicate question text. Ask it to rephrase the questions.');
  return questions.map((question, index) => ({
    ...question,
    id: `question-${index}`,
    multiSelect: question.multiSelect ?? false,
    allowCustom: true,
  }));
}
export function claudeQuestionInput(
  input: Record<string, unknown>,
  answers?: Record<string, string[]>,
) {
  const questions = claudeQuestions(input);
  if (Object.keys(answers ?? {}).some((key) => !questions.some((q) => q.id === key)))
    throw new Error('These answers do not belong to the original questions.');
  const pairs = questions.map((q) => {
    const values = answers?.[q.id];
    if (!values?.length || values.some((value) => !value.trim() || value.length > 8000))
      throw new Error('Answer each question before submitting.');
    if ((!q.multiSelect && values.length !== 1) || values.length > 51)
      throw new Error('Choose one answer unless the question allows multiple selections.');
    return [q.question, [...new Set(values)].join(', ')] as const;
  });
  return { ...input, answers: Object.fromEntries(pairs) };
}
export type ClaudeEvent =
  | {
      type: 'session';
      sessionId: string;
      model: string | null;
      tools: string[];
      commands?: string[];
    }
  | { type: 'boundary'; sessionId: string; deliveryId: string; messageId: string | null }
  | {
      type: 'message';
      id: string;
      role: 'assistant' | 'user';
      text: string;
      parentToolUseId?: string;
    }
  | {
      type: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown>;
      parentToolUseId?: string;
    }
  | { type: 'tool_result'; id: string; text: string; isError: boolean; parentToolUseId?: string }
  | {
      type: 'usage';
      id: string;
      sessionId: string;
      deliveryId: string;
      usage: ClaudeUsage;
      parentToolUseId?: string;
    }
  | { type: 'permission'; request: ClaudePermission }
  | { type: 'permission_cancelled'; requestId: string }
  | { type: 'unowned_result'; id: string; sessionId: string; originKind: string }
  | {
      type: 'result';
      id: string;
      deliveryId: string | null;
      sessionId: string;
      status: 'completed' | 'failed' | 'interrupted';
      text: string;
      usage: ClaudeUsage | null;
      modelUsage?: Record<string, ClaudeUsage>;
      helpersPending?: boolean;
    }
  | {
      // Typed primary-window rejection only; never raw payload, overage or wording.
      type: 'rate_limit';
      id: string;
      sessionId: string;
      deliveryId: string;
      rateLimitType: (typeof nativeRateLimitTypes)[number];
      resetsAtSeconds: number;
    }
  | { type: 'unavailable'; message: string };
export type ClaudeUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
};
const observedHooks = [
  'SessionStart',
  'PreCompact',
  'PostCompact',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
] as const;
const hookSchema = z.object({
  session_id: uuid,
  hook_event_name: z.enum(observedHooks),
  source: z.string().max(80).optional(),
  trigger: z.string().max(80).optional(),
  compact_summary: z.string().max(200_000).optional(),
  agent_id: id.optional(),
  agent_type: z.string().max(500).optional(),
  transcript_path: z.string().max(8192).optional().catch(undefined),
  agent_transcript_path: z.string().max(8192).optional().catch(undefined),
  tool_use_id: id.optional(),
  tool_name: id.optional(),
  tool_input: jsonObject.optional(),
  tool_response: z.unknown().optional(),
  error: z.string().optional(),
  last_assistant_message: z.string().optional(),
});
export type ClaudeHook = z.infer<typeof hookSchema>;
/** Native Agent/Task returns a structured report and run total. Its usage breakdown
 * can describe a different scope, so do not infer output tokens from that object. */
export function claudeHelperResult(event: ClaudeHook) {
  if (
    event.hook_event_name !== 'PostToolUse' ||
    !['Agent', 'Task'].includes(event.tool_name ?? '') ||
    !event.tool_use_id
  )
    return null;
  const result = z
    .object({
      status: z.literal('completed'),
      agentId: id,
      totalTokens: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .catch(undefined),
      content: z.array(jsonObject).max(1000).optional().catch(undefined),
    })
    .safeParse(event.tool_response);
  return result.success
    ? {
        agentId: result.data.agentId,
        totalTokens: result.data.totalTokens,
        text: result.data.content
          ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n'),
        toolId: event.tool_use_id,
      }
    : null;
}
/** Shared by both providers' native writing roles; scope is intent, not containment. */
export const nativeFullAccessNote =
  "You run with native full access: commands, browsers and SSH use the owner's own user permissions without approval prompts. Your project folder is your intended working scope, not a hard boundary; keep changes there unless the owner asked otherwise.";

export type ClaudeSessionOptions = {
  /** Host-only whole-process boundary. Native tool configuration is preserved. */
  boundary?: NativeProviderBoundary;
  binary: string;
  cwd: string;
  sessionId: string;
  resume: boolean;
  /** Native copy through an observed root reply; never a hand-edited transcript. */
  forkFrom?: { sessionId: string; messageId: string };
  /** Already pinned in durable host storage; never taken from a browser request. */
  accountAffinity: string;
  role: 'manager' | 'read-only' | 'implementer';
  inheritNative?: boolean;
  /** Internal supplied-evidence helpers have no native tools, including file reads. */
  nativeTools?: 'off';
  /** Official per-session Chrome opt-in; omission preserves native preferences. */
  nativeChrome?: 'inherit' | 'enabled';
  /** Native scoped execution; permissions needing a person are denied, questions remain visible. */
  unattended?: boolean;
  model: string;
  effort: string;
  charter: string;
  tools: ClaudeHostTool[];
  /** Durable fork-attempt fence immediately before process creation. */
  beforeStart?: () => void;
  /** Synchronous host receipt/attempt fence, after startup but before native input I/O. */
  beforeWrite?: (deliveryId: string) => void;
  /** Observe native events and gate continued work without defining its tools. */
  hook?: (event: ClaudeHook, deliveryId: string, receipt?: string) => Record<string, unknown>;
  /** Host-chosen working folders a writing role also uses, such as a manager's project folder. */
  writableDirectories?: string[];
  /** Fixed native auth-failure observations only; never raw stderr or a retry. */
  authDiagnostic?: (diagnostic: ClaudeSessionAuthDiagnostic) => void;
};
export type ClaudeChannel = {
  readonly ownedProcessId?: number | null;
  input: Writable;
  output: Readable;
  exited: Promise<number | null>;
  close(): Promise<void>;
};
export type ClaudeSessionDependencies = {
  identity?: (binary: string) => Promise<ClaudeIdentity>;
  spawn?: (
    binary: string,
    args: string[],
    cwd: string,
    authDiagnostic?: (diagnostic: ClaudeAuthDiagnostic) => void,
  ) => ClaudeChannel;
  timeoutMs?: number;
};
export class ClaudeSubmissionCancelled extends Error {
  constructor() {
    super('Claude start was cancelled before submission. No message was sent.');
  }
}
const modelSchema = z.object({
  value: z.string().min(1).max(200),
  resolvedModel: z.string().max(200).optional(),
  displayName: z.string().max(300),
  description: z.string().max(2000).default(''),
  supportsEffort: z.boolean().optional().catch(undefined),
  supportedEffortLevels: z.array(effortSchema).optional().catch(undefined),
});
export type ClaudeModel = z.infer<typeof modelSchema>;

/** Disposable no-turn initialization only; never use an owner's saved context to discover models. */
export async function inspectClaudeRuntime(
  binary: string,
  cwd: string,
  authDiagnostic?: (diagnostic: ClaudeSessionAuthDiagnostic) => void,
) {
  const identity = await readClaudeIdentity(binary);
  const session = new ClaudeSession({
    binary,
    cwd,
    sessionId: randomUUID(),
    resume: false,
    accountAffinity: identity.affinity,
    role: 'manager',
    inheritNative: true,
    model: 'default',
    effort: providerDefaultEffort,
    charter: 'Capability discovery only. No user turn will be submitted.',
    tools: [],
    authDiagnostic,
  });
  try {
    return { identity, models: await session.inspectFreshModels() };
  } finally {
    await session.close();
  }
}

export function claudeArguments(options: ClaudeSessionOptions): string[] {
  uuid.parse(options.sessionId);
  if (options.forkFrom) {
    uuid.parse(options.forkFrom.sessionId);
    uuid.parse(options.forkFrom.messageId);
    if (options.resume || options.forkFrom.sessionId === options.sessionId)
      throw new Error('A Claude discussion must fork into a distinct new session.');
  }
  z.enum(['manager', 'read-only', 'implementer']).parse(options.role);
  effortSchema.parse(options.effort);
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(options.accountAffinity);
  if (
    !isAbsolute(options.cwd) ||
    !options.binary ||
    !options.charter.trim() ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/.test(options.model)
  )
    throw new Error('Invalid private Claude session configuration.');
  if (
    options.tools.length > 20 ||
    new Set(options.tools.map((tool) => tool.name)).size !== options.tools.length ||
    options.tools.some((tool) => !coordinationName.test(tool.name))
  )
    throw new Error('Invalid coordination tool catalog.');
  for (const tool of options.tools) jsonObject.parse(tool.inputSchema);
  if (
    (options.writableDirectories ?? []).length > 4 ||
    (options.writableDirectories ?? []).some(
      (path) => !isAbsolute(path) || path.length > 400 || /[\0\n\r*?[\]]/.test(path),
    )
  )
    throw new Error('Invalid private Claude session configuration.');
  const writing = options.role !== 'read-only';
  const builtins =
    options.nativeTools === 'off' || options.role === 'manager'
      ? []
      : options.role === 'implementer'
        ? ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write']
        : ['Read', 'Glob', 'Grep'];
  return [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--replay-user-messages',
    ...(options.inheritNative
      ? options.role === 'read-only'
        ? ['--permission-mode', 'plan']
        : options.unattended
          ? // Documented full native access for writing roles; questions still reach the host.
            ['--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions']
          : []
      : ['--permission-mode', 'manual']),
    '--permission-prompt-tool',
    'stdio',
    '--permission-prompts',
    'host',
    ...(options.inheritNative && options.nativeChrome === 'enabled' ? ['--chrome'] : []),
    ...(!options.inheritNative
      ? [
          '--restricted',
          '--setting-sources=',
          '--no-chrome',
          '--disable-slash-commands',
          '--strict-mcp-config',
        ]
      : []),
    '--mcp-config',
    JSON.stringify({ mcpServers: { dock: { type: 'sdk', name: 'dock' } } }),
    ...(!options.inheritNative ? ['--tools', builtins.join(',')] : []),
    '--allowedTools',
    options.tools.map((tool) => `mcp__dock__${tool.name}`).join(','),
    ...(!options.inheritNative
      ? [
          '--settings',
          JSON.stringify({
            // Native observation uses an SDK callback on this private connection.
            // Ambient configuration migration is separate from this launch contract.
            autoMemoryEnabled: false,
            disableWorkflows: true,
            permissions: { ask: builtins, disableBypassPermissionsMode: 'disable' },
            sandbox: { autoAllowBashIfSandboxed: false },
          }),
        ]
      : options.unattended && !writing
        ? [
            '--settings',
            JSON.stringify({
              // The native command parser can still ask for harmless variable
              // expansions. The strict OS sandbox keeps read-only Bash read-only.
              permissions: { allow: ['Read(//**)', 'WebFetch', 'WebSearch'] },
              sandbox: {
                enabled: true,
                failIfUnavailable: true,
                autoAllowBashIfSandboxed: true,
                allowUnsandboxedCommands: false,
                filesystem: {
                  disabled: false,
                  // Plan mode blocks file-edit tools, but sandboxed Bash still
                  // inherits a writable cwd unless the OS sandbox denies it.
                  denyWrite: [options.cwd],
                },
                network: { allowedDomains: ['*'] },
              },
            }),
          ]
        : options.unattended && options.writableDirectories?.length
          ? [
              '--settings',
              JSON.stringify({
                permissions: { additionalDirectories: options.writableDirectories },
              }),
            ]
          : []),
    '--model',
    options.model,
    ...(options.effort === providerDefaultEffort ? [] : ['--effort', options.effort]),
    options.inheritNative ? '--append-system-prompt' : '--system-prompt',
    [
      options.charter,
      ...(options.inheritNative && options.unattended && options.role === 'read-only'
        ? [
            'Use the registered Dock coordination tools directly without exiting plan mode or asking for routine approval. They enforce your host assignment scope; recording an assigned review verdict is authorized coordination even in plan mode.',
          ]
        : []),
      ...(options.inheritNative && options.unattended && writing ? [nativeFullAccessNote] : []),
    ].join('\n\n'),
    ...(options.forkFrom
      ? [
          `--resume=${options.forkFrom.sessionId}`,
          '--fork-session',
          `--session-id=${options.sessionId}`,
          `--resume-session-at=${options.forkFrom.messageId}`,
        ]
      : options.resume
        ? [`--resume=${options.sessionId}`]
        : [`--session-id=${options.sessionId}`]),
  ];
}

export function spawnClaudeChannel(
  binary: string,
  args: string[],
  cwd: string,
  authDiagnostic?: (diagnostic: ClaudeAuthDiagnostic) => void,
  boundary?: NativeProviderBoundary,
): ClaudeChannel {
  assertClaudeSubscriptionEnvironment(boundary ? boundary.environment : process.env);
  const host = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? './claude-session-host.ts' : './claude-session-host.js',
      import.meta.url,
    ),
  );
  const launch = boundary ? boundary.spawn.bind(boundary) : spawn;
  const child = launch(
    boundary?.claudeDirect ? binary : process.execPath,
    boundary?.claudeDirect ? args : [host, binary, JSON.stringify(args)],
    {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...(boundary ? boundary.environment : process.env),
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60',
      },
    },
  );
  if (!child.stdin || !child.stdout || !child.stderr)
    throw new Error('Claude requires private stdio pipes.');
  child.stderr.on(
    'data',
    boundary?.claudeDirect
      ? claudeAuthScanner((classification) => {
          if (child.pid)
            authDiagnostic?.({
              classification,
              observedAt: new Date().toISOString(),
              nativeProcessId: child.pid,
            });
        })
      : claudeAuthDiagnosticReader((event) => authDiagnostic?.(event)),
  );
  // Prevent an unhandled EPIPE from bypassing the unavailable event/receipt recovery.
  child.stdin.on('error', () => {});
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', resolve);
  });
  return {
    input: child.stdin,
    get ownedProcessId() {
      return child.exitCode === null && child.signalCode === null ? (child.pid ?? null) : null;
    },
    output: child.stdout,
    exited,
    async close() {
      child.stdin!.end();
      const timeout = setTimeout(() => child.kill('SIGTERM'), 1500);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** Native CLI conversation, deliberately not the Codex-shaped Provider interface.
 * Construction/reopening starts no process. submit is an explicit owner/queue action.
 * Host owns durable receipts/archives and interrupted-turn confirmation before submit.
 * Native capabilities stay in Claude; this adapter adds observation and QUARK controls.
 */
export class ClaudeSession extends EventEmitter {
  readonly capabilities = {
    managedChat: true,
    coordinationTools: true,
    originalApprovals: true,
    nativeTerminal: false,
    lazyResume: true,
  } as const;
  get externalMcp() {
    return this.options.inheritNative === true;
  }
  private channel: ClaudeChannel | null = null;
  get ownedProcessId() {
    return this.channel?.ownedProcessId ?? null;
  }
  private starting: Promise<void> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private busy = false;
  private cancelledStart = false;
  private deliveryId: string | null = null;
  private controls = new Map<
    string,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private permissions = new Map<string, ClaudePermission>();
  private hostRequests = new Map<string, AbortController>();
  private seenRequestIds = new Set<string>();
  private seenDeliveries = new Set<string>();
  private seenResults = new Set<string>();
  private seenRejections = new Set<string>();
  private decoder = new StringDecoder('utf8');
  private buffered = '';
  private models: ClaudeModel[] = [];
  private commands: string[] = [];
  nativeCommands(): string[] {
    return [...this.commands];
  }
  async inspectCommands(): Promise<string[]> {
    this.starting ??= this.start();
    await this.starting;
    return this.nativeCommands();
  }
  requireCommand(text: string) {
    const name = text.trim().split(/\s/, 1)[0]?.slice(1);
    if (!name || !this.options.inheritNative || !this.commands.includes(name))
      throw new Error(
        'That command is not available in this Claude session. No message was sent; your draft is retained.',
      );
  }
  private nativeChildren = new Set<string>();
  private pendingResult: Extract<ClaudeEvent, { type: 'result' }> | null = null;

  constructor(
    readonly options: ClaudeSessionOptions,
    private dependencies: ClaudeSessionDependencies = {},
  ) {
    super();
    claudeArguments(options); // Validate without starting a process or accessing account/history.
  }
  private event(event: ClaudeEvent) {
    this.emit('event', event);
  }
  private write(value: unknown) {
    if (this.closed || !this.channel || this.channel.input.destroyed)
      throw new Error('Claude is disconnected. Inspect the saved result before trying again.');
    const line = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(line) > frameLimit) throw new Error('Claude request exceeded its limit.');
    this.channel.input.write(line);
  }
  private control(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(requestId);
        reject(new Error('Claude control timed out; no automatic retry was made.'));
        void this.fail('Claude control timed out. Inspect the session before continuing.');
      }, this.dependencies.timeoutMs ?? 30_000);
      this.controls.set(requestId, { resolve, reject, timer });
      try {
        this.write({ type: 'control_request', request_id: requestId, request });
      } catch (error) {
        clearTimeout(timer);
        this.controls.delete(requestId);
        reject(error);
      }
    });
  }
  private reply(requestId: string, response: unknown, error?: string) {
    this.write({
      type: 'control_response',
      response: error
        ? { subtype: 'error', request_id: requestId, error }
        : { subtype: 'success', request_id: requestId, response },
    });
  }
  private async start() {
    if (this.closed)
      throw new Error('This Claude connection is closed; explicitly reopen the saved session.');
    if (this.channel) return;
    await this.verifyIdentity();
    if (this.closed) throw new Error('Claude startup was cancelled.');
    const args = claudeArguments(this.options);
    this.options.beforeStart?.();
    // A group boundary cannot be bypassed by an ordinary fixture/native spawner.
    const channel = (
      this.options.boundary ? spawnClaudeChannel : (this.dependencies.spawn ?? spawnClaudeChannel)
    )(
      this.options.binary,
      args,
      this.options.cwd,
      (diagnostic) =>
        this.options.authDiagnostic?.({
          ...diagnostic,
          sessionId: this.options.sessionId,
          supervisorProcessId: this.ownedProcessId,
        }),
      this.options.boundary,
    );
    this.channel = channel;
    channel.output.on('data', (chunk: Buffer) => {
      try {
        this.buffered += this.decoder.write(chunk);
        let newline: number;
        while ((newline = this.buffered.indexOf('\n')) !== -1) {
          const line = this.buffered.slice(0, newline);
          this.buffered = this.buffered.slice(newline + 1);
          if (Buffer.byteLength(line) > frameLimit) throw new Error('Oversized frame');
          if (line.trim()) this.receive(JSON.parse(line));
        }
        if (Buffer.byteLength(this.buffered) > frameLimit) throw new Error('Oversized frame');
      } catch {
        void this.fail(
          'Claude returned an unsupported or unsafe response. The saved conversation is retained.',
        );
      }
    });
    channel.output.on('error', () => void this.fail('The Claude output connection failed.'));
    channel.input.on(
      'error',
      () => void this.fail('The Claude input connection failed. Delivery may be uncertain.'),
    );
    void channel.exited.then(() => {
      if (!this.closed)
        void this.fail(
          'Claude exited. The conversation is retained; interrupted work is not replayed.',
        );
    });
    const initialized = await this.control({
      subtype: 'initialize',
      hooks: this.options.hook
        ? Object.fromEntries(
            observedHooks.map((name) => [
              name,
              [
                {
                  matcher: '*',
                  hookCallbackIds: ['quark'],
                  timeout: 5,
                },
              ],
            ]),
          )
        : null,
      ...(!this.options.inheritNative ? { agents: {}, skills: [] } : { forwardSubagentText: true }),
    });
    this.commands = parseNativeCommands(initialized.commands);
    this.models = z
      .array(modelSchema)
      .max(100)
      .parse(initialized.models ?? []);
  }
  private async verifyIdentity() {
    await this.options.boundary?.check('claude');
    assertClaudeSubscriptionEnvironment(
      this.options.boundary ? this.options.boundary.environment : process.env,
    );
    const identity = await (this.options.boundary
      ? this.options.boundary.verifyClaudeIdentity(this.options.binary)
      : (this.dependencies.identity ?? readClaudeIdentity)(this.options.binary));
    if (identity.affinity !== this.options.accountAffinity)
      throw new ClaudePreflightError(
        'account_changed',
        'Claude sign-in changed. This conversation will not be sent to another account.',
      );
  }
  async inspectFreshModels(): Promise<ClaudeModel[]> {
    if (this.options.resume || this.options.forkFrom || this.seenDeliveries.size)
      throw new Error('Model discovery cannot initialize a saved or used conversation.');
    this.starting ??= this.start();
    await this.starting;
    return structuredClone(this.models);
  }
  async submit(input: {
    deliveryId: string;
    text: string;
    nativeCommand?: boolean;
  }): Promise<void> {
    uuid.parse(input.deliveryId);
    z.string().trim().min(1).max(200_000).parse(input.text);
    if (this.seenDeliveries.has(input.deliveryId))
      throw new Error(
        'This submission already reached the transport. Inspect its durable receipt.',
      );
    if (this.busy)
      throw new Error('Claude is already working. Wait or interrupt the current turn.');
    if (this.closed) throw new Error('The Claude connection is closed.');
    this.busy = true;
    try {
      // Recheck every explicit turn, including an already-running CLI whose local
      // owner may have changed sign-in since the previous result.
      if (this.channel) await this.verifyIdentity();
      this.starting ??= this.start();
      await this.starting;
      if (this.closed) throw new Error('Claude startup was cancelled.');
      if (input.nativeCommand) this.requireCommand(input.text);
      this.deliveryId = input.deliveryId;
      // Mark before write. A lost acknowledgement is never permission to resend.
      this.seenDeliveries.add(input.deliveryId);
      this.options.beforeWrite?.(input.deliveryId);
      this.write({
        type: 'user',
        session_id: this.options.sessionId,
        uuid: input.deliveryId,
        origin: { kind: 'human' },
        message: { role: 'user', content: input.text },
        parent_tool_use_id: null,
      });
    } catch (error) {
      this.busy = false;
      await this.close();
      if (this.cancelledStart) throw new ClaudeSubmissionCancelled();
      throw error;
    }
  }
  async interrupt(): Promise<'cancelled_start' | 'requested'> {
    if (this.closed || !this.busy) throw new Error('Claude has no active turn to interrupt.');
    if (!this.deliveryId) {
      this.cancelledStart = true;
      await this.close();
      return 'cancelled_start';
    }
    if (!this.channel) throw new Error('The original Claude connection is unavailable.');
    await this.control({ subtype: 'interrupt' });
    if (this.nativeChildren.size || this.pendingResult)
      await this.fail(
        'Stopped the owned Claude work group, including its native helpers. Saved progress is retained; inspect it before continuing.',
      );
    return 'requested';
  }
  canAnswer(requestId: string): boolean {
    return !this.closed && this.permissions.has(requestId);
  }
  answer(requestId: string, decision: 'accept' | 'decline', answers?: Record<string, string[]>) {
    const request = this.permissions.get(requestId);
    if (!request || this.closed)
      throw new Error('That original Claude permission request is no longer pending.');
    const input =
      decision === 'accept' && request.toolName === 'AskUserQuestion'
        ? claudeQuestionInput(request.input, answers)
        : request.input;
    this.permissions.delete(requestId); // Exactly one response; no replay after uncertain write.
    this.reply(
      requestId,
      decision === 'accept'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Declined by the owner.' },
    );
  }
  private receive(value: unknown) {
    if (this.closed) return;
    const frame = jsonObject.parse(value);
    if (
      frame.type === 'system' &&
      frame.subtype === 'init' &&
      frame.session_id === this.options.sessionId
    )
      this.commands = parseNativeCommands(frame.slash_commands);
    if (typeof frame.session_id === 'string' && frame.session_id !== this.options.sessionId)
      throw new Error('Claude session identity changed.');
    if (frame.type === 'control_response') {
      const response = jsonObject.parse(frame.response);
      const key = id.parse(response.request_id);
      const pending = this.controls.get(key);
      if (!pending) return;
      this.controls.delete(key);
      clearTimeout(pending.timer);
      if (response.subtype === 'success')
        pending.resolve(jsonObject.parse(response.response ?? {}));
      else pending.reject(new Error('Claude refused the requested control operation.'));
      return;
    }
    if (frame.type === 'control_cancel_request') {
      const key = id.parse(frame.request_id);
      if (this.permissions.delete(key))
        this.event({ type: 'permission_cancelled', requestId: key });
      this.hostRequests.get(key)?.abort();
      this.hostRequests.delete(key);
      return;
    }
    if (frame.type === 'control_request') {
      const key = id.parse(frame.request_id),
        request = jsonObject.parse(frame.request);
      if (this.seenRequestIds.has(key)) throw new Error('Duplicate Claude request identity.');
      this.seenRequestIds.add(key);
      if (this.seenRequestIds.size > 20_000) throw new Error('Claude request limit reached.');
      if (request.subtype === 'hook_callback') {
        const event = hookSchema.safeParse(request.input);
        if (
          request.callback_id !== 'quark' ||
          !this.options.hook ||
          !event.success ||
          event.data.session_id !== this.options.sessionId
        ) {
          this.reply(key, {}, 'This native hook does not belong to the registered session.');
          return;
        }
        if (event.data.hook_event_name === 'SessionStart') {
          this.reply(
            key,
            this.options.hook(event.data, this.deliveryId ?? this.options.sessionId, key),
          );
          return;
        }
        if (!this.busy || !this.deliveryId) {
          this.reply(
            key,
            event.data.hook_event_name === 'PreToolUse'
              ? {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: 'QUARK has no active admission for this work.',
                  },
                }
              : {},
          );
          if (event.data.hook_event_name === 'SubagentStart')
            void this.fail(
              'Claude started native work outside an admitted turn. Its owned process group was stopped; saved evidence is retained.',
            );
          return;
        }
        this.reply(key, this.options.hook(event.data, this.deliveryId, key));
        if (event.data.agent_id) {
          if (event.data.hook_event_name === 'SubagentStart')
            this.nativeChildren.add(event.data.agent_id);
          if (event.data.hook_event_name === 'SubagentStop')
            this.nativeChildren.delete(event.data.agent_id);
        }
        if (!this.nativeChildren.size && this.pendingResult) this.complete(this.pendingResult);
      } else if (request.subtype === 'mcp_message') {
        void this.mcp(key, request).catch(() =>
          this.fail(
            'Claude coordination transport failed. Inspect the saved task before retrying.',
          ),
        );
      } else if (request.subtype === 'can_use_tool') {
        if (!this.busy || !this.deliveryId) {
          this.reply(key, {
            behavior: 'deny',
            message: 'There is no active managed turn for this permission request.',
          });
          return;
        }
        const name = id.parse(request.tool_name);
        const allowed =
          this.options.role === 'implementer'
            ? ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write']
            : this.options.role === 'read-only'
              ? ['Read', 'Glob', 'Grep']
              : [];
        if (!this.options.inheritNative && !allowed.includes(name)) {
          this.reply(key, {
            behavior: 'deny',
            message: 'This capability is not enabled for this managed Claude role.',
          });
          return;
        }
        const permission: ClaudePermission = {
          requestId: key,
          toolUseId: id.parse(request.tool_use_id),
          toolName: name,
          input: jsonObject.parse(request.input),
          description:
            typeof request.description === 'string'
              ? request.description.slice(0, 2000)
              : `Claude requests ${name}`,
        };
        // Native plan mode asks before non-read-only MCP calls, ahead of
        // --allowedTools. Resolve only that mode floor for our registered SDK
        // tools; their invocation still goes through the scoped host handler.
        // Native ask rules/user interaction and all other servers stay denied.
        if (
          this.options.inheritNative &&
          this.options.unattended &&
          request.decision_reason_type === 'mode' &&
          request.matched_ask_rule === undefined &&
          (request.requires_user_interaction === undefined ||
            request.requires_user_interaction === false) &&
          z
            .object({ name: z.literal('dock'), source: z.literal('sdk') })
            .safeParse(request.mcp_server).success &&
          this.options.tools.some((tool) => name === `mcp__dock__${tool.name}`)
        ) {
          this.reply(key, { behavior: 'allow', updatedInput: permission.input });
          return;
        }
        if (name === 'AskUserQuestion') {
          try {
            claudeQuestions(permission.input);
          } catch {
            this.reply(key, {
              behavior: 'deny',
              message: 'The question form could not be displayed. Please rephrase the questions.',
            });
            return;
          }
        }
        if (this.options.unattended && name !== 'AskUserQuestion') {
          this.reply(key, {
            behavior: 'deny',
            message:
              'This operation needs permission outside the native unattended policy. Continue with permitted work and report the blocked operation to your manager; do not wait for approval.',
          });
          return;
        }
        if (this.permissions.size >= 16) throw new Error('Too many Claude permission requests.');
        this.permissions.set(key, structuredClone(permission));
        this.event({ type: 'permission', request: structuredClone(permission) });
      } else
        this.reply(
          key,
          {},
          'This Claude control capability is not supported by sciencewithagents.',
        );
      return;
    }
    if (frame.type === 'result') {
      // A helper completion is not the owning turn's terminal receipt. In
      // particular it must not clear that turn's pending owner questions.
      if (frame.parent_tool_use_id != null) return;
      const resultId = id.parse(frame.uuid);
      // Results can be replayed after the next user input. A prior result must
      // never inherit the current delivery ID and complete that newer run.
      if (this.seenResults.has(resultId)) return;
      if (this.seenResults.size >= 20_000) throw new Error('Claude result limit reached.');
      this.seenResults.add(resultId);
      const input = claudeResultInput(frame, this.deliveryId);
      const originKind = nonHumanResultOrigin(frame);
      if (originKind && !input.matches) {
        // Native resumes can inject background-task turns beside the owner's
        // input. Their terminal receipts do not release the owner's admission.
        this.event({
          type: 'unowned_result',
          id: resultId,
          sessionId: uuid.parse(frame.session_id),
          originKind,
        });
        return;
      }
      if (!this.busy || !this.deliveryId) return;
      if (input.reported && !input.matches) return;
    }
    if (frame.type === 'rate_limit_event') {
      // The SDK omits the turn origin, so the exact native event ID is replay
      // evidence: a rejection seen once, even late, never attaches to a newer turn.
      const info = jsonObject.safeParse(frame.rate_limit_info);
      const eventId = id.safeParse(frame.uuid);
      if (info.success && info.data.status === 'rejected' && eventId.success) {
        if (this.seenRejections.has(eventId.data)) return;
        if (this.seenRejections.size >= 20_000) throw new Error('Claude rejection limit reached.');
        this.seenRejections.add(eventId.data);
      }
      // A rejection outside the current owned turn is late evidence, not a hold.
      if (!this.busy || !this.deliveryId) return;
    }
    for (const event of normalizeClaudeEvent(frame, this.deliveryId)) {
      // The advertised catalog is observation, not a permission grant. A native
      // tool added by a provider update must not terminate this conversation.
      if (event.type === 'result') {
        if (this.nativeChildren.size) {
          this.pendingResult = { ...event, helpersPending: true };
          continue;
        }
        this.complete(event);
        continue;
      }
      this.event(event);
    }
  }
  private complete(event: Extract<ClaudeEvent, { type: 'result' }>) {
    this.pendingResult = null;
    this.busy = false;
    this.deliveryId = null;
    for (const key of this.permissions.keys())
      this.event({ type: 'permission_cancelled', requestId: key });
    this.permissions.clear();
    this.event(event);
  }
  private async mcp(key: string, request: Record<string, unknown>) {
    if (request.server_name !== 'dock') {
      this.reply(key, {}, 'Unknown coordination server.');
      return;
    }
    const message = jsonObject.parse(request.message);
    const method = id.parse(message.method);
    const rpcId = z
      .union([z.string().max(256), z.number().finite()])
      .optional()
      .parse(message.id);
    const response = (result: unknown, error?: string) =>
      this.reply(key, {
        mcp_response: error
          ? { jsonrpc: '2.0', id: rpcId ?? null, error: { code: -32601, message: error } }
          : { jsonrpc: '2.0', ...(rpcId === undefined ? {} : { id: rpcId }), result },
      });
    if (method === 'initialize') {
      response({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dock', version: '0.1.0' },
      });
    } else if (method === 'notifications/initialized' || method === 'ping') response({});
    else if (method === 'tools/list')
      response({
        tools: this.options.tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    else if (method === 'tools/call') {
      if (!this.busy || !this.deliveryId || rpcId === undefined) {
        response({}, 'No active managed turn.');
        return;
      }
      const params = jsonObject.parse(message.params);
      const tool = this.options.tools.find((item) => item.name === params.name);
      if (!tool) {
        response({}, 'Unknown coordination tool.');
        return;
      }
      if (this.hostRequests.size >= 16) throw new Error('Too many coordination calls.');
      const controller = new AbortController();
      this.hostRequests.set(key, controller);
      try {
        const result = await tool.invoke(jsonObject.parse(params.arguments ?? {}), {
          sessionId: this.options.sessionId,
          requestId: key,
          signal: controller.signal,
        });
        if (!this.closed && !controller.signal.aborted)
          response(
            z
              .object({
                content: z
                  .array(z.object({ type: z.literal('text'), text: z.string().max(500_000) }))
                  .max(100),
                isError: z.boolean().optional(),
              })
              .parse(result),
          );
      } catch {
        if (!this.closed && !controller.signal.aborted)
          response({
            content: [
              {
                type: 'text',
                text: 'The coordination request failed. Inspect its saved task before retrying.',
              },
            ],
            isError: true,
          });
      } finally {
        this.hostRequests.delete(key);
      }
    } else response({}, 'This coordination method is not supported.');
  }
  private async fail(message: string) {
    if (this.closed) return;
    const closing = this.close();
    this.event({ type: 'unavailable', message });
    await closing;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.finishClose();
    return this.closing;
  }
  private async finishClose() {
    this.closed = true;
    for (const pending of this.controls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Claude disconnected; no control request was replayed.'));
    }
    this.controls.clear();
    for (const key of this.permissions.keys())
      this.event({ type: 'permission_cancelled', requestId: key });
    this.permissions.clear();
    for (const controller of this.hostRequests.values()) controller.abort();
    this.hostRequests.clear();
    await this.channel?.close();
  }
}

function claudeResultInput(frame: Record<string, unknown>, deliveryId: string | null) {
  const singular = frame.user_message_uuid != null ? uuid.parse(frame.user_message_uuid) : null;
  const folded =
    frame.user_message_uuids != null
      ? uuid.array().max(20_000).parse(frame.user_message_uuids)
      : null;
  return {
    singular,
    reported: singular !== null || folded !== null,
    // The opening input supplies origin, but the native CLI can fold our input
    // into that same turn. An exact input ID is stronger evidence than origin.
    matches: deliveryId !== null && (singular === deliveryId || !!folded?.includes(deliveryId)),
  };
}

// The native SDK distinguishes application input from injected background turns.
// Older CLIs omit origin; keep their root results compatible with UUID fencing.
function nonHumanResultOrigin(frame: Record<string, unknown>): string | null {
  const origin = jsonObject.safeParse(frame.origin);
  if (!origin.success || typeof origin.data.kind !== 'string' || origin.data.kind === 'human')
    return null;
  return origin.data.kind.length > 0 && origin.data.kind.length <= 64
    ? origin.data.kind
    : 'unknown';
}

const tokens = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** Visible evidence only. Never return thinking/signatures/raw auth or arbitrary system frames. */
export function normalizeClaudeEvent(
  value: unknown,
  deliveryId: string | null = null,
): ClaudeEvent[] {
  const frame = jsonObject.parse(value);
  if (frame.type === 'rate_limit_event') {
    // Act only on the primary status. `overageStatus: rejected` accompanies
    // allowed work when overage is disabled and must never pause a turn.
    const parsed = z
      .object({
        uuid: id,
        session_id: uuid,
        rate_limit_info: z.object({
          status: z.literal('rejected'),
          rateLimitType: z.enum(nativeRateLimitTypes),
          resetsAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        }),
      })
      .safeParse(frame);
    if (!parsed.success || frame.parent_tool_use_id != null || !deliveryId) return [];
    // Optional provider origin must name the current delivery; never restamp it.
    if (frame.user_message_uuid != null && frame.user_message_uuid !== deliveryId) return [];
    return [
      {
        type: 'rate_limit',
        id: parsed.data.uuid,
        sessionId: parsed.data.session_id,
        deliveryId,
        rateLimitType: parsed.data.rate_limit_info.rateLimitType,
        resetsAtSeconds: parsed.data.rate_limit_info.resetsAt,
      },
    ];
  }
  if (frame.type === 'system' && frame.subtype === 'init')
    return [
      {
        type: 'session',
        sessionId: uuid.parse(frame.session_id),
        model: typeof frame.model === 'string' ? frame.model : null,
        commands: parseNativeCommands(frame.slash_commands),
        tools: Array.isArray(frame.tools)
          ? frame.tools.filter((tool): tool is string => typeof tool === 'string').slice(0, 500)
          : [],
      },
    ];
  if (frame.type === 'assistant' || frame.type === 'user') {
    const origin =
      typeof frame.parent_tool_use_id === 'string'
        ? { parentToolUseId: id.parse(frame.parent_tool_use_id) }
        : {};
    const message = jsonObject.parse(frame.message);
    const messageId = id.parse(frame.uuid ?? message.id);
    const usage = jsonObject.safeParse(message.usage);
    const source = id.safeParse(message.id);
    const session = uuid.safeParse(frame.session_id);
    // Parallel tool frames repeat the same API message ID. Never use the SDK
    // frame UUID for token deduplication; its output count is only a placeholder.
    const observations: ClaudeEvent[] =
      frame.type === 'assistant' && usage.success && source.success && session.success && deliveryId
        ? [
            {
              type: 'usage',
              id: source.data,
              sessionId: session.data,
              deliveryId,
              ...origin,
              usage: {
                inputTokens: tokens(usage.data.input_tokens),
                outputTokens: null,
                cacheReadInputTokens: tokens(usage.data.cache_read_input_tokens),
                cacheCreationInputTokens: tokens(usage.data.cache_creation_input_tokens),
              },
            },
          ]
        : [];
    // The native frame UUID is a history boundary, not the API token receipt.
    // Only the latest root text reply is eligible; tool/user frames invalidate it.
    if (frame.parent_tool_use_id == null && session.success && deliveryId) {
      const nativeId = uuid.safeParse(frame.uuid);
      const content = message.content;
      const textReply =
        frame.type === 'assistant' &&
        (typeof content === 'string'
          ? !!content.trim()
          : Array.isArray(content) &&
            content.some(
              (item) => item?.type === 'text' && typeof item.text === 'string' && item.text.trim(),
            ) &&
            !content.some((item) => item?.type === 'tool_use'));
      observations.push({
        type: 'boundary',
        sessionId: session.data,
        deliveryId,
        messageId: textReply && nativeId.success ? nativeId.data : null,
      });
    }
    if (typeof message.content === 'string')
      return [
        { type: 'message', id: messageId, role: frame.type, text: message.content, ...origin },
        ...observations,
      ];
    const result: ClaudeEvent[] = [];
    for (const [index, value] of z.array(jsonObject).max(1000).parse(message.content).entries()) {
      if (value.type === 'text' && typeof value.text === 'string')
        result.push({
          type: 'message',
          id: `${messageId}:${index}`,
          role: frame.type,
          text: value.text,
        });
      else if (value.type === 'tool_use')
        result.push({
          type: 'tool',
          id: id.parse(value.id),
          name: id.parse(value.name),
          input: jsonObject.parse(value.input),
        });
      else if (value.type === 'tool_result') {
        const text =
          typeof value.content === 'string'
            ? value.content
            : Array.isArray(value.content)
              ? value.content
                  .filter((item) => item?.type === 'text' && typeof item.text === 'string')
                  .map((item) => item.text)
                  .join('\n')
              : '[Non-text tool result]';
        result.push({
          type: 'tool_result',
          id: id.parse(value.tool_use_id),
          text,
          isError: value.is_error === true,
        });
      }
    }
    return [...result.map((event) => ({ ...event, ...origin })), ...observations];
  }
  if (frame.type === 'result') {
    if (frame.parent_tool_use_id != null) return [];
    const input = claudeResultInput(frame, deliveryId);
    if (
      (nonHumanResultOrigin(frame) && !input.matches) ||
      (deliveryId !== null && input.reported && !input.matches)
    )
      return [];
    const usage = jsonObject.safeParse(frame.usage);
    const models = jsonObject.safeParse(frame.modelUsage);
    const modelUsage =
      models.success && Object.keys(models.data).length <= 100
        ? Object.fromEntries(
            Object.entries(models.data).map(([model, raw]) => {
              const value = jsonObject.safeParse(raw);
              return [
                model,
                {
                  inputTokens: tokens(value.success ? value.data.inputTokens : null),
                  outputTokens: tokens(value.success ? value.data.outputTokens : null),
                  cacheReadInputTokens: tokens(
                    value.success ? value.data.cacheReadInputTokens : null,
                  ),
                  cacheCreationInputTokens: tokens(
                    value.success ? value.data.cacheCreationInputTokens : null,
                  ),
                },
              ];
            }),
          )
        : undefined;
    const interrupted =
      frame.terminal_reason === 'aborted_streaming' || frame.terminal_reason === 'aborted_tools';
    return [
      {
        type: 'result',
        id: id.parse(frame.uuid),
        sessionId: uuid.parse(frame.session_id),
        deliveryId: input.matches ? deliveryId : (input.singular ?? deliveryId),
        status: interrupted
          ? 'interrupted'
          : frame.is_error === true || frame.subtype !== 'success'
            ? 'failed'
            : 'completed',
        text: typeof frame.result === 'string' ? frame.result : '',
        ...(modelUsage ? { modelUsage } : {}),
        usage: usage.success
          ? {
              inputTokens: tokens(usage.data.input_tokens),
              outputTokens: tokens(usage.data.output_tokens),
              cacheReadInputTokens: tokens(usage.data.cache_read_input_tokens),
              cacheCreationInputTokens: tokens(usage.data.cache_creation_input_tokens),
            }
          : null,
      },
    ];
  }
  return [];
}

/** Current SDK initialize reports command metadata; system/init reports names. */
export function parseNativeCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.slice(0, 500).flatMap((entry: unknown) => {
        const name =
          typeof entry === 'string'
            ? entry
            : entry && typeof entry === 'object' && 'name' in entry
              ? entry.name
              : undefined;
        const parsed = nativeCommandNameSchema.safeParse(name);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  ];
}
