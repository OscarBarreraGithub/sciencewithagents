import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
  renameSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { GroupAction } from '@dock/shared/dist/group-actions.js';
import { groupEventIdSchema, modelPolicySchema, type GroupContext } from '@dock/shared';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { GroupEventRepository } from './group-events.js';
import { createGroupHostNativeConnector } from './group-native-host-runtime.js';
import { modelFixture } from './model-policy.fixture.js';
import { createProductionGroupHost } from './group-host-bootstrap.js';
import { privateGroupFile } from './group-host-storage.js';
import { prepareRunDelivery, markRunHandoff, recordRunFailure } from './run-recovery.js';
import {
  GroupHostNativeDocuments,
  captureHostDocumentFiles,
} from './group-documents-host-native.js';
import { GroupHostNativeJournal } from './group-host-native-journal.js';
import type { GroupHost } from './group-host.js';
import type { GroupHostNativeCompletion } from './group-native-host-runtime.js';
import { publicationCanonical } from './group-publication-protocol.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function fixture(readEvidence?: (context: GroupContext) => Promise<string>) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'groups-host-native-')));
  mkdirSync(join(directory, 'groups'), { mode: 0o700 });
  const store = new Store(join(directory, 'dock.sqlite'));
  modelFixture(store);
  const provider = vi.fn(async () => {
    throw Error('No provider/model allowed in unit checks.');
  });
  const runtime = new Runtime(store, directory, 'UNUSED', provider);
  const kick = vi.spyOn(runtime, 'kick').mockImplementation(() => {});
  const eventsPath = join(directory, 'groups/events.sqlite');
  privateGroupFile(eventsPath);
  const events = new GroupEventRepository(eventsPath);
  const group = events.createGroup('Unit');
  const shared = events.createContext({
    groupId: group.groupId,
    memberId: group.memberId,
    installationId: group.installationId,
    visibility: 'shared',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  const privateContext = events.createContext({
    groupId: group.groupId,
    memberId: group.memberId,
    installationId: group.installationId,
    visibility: 'private',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  const enrollmentHandle = randomUUID();
  let connector = createGroupHostNativeConnector(runtime, {
    directory: join(directory, 'groups'),
    events,
  });
  const wire = () => {
    connector.evidence(
      readEvidence ??
        (async (c) =>
          JSON.stringify({
            shared: ['shared source'],
            private: c.visibility === 'private' ? ['own aside'] : [],
          })),
    );
    connector.revalidate(async () => {});
  };
  wire();
  const input = (context = shared, intent: 'ask' | 'work' = 'ask') => ({
    requestId: randomUUID(),
    key: randomUUID(),
    enrollmentHandle,
    context,
    text: 'Exact owner input',
    intent,
  });
  const scope = (context: GroupContext) =>
    ({
      handle: randomUUID(),
      enrollmentHandle,
      context,
      enrollment: { ...group, state: 'active', displayName: 'Unit' },
      revalidate: vi.fn(async () => {}),
      readShared: vi.fn(),
      original: vi.fn(),
    }) as unknown as Parameters<NonNullable<typeof connector.owner>['control']>[0];
  const control = async (
    s: ReturnType<typeof scope>,
    action: 'prepare' | 'continue' | 'reject',
    request?: ReturnType<typeof input>,
  ) =>
    connector.owner!.control(
      s,
      {
        action,
        handle: s.handle,
        key: randomUUID(),
        ...(request ? { requestId: request.requestId } : {}),
      },
      true,
      request,
    );
  cleanup.push(async () => {
    await connector.close!();
    await runtime.close();
    events.close();
    expect(provider).not.toHaveBeenCalled();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    runtime,
    kick,
    events,
    group,
    shared,
    privateContext,
    input,
    scope,
    control,
    async managedCompatibility() {
      await control(scope(shared), 'prepare');
      // Seed the old persisted shape before provisioning; no receipt is rewritten.
      const cwd = join(directory, 'groups/host-workspaces', randomUUID());
      mkdirSync(cwd, { recursive: true });
      const project = store.register(cwd, 'Retained Group', '', 'codex');
      store.updateAgent(project.managerId, { permission: 'read-only', toolPolicy: 'native' });
      const { sessionId: _ownerSession, ...anchor } = shared;
      const context = events.createContext({
        ...anchor,
        provider: 'codex',
        nativeSessionId: randomUUID(),
      });
      const oldBinding = {
        anchor: shared,
        context,
        enrollmentHandle,
        projectId: project.id,
        agentId: project.managerId,
        provider: 'codex',
        cwd,
      };
      const key = createHash('sha256')
        .update(publicationCanonical({ anchor: shared, enrollment: enrollmentHandle }))
        .digest('hex');
      const nativeDb = new DatabaseSync(join(directory, 'groups/host-native.sqlite'));
      nativeDb
        .prepare('INSERT INTO hnr_bindings VALUES (?,?)')
        .run(key, JSON.stringify(oldBinding));
      nativeDb.close();
    },
    get connector() {
      return connector;
    },
    async restart() {
      await connector.close!();
      connector = createGroupHostNativeConnector(runtime, {
        directory: join(directory, 'groups'),
        events,
      });
      wire();
    },
  };
}
it.each(['codex', 'claude'] as const)(
  'fresh %s Group owner input uses direct native execution without managed control or implicit helper authority',
  async (provider) => {
    const f = fixture();
    const policy = modelPolicySchema.parse(f.store.getSetting('model-policy'));
    policy.providers.manager = provider;
    f.store.setSetting('model-policy', policy);
    await f.control(f.scope(f.shared), 'prepare');
    const input = f.input(f.shared, 'work');
    await f.connector.submit(input);
    const binding = f.connector.context(input.requestId)!;
    expect(f.store.agent(binding.agentId)).toMatchObject({ provider, executionMode: 'direct' });
    const run = f.store.run(binding.runId!);
    expect(run).toMatchObject({ kind: 'user', sourceId: null });
    expect(run.text).toContain('group_evidence_original');
    expect(run.text).toContain('not independently reviewed');
    expect(run.text).not.toMatch(/dock_apply|task worktrees|tools and QUARK/);
    const body = vi.fn();
    await expect(
      f.runtime.withGroupCoordinationControl(binding.agentId, randomUUID(), body),
    ).rejects.toMatchObject({ code: 'GROUP_MANAGED_COORDINATION_REQUIRED' });
    expect(body).not.toHaveBeenCalled();
    expect(f.store.runs()).toHaveLength(1);
    expect(() => f.connector.coordination.identity(binding.context)).toThrow(
      'Managed task coordination',
    );
    const request = vi.fn(async (_method: string, _params: unknown) => ({
      turn: { id: randomUUID(), status: 'inProgress' },
    }));
    const submit = vi.fn(async () => {});
    if (provider === 'codex')
      vi.spyOn(f.runtime, 'attach').mockResolvedValue({
        client: { request } as never,
        threadId: 'native-fixture-thread',
      });
    else vi.spyOn(f.runtime.claude, 'prepare').mockResolvedValue({ submit } as never);
    const lease = vi.spyOn(f.runtime.quark, 'issueManagerLease');
    await (f.runtime as unknown as { startRun(value: typeof run): Promise<void> }).startRun(run);
    expect(lease).not.toHaveBeenCalled();
    expect(f.store.getSetting(`quark:manager-lease:${run.id}`)).toBeNull();
    if (provider === 'codex') {
      expect(request.mock.calls[0]).toEqual([
        'turn/start',
        expect.objectContaining({ input: [expect.objectContaining({ text: run.text })] }),
      ]);
      const params = request.mock.calls[0]![1];
      for (const key of [
        'developerInstructions',
        'additionalContext',
        'approvalPolicy',
        'sandboxPolicy',
      ])
        expect(params).not.toHaveProperty(key);
    } else {
      expect(submit).toHaveBeenCalledWith({ deliveryId: run.id, text: run.text, appContext: '' });
    }
    const scope = f.scope(f.shared);
    const status = await f.connector.owner!.control(
      scope,
      { action: 'status', handle: scope.handle },
      true,
    );
    expect(status).toMatchObject({ sessionMode: 'direct', managedCoordination: false });
  },
);

it('retains a pre-mode managed Group binding and exact request through restart without adopting a direct session', async () => {
  const f = fixture();
  await f.managedCompatibility();
  const input = f.input(f.shared, 'work');
  await f.connector.submit(input);
  const saved = f.connector.context(input.requestId)!;
  expect(saved.executionMode).toBe('managed');
  expect(f.store.run(saved.runId!).text).toContain('exact dock_apply preview');
  await f.restart();
  expect(f.connector.context(input.requestId)).toEqual(saved);
  expect(await f.connector.submit(input)).toMatchObject({ state: 'queued' });
  expect(f.store.runs()).toHaveLength(1);
  const scope = f.scope(f.shared);
  expect(
    await f.connector.owner!.control(scope, { action: 'status', handle: scope.handle }, true),
  ).toMatchObject({ sessionMode: 'managed', managedCoordination: true });
});

async function selectedReport() {
  const f = fixture(),
    choice = chosenFolder();
  const scope = f.scope(f.shared);
  f.connector.workspace(f.shared, scope.enrollmentHandle, {
    key: randomUUID(),
    revision: 0,
    selection: choice,
  });
  await f.control(scope, 'prepare');
  const db = new DatabaseSync(join(f.directory, 'groups/report-host.sqlite'));
  const nativeJournal = new GroupHostNativeJournal(db);
  const record = nativeJournal.prepare(scope.handle, {
    key: randomUUID(),
    text: 'Create this bounded report',
    context: f.shared,
    enrollmentHandle: scope.enrollmentHandle,
    intent: 'work',
  });
  await f.connector.submit(record.request);
  const binding = f.connector.context(record.request.requestId)!;
  mkdirSync(join(choice.root, 'sections'));
  writeFileSync(join(choice.root, 'sections/body.tex'), 'Exact nested source α');
  writeFileSync(
    join(choice.root, 'report.tex'),
    '\\documentclass{article}\\begin{document}\\input{sections/body}\\end{document}',
  );
  writeFileSync(join(choice.root, 'report.pdf'), '%PDF-1.4\nExact immutable PDF');
  writeFileSync(join(choice.root, 'private.tex'), 'Unrelated private material');
  const run = f.store.run(binding.runId!);
  f.store.entry({
    id: randomUUID(),
    agentId: binding.agentId,
    runId: run.id,
    kind: 'assistant',
    title: 'Final',
    text: '[Report](report.tex) [PDF](report.pdf)',
    status: 'complete',
    phase: 'final',
    createdAt: new Date().toISOString(),
  });
  f.store.updateRun(run.id, { status: 'completed' });
  const snapshot = await f.connector.inspect({ requestId: record.request.requestId });
  nativeJournal.record(record, snapshot);
  const completion: GroupHostNativeCompletion = {
    request: record.request,
    result: snapshot.result!,
    runId: run.id,
    cwd: binding.cwd,
  };
  const host = { directory: join(f.directory, 'groups'), db, nativeJournal } as GroupHost;
  const owner = vi.fn(async (context: GroupContext) => {
    if (publicationCanonical(context) !== publicationCanonical(f.shared))
      throw Error('Foreign owner');
    f.events.trustedHostScope({
      groupId: context.groupId,
      memberId: context.memberId,
      installationId: context.installationId,
      visibility: context.visibility,
      source: {
        sessionId: context.sessionId,
        provider: context.provider,
        nativeSessionId: context.nativeSessionId,
        messageId: 'capture-fixture',
      },
      causalRefs: [],
    });
  });
  let adapter = new GroupHostNativeDocuments(host, (c) => f.connector.completionWorkspace(c));
  const authority = {
    revalidateOwner: owner,
    resolve: async () => ({ context: f.shared, revalidate: async () => owner(f.shared) }),
  };
  adapter.documents(authority);
  cleanup.push(async () => {
    await adapter.close();
    db.close();
  });
  return {
    ...f,
    choice,
    binding,
    record,
    completion,
    owner,
    get adapter() {
      return adapter;
    },
    async restartCapture() {
      await adapter.close();
      adapter = new GroupHostNativeDocuments(host, (c) => f.connector.completionWorkspace(c));
      adapter.documents(authority);
    },
  };
}

it('captures exact completed direct Work source/PDF from the retained outside folder and preserves bytes through restart', async () => {
  const f = await selectedReport();
  expect(f.completion.cwd.startsWith(f.directory)).toBe(false);
  expect(f.connector.completionWorkspace(f.completion)).toEqual({
    root: f.choice.root,
    identity: f.choice.identity,
  });
  await f.adapter.captureCompleted(f.completion);
  const manifest = await f.adapter.describe(f.record.ids.resultId);
  expect(manifest.files.map((file) => file.name)).toEqual([
    'report.pdf',
    'report.tex',
    'sections/body.tex',
  ]);
  const input = {
    key: randomUUID(),
    manifest,
    artifactIds: manifest.files.map((file) => file.artifactId),
    limits: { bytes: 8 * 1024 ** 2, timeoutMs: 5000 },
  };
  const saved = await f.adapter.export(input);
  expect(saved.files.map((file) => file.bytes.toString()).join('\n')).toContain(
    'Exact immutable PDF',
  );
  expect(saved.files.map((file) => file.bytes.toString()).join('\n')).toContain(
    'Exact nested source α',
  );
  writeFileSync(join(f.choice.root, 'report.pdf'), 'Later bytes');
  await f.restart();
  await f.restartCapture();
  expect(await f.adapter.export(input)).toEqual(saved);
  await f.adapter.captureCompleted(f.completion);
  expect(await f.adapter.describe(f.record.ids.resultId)).toEqual(manifest);
});

it.each([
  'revoked',
  'replaced',
  'symlink',
  'changed-run',
  'changed-native-context',
  'after-await-replaced',
  'after-await-revoked',
] as const)(
  'refuses %s outside-folder capture and never captures later repaired bytes',
  async (failure) => {
    const f = await selectedReport();
    let completion = f.completion;
    const replace = () => {
      const retained = `${f.choice.root}-retained`;
      renameSync(f.choice.root, retained);
      cleanup.push(async () => rmSync(retained, { recursive: true, force: true }));
      if (failure === 'symlink') symlinkSync(retained, f.choice.root);
      else {
        mkdirSync(f.choice.root);
        writeFileSync(join(f.choice.root, 'report.tex'), 'Substituted private source');
      }
    };
    if (failure === 'revoked') f.events.revokeMember(f.group.groupId, f.group.memberId);
    if (failure === 'replaced' || failure === 'symlink') replace();
    if (failure === 'changed-run') completion = { ...completion, runId: randomUUID() };
    if (failure === 'changed-native-context')
      completion = {
        ...completion,
        result: {
          ...completion.result,
          context: { ...completion.result.context, nativeSessionId: randomUUID() },
        },
      };
    if (failure === 'after-await-replaced')
      f.owner.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => replace());
    if (failure === 'after-await-revoked')
      f.owner
        .mockImplementationOnce(async () => {})
        .mockImplementationOnce(async () => {
          f.events.revokeMember(f.group.groupId, f.group.memberId);
        });
    await f.adapter.captureCompleted(completion);
    expect(f.adapter.documentAvailable(f.record.ids.resultId)).toBe(false);
    await f.restartCapture();
    await f.adapter.captureCompleted(f.completion);
    expect(f.adapter.documentAvailable(f.record.ids.resultId)).toBe(false);
    expect(f.adapter.documentCaptureState(f.record.ids.resultId)).toBe('unavailable');
  },
);

it('does not broaden selected capture to a changed request or an unexpected descriptor identity', async () => {
  const f = await selectedReport();
  expect(() =>
    f.connector.completionWorkspace({
      ...f.completion,
      request: { ...f.completion.request, text: 'Changed owner input' },
    }),
  ).toThrow('Exact completed Group request');
  await f.adapter.captureCompleted({
    ...f.completion,
    request: { ...f.completion.request, text: 'Changed owner input' },
  });
  expect(f.adapter.documentAvailable(f.record.ids.resultId)).toBe(false);
  expect(() => captureHostDocumentFiles(f.choice.root, ['report.tex'], '0:0')).toThrow(
    'Exact report capture',
  );
  await f.adapter.captureCompleted(f.completion);
  expect(f.adapter.documentAvailable(f.record.ids.resultId)).toBe(true);
});
it('local removal holds exact queued background helpers across restart without changing owner Work', async () => {
  const f = fixture(),
    input = f.input(f.shared, 'work');
  await f.control(f.scope(f.shared), 'prepare');
  await f.connector.submit(input);
  const binding = f.connector.resolveLocalContext(f.shared, input.enrollmentHandle);
  const helper = f.store.addAgent({
    projectId: binding.projectId,
    parentId: null,
    taskId: null,
    name: 'Saved feed helper',
    role: 'researcher',
    provider: binding.provider,
    cwd: binding.cwd,
    scope: 'Shared summary only',
  });
  f.store.updateAgent(helper.id, { permission: 'read-only' });
  const summaryId = randomUUID(),
    run = f.store.enqueue(helper.id, summaryId, 'Saved original batch', 'delegation');
  f.connector.registerHelper(helper.id, binding.context, input.enrollmentHandle, run.id, summaryId);
  f.store.db.exec(
    'CREATE TABLE group_member_feed_batches(id TEXT PRIMARY KEY,body TEXT NOT NULL,state TEXT NOT NULL)',
  );
  const body = JSON.stringify({ id: summaryId, agentId: helper.id, runId: run.id });
  f.store.db
    .prepare('INSERT INTO group_member_feed_batches VALUES (?,?,?)')
    .run(summaryId, body, 'pending');
  const queued = f.store.run(run.id);
  let visible = true;
  f.connector.backgroundVisible(() => visible);
  await f.runtime.groupHostNativeAdmission!(helper.id, run.id);
  // The final live check fences removal during membership verification too.
  const awaiting = f.runtime.groupHostNativeAdmission!(helper.id, run.id);
  visible = false;
  await expect(awaiting).rejects.toThrow('removed from this app');
  expect(f.runtime.groupHostBackgroundReason!(helper.id, run.id)).toContain('paused');
  expect(f.runtime.pulsar.decision(queued, new Set())).toMatchObject({ eligible: false });
  const start = f.runtime as unknown as { startRun(item: typeof queued): Promise<void> };
  await expect(start.startRun(queued)).rejects.toThrow('removed from this app');
  expect(f.store.run(run.id)).toEqual(queued);
  const work = f.store.runs().find((item) => item.key === input.requestId)!;
  expect(f.runtime.groupHostBackgroundReason!(binding.agentId, work.id)).toBeNull();
  await f.runtime.groupHostNativeAdmission!(binding.agentId, work.id);
  await f.restart();
  f.connector.backgroundVisible(() => visible);
  await expect(f.runtime.groupHostNativeAdmission!(helper.id, run.id)).rejects.toThrow(
    'removed from this app',
  );
  expect(
    String(
      f.store.db.prepare('SELECT body FROM group_member_feed_batches WHERE id=?').get(summaryId)!
        .body,
    ),
  ).toBe(body);
  expect(f.store.run(run.id)).toEqual(queued);
  visible = true;
  await f.runtime.groupHostNativeAdmission!(helper.id, run.id);
  expect(f.runtime.groupHostBackgroundReason!(helper.id, run.id)).toBeNull();
});

it('Read-only holds exact original group queue IDs before model discovery, including inherited helpers, across restart', async () => {
  const f = fixture(),
    input = f.input(f.shared, 'work');
  await f.control(f.scope(f.shared), 'prepare');
  await f.connector.submit(input);
  const binding = f.connector.context(input.requestId)!,
    run = f.store.run(binding.runId!);
  const helper = f.store.addAgent({
    projectId: binding.projectId,
    parentId: null,
    taskId: null,
    name: 'Original summary helper',
    role: 'researcher',
    provider: binding.provider,
    cwd: binding.cwd,
  });
  f.store.updateAgent(helper.id, { permission: 'read-only' });
  const helperKey = randomUUID(),
    helperRun = f.store.enqueue(helper.id, helperKey, 'Saved group source', 'delegation');
  f.connector.registerHelper(
    helper.id,
    binding.context,
    input.enrollmentHandle,
    helperRun.id,
    helperKey,
  );
  let allowed = false;
  f.connector.contributions(() => allowed);
  expect(f.runtime.groupHostBackgroundReason!(binding.agentId, run.id)).toContain('Read-only');
  expect(f.runtime.groupHostBackgroundReason!(helper.id, helperRun.id)).toContain('Read-only');
  expect(f.runtime.pulsar.decision(run, new Set()).reason).toContain('Read-only');
  const prepare = vi.spyOn(f.runtime.modelPolicy, 'prepare');
  await (f.runtime as unknown as { drain(): Promise<void> }).drain();
  expect(prepare).not.toHaveBeenCalled();
  expect(f.store.run(run.id).status).toBe('queued');
  await f.restart();
  f.connector.contributions(() => allowed);
  expect(f.connector.context(input.requestId)!.runId).toBe(run.id);
  expect(f.runtime.groupHostBackgroundReason!(binding.agentId, run.id)).toContain('Read-only');
  allowed = true;
  expect(f.runtime.groupHostBackgroundReason!(binding.agentId, run.id)).toBeNull();
  expect(f.store.runs()).toHaveLength(2);
  expect(f.store.run(helperRun.id)).toMatchObject({ status: 'queued', key: helperKey });
  expect(f.store.run(run.id).key).toBe(input.requestId);
});

it.each(['codex', 'claude'] as const)(
  'Read-only changes during final %s preparation preserve the never-dispatched original queue identity',
  async (provider) => {
    const f = fixture();
    const policy = f.store.getSetting('model-policy') as { providers: { manager: string } };
    policy.providers.manager = provider;
    f.store.setSetting('model-policy', policy);
    await f.control(f.scope(f.shared), 'prepare');
    const input = f.input(f.shared, 'work');
    await f.connector.submit(input);
    const binding = f.connector.context(input.requestId)!,
      run = f.store.run(binding.runId!);
    let allowed = true;
    f.connector.contributions(() => allowed);
    const request = vi.fn(async () => ({ turn: { id: randomUUID(), status: 'inProgress' } }));
    vi.spyOn(f.runtime.quark, 'sync').mockImplementation(() => {});
    vi.spyOn(f.runtime.quark, 'managerLeaseReason').mockReturnValue(null);
    f.store.setSetting('pulsar:policy', { enabled: false });
    expect(f.runtime.pulsar.reserve(run, new Set(), true)).toBe(true);
    f.runtime.quark.begin(run);
    if (provider === 'codex') {
      vi.spyOn(f.runtime, 'attach').mockImplementation(async () => {
        allowed = false;
        return { client: { request } as never, threadId: 'retained-thread' };
      });
    } else {
      const managed = f.runtime.claude as unknown as {
        callbacks: { beforeSubmit(agentId: string, runId: string): void };
      };
      vi.spyOn(f.runtime.claude, 'prepare').mockResolvedValue({
        submit: async () => {
          allowed = false;
          managed.callbacks.beforeSubmit(binding.agentId, run.id);
          await request();
        },
      } as never);
    }
    const runtime = f.runtime as unknown as {
      startRun(value: typeof run): Promise<void>;
      failRun(value: typeof run, error: unknown): Promise<void>;
    };
    await runtime.startRun(run).catch((error) => runtime.failRun(run, error));
    expect(request).not.toHaveBeenCalled();
    expect(f.store.run(run.id)).toMatchObject({
      status: 'queued',
      key: input.requestId,
      turnId: null,
    });
    expect(f.store.runs()).toHaveLength(1);
    expect(f.store.agent(binding.agentId).turnId).toBeNull();
    expect(
      (f.store.getSetting(`run:delivery:${run.id}`) as { handoffAt: null }).handoffAt,
    ).toBeNull();
    expect(
      Number(
        f.store.db.prepare('SELECT count(*) n FROM pulsar_leases WHERE run_id=?').get(run.id)!.n,
      ),
    ).toBe(0);
    expect(
      Number(f.store.db.prepare('SELECT count(*) n FROM quark_runs WHERE run_id=?').get(run.id)!.n),
    ).toBe(0);
  },
);

it('Read-only holds a pristine queued input without inventing a delivery or admission record', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const input = f.input(f.shared, 'work');
  await f.connector.submit(input);
  const binding = f.connector.context(input.requestId)!,
    run = f.store.run(binding.runId!);
  f.connector.contributions(() => false);
  const runtime = f.runtime as unknown as {
    startRun(value: typeof run): Promise<void>;
    failRun(value: typeof run, error: unknown): Promise<void>;
  };
  const discard = vi.spyOn(f.runtime.quark, 'discardUnconsumed');
  await runtime.startRun(run).catch((error) => runtime.failRun(run, error));
  expect(discard).not.toHaveBeenCalled();
  expect(f.store.run(run.id)).toMatchObject({ status: 'queued', key: input.requestId });
  expect(f.store.getSetting(`run:delivery:${run.id}`)).toBeNull();
});

it.each(['handoff', 'fork', 'failure', 'missing-proof'] as const)(
  'Read-only never discards a queued input with retained %s admission evidence',
  async (boundary) => {
    const f = fixture();
    await f.control(f.scope(f.shared), 'prepare');
    const input = f.input(f.shared, 'work');
    await f.connector.submit(input);
    const binding = f.connector.context(input.requestId)!,
      run = f.store.run(binding.runId!);
    f.store.setSetting('pulsar:policy', { enabled: false });
    expect(f.runtime.pulsar.reserve(run, new Set(), true)).toBe(true);
    f.runtime.quark.begin(run);
    if (boundary !== 'missing-proof') {
      f.store.updateRun(run.id, { status: 'running' });
      prepareRunDelivery(f.store, f.store.run(run.id));
      if (boundary === 'failure')
        recordRunFailure(f.store, f.store.run(run.id), new Error('Saved uncertainty'));
      else markRunHandoff(f.store, f.store.run(run.id), boundary === 'fork' ? 'fork' : 'input');
      f.store.updateRun(run.id, { status: 'queued' });
    }
    const saved = f.store.getSetting(`run:delivery:${run.id}`) as {
      handoffAt: string | null;
      forkAt: string | null;
    } | null;
    const accounting = String(
      f.store.db.prepare('SELECT body FROM quark_runs WHERE run_id=?').get(run.id)!.body,
    );
    const lease = String(
      f.store.db.prepare('SELECT body FROM pulsar_leases WHERE run_id=?').get(run.id)!.body,
    );
    let allowed = false;
    f.connector.contributions(() => allowed);
    const discard = vi.spyOn(f.runtime.quark, 'discardUnconsumed');
    const runtime = f.runtime as unknown as {
      startRun(value: typeof run): Promise<void>;
      failRun(value: typeof run, error: unknown): Promise<void>;
    };
    await runtime.startRun(f.store.run(run.id)).catch((error) => runtime.failRun(run, error));
    expect(discard).not.toHaveBeenCalled();
    expect(
      String(f.store.db.prepare('SELECT body FROM quark_runs WHERE run_id=?').get(run.id)!.body),
    ).toBe(accounting);
    expect(
      String(f.store.db.prepare('SELECT body FROM pulsar_leases WHERE run_id=?').get(run.id)!.body),
    ).toBe(lease);
    expect(f.store.run(run.id)).toMatchObject({ status: 'failed', key: input.requestId });
    const retained = f.store.getSetting(`run:delivery:${run.id}`) as typeof saved;
    expect(retained?.handoffAt).toBe(saved?.handoffAt);
    expect(retained?.forkAt).toBe(saved?.forkAt);
    // Switching modes cannot replay the failed original.
    allowed = true;
    f.connector.contributionModeChanged!();
    expect(f.store.runs()).toHaveLength(1);
    expect(f.store.run(run.id).status).toBe('failed');
  },
);

it('Read-only retains observed admission evidence for explicit recovery instead of fabricating unused spend or replaying', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const input = f.input(f.shared, 'work');
  await f.connector.submit(input);
  const binding = f.connector.context(input.requestId)!,
    run = f.store.run(binding.runId!);
  let allowed = true;
  f.connector.contributions(() => allowed);
  vi.spyOn(f.runtime.quark, 'sync').mockImplementation(() => {});
  vi.spyOn(f.runtime.quark, 'managerLeaseReason').mockReturnValue(null);
  f.store.setSetting('pulsar:policy', { enabled: false });
  expect(f.runtime.pulsar.reserve(run, new Set(), true)).toBe(true);
  f.runtime.quark.begin(run);
  const row = f.store.db.prepare('SELECT body FROM quark_runs WHERE run_id=?').get(run.id)!;
  const saved = JSON.parse(String(row.body));
  const observed = {
    ...saved,
    observedAt: new Date().toISOString(),
    tokens: { ...saved.tokens, inputTokens: 17 },
    basis: 'partial',
  };
  f.store.db
    .prepare('UPDATE quark_runs SET body=? WHERE run_id=?')
    .run(JSON.stringify(observed), run.id);
  const request = vi.fn(async () => ({ turn: { id: randomUUID() } }));
  vi.spyOn(f.runtime, 'attach').mockImplementation(async () => {
    allowed = false;
    return { client: { request } as never, threadId: 'retained-thread' };
  });
  const runtime = f.runtime as unknown as {
    startRun(value: typeof run): Promise<void>;
    failRun(value: typeof run, error: unknown): Promise<void>;
  };
  await runtime.startRun(run).catch((error) => runtime.failRun(run, error));
  expect(request).not.toHaveBeenCalled();
  expect(f.store.run(run.id)).toMatchObject({
    status: 'failed',
    key: input.requestId,
    turnId: null,
  });
  expect(
    JSON.parse(
      String(f.store.db.prepare('SELECT body FROM quark_runs WHERE run_id=?').get(run.id)!.body),
    ),
  ).toEqual(observed);
  expect(
    Number(
      f.store.db.prepare('SELECT count(*) n FROM pulsar_leases WHERE run_id=?').get(run.id)!.n,
    ),
  ).toBe(1);
  expect(f.store.getSetting(`run:delivery:${run.id}`)).toMatchObject({
    handoffAt: null,
    failure: { retry: false },
  });
  allowed = true;
  f.connector.contributionModeChanged!();
  expect(f.store.runs()).toHaveLength(1);
  expect(f.store.run(run.id).status).toBe('failed');
});

it('Read-only keeps already-dispatched native authority and truthful completion without replaying failed or uncertain turns', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const input = f.input(f.shared, 'work');
  await f.connector.submit(input);
  const binding = f.connector.context(input.requestId)!,
    run = f.store.run(binding.runId!);
  f.store.updateRun(run.id, { status: 'running' });
  prepareRunDelivery(f.store, f.store.run(run.id));
  markRunHandoff(f.store, f.store.run(run.id));
  f.connector.contributions(() => false);
  expect(f.runtime.groupHostBackgroundReason!(binding.agentId, run.id)).toBeNull();
  await expect(
    f.runtime.groupHostNativeAdmission!(binding.agentId, run.id),
  ).resolves.toBeUndefined();
  f.store.entry({
    id: `${randomUUID()}-final`,
    agentId: binding.agentId,
    runId: run.id,
    kind: 'assistant',
    title: 'Response',
    text: 'Completed while Read-only.',
    status: 'complete',
    createdAt: new Date().toISOString(),
    phase: 'final',
  });
  f.store.updateRun(run.id, { status: 'completed' });
  expect(f.store.run(run.id).status).toBe('completed');
  expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
    state: 'completed',
    result: { text: 'Completed while Read-only.' },
  });
  const later = f.store.enqueue(binding.agentId, randomUUID(), 'Retained uncertain turn');
  f.store.updateRun(later.id, { status: 'failed' });
  f.connector.contributionModeChanged!();
  expect(f.store.run(later.id).status).toBe('failed');
  expect(f.store.runs()).toHaveLength(2);
});
function chosenFolder() {
  const root = mkdtempSync(join(tmpdir(), 'group-chosen-work-'));
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const canonical = realpathSync(root);
  const stat = statSync(canonical);
  writeFileSync(join(root, 'existing.txt'), 'Retain this existing folder.');
  return { key: randomUUID(), root: canonical, identity: `${stat.dev}:${stat.ino}` };
}
it.each(['native', 'exact'] as const)(
  'binds selected folders to fresh native work while retaining the old %s choice and exact requests',
  async (modelSelection) => {
    const f = fixture(),
      input = f.input(f.shared, 'work'),
      first = chosenFolder(),
      second = chosenFolder();
    const change = { key: randomUUID(), revision: 0, selection: first };
    const receipt = f.connector.workspace(f.shared, input.enrollmentHandle, change);
    expect(receipt).toMatchObject({
      selectionKey: first.key,
      workspacePath: first.root,
      revision: 1,
      available: true,
    });
    expect(f.store.projects()).toHaveLength(0);
    expect(f.store.agents()).toHaveLength(0);
    expect(f.connector.workspaceScope(f.shared, input.enrollmentHandle)).toMatchObject({
      cwd: first.root,
      projectId: null,
    });
    await f.restart();
    expect(f.connector.workspace(f.shared, input.enrollmentHandle, change)).toEqual(receipt);
    await f.control(f.scope(f.shared), 'prepare');
    const old = f.connector.resolveLocalContext(f.shared, input.enrollmentHandle);
    expect(old.cwd).toBe(first.root);
    f.store.updateAgent(old.agentId, {
      modelSelection,
      model: 'saved-explicit',
      effort: 'high',
      threadId: 'original-native-thread',
    });
    await f.connector.submit(input);
    const run = f.store.runs().find((item) => item.key === input.requestId)!;
    expect(() =>
      f.connector.workspace(f.shared, input.enrollmentHandle, {
        key: randomUUID(),
        revision: 1,
        selection: second,
      }),
    ).toThrow(/queued|pending/);
    f.store.entry({
      id: 'provider:fixture/turn-final',
      agentId: old.agentId,
      runId: run.id,
      kind: 'assistant',
      title: 'Final',
      text: 'Original work complete.',
      status: 'complete',
      createdAt: new Date().toISOString(),
    });
    f.store.updateRun(run.id, { status: 'completed' });
    f.store.updateAgent(old.agentId, { status: 'idle', turnId: null });
    await f.connector.inspect({ requestId: input.requestId });
    const oldAgent = f.store.agent(old.agentId);
    f.connector.workspace(f.shared, input.enrollmentHandle, {
      key: randomUUID(),
      revision: 1,
      selection: second,
    });
    const fresh = f.connector.resolveLocalContext(f.shared, input.enrollmentHandle);
    expect(fresh.cwd).toBe(second.root);
    expect(fresh.agentId).not.toBe(old.agentId);
    expect(fresh.context.sessionId).not.toBe(old.context.sessionId);
    expect(f.store.agent(fresh.agentId)).toMatchObject({
      modelSelection,
      model: 'saved-explicit',
      threadId: null,
    });
    expect(f.store.agent(old.agentId)).toEqual(oldAgent);
    expect(f.connector.context(input.requestId)).toMatchObject({
      cwd: first.root,
      agentId: old.agentId,
      runId: run.id,
    });
    expect(f.connector.resolveLocalContext(old.context, input.enrollmentHandle)).toEqual(old);
    expect(await f.connector.submit(input)).toMatchObject({
      state: 'completed',
      result: { text: 'Original work complete.' },
    });
    expect(f.store.runs()).toHaveLength(1);
    const next = f.input(f.shared, 'work');
    await f.connector.submit(next);
    expect(f.connector.context(next.requestId)).toMatchObject({
      cwd: second.root,
      agentId: fresh.agentId,
    });
    expect(readFileSync(join(first.root, 'existing.txt'), 'utf8')).toBe(
      'Retain this existing folder.',
    );
    expect(readFileSync(join(second.root, 'existing.txt'), 'utf8')).toBe(
      'Retain this existing folder.',
    );
  },
);
it('refuses folder changes for unresolved handoffs and changed selected identities without rebinding queued work', async () => {
  const f = fixture(),
    input = f.input(f.shared, 'work'),
    first = chosenFolder();
  f.connector.workspace(f.shared, input.enrollmentHandle, {
    key: randomUUID(),
    revision: 0,
    selection: first,
  });
  await f.connector.submit(input); // Retained unstarted native handoff, not enabled.
  expect(() =>
    f.connector.workspace(f.shared, input.enrollmentHandle, {
      key: randomUUID(),
      revision: 1,
      selection: chosenFolder(),
    }),
  ).toThrow('pending group request');
  await f.control(f.scope(f.shared), 'prepare');
  await f.control(f.scope(f.shared), 'continue', input);
  const run = f.store.runs().find((item) => item.key === input.requestId)!;
  const oldRoot = `${first.root}-original`;
  renameSync(first.root, oldRoot);
  mkdirSync(first.root);
  cleanup.push(async () => rmSync(oldRoot, { recursive: true, force: true }));
  await expect(f.runtime.groupHostNativeAdmission!(run.agentId, run.id)).rejects.toThrow(
    'chosen group folder changed',
  );
  expect(f.store.run(run.id).status).toBe('queued');
  expect(f.connector.workspace(f.shared, input.enrollmentHandle)).toMatchObject({
    available: false,
    workspacePath: first.root,
  });
  expect(readFileSync(join(oldRoot, 'existing.txt'), 'utf8')).toBe('Retain this existing folder.');
});
it('retains an unstarted request across enable/restart and enqueues exact UUID once', async () => {
  const f = fixture(),
    input = f.input(),
    scope = f.scope(f.shared);
  expect(await f.connector.submit(input)).toMatchObject({ state: 'pending-consent' });
  expect(f.store.runs()).toHaveLength(0);
  await f.restart();
  await f.control(scope, 'prepare');
  expect(f.store.runs()).toHaveLength(0);
  await f.control(scope, 'continue', input);
  await f.control(scope, 'continue', input);
  expect(f.store.runs()).toHaveLength(1);
  const binding = f.connector.context(input.requestId)!;
  expect(f.store.run(binding.runId!).key).toBe(input.requestId);
  await expect(f.connector.submit({ ...input, text: 'changed' })).rejects.toThrow(/retry changed/);
  await f.restart();
  expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
    state: 'queued',
  });
  expect(f.store.runs()).toHaveLength(1);
});
it('separates shared/private native agents and only supplies their exact bounded evidence', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const a = f.input(),
    b = f.input(f.privateContext);
  await f.connector.submit(a);
  await f.connector.submit(b);
  const one = f.connector.context(a.requestId)!,
    two = f.connector.context(b.requestId)!;
  expect(one.context.sessionId).not.toBe(two.context.sessionId);
  expect(one.context.nativeSessionId).not.toBe(two.context.nativeSessionId);
  expect(one.agentId).not.toBe(two.agentId);
  expect(one.projectId).not.toBe(two.projectId);
  expect(f.store.run(one.runId!).text).not.toContain('own aside');
  expect(f.store.run(two.runId!).text).toContain('own aside');
  expect(f.runtime.context(f.store.agent(one.agentId))).not.toContain('personal');
  await expect(f.connector.submit(f.input(f.privateContext, 'work'))).rejects.toThrow(/Ask only/);
});
it('retains exact completed native result/source through lost ACK and restart without resending', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const input = f.input(f.shared, 'work');
  await f.connector.submit(input);
  const bound = f.connector.context(input.requestId)!,
    run = f.store.run(bound.runId!);
  f.store.entry({
    id: randomUUID(),
    agentId: bound.agentId,
    runId: run.id,
    kind: 'assistant',
    title: 'Response',
    text: 'Exact reply',
    status: 'complete',
    createdAt: new Date().toISOString(),
    phase: 'final',
  });
  f.store.updateRun(run.id, { status: 'completed' });
  const result = await f.connector.inspect({ requestId: input.requestId });
  expect(result).toMatchObject({
    state: 'completed',
    result: { text: 'Exact reply', context: bound.context, source: { messageId: input.requestId } },
  });
  await f.restart();
  expect(await f.connector.submit(input)).toEqual(result);
  expect(f.store.runs()).toHaveLength(1);
});
it('cancel before native start remains terminal; no implicit migration or retry of old isolated IDs', async () => {
  const f = fixture(),
    input = f.input(),
    scope = f.scope(f.shared);
  await f.connector.submit(input);
  await f.control(scope, 'reject', input);
  await f.control(scope, 'prepare');
  // Exact Continue must not revive a cancelled unstarted request.
  expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
    state: 'blocked',
  });
  await f.control(scope, 'continue', input);
  expect(await f.connector.inspect({ requestId: randomUUID() })).toMatchObject({
    state: 'unknown',
  });
  expect(f.store.runs()).toHaveLength(0);
});
it('fresh helper is separately bound; admission rechecks authority and Ask cannot delegate app work', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const input = f.input();
  await f.connector.submit(input);
  const bound = f.connector.context(input.requestId)!;
  const helper = f.store.addAgent({
    projectId: bound.projectId,
    parentId: null,
    taskId: null,
    name: 'Summary',
    role: 'researcher',
    cwd: bound.cwd,
    provider: bound.provider,
  });
  const run = f.store.enqueue(helper.id, randomUUID(), 'summary');
  f.connector.registerHelper(helper.id, f.shared, bound.enrollmentHandle, run.id, randomUUID());
  expect(f.store.getSetting(`group:host-native-agent:${helper.id}`)).toMatchObject({
    context: bound.context,
  });
  expect(helper.id).not.toBe(bound.agentId);
  await f.runtime.groupHostNativeAdmission!(helper.id, run.id);
  f.events.revokeMember(f.group.groupId, f.group.memberId);
  await expect(f.runtime.groupHostNativeAdmission!(helper.id, run.id)).rejects.toThrow();
  await expect(f.runtime.tool(bound.agentId, randomUUID(), 'dock_delegate', {})).rejects.toThrow(
    /Direct native conversations/,
  );
});

