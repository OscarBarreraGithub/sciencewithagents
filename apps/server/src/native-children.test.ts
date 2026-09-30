import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { DemoProvider } from './demo.js';
import { NativeChildren, nativeChildConfig } from './native-children.js';
import { repoRoot } from './paths.js';

let dir: string, store: Store, children: NativeChildren, provider: DemoProvider;
let rootId: string, rootThread: string, sessionId: string;
let metadata: Map<string, Record<string, unknown>>;
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  dir = mkdtempSync(join(repoRoot, 'data/tests/children-'));
  store = new Store(join(dir, 'dock.sqlite'));
  children = new NativeChildren(store);
  provider = new DemoProvider();
  const project = store.register(dir, 'Children fixture', '');
  rootId = store.addAgent({
    projectId: project.id,
    parentId: project.managerId,
    taskId: null,
    role: 'researcher',
    name: 'Parent',
    cwd: dir,
    provider: 'codex',
  }).id;
  rootThread = randomUUID();
  sessionId = randomUUID();
  store.updateAgent(rootId, {
    threadId: rootThread,
    mcpServers: ['fixture'],
    webSearch: 'indexed',
    imageGeneration: true,
    checkpoint: 'Parent checkpoint',
  });
  metadata = new Map([
    [
      rootThread,
      {
        id: rootThread,
        sessionId,
        parentThreadId: null,
        cwd: dir,
        ephemeral: false,
        source: 'appServer',
      },
    ],
  ]);
  vi.spyOn(provider, 'request').mockImplementation(async (method, raw) => {
    expect(method).toBe('thread/read');
    return { thread: metadata.get((raw as { threadId: string }).threadId) };
  });
});
afterEach(async () => {
  await provider.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const addThread = (parentThreadId = rootThread, path = '/root/helper') => {
  const id = randomUUID();
  metadata.set(id, {
    id,
    sessionId,
    parentThreadId,
    cwd: dir,
    ephemeral: false,
    source: { subAgent: { thread_spawn: { parent_thread_id: parentThreadId, agent_path: path } } },
    model: 'fixture-model',
    reasoningEffort: 'high',
  });
  return id;
};

it('retains proven Claude nesting across restart without cycles, cross-session links or parent replacement', () => {
  const manager = store.register(join(dir, 'claude'), 'Claude', '', 'claude').managerId;
  const session = randomUUID();
  store.updateAgent(manager, { threadId: session });
  const first = children.claude(manager, session, 'first')!;
  const nested = children.claude(manager, session, 'nested')!;
  const other = children.claude(manager, session, 'other')!;
  expect(nested.parentId).toBe(manager); // Only session ownership is initially known.
  children.claudeParent(manager, session, nested.id, first.id, 'first-dispatch');
  expect(store.agent(nested.id).parentId).toBe(first.id);
  const head = store.head;
  children.claudeParent(manager, session, nested.id, first.id, 'first-dispatch');
  children.claudeParent(manager, session, nested.id, other.id, 'different-caller');
  children.claudeParent(manager, session, first.id, nested.id, 'cycle');
  children.claudeParent(manager, session, other.id, other.id, 'self');
  children.claudeParent(manager, randomUUID(), other.id, first.id, 'wrong-session');
  children.claudeParent(manager, session, other.id, rootId, 'other-family');
  expect(store.head).toBe(head);
  expect(store.agent(first.id).parentId).toBe(manager);
  store.close();
  store = new Store(join(dir, 'dock.sqlite'));
  children = new NativeChildren(store);
  expect(store.agent(nested.id)).toMatchObject({
    parentId: first.id,
    nativeRootId: manager,
    nativePath: `${session}/nested`,
  });
  expect(store.getSetting(`claude:parent:${nested.id}`)).toEqual({
    parentId: first.id,
    sessionId: session,
    toolId: 'first-dispatch',
  });
  expect(children.family(nested.id)).toHaveLength(4);
});

it('enables bounded worker helpers but keeps managers disabled and unrelated feature gates intact', async () => {
  const config = {
    features: {
      multi_agent: false,
      multi_agent_v2: false,
      shell_tool: false,
      plugins: true,
      hooks: false,
      unused: null,
    },
    agents: {
      enabled: false,
      max_threads: 99,
      fixture_reader: { config_file: '/private/fixture.toml' },
      default_subagent_model: null,
    },
  };
  vi.mocked(provider.request).mockResolvedValue({ config });
  for (const manager of [false, true]) {
    expect(await nativeChildConfig(provider, manager)).toEqual({
      features: {
        multi_agent: !manager,
        multi_agent_v2: !manager,
        shell_tool: false,
        plugins: true,
        hooks: false,
      },
      agents: {
        enabled: !manager,
        max_concurrent_threads_per_session: 2,
        fixture_reader: { config_file: '/private/fixture.toml' },
      },
    });
  }
  expect(config.agents.max_threads).toBe(99);
  expect(vi.mocked(provider.request).mock.calls.every(([method]) => method === 'config/read')).toBe(
    true,
  );
});

it('refuses malformed native configuration without starting or changing a provider context', async () => {
  vi.mocked(provider.request).mockResolvedValue({
    config: { features: { shell_tool: 'unknown' } },
  });
  await expect(nativeChildConfig(provider, false)).rejects.toThrow();
  expect(provider.request).toHaveBeenCalledTimes(1);
});

it('registers nested identities once with provider session provenance, inherited policy and separate checkpoints', async () => {
  const child = addThread(),
    grandchild = addThread(child, '/root/helper/nested');
  const nested = await children.resolve(rootId, grandchild, provider);
  const parent = store.agent(nested!.parentId!);
  expect(parent).toMatchObject({
    parentId: rootId,
    threadId: child,
    nativeRootId: rootId,
    nativePath: '/root/helper',
    role: 'researcher',
    permission: 'read-only',
    mcpServers: ['fixture'],
    webSearch: 'indexed',
    imageGeneration: true,
    checkpoint: '',
  });
  expect(nested).toMatchObject({
    threadId: grandchild,
    nativeRootId: rootId,
    nativePath: '/root/helper/nested',
    role: 'researcher',
    model: 'fixture-model',
    effort: 'high',
    webSearch: 'indexed',
    imageGeneration: true,
  });
  expect(store.agent(rootId).checkpoint).toBe('Parent checkpoint');
  const events = store.events();
  expect((await children.resolve(rootId, grandchild, provider))?.id).toBe(nested!.id);
  expect(store.events()).toEqual(events);
  expect(children.family(rootId).map((a) => a.id)).toEqual([rootId, parent.id, nested!.id]);
  expect(children.rootId(nested!.id)).toBe(rootId);
  store.close();
  store = new Store(join(dir, 'dock.sqlite'));
  children = new NativeChildren(store);
  expect((await children.resolve(rootId, grandchild, provider))?.id).toBe(nested!.id);
  expect(store.events()).toEqual(events);
});

it('observes a native manager child in the parent runtime workspace without giving it a separate manager lease', async () => {
  store.updateAgent(rootId, { role: 'manager', toolPolicy: 'native' });
  const cwd = join(dir, 'manager-runtime');
  metadata.get(rootThread)!.cwd = cwd;
  const childId = addThread();
  metadata.get(childId)!.cwd = cwd;
  const child = await children.resolve(rootId, childId, provider);
  expect(child).toMatchObject({
    nativeRootId: rootId,
    parentId: rootId,
    role: 'researcher',
    toolPolicy: 'native',
    cwd,
  });
  store.updateAgent(rootId, { toolPolicy: 'restricted' });
  expect(await children.resolve(rootId, addThread(), provider)).toBeNull();
});

it('waits for initial child metadata without replaying model work or losing the original identity', async () => {
  const child = addThread();
  vi.mocked(provider.request).mockRejectedValueOnce(
    new Error(
      'failed to read session metadata /private/rollout.jsonl: rollout at /private/rollout.jsonl is empty',
    ),
  );
  expect((await children.resolve(rootId, child, provider))?.threadId).toBe(child);
  expect(provider.request).toHaveBeenCalledTimes(3);
  expect(vi.mocked(provider.request).mock.calls.every(([method]) => method === 'thread/read')).toBe(
    true,
  );
});

it('does not retry unrelated metadata failures or expose private provider diagnostics', async () => {
  const child = addThread();
  vi.mocked(provider.request).mockRejectedValueOnce(new Error('private unrelated failure'));
  await expect(children.resolve(rootId, child, provider)).rejects.toThrow(
    'Native child metadata could not be read',
  );
  expect(provider.request).toHaveBeenCalledTimes(1);
  expect(store.contextOwner(child)).toBeNull();
});

it('bounds an empty-metadata wait without installing a partial child', async () => {
  const child = addThread();
  vi.mocked(provider.request).mockRejectedValue(
    new Error(
      'failed to read session metadata /private/rollout.jsonl: rollout at /private/rollout.jsonl is empty',
    ),
  );
  await expect(children.resolve(rootId, child, provider)).rejects.toThrow(
    'Native child metadata could not be read',
  );
  expect(provider.request).toHaveBeenCalledTimes(8);
  expect(store.contextOwner(child)).toBeNull();
});

it('refuses mismatched session, workspace, origin, ownership, manager and retired-parent identities', async () => {
  for (const change of [
    { sessionId: randomUUID() },
    { cwd: join(dir, 'other') },
    { ephemeral: true },
    { id: randomUUID() },
    { source: 'appServer' },
    {
      source: {
        subAgent: { thread_spawn: { parent_thread_id: randomUUID(), agent_path: '/root/helper' } },
      },
    },
  ]) {
    const child = addThread();
    Object.assign(metadata.get(child)!, change);
    expect(await children.resolve(rootId, child, provider)).toBeNull();
    expect(store.contextOwner(child)).toBeNull();
  }
  const child = addThread();
  expect(await children.resolve(store.agent(rootId).parentId!, child, provider)).toBeNull();
  store.updateAgent(rootId, { threadId: randomUUID() });
  expect(await children.resolve(rootId, child, provider)).toBeNull();
  store.updateAgent(rootId, { threadId: rootThread });
  const outsider = store.addAgent({
    projectId: store.register(join(dir, 'other'), 'Other', '').id,
    parentId: null,
    taskId: null,
    role: 'researcher',
    name: 'Other',
    provider: 'codex',
    cwd: dir,
  });
  store.updateAgent(outsider.id, { threadId: child });
  expect(await children.resolve(rootId, child, provider)).toBeNull();
});

it('rejects cyclic and malformed metadata without including provider values in an exception', async () => {
  const a = addThread(),
    b = addThread(a);
  Object.assign(metadata.get(a)!, {
    parentThreadId: b,
    source: { subAgent: { thread_spawn: { parent_thread_id: b, agent_path: '/cycle' } } },
  });
  expect(await children.resolve(rootId, a, provider)).toBeNull();
  const malformed = addThread();
  metadata.set(malformed, { id: 'private provider diagnostic' });
  expect(await children.resolve(rootId, malformed, provider)).toBeNull();
  expect(store.agents()).toHaveLength(2);
});
