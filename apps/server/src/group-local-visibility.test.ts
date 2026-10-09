import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupHost } from './group-host.js';
import { registerGroupHostRoutes } from './group-host-routes.js';
import { Hosts, proxyPath, registerHostRoutes } from './hosts.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(creator = true) {
  const directory = mkdtempSync(join(tmpdir(), 'group-local-visibility-'));
  const http = vi.fn(async () => {
    throw new Error('No remote calls allowed');
  });
  let host = new GroupHost(directory, { betaProfile: null, http });
  const member = host.events.createGroup('Local owner');
  const { displayName: _, ...scope } = member;
  const slot = (visibility: 'shared' | 'private') => ({
    handle: randomUUID(),
    context: host.events.createContext({
      ...scope,
      visibility,
      provider: 'owner',
      nativeSessionId: randomUUID(),
    }),
    createdAt: new Date().toISOString(),
  });
  const value = {
    handle: randomUUID(),
    name: 'Retained group',
    credential: 'a'.repeat(64),
    confirmation: 'b'.repeat(64),
    identity: { ...member, state: 'active' },
    binding: null,
    shared: slot('shared'),
    private: slot('private'),
    creator,
    invitationSecret: creator ? 'c'.repeat(64) : null,
    serviceHash: 'd'.repeat(64),
  };
  host.db.prepare('INSERT INTO gh_groups VALUES (?,?)').run(value.handle, JSON.stringify(value));
  const original = JSON.stringify(value);
  cleanup.push(async () => {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    value,
    original,
    http,
    get host() {
      return host;
    },
    async restart() {
      await host.close();
      host = new GroupHost(directory, { betaProfile: null, http });
    },
  };
}

it.each([true, false])(
  'removes and restores a saved %s creator group offline with exact retry/restart',
  async (creator) => {
    const f = fixture(creator),
      key = randomUUID();
    const input = { handle: f.value.handle, key, revision: 0, hidden: true };
    const removed = f.host.localVisibility(input);
    expect(removed.local).toEqual({ hidden: true, revision: 1 });
    expect(await f.host.list()).toMatchObject({ groups: [], removed: [removed] });
    expect(f.host.localVisible(f.value.shared.handle)).toBe(false);
    expect(f.host.localVisible(f.value.private.handle)).toBe(false);
    await f.restart();
    expect(f.host.localVisibility(input)).toEqual(removed);
    expect(() => f.host.localVisibility({ ...input, hidden: false })).toThrow('Request changed');
    expect(() => f.host.localVisibility({ ...input, key: randomUUID() })).toThrow(
      'visibility changed',
    );
    const restored = f.host.localVisibility({
      ...input,
      key: randomUUID(),
      revision: 1,
      hidden: false,
    });
    expect(restored.local).toEqual({ hidden: false, revision: 2 });
    expect(await f.host.list()).toMatchObject({ groups: [restored], removed: [] });
    // A delayed remove replay returns its old receipt without hiding a restored group.
    expect(f.host.localVisibility(input)).toEqual(removed);
    expect(f.host.localVisible(f.value.handle)).toBe(true);
    expect(
      String(
        f.host.db.prepare('SELECT body FROM gh_groups WHERE handle=?').get(f.value.handle)!.body,
      ),
    ).toBe(f.original);
    expect(() =>
      f.host.db.prepare('DELETE FROM gh_local_visibility WHERE handle=?').run(f.value.handle),
    ).toThrow('retained local visibility');
    expect(f.http).not.toHaveBeenCalled();
  },
);

