import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSchema, conversationCreateSchema } from '@dock/shared';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { createConversation } from './conversations.js';
import { createProject } from './projects.js';
import { FolderConnections } from './folder-picker.js';
import { git } from './workspaces.js';
import { runRecoveryView } from './run-recovery.js';
import { materialDemand } from './quark-demand.js';
import { GroupEventRepository } from './group-events.js';
import { registerGroupHostEvidence } from './group-host-native-tools.js';
import { GROUP_PRIVATE_EVIDENCE_TOOL } from './group-evidence-private.js';
import { GROUP_EVIDENCE_ORIGINAL_TOOL } from './group-evidence-original.js';
import { groupNativeReadingNames } from './group-native-reading-names.js';

let root: string, store: Store, runtime: Runtime;
let provider: DemoProvider;
let requests: MockInstance<DemoProvider['request']>;
function open() {
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const connect = () => {
    provider = new DemoProvider();
    const original = provider.request.bind(provider);
    requests = vi
      .spyOn(provider, 'request')
      .mockImplementation(async (method, params) =>
        method === 'turn/start'
          ? { turn: { id: randomUUID(), status: 'inProgress' } }
          : original(method, params),
      );
  };
  connect();
  runtime = new Runtime(store, root, 'never-spawn-native', async () => {
    if (!provider.ready) connect();
    return provider;
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-native-direct-'));
  open();
});
afterEach(async () => {
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const starts = () => requests.mock.calls.filter(([method]) => method === 'turn/start');
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const direct = () => {
  const cwd = join(root, randomUUID());
  mkdirSync(cwd);
  return store.register(cwd, 'Native fixture', '', 'codex', undefined, 'direct');
};
const finish = async (agentId: string, runId: string) => {
  provider.emit('notification', 'turn/completed', {
    threadId: store.agent(agentId).threadId,
    turn: { id: store.run(runId).turnId, status: 'completed' },
  });
  await vi.waitFor(() => expect(store.run(runId).status).toBe('completed'));
};

it('persists fresh direct defaults, explicit managed choice and exact restart receipts without converting legacy identities', async () => {
  const input = { key: randomUUID(), name: 'Native fixture', provider: 'codex' };
  const first = await createConversation(store, runtime.modelPolicy, root, input);
  expect(first.executionMode).toBe('direct');
  const managed = await createConversation(store, runtime.modelPolicy, root, {
    ...input,
    key: randomUUID(),
    executionMode: 'managed',
  });
  expect(managed.executionMode).toBe('managed');
  const legacyInput = { ...input, key: randomUUID() };
  store.setSetting(`conversation.create:${legacyInput.key}`, {
    input: JSON.stringify(conversationCreateSchema.parse(legacyInput)),
    model: 'demo',
    effort: 'medium',
    assignment: null,
  });
  const legacy = await createConversation(store, runtime.modelPolicy, root, legacyInput);
  expect(legacy.executionMode).toBe('managed');
  const old = store.agent(legacy.id);
  const { executionMode: _omitted, ...raw } = old;
  store.db.prepare('UPDATE agents SET body=? WHERE id=?').run(JSON.stringify(raw), old.id);
  expect(agentSchema.parse(raw).executionMode).toBe('managed');
  expect(store.agent(old.id).executionMode).toBe('managed');
  expect(() => store.updateAgent(old.id, { executionMode: 'direct' })).toThrow('not converted');
  await expect(
    createConversation(store, runtime.modelPolicy, root, { ...input, executionMode: 'managed' }),
  ).rejects.toThrow('different input');
  expect(store.runs()).toHaveLength(0);
  await runtime.close();
  store.close();
  open();
  vi.spyOn(runtime.modelPolicy, 'catalog').mockRejectedValue(new Error('Offline native catalog'));
  expect(await createConversation(store, runtime.modelPolicy, root, input)).toEqual(first);
  expect(store.agent(old.id).executionMode).toBe('managed');
});

it('keeps fresh projects and selected folders managed while retaining old creation reservations and existing projects', async () => {
  const input = { key: randomUUID(), name: 'Fresh project' };
  const project = await createProject(store, root, input);
  expect(store.agent(project.managerId).executionMode).toBe('managed');
  expect(await createProject(store, root, input)).toEqual(project);
  await expect(createProject(store, root, { ...input, executionMode: 'direct' })).rejects.toThrow(
    'different project',
  );
  const oldInput = { key: randomUUID(), name: 'Reserved old project' };
  store.setSetting(`project-create:${oldInput.key}`, {
    directoryId: randomUUID(),
    name: oldInput.name,
    description: '',
    provider: 'codex',
    requestedProvider: 'policy',
  });
  const old = await createProject(store, root, oldInput);
  expect(store.agent(old.managerId).executionMode).toBe('managed');
  const selected = join(root, 'selected');
  mkdirSync(selected);
  await git(selected, ['init', '--template=', '--initial-branch=main']);
  await git(selected, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'Fixture',
  ]);
  writeFileSync(join(selected, 'native.txt'), 'Keep native files');
  mkdirSync(join(root, 'runtime'));
  const folders = new FolderConnections(store, join(root, 'runtime'), async () => selected);
  const key = randomUUID();
  const folder = await folders.connect(key);
  expect(folder).not.toBeNull();
  expect(store.agent(folder!.managerId).executionMode).toBe('managed');
  expect(await folders.connect(key)).toEqual(folder);
  await expect(
    folders.connect(key, undefined, false, undefined, undefined, false, 'direct'),
  ).rejects.toThrow('execution mode');
  const existing = await folders.connect(
    randomUUID(),
    undefined,
    false,
    undefined,
    undefined,
    false,
    'direct',
  );
  expect(existing).toEqual(folder);
  expect(store.agent(folder!.managerId).executionMode).toBe('managed');
  folders.close();
});

it('starts native Codex input under the normal unpaused scheduler after async model preparation', async () => {
  const project = direct();
  store.setSetting('scheduler:settings', { paused: false, maxConcurrent: 1 });
  const prepare = vi.spyOn(runtime.modelPolicy, 'prepare');
  const run = store.enqueue(project.managerId, randomUUID(), 'Normal unpaused native input');
  runtime.kick();
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ id: project.managerId }), run.id);
  expect(store.run(run.id).status).toBe('running');
  expect(store.getSetting(`quark:manager-lease:${run.id}`)).toBeNull();
  expect(starts()[0]![1]).toMatchObject({ input: [{ type: 'text', text: run.text }] });
});

