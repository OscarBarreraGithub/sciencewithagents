import { afterEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes, randomUUID, createHash, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  encodeGroupBetaAdmission,
  encodeGroupBetaSetupCode,
  groupBetaSigningBytes,
  type GroupBetaProfile,
} from '@dock/shared/dist/group-beta-admission.js';
import {
  membershipCommandSchema,
  membershipIdentitySchema,
  type MembershipCommand,
  type MembershipIdentity,
} from '@dock/shared/dist/group-membership.js';
import { deliveryCommandSchema, type DeliveryCommand } from '@dock/shared/dist/group-delivery.js';
import { GroupHost } from './group-host.js';
import { Conflict } from './store.js';
import { repoRoot } from './paths.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const secret = () => randomBytes(32).toString('hex');
function fixture() {
  const base = join(repoRoot, 'data/groups-beta-host');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(base, 'test-'));
  cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const profile: GroupBetaProfile = {
    version: 1,
    serviceId: randomUUID(),
    endpointId: randomUUID(),
    origin: 'https://pinned-groups.example.invalid',
    keys: [
      {
        kid: randomBytes(8).toString('hex'),
        publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
        state: 'create+route',
      },
    ],
  };
  const createCapability = secret();
  const payload = {
    version: 1 as const,
    serviceId: profile.serviceId,
    kid: profile.keys[0].kid,
    groupId: randomUUID(),
    createOperationId: randomUUID(),
    createCapabilityHash: createHash('sha256')
      .update(`dock-group-setup-v1:${createCapability}`)
      .digest('hex'),
    issuedAt: Date.now() - 1000,
    createExpiresAt: Date.now() + 1000,
  };
  const admission = encodeGroupBetaAdmission(
    payload,
    sign(null, groupBetaSigningBytes(payload), privateKey),
  );
  const setupCode = encodeGroupBetaSetupCode({ version: 1, admission, createCapability });
  const members = new Map<string, MembershipIdentity>();
  const calls: {
    path: string;
    body: MembershipCommand | DeliveryCommand;
    bearer: string;
    headers: Headers;
  }[] = [];
  let original: { bearer: string; body: string; identity: MembershipIdentity } | undefined;
  let inviteSecret: string | undefined;
  let loseCreateAck = false;
  const http: typeof fetch = async (url, options) => {
    const target = new URL(String(url));
    expect(target.origin).toBe(profile.origin);
    const headers = new Headers(options?.headers);
    expect(headers.get('X-Group-Admission')).toBe(admission);
    expect(headers.has('X-Hosting-Approval')).toBe(false);
    const bearer = headers.get('Authorization')!.slice('Bearer '.length);
    expect(bearer).toMatch(/^[a-f0-9]{64}$/);
    const raw: unknown = JSON.parse(String(options?.body));
    const body = membershipCommandSchema.safeParse(raw).data ?? deliveryCommandSchema.parse(raw);
    calls.push({ path: target.pathname, body, bearer, headers });
    const reply = (value: unknown) => Response.json({ ok: true, value });
    if (body.kind === 'initialize') {
      expect(body.operationId).toBe(payload.createOperationId);
      expect(headers.get('X-Group-Setup')).toBe(createCapability);
      if (original) {
        if (bearer !== original.bearer || String(options?.body) !== original.body)
          return Response.json({ ok: false, error: 'conflict' }, { status: 409 });
        expect(String(options?.body)).toBe(original.body);
        return reply({ kind: 'identity', identity: original.identity });
      }
      if (Date.now() >= payload.createExpiresAt)
        return Response.json({ ok: false, error: 'creation_expired' }, { status: 410 });
      const identity = membershipIdentitySchema.parse({
        groupId: payload.groupId,
        memberId: randomUUID(),
        installationId: randomUUID(),
        displayName: body.displayName,
        state: 'active',
      });
      members.set(bearer, identity);
      original = { bearer, body: String(options?.body), identity };
      if (loseCreateAck) {
        loseCreateAck = false;
        throw new Error('Lost create acknowledgement');
      }
      return reply({ kind: 'identity', identity });
    }
    expect(headers.has('X-Group-Setup')).toBe(false);
    expect(target.pathname.startsWith(`/v1/groups/${payload.groupId}`)).toBe(true);
    if (body.kind === 'join') {
      expect(body.inviteSecret).toBe(inviteSecret);
      const identity =
        members.get(bearer) ??
        membershipIdentitySchema.parse({
          groupId: payload.groupId,
          memberId: randomUUID(),
          installationId: randomUUID(),
          displayName: body.displayName,
          state: 'pending' as const,
        });
      members.set(bearer, identity);
      return reply({ kind: 'identity', identity });
    }
    const identity = members.get(bearer);
    if (!identity) return Response.json({ ok: false, error: 'denied' }, { status: 403 });
    if (body.kind === 'status') return reply({ kind: 'identity', identity });
    if (body.kind === 'roster' || body.kind === 'pending')
      return reply({
        kind: 'members',
        next: null,
        entries: [...members.values()]
          .filter((m) => m.state === (body.kind === 'roster' ? 'active' : 'pending'))
          .map((m, i) => ({ position: i + 1, identity: m })),
      });
    if (body.kind === 'invite') {
      inviteSecret = body.inviteSecret;
      return reply({ kind: 'invitation', inviteId: randomUUID(), expiresAt: Date.now() + 900000 });
    }
    if (body.kind === 'approve') {
      const pending = [...members.values()].find((m) => m.installationId === body.installationId)!;
      pending.state = 'active';
      return reply({ kind: 'identity', identity: pending });
    }
    if (body.kind === 'feed')
      return reply({ kind: 'feed', entries: [], watermark: 0, continuation: null });
    throw new Error(`Unexpected controlled request ${body.kind}`);
  };
  const installation = (name: string, pinned = profile) => {
    const host = new GroupHost(join(directory, name), { betaProfile: pinned, http });
    cleanup.push(() => host.close());
    return host;
  };
  return {
    profile,
    payload,
    setupCode,
    createCapability,
    admission,
    calls,
    installation,
    loseAck: () => {
      loseCreateAck = true;
    },
  };
}