function nativePermissionClients(f: ReturnType<typeof fixture>) {
  const generations: DemoProvider[] = [];
  const observations: {
    generation: number;
    method: string;
    params: Record<string, unknown>;
    sandbox: string;
  }[] = [];
  const clients = (f.runtime as unknown as { clients: Map<string, DemoProvider> }).clients;
  vi.spyOn(f.runtime.modelPolicy, 'prepare').mockImplementation(async (agent) => agent);
  vi.spyOn(f.runtime, 'client').mockImplementation(async (agent) => {
    const existing = clients.get(agent.id);
    if (existing?.ready) return existing;
    const client = new DemoProvider();
    generations.push(client);
    const generation = generations.length;
    // Model the pinned native server: omitted overrides keep a loaded thread's
    // policy; an unloaded resume resolves omission from native configuration.
    let sandbox = 'workspaceWrite';
    vi.spyOn(client, 'request').mockImplementation(async (method, raw) => {
      const params = (raw ?? {}) as Record<string, unknown>;
      if (method === 'thread/start' || method === 'thread/resume') {
        if (params.sandbox === 'read-only') sandbox = 'readOnly';
        client.threadId = typeof params.threadId === 'string' ? params.threadId : client.threadId;
        observations.push({ generation, method, params, sandbox });
        return {
          thread: { id: client.threadId, turns: [] },
          model: 'demo',
          sandbox: { type: sandbox },
        };
      }
      if (method === 'turn/start') {
        const override = params.sandboxPolicy as { type: string } | undefined;
        if (override) sandbox = override.type;
        observations.push({ generation, method, params, sandbox });
        return { turn: { id: randomUUID(), status: 'inProgress' } };
      }
      return {};
    });
    clients.set(agent.id, client);
    return client;
  });
  return { generations, observations };
}