it('starts exact native input while QUARK is paused, without Dock catalog, charter, permission override or scheduler lease', async () => {
  const project = direct();
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 1 });
  store.setSetting('pulsar:policy', { enabled: true, reservePercent: 99 });
  const managed = store.register(join(root, 'managed'), 'Retained managed', '');
  const managedRun = store.enqueue(managed.managerId, randomUUID(), 'Managed still waits');
  const automatic = store.enqueue(
    project.managerId,
    randomUUID(),
    'Automatic report',
    'report',
    managed.managerId,
  );
  const run = store.enqueue(project.managerId, randomUUID(), 'Owner native question');
  runtime.kick();
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  const start = requests.mock.calls.find(([method]) => method === 'thread/start')![1] as Record<
    string,
    unknown
  >;
  expect(start.cwd).toBe(store.agent(project.managerId).cwd);
  for (const key of ['dynamicTools', 'developerInstructions', 'approvalPolicy', 'sandbox'])
    expect(start).not.toHaveProperty(key);
  expect(start.config).toEqual({ model_reasoning_effort: 'medium' });
  expect(starts()[0]![1]).toMatchObject({
    clientUserMessageId: run.id,
    input: [{ type: 'text', text: 'Owner native question' }],
    model: 'demo',
  });
  expect(starts()[0]![1]).not.toHaveProperty('additionalContext');
  expect(starts()[0]![1]).not.toHaveProperty('sandboxPolicy');
  expect(store.run(managedRun.id).status).toBe('queued');
  expect(store.run(automatic.id).status).toBe('queued');
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM pulsar_leases').get()?.count).toBe(0);
  expect(store.getSetting(`quark:manager-lease:${run.id}`)).toBeNull();
  expect(materialDemand(store, runtime.quark, Date.now()).has(project.id)).toBe(false);
  await finish(project.managerId, run.id);
  const nativeIdentity = store.agent(project.managerId).threadId;
  const next = store.enqueue(project.managerId, randomUUID(), 'Same native identity');
  runtime.kick();
  await vi.waitFor(() => expect(starts()).toHaveLength(2));
  const resume = requests.mock.calls.find(([method]) => method === 'thread/resume')![1] as Record<
    string,
    unknown
  >;
  expect(resume.threadId).toBe(nativeIdentity);
  expect(resume).not.toHaveProperty('developerInstructions');
  expect(resume).not.toHaveProperty('approvalPolicy');
  expect(starts()[1]![1]).toMatchObject({ clientUserMessageId: next.id, threadId: nativeIdentity });
  await expect(
    runtime.tool(project.managerId, randomUUID(), 'dock_task_create', {}),
  ).rejects.toThrow('do not expose Dock');
});

