import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeSession,
  ClaudeSubmissionCancelled,
  assertClaudeSubscriptionEnvironment,
  claudeArguments,
  normalizeClaudeEvent,
  parseClaudeIdentity,
  spawnClaudeChannel,
  type ClaudeChannel,
  type ClaudeEvent,
  type ClaudeSessionOptions,
} from './claude-session.js';

const identity = parseClaudeIdentity({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'fixture@example.invalid',
  orgId: 'fixture-org',
});
const options = (overrides: Partial<ClaudeSessionOptions> = {}): ClaudeSessionOptions => ({
  binary: '/nonexistent/fixture-claude',
  cwd: '/tmp',
  sessionId: randomUUID(),
  resume: false,
  accountAffinity: identity.affinity,
  role: 'manager',
  model: 'opus',
  effort: 'medium',
  charter: 'Coordinate only.',
  tools: [],
  ...overrides,
});
const sessions: ClaudeSession[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});
function fixture(config: ClaudeSessionOptions = options(), initialize = true) {
  const input = new PassThrough(),
    output = new PassThrough();
  const writes: Record<string, any>[] = [];
  let end!: (value: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    end = resolve;
  });
  const channel: ClaudeChannel = {
    input,
    output,
    exited,
    close: vi.fn(async () => {
      input.end();
      output.end();
      end(0);
    }),
  };
  const emit = (frame: unknown) => output.write(JSON.stringify(frame) + '\n');
  input.on('data', (buffer) => {
    const frame = JSON.parse(buffer.toString());
    writes.push(frame);
    if (initialize && frame.type === 'control_request')
      queueMicrotask(() =>
        emit({
          type: 'control_response',
          response: { subtype: 'success', request_id: frame.request_id, response: {} },
        }),
      );
  });
  const spawn = vi.fn((_binary: string, _args: string[], _cwd: string) => channel);
  const auth = vi.fn(async () => identity);
  const session = new ClaudeSession(config, { spawn, identity: auth, timeoutMs: 40 });
  const events: ClaudeEvent[] = [];
  session.on('event', (event) => events.push(event));
  sessions.push(session);
  const submit = () => session.submit({ deliveryId: randomUUID(), text: 'Fixture input' });
  return { session, events, writes, config, spawn, auth, emit, channel, submit, end };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
it('uses native bounded forks with an identity distinct from the source and fences startup before I/O', async () => {
  const forkFrom = { sessionId: randomUUID(), messageId: randomUUID() };
  const beforeStart = vi.fn();
  const f = fixture(options({ forkFrom, beforeStart }));
  await expect(f.session.inspectFreshModels()).rejects.toThrow('saved or used');
  expect(f.spawn).not.toHaveBeenCalled();
  await f.submit();
  expect(f.spawn.mock.calls[0]?.[1]).toEqual(
    expect.arrayContaining([
      `--resume=${forkFrom.sessionId}`,
      '--fork-session',
      `--session-id=${f.config.sessionId}`,
      `--resume-session-at=${forkFrom.messageId}`,
    ]),
  );
  expect(beforeStart.mock.invocationCallOrder[0]).toBeLessThan(
    f.spawn.mock.invocationCallOrder[0]!,
  );
  expect(() => claudeArguments({ ...f.config, resume: true })).toThrow('distinct');
  expect(() => claudeArguments({ ...f.config, sessionId: forkFrom.sessionId })).toThrow('distinct');
  const stopped = fixture(
    options({
      forkFrom,
      beforeStart: () => {
        throw new Error('Admission lost');
      },
    }),
  );
  await expect(stopped.submit()).rejects.toThrow('Admission lost');
  expect(stopped.spawn).not.toHaveBeenCalled();
});
it('captures only an observed root reply UUID and invalidates a boundary when root work continues', () => {
  const session_id = randomUUID(),
    deliveryId = randomUUID(),
    messageId = randomUUID();
  const frame = {
    type: 'assistant',
    session_id,
    uuid: messageId,
    message: {
      id: 'api-message-not-history-id',
      content: [{ type: 'text', text: 'Why we chose it' }],
    },
  };
  const boundary = (value: unknown, delivery: string | null = deliveryId) =>
    normalizeClaudeEvent(value, delivery).filter((event) => event.type === 'boundary');
  expect(boundary(frame)).toEqual([
    { type: 'boundary', sessionId: session_id, deliveryId, messageId },
  ]);
  expect(boundary({ ...frame, parent_tool_use_id: 'native-helper' })).toEqual([]);
  expect(boundary(frame, null)).toEqual([]);
  for (const value of [
    { ...frame, uuid: undefined },
    { ...frame, type: 'user' },
    { ...frame, message: { content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } },
  ])
    expect(boundary(value)).toEqual([
      { type: 'boundary', sessionId: session_id, deliveryId, messageId: null },
    ]);
});
const permission = (requestId = randomUUID()) => ({
  type: 'control_request',
  request_id: requestId,
  request: {
    subtype: 'can_use_tool',
    tool_use_id: 'tool-1',
    tool_name: 'Bash',
    input: { command: 'fixture command' },
    permission_suggestions: [{ type: 'addRules', behavior: 'allow' }],
  },
});
const mcp = (method: string, params: unknown = {}, requestId = randomUUID()) => ({
  type: 'control_request',
  request_id: requestId,
  request: {
    subtype: 'mcp_message',
    server_name: 'dock',
    message: { jsonrpc: '2.0', id: 1, method, params },
  },
});