it('reopens direct Codex Ask/Work permissions from native configuration with the same retained history', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const ask = f.input(),
    work = f.input(f.shared, 'work'),
    nextAsk = f.input();
  await f.connector.submit(ask);
  await f.connector.submit(work);
  await f.connector.submit(nextAsk);
  const bound = f.connector.context(ask.requestId)!,
    first = f.store.run(bound.runId!),
    second = f.store.run(f.connector.context(work.requestId)!.runId!),
    third = f.store.run(f.connector.context(nextAsk.requestId)!.runId!);
  const native = nativePermissionClients(f);
  const retire = vi.spyOn(
    f.runtime as unknown as { retireContext(agentId: string): Promise<void> },
    'retireContext',
  );
  const start = (run: typeof first) =>
    (f.runtime as unknown as { startRun(run: typeof first): Promise<void> }).startRun(run);
  await start(first);
  const threadId = f.store.agent(bound.agentId).threadId;
  const history = f.store.entries(bound.agentId);
  f.store.updateRun(first.id, { status: 'completed' });
  f.store.updateAgent(bound.agentId, { status: 'idle', turnId: null });
  await start(second);
  expect(native.generations).toHaveLength(2);
  expect(native.generations[0]!.ready).toBe(false);
  const resumed = native.observations.find((item) => item.method === 'thread/resume')!;
  expect(resumed).toMatchObject({
    generation: 2,
    sandbox: 'workspaceWrite',
    params: { threadId },
  });
  for (const key of ['sandbox', 'approvalPolicy', 'developerInstructions'])
    expect(resumed.params).not.toHaveProperty(key);
  expect(f.store.agent(bound.agentId).permission).toBe('workspace-write');
  f.store.updateRun(second.id, { status: 'completed' });
  f.store.updateAgent(bound.agentId, { status: 'idle', turnId: null });
  await start(third);
  expect(native.generations).toHaveLength(3);
  expect(native.generations[1]!.ready).toBe(false);
  expect(native.observations.filter((item) => item.method === 'turn/start')).toMatchObject([
    { generation: 1, sandbox: 'readOnly', params: { threadId } },
    { generation: 2, sandbox: 'workspaceWrite', params: { threadId } },
    { generation: 3, sandbox: 'readOnly', params: { threadId } },
  ]);
  expect(native.observations.filter((item) => item.method === 'thread/start')).toHaveLength(1);
  expect(native.observations.filter((item) => item.method === 'thread/resume')).toHaveLength(2);
  expect(f.store.agent(bound.agentId)).toMatchObject({ threadId, permission: 'read-only' });
  expect(f.store.entries(bound.agentId)).toEqual(history);
  expect(retire).not.toHaveBeenCalled();
});

