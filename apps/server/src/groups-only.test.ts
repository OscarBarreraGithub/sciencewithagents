import { GroupGitHub } from './group-github.js';
import { GroupGitHubAccess } from './group-github-access.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GroupsConversationJournal } from './groups-conversation-journal.js';
import { GroupGitRepository } from './group-git-repository.js';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  renameSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createGroupsServices } from './groups-services.js';
import { createGroupsServer } from './groups-server.js';
import { LocalAccess, prepareLocalAccess, ownerAuthorization } from './local-access.js';
import { PhoneAccess } from './phone-access.js';
import { localRequestProof } from '@dock/shared/dist/local-authorization.js';
import { Store, Conflict } from './store.js';
import { repoRoot } from './paths.js';
import { groupHostOpenSchema } from '@dock/shared/dist/group-host.js';

vi.mock('./runtime.js', () => ({
  Runtime: class {
    constructor() {
      throw new Error('Groups must not instantiate Runtime');
    }
  },
}));
const summary = vi.fn(async () => {
  throw new Error('Model call prohibited');
});
const cleanup: (() => Promise<void>)[] = [];
const base = join(repoRoot, 'data/groups-only-tests');
mkdirSync(base, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(base, 'run-'));
const setup = randomBytes(32).toString('hex');
let worker: ChildProcess | undefined;
let endpoint = '';
async function freePort() {
  const server = netServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
async function startWorker() {
  if (worker && worker.exitCode === null) {
    const ended = new Promise<void>((done) => worker!.once('exit', () => done()));
    worker.kill('SIGTERM');
    await ended;
  }
  const port = await freePort();
  endpoint = `http://127.0.0.1:${port}/`;
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
      join(root, 'worker'),
      '--var',
      'HOSTING_MODE:local-test',
      '--var',
      `GROUP_SETUP_HASH:${createHash('sha256').update(`dock-group-setup-v1:${setup}`).digest('hex')}`,
      '--log-level',
      'error',
    ],
    {
      cwd: join(repoRoot, 'apps/group-service'),
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_LOG_PATH: join(root, 'wrangler.log'),
        XDG_CONFIG_HOME: join(root, 'config'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  worker.stdout?.resume();
  let diagnostic = '';
  worker.stderr?.on('data', (value) => (diagnostic = (diagnostic + String(value)).slice(-6000)));
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (worker.exitCode !== null) throw new Error(`Owned Worker exited: ${diagnostic}`);
    try {
      const response = await fetch(`${endpoint}v1/create`, {
        method: 'POST',
        signal: AbortSignal.timeout(300),
      });
      if ([400, 403].includes(response.status)) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Owned Worker startup timed out');
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  expect(summary).not.toHaveBeenCalled();
});
afterAll(async () => {
  if (worker && worker.exitCode === null) {
    const ended = new Promise<void>((done) => worker!.once('exit', () => done()));
    worker.kill('SIGTERM');
    await ended;
  }
  rmSync(root, { recursive: true, force: true });
});
async function installation(
  existing?: string,
  options: {
    folderPicker?: import('./folder-picker.js').FolderPicker;
    filesFixture?: ConstructorParameters<typeof import('./groups-files.js').GroupsFiles>[3];
  } = {},
) {
  const directory = existing ?? mkdtempSync(join(root, 'install-'));
  const port = await freePort();
  const services = await createGroupsServices(directory, {
    summarize: summary,
    inspectSource: async () => ({
      head: 'a'.repeat(40),
      target: 'a'.repeat(40),
      current: true,
      localChanges: false,
    }),
    filesFixture: options.filesFixture,
  });
  if (!existing)
    writeFileSync(
      join(services.host.directory, 'service.json'),
      JSON.stringify({
        version: 1,
        mode: 'local-test',
        endpoint,
        endpointId: randomUUID(),
        setupCapability: setup,
      }),
      { mode: 0o600 },
    );
  const access = new LocalAccess(prepareLocalAccess(directory, port));
  const app = await createGroupsServer(services, {
    port,
    folderPicker: options.folderPicker,
    localAccess: access,
    phone: new PhoneAccess(services.store, null),
  });
  services.start();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
    await services.close();
  };
  cleanup.push(close);
  const request = (method: 'GET' | 'POST', path: string, payload?: object, authorized = true) => {
    const challenge = randomBytes(32).toString('hex');
    const proof = access.proof({ role: 'owner', challenge });
    return app.inject({
      method,
      url: path,
      headers: {
        host: `127.0.0.1:${port}`,
        origin: access.configuration.origin,
        'content-type': 'application/json',
        ...(authorized
          ? {
              authorization: `Dock owner.${proof.nonce}.${localRequestProof(access.configuration.owner, access.configuration.origin, 'owner', challenge, proof.nonce, method, path)}`,
            }
          : {}),
      },
      payload,
    });
  };
  const post = (action: string, payload: object) =>
    request('POST', `/api/groups/${action}`, payload);
  return { directory, services, app, access, request, post, close };
}
it('boots fresh without Runtime or a provider and preserves owner authentication', async () => {
  const owner = await installation();
  expect((await owner.request('GET', '/api/groups', undefined, false)).statusCode).toBe(401);
  expect((await owner.request('GET', '/api/groups/app-updates', undefined, false)).statusCode).toBe(
    401,
  );
  expect((await owner.request('GET', '/api/groups/app-updates')).json()).toMatchObject({
    branch: 'groups-only',
  });
  expect((await owner.request('GET', '/api/distribution', undefined, false)).json()).toEqual({
    distribution: 'groups-only',
  });
  for (const path of [
    '/api/snapshot',
    '/api/quark',
    '/api/frontdesk',
    '/api/owner-terminal',
    '/api/vscode',
    '/api/app-updates',
  ])
    expect((await owner.request('GET', path)).statusCode).toBe(404);
  expect(owner.services.store.projects()).toEqual([]);
  expect(owner.services.store.runs()).toEqual([]);
  expect(owner.services.store.getSetting('model-policy')).toBeNull();
  expect(existsSync(join(owner.directory, 'groups-conversations.sqlite'))).toBe(false);
  const handoff = await owner.request('POST', '/api/local-access/handoff', {});
  expect(handoff.statusCode).toBe(200);
});
it('creates, joins and delivers human text exactly once, retaining drafts/removal/read-only through reload', async () => {
  await startWorker();
  const creator = await installation();
  const member = await installation();
  const created = await creator.post('create', {
    key: randomUUID(),
    projectName: 'Groups-only fixture',
    displayName: 'Creator',
  });
  expect(created.statusCode).toBe(200);
  const group = groupHostOpenSchema.parse(created.json());
  const invitation = await creator.post('invite', {
    handle: group.group.handle,
    key: randomUUID(),
  });
  const joined = await member.post('join', {
    key: randomUUID(),
    invitation: `http://invitation.invalid/#${invitation.json().fragment}`,
    displayName: 'Member',
  });
  expect(joined.statusCode, joined.body).toBe(200);
  const peer = groupHostOpenSchema.parse(
    (await member.post('open', { handle: joined.json().group.handle })).json(),
  );
  const input = { handle: group.shared.handle, key: randomUUID(), text: 'Only shared human text' };
  const first = await creator.post('send', input);
  expect(first.statusCode).toBe(200);
  expect((await creator.post('send', input)).json()).toEqual(first.json());
  const query = { visibility: 'shared', after: 0, limit: 20, cursor: null };
  const feed = await member.post('feed', { handle: peer.shared.handle, query });
  expect(feed.statusCode).toBe(200);
  expect(JSON.stringify(feed.json())).toContain('Only shared human text');
  const draft = await member.post('draft', {
    handle: peer.shared.handle,
    key: randomUUID(),
    revision: 0,
    text: 'Private unsent draft',
  });
  expect(draft.statusCode).toBe(200);
  expect(
    JSON.stringify((await creator.post('feed', { handle: group.shared.handle, query })).json()),
  ).not.toContain('Private unsent draft');
  const mode = await member.post('local-mode', {
    handle: peer.group.handle,
    key: randomUUID(),
    revision: peer.group.local!.modeRevision,
    mode: 'read-only',
  });
  expect(mode.statusCode).toBe(200);
  expect(
    (await member.post('send', { handle: peer.shared.handle, key: randomUUID(), text: 'Denied' }))
      .statusCode,
  ).toBe(409);
  const hidden = await member.post('local-visibility', {
    handle: peer.group.handle,
    key: randomUUID(),
    revision: peer.group.local!.revision,
    hidden: true,
  });
  expect(hidden.statusCode).toBe(200);
  await member.close();
  const reopened = await installation(member.directory);
  const list = (await reopened.request('GET', '/api/groups')).json();
  expect(list.groups).toHaveLength(0);
  expect(list.removed).toHaveLength(1);
  expect(
    (
      await reopened.post('local-visibility', {
        handle: peer.group.handle,
        key: randomUUID(),
        revision: list.removed[0].local.revision,
        hidden: false,
      })
    ).statusCode,
  ).toBe(200);
  const chat = await reopened.post('chat', { handle: peer.shared.handle });
  expect(JSON.stringify(chat.json())).toContain('Private unsent draft');
}, 30000);
it('reuses full-SWA records without queue recovery or rewriting saved choices', async () => {
  const directory = mkdtempSync(join(root, 'reuse-'));
  const store = new Store(join(directory, 'dock.sqlite'));
  const project = store.register(directory, 'Saved full app', '');
  store.enqueue(project.managerId, randomUUID(), 'Do not run');
  store.setSetting('quark:settings', { enabled: true, marker: 'preserve' });
  store.setSetting('model-policy', { explicit: 'preserve exact saved object' });
  const before = { projects: store.projects(), agents: store.agents(), runs: store.runs() };
  store.close();
  const owner = await installation(directory);
  expect({
    projects: owner.services.store.projects(),
    agents: owner.services.store.agents(),
    runs: owner.services.store.runs(),
  }).toEqual(before);
  expect(owner.services.store.getSetting('quark:settings')).toEqual({
    enabled: true,
    marker: 'preserve',
  });
  expect(owner.services.store.getSetting('model-policy')).toEqual({
    explicit: 'preserve exact saved object',
  });
});
it('actual branch main honors launcher lifetime with no installed provider and no scheduling startup', async () => {
  const directory = mkdtempSync(join(root, 'main-'));
  const port = await freePort();
  const child = spawn(process.execPath, [join(repoRoot, 'apps/server/dist/main.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DOCK_DATA_DIR: directory,
      DOCK_PORT: String(port),
      DOCK_LAUNCHER_LIFETIME: '1',
      DOCK_CODEX_BIN: join(directory, 'missing-codex'),
      DOCK_CLAUDE_BIN: join(directory, 'missing-claude'),
      DOCK_CLUSTER_BOOTSTRAP_FILE: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout!.resume();
  let errors = '';
  child.stderr!.on('data', (value) => (errors += String(value)));
  const ended = new Promise<void>((done) => child.once('exit', () => done()));
  try {
    const end = Date.now() + 10000;
    let connected = false;
    while (Date.now() < end && child.exitCode === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/distribution`);
        if (res.ok) {
          expect(await res.json()).toEqual({ distribution: 'groups-only' });
          connected = true;
          break;
        }
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    expect(connected, errors).toBe(true);
    const auth = await ownerAuthorization(directory, port, 'GET', '/api/groups');
    expect(
      (await fetch(`http://127.0.0.1:${port}/api/groups`, { headers: { authorization: auth! } }))
        .status,
    ).toBe(200);
    child.stdin!.end();
    await ended;
    expect(child.exitCode, errors).toBe(0);
    expect(existsSync(join(directory, 'server.lock'))).toBe(false);
    const store = new Store(join(directory, 'dock.sqlite'));
    expect(store.projects()).toEqual([]);
    expect(store.runs()).toEqual([]);
    store.close();
    expect(readFileSync(join(directory, 'local-access.json'), 'utf8')).toContain('version');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await ended;
    }
  }
}, 20000);

it('identifies Groups before remote phone pairing without exposing group records', async () => {
  const owner = await installation();
  const phone = new PhoneAccess(owner.services.store, {
    origin: 'https://groups.example.com',
    authentication: 'paired',
    port: 4331,
  });
  owner.services.store.setSetting('phone:enabled', true);
  const app = await createGroupsServer(owner.services, { port: 4331, phone, remote: true });
  cleanup.push(() => app.close());
  const headers = { host: 'groups.example.com', origin: 'https://groups.example.com' };
  expect((await app.inject({ url: '/api/distribution', headers })).json()).toEqual({
    distribution: 'groups-only',
  });
  expect((await app.inject({ url: '/api/groups', headers })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        url: '/api/distribution',
        headers: { ...headers, upgrade: 'websocket', connection: 'Upgrade' },
      })
    ).statusCode,
  ).toBe(401);
});

it('continues aggregate cleanup when the optional updater rejects close', async () => {
  const owner = await installation();
  await owner.services.appUpdates!.check();
  const closeStore = vi.spyOn(owner.services.store, 'close');
  const closeHost = vi.spyOn(owner.services.host, 'close');
  const closeFiles = vi.spyOn(owner.services.files, 'close');
  const closeSharing = vi.spyOn(owner.services.sharing, 'close');
  const finishUpdater = owner.services.appUpdates!.close.bind(owner.services.appUpdates);
  vi.spyOn(owner.services.appUpdates!, 'close').mockImplementationOnce(async () => {
    await finishUpdater();
    throw new Error('Updater close failure');
  });
  await expect(owner.services.close()).rejects.toThrow('Groups could not close every service');
  await owner.app.close();
  cleanup.pop();
  expect(closeSharing).toHaveBeenCalled();
  expect(closeFiles).toHaveBeenCalledOnce();
  expect(closeHost).toHaveBeenCalledOnce();
  expect(closeStore).toHaveBeenCalledOnce();
});
it('closes all services after a consumer failure and awaits constructor failure cleanup', async () => {
  const owner = await installation();
  const closeStore = vi.spyOn(owner.services.store, 'close');
  const closeSharing = vi
    .spyOn(owner.services.sharing, 'close')
    .mockRejectedValueOnce(new Error('controlled closure failure'));
  await expect(owner.services.close()).rejects.toThrow('Groups could not close every service');
  await owner.app.close();
  cleanup.pop();
  expect(closeStore).toHaveBeenCalledOnce();
  closeSharing.mockRestore();
  const directory = mkdtempSync(join(root, 'bad-report-'));
  mkdirSync(join(directory, 'groups'), { mode: 0o700 });
  mkdirSync(join(directory, 'groups', 'documents.sqlite'), { mode: 0o700 });
  const storeClose = vi.spyOn(Store.prototype, 'close');
  await expect(createGroupsServices(directory, { summarize: summary })).rejects.toThrow();
  expect(storeClose).toHaveBeenCalled();
  storeClose.mockRestore();
  // The failed constructor released its DB before returning its rejection.
  const store = new Store(join(directory, 'dock.sqlite'));
  expect(store.projects()).toEqual([]);
  store.close();
});

it.each(['no-origin', 'private-access-denied', 'configure-unverified', 'sync-unverified'] as const)(
  'terminal Git refusals retain exact retries and allow a new folder: %s',
  async (failure) => {
    await startWorker();
    const wrong = mkdtempSync(join(root, 'wrong-folder-')),
      valid = mkdtempSync(join(root, 'valid-folder-')),
      remote = join(root, `refusal-remote-${randomUUID()}.git`);
    const exec = promisify(execFile);
    const git = async (args: string[], cwd = valid) =>
      (await exec('git', args, { cwd })).stdout.trim();
    await git(['init', '--bare', '--initial-branch=main', remote]);
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Native refusal fixture']);
    await git(['config', 'user.email', 'fixture@localhost']);
    writeFileSync(join(valid, 'README.md'), 'shared source\n');
    await git(['add', 'README.md']);
    await git(['commit', '-m', 'Shared history']);
    await git(['remote', 'add', 'origin', remote]);
    await git(['push', 'origin', 'main']);
    await git(['clone', remote, wrong]);
    if (failure === 'no-origin') await git(['remote', 'remove', 'origin'], wrong);
    let selectedFolder = wrong,
      denied = failure === 'private-access-denied';
    const verify = vi.fn(async (cwd: string) => {
      if (cwd === wrong && denied) throw new Conflict('Owned fixture private access denied.');
    });
    const options = {
      folderPicker: async () => selectedFolder,
      filesFixture: { localRepository: true as const, verifyPrivateAccess: verify },
    };
    const owner = await installation(undefined, options);
    const created = groupHostOpenSchema.parse(
      (
        await owner.post('create', {
          key: randomUUID(),
          projectName: `Refusal ${failure}`,
          displayName: 'Owner',
        })
      ).json(),
    );
    const pick = await owner.request('POST', '/api/projects/connect-folder', {
      key: randomUUID(),
      selectOnly: true,
    });
    expect(pick.statusCode, pick.body).toBe(200);
    const bound = await owner.post('workspace', {
      action: 'select',
      handle: created.shared.handle,
      key: randomUUID(),
      revision: 0,
      selectionKey: pick.json().selection.key,
    });
    expect(bound.statusCode, bound.body).toBe(200);
    const draft = {
      handle: created.shared.handle,
      key: randomUUID(),
      revision: 0,
      text: 'Keep my private draft through setup repair',
    };
    expect((await owner.post('draft', draft)).statusCode).toBe(200);
    const input = {
      action:
        failure === 'configure-unverified'
          ? 'configure'
          : failure === 'sync-unverified'
            ? 'sync'
            : 'connect',
      handle: created.shared.handle,
      key: randomUUID(),
      ...(failure === 'configure-unverified' ? { githubUsername: 'fixture', autoSync: true } : {}),
    };
    const [refused, concurrentRetry] = await Promise.all([
      owner.post('native-git', input),
      owner.post('native-git', input),
    ]);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(concurrentRetry.statusCode, concurrentRetry.body).toBe(409);
    expect(concurrentRetry.json()).toEqual(refused.json());
    const receipt = owner.services.host.db
      .prepare('SELECT input,result FROM gng_operations WHERE key=?')
      .get(input.key)!;
    expect(JSON.parse(String(receipt.result))).toEqual({
      nativeApprovalRejected: refused.json().error,
    });
    expect(owner.services.host.db.prepare('SELECT count(*) n FROM gng_connections').get()!.n).toBe(
      0,
    );
    expect(owner.services.host.db.prepare('SELECT count(*) n FROM gng_settings').get()!.n).toBe(0);
    expect(existsSync(join(wrong, '.git', 'FETCH_HEAD'))).toBe(false);
    await owner.close();
    // Repairing setup cannot turn the refused UUID into a successful operation.
    if (failure === 'no-origin') await git(['remote', 'add', 'origin', remote], wrong);
    denied = false;
    const reopened = await installation(owner.directory, options);
    expect((await reopened.post('native-git', input)).json()).toEqual(refused.json());
    expect(
      reopened.services.host.db
        .prepare('SELECT input,result FROM gng_operations WHERE key=?')
        .get(input.key),
    ).toEqual(receipt);
    selectedFolder = valid;
    const nextPick = await reopened.request('POST', '/api/projects/connect-folder', {
      key: randomUUID(),
      selectOnly: true,
    });
    expect(nextPick.statusCode, nextPick.body).toBe(200);
    const changed = await reopened.post('workspace', {
      action: 'select',
      handle: created.shared.handle,
      key: randomUUID(),
      revision: bound.json().revision,
      selectionKey: nextPick.json().selection.key,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().workspacePath).toBe(valid);
    expect((await reopened.post('native-git', input)).statusCode).toBe(409);
    const connected = await reopened.post('native-git', {
      action: 'connect',
      handle: created.shared.handle,
      key: randomUUID(),
    });
    expect(connected.statusCode, connected.body).toBe(200);
    expect(connected.json().connected).toBe(true);
    expect((await reopened.post('chat', { handle: created.shared.handle })).json().draft.text).toBe(
      draft.text,
    );
    expect(
      reopened.services.host.db
        .prepare('SELECT input,result FROM gng_operations WHERE key=?')
        .get(input.key),
    ).toEqual(receipt);
  },
  30000,
);

it('rejects Git requests when shutdown begins without reserving an operation', async () => {
  const owner = await installation();
  const files = owner.services.files,
    close = files.close.bind(files);
  const guard = vi.spyOn(files, 'close').mockImplementationOnce(async () => {
    const stopping = close();
    await expect(
      files.request({ action: 'connect', handle: randomUUID(), key: randomUUID() }),
    ).rejects.toThrow('File sharing is closing');
    expect(owner.services.host.db.prepare('SELECT count(*) n FROM gng_operations').get()!.n).toBe(
      0,
    );
    await stopping;
  });
  try {
    await owner.close();
    expect(guard).toHaveBeenCalledOnce();
  } finally {
    guard.mockRestore();
  }
});

it('thin Groups selects the native folder and publishes only exact owner-approved checkpoints without checkout changes', async () => {
  await startWorker();
  const project = mkdtempSync(join(root, 'project-')),
    remote = join(root, `remote-${randomUUID()}.git`);
  const exec = promisify(execFile);
  const git = async (args: string[], cwd = project) =>
    (await exec('git', args, { cwd })).stdout.trim();
  await git(['init', '--bare', '--initial-branch=main', remote]);
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Native fixture']);
  await git(['config', 'user.email', 'fixture@localhost']);
  writeFileSync(join(project, 'README.md'), 'initial shared source\n');
  await git(['add', 'README.md']);
  await git(['commit', '-m', 'Initial shared history']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', 'origin', 'main']);
  const verify = vi.fn(async (cwd: string, origin: string) => {
    expect(cwd).toBe(project);
    expect(origin).toBe(remote);
  });
  const owner = await installation(undefined, {
    folderPicker: async () => project,
    filesFixture: { localRepository: true, verifyPrivateAccess: verify },
  });
  const created = groupHostOpenSchema.parse(
    (
      await owner.post('create', {
        key: randomUUID(),
        projectName: 'File fixture',
        displayName: 'Owner',
      })
    ).json(),
  );
  const journal = new GroupsConversationJournal(owner.directory),
    sessionId = randomUUID();
  journal.registerSession(sessionId, project);
  const selected = journal.select({ handle: created.group.handle, sessionId, key: randomUUID() });
  journal.close();
  const pick = await owner.request('POST', '/api/projects/connect-folder', {
    key: randomUUID(),
    selectOnly: true,
  });
  expect(pick.statusCode, pick.body).toBe(200);
  expect(owner.services.store.projects()).toEqual([]);
  const binding = {
    action: 'select',
    handle: created.shared.handle,
    key: randomUUID(),
    revision: 0,
    selectionKey: pick.json().selection.key,
  };
  const attached = await owner.post('workspace', binding);
  expect(attached.statusCode, attached.body).toBe(200);
  expect(attached.json().workspacePath).toBe(project);
  expect((await owner.post('workspace', binding)).json()).toEqual(attached.json());
  const connected = await owner.post('native-git', {
    action: 'connect',
    handle: created.shared.handle,
    key: randomUUID(),
  });
  expect(connected.statusCode, connected.body).toBe(200);
  expect(connected.json().autoSync).toBe(true);
  expect(verify).toHaveBeenCalled();
  writeFileSync(join(project, 'result.tex'), 'Reviewed scientific result\n');
  await git(['add', 'result.tex']);
  await git(['commit', '-m', 'Share selected result']);
  const head = await git(['rev-parse', 'HEAD']);
  const proposal = { action: 'propose', handle: created.shared.handle, key: randomUUID(), head };
  const folderProof = new GroupsConversationJournal(owner.directory);
  folderProof.registerSession(sessionId, owner.directory);
  folderProof.close();
  expect((await owner.post('files', proposal)).statusCode).toBe(409);
  const correctedProof = new GroupsConversationJournal(owner.directory);
  correctedProof.registerSession(sessionId, project);
  correctedProof.close();
  expect(
    (
      await owner.post('local-mode', {
        handle: created.group.handle,
        key: randomUUID(),
        revision: created.group.local!.modeRevision,
        mode: 'read-only',
      })
    ).statusCode,
  ).toBe(200);
  expect((await owner.post('files', proposal)).statusCode).toBe(409);
  expect(
    (
      await owner.post('local-mode', {
        handle: created.group.handle,
        key: randomUUID(),
        revision: created.group.local!.modeRevision + 1,
        mode: 'contribute',
      })
    ).statusCode,
  ).toBe(200);

  expect((await owner.post('files', proposal)).statusCode).toBe(200);
  const previewReply = await owner.post('files', {
    action: 'preview',
    handle: created.shared.handle,
    id: proposal.key,
  });
  expect(previewReply.statusCode, previewReply.body).toBe(200);
  const preview = previewReply.json().preview;
  expect(preview.patch).toContain('Share selected result');
  expect(preview.files).toContain('result.tex');
  writeFileSync(join(project, 'later.txt'), 'not approved\n');
  await git(['add', 'later.txt']);
  await git(['commit', '-m', 'Later private checkpoint']);
  writeFileSync(join(project, 'unsent.txt'), 'dirty native files stay here\n');
  const localHead = await git(['rev-parse', 'HEAD']),
    localStatus = await git(['status', '--porcelain']);
  const approval = {
    action: 'approve',
    handle: created.shared.handle,
    key: randomUUID(),
    id: proposal.key,
    fingerprint: preview.fingerprint,
  };
  expect((await owner.post('files', approval)).statusCode).toBe(409);
  const ticket = owner.access.issueHandoff(),
    cookie = owner.access.consumeHandoff(ticket.ticket).split(';')[0];
  const browserOrigin = owner.access.browserOrigin;
  const human = async (action: string, payload: object) =>
    owner.app.inject({
      method: 'POST',
      url: `/api/groups/${action}`,
      headers: {
        host: new URL(browserOrigin).host,
        origin: browserOrigin,
        'content-type': 'application/json',
        cookie,
      },
      payload,
    });
  const approved = await human('files', approval);
  expect(approved.statusCode, approved.body).toBe(200);
  expect(approved.json().proposals[0].state).toBe('shared');
  expect((await human('files', approval)).json()).toEqual(approved.json());
  expect(await git(['rev-parse', 'HEAD'])).toBe(localHead);
  expect(await git(['status', '--porcelain'])).toBe(localStatus);
  expect(await git(['rev-parse', 'refs/heads/main'], remote)).toBe(head);
  expect(await git(['show', `${head}:result.tex`], remote)).toContain('Reviewed scientific result');
  expect(
    (
      await owner.post('native-git', {
        action: 'sync',
        handle: created.shared.handle,
        key: randomUUID(),
      })
    ).statusCode,
  ).toBe(200);
  expect(await git(['rev-parse', 'HEAD'])).toBe(localHead);
  expect(await git(['status', '--porcelain'])).toBe(localStatus);
  const uncertain = { action: 'sync', handle: created.shared.handle, key: randomUUID() };
  const fetchDefault = GroupGitRepository.prototype.fetchDefault;
  const fetchFailure = vi
    .spyOn(GroupGitRepository.prototype, 'fetchDefault')
    .mockImplementationOnce(async function (this: GroupGitRepository, workspace, repo) {
      await fetchDefault.call(this, workspace, repo);
      throw new Conflict('Owned fixture lost the result after an actual fetch.');
    });
  try {
    const failed = await owner.post('native-git', uncertain);
    expect(failed.statusCode, failed.body).toBe(503);
    expect(failed.json().code).toBe('GROUP_GIT_OPERATION_UNCERTAIN');
  } finally {
    fetchFailure.mockRestore();
  }
  const pendingOperation = owner.services.host.db
    .prepare('SELECT input,result FROM gng_operations WHERE key=?')
    .get(uncertain.key)!;
  expect(pendingOperation.result).toBeNull();
  verify.mockImplementationOnce(async () => {
    throw new Conflict('Owned fixture temporarily lost private access before retry.');
  });
  expect((await owner.post('native-git', uncertain)).statusCode).toBe(503);
  expect(
    owner.services.host.db
      .prepare('SELECT input,result FROM gng_operations WHERE key=?')
      .get(uncertain.key),
  ).toEqual(pendingOperation);
  const held = await owner.post('workspace', {
    ...binding,
    key: randomUUID(),
    revision: attached.json().revision,
  });
  expect(held.statusCode, held.body).toBe(409);
  expect(held.json().error).toContain('Recover the original saved Git operation');
  expect((await owner.post('native-git', uncertain)).statusCode).toBe(200);
  expect(
    owner.services.host.db
      .prepare('SELECT input FROM gng_operations WHERE key=?')
      .get(uncertain.key)!.input,
  ).toBe(pendingOperation.input);
  expect(await git(['rev-parse', 'HEAD'])).toBe(localHead);
  expect(await git(['status', '--porcelain'])).toBe(localStatus);
  const second = { ...proposal, key: randomUUID(), head: localHead };
  expect((await owner.post('files', second)).statusCode).toBe(200);
  const stopped = new GroupsConversationJournal(owner.directory);
  stopped.stop({
    handle: created.group.handle,
    key: randomUUID(),
    generation: selected.generation,
  });
  const stoppedGeneration = stopped.selection(created.group.handle)!.generation;
  stopped.close();
  const inspection = await owner.post('files', { action: 'status', handle: created.shared.handle });
  expect(inspection.statusCode, inspection.body).toBe(200);
  expect(inspection.json().proposals.some((p: { state: string }) => p.state === 'shared')).toBe(
    true,
  );
  expect(
    (
      await owner.post('files', {
        action: 'preview',
        handle: created.shared.handle,
        id: proposal.key,
      })
    ).json().preview.head,
  ).toBe(head);
  const currentGroup = (await owner.post('open', { handle: created.group.handle })).json().group;
  expect(
    (
      await owner.post('local-mode', {
        handle: created.group.handle,
        key: randomUUID(),
        revision: currentGroup.local.modeRevision,
        mode: 'read-only',
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await owner.post('files', { action: 'status', handle: created.shared.handle })).statusCode,
  ).toBe(200);
  expect(
    (
      await owner.post('local-mode', {
        handle: created.group.handle,
        key: randomUUID(),
        revision: currentGroup.local.modeRevision + 1,
        mode: 'contribute',
      })
    ).statusCode,
  ).toBe(200);

  expect(
    (await human('files', { ...approval, key: randomUUID(), id: second.key })).statusCode,
  ).toBe(409);
  expect(
    (
      await owner.post('native-git', {
        action: 'confirm-external-closed',
        handle: created.shared.handle,
        key: randomUUID(),
        generation: selected.generation,
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await human('native-git', {
        action: 'confirm-external-closed',
        handle: created.shared.handle,
        key: randomUUID(),
        generation: stoppedGeneration,
      })
    ).statusCode,
  ).toBe(200);
  await owner.close();
  const reopened = await installation(owner.directory, {
    filesFixture: { localRepository: true, verifyPrivateAccess: verify },
  });
  expect(
    (await reopened.post('workspace', { action: 'status', handle: created.shared.handle })).json()
      .revision,
  ).toBe(1);
  expect(
    (await reopened.post('native-git', { action: 'status', handle: created.shared.handle })).json()
      .connected,
  ).toBe(true);
}, 30000);

it('missing or invalid native folder observations invalidate files without disrupting selected summary journaling', async () => {
  const owner = await installation(),
    sessionId = randomUUID();
  const journal = new GroupsConversationJournal(owner.directory);
  journal.registerSession(sessionId, owner.directory);
  const handle = randomUUID();
  journal.select({ handle, sessionId, key: randomUUID() });
  expect(journal.sessionFolder(sessionId)?.cwd).toBe(owner.directory);
  journal.registerSession(sessionId);
  expect(journal.sessionFolder(sessionId)).toBeNull();
  journal.observe(sessionId, 'UserPromptSubmit', 'A selected prompt');
  journal.observe(sessionId, 'Stop', 'A selected final reply');
  expect(journal.jobs().some((job) => job.handle === handle)).toBe(true);
  journal.registerSession(sessionId, owner.directory);
  expect(journal.sessionFolder(sessionId)).not.toBeNull();
  journal.registerSession(sessionId, join(owner.directory, 'missing-native-folder'));
  expect(journal.sessionFolder(sessionId)).toBeNull();
  expect(Number(journal.db.prepare('SELECT count(*) n FROM gc_session_folders').get()!.n)).toBe(4);
  journal.close();
});

it('shares authenticated GitHub profiles across independent enrollments with exact retry and creator-only repo metadata', async () => {
  await startWorker();
  const a = await installation(),
    b = await installation();
  const created = groupHostOpenSchema.parse(
    (
      await a.post('create', {
        key: randomUUID(),
        projectName: 'GitHub metadata',
        displayName: 'Creator',
      })
    ).json(),
  );
  const invitation = (
    await a.post('invite', { key: randomUUID(), handle: created.group.handle })
  ).json();
  const joined = (
    await b.post('join', {
      key: randomUUID(),
      invitation: `http://invitation.invalid/#${invitation.fragment}`,
      displayName: 'Member',
    })
  ).json();
  const member = groupHostOpenSchema.parse(
    (await b.post('open', { handle: joined.group.handle })).json(),
  );
  let intendedRepository = 'owner/repo';
  const git = async () => ({
    available: true,
    connected: true,
    repository: `https://github.com/${intendedRepository}`,
    workspacePath: null,
    branch: 'main',
    githubUsername: '',
    autoSync: false,
    dirty: false,
    busy: false,
    message: '',
    tasks: [],
    preview: null,
  });
  const access = () =>
    new GroupGitHubAccess(async ([path]) =>
      path === 'user'
        ? { login: 'Owner' }
        : ['repos/owner/repo', 'repos/owner/other'].includes(path)
          ? { full_name: path.slice('repos/'.length), private: true, permissions: { push: true } }
          : path.includes('collaborators')
            ? [{ login: 'creator-gh' }]
            : [{ invitee: { login: 'member-gh' }, expired: false }],
    );
  const ga = new GroupGitHub(a.services.host, git, access()),
    gb = new GroupGitHub(b.services.host, git, access());
  await ga.request({ action: 'repository', handle: created.shared.handle, key: randomUUID() });
  await ga.request({
    action: 'profile',
    handle: created.shared.handle,
    key: randomUUID(),
    username: 'creator-gh',
  });
  const key = randomUUID();
  const publication = vi
    .spyOn(b.services.host, 'publishFeatureEvent')
    .mockRejectedValueOnce(new Error('lost profile reply'));
  const pending = await gb.request({
    action: 'profile',
    handle: member.shared.handle,
    key,
    username: 'member-gh',
  });
  expect(pending.pending).toHaveLength(1);
  await gb.request({ action: 'retry', handle: member.shared.handle, key });
  publication.mockRestore();
  const result = await ga.request({ action: 'check', handle: created.shared.handle });
  expect(result.members.find((m) => m.memberId === member.member.memberId)).toMatchObject({
    username: 'member-gh',
    status: 'Invitation pending',
  });
  expect(result.members.find((m) => m.memberId === created.member.memberId)).toMatchObject({
    username: 'creator-gh',
    status: 'Access confirmed',
  });
  await b.services.host.send({
    handle: member.shared.handle,
    key: randomUUID(),
    text: JSON.stringify({
      kind: 'swa-github-profile-v1',
      username: 'spoof',
      memberId: created.member.memberId,
    }),
  });
  await b.services.host.publishFeatureEvent(
    member.shared.handle,
    `spoof-${randomUUID()}`,
    JSON.stringify({ kind: 'swa-github-repository-v1', repository: 'evil/repo' }),
    'GitHub onboarding · Private repository evil/repo',
  );
  const received = await gb.request({ action: 'status', handle: member.shared.handle });
  expect(received.repository).toBe('owner/repo');
  await gb.request({
    action: 'profile',
    handle: member.shared.handle,
    key: randomUUID(),
    username: 'missing-gh',
  });
  const absent = await ga.request({ action: 'check', handle: created.shared.handle });
  expect(absent.members.find((m) => m.memberId === member.member.memberId)?.status).toBe(
    'No access',
  );
  const unavailable = new GroupGitHub(
    a.services.host,
    git,
    new GroupGitHubAccess(async () => {
      throw new Error('auth unavailable');
    }),
  );
  const unknown = await unavailable.request({ action: 'check', handle: created.shared.handle });
  expect(unknown.members.every((m) => m.status === 'Not checked')).toBe(true);

  expect(received.members.find((m) => m.memberId === created.member.memberId)?.username).toBe(
    'creator-gh',
  );
  const repositoryKey = randomUUID();
  const hold = vi
    .spyOn(a.services.host, 'publishFeatureEvent')
    .mockRejectedValueOnce(new Error('held repo announcement'));
  await ga.request({ action: 'repository', handle: created.shared.handle, key: repositoryKey });
  hold.mockRestore();
  intendedRepository = 'owner/other';
  await expect(
    ga.request({ action: 'repository', handle: created.shared.handle, key: repositoryKey }),
  ).rejects.toMatchObject({ code: 'GROUP_GITHUB_REPOSITORY_PRECONDITION' });
  expect(
    JSON.parse(
      String(
        a.services.host.db
          .prepare('SELECT input FROM gh_github_intents WHERE key=?')
          .get(repositoryKey)!.input,
      ),
    ).repository,
  ).toBe('owner/repo');
  const authenticated = a.services.host.authenticatedContext.bind(a.services.host);
  const originals: string[] = [];
  let failOriginal = true;
  const intercept = vi
    .spyOn(a.services.host, 'authenticatedContext')
    .mockImplementation(async (raw) => {
      const reader = await authenticated(raw);
      return {
        ...reader,
        original: async (eventId) => {
          originals.push(eventId);
          if (failOriginal) {
            failOriginal = false;
            throw new Error('original temporarily unavailable');
          }
          return reader.original(eventId);
        },
      };
    });
  const incomplete = await ga.request({
    action: 'repository',
    handle: created.shared.handle,
    key: randomUUID(),
  });
  expect(incomplete.complete).toBe(false);
  expect(incomplete.members.every((m) => m.status === 'Not checked')).toBe(true);
  expect(incomplete.checkedAt).toBeNull();
  expect(incomplete.message).toContain('incomplete');
  const recoveredMetadata = await ga.request({ action: 'check', handle: created.shared.handle });
  expect(recoveredMetadata.complete).toBe(true);
  expect(recoveredMetadata.repository).toBe('owner/other');
  expect(originals[1]).toBe(originals[0]);
  intercept.mockRestore();
  expect(a.services.store.runs()).toHaveLength(0);
  expect(b.services.store.runs()).toHaveLength(0);
}, 20000);

it('a moved selected folder gives a definitive typed refusal while hosted creation remains retained', async () => {
  await startWorker();
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'swa-folder-refusal-')));
  cleanup.push(async () => rmSync(temporary, { recursive: true, force: true }));
  const folder = join(temporary, 'project');
  mkdirSync(folder);
  const owner = await installation(undefined, { folderPicker: async () => folder });
  const createKey = randomUUID();
  const created = groupHostOpenSchema.parse(
    (
      await owner.post('create', {
        key: createKey,
        projectName: 'Created before folder refusal',
        displayName: 'Owner',
      })
    ).json(),
  );
  const pick = await owner.request('POST', '/api/projects/connect-folder', {
    key: randomUUID(),
    selectOnly: true,
  });
  expect(pick.statusCode, pick.body).toBe(200);
  renameSync(folder, `${folder}-moved`);
  const refusal = await owner.post('workspace', {
    action: 'select',
    handle: created.shared.handle,
    key: randomUUID(),
    revision: 0,
    selectionKey: pick.json().selection.key,
  });
  expect(refusal.statusCode).toBe(409);
  expect(refusal.json().code).toBe('GROUP_FOLDER_BINDING_REFUSED');
  expect(
    groupHostOpenSchema.parse(
      (
        await owner.post('create', {
          key: createKey,
          projectName: 'Created before folder refusal',
          displayName: 'Owner',
        })
      ).json(),
    ).group.id,
  ).toBe(created.group.id);
  expect(
    (
      await owner.post('create', {
        key: randomUUID(),
        projectName: 'Next intended group',
        displayName: 'Owner',
      })
    ).statusCode,
  ).toBe(200);
});