it('fresh beta hosts create, invite and approve with separate local bearers and no operator capabilities in invitations', async () => {
  const f = fixture(),
    creator = f.installation('creator'),
    member = f.installation('member');
  expect((await creator.list()).service.setupCodeRequired).toBe(true);
  const opened = await creator.create({
    key: randomUUID(),
    projectName: 'Independent people',
    displayName: 'Amina',
    setupCode: f.setupCode,
  });
  const invite = await creator.invite({ key: randomUUID(), handle: opened.group.handle });
  const body = JSON.parse(
    new URLSearchParams(invite.fragment.replace('/groups?', '')).get('invite')!,
  );
  expect(body).toEqual({
    groupId: f.payload.groupId,
    secret: expect.any(String),
    name: opened.group.name,
    serviceId: f.profile.serviceId,
    admission: f.admission,
  });
  expect(JSON.stringify(body)).not.toContain(f.createCapability);
  const joined = await member.join({
    key: randomUUID(),
    displayName: 'Mateo',
    invitation: `http://127.0.0.1/#${invite.fragment}`,
  });
  const pending = await creator.pending({ handle: opened.group.handle });
  await creator.approve({
    handle: opened.group.handle,
    key: randomUUID(),
    requestId: pending.requests[0].requestId,
    confirmation: joined.confirmation,
  });
  expect((await member.open({ handle: joined.group.handle })).member.displayName).toBe('Mateo');
  expect(
    new Set(
      f.calls.filter((c) => ['initialize', 'join'].includes(c.body.kind)).map((c) => c.bearer),
    ).size,
  ).toBe(2);
});

it('lost creation acknowledgements recover after restart, tab loss, expiry and key retirement by retrying the original create', async () => {
  const f = fixture(),
    first = f.installation('creator');
  const input = {
    key: randomUUID(),
    projectName: 'Exact recovery',
    displayName: 'Amina',
    setupCode: f.setupCode,
  };
  f.loseAck();
  await expect(first.create(input)).rejects.toMatchObject({ code: 'GROUP_SERVICE_UNAVAILABLE' });
  expect(f.calls.map((c) => c.body.kind)).toEqual(['initialize']);
  await first.close();
  cleanup.pop();
  vi.spyOn(Date, 'now').mockReturnValue(f.payload.createExpiresAt + 1);
  const profile: GroupBetaProfile = {
    ...f.profile,
    keys: f.profile.keys.map((k) => ({ ...k, state: 'route-only' })),
  };
  const reopened = f.installation('creator', profile);
  const recovered = await reopened.resume({ key: input.key, kind: 'create' });
  expect(recovered.group.id).toBe(f.payload.groupId);
  expect(f.calls.slice(0, 2).map((c) => c.body.kind)).toEqual(['initialize', 'initialize']);
  const same = await reopened.create({ ...input, key: randomUUID() });
  expect(same.group.handle).toBe(recovered.group.handle);
  expect((await reopened.list()).groups).toHaveLength(1);
});