it.each(['owner Stop', 'Read-only', 'membership revoked'] as const)(
  'rechecks %s during a direct Codex permission reconnect before dispatch',
  async (change) => {
    const f = fixture();
    await f.control(f.scope(f.shared), 'prepare');
    const ask = f.input(),
      work = f.input(f.shared, 'work');
    await f.connector.submit(ask);
    await f.connector.submit(work);
    const bound = f.connector.context(ask.requestId)!,
      first = f.store.run(bound.runId!),
      second = f.store.run(f.connector.context(work.requestId)!.runId!);
    const native = nativePermissionClients(f);
    const start = (run: typeof first) =>
      (f.runtime as unknown as { startRun(run: typeof first): Promise<void> }).startRun(run);
    await start(first);
    const threadId = f.store.agent(bound.agentId).threadId;
    f.store.updateRun(first.id, { status: 'completed' });
    f.store.updateAgent(bound.agentId, { status: 'idle', turnId: null });
    const old = native.generations[0]!;
    const close = old.close.bind(old);
    vi.spyOn(old, 'close').mockImplementationOnce(async () => {
      if (change === 'owner Stop') await f.runtime.interrupt(bound.agentId);
      else if (change === 'Read-only') f.connector.contributions(() => false);
      else f.events.revokeMember(f.group.groupId, f.group.memberId);
      await close();
    });
    if (change === 'owner Stop') {
      await start(second);
      expect(f.store.run(second.id).status).toBe('cancelled');
    } else {
      await expect(start(second)).rejects.toThrow();
      expect(f.store.run(second.id).status).toBe('queued');
    }
    expect(native.generations).toHaveLength(1);
    expect(native.observations.filter((item) => item.method === 'turn/start')).toHaveLength(1);
    expect(f.store.agent(bound.agentId).threadId).toBe(threadId);
    expect(f.store.getSetting(`run:delivery:${second.id}`)).toBeNull();
  },
);

