import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  runInDurableObject,
  reset,
  abortAllDurableObjects,
} from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  membershipIdentitySchema,
  membershipEnvelopeSchema,
} from '@dock/shared/dist/group-membership.js';
import { groupPhoneDevicesSchema } from '@dock/shared/dist/group-phone.js';
import { capabilityHash, creationGroupId, hostingApprovalHash, setupHash } from '../src/crypto.js';
import worker from '../src/index.js';
import { GroupFeatureStorage } from '../src/group-feature-storage.js';
const secret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const origin = 'https://groups.example.test';
afterEach(async () => {
  await abortAllDurableObjects();
  await reset();
});
async function fixture(allowPost = false) {
  const approval = secret(),
    setup = secret(),
    credential = secret(),
    operationId = crypto.randomUUID();
  Object.assign(env, {
    HOSTING_MODE: 'hosted',
    HOSTING_ORIGIN: origin,
    HOSTING_APPROVAL_HASH: await hostingApprovalHash(approval),
    GROUP_SETUP_HASH: await setupHash(setup),
  });
  const groupId = await creationGroupId(await setupHash(setup), operationId),
    stub = env.GROUPS.getByName(groupId);
  const initialized = await stub.execute(
    membershipEnvelopeSchema.parse({
      groupId,
      credential,
      setupCapability: setup,
      command: {
        kind: 'initialize',
        operationId,
        groupName: 'Hosted phone group',
        displayName: 'Alice',
      },
    }),
  );
  if (!initialized.ok || initialized.value.kind !== 'identity')
    throw new Error('Owned fixture initialization failed');
  const identity = membershipIdentitySchema.parse(initialized.value.identity),
    binding = {
      groupId,
      installationId: identity.installationId,
      epoch: crypto.randomUUID(),
      remoteGroupId: groupId,
      endpointId: crypto.randomUUID(),
      credentialRevision: 1,
    };
  const pair = {
    kind: 'pair' as const,
    operationId: crypto.randomUUID(),
    pairSecret: secret(),
    expiresAt: Date.now() + 600000,
    label: 'Personal phone',
    allowPost,
    binding,
    memberId: identity.memberId,
  };
  const manage = async (command: unknown) =>
    worker.fetch(
      new Request(origin + '/v1/groups/' + groupId + '/phones', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + credential,
          'X-Hosting-Approval': approval,
        },
        body: JSON.stringify(command),
      }),
      env,
    );
  const offered = await manage(pair);
  expect(offered.status).toBe(200);
  const value = z
    .object({
      ok: z.literal(true),
      value: z.object({ pairId: z.uuid(), expiresAt: z.number(), pairProof: z.string() }),
    })
    .parse(await offered.json()).value;
  const claim = {
    kind: 'claim' as const,
    pairId: value.pairId,
    pairSecret: pair.pairSecret,
    pairProof: value.pairProof,
    expiresAt: value.expiresAt,
    key: crypto.randomUUID(),
    deviceId: crypto.randomUUID(),
    deviceCredential: secret(),
  };
  const call = async (command: unknown, cookie?: string, sourceOrigin = origin) =>
    worker.fetch(
      new Request(origin + '/v1/phone/' + groupId, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: sourceOrigin,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(command),
      }),
      env,
    );
  const claimed = await call(claim);
  expect(claimed.status).toBe(200);
  const cookie = claimed.headers.get('Set-Cookie')!.split(';')[0]!;
  return { groupId, credential, identity, binding, pair, claim, cookie, call, manage, stub };
}
it('daily phone admission refuses new writes while current reads and reserved revocation remain available', async () => {
  const f = await fixture(true);
  await runInDurableObject(f.stub, async (_, ctx) => {
    ctx.storage.sql.exec(
      'UPDATE delivery_feature_daily SET day=?,mutations=1000 WHERE singleton=1',
      Math.floor(Date.now() / 86400000),
    );
    await ctx.storage.sync();
  });
  expect(
    (
      await f.manage({
        ...f.pair,
        operationId: crypto.randomUUID(),
        pairSecret: secret(),
        expiresAt: Date.now() + 600000,
      })
    ).status,
  ).toBe(429);
  expect(
    (
      await f.call(
        { kind: 'post', key: crypto.randomUUID(), text: 'This unsent text must stay private.' },
        f.cookie,
      )
    ).status,
  ).toBe(429);
  expect((await f.call({ kind: 'feed', before: null, since: 0 }, f.cookie)).status).toBe(200);
  const revoke = { kind: 'revoke', operationId: crypto.randomUUID(), deviceId: f.claim.deviceId };
  expect((await f.manage(revoke)).status).toBe(200);
  expect((await f.manage(revoke)).status).toBe(200);
  await runInDurableObject(f.stub, async (_, ctx) => {
    expect(ctx.storage.sql.exec('SELECT count(*) n FROM delivery_phone_posts').one().n).toBe(0);
    expect(ctx.storage.sql.exec('SELECT count(*) n FROM delivery_phone_pairs').one().n).toBe(1);
  });
});
it('keeps phone admission byte-based beyond old link counts, releases only expired unused reservations, and fences active devices and authors', async () => {
  const f = await fixture();
  expect(
    (
      await f.manage({
        ...f.pair,
        operationId: crypto.randomUUID(),
        pairSecret: secret(),
        memberId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.manage({
        ...f.pair,
        operationId: crypto.randomUUID(),
        pairSecret: secret(),
        binding: { ...f.binding, installationId: crypto.randomUUID() },
      })
    ).status,
  ).toBe(403);
  const enrollment = await capabilityHash(f.groupId, 'installation', f.credential);
  await runInDurableObject(f.stub, async (_, ctx) => {
    const features = new GroupFeatureStorage(ctx.storage);
    ctx.storage.transactionSync(() => {
      for (let i = 0; i < 65; i++) {
        const id = crypto.randomUUID();
        features.reserve(`phone:${id}`, 8192, 262144);
        features.account(
          () =>
            ctx.storage.sql
              .exec(
                'INSERT INTO delivery_phone_pairs VALUES(?,?,?,?,?,?,?,?,NULL,NULL)',
                id,
                enrollment,
                secret(),
                Date.now() - 1,
                'Expired fixture link',
                0,
                JSON.stringify(f.binding),
                f.identity.memberId,
              )
              .toArray(),
          4096,
        );
      }
    });
    await ctx.storage.sync();
  });
  for (let i = 0; i < 7; i++) {
    const pair = {
      ...f.pair,
      operationId: crypto.randomUUID(),
      pairSecret: secret(),
      expiresAt: Date.now() + 600000,
    };
    const response = await f.manage(pair);
    expect(response.status).toBe(200);
    const offered = (await response.json()) as { value: { pairProof: string } };
    const claim = {
      ...f.claim,
      pairId: pair.operationId,
      pairSecret: pair.pairSecret,
      pairProof: offered.value.pairProof,
      expiresAt: pair.expiresAt,
      key: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      deviceCredential: secret(),
    };
    expect((await f.call(claim)).status).toBe(200);
  }
  expect(
    (
      await f.manage({
        ...f.pair,
        operationId: crypto.randomUUID(),
        pairSecret: secret(),
        expiresAt: Date.now() + 600000,
      })
    ).status,
  ).toBe(429);
  const listed = (await (await f.manage({ kind: 'list' })).json()) as {
    value: { devices: unknown[] };
  };
  expect(listed.value.devices).toHaveLength(8);
  await runInDurableObject(f.stub, async (_, ctx) => {
    expect(ctx.storage.sql.exec('SELECT count(*) n FROM delivery_phone_pairs').one().n).toBe(73);
    expect(
      ctx.storage.sql
        .exec(
          "SELECT count(*) n FROM delivery_phone_pairs p JOIN delivery_feature_reservations r ON r.id='phone:'||p.id WHERE p.claim IS NULL AND p.expires<=?",
          Date.now(),
        )
        .one().n,
    ).toBe(0);
    expect(ctx.storage.sql.exec('SELECT count(*) n FROM delivery_phone_revokes').one().n).toBe(0);
  });
});
it('pairs one exact revocable read-only phone, preserves claim receipt through eviction and refuses changed/cross-origin/cross-group credentials', async () => {
  const f = await fixture();
  expect((await f.call(f.claim)).headers.get('Set-Cookie')!.split(';')[0]).toBe(f.cookie);
  await evictDurableObject(f.stub);
  expect((await f.call(f.claim)).headers.get('Set-Cookie')!.split(';')[0]).toBe(f.cookie);
  expect(
    (await f.call({ ...f.claim, key: crypto.randomUUID(), deviceId: crypto.randomUUID() })).status,
  ).toBe(403);
  expect(
    (await f.call({ kind: 'feed', before: null, since: 0 }, f.cookie, 'https://wrong.example.test'))
      .status,
  ).toBe(403);
  const foreign = await worker.fetch(
    new Request(origin + '/v1/phone/' + crypto.randomUUID(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: f.cookie },
      body: JSON.stringify({ kind: 'feed', before: null, since: 0 }),
    }),
    env,
  );
  expect(foreign.status).toBe(403);
  const view = await (await f.call({ kind: 'feed', before: null, since: 0 }, f.cookie)).json();
  expect(view).toMatchObject({
    ok: true,
    value: {
      kind: 'feed',
      groupName: 'Hosted phone group',
      self: 'Alice',
      allowPost: false,
      entries: [],
    },
  });
  expect(
    (
      await f.call(
        { kind: 'post', key: crypto.randomUUID(), text: 'Read only must not publish' },
        f.cookie,
      )
    ).status,
  ).toBe(403);
  const listed = await f.manage({ kind: 'list' }),
    list = groupPhoneDevicesSchema.parse(((await listed.json()) as { value: unknown }).value);
  expect(list.devices).toEqual([
    { id: f.claim.deviceId, label: 'Personal phone', allowPost: false, state: 'active' },
  ]);
  const revoke = { kind: 'revoke', operationId: crypto.randomUUID(), deviceId: f.claim.deviceId };
  expect((await f.manage(revoke)).status).toBe(200);
  expect((await f.manage(revoke)).status).toBe(200);
  expect((await f.call(f.claim)).status).toBe(403);
  expect((await f.call({ kind: 'feed', before: null, since: 0 }, f.cookie)).status).toBe(403);
});
it('posts exact human text into ordinary hosted delivery, makes retries durable and returns latest/earlier pages without a companion or model', async () => {
  const f = await fixture(true),
    post = { kind: 'post', key: crypto.randomUUID(), text: 'Exact human phone message · γ' };
  const first = await f.call(post, f.cookie),
    ack = await first.json();
  expect(first.status).toBe(200);
  await evictDurableObject(f.stub);
  expect(await (await f.call(post, f.cookie)).json()).toEqual(ack);
  expect((await f.call({ ...post, text: 'Changed retry must not publish' }, f.cookie)).status).toBe(
    409,
  );
  const normal = await f.stub.deliver({
    groupId: f.groupId,
    credential: f.credential,
    command: { kind: 'feed', after: 0, limit: 8, cursor: null },
  });
  expect(normal).toMatchObject({
    ok: true,
    value: {
      kind: 'feed',
      entries: [
        {
          header: { event: { condensedText: post.text } },
          author: { memberId: f.identity.memberId, installationId: f.identity.installationId },
        },
      ],
    },
  });
  if (!normal.ok || normal.value.kind !== 'feed') throw Error('Fixture feed missing');
  const event = normal.value.entries[0]!.header.event;
  const expanded = await f.call({ kind: 'original', eventId: event.eventId, start: 0 }, f.cookie);
  expect(await expanded.json()).toMatchObject({
    ok: true,
    value: { kind: 'original', text: post.text, next: null },
  });
  for (let n = 0; n < 21; n++)
    expect(
      (await f.call({ kind: 'post', key: crypto.randomUUID(), text: 'Message ' + n }, f.cookie))
        .status,
    ).toBe(200);
  const recent = (await (
    await f.call({ kind: 'feed', before: null, since: 0 }, f.cookie)
  ).json()) as { value: { entries: { sequence: number; text: string }[]; next: number | null } };
  expect(recent.value.entries).toHaveLength(20);
  expect(recent.value.entries.at(-1)!.text).toBe('Message 20');
  const old = (await (
    await f.call({ kind: 'feed', before: recent.value.next, since: 0 }, f.cookie)
  ).json()) as { value: { entries: { text: string }[] } };
  expect(old.value.entries[0]!.text).toBe(post.text);
  const empty = await (
    await f.call(
      { kind: 'feed', before: null, since: recent.value.entries.at(-1)!.sequence },
      f.cookie,
    )
  ).json();
  expect(empty).toMatchObject({ ok: true, value: { entries: [] } });
});
it('stops phone reads, writes and exact retries immediately after its parent enrollment is revoked, and retains no plaintext capabilities', async () => {
  const f = await fixture(true),
    post = { kind: 'post', key: crypto.randomUUID(), text: 'Before parent revoke' };
  expect((await f.call(post, f.cookie)).status).toBe(200);
  await runInDurableObject(f.stub, (_instance, state) => {
    const pairs = state.storage.sql.exec('SELECT * FROM delivery_phone_pairs').toArray(),
      devices = state.storage.sql.exec('SELECT * FROM delivery_phone_devices').toArray();
    const saved = JSON.stringify({ pairs, devices });
    expect(saved).not.toContain(f.pair.pairSecret);
    expect(saved).not.toContain(f.claim.deviceCredential);
    expect(saved).not.toContain(f.credential);
    state.storage.sql
      .exec(
        "UPDATE enrollments SET state='revoked' WHERE installation_id=?",
        f.identity.installationId,
      )
      .toArray();
  });
  expect((await f.call({ kind: 'feed', before: null, since: 0 }, f.cookie)).status).toBe(403);
  expect((await f.call(post, f.cookie)).status).toBe(403);
  expect((await f.call(f.claim)).status).toBe(403);
  expect((await f.manage({ kind: 'list' })).status).toBe(403);
});
it('rejects fabricated pairing proofs before opening the target group and serves private static phone UI without actor credentials', async () => {
  await fixture();
  const groupId = crypto.randomUUID(),
    claim = {
      kind: 'claim',
      pairId: crypto.randomUUID(),
      pairSecret: secret(),
      pairProof: secret(),
      expiresAt: Date.now() + 600000,
      key: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      deviceCredential: secret(),
    };
  const bad = await worker.fetch(
    new Request(origin + '/v1/phone/' + groupId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(claim),
    }),
    env,
  );
  expect(bad.status).toBe(403);
  const page = await worker.fetch(new Request(origin + '/groups/' + groupId), env);
  expect(page.status).toBe(200);
  expect(page.headers.get('Cache-Control')).toBe('no-store');
  expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect(await page.text()).toContain('Reading uses no model');
  expect(await capabilityHash(groupId, 'phone-device', claim.deviceCredential)).not.toBe(
    claim.deviceCredential,
  );
});