it('retains held FIFO and revalidates a manual stop after awaited native connection before input', async () => {
  const project = direct();
  const first = store.enqueue(project.managerId, randomUUID(), 'First held');
  store.updateRun(first.id, {
    queueEdit: { clientId: randomUUID(), text: 'Held draft', state: 'editing' },
  });
  const second = store.enqueue(project.managerId, randomUUID(), 'Second cannot overtake');
  runtime.kick();
  await tick();
  await tick();
  expect(starts()).toHaveLength(0);
  store.updateRun(first.id, { queueEdit: null });
  const original = DemoProvider.prototype.request.bind(provider);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  requests.mockImplementation(async (method, params) => {
    if (method === 'thread/start') await pending;
    return original(method, params);
  });
  runtime.kick();
  await vi.waitFor(() =>
    expect(requests.mock.calls.some(([method]) => method === 'thread/start')).toBe(true),
  );
  runtime.quark.hold(store.run(first.id), 'Owner explicitly paused', false, 'manual');
  release();
  await vi.waitFor(() => expect(store.run(first.id).status).toBe('interrupted'));
  expect(starts()).toHaveLength(0);
  expect(store.run(second.id).status).toBe('queued');
  expect(runtime.quark.holds()).toHaveLength(1);
});

it('keeps explicit read-only permissions and native question/Stop receipts without a manager lease', async () => {
  const project = direct();
  store.updateAgent(project.managerId, { permission: 'read-only' });
  const run = store.enqueue(project.managerId, randomUUID(), 'Read only');
  const respond = vi.spyOn(provider, 'respond');
  runtime.kick();
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  expect(requests.mock.calls.find(([method]) => method === 'thread/start')![1]).toMatchObject({
    sandbox: 'read-only',
  });
  expect(starts()[0]![1]).toMatchObject({ sandboxPolicy: { type: 'readOnly' } });
  provider.emit('request', 'native-question', 'item/tool/requestUserInput', {
    threadId: store.agent(project.managerId).threadId,
    turnId: store.run(run.id).turnId,
    questions: [
      {
        id: 'choice',
        header: 'Choice',
        question: 'Which option?',
        options: [{ label: 'One', description: 'Fixture' }],
      },
    ],
  });
  await vi.waitFor(() => expect(store.approvals()).toHaveLength(1));
  const approval = store.approvals()[0]!;
  await runtime.approve(approval.id, 'accept', { choice: ['One'] });
  await runtime.approve(approval.id, 'accept', { choice: ['One'] });
  expect(respond).toHaveBeenCalledTimes(1);
  await runtime.interrupt(project.managerId);
  expect(requests.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(1);
  expect(starts()).toHaveLength(1);
});

it('refuses a saved Group marker from ordinary direct input when dedicated authority is unavailable', async () => {
  const project = direct();
  store.setSetting(`group:host-native-agent:${project.managerId}`, { bindingId: randomUUID() });
  const run = store.enqueue(
    project.managerId,
    randomUUID(),
    'Ordinary input cannot bypass Group authority',
  );
  runtime.kick();
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('failed'));
  expect(starts()).toHaveLength(0);
  expect(requests.mock.calls.some(([method]) => method === 'thread/start')).toBe(false);
});

it('offers exactly two native Group readers only after dedicated admission, preserving Ask permissions and Stop', async () => {
  const events = new GroupEventRepository(join(root, 'group-events.sqlite'));
  try {
    const project = direct();
    const member = events.createGroup('Generic fixture');
    const context = events.createContext({
      groupId: member.groupId,
      memberId: member.memberId,
      installationId: member.installationId,
      visibility: 'shared',
      provider: 'codex',
      nativeSessionId: randomUUID(),
    });
    store.setSetting(`group:host-native-agent:${project.managerId}`, { context });
    const invoke = vi.fn(async () => ({
      content: [
        { type: 'text' as const, text: JSON.stringify({ exactContext: context.sessionId }) },
      ],
    }));
    registerGroupHostEvidence(runtime, () => [
      { ...GROUP_PRIVATE_EVIDENCE_TOOL, invoke },
      { ...GROUP_EVIDENCE_ORIGINAL_TOOL, invoke },
    ]);
    const run = store.enqueue(project.managerId, randomUUID(), 'Explicit Group Ask fixture');
    store.setSetting(`group:host-native-run:${run.id}`, {
      requestId: randomUUID(),
      intent: 'ask',
      context,
    });
    const admissionBoundaries: {
      status: string;
      permission: string;
      threadStarts: number;
      turnStarts: number;
    }[] = [];
    runtime.groupHostNativeAdmission = vi.fn(async (agentId, runId) => {
      expect(agentId).toBe(project.managerId);
      expect(runId).toBe(run.id);
      expect(store.getSetting(`group:host-native-run:${runId}`)).toMatchObject({ context });
      admissionBoundaries.push({
        status: store.run(runId).status,
        permission: store.agent(agentId).permission,
        threadStarts: requests.mock.calls.filter(([method]) => method === 'thread/start').length,
        turnStarts: starts().length,
      });
    });
    store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 1 });
    runtime.kick();
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    const params = requests.mock.calls.find(([method]) => method === 'thread/start')![1] as {
      dynamicTools: { name: string }[];
    };
    expect(params.dynamicTools.map((tool) => tool.name)).toEqual(groupNativeReadingNames);
    expect(params).not.toHaveProperty('developerInstructions');
    expect(params).not.toHaveProperty('approvalPolicy');
    expect(params).toMatchObject({ sandbox: 'read-only' });
    expect(starts()[0]![1]).toMatchObject({ sandboxPolicy: { type: 'readOnly' } });
    expect(runtime.groupHostNativeAdmission).toHaveBeenCalledTimes(3);
    expect(admissionBoundaries).toEqual([
      { status: 'queued', permission: 'workspace-write', threadStarts: 0, turnStarts: 0 },
      { status: 'queued', permission: 'workspace-write', threadStarts: 0, turnStarts: 0 },
      { status: 'running', permission: 'read-only', threadStarts: 1, turnStarts: 0 },
    ]);
    expect(
      await runtime.tool(project.managerId, randomUUID(), groupNativeReadingNames[1], {}),
    ).toEqual({ exactContext: context.sessionId });
    expect(invoke).toHaveBeenCalledOnce();
    expect(store.getSetting(`quark:manager-lease:${run.id}`)).toBeNull();
    await runtime.interrupt(project.managerId);
    expect(requests.mock.calls.some(([method]) => method === 'turn/interrupt')).toBe(true);
  } finally {
    events.close();
  }
});

