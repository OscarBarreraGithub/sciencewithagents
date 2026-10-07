import { beforeAll, afterAll, afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
  chmodSync,
  readFileSync,
} from 'node:fs';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { repoRoot } from './paths.js';
import { GroupHost } from './group-host.js';
import { groupDocumentVersion } from './group-documents.js';
import { GroupFeatureDocuments } from './group-feature-documents.js';
import { GroupFeatureCoordination } from './group-feature-coordination.js';
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
import { groupHostOpenSchema, groupHostReceiptSchema } from '@dock/shared/dist/group-host.js';
import { proxyPath } from './hosts.js';
import { groupActionResultSchema } from '@dock/shared/dist/group-actions.js';
import type { GroupPromotionSynthesis, GroupPromotionSynthesisResult } from './group-promotion.js';
import { groupEventIdSchema, type GroupContext } from '@dock/shared';

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
async function startWorker() {
  worker = spawn(
    process.execPath,
    [
      join(repoRoot, 'apps/group-service/node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      '0',
      '--persist-to',
      join(root, 'workerd'),
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
  worker.stdout?.resume();
  worker.stderr?.resume();
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (worker.exitCode !== null) throw new Error('Owned workerd exited');
    try {
      const response = await fetch(`${endpoint}/v1/create`, {
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
  const host = new GroupHost(directory, {
    betaProfile: null,
    http: options.http,
    native: options.native,
    nativeFactory: options.nativeFactory,
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
  return { directory, host, app, post, get, close, access, appPort, runtime, store };
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
    'Instruction',
    'Decision',
  ]);
  const catchup = await a.post('catchup/start', { handle: open.private.handle });
  expect(catchup.statusCode, catchup.body).toBe(200);
  expect(catchup.json().entries).toHaveLength(2);
  expect(catchup.json().sourceFacts).toHaveLength(2);
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
  const pending = await a.post('pending', { handle });
  expect(pending.statusCode, pending.body).toBe(200);
  const request = pending
    .json()
    .requests.find((r: { displayName: string }) => r.displayName === 'Li Ming');
  expect((await b.post('open', { handle: joined.json().group.handle })).statusCode).toBe(403);
  const approved = await a.post('approve', {
    handle,
    key: randomUUID(),
    requestId: request.requestId,
    confirmation: joined.json().confirmation,
  });
  expect(approved.statusCode, approved.body).toBe(200);
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
  // A fixed test-only relay verifies the protected HTTPS intent/headers then
  // sends the same request to actual owned local workerd. TLS itself is covered
  // by the dependency's native HTTPS suite; this is not deployed service proof.
  const http: typeof fetch = async (...args) => {
    const url = new URL(String(args[0]));
    expect(url.origin).toBe(origin);
    expect(url.search).toBe('');
    const headers = new Headers(args[1]?.headers);
    expect(headers.get('X-Hosting-Approval')).toBe(approval);
    expect(headers.get('Authorization')).toMatch(/^Bearer [a-f0-9]{64}$/);
    expect(args[1]?.redirect).toBe('error');
    expect(args[1]?.credentials).toBe('omit');
    kinds.add(JSON.parse(String(args[1]?.body)).kind);
    headers.delete('X-Hosting-Approval');
    return fetch(`${endpoint.replace(/\/$/, '')}${url.pathname}`, { ...args[1], headers });
  };
  const a = await installation(undefined, { service, http }),
    b = await installation(undefined, { service: { ...service, endpointId: randomUUID() }, http });
  const { open } = await create(a, 'Protected hosted routing');
  const joined = await joinMember(a, b, open.group.handle);
  const input = {
    handle: open.shared.handle,
    key: randomUUID(),
    text: 'Actual local workerd result through configured hosted seam',
  };
  await selectFeedWriter(a, open.shared.handle);
  expect((await a.post('send', input)).json().delivery).toContain('pending');
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
    'approve',
    'roster',
    'registerSource',
    'effect',
    'receipt',
    'feed',
    'expand',
  ])
    expect(kinds.has(kind), kind).toBe(true);
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
it('real workerd create/join/approval, exact host mappings, private drafts and native denial survive host/workerd restart', async () => {
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
  const b = await installation(undefined, {
    http: async (...args) => {
      const response = await fetch(...args);
      const body = JSON.parse((args[1]?.body as string) ?? '{}');
      if (loseJoin && body.kind === 'join') {
        loseJoin = false;
        throw new Error('lost join ack');
      }
      return response;
    },
  });
  const key = randomUUID();
  expect((await b.post('join', { key, invitation, displayName: 'Member' })).statusCode).toBe(503);
  const result = await b.post('resume', { key, kind: 'join' });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().group.state).toBe('pending');
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
  expect((await f.post('open', { handle: open.group.handle })).statusCode).toBe(500);
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
  const summary = controlledFeedSynthesis();
  await selectFeedWriter(a, open.shared.handle, summary);
  const joined = await joinMember(a, b, open.group.handle);
  const other = await create(c, 'Other group');
  const firstInput = {
    handle: open.shared.handle,
    key: randomUUID(),
    text: '  Exact human original\nأمينة\t  ',
  };
  const first = await a.post('send', firstInput);
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().delivery).toContain('pending');
  await progressFeed(a);
  const retained = () =>
    JSON.parse(
      String(
        a.host.db
          .prepare('SELECT body FROM gh_sends WHERE handle=? AND key=?')
          .get(firstInput.handle, firstInput.key)!.body,
      ),
    );
  const ids = retained();
  const projection = a.host.db
    .prepare('SELECT source_json FROM gh_promotion_projections ORDER BY rowid LIMIT 1')
    .get()!;
  expect(projection).toBeTruthy();
  expect(ids.promotionReceiptId).toBeTruthy();
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
  resumed.host.promotion.start(summary);
  await new Promise((resolve) => setTimeout(resolve, 1100)); // retained publication backoff, then receipt-only reconciliation
  await progressFeed(resumed);
  expect(
    (
      await resumed.post('status', { handle: firstInput.handle, key: firstInput.key, retry: true })
    ).json().delivery,
  ).toBe('complete');
  await progressFeed(resumed);
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
    promotionReceiptId: ids.promotionReceiptId,
  });
  expect(
    resumed.host.db
      .prepare('SELECT source_json FROM gh_promotion_projections ORDER BY rowid LIMIT 1')
      .get(),
  ).toEqual(projection);
  const more = ['Second unchanged original 🧬', 'Third unchanged original e\u0301'];
  for (const text of more) {
    const result = await resumed.post('send', {
      handle: open.shared.handle,
      key: randomUUID(),
      text,
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().delivery).toContain('pending');
    await progressFeed(resumed);
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
  ).toContain('pending');
  await progressFeed(resumed);
  const query = { visibility: 'shared', after: 0, limit: 8, cursor: null };
  const response = await b.post('feed', { handle: joined.open.shared.handle, query });
  expect(response.statusCode, response.body).toBe(200);
  const events = response.json().entries;
  expect(events).toHaveLength(4);
  expect(new Set(events.map((e: { eventId: string }) => e.eventId)).size).toBe(4);
  const owned = events.filter(
    (e: { origin: { scope: { memberId: string } } }) =>
      e.origin.scope.memberId === open.member.memberId,
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

// Controlled host contract fixture: no provider/native process or acceptance
// readiness is proved here. The production factory has its own review/canaries.
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
  expect(feed.json().entries).toHaveLength(1);
  const event = feed.json().entries[0];
  expect(event.origin.scope.source).toEqual(snapshots.get(requestId)!.result!.source);
  expect(event.origin.kind).toBe('native');
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
  ).toHaveLength(1);
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
  expect(
    (
      await a.post('feed', {
        handle: request.handle,
        query: { visibility: 'shared', after: 0, limit: 20, cursor: null },
      })
    ).json().entries,
  ).toHaveLength(0);
  await a.post('request-agent', request);
  expect(submits).toBe(1);
});

it('designated normal writer resumes another host ordinary shared source after being offline, without duplicate projection or a model launch', async () => {
  const a = await installation();
  const { open } = await create(a, 'Cross-host promotion');
  const b = await installation();
  const member = await joinMember(a, b, open.group.handle);
  const selected = await a.post('feed-writer', { handle: open.shared.handle, key: randomUUID() });
  expect(selected.statusCode, selected.body).toBe(200);
  await a.close(); // writer unavailable; producer must still retain the exact source remotely
  const input = {
    handle: member.open.shared.handle,
    key: randomUUID(),
    text: 'Decision: We will use the reviewed configuration.',
  };
  const sent = await b.post('send', input);
  expect(sent.statusCode, sent.body).toBe(200);
  expect(sent.json().delivery).toContain('pending');
  const query = { visibility: 'shared', after: 0, cursor: null, limit: 20 };
  const before = await b.post('feed', { handle: input.handle, query });
  expect(before.statusCode, before.body).toBe(200);
  expect(before.json().entries).toHaveLength(0);
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
  expect(event.origin.scope.memberId).toBe(member.open.member.memberId);
  expect(event.origin.scope.source.sessionId).toBe(member.open.shared.context.sessionId);
  expect(event.origin.displayName).toBe('Li Ming');
  expect(event.origin.writerId).toBe(open.member.installationId);
  expect(event.scope.memberId).toBe(open.member.memberId);
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
});

it('committed cross-host source keeps original attribution while its writer is offline after a lost commit acknowledgement', async () => {
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
  expect((await b.post('send', input)).statusCode).toBe(200);
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
    value: { kind: 'status', state: 'pending' },
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

it('a bound cross-host source has no trusted attribution before delivery commits', async () => {
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
    (
      await b.post('send', {
        handle: member.open.shared.handle,
        key: randomUUID(),
        text: 'Decision: This source is not committed yet.',
      })
    ).statusCode,
  ).toBe(200);
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
        throw new Error('Controlled capture pending');
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
  expect((await f.post('document-offer', { handle: open.private.handle, key })).statusCode).toBe(
    503,
  );
  expect(describes).toBe(1);
  expect((await f.post('document-offer', { handle: open.shared.handle, key })).statusCode).toBe(
    404,
  );
  expect(describes).toBe(1);
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
    let lose = false;
    const a = await installation(undefined, {
      documents: native,
      http: async (url, options) => {
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
    lose = true;
    expect((await a.post(`${localBase}/publish`, publication)).statusCode).toBe(503);
    const shared = await a.post(`${localBase}/publish`, publication);
    expect(shared.statusCode, shared.body).toBe(200);
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