describe('Claude native launch policy', () => {
  it('uses the native sandbox and denies unattended permission requests while retaining human questions', async () => {
    const f = fixture(options({ inheritNative: true, unattended: true, role: 'implementer' }));
    const args = claudeArguments(f.config);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toMatchObject({
      permissions: { allow: ['Read(//**)', 'Bash', 'WebFetch', 'WebSearch'] },
      sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
    });
    expect(args).not.toContain('--tools');
    const readOnly = claudeArguments({ ...f.config, role: 'read-only' });
    expect(readOnly[readOnly.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(
      JSON.parse(readOnly[readOnly.indexOf('--settings') + 1]!).permissions.allow,
    ).not.toContain('Bash');
    await f.submit();
    const request = permission();
    f.emit(request);
    expect(f.writes.at(-1)?.response.response.behavior).toBe('deny');
    expect(f.session.canAnswer(request.request_id)).toBe(false);
    const question = permission();
    f.emit({
      ...question,
      request: {
        ...question.request,
        tool_name: 'AskUserQuestion',
        input: {
          questions: [{ question: 'Which outcome?', header: 'Outcome', options: [] }],
        },
      },
    });
    expect(f.session.canAnswer(question.request_id)).toBe(true);
  });
  it('inherits native tools/configuration and appends coordination without overriding native permissions', async () => {
    const f = fixture(options({ inheritNative: true, hook: () => ({}) }));
    const args = claudeArguments(f.config);
    for (const disabled of [
      '--restricted',
      '--setting-sources=',
      '--strict-mcp-config',
      '--tools',
      '--settings',
      '--disable-slash-commands',
      '--no-chrome',
      '--system-prompt',
      '--permission-mode',
    ])
      expect(args).not.toContain(disabled);
    expect(args).toContain('--append-system-prompt');
    expect(claudeArguments(options({ inheritNative: true, role: 'read-only' }))).toContain('plan');
    await f.submit();
    const init = f.writes.find((frame) => frame.request?.subtype === 'initialize')!.request;
    expect(init).not.toHaveProperty('skills');
    expect(init).not.toHaveProperty('agents');
    expect(init.forwardSubagentText).toBe(true);
    const original = permission();
    original.request.tool_name = 'mcp__native__future_tool';
    f.emit(original);
    expect(f.events.at(-1)).toMatchObject({
      type: 'permission',
      request: { toolName: original.request.tool_name },
    });
    f.session.answer(original.request_id, 'accept');
    expect(f.writes.at(-1)?.response.response).toEqual({
      behavior: 'allow',
      updatedInput: original.request.input,
    });
  });
  it('waits for native helpers after the parent result and retains their visible provenance', async () => {
    const f = fixture(options({ inheritNative: true, hook: () => ({}) }));
    await f.submit();
    const lifecycle = (hook_event_name: string) =>
      f.emit({
        type: 'control_request',
        request_id: randomUUID(),
        request: {
          subtype: 'hook_callback',
          callback_id: 'quark',
          input: {
            session_id: f.config.sessionId,
            hook_event_name,
            agent_id: 'native-child',
            agent_type: 'researcher',
          },
        },
      });
    lifecycle('SubagentStart');
    f.emit({
      type: 'result',
      uuid: randomUUID(),
      session_id: f.config.sessionId,
      subtype: 'success',
      result: 'Parent done',
      is_error: false,
    });
    expect(f.events.some((e) => e.type === 'result')).toBe(false);
    await expect(f.submit()).rejects.toThrow('already working');
    f.emit({
      type: 'assistant',
      uuid: 'child-message',
      parent_tool_use_id: 'spawn-tool',
      session_id: f.config.sessionId,
      message: { content: [{ type: 'text', text: 'Child evidence' }] },
    });
    expect(f.events.at(-1)).toMatchObject({
      type: 'message',
      parentToolUseId: 'spawn-tool',
      text: 'Child evidence',
    });
    lifecycle('SubagentStop');
    expect(f.events.filter((e) => e.type === 'result')).toHaveLength(1);
    expect(f.events.at(-1)).toMatchObject({ type: 'result', helpersPending: true });
    await f.submit();
  });
  it('stops the owned group when native helpers are active instead of claiming only the parent stopped', async () => {
    const f = fixture(options({ inheritNative: true, hook: () => ({}) }));
    await f.submit();
    f.emit({
      type: 'control_request',
      request_id: randomUUID(),
      request: {
        subtype: 'hook_callback',
        callback_id: 'quark',
        input: {
          session_id: f.config.sessionId,
          hook_event_name: 'SubagentStart',
          agent_id: 'native-child',
        },
      },
    });
    await f.session.interrupt();
    expect(f.channel.close).toHaveBeenCalledOnce();
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: 'unavailable',
        message: expect.stringContaining('work group'),
      }),
    );
    expect(f.events.some((e) => e.type === 'result')).toBe(false);
  });
  it('omits the native effort override for provider default and tolerates changed optional tool metadata', () => {
    const config = options({ effort: 'provider-default' });
    expect(claudeArguments(config)).not.toContain('--effort');
    expect(claudeArguments(config)).not.toContain('provider-default');
    const [event] = normalizeClaudeEvent({
      type: 'system',
      subtype: 'init',
      session_id: config.sessionId,
      tools: [...Array.from({ length: 125 }, (_, i) => `native-${i}`), { future: true }],
    });
    expect(event).toMatchObject({ type: 'session', tools: expect.arrayContaining(['native-124']) });
  });
  it('treats provider effort and advertised tools as extensible observations', async () => {
    const f = fixture(options({ effort: 'adaptive-v2' }), false);
    const pending = f.session.inspectFreshModels();
    await tick();
    const init = f.writes.find((frame) => frame.request?.subtype === 'initialize')!;
    f.emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: init.request_id,
        response: {
          models: [
            {
              value: 'future-model',
              displayName: 'Future',
              supportsEffort: true,
              supportedEffortLevels: ['adaptive-v2'],
            },
          ],
        },
      },
    });
    expect(await pending).toMatchObject([{ supportedEffortLevels: ['adaptive-v2'] }]);
    f.emit({
      type: 'system',
      subtype: 'init',
      session_id: f.config.sessionId,
      tools: ['FutureNativeTool'],
      model: 'future-model',
    });
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: 'session', tools: ['FutureNativeTool'] }),
    );
    expect(f.events.some((event) => event.type === 'unavailable')).toBe(false);
  });
  it('routes native hook callbacks to the active admission without granting permission itself', async () => {
    const hook = vi.fn(() => ({}));
    const f = fixture(options({ hook }));
    await f.submit();
    const init = f.writes.find((frame) => frame.request?.subtype === 'initialize')!;
    expect(init.request.hooks.PreToolUse[0].hookCallbackIds).toEqual(['quark']);
    const input = {
      session_id: f.config.sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'FutureTool',
      tool_use_id: 't1',
    };
    const callback = (id: string, sessionId: string) =>
      f.emit({
        type: 'control_request',
        request_id: id,
        request: {
          subtype: 'hook_callback',
          callback_id: 'quark',
          input: { ...input, session_id: sessionId, transcript_path: null },
        },
      });
    callback('valid-hook', f.config.sessionId);
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining(input),
      expect.any(String),
      expect.any(String),
    );
    expect(f.writes.at(-1)?.response).toMatchObject({ request_id: 'valid-hook', response: {} });
    callback('wrong-session', randomUUID());
    expect(hook).toHaveBeenCalledTimes(1);
    expect(f.writes.at(-1)?.response.subtype).toBe('error');
    f.emit({
      type: 'result',
      uuid: randomUUID(),
      session_id: f.config.sessionId,
      subtype: 'success',
      result: '',
      is_error: false,
    });
    callback('late-hook', f.config.sessionId);
    expect(f.writes.at(-1)?.response.response).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(hook).toHaveBeenCalledTimes(1);
  });
  it('restores compacted context through SessionStart before a new turn is busy', async () => {
    const context = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Saved handoff' },
    };
    const hook = vi.fn(() => context);
    const f = fixture(options({ inheritNative: true, hook }));
    await f.submit();
    f.emit({
      type: 'result',
      uuid: randomUUID(),
      session_id: f.config.sessionId,
      subtype: 'success',
      result: '',
      is_error: false,
    });
    f.emit({
      type: 'control_request',
      request_id: 'compact-start',
      request: {
        subtype: 'hook_callback',
        callback_id: 'quark',
        input: {
          session_id: f.config.sessionId,
          hook_event_name: 'SessionStart',
          source: 'compact',
        },
      },
    });
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'compact' }),
      expect.any(String),
      'compact-start',
    );
    expect(f.writes.at(-1)?.response.response).toEqual(context);
  });
  it('rejects API, token and routing overrides before auth/spawn without exposing their values', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
      'ANTHROPIC_AWS_API_KEY',
      'ANTHROPIC_BEDROCK_BASE_URL',
      'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
      'ANTHROPIC_VERTEX_BASE_URL',
      'ANTHROPIC_FOUNDRY_BASE_URL',
      'AWS_BEARER_TOKEN_BEDROCK',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_MANTLE',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
      'CLAUDE_CODE_SIMPLE',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
      'CLAUDE_CODE_SKIP_VERTEX_AUTH',
    ]) {
      let message = '';
      try {
        assertClaudeSubscriptionEnvironment({ [name]: 'private-fixture-value' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('Conflicting Claude');
      expect(message).not.toContain('private-fixture-value');
    }
    expect(() =>
      assertClaudeSubscriptionEnvironment({
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_USE_VERTEX: '0',
        CLAUDE_CODE_USE_BEDROCK: 'false',
        PATH: '/fixture/bin',
        CLAUDE_CONFIG_DIR: '/fixture/profile',
      }),
    ).not.toThrow();
  });
  it('pins local subscription identity without exporting raw identity or credentials', () => {
    expect(identity).toEqual({
      affinity: expect.stringMatching(/^[a-f0-9]{64}$/),
      authMethod: 'claude.ai',
      provider: 'firstParty',
    });
    expect(JSON.stringify(identity)).not.toContain('fixture@example');
    expect(
      parseClaudeIdentity({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'FIXTURE@example.invalid',
        orgId: 'fixture-org',
      }).affinity,
    ).toBe(identity.affinity);
    for (const patch of [
      { loggedIn: false },
      { authMethod: 'api_key' },
      { apiProvider: 'bedrock' },
      { email: '' },
      { orgId: '' },
    ])
      expect(() =>
        parseClaudeIdentity({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          email: 'fixture@example.invalid',
          orgId: 'fixture-org',
          ...patch,
        }),
      ).toThrow('subscription');
  });
  it('removes manager built-ins, ignores ambient MCP/settings and never uses bare/API fallback', () => {
    const args = claudeArguments(options());
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--restricted');
    expect(args).toContain('--setting-sources=');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--fallback-model');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--worktree');
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('stdio');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    expect(settings.disableAllHooks).toBeUndefined();
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable');
  });
  it('worker tools use an existing workspace and require original prompts without native delegation', () => {
    const config = options({ role: 'implementer', resume: true });
    const args = claudeArguments(config);
    expect(args).toContain(`--resume=${config.sessionId}`);
    expect(args.some((arg) => arg.startsWith('--session-id'))).toBe(false);
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Bash,Edit,Write');
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!).permissions.ask).toContain('Bash');
    expect(args).not.toContain('Agent');
  });
  it('rejects invalid host parameters before any process or account read', () => {
    for (const patch of [
      { sessionId: '../../saved' },
      { model: '--bypass' },
      { cwd: 'relative' },
      { accountAffinity: '' },
    ])
      expect(() => new ClaudeSession(options(patch))).toThrow();
  });
});