it('normal production bootstrap selects host mode without reading legacy route or launching providers', async () => {
  const f = fixture();
  await f.connector.close!();
  f.store.setSetting('group:native-route', { legacy: 'retained' });
  const host = createProductionGroupHost(dirname(f.store.path), f.runtime);
  try {
    expect(await host.native.availability()).toMatchObject({
      executionMode: 'host',
      available: true,
      productionReady: true,
      authState: 'inherited',
    });
    expect(f.store.getSetting('group:native-route')).toEqual({ legacy: 'retained' });
    expect(f.store.runs()).toHaveLength(0);
  } finally {
    await host.close();
  }
});

it('Work delegates with exact lineage, waits for its report and retains only the final manager reply', async () => {
  const f = fixture();
  await f.managedCompatibility();
  await f.control(f.scope(f.shared), 'prepare');
  const input = f.input(f.shared, 'work');
  await f.connector.submit(input);
  const bound = f.connector.context(input.requestId)!,
    root = f.store.run(bound.runId!);
  f.store.updateRun(root.id, { status: 'running', turnId: root.id });
  f.store.updateAgent(bound.agentId, { status: 'running', permission: 'workspace-write' });
  vi.spyOn(f.runtime.quark, 'sync').mockImplementation(() => {});
  vi.spyOn(f.runtime.quark, 'requireManagerLease').mockReturnValue({
    id: randomUUID(),
    runId: root.id,
  } as never);
  vi.spyOn(f.runtime.modelPolicy, 'catalog').mockResolvedValue([
    { id: 'demo', label: 'Fixture model', isDefault: true, efforts: ['medium', 'high', 'xhigh'] },
  ]);
  const task = f.store.addTask(bound.projectId, {
    title: 'Research',
    goal: 'Read supplied evidence',
    acceptance: 'Bounded answer',
    parentId: null,
  });
  const worker = (await f.runtime.tool(bound.agentId, randomUUID(), 'dock_delegate', {
    taskId: task.id,
    role: 'researcher',
    name: 'Reader',
    instruction: 'Return a bounded answer',
  })) as { id: string };
  const delegated = f.store.runs().find((run) => run.agentId === worker.id)!;
  expect(f.store.getSetting(`group:host-native-run:${delegated.id}`)).toMatchObject({
    requestId: input.requestId,
    originRunId: root.id,
    permission: 'read-only',
  });
  await f.runtime.groupHostNativeAdmission!(worker.id, delegated.id);
  f.store.entry({
    id: randomUUID(),
    agentId: bound.agentId,
    runId: root.id,
    kind: 'assistant',
    title: 'Dispatch',
    text: 'I delegated the work.',
    status: 'complete',
    phase: 'final',
    createdAt: new Date().toISOString(),
  });
  f.store.updateRun(root.id, { status: 'completed' });
  expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
    state: 'running',
  });
  const nativeRequest = vi.fn(async () => ({ turn: { id: delegated.id, status: 'inProgress' } }));
  vi.spyOn(f.runtime, 'attach').mockResolvedValue({
    client: { request: nativeRequest } as never,
    threadId: 'worker-thread',
  });
  await (f.runtime as unknown as { startRun(value: typeof delegated): Promise<void> }).startRun(
    delegated,
  );
  expect(f.store.agent(worker.id).permission).toBe('read-only');
  expect(nativeRequest).toHaveBeenCalledWith(
    'turn/start',
    expect.objectContaining({ sandboxPolicy: { type: 'readOnly', networkAccess: true } }),
  );
  f.store.entry({
    id: randomUUID(),
    agentId: worker.id,
    runId: delegated.id,
    kind: 'assistant',
    title: 'Evidence',
    text: 'Worker evidence',
    status: 'complete',
    phase: 'final',
    createdAt: new Date().toISOString(),
  });
  await (
    f.runtime as unknown as { finish(id: string, turn: string, status: string): Promise<void> }
  ).finish(worker.id, delegated.id, 'completed');
  const report = f.store.runs().find((run) => run.key === `report:${delegated.id}`)!;
  expect(f.store.getSetting(`group:host-native-run:${report.id}`)).toMatchObject({
    requestId: input.requestId,
    originRunId: root.id,
    parentRunId: delegated.id,
  });
  await f.runtime.groupHostNativeAdmission!(bound.agentId, report.id);
  expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
    state: 'running',
  });
  f.store.entry({
    id: randomUUID(),
    agentId: bound.agentId,
    runId: report.id,
    kind: 'assistant',
    title: 'Final',
    text: 'Final reviewed answer.',
    status: 'complete',
    phase: 'final',
    createdAt: new Date().toISOString(),
  });
  f.store.updateRun(report.id, { status: 'completed' });
  expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
    state: 'completed',
    result: { text: 'Final reviewed answer.' },
  });
  await f.restart();
  expect(await f.connector.submit(input)).toMatchObject({
    state: 'completed',
    result: { text: 'Final reviewed answer.' },
  });
  expect(f.store.runs()).toHaveLength(3);
});

