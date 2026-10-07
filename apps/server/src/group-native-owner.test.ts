import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import Fastify from 'fastify';
import { GroupNativeOwner } from './group-native-owner.js';
import type { GroupNativeConnector } from './group-native-connector.js';
import type { GroupNativeExecution } from './group-native-execution.js';
import type { GroupHostFeatureContext } from './group-host-context.js';
import { GroupHost } from './group-host.js';
import { registerGroupHostRoutes } from './group-host-routes.js';
import {
  saveGroupNativeOwnerConfig,
  loadGroupNativeOwnerConfig,
  type GroupNativeOwnerConfig,
} from './group-native-owner-config.js';
import { groupNativeOwnerInputSchema } from '@dock/shared/dist/group-native-owner.js';
import type { Runtime } from './runtime.js';
import * as nativeConnector from './group-native-connector.js';
import { createProductionGroupHost } from './group-host-bootstrap.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(provider: 'codex' | 'claude' = 'codex') {
  const directory = mkdtempSync(join(tmpdir(), 'native-owner-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let authenticated = false;
  const execution = {
    provider,
    admissionId: randomUUID(),
    canRestartDeviceSignIn: vi.fn(() => provider === 'codex'),
    restartDeviceSignIn: vi.fn(async () => ({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'RETRY-TRANSIENT',
    })),
    authentication: vi.fn(async () => (authenticated ? 'authenticated' : 'signed-out')),
    beginDeviceSignIn: vi.fn(async () => ({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'TRANSIENT-ONLY',
    })),
    ownerClaudeLogin: vi.fn(() => ({
      executable: '/trusted/docker',
      args: ['exec', 'owned-container', '/usr/local/bin/claude', 'auth', 'login', '--claudeai'],
    })),
    acceptanceToolTurn: vi.fn(async () => ({ toolReceiptVerified: true, nativeToolItems: 1 })),
    startDescendantCanary: vi.fn(),
    explicitStopCanary: vi.fn(async () => ({ stopped: true })),
    crashStopCanary: vi.fn(async () => ({ stopped: true })),
    close: vi.fn(async () => {}),
  };
  const approve = vi.fn(() => ({
    reviewId: randomUUID(),
    image: `sha256:${'3'.repeat(64)}`,
    provider,
    scope: 'linux-guest-tools' as const,
  }));
  const context = {
    groupId: randomUUID(),
    memberId: randomUUID(),
    installationId: randomUUID(),
    visibility: 'private' as const,
    provider: 'owner' as const,
    sessionId: randomUUID(),
    nativeSessionId: randomUUID(),
  };
  const scope = {
    handle: randomUUID(),
    enrollmentHandle: randomUUID(),
    context,
    enrollment: {},
    revalidate: vi.fn(async () => {}),
    readShared: vi.fn(),
    original: vi.fn(),
  } as unknown as GroupHostFeatureContext;
  const connector = {
    availability: vi.fn(async () => ({
      available: true,
      productionReady: false,
      authState: 'per-context' as const,
      message: 'Needs actual acceptance',
    })),
    ownerAcceptance: vi.fn(() => ({
      context: { ...context, provider },
      runId: randomUUID(),
      admitted: Promise.resolve(execution as unknown as GroupNativeExecution),
      approve,
    })),
    inspect: vi.fn(async ({ requestId }: { requestId: string }) => ({
      requestId,
      state: 'pending-consent' as const,
      message: 'Saved original request',
    })),
    canRecoverPendingConsent: vi.fn(() => true),
    recoverPendingConsent: vi.fn(async ({ requestId }: { requestId: string }) => ({
      requestId,
      state: 'queued' as const,
      message: 'Same request reconnecting',
    })),
    ownerExecution: vi.fn(() => execution as unknown as GroupNativeExecution),
    continueAfterConsent: vi.fn(async ({} = {}) => ({
      requestId: randomUUID(),
      state: 'running' as const,
      message: 'Same request',
    })),
    close: vi.fn(async () => {}),
    submit: vi.fn(),
  } as unknown as GroupNativeConnector;
  const config: GroupNativeOwnerConfig = {
    reviewedCommit: 'a'.repeat(40),
    route: {
      projectId: randomUUID(),
      provider,
      image: `sha256:${'3'.repeat(64)}`,
      resources: {
        workspace: null,
        stateBase: join(directory, 'state'),
        readResources: [],
        forbiddenPaths: ['/private-owner-home'],
        outbound: [{ host: 'auth.openai.com', ports: [443] }],
      },
    },
  };
  const terminal = vi.fn(() => randomUUID());
  const owner = new GroupNativeOwner(directory, connector, config, terminal);
  let closed = false;
  cleanup.push(async () => {
    if (!closed) await owner.close();
  });
  const call = (action: string, rest: object = {}) =>
    owner.control(
      scope,
      {
        action,
        handle: scope.handle,
        ...(action === 'status' ? {} : { key: randomUUID() }),
        ...rest,
      },
      true,
    );
  return {
    directory,
    owner,
    scope,
    connector,
    execution,
    config,
    approve,
    terminal,
    call,
    authenticate: () => {
      authenticated = true;
    },
    close: async () => {
      await owner.close();
      closed = true;
    },
  };
}

it('retains one acceptance identity, transient sign-in, exact retries and pinned real-check approval', async () => {
  const f = fixture();
  const key = randomUUID();
  const queued = await f.call('prepare', { key });
  await tick();
  await f.call('prepare', { key });
  expect(f.connector.ownerAcceptance).toHaveBeenCalledTimes(1);
  expect((await f.call('status')).setupId).toBe(queued.setupId);
  const signKey = randomUUID();
  expect((await f.call('sign-in', { key: signKey })).device?.userCode).toBe('TRANSIENT-ONLY');
  expect((await f.call('sign-in', { key: signKey })).device?.userCode).toBe('TRANSIENT-ONLY');
  expect(f.execution.beginDeviceSignIn).toHaveBeenCalledTimes(1);
  for (const name of readdirSync(f.directory))
    expect(readFileSync(join(f.directory, name)).includes(Buffer.from('TRANSIENT-ONLY'))).toBe(
      false,
    );
  f.authenticate();
  expect((await f.call('status')).state).toBe('authenticated');
  const toolKey = randomUUID();
  await f.call('verify-tools', { key: toolKey });
  await tick();
  await f.call('verify-tools', { key: toolKey });
  expect(f.execution.acceptanceToolTurn).toHaveBeenCalledTimes(1);
  await f.call('verify-stop', { kind: 'crash' });
  await tick();
  expect(f.execution.crashStopCanary).toHaveBeenCalledTimes(1);
  await f.call('approve');
  expect(f.approve).toHaveBeenCalledWith('a'.repeat(40));
  await expect(f.call('verify-stop', { key: toolKey, kind: 'explicit' })).rejects.toThrow(
    'retry changed',
  );
});

it('continues the original consent-bound request once and never creates a new handoff', async () => {
  const f = fixture();
  const requestId = randomUUID();
  const key = randomUUID();
  await expect(f.call('continue', { requestId, key })).rejects.toThrow('authorization first');
  f.authenticate();
  await f.call('continue', { requestId, key: randomUUID() });
  const anotherKey = randomUUID();
  await f.call('continue', { requestId, key: anotherKey });
  await f.call('continue', { requestId, key: anotherKey });
  expect(f.connector.continueAfterConsent).toHaveBeenCalledWith(requestId);
  expect(f.connector.continueAfterConsent).toHaveBeenCalledTimes(1);
  expect(f.connector.ownerAcceptance).not.toHaveBeenCalled();
  expect(f.connector.submit).not.toHaveBeenCalled();
});

it('lost host capabilities remain unknown after restart without sign-in or model replay', async () => {
  const f = fixture();
  await f.call('prepare');
  await tick();
  await f.close();
  const next = new GroupNativeOwner(f.directory, f.connector, f.config);
  cleanup.push(() => next.close());
  const status = await next.control(f.scope, { handle: f.scope.handle, action: 'status' }, true);
  expect(status.state).toBe('unknown');
  await next.control(
    f.scope,
    { handle: f.scope.handle, action: 'prepare', key: randomUUID() },
    true,
  );
  expect(f.connector.ownerAcceptance).toHaveBeenCalledTimes(1);
  expect(f.execution.beginDeviceSignIn).not.toHaveBeenCalled();
});

it('rejection persists and fixed Claude login accepts no browser command', async () => {
  const f = fixture('claude');
  await f.call('prepare');
  await tick();
  const signed = await f.call('sign-in');
  expect(signed.terminalId).toBeTruthy();
  expect(f.terminal).toHaveBeenCalledWith(
    expect.any(String),
    f.execution.ownerClaudeLogin.mock.results[0]!.value,
  );
  await f.call('reject');
  expect((await f.call('status')).state).toBe('rejected');
  expect(f.execution.close).toHaveBeenCalledTimes(1);
  expect(
    groupNativeOwnerInputSchema.safeParse({
      action: 'sign-in',
      handle: f.scope.handle,
      key: randomUUID(),
      command: 'anything',
    }).success,
  ).toBe(false);
});

it('retained request sign-in follows its actual native provider after host configuration changes', async () => {
  const f = fixture('claude');
  f.config.route.provider = 'codex';
  const requestId = randomUUID();
  expect((await f.call('status', { requestId })).provider).toBe('claude');
  expect((await f.call('sign-in', { requestId })).terminalId).toBeTruthy();
  expect(f.execution.beginDeviceSignIn).not.toHaveBeenCalled();
  expect(f.terminal).toHaveBeenCalledTimes(1);
});

it('deduplicates unchanged status and cools down recent retries without a lifetime request lockout', async () => {
  let now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = fixture();
  await f.call('prepare');
  await tick();
  await f.call('status');
  const db = new DatabaseSync(join(f.directory, 'native-owner.sqlite'));
  try {
    const before = db.prepare('SELECT count(*) AS n FROM gno_receipts').get()!.n;
    for (let i = 0; i < 20; i++) await f.call('status');
    expect(db.prepare('SELECT count(*) AS n FROM gno_receipts').get()!.n).toBe(before);
    const requestId = randomUUID();
    await f.call('sign-in', { requestId });
    expect((await f.call('status', { requestId })).canRetrySignIn).toBe(true);
    const key = randomUUID();
    expect((await f.call('restart-sign-in', { requestId, key })).device?.userCode).toBe(
      'RETRY-TRANSIENT',
    );
    await f.call('restart-sign-in', { requestId, key });
    expect(f.execution.restartDeviceSignIn).toHaveBeenCalledTimes(1);
    await f.call('restart-sign-in', { requestId });
    await f.call('restart-sign-in', { requestId });
    expect((await f.call('status', { requestId })).canRetrySignIn).toBe(false);
    await expect(f.call('restart-sign-in', { requestId })).rejects.toThrow('within one minute');
    expect(db.prepare('SELECT count(*) AS n FROM gno_signin_retries').get()!.n).toBe(3);
    const retained = db
      .prepare('SELECT key,binding,attempted_at FROM gno_signin_retries ORDER BY key')
      .all();
    now += 59_999;
    expect((await f.call('status', { requestId })).canRetrySignIn).toBe(false);
    now += 1;
    expect((await f.call('status', { requestId })).canRetrySignIn).toBe(true);
    await f.call('restart-sign-in', { requestId });
    expect(f.execution.restartDeviceSignIn).toHaveBeenCalledTimes(4);
    expect(db.prepare('SELECT count(*) AS n FROM gno_signin_retries').get()!.n).toBe(4);
    for (const attempt of retained)
      expect(
        db
          .prepare('SELECT key,binding,attempted_at FROM gno_signin_retries WHERE key=?')
          .get(String(attempt.key)),
      ).toEqual(attempt);
    await f.call('restart-sign-in', { requestId, key });
    expect(f.execution.restartDeviceSignIn).toHaveBeenCalledTimes(4);
    expect(
      new Set(
        db
          .prepare('SELECT binding FROM gno_signin_retries')
          .all()
          .map((row) => row.binding),
      ),
    ).toEqual(new Set([requestId]));
    expect(f.connector.submit).not.toHaveBeenCalled();
    expect(f.connector.continueAfterConsent).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it('preserves legacy timestamp-less retry evidence without permanently blocking its saved request', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const f = fixture();
  const requestId = randomUUID();
  await f.call('sign-in', { requestId });
  await f.close();
  const db = new DatabaseSync(join(f.directory, 'native-owner.sqlite'));
  const keys = [randomUUID(), randomUUID(), randomUUID()];
  db.exec(
    'DROP TABLE gno_signin_retries; CREATE TABLE gno_signin_retries(key TEXT PRIMARY KEY,binding TEXT NOT NULL)',
  );
  for (const key of keys)
    db.prepare('INSERT INTO gno_signin_retries VALUES (?,?)').run(key, requestId);
  db.close();
  const owner = new GroupNativeOwner(f.directory, f.connector, f.config, f.terminal);
  cleanup.push(() => owner.close());
  const call = (action: 'status' | 'restart-sign-in') =>
    owner.control(
      f.scope,
      {
        action,
        handle: f.scope.handle,
        requestId,
        ...(action === 'status' ? {} : { key: randomUUID() }),
      },
      true,
    );
  expect((await call('status')).canRetrySignIn).toBe(true);
  await call('restart-sign-in');
  const retained = new DatabaseSync(join(f.directory, 'native-owner.sqlite'));
  try {
    expect(retained.prepare('SELECT count(*) AS n FROM gno_signin_retries').get()!.n).toBe(4);
    for (const key of keys)
      expect(
        retained
          .prepare('SELECT binding,attempted_at FROM gno_signin_retries WHERE key=?')
          .get(key),
      ).toMatchObject({ binding: requestId, attempted_at: 0 });
  } finally {
    retained.close();
  }
  expect(f.execution.restartDeviceSignIn).toHaveBeenCalledTimes(1);
  expect(f.connector.submit).not.toHaveBeenCalled();
  expect(f.connector.continueAfterConsent).not.toHaveBeenCalled();
});

it('explicit owner reconnect uses only the exact saved host request and denies declined or submitted authority', async () => {
  const f = fixture();
  const requestId = randomUUID();
  vi.mocked(f.connector.ownerExecution).mockReturnValue(null);
  vi.mocked(f.connector.inspect).mockResolvedValue({
    requestId,
    state: 'unknown',
    message: 'Restarted before model input',
  });
  expect((await f.call('status', { requestId })).canReconnect).toBe(true);
  await expect(f.call('reconnect', { requestId })).rejects.toThrow('Exact retained owner request');
  const input = { action: 'reconnect', handle: f.scope.handle, requestId, key: randomUUID() };
  const retained = {
    requestId,
    key: randomUUID(),
    context: f.scope.context,
    enrollmentHandle: f.scope.enrollmentHandle,
    text: 'Original saved request',
  };
  const call = () => f.owner.control(f.scope, input, true, retained);
  expect((await call()).state).toBe('checking');
  await call();
  expect(f.connector.recoverPendingConsent).toHaveBeenCalledExactlyOnceWith(retained);
  expect(f.connector.submit).not.toHaveBeenCalled();
  expect(f.connector.continueAfterConsent).not.toHaveBeenCalled();
  // A decline intent survives restart even when the old execution is gone.
  const db = new DatabaseSync(join(f.directory, 'native-owner.sqlite'));
  db.prepare('INSERT INTO gno_operations VALUES (?,?)').run(
    randomUUID(),
    JSON.stringify({ action: 'reject', requestId }),
  );
  db.close();
  expect((await f.call('status', { requestId })).canReconnect).toBe(false);
  await expect(
    f.owner.control(f.scope, { ...input, key: randomUUID() }, true, retained),
  ).rejects.toThrow('declined');
});

it('normal host reconnect reopens blocked receipt inspection with the retained original, never native resubmission', async () => {
  const f = fixture();
  const host = new GroupHost(f.directory, {
    native: {
      availability: () => ({ available: true, message: 'Fixture only' }),
      submit: vi.fn(),
      inspect: vi.fn(),
      owner: f.owner,
    },
  });
  cleanup.push(() => host.close());
  Object.defineProperty(host, 'authenticatedContext', { value: async () => f.scope });
  const record = host.nativeJournal.prepare(f.scope.handle, {
    key: randomUUID(),
    text: 'Exact saved original',
    context: f.scope.context,
    enrollmentHandle: f.scope.enrollmentHandle,
  });
  host.nativeJournal.mark(record, {
    state: 'blocked',
    message: 'Old namespace closed before consent',
  });
  vi.mocked(f.connector.ownerExecution).mockReturnValue(null);
  vi.mocked(f.connector.inspect).mockResolvedValue({
    requestId: record.request.requestId,
    state: 'blocked',
    message: 'Previous runtime stopped',
  });
  const input = {
    action: 'reconnect',
    handle: f.scope.handle,
    requestId: record.request.requestId,
    key: randomUUID(),
  };
  await host.nativeOwnerControl(input);
  expect(f.connector.recoverPendingConsent).toHaveBeenCalledExactlyOnceWith(record.request);
  const retained = host.nativeJournal.get(f.scope.handle, record.request.key)!;
  expect(retained.request).toEqual(record.request);
  expect(retained.receipt.state).toBe('unknown');
  expect(host.native.submit).not.toHaveBeenCalled();
  expect(f.connector.continueAfterConsent).not.toHaveBeenCalled();
});

it('a recovered Claude admission can explicitly sign in again without borrowing the lost old terminal', async () => {
  const f = fixture('claude');
  const requestId = randomUUID();
  const first = await f.call('sign-in', { requestId });
  expect(first.terminalId).toBeTruthy();
  await f.close();
  f.execution.admissionId = randomUUID();
  const terminal = vi.fn(() => randomUUID());
  const owner = new GroupNativeOwner(f.directory, f.connector, f.config, terminal);
  cleanup.push(() => owner.close());
  const result = await owner.control(
    f.scope,
    {
      action: 'sign-in',
      handle: f.scope.handle,
      requestId,
      key: randomUUID(),
    },
    true,
  );
  expect(result.terminalId).toBeTruthy();
  expect(result.terminalId).not.toBe(first.terminalId);
  expect(terminal).toHaveBeenCalledTimes(1);
  const db = new DatabaseSync(join(f.directory, 'native-owner.sqlite'));
  expect(db.prepare('SELECT count(*) AS n FROM gno_signins').get()!.n).toBe(2);
  db.close();
  expect(f.connector.submit).not.toHaveBeenCalled();
  expect(f.connector.continueAfterConsent).not.toHaveBeenCalled();
});

it('a proved reconnected admission can continue once while earlier continuation receipts remain retained', async () => {
  const f = fixture();
  const requestId = randomUUID();
  f.authenticate();
  await f.call('continue', { requestId });
  // The connector supplies a distinct run only after its immutable pre-input
  // recovery proof and actual owned-stop boundary, never from browser input.
  f.execution.admissionId = randomUUID();
  await f.call('continue', { requestId });
  await f.call('continue', { requestId });
  expect(f.connector.continueAfterConsent).toHaveBeenCalledTimes(2);
  const db = new DatabaseSync(join(f.directory, 'native-owner.sqlite'));
  expect(db.prepare('SELECT count(*) AS n FROM gno_continuations').get()!.n).toBe(2);
  db.close();
  expect(f.connector.submit).not.toHaveBeenCalled();
});

it.each(['running', 'unknown'] as const)(
  'cannot restart sign-in for a %s native request or replay its model input',
  async (state) => {
    const f = fixture();
    const requestId = randomUUID();
    vi.mocked(f.connector.inspect).mockResolvedValue({
      requestId,
      state,
      message: 'Inspect retained native work',
    });
    await expect(f.call('restart-sign-in', { requestId })).rejects.toThrow(
      'not awaiting retained native consent',
    );
    expect(f.execution.restartDeviceSignIn).not.toHaveBeenCalled();
    expect(f.connector.submit).not.toHaveBeenCalled();
    expect(f.connector.continueAfterConsent).not.toHaveBeenCalled();
  },
);

it('owner HTTP rejects unauthenticated callers and allows paired owner with opaque request-scope validation', async () => {
  const f = fixture();
  const host = new GroupHost(f.directory, {
    native: {
      availability: () => ({ available: true, message: 'Fixture only' }),
      submit: vi.fn(),
      inspect: vi.fn(),
      owner: f.owner,
    },
  });
  cleanup.push(() => host.close());
  Object.defineProperty(host, 'authenticatedContext', { value: async () => f.scope });
  const app = Fastify();
  cleanup.push(() => app.close());
  registerGroupHostRoutes(app, host, (request) => request.headers.authorization === 'paired-owner');
  const body = { action: 'status', handle: f.scope.handle };
  expect(
    (await app.inject({ method: 'POST', url: '/api/groups/native-owner', payload: body }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/groups/native-owner',
        headers: { authorization: 'paired-owner' },
        payload: body,
      })
    ).statusCode,
  ).toBe(200);
  const wrong = await app.inject({
    method: 'POST',
    url: '/api/groups/native-owner',
    headers: { authorization: 'paired-owner' },
    payload: { ...body, requestId: randomUUID() },
  });
  expect(wrong.statusCode).toBe(404);
  expect(f.connector.ownerExecution).not.toHaveBeenCalled();
});

it('setup-agent registration validates private config and production startup applies the exact route', () => {
  const f = fixture();
  const source = join(f.directory, 'source.json');
  writeFileSync(source, JSON.stringify(f.config), { mode: 0o600 });
  const root = join(f.directory, 'installation');
  saveGroupNativeOwnerConfig(root, source);
  const runtime = { store: { project: vi.fn(), setSetting: vi.fn() } } as unknown as Runtime;
  expect(loadGroupNativeOwnerConfig(root, runtime)?.reviewedCommit).toBe(f.config.reviewedCommit);
  expect(runtime.store.setSetting).toHaveBeenCalledWith('group:native-route', {
    ...f.config.route,
    resources: {
      ...f.config.route.resources,
      stateBase: realpathSync(f.config.route.resources.stateBase),
    },
  });
  chmodSync(source, 0o644);
  expect(() => saveGroupNativeOwnerConfig(root, source)).toThrow('Private');
  const link = join(f.directory, 'linked.json');
  symlinkSync(source, link);
  expect(() => saveGroupNativeOwnerConfig(root, link)).toThrow();
});

it('a malformed private route fails closed for native readiness while preserving the human Groups host', async () => {
  const f = fixture();
  const directory = join(f.directory, 'groups');
  const seed = new GroupHost(f.directory);
  await seed.close();
  writeFileSync(join(directory, 'native-route.json'), '{"unsupported":true}', { mode: 0o600 });
  vi.spyOn(nativeConnector, 'createGroupNativeConnector').mockReturnValue(f.connector);
  vi.mocked(f.connector.availability).mockResolvedValue({
    available: true,
    productionReady: true,
    authState: 'per-context',
    message: 'Prior unrelated route',
  });
  const host = createProductionGroupHost(f.directory, {} as Runtime);
  cleanup.push(() => host.close());
  const status = await host.native.availability();
  expect(status.available).toBe(false);
  expect(status.productionReady).toBe(false);
  expect(status.message).toContain('human Groups messages remain available');
  expect(
    (await host.native.owner!.control(f.scope, { action: 'status', handle: f.scope.handle }, true))
      .productionReady,
  ).toBe(false);
  expect(host.db.prepare('SELECT count(*) AS n FROM gh_groups').get()?.n).toBe(0);
  expect(f.connector.submit).not.toHaveBeenCalled();
});
