import { env } from 'cloudflare:workers';
import { reset, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import {
  encodeGroupBetaAdmission,
  groupBetaSigningBytes,
  groupBetaEncode,
  type GroupBetaAdmissionPayload,
  type GroupBetaProfile,
} from '@dock/shared/dist/group-beta-admission.js';
import type { MembershipResult } from '@dock/shared/dist/group-membership.js';
import { creationGroupId, setupHash } from '../src/crypto.js';
import { MEMBERSHIP_CAPACITY } from '../src/capacity.js';
import worker from '../src/index.js';
import { DeliveryStorage } from '../src/delivery.js';

const secret = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
async function fixture(expired = false) {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('Expected Ed25519 key pair.');
  const publicBytes = await crypto.subtle.exportKey('raw', pair.publicKey);
  if (!(publicBytes instanceof ArrayBuffer)) throw new Error('Expected raw Ed25519 public key.');
  const profile: GroupBetaProfile = {
    version: 1,
    serviceId: crypto.randomUUID(),
    endpointId: crypto.randomUUID(),
    origin: 'https://groups.example',
    keys: [
      {
        kid: '0123456789abcdef',
        state: 'create+route',
        publicKey: [...new Uint8Array(publicBytes)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(''),
      },
    ],
  };
  const capability = secret(),
    operation = crypto.randomUUID();
  const hash = await setupHash(capability),
    now = Date.now();
  const payload: GroupBetaAdmissionPayload = {
    version: 1,
    serviceId: profile.serviceId,
    kid: profile.keys[0].kid,
    groupId: await creationGroupId(hash, operation),
    createOperationId: operation,
    createCapabilityHash: hash,
    issuedAt: now - (expired ? 120_000 : 1000),
    createExpiresAt: now + (expired ? -60_000 : 60_000),
  };
  const sign = async (p: GroupBetaAdmissionPayload) =>
    encodeGroupBetaAdmission(
      p,
      new Uint8Array(
        await crypto.subtle.sign('Ed25519', pair.privateKey, groupBetaSigningBytes(p)),
      ),
    );
  const admission = await sign(payload);
  Object.assign(env, {
    HOSTING_MODE: 'hosted',
    HOSTING_ORIGIN: profile.origin,
    HOSTING_APPROVAL_HASH: secret(),
    GROUP_SETUP_HASH: secret(),
    GROUP_BETA_SERVICE_ID: profile.serviceId,
    GROUP_BETA_KEYS: JSON.stringify(profile.keys),
  });
  const credential = secret();
  const init = {
    kind: 'initialize',
    operationId: operation,
    groupName: 'Synthetic beta',
    displayName: 'A',
  };
  const path = `/v1/groups/${payload.groupId}`;
  return { profile, payload, pair, capability, sign, admission, credential, init, path };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function http(
  f: Fixture,
  command: unknown,
  options: {
    path?: string;
    credential?: string;
    admission?: string;
    setup?: string;
    headers?: Record<string, string>;
    environment?: Env;
  } = {},
) {
  const response = await worker.fetch(
    new Request(f.profile.origin + (options.path ?? f.path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.credential ?? f.credential}`,
        'X-Group-Admission': options.admission ?? f.admission,
        ...(options.setup === undefined ? {} : { 'X-Group-Setup': options.setup }),
        ...options.headers,
      },
      body: JSON.stringify(command),
    }),
    options.environment ?? env,
  );
  return { status: response.status, body: await response.json<MembershipResult>() };
}
const initialize = (f: Fixture, credential = f.credential) =>
  http(f, f.init, { path: '/v1/create', setup: f.capability, credential });
function identity(result: Awaited<ReturnType<typeof http>>) {
  if (!result.body.ok || result.body.value.kind !== 'identity')
    throw new Error('Expected synthetic identity.');
  return result.body.value.identity;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await reset();
  Object.assign(env, {
    HOSTING_MODE: 'disabled',
    HOSTING_ORIGIN: '',
    HOSTING_APPROVAL_HASH: '',
    GROUP_SETUP_HASH: '',
    GROUP_BETA_SERVICE_ID: '',
    GROUP_BETA_KEYS: '',
  });
});

it('rejects invalid/mixed/service/group/create authority before any DO lookup', async () => {
  const f = await fixture();
  const lookup = vi.fn((name: string) => env.GROUPS.getByName(name));
  const environment: Env = {
    ...env,
    GROUPS: new Proxy(env.GROUPS, {
      get(target, name, receiver) {
        return name === 'getByName' ? lookup : Reflect.get(target, name, receiver);
      },
    }),
  };
  const check = async (options: Parameters<typeof http>[2] = {}) => {
    expect((await http(f, { kind: 'status' }, { environment, ...options })).status).toBe(403);
  };
  await check({ admission: 'invalid' });
  const parts = f.admission.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  await check({ admission: parts.join('.') });
  await check({ admission: await f.sign({ ...f.payload, serviceId: crypto.randomUUID() }) });
  for (const suffix of ['', '/delivery', '/documents', '/actions', '/promotion'])
    await check({ path: `/v1/groups/${crypto.randomUUID()}${suffix}` });
  await check({ headers: { 'X-Hosting-Approval': secret() } });
  await check({ headers: { Origin: 'https://browser.example' } });
  expect((await http(f, f.init, { environment, path: '/v1/create', setup: secret() })).status).toBe(
    403,
  );
  expect(
    (
      await http(
        f,
        { ...f.init, operationId: crypto.randomUUID() },
        { environment, path: '/v1/create', setup: f.capability },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await http(f, f.init, {
        environment,
        path: '/v1/create',
        setup: f.capability,
        admission: await f.sign({ ...f.payload, groupId: crypto.randomUUID() }),
      })
    ).status,
  ).toBe(403);
  // A correctly signed but noncanonical/extra-field payload is still not authority.
  const raw = new TextEncoder().encode(JSON.stringify({ ...f.payload, extra: true }));
  const label = new TextEncoder().encode(`dock-group-beta-admission-v1:${f.payload.kid}:`);
  const bytes = new Uint8Array(label.length + raw.length);
  bytes.set(label);
  bytes.set(raw, label.length);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', f.pair.privateKey, bytes));
  await check({ admission: `${f.payload.kid}.${groupBetaEncode(raw)}.${groupBetaEncode(sig)}` });
  expect(lookup).not.toHaveBeenCalled();
});

it('two independent credentials enroll, recover exact ACKs across eviction, and revoke through scoped HTTP', async () => {
  const f = await fixture();
  const first = await initialize(f);
  expect(first.status).toBe(200);
  await evictDurableObject(env.GROUPS.getByName(f.payload.groupId));
  expect(await initialize(f)).toEqual(first);
  const inviteSecret = secret();
  const invite = {
    kind: 'invite',
    operationId: crypto.randomUUID(),
    inviteSecret,
    ttlSeconds: 900,
  };
  expect((await http(f, invite)).status).toBe(200);
  // Creation admission has expired, but this existing group's invitation is still live.
  vi.setSystemTime(f.payload.createExpiresAt + 1);
  const b = secret(),
    confirmation = secret();
  const join = {
    kind: 'join',
    operationId: crypto.randomUUID(),
    inviteSecret,
    confirmation,
    displayName: 'B',
  };
  const pending = await http(f, join, { credential: b });
  expect(identity(pending).state).toBe('pending');
  expect((await http(f, { kind: 'roster', after: 0, limit: 50 }, { credential: b })).status).toBe(
    403,
  );
  await evictDurableObject(env.GROUPS.getByName(f.payload.groupId));
  expect(await http(f, join, { credential: b })).toEqual(pending);
  const approved = await http(f, {
    kind: 'approve',
    operationId: crypto.randomUUID(),
    installationId: identity(pending).installationId,
    confirmation,
  });
  expect(identity(approved).state).toBe('active');
  expect(identity(await http(f, { kind: 'status' }, { credential: b })).state).toBe('active');
  expect(
    (
      await http(f, {
        kind: 'revoke',
        operationId: crypto.randomUUID(),
        installationId: identity(pending).installationId,
      })
    ).status,
  ).toBe(200);
  expect((await http(f, { kind: 'status' }, { credential: b })).status).toBe(403);
  const receipts = await runInDurableObject(
    env.GROUPS.getByName(f.payload.groupId),
    (_instance, state) =>
      JSON.stringify(state.storage.sql.exec('SELECT * FROM receipts').toArray()),
  );
  for (const value of [f.capability, f.credential, b, inviteSecret, confirmation, f.admission])
    expect(receipts).not.toContain(value);
});

it('one creator wins concurrent redemption; other bearer/body gets conflict without identity', async () => {
  const f = await fixture(),
    other = secret();
  const raced = await Promise.all([initialize(f), initialize(f, other)]);
  expect(raced.map((r) => r.status).sort()).toEqual([200, 409]);
  const winner = raced[0].status === 200 ? f.credential : other;
  const first = raced.find((r) => r.status === 200)!;
  expect(await initialize(f, winner)).toEqual(first);
  expect(
    (
      await http(
        f,
        { ...f.init, groupName: 'Changed body' },
        { path: '/v1/create', setup: f.capability, credential: winner },
      )
    ).body,
  ).toEqual({ ok: false, error: 'conflict' });
  expect(raced.find((r) => r.status === 409)!.body).toEqual({ ok: false, error: 'conflict' });
});

it('expiry is checked after exact receipt: committed create recovers, never-created code fails definitively', async () => {
  const f = await fixture();
  const first = await initialize(f);
  expect(first.status).toBe(200);
  vi.setSystemTime(f.payload.createExpiresAt + 1);
  expect(Date.now()).toBeGreaterThan(f.payload.createExpiresAt);
  expect(await initialize(f)).toEqual(first);
  expect((await http(f, { kind: 'status' })).status).toBe(200);
  const expired = await fixture(true);
  expect(await initialize(expired)).toEqual({
    status: 410,
    body: { ok: false, error: 'creation_expired' },
  });
  expect((await http(expired, { kind: 'status' })).status).toBe(403);
  expect(await initialize(expired)).toEqual({
    status: 410,
    body: { ok: false, error: 'creation_expired' },
  });
});

it('route-only retirement blocks new initialization and retains existing creator/member recovery', async () => {
  const f = await fixture();
  const first = await initialize(f);
  expect(first.status).toBe(200);
  Object.assign(env, {
    GROUP_BETA_KEYS: JSON.stringify(f.profile.keys.map((k) => ({ ...k, state: 'route-only' }))),
  });
  expect(await initialize(f)).toEqual(first);
  expect((await http(f, { kind: 'status' })).status).toBe(200);
  // A valid new ticket with the retired key still cannot initialize.
  const operationId = '11111111-1111-4111-a111-111111111111';
  const admission = await f.sign({
    ...f.payload,
    createOperationId: operationId,
    groupId: await creationGroupId(f.payload.createCapabilityHash, operationId),
  });
  expect(
    (
      await http(
        f,
        { ...f.init, operationId },
        { path: '/v1/create', admission, setup: f.capability },
      )
    ).body,
  ).toEqual({ ok: false, error: 'creation_expired' });
});

it('uninitialized non-create is read-only and normal quota refuses while revocation remains admitted', async () => {
  const f = await fixture(),
    stub = env.GROUPS.getByName(f.payload.groupId);
  const changes = () =>
    runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql.exec<{ n: number }>('SELECT total_changes() AS n').one().n,
    );
  const before = await changes();
  expect((await http(f, { kind: 'status' })).status).toBe(403);
  for (const [suffix, command] of [
    ['/delivery', { kind: 'feed', after: 0, limit: 1, cursor: null }],
    ['/documents', { kind: 'list', after: 0, limit: 1 }],
    ['/promotion', { kind: 'pending', after: 0 }],
    ['/actions', { kind: 'board', after: 0, limit: 1 }],
  ] as const)
    expect((await http(f, command, { path: f.path + suffix })).status).toBe(403);
  expect(await changes()).toBe(before);
  const created = identity(await initialize(f));
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql
      .exec('UPDATE metadata SET operations=?', MEMBERSHIP_CAPACITY.normalOperations)
      .toArray();
  });
  expect(
    (
      await http(f, {
        kind: 'invite',
        operationId: crypto.randomUUID(),
        inviteSecret: secret(),
        ttlSeconds: 900,
      })
    ).status,
  ).toBe(429);
  expect(
    (
      await http(f, {
        kind: 'revoke',
        operationId: crypto.randomUUID(),
        installationId: created.installationId,
      })
    ).status,
  ).toBe(200);
});

it('future issuance is retryable and the same code creates once its issuance time arrives', async () => {
  const f = await fixture();
  const issuedAt = Date.now() + 60_000;
  f.admission = await f.sign({ ...f.payload, issuedAt, createExpiresAt: issuedAt + 60_000 });
  expect(await initialize(f)).toEqual({ status: 503, body: { ok: false, error: 'unavailable' } });
  vi.setSystemTime(issuedAt);
  const created = await initialize(f);
  expect(created.status).toBe(200);
  expect(await initialize(f)).toEqual(created);
});

it('recovered delivery schema survives a rejected outer create after constructor migration failure', async () => {
  const f = await fixture(true);
  const stub = env.GROUPS.getByName(f.payload.groupId);
  await runInDurableObject(stub, (instance, state) => {
    // Fault only the constructor's delivery migration, leaving real workerd SQL
    // and subsequent nested savepoint/outer rollback behavior intact.
    state.storage.sql.exec('DROP TABLE delivery_version').toArray();
    let transactions = 0;
    const storage = new Proxy(state.storage, {
      get(target, property) {
        if (property === 'transactionSync')
          return <T>(work: () => T): T => {
            if (++transactions === 2) throw new Error('Controlled initial migration failure');
            return target.transactionSync(work);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.defineProperty(instance, 'deliveryStorage', { value: new DeliveryStorage(storage) });
    expect(
      state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name='delivery_version'")
        .toArray(),
    ).toEqual([]);
  });
  expect(await initialize(f)).toEqual({
    status: 410,
    body: { ok: false, error: 'creation_expired' },
  });
  await runInDurableObject(stub, (_instance, state) => {
    expect(
      state.storage.sql.exec('SELECT version FROM delivery_version WHERE singleton=1').one()
        .version,
    ).toBe(2);
  });
  // No eviction or alternate credential: the same retained group/op/bearer can
  // initialize and use delivery after a newly valid signed creation window.
  f.admission = await f.sign({
    ...f.payload,
    issuedAt: Date.now() - 1000,
    createExpiresAt: Date.now() + 60_000,
  });
  expect((await initialize(f)).status).toBe(200);
  expect(
    (
      await http(
        f,
        { kind: 'feed', after: 0, limit: 1, cursor: null },
        { path: f.path + '/delivery' },
      )
    ).body.ok,
  ).toBe(true);
});