it('stops the saved Work family after its first turn completes without cancelling another request', async () => {
  const f = fixture();
  const scope = f.scope(f.shared);
  await f.control(scope, 'prepare');
  const input = f.input(f.shared, 'work'),
    unrelated = f.input(f.shared, 'work');
  await f.connector.submit(input);
  await f.connector.submit(unrelated);
  const bound = f.connector.context(input.requestId)!,
    root = f.store.run(bound.runId!);
  const worker = f.store.addAgent({
    projectId: bound.projectId,
    parentId: bound.agentId,
    taskId: null,
    name: 'Worker',
    role: 'researcher',
    provider: bound.provider,
    cwd: bound.cwd,
  });
  const child = f.store.enqueue(worker.id, randomUUID(), 'Work', 'delegation', bound.agentId);
  const { inheritGroupHostWork } = await import('./group-host-work-continuation.js');
  inheritGroupHostWork(f.store, root, child);
  f.store.updateRun(root.id, { status: 'completed' });
  f.store.updateRun(child.id, { status: 'running' });
  const interrupt = vi.spyOn(f.runtime, 'interrupt').mockImplementation(async (_id, options) => {
    f.store.updateRun(options!.runId, { status: 'interrupted' });
  });
  await f.control(scope, 'reject', input);
  expect(interrupt).toHaveBeenCalledExactlyOnceWith(worker.id, {
    preserveQueued: true,
    runId: child.id,
  });
  expect(f.store.run(f.connector.context(unrelated.requestId)!.runId!).status).toBe('queued');
  expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
    state: 'blocked',
  });
  await expect(f.runtime.groupHostNativeAdmission!(worker.id, child.id)).rejects.toThrow(
    /authority changed/,
  );
  const late = f.store.enqueue(worker.id, randomUUID(), 'Late', 'message', bound.agentId);
  expect(() => inheritGroupHostWork(f.store, root, late)).toThrow(/original local Work/);
});

it('does not submit provider input after owner cancellation during the final asynchronous admission', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const input = f.input();
  await f.connector.submit(input);
  const bound = f.connector.context(input.requestId)!,
    run = f.store.run(bound.runId!);
  const request = vi.fn();
  vi.spyOn(f.runtime, 'attach').mockResolvedValue({
    client: { request } as never,
    threadId: 'no-input',
  });
  vi.spyOn(f.runtime.quark, 'sync').mockImplementation(() => {});
  vi.spyOn(f.runtime.quark, 'managerLeaseReason').mockReturnValue(null);
  let count = 0;
  f.runtime.groupHostNativeAdmission = async () => {
    if (++count === 2) f.store.updateRun(run.id, { status: 'cancelled' });
  };
  await (f.runtime as unknown as { startRun(value: typeof run): Promise<void> }).startRun(run);
  expect(count).toBe(2);
  expect(request).not.toHaveBeenCalled();
});

