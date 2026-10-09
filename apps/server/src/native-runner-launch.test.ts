import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { nativeRunnerStartReceiptSchema, type NativeRunnerStart } from '@dock/shared';
import { localRequestProof } from '@dock/shared/dist/local-authorization.js';
import { Store } from './store.js';
import { ModelPolicy } from './model-policy.js';
import { FolderBrowser } from './folder-browser.js';
import { NativeConnections, nativeConnectionLimits } from './native-connections.js';
import { NativeRunnerLaunch } from './native-runner-launch.js';
import {
  nativeRunnerArguments,
  NativeRunnerCliDriver,
  NativeRunnerNotStarted,
  type NativeRunnerDriver,
  type CreatedNativeRunner,
} from './native-runner-driver.js';
import type { NativeConnectionProfile } from './native-connections-config.js';
import { repoRoot } from './paths.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { proxyPath } from './hosts.js';
import { phoneEntryOptions } from './entry-options.js';

const latch = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
let root: string,
  store: Store,
  browser: FolderBrowser,
  native: NativeConnections,
  launch: NativeRunnerLaunch,
  policy: ModelPolicy;
let profiles: NativeConnectionProfile[], input: NativeRunnerStart, driver: NativeRunnerDriver;
let effect: () => Promise<void>;
let created: CreatedNativeRunner | undefined;
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/native-launch-'));
  mkdirSync(join(root, 'private'));
  mkdirSync(join(root, 'Work folder'));
  store = new Store(join(root, 'private/dock.sqlite'));
  browser = new FolderBrowser(join(root, 'private'), root);
  profiles = [
    { id: randomUUID(), label: 'Local fixture', kind: 'tmux', socket: join(root, 'fixture.sock') },
  ];
  native = new NativeConnections(
    store,
    root,
    {
      discover: async () => ({
        state: 'available',
        message: '',
        targets: created ? [created] : [],
      }),
      open: vi.fn(),
      submit: vi.fn(),
    },
    () => profiles,
  );
  policy = new ModelPolicy(
    store,
    vi.fn(async (provider) => [
      {
        id: provider === 'codex' ? 'gpt-6-astra' : 'claude-opus-5-5',
        label: 'Policy model',
        isDefault: true,
        efforts: ['low', 'high', 'xhigh'],
      },
      {
        id: provider === 'codex' ? 'gpt-6-luna' : 'claude-haiku-4-5',
        label: 'Explicit light model',
        isDefault: false,
        efforts: ['low', 'high'],
      },
    ]),
  );
  effect = async () => {};
  created = undefined;
  driver = {
    source: vi.fn(async () => ({ available: true, message: 'tmux fixture' })),
    provider: vi.fn(async () => ({
      installed: true,
      version: 'Fixture native CLI',
      message: 'Fixture metadata only',
    })),
    prepare: vi.fn(async (profile, folder, nonce, resolution) => ({
      profile,
      nonce,
      tmux: { path: '/fixture/tmux', identity: 'fixture' },
      provider: { path: '/fixture/provider', identity: 'fixture' },
      socket: null,
      args: nativeRunnerArguments(profile, folder, nonce, resolution, '/fixture/provider'),
    })),
    create: vi.fn(async ({ nonce }) => {
      await effect();
      created = {
        proof: {
          generation: 'private-socket-generation',
          session: '$0',
          pane: '%0',
          pid: 42,
          started: 'native-start',
          serverTime: '1',
          sessionCreated: '2',
          panePid: '43',
        },
        view: {
          kind: 'tmux',
          label: `swa-${nonce}`,
          canObserve: true,
          canControl: true,
          controller: 'unknown',
          controlPolicy: 'shared',
          nativeStatus: 'unknown',
        },
      };
      return created;
    }),
  };
  launch = new NativeRunnerLaunch(store, native, policy, driver, () => profiles);
  input = {
    key: randomUUID(),
    folderId: (await browser.browse()).folders[0]!.id,
    sourceId: profiles[0]!.id,
    provider: 'codex',
    choice: { mode: 'native' },
  };
});
afterEach(async () => {
  await launch.close();
  native.close();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
it('starts only the issued folder/source and retains exact creation identity without registering a project or agent', async () => {
  const result = await launch.start(input, browser);
  expect(result.state).toBe('created');
  expect(result.resolution.model).toBeNull();
  expect(result.resolution.effort).toBeNull();
  expect(driver.prepare).toHaveBeenCalledExactlyOnceWith(
    profiles[0],
    join(root, 'Work folder'),
    expect.any(String),
    result.resolution,
  );
  expect(driver.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      profile: profiles[0],
      args: expect.arrayContaining([join(root, 'Work folder')]),
    }),
  );
  expect((await native.list()).targets[0]!.id).toBe(result.targetId);
  expect(await launch.start(input, new FolderBrowser(join(root, 'private')))).toEqual(result);
  expect(() => launch.start({ ...input, provider: 'claude' }, browser)).toThrow('different input');
  expect(store.projects()).toEqual([]);
  expect(store.agents()).toEqual([]);
  expect(store.runs()).toEqual([]);
  expect(JSON.stringify((await launch.options()).starts)).not.toContain(root);
  expect(() =>
    launch.start({ ...input, key: randomUUID(), command: 'untrusted shell', path: root }, browser),
  ).toThrow();
});
it('retains uncertain lost creation ACK across restart and never replays, even after folder IDs and source config expire', async () => {
  effect = async () => {
    throw new Error('native creation ACK lost');
  };
  const result = await launch.start(input, browser);
  expect(result.state).toBe('uncertain');
  await launch.close();
  native.close();
  store.close();
  store = new Store(join(root, 'private/dock.sqlite'));
  profiles = [];
  native = new NativeConnections(store, root, undefined, () => []);
  launch = new NativeRunnerLaunch(store, native, policy, driver, () => [], false);
  expect(await launch.start(input, new FolderBrowser(join(root, 'private')))).toEqual(result);
  expect(launch.read(input.key)).toEqual(result);
  expect((await launch.options()).starts).toEqual([result]);
  expect(driver.create).toHaveBeenCalledOnce();
});
it('deduplicates concurrent/late exact starts and lets an attempted native creation settle during app close', async () => {
  const held = latch();
  effect = () => held.promise;
  const start = launch.start(input, browser);
  await vi.waitFor(() => expect(driver.create).toHaveBeenCalledOnce());
  expect((await launch.start(input, browser)).state).toBe('uncertain');
  expect(launch.activeCount()).toBe(1);
  const closing = launch.close();
  held.release();
  const result = await start;
  await closing;
  expect(result.state).toBe('created');
  expect(launch.activeCount()).toBe(0);
  expect(await launch.start(input, browser)).toEqual(result);
  expect(driver.create).toHaveBeenCalledOnce();
});
it('reserves creation plus issued-target completion before handoff, completes at the full fence, and refuses new starts without effects', async () => {
  const held = latch();
  effect = () => held.promise;
  const start = launch.start(input, browser);
  await vi.waitFor(() => expect(driver.create).toHaveBeenCalledOnce());
  const charge = (store.db.prepare('SELECT used FROM nc_budget').get() as { used: number }).used;
  expect(charge).toBe(
    2 * Buffer.byteLength(JSON.stringify(input)) +
      Buffer.byteLength(
        (store.db.prepare('SELECT folder FROM nc_starts').get() as { folder: string }).folder,
      ) +
      2048 +
      2 * nativeConnectionLimits.receiptReserve,
  );
  store.db.prepare('UPDATE nc_budget SET used=?').run(nativeConnectionLimits.journalBytes);
  held.release();
  const receipt = await start;
  expect(receipt.state).toBe('created');
  expect(store.db.prepare('SELECT id FROM nc_targets').get()).toEqual({ id: receipt.targetId });
  await expect(launch.start({ ...input, key: randomUUID() }, browser)).rejects.toThrow('full');
  expect(driver.create).toHaveBeenCalledOnce();
  expect(await launch.start(input, browser)).toEqual(receipt);
  expect(store.db.prepare('SELECT used FROM nc_budget').get()).toEqual({
    used: nativeConnectionLimits.journalBytes,
  });
});
it('keeps the original uncertain receipt after a final local write fault without a phantom target or a second creation', async () => {
  store.db.exec(
    `CREATE TRIGGER fail_native_creation BEFORE UPDATE ON nc_starts WHEN NEW.body LIKE '%"created"%' BEGIN SELECT RAISE(ABORT,'fixture final fault'); END`,
  );
  await expect(launch.start(input, browser)).rejects.toThrow('fixture final fault');
  expect(launch.read(input.key).state).toBe('uncertain');
  expect(store.db.prepare('SELECT proof FROM nc_starts').get()).toEqual({ proof: null });
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM nc_targets').get()).toEqual({ n: 0 });
  expect((await launch.start(input, browser)).state).toBe('uncertain');
  expect(driver.create).toHaveBeenCalledOnce();
});
const localCli = (root: string) => {
  const tmux = join(root, 'fixture-tmux'),
    provider = join(root, 'fixture-provider'),
    shim = join(root, 'provider-shim');
  writeFileSync(
    tmux,
    `#!/bin/sh\nif [ "$1" = '-V' ]; then printf '%s\\n' 'tmux 3.6a'; exit; fi\nprintf '%s\\n' "$*" >> '${root}/native-mutations'\nexit 1\n`,
    { mode: 0o700 },
  );
  writeFileSync(provider, '#!/bin/sh\nprintf "%s\\n" "${0##*/}"\n', { mode: 0o700 });
  symlinkSync(provider, shim);
  return {
    profile: { ...profiles[0]!, binary: tmux },
    cli: new NativeRunnerCliDriver({ codex: shim, claude: shim }),
    shim,
  };
};
it('records an executable that disappears after preparation as not_started and exact same-key inspection never retries', async () => {
  const { profile, cli, shim } = localCli(root);
  profiles = [profile];
  const original = cli.create.bind(cli);
  const create = vi.spyOn(cli, 'create').mockImplementation(async (prepared) => {
    expect(prepared.provider.path).toBe(shim); // Keep the version-manager shim filename/argv0.
    expect(Object.isFrozen(prepared.args)).toBe(true);
    rmSync(shim);
    return original(prepared);
  });
  expect((await cli.provider('codex')).version).toBe('provider-shim');
  launch = new NativeRunnerLaunch(store, native, policy, cli, () => profiles);
  const receipt = await launch.start(input, browser);
  expect(receipt.state).toBe('not_started');
  expect(receipt.message).toContain('disappeared');
  expect(await launch.start(input, new FolderBrowser(join(root, 'private')))).toEqual(receipt);
  expect(create).toHaveBeenCalledOnce();
  expect(existsSync(join(root, 'native-mutations'))).toBe(false);
});
it('rejects an unverifiable existing socket before mutation and records only a small final not_started receipt', async () => {
  const { profile, cli } = localCli(root);
  profiles = [profile];
  writeFileSync(profile.socket, 'unverifiable stale socket');
  launch = new NativeRunnerLaunch(store, native, policy, cli, () => profiles);
  const create = vi.spyOn(cli, 'create');
  const receipt = await launch.start(input, browser);
  expect(receipt.state).toBe('not_started');
  expect(receipt.message).toContain('socket or server identity');
  expect(await launch.start(input, browser)).toEqual(receipt);
  expect(create).not.toHaveBeenCalled();
  expect(existsSync(join(root, 'native-mutations'))).toBe(false);
  expect(
    (store.db.prepare('SELECT used FROM nc_budget').get() as { used: number }).used,
  ).toBeLessThan(2 * nativeConnectionLimits.receiptReserve);
});
it('keeps a failed/lost new-session acknowledgement uncertain once the mutation executable spawned', async () => {
  const { profile, cli } = localCli(root);
  profiles = [profile];
  launch = new NativeRunnerLaunch(store, native, policy, cli, () => profiles);
  const receipt = await launch.start(input, browser);
  expect(receipt.state).toBe('uncertain');
  expect(readFileSync(join(root, 'native-mutations'), 'utf8')).toContain('new-session');
  expect(await launch.start(input, browser)).toEqual(receipt);
  expect(readFileSync(join(root, 'native-mutations'), 'utf8').trim().split('\n')).toHaveLength(1);
});
it('classifies synchronous native dispatch validation failures as not_started before any process spawned', async () => {
  const { profile, cli } = localCli(root);
  const prepared = await cli.prepare(
    profile,
    join(root, 'Work folder'),
    randomUUID(),
    await policy.resolveNativeLaunch('codex', { mode: 'native' }),
  );
  await expect(cli.create({ ...prepared, args: ['\0'] })).rejects.toBeInstanceOf(
    NativeRunnerNotStarted,
  );
  expect(existsSync(join(root, 'native-mutations'))).toBe(false);
});
it('retains typed pre-dispatch refusals distinctly from uncertain creation failures', async () => {
  vi.mocked(driver.create).mockRejectedValue(
    new NativeRunnerNotStarted('Prepared socket changed. Nothing was started.'),
  );
  const receipt = await launch.start(input, browser);
  expect(receipt.state).toBe('not_started');
  expect(await launch.start(input, browser)).toEqual(receipt);
  expect(driver.create).toHaveBeenCalledOnce();
});
it('records a folder replacement before effect as not_started and never uses the replacement folder', async () => {
  const verify = browser.verifyNativeSelection.bind(browser);
  vi.spyOn(browser, 'verifyNativeSelection').mockImplementation(async (saved) => {
    renameSync(join(root, 'Work folder'), join(root, 'Old folder'));
    mkdirSync(join(root, 'Work folder'));
    return verify(saved);
  });
  expect((await launch.start(input, browser)).state).toBe('not_started');
  expect(driver.create).not.toHaveBeenCalled();
  expect((await launch.start(input, browser)).state).toBe('not_started');
});
it('rejects expired/home folder IDs, unsupported sources and missing native providers before durable native effects', async () => {
  await expect(
    launch.start({ ...input, key: randomUUID(), folderId: randomUUID() }, browser),
  ).rejects.toThrow('expired');
  await expect(
    launch.start(
      { ...input, key: randomUUID(), folderId: (await browser.browse()).current.id },
      browser,
    ),
  ).rejects.toThrow('entire home');
  profiles[0]!.sshAlias = 'trusted-remote';
  await expect(launch.start(input, browser)).rejects.toThrow('local tmux');
  delete profiles[0]!.sshAlias;
  vi.mocked(driver.provider).mockResolvedValue({
    installed: false,
    version: '',
    message: 'Native provider missing',
  });
  await expect(launch.start(input, browser)).rejects.toThrow('missing');
  expect(driver.create).not.toHaveBeenCalled();
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM nc_starts').get()).toEqual({ n: 0 });
});
it('fences config changes both before admission and after native handoff without retargeting a later source', async () => {
  const source = driver.source;
  driver.source = vi.fn(async (profile) => {
    const result = await source(profile);
    profiles = [{ ...profile, socket: join(root, 'replacement.sock') }];
    return result;
  });
  await expect(launch.start(input, browser)).rejects.toThrow('source changed');
  expect(driver.create).not.toHaveBeenCalled();
  driver.source = source;
  effect = async () => {
    profiles = [{ ...profiles[0]!, socket: join(root, 'third.sock') }];
  };
  expect((await launch.start(input, browser)).state).toBe('uncertain');
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM nc_targets').get()).toEqual({ n: 0 });
});
it('keeps native and exact provider/model choices independent of managed routing while policy uses central defaults', async () => {
  expect(await policy.resolveNativeLaunch('claude', { mode: 'native' })).toMatchObject({
    provider: 'claude',
    model: null,
    effort: null,
  });
  const exact = await policy.resolveNativeLaunch('claude', {
    mode: 'exact',
    model: 'claude-haiku-4-5',
    effort: 'low',
  });
  expect(exact).toMatchObject({ provider: 'claude', model: 'claude-haiku-4-5', effort: 'low' });
  expect(await policy.resolveNativeLaunch('codex', { mode: 'policy' })).toMatchObject({
    provider: 'codex',
    model: 'gpt-6-astra',
  });
  await expect(policy.resolveNativeLaunch('claude', { mode: 'policy' })).rejects.toThrow(
    'no fable model',
  );
  await expect(
    policy.resolveNativeLaunch('claude', { mode: 'exact', model: 'invented' }),
  ).rejects.toThrow('available');
  await expect(
    policy.resolveNativeLaunch('claude', {
      mode: 'exact',
      model: 'claude-haiku-4-5',
      effort: 'max',
    }),
  ).rejects.toThrow('available');
});
it('builds fixed multi-argv native commands with no prompt, shell, permission, plugin or account override', async () => {
  const nativeChoice = await policy.resolveNativeLaunch('claude', { mode: 'native' });
  const args = nativeRunnerArguments(
    profiles[0]!,
    "/fixture/space ' folder",
    input.key,
    nativeChoice,
    '/fixture/native-claude',
  );
  expect(args.slice(0, 5)).toEqual(['-S', profiles[0]!.socket, 'new-session', '-d', '-P']);
  expect(args).toContain("/fixture/space ' folder");
  expect(args.slice(args.indexOf('--'))).toEqual([
    '--',
    '/usr/bin/env',
    ...[
      'CLAUDECODE',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_SESSION_ATTENDED',
      'CLAUDE_PID',
      'CLAUDE_CODE_SSE_PORT',
    ].flatMap((name) => ['-u', name]),
    '/fixture/native-claude',
  ]);
  expect(args).not.toContain('-f');
  expect(args).not.toContain('-p');
  const exact = await policy.resolveNativeLaunch('codex', {
    mode: 'exact',
    model: 'gpt-6-luna',
    effort: 'low',
  });
  expect(
    nativeRunnerArguments(profiles[0]!, '/fixture', input.key, exact, '/fixture/codex').slice(-4),
  ).toEqual(['/fixture/codex', '--model=gpt-6-luna', '--config', 'model_reasoning_effort="low"']);
});
it('caps pending preflight launches, cancels cleanly before effect on app close, and does not probe disabled fixture providers', async () => {
  const held = latch();
  vi.mocked(driver.source).mockImplementation(async () => {
    await held.promise;
    return { available: true, message: '' };
  });
  const attempts = Array.from({ length: nativeConnectionLimits.active }, () =>
    launch.start({ ...input, key: randomUUID() }, browser),
  );
  expect(() => launch.start({ ...input, key: randomUUID() }, browser)).toThrow(
    'still being inspected',
  );
  const closed = launch.close();
  held.release();
  await Promise.all(attempts.map((attempt) => expect(attempt).rejects.toThrow('stopping')));
  await closed;
  expect(driver.create).not.toHaveBeenCalled();
  vi.clearAllMocks();
  launch = new NativeRunnerLaunch(store, native, policy, driver, () => profiles, false);
  expect((await launch.options()).sources).toEqual([]);
  expect(driver.provider).not.toHaveBeenCalled();
});
it('enforces actual owner auth, exact typed routes and paired-host allowlists with no provider turn', async () => {
  const receipt = await launch.start(input, browser);
  const access = new LocalAccess(prepareLocalAccess(root, 4998));
  const providerTurn = vi.fn(async () => {
    throw new Error('No real provider');
  });
  const runtime = new Runtime(store, join(root, 'private'), 'fixture-unavailable', providerTurn);
  const app = await createServer(store, runtime, {
    port: 4998,
    localAccess: access,
    nativeConnections: native,
    nativeRunnerLaunch: launch,
    ownsRuntime: false,
  });
  const headers = (method: string, path: string, role: 'owner' | 'bridge' = 'owner') => {
    const challenge = randomBytes(32).toString('hex'),
      proof = access.proof({ role, challenge });
    return {
      host: '127.0.0.1:4998',
      origin: 'http://127.0.0.1:4998',
      authorization: `Dock ${role}.${proof.nonce}.${localRequestProof(access.configuration[role], 'http://127.0.0.1:4998', role, challenge, proof.nonce, method, path)}`,
    };
  };
  try {
    const options = '/api/native-connections/launch-options',
      start = '/api/native-connections/start',
      read = `/api/native-connections/starts/${input.key}`;
    expect((await app.inject({ url: options })).statusCode).toBe(403);
    expect(
      (await app.inject({ url: options, headers: headers('GET', options, 'bridge') })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: options, headers: headers('GET', options) })).json().starts,
    ).toContainEqual(receipt);
    expect(
      nativeRunnerStartReceiptSchema.parse(
        (
          await app.inject({
            method: 'POST',
            url: start,
            headers: headers('POST', start),
            payload: input,
          })
        ).json(),
      ),
    ).toEqual(receipt);
    expect((await app.inject({ url: read, headers: headers('GET', read) })).json()).toEqual(
      receipt,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: start,
          headers: headers('POST', start),
          payload: { ...input, command: 'rm anything' },
        })
      ).statusCode,
    ).toBe(400);
    expect(proxyPath('GET', '/native-connections/launch-options')).toBe(options);
    expect(proxyPath('GET', '/project-folders')).toBe('/api/project-folders');
    expect(proxyPath('GET', `/project-folders?folderId=${input.folderId}&offset=0`)).toBe(
      `/api/project-folders?folderId=${input.folderId}&offset=0`,
    );
    expect(proxyPath('GET', '/project-folders?path=/untrusted')).toBeNull();
    expect(proxyPath('POST', '/native-connections/start')).toBe(start);
    expect(proxyPath('GET', `/native-connections/starts/${input.key}`)).toBe(read);
    expect(proxyPath('POST', `/native-connections/starts/${input.key}`)).toBeNull();
    expect(proxyPath('GET', `/native-connections/starts/${input.key}?command=anything`)).toBeNull();
    expect(proxyPath('POST', '/native-connections/start', true)).toBeNull();
    expect(
      phoneEntryOptions({ nativeRunnerLaunch: launch } as Parameters<typeof phoneEntryOptions>[0], {
        port: 4997,
      }).nativeRunnerLaunch,
    ).toBe(launch);
    expect(driver.create).toHaveBeenCalledOnce();
    expect(providerTurn).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await runtime.close();
  }
});