it('retains native command/file/MCP permission requests and refuses a response after its direct turn changes', async () => {
  const project = direct();
  const run = store.enqueue(
    project.managerId,
    randomUUID(),
    'Use native tools with their own permissions',
  );
  const respond = vi.spyOn(provider, 'respond');
  runtime.kick();
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  const scope = {
    threadId: store.agent(project.managerId).threadId,
    turnId: store.run(run.id).turnId,
  };
  for (const [requestId, method, extra] of [
    ['command', 'item/commandExecution/requestApproval', { command: 'Native fixture command' }],
    ['file', 'item/fileChange/requestApproval', { reason: 'Native fixture file change' }],
    [
      'mcp',
      'mcpServer/elicitation/request',
      {
        serverName: 'native_configured_mcp',
        mode: 'form',
        message: 'Native fixture consent',
        _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: {} },
        requestedSchema: { type: 'object', properties: {} },
      },
    ],
  ] as const) {
    provider.emit('request', requestId, method, { ...scope, ...extra });
    await vi.waitFor(() =>
      expect(store.approvals().some((item) => item.requestId === requestId)).toBe(true),
    );
    const approval = store.approvals().find((item) => item.requestId === requestId)!;
    await runtime.approve(approval.id, 'accept');
    await runtime.approve(approval.id, 'accept');
  }
  expect(respond).toHaveBeenCalledTimes(3);
  expect(store.approvals().map((item) => item.kind)).toEqual(['command', 'file', 'mcp']);
  provider.emit('request', 'old-native-turn', 'item/commandExecution/requestApproval', {
    ...scope,
    command: 'Stale native request',
  });
  await vi.waitFor(() => expect(store.approvals()).toHaveLength(4));
  store.updateAgent(project.managerId, { turnId: randomUUID() });
  await expect(runtime.approve(store.approvals()[3]!.id, 'accept')).rejects.toThrow(
    'no longer current',
  );
  expect(respond).toHaveBeenCalledTimes(3);
});

it('preserves direct mode and native identity across uncertain handoff/restart without replay', async () => {
  const project = direct();
  const key = randomUUID();
  const run = store.enqueue(project.managerId, key, 'Original input');
  requests.mockImplementation(async (method, params) => {
    if (method === 'turn/start') throw new Error('Lost native acknowledgement');
    return DemoProvider.prototype.request.call(provider, method, params);
  });
  runtime.kick();
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('failed'));
  const nativeIdentity = store.agent(project.managerId).threadId;
  expect(runRecoveryView(store, project.managerId)).toMatchObject({
    runId: run.id,
    action: 'continue',
  });
  await runtime.close();
  store.close();
  open();
  store.recover();
  runtime.kick();
  await tick();
  await tick();
  expect(starts()).toHaveLength(0);
  expect(store.agent(project.managerId)).toMatchObject({
    executionMode: 'direct',
    threadId: nativeIdentity,
  });
  expect(store.enqueue(project.managerId, key, 'Original input').id).toBe(run.id);
  runtime.kick();
  await tick();
  expect(starts()).toHaveLength(0);
});
