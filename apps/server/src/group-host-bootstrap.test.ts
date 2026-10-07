import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { GroupContext } from '@dock/shared';
import { localRequestProof } from '@dock/shared/dist/local-authorization.js';
import { groupHostNativeStatusSchema } from '@dock/shared/dist/group-host.js';
import { createProductionGroupHost } from './group-host-bootstrap.js';
import { createGroupNativeConnector } from './group-native-connector.js';
import type { GroupNativeSnapshot } from './group-host-native.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';
import { createServer } from './server.js';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { repoRoot } from './paths.js';

vi.mock('./group-native-connector.js', async (original) => {
  const actual = await original<typeof import('./group-native-connector.js')>();
  return { ...actual, createGroupNativeConnector: vi.fn(actual.createGroupNativeConnector) };
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function installation(directory?: string) {
  if (!directory) {
    const base = join(repoRoot, 'data', 'group-host-bootstrap');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    directory = mkdtempSync(join(base, 'test-'));
    const owned = directory;
    cleanup.push(async () => rmSync(owned, { recursive: true, force: true }));
  }
  const store = new Store(join(directory, 'dock.sqlite'));
  const provider = vi.fn(async () => {
    throw new Error('Real provider launch prohibited in bootstrap checks');
  });
  const runtime = new Runtime(store, directory, 'never-native', provider);
  const host = createProductionGroupHost(directory, runtime, undefined, {
    executionMode: 'isolated',
  });
  expect(createGroupNativeConnector).toHaveBeenLastCalledWith(runtime, {
    directory: host.directory,
    events: host.events,
  });
  // inject() binds no listener. This port identifies the normal owner-auth origin only.
  const port = 41387;
  const access = new LocalAccess(prepareLocalAccess(directory, port));
  const app = await createServer(store, runtime, {
    port,
    localAccess: access,
    groupHost: host,
    ownsRuntime: false,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
    await host.close();
    await runtime.close();
    expect(provider).not.toHaveBeenCalled();
    expect(store.runs()).toHaveLength(0);
    store.close();
  };
  cleanup.push(close);
  const request = (method: 'GET' | 'POST', path: string, payload?: object, owner = true) => {
    const challenge = randomBytes(32).toString('hex');
    const proof = owner ? access.proof({ role: 'owner', challenge }) : undefined;
    return app.inject({
      method,
      url: path,
      payload,
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        ...(proof
          ? {
              authorization: `Dock owner.${proof.nonce}.${localRequestProof(access.configuration.owner, access.configuration.origin, 'owner', challenge, proof.nonce, method, path)}`,
            }
          : {}),
      },
    });
  };
  return { host, runtime, store, directory, close, request };
}
function authorizedPrivateScope(
  host: ReturnType<typeof createProductionGroupHost>,
  context?: GroupContext,
) {
  if (!context) {
    const member = host.events.createGroup('Controlled owner');
    context = host.events.createContext({
      groupId: member.groupId,
      memberId: member.memberId,
      installationId: member.installationId,
      visibility: 'private',
      provider: 'owner',
      nativeSessionId: randomUUID(),
    });
  }
  const slot = { handle: randomUUID(), context, createdAt: new Date().toISOString() };
  const value = { handle: randomUUID(), name: 'Controlled enrollment', private: slot };
  // Hosting enrollment is pre-authorized in this bounded seam check. Native
  // context registration, owner HTTP auth and the host request journal stay real.
  Object.defineProperty(host, 'resolve', { value: async () => ({ value, slot }) });
  return { context, slot, value };
}

it('normal production construction keeps a real unconfigured factory unavailable without launching a provider', async () => {
  const f = await installation();
  const list = await f.request('GET', '/api/groups');
  expect(list.statusCode, list.body).toBe(200);
  expect(list.json().native).toEqual({
    available: false,
    productionReady: false,
    authState: 'unavailable',
    message: 'Root-reviewed native installation route is not configured.',
  });
  const { slot } = authorizedPrivateScope(f.host);
  const input = { handle: slot.handle, key: randomUUID(), text: 'No configured native route' };
  expect((await f.request('POST', '/api/groups/request-agent', input)).statusCode).toBe(503);
  expect(f.host.nativeJournal.get(input.handle, input.key)).toBeNull();
});

it('normal owner route reaches the production factory seam and recovers a retained private result without resubmission', async () => {
  const snapshots = new Map<string, GroupNativeSnapshot>();
  let current: Awaited<ReturnType<typeof installation>>;
  const submit = vi.fn(
    async (input: Parameters<ReturnType<typeof createGroupNativeConnector>['submit']>[0]) => {
      // The durable unknown marker must precede any possibly effective handoff.
      expect(current.host.nativeJournal.get(handle, input.key)?.receipt.state).toBe('unknown');
      const { sessionId: _owner, ...scope } = input.context;
      const context = current.host.events.createContext({
        ...scope,
        provider: 'codex',
        nativeSessionId: randomUUID(),
      });
      snapshots.set(input.requestId, {
        requestId: input.requestId,
        state: 'completed',
        message: 'Controlled retained native receipt',
        result: { context, text: 'Private controlled result', nativeToolItems: 7 },
      });
      throw new Error('Lost acknowledgement after retained result');
    },
  );
  const inspect = vi.fn(async ({ requestId }: { requestId: string }) => snapshots.get(requestId)!);
  const close = vi.fn(async () => {});
  vi.mocked(createGroupNativeConnector).mockImplementation(() => ({
    availability: async () => ({
      available: true,
      productionReady: true,
      authState: 'per-context',
      message: 'Controlled adapter; no actual native readiness is proved.',
    }),
    submit,
    inspect,
    close,
    beforeTurn: () => {},
    documents: () => ({
      describe: async () => {
        throw new Error('Not used');
      },
      export: async () => {
        throw new Error('Not used');
      },
    }),
    gitExports: () => {
      throw new Error('Not used');
    },
    canRecoverPendingConsent: () => false,
    recoverPendingConsent: async () => {
      throw new Error('Not used');
    },
    promotionSynthesis: () => ({
      submit: async () => ({ state: 'unavailable' as const }),
      inspect: async () => ({ state: 'unavailable' as const }),
      close: async () => {},
    }),
    ownerExecution: () => null,
    continueAfterConsent: async () => {
      throw new Error('Not used');
    },
    ownerAcceptance: () => {
      throw new Error('Not used');
    },
  }));
  current = await installation();
  const scope = authorizedPrivateScope(current.host);
  const handle = scope.slot.handle;
  const input = { handle, key: randomUUID(), text: 'Read my private question' };
  const status = await current.request('GET', '/api/groups');
  expect(status.json().native.authState).toBe('per-context');
  expect(
    (await current.request('POST', '/api/groups/request-agent', input, false)).statusCode,
  ).toBe(401);
  expect(submit).not.toHaveBeenCalled();
  const lost = await current.request('POST', '/api/groups/request-agent', input);
  expect(lost.statusCode, lost.body).toBe(503);
  expect(lost.json().code).toBe('GROUP_NATIVE_RECEIPT_UNAVAILABLE');
  const original = current.host.nativeJournal.get(handle, input.key)!;
  const directory = current.directory;
  await current.close();
  current = await installation(directory);
  // Retain the same authorized enrollment identity across the host restart.
  Object.defineProperty(current.host, 'resolve', {
    value: async () => ({ value: scope.value, slot: scope.slot }),
  });
  const recovered = await current.request('POST', '/api/groups/request-agent', input);
  expect(recovered.statusCode, recovered.body).toBe(200);
  expect(recovered.json()).toMatchObject({
    requestId: original.request.requestId,
    key: input.key,
    state: 'completed',
    delivery: 'private',
  });
  expect(recovered.json()).not.toHaveProperty('source');
  expect(current.host.nativeJournal.get(handle, input.key)?.result).toMatchObject({
    text: 'Private controlled result',
    nativeToolItems: 7,
    context: { visibility: 'private', provider: 'codex' },
  });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(inspect).toHaveBeenCalledExactlyOnceWith({ requestId: original.request.requestId });
  const conflict = await current.request('POST', '/api/groups/request-agent', {
    ...input,
    text: 'Changed intent',
  });
  expect(conflict.statusCode).toBe(409);
  expect(submit).toHaveBeenCalledTimes(1);
});

it('accepts only the finite per-context status and rejects unknown native authentication values', () => {
  const status = {
    available: true,
    productionReady: true,
    authState: 'per-context',
    message: 'Per context',
  };
  expect(groupHostNativeStatusSchema.parse(status).authState).toBe('per-context');
  expect(
    groupHostNativeStatusSchema.safeParse({ ...status, authState: 'unchecked-ready' }).success,
  ).toBe(false);
});
