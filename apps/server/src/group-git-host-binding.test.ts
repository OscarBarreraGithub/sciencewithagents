import Fastify from 'fastify';
import { GroupFeatureGit } from './group-feature-git.js';
import { registerGroupHostRoutes } from './group-host-routes.js';
import type { GroupHost } from './group-host.js';
import type { GroupNativeConnector } from './group-native-connector.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { groupMemberIdSchema, groupInstallationIdSchema, type GroupContext } from '@dock/shared';
import {
  createGroupGitHostBinding,
  type GroupGitHostCallbacks,
  type GroupGitNativeConnector,
} from './group-git-host-binding.js';
import type { GitGrant, GitReviewReceipt } from './group-git-service.js';
import type { GitNativeExportRequest } from './group-git-native-export.js';

// In the integrated tree these are the local real host/connector modules. The
// isolated Git worker can point ONLY this test at a compiled git-archive of the
// frozen integration. No host algorithms or boolean membership validators are
// replaced. Network replies below are a disposable credential-bound transport
// fixture; native proof/guest execution remains with its owner's canary.
const fixtureDirectory =
  process.env.GROUP_GIT_HOST_FIXTURE_DIRECTORY ?? dirname(fileURLToPath(import.meta.url));
interface Host extends GroupGitHostCallbacks {
  directory: string;
  db: DatabaseSync;
  nativeJournal: GroupGitHostCallbacks['nativeJournal'] & {
    prepare(
      handle: string,
      input: {
        key: string;
        enrollmentHandle: string;
        context: GroupContext;
        text: string;
        intent: 'work';
      },
    ): { request: { requestId: string } };
    record(record: unknown, snapshot: unknown): unknown;
  };
  create(input: unknown): Promise<Open>;
  open(input: { handle: string }): Promise<Open>;
  close(): Promise<void>;
}
interface Open {
  group: { handle: string };
  shared: { handle: string; context: GroupContext };
  private: { handle: string; context: GroupContext };
}
interface FixtureStore {
  close(): void;
  setSetting(key: string, value: unknown): void;
}
interface FixtureRuntime {
  close(): Promise<void>;
}
let HostClass: new (
  root: string,
  options: {
    http: typeof fetch;
    nativeFactory(input: { directory: string; events: Host['events'] }): object;
  },
) => Host;
let StoreClass: new (path: string) => FixtureStore;
let RuntimeClass: new (
  store: FixtureStore,
  root: string,
  binary: string,
  factory: () => Promise<never>,
  dependencies: undefined,
  fixture: { workspace: string },
) => FixtureRuntime;
let createNative: (
  runtime: FixtureRuntime,
  options: { directory: string; events: Host['events'] },
) => GroupGitNativeConnector & { close(): Promise<void> };
beforeAll(async () => {
  const load = async (name: string) =>
    import(/* @vite-ignore */ pathToFileURL(join(fixtureDirectory, name)).href);
  HostClass = (await load('group-host.js')).GroupHost;
  StoreClass = (await load('store.js')).Store;
  RuntimeClass = (await load('runtime.js')).Runtime;
  createNative = (await load('group-native-connector.js')).createGroupNativeConnector;
});

const exec = promisify(execFile);
const binary = process.env.GROUP_GIT_TEST_EXECUTABLE ?? '/opt/homebrew/bin/git';
const env = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  LANG: 'C',
};
const git = async (cwd: string, ...args: string[]) =>
  (await exec(binary, args, { cwd, env })).stdout.trim();
type Binding = Awaited<ReturnType<typeof createGroupGitHostBinding>>;
let root: string, active: string, tip: string, host: Host, binding: Binding;
let connector: ReturnType<typeof createNative>, store: FixtureStore, runtime: FixtureRuntime;
let open: Open,
  nativeContext: GroupContext,
  nativeKey: string,
  grant: GitGrant,
  repositoryId: string;
let wireCalls: number, providerCalls: number, offline: boolean;
const identities = new Map<
  string,
  {
    groupId: string;
    memberId: string;
    installationId: string;
    displayName: string;
    state: 'active' | 'revoked';
  }