it.each(['provision', 'evidence'] as const)(
  'retains a definitely-unsubmitted %s failure and explicitly continues the same input after restart',
  async (phase) => {
    const evidence = vi.fn(async () => 'Current scoped evidence');
    if (phase === 'evidence')
      evidence.mockRejectedValueOnce(new Error('Temporary evidence outage'));
    const f = fixture(evidence),
      input = f.input(),
      scope = f.scope(f.shared);
    await f.control(scope, 'prepare');
    const providerChoice = vi.spyOn(f.store, 'defaultProvider');
    if (phase === 'provision')
      providerChoice.mockImplementationOnce(() => {
        throw new Error('Temporary model configuration outage');
      });
    await expect(f.connector.submit(input)).rejects.toThrow(/Temporary/);
    expect(f.store.runs()).toHaveLength(0);
    await f.restart();
    expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
      state: 'pending-consent',
    });
    await expect(f.connector.submit({ ...input, text: 'different' })).rejects.toThrow(
      /retry changed/,
    );
    expect(await f.connector.submit(input)).toMatchObject({ state: 'pending-consent' });
    expect(f.store.runs()).toHaveLength(0); // inspect/retry never performs preflight or submits
    await expect(f.control(f.scope(f.privateContext), 'continue', input)).rejects.toThrow(
      /Exact saved owner/,
    );
    await f.control(scope, 'continue', input);
    await f.control(scope, 'continue', input);
    const bound = f.connector.context(input.requestId)!;
    expect(f.store.run(bound.runId!).key).toBe(input.requestId);
    expect(f.store.runs()).toHaveLength(1);
    expect(await f.connector.inspect({ requestId: randomUUID() })).toMatchObject({
      state: 'unknown',
    });
  },
);

it('retains an explicit capacity refusal without submitting a 65th native input or losing its receipt', async () => {
  const f = fixture(),
    scope = f.scope(f.shared);
  await f.control(scope, 'prepare');
  for (let n = 0; n < 64; n++) await f.connector.submit(f.input());
  const input = f.input();
  const refusal = await f.connector.submit(input);
  expect(refusal).toMatchObject({
    state: 'blocked',
    message: expect.stringContaining('Too many outstanding'),
  });
  await f.restart();
  expect(await f.connector.inspect({ requestId: input.requestId })).toEqual(refusal);
  await f.control(scope, 'continue', input);
  expect(f.store.runs()).toHaveLength(64);
});

it('cancellation during the pre-input hook cannot enqueue the saved request afterwards', async () => {
  const f = fixture(),
    scope = f.scope(f.shared);
  await f.control(scope, 'prepare');
  const input = f.input();
  f.connector.beforeTurn(async () => {
    await f.control(scope, 'reject', input);
  });
  expect(await f.connector.submit(input)).toMatchObject({ state: 'blocked' });
  expect(f.store.runs()).toHaveLength(0);
  await f.control(scope, 'continue', input);
  expect(f.store.runs()).toHaveLength(0);
});

it('captures exact live Work before next workspace preparation or input; restart never reopens old files', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const capture = vi.fn(async () => held);
  const beforeTurn = vi.fn(async () => {});
  f.connector.completed(capture);
  f.connector.beforeTurn(beforeTurn);
  await f.control(f.scope(f.shared), 'prepare');
  const work = f.input(f.shared, 'work');
  await f.connector.submit(work);
  const binding = f.connector.context(work.requestId)!;
  f.store.entry({
    id: randomUUID(),
    agentId: binding.agentId,
    runId: binding.runId!,
    kind: 'assistant',
    title: 'Response',
    text: '[Report](report.tex)',
    status: 'complete',
    createdAt: new Date().toISOString(),
    phase: 'final',
  });
  f.store.updateRun(binding.runId!, { status: 'completed' });
  await expect.poll(() => capture.mock.calls.length).toBe(1);
  expect(capture).toHaveBeenCalledWith({
    request: work,
    result: expect.objectContaining({
      text: '[Report](report.tex)',
      context: binding.context,
      source: expect.objectContaining({ messageId: work.requestId }),
    }),
    runId: binding.runId,
    cwd: binding.cwd,
  });
  const next = f.input(f.shared, 'work');
  let submitted = false;
  const submitting = f.connector.submit(next).then(() => {
    submitted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(submitted).toBe(false);
  expect(beforeTurn).toHaveBeenCalledTimes(1);
  expect(f.connector.context(next.requestId)!.runId).toBeNull();
  release();
  await submitting;
  expect(beforeTurn).toHaveBeenCalledTimes(2);
  const nextRun = f.connector.context(next.requestId)!.runId!;
  await f.runtime.groupHostNativeAdmission!(binding.agentId, nextRun);
  await f.restart();
  const afterRestart = vi.fn(async () => {});
  f.connector.completed(afterRestart);
  expect(await f.connector.inspect({ requestId: work.requestId })).toMatchObject({
    state: 'completed',
  });
  expect(afterRestart).not.toHaveBeenCalled();
});

it('synthetic action controls cannot authorize capture or become the final report manager reply', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const work = f.input(f.shared, 'work');
  await f.connector.submit(work);
  const binding = f.connector.context(work.requestId)!;
  f.store.entry({
    id: randomUUID(),
    agentId: binding.agentId,
    runId: binding.runId!,
    kind: 'assistant',
    title: 'Response',
    text: '[Original](report.tex)',
    status: 'complete',
    createdAt: new Date().toISOString(),
    phase: 'final',
  });
  f.store.updateRun(binding.runId!, { status: 'completed' });
  await new Promise((resolve) => setImmediate(resolve));
  // The original live boundary was missed; enabling capture later cannot repair it.
  const capture = vi.fn(async () => {});
  f.connector.completed(capture);
  const control = f.store.enqueue(binding.agentId, randomUUID(), 'Synthetic control');
  f.store.setSetting(`group:host-native-run:${control.id}`, {
    requestId: work.requestId,
    intent: 'work',
    context: binding.context,
    originRunId: binding.runId,
    parentRunId: binding.runId,
  });
  f.store.setSetting(`group:native-control:${control.id}`, { actionId: randomUUID() });
  f.store.entry({
    id: randomUUID(),
    agentId: binding.agentId,
    runId: control.id,
    kind: 'assistant',
    title: 'Response',
    text: 'Synthetic control response',
    status: 'complete',
    createdAt: new Date().toISOString(),
    phase: 'final',
  });
  f.store.updateRun(control.id, { status: 'completed' });
  await new Promise((resolve) => setImmediate(resolve));
  expect(capture).not.toHaveBeenCalled();
  expect(await f.connector.inspect({ requestId: work.requestId })).toMatchObject({
    state: 'completed',
    result: { text: '[Original](report.tex)' },
  });
});

