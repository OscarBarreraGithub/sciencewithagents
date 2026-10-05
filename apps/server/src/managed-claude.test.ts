import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ManagedClaude } from './managed-claude.js';
import {
  ClaudeSession,
  parseClaudeIdentity,
  type ClaudeModel,
  type ClaudeSessionOptions,
} from './claude-session.js';
import { Store } from './store.js';

const identity = parseClaudeIdentity({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'fixture@example.invalid',
  orgId: 'fixture',
});
const catalog: ClaudeModel[] = [
  {
    value: 'default',
    displayName: 'Default fixture',
    description: '',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  {
    value: 'opus[1m]',
    displayName: 'Long fixture',
    description: '',
    supportsEffort: true,
    supportedEffortLevels: ['medium', 'high'],
  },
  { value: 'no-known-effort', displayName: 'No effort fixture', description: '' },
];
class FixtureSession extends ClaudeSession {
  override submit = vi.fn(async (_input: { deliveryId: string; text: string }) => {});
  override close = vi.fn(async () => {});
}
let root: string, store: Store, managerId: string, managed: ManagedClaude;
let instances: FixtureSession[];
const auth = vi.fn(async () => identity);
const inspect = vi.fn(async () => ({ identity, models: catalog }));
const invoke = vi.fn(async (_agentId: string, _key: string, _name: string, _input: unknown) => ({
  retained: true,
}));
const events = vi.fn();
const dependencies = () => ({
  identity: auth,
  inspect,
  session: (options: ClaudeSessionOptions) => {
    const session = new FixtureSession(options);
    instances.push(session);
    return session;
  },
});
const callbacks = () => ({
  charter: () => 'Coordinate only.',
  tools: () => [
    {
      type: 'function' as const,
      name: 'dock_inspect',
      description: 'Inspect evidence',
      inputSchema: { type: 'object' },
      deferLoading: false,
    },
  ],
  invoke,
  event: events,
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dock-managed-claude-'));
  store = new Store(join(root, 'dock.sqlite'));
  managerId = store.register(root, 'Fixture', '').managerId;
  store.updateAgent(managerId, { provider: 'claude' });
  instances = [];
  auth.mockReset().mockResolvedValue(identity);
  inspect.mockReset().mockResolvedValue({ identity, models: catalog });
  invoke.mockClear();
  events.mockClear();
  managed = new ManagedClaude(store, root, callbacks(), dependencies());
});
afterEach(async () => {
  await managed.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it('refreshes changed host instructions and tool definitions without replacing the saved conversation', async () => {
  let charter = 'Original instructions';
  let description = 'Original tool';
  managed = new ManagedClaude(
    store,
    root,
    {
      ...callbacks(),
      charter: () => charter,
      tools: () =>
        callbacks()
          .tools()
          .map((tool) => ({ ...tool, description })),
    },
    dependencies(),
  );
  const first = await managed.prepare(store.agent(managerId));
  const id = first.options.sessionId;
  store.setSetting(`claude:started:${id}`, true);
  expect(await managed.prepare(store.agent(managerId))).toBe(first);
  charter = 'Notes belong to the owner.';
  const second = await managed.prepare(store.agent(managerId));
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.options).toMatchObject({ charter, sessionId: id, resume: true });
  description = 'Current tool';
  const third = await managed.prepare(store.agent(managerId));
  expect(second.close).toHaveBeenCalledOnce();
  expect(third.options.sessionId).toBe(id);
  expect(third.options.tools?.[0]?.description).toBe(description);
});

describe('managed Claude host lifecycle', () => {
  it.each(['workspace-write', 'read-only'] as const)(
    'keeps a standalone conversation in its private folder with %s permission',
    async (permission) => {
      const cwd = join(root, 'conversations', randomUUID());
      store.updateAgent(managerId, { surface: 'misc', cwd, permission, toolPolicy: 'native' });
      const session = await managed.prepare(store.agent(managerId));
      expect(session.options).toMatchObject({
        cwd,
        inheritNative: true,
        unattended: true,
        role: permission === 'workspace-write' ? 'implementer' : 'read-only',
      });
      expect((session as FixtureSession).submit).not.toHaveBeenCalled();
    },
  );

  it.each(['workspace-write', 'read-only'] as const)(
    'honors a project manager’s saved %s boundary',
    async (permission) => {
      store.updateAgent(managerId, { permission, toolPolicy: 'native' });
      const session = await managed.prepare(store.agent(managerId));
      expect(session.options).toMatchObject({
        inheritNative: true,
        unattended: true,
        role: permission === 'workspace-write' ? 'manager' : 'read-only',
        // The native session keeps its private folder; a writing manager also changes its project.
        writableDirectories: permission === 'workspace-write' ? [store.agent(managerId).cwd] : [],
      });
      expect(session.options.cwd).not.toBe(store.agent(managerId).cwd);
    },
  );

  it('preserves coordination-only built-ins for a restricted manager', async () => {
    store.updateAgent(managerId, { permission: 'read-only', toolPolicy: 'restricted' });
    const session = await managed.prepare(store.agent(managerId));
    expect(session.options).toMatchObject({ inheritNative: false, role: 'manager' });
  });

  it('retains native aliases and exposes reported concrete versions for stable pins', async () => {
    inspect.mockResolvedValue({
      identity,
      models: [
        {
          ...catalog[0]!,
          value: 'opus',
          displayName: 'Opus current',
          resolvedModel: 'claude-opus-5-5',
        },
      ],
    });
    const available = await managed.models();
    expect(available.map((model) => model.id)).toEqual(['opus', 'claude-opus-5-5']);
    expect(available[1]?.label).toContain('exact version');
  });

  it('persists an uncertain fork start before I/O and resumes only its known target after restart', async () => {
    const sourceThreadId = randomUUID(),
      sourceMessageId = randomUUID();
    store.updateAgent(managerId, {
      role: 'researcher',
      webSearch: 'disabled',
      permission: 'read-only',
      interview: {
        sourceAgentId: randomUUID(),
        sourceTaskId: null,
        capturedAt: new Date().toISOString(),
        continuity: 'native-fork',
        sourceThreadId,
        sourceMessageId,
      },
    });
    const first = await managed.prepare(store.agent(managerId));
    expect(first.options.forkFrom).toEqual({
      sessionId: sourceThreadId,
      messageId: sourceMessageId,
    });
    expect(store.getSetting(`claude:fork-attempted:${first.options.sessionId}`)).not.toBe(true);
    expect(() => first.options.beforeStart!()).toThrow('cancelled');
    const run = store.enqueue(managerId, randomUUID(), 'Explain');
    store.updateRun(run.id, { status: 'running', turnId: run.id });
    store.updateAgent(managerId, { status: 'running', turnId: run.id });
    first.options.beforeStart!();
    // Crash before init or message acknowledgement: durable target must not be replaced.
    await managed.close();
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    managed = new ManagedClaude(store, root, callbacks(), dependencies());
    const restored = await managed.prepare(store.agent(managerId));
    expect(restored.options.sessionId).toBe(first.options.sessionId);
    expect(restored.options.resume).toBe(true);
    expect(restored.options.forkFrom).toBeUndefined();
    expect((restored as FixtureSession).submit).not.toHaveBeenCalled();
  });
  it.each([false, undefined])(
    'keeps models with effort support %s usable through native defaults without inventing a thinking level',
    async (supportsEffort) => {
      inspect.mockResolvedValue({
        identity,
        models: [
          { value: 'haiku-future', displayName: 'Haiku fixture', description: '', supportsEffort },
        ],
      });
      expect((await managed.models())[0]?.efforts).toEqual(['provider-default']);
      store.updateAgent(managerId, { model: 'haiku-future', effort: 'provider-default' });
      const first = await managed.prepare(store.agent(managerId));
      expect(first.options.effort).toBe('provider-default');
      expect(first.options.model).toBe('haiku-future');
      await managed.forget(managerId);
      store.updateAgent(managerId, { effort: 'high' });
      await expect(managed.prepare(store.agent(managerId))).rejects.toThrow('thinking level');
    },
  );
  it('keeps a newly reported thinking level selectable through catalog, persistence and launch', async () => {
    inspect.mockResolvedValue({
      identity,
      models: [{ ...catalog[0]!, supportedEffortLevels: ['adaptive-v2'] }],
    });
    expect((await managed.models())[0]?.efforts).toEqual(['adaptive-v2', 'provider-default']);
    store.updateAgent(managerId, { effort: 'adaptive-v2' });
    const session = await managed.prepare(store.agent(managerId));
    expect(session.options.effort).toBe('adaptive-v2');
    expect(store.agent(managerId).effort).toBe('adaptive-v2');
  });
  it('prepares one inert context with durable provider/account identity and exact reported settings', async () => {
    const [one, two] = await Promise.all([
      managed.prepare(store.agent(managerId)),
      managed.prepare(store.agent(managerId)),
    ]);
    expect(one).toBe(two);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.submit).not.toHaveBeenCalled();
    const saved = store.agent(managerId);
    expect(saved.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.model).toBe('default');
    expect(one.options).toMatchObject({
      sessionId: saved.threadId,
      resume: false,
      role: 'manager',
      cwd: join(root, 'managers', managerId),
      model: 'default',
      accountAffinity: identity.affinity,
    });
    expect(store.getSetting(`claude:account:${managerId}`)).toBe(identity.affinity);
    expect(await managed.models()).toEqual([
      {
        id: 'default',
        label: 'Default fixture',
        isDefault: true,
        efforts: ['low', 'medium', 'high', 'provider-default'],
      },
      {
        id: 'opus[1m]',
        label: 'Long fixture',
        isDefault: false,
        efforts: ['medium', 'high', 'provider-default'],
      },
      {
        id: 'no-known-effort',
        label: 'No effort fixture',
        isDefault: false,
        efforts: ['provider-default'],
      },
    ]);
  });
  it('reopens the exact saved session lazily, retaining old identity and without submitting', async () => {
    const first = await managed.prepare(store.agent(managerId));
    first.emit('event', {
      type: 'session',
      sessionId: first.options.sessionId,
      model: 'resolved-fixture',
      tools: ['mcp__dock__dock_inspect'],
    });
    await managed.close();
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    managed = new ManagedClaude(store, root, callbacks(), dependencies());
    const restored = await managed.prepare(store.agent(managerId));
    expect(restored.options.sessionId).toBe(first.options.sessionId);
    expect(restored.options.resume).toBe(true);
    expect((restored as FixtureSession).submit).not.toHaveBeenCalled();
    expect(store.agent(managerId).model).toBe('default');
  });
  it('refuses changed account or unknown historical account without replacing identity', async () => {
    const first = await managed.prepare(store.agent(managerId));
    await managed.forget(managerId);
    auth.mockResolvedValue({ ...identity, affinity: 'f'.repeat(64) });
    await expect(managed.prepare(store.agent(managerId))).rejects.toThrow('original local account');
    expect(store.agent(managerId).threadId).toBe(first.options.sessionId);
    expect(instances).toHaveLength(1);
    auth.mockResolvedValue(identity);
    store.setSetting(`claude:account:${managerId}`, null);
    await expect(managed.prepare(store.agent(managerId))).rejects.toThrow('original local account');
  });
  it('rejects unknown model, effort and unsupported worker features without making a session', async () => {
    for (const change of [
      { model: 'codex-only' },
      { effort: 'ultra' as const },
      { pluginsEnabled: true },
      { mcpServers: ['external'] },
      { imageGeneration: true },
      { webSearch: 'live' as const },
    ]) {
      store.updateAgent(managerId, {
        toolPolicy: 'restricted',
        model: null,
        effort: 'medium',
        pluginsEnabled: false,
        mcpServers: [],
        imageGeneration: false,
        webSearch: 'disabled',
        ...change,
      });
      await expect(managed.prepare(store.agent(managerId))).rejects.toThrow();
      expect(instances).toHaveLength(0);
      expect(store.agent(managerId).threadId).toBeNull();
    }
  });
  it('role and saved permission decide worker tools, preserving the existing task workspace', async () => {
    const project = store.agent(managerId).projectId;
    for (const permission of ['read-only', 'workspace-write'] as const) {
      const worker = store.addAgent({
        projectId: project,
        parentId: managerId,
        taskId: null,
        role: 'implementer',
        cwd: join(root, `worktree-${permission}`),
        name: 'Worker',
        provider: 'claude',
      });
      store.updateAgent(worker.id, { webSearch: 'disabled', permission, model: 'opus[1m]' });
      const session = await managed.prepare(store.agent(worker.id));
      expect(session.options.cwd).toBe(worker.cwd);
      expect(session.options.role).toBe(
        permission === 'workspace-write' ? 'implementer' : 'read-only',
      );
    }
  });
  it('typed coordination retains full operation identity and refuses cancelled or retired contexts', async () => {
    const session = await managed.prepare(store.agent(managerId));
    const tool = session.options.tools[0]!;
    const controller = new AbortController();
    const context = {
      sessionId: session.options.sessionId,
      requestId: 'original-request',
      signal: controller.signal,
    };
    expect(await tool.invoke({ taskId: 'fixture' }, context)).toEqual({
      content: [{ type: 'text', text: '{"retained":true}' }],
    });
    expect(invoke).toHaveBeenCalledWith(
      managerId,
      `claude-tool:${managerId}:${session.options.sessionId}:original-request`,
      'dock_inspect',
      { taskId: 'fixture' },
    );
    controller.abort();
    await expect(tool.invoke({}, context)).rejects.toThrow('no longer connected');
    store.updateAgent(managerId, { threadId: randomUUID() });
    await expect(
      tool.invoke({}, { ...context, signal: new AbortController().signal }),
    ).rejects.toThrow('no longer connected');
    expect(invoke).toHaveBeenCalledOnce();
  });
  it('reports invalid coordination fields without echoing inputs or unexpected internal errors', async () => {
    const session = await managed.prepare(store.agent(managerId));
    const tool = session.options.tools[0]!;
    const context = {
      sessionId: session.options.sessionId,
      requestId: 'invalid-reserve',
      signal: new AbortController().signal,
    };
    const invalid = z
      .object({ reservePercent: z.number().min(5) })
      .safeParse({ reservePercent: 0 });
    if (invalid.success) throw new Error('Fixture must fail its old contract.');
    invoke.mockRejectedValueOnce(invalid.error);
    const result = await tool.invoke(
      { reservePercent: 0, reason: 'Private owner instruction' },
      context,
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toContain('reservePercent');
    expect(result.content[0]?.text).toContain('Correct the input');
    expect(result.content[0]?.text).not.toContain('Private owner instruction');
    invoke.mockRejectedValueOnce(new Error('Private internal diagnostic'));
    const unexpected = await tool.invoke({}, context);
    expect(unexpected).toMatchObject({ isError: true });
    expect(unexpected.content[0]?.text).toBe(
      'Coordination failed. Inspect the recorded task before retrying.',
    );
  });
  it('old process events cannot act after forget; shutdown closes only sessions it owns', async () => {
    const first = await managed.prepare(store.agent(managerId));
    await managed.forget(managerId);
    first.emit('event', { type: 'unavailable', message: 'Late old event' });
    expect(events).not.toHaveBeenCalled();
    expect((first as FixtureSession).close).toHaveBeenCalledOnce();
    const second = await managed.prepare(store.agent(managerId));
    await managed.close();
    expect((second as FixtureSession).close).toHaveBeenCalledOnce();
    await expect(managed.prepare(store.agent(managerId))).rejects.toThrow('stopping');
  });
  it('cannot prepare Codex or a provider-native child through the Claude adapter', async () => {
    store.updateAgent(managerId, { provider: 'codex' });
    await expect(managed.prepare(store.agent(managerId))).rejects.toThrow('not a standalone');
    expect(auth).not.toHaveBeenCalled();
  });
});