it('rejects invalid signatures and beta input on protected endpoints before any secret-bearing network request', async () => {
  const f = fixture(),
    host = f.installation('creator');
  const invalid = f.setupCode.slice(0, -1) + (f.setupCode.endsWith('A') ? 'B' : 'A');
  await expect(
    host.create({
      key: randomUUID(),
      projectName: 'Wrong code',
      displayName: 'Amina',
      setupCode: invalid,
    }),
  ).rejects.toMatchObject({ code: 'GROUP_BETA_SETUP_INVALID' });
  expect(f.calls).toHaveLength(0);
  writeFileSync(
    join(host.directory, 'service.json'),
    JSON.stringify({
      version: 1,
      mode: 'local-test',
      endpoint: 'http://127.0.0.1:19999/',
      endpointId: randomUUID(),
      setupCapability: secret(),
    }),
    { mode: 0o600 },
  );
  await expect(
    host.create({
      key: randomUUID(),
      projectName: 'Wrong service',
      displayName: 'Amina',
      setupCode: f.setupCode,
    }),
  ).rejects.toMatchObject({ code: 'GROUP_SERVICE_CHANGED' });
  const invitation = `http://127.0.0.1/#/groups?invite=${encodeURIComponent(JSON.stringify({ groupId: f.payload.groupId, secret: secret(), name: 'Wrong service', serviceId: f.profile.serviceId, admission: f.admission }))}`;
  await expect(
    host.join({ key: randomUUID(), displayName: 'Mateo', invitation }),
  ).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
  expect(f.calls).toHaveLength(0);
});

it('retains the original setup identity when the service definitively rejects unused expired creation', async () => {
  const f = fixture(),
    host = f.installation('creator');
  vi.spyOn(Date, 'now').mockReturnValue(f.payload.createExpiresAt + 1);
  const key = randomUUID();
  await expect(
    host.create({
      key,
      projectName: 'Expired unused',
      displayName: 'Amina',
      setupCode: f.setupCode,
    }),
  ).rejects.toMatchObject({ status: 410, code: 'GROUP_BETA_CREATION_EXPIRED' });
  await expect(host.resume({ key, kind: 'create' })).rejects.toMatchObject({
    code: 'GROUP_BETA_CREATION_EXPIRED',
  });
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1].bearer).toBe(f.calls[0].bearer);
  expect(f.calls[1].body).toEqual(f.calls[0].body);
});

it('distinguishes a remotely redeemed beta code from local identity conflicts and retains both original retries', async () => {
  const f = fixture(),
    first = f.installation('creator'),
    second = f.installation('other-installation');
  const input = {
    key: randomUUID(),
    projectName: 'One code, one group',
    displayName: 'Amina',
    setupCode: f.setupCode,
  };
  const created = await first.create(input);
  const secondKey = randomUUID();
  await expect(second.create({ ...input, key: secondKey })).rejects.toMatchObject({
    status: 409,
    code: 'GROUP_BETA_CODE_USED',
  });
  const rejected = f.calls.at(-1)!;
  await expect(second.resume({ key: secondKey, kind: 'create' })).rejects.toMatchObject({
    code: 'GROUP_BETA_CODE_USED',
  });
  expect(f.calls.at(-1)!.bearer).toBe(rejected.bearer);
  expect(f.calls.at(-1)!.body).toEqual(rejected.body);
  const count = f.calls.length;
  await expect(
    first.create({ ...input, projectName: 'Changed local request' }),
  ).rejects.toBeInstanceOf(Conflict);
  expect(f.calls).toHaveLength(count);
  expect((await first.resume({ key: input.key, kind: 'create' })).group.handle).toBe(
    created.group.handle,
  );
});

it('refuses a protected service change during asynchronous code verification before sending any secrets', async () => {
  const f = fixture(),
    host = f.installation('creator');
  const request = host.create({
    key: randomUUID(),
    projectName: 'Service changed',
    displayName: 'Amina',
    setupCode: f.setupCode,
  });
  writeFileSync(
    join(host.directory, 'service.json'),
    JSON.stringify({
      version: 1,
      mode: 'local-test',
      endpoint: 'http://127.0.0.1:19999/',
      endpointId: randomUUID(),
      setupCapability: secret(),
    }),
    { mode: 0o600 },
  );
  await expect(request).rejects.toMatchObject({ code: 'GROUP_SERVICE_CHANGED' });
  expect(f.calls).toHaveLength(0);
  rmSync(join(host.directory, 'service.json'));
  const recovered = await host.create({
    key: randomUUID(),
    projectName: 'Service changed',
    displayName: 'Amina',
    setupCode: f.setupCode,
  });
  expect(recovered.group.id).toBe(f.payload.groupId);
});