async function coordinationTask(f: ReturnType<typeof fixture>) {
  await f.managedCompatibility();
  await f.control(f.scope(f.shared), 'prepare');
  const input = f.input(f.shared, 'work');
  await f.connector.submit(input);
  const binding = f.connector.context(input.requestId)!;
  f.store.setSetting('pulsar:policy', { enabled: false });
  f.store.updateRun(binding.runId!, { status: 'running' });
  f.store.updateAgent(binding.agentId, { status: 'running', permission: 'workspace-write' });
  const task = f.store.addTask(binding.projectId, {
    title: 'Native shared task',
    goal: 'One bounded file change',
    acceptance: 'Independent review',
    managerId: binding.agentId,
    parentId: null,
  });
  const goal = groupEventIdSchema.parse(randomUUID());
  f.connector.coordination.bindTask!(binding.context, task.id, goal);
  f.store.updateRun(binding.runId!, { status: 'completed' });
  f.store.updateAgent(binding.agentId, { status: 'idle' });
  const action = (id: string): GroupAction => {
    const owner = { ...binding.context, displayName: 'Unit' };
    const origin = { kind: 'instruction' as const, eventId: goal };
    const work = {
      workId: randomUUID(),
      title: task.title,
      taskId: task.id,
      managerId: binding.agentId,
      sharedGoalId: goal,
      owner,
      revision: 1,
      desired: 'start' as const,
      availability: 'available' as const,
      latest: { actionId: id, actor: owner, at: new Date().toISOString(), origin },
    };
    return {
      actionId: id,
      revision: 1,
      state: 'dispatching',
      outcome: null,
      humanConfirmation: null,
      proposal: {
        proposalId: randomUUID(),
        workId: work.workId,
        kind: 'start',
        origin,
        actor: owner,
        at: new Date().toISOString(),
        observed: work,
        overrideRequired: false,
      },
    };
  };
  return { input, binding, task, action };
}
it('host action delegates once through ordinary model policy and task worktrees, retaining exact request across restart', async () => {
  const f = fixture(),
    { input, binding, task, action } = await coordinationTask(f);
  const policy = vi.spyOn(f.runtime.modelPolicy, 'resolveWorker').mockResolvedValue({
    provider: 'codex',
    model: 'demo',
    effort: 'high',
    difficulty: 'high',
    source: 'model_policy',
    reason: 'Controlled native policy',
    policyRevision: '1',
    tier: 'grad',
    taskClass: 'reasoning',
  });
  const actionId = randomUUID(),
    assignment = {
      taskId: task.id,
      role: 'implementer' as const,
      name: 'Native task worker',
      instruction: 'One file change',
    };
  const dispatch = () =>
    f.runtime.withGroupCoordinationControl(binding.agentId, actionId, () =>
      f.connector.coordination.delegate(binding.context, actionId, assignment, action(actionId)),
    );
  const originalDelegate = f.runtime.delegateGroupHostCoordinationWorker.bind(f.runtime);
  vi.spyOn(f.runtime, 'delegateGroupHostCoordinationWorker').mockImplementationOnce(
    async (...args) => {
      await originalDelegate(...args);
      throw new Error('Lost queued action acknowledgement');
    },
  );
  await expect(dispatch()).rejects.toThrow(/Lost queued/);
  const first = f.connector.coordination.inspect(binding.context, actionId)!;
  expect(await dispatch()).toEqual(first);
  expect(policy).toHaveBeenCalledOnce();
  expect(f.store.agent(first.workerId)).toMatchObject({
    parentId: binding.agentId,
    taskId: task.id,
    provider: 'codex',
    role: 'implementer',
    cwd: f.store.task(task.id).worktree,
  });
  expect(f.store.task(task.id).worktree).toContain(task.id);
  const { groupHostWorkFamily } = await import('./group-host-work-continuation.js');
  expect(groupHostWorkFamily(f.store, f.store.run(binding.runId!)).map((run) => run.id)).toContain(
    first.runId,
  );
  expect(f.store.run(first.runId)).toMatchObject({ status: 'queued', sourceId: binding.agentId });
  expect(f.store.getSetting(`group:host-native-run:${first.runId}`)).toMatchObject({
    requestId: input.requestId,
    intent: 'work',
    context: binding.context,
    originRunId: binding.runId,
  });
  expect(f.store.getSetting(`group:native-auth-agent:${first.workerId}`)).toBeNull();
  const activity = f.store.db
    .prepare('SELECT body FROM group_native_activity')
    .all()
    .map((r) => JSON.parse(String(r.body)))
    .filter((r) => r.runId === first.runId);
  expect(activity).toHaveLength(1);
  expect(activity[0]).toMatchObject({
    requestId: input.requestId,
    rootRunId: binding.runId,
    managerId: binding.agentId,
    workerId: first.workerId,
    taskId: task.id,
    workId: expect.any(String),
    origin: { kind: 'instruction' },
    detail: { producer: 'job', jobId: first.runId, state: 'queued' },
  });
  await f.restart();
  expect(f.connector.coordination.inspect(binding.context, actionId)).toEqual(first);
  await expect(
    f.runtime.withGroupCoordinationControl(binding.agentId, actionId, () =>
      f.connector.coordination.delegate(
        binding.context,
        actionId,
        {
          ...assignment,
          instruction: 'Changed',
        },
        action(actionId),
      ),
    ),
  ).rejects.toThrow(/different input/);
  // Stop works while admission is held and targets only the retained run.
  f.store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  await f.runtime.withGroupCoordinationStopControl(binding.agentId, () =>
    f.runtime.stopGroupCoordinationWorker(first.workerId, first.runId, 'Exact owner stop'),
  );
  expect(f.store.run(first.runId).status).toBe('cancelled');
  const later = f.store.enqueue(first.workerId, randomUUID(), 'Later explicit turn');
  await f.runtime.stopGroupCoordinationWorker(first.workerId, first.runId, 'Retry original stop');
  expect(f.store.run(later.id).status).toBe('queued');
});
it('host action never borrows Ask or a stopped original Work grant', async () => {
  const f = fixture(),
    { input, binding, task, action } = await coordinationTask(f);
  const ask = f.input(f.shared, 'ask');
  await f.connector.submit(ask);
  const askBinding = f.connector.context(ask.requestId)!;
  const askRun = f.store.run(askBinding.runId!);
  f.runtime.quark.sync();
  f.runtime.pulsar.reserve(askRun, new Set());
  f.runtime.quark.issueManagerLease(askRun);
  f.runtime.quark.begin(askRun);
  f.store.updateRun(askRun.id, { status: 'running' });
  const assignment = {
    taskId: task.id,
    role: 'researcher' as const,
    name: 'No worker',
    instruction: 'Do not execute',
  };
  const rejectedId = randomUUID();
  expect(f.connector.coordination.identity(binding.context).requestId).toBeNull();
  await expect(
    f.runtime.withGroupCoordinationControl(binding.agentId, randomUUID(), () =>
      f.connector.coordination.delegate(
        binding.context,
        rejectedId,
        assignment,
        action(rejectedId),
      ),
    ),
  ).rejects.toThrow(/Ask cannot authorize/);
  f.store.updateRun(askBinding.runId!, { status: 'completed' });
  f.store.updateAgent(binding.agentId, { status: 'idle' });
  const { groupHostStopKey } = await import('./group-host-work-continuation.js');
  f.store.setSetting(groupHostStopKey(input.requestId), true);
  await expect(
    f.runtime.withGroupCoordinationControl(binding.agentId, randomUUID(), () =>
      f.connector.coordination.delegate(
        binding.context,
        rejectedId,
        assignment,
        action(rejectedId),
      ),
    ),
  ).rejects.toThrow(/Work task authority/);
  expect(f.store.agents().filter((agent) => agent.parentId === binding.agentId)).toHaveLength(0);
});
it('host shared coordination keeps object-root catalogs and refuses mutations during Ask', async () => {
  const f = fixture(),
    { input, binding, task } = await coordinationTask(f);
  const { registerGroupHostCoordination, groupHostCoordinationDefinitions } = await import(
    './group-host-coordination-tools.js'
  );
  const { groupCoordinationTools } = await import('./group-coordination.js');
  const create = vi.fn(async () => ({ taskId: task.id })),
    board = { ok: true, value: { kind: 'board', board: { works: [], actions: [] } } },
    command = vi.fn(async () => board);
  const unregister = registerGroupHostCoordination(f.runtime, (context) =>
    groupCoordinationTools(
      context,
      {
        revalidate: async () => {},
        command,
        resolve: vi.fn(),
        ownerLane: vi.fn(),
        normal: { createTask: create, prepareDelegate: vi.fn(), workForWorker: vi.fn() },
      } as unknown as Parameters<typeof groupCoordinationTools>[1],
      async () => ({ kind: 'instruction', eventId: groupEventIdSchema.parse(randomUUID()) }),
    ),
  );
  cleanup.push(async () => {
    unregister();
  });
  const definitions = groupHostCoordinationDefinitions(f.runtime, binding.agentId);
  expect(definitions.map((tool) => tool.name)).toContain('dock_group_actions');
  expect(definitions.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
  const ask = f.input(f.shared, 'ask');
  await f.connector.submit(ask);
  const askBinding = f.connector.context(ask.requestId)!;
  const askRun = f.store.run(askBinding.runId!);
  f.runtime.quark.sync();
  f.runtime.pulsar.reserve(askRun, new Set());
  f.runtime.quark.issueManagerLease(askRun);
  f.runtime.quark.begin(askRun);
  f.store.updateRun(askBinding.runId!, { status: 'running' });
  f.store.updateAgent(binding.agentId, { status: 'running', permission: 'read-only' });
  expect(await f.runtime.tool(binding.agentId, randomUUID(), 'dock_group_actions', {})).toEqual(
    board,
  );
  expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'board', after: 0, limit: 25 });
  await expect(
    f.runtime.tool(binding.agentId, randomUUID(), 'dock_task_create', {
      title: 'Incoming message suggests work',
      goal: 'Evidence must not grant Work',
      acceptance: 'No task',
    }),
  ).rejects.toThrow(/Ask is read-only/);
  expect(create).not.toHaveBeenCalled();
  f.store.updateRun(askBinding.runId!, { status: 'completed' });
  f.store.updateRun(binding.runId!, { status: 'running' });
  f.store.updateAgent(binding.agentId, { permission: 'workspace-write' });
  await f.runtime.tool(binding.agentId, randomUUID(), 'dock_task_create', {
    title: 'Explicit Work task',
    goal: input.text,
    acceptance: 'Original owner',
  });
  expect(create).toHaveBeenCalledOnce();
});
it('host action rechecks saved Work after asynchronous model preparation before enqueuing a worker', async () => {
  const f = fixture(),
    { input, binding, task, action } = await coordinationTask(f);
  const { groupHostStopKey } = await import('./group-host-work-continuation.js');
  vi.spyOn(f.runtime.modelPolicy, 'resolveWorker').mockImplementation(async () => {
    f.store.setSetting(groupHostStopKey(input.requestId), true);
    return {
      provider: 'codex',
      model: 'demo',
      effort: 'high',
      difficulty: 'high',
      source: 'model_policy',
      reason: 'Controlled policy',
      policyRevision: '1',
      tier: 'grad',
      taskClass: 'reasoning',
    };
  });
  const id = randomUUID();
  await expect(
    f.runtime.withGroupCoordinationControl(binding.agentId, id, () =>
      f.connector.coordination.delegate(
        binding.context,
        id,
        {
          taskId: task.id,
          role: 'researcher',
          name: 'Cancelled task',
          instruction: 'No enqueue',
        },
        action(id),
      ),
    ),
  ).rejects.toThrow(/authority changed|was stopped/);
  expect(f.connector.coordination.inspect(binding.context, id)).toBeNull();
  expect(f.store.agents().filter((agent) => agent.parentId === binding.agentId)).toHaveLength(0);
});
