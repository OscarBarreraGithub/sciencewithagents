import { managerTool } from './manager-lease.fixture.js';
import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { DemoProvider } from './demo.js';
import {
  ClaudeSession,
  ClaudeSubmissionCancelled,
  parseClaudeIdentity,
  type ClaudeModel,
  type ClaudeEvent,
  type ClaudeSessionOptions,
} from './claude-session.js';
import { git } from './workspaces.js';
import { createInterview, nativeDiscussionBoundary } from './interviews.js';

const identity = parseClaudeIdentity({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'fixture@example.invalid',
  orgId: 'fixture',
});
const models: ClaudeModel[] = [
  {
    value: 'default',
    displayName: 'Default Claude fixture',
    description: '',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  {
    value: 'opus[1m]',
    displayName: 'Long fixture',
    description: '',
    supportsEffort: true,
    supportedEffortLevels: ['high'],
  },
];
class FixtureSession extends ClaudeSession {
  override submit = vi.fn(async (input: { deliveryId: string; text: string }) => {
    if (this.submit.mock.calls.length === 1) this.options.beforeStart?.();
    this.options.beforeWrite?.(input.deliveryId);
  });
  override close = vi.fn(async () => {});
  override interrupt = vi.fn(async (): Promise<'cancelled_start' | 'requested'> => 'requested');
  override answer = vi.fn(
    (_request: string, _decision: 'accept' | 'decline', _answers?: Record<string, string[]>) => {},
  );
  override canAnswer = vi.fn((_request: string) => true);
  send(event: ClaudeEvent) {
    this.emit('event', event);
  }
}
let root: string,
  projectRoot: string,
  store: Store,
  runtime: Runtime,
  manager: string,
  project: string;
let instances: FixtureSession[];
let configureSession: (session: FixtureSession) => void;
const codexFactory = vi.fn(async () => new DemoProvider());
const auth = vi.fn(async () => identity);
const inspect = vi.fn(async () => ({ identity, models }));
function createRuntime() {
  return new Runtime(store, root, 'never-spawn-codex', codexFactory, {
    identity: auth,
    inspect,
    session: (options: ClaudeSessionOptions) => {
      const session = new FixtureSession(options);
      configureSession(session);
      instances.push(session);
      return session;
    },
  });
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dock-claude-runtime-'));
  projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  await git(projectRoot, ['init', '-b', 'main']);
  await git(projectRoot, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'Fixture',
  ]);
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const registered = store.register(projectRoot, 'Fixture', '');
  project = registered.id;
  manager = registered.managerId;
  store.updateAgent(manager, { provider: 'claude' });
  instances = [];
  configureSession = () => {};
  codexFactory.mockClear();
  auth.mockReset().mockResolvedValue(identity);
  inspect.mockClear();
  runtime = createRuntime();
  await runtime.initialize();
});
afterEach(async () => {
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
async function start(agentId = manager, text = 'One bounded fixture result') {
  const before = instances.reduce((sum, session) => sum + session.submit.mock.calls.length, 0);
  const run = store.enqueue(agentId, randomUUID(), text);
  await vi.waitFor(() =>
    expect(instances.reduce((sum, session) => sum + session.submit.mock.calls.length, 0)).toBe(
      before + 1,
    ),
  );
  const session = instances.findLast(
    (session) => session.options.sessionId === store.agent(agentId).threadId,
  )!;
  return { run, session };
}
function finish(
  session: FixtureSession,
  runId: string,
  status: 'completed' | 'failed' | 'interrupted' = 'completed',
) {
  session.send({
    type: 'result',
    id: randomUUID(),
    deliveryId: runId,
    sessionId: session.options.sessionId,
    status,
    text: '',
    usage: null,
  });
}
function request(session: FixtureSession, requestId = randomUUID()) {
  session.send({
    type: 'permission',
    request: {
      requestId,
      toolUseId: randomUUID(),
      toolName: 'Write',
      input: { file_path: join(projectRoot, 'fixture-only.txt'), content: 'fixture' },
      description: 'Fixture file request',
    },
  });
  return requestId;
}

describe('Claude uses the shared runtime without Codex protocol substitution', () => {
  it('discusses a completed native reply in a separate read-only copy, preserving task and excluding inherited spending', async () => {
    const task = store.addTask(project, {
      title: 'Research',
      goal: 'Compare approaches',
      acceptance: 'Explain choice',
      parentId: null,
    });
    const source = store.addAgent({
      projectId: project,
      parentId: manager,
      taskId: task.id,
      name: 'Researcher',
      role: 'researcher',
      cwd: projectRoot,
      provider: 'claude',
    });
    store.updateAgent(source.id, { model: 'default', webSearch: 'disabled' });
    const first = await start(source.id),
      messageId = randomUUID();
    first.session.send({
      type: 'boundary',
      sessionId: first.session.options.sessionId,
      deliveryId: first.run.id,
      messageId,
    });
    expect(nativeDiscussionBoundary(store, store.agent(source.id))).toBeNull();
    finish(first.session, first.run.id);
    await vi.waitFor(() => expect(store.run(first.run.id).status).toBe('completed'));
    store.updateTask(task.id, {
      status: 'done',
      review: 'Keep original approval',
      reviewedCommit: 'original',
    });
    const original = store.agent(source.id),
      originalTask = store.task(task.id);
    expect(nativeDiscussionBoundary(store, original)).toEqual({
      sourceThreadId: original.threadId,
      sourceMessageId: messageId,
    });
    const connectedBefore = instances.length;
    const discussion = createInterview(store, source.id, {
      key: randomUUID(),
      continuity: 'native-fork',
    });
    expect(instances).toHaveLength(connectedBefore);
    expect(store.getSetting(`claude:account:${discussion.id}`)).toBe(identity.affinity);
    const second = await start(discussion.id, 'Why that approach?');
    expect(second.session.options).toMatchObject({
      resume: false,
      forkFrom: { sessionId: original.threadId, messageId },
      role: 'read-only',
      inheritNative: false,
    });
    expect(second.session.options.sessionId).not.toBe(original.threadId);
    expect(store.getSetting(`claude:fork-attempted:${second.session.options.sessionId}`)).toBe(
      true,
    );
    expect(second.session.options.charter).toContain('native copy');
    second.session.send({
      type: 'result',
      id: randomUUID(),
      sessionId: second.session.options.sessionId,
      deliveryId: second.run.id,
      status: 'completed',
      text: 'Recorded explanation',
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      modelUsage: {
        main: {
          inputTokens: 8000,
          outputTokens: 2000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
    await vi.waitFor(() => expect(store.run(second.run.id).status).toBe('completed'));
    runtime.quark.sync();
    expect(runtime.quark.runs().find((r) => r.runId === second.run.id)).toMatchObject({
      taskId: task.id,
      basis: 'partial',
      tokens: { totalTokens: 100 },
    });
    expect(store.agent(source.id)).toEqual(original);
    expect(store.task(task.id)).toEqual(originalTask);
    await runtime.claude.forget(discussion.id);
    const restored = await runtime.claude.prepare(store.agent(discussion.id));
    expect(restored.options.sessionId).toBe(second.session.options.sessionId);
    expect(restored.options.resume).toBe(true);
    expect(restored.options.forkFrom).toBeUndefined();
  });
  it('links nested native helpers from the owned caller and result without treating a resume as a new parent', async () => {
    const { session, run } = await start();
    const hook = session.options.hook!;
    const session_id = session.options.sessionId;
    for (const agent_id of ['caller', 'nested', 'resumed'])
      hook({ session_id, agent_id, hook_event_name: 'SubagentStart' }, run.id, agent_id);
    const member = (name: string) =>
      runtime.nativeChildren.family(manager).find((a) => a.nativePath === `${session_id}/${name}`)!;
    const caller = member('caller'),
      nested = member('nested'),
      resumed = member('resumed');
    const nestedRun = store.runs().find((r) => r.agentId === nested.id)!;
    const result = {
      session_id,
      agent_id: 'caller',
      hook_event_name: 'PostToolUse' as const,
      tool_name: 'Agent',
      tool_use_id: 'nested-call',
      tool_input: { prompt: 'Read the relevant evidence.' },
      tool_response: {
        status: 'completed',
        agentId: 'nested',
        totalTokens: 250,
        content: [{ type: 'text', text: 'Nested result.' }],
      },
    };
    hook(result, run.id, 'nested-report');
    expect(store.agent(nested.id).parentId).toBe(caller.id);
    expect(store.agent(nested.id).nativeRootId).toBe(manager);
    expect(store.entries(nested.id)).toContainEqual(
      expect.objectContaining({ text: 'Nested result.', runId: nestedRun.id }),
    );
    hook(
      {
        ...result,
        tool_use_id: 'resume-call',
        tool_input: { ...result.tool_input, resume: 'resumed' },
        tool_response: { ...result.tool_response, agentId: 'resumed' },
      },
      run.id,
      'resume-report',
    );
    expect(store.agent(resumed.id).parentId).toBe(manager);
    expect(store.getSetting(`claude:parent:${resumed.id}`)).toBeNull();
    // The owned root still controls every descendant, regardless of tree depth.
    await runtime.interrupt(nested.id);
    expect(session.interrupt).toHaveBeenCalledOnce();
    // The real adapter closes its owned group when helpers are active, then reports this.
    // A root result alone is not proof that every child has stopped.
    session.send({ type: 'unavailable', message: 'Fixture owned group closed.' });
    await vi.waitFor(() => expect(store.agent(nested.id).status).toBe('interrupted'));
    expect(store.run(nestedRun.id).status).toBe('interrupted');
    expect(store.entries(nested.id).some((entry) => entry.text === 'Nested result.')).toBe(true);
  });
  it('attributes structured native helper reports and totals without inventing helpers or reopening finished work', async () => {
    const { session, run } = await start();
    const hook = session.options.hook!;
    const identity = { session_id: session.options.sessionId, agent_id: 'structured-helper' };
    hook({ ...identity, hook_event_name: 'SubagentStart' }, run.id, 'structured-start');
    const child = runtime.nativeChildren.family(manager).find((a) => a.id !== manager)!;
    const childRun = store.runs().find((r) => r.agentId === child.id)!;
    hook(
      {
        ...identity,
        hook_event_name: 'SubagentStop',
        last_assistant_message: 'Closing text only.',
      },
      run.id,
      'structured-stop',
    );
    await vi.waitFor(() => expect(store.agent(child.id).status).toBe('idle'));
    const result = {
      session_id: session.options.sessionId,
      hook_event_name: 'PostToolUse' as const,
      tool_name: 'Agent',
      tool_use_id: 'launch-helper',
      tool_response: {
        status: 'completed',
        agentId: 'structured-helper',
        totalTokens: 750,
        content: [{ type: 'text', text: 'The actual delivered report.' }],
        usage: { input_tokens: 1, output_tokens: 1 }, // Never reinterpret this breakdown as run totals.
      },
    };
    hook(result, run.id, 'result');
    hook(result, run.id, 'result-repeat');
    runtime.quark.sync();
    expect(
      store.entries(child.id).filter((e) => e.title === 'Delivered native helper report'),
    ).toEqual([
      expect.objectContaining({ text: 'The actual delivered report.', runId: childRun.id }),
    ]);
    expect(store.agent(child.id).status).toBe('idle');
    expect(runtime.quark.status().runs.find((r) => r.runId === childRun.id)).toMatchObject({
      basis: 'partial',
      tokens: { totalTokens: 750, inputTokens: null, outputTokens: null },
    });
    // An identical old result cannot become spending in a resumed helper run.
    hook({ ...identity, hook_event_name: 'SubagentStart' }, run.id, 'structured-resume');
    hook(result, run.id, 'old-result');
    runtime.quark.sync();
    const resumed = store.runs().findLast((r) => r.agentId === child.id)!;
    expect(
      runtime.quark.status().runs.find((r) => r.runId === resumed.id)?.tokens.totalTokens,
    ).toBeNull();
    hook(
      {
        ...result,
        tool_use_id: 'foreign-result',
        tool_response: { ...result.tool_response, agentId: 'unregistered-helper' },
      },
      run.id,
    );
    hook(
      {
        ...result,
        tool_use_id: 'malformed-result',
        tool_response: { status: 'changed-native-format' },
      },
      run.id,
    );
    expect(runtime.nativeChildren.family(manager)).toHaveLength(2);
    expect(session.close).not.toHaveBeenCalled();
  });
  it('retains real helper identities, tool evidence and resumed runs under one root budget', async () => {
    const { session, run } = await start();
    const transcripts = vi.spyOn(runtime.claudeTranscripts, 'register');
    const hook = session.options.hook!;
    const childEvent = {
      session_id: session.options.sessionId,
      agent_id: 'native-helper-1',
      agent_type: 'fixture:reviewer',
    };
    const started = { ...childEvent, hook_event_name: 'SubagentStart' as const };
    hook(started, run.id, 'start-1');
    hook(started, run.id, 'start-1');
    const child = runtime.nativeChildren.family(manager).find((a) => a.id !== manager)!;
    expect(transcripts).toHaveBeenCalledWith(child.id, started);
    expect(child).toMatchObject({
      provider: 'claude',
      nativeRootId: manager,
      parentId: manager,
      projectId: project,
      nativePath: `${session.options.sessionId}/native-helper-1`,
      model: null,
      threadId: null,
      status: 'running',
    });
    const childRuns = () => store.runs().filter((r) => r.agentId === child.id);
    expect(childRuns()).toHaveLength(1);
    expect(runtime.pulsar.hasReservation(childRuns()[0]!.id)).toBe(false);
    const tool = {
      ...childEvent,
      tool_use_id: 'helper-tool',
      tool_name: 'Read',
      tool_input: { file_path: 'fixture.txt' },
    };
    hook({ ...tool, hook_event_name: 'PreToolUse' }, run.id, 'pre-1');
    hook(
      { ...tool, hook_event_name: 'PostToolUse', tool_response: 'Useful evidence' },
      run.id,
      'post-1',
    );
    expect(store.entries(child.id).find((e) => e.id.endsWith(':helper-tool'))).toMatchObject({
      status: 'complete',
      title: 'Read',
      runId: childRuns()[0]!.id,
    });
    const stopped = {
      ...childEvent,
      hook_event_name: 'SubagentStop' as const,
      last_assistant_message: 'The recorded reason.',
    };
    hook(stopped, run.id, 'stop-1');
    await vi.waitFor(() => expect(store.agent(child.id).status).toBe('idle'));
    hook(stopped, run.id, 'stop-1');
    hook(started, run.id, 'start-1');
    expect(childRuns()).toHaveLength(1);
    expect(store.agent(child.id).status).toBe('idle');
    expect(store.entries(child.id).filter((e) => e.kind === 'assistant')).toHaveLength(1);

    hook(started, run.id, 'start-2');
    expect(childRuns()).toHaveLength(2);
    expect(runtime.nativeChildren.family(manager)).toHaveLength(2);
    expect(store.agent(child.id).status).toBe('running');
    runtime.quark.hold(store.run(run.id), 'Fixture shared cap reached');
    expect(
      hook({ ...tool, tool_use_id: 'next-tool', hook_event_name: 'PreToolUse' }, run.id, 'pre-2'),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await vi.waitFor(() => expect(session.interrupt).toHaveBeenCalled());
    expect(store.entries(child.id).some((e) => e.id.endsWith(':next-tool'))).toBe(false);
    session.send({ type: 'unavailable', message: 'Fixture owned group closed.' });
    await vi.waitFor(() => expect(store.agent(child.id).status).toBe('interrupted'));
    expect(childRuns().filter((r) => r.status === 'interrupted')).toHaveLength(1);
    expect(store.agent(child.id).nativePath).toBe(child.nativePath);
  });
  it('keeps helper history across reconnect and routes its stop to the owning session', async () => {
    const first = await start();
    const event = {
      session_id: first.session.options.sessionId,
      agent_id: 'retained-child',
      agent_type: 'Explore',
    };
    first.session.options.hook!(
      { ...event, hook_event_name: 'SubagentStart' },
      first.run.id,
      'first-start',
    );
    const child = runtime.nativeChildren.family(manager).find((a) => a.id !== manager)!;
    first.session.options.hook!(
      { ...event, hook_event_name: 'SubagentStop', last_assistant_message: 'First result' },
      first.run.id,
      'first-stop',
    );
    finish(first.session, first.run.id);
    await vi.waitFor(() => expect(store.run(first.run.id).status).toBe('completed'));
    await runtime.close();
    runtime = createRuntime();
    await runtime.initialize();
    const second = await start();
    expect(second.session.options.sessionId).toBe(event.session_id);
    second.session.options.hook!(
      { ...event, hook_event_name: 'SubagentStart' },
      second.run.id,
      'second-start',
    );
    expect(runtime.nativeChildren.family(manager).map((a) => a.id)).toContain(child.id);
    expect(runtime.nativeChildren.family(manager)).toHaveLength(2);
    await runtime.interrupt(child.id);
    expect(second.session.interrupt).toHaveBeenCalledOnce();
    expect(store.entries(child.id).some((e) => e.text === 'First result')).toBe(true);
    // Late old-run hooks cannot finish this new invocation or change its identity.
    first.session.options.hook!(
      { ...event, hook_event_name: 'SubagentStop' },
      first.run.id,
      'late-stop',
    );
    expect(store.agent(child.id).status).toBe('running');
  });
  it('feeds live input evidence and final team totals into the same QUARK run without adding them twice', async () => {
    const { session, run } = await start();
    const usage = {
      inputTokens: 100,
      outputTokens: null,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 10,
    };
    session.send({
      type: 'usage',
      id: 'native-message',
      sessionId: session.options.sessionId,
      deliveryId: run.id,
      usage,
    });
    await vi.waitFor(() => {
      runtime.quark.sync();
      expect(runtime.quark.runs().find((r) => r.runId === run.id)).toMatchObject({
        basis: 'partial',
        tokens: { inputTokens: 100, outputTokens: null },
      });
    });
    session.send({
      type: 'result',
      id: 'native-result',
      sessionId: session.options.sessionId,
      deliveryId: run.id,
      status: 'completed',
      text: 'Finished',
      usage: { ...usage, outputTokens: 15 },
      modelUsage: {
        main: { ...usage, outputTokens: 15 },
        helper: {
          inputTokens: 50,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
    await vi.waitFor(() => expect(store.run(run.id).status).toBe('completed'));
    runtime.quark.sync();
    expect(runtime.quark.runs().find((r) => r.runId === run.id)).toMatchObject({
      basis: 'measured',
      observedModels: ['main', 'helper'],
      tokens: { inputTokens: 150, outputTokens: 25, totalTokens: 205 },
    });
  });
  it('closes an owned group that acknowledges interruption but keeps running, retaining its quota hold and queued input', async () => {
    const { session, run } = await start();
    const queued = store.enqueue(manager, randomUUID(), 'Retain this next request');
    const hold = runtime.quark.hold(store.run(run.id), 'Fixture cap reached');
    store.setSetting(`quark:hold:${run.id}`, {
      ...hold,
      createdAt: new Date(Date.now() - 40_000).toISOString(),
      lastAttemptAt: new Date(Date.now() - 15_000).toISOString(),
    });
    await vi.waitFor(() => expect(session.close).toHaveBeenCalled());
    await vi.waitFor(() => expect(store.run(run.id).status).toBe('interrupted'));
    expect(store.run(queued.id).status).toBe('queued');
    expect(store.agent(manager).threadId).toBe(session.options.sessionId);
    expect(runtime.quark.holds()[0]).toMatchObject({
      runId: run.id,
      stopAcknowledgedAt: expect.any(String),
    });
  });
  it('records native hooks once and blocks further tools when QUARK withdraws admission', async () => {
    const { run, session } = await start();
    const tool = {
      session_id: session.options.sessionId,
      tool_use_id: 'native-tool',
      tool_name: 'FutureNativeTool',
      tool_input: { query: 'Fixture observation' },
    };
    const hook = session.options.hook!;
    expect(hook({ ...tool, hook_event_name: 'PreToolUse' }, run.id)).toEqual({});
    const completed = {
      ...tool,
      hook_event_name: 'PostToolUse' as const,
      tool_response: { ok: true },
    };
    hook(completed, run.id);
    hook(completed, run.id);
    hook({ ...tool, hook_event_name: 'PreToolUse' }, run.id);
    const entries = store.entries(manager).filter((e) => e.id.endsWith(':native-tool'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      title: 'FutureNativeTool',
      status: 'complete',
      runId: run.id,
    });
    expect(store.approvals()).toHaveLength(0); // Observing is not a permission grant.

    runtime.quark.hold(store.run(run.id), 'Fixture quota reached');
    expect(hook({ ...tool, hook_event_name: 'PreToolUse' }, run.id)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('Fixture quota reached'),
      },
    });
    await vi.waitFor(() => expect(session.interrupt).toHaveBeenCalled());
    expect(store.entries(manager).find((e) => e.id.endsWith(':native-tool'))?.status).toBe(
      'complete',
    );
  });
  it('supplies a coalesced native post-tool update without granting tools or waking a manager', async () => {
    const { session, run } = await start();
    const hook = session.options.hook!;
    const event = {
      session_id: session.options.sessionId,
      hook_event_name: 'PostToolUse' as const,
      tool_name: 'FutureNativeTool',
      tool_use_id: 'update-fixture',
      tool_response: { ok: true },
    };
    const first = hook(event, run.id) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(first.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(first.hookSpecificOutput.additionalContext).toContain('QUARK update');
    expect(first).not.toHaveProperty('hookSpecificOutput.permissionDecision');
    expect(hook({ ...event, tool_use_id: 'another' }, run.id)).toEqual({});
    const hostTool = session.options.tools.find((tool) => tool.name === 'dock_inspect')!;
    const reply = await hostTool.invoke(
      {},
      {
        sessionId: session.options.sessionId,
        requestId: 'inspect-after-hook',
        signal: new AbortController().signal,
      },
    );
    expect(JSON.parse(reply.content[0]!.text)).not.toHaveProperty('quarkUpdate');
    expect(session.submit).toHaveBeenCalledTimes(1);
    expect(store.runs().filter((item) => item.agentId === manager)).toHaveLength(1);
  });
  it('fences hooks by original run/session and rechecks signed manager leases without renewing them', async () => {
    const { run, session } = await start();
    const event = {
      session_id: session.options.sessionId,
      hook_event_name: 'PreToolUse' as const,
      tool_use_id: 'late-tool',
      tool_name: 'Read',
    };
    const hook = session.options.hook!;
    expect(hook(event, randomUUID())).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(hook({ ...event, session_id: randomUUID() }, run.id)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    store.setSetting(`quark:manager-lease:${run.id}`, null);
    expect(hook(event, run.id)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('signed a lease'),
      },
    });
    expect(store.getSetting(`quark:manager-lease:${run.id}`)).toBeNull();
    expect(store.entries(manager).some((e) => e.id.endsWith(':late-tool'))).toBe(false);
  });
  it('checks the manager lease again at the final Claude write boundary', async () => {
    let write!: () => void;
    let sent = false;
    configureSession = (session) => {
      session.submit.mockImplementation(
        (input) =>
          new Promise<void>((resolve, reject) => {
            write = () => {
              try {
                session.options.beforeWrite?.(input.deliveryId);
                sent = true;
                resolve();
              } catch (error) {
                reject(error);
              }
            };
          }),
      );
    };
    const { run, session } = await start(manager, 'Delayed native input');
    store.setSetting(`quark:manager-lease:${run.id}`, null);
    write();
    await vi.waitFor(() => expect(store.run(run.id).status).toBe('interrupted'));
    expect(sent).toBe(false);
    expect(store.getSetting(`claude:attempted:${session.options.sessionId}`)).toBeNull();
    expect(runtime.quark.holds().find((h) => h.runId === run.id)?.reason).toContain(
      'signed a lease',
    );
  });
  it('starts one native run with durable UUID/receipt before submission, retaining visible evidence', async () => {
    const { session, run } = await start();
    expect(codexFactory).not.toHaveBeenCalled();
    expect(session.options.role).toBe('manager');
    expect(session.options.cwd).not.toBe(projectRoot);
    expect(store.run(run.id).turnId).toBe(run.id);
    expect(store.getSetting(`claude:attempted:${session.options.sessionId}`)).toBe(true);
    expect(session.submit.mock.calls[0]![0]).toMatchObject({ deliveryId: run.id });
    expect(session.submit.mock.calls[0]![0].text).toContain('One bounded fixture result');
    session.send({
      type: 'session',
      sessionId: session.options.sessionId,
      model: 'resolved-fixture',
      tools: ['mcp__dock__dock_inspect'],
    });
    session.send({
      type: 'message',
      id: 'answer',
      role: 'assistant',
      text: 'Retained visible answer',
    });
    session.send({ type: 'tool', id: 'tool', name: 'dock_inspect', input: { project: 'fixture' } });
    session.send({
      type: 'tool_result',
      id: 'tool',
      text: 'Retained tool evidence',
      isError: false,
    });
    finish(session, run.id);
    await vi.waitFor(() => expect(store.run(run.id).status).toBe('completed'));
    expect(store.agent(manager).model).toBe('default');
    expect(store.entries(manager)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${manager}:claude:answer`,
          text: 'Retained visible answer',
          kind: 'assistant',
        }),
        expect.objectContaining({
          id: `${manager}:claude:tool`,
          text: 'Retained tool evidence',
          status: 'complete',
        }),
      ]),
    );
    session.send({
      type: 'message',
      id: 'late',
      role: 'assistant',
      text: 'Must not revive a finished run',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.entries(manager).some((entry) => entry.text.includes('Must not revive'))).toBe(
      false,
    );
  });
  it('keeps original approval decision exactly once and forwards no Codex response', async () => {
    const worker = store.addAgent({
      projectId: project,
      parentId: null,
      taskId: null,
      name: 'Worker',
      role: 'implementer',
      cwd: projectRoot,
      provider: 'claude',
    });
    store.updateAgent(worker.id, { webSearch: 'disabled' });
    const { session } = await start(worker.id);
    const requestId = request(session);
    await vi.waitFor(() =>
      expect(store.approvals().filter((approval) => approval.status === 'pending')).toHaveLength(1),
    );
    const approval = store.approvals()[0]!;
    expect(approval.params).toMatchObject({
      provider: 'claude',
      threadId: session.options.sessionId,
      turnId: store.agent(worker.id).turnId,
    });
    await runtime.approve(approval.id, 'accept');
    await runtime.approve(approval.id, 'accept');
    expect(session.answer).toHaveBeenCalledExactlyOnceWith(requestId, 'accept');
    expect(store.approval(approval.id).status).toBe('accepted');
    expect(codexFactory).not.toHaveBeenCalled();
  });
  it('event ingress keeps a late prior-turn message out of a newly dequeued run', async () => {
    const { session, run } = await start(manager, 'First input');
    const next = store.enqueue(manager, randomUUID(), 'Second input already queued');
    finish(session, run.id);
    session.send({
      type: 'message',
      id: 'late-prior-turn',
      role: 'assistant',
      text: 'Old output after terminal frame',
    });
    await vi.waitFor(() => expect(session.submit).toHaveBeenCalledTimes(2));
    expect(store.run(run.id).status).toBe('completed');
    expect(store.run(next.id).status).toBe('running');
    expect(
      store
        .entries(manager)
        .filter((entry) => entry.runId === next.id)
        .some((entry) => entry.text === 'Old output after terminal frame'),
    ).toBe(false);
    session.send({
      type: 'message',
      id: 'current-turn',
      role: 'assistant',
      text: 'Current output',
    });
    finish(session, next.id);
    await vi.waitFor(() => expect(store.run(next.id).status).toBe('completed'));
    expect(store.entries(manager)).toContainEqual(
      expect.objectContaining({ runId: next.id, text: 'Current output' }),
    );
  });
  it('projects native questions and validates answers before saving and forwarding the owner decision once', async () => {
    const { session } = await start();
    const requestId = randomUUID();
    session.send({
      type: 'permission',
      request: {
        requestId,
        toolUseId: 'ask-1',
        toolName: 'AskUserQuestion',
        description: 'Choose checks',
        input: {
          questions: [
            {
              question: 'Which checks?',
              header: 'Checks',
              multiSelect: true,
              options: [
                { label: 'Tests', description: 'Run tests' },
                { label: 'Types', description: 'Check types' },
              ],
            },
          ],
        },
      },
    });
    await vi.waitFor(() => expect(store.approvals()).toHaveLength(1));
    const approval = store.approvals()[0]!;
    expect(approval.kind).toBe('input');
    expect(approval.questions[0]).toMatchObject({
      id: 'question-0',
      multiSelect: true,
      allowCustom: true,
    });
    await expect(runtime.approve(approval.id, 'accept')).rejects.toThrow('Answer each');
    expect(store.approval(approval.id).status).toBe('pending');
    expect(session.answer).not.toHaveBeenCalled();
    const answers = { 'question-0': ['Tests', 'Types', 'Include recovery'] };
    await runtime.approve(approval.id, 'accept', answers);
    await runtime.approve(approval.id, 'accept', answers);
    expect(store.approval(approval.id).status).toBe('accepted');
    expect(session.answer).toHaveBeenCalledExactlyOnceWith(requestId, 'accept', answers);
  });
  it('a lost approval write is retained as an uncertain decided request, never retransmitted', async () => {
    const { session } = await start();
    const requestId = request(session);
    await vi.waitFor(() => expect(store.approvals()).toHaveLength(1));
    session.answer.mockImplementation(() => {
      throw new Error('Connection lost');
    });
    const approval = store.approvals()[0]!;
    await expect(runtime.approve(approval.id, 'decline')).rejects.toThrow('not be answered again');
    expect(store.approval(approval.id).status).toBe('declined');
    await runtime.approve(approval.id, 'decline');
    expect(session.answer).toHaveBeenCalledExactlyOnceWith(requestId, 'decline');
  });
  it('a known-closed original permission expires before any accepted decision or response attempt', async () => {
    const { session } = await start();
    request(session);
    await vi.waitFor(() => expect(store.approvals()).toHaveLength(1));
    const approval = store.approvals()[0]!;
    session.canAnswer.mockReturnValue(false); // Transport closed; queued expiry event has not run yet.
    await expect(runtime.approve(approval.id, 'accept')).rejects.toThrow(
      /original Claude|pending|connected/,
    );
    expect(store.approval(approval.id).status).toBe('expired');
    expect(session.answer).not.toHaveBeenCalled();
  });
  it('cancellation expires only the original pending permission', async () => {
    const { session } = await start();
    const first = request(session),
      second = request(session);
    await vi.waitFor(() => expect(store.approvals()).toHaveLength(2));
    session.send({ type: 'permission_cancelled', requestId: first });
    await vi.waitFor(() =>
      expect(store.approvals().find((approval) => approval.requestId === first)?.status).toBe(
        'expired',
      ),
    );
    expect(store.approvals().find((approval) => approval.requestId === second)?.status).toBe(
      'pending',
    );
  });
  it('restart preserves the exact context/archive, expires approvals and restores without replay', async () => {
    const { session, run } = await start();
    const requestId = request(session);
    session.send({
      type: 'message',
      id: 'before-crash',
      role: 'assistant',
      text: 'Already completed step; do not repeat',
    });
    await vi.waitFor(() => expect(store.approvals()).toHaveLength(1));
    const threadId = store.agent(manager).threadId;
    await runtime.close();
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store);
    runtime = createRuntime();
    await runtime.initialize();
    expect(store.run(run.id).status).toBe('interrupted');
    expect(store.approvals().find((approval) => approval.requestId === requestId)?.status).toBe(
      'expired',
    );
    const views = await runtime.restoreSessions([manager]);
    expect(views[0]).toMatchObject({ agentId: manager, state: 'inspect' });
    const restored = instances.at(-1)!;
    expect(restored.options.sessionId).toBe(threadId);
    expect(restored.options.resume).toBe(true);
    expect(restored.submit).not.toHaveBeenCalled();
    expect(store.runs()).toHaveLength(1);
    expect(
      store
        .entries(manager)
        .some((entry) => entry.text === 'Already completed step; do not repeat'),
    ).toBe(true);
    const next = await start(manager, 'Explicitly continue after inspection');
    expect(next.session.options.sessionId).toBe(threadId);
    expect(next.session.submit.mock.calls[0]![0].text).toContain(
      'Explicitly continue after inspection',
    );
    expect(store.run(run.id).status).toBe('interrupted');
  });
  it('an interrupted turn stays gated until its explicit owner continuation', async () => {
    const { session, run } = await start();
    await runtime.interrupt(manager);
    expect(session.interrupt).toHaveBeenCalledOnce();
    finish(session, run.id, 'interrupted');
    await vi.waitFor(() => expect(store.agent(manager).status).toBe('interrupted'));
    await runtime.restoreSessions([manager]);
    expect(session.submit).toHaveBeenCalledOnce();
    expect(store.runs()).toHaveLength(1);
  });
  it('Stop during prepare retains the scheduler lease and never submits the cancelled input', async () => {
    let release!: () => void;
    auth.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(identity);
        }),
    );
    const stopped = store.enqueue(manager, randomUUID(), 'Never submit this cancelled prompt');
    await vi.waitFor(() => expect(auth).toHaveBeenCalled());
    await runtime.interrupt(manager);
    expect(store.run(stopped.id).status).toBe('interrupted');
    expect(runtime.executing.has(manager)).toBe(true);
    const next = store.enqueue(manager, randomUUID(), 'Explicit replacement after Stop');
    expect(instances).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(instances.at(-1)?.submit).toHaveBeenCalledOnce());
    const replacement = instances.at(-1)!;
    expect(replacement.submit.mock.calls[0]![0].deliveryId).toBe(next.id);
    expect(replacement.submit.mock.calls[0]![0].text).toContain('Explicit replacement after Stop');
    expect(
      instances.every((session) =>
        session.submit.mock.calls.every(([input]) => input.deliveryId !== stopped.id),
      ),
    ).toBe(true);
    expect(store.run(stopped.id).status).toBe('interrupted');
    expect(store.runs().some((run) => run.kind === 'report')).toBe(false);
  });
  it('Stop during submit cannot revive a failure or clobber the next explicit same-session prompt', async () => {
    let reject!: (error: Error) => void;
    configureSession = (session) => {
      if (instances.length) return;
      session.submit.mockImplementation(
        () =>
          new Promise((_resolve, rejectPromise) => {
            reject = rejectPromise;
          }),
      );
      session.interrupt.mockResolvedValue('cancelled_start');
    };
    const { session, run } = await start(manager, 'Cancelled before transport input');
    const contextId = session.options.sessionId;
    await runtime.interrupt(manager);
    expect(store.run(run.id).status).toBe('interrupted');
    expect(runtime.executing.has(manager)).toBe(true);
    const next = store.enqueue(manager, randomUUID(), 'Next deliberate prompt');
    reject(new ClaudeSubmissionCancelled());
    await vi.waitFor(() => expect(instances.at(-1)).not.toBe(session));
    const replacement = instances.at(-1)!;
    await vi.waitFor(() => expect(replacement.submit).toHaveBeenCalledOnce());
    expect(replacement.options.sessionId).toBe(contextId);
    expect(replacement.options.resume).toBe(false); // Cancelled before the first native user frame.
    expect(replacement.submit.mock.calls[0]![0].deliveryId).toBe(next.id);
    expect(store.run(run.id).status).toBe('interrupted');
    expect(store.runs().some((run) => run.kind === 'report')).toBe(false);
    expect(
      store.entries(manager).some((entry) => entry.title === 'Could not complete this turn'),
    ).toBe(false);
  });
  it('unknown account and missing original approvals cannot silently start another provider', async () => {
    const { session, run } = await start();
    request(session);
    await vi.waitFor(() => expect(store.approvals()).toHaveLength(1));
    const approval = store.approvals()[0]!;
    await runtime.claude.forget(manager);
    await expect(runtime.approve(approval.id, 'accept')).rejects.toThrow('original Claude request');
    await runtime.close();
    runtime = createRuntime();
    await runtime.initialize();
    auth.mockResolvedValue({ ...identity, affinity: 'f'.repeat(64) });
    finish(session, run.id); // Forgotten session's late completion is inert.
    const results = await runtime.restoreSessions([manager]);
    expect(results[0]!.state).not.toBe('connected');
    expect(store.agent(manager).threadId).toBe(session.options.sessionId);
    expect(codexFactory).not.toHaveBeenCalled();
  });
  it('native Codex-only controls reject Claude, and new context explicitly retains old archive', async () => {
    const { session, run } = await start();
    session.send({ type: 'message', id: 'old', role: 'assistant', text: 'Old retained evidence' });
    finish(session, run.id);
    await vi.waitFor(() => expect(store.run(run.id).status).toBe('completed'));
    await expect(runtime.attach(manager)).rejects.toThrow('belongs to Codex');
    const previous = store.agent(manager).threadId;
    await runtime.newContext(manager);
    expect(store.agent(manager).threadId).toBeNull();
    expect(store.entries(manager).some((entry) => entry.text === 'Old retained evidence')).toBe(
      true,
    );
    const next = await start();
    expect(next.session.options.sessionId).not.toBe(previous);
    expect(next.session.options.resume).toBe(false);
    expect(codexFactory).not.toHaveBeenCalled();
  });
  it('mixed-provider research uses existing files and explicit target-model settings', async () => {
    const task = store.addTask(project, {
      title: 'One result',
      goal: 'Read one result',
      acceptance: 'Evidence',
      parentId: null,
    });
    const worker = (await managerTool(runtime, manager, 'mixed-worker', 'dock_delegate', {
      taskId: task.id,
      role: 'researcher',
      name: 'Codex peer',
      instruction: 'Read only',
      execution: {
        provider: 'codex',
        model: 'demo',
        effort: 'medium',
        difficulty: 'low',
        reason: 'Fixture explicit target provider',
      },
    })) as { id: string };
    const saved = store.agent(worker.id);
    expect(saved.provider).toBe('codex');
    expect(saved.model).toBe('demo');
    expect(saved.cwd).toBe(projectRoot);
    expect(saved.permission).toBe('read-only');
    expect(existsSync(saved.cwd)).toBe(true);
    expect(saved.parentId).toBe(manager);
    expect(saved.taskId).toBe(task.id);
    expect(saved.assignment?.provider).toBe('codex');
    const repeated = (await managerTool(runtime, manager, 'mixed-worker', 'dock_delegate', {
      taskId: task.id,
      role: 'researcher',
      name: 'Codex peer',
      instruction: 'Read only',
      execution: {
        provider: 'codex',
        model: 'demo',
        effort: 'medium',
        difficulty: 'low',
        reason: 'Fixture explicit target provider',
      },
    })) as { id: string };
    expect(repeated.id).toBe(worker.id);
  });
  it('uses the target provider central defaults without inheriting the manager model', async () => {
    const task = store.addTask(project, {
      title: 'One result',
      goal: 'Read one result',
      acceptance: 'Evidence',
      parentId: null,
    });
    await expect(
      managerTool(runtime, manager, randomUUID(), 'dock_delegate', {
        taskId: task.id,
        role: 'researcher',
        name: 'Invalid peer',
        instruction: 'Read only',
        execution: { provider: 'codex' },
      }),
    ).resolves.toMatchObject({
      provider: 'codex',
      model: 'demo',
      assignment: { tier: 'grad', policyRevision: '0' },
    });
    expect(store.agents()).toHaveLength(2);
    expect(store.runs().filter((r) => r.agentId !== manager)).toHaveLength(1);
    expect(existsSync(join(root, 'worktrees', task.id))).toBe(false);
  });
  it('shutdown cancels only owned Claude sessions and never launches an idle saved identity', async () => {
    const { session } = await start();
    await runtime.close();
    expect(session.close).toHaveBeenCalledOnce();
    runtime = createRuntime();
    await runtime.initialize();
    const count = instances.length;
    await runtime.close();
    expect(instances).toHaveLength(count);
    expect(codexFactory).not.toHaveBeenCalled();
  });
});
