import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
  chmodSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
} from 'node:fs';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { repoRoot } from './paths.js';
import { installService, groupServiceHash } from '../../../scripts/group-service-registry.mjs';
import { GroupHost, GroupHostError } from './group-host.js';
import { groupDocumentVersion } from './group-documents.js';
import { GroupFeatureDocuments } from './group-feature-documents.js';
import { GroupDocumentCaptureError } from './group-documents-native.js';
import { GroupFeatureCoordination } from './group-feature-coordination.js';
import { GroupHostNativeActivity, registerGroupHostActivity } from './group-native-activity.js';
import {
  captureGroupRunTransition,
  captureGroupNativeFinal,
} from './group-native-activity-producers.js';
import { inheritGroupHostWork } from './group-host-work-continuation.js';
import { GroupMemberFeed } from './group-member-feed.js';
import { groupFeatureEvidence } from './group-feature-evidence.js';
import { modelFixture } from './model-policy.fixture.js';
import type {
  GroupNativeConnector,
  GroupNativeConnectorFactory,
  GroupNativeSnapshot,
} from './group-host-native.js';
import {
  groupServiceConfigurationSchema,
  type ActiveGroupServiceConfiguration,
} from './group-host-storage.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';
import { localRequestProof } from '@dock/shared/dist/local-authorization.js';
import {
  groupHostOpenSchema,
  groupHostReceiptSchema,
  type GroupHostOpen,
} from '@dock/shared/dist/group-host.js';
import { publicationCanonical } from './group-publication-protocol.js';
import { GroupPublicationController, type PublicationAccess } from './group-publication.js';
import { proxyPath } from './hosts.js';
import { Hosts, registerHostRoutes } from './hosts.js';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {
  createGroupHostNativeConnector,
  type GroupHostNativeRuntime,
} from './group-native-host-runtime.js';
import { GroupHostNativeGit } from './group-host-native-git.js';
import { git, ensureWorktree, checkpointWorktree } from './workspaces.js';
import { prepareRunDelivery, markRunHandoff } from './run-recovery.js';
import type { FolderPicker } from './folder-picker.js';
import { verifyHostedArchive } from './group-hosted-archive.js';
import { groupExportArchiveSchema } from '@dock/shared/dist/group-hosted-export.js';
import { groupActionResultSchema } from '@dock/shared/dist/group-actions.js';
import {
  GROUP_LOCAL_RECEIPT_BYTES,
  GROUP_LOCAL_RECEIPT_CONTROL_BYTES,
  groupLocalReceiptCapacity,
} from './group-local-receipt-capacity.js';
import type { GroupPromotionSynthesis, GroupPromotionSynthesisResult } from './group-promotion.js';
import {
  groupEventIdSchema,
  groupOperationIdSchema,
  groupEntityIdSchema,
  type GroupContext,
} from '@dock/shared';

// Fixed fixture relay only: real protected routing stays HTTPS/WSS while both
// owned services run on loopback. No production transport injection is added.
const serviceRelays = vi.hoisted(() => new Map<string, { endpoint: string; approval: string }>());
const notificationRoutes = vi.hoisted(() => [] as string[]);
vi.mock('ws', async (original) => {
  const native = await original<typeof import('ws')>();
  class MappedWebSocket extends native.default {
    constructor(address: string | URL, options?: import('ws').ClientOptions) {
      const url = new URL(String(address));
      const relay = serviceRelays.get(url.origin.replace(/^wss:/, 'https:'));
      if (relay) {
        expect(
          new Headers(options?.headers as ConstructorParameters<typeof Headers>[0]).get(
            'X-Hosting-Approval',
          ),
        ).toBe(relay.approval);
        expect(
          new Headers(options?.headers as ConstructorParameters<typeof Headers>[0]).get(
            'Authorization',
          ),
        ).toMatch(/^Bearer [a-f0-9]{64}$/);
        notificationRoutes.push(url.origin);
      }
      const headers = new Headers(options?.headers as ConstructorParameters<typeof Headers>[0]);
      if (relay) headers.delete('X-Hosting-Approval');
      super(
        relay ? relay.endpoint.replace(/^http:/, 'ws:').replace(/\/$/, '') + url.pathname : address,
        relay ? { ...options, headers: Object.fromEntries(headers) } : options,
      );
    }
  }
  return { ...native, default: MappedWebSocket, WebSocket: MappedWebSocket };
});

const secret = () => randomBytes(32).toString('hex');
let root: string, endpoint: string, worker: ChildProcess | undefined, port: number;
const setup = secret(),
  setupHash = createHash('sha256').update(`dock-group-setup-v1:${setup}`).digest('hex');
