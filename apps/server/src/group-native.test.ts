import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupNativeBridge, GroupNativeJournal, GROUP_NATIVE_BLOCKER } from './group-native.js';
import { GroupEventRepository } from './group-events.js';
import { GroupIsolationBlocked } from './group-isolation.js';
import { CodexRpc } from './codex.js';
import { ClaudeSession } from './claude-session.js';
import { Store } from './store.js';
import { ModelPolicy } from './model-policy.js';
import { Pulsar } from './pulsar.js';
import { Quark } from './quark.js';

let root: string, repository: GroupEventRepository, journal: GroupNativeJournal;
let member: ReturnType<GroupEventRepository['createGroup']>;
beforeEach(() => {
  mkdirSync('data/tests', { recursive: true });
  root = realpathSync.native(mkdtempSync('data/tests/group-native-'));
  for (const dir of ['host', 'workspace', 'state']) mkdirSync(join(root, dir));
  repository = new GroupEventRepository(join(root, 'host/events.sqlite'));
  journal = new GroupNativeJournal(join(root, 'host/native.sqlite'), repository);
  member = repository.createGroup('Owner fixture');
});
afterEach(() => {
  try {
    journal.close();
    repository.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
const context = (
  visibility: 'shared' | 'private' = 'shared',
  provider: 'codex' | 'claude' = 'codex',
  agent: string = randomUUID(),
) =>
  journal.issue(
    {
      groupId: member.groupId,
      memberId: member.memberId,
      installationId: member.installationId,
      visibility,
    },
    agent,
    provider,
  );

it('persists fresh shared/private identities, local real-ID mappings and scoped source aliases across restart', () => {
  const shared = context(),
    privateContext = context('private');
  const s = journal.resolve(shared),
    p = journal.resolve(privateContext);
  expect(s.context.sessionId).not.toBe(p.context.sessionId);
  expect(s.context.nativeSessionId).not.toBe(p.context.nativeSessionId);
  const actual = randomUUID(),
    message = randomUUID();
  journal.bindNative(shared, actual);
  journal.bindNative(shared, actual);
  expect(() => journal.bindNative(shared, randomUUID())).toThrow(/immutable/);
  journal.bindNative(privateContext, randomUUID());
  const source = journal.publicationSource(shared, message);
  expect(source.nativeSessionId).not.toBe(actual);
  expect(source.messageId).not.toBe(message);
  expect(() => journal.publicationSource(privateContext, message)).toThrow(/Private/);
  journal.claimPreparation(shared);
  const id = s.context.sessionId;
  journal.close();
  journal = new GroupNativeJournal(join(root, 'host/native.sqlite'), repository);
  const reopened = journal.reopen(id);
  expect(() => journal.claimPreparation(reopened)).toThrow(/Native preparation/);
  expect(journal.publicationSource(reopened, message)).toEqual(source);
  const other = context();
  expect(() => journal.bindNative(other, actual)).toThrow(/UNIQUE/);
  const db = new DatabaseSync(join(root, 'host/native.sqlite'));
  try {
    expect(() => db.exec('DELETE FROM gn_native')).toThrow(/permanent/);
    expect(() => db.exec("UPDATE gn_contexts SET local_json='{}'")).toThrow(/immutable/);
  } finally {
    db.close();
  }
});

it('rejects forged/browser handles, unbound source messages, wrong membership and revocation', () => {
  const h = context();
  expect(() => journal.resolve({} as never)).toThrow(/Host-issued/);
  expect(() => journal.publicationSource(h, randomUUID())).toThrow(/FOREIGN KEY/);
  expect(() =>
    journal.issue(
      { ...member, installationId: randomUUID(), visibility: 'shared' } as never,
      randomUUID(),
      'codex',
    ),
  ).toThrow();
  repository.revokeMember(member.groupId, member.memberId);
  expect(() => journal.resolve(h)).toThrow(/Active membership/);
  expect(() => journal.bindNative(h, randomUUID())).toThrow(/Active membership/);
});

it('allocates Claude IDs locally before startup, never forks/resumes or adopts a different native ID', () => {
  const h = context('private', 'claude'),
    row = journal.resolve(h);
  expect(row.freshClaudeId).toBeTruthy();
  expect(() => journal.bindNative(h, randomUUID())).toThrow(/another native/);
  journal.bindNative(h, row.freshClaudeId!);
});

const macIt = process.platform === 'darwin' && process.arch === 'arm64' ? it : it.skip;
it('scopes retained container lifecycle receipts to the exact native context and namespace', () => {
  const own = context(),
    other = context(),
    namespace = 'a'.repeat(64);
  expect(journal.containerReceipt(own, namespace, 'created')).toBe(false);
  journal.runtimeEvent(own, 'container-created', {
    container: namespace,
    volume: 'synthetic-unit',
  });
  expect(journal.containerReceipt(own, namespace, 'created')).toBe(true);
  expect(journal.containerReceipt(other, namespace, 'created')).toBe(false);
  expect(journal.containerReceipt(own, namespace, 'stopped')).toBe(false);
  journal.runtimeEvent(own, 'container-stopped', {
    container: namespace,
    volume: 'synthetic-unit',
  });
  expect(journal.containerReceipt(own, namespace, 'stopped')).toBe(true);
  expect(journal.containerReceipt(own, 'b'.repeat(64), 'stopped')).toBe(false);
});
macIt.each(['codex', 'claude'] as const)(
  'uses the existing %s adapter, central frozen model and actual host admission; blocks before auth/process/socket side effects',
  async (provider) => {
    const store = new Store(join(root, 'host/dock.sqlite'));
    const project = store.register(join(root, 'workspace'), 'Boundary fixture', '', provider);
    const agent = store.addAgent({
      projectId: project.id,
      parentId: project.managerId,
      taskId: null,
      role: 'implementer',
      name: 'Group native',
      cwd: join(root, 'workspace'),
      provider,
    });
    store.updateAgent(agent.id, {
      toolPolicy: 'native',
      model: 'fixture-explicit-native-pin',
      effort: 'high',
    });
    // Fixtures exercise real central policy/QUARK methods without discovery/model calls.
    store.setSetting('pulsar:policy', { enabled: false });
    const discover = vi.fn(async () => {
      throw new Error('No discovery permitted in this fixture');
    });
    const models = new ModelPolicy(store, discover),
      pulsar = new Pulsar(store, () => null),
      quark = new Quark(store, pulsar);
    const executing = new Set<string>();
    quark.executing = () => executing;
    const h = context('shared', provider, agent.id);
    const run = store.enqueue(agent.id, randomUUID(), 'Tiny owned probe fixture');
    const bridge = new GroupNativeBridge(journal, store, models, quark);
    const resources = {
      revision: 1,
      expiresAt: Date.now() + 60_000,
      workspace: join(root, 'workspace'),
      stateBase: join(root, 'state'),
      readResources: [],
      executables: ['/usr/bin/false'],
      runtimeFiles: [],
      forbiddenPaths: [join(root, 'host')],
      requireNestedSandbox: true,
    };
    let prepared: Awaited<ReturnType<GroupNativeBridge['prepare']>> | undefined;
    try {
      await expect(bridge.prepare(run.id, h, resources, '/usr/bin/false')).rejects.toThrow(
        /QUARK execution/,
      );
      expect(existsSync(join(root, 'state', member.installationId))).toBe(false);
      expect(pulsar.reserve(store.run(run.id), executing)).toBe(true);
      store.claimQueuedRun(run.id);
      quark.begin(store.run(run.id));
      executing.add(agent.id);
      store.setSetting(`quark:project:${project.id}`, { paused: true });
      await expect(bridge.prepare(run.id, h, resources, '/usr/bin/false')).rejects.toThrow(
        /QUARK admission held.*project is paused/,
      );
      store.setSetting(`quark:project:${project.id}`, { paused: false });
      if (provider === 'claude') {
        await expect(bridge.prepare(run.id, h, resources, '/usr/bin/false')).rejects.toThrow(
          /affinity/,
        );
        store.setSetting(`claude:account:${agent.id}`, 'a'.repeat(64)); // fabricated sanitized identity only
      }
      prepared = await bridge.prepare(run.id, h, resources, '/usr/bin/false');
      expect(discover).not.toHaveBeenCalled();
      if (provider === 'codex') {
        expect(prepared.adapter).toBeInstanceOf(CodexRpc);
        const adapter = prepared.adapter as CodexRpc;
        expect(adapter.inheritNative).toBe(true);
        await expect(adapter.start()).rejects.toThrow(GROUP_NATIVE_BLOCKER);
        expect(adapter.process).toBeNull();
        expect(existsSync(adapter.socketPath)).toBe(false);
      } else {
        expect(prepared.adapter).toBeInstanceOf(ClaudeSession);
        const adapter = prepared.adapter as ClaudeSession;
        expect(adapter.options.model).toBe('fixture-explicit-native-pin');
        expect(adapter.options.resume).toBe(false);
        expect(adapter.options.forkFrom).toBeUndefined();
        const ambient = vi.fn(async () => {
          throw new Error('Unmanaged auth must never execute');
        });
        const hostile = new ClaudeSession(adapter.options, {
          identity: ambient,
          spawn: () => {
            throw new Error('Unmanaged spawn must never execute');
          },
        });
        await expect(
          hostile.submit({ deliveryId: randomUUID(), text: 'No native turn' }),
        ).rejects.toThrow(GROUP_NATIVE_BLOCKER);
        expect(ambient).not.toHaveBeenCalled();
        await hostile.close();
      }
      await expect(
        bridge.prepare(
          run.id,
          h,
          { ...resources, stateBase: join(root, 'workspace') },
          '/usr/bin/false',
        ),
      ).rejects.toThrow(/Native preparation/);
      executing.clear();
      await expect(
        prepared.adapter instanceof CodexRpc
          ? prepared.adapter.boundary!.check('codex')
          : prepared.adapter.options.boundary!.check('claude'),
      ).rejects.toThrow(/QUARK execution/);
    } finally {
      await prepared?.close();
      await models.close();
      store.close();
    }
  },
);

it('permanently refuses broker-path reuse across contexts and journal restart', async () => {
  const socket = join(root, 'broker.sock'),
    server = createServer();
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(relative(process.cwd(), socket), done);
  });
  try {
    journal.claimPreparation(context(), socket);
    expect(() => journal.claimPreparation(context('private'), socket)).toThrow(
      /Native preparation/,
    );
    journal.close();
    journal = new GroupNativeJournal(join(root, 'host/native.sqlite'), repository);
    expect(() => journal.claimPreparation(context(), socket)).toThrow(/Native preparation/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

macIt(
  'auth-route unit constructs the existing private-socket adapter with ephemeral auth and owned cleanup; fake RPC is not provider acceptance',
  async () => {
    const store = new Store(join(root, 'host/dock.sqlite'));
    const project = store.register(join(root, 'workspace'), 'Scoped auth unit', '');
    store.updateAgent(project.managerId, {
      model: 'fixture-explicit-native-pin',
      effort: 'high',
      toolPolicy: 'native',
    });
    store.setSetting('pulsar:policy', { enabled: false });
    const models = new ModelPolicy(store, async () => {
      throw new Error('Discovery forbidden in unit');
    });
    const pulsar = new Pulsar(store, () => null),
      quark = new Quark(store, pulsar);
    const executing = new Set<string>();
    quark.executing = () => executing;
    const h = context('private', 'codex', project.managerId);
    const run = store.enqueue(project.managerId, randomUUID(), 'Owned auth-only unit');
    expect(pulsar.reserve(store.run(run.id), executing)).toBe(true);
    quark.issueManagerLease(store.run(run.id));
    store.claimQueuedRun(run.id);
    quark.begin(store.run(run.id));
    executing.add(project.managerId);
    const start = vi.spyOn(CodexRpc.prototype, 'start').mockResolvedValue();
    vi.spyOn(CodexRpc.prototype, 'request').mockImplementation(async (method) => {
      if (method === 'config/read') return { config: { cli_auth_credentials_store: 'ephemeral' } };
      if (method === 'configRequirements/read') return { requirements: null };
      if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
      throw new Error('No generic RPC in auth unit');
    });
    const bridge = new GroupNativeBridge(journal, store, models, quark);
    let auth: Awaited<ReturnType<GroupNativeBridge['probeAuthentication']>> | undefined;
    try {
      auth = await bridge.probeAuthentication(
        run.id,
        h,
        {
          revision: 1,
          expiresAt: Date.now() + 60_000,
          workspace: join(root, 'workspace'),
          stateBase: join(root, 'state'),
          readResources: [],
          executables: ['/usr/bin/false'],
          runtimeFiles: [],
          forbiddenPaths: [join(root, 'host')],
          requireNestedSandbox: false,
        },
        '/usr/bin/false',
      );
      const adapter = start.mock.contexts[0] as CodexRpc;
      expect(adapter.inheritNative).toBe(true);
      expect(adapter.boundary?.codexDirect).toBe(true);
      expect(adapter.boundary?.codexArgs).toEqual(['-c', 'cli_auth_credentials_store="ephemeral"']);
      expect(adapter.boundary?.environment.HOME).not.toBe(process.env.HOME);
      expect(adapter.boundary?.environment.NODE_OPTIONS).toBeUndefined();
      const socketDirectory = adapter.socketPath.slice(0, adapter.socketPath.lastIndexOf('/'));
      expect(existsSync(socketDirectory)).toBe(true);
      expect(await auth.inspect()).toBe('signed-out');
      await auth.close();
      expect(existsSync(socketDirectory)).toBe(false);
      expect(() => journal.publicationSource(h, 'no-native-thread')).toThrow(/Private/);
      await expect(
        bridge.probeAuthentication(
          run.id,
          h,
          {
            revision: 1,
            expiresAt: Date.now() + 60_000,
            workspace: join(root, 'workspace'),
            stateBase: join(root, 'state'),
            readResources: [],
            executables: ['/usr/bin/false'],
            runtimeFiles: [],
            forbiddenPaths: [join(root, 'host')],
            requireNestedSandbox: false,
          },
          '/usr/bin/false',
        ),
      ).rejects.toThrow(/Native preparation/);
    } finally {
      await auth?.close();
      await models.close();
      store.close();
    }
  },
);

it('durable request identity rejects changed input, unsafe regression and forged sources', () => {
  const h = context(),
    id = randomUUID();
  journal.bindNative(h, 'unit-request-native');
  expect(journal.beginRequest(h, id, 'exact input').fresh).toBe(true);
  expect(journal.beginRequest(h, id, 'exact input').fresh).toBe(false);
  expect(() => journal.beginRequest(h, id, 'changed')).toThrow(/idempotency/);
  journal.requestEvent(h, id, { state: 'admitted' });
  journal.requestEvent(h, id, { state: 'write-intent' });
  expect(() => journal.requestEvent(h, id, { state: 'admitted' })).toThrow(/regress/);
  journal.requestEvent(h, id, { state: 'native-started', nativeTurnId: 'actual-turn' });
  expect(() => journal.requestEvent(h, id, { nativeTurnId: 'foreign-turn' })).toThrow(/immutable/);
  const source = journal.publicationSource(h, 'actual-message');
  expect(() =>
    journal.requestEvent(h, id, {
      state: 'completed',
      text: 'exact',
      nativeToolItems: 1,
      source: { ...source, messageId: randomUUID() },
    }),
  ).toThrow(/Exact actual/);
  journal.requestEvent(h, id, { state: 'unknown' });
  const contextId = journal.resolve(h).context.sessionId;
  journal.close();
  journal = new GroupNativeJournal(join(root, 'host/native.sqlite'), repository);
  const recovered = journal.reopen(contextId);
  expect(journal.request(recovered, id)?.nativeTurnId).toBe('actual-turn');
  expect(() => journal.requestEvent(recovered, id, { state: 'write-intent' })).toThrow(/regress/);
  const complete = journal.requestEvent(recovered, id, {
    state: 'completed',
    text: 'exact',
    nativeToolItems: 1,
    source,
  });
  expect(journal.requestEvent(recovered, id, { state: 'completed', text: 'replacement' })).toEqual(
    complete,
  );
  const privateHandle = context('private'),
    privateId = randomUUID();
  journal.beginRequest(privateHandle, privateId, 'private');
  journal.requestEvent(privateHandle, privateId, { state: 'admitted' });
  journal.requestEvent(privateHandle, privateId, { state: 'write-intent' });
  expect(() =>
    journal.requestEvent(privateHandle, privateId, { state: 'completed', source }),
  ).toThrow(/Private/);
});
it('production artifact stays denied without actual current four-mode evidence and review', () => {
  const h = context(),
    image = 'sha256:' + 'e'.repeat(64),
    kernel = 'f'.repeat(64);
  expect(journal.artifactReady(image, 'codex', kernel)).toBe(false);
  expect(() => journal.approveNativeArtifact(h, 'a'.repeat(40), 'linux-guest-tools')).toThrow(
    /evidence/,
  );
  // UNIT schema observer only; not actual native acceptance.
  journal.nativeCheck(h, image, kernel, 'guest-sandbox', {
    privacy: true,
    nested: true,
    browser: true,
  });
  expect(() => journal.approveNativeArtifact(h, 'a'.repeat(40), 'linux-guest-tools')).toThrow(
    /Real native/,
  );
  expect(journal.artifactReady(image, 'codex', kernel)).toBe(false);
  expect(() =>
    journal.nativeCheck(h, image, kernel, 'namespace-crash', { stopped: true }),
  ).toThrow();
});