describe('Claude typed native session', () => {
  it('is lazy even for resume, then initializes before one explicit input with unchanged UUID', async () => {
    const f = fixture(options({ resume: true }));
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.auth).not.toHaveBeenCalled();
    const deliveryId = randomUUID();
    await f.session.submit({ deliveryId, text: 'Continue explicitly' });
    expect(f.auth).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.writes.map((frame) => frame.type)).toEqual(['control_request', 'user']);
    expect(f.writes[0]!.request).toEqual({
      subtype: 'initialize',
      hooks: null,
      agents: {},
      skills: [],
    });
    expect(f.writes[1]).toMatchObject({
      session_id: f.config.sessionId,
      uuid: deliveryId,
      message: { content: 'Continue explicitly' },
    });
    await expect(f.session.submit({ deliveryId, text: 'Continue explicitly' })).rejects.toThrow(
      'already reached',
    );
    await expect(f.submit()).rejects.toThrow('already working');
  });
  it('runs the host receipt fence synchronously after initialization and immediately before input', async () => {
    const fence = vi.fn((_deliveryId: string) => {});
    const f = fixture(options({ beforeWrite: fence }));
    fence.mockImplementation(() =>
      expect(f.writes.some((frame) => frame.type === 'user')).toBe(false),
    );
    const deliveryId = randomUUID();
    await f.session.submit({ deliveryId, text: 'One fenced input' });
    expect(fence).toHaveBeenCalledExactlyOnceWith(deliveryId);
    expect(f.writes.at(-1)).toMatchObject({ type: 'user', uuid: deliveryId });
  });
  it('rejects account change before launching the CLI or sending input', async () => {
    const f = fixture(options({ accountAffinity: 'f'.repeat(64) }));
    await expect(f.submit()).rejects.toThrow('sign-in changed');
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('rechecks affinity on another turn without sending saved context to the changed account', async () => {
    const f = fixture();
    await f.submit();
    f.emit({
      type: 'result',
      uuid: randomUUID(),
      session_id: f.config.sessionId,
      subtype: 'success',
      is_error: false,
    });
    f.auth.mockResolvedValueOnce({ ...identity, affinity: 'a'.repeat(64) });
    await expect(f.submit()).rejects.toThrow('sign-in changed');
    expect(f.writes.filter((frame) => frame.type === 'user')).toHaveLength(1);
    expect(f.channel.close).toHaveBeenCalledOnce();
  });
  it('model discovery is fresh-only and never sends user input', async () => {
    const f = fixture();
    expect(await f.session.inspectFreshModels()).toEqual([]);
    expect(f.writes.some((frame) => frame.type === 'user')).toBe(false);
    const saved = fixture(options({ resume: true }));
    await expect(saved.session.inspectFreshModels()).rejects.toThrow('saved or used');
    expect(saved.spawn).not.toHaveBeenCalled();
  });
  it('returns native question answers with the exact original input and rejects missing answers without consuming the request', async () => {
    const f = fixture(options({ inheritNative: true }));
    await f.submit();
    const input = {
      questions: [
        {
          question: ' Which checks? ',
          header: 'Checks',
          multiSelect: true,
          options: [
            { label: 'Tests', description: 'Run tests' },
            { label: 'Types', description: 'Check types' },
          ],
          preview: 'native extra',
        },
        { question: 'When?', header: 'Timing', options: [] },
      ],
      metadata: { source: 'native' },
    };
    const request = permission();
    f.emit({ ...request, request: { ...request.request, tool_name: 'AskUserQuestion', input } });
    expect(() => f.session.answer(request.request_id, 'accept')).toThrow('Answer each');
    expect(f.session.canAnswer(request.request_id)).toBe(true);
    expect(() => f.session.answer(request.request_id, 'accept', { unrelated: ['x'] })).toThrow(
      'original questions',
    );
    f.session.answer(request.request_id, 'accept', {
      'question-0': ['Tests', 'Types'],
      'question-1': ['After lunch'],
    });
    expect(f.writes.at(-1)?.response.response).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: { ' Which checks? ': 'Tests, Types', 'When?': 'After lunch' },
      },
    });
    expect(f.session.canAnswer(request.request_id)).toBe(false);
  });
  it('denies malformed native question forms without closing the session', async () => {
    const f = fixture(options({ inheritNative: true }));
    await f.submit();
    const request = permission();
    f.emit({
      ...request,
      request: { ...request.request, tool_name: 'AskUserQuestion', input: { questions: [] } },
    });
    expect(f.writes.at(-1)?.response.response.behavior).toBe('deny');
    expect(
      f.events.some((event) => event.type === 'permission' || event.type === 'unavailable'),
    ).toBe(false);
    f.emit(permission());
    expect(f.events.some((event) => event.type === 'permission')).toBe(true);
  });
  it('ignores helper terminal frames without completing the parent or cancelling its question', async () => {
    const f = fixture(options({ inheritNative: true }));
    await f.submit();
    const request = permission();
    f.emit(request);
    const frame = {
      type: 'result',
      subtype: 'success',
      uuid: randomUUID(),
      session_id: f.config.sessionId,
      result: 'Helper complete',
    };
    const child = { ...frame, parent_tool_use_id: 'child-launch' };
    expect(normalizeClaudeEvent(child, randomUUID())).toEqual([]);
    f.emit(child);
    expect(
      f.events.some((event) => event.type === 'result' || event.type === 'permission_cancelled'),
    ).toBe(false);
    expect(f.session.canAnswer(request.request_id)).toBe(true);
    f.emit({ ...frame, parent_tool_use_id: null });
    expect(f.events.filter((event) => event.type === 'result')).toHaveLength(1);
    expect(f.session.canAnswer(request.request_id)).toBe(false);
  });
  it('forwards an original permission once with exact input, never persistent permission suggestions', async () => {
    const f = fixture(options({ role: 'implementer' }));
    await f.submit();
    const request = permission();
    f.emit(request);
    expect(f.session.canAnswer(request.request_id)).toBe(true);
    const event = f.events.find((event) => event.type === 'permission');
    expect(event?.type).toBe('permission');
    if (event?.type === 'permission') event.request.input.command = 'mutated view';
    f.session.answer(request.request_id, 'accept');
    expect(f.session.canAnswer(request.request_id)).toBe(false);
    expect(f.writes.at(-1)).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.request_id,
        response: { behavior: 'allow', updatedInput: { command: 'fixture command' } },
      },
    });
    await expect(async () => f.session.answer(request.request_id, 'accept')).rejects.toThrow(
      'no longer pending',
    );
  });
  it('decline/cancel keep original request ownership and never revive a request', async () => {
    const f = fixture(options({ role: 'implementer' }));
    await f.submit();
    const first = permission();
    f.emit(first);
    f.session.answer(first.request_id, 'decline');
    expect(f.writes.at(-1)!.response.response.behavior).toBe('deny');
    const second = permission();
    f.emit(second);
    f.emit({ type: 'control_cancel_request', request_id: second.request_id });
    expect(() => f.session.answer(second.request_id, 'accept')).toThrow('no longer pending');
    expect(f.events).toContainEqual({ type: 'permission_cancelled', requestId: second.request_id });
  });
  it('manager and unknown MCP permissions are denied, not delegated to a permissive host callback', async () => {
    const f = fixture();
    await f.submit();
    f.emit(permission());
    expect(f.writes.at(-1)!.response.response.behavior).toBe('deny');
    expect(f.events.some((event) => event.type === 'permission')).toBe(false);
    const external = permission();
    external.request.tool_name = 'mcp__external__pay';
    f.emit(external);
    expect(f.writes.at(-1)!.response.response.behavior).toBe('deny');
    expect(f.session.externalMcp).toBe(false);
  });
  it('serves only typed Dock MCP calls, preserving request ID and cancelling without a stale response', async () => {
    let finish!: () => void;
    const invoked = vi.fn(
      (_input, context) =>
        new Promise<{ content: { type: 'text'; text: string }[] }>((resolve) => {
          finish = () => resolve({ content: [{ type: 'text', text: context.requestId }] });
        }),
    );
    const f = fixture(
      options({
        tools: [
          {
            name: 'dock_inspect',
            description: 'Inspect',
            inputSchema: { type: 'object' },
            invoke: invoked,
          },
        ],
      }),
    );
    await f.submit();
    f.emit(mcp('initialize'));
    f.emit(mcp('tools/list'));
    await tick();
    expect(f.writes.at(-1)!.response.response.mcp_response.result.tools[0].name).toBe(
      'dock_inspect',
    );
    f.emit(mcp('tools/call', { name: 'not_registered' }));
    await tick();
    expect(invoked).not.toHaveBeenCalled();
    const request = mcp('tools/call', { name: 'dock_inspect', arguments: { taskId: 'task' } });
    f.emit(request);
    expect(invoked).toHaveBeenCalledWith(
      { taskId: 'task' },
      expect.objectContaining({
        requestId: request.request_id,
        sessionId: f.config.sessionId,
      }),
    );
    f.emit({ type: 'control_cancel_request', request_id: request.request_id });
    finish();
    await tick();
    expect(invoked.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(f.writes.some((frame) => frame.response?.request_id === request.request_id)).toBe(false);
  });
  it('completes one typed coordination request and refuses duplicate identities instead of executing twice', async () => {
    const invoke = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'Retained result' }],
    }));
    const f = fixture(
      options({
        tools: [
          { name: 'dock_checkpoint', description: 'Save', inputSchema: { type: 'object' }, invoke },
        ],
      }),
    );
    await f.submit();
    const call = mcp('tools/call', { name: 'dock_checkpoint', arguments: {} });
    f.emit(call);
    await tick();
    expect(f.writes.at(-1)!.response.response.mcp_response.result.content[0].text).toBe(
      'Retained result',
    );
    f.emit(call);
    await tick();
    expect(invoke).toHaveBeenCalledOnce();
    expect(f.channel.close).toHaveBeenCalledOnce();
  });
  it('refuses session swaps, closing the owned process with no new turn', async () => {
    for (const patch of [{ session_id: randomUUID() }]) {
      const f = fixture();
      await f.submit();
      f.emit({
        type: 'system',
        subtype: 'init',
        session_id: f.config.sessionId,
        tools: [],
        ...patch,
      });
      await tick();
      expect(f.channel.close).toHaveBeenCalledOnce();
      expect(f.events.some((event) => event.type === 'unavailable')).toBe(true);
      expect(f.writes.filter((frame) => frame.type === 'user')).toHaveLength(1);
    }
  });
  it('interrupts through typed control and awaits provider terminal result before another send', async () => {
    const f = fixture();
    await f.submit();
    await f.session.interrupt();
    expect(f.writes.at(-1)!.request).toEqual({ subtype: 'interrupt' });
    await expect(f.submit()).rejects.toThrow('already working');
    f.emit({
      type: 'result',
      uuid: randomUUID(),
      session_id: f.config.sessionId,
      subtype: 'success',
      is_error: true,
      terminal_reason: 'aborted_tools',
    });
    expect(f.events.at(-1)).toMatchObject({ type: 'result', status: 'interrupted' });
    await f.submit();
    expect(f.spawn).toHaveBeenCalledOnce();
  });
  it('replayed or explicitly mismatched old terminal results cannot finish a newer delivery', async () => {
    const f = fixture();
    const first = randomUUID(),
      second = randomUUID();
    await f.session.submit({ deliveryId: first, text: 'First turn' });
    const old = {
      type: 'result',
      uuid: randomUUID(),
      session_id: f.config.sessionId,
      subtype: 'success',
      is_error: false,
    };
    f.emit(old);
    await f.session.submit({ deliveryId: second, text: 'Second turn' });
    f.emit(old); // Older native frame without a user UUID.
    f.emit({ ...old, uuid: randomUUID(), user_message_uuid: first });
    expect(f.events.filter((event) => event.type === 'result')).toHaveLength(1);
    await expect(f.submit()).rejects.toThrow('already working');
    f.emit({ ...old, uuid: randomUUID(), user_message_uuid: second });
    expect(f.events.filter((event) => event.type === 'result')).toEqual([
      expect.objectContaining({ deliveryId: first }),
      expect.objectContaining({ deliveryId: second }),
    ]);
  });
  it('denies permission frames outside an active delivery instead of leaving the CLI waiting', async () => {
    const f = fixture(options({ role: 'implementer' }));
    await f.session.inspectFreshModels();
    const before = permission();
    f.emit(before);
    expect(f.writes.at(-1)!.response).toMatchObject({
      request_id: before.request_id,
      response: { behavior: 'deny' },
    });
    await f.submit();
    f.emit({
      type: 'result',
      uuid: randomUUID(),
      session_id: f.config.sessionId,
      subtype: 'success',
      is_error: false,
    });
    const after = permission();
    f.emit(after);
    expect(f.writes.at(-1)!.response).toMatchObject({
      request_id: after.request_id,
      response: { behavior: 'deny' },
    });
    expect(f.events.some((event) => event.type === 'permission')).toBe(false);
    expect(() => f.session.answer(after.request_id, 'accept')).toThrow('no longer pending');
  });
  it('expiry, shutdown and process death clear pending approvals and never replay input', async () => {
    const f = fixture(options({ role: 'implementer' }));
    await f.submit();
    const request = permission();
    f.emit(request);
    f.end(1);
    await tick();
    expect(f.session.canAnswer(request.request_id)).toBe(false);
    expect(() => f.session.answer(request.request_id, 'accept')).toThrow('no longer pending');
    await expect(f.submit()).rejects.toThrow();
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.events).toContainEqual({
      type: 'permission_cancelled',
      requestId: request.request_id,
    });
  });
  it('initialization timeout never sends a model input and cleans up its exact runtime', async () => {
    const f = fixture(options(), false);
    await expect(f.submit()).rejects.toThrow('timed out');
    expect(f.writes.some((frame) => frame.type === 'user')).toBe(false);
    expect(f.channel.close).toHaveBeenCalledOnce();
  });
  it('Stop during first authentication cancels startup before any native process or input', async () => {
    const beforeWrite = vi.fn();
    const f = fixture(options({ beforeWrite }));
    let release!: () => void;
    f.auth.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(identity);
        }),
    );
    const submitted = f.submit();
    const rejected = expect(submitted).rejects.toBeInstanceOf(ClaudeSubmissionCancelled);
    await tick();
    expect(await f.session.interrupt()).toBe('cancelled_start');
    expect(f.spawn).not.toHaveBeenCalled();
    release();
    await rejected;
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
    expect(beforeWrite).not.toHaveBeenCalled();
  });
  it('Stop during initialization closes only that channel and never sends deferred input', async () => {
    const f = fixture(options(), false);
    const submitted = f.submit();
    const rejected = expect(submitted).rejects.toBeInstanceOf(ClaudeSubmissionCancelled);
    await tick();
    expect(f.writes[0]!.request.subtype).toBe('initialize');
    expect(await f.session.interrupt()).toBe('cancelled_start');
    await rejected;
    expect(f.channel.close).toHaveBeenCalledOnce();
    expect(f.writes.some((frame) => frame.type === 'user')).toBe(false);
  });
  it('Stop during the next turn affinity recheck cannot send after the lock check completes', async () => {
    const f = fixture();
    await f.submit();
    f.emit({
      type: 'result',
      uuid: randomUUID(),
      session_id: f.config.sessionId,
      subtype: 'success',
      is_error: false,
    });
    let release!: () => void;
    f.auth.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(identity);
        }),
    );
    const submitted = f.submit();
    const rejected = expect(submitted).rejects.toBeInstanceOf(ClaudeSubmissionCancelled);
    await tick();
    expect(await f.session.interrupt()).toBe('cancelled_start');
    release();
    await rejected;
    expect(f.writes.filter((frame) => frame.type === 'user')).toHaveLength(1);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.channel.close).toHaveBeenCalledOnce();
  });
  it('rejects oversized and malformed native output without copying raw diagnostics', async () => {
    const f = fixture();
    await f.submit();
    f.channel.output.emit('data', Buffer.from('{private broken output}\n'));
    await tick();
    expect(f.channel.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.events)).not.toContain('private broken output');
    const second = fixture();
    await second.submit();
    second.channel.output.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1, 65));
    await tick();
    expect(second.channel.close).toHaveBeenCalledOnce();
  });
});