it('requires owner authentication and accepts only typed saved local handles', async () => {
  const f = fixture(),
    app = Fastify();
  registerGroupHostRoutes(
    app,
    f.host,
    (request) => request.headers.authorization === 'fixture-owner',
  );
  cleanup.push(() => app.close());
  const body = { handle: f.value.handle, key: randomUUID(), revision: 0, hidden: true };
  expect(
    (await app.inject({ method: 'POST', url: '/api/groups/local-visibility', payload: body }))
      .statusCode,
  ).toBe(401);
  expect(f.host.localVisible(f.value.handle)).toBe(true);
  const result = await app.inject({
    method: 'POST',
    url: '/api/groups/local-visibility',
    headers: { authorization: 'fixture-owner' },
    payload: body,
  });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({ local: { hidden: true, revision: 1 } });
  expect(() => f.host.localVisibility({ ...body, handle: randomUUID() })).toThrow(
    'Saved local group unavailable',
  );
  expect(() => f.host.localVisibility({ ...body, path: '/not-accepted' })).toThrow();
  expect(proxyPath('POST', '/groups/local-visibility')).toBe('/api/groups/local-visibility');
  expect(f.http).not.toHaveBeenCalled();
});

it('forwards local remove and restore through the authenticated paired-host transport', async () => {
  const f = fixture(),
    app = Fastify(),
    gateway = Fastify(),
    hostId = randomUUID();
  let access: LocalAccess;
  app.get('/api/host-info', () => ({ hostId, protocolVersion: 1, localAuthentication: true }));
  app.get('/api/local-access/proof', (request) => access.proof(request.query));
  registerGroupHostRoutes(
    app,
    f.host,
    (request) =>
      access.authenticate(request.headers.authorization, request.method, request.url) === 'host',
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => app.close());
  const port = (app.server.address() as { port: number }).port;
  access = new LocalAccess(prepareLocalAccess(f.directory, port));
  const config = {
    id: randomUUID(),
    label: 'Owned fixture',
    accountLabel: 'Fixture',
    expectedHostId: hostId,
    sshAlias: 'unused-fixture',
    remotePort: port,
    credential: access.configuration.host,
  };
  const hosts = new Hosts(
    f.directory,
    async () => ({ port, alive: () => true, async close() {} }),
    [config],
  );
  cleanup.push(() => hosts.close());
  await gateway.register(websocket);
  registerHostRoutes(gateway, hosts);
  cleanup.push(() => gateway.close());
  const path = `/api/hosts/${config.id}/proxy/groups/local-visibility`;
  const input = { handle: f.value.handle, key: randomUUID(), revision: 0, hidden: true };
  const removed = await gateway.inject({ method: 'POST', url: path, payload: input });
  expect(removed.statusCode).toBe(200);
  expect(removed.json()).toMatchObject({ local: { hidden: true, revision: 1 } });
  expect((await gateway.inject({ method: 'POST', url: path, payload: input })).json()).toEqual(
    removed.json(),
  );
  expect(
    (
      await gateway.inject({
        method: 'POST',
        url: path,
        payload: { ...input, key: randomUUID(), revision: 1, hidden: false },
      })
    ).json(),
  ).toMatchObject({ local: { hidden: false, revision: 2 } });
  for (const invalid of [
    '/groups/local-visibility/run',
    '/groups/local-visibility?path=/tmp',
    '/groups/local-visibility?command=rm',
  ])
    expect(proxyPath('POST', invalid)).toBeNull();
  expect(f.http).not.toHaveBeenCalled();
});

it('does not poll retained writer inputs or writer leases for a removed group', async () => {
  const f = fixture(),
    inputId = randomUUID();
  // Poll selection must happen before interpreting or remotely expanding a pending input.
  f.host.db
    .prepare(
      'INSERT INTO gh_promotion_inputs(receipt_id,enrollment_handle,source_json,state) VALUES (?,?,?,?)',
    )
    .run(inputId, f.value.handle, '{}', 'pending');
  f.host.db
    .prepare('INSERT INTO gh_promotion_writers(enrollment_handle,enabled,state) VALUES (?,1,?)')
    .run(f.value.handle, 'ready');
  f.host.localVisibility({ handle: f.value.handle, key: randomUUID(), revision: 0, hidden: true });
  const resolve = vi.spyOn(f.host, 'promotionContext');
  await f.host.promotion.pass();
  expect(resolve).not.toHaveBeenCalled();
  expect(
    f.host.db.prepare('SELECT state FROM gh_promotion_inputs WHERE receipt_id=?').get(inputId)
      ?.state,
  ).toBe('pending');
  expect(f.http).not.toHaveBeenCalled();
});
