import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { GroupHostUpdates } from './group-host-updates.js';
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const finish of close.splice(0).reverse()) await finish();
  vi.restoreAllMocks();
});
async function native() {
  const server = createServer(),
    sockets = new WebSocketServer({ server });
  const peers: WebSocket[] = [];
  let inbound = 0;
  sockets.on('connection', (peer) => {
    peers.push(peer);
    peer.on('message', () => {
      inbound++;
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  close.push(async () => {
    for (const peer of sockets.clients) peer.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  return { url: `ws://127.0.0.1:${port}/v1/groups/updates`, peers, inbound: () => inbound };
}
function broker() {
  const host = new GroupHostUpdates();
  close.push(async () => host.close());
  return host;
}
it('one protected native Group socket coalesces burst hints for all host readers without sending application commands', async () => {
  const fixture = await native(),
    host = broker();
  const identity = {
    groupId: randomUUID(),
    memberId: randomUUID(),
    installationId: randomUUID(),
    displayName: 'Not transport metadata',
    state: 'active',
  };
  const one: unknown[] = [],
    two: unknown[] = [];
  host.subscribe((value) => one.push(value));
  host.subscribe((value) => two.push(value));
  for (let i = 0; i < 20; i++)
    host.watch(identity, () => ({
      url: fixture.url,
      headers: { Authorization: 'Bearer fixture-private' },
    }));
  await expect.poll(() => fixture.peers.length).toBe(1);
  fixture.peers[0].send(
    JSON.stringify({ version: 1, groupId: identity.groupId, kind: 'connected' }),
  );
  await expect.poll(() => host.connected(identity)).toBe(true);
  for (let i = 0; i < 60; i++)
    fixture.peers[0].send(
      JSON.stringify({ version: 1, groupId: identity.groupId, kind: 'changed' }),
    );
  await expect.poll(() => one.length).toBe(2);
  expect(one).toEqual(two);
  expect(one[0]).toEqual({
    groupId: identity.groupId,
    memberId: identity.memberId,
    installationId: identity.installationId,
    connected: true,
    changed: true,
  });
  expect(JSON.stringify(one)).not.toContain('fixture-private');
  expect(fixture.inbound()).toBe(0);
});
it('unwatch releases real sockets and a full broker slot and cannot retry a removed channel', async () => {
  const fixture = await native(),
    host = broker();
  const identities = Array.from({ length: 33 }, () => ({
    groupId: randomUUID(),
    memberId: randomUUID(),
    installationId: randomUUID(),
  }));
  for (const identity of identities)
    host.watch(identity, () => ({ url: fixture.url, headers: {} }));
  await expect.poll(() => fixture.peers.length).toBe(32);
  expect(host['channels'].size).toBe(32);
  const channel = host['channels'].get(
    `${identities[0].groupId}:${identities[0].memberId}:${identities[0].installationId}`,
  )!;
  fixture.peers[0].terminate();
  await expect.poll(() => Boolean(channel.retry)).toBe(true);
  host.unwatch(identities[0]);
  expect(channel.retry).toBeUndefined();
  expect(channel.peer).toBeUndefined();
  expect(channel.heartbeat).toBeUndefined();
  expect(channel.debounce).toBeUndefined();
  host['open'](channel);
  expect(host['channels'].size).toBe(31);
  host.watch(identities[32], () => ({ url: fixture.url, headers: {} }));
  await expect.poll(() => fixture.peers.length).toBe(33);
  expect(host['channels'].size).toBe(32);
  expect(fixture.inbound()).toBe(0);
});
it('older services use finite fallback while denied native enrollment stops reconnecting', async () => {
  for (const status of [404, 403]) {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(status);
      response.end('Unavailable');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    close.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const host = broker(),
      port = (server.address() as { port: number }).port;
    const identity = {
      groupId: randomUUID(),
      memberId: randomUUID(),
      installationId: randomUUID(),
    };
    const values: unknown[] = [];
    host.subscribe((value) => values.push(value));
    host.watch(identity, () => ({ url: `ws://127.0.0.1:${port}/updates`, headers: {} }));
    await expect.poll(() => values.length).toBe(1);
    const channel = [...host['channels'].values()][0];
    expect(host.connected(identity)).toBe(false);
    expect(channel.denied).toBe(status === 403);
    expect(Boolean(channel.retry)).toBe(status === 404);
    expect(requests).toBe(1);
    host.close();
  }
});

it('the existing protocol heartbeat closes an idle changed destination before ping without an incoming frame', async () => {
  const schedule = globalThis.setInterval;
  let heartbeat: (() => void) | undefined;
  vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
    if (delay === 30_000) heartbeat = () => callback(...args);
    return schedule(callback, delay, ...args);
  });
  const fixture = await native(),
    host = broker();
  const identity = { groupId: randomUUID(), memberId: randomUUID(), installationId: randomUUID() };
  let header = 'original';
  host.watch(identity, () => ({ url: fixture.url, headers: { Authorization: header } }));
  await expect.poll(() => fixture.peers.length).toBe(1);
  fixture.peers[0].send(
    JSON.stringify({ version: 1, groupId: identity.groupId, kind: 'connected' }),
  );
  await expect.poll(() => host.connected(identity)).toBe(true);
  let pings = 0;
  fixture.peers[0].on('ping', () => {
    pings++;
  });
  header = 'replacement';
  expect(heartbeat).toBeDefined();
  heartbeat!();
  await expect.poll(() => host.connected(identity)).toBe(false);
  expect(pings).toBe(0);
  expect(fixture.inbound()).toBe(0);
});
it('foreign, oversized and binding-changed Group frames never become a fresh hint', async () => {
  for (const type of ['foreign', 'oversized', 'changed-binding']) {
    const fixture = await native(),
      host = broker();
    const identity = {
      groupId: randomUUID(),
      memberId: randomUUID(),
      installationId: randomUUID(),
    };
    let header = 'fixture-original';
    const values: { connected: boolean; changed: boolean }[] = [];
    host.subscribe((value) => values.push(value));
    host.watch(identity, () => ({ url: fixture.url, headers: { Authorization: header } }));
    await expect.poll(() => fixture.peers.length).toBe(1);
    fixture.peers[0].send(
      JSON.stringify({ version: 1, groupId: identity.groupId, kind: 'connected' }),
    );
    await expect.poll(() => host.connected(identity)).toBe(true);
    if (type === 'changed-binding') header = 'fixture-replacement';
    fixture.peers[0].send(
      type === 'oversized'
        ? 'x'.repeat(2048)
        : JSON.stringify({
            version: 1,
            groupId: type === 'foreign' ? randomUUID() : identity.groupId,
            kind: 'changed',
          }),
    );
    await expect.poll(() => host.connected(identity)).toBe(false);
    expect(values.filter((value) => value.changed)).toHaveLength(1);
    host.close();
  }
});
it('a restarted Group observer reconciles the new connection without resending a command', async () => {
  const fixture = await native();
  const identity = { groupId: randomUUID(), memberId: randomUUID(), installationId: randomUUID() };
  const first = broker();
  first.watch(identity, () => ({ url: fixture.url, headers: { Authorization: 'fixture' } }));
  await expect.poll(() => fixture.peers.length).toBe(1);
  fixture.peers[0].send(
    JSON.stringify({ version: 1, groupId: identity.groupId, kind: 'connected' }),
  );
  await expect.poll(() => first.connected(identity)).toBe(true);
  first.close();
  const second = broker(),
    reads: unknown[] = [];
  second.subscribe((value) => reads.push(value));
  second.watch(identity, () => ({ url: fixture.url, headers: { Authorization: 'fixture' } }));
  await expect.poll(() => fixture.peers.length).toBe(2);
  fixture.peers[1].send(
    JSON.stringify({ version: 1, groupId: identity.groupId, kind: 'connected' }),
  );
  await expect.poll(() => second.connected(identity)).toBe(true);
  expect(reads).toEqual([{ ...identity, connected: true, changed: true }]);
  expect(fixture.inbound()).toBe(0);
});