>();
const http: typeof fetch = async (url, options) => {
  if (offline) throw new Error('Disposable service offline');
  const headers = new Headers(options?.headers),
    credential = headers.get('authorization')!;
  const command = JSON.parse(String(options?.body));
  if (command.kind === 'initialize') {
    identities.set(credential, {
      groupId: randomUUID(),
      memberId: randomUUID(),
      installationId: randomUUID(),
      displayName: command.displayName,
      state: 'active',
    });
  }
  const identity = identities.get(credential);
  const valid =
    identity &&
    (command.kind === 'initialize' || String(url).endsWith(`/v1/groups/${identity.groupId}`));
  const value =
    command.kind === 'roster'
      ? { kind: 'members', entries: [{ position: 1, identity }], next: null }
      : { kind: 'identity', identity };
  return new Response(
    JSON.stringify(valid ? { ok: true, value } : { ok: false, error: 'denied' }),
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
};
let feature: GroupFeatureGit | undefined;
async function start(consumer = false) {
  store = new StoreClass(join(root, 'runtime.sqlite'));
  store.setSetting('pulsar:policy', { enabled: false });
  runtime = new RuntimeClass(
    store,
    root,
    'UNUSED',
    async () => {
      providerCalls++;
      throw new Error('Provider execution forbidden in binding checks');
    },
    undefined,
    { workspace: active },
  );
  host = new HostClass(join(root, 'normal'), {
    http,
    nativeFactory: (options) => {
      connector = createNative(runtime, options);
      return connector;
    },
  });
  await writeFile(
    join(host.directory, 'service.json'),
    JSON.stringify({
      version: 1,
      mode: 'local-test',
      endpoint: 'http://127.0.0.1:9',
      endpointId: '10000000-0000-4000-8000-000000000001',
      setupCapability: '1'.repeat(64),
    }),
    { mode: 0o600 },
  );
  vi.spyOn(connector, 'gitExports'); // Calls through to the real concrete native port.
  if (consumer) {
    feature = new GroupFeatureGit(host as unknown as GroupHost, connector as GroupNativeConnector);
    await feature.request({ handle: open.shared.handle, command: { kind: 'list' } });
    binding = (feature as unknown as { binding: Binding }).binding;
    return;
  }
  feature = undefined;
  binding = await createGroupGitHostBinding({
    host,
    connector,
    service: {
      hostRoot: join(host.directory, 'git'),
      gitExecutable: binary,
      githubIdentity: async () => ({
        resolve: async () => ({ token: 'DISPOSABLE', accountId: '42' }),
      }),
      githubWire: async () => {
        wireCalls++;
        throw new Error('No remote network in host binding checks');
      },
    },
  });
}
async function stop() {
  if (feature) await feature.close();
  else binding?.service.close();
  await host?.close();
  await runtime?.close();
  store?.close();
}
const receipt = (id = 'review'): GitReviewReceipt => ({
  id,
  repositoryId,
  sourceOid: tip,
  grantRevision: grant.revision,
  historyGrantId: 'complete-history',
  historyRevision: 'h1',
  historySourceOid: tip,
  historyTargetOid: null,
  approved: true,
});
async function provision() {
  open = await host.create({
    key: randomUUID(),
    projectName: 'Binding fixture',
    displayName: 'Member',
  });
  const owner = await host.authenticatedContext({ handle: open.shared.handle });
  nativeKey = randomUUID();
  const record = host.nativeJournal.prepare(open.shared.handle, {
    key: nativeKey,
    context: owner.context,
    enrollmentHandle: owner.enrollmentHandle,
    text: 'Reviewed shared work',
    intent: 'work',
  });
  nativeContext = host.events.createContext({
    groupId: owner.context.groupId,
    memberId: owner.context.memberId,
    installationId: owner.context.installationId,
    visibility: 'shared',
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
  host.nativeJournal.record(record, {
    requestId: record.request.requestId,
    state: 'completed',
    message: 'Controlled native result; no guest proof asserted',
    result: { context: nativeContext, text: 'Reviewed commit retained', nativeToolItems: 0 },
  });
  ({ repositoryId } = await binding.service.register({
    resourceId: 'resource',
    grantId: 'grant',
    executorId: 'executor',
    endpointId: 'github',
    activeRoot: active,
    mainRef: 'refs/heads/selected',
    endpoint: {
      kind: 'github',
      url: 'https://github.com/owner/repo.git',
      binding: {
        accountId: '42',
        repositoryNumericId: '7',
        repositoryNodeId: 'R_fixture',
        fullName: 'owner/repo',
      },
    },
    limits: { maxFiles: 30, maxTransferBytes: 65536, maxFileBytes: 4096 },
  }));
  grant = {
    id: 'grant',
    revision: 'g1',
    groupId: owner.context.groupId,
    memberId: owner.context.memberId,
    installationId: owner.context.installationId,
    repositoryId,
    resourceId: 'resource',
    endpointId: 'github',
    executorId: 'executor',
    metadata: true,
    paths: { 'shared.txt': 'content', 'only-metadata.txt': 'metadata' },
    active: true,
  };
  await binding.registerResource({
    handle: open.shared.handle,
    repositoryId,
    nativeRequestKey: nativeKey,
    guestRepository: '/workspace/repository',
    grant,
  });
  await binding.approveReview(open.shared.handle, repositoryId, receipt());
}
async function pendingRequest(operationId = 'proposal') {
  const selected = await binding.select(open.shared.handle, repositoryId);
  // Actual native connector independently rejects the fixture's absent admitted
  // native identity/ownership proof. No successful export/capability is mocked.
  await expect(
    selected.propose({
      operationId,
      proposalId: operationId,
      reviewId: 'review',
      historyGrantId: 'complete-history',
    }),
  ).rejects.toThrow();
  expect(wireCalls).toBe(0);
  return binding.service.journal.get<GitNativeExportRequest>(`native-export:${operationId}`)!;
}
beforeEach(async () => {
  identities.clear();
  offline = false;
  wireCalls = 0;
  providerCalls = 0;
  await mkdir('data/group-git-host-binding/tests', { recursive: true });
  root = await realpath(await mkdtemp('data/group-git-host-binding/tests/binding-'));
  active = join(root, 'active');
  await mkdir(active);
  await git(active, 'init', '--template=');
  await git(active, 'config', 'user.name', 'Fixture');
  await git(active, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(active, 'shared.txt'), 'Reviewed shared bytes');
  await git(active, 'add', 'shared.txt');
  await git(active, 'commit', '-m', 'Reviewed');
  tip = await git(active, 'rev-parse', 'HEAD');
  await writeFile(join(active, 'shared.txt'), 'Dirty retained bytes');
  await writeFile(join(active, 'untracked.txt'), 'Untracked retained bytes');
  await writeFile(join(active, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(active, 'ignored.txt'), 'Ignored retained bytes');
  await start();
  await provision();
});
afterEach(async () => {
  await stop();
  expect(providerCalls).toBe(0);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('composes actual saved GroupHost and the same concrete connector once; selects saved branch and grant', async () => {
  const spy = vi.mocked(connector.gitExports);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][0]).toBe(binding.authorizeNativeExport);
  const selected = await binding.select(open.shared.handle, repositoryId);
  expect(selected.selectedBranch).toBe('refs/heads/selected');
  expect(await selected.status()).toMatchObject({
    repositoryId,
    grantRevision: 'g1',
    autoMain: false,
  });
  await expect(
    createGroupGitHostBinding({
      host,
      connector,
      service: { hostRoot: join(root, 'other'), gitExecutable: binary },
    }),
  ).rejects.toThrow('already owns');
  await expect(
    createGroupGitHostBinding({
      host,
      connector: { gitExports: connector.gitExports },
      service: { hostRoot: join(root, 'other'), gitExecutable: binary },
    }),
  ).rejects.toThrow('same concrete');
});

it('binds the actual durable GitService intent to the retained native alias and exact selected content/limits', async () => {
  const request = await pendingRequest();
  expect(request).toMatchObject({
    resourceId: 'resource',
    sourceOid: tip,
    historyRevision: 'h1',
    contentPaths: ['shared.txt'],
    maxObjects: 30,
    maxBytes: 65536,
    maxFileBytes: 4096,
  });
  const authorization = await binding.authorizeNativeExport(request);
  expect(authorization.contextId).toBe(nativeContext.sessionId);
  expect(authorization.contextId).not.toBe(nativeContext.nativeSessionId);
  expect(authorization.guestRepository).toBe('/workspace/repository');
  await authorization.revalidate();
  const mutators: Array<(r: GitNativeExportRequest) => void> = [
    (r) => {
      r.resourceId = 'different';
    },
    (r) => {
      r.repositoryId = randomUUID();
    },
    (r) => {
      r.scope.memberId = groupMemberIdSchema.parse(randomUUID());
    },
    (r) => {
      r.scope.installationId = groupInstallationIdSchema.parse(randomUUID());
    },
    (r) => {
      r.scope.source.sessionId = nativeContext.sessionId;
    },
    (r) => {
      r.scope.source.nativeSessionId = nativeContext.nativeSessionId;
    },
    (r) => {
      r.scope.visibility = 'private';
    },
    (r) => {
      r.scope.source.provider = 'codex';
    },
    (r) => {
      r.grantRevision = 'changed';
    },
    (r) => {
      r.reviewId = 'absent';
    },
    (r) => {
      r.sourceOid = 'a'.repeat(40);
    },
    (r) => {
      r.historyRevision = 'changed';
    },
    (r) => {
      r.contentPaths.push('only-metadata.txt');
    },
    (r) => {
      r.contentPaths = [];
    },
    (r) => {
      r.maxBytes++;
    },
    (r) => {
      r.maxObjects++;
    },
    (r) => {
      r.maxFileBytes++;
    },
    (r) => {
      r.operationId = 'new-operation';
    },
    (r) => {
      r.exportId = randomUUID();
    },
  ];
  for (const mutate of mutators) {
    const changed = structuredClone(request);
    mutate(changed);
    await expect(binding.authorizeNativeExport(changed)).rejects.toThrow();
  }
});

it('rechecks actual host authentication, grants and complete-history receipt on every lease validation', async () => {
  const request = await pendingRequest(),
    authorization = await binding.authorizeNativeExport(request);
  grant = { ...grant, revision: 'g2', paths: { 'shared.txt': 'metadata' } };
  await binding.setPolicy(open.shared.handle, repositoryId, grant);
  await expect(authorization.revalidate()).rejects.toThrow();
  await expect(binding.authorizeNativeExport(request)).rejects.toThrow();
  await expect(
    binding.approveReview(open.shared.handle, repositoryId, {
      ...receipt('invalid'),
      historySourceOid: 'a'.repeat(40),
    }),
  ).rejects.toThrow('entire-history');
  await binding.approveReview(open.shared.handle, repositoryId, receipt('new-review'));
  await binding.setPolicy(open.shared.handle, repositoryId, { ...grant, active: false });
  await expect(binding.select(open.shared.handle, repositoryId)).rejects.toThrow('grant');
});

it('uses real GroupHost revocation/offline checks even for a previously selected consumer', async () => {
  const selected = await binding.select(open.shared.handle, repositoryId);
  offline = true;
  await expect(selected.status()).rejects.toThrow('unavailable');
  offline = false;
  for (const identity of identities.values()) identity.state = 'revoked';
  await expect(selected.status()).rejects.toThrow('revoked');
  await expect(binding.select(open.shared.handle, repositoryId)).rejects.toThrow('revoked');
});

it('rejects a changed authenticated enrollment and never treats local saved membership as sufficient', async () => {
  const selected = await binding.select(open.shared.handle, repositoryId);
  for (const identity of identities.values()) identity.memberId = randomUUID();
  await expect(selected.status()).rejects.toThrow('identity changed');
  expect(wireCalls).toBe(0);
});

it('rejects private/other saved handles, mismatched policy and changed native guest mappings', async () => {
  await expect(binding.select(open.private.handle, repositoryId)).rejects.toThrow('shared handle');
  const other = await host.create({
    key: randomUUID(),
    projectName: 'Other',
    displayName: 'Other',
  });
  await expect(binding.select(other.shared.handle, repositoryId)).rejects.toThrow('shared handle');
  await expect(
    binding.registerResource({
      handle: open.shared.handle,
      repositoryId,
      nativeRequestKey: nativeKey,
      guestRepository: '/workspace/repository',
      grant: { ...grant, resourceId: 'other' },
    }),
  ).rejects.toThrow('exact GroupHost resource');
  for (const path of [
    '/home/owner/repo',
    '/workspace/../repo',
    '/workspace//repo',
    '/workspace/repo/',
    '/workspace/repo\\other',
    '/workspace/repo\n',
  ])
    await expect(
      binding.registerResource({
        handle: open.shared.handle,
        repositoryId,
        nativeRequestKey: nativeKey,
        guestRepository: path,
        grant,
      }),
    ).rejects.toThrow();
  await expect(
    binding.registerResource({
      handle: open.shared.handle,
      repositoryId,
      nativeRequestKey: nativeKey,
      guestRepository: '/workspace/different',
      grant,
    }),
  ).rejects.toThrow('immutable');
  await expect(
    binding.registerResource({
      handle: open.private.handle,
      repositoryId,
      nativeRequestKey: nativeKey,
      guestRepository: '/workspace',
      grant,
    }),
  ).rejects.toThrow('shared owner');
  await expect(
    binding.registerResource({
      handle: open.shared.handle,
      repositoryId,
      nativeRequestKey: randomUUID(),
      guestRepository: '/workspace',
      grant,
    }),
  ).rejects.toThrow('retained native');
});

it('preserves immutable saved reviews and rejects unsaved core receipts as export authorization', async () => {
  await expect(
    binding.approveReview(open.shared.handle, repositoryId, {
      ...receipt(),
      sourceOid: 'b'.repeat(40),
      historySourceOid: 'b'.repeat(40),
    }),
  ).rejects.toThrow('immutable');
  binding.service.authority.review(receipt('core-only'));
  const selected = await binding.select(open.shared.handle, repositoryId);
  await expect(
    selected.propose({
      operationId: 'unsaved',
      proposalId: 'unsaved',
      reviewId: 'core-only',
      historyGrantId: 'complete-history',
    }),
  ).rejects.toThrow('saved resource policy');
  expect(binding.service.journal.get('native-export:unsaved')).toBeNull();
});

it('retains same-ID uncertainty across actual host/connector/service restart and preserves active bytes', async () => {
  const paths = [
    '.git/HEAD',
    '.git/index',
    '.git/config',
    'shared.txt',
    'untracked.txt',
    'ignored.txt',
    '.gitignore',
  ];
  const before = await Promise.all(paths.map((p) => readFile(join(active, p))));
  const request = await pendingRequest();
  await stop();
  await start();
  expect((await binding.authorizeNativeExport(request)).contextId).toBe(nativeContext.sessionId);
  const spy = vi.mocked(connector.gitExports),
    exports = spy.mock.results[0].value;
  const acquire = vi.spyOn(exports, 'acquire'),
    inspect = vi.spyOn(exports, 'inspect');
  const selected = await binding.select(open.shared.handle, repositoryId);
  await expect(
    selected.propose({
      operationId: 'proposal',
      proposalId: 'proposal',
      reviewId: 'review',
      historyGrantId: 'complete-history',
    }),
  ).rejects.toThrow('same-ID inspection');
  expect(acquire).not.toHaveBeenCalled();
  expect(inspect).toHaveBeenCalledExactlyOnceWith(request.exportId);
  expect(binding.service.journal.get('native-export:proposal')).toEqual(request);
  expect(await Promise.all(paths.map((p) => readFile(join(active, p))))).toEqual(before);
  expect(wireCalls).toBe(0);
});

it('normal authenticated Git route uses opaque saved resources, acknowledges exact visibility/refusal retries and preserves dirty copies', async () => {
  await writeFile(
    join(host.directory, 'git-resources.json'),
    JSON.stringify({
      gitExecutable: binary,
      resources: [
        {
          handle: open.shared.handle,
          repositoryId,
          label: 'Selected repository',
          nativeRequestKey: nativeKey,
          guestRepository: '/workspace/repository',
          paths: ['shared.txt', 'only-metadata.txt'],
          reviews: ['review'],
        },
      ],
    }),
    { mode: 0o600 },
  );
  await stop();
  await start(true);
  const app = Fastify();
  registerGroupHostRoutes(
    app,
    host as unknown as GroupHost,
    (request) => request.headers.authorization === 'Owner fixture',
  );
  const send = (command: unknown, handle = open.shared.handle, auth = true) =>
    app.inject({
      method: 'POST',
      url: '/api/groups/git',
      payload: { handle, command },
      headers: auth ? { authorization: 'Owner fixture' } : {},
    });
  try {
    expect((await send({ kind: 'list' }, open.shared.handle, false)).statusCode).toBe(401);
    const listed = await send({ kind: 'list' });
    expect(listed.statusCode, listed.body).toBe(200);
    const resource = listed.json().repositories[0];
    expect(resource.paths[0]).toMatchObject({ name: 'shared.txt' });
    expect(resource.paths[0].id).toMatch(/^path_/);
    const refused = {
      kind: 'intent',
      repositoryId,
      key: randomUUID(),
      paths: [resource.paths[0].id],
    };
    const refusal = await send(refused);
    expect(refusal.statusCode, refusal.body).toBe(200);
    expect(refusal.json().receipt).toMatchObject({ key: refused.key, state: 'refused' });
    expect((await send(refused)).json().receipt).toEqual(refusal.json().receipt);
    const policy = {
      kind: 'policy',
      repositoryId,
      key: randomUUID(),
      visibility: 'content',
      paths: [resource.paths[0].id],
    };
    const applied = await send(policy);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().receipt).toMatchObject({ key: policy.key, state: 'completed' });
    expect((await send(policy)).json().receipt).toEqual(applied.json().receipt);
    expect(binding.service.journal.get<GitGrant>('grant:grant')?.paths).toEqual({
      'shared.txt': 'content',
    });
    expect((await send({ ...policy, visibility: 'private' })).statusCode).toBe(409);
    const privatePolicy = {
      kind: 'policy',
      repositoryId,
      key: randomUUID(),
      visibility: 'private',
      paths: [],
    };
    expect((await send(privatePolicy)).json().receipt.state).toBe('completed');
    expect(binding.service.journal.get<GitGrant>('grant:grant')?.metadata).toBe(false);
    // Simulate the actual cross-database lost completion ACK after A applied:
    // another device selected newer Private B before the original A retry.
    host.db
      .prepare('UPDATE gh_git_commands SET completed=0 WHERE handle=? AND key=?')
      .run(open.shared.handle, policy.key);
    const staleRetry = await send(policy);
    expect(staleRetry.statusCode, staleRetry.body).toBe(200);
    expect(staleRetry.json().receipt.state).toBe('completed');
    expect(binding.service.journal.get<GitGrant>('grant:grant')?.revision).toBe(privatePolicy.key);
    expect(binding.service.journal.get<GitGrant>('grant:grant')?.metadata).toBe(false);

    const savedRequest = host.nativeJournal.prepare(open.shared.handle, {
      key: nativeKey,
      context: open.shared.context,
      enrollmentHandle: open.group.handle,
      text: 'Reviewed shared work',
      intent: 'work',
    }).request.requestId;
    await feature!.beforeWork(nativeContext, savedRequest);
    expect(binding.service.journal.get<number>(`writer:${repositoryId}`)).toBe(1);
    const question = host.nativeJournal.prepare(open.shared.handle, {
      key: randomUUID(),
      context: open.shared.context,
      enrollmentHandle: open.group.handle,
      text: 'What changed?',
      intent: 'ask',
    }).request.requestId;
    await feature!.beforeWork(nativeContext, question);
    expect(binding.service.journal.get<number>(`writer:${repositoryId}`)).toBe(1);

    expect((await send({ kind: 'list' }, open.private.handle)).statusCode).toBe(403);
    expect((await send({ kind: 'status', repositoryId: 'unknown' })).statusCode).toBe(403);
    expect(await readFile(join(active, 'shared.txt'), 'utf8')).toBe('Dirty retained bytes');
    expect(await readFile(join(active, 'untracked.txt'), 'utf8')).toBe('Untracked retained bytes');
    expect(wireCalls).toBe(0);
  } finally {
    await app.close();
  }
});
