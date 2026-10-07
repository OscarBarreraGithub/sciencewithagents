import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import { localRequestProof } from '@dock/shared/dist/local-authorization.js';
import type { GroupScope } from '@dock/shared';
import type { GroupCatchupReader } from './group-catchup-context.js';
import { groupFeatureReading } from './group-features-reading.js';
import { GroupHost } from './group-host.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';
import { PhoneAccess, phoneConfigSchema } from './phone-access.js';
import { repoRoot } from './paths.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { Store } from './store.js';
import { Terminals } from './terminal.js';

it('shares reading stores across authenticated entries, failed phone starts, retries and either close order', async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  const directory = mkdtempSync(join(repoRoot, 'data/tests/group-reading-entries-'));
  const store = new Store(join(directory, 'dock.sqlite'));
  const runtime = new Runtime(store, directory, 'codex', async () => {
    throw new Error('Native launches are not part of this listener check.');
  });
  const host = new GroupHost(directory);
  const terminals = new Terminals(runtime);
  const apps = new Set<FastifyInstance>();
  const localPort = 4999;
  const localOrigin = `http://127.0.0.1:${localPort}`;
  const access = new LocalAccess(prepareLocalAccess(directory, localPort));
  const config = phoneConfigSchema.parse({
    origin: 'https://dock.example.test',
    issuer: 'https://owner.cloudflareaccess.com',
    audience: 'a'.repeat(64),
    owner: 'owner@example.test',
    port: 4998,
  });
  const keys = await generateKeyPair('RS256');
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'listener-check' }],
  });
  const assertion = await new SignJWT({ email: config.owner, type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: 'listener-check' })
    .setSubject('owner-subject')
    .setIssuer(config.issuer!)
    .setAudience(config.audience!)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
  const phone = new PhoneAccess(store, config, jwks);
  phone.setEnabled(true);
  const entry = async (remote: boolean) => {
    const app = await createServer(store, runtime, {
      port: remote ? config.port : localPort,
      groupHost: host,
      phone,
      terminals,
      ownsRuntime: false,
      ...(remote ? { remote: true } : { localAccess: access }),
    });
    apps.add(app);
    return app;
  };
  const close = async (app: FastifyInstance) => {
    await app.close();
    apps.delete(app);
  };
  // Real loopback listeners exercise startup/close; Host remains each entry's exact trusted host.
  const localHeaders = (method: string, path: string, authorized = true) => {
    const challenge = randomBytes(32).toString('hex');
    const proof = access.proof({ role: 'owner', challenge });
    return {
      host: `127.0.0.1:${localPort}`,
      origin: localOrigin,
      'content-type': 'application/json',
      ...(authorized
        ? {
            authorization: `Dock owner.${proof.nonce}.${localRequestProof(access.configuration.owner, localOrigin, 'owner', challenge, proof.nonce, method, path)}`,
          }
        : {}),
    };
  };
  const remoteHeaders = (cookie?: string) => ({
    host: new URL(config.origin).host,
    origin: config.origin,
    'content-type': 'application/json',
    'cf-access-jwt-assertion': assertion,
    ...(cookie ? { cookie } : {}),
  });
  const request = (
    address: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) =>
    new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(
        `${address}${path}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers,
          signal: AbortSignal.timeout(3000),
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('error', reject);
          incoming.on('end', () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (typeof value === 'string') responseHeaders.set(name, value);
              else for (const item of value ?? []) responseHeaders.append(name, item);
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: incoming.statusCode,
                headers: responseHeaders,
              }),
            );
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  try {
    const local = await entry(false);
    const localAddress = await local.listen({ host: '127.0.0.1', port: 0 });
    const reading = groupFeatureReading(host);
    const member = host.events.createGroup('Listener check');
    const context = host.events.createContext({
      groupId: member.groupId,
      memberId: member.memberId,
      installationId: member.installationId,
      visibility: 'private',
      provider: 'codex',
      nativeSessionId: randomUUID(),
    });
    const scope: GroupScope = {
      groupId: context.groupId,
      memberId: context.memberId,
      installationId: context.installationId,
      visibility: context.visibility,
      source: {
        sessionId: context.sessionId,
        provider: context.provider,
        nativeSessionId: context.nativeSessionId,
        messageId: randomUUID(),
      },
      causalRefs: [],
    };
    const reader: GroupCatchupReader = {
      context,
      enrollmentHandle: member.installationId,
      revalidate: async () => {
        host.events.trustedHostScope(scope);
      },
      readShared: async (query) => host.events.feed(host.events.trustedHostScope(scope), query),
      original: async (eventId) => {
        const original = host.events.expand(host.events.trustedHostScope(scope), eventId);
        return { eventId, text: original.original };
      },
    };
    const saved = await reading.catchup.start(reader);
    const assertStoresOpen = async () => {
      expect(groupFeatureReading(host)).toBe(reading);
      expect((await reading.catchup.start(reader)).snapshotId).toBe(saved.snapshotId);
      expect(reading.evidence.queryPlan({ type: 'offline_changes' }).length).toBeGreaterThan(0);
    };

    const failedPhone = await entry(true);
    await expect(
      failedPhone.listen({ host: '127.0.0.1', port: Number(new URL(localAddress).port) }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await close(failedPhone);
    await assertStoresOpen();

    const remote = await entry(true);
    const remoteAddress = await remote.listen({ host: '127.0.0.1', port: 0 });
    expect(
      (await request(localAddress, '/api/groups', localHeaders('GET', '/api/groups', false)))
        .status,
    ).toBe(401);
    expect(
      (await request(localAddress, '/api/groups', localHeaders('GET', '/api/groups'))).status,
    ).toBe(200);
    expect((await request(remoteAddress, '/api/groups', remoteHeaders())).status).toBe(401);
    const code = await request(
      localAddress,
      '/api/phone/code',
      localHeaders('POST', '/api/phone/code'),
      { key: randomUUID() },
    );
    expect(code.status).toBe(200);
    const paired = await request(remoteAddress, '/api/phone/pair', remoteHeaders(), {
      code: (await code.json()).code,
      name: 'Listener check phone',
    });
    expect(paired.status).toBe(200);
    const cookie = paired.headers.get('set-cookie')!.split(';')[0];
    expect((await request(remoteAddress, '/api/groups', remoteHeaders(cookie))).status).toBe(200);
    const catchupPath = '/api/groups/catchup/start';
    expect((await request(remoteAddress, catchupPath, remoteHeaders(), {})).status).toBe(401);
    expect((await request(remoteAddress, catchupPath, remoteHeaders(cookie), {})).status).toBe(400);
    expect(
      (await request(localAddress, catchupPath, localHeaders('POST', catchupPath), {})).status,
    ).toBe(400);
    await assertStoresOpen();

    await close(remote);
    await assertStoresOpen();
    expect(
      (await request(localAddress, '/api/groups', localHeaders('GET', '/api/groups'))).status,
    ).toBe(200);
    const retriedPhone = await entry(true);
    const retriedAddress = await retriedPhone.listen({ host: '127.0.0.1', port: 0 });
    await assertStoresOpen();
    await close(local);
    await assertStoresOpen();
    expect((await request(retriedAddress, '/api/groups', remoteHeaders(cookie))).status).toBe(200);
    await close(retriedPhone);
    expect(() => groupFeatureReading(host)).toThrow('unavailable');
    expect(() => reading.evidence.queryPlan({ type: 'offline_changes' })).toThrow();
    await expect(reading.catchup.acknowledged(reader)).rejects.toThrow();

    const reopened = await entry(false);
    await reopened.ready();
    expect(groupFeatureReading(host)).not.toBe(reading);
    expect((await groupFeatureReading(host).catchup.start(reader)).snapshotId).toBe(
      saved.snapshotId,
    );
  } finally {
    for (const app of [...apps].reverse()) await app.close();
    terminals.close();
    await runtime.close();
    await host.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