describe('Claude visible archive normalization', () => {
  it('keeps stable visible item IDs and omits thinking/signatures and unrelated system metadata', () => {
    const events = normalizeClaudeEvent({
      type: 'assistant',
      uuid: 'message-1',
      message: {
        content: [
          { type: 'thinking', thinking: 'private reasoning', signature: 'private signature' },
          { type: 'text', text: 'Visible answer' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } },
        ],
      },
    });
    expect(events).toEqual([
      { type: 'message', id: 'message-1:1', role: 'assistant', text: 'Visible answer' },
      { type: 'tool', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } },
    ]);
    expect(
      normalizeClaudeEvent({ type: 'system', subtype: 'auth_status', token: 'private' }),
    ).toEqual([]);
    expect(
      normalizeClaudeEvent({
        type: 'assistant',
        uuid: 'child-evidence',
        parent_tool_use_id: 'spawn',
        message: { content: 'Retained child evidence' },
      }),
    ).toEqual([
      {
        type: 'message',
        id: 'child-evidence',
        role: 'assistant',
        text: 'Retained child evidence',
        parentToolUseId: 'spawn',
      },
    ]);
  });
  it('distinguishes missing usage from zero and emits per-result observation without invented quota/cost', () => {
    const sessionId = randomUUID(),
      deliveryId = randomUUID();
    const [event] = normalizeClaudeEvent(
      {
        type: 'result',
        uuid: 'result-1',
        session_id: sessionId,
        subtype: 'success',
        is_error: false,
        result: 'Done',
        total_cost_usd: 4,
        usage: { input_tokens: 0, output_tokens: 12, cache_read_input_tokens: -1 },
      },
      deliveryId,
    );
    expect(event).toEqual({
      type: 'result',
      id: 'result-1',
      sessionId,
      deliveryId,
      status: 'completed',
      text: 'Done',
      usage: {
        inputTokens: 0,
        outputTokens: 12,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
      },
    });
  });
  it('reads provider model totals without costs, and leaves changed observational fields unknown', () => {
    const [event] = normalizeClaudeEvent(
      {
        type: 'result',
        uuid: 'model-result',
        session_id: randomUUID(),
        subtype: 'success',
        modelUsage: {
          main: {
            inputTokens: 123,
            outputTokens: 9,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 4,
            costUSD: 20,
          },
          future: { newField: 99 },
        },
      },
      randomUUID(),
    );
    expect(event).toMatchObject({
      modelUsage: {
        main: {
          inputTokens: 123,
          outputTokens: 9,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 4,
        },
        future: { inputTokens: null, outputTokens: null },
      },
    });
    expect(JSON.stringify(event)).not.toContain('costUSD');
  });
  it('reports live inputs by API message identity, retaining helper origin and discarding placeholder output', () => {
    const sessionId = randomUUID(),
      deliveryId = randomUUID();
    const frame = {
      type: 'assistant',
      uuid: 'different-frame-id',
      session_id: sessionId,
      parent_tool_use_id: 'native-spawn',
      message: {
        id: 'api-message-id',
        content: [],
        usage: { input_tokens: 42, output_tokens: 999, cache_read_input_tokens: 0 },
      },
    };
    expect(normalizeClaudeEvent(frame, deliveryId)).toEqual([
      {
        type: 'usage',
        id: 'api-message-id',
        sessionId,
        deliveryId,
        parentToolUseId: 'native-spawn',
        usage: {
          inputTokens: 42,
          outputTokens: null,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: null,
        },
      },
    ]);
    expect(
      normalizeClaudeEvent({ ...frame, message: { ...frame.message, id: undefined } }, deliveryId),
    ).toEqual([]);
  });
});

it('real owned stdio supervisor runs a no-model fake CLI and closes all its pipes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dock-claude-fixture-'));
  directories.push(directory);
  const source = `let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))!==-1){const x=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(x.type==='control_request')process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:x.request_id,response:{}}})+'\\n');else if(x.type==='user')process.stdout.write(JSON.stringify({type:'result',uuid:'fixture-result',session_id:x.session_id,subtype:'success',is_error:false,result:'Fixture complete'})+'\\n');}});`;
  let channel: ClaudeChannel | undefined;
  const config = options({ cwd: directory });
  const session = new ClaudeSession(config, {
    identity: async () => identity,
    spawn: () => (channel = spawnClaudeChannel(process.execPath, ['-e', source], directory)),
    timeoutMs: 5000,
  });
  sessions.push(session);
  const events: ClaudeEvent[] = [];
  session.on('event', (event) => events.push(event));
  await session.submit({ deliveryId: randomUUID(), text: 'No model invoked' });
  expect(session.ownedProcessId).toBeGreaterThan(0);
  await vi.waitFor(() =>
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'Fixture complete' }),
  );
  await session.close();
  await expect(channel!.exited).resolves.toBe(0);
  expect(session.ownedProcessId).toBeNull();
}, 10_000);