const closers: (() => Promise<void>)[] = [];
async function freePort() {
  const server = netServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const p = (server.address() as { port: number }).port;
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  return p;
}
async function startWorker(owned?: { port: number; endpoint: string; persist: string }) {
  const workerPort = owned?.port ?? port,
    workerEndpoint = owned?.endpoint ?? endpoint;
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, 'apps/group-service/node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(workerPort),
      '--inspector-port',
      '0',
      '--persist-to',
      owned?.persist ?? join(root, 'workerd'),
      '--var',
      'HOSTING_MODE:local-test',
      '--var',
      `GROUP_SETUP_HASH:${setupHash}`,
      '--log-level',
      'error',
    ],
    {
      cwd: join(repoRoot, 'apps/group-service'),
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: 'pipe',
    },
  );
  if (!owned) worker = child;
  else
    closers.push(async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    });
  child.stdout?.resume();
  child.stderr?.resume();
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error('Owned workerd exited');
    try {
      const response = await fetch(`${workerEndpoint}/v1/create`, {
        method: 'POST',
        signal: AbortSignal.timeout(300),
      });
      if (response.status === 403 || response.status === 400) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Owned workerd startup timeout');
}
async function stopWorker() {
  const child = worker;
  worker = undefined;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  child.kill('SIGTERM');
  await exited;
}
beforeAll(async () => {
  mkdirSync(join(repoRoot, 'data/normal-groups'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/normal-groups/test-'));
  port = await freePort();
  endpoint = `http://127.0.0.1:${port}/`;
  await startWorker();
}, 30000);
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
afterAll(async () => {
  await stopWorker();
  rmSync(root, { recursive: true, force: true });
}, 10000);
async function installation(
  existing?: string,
  options: {
    configured?: boolean;
    http?: typeof fetch;
    native?: GroupNativeConnector;
    nativeFactory?: GroupNativeConnectorFactory;
    service?: ActiveGroupServiceConfiguration;
    documents?: ConstructorParameters<typeof GroupFeatureDocuments>[1];
    localNative?: boolean;
    folderPicker?: FolderPicker;
  } = {},
) {
  const directory = existing ?? mkdtempSync(join(root, 'installation-'));
  const appPort = await freePort();
  const store = new Store(join(directory, 'dock.sqlite'));
  let launches = 0;
  const runtime = new Runtime(store, directory, 'never-native', async () => {
    launches++;
    throw new Error('Native launch prohibited in host checks');
  });
  if (options.localNative) {
    modelFixture(store);
    vi.spyOn(runtime, 'kick').mockImplementation(() => {});
  }
  const host = new GroupHost(directory, {
    betaProfile: null,
    http: options.http,
    native: options.native,
    nativeFactory:
      options.nativeFactory ??
      (options.localNative ? (ports) => createGroupHostNativeConnector(runtime, ports) : undefined),
  });
  if (options.configured !== false && !existing)
    writeFileSync(
      join(host.directory, 'service.json'),
      JSON.stringify(
        options.service ?? {
          version: 1,
          mode: 'local-test',
          endpoint,
          endpointId: randomUUID(),
          setupCapability: setup,
        },
      ),
      { mode: 0o600 },
    );
  const documents = options.documents
    ? new GroupFeatureDocuments(host, options.documents)
    : undefined;
  const access = new LocalAccess(prepareLocalAccess(directory, appPort));
  const app = await createServer(store, runtime, {
    port: appPort,
    groupHost: host,
    localAccess: access,
    ownsRuntime: false,
    folderPicker: options.folderPicker,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
    await runtime.close();
    await documents?.close();
    await host.close();
    store.close();
    expect(launches).toBe(0);
  };
  closers.push(close);
  const auth = (method: string, path: string) => {
    const challenge = secret(),
      proof = access.proof({ role: 'owner', challenge });
    return `Dock owner.${proof.nonce}.${localRequestProof(access.configuration.owner, access.configuration.origin, 'owner', challenge, proof.nonce, method, path)}`;
  };
  const post = (name: string, body: unknown, authorized = true) => {
    const path = `/api/groups/${name}`;
    return app.inject({
      method: 'POST',
      url: path,
      headers: {
        host: `127.0.0.1:${appPort}`,
        origin: `http://127.0.0.1:${appPort}`,
        'content-type': 'application/json',
        ...(authorized ? { authorization: auth('POST', path) } : {}),
      },
      payload: body as Record<string, unknown>,
    });
  };
  const get = (name: string, authorized = true) => {
    const path = `/api/groups/${name}`;
    return app.inject({
      method: 'GET',
      url: path,
      headers: {
        host: `127.0.0.1:${appPort}`,
        origin: `http://127.0.0.1:${appPort}`,
        ...(authorized ? { authorization: auth('GET', path) } : {}),
      },
    });
  };
  return { directory, host, app, post, get, close, access, auth, appPort, runtime, store };
}
// Controlled semantic output only; these host journeys launch no provider.
function controlledFeedSynthesis(): GroupPromotionSynthesis {
  const receipts = new Map<string, GroupPromotionSynthesisResult>();
  return {
    async submit(input) {
      const result: GroupPromotionSynthesisResult = {
        state: 'completed',
        identity: input.identity,
        decision: {
          category: 'Finding',
          sentences: ['The controlled shared source contains a retained result.'],
          evidenceRefs: input.source.evidenceRefs,
        },
      };
      receipts.set(input.synthesisId, result);
      return result;
    },
    async inspect(id) {
      return receipts.get(id) ?? { state: 'unknown' };
    },
  };
}
async function selectFeedWriter(
  f: Awaited<ReturnType<typeof installation>>,
  handle: string,
  synthesis = controlledFeedSynthesis(),
) {
  f.host.promotion.start(synthesis);
  const response = await f.post('feed-writer', { handle, key: randomUUID() });
  expect(response.statusCode, response.body).toBe(200);
  await f.host.promotion.pass();
}
async function progressFeed(f: Awaited<ReturnType<typeof installation>>) {
  await f.host.promotion.pass();
  await f.host.promotion.pass();
}
async function create(f: Awaited<ReturnType<typeof installation>>, name = 'River') {
  const input = { key: randomUUID(), projectName: name, displayName: 'Amina · أمينة' };
  const response = await f.post('create', input);
  expect(response.statusCode, response.body).toBe(200);
  return { input, open: groupHostOpenSchema.parse(response.json()) };
}

it('local byte admission preserves real send/draft retries beyond old row limits and refuses a new key before local effects', async () => {
  const f = await installation();
  const { open } = await create(f);
  const handle = open.private.handle;
  f.host.db.exec('BEGIN IMMEDIATE');
  try {
    const insertSend = f.host.db.prepare('INSERT INTO gh_sends VALUES(?,?,?,?)');
    for (let i = 0; i < 2048; i++) insertSend.run(handle, randomUUID(), '{}', '{}');
    const insertDraft = f.host.db.prepare('INSERT INTO gh_draft_receipts VALUES(?,?,?,?)');
    for (let i = 0; i < 4096; i++) insertDraft.run(handle, randomUUID(), '{}', '{}');
    f.host.db.exec('COMMIT');
  } catch (error) {
    f.host.db.exec('ROLLBACK');
    throw error;
  }
  const send = { handle, key: randomUUID(), text: 'Retain this exact private original.' };
  const draft = { handle, key: randomUUID(), revision: 0, text: 'Unsent draft stays here.' };
  const sent = await f.post('send', send),
    saved = await f.post('draft', draft);
  expect(sent.statusCode, sent.body).toBe(200);
  expect(saved.statusCode, saved.body).toBe(200);
  f.host.db.exec('BEGIN IMMEDIATE');
  try {
    const insert = f.host.db.prepare('INSERT INTO gh_sends VALUES(?,?,?,?)');
    while (
      groupLocalReceiptCapacity(f.host.db).bytes + 2 + 8192 + 4096 <=
      GROUP_LOCAL_RECEIPT_BYTES - GROUP_LOCAL_RECEIPT_CONTROL_BYTES
    )
      insert.run('capacity-fixture', randomUUID(), '{}', '{}');
    f.host.db.exec('COMMIT');
  } catch (error) {
    f.host.db.exec('ROLLBACK');
    throw error;
  }
  const before = groupLocalReceiptCapacity(f.host.db);
  expect((await f.post('send', send)).json()).toEqual(sent.json());
  expect((await f.post('draft', draft)).json()).toEqual(saved.json());
  const refusedKey = randomUUID();
  const refused = await f.post('send', { ...send, key: refusedKey, text: 'Not delivered.' });
  expect(refused.statusCode, refused.body).toBe(409);
  expect(refused.json().error).toContain('no new request was delivered');
  expect(f.host.db.prepare('SELECT 1 FROM gh_sends WHERE key=?').get(refusedKey)).toBeUndefined();
  expect(
    f.host.db.prepare('SELECT text,revision FROM gh_drafts WHERE handle=?').get(handle),
  ).toEqual(saved.json());
  expect(groupLocalReceiptCapacity(f.host.db)).toEqual(before);
  const removed = await f.post('local-visibility', {
    handle: open.group.handle,
    key: randomUUID(),
    revision: 0,
    hidden: true,
  });
  expect(removed.statusCode, removed.body).toBe(200);
  expect(removed.json().local.hidden).toBe(true);
  const restored = await f.post('local-visibility', {
    handle: open.group.handle,
    key: randomUUID(),
    revision: 1,
    hidden: false,
  });
  expect(restored.statusCode, restored.body).toBe(200);
  expect(restored.json().local.hidden).toBe(false);
}, 30000);

it('paired chosen-folder setup works before agents and synchronizes actual reviewed files in both directions without a provider turn', async () => {
  const files = mkdtempSync(join(root, 'shared-files-'));
  const remote = join(files, 'remote.git'),
    selected = join(files, 'chosen'),
    other = join(files, 'other');
  await git(files, ['init', '--bare', '--initial-branch=main', remote]);
  await git(files, ['clone', remote, selected]);
  await git(selected, ['config', 'user.name', 'Fixture']);
  await git(selected, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(selected, 'baseline.txt'), 'Retain the existing chosen project.\n');
  await git(selected, ['add', 'baseline.txt']);
  await git(selected, ['commit', '-m', 'Existing owner repository']);
  await git(selected, ['push', 'origin', 'HEAD:refs/heads/main']);
  const picker = vi.fn<FolderPicker>(async () => selected);
  const f = await installation(undefined, { localNative: true, folderPicker: picker });
  const connector = f.host.native as GroupHostNativeRuntime;
  connector.revalidate(async (context) => {
    await (await f.host.nativeFeatureContext(context)).revalidate();
  });
  connector.contributions((enrollment) => f.host.localContributing(enrollment));
  let releaseCapture!: () => void, captureStarted!: () => void;
  const heldCapture = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  const startedCapture = new Promise<void>((resolve) => {
    captureStarted = resolve;
  });
  connector.completed(async () => {
    captureStarted();
    await heldCapture;
  });
  closers.push(async () => releaseCapture());
  const verify = vi.fn(async () => {});
  const nativeGit = new GroupHostNativeGit(f.host, f.runtime, connector, true, verify);
  connector.beforeTurn((context, requestId) => nativeGit.beforeWork(context, requestId));
  closers.push(() => nativeGit.close());
  await f.app.listen({ host: '127.0.0.1', port: f.appPort });
  const hostId = (
    await f.app.inject({ url: '/api/host-info', headers: { host: `127.0.0.1:${f.appPort}` } })
  ).json().hostId as string;
  const pairedId = randomUUID();
  const paired = new Hosts(
    join(files, 'paired'),
    async () => ({ port: f.appPort, alive: () => true, async close() {} }),
    [
      {
        id: pairedId,
        label: 'Owned folder fixture',
        accountLabel: 'Fixture',
        expectedHostId: hostId,
        sshAlias: 'fixture-owned',
        remotePort: f.appPort,
        credential: f.access.configuration.host,
      },
    ],
  );
  closers.push(() => paired.close());
  const gateway = Fastify();
  await gateway.register(websocket);
  registerHostRoutes(gateway, paired);
  closers.push(() => gateway.close());
  const post = (path: string, payload: unknown) =>
    gateway.inject({
      method: 'POST',
      url: `/api/hosts/${pairedId}/proxy/${path}`,
      payload: payload as Record<string, unknown>,
    });
  const selectionKey = randomUUID();
  const chosen = await post('projects/connect-folder', { key: selectionKey, selectOnly: true });
  expect(chosen.statusCode, chosen.body).toBe(200);
  expect(chosen.json()).toMatchObject({
    project: null,
    selection: { key: selectionKey, workspacePath: realpathSync(selected) },
  });
  expect(f.store.agents()).toEqual([]);
  expect(f.store.runs()).toEqual([]);
  const created = await post('groups/create', {
    key: randomUUID(),
    projectName: 'Chosen folder journey',
    displayName: 'Owner fixture',
  });
  expect(created.statusCode, created.body).toBe(200);
  const open = groupHostOpenSchema.parse(created.json()),
    handle = open.shared.handle;
  const attach = { action: 'select', handle, key: randomUUID(), revision: 0, selectionKey };
  const attached = await post('groups/workspace', attach);
  expect(attached.statusCode, attached.body).toBe(200);
  expect(attached.json()).toMatchObject({
    revision: 1,
    available: true,
    workspacePath: realpathSync(selected),
  });
  expect((await post('groups/workspace', attach)).json()).toEqual(attached.json());
  expect(
    (
      await post('groups/workspace', {
        ...attach,
        key: randomUUID(),
        revision: 1,
        path: '/arbitrary',
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await post('groups/native-git', { action: 'status', handle, command: 'anything' })).statusCode,
  ).toBe(400);
  expect((await post('groups/native-git/run', { command: 'anything' })).statusCode).toBe(404);
  const initial = await post('groups/native-git', { action: 'status', handle });
  expect(initial.json()).toMatchObject({
    autoSync: false,
    connected: false,
    workspacePath: realpathSync(selected),
  });
  const connection = { action: 'connect', handle, key: randomUUID() };
  const connected = await post('groups/native-git', connection);
  expect(connected.statusCode, connected.body).toBe(200);
  expect(connected.json()).toMatchObject({ connected: true, autoSync: true });
  expect((await post('groups/native-git', connection)).json()).toEqual(connected.json());
  expect(verify).toHaveBeenCalledTimes(1);
  expect(f.store.agents()).toEqual([]);
  const readOnly = { handle, key: randomUUID(), revision: 0, mode: 'read-only' };
  expect((await post('groups/local-mode', readOnly)).json()).toMatchObject({
    local: { mode: 'read-only', modeRevision: 1 },
  });
  expect(
    (
      await post('groups/local-mode', {
        ...readOnly,
        key: randomUUID(),
        revision: 1,
        path: '/arbitrary',
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await post('groups/request-agent', {
        handle,
        key: randomUUID(),
        intent: 'ask',
        text: 'New model question',
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (await post('groups/send', { handle, key: randomUUID(), text: 'New human post' })).statusCode,
  ).toBe(409);
  expect(
    (
      await post('groups/draft', {
        handle,
        key: randomUUID(),
        revision: 0,
        text: 'Retain this local draft.',
      })
    ).json(),
  ).toMatchObject({ text: 'Retain this local draft.', revision: 1 });
  await git(files, ['clone', remote, other]);
  await git(other, ['config', 'user.name', 'Other member']);
  await git(other, ['config', 'user.email', 'other@example.invalid']);
  writeFileSync(join(other, 'incoming.txt'), 'Other member’s shared result.\n');
  await git(other, ['add', 'incoming.txt']);
  await git(other, ['commit', '-m', 'Incoming shared files']);
  await git(other, ['push', 'origin', 'HEAD:refs/heads/main']);
  const pulled = await post('groups/native-git', { action: 'sync', handle, key: randomUUID() });
  expect(pulled.statusCode, pulled.body).toBe(200);
  expect(readFileSync(join(selected, 'incoming.txt'), 'utf8')).toContain('Other member');
  expect(f.store.runs()).toEqual([]);
  expect(
    (
      await post('groups/local-mode', {
        handle,
        key: randomUUID(),
        revision: 1,
        mode: 'contribute',
      })
    ).statusCode,
  ).toBe(200);
  expect(f.store.agents()).toEqual([]);
  expect(
    (await post('groups/native-owner', { action: 'prepare', handle, key: randomUUID() }))
      .statusCode,
  ).toBe(200);
  const workInput = {
    handle,
    key: randomUUID(),
    intent: 'work' as const,
    text: 'Create one reviewed shared result.',
  };
  const request = await post('groups/request-agent', workInput);
  expect(request.statusCode, request.body).toBe(200);
  const requestId = request.json().requestId as string;
  const binding = connector.context(requestId)!;
  expect(binding.cwd).toBe(realpathSync(selected));
  expect(f.store.agent(binding.agentId).cwd).toBe(realpathSync(selected));
  expect(
    (await post('groups/local-mode', { handle, key: randomUUID(), revision: 2, mode: 'read-only' }))
      .statusCode,
  ).toBe(200);
  const held = await post('groups/request-agent', workInput);
  expect(held.statusCode, held.body).toBe(200);
  expect(held.json()).toMatchObject({ requestId, state: 'queued' });
  expect(connector.context(requestId)!.runId).toBe(binding.runId);
  expect(f.store.runs()).toHaveLength(1);
  expect(
    (
      await post('groups/local-mode', {
        handle,
        key: randomUUID(),
        revision: 3,
        mode: 'contribute',
      })
    ).statusCode,
  ).toBe(200);
  const workBranch = await git(selected, ['branch', '--show-current']);
  expect(workBranch).toMatch(new RegExp(`^swa/member-[a-f0-9]{12}/work-${requestId}$`));
  // Simulate a provider's exact durable final outcome; the fixture never calls a provider.
  const runId = binding.runId!;
  f.store.updateRun(runId, { status: 'running' });
  prepareRunDelivery(f.store, f.store.run(runId));
  markRunHandoff(f.store, f.store.run(runId));
  f.store.entry({
    id: `${randomUUID()}-final`,
    agentId: binding.agentId,
    runId,
    kind: 'assistant',
    title: 'Response',
    text: 'Exact fixture Work completed.',
    status: 'complete',
    createdAt: new Date().toISOString(),
    phase: 'final',
  });
  f.store.updateRun(runId, { status: 'completed' });
  f.store.updateAgent(binding.agentId, { status: 'idle', turnId: null });
  expect(await connector.inspect({ requestId })).toMatchObject({
    state: 'completed',
    result: { text: 'Exact fixture Work completed.' },
  });
  await startedCapture;
  expect(connector.completionPending(requestId)).toBe(true);
  const task = f.store.addTask(binding.projectId, {
    title: 'Reviewed result',
    goal: 'Share files',
    acceptance: 'One file',
    parentId: null,
  });
  const taskPath = await ensureWorktree(f.store, task, f.directory);
  writeFileSync(join(taskPath, 'outgoing.txt'), 'Independently reviewed outgoing result.\n');
  const source = await checkpointWorktree(f.store, task.id);
  const reviewer = f.store.addAgent({
    projectId: binding.projectId,
    parentId: task.managerId,
    taskId: task.id,
    role: 'reviewer',
    name: 'Independent fixture reviewer',
    cwd: taskPath,
  });
  f.store.updateTask(task.id, {
    status: 'done',
    reviewedCommit: source,
    reviewAgentId: reviewer.id,
    review: 'Exact checkpoint approved in fixture',
  });
  const preview = await post('groups/native-git', { action: 'preview', handle, taskId: task.id });
  expect(preview.statusCode, preview.body).toBe(200);
  const applied = await post('groups/native-git', {
    action: 'apply',
    handle,
    key: randomUUID(),
    taskId: task.id,
    source: preview.json().preview.source,
    target: preview.json().preview.target,
  });
  expect(applied.statusCode, applied.body).toBe(200);
  const publishedHead = await git(selected, ['rev-parse', 'HEAD']);
  const pushed = await post('groups/native-git', { action: 'sync', handle, key: randomUUID() });
  expect(pushed.statusCode, pushed.body).toBe(200);
  await git(other, ['pull', '--ff-only']);
  expect(readFileSync(join(other, 'outgoing.txt'), 'utf8')).toContain('Independently reviewed');
  expect(readFileSync(join(selected, 'baseline.txt'), 'utf8')).toContain('existing chosen project');
  expect(await git(selected, ['rev-parse', workBranch])).toBe(publishedHead);
  writeFileSync(join(other, 'after-work.txt'), 'Received after completed Work while Read-only.\n');
  await git(other, ['add', 'after-work.txt']);
  await git(other, ['commit', '-m', 'Later shared member change']);
  await git(other, ['push', 'origin', 'HEAD:refs/heads/main']);
  const receivedHead = await git(other, ['rev-parse', 'HEAD']);
  expect(
    (await post('groups/local-mode', { handle, key: randomUUID(), revision: 4, mode: 'read-only' }))
      .statusCode,
  ).toBe(200);
  expect(
    (await post('groups/native-git', { action: 'sync', handle, key: randomUUID() })).statusCode,
  ).toBe(200);
  expect(await git(selected, ['branch', '--show-current'])).toBe(workBranch);
  expect(await git(selected, ['rev-parse', 'HEAD'])).toBe(publishedHead);
  expect(await git(selected, ['ls-files', '--', 'after-work.txt'])).toBe('');
  releaseCapture();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(connector.completionPending(requestId)).toBe(false);
  expect(
    (await post('groups/native-git', { action: 'sync', handle, key: randomUUID() })).statusCode,
  ).toBe(200);
  expect(await git(selected, ['branch', '--show-current'])).toBe('main');
  expect(await git(selected, ['rev-parse', 'HEAD'])).toBe(receivedHead);
  expect(readFileSync(join(selected, 'after-work.txt'), 'utf8')).toContain('while Read-only');
  expect(await git(selected, ['rev-parse', workBranch])).toBe(publishedHead);
  expect(await git(selected, ['ls-remote', 'origin', `refs/heads/${workBranch}`])).toContain(
    publishedHead,
  );
  expect(connector.context(requestId)!.runId).toBe(runId);
  expect(f.store.runs()).toHaveLength(1);
  expect(f.store.runs()[0].status).toBe('completed');
  const pendingKey = randomUUID();
  f.host.db.prepare('INSERT INTO gng_operations VALUES(?,?,NULL)').run(
    pendingKey,
    JSON.stringify({
      action: 'sync',
      handle,
      key: pendingKey,
      workspaceChoiceKey: binding.workspaceChoiceKey,
    }),
  );
  const switched = await post('groups/workspace', { ...attach, key: randomUUID(), revision: 1 });
  expect(switched.statusCode, switched.body).toBe(409);
  expect(switched.json().error).toContain('pending shared-file operation');
  expect((await post('groups/workspace', { action: 'status', handle })).json().revision).toBe(1);
  expect((await post('groups/workspace', attach)).json()).toEqual(attached.json());
  const originalFolder = `${selected}-original`;
  renameSync(selected, originalFolder);
  mkdirSync(selected);
  const retained = await post('groups/workspace', attach);
  expect(retained.statusCode, retained.body).toBe(200);
  expect(retained.json()).toMatchObject({
    revision: 1,
    selectionKey,
    workspacePath: realpathSync(selected),
    available: false,
  });
  expect(
    (await post('groups/workspace', { ...attach, selectionKey: randomUUID() })).statusCode,
  ).toBe(409);
  const nativeDb = new DatabaseSync(join(f.host.directory, 'host-native.sqlite'), {
    readOnly: true,
  });
  try {
    expect(Number(nativeDb.prepare('SELECT count(*) n FROM hnr_workspaces').get()!.n)).toBe(1);
  } finally {
    nativeDb.close();
  }
  expect(readFileSync(join(originalFolder, 'baseline.txt'), 'utf8')).toContain(
    'existing chosen project',
  );
}, 30000);
/** Pre-direct-delivery producer fixture. Its original IDs and pending receipt
 * model an installation saved by the previous host, not a new normal send. */
async function legacyHuman(
  f: Awaited<ReturnType<typeof installation>>,
  open: GroupHostOpen,
  input: { handle: string; key: string; text: string },
) {
  expect(input.handle).toBe(open.shared.handle);
  const messageId = randomUUID(),
    operationId = randomUUID(),
    entityId = randomUUID(),
    runId = randomUUID();
  const source = {
    sessionId: open.shared.context.sessionId,
    provider: open.shared.context.provider,
    nativeSessionId: open.shared.context.nativeSessionId,
    messageId,
  };
  const scope = {
    groupId: open.shared.context.groupId,
    memberId: open.shared.context.memberId,
    installationId: open.shared.context.installationId,
    visibility: 'shared' as const,
    source,
    causalRefs: [],
  };
  const event = f.host.events.append(f.host.events.trustedHostScope(scope), {
    operationId: groupOperationIdSchema.parse(operationId),
    entityId: groupEntityIdSchema.parse(entityId),
    expectedRevision: 0,
    category: 'Question',
    condensedText: 'Human original retained on its source computer',
    original: { kind: 'inline', text: input.text },
    evidenceRefs: [],
    corrects: null,
  }).event;
  const port = await f.host.promotionContext(open.group.handle);
  const sourceId = await port.registerSource(source, operationId);
  const promotionReceiptId = `human:${input.handle}:${input.key}`;
  const promotionState = await f.host.promotion.retain({
    receiptId: promotionReceiptId,
    enrollmentHandle: open.group.handle,
    sourceId,
    scope: event.scope,
    kind: 'human',
    original: { kind: 'inline', text: input.text },
  });
  f.host.db.prepare('INSERT INTO gh_sends VALUES(?,?,?,?)').run(
    input.handle,
    input.key,
    publicationCanonical(input),
    JSON.stringify({
      messageId,
      operationId,
      entityId,
      runId,
      eventId: event.eventId,
      deliveryOperation: null,
      promotionReceiptId,
      promotionState,
      createdAt: new Date().toISOString(),
    }),
  );
  return promotionState;
}

it('normal action board retains authenticated instructions across lost response/restart and excludes private mutation', async () => {
  let lose = true;
  const http: typeof fetch = async (...args) => {
    const response = await fetch(...args);
    if (
      String(args[0]).endsWith('/actions') &&
      JSON.parse(String(args[1]?.body)).kind === 'instruction' &&
      lose
    ) {
      lose = false;
      throw new Error('Lost committed action response');
    }
    return response;
  };
  const a = await installation(undefined, { http });
  const { open } = await create(a, 'Actions normal journey');
  const command = {
    kind: 'instruction',
    operationId: randomUUID(),
    text: 'Preserve this exact shared instruction.',
  };
  expect((await a.post('actions', { handle: open.shared.handle, command }, false)).statusCode).toBe(
    401,
  );
  expect((await a.post('actions', { handle: open.private.handle, command })).statusCode).toBe(403);
  expect((await a.post('actions', { handle: open.shared.handle, command })).statusCode).toBe(503);
  await a.close();
  const resumed = await installation(a.directory, { http });
  const replay = await resumed.post('actions', { handle: open.shared.handle, command });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(groupActionResultSchema.parse(replay.json())).toMatchObject({
    ok: true,
    value: {
      kind: 'instruction',
      instruction: { text: command.text, actor: { memberId: open.member.memberId } },
    },
  });
  const board = await resumed.post('actions', {
    handle: open.shared.handle,
    command: { kind: 'board', after: 0, limit: 50 },
  });
  expect(board.json().value.board.instructions).toHaveLength(1);
  expect(
    (
      await resumed.post('actions', {
        handle: open.shared.handle,
        command: { ...command, text: 'Changed retry' },
      })
    ).json(),
  ).toMatchObject({ ok: false, error: 'conflict' });
  expect(proxyPath('POST', '/groups/actions')).toBe('/api/groups/actions');
});

it('shared work intent supplies a committed instruction and exact native task receipt; ordinary questions grant no action authority', async () => {
  let nativeContext: GroupContext | undefined;
  const factory: GroupNativeConnectorFactory = ({ events }) => ({
    availability: () => ({
      available: true,
      productionReady: true,
      authState: 'ready',
      message: 'Controlled native contract fixture',
    }),
    async submit(input) {
      if (input.intent === 'work') {
        const { sessionId, ...context } = input.context;
        nativeContext = events.createContext({
          ...context,
          provider: 'codex',
          nativeSessionId: randomUUID(),
        });
      }
      return { requestId: input.requestId, state: 'queued', message: 'Fixture retained' };
    },
    async inspect({ requestId }) {
      return { requestId, state: 'queued', message: 'Fixture retained' };
    },
  });
  const a = await installation(undefined, { nativeFactory: factory });
  const { open } = await create(a, 'Intent and owned task');
  const ask = await a.post('request-agent', {
    handle: open.shared.handle,
    key: randomUUID(),
    text: 'What is Bob doing?',
  });
  expect(ask.statusCode, ask.body).toBe(200);
  await expect(a.host.sharedGoalForRequest(ask.json().requestId)).rejects.toThrow(
    'explicit shared work',
  );
  const input = {
    handle: open.shared.handle,
    key: randomUUID(),
    text: 'Implement the requested change.',
    intent: 'work',
  };
  const work = await a.post('request-agent', input);
  expect(work.statusCode, work.body).toBe(200);
  const sharedGoalId = await a.host.sharedGoalForRequest(work.json().requestId);
  const receipt = {
    kind: 'group-owned-task' as const,
    taskId: randomUUID(),
    managerId: randomUUID(),
    sharedGoalId,
    title: 'Requested change',
  };
  const published = await a.host.publishOwnedTask(randomUUID(), receipt, nativeContext!);
  const command = {
    operationId: randomUUID(),
    ...receipt,
    origin: {
      kind: 'autonomous' as const,
      eventId: published.eventId,
      managerId: receipt.managerId,
      sharedGoalId,
    },
  };
  const { kind, ...registration } = command;
  const result = await (
    await a.host.actionContext(open.shared.handle)
  ).command({ ...registration, kind: 'register-work' });
  expect(result).toMatchObject({
    ok: true,
    value: { kind: 'work', work: { taskId: receipt.taskId, sharedGoalId } },
  });
  const forged = await (
    await a.host.actionContext(open.shared.handle)
  ).command({
    ...registration,
    kind: 'register-work',
    operationId: randomUUID(),
    taskId: randomUUID(),
  });
  expect(forged).toMatchObject({ ok: false, error: 'denied' });
  const source = await a.post('original', { handle: open.shared.handle, eventId: sharedGoalId });
  expect(source.json().text).toBe(input.text);
  const page = await a.post('feed', {
    handle: open.shared.handle,
    query: { visibility: 'shared', after: 0, cursor: null, limit: 20 },
  });
  expect(page.statusCode, page.body).toBe(200);
  expect(page.json().entries.map((event: { category: string }) => event.category)).toEqual([
    'Question',
    'Instruction',
    'Question',
    'Decision',
  ]);
  const catchup = await a.post('catchup/start', { handle: open.private.handle });
  expect(catchup.statusCode, catchup.body).toBe(200);
  expect(catchup.json().entries).toHaveLength(4);
  expect(catchup.json().sourceFacts).toHaveLength(4);
  expect((await a.post('catchup/start', { handle: open.shared.handle })).statusCode).toBe(409);
  const read = catchup.json();
  const acknowledgement = {
    handle: open.private.handle,
    snapshotId: read.snapshotId,
    pageId: read.pageId,
    acknowledgementId: read.acknowledgementId,
  };
  expect((await a.post('catchup/ack', acknowledgement)).statusCode).toBe(200);
  expect(proxyPath('POST', '/groups/catchup/start')).toBe('/api/groups/catchup/start');
  expect(proxyPath('POST', '/groups/evidence/query')).toBe('/api/groups/evidence/query');
  expect((await a.post('request-agent', { ...input, intent: 'ask' })).statusCode).toBe(409);
  expect(groupEventIdSchema.parse(published.eventId)).toBe(published.eventId);
  await a.close();
  const reopened = await installation(a.directory, { nativeFactory: factory });
  const next = await reopened.post('catchup/start', { handle: open.private.handle });
  expect(next.statusCode, next.body).toBe(200);
  expect(next.json().entries).toHaveLength(0);
  const replayAck = await reopened.post('catchup/ack', acknowledgement);
  expect(replayAck.statusCode, replayAck.body).toBe(200);
});
async function joinMember(
  a: Awaited<ReturnType<typeof installation>>,
  b: Awaited<ReturnType<typeof installation>>,
  handle: string,
) {
  const response = await a.post('invite', { handle, key: randomUUID() });
  expect(response.statusCode, response.body).toBe(200);
  const invitation = `http://invitation.invalid/#${response.json().fragment}`;
  const input = { key: randomUUID(), invitation, displayName: 'Li Ming' };
  const joined = await b.post('join', input);
  expect(joined.statusCode, joined.body).toBe(200);
  expect(joined.json().group.state).toBe('active');
  const concurrent = await Promise.all(
    Array.from({ length: 3 }, () => b.post('open', { handle: joined.json().group.handle })),
  );
  const opened = concurrent[0];
  expect(opened.statusCode, opened.body).toBe(200);
  for (const reply of concurrent) {
    expect(reply.statusCode, reply.body).toBe(200);
    expect(groupHostOpenSchema.parse(reply.json()).shared.context).toEqual(
      groupHostOpenSchema.parse(opened.json()).shared.context,
    );
    expect(groupHostOpenSchema.parse(reply.json()).private.context).toEqual(
      groupHostOpenSchema.parse(opened.json()).private.context,
    );
  }
  return { input, joined: joined.json(), open: groupHostOpenSchema.parse(opened.json()) };
}
it('one reusable invitation directly joins two hosts, retains rejoining identity and separates each private chat', async () => {
  const a = await installation(),
    b = await installation(),
    c = await installation();
  const { open } = await create(a, 'One link for the group');
  const invite = await a.post('invite', { handle: open.group.handle, key: randomUUID() });
  expect(invite.statusCode, invite.body).toBe(200);
  const invitation = `http://invitation.invalid/#${invite.json().fragment}`;
  const invalidPayload = JSON.parse(
    new URLSearchParams(invite.json().fragment.slice('/groups?'.length)).get('invite')!,
  );
  invalidPayload.secret = secret();
  const rejected = await b.post('join', {
    key: randomUUID(),
    invitation: `http://invitation.invalid/#/groups?invite=${encodeURIComponent(JSON.stringify(invalidPayload))}`,
    displayName: 'B',
  });
  expect(rejected.statusCode, rejected.body).toBe(403);
  const [first, repeated, second] = await Promise.all([
    b.post('join', { key: randomUUID(), invitation, displayName: 'B' }),
    b.post('join', { key: randomUUID(), invitation, displayName: 'B' }),
    c.post('join', { key: randomUUID(), invitation, displayName: 'C' }),
  ]);
  for (const joined of [first, repeated, second]) {
    expect(joined.statusCode, joined.body).toBe(200);
    expect(joined.json().group.state).toBe('active');
    expect(joined.json().group.id).toBe(open.group.id);
  }
  expect(repeated.json().group.handle).toBe(first.json().group.handle);
  expect((await b.host.list()).groups).toHaveLength(1);
  const bOpen = groupHostOpenSchema.parse(
    (await b.post('open', { handle: first.json().group.handle })).json(),
  );
  const cOpen = groupHostOpenSchema.parse(
    (await c.post('open', { handle: second.json().group.handle })).json(),
  );
  const members = [open, bOpen, cOpen];
  expect(new Set(members.map((member) => member.member.installationId)).size).toBe(3);
  expect(
    new Set(
      members.flatMap((member) => [
        member.shared.context.sessionId,
        member.private.context.sessionId,
      ]),
    ).size,
  ).toBe(6);
  for (const member of members) {
    expect(member.shared.context).toMatchObject({
      groupId: open.group.id,
      memberId: member.member.memberId,
      visibility: 'shared',
    });
    expect(member.private.context).toMatchObject({
      groupId: open.group.id,
      memberId: member.member.memberId,
      visibility: 'private',
    });
  }
  const roster = await a.post('open', { handle: open.group.handle });
  expect(roster.statusCode, roster.body).toBe(200);
  expect(roster.json().members).toHaveLength(3);
  expect((await a.post('pending', { handle: open.group.handle })).json().requests).toEqual([]);

  await selectFeedWriter(a, open.shared.handle);
  const privateTexts = ['PRIVATE-A-ONLY', 'PRIVATE-B-ONLY', 'PRIVATE-C-ONLY'];
  const sharedTexts = ['Shared from A', 'Shared from B', 'Shared from C'];
  const hosts = [a, b, c];
  for (const [index, current] of hosts.entries()) {
    const member = members[index];
    expect(
      (
        await current.post('send', {
          handle: member.private.handle,
          key: randomUUID(),
          text: privateTexts[index],
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await current.post('send', {
          handle: member.shared.handle,
          key: randomUUID(),
          text: sharedTexts[index],
        })
      ).statusCode,
    ).toBe(200);
  }
  await progressFeed(a);
  await a.host.promotion.pass(); // The writer processes one shared source per pass.
  for (const [index, current] of hosts.entries()) {
    const member = members[index];
    const feed = await current.post('feed', {
      handle: member.shared.handle,
      query: { visibility: 'shared', after: 0, cursor: null, limit: 20 },
    });
    expect(feed.statusCode, feed.body).toBe(200);
    const originals: string[] = [];
    for (const event of feed.json().entries) {
      const original = await current.post('original', {
        handle: member.shared.handle,
        eventId: event.eventId,
      });
      expect(original.statusCode, original.body).toBe(200);
      originals.push(original.json().text);
    }
    expect(originals.sort()).toEqual([...sharedTexts].sort());
    const privateChat = await current.post('chat', { handle: member.private.handle });
    expect(privateChat.statusCode, privateChat.body).toBe(200);
    expect(privateChat.json().detail.entries.map((entry: { text: string }) => entry.text)).toEqual([
      privateTexts[index],
    ]);
    for (const text of privateTexts) expect(feed.body).not.toContain(text);
    for (const text of privateTexts.filter((_, other) => other !== index))
      expect(privateChat.body).not.toContain(text);
  }
  expect((await b.post('chat', { handle: cOpen.private.handle })).statusCode).toBe(404);
  const directory = b.directory;
  await b.close();
  const resumed = await installation(directory);
  const rejoined = await resumed.post('join', { key: randomUUID(), invitation, displayName: 'B' });
  expect(rejoined.statusCode, rejoined.body).toBe(200);
  expect(rejoined.json().group.handle).toBe(bOpen.group.handle);
  const reopened = await resumed.post('open', { handle: bOpen.group.handle });
  expect(groupHostOpenSchema.parse(reopened.json()).private.context).toEqual(bOpen.private.context);
  expect((await resumed.host.list()).groups).toHaveLength(1);
}, 30000);
it('normal owner authentication, strict bounded intents and visible missing service/native setup', async () => {
  const f = await installation(undefined, { configured: false });
  const input = { key: randomUUID(), projectName: 'River', displayName: 'Amina' };
  expect((await f.post('create', input, false)).statusCode).toBe(401);
  const missing = await f.post('create', input);
  expect(missing.statusCode).toBe(503);
  expect(missing.json().code).toBe('GROUP_SETUP_REQUIRED');
  expect((await f.post('create', { ...input, cwd: '/private' })).statusCode).toBe(400);
  expect((await f.host.list()).native.available).toBe(false);
  expect(proxyPath('GET', '/groups')).toBe('/api/groups');
  expect(proxyPath('POST', '/groups/send')).toBe('/api/groups/send');
  expect(proxyPath('POST', '/groups/rpc')).toBeNull();
  expect(statSync(join(f.host.directory, 'host.sqlite')).mode & 0o077).toBe(0);
});
it('auth-only native readiness cannot admit a group execution request', async () => {
  let requests = 0;
  const f = await installation(undefined, {
    native: {
      availability: () => ({
        available: true,
        authState: 'ready',
        productionReady: false,
        message: 'Authentication checked; verified execution adapter still required.',
      }),
      submit: async () => {
        requests++;
        throw new Error('Auth-only connector must not execute');
      },
      inspect: async () => {
        throw new Error('No native request was admitted');
      },
    },
  });
  const { open } = await create(f, 'Auth-only');
  const result = await f.post('request-agent', {
    handle: open.shared.handle,
    key: randomUUID(),
    text: 'Question',
  });
  expect(result.statusCode).toBe(503);
  expect(result.json().code).toBe('GROUP_NATIVE_SETUP_REQUIRED');
  expect(requests).toBe(0);
});
it('protected hosted configuration routes approval only in server headers for all membership and delivery requests', async () => {
  const origin = 'https://owned-host.example.invalid',
    approval = secret(),
    freeApprovalId = randomUUID();
  const service = {
    version: 1 as const,
    mode: 'hosted' as const,
    endpoint: `${origin}/`,
    endpointId: randomUUID(),
    setupCapability: setup,
    hostingAuthorization: { origin, approvalCapability: approval, freeApprovalId },
  };
  expect(groupServiceConfigurationSchema.parse(service)).toEqual(service);
  for (const invalid of [
    { ...service, hostingAuthorization: undefined },
    { ...service, endpoint: endpoint },
    { ...service, endpoint: `${origin}/other` },
    { ...service, endpoint: `${origin}/?approval=${approval}` },
    {
      ...service,
      hostingAuthorization: {
        ...service.hostingAuthorization,
        origin: 'https://different.example.invalid',
      },
    },
    {
      ...service,
      hostingAuthorization: { ...service.hostingAuthorization, freeApprovalId: 'plan=Free' },
    },
  ])
    expect(groupServiceConfigurationSchema.safeParse(invalid).success).toBe(false);
  const kinds = new Set<string>();
  let networkCalls = 0;
  // A fixed test-only relay verifies the protected HTTPS intent/headers then
  // sends the same request to actual owned local workerd. TLS itself is covered
  // by the dependency's native HTTPS suite; this is not deployed service proof.
  const http: typeof fetch = async (...args) => {
    networkCalls++;
    const url = new URL(String(args[0]));
    expect(url.origin).toBe(origin);
    expect(url.search).toBe('');
    const headers = new Headers(args[1]?.headers);
    expect(headers.get('X-Hosting-Approval')).toBe(approval);
    expect(headers.get('Authorization')).toMatch(/^Bearer [a-f0-9]{64}$/);
    expect(args[1]?.redirect).toBe('error');
    expect(args[1]?.credentials).toBe('omit');
    const command = JSON.parse(String(args[1]?.body));
    kinds.add(command.kind);
    if (command.kind === 'invite') expect(command.ttlSeconds).toBe(7 * 24 * 60 * 60);
    headers.delete('X-Hosting-Approval');
    return fetch(`${endpoint.replace(/\/$/, '')}${url.pathname}`, { ...args[1], headers });
  };
  const a = await installation(undefined, { service, http }),
    b = await installation(undefined, {
      configured: false,
      http,
    });
  const { open } = await create(a, 'Protected hosted routing');
  expect((await b.host.list()).service.configured).toBe(false);
  const handoff = await a.host.invite({ handle: open.group.handle, key: randomUUID() });
  const invitation = `http://127.0.0.1:4330/#${handoff.fragment}`;
  const descriptor = JSON.parse(
    new URLSearchParams(handoff.fragment.slice('/groups?'.length)).get('invite')!,
  );
  expect(descriptor.service).toEqual({
    version: service.version,
    mode: service.mode,
    endpoint: service.endpoint,
    endpointId: service.endpointId,
    hostingAuthorization: service.hostingAuthorization,
  });
  expect(JSON.stringify(descriptor)).not.toContain(setup);
  const invitationFile = join(root, `invitation-${randomUUID()}.txt`);
  writeFileSync(invitationFile, invitation, { mode: 0o600 });
  const configure = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts/group-cloudflare-setup.mjs'), 'join', b.directory, invitationFile],
    { encoding: 'utf8' },
  );
  expect(configure.status, configure.stderr).toBe(0);
  expect(b.host.configuration()).not.toHaveProperty('setupCapability');
  expect((await b.host.list()).service.configured).toBe(true);
  const beforeRefused = networkCalls;
  expect(
    (await b.post('create', { key: randomUUID(), projectName: 'Refused', displayName: 'B' })).json()
      .code,
  ).toBe('GROUP_CREATOR_SETUP_REQUIRED');
  const changed = { ...descriptor, service: { ...descriptor.service, endpointId: randomUUID() } };
  const changedInvitation = `http://127.0.0.1:4330/#/groups?invite=${encodeURIComponent(JSON.stringify(changed))}`;
  expect(
    (await b.post('join', { key: randomUUID(), invitation: changedInvitation, displayName: 'B' }))
      .statusCode,
  ).toBe(400);
  expect(networkCalls).toBe(beforeRefused);
  const joined = await joinMember(a, b, open.group.handle);
  const input = {
    handle: open.shared.handle,
    key: randomUUID(),
    text: 'Actual local workerd result through configured hosted seam',
  };
  await selectFeedWriter(a, open.shared.handle);
  expect((await a.post('send', input)).json().delivery).toBe('complete');
  await progressFeed(a);
  const feed = await b.post('feed', {
    handle: joined.open.shared.handle,
    query: { visibility: 'shared', after: 0, limit: 8, cursor: null },
  });
  expect(feed.statusCode, feed.body).toBe(200);
  expect(
    (
      await b.post('original', {
        handle: joined.open.shared.handle,
        eventId: feed.json().entries[0].eventId,
      })
    ).json().text,
  ).toBe(input.text);
  for (const kind of [
    'initialize',
    'join',
    'status',
    'invite',
    'pending',
    'roster',
    'registerSource',
    'effect',
    'receipt',
    'feed',
    'expand',
  ])
    expect(kinds.has(kind), kind).toBe(true);
  expect(kinds.has('approve')).toBe(false);
  const visible = JSON.stringify(await a.host.list()) + JSON.stringify(open);
  for (const privateValue of [origin, approval, setup, freeApprovalId])
    expect(visible).not.toContain(privateValue);
  writeFileSync(
    join(a.host.directory, 'service.json'),
    JSON.stringify({
      ...service,
      hostingAuthorization: { ...service.hostingAuthorization, freeApprovalId: randomUUID() },
    }),
  );
  expect((await a.post('open', { handle: open.group.handle })).json().code).toBe(
    'GROUP_SERVICE_CHANGED',
  );
  writeFileSync(
    join(a.host.directory, 'service.json'),
    JSON.stringify({ version: 1, mode: 'disabled' }),
  );
  expect((await a.host.list()).service.configured).toBe(false);
  expect((await a.post('send', input)).json().code).toBe('GROUP_SETUP_REQUIRED');
});
it('typed hosted read failure has an actionable authenticated retry without exposing transport errors', async () => {
  let offline = true;
  const f = await installation(undefined, {
    http: async (...args) => {
      const response = await fetch(...args);
      if (offline && String(args[0]).endsWith('/delivery')) throw new Error('transport failure');
      return response;
    },
  });
  const { open } = await create(f, 'Read retry');
  const input = {
    handle: open.shared.handle,
    query: { visibility: 'shared', after: 0, limit: 8, cursor: null },
  };
  const failure = await f.post('feed', input);
  expect(failure.statusCode).toBe(503);
  expect(failure.json().code).toBe('GROUP_DELIVERY_UNAVAILABLE');
  expect(failure.json().error).toContain('retry the same request');
  expect(failure.body).not.toContain('transport failure');
  offline = false;
  const retry = await f.post('feed', input);
  expect(retry.statusCode, retry.body).toBe(200);
  expect(retry.json().entries).toEqual([]);
});
it('real workerd create/direct join, exact host mappings, private drafts and native denial survive host/workerd restart', async () => {
  const a = await installation(),
    b = await installation();
  const { input, open } = await create(a);
  const retry = await a.post('create', input);
  expect(groupHostOpenSchema.parse(retry.json()).shared.context).toEqual(open.shared.context);
  const joined = await joinMember(a, b, open.group.handle);
  expect(joined.open.group.id).toBe(open.group.id);
  expect(joined.open.member.memberId).not.toBe(open.member.memberId);
  const sharedDraft = {
    handle: open.shared.handle,
    key: randomUUID(),
    revision: 0,
    text: 'Shared draft',
  };
  const privateDraft = {
    handle: open.private.handle,
    key: randomUUID(),
    revision: 0,
    text: 'PRIVATE-DRAFT-CANARY',
  };
  expect((await a.post('draft', sharedDraft)).json()).toEqual({
    text: 'Shared draft',
    revision: 1,
  });
  expect((await a.post('draft', privateDraft)).json()).toEqual({
    text: privateDraft.text,
    revision: 1,
  });
  const privateSend = {
    handle: open.private.handle,
    key: randomUUID(),
    text: 'PRIVATE-MESSAGE-CANARY',
  };
  const saved = await a.post('send', privateSend);
  expect(saved.statusCode, saved.body).toBe(200);
  expect(groupHostReceiptSchema.parse(saved.json()).delivery).toMatch(/Private/);
  expect(
    (
      await a.post('request-agent', {
        handle: open.shared.handle,
        key: randomUUID(),
        text: 'Question only',
      })
    ).json().code,
  ).toBe('GROUP_NATIVE_SETUP_REQUIRED');
  expect(
    (
      await a.post('feed', {
        handle: open.private.handle,
        query: { visibility: 'shared', after: 0, limit: 8, cursor: null },
      })
    ).statusCode,
  ).toBe(403);
  const directory = a.directory;
  await a.close();
  await stopWorker();
  await startWorker();
  const recovered = await installation(directory);
  const reopened = await recovered.post('open', { handle: open.group.handle });
  expect(groupHostOpenSchema.parse(reopened.json()).shared.context).toEqual(open.shared.context);
  expect((await recovered.post('draft', privateDraft)).json()).toEqual({
    text: privateDraft.text,
    revision: 1,
  });
  expect((await recovered.post('send', privateSend)).json().runId).toBe(saved.json().runId);
  expect((await recovered.post('chat', { handle: open.shared.handle })).json().draft.text).toBe(
    'Shared draft',
  );
  expect(
    (await recovered.post('chat', { handle: open.private.handle })).json().detail.entries[0].text,
  ).toBe(privateSend.text);
  expect(
    (await recovered.post('draft', { ...sharedDraft, key: randomUUID(), text: 'stale' }))
      .statusCode,
  ).toBe(409);
}, 30000);
it('distinguishes another owner’s hosted service from a malformed invitation before any network or saved intent', async () => {
  const owned = (origin: string) => ({
    version: 1 as const,
    mode: 'hosted' as const,
    endpoint: `${origin}/`,
    endpointId: randomUUID(),
    setupCapability: secret(),
    hostingAuthorization: { origin, approvalCapability: secret(), freeApprovalId: randomUUID() },
  });
  const creatorService = owned('https://creator-groups.example.invalid');
  const recipientService = owned('https://recipient-groups.example.invalid');
  const http = vi.fn<typeof fetch>();
  const recipient = await installation(undefined, { service: recipientService, http });
  const configPath = join(recipient.host.directory, 'service.json');
  const originalConfig = readFileSync(configPath, 'utf8');
  const { setupCapability: _creatorCapability, ...service } = creatorService;
  const fragment = `/groups?invite=${encodeURIComponent(
    JSON.stringify({ groupId: randomUUID(), secret: secret(), name: 'Creator’s group', service }),
  )}`;
  const result = await recipient.post('join', {
    key: randomUUID(),
    invitation: `${creatorService.hostingAuthorization.origin}/join#${fragment}`,
    displayName: 'Recipient',
  });
  expect(result.statusCode).toBe(400);
  expect(result.json()).toMatchObject({
    code: 'INVALID_INVITATION',
    error:
      'This invitation belongs to another Groups service. Your existing groups are unchanged. Ask your setup agent to check the invitation’s service and your saved Groups configuration before continuing.',
  });
  const malformed = await recipient.post('join', {
    key: randomUUID(),
    invitation: `${creatorService.hostingAuthorization.origin}/join#/groups?invite=broken`,
    displayName: 'Recipient',
  });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.json().code).toBe('INVALID_INVITATION');
  expect(malformed.json().error).not.toContain('belongs to another Groups service');
  expect(http).not.toHaveBeenCalled();
  expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
  expect(recipient.host.configuration()).toEqual(recipientService);
  expect(recipient.host.db.prepare('SELECT count(*) n FROM gh_operations').get()?.n).toBe(0);
  expect((await recipient.host.list()).groups).toEqual([]);
});
it('lost create and join replies resume exact retained intents without invitation secrets in URL or browser authority', async () => {
  let lose = true;
  const http: typeof fetch = async (...args) => {
    const response = await fetch(...args);
    if (lose && String(args[0]).endsWith('/v1/create')) {
      lose = false;
      throw new Error('lost ack');
    }
    return response;
  };
  const a = await installation(undefined, { http });
  const input = { key: randomUUID(), projectName: 'Lost setup', displayName: 'Owner' };
  expect((await a.post('create', input)).statusCode).toBe(503);
  const resumed = await a.post('resume', { key: input.key, kind: 'create' });
  expect(resumed.statusCode, resumed.body).toBe(200);
  const open = await a.post('open', { handle: resumed.json().group.handle });
  expect(open.statusCode).toBe(200);
  const invite = await a.post('invite', { handle: resumed.json().group.handle, key: randomUUID() });
  const invitation = `http://example.invalid/#${invite.json().fragment}`;
  let loseJoin = true;
  const joinOperations: string[] = [];
  const joinHttp: typeof fetch = async (...args) => {
    const response = await fetch(...args);
    const body = JSON.parse((args[1]?.body as string) ?? '{}');
    if (body.kind === 'join') {
      joinOperations.push(body.operationId);
      if (loseJoin) {
        loseJoin = false;
        throw new Error('lost join ack');
      }
      // An exact legacy receipt can still contain the original pending
      // identity, while authenticated status now activates that enrollment.
      const legacy = (await response.json()) as { value: { identity: { state: string } } };
      legacy.value.identity.state = 'pending';
      return Response.json(legacy);
    }
    return response;
  };
  let b = await installation(undefined, { http: joinHttp });
  const key = randomUUID();
  expect((await b.post('join', { key, invitation, displayName: 'Member' })).statusCode).toBe(503);
  const directory = b.directory;
  await b.close();
  b = await installation(directory, { http: joinHttp });
  const reentered = await b.post('join', { key: randomUUID(), invitation, displayName: 'Member' });
  expect(reentered.statusCode, reentered.body).toBe(200);
  expect(reentered.json().group.state).toBe('active');
  const result = await b.post('resume', { key, kind: 'join' });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().group.state).toBe('active');
  expect(result.json().group.handle).toBe(reentered.json().group.handle);
  expect(joinOperations).toEqual([key, key]);
  expect((await b.host.list()).groups).toHaveLength(1);
  expect(
    (await a.post('open', { handle: resumed.json().group.handle })).json().members,
  ).toHaveLength(2);
  expect(
    (
      await b.post('join', {
        key: randomUUID(),
        displayName: 'Member',
        invitation: 'http://example.invalid/?secret=bad',
      })
    ).statusCode,
  ).toBe(400);
});
it('fails closed on unsafe config and changed endpoint mapping, preserving retained enrollment', async () => {
  const f = await installation();
  const { open } = await create(f);
  const path = join(f.host.directory, 'service.json');
  const original = readFileSync(path, 'utf8');
  chmodSync(path, 0o644);
  expect((await f.post('open', { handle: open.group.handle })).json().code).toBe(
    'GROUP_SERVICE_CHANGED',
  );
  chmodSync(path, 0o600);
  const changed = JSON.parse(original);
  changed.endpointId = randomUUID();
  writeFileSync(path, JSON.stringify(changed));
  expect((await f.post('open', { handle: open.group.handle })).json().code).toBe(
    'GROUP_SERVICE_CHANGED',
  );
  writeFileSync(path, original);
  expect((await f.post('open', { handle: open.group.handle })).statusCode).toBe(200);
});
it('acknowledged revocation denies saved feed/chat/draft/send retries across restart without changing IDs', async () => {
  const a = await installation(),
    b = await installation();
  const { open } = await create(a, 'Revoked group');
  const joined = await joinMember(a, b, open.group.handle);
  const draft = {
    handle: joined.open.private.handle,
    key: randomUUID(),
    revision: 0,
    text: 'PRIVATE-REVOKED-DRAFT',
  };
  expect((await b.post('draft', draft)).statusCode).toBe(200);
  const send = {
    handle: joined.open.private.handle,
    key: randomUUID(),
    text: 'PRIVATE-REVOKED-NOTE',
  };
  expect((await b.post('send', send)).statusCode).toBe(200);
  const feature = await b.host.authenticatedContext({ handle: joined.open.private.handle });
  expect(feature.context).toEqual(joined.open.private.context);
  expect(feature.enrollment.installationId).toBe(joined.open.member.installationId);
  expect(
    (await feature.readShared({ visibility: 'shared', after: 0, limit: 8, cursor: null })).entries,
  ).toHaveLength(0);
  await expect(b.host.authenticatedContext({ handle: randomUUID() })).rejects.toThrow(
    'Saved group context unavailable',
  );
  const revoke = {
    handle: open.group.handle,
    key: randomUUID(),
    requestId: joined.open.member.installationId,
  };
  expect((await a.post('revoke', revoke)).statusCode).toBe(200);
  const rejoin = await b.post('join', { ...joined.input, key: randomUUID() });
  expect(rejoin.statusCode, rejoin.body).toBe(403);
  expect(rejoin.json().code).toBe('GROUP_REVOKED');
  expect((await b.host.list()).groups).toHaveLength(1);
  await expect(feature.revalidate()).rejects.toMatchObject({ code: 'GROUP_REVOKED' });
  await expect(
    feature.readShared({ visibility: 'shared', after: 0, limit: 8, cursor: null }),
  ).rejects.toMatchObject({ code: 'GROUP_REVOKED' });
  const directory = b.directory;
  await b.close();
  const reloaded = await installation(directory);
  for (const [route, input] of [
    ['chat', { handle: joined.open.private.handle }],
    ['draft', draft],
    ['send', send],
    ['open', { handle: joined.open.group.handle }],
    [
      'feed',
      {
        handle: joined.open.shared.handle,
        query: { visibility: 'shared', after: 0, limit: 8, cursor: null },
      },
    ],
  ] as const) {
    const result = await reloaded.post(route, input);
    expect(result.statusCode, result.body).toBe(403);
    expect(result.json().code).toBe('GROUP_REVOKED');
  }
});
it('trusted enrollment import keeps exact identity and cannot resurrect or rebind it', async () => {
  const f = await installation();
  const { open } = await create(f, 'Exact enrollment');
  const identity = {
    groupId: open.member.groupId,
    memberId: open.member.memberId,
    installationId: open.member.installationId,
    displayName: open.member.displayName,
  };
  expect(f.host.events.trustedHostEnroll(identity)).toEqual(identity);
  expect(() => f.host.events.trustedHostEnroll({ ...identity, groupId: randomUUID() })).toThrow();
  f.host.events.revokeMember(open.member.groupId, open.member.memberId);
  expect(() => f.host.events.trustedHostEnroll(identity)).toThrow();
});
it('lost revoke reply reconciles only the saved exact revoke across host restart when reads are unavailable', async () => {
  let lose = true,
    blockReads = false;
  const operationIds: string[] = [];
  const http: typeof fetch = async (...args) => {
    const command = JSON.parse(String(args[1]?.body ?? '{}'));
    if (blockReads && command.kind === 'status')
      return Response.json({ ok: false, error: 'unavailable' }, { status: 503 });
    const response = await fetch(...args);
    if (command.kind === 'revoke') {
      operationIds.push(command.operationId);
      if (lose) {
        lose = false;
        blockReads = true;
        throw new Error('Lost successful revoke acknowledgement');
      }
    }
    return response;
  };
  const a = await installation(undefined, { http }),
    b = await installation();
  const { open } = await create(a, 'Lost revoke');
  const joined = await joinMember(a, b, open.group.handle);
  const input = {
    handle: open.group.handle,
    key: randomUUID(),
    requestId: joined.open.member.installationId,
  };
  expect((await a.post('revoke', input)).statusCode).toBe(503);
  const directory = a.directory;
  await a.close();
  const resumed = await installation(directory, { http });
  expect((await resumed.post('open', { handle: open.group.handle })).statusCode).toBe(503);
  expect((await resumed.post('revoke', { ...input, requestId: randomUUID() })).statusCode).toBe(
    409,
  );
  const result = await resumed.post('revoke', input);
  expect(result.statusCode, result.body).toBe(200);
  expect(operationIds).toEqual([input.key, input.key]);
  expect((await b.post('open', { handle: joined.open.group.handle })).statusCode).toBe(403);
});
it('same durable human context publishes multiple exact originals, reconciles lost commit acknowledgement across restart and excludes private/cross-group evidence', async () => {
  let loseCommit = true;
  const http: typeof fetch = async (...args) => {
    const response = await fetch(...args);
    const command = JSON.parse(String(args[1]?.body ?? '{}'));
    if (loseCommit && command.kind === 'effect' && command.packet.kind === 'commit') {
      loseCommit = false;
      throw new Error('Lost successful commit acknowledgement');
    }
    return response;
  };
  const a = await installation(undefined, { http }),
    b = await installation(),
    c = await installation();
  const { open } = await create(a, 'Human publication');
  const joined = await joinMember(a, b, open.group.handle);
  const other = await create(c, 'Other group');
  const firstInput = {
    handle: open.shared.handle,
    key: randomUUID(),
    text: '  Exact human original\nأمينة\t  ',
  };
  const first = await a.post('send', firstInput);
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().delivery).toBe('uncertain');
  const retained = () =>
    JSON.parse(
      String(
        a.host.db
          .prepare('SELECT body FROM gh_sends WHERE handle=? AND key=?')
          .get(firstInput.handle, firstInput.key)!.body,
      ),
    );
  const ids = retained();
  expect(ids.deliveryOperation).toBeTruthy();
  expect(ids.promotionReceiptId).toBeUndefined();
  expect((await a.post('send', { ...firstInput, text: 'changed' })).statusCode).toBe(409);
  const privateInput = {
    handle: open.private.handle,
    key: randomUUID(),
    text: 'PRIVATE-PUBLICATION-CANARY',
  };
  expect((await a.post('send', privateInput)).statusCode).toBe(200);
  const directory = a.directory;
  await a.close();
  await stopWorker();
  await startWorker();
  const resumed = await installation(directory);
  await new Promise((resolve) => setTimeout(resolve, 1100)); // retained publication backoff, then receipt-only reconciliation
  expect(
    (
      await resumed.post('status', { handle: firstInput.handle, key: firstInput.key, retry: true })
    ).json().delivery,
  ).toBe('complete');
  const same = await resumed.post('send', firstInput);
  expect(same.statusCode, same.body).toBe(200);
  expect(same.json().runId).toBe(first.json().runId);
  expect(
    JSON.parse(
      String(
        resumed.host.db
          .prepare('SELECT body FROM gh_sends WHERE handle=? AND key=?')
          .get(firstInput.handle, firstInput.key)!.body,
      ),
    ),
  ).toMatchObject({
    messageId: ids.messageId,
    operationId: ids.operationId,
    entityId: ids.entityId,
    runId: ids.runId,
    eventId: ids.eventId,
    deliveryOperation: ids.deliveryOperation,
  });
  expect(resumed.host.db.prepare('SELECT count(*) n FROM gh_promotion_projections').get()!.n).toBe(
    0,
  );
  const more = ['Second unchanged original 🧬', 'Third unchanged original e\u0301'];
  for (const text of more) {
    const result = await resumed.post('send', {
      handle: open.shared.handle,
      key: randomUUID(),
      text,
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().delivery).toBe('complete');
  }
  const memberText = 'Li Ming shared human original';
  expect(
    (
      await b.post('send', {
        handle: joined.open.shared.handle,
        key: randomUUID(),
        text: memberText,
      })
    ).json().delivery,
  ).toBe('complete');
  const query = { visibility: 'shared', after: 0, limit: 8, cursor: null };
  const response = await b.post('feed', { handle: joined.open.shared.handle, query });
  expect(response.statusCode, response.body).toBe(200);
  const events = response.json().entries;
  expect(events).toHaveLength(4);
  expect(new Set(events.map((e: { eventId: string }) => e.eventId)).size).toBe(4);
  const owned = events.filter(
    (e: { scope: { memberId: string } }) => e.scope.memberId === open.member.memberId,
  );
  expect(owned).toHaveLength(3);
  for (const event of owned) {
    expect(event.scope.source.sessionId).toBe(open.shared.context.sessionId);
    expect(event.scope.source.nativeSessionId).toBe(open.shared.context.nativeSessionId);
  }
  expect(
    new Set(
      owned.map((e: { scope: { source: { messageId: string } } }) => e.scope.source.messageId),
    ).size,
  ).toBe(3);
  const originals: string[] = [];
  for (const event of events) {
    const expanded = await b.post('original', {
      handle: joined.open.shared.handle,
      eventId: event.eventId,
    });
    expect(expanded.statusCode, expanded.body).toBe(200);
    originals.push(expanded.json().text);
  }
  expect(originals).toEqual([firstInput.text, ...more, memberText]);
  expect(response.body).not.toContain(privateInput.text);
  const excluded = await c.post('original', {
    handle: other.open.shared.handle,
    eventId: events[0].eventId,
  });
  expect(excluded.statusCode).toBe(503);
  expect(excluded.body).not.toContain(firstInput.text);
  expect(
    (await c.post('feed', { handle: other.open.shared.handle, query })).json().entries,
  ).toEqual([]);
  const privateOriginal = await resumed.post('original', {
    handle: open.private.handle,
    eventId: events[0].eventId,
  });
  expect(privateOriginal.statusCode).toBe(403);
  expect(
    (await resumed.post('chat', { handle: open.private.handle })).json().detail.entries[0].text,
  ).toBe(privateInput.text);
  expect((await resumed.post('open', { handle: open.group.handle })).json().shared.context).toEqual(
    open.shared.context,
  );
}, 30000);

function earlyPublicationClock(controller: GroupPublicationController, initial: number) {
  const clock = { now: initial, frozen: false, waits: [] as number[] };
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  vi.spyOn(controller.scheduling, 'now').mockImplementation(() => clock.now);
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay = 0,
    ...args: unknown[]
  ) => {
    if (delay > 0 && delay <= 1000) {
      clock.waits.push(delay);
      if (!clock.frozen) clock.now += delay > 1 ? delay - 1 : delay;
      return realSetTimeout(callback, 0, ...args);
    }
    return realSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  return clock;
}

it('explicit host delivery retry rechecks an early timer wake against the durable deadline', async () => {
  let controller!: GroupPublicationController, access!: PublicationAccess;
  const originalStep = GroupPublicationController.prototype.step;
  vi.spyOn(GroupPublicationController.prototype, 'step').mockImplementation(function (
    this: GroupPublicationController,
    ...args
  ) {
    controller = this;
    access = args[0];
    return originalStep.apply(this, args);
  });
  let loseCommit = true;
  const receiptTimes: number[] = [];
  const a = await installation(undefined, {
    http: async (...args) => {
      const command = JSON.parse(String(args[1]?.body ?? '{}'));
      if (command.kind === 'receipt') receiptTimes.push(Date.now());
      const response = await fetch(...args);
      if (loseCommit && command.kind === 'effect' && command.packet.kind === 'commit') {
        loseCommit = false;
        throw new Error('Lost successful commit acknowledgement');
      }
      return response;
    },
  });
  try {
    const { open } = await create(a, 'Early delivery timer');
    const input = {
      handle: open.shared.handle,
      key: randomUUID(),
      text: 'Exact retained original',
    };
    const sent = await a.post('send', input);
    expect(sent.json().delivery).toBe('uncertain');
    const body = JSON.parse(
      String(
        a.host.db
          .prepare('SELECT body FROM gh_sends WHERE handle=? AND key=?')
          .get(input.handle, input.key)!.body,
      ),
    );
    const scheduled = controller.inspect(access, body.deliveryOperation);
    const deadline = scheduled.nextAttemptAt!;
    const clock = earlyPublicationClock(controller, deadline - 1001);
    receiptTimes.length = 0;
    expect(
      (await a.post('status', { handle: input.handle, key: input.key, retry: true })).json()
        .delivery,
    ).toBe('uncertain');
    expect(clock.waits).toEqual([]);
    expect(receiptTimes).toEqual([]);
    expect(controller.inspect(access, body.deliveryOperation)).toEqual(scheduled);
    // A stalled/backward wall clock cannot turn this into an unbounded wait or
    // permit an early remote request. The same receipt stays explicitly retryable.
    clock.now = deadline - 20;
    clock.frozen = true;
    expect(
      (await a.post('status', { handle: input.handle, key: input.key, retry: true })).json()
        .delivery,
    ).toBe('uncertain');
    expect(clock.waits).toEqual([20, 20, 20]);
    expect(receiptTimes).toEqual([]);
    expect(controller.inspect(access, body.deliveryOperation)).toEqual(scheduled);
    clock.frozen = false;
    clock.waits.length = 0;
    const retry = await a.post('status', { handle: input.handle, key: input.key, retry: true });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().delivery).toBe('complete');
    expect(clock.waits).toEqual([20, 1]);
    expect(receiptTimes.length).toBeGreaterThan(0);
    expect(receiptTimes.every((time) => time >= deadline)).toBe(true);
    expect(controller.inspect(access, body.deliveryOperation).attempts).toBe(
      scheduled.attempts! + 1,
    );
    expect(
      JSON.parse(
        String(
          a.host.db
            .prepare('SELECT body FROM gh_sends WHERE handle=? AND key=?')
            .get(input.handle, input.key)!.body,
        ),
      ),
    ).toEqual(body);
  } finally {
    vi.restoreAllMocks();
  }
});

it('host publication drive reaches each saved deadline after early wakes without an early attempt', async () => {
  const a = await installation();
  const { open } = await create(a, 'Early normal delivery');
  let clock: ReturnType<typeof earlyPublicationClock> | undefined;
  const earlyAttempts: string[] = [];
  const originalStep = GroupPublicationController.prototype.step;
  vi.spyOn(GroupPublicationController.prototype, 'step').mockImplementation(function (
    this: GroupPublicationController,
    ...args
  ) {
    clock ??= earlyPublicationClock(this, Date.now());
    const scheduled = this.inspect(args[0], args[1]!);
    if (clock.now < (scheduled.nextAttemptAt ?? 0)) earlyAttempts.push(args[1]!);
    return originalStep.apply(this, args);
  });
  try {
    const response = await a.post('send', {
      handle: open.shared.handle,
      key: randomUUID(),
      text: 'One exact original despite early timers',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().delivery).toBe('complete');
    expect(clock!.waits.length).toBeGreaterThan(1);
    expect(clock!.waits).toContain(1);
    expect(earlyAttempts).toEqual([]);
  } finally {
    vi.restoreAllMocks();
  }
});

it('native result delivery retry waits for the exact receipt deadline without resubmitting the provider', async () => {
  let submits = 0,
    commitEffects = 0;
  const factory: GroupNativeConnectorFactory = ({ events }) => ({
    availability: () => ({
      available: true,
      productionReady: true,
      authState: 'ready',
      message: 'Controlled no-model fixture',
    }),
    async submit(input) {
      submits++;
      const { sessionId: _session, ...scope } = input.context;
      const context = events.createContext({
        ...scope,
        provider: 'codex',
        nativeSessionId: randomUUID(),
      });
      return {
        requestId: input.requestId,
        state: 'completed',
        message: 'Retained native result',
        result: {
          context,
          text: 'Exact controlled native result',
          nativeToolItems: 0,
          source: {
            sessionId: context.sessionId,
            provider: context.provider,
            nativeSessionId: context.nativeSessionId,
            messageId: randomUUID(),
          },
        },
      };
    },
    async inspect() {
      throw new Error('A retained final result must not need another provider inspection');
    },
  });
  let controller!: GroupPublicationController, access!: PublicationAccess;
  const originalStep = GroupPublicationController.prototype.step;
  vi.spyOn(GroupPublicationController.prototype, 'step').mockImplementation(function (
    this: GroupPublicationController,
    ...args
  ) {
    controller = this;
    access = args[0];
    return originalStep.apply(this, args);
  });
  const a = await installation(undefined, {
    nativeFactory: factory,
    http: async (...args) => {
      const command = JSON.parse(String(args[1]?.body ?? '{}'));
      const response = await fetch(...args);
      if (command.kind === 'effect' && command.packet.kind === 'commit' && ++commitEffects === 2)
        throw new Error('Lost native result commit acknowledgement');
      return response;
    },
  });
  try {
    const { open } = await create(a, 'Early native result retry');
    const input = { handle: open.shared.handle, key: randomUUID(), text: 'One native question' };
    const first = await a.post('request-agent', input);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().delivery).toBe('uncertain');
    const retained = a.host.nativeJournal.get(input.handle, input.key)!;
    const scheduled = controller.inspect(access, retained.receipt.deliveryOperation!);
    const clock = earlyPublicationClock(controller, scheduled.nextAttemptAt! - 20);
    const retried = await a.post('request-agent', input);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({
      requestId: retained.request.requestId,
      resultId: first.json().resultId,
      delivery: 'complete',
    });
    expect(clock.waits).toEqual([20, 1]);
    expect(submits).toBe(1);
    expect(commitEffects).toBe(2);
    expect(a.host.nativeJournal.get(input.handle, input.key)!.result).toEqual(retained.result);
    expect(controller.inspect(access, retained.receipt.deliveryOperation!).attempts).toBe(
      scheduled.attempts! + 1,
    );
  } finally {
    vi.restoreAllMocks();
  }
});

// Controlled host contract fixture: no provider/native process or acceptance
// readiness is proved here. The production factory has its own review/canaries.
it('delivers exact human messages and native question/reply between hosts without a feed writer, preserving retries and private results', async () => {
  let submits = 0;
  const snapshots = new Map<string, GroupNativeSnapshot>();
  const factory: GroupNativeConnectorFactory = ({ events }) => ({
    availability: () => ({
      available: true,
      productionReady: true,
      authState: 'ready',
      message: 'Controlled native result',
    }),
    async submit(input) {
      submits++;
      const { sessionId: _owner, ...scope } = input.context;
      const context = events.createContext({
        ...scope,
        provider: 'codex',
        nativeSessionId: randomUUID(),
      });
      const result: GroupNativeSnapshot = {
        requestId: input.requestId,
        state: 'completed',
        message: 'Native reply retained.',
        result: {
          context,
          text:
            context.visibility === 'shared'
              ? 'Exact native answer 🧬\nwith original spacing.  '
              : 'PRIVATE-ANSWER',
          nativeToolItems: 1,
          ...(context.visibility === 'shared'
            ? {
                source: {
                  sessionId: context.sessionId,
                  provider: context.provider,
                  nativeSessionId: context.nativeSessionId,
                  messageId: randomUUID(),
                },
              }
            : {}),
        },
      };
      snapshots.set(input.requestId, result);
      return result;
    },
    async inspect({ requestId }) {
      return snapshots.get(requestId)!;
    },
  });
  const a = await installation(undefined, { nativeFactory: factory });
  const { open } = await create(a, 'Direct shared originals');
  const b = await installation();
  const joined = await joinMember(a, b, open.group.handle);
  expect((await a.host.open({ handle: open.group.handle })).feedWriter?.enabled).toBe(false);
  const human = {
    handle: joined.open.shared.handle,
    key: randomUUID(),
    text: '  Exact human message e\u0301 🧬\n',
  };
  expect((await b.post('send', human)).json().delivery).toBe('complete');
  const request = { handle: open.shared.handle, key: randomUUID(), text: 'Shared agent question?' };
  const reply = await a.post('request-agent', request);
  expect(reply.statusCode, reply.body).toBe(200);
  expect(reply.json()).toMatchObject({ state: 'completed', delivery: 'complete' });
  const query = { visibility: 'shared', after: 0, limit: 20, cursor: null };
  const feed = await b.post('feed', { handle: joined.open.shared.handle, query });
  expect(feed.statusCode, feed.body).toBe(200);
  expect(feed.json().entries).toHaveLength(3);
  const originals = await Promise.all(
    feed
      .json()
      .entries.map(
        async (event: { eventId: string }) =>
          (
            await b.post('original', { handle: joined.open.shared.handle, eventId: event.eventId })
          ).json().text,
      ),
  );
  expect(originals).toEqual([
    human.text,
    request.text,
    'Exact native answer 🧬\nwith original spacing.  ',
  ]);
  const chat = await a.post('chat', { handle: open.shared.handle });
  expect(chat.body).toContain('Exact native answer');
  expect(
    chat.json().detail.entries.filter((entry: { text: string }) => entry.text === request.text),
  ).toHaveLength(1);
  const originalRecord = a.host.nativeJournal.get(request.handle, request.key)!;
  expect(originalRecord.receipt.deliveryOperation).toBeTruthy();
  expect(a.host.db.prepare('SELECT count(*) n FROM gh_promotion_inputs').get()!.n).toBe(0);
  await a.close();
  const restarted = await installation(a.directory, { nativeFactory: factory });
  const replay = await restarted.post('request-agent', request);
  expect(replay.json()).toEqual(reply.json());
  expect(submits).toBe(1);
  expect(restarted.host.nativeJournal.get(request.handle, request.key)!.receipt).toEqual(
    originalRecord.receipt,
  );
  await selectFeedWriter(restarted, open.shared.handle);
  await progressFeed(restarted);
  expect(
    (await b.post('feed', { handle: joined.open.shared.handle, query })).json().entries,
  ).toHaveLength(3);
  const privateReply = await restarted.post('request-agent', {
    handle: open.private.handle,
    key: randomUUID(),
    text: 'PRIVATE-QUESTION',
  });
  expect(privateReply.json()).toMatchObject({ state: 'completed', delivery: 'private' });
  expect((await b.post('feed', { handle: joined.open.shared.handle, query })).body).not.toContain(
    'PRIVATE',
  );
  expect(
    (await b.post('feed', { handle: joined.open.shared.handle, query })).json().entries,
  ).toHaveLength(3);
});

it.each([false, true])(
  'recovers an accepted legacy native result with summary already complete=%s without replay or duplicate shared events',
  async (summaryComplete) => {
    const a = await installation();
    const { open } = await create(a, 'Legacy native delivery');
    const b = await installation();
    const joined = await joinMember(a, b, open.group.handle);
    const request = {
      handle: open.shared.handle,
      key: randomUUID(),
      text: 'Original accepted shared question?',
    };
    let record = a.host.nativeJournal.prepare(request.handle, {
      key: request.key,
      text: request.text,
      context: open.shared.context,
      enrollmentHandle: open.group.handle,
    });
    const { sessionId: _owner, ...scope } = open.shared.context;
    const context = a.host.events.createContext({
      ...scope,
      provider: 'codex',
      nativeSessionId: randomUUID(),
    });
    const source = {
      sessionId: context.sessionId,
      provider: context.provider,
      nativeSessionId: context.nativeSessionId,
      messageId: randomUUID(),
    };
    const text = 'Exact accepted reply before delivery migration 🧬';
    record = a.host.nativeJournal.record(record, {
      requestId: record.request.requestId,
      state: 'completed',
      message: 'Native reply retained.',
      result: { context, source, text, nativeToolItems: 1 },
    });
    const access = a.host.events.trustedHostScope({
      groupId: context.groupId,
      memberId: context.memberId,
      installationId: context.installationId,
      visibility: 'shared',
      source,
      causalRefs: [],
    });
    const event = a.host.events.append(access, {
      operationId: groupOperationIdSchema.parse(record.ids.operationId),
      entityId: groupEntityIdSchema.parse(record.ids.entityId),
      expectedRevision: 0,
      category: 'Finding',
      condensedText: 'Verified native original retained on its source computer',
      original: { kind: 'inline', text },
      evidenceRefs: [],
      corrects: null,
    }).event;
    record = a.host.nativeJournal.mark(record, { eventId: event.eventId });
    const port = await a.host.promotionContext(open.group.handle);
    const sourceId = await port.registerSource(source, record.ids.operationId);
    const legacyId = `native:${record.request.requestId}`;
    expect(
      await a.host.promotion.retain({
        receiptId: legacyId,
        enrollmentHandle: open.group.handle,
        sourceId,
        scope: event.scope,
        kind: 'native',
        original: { kind: 'inline', text },
      }),
    ).toContain('pending');
    if (summaryComplete) {
      await selectFeedWriter(a, open.shared.handle);
      await progressFeed(a);
      expect(await a.host.promotion.status(legacyId)).toBe('complete');
    }
    await a.close();
    const resumed = await installation(a.directory);
    const recovered = await resumed.post('request-agent', request);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({
      requestId: record.request.requestId,
      state: 'completed',
      delivery: 'complete',
    });
    const current = resumed.host.nativeJournal.get(request.handle, request.key)!;
    expect(current.ids).toEqual(record.ids);
    expect(current.receipt.eventId).toBe(event.eventId);
    expect(!!current.receipt.deliveryOperation).toBe(!summaryComplete);
    await selectFeedWriter(resumed, open.shared.handle);
    await progressFeed(resumed);
    expect((await resumed.post('request-agent', request)).json()).toEqual(recovered.json());
    const query = { visibility: 'shared', after: 0, limit: 20, cursor: null };
    const feed = await b.post('feed', { handle: joined.open.shared.handle, query });
    expect(feed.statusCode, feed.body).toBe(200);
    expect(feed.json().entries).toHaveLength(2);
    const originals = await Promise.all(
      feed
        .json()
        .entries.map(
          async (e: { eventId: string }) =>
            (
              await b.post('original', { handle: joined.open.shared.handle, eventId: e.eventId })
            ).json().text,
        ),
    );
    expect(originals).toContain(text);
    expect(originals.filter((original) => original === text)).toHaveLength(1);
    expect(originals).toContain(request.text);
  },
);

it('native host retains exact lost-handoff/result identities, scoped originals and private exclusion across restart', async () => {
  let submits = 0,
    inspections = 0;
  const snapshots = new Map<string, GroupNativeSnapshot>();
  const sharedText = '  Verified adapter contract original 🧬\n' + 'é终🧬'.repeat(3000);
  const privateText = 'PRIVATE-NATIVE-CONTRACT-ORIGINAL';
  const factory: GroupNativeConnectorFactory = ({ events }) => ({
    availability: () => ({
      available: true,
      productionReady: true,
      authState: 'ready',
      message: 'Controlled host contract test only',
    }),
    async submit(input) {
      submits++;
      const { sessionId: ownerSession, ...scope } = input.context;
      const context = events.createContext({
        ...scope,
        provider: 'codex',
        nativeSessionId: randomUUID(),
      });
      const snapshot: GroupNativeSnapshot = {
        requestId: input.requestId,
        state: 'completed',
        message: 'Controlled retained receipt',
        result: {
          context,
          text: context.visibility === 'shared' ? sharedText : privateText,
          nativeToolItems: 7,
          ...(context.visibility === 'shared'
            ? {
                source: {
                  sessionId: context.sessionId,
                  provider: context.provider,
                  nativeSessionId: context.nativeSessionId,
                  messageId: randomUUID(),
                },
              }
            : {}),
        },
      };
      snapshots.set(input.requestId, snapshot);
      if (submits === 1) throw new Error('Lost native acknowledgement after retained result');
      return snapshot;
    },
    async inspect({ requestId }) {
      inspections++;
      return snapshots.get(requestId)!;
    },
  });
  const a = await installation(undefined, { nativeFactory: factory });
  const { open } = await create(a, 'Native host contract');
  const request = {
    handle: open.shared.handle,
    key: randomUUID(),
    text: 'Please inspect this shared question',
  };
  const lost = await a.post('request-agent', request);
  expect(lost.statusCode, lost.body).toBe(503);
  expect(lost.json().code).toBe('GROUP_NATIVE_RECEIPT_UNAVAILABLE');
  const retained = a.host.nativeJournal.get(request.handle, request.key)!;
  expect(retained.receipt.state).toBe('unknown');
  const requestId = retained.request.requestId;
  await a.close();
  const restarted = await installation(a.directory, { nativeFactory: factory });
  await selectFeedWriter(restarted, open.shared.handle);
  const pendingResult = await restarted.post('request-agent', request);
  expect(pendingResult.statusCode, pendingResult.body).toBe(200);
  await progressFeed(restarted);
  await restarted.host.promotion.status(`native:${requestId}`);
  const recovered = await restarted.post('request-agent', request);
  expect(recovered.statusCode, recovered.body).toBe(200);
  expect(recovered.json()).toMatchObject({
    key: request.key,
    requestId,
    state: 'completed',
    delivery: 'complete',
  });
  expect(submits).toBe(1);
  expect(inspections).toBe(1);
  const changed = await restarted.post('request-agent', {
    ...request,
    text: 'changed uncertain intent',
  });
  expect(changed.statusCode).toBe(409);
  expect(submits).toBe(1);
  const original = restarted.host.nativeJournal.get(request.handle, request.key)!;
  const feed = await restarted.post('feed', {
    handle: request.handle,
    query: { visibility: 'shared', after: 0, limit: 20, cursor: null },
  });
  expect(feed.statusCode, feed.body).toBe(200);
  expect(feed.json().entries).toHaveLength(2);
  const event = feed
    .json()
    .entries.find(
      (entry: { scope: { source: { provider: string } } }) =>
        entry.scope.source.provider === 'codex',
    );
  expect(event.scope.source).toEqual(snapshots.get(requestId)!.result!.source);
  expect(event.manifest.chunks.length).toBeGreaterThan(1);
  const expanded = await restarted.post('original', {
    handle: request.handle,
    eventId: event.eventId,
  });
  expect(expanded.statusCode, expanded.body).toBe(200);
  expect(expanded.json().text).toBe(sharedText);
  const privateRequest = {
    handle: open.private.handle,
    key: randomUUID(),
    text: 'Please inspect my private question',
  };
  const privateReply = await restarted.post('request-agent', privateRequest);
  expect(privateReply.statusCode, privateReply.body).toBe(200);
  expect(privateReply.json()).toMatchObject({ state: 'completed', delivery: 'private' });
  expect(privateReply.json()).not.toHaveProperty('source');
  const privateChat = await restarted.post('chat', { handle: open.private.handle });
  expect(privateChat.body).toContain(privateText);
  expect(privateChat.json().nativeRequests[0]).not.toHaveProperty('source');
  const sharedChat = await restarted.post('chat', { handle: request.handle });
  expect(sharedChat.body).not.toContain(privateText);
  expect(
    sharedChat.json().detail.entries.some((entry: { text: string }) => entry.text === sharedText),
  ).toBe(true);
  expect(
    (
      await restarted.post('feed', {
        handle: request.handle,
        query: { visibility: 'shared', after: 0, limit: 20, cursor: null },
      })
    ).json().entries,
  ).toHaveLength(2);
  await restarted.close();
  const again = await installation(a.directory, { nativeFactory: factory });
  const receipt = await again.post('request-agent', request);
  expect(receipt.statusCode, receipt.body).toBe(200);
  expect(receipt.json()).toEqual(recovered.json());
  expect(again.host.nativeJournal.get(request.handle, request.key)!.result).toEqual(
    original.result,
  );
  expect(submits).toBe(2); // one shared and one private; no restart resubmission
  expect((await again.post('request-agent', request, false)).statusCode).toBe(401);
});

it('native host refuses unrelated and unregistered result sources without sharing a reply', async () => {
  let submits = 0;
  const factory: GroupNativeConnectorFactory = ({ events }) => ({
    availability: () => ({
      available: true,
      productionReady: true,
      authState: 'ready',
      message: 'Controlled rejection test',
    }),
    async submit(input) {
      submits++;
      const { sessionId: ownerSession, ...scope } = input.context;
      const context = events.createContext({
        ...scope,
        provider: 'codex',
        nativeSessionId: randomUUID(),
      });
      return {
        requestId: input.requestId,
        state: 'completed',
        message: 'Invalid receipt fixture',
        result: {
          context,
          text: 'UNVERIFIED-NATIVE-RESULT',
          nativeToolItems: 0,
          source: {
            sessionId: randomUUID() as typeof context.sessionId,
            provider: context.provider,
            nativeSessionId: context.nativeSessionId,
            messageId: randomUUID(),
          },
        },
      };
    },
    async inspect({ requestId }) {
      return { requestId, state: 'unknown', message: 'Adapter receipt not verified' };
    },
  });
  const a = await installation(undefined, { nativeFactory: factory });
  const { open } = await create(a, 'Native rejection');
  const request = { handle: open.shared.handle, key: randomUUID(), text: 'Scoped question' };
  const reply = await a.post('request-agent', request);
  expect(reply.statusCode, reply.body).toBe(503);
  expect(reply.json().code).toBe('GROUP_NATIVE_RECEIPT_INVALID');
  expect(a.host.nativeJournal.get(request.handle, request.key)!.result).toBeNull();
  const chat = await a.post('chat', { handle: request.handle });
  expect(chat.statusCode, chat.body).toBe(200);
  expect(chat.body).not.toContain('UNVERIFIED-NATIVE-RESULT');
  expect(chat.json().nativeRequests[0].state).toBe('unknown');
  const feed = await a.post('feed', {
    handle: request.handle,
    query: { visibility: 'shared', after: 0, limit: 20, cursor: null },
  });
  expect(feed.json().entries).toHaveLength(1);
  expect(feed.json().entries[0].scope.source.provider).toBe('owner');
  expect(
    (
      await a.post('original', { handle: request.handle, eventId: feed.json().entries[0].eventId })
    ).json().text,
  ).toBe(request.text);
  await a.post('request-agent', request);
  expect(submits).toBe(1);
});

it('ordinary shared messages deliver while the designated writer is offline without a duplicate projection or model launch', async () => {
  const a = await installation();
  const { open } = await create(a, 'Cross-host promotion');
  const b = await installation();
  const member = await joinMember(a, b, open.group.handle);
  const selected = await a.post('feed-writer', { handle: open.shared.handle, key: randomUUID() });
  expect(selected.statusCode, selected.body).toBe(200);
  await a.close(); // Optional summarization cannot gate the producer's direct delivery.
  const input = {
    handle: member.open.shared.handle,
    key: randomUUID(),
    text: 'Decision: We will use the reviewed configuration.',
  };
  const sent = await b.post('send', input);
  expect(sent.statusCode, sent.body).toBe(200);
  expect(sent.json().delivery).toBe('complete');
  const query = { visibility: 'shared', after: 0, cursor: null, limit: 20 };
  const before = await b.post('feed', { handle: input.handle, query });
  expect(before.statusCode, before.body).toBe(200);
  expect(before.json().entries).toHaveLength(1);
  const resumed = await installation(a.directory);
  await resumed.host.promotion.pass();
  const page = await b.post('feed', { handle: input.handle, query });
  expect(page.statusCode, page.body).toBe(200);
  expect(
    page.json().entries,
    JSON.stringify(resumed.host.db.prepare('SELECT state FROM gh_promotion_writers').all()),
  ).toHaveLength(1);
  const event = page.json().entries[0];
  expect(event.condensedText).toBe(input.text);
  expect(event.scope.memberId).toBe(member.open.member.memberId);
  expect(event.scope.source.sessionId).toBe(member.open.shared.context.sessionId);
  expect(event).not.toHaveProperty('origin');
  expect(resumed.host.db.prepare('SELECT count(*) n FROM gh_promotion_projections').get()!.n).toBe(
    0,
  );
  const original = await b.post('original', { handle: input.handle, eventId: event.eventId });
  expect(original.json().text).toBe(input.text);
  expect((await b.post('status', { handle: input.handle, key: input.key })).json().delivery).toBe(
    'complete',
  );
  await resumed.host.promotion.pass();
  expect((await b.post('send', input)).statusCode).toBe(200);
  await resumed.host.promotion.pass();
  expect((await b.post('feed', { handle: input.handle, query })).json().entries).toHaveLength(1);
  expect(
    (await b.post('feed-writer', { handle: input.handle, key: randomUUID() })).statusCode,
  ).toBe(403);
});

it('chat follows direct receipts for writer and nonwriter sends across restart without promotion fanout', async () => {
  let promotionCalls = 0;
  const http: typeof fetch = async (...args) => {
    if (String(args[0]).endsWith('/promotion')) promotionCalls++;
    return fetch(...args);
  };
  const a = await installation(undefined, { http });
  const b = await installation(undefined, { http });
  const { open } = await create(a, 'Human delivery status');
  const member = await joinMember(a, b, open.group.handle);
  await selectFeedWriter(a, open.shared.handle);
  const writerSend = {
    handle: open.shared.handle,
    key: randomUUID(),
    text: 'Finding: The writer retained its exact result.',
  };
  const memberSend = {
    handle: member.open.shared.handle,
    key: randomUUID(),
    text: 'Finding: The other installation retained its exact result.',
  };
  expect((await a.post('send', writerSend)).statusCode).toBe(200);
  expect((await b.post('send', memberSend)).statusCode).toBe(200);
  expect((await a.post('chat', { handle: writerSend.handle })).json().deliveries).toEqual([
    expect.objectContaining({ key: writerSend.key, state: 'complete' }),
  ]);
  expect((await b.post('chat', { handle: memberSend.handle })).json().deliveries).toEqual([
    expect.objectContaining({ key: memberSend.key, state: 'complete' }),
  ]);

  // Optional writer passes cannot create a second event for direct chat sources.
  await progressFeed(a);
  await a.host.promotion.pass();
  await b.host.promotion.pass();
  const beforeChats = promotionCalls;
  for (const [f, input] of [
    [a, writerSend],
    [b, memberSend],
  ] as const) {
    const chat = await f.post('chat', { handle: input.handle });
    expect(chat.statusCode, chat.body).toBe(200);
    expect(chat.json().deliveries).toEqual([
      expect.objectContaining({ key: input.key, state: 'complete' }),
    ]);
  }
  expect(promotionCalls).toBe(beforeChats);

  const note = { handle: open.private.handle, key: randomUUID(), text: 'PRIVATE-STATUS-NOTE' };
  expect((await a.post('send', note)).statusCode).toBe(200);
  expect((await a.post('chat', { handle: note.handle })).json().deliveries).toEqual([
    expect.objectContaining({ key: note.key, state: 'private' }),
  ]);
  await a.close();
  await b.close();
  const resumedA = await installation(a.directory, { http });
  const resumedB = await installation(b.directory, { http });
  const beforeRestartChats = promotionCalls;
  for (const [f, input] of [
    [resumedA, writerSend],
    [resumedB, memberSend],
  ] as const) {
    expect((await f.post('chat', { handle: input.handle })).json().deliveries).toEqual([
      expect.objectContaining({ key: input.key, state: 'complete' }),
    ]);
    expect(f.host.db.prepare('SELECT count(*) n FROM gh_sends').get()!.n).toBe(
      f === resumedA ? 2 : 1,
    );
  }
  expect(promotionCalls).toBe(beforeRestartChats);
});

it('chat preserves a legacy promotion capacity refusal while new direct messages bypass that capacity', async () => {
  const a = await installation();
  const { open } = await create(a, 'Retained delivery capacity');
  const input = {
    handle: open.shared.handle,
    key: randomUUID(),
    text: 'Finding: Retain this result.',
  };
  const full = 'full: original retained; shared source capacity reached';
  const retain = vi.spyOn(a.host.promotion, 'retain').mockResolvedValue(full);
  try {
    expect(await legacyHuman(a, open, input)).toBe(full);
    expect(a.host.promotion.peek(`human:${input.handle}:${input.key}`)).toBe(
      'source_registration_pending',
    );
    expect((await a.post('chat', { handle: input.handle })).json().deliveries).toEqual([
      expect.objectContaining({ key: input.key, state: full }),
    ]);
    const fresh = { ...input, key: randomUUID(), text: 'New directly delivered message.' };
    expect((await a.post('send', fresh)).json().delivery).toBe('complete');
    expect(retain).toHaveBeenCalledTimes(1);
    expect((await a.post('chat', { handle: input.handle })).json().deliveries).toEqual([
      expect.objectContaining({ key: input.key, state: full }),
      expect.objectContaining({ key: fresh.key, state: 'complete' }),
    ]);
  } finally {
    retain.mockRestore();
  }
});

it('normal authenticated action confirmation dispatches through its original idle native owner without a manager model turn', async () => {
  let requestId = '';
  const f = await installation(undefined, {
    native: {
      availability: () => ({
        available: true,
        productionReady: true,
        authState: 'ready',
        message: 'Controlled native port, no provider.',
      }),
      submit: async (input) => {
        requestId = input.requestId;
        return { requestId, state: 'queued', message: 'Controlled native request.' };
      },
      inspect: async () => ({ requestId, state: 'queued', message: 'Controlled native request.' }),
    },
  });
  const { open } = await create(f, 'Normal owner dispatch');
  const { sessionId: _anchor, ...scope } = open.shared.context;
  const nativeContext = f.host.events.createContext({
    ...scope,
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
  const project = f.store.register(f.directory, 'Owned normal project', '');
  const manager = f.store.addAgent({
    projectId: project.id,
    parentId: null,
    taskId: null,
    name: 'Owned group manager',
    role: 'manager',
    cwd: f.directory,
    provider: 'codex',
  });
  f.store.updateAgent(manager.id, {
    model: 'demo',
    effort: 'high',
    toolPolicy: 'native',
    status: 'idle',
  });
  modelFixture(f.store);
  f.store.setSetting('pulsar:policy', { enabled: false });
  f.store.setSetting(`group:native-auth-agent:${manager.id}`, {
    contextId: nativeContext.sessionId,
  });
  let effects = 0;
  const coordination = new GroupFeatureCoordination(f.runtime, f.host, {
    identity: (context) => {
      expect(context).toEqual(nativeContext);
      return { managerId: manager.id, agentId: manager.id, requestId };
    },
    inspect: () => null,
    delegate: async () => {
      const active = f.store.runs(['running']).find((r) => r.agentId === manager.id);
      expect(f.runtime.quark.requireManagerLease(active).managerId).toBe(manager.id);
      effects++;
      return { workerId: randomUUID(), runId: randomUUID() };
    },
  });
  closers.push(() => coordination.close());
  const tools = coordination.tools(nativeContext);
  const invoke = async (name: string, input: Record<string, unknown>) => {
    const result = await tools
      .find((t) => t.name === name)!
      .invoke(input, {
        sessionId: nativeContext.sessionId,
        requestId: randomUUID(),
        signal: AbortSignal.timeout(5000),
      });
    return JSON.parse(result.content[0].text);
  };
  expect(
    (
      await f.post('request-agent', {
        handle: open.shared.handle,
        key: randomUUID(),
        text: 'Implement one bounded result.',
        intent: 'ask',
      })
    ).statusCode,
  ).toBe(200);
  await expect(
    invoke('dock_task_create', {
      title: 'Refused Ask',
      goal: 'No authority',
      acceptance: 'No effects',
    }),
  ).rejects.toThrow('explicit shared work');
  expect(f.store.tasks()).toHaveLength(0);
  expect(
    (
      await f.post('request-agent', {
        handle: open.shared.handle,
        key: randomUUID(),
        text: 'Implement one bounded result.',
        intent: 'work',
      })
    ).statusCode,
  ).toBe(200);
  const work = await f.runtime.withGroupCoordinationControl(manager.id, randomUUID(), () =>
    invoke('dock_task_create', {
      title: 'Bounded task',
      goal: 'One result',
      acceptance: 'Retain result',
    }),
  );
  const proposal = await f.runtime.withGroupCoordinationControl(manager.id, randomUUID(), () =>
    invoke('dock_delegate', {
      taskId: work.taskId,
      role: 'implementer',
      name: 'Owned worker',
      instruction: 'Produce one result',
    }),
  );
  expect(proposal.ok, JSON.stringify(proposal)).toBe(true);
  expect(proposal.value.kind).toBe('proposal');
  expect(effects).toBe(0);
  expect(f.store.runs(['running'])).toHaveLength(0);
  const command = {
    kind: 'confirm',
    operationId: randomUUID(),
    proposalId: proposal.value.proposal.proposalId,
    expectedRevision: proposal.value.proposal.observed.revision,
    override: false,
  };
  const response = await f.post('actions', { handle: open.shared.handle, command });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().value.action.outcome?.status, response.body).toBe('started');
  expect(response.json().value.action.state).toBe('completed');
  expect(effects).toBe(1);
  expect((await f.post('actions', { handle: open.shared.handle, command })).statusCode).toBe(200);
  await coordination.pass();
  expect(effects).toBe(1);
  expect(f.store.runs(['running'])).toHaveLength(0);
}, 20000);

it('a legacy committed cross-host summary keeps original attribution while its writer is offline after a lost commit acknowledgement', async () => {
  let lost = false;
  const http: typeof fetch = async (...args) => {
    const response = await fetch(...args);
    const command = JSON.parse(String(args[1]?.body ?? '{}'));
    if (command.kind === 'effect' && command.packet.kind === 'commit') {
      lost = true;
      throw new Error('Lost committed delivery acknowledgement');
    }
    return response;
  };
  const a = await installation(undefined, { http });
  const { open } = await create(a, 'Offline writer attribution');
  const b = await installation();
  const member = await joinMember(a, b, open.group.handle);
  await selectFeedWriter(a, open.shared.handle);
  const input = {
    handle: member.open.shared.handle,
    key: randomUUID(),
    text: 'Decision: Retain the original member identity during recovery.',
  };
  expect(await legacyHuman(b, member.open, input)).toContain('pending');
  await a.host.promotion.pass();
  expect(lost).toBe(true);
  const projection = a.host.db
    .prepare('SELECT source_json FROM gh_promotion_projections LIMIT 1')
    .get()!;
  const source = JSON.parse(String(projection.source_json));
  await a.close(); // No writer receipt reconciliation occurs before either reader below.
  const reader = await b.host.promotionContext(member.open.group.handle);
  expect(await reader.command({ kind: 'state', key: source.key })).toMatchObject({
    ok: true,
    value: { kind: 'status', state: 'complete' },
  });
  const feed = await b.post('feed', {
    handle: input.handle,
    query: { visibility: 'shared', after: 0, limit: 20, cursor: null },
  });
  expect(feed.statusCode, feed.body).toBe(200);
  expect(feed.json().entries).toHaveLength(1);
  const event = feed.json().entries[0];
  expect(event.origin).toMatchObject({
    key: source.key,
    scope: {
      memberId: member.open.member.memberId,
      installationId: member.open.member.installationId,
    },
    writerId: open.member.installationId,
    displayName: 'Li Ming',
  });
  expect(event.scope.memberId).toBe(open.member.memberId);
  const evidence = await b.host.sharedEvidenceHeader(member.open.group.handle, event.eventId);
  expect(evidence.origin).toEqual(event.origin);
  expect(
    (await b.post('original', { handle: input.handle, eventId: event.eventId })).json().text,
  ).toBe(input.text);
  // Revocation blocks the former member, but cannot relabel its retained shared original.
  const resumed = await installation(a.directory, { http });
  expect(
    (
      await resumed.post('revoke', {
        handle: open.group.handle,
        key: randomUUID(),
        requestId: member.open.member.installationId,
      })
    ).statusCode,
  ).toBe(200);
  const retained = await resumed.post('feed', {
    handle: open.shared.handle,
    query: { visibility: 'shared', after: 0, limit: 20, cursor: null },
  });
  expect(retained.statusCode, retained.body).toBe(200);
  expect(retained.json().entries[0].origin).toEqual(event.origin);
  expect(
    (
      await b.post('feed', {
        handle: input.handle,
        query: { visibility: 'shared', after: 0, limit: 20, cursor: null },
      })
    ).statusCode,
  ).toBe(403);
});

it('a legacy bound cross-host summary has no trusted attribution before delivery commits', async () => {
  const http: typeof fetch = async (...args) => {
    const command = JSON.parse(String(args[1]?.body ?? '{}'));
    if (command.kind === 'effect' && command.packet.kind === 'commit')
      throw new Error('Commit did not reach the service');
    return fetch(...args);
  };
  const a = await installation(undefined, { http });
  const { open } = await create(a, 'Uncommitted attribution');
  const b = await installation();
  const member = await joinMember(a, b, open.group.handle);
  await selectFeedWriter(a, open.shared.handle);
  expect(
    await legacyHuman(b, member.open, {
      handle: member.open.shared.handle,
      key: randomUUID(),
      text: 'Decision: This source is not committed yet.',
    }),
  ).toContain('pending');
  await a.host.promotion.pass();
  const projection = a.host.db
    .prepare('SELECT source_json FROM gh_promotion_projections LIMIT 1')
    .get()!;
  const original = String(projection.source_json),
    source = JSON.parse(original);
  const writer = await a.host.promotionContext(open.group.handle);
  const reserved = await writer.command({
    kind: 'command',
    command: {
      kind: 'reserve',
      identity: {
        key: source.key,
        sourceHash: createHash('sha256').update(original).digest('hex'),
      },
    },
  });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok || reserved.value.kind !== 'receipt') throw new Error('Expected bound receipt');
  const eventId = reserved.value.receipt.eventId;
  expect(eventId).not.toBeNull();
  const reader = await b.host.promotionContext(member.open.group.handle);
  expect(await reader.command({ kind: 'attribution', eventIds: [eventId!] })).toEqual({
    ok: true,
    value: { kind: 'attribution', entries: [] },
  });
});

it('polling historical report replies makes no document or additional membership requests until the exact saved report is opened', async () => {
  let requests = 0,
    describes = 0;
  let capture: 'retry' | 'pending' | 'unavailable' = 'retry';
  const http: typeof fetch = async (...args) => {
    requests++;
    return fetch(...args);
  };
  const f = await installation(undefined, { http });
  const { open } = await create(f, 'Report polling');
  const documents = new GroupFeatureDocuments(f.host, {
    documents: () => ({
      imageSourceDigest: '0'.repeat(64),
      describe: async () => {
        describes++;
        if (capture !== 'retry') throw new GroupDocumentCaptureError(capture);
        throw new Error('Private native diagnostic /private/canary');
      },
      export: async () => {
        throw new Error('No export permitted in this request-count check');
      },
      captureCompletedRequest: async () => null,
      captureCompletedResult: async () => null,
      close: async () => {},
    }),
  });
  closers.push(() => documents.close());
  requests = 0;
  expect((await f.post('chat', { handle: open.private.handle })).statusCode).toBe(200);
  const baseline = requests;
  const { sessionId: _anchor, ...scope } = open.private.context;
  const context = f.host.events.createContext({
    ...scope,
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
  let key = '';
  for (let i = 0; i < 20; i++) {
    key = randomUUID();
    const record = f.host.nativeJournal.prepare(open.private.handle, {
      key,
      text: `Report ${i}`,
      context: open.private.context,
      enrollmentHandle: open.group.handle,
      intent: 'ask',
    });
    f.host.nativeJournal.record(record, {
      requestId: record.request.requestId,
      state: 'completed',
      message: 'Controlled historical result',
      result: { context, text: `[Report ${i}](report-${i}.tex)`, nativeToolItems: 1 },
    });
  }
  for (let i = 0; i < 3; i++) {
    requests = 0;
    const chat = await f.post('chat', { handle: open.private.handle });
    expect(chat.statusCode, chat.body).toBe(200);
    expect(chat.json().nativeRequests).toHaveLength(20);
    expect(
      chat.json().nativeRequests.every((r: { documentAvailable: boolean }) => r.documentAvailable),
    ).toBe(true);
    expect(requests).toBe(baseline);
    expect(describes).toBe(0);
  }
  const retry = await f.post('document-offer', { handle: open.private.handle, key });
  expect(retry.statusCode).toBe(503);
  expect(retry.json().code).toBe('GROUP_DOCUMENT_OFFER_RETRY');
  expect(retry.body).not.toContain('canary');
  expect(describes).toBe(1);
  capture = 'pending';
  const pending = await f.post('document-offer', { handle: open.private.handle, key });
  expect(pending.statusCode).toBe(503);
  expect(pending.json().code).toBe('GROUP_DOCUMENT_CAPTURE_PENDING');
  capture = 'unavailable';
  const unavailable = await f.post('document-offer', { handle: open.private.handle, key });
  expect(unavailable.statusCode).toBe(409);
  expect(unavailable.json().code).toBe('GROUP_DOCUMENT_CAPTURE_UNAVAILABLE');
  expect(unavailable.json().error).toContain('explicitly request new Work');
  expect(unavailable.body).not.toContain('canary');
  expect((await f.post('document-offer', { handle: open.shared.handle, key })).statusCode).toBe(
    404,
  );
  expect(describes).toBe(3);
});

it.skipIf(!process.env.GROUP_DOCUMENT_COMPILER_FIXTURE)(
  'normal two-host shared report route serves the exact compiled PDF and Reading without exposing the private aside, including lost ACK, restart and revoke',
  async () => {
    const sourceRoot = process.env.GROUP_DOCUMENT_COMPILER_FIXTURE!;
    const publicSource = readFileSync(join(sourceRoot, 'report.tex')),
      chapter = readFileSync(join(sourceRoot, 'chapter.tex')),
      pdf = readFileSync(join(sourceRoot, 'report.pdf'));
    expect(createHash('sha256').update(pdf).digest('hex')).toBe(
      'da32b77d286054acecbd0294af7f4e8e4cb5ad49ec9a1ca99148b256636be536',
    );
    let manifest: import('@dock/shared/dist/group-documents.js').GroupDocumentManifest;
    const data = new Map<string, Buffer>();
    const native: ConstructorParameters<typeof GroupFeatureDocuments>[1] = {
      documents: () => ({
        imageSourceDigest: '0'.repeat(64),
        describe: async () => manifest,
        export: async (input) => ({
          state: 'completed',
          receiptId: input.key,
          sourceReceiptId: manifest.receiptId,
          version: groupDocumentVersion(manifest),
          files: input.artifactIds.map((artifactId) => ({
            artifactId,
            bytes: data.get(artifactId)!,
          })),
        }),
        build: async (input) => ({
          state: 'completed',
          receiptId: input.key,
          grantId: input.grantId,
          version: input.version,
          pdf,
        }),
        captureCompletedRequest: async () => null,
        captureCompletedResult: async () => null,
        close: async () => {},
      }),
    };
    let lose = false,
      capacityUnsupported = false;
    const a = await installation(undefined, {
      documents: native,
      http: async (url, options) => {
        if (
          capacityUnsupported &&
          String(url).endsWith('/documents') &&
          JSON.parse(String(options?.body)).kind === 'capacity'
        )
          return Response.json({ ok: false, error: 'invalid' });
        const response = await fetch(url, options);
        if (
          lose &&
          String(url).endsWith('/documents') &&
          JSON.parse(String(options?.body)).kind === 'commit'
        ) {
          lose = false;
          throw new Error('Lost report commit ACK after actual DO commit');
        }
        return response;
      },
    });
    const b = await installation(undefined, { documents: native });
    const { open } = await create(a, 'Shared report acceptance');
    const joined = await joinMember(a, b, open.group.handle);
    const { sessionId: _private, ...scope } = open.private.context;
    const context = a.host.events.createContext({
      ...scope,
      provider: 'codex',
      nativeSessionId: randomUUID(),
    });
    const key = randomUUID(),
      record = a.host.nativeJournal.prepare(open.private.handle, {
        key,
        text: 'Write the report in this private aside',
        context: open.private.context,
        enrollmentHandle: open.group.handle,
        intent: 'work',
      });
    a.host.nativeJournal.record(record, {
      requestId: record.request.requestId,
      state: 'completed',
      message: 'Controlled native export of already-compiled public fixture',
      result: { context, text: '[Report](report.tex)', nativeToolItems: 1 },
    });
    const files = [
      ['report.tex', publicSource],
      ['chapter.tex', chapter],
      ['private-aside.txt', Buffer.from('Private aside never shared')],
    ] as const;
    manifest = {
      receiptId: randomUUID(),
      requestId: record.request.requestId,
      resultId: record.ids.resultId,
      context: open.private.context,
      nativeContext: context,
      source: {
        sessionId: context.sessionId,
        provider: context.provider,
        nativeSessionId: context.nativeSessionId,
        messageId: randomUUID(),
      },
      files: files.map(([name, bytes]) => {
        const artifactId = randomUUID();
        data.set(artifactId, bytes);
        return {
          artifactId,
          name,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }),
    };
    const offered = await a.post('document-offer', { handle: open.private.handle, key });
    expect(offered.statusCode, offered.body).toBe(200);
    const offer = offered.json();
    const grant = await a.post(`documents/${open.private.handle}/grants`, {
      key: randomUUID(),
      offer: offer.handle,
      entry: offer.files.find((file: { name: string }) => file.name === 'report.tex').handle,
      dependencies: [
        offer.files.find((file: { name: string }) => file.name === 'chapter.tex').handle,
      ],
    });
    expect(grant.statusCode, grant.body).toBe(200);
    const local = grant.json();
    const localBase = `documents/${open.private.handle}/${local.grantId}/${local.version}`;
    expect((await a.post(`${localBase}/build`, { key: randomUUID() })).statusCode).toBe(200);
    expect(
      (await b.post('reports', { handle: joined.open.shared.handle })).json().entries,
    ).toHaveLength(0);
    const publication = { key: randomUUID(), sharedHandle: open.shared.handle };
    const beforePreflight = a.host.db
      .prepare('SELECT count(*) n FROM gh_document_publications')
      .get()!.n;
    capacityUnsupported = true;
    const legacy = await a.post(`${localBase}/preflight`, { sharedHandle: open.shared.handle });
    expect(legacy.statusCode, legacy.body).toBe(409);
    expect(legacy.json().code).toBe('GROUP_REPORT_HOSTING_UPDATE');
    expect((await a.post(`${localBase}/publish`, publication)).statusCode).toBe(409);
    expect(a.host.db.prepare('SELECT count(*) n FROM gh_document_publications').get()!.n).toBe(
      beforePreflight,
    );
    capacityUnsupported = false;
    const advisory = await a.post(`${localBase}/preflight`, { sharedHandle: open.shared.handle });
    expect(advisory.statusCode, advisory.body).toBe(200);
    expect(advisory.json()).toMatchObject({
      kind: 'capacity',
      fits: true,
      reason: 'available',
      pending: 0,
    });
    expect(a.host.db.prepare('SELECT count(*) n FROM gh_document_publications').get()!.n).toBe(
      beforePreflight,
    );
    expect(
      (await b.post(`${localBase}/preflight`, { sharedHandle: joined.open.shared.handle }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await a.post('local-mode', {
          handle: open.group.handle,
          key: randomUUID(),
          revision: 0,
          mode: 'read-only',
        })
      ).statusCode,
    ).toBe(200);
    expect((await a.post(`${localBase}/publish`, publication)).json().code).toBe(
      'GROUP_LOCAL_READ_ONLY',
    );
    expect(a.host.db.prepare('SELECT count(*) n FROM gh_document_publications').get()!.n).toBe(
      beforePreflight,
    );
    expect(
      (
        await a.post('local-mode', {
          handle: open.group.handle,
          key: randomUUID(),
          revision: 1,
          mode: 'contribute',
        })
      ).statusCode,
    ).toBe(200);
    lose = true;
    expect((await a.post(`${localBase}/publish`, publication)).statusCode).toBe(503);
    expect(
      (
        await a.post('local-mode', {
          handle: open.group.handle,
          key: randomUUID(),
          revision: 2,
          mode: 'read-only',
        })
      ).statusCode,
    ).toBe(200);
    capacityUnsupported = true;
    const shared = await a.post(`${localBase}/publish`, publication);
    expect(shared.statusCode, shared.body).toBe(200);
    capacityUnsupported = false;
    const link = shared.json();
    expect(link.href).toMatch(/^#\/groups\/report\//);
    const reports = await b.post('reports', { handle: joined.open.shared.handle });
    expect(reports.statusCode, reports.body).toBe(200);
    expect(reports.json().entries).toHaveLength(1);
    const remote = reports.json().entries[0];
    expect(remote.manifest.owner).toEqual(open.shared.context);
    expect(JSON.stringify(remote)).not.toContain(open.private.context.sessionId);
    expect(remote.manifest.files.map((file: { name: string }) => file.name)).not.toContain(
      'private-aside.txt',
    );
    const base = `reports/${joined.open.shared.handle}/${link.grantId}/${link.version}`;
    expect((await b.get(base, false)).statusCode).toBe(401);
    expect(
      (await b.get(`documents/${joined.open.shared.handle}/${local.grantId}/${local.version}`))
        .statusCode,
    ).toBe(403);
    expect((await b.get(base)).json()).toMatchObject({ hasPdf: true, name: 'report.tex' });
    const copied = await b.get(`${base}/pdf`);
    expect(copied.statusCode, copied.body).toBe(200);
    expect(copied.rawPayload.equals(pdf)).toBe(true);
    const cache = new DatabaseSync(join(b.host.directory, 'shared-report-cache.sqlite'));
    const occupied = Number(
      cache.prepare('SELECT sum(length(body)) AS n FROM report_files').get()!.n,
    );
    cache
      .prepare('INSERT INTO report_files VALUES(?,?,?,?,zeroblob(?))')
      .run(randomUUID(), '0'.repeat(64), randomUUID(), '0'.repeat(64), 32 * 1024 ** 2 - occupied);
    const reading = await b.get(`${base}/reading`);
    expect(reading.statusCode, reading.body).toBe(200);
    expect(reading.json().available).toBe(true);
    expect(JSON.stringify(reading.json())).toContain('approved');
    expect(cache.prepare('SELECT count(*) AS n FROM report_reading').get()!.n).toBe(1);
    expect(
      Number(cache.prepare('SELECT coalesce(sum(length(body)),0) AS n FROM report_files').get()!.n),
    ).toBe(0);
    cache.exec('DELETE FROM report_reading; DELETE FROM report_assets;');
    // A still-open Reading image request rebuilds an evicted family under current
    // remote authorization; an image absent from this actual source stays absent.
    expect((await b.get(`${base}/assets/${'0'.repeat(64)}.png`)).statusCode).toBe(404);
    expect(cache.prepare('SELECT count(*) AS n FROM report_reading').get()!.n).toBe(1);
    cache.close();
    expect(
      (await b.get(`reports/${joined.open.private.handle}/${link.grantId}/${link.version}/pdf`))
        .statusCode,
    ).not.toBe(200);
    await b.close();
    const reopened = await installation(b.directory, { documents: native });
    expect((await reopened.get(`${base}/pdf`)).rawPayload.equals(pdf)).toBe(true);
    expect((await a.post(`${localBase}/revoke`, { key: randomUUID() })).statusCode).toBe(200);
    expect((await reopened.get(`${base}/pdf`)).statusCode).toBe(403);
    expect(proxyPath('GET', `/groups/${base}/pdf`)).toBe(`/api/groups/${base}/pdf`);
    expect(proxyPath('POST', `/groups/${localBase}/publish`)).toBe(
      `/api/groups/${localBase}/publish`,
    );
  },
  30000,
);

it('protected creator export retries a changed snapshot through the normal host route and verifies the private archive after restart', async () => {
  const calls: string[] = [];
  let exporting = false,
    change = true;
  const a = await installation(undefined, {
    http: async (...args) => {
      if (exporting) {
        calls.push(String(args[0]));
        if (change) {
          change = false;
          return Response.json({ ok: false, error: 'changed' });
        }
      }
      return fetch(...args);
    },
  });
  const b = await installation();
  const { open } = await create(a, 'Private creator archive');
  const joined = await joinMember(a, b, open.group.handle);
  const input = { handle: open.group.handle, key: randomUUID() };
  const instruction = await a.post('actions', {
    handle: open.shared.handle,
    command: { kind: 'instruction', operationId: randomUUID(), text: 'Retain this exact receipt.' },
  });
  expect(instruction.statusCode, instruction.body).toBe(200);
  expect((await a.post('hosted-export', input, false)).statusCode).toBe(401);
  expect(
    (await b.post('hosted-export', { handle: joined.open.group.handle, key: randomUUID() }))
      .statusCode,
  ).toBe(403);
  expect((await a.post('hosted-export', { ...input, path: '/tmp/arbitrary' })).statusCode).not.toBe(
    200,
  );
  exporting = true;
  const failed = await a.post('hosted-export', input);
  expect(failed.statusCode).toBe(503);
  expect(failed.json().error).toMatch(/quiet window/);
  const original = a.host.exportHostedArchive.bind(a.host);
  a.host.exportHostedArchive = async (raw) => {
    await original(raw);
    throw new GroupHostError(
      503,
      'FIXTURE_LOST_APP_ACK',
      'Lost app response after verified archive commit.',
    );
  };
  const lost = await a.post('hosted-export', input);
  expect(lost.statusCode).toBe(503);
  const intent = a.host.db
    .prepare('SELECT body FROM gh_operations WHERE key=?')
    .get(`hosted-export:${input.key}`)!;
  const archiveId = JSON.parse(String(intent.body)).archiveId as string;
  const saved = verifyHostedArchive(join(a.directory, 'groups'), archiveId);
  expect(saved.groupId).toBe(open.shared.context.groupId);
  expect(calls.length).toBeGreaterThan(2);
  expect(calls.every((url) => url.endsWith('/export'))).toBe(true);
  await a.close();
  let reconciled = 0;
  const resumed = await installation(a.directory, {
    http: async (...args) => {
      reconciled++;
      return fetch(...args);
    },
  });
  const response = await resumed.post('hosted-export', input);
  expect(response.statusCode, response.body).toBe(200);
  expect(groupExportArchiveSchema.parse(response.json())).toEqual(saved);
  expect(reconciled).toBe(1); // Fresh current creator proof, no second full export.
  expect(readdirSync(join(a.directory, 'groups', 'hosted-archives'))).toEqual([archiveId]);
  expect(response.body).not.toContain(setup);
  expect(verifyHostedArchive(join(a.directory, 'groups'), saved.archiveId)).toEqual(saved);
  const other = await create(resumed, 'Different archive scope');
  expect(
    (await resumed.post('hosted-export', { ...input, handle: other.open.group.handle })).statusCode,
  ).toBe(409);
  expect(verifyHostedArchive(join(a.directory, 'groups'), archiveId)).toEqual(saved);
  const archived = readFileSync(
    join(a.directory, 'groups', 'hosted-archives', saved.archiveId, 'archive.jsonl'),
    'utf8',
  );
  expect(archived).toContain('Retain this exact receipt.');
  // Persisted state at process death: an exact intent and first page exist,
  // but no complete footer/receipt was acknowledged.
  const interrupted = { handle: input.handle, key: randomUUID() },
    partialId = randomUUID();
  const stored = resumed.host.db
    .prepare('SELECT body FROM gh_groups WHERE handle=?')
    .get(input.handle)!;
  const mapping = JSON.parse(String(stored.body)).serviceHash as string;
  resumed.host.db
    .prepare('INSERT INTO gh_operations VALUES(?,?,?)')
    .run(
      `hosted-export:${interrupted.key}`,
      publicationCanonical({ handle: input.handle, groupId: saved.groupId, serviceHash: mapping }),
      JSON.stringify({ archiveId: partialId, receipt: null }),
    );
  const partialDirectory = join(a.directory, 'groups', 'hosted-archives', partialId);
  mkdirSync(partialDirectory, { mode: 0o700 });
  const partial = archived.split('\n')[0] + '\n';
  writeFileSync(join(partialDirectory, 'archive.jsonl'), partial, { mode: 0o600 });
  const held = await resumed.post('hosted-export', interrupted);
  expect(held.json()).toMatchObject({ code: 'GROUP_EXPORT_HELD' });
  expect(readFileSync(join(partialDirectory, 'archive.jsonl'), 'utf8')).toBe(partial);
  const fresh = await resumed.post('hosted-export', { handle: input.handle, key: randomUUID() });
  expect(fresh.statusCode, fresh.body).toBe(200);
  expect(fresh.json().archiveId).not.toBe(partialId);
  expect(readFileSync(join(partialDirectory, 'archive.jsonl'), 'utf8')).toBe(partial);
  expect(verifyHostedArchive(join(a.directory, 'groups'), archiveId)).toEqual(saved);
  const moved = join(a.directory, 'preserved-verified-archive.jsonl');
  renameSync(join(a.directory, 'groups', 'hosted-archives', archiveId, 'archive.jsonl'), moved);
  expect((await resumed.post('hosted-export', input)).json()).toMatchObject({
    code: 'GROUP_EXPORT_HELD',
  });
  const afterMoved = await resumed.post('hosted-export', {
    handle: input.handle,
    key: randomUUID(),
  });
  expect(afterMoved.statusCode, afterMoved.body).toBe(200);
  expect(afterMoved.json().archiveId).not.toBe(archiveId);
  expect(readFileSync(moved, 'utf8')).toBe(archived);
  expect(readdirSync(join(a.directory, 'groups', 'hosted-archives', archiveId))).toEqual([]);
  const empty = { handle: input.handle, key: randomUUID() },
    emptyId = randomUUID();
  resumed.host.db
    .prepare('INSERT INTO gh_operations VALUES(?,?,?)')
    .run(
      `hosted-export:${empty.key}`,
      publicationCanonical({ handle: input.handle, groupId: saved.groupId, serviceHash: mapping }),
      JSON.stringify({ archiveId: emptyId, receipt: null }),
    );
  const emptyDirectory = join(a.directory, 'groups', 'hosted-archives', emptyId);
  mkdirSync(emptyDirectory, { mode: 0o700 });
  expect((await resumed.post('hosted-export', empty)).json()).toMatchObject({
    code: 'GROUP_EXPORT_HELD',
  });
  const afterEmpty = await resumed.post('hosted-export', {
    handle: input.handle,
    key: randomUUID(),
  });
  expect(afterEmpty.statusCode, afterEmpty.body).toBe(200);
  expect(afterEmpty.json().archiveId).not.toBe(emptyId);
  expect(readdirSync(emptyDirectory)).toEqual([]);
  expect(readFileSync(moved, 'utf8')).toBe(archived);
  expect(proxyPath('POST', '/groups/hosted-export')).toBe('/api/groups/hosted-export');
}, 30000);

it('native activity delivers exact producer originals once through hosted receipts and the member feed lane after a lost acknowledgement', async () => {
  let nativeContext: GroupContext | undefined;
  const nativeFactory: GroupNativeConnectorFactory = ({ events }) => ({
    availability: () => ({
      available: true,
      productionReady: true,
      authState: 'ready',
      message: 'Controlled native producer, no provider.',
    }),
    submit: async (input) => {
      const { sessionId: _session, ...scope } = input.context;
      nativeContext = events.createContext({
        ...scope,
        provider: 'codex',
        nativeSessionId: randomUUID(),
      });
      return { requestId: input.requestId, state: 'queued', message: 'Controlled request.' };
    },
    inspect: async ({ requestId }) => ({
      requestId,
      state: 'queued',
      message: 'Controlled request.',
    }),
  });
  const f = await installation(undefined, { nativeFactory }),
    { open } = await create(f, 'Native activity');
  const response = await f.post('request-agent', {
    handle: open.shared.handle,
    key: randomUUID(),
    text: 'Perform this shared bounded work.',
    intent: 'work',
  });
  expect(response.statusCode, response.body).toBe(200);
  const requestId = response.json().requestId as string,
    feature = await f.host.nativeFeatureContext(nativeContext!),
    project = f.store.register(f.directory, 'Producer', ''),
    manager = f.store.agent(project.managerId),
    run = f.store.enqueue(manager.id, requestId, 'Exact shared Work');
  f.store.setSetting(`group:host-native-agent:${manager.id}`, {
    context: nativeContext,
    anchor: open.shared.context,
    enrollmentHandle: feature.enrollmentHandle,
  });
  f.store.setSetting(`group:host-native-run:${run.id}`, {
    context: nativeContext,
    requestId,
    intent: 'work',
  });
  const memberFeed = new GroupMemberFeed(
    f.runtime,
    f.directory,
    {
      resolveLocalContext: () => {
        throw new Error('No model source resolution in this fixture.');
      },
      registerHelper: () => {
        throw new Error('No model helper in this fixture.');
      },
    },
    {
      source: async () => {
        throw new Error('No model pass in this fixture.');
      },
      publish: async () => {
        throw new Error('No summary publication in this fixture.');
      },
    },
  );
  f.host.memberFeedOriginal = (input) => memberFeed.retain(input);
  captureGroupRunTransition(f.store, run.id, `run:${run.id}:queued`);
  let lost = false;
  const activity = new GroupHostNativeActivity(f.store, {
    sharedGoalForRequest: (id) => f.host.sharedGoalForRequest(id),
    publishNativeActivity: async (enrollment, receipt) => {
      const published = await f.host.publishNativeActivity(enrollment, receipt);
      if (!lost) {
        lost = true;
        throw new Error('Lost acknowledgement after hosted commit.');
      }
      return published;
    },
  });
  const unregisterActivity = registerGroupHostActivity(f.host, activity);
  try {
    await activity.pass();
    expect(lost).toBe(true);
    expect(
      f.store.db.prepare('SELECT state FROM group_native_activity_delivery').get()!.state,
    ).toBe('pending');
    await activity.pass();
    expect(
      f.store.db.prepare('SELECT state FROM group_native_activity_delivery').get()!.state,
    ).toBe('complete');
    expect(f.store.db.prepare('SELECT count(*) n FROM group_member_feed_sources').get()!.n).toBe(1);
    const feed = await feature.readShared({
        visibility: 'shared',
        after: 0,
        limit: 8,
        cursor: null,
      }),
      item = feed.entries.find((e) => e.category === 'Action')!;
    expect(feed.entries).toHaveLength(3); // Human message, exact Work instruction and one producer original.
    expect(item.scope.memberId).toBe(open.member.memberId);
    const header = await f.host.sharedEvidenceHeader(feature.enrollmentHandle, item.eventId),
      original = JSON.parse(header.compactOriginal!);
    expect(original).toMatchObject({
      requestId,
      runId: run.id,
      detail: { producer: 'job', jobId: run.id, state: 'queued' },
    });
    expect(
      (await f.host.original({ handle: open.shared.handle, eventId: item.eventId })).text,
    ).toBe(header.compactOriginal);
    const verified = await groupFeatureEvidence(f.host).readVerifiedShared(feature, item.eventId);
    expect(verified.facts).toMatchObject({
      kinds: ['job'],
      originalIds: { managerId: manager.id, jobId: run.id },
      instructionIds: [original.instructionEventId],
    });
    await expect(
      f.host.publishNativeActivity(feature.enrollmentHandle, {
        ...original,
        detail: { ...original.detail, state: 'completed' },
      }),
    ).rejects.toThrow();
    expect(f.store.runs()).toHaveLength(1);
    const task = f.store.addTask(project.id, {
        title: 'Exact output',
        goal: 'Shared result',
        acceptance: 'Keep exact original',
        managerId: manager.id,
        parentId: null,
      }),
      child = f.store.addAgent({
        projectId: project.id,
        parentId: manager.id,
        taskId: task.id,
        name: 'Result worker',
        role: 'researcher',
        provider: 'codex',
        cwd: f.directory,
      }),
      childRun = f.store.enqueue(child.id, randomUUID(), 'Shared task', 'delegation', manager.id),
      text = 'Exact chunked result 🧬\n'.repeat(2500);
    inheritGroupHostWork(f.store, f.store.run(run.id), f.store.run(childRun.id));
    f.store.updateRun(childRun.id, { status: 'running' });
    captureGroupNativeFinal(f.store, childRun.id, `${child.id}:provider-final`, text);
    f.store.entry({
      id: randomUUID(),
      agentId: child.id,
      runId: childRun.id,
      kind: 'assistant',
      title: 'Result',
      text,
      status: 'complete',
      phase: 'final',
      createdAt: new Date().toISOString(),
    });
    f.store.updateRun(childRun.id, { status: 'completed' });
    // Each bounded pass advances at most four existing delivery phases per source.
    for (let i = 0; i < 4; i++) await activity.pass();
    const sources = f.store.db
        .prepare('SELECT body FROM group_native_activity')
        .all()
        .map((r) => JSON.parse(String(r.body))),
      result = sources.find((r) => r.detail.producer === 'worker'),
      page = await feature.readShared({ visibility: 'shared', after: 0, limit: 8, cursor: null }),
      event = page.entries.find((e) => e.entityId === result.receiptId)!;
    expect(event.manifest.chunks.length).toBeGreaterThan(1);
    expect(
      (await f.host.sharedEvidenceHeader(feature.enrollmentHandle, event.eventId)).compactOriginal,
    ).toBeNull();
    const exact = await f.host.original({ handle: open.shared.handle, eventId: event.eventId });
    expect(JSON.parse(exact.text).detail.result).toMatchObject({ text, availability: 'complete' });
    expect(
      (await groupFeatureEvidence(f.host).readVerifiedShared(feature, event.eventId)).facts,
    ).toMatchObject({
      kinds: ['finding'],
      originalIds: { workerId: child.id, jobId: childRun.id },
    });
    const local = await f.post('activity-original', {
      handle: open.shared.handle,
      receiptId: result.receiptId,
      count: 16,
    });
    expect(local.statusCode, local.body).toBe(200);
    expect(Buffer.from(local.json().data, 'base64').toString('utf8')).toBe(text);
    expect(
      (
        await f.post(
          'activity-original',
          { handle: open.shared.handle, receiptId: result.receiptId },
          false,
        )
      ).statusCode,
    ).toBe(401);
    expect((await f.post('activity-status', { handle: open.shared.handle })).json()).toMatchObject({
      retained: 5,
      pending: 0,
      gaps: [],
    });
    expect(proxyPath('POST', '/groups/activity-status')).toBe('/api/groups/activity-status');
    expect(proxyPath('POST', '/groups/activity-original')).toBe('/api/groups/activity-original');
  } finally {
    unregisterActivity();
    await activity.close();
    await memberFeed.close();
  }
}, 30000);

it('concurrent identical Groups readings share only their exact in-flight authority and query', async () => {
  let watching = false;
  const kinds: string[] = [];
  let gate: Promise<void> | undefined;
  let release!: () => void, entered!: () => void;
  const http: typeof fetch = async (...args) => {
    const command = JSON.parse(String(args[1]?.body)) as { kind: string };
    if (watching) {
      kinds.push(command.kind);
      if (command.kind === 'status' && gate) {
        entered();
        await gate;
      }
    }
    return fetch(...args);
  };
  const f = await installation(undefined, { http });
  const { open } = await create(f, 'Concurrent read budget');
  watching = true;
  const shared = { handle: open.shared.handle };
  const feed = { ...shared, query: { visibility: 'shared', after: 0, limit: 1, cursor: null } };
  for (const [name, input, expected] of [
    ['open', { handle: open.group.handle }, ['status', 'roster']],
    ['chat', shared, ['status']],
    ['feed', feed, ['status', 'feed']],
  ] as const) {
    kinds.length = 0;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = f.post(name, input),
      second = f.post(name, input);
    await started;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(kinds).toEqual(['status']);
    release();
    gate = undefined;
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
    expect(results[0].json()).toEqual(results[1].json());
    expect(kinds).toEqual(expected);
    await f.post(name, input);
    expect(kinds).toEqual([...expected, ...expected]);
  }
  kinds.length = 0;
  const differentQueries = await Promise.all([
    f.post('feed', feed),
    f.post('feed', { ...feed, query: { ...feed.query, limit: 2 } }),
  ]);
  expect(differentQueries.map((result) => result.statusCode)).toEqual([200, 200]);
  expect(kinds.filter((kind) => kind === 'status')).toHaveLength(2);
  expect(kinds.filter((kind) => kind === 'feed')).toHaveLength(2);
  kinds.length = 0;
  await Promise.all([f.post('chat', shared), f.post('chat', { handle: open.private.handle })]);
  expect(kinds).toEqual(['status', 'status']);
  kinds.length = 0;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = f.post('chat', shared);
  await started;
  const effect = f.post('draft', {
    ...shared,
    key: randomUUID(),
    revision: 0,
    text: 'An effect needs its own fresh authority.',
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(kinds).toEqual(['status', 'status']);
  release();
  gate = undefined;
  expect((await Promise.all([reading, effect])).map((result) => result.statusCode)).toEqual([
    200, 200,
  ]);
});

it('settled coalesced readings never authorize later effects or conceal enrollment revocation', async () => {
  const a = await installation(),
    b = await installation();
  const { open } = await create(a, 'Fresh effect authority');
  const member = await joinMember(a, b, open.group.handle);
  const reading = { handle: member.open.shared.handle };
  expect(
    (await Promise.all([b.post('chat', reading), b.post('chat', reading)])).map(
      (r) => r.statusCode,
    ),
  ).toEqual([200, 200]);
  expect(
    (
      await a.post('revoke', {
        handle: open.group.handle,
        key: randomUUID(),
        requestId: member.open.member.installationId,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await b.post('send', { ...reading, key: randomUUID(), text: 'Must not send after revoke' }))
      .statusCode,
  ).toBe(403);
  expect((await b.post('chat', reading)).statusCode).toBe(403);
  expect(
    (
      await b.post('feed', {
        ...reading,
        query: { visibility: 'shared', after: 0, limit: 1, cursor: null },
      })
    ).statusCode,
  ).toBe(403);
  expect(b.host.db.prepare('SELECT count(*) AS n FROM gh_sends').get()?.n).toBe(0);
});

it('native Group notifications share one protected socket and fan out ephemeral authenticated SSE hints', async () => {
  const f = await installation(),
    { open } = await create(f, 'Notification fanout');
  await expect.poll(() => f.host.updates.connected(open.member)).toBe(true);
  const first: unknown[] = [],
    second: unknown[] = [];
  const off1 = f.host.updates.subscribe((value) => first.push(value)),
    off2 = f.host.updates.subscribe((value) => second.push(value));
  await f.app.listen({ host: '127.0.0.1', port: f.appPort });
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${f.appPort}/api/events`, {
    headers: { Authorization: f.auth('GET', '/api/events') },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  let text = '';
  const until = async (condition: () => boolean) => {
    while (!condition()) {
      const next = await reader.read();
      if (next.done) throw new Error('Stream ended');
      text += new TextDecoder().decode(next.value);
    }
  };
  try {
    await until(() => text.includes('event: group'));
    expect(text).toContain('"connected":true');
    expect(text).not.toContain('Bearer');
    const count = f.host.updates['channels'].size;
    expect(count).toBe(1);
    const events = f.store.head;
    await f.host.open({ handle: open.group.handle });
    await f.host.chat({ handle: open.shared.handle });
    expect(f.host.updates['channels'].size).toBe(1);
    const before = first.length;
    await f.post('invite', { handle: open.group.handle, key: randomUUID() });
    await expect.poll(() => first.length).toBeGreaterThan(before);
    expect(first).toEqual(second);
    expect(f.store.head).toBe(events);
    await until(() => text.includes('"changed":true'));
    expect(text).not.toContain('event: change\n');
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
    off1();
    off2();
  }
});

it('background native Group evidence reads use one fresh service read and notification-aware idle cadence', async () => {
  const commands: string[] = [];
  let watching = false;
  const http: typeof fetch = async (...args) => {
    if (watching) commands.push((JSON.parse(String(args[1]?.body)) as { kind: string }).kind);
    return fetch(...args);
  };
  const f = await installation(undefined, { http }),
    { open } = await create(f, 'Evidence idle budget');
  const { sessionId: _owner, ...scope } = open.shared.context;
  const context = f.host.events.createContext({
    ...scope,
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
  const managerId = randomUUID();
  let effects = 0;
  const coordination = new GroupFeatureCoordination(f.runtime, f.host, {
    identity: () => ({ managerId, agentId: managerId, requestId: randomUUID() }),
    inspect: () => null,
    delegate: async () => {
      effects++;
      throw new Error('No effect authorized by a hint');
    },
  });
  closers.push(() => coordination.close());
  coordination.tools(context);
  await expect.poll(() => f.host.updates.connected(context)).toBe(true);
  watching = true;
  for (let i = 0; i < 100; i++) await coordination.pass(false);
  expect(commands).toEqual(['evidence']);
  expect(effects).toBe(0);
  expect(f.store.runs()).toHaveLength(0);
  // Explicit reconciliation remains fresh even inside the idle interval.
  await coordination.pass();
  expect(commands).toEqual(['evidence', 'evidence']);
  await expect(
    f.host.readNativeActionEvidence(context, {
      kind: 'instruction',
      operationId: randomUUID(),
      text: 'Not a read',
    } as never),
  ).rejects.toThrow('Read-only evidence');
  expect(effects).toBe(0);
});

it('native Group evidence and socket retries preserve their saved service binding before dispatch and after a held read', async () => {
  let count = 0,
    held = false,
    started!: () => void,
    release!: () => void;
  const begins = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const http: typeof fetch = async (...args) => {
    if (held) {
      count++;
      const result = await fetch(...args);
      started();
      await gate;
      return result;
    }
    return fetch(...args);
  };
  const f = await installation(undefined, { http }),
    { open } = await create(f, 'Saved notification service');
  const { sessionId: _owner, ...scope } = open.shared.context;
  const context = f.host.events.createContext({
    ...scope,
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
  await expect.poll(() => f.host.updates.connected(context)).toBe(true);
  held = true;
  const reading = f.host.readNativeActionEvidence(context, {
    kind: 'evidence',
    after: 0,
    limit: 1,
  });
  await begins;
  const path = join(f.host.directory, 'service.json');
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { endpoint: string; endpointId: string };
  writeFileSync(path, JSON.stringify({ ...saved, endpointId: randomUUID() }));
  release();
  await expect(reading).rejects.toMatchObject({ code: 'GROUP_SERVICE_CHANGED' });
  await expect(
    f.host.readNativeActionEvidence(context, { kind: 'evidence', after: 0, limit: 1 }),
  ).rejects.toMatchObject({ code: 'GROUP_SERVICE_CHANGED' });
  expect(count).toBe(1);
  const channel = [...f.host.updates['channels'].values()][0];
  channel.peer!.terminate();
  await expect.poll(() => channel.peer).toBeUndefined();
  f.host.updates['open'](channel);
  expect(channel.peer).toBeUndefined();
  expect(channel.connected).toBe(false);
  expect(count).toBe(1);
});

it('removing a watched Group disposes its native socket immediately; reads stay unwatched until an explicit restore', async () => {
  const f = await installation(),
    { open } = await create(f, 'Remove native notifications');
  await expect.poll(() => f.host.updates.connected(open.shared.context)).toBe(true);
  const updates: unknown[] = [];
  const unsubscribe = f.host.updates.subscribe((update) => updates.push(update));
  closers.push(async () => unsubscribe());
  const channel = [...f.host.updates['channels'].values()][0];
  const remove = { handle: open.group.handle, key: randomUUID(), revision: 0, hidden: true };
  const hidden = await f.post('local-visibility', remove);
  expect(hidden.statusCode, hidden.body).toBe(200);
  expect(f.host.updates.connected(open.shared.context)).toBe(false);
  expect(f.host.updates['channels'].size).toBe(0);
  expect(channel.peer).toBeUndefined();
  expect(channel.heartbeat).toBeUndefined();
  expect(channel.retry).toBeUndefined();
  expect(channel.debounce).toBeUndefined();
  expect(updates.at(-1)).toMatchObject({ connected: false, changed: false });
  f.host.updates['open'](channel);
  expect((await f.post('open', { handle: open.group.handle })).statusCode).toBe(200);
  expect(f.host.updates['channels'].size).toBe(0);
  const restored = await f.post('local-visibility', {
    handle: open.group.handle,
    key: randomUUID(),
    revision: 1,
    hidden: false,
  });
  expect(restored.statusCode, restored.body).toBe(200);
  expect(f.host.updates['channels'].size).toBe(0);
  expect((await f.post('open', { handle: open.group.handle })).statusCode).toBe(200);
  await expect.poll(() => f.host.updates.connected(open.shared.context)).toBe(true);
  expect((await f.post('local-visibility', remove)).json()).toEqual(hidden.json());
  expect(f.host.updates.connected(open.shared.context)).toBe(true);
  expect(f.host.updates['channels'].size).toBe(1);
  expect(f.store.runs()).toHaveLength(0);
});

it('native evidence continuation drains bounded pages before idle cadence and leaves other owners fair turns', async () => {
  const f = await installation(),
    { open } = await create(f, 'Bounded evidence continuation');
  for (let i = 0; i < 27; i++)
    expect(
      (
        await f.post('actions', {
          handle: open.shared.handle,
          command: {
            kind: 'instruction',
            operationId: randomUUID(),
            text: `Explicit fixture instruction ${i}`,
          },
        })
      ).json(),
    ).toMatchObject({ ok: true });
  const { sessionId: _owner, ...scope } = open.shared.context;
  const contexts = Array.from({ length: 3 }, () =>
    f.host.events.createContext({ ...scope, provider: 'codex', nativeSessionId: randomUUID() }),
  );
  const managers = contexts.map(() => randomUUID());
  let effects = 0;
  const coordination = new GroupFeatureCoordination(f.runtime, f.host, {
    identity: (context) => {
      const managerId =
        managers[contexts.findIndex((value) => value.sessionId === context.sessionId)];
      return { managerId, agentId: managerId, requestId: randomUUID() };
    },
    inspect: () => null,
    delegate: async () => {
      effects++;
      throw new Error('Instruction evidence grants no effect');
    },
  });
  closers.push(() => coordination.close());
  contexts.forEach((context) => coordination.tools(context));
  await expect.poll(() => f.host.updates.connected(contexts[0])).toBe(true);
  const read = vi.spyOn(f.host, 'readNativeActionEvidence');
  for (let i = 0; i < 6; i++) await coordination.pass(false);
  expect(read.mock.calls.map(([, command]) => command.after)).toEqual([0, 25, 0, 25, 0, 25]);
  expect(read.mock.calls.map(([context]) => context.sessionId)).toEqual(
    contexts.flatMap((context) => [context.sessionId, context.sessionId]),
  );
  expect(
    f.host.db
      .prepare('SELECT cursor FROM gh_coordination_owners ORDER BY rowid')
      .all()
      .map((row) => row.cursor),
  ).toEqual([27, 27, 27]);
  for (let i = 0; i < 3; i++) await coordination.pass(false);
  expect(read).toHaveBeenCalledTimes(6);
  const ordinaryPositions = new Set<number>();
  for (let i = 0; i < 10; i++) {
    coordination['dirty'].add(managers[0]);
    await coordination.pass(false);
    ordinaryPositions.add(coordination['position']);
  }
  expect(ordinaryPositions).toEqual(new Set([1, 2, 3]));
  expect(effects).toBe(0);
  expect(f.store.runs()).toHaveLength(0);
  read.mockRestore();
});

it('protected per-enrollment routes retain two creators across restart, lost replies, originals, notifications and revocation', async () => {
  const secondPort = await freePort(),
    secondEndpoint = `http://127.0.0.1:${secondPort}/`;
  await startWorker({
    port: secondPort,
    endpoint: secondEndpoint,
    persist: join(root, 'second-service'),
  });
  const ownerConfig = (name: string) => {
    const origin = `https://${name}.example.invalid`;
    return {
      version: 1 as const,
      mode: 'hosted' as const,
      endpoint: origin + '/',
      endpointId: randomUUID(),
      setupCapability: setup,
      hostingAuthorization: { origin, approvalCapability: secret(), freeApprovalId: randomUUID() },
    };
  };
  const firstService = ownerConfig('first-owner'),
    secondService = ownerConfig('second-owner');
  serviceRelays.set(firstService.hostingAuthorization.origin, {
    endpoint,
    approval: firstService.hostingAuthorization.approvalCapability,
  });
  serviceRelays.set(secondService.hostingAuthorization.origin, {
    endpoint: secondEndpoint,
    approval: secondService.hostingAuthorization.approvalCapability,
  });
  closers.push(async () => {
    serviceRelays.clear();
    notificationRoutes.length = 0;
  });
  const calls: { origin: string; kind: string; operation?: string }[] = [];
  let acceptedJoinInstallation: string | undefined;
  let loseJoin = false,
    loseCommit = false,
    loseRevoke = false;
  const http: typeof fetch = async (address, options) => {
    const url = new URL(String(address)),
      relay = serviceRelays.get(url.origin);
    expect(relay, 'only explicitly owned fixture services may receive requests').toBeTruthy();
    expect(url.search).toBe('');
    expect(options?.redirect).toBe('error');
    expect(options?.credentials).toBe('omit');
    const headers = new Headers(options?.headers);
    expect(headers.get('X-Hosting-Approval')).toBe(relay!.approval);
    const command = JSON.parse(String(options?.body));
    calls.push({ origin: url.origin, kind: command.kind, operation: command.operationId });
    headers.delete('X-Hosting-Approval');
    const response = await fetch(relay!.endpoint.replace(/\/$/, '') + url.pathname, {
      ...options,
      headers,
    });
    if (
      url.origin === secondService.hostingAuthorization.origin &&
      loseJoin &&
      command.kind === 'join'
    ) {
      loseJoin = false;
      const reply = (await response.clone().json()) as {
        value: { identity: { installationId: string } };
      };
      acceptedJoinInstallation = reply.value.identity.installationId;
      throw new Error('Lost exact join acknowledgement');
    }
    if (
      url.origin === secondService.hostingAuthorization.origin &&
      loseCommit &&
      command.kind === 'effect' &&
      command.packet.kind === 'commit'
    ) {
      loseCommit = false;
      throw new Error('Lost exact publication acknowledgement');
    }
    if (
      url.origin === firstService.hostingAuthorization.origin &&
      loseRevoke &&
      command.kind === 'revoke'
    ) {
      loseRevoke = false;
      throw new Error('Lost exact revoke acknowledgement');
    }
    return response;
  };
  const first = await installation(undefined, { service: firstService, http }),
    second = await installation(undefined, { service: secondService, http });
  let member = await installation(undefined, { configured: false, http });
  const a = (await create(first, 'Creator one')).open,
    b = (await create(second, 'Creator two')).open;
  const invitation = async (owner: typeof first, handle: string) => {
    const reply = await owner.post('invite', { handle, key: randomUUID() });
    expect(reply.statusCode, reply.body).toBe(200);
    return `https://app.example.invalid/#${reply.json().fragment}`;
  };
  const firstInvitation = await invitation(first, a.group.handle),
    secondInvitation = await invitation(second, b.group.handle);
  const descriptor = (link: string) =>
    JSON.parse(new URLSearchParams(new URL(link).hash.slice('#/groups?'.length)).get('invite')!);
  const install = (link: string) => installService(member.host.directory, descriptor(link).service);
  const beforeImport = calls.length;
  expect(
    (
      await member.post('join', {
        key: randomUUID(),
        displayName: 'Reader',
        invitation: secondInvitation,
      })
    ).statusCode,
  ).toBe(400);
  expect(calls).toHaveLength(beforeImport);
  install(firstInvitation);
  const originalPath = join(member.host.directory, 'service.json'),
    originalBytes = readFileSync(originalPath, 'utf8'),
    originalInode = statSync(originalPath).ino;
  const joinedA = await member.post('join', {
    key: randomUUID(),
    displayName: 'Reader',
    invitation: firstInvitation,
  });
  expect(joinedA.statusCode, joinedA.body).toBe(200);
  const openedA = groupHostOpenSchema.parse(
    (await member.post('open', { handle: joinedA.json().group.handle })).json(),
  );
  expect(
    (
      await member.post('create', {
        key: randomUUID(),
        projectName: 'No creator grant',
        displayName: 'Reader',
      })
    ).json().code,
  ).toBe('GROUP_CREATOR_SETUP_REQUIRED');
  install(secondInvitation);
  expect(readFileSync(originalPath, 'utf8')).toBe(originalBytes);
  expect(statSync(originalPath).ino).toBe(originalInode);
  const alteredInvitation = descriptor(secondInvitation);
  alteredInvitation.service.hostingAuthorization.approvalCapability = secret();
  const alteredLink = `https://app.example.invalid/#/groups?invite=${encodeURIComponent(JSON.stringify(alteredInvitation))}`;
  const beforeAltered = calls.length,
    intentsBeforeAltered = member.host.db.prepare('SELECT count(*) n FROM gh_operations').get()!.n;
  expect(
    (
      await member.post('join', {
        key: randomUUID(),
        displayName: 'Reader',
        invitation: alteredLink,
      })
    ).statusCode,
  ).toBe(400);
  expect(calls).toHaveLength(beforeAltered);
  expect(member.host.db.prepare('SELECT count(*) n FROM gh_operations').get()!.n).toBe(
    intentsBeforeAltered,
  );
  const joinInput = { key: randomUUID(), displayName: 'Reader', invitation: secondInvitation };
  loseJoin = true;
  expect((await member.post('join', joinInput)).statusCode).toBe(503);
  const pendingBody = String(
    member.host.db
      .prepare('SELECT body FROM gh_operations WHERE key=?')
      .get('join:' + joinInput.key)!.body,
  );
  const directory = member.directory;
  await member.close();
  member = await installation(directory, { http });
  const resumedJoin = await member.post('resume', { key: joinInput.key, kind: 'join' });
  expect(resumedJoin.statusCode, resumedJoin.body).toBe(200);
  const openedB = groupHostOpenSchema.parse(
    (await member.post('open', { handle: resumedJoin.json().group.handle })).json(),
  );
  expect(openedB.member.installationId).toBe(acceptedJoinInstallation);
  expect(
    String(
      member.host.db
        .prepare('SELECT body FROM gh_operations WHERE key=?')
        .get('join:' + joinInput.key)!.body,
    ),
  ).toBe(pendingBody);
  expect(
    calls
      .filter((x) => x.origin === secondService.hostingAuthorization.origin && x.kind === 'join')
      .map((x) => x.operation),
  ).toEqual([joinInput.key, joinInput.key]);
  expect(
    (await member.post('open', { handle: openedA.group.handle })).json().shared.context,
  ).toEqual(openedA.shared.context);
  await expect
    .poll(
      () =>
        member.host.updates.connected(openedA.member) &&
        member.host.updates.connected(openedB.member),
      { timeout: 5000 },
    )
    .toBe(true);
  expect(notificationRoutes).toContain('wss://first-owner.example.invalid');
  expect(notificationRoutes).toContain('wss://second-owner.example.invalid');
  const updates: string[] = [];
  const unsubscribe = member.host.updates.subscribe((update) => {
    if (update.changed) updates.push(update.groupId);
  });
  closers.push(async () => unsubscribe());
  const noteA = {
      handle: a.shared.handle,
      key: randomUUID(),
      text: 'Exact original from creator one',
    },
    noteB = { handle: b.shared.handle, key: randomUUID(), text: 'Exact original from creator two' };
  await selectFeedWriter(first, a.shared.handle);
  await selectFeedWriter(second, b.shared.handle);
  expect((await first.post('send', noteA)).json().delivery).toBe('complete');
  await progressFeed(first);
  expect((await second.post('send', noteB)).json().delivery).toBe('complete');
  await progressFeed(second);
  await expect
    .poll(() => new Set(updates), { timeout: 5000 })
    .toEqual(new Set([a.member.groupId, b.member.groupId]));
  const original = async (opened: GroupHostOpen, text: string, retainedEvent?: string) => {
    const feed = await member.post('feed', {
      handle: opened.shared.handle,
      query: { visibility: 'shared', after: 0, limit: 8, cursor: null },
    });
    expect(feed.statusCode, feed.body).toBe(200);
    if (!retainedEvent) expect(feed.json().entries).toHaveLength(1);
    const eventId = retainedEvent ?? feed.json().entries[0].eventId;
    expect(
      feed.json().entries.some((entry: { eventId: string }) => entry.eventId === eventId),
    ).toBe(true);
    expect(
      (await member.post('original', { handle: opened.shared.handle, eventId })).json().text,
    ).toBe(text);
    return eventId;
  };
  const eventA = await original(openedA, noteA.text),
    eventB = await original(openedB, noteB.text);
  expect(eventA).not.toBe(eventB);
  const foreignOriginal = await member.post('original', {
    handle: openedA.shared.handle,
    eventId: eventB,
  });
  expect(foreignOriginal.statusCode).not.toBe(200);
  expect(foreignOriginal.body).not.toContain(noteB.text);
  const ownNote = {
    handle: openedB.shared.handle,
    key: randomUUID(),
    text: 'Member sends to the second retained service',
  };
  loseCommit = true;
  const uncertain = await member.post('send', ownNote);
  expect(uncertain.json().delivery).toBe('uncertain');
  const savedSend = String(
    member.host.db
      .prepare('SELECT body FROM gh_sends WHERE handle=? AND key=?')
      .get(ownNote.handle, ownNote.key)!.body,
  );
  await member.close();
  member = await installation(directory, { http });
  await new Promise((resolve) => setTimeout(resolve, 1100)); // retained publication backoff, receipt-only retry
  expect(
    (await member.post('status', { handle: ownNote.handle, key: ownNote.key, retry: true })).json()
      .delivery,
  ).toBe('complete');
  expect((await member.post('send', ownNote)).json().runId).toBe(uncertain.json().runId);
  const nextSend = JSON.parse(
    String(
      member.host.db
        .prepare('SELECT body FROM gh_sends WHERE handle=? AND key=?')
        .get(ownNote.handle, ownNote.key)!.body,
    ),
  );
  expect(nextSend.deliveryOperation).toBe(JSON.parse(savedSend).deliveryOperation);
  const registry = join(member.host.directory, 'services'),
    routeB = join(registry, groupServiceHash(secondService) + '.member.json');
  const stored = readFileSync(routeB, 'utf8'),
    beforeUnavailable = calls.length;
  // Move outside the registry so unrelated valid services remain readable.
  const savedOutside = join(member.host.directory, 'route-saved.fixture');
  renameSync(routeB, savedOutside);
  expect((await member.post('open', { handle: openedB.group.handle })).json().code).toBe(
    'GROUP_SERVICE_CHANGED',
  );
  expect(calls).toHaveLength(beforeUnavailable);
  expect((await member.post('open', { handle: openedA.group.handle })).statusCode).toBe(200);
  renameSync(savedOutside, routeB);
  const changed = JSON.parse(stored);
  changed.service.hostingAuthorization.approvalCapability = secret();
  writeFileSync(routeB, JSON.stringify(changed));
  const beforeChanged = calls.length;
  expect((await member.post('open', { handle: openedB.group.handle })).json().code).toBe(
    'GROUP_SERVICE_CHANGED',
  );
  expect(calls).toHaveLength(beforeChanged);
  writeFileSync(routeB, stored);
  const malicious = {
    ...descriptor(firstInvitation),
    service: descriptor(secondInvitation).service,
  };
  const conflictLink = `https://app.example.invalid/#/groups?invite=${encodeURIComponent(JSON.stringify(malicious))}`,
    beforeConflict = calls.length;
  expect(
    (
      await member.post('join', {
        key: randomUUID(),
        displayName: 'Reader',
        invitation: conflictLink,
      })
    ).json().code,
  ).toBe('GROUP_IDENTITY_CONFLICT');
  expect(calls).toHaveLength(beforeConflict);
  writeFileSync(originalPath, JSON.stringify({ version: 1, mode: 'disabled' }));
  const beforeDisabled = calls.length;
  expect((await member.post('open', { handle: openedB.group.handle })).json().code).toBe(
    'GROUP_SETUP_REQUIRED',
  );
  expect(calls).toHaveLength(beforeDisabled);
  writeFileSync(originalPath, originalBytes);
  // Explicit creator activation after joining selects fresh creation only.
  installService(member.host.directory, secondService, true);
  const own = (await create(member, 'Joined first, own creator choice')).open;
  expect(own.member.groupId).not.toBe(b.member.groupId);
  expect(readFileSync(originalPath, 'utf8')).toBe(originalBytes);
  expect(statSync(originalPath).ino).toBe(originalInode);
  expect(
    (await member.post('open', { handle: openedA.group.handle })).json().shared.context,
  ).toEqual(openedA.shared.context);
  const revoke = {
    handle: a.group.handle,
    key: randomUUID(),
    requestId: openedA.member.installationId,
  };
  loseRevoke = true;
  expect((await first.post('revoke', revoke)).statusCode).toBe(503);
  await first.close();
  const firstRestarted = await installation(first.directory, { http });
  expect((await firstRestarted.post('revoke', revoke)).statusCode).toBe(200);
  expect((await member.post('open', { handle: openedA.group.handle })).statusCode).toBe(403);
  expect(
    (await member.post('open', { handle: openedB.group.handle })).json().shared.context,
  ).toEqual(openedB.shared.context);
  await original(openedB, noteB.text, eventB);
}, 30000);
