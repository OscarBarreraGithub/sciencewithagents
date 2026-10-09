import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { localRequestProof, type LocalRole } from '@dock/shared/dist/local-authorization.js';
import {
  nativeConnectionsViewSchema,
  nativeConnectionSendReceiptSchema,
  nativeConnectionPromptListSchema,
} from '@dock/shared';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { NativeConnections, nativeConnectionLimits } from './native-connections.js';
import type { NativeConnectionProfile } from './native-connections-config.js';
import {
  type NativeClient,
  type NativeDiscovery,
  type NativeTerminalDriver,
  nativeSshInvocation,
} from './native-terminal-driver.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';
import { PhoneAccess } from './phone-access.js';
import { createServer } from './server.js';
import { Terminals } from './terminal.js';
import { proxyPath } from './hosts.js';
import { repoRoot } from './paths.js';

class Browser extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: unknown[] = [];
  send(text: string) {
    this.frames.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  asSocket() {
    return this as unknown as WebSocket;
  }
  input(data: string) {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'input', data })), false);
  }
}
class Client implements NativeClient {
  writes: string[] = [];
  resizes: { cols: number; rows: number }[] = [];
  closed = false;
  output: (data: string) => void = () => {};
  exit: (code: number) => void = () => {};
  onOutput(fn: (data: string) => void) {
    this.output = fn;
  }
  onExit(fn: (code: number) => void) {
    this.exit = fn;
  }
  input(text: string) {
    this.writes.push(text);
  }
  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows });
  }
  close() {
    this.closed = true;
  }
}
const latch = () => {
  let release: () => void = () => {};
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};
let root: string,
  store: Store,
  native: NativeConnections,
  driver: NativeTerminalDriver,
  profile: NativeConnectionProfile;
let discovered: NativeDiscovery,
  clients: Client[],
  submissions: string[],
  probe: () => Promise<void>,
  submit: () => Promise<'not_sent' | 'delivered' | 'uncertain'>;
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/native-connections-'));
  store = new Store(join(root, 'dock.sqlite'));
  clients = [];
  submissions = [];
  profile = {
    id: randomUUID(),
    label: 'Owned native fixture',
    kind: 'tmux',
    socket: join(root, 'native.sock'),
  };
  discovered = {
    state: 'available',
    message: 'Native fixture',
    targets: [
      {
        proof: {
          generation: 'socket-one',
          pid: 42,
          started: 'start-one',
          session: '$0',
          pane: '%0',
          sessionCreated: '1',
          panePid: '43',
          serverTime: '1',
        },
        view: {
          kind: 'tmux',
          label: 'Existing pane',
          nativeStatus: 'unknown',
          canObserve: true,
          canControl: true,
          controlPolicy: 'shared',
          controller: 'unknown',
        },
      },
    ],
  };
  probe = async () => {};
  submit = async () => 'delivered';
  driver = {
    discover: vi.fn(async () => {
      await probe();
      return structuredClone(discovered);
    }),
    open: vi.fn(async () => {
      const c = new Client();
      clients.push(c);
      return c;
    }),
    submit: vi.fn(async (_p, _proof, _c, text) => {
      submissions.push(text);
      return submit();
    }),
  };
  native = new NativeConnections(store, root, driver, () => [profile]);
});
afterEach(() => {
  native.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
async function attached(mode: 'observe' | 'control' = 'control') {
  const view = await native.list(),
    targetId = view.targets[0]!.id;
  const input = { key: randomUUID(), targetId, mode };
  const info = native.attach(input),
    browser = new Browser();
  await native.connect(info.id, browser.asSocket());
  return { info: native.read(info.id), browser, input };
}
it('issues stable opaque identities and retains attachment metadata without exposing native paths or raw screen history', async () => {
  const first = await native.list(),
    second = await native.list();
  expect(second.targets).toEqual(first.targets);
  const { info, browser } = await attached();
  clients[0]!.output('private native output');
  browser.input('unrecorded password\r');
  await vi.waitFor(() => expect(clients[0]!.writes).toEqual(['unrecorded password\r']));
  expect(vi.mocked(driver.discover).mock.calls.length).toBe(5); // list/attach probes, never one subprocess per key
  const view = nativeConnectionsViewSchema.parse(await native.list());
  expect(view.attachments).toContainEqual(info);
  expect(JSON.stringify(view)).not.toContain(root);
  expect(JSON.stringify(store.db.prepare('SELECT * FROM nc_events').all())).not.toMatch(
    /password|private native output/,
  );
  for (const table of ['nc_sends', 'nc_attachments', 'nc_targets'])
    expect(JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all())).not.toMatch(
      /unrecorded password|private native output/,
    );
  browser.close();
  expect(clients[0]!.closed).toBe(true);
  expect(native.read(info.id).status).toBe('detached');
});
it('recovers exact attach/detach keys, refuses collisions and caps both not-yet-connected and live clients', async () => {
  const targetId = (await native.list()).targets[0]!.id,
    key = randomUUID();
  const input = { key, targetId, mode: 'observe' as const };
  const info = native.attach(input);
  expect(native.attach(input)).toEqual(info);
  expect(() => native.attach({ ...input, mode: 'control' })).toThrow('different input');
  for (let i = 1; i < 4; i++) native.attach({ ...input, key: randomUUID() });
  expect(native.activeCount()).toBe(4);
  expect(() => native.attach({ ...input, key: randomUUID() })).toThrow('Detach');
  const detachKey = randomUUID(),
    result = native.detach(info.id, detachKey);
  expect(native.detach(info.id, detachKey)).toEqual(result);
  expect(() => native.detach(native.attach({ ...input, key: randomUUID() }).id, detachKey)).toThrow(
    'another attachment',
  );
  expect(driver.open).not.toHaveBeenCalled();
  expect(native.activeCount()).toBe(4);
});
it('fences a replaced native generation and configuration during discovery or before connect', async () => {
  const targetId = (await native.list()).targets[0]!.id,
    info = native.attach({ key: randomUUID(), targetId, mode: 'control' });
  discovered.targets[0]!.proof.started = 'start-two';
  await expect(native.connect(info.id, new Browser().asSocket())).rejects.toThrow('changed');
  expect(driver.open).not.toHaveBeenCalled();
  expect(native.read(info.id).status).toBe('unavailable');
  expect((await native.list()).targets[0]!.id).not.toBe(targetId);
  const held = latch();
  probe = () => held.promise;
  const listing = native.list();
  profile = { ...profile, socket: join(root, 'replacement.sock') };
  held.release();
  expect((await listing).targets).toEqual([]);
});
it('closes only its pending client if a native generation changes while attachment is opening', async () => {
  const view = await native.list(),
    info = native.attach({ key: randomUUID(), targetId: view.targets[0]!.id, mode: 'control' });
  const held = latch(),
    client = new Client();
  vi.mocked(driver.open).mockImplementationOnce(async () => {
    await held.promise;
    return client;
  });
  const connected = native.connect(info.id, new Browser().asSocket());
  await vi.waitFor(() => expect(driver.open).toHaveBeenCalledTimes(1));
  discovered.targets[0]!.proof.generation = 'replacement-socket';
  held.release();
  await expect(connected).rejects.toThrow('changed');
  expect(client.closed).toBe(true);
  expect(native.read(info.id).status).toBe('unavailable');
  expect(submissions).toEqual([]);
});
it('refuses raw input after a host profile changes without probing or reconnecting the bound native stream', async () => {
  const { info, browser } = await attached();
  const probes = vi.mocked(driver.discover).mock.calls.length;
  profile = { ...profile, socket: join(root, 'another-server.sock') };
  browser.input('must not retarget');
  await vi.waitFor(() => expect(native.read(info.id).status).toBe('detached'));
  expect(vi.mocked(driver.discover).mock.calls.length).toBe(probes);
  expect(clients[0]!.writes).toEqual([]);
  expect(clients[0]!.closed).toBe(true);
});
it('does not emit ready or retain connected status when the native client exited before listener attachment', async () => {
  const view = await native.list(),
    info = native.attach({ key: randomUUID(), targetId: view.targets[0]!.id, mode: 'control' });
  const client = new Client();
  client.onExit = (fn) => fn(1);
  vi.mocked(driver.open).mockResolvedValueOnce(client);
  const browser = new Browser();
  await expect(native.connect(info.id, browser.asSocket())).rejects.toThrow('ended before');
  expect(native.read(info.id).status).toBe('detached');
  expect(browser.frames).not.toContainEqual({ type: 'ready' });
  expect(client.closed).toBe(true);
  expect(native.activeCount()).toBe(0);
});
it('allows observation resize but refuses input and never mutates a separate observer on control refusal', async () => {
  const observer = await attached('observe');
  observer.browser.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'resize', cols: 40, rows: 10 })),
    false,
  );
  await vi.waitFor(() => expect(clients[0]!.resizes.at(-1)).toEqual({ cols: 40, rows: 10 }));
  vi.mocked(driver.open).mockRejectedValueOnce(new Error('Native controller occupied'));
  const info = native.attach({
    key: randomUUID(),
    targetId: observer.info.targetId,
    mode: 'control',
  });
  await expect(native.connect(info.id, new Browser().asSocket())).rejects.toThrow();
  expect(clients[0]!.closed).toBe(false);
  expect(native.read(observer.info.id).status).toBe('connected');
  observer.browser.input('must refuse');
  expect(clients[0]!.writes).toEqual([]);
  expect(observer.browser.readyState).toBe(3);
  expect(() =>
    native.attach({
      key: randomUUID(),
      targetId: observer.info.targetId,
      mode: 'control',
      takeover: true,
    }),
  ).toThrow('takeover');
});
it('stores the original prompt before native handoff and coalesces identical racing retries without re-sending', async () => {
  const { info } = await attached(),
    held = latch();
  submit = async () => {
    await held.promise;
    return 'delivered';
  };
  const input = {
    key: randomUUID(),
    inputToken: info.inputToken!,
    text: 'exact saved prompt\nsecond line',
  };
  const first = native.send(info.id, input);
  await vi.waitFor(() => expect(submissions).toEqual([input.text]));
  expect(native.receipt(info.id, input.key).state).toBe('uncertain');
  expect((await native.send(info.id, input)).state).toBe('uncertain');
  await expect(native.send(info.id, { ...input, text: 'changed' })).rejects.toThrow(
    'different input',
  );
  held.release();
  const result = await first;
  expect(result.state).toBe('delivered');
  expect(await native.send(info.id, input)).toEqual(result);
  expect(submissions).toHaveLength(1);
  expect(result.message).toContain('does not prove an agent accepted');
  expect(
    nativeConnectionPromptListSchema.parse(native.prompts(info.targetId)).items[0]!.textPreview,
  ).toBe(input.text);
});
it('cancels before handoff, retains not-sent proof, and never retargets a stale input token to a new attachment', async () => {
  const { info } = await attached(),
    held = latch();
  probe = () => held.promise;
  const input = {
    key: randomUUID(),
    inputToken: info.inputToken!,
    text: 'cancel before native handoff',
  };
  const sending = native.send(info.id, input);
  native.detach(info.id, randomUUID());
  held.release();
  expect((await sending).state).toBe('not_sent');
  expect(submissions).toEqual([]);
  probe = async () => {};
  const next = await attached();
  await expect(native.send(next.info.id, { ...input, key: randomUUID() })).rejects.toThrow('token');
  expect((await native.send(info.id, input)).state).toBe('not_sent');
  expect(submissions).toEqual([]);
});
it('retains uncertain handoff after native failure and app restart without opening a client or replaying any prompt', async () => {
  const { info } = await attached();
  submit = async () => {
    throw new Error('Lost native ACK');
  };
  const input = { key: randomUUID(), inputToken: info.inputToken!, text: 'one handoff only' };
  expect((await native.send(info.id, input)).state).toBe('uncertain');
  native.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  native = new NativeConnections(store, root, driver, () => [profile]);
  expect((await native.send(info.id, input)).state).toBe('uncertain');
  expect(driver.open).toHaveBeenCalledTimes(1);
  expect(submissions).toEqual([input.text]);
  expect(native.read(info.id).status).toBe('detached');
  expect(native.prompts(info.targetId).items).toHaveLength(1);
});
it('recovers crash-retained connecting state as unavailable, retaining its exact attach key without restarting a native client', async () => {
  const view = await native.list(),
    input = { key: randomUUID(), targetId: view.targets[0]!.id, mode: 'control' as const };
  const info = native.attach(input);
  native.close();
  // Crash evidence is the original durable connecting intent, not an owned process to resurrect.
  store.db
    .prepare('UPDATE nc_attachments SET body=? WHERE id=?')
    .run(JSON.stringify(info), info.id);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  native = new NativeConnections(store, root, driver, () => [profile]);
  expect(native.attach(input).status).toBe('unavailable');
  expect(native.read(info.id).inputToken).toBeUndefined();
  expect(driver.open).not.toHaveBeenCalled();
  expect(native.activeCount()).toBe(0);
});
it('preserves saved uncertain proof after a failed final local receipt write and retries read-only', async () => {
  const { info } = await attached();
  const input = {
    key: randomUUID(),
    inputToken: info.inputToken!,
    text: 'native ACK then local fault',
  };
  store.db.exec(
    "CREATE TRIGGER fail_native_final BEFORE UPDATE ON nc_sends BEGIN SELECT RAISE(ABORT,'fixture final write fault'); END",
  );
  await expect(native.send(info.id, input)).rejects.toThrow('fixture final write fault');
  expect(native.receipt(info.id, input.key).state).toBe('uncertain');
  expect((await native.send(info.id, input)).state).toBe('uncertain');
  expect(submissions).toEqual([input.text]);
});
it('refuses full journals and oversized owner prompts before dispatch while old receipts stay readable', async () => {
  const { info } = await attached();
  const old = { key: randomUUID(), inputToken: info.inputToken!, text: 'retained original' };
  const result = await native.send(info.id, old);
  store.db.prepare('UPDATE nc_budget SET used=?').run(nativeConnectionLimits.journalBytes);
  await expect(native.send(info.id, { ...old, key: randomUUID() })).rejects.toThrow('full');
  expect(await native.send(info.id, old)).toEqual(result);
  await expect(
    native.send(info.id, { ...old, key: randomUUID(), text: 'x'.repeat(200_001) }),
  ).rejects.toThrow();
  expect(submissions).toEqual([old.text]);
  expect(native.detach(info.id, randomUUID()).status).toBe('detached');
  expect(clients[0]!.closed).toBe(true);
  expect(() => native.receipt(randomUUID(), old.key)).toThrow('No saved prompt');
});
it('keeps retained targets, attachments and receipts visible when new identities exceed the journal budget', async () => {
  const { info } = await attached();
  const input = { key: randomUUID(), inputToken: info.inputToken!, text: 'Retained owner prompt' };
  const receipt = await native.send(info.id, input);
  discovered.targets.push({
    ...structuredClone(discovered.targets[0]!),
    proof: { ...discovered.targets[0]!.proof, session: '$1', pane: '%1' },
  });
  store.db.prepare('UPDATE nc_budget SET used=?').run(nativeConnectionLimits.journalBytes);
  const view = await native.list();
  expect(view.targets.map((target) => target.id)).toEqual([info.targetId]);
  expect(view.attachments).toContainEqual(info);
  expect(view.sources[0]!.message).toContain('full');
  expect(native.receipt(info.id, input.key)).toEqual(receipt);
  discovered.targets[0]!.proof.generation = 'new-native-server';
  const replacement = await native.list();
  expect(replacement.targets).toEqual([]);
  expect(replacement.attachments).toContainEqual(info);
  expect(native.prompts(info.targetId).items[0]!.textPreview).toBe(input.text);
  expect(await native.send(info.id, input)).toEqual(receipt);
  expect(submissions).toEqual([input.text]);
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM nc_targets').get()).toEqual({ n: 1 });
});
it('charges both retained copies of UTF-8 prompt text and leaves the admitted completion/detach slot available at the fence', async () => {
  const { info } = await attached(),
    held = latch();
  submit = async () => {
    await held.promise;
    return 'delivered';
  };
  const input = {
    key: randomUUID(),
    inputToken: info.inputToken!,
    text: 'Exact é𐐷原文 '.repeat(100).trim(),
  };
  const before = (store.db.prepare('SELECT used FROM nc_budget').get() as { used: number }).used;
  const sending = native.send(info.id, input);
  await vi.waitFor(() => expect(submissions).toEqual([input.text]));
  const charged =
    (store.db.prepare('SELECT used FROM nc_budget').get() as { used: number }).used - before;
  expect(charged).toBe(
    2 * Buffer.byteLength(JSON.stringify(input)) + nativeConnectionLimits.receiptReserve,
  );
  store.db.prepare('UPDATE nc_budget SET used=?').run(nativeConnectionLimits.journalBytes);
  held.release();
  expect((await sending).state).toBe('delivered');
  expect(native.detach(info.id, randomUUID()).status).toBe('detached');
  expect(clients[0]!.closed).toBe(true);
  expect(native.receipt(info.id, input.key).text).toBe(input.text);
  expect((store.db.prepare('SELECT used FROM nc_budget').get() as { used: number }).used).toBe(
    nativeConnectionLimits.journalBytes,
  );
});
it('expires abandoned attachment intents and closes only owned attachment clients on app close', async () => {
  const { info } = await attached();
  vi.useFakeTimers();
  const pending = native.attach({ key: randomUUID(), targetId: info.targetId, mode: 'observe' });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(native.read(pending.id).status).toBe('detached');
  native.close();
  expect(clients[0]!.closed).toBe(true);
  expect(native.activeCount()).toBe(0);
  expect(() =>
    native.attach({ key: randomUUID(), targetId: info.targetId, mode: 'control' }),
  ).toThrow('unavailable');
});
it('builds only bounded, noninteractive SSH native argv with quoting and no added forwarding', () => {
  const invocation = nativeSshInvocation(
    { ...profile, sshAlias: 'owner-configured-alias' },
    ['tmux', '-S', "/tmp/a' b.sock", 'attach-session', '-t', '$0'],
    true,
  );
  expect(invocation.executable).toBe('ssh');
  expect(invocation.args[0]).toBe('-tt');
  expect(invocation.args).toEqual(
    expect.arrayContaining([
      'BatchMode=yes',
      'ConnectTimeout=5',
      'ForwardAgent=no',
      'ForwardX11=no',
      'ClearAllForwardings=yes',
      'StrictHostKeyChecking=yes',
    ]),
  );
  expect(invocation.args.at(-1)).toBe(
    "exec 'tmux' '-S' '/tmp/a'\\'' b.sock' 'attach-session' '-t' '$0'",
  );
  expect(
    nativeSshInvocation({ ...profile, sshAlias: 'owner-configured-alias' }, ['ps', '-p', '42'])
      .args[0],
  ).toBe('-T');
});
it('exposes authenticated typed routes and exact paired-host allowlists, with zero provider calls', async () => {
  const access = new LocalAccess(prepareLocalAccess(root, 4999));
  const launches = vi.fn(async () => {
    throw new Error('No real provider allowed');
  });
  const runtime = new Runtime(store, root, 'unavailable-provider', launches);
  const app = await createServer(store, runtime, {
    port: 4999,
    localAccess: access,
    nativeConnections: native,
    ownsRuntime: false,
  });
  const headers = (method: string, path: string, role: LocalRole = 'owner') => {
    const challenge = randomBytes(32).toString('hex'),
      proof = access.proof({ role, challenge });
    return {
      host: '127.0.0.1:4999',
      origin: 'http://127.0.0.1:4999',
      authorization: `Dock ${role}.${proof.nonce}.${localRequestProof(access.configuration[role], 'http://127.0.0.1:4999', role, challenge, proof.nonce, method, path)}`,
    };
  };
  let socket: WebSocket | undefined;
  try {
    expect((await app.inject({ url: '/api/native-connections' })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/native-connections',
          headers: headers('GET', '/api/native-connections', 'bridge'),
        })
      ).statusCode,
    ).toBe(401);
    const view = nativeConnectionsViewSchema.parse(
      (
        await app.inject({
          url: '/api/native-connections',
          headers: headers('GET', '/api/native-connections'),
        })
      ).json(),
    );
    const key = randomUUID(),
      url = '/api/native-connections/attach',
      payload = { key, targetId: view.targets[0]!.id, mode: 'control' };
    const created = await app.inject({
      method: 'POST',
      url,
      headers: headers('POST', url),
      payload,
    });
    expect(created.statusCode).toBe(200);
    const info = created.json();
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: headers('POST', url),
          payload: { ...payload, socket: '/browser/path' },
        })
      ).statusCode,
    ).toBe(400);
    const path = `/api/native-connections/attachments/${info.id}/socket`;
    socket = await app.injectWS(path, { headers: headers('GET', path) });
    await vi.waitFor(() => expect(native.read(info.id).status).toBe('connected'));
    const sendPath = `/api/native-connections/attachments/${info.id}/send`,
      input = { key: randomUUID(), inputToken: info.inputToken, text: 'typed original' };
    const sent = await app.inject({
      method: 'POST',
      url: sendPath,
      headers: headers('POST', sendPath),
      payload: input,
    });
    expect(sent.statusCode).toBe(200);
    nativeConnectionSendReceiptSchema.parse(sent.json());
    const missing = `/api/native-connections/attachments/${info.id}/receipts/${randomUUID()}`;
    expect((await app.inject({ url: missing, headers: headers('GET', missing) })).statusCode).toBe(
      404,
    );
    for (const p of [
      '/native-connections',
      `/native-connections/attachments/${info.id}`,
      `/native-connections/attachments/${info.id}/receipts/${input.key}`,
      `/native-connections/targets/${info.targetId}/prompts?before=${input.key}`,
    ])
      expect(proxyPath('GET', p)).toBe(`/api${p}`);
    expect(proxyPath('GET', path.slice(4), true)).toBe(path);
    expect(proxyPath('POST', sendPath.slice(4))).toBe(sendPath);
    for (const p of [
      '/native-connections/exec',
      '/native-connections?rpc=send',
      `/native-connections/targets/${info.targetId}/prompts?before=${input.key}&before=${input.key}`,
      `/native-connections/attachments/${info.id}/socket?token=x`,
    ])
      expect(proxyPath('GET', p)).toBeNull();
    expect(launches).not.toHaveBeenCalled();
  } finally {
    socket?.terminate();
    await app.close();
    await runtime.close();
  }
});
it('shares the exact attachment service with a paired phone and releases its client on revocation', async () => {
  const runtime = new Runtime(store, root, 'unavailable-provider', async () => {
    throw new Error('No providers');
  });
  const phone = new PhoneAccess(store, {
    origin: 'https://swa.example.test',
    authentication: 'access',
    issuer: 'https://owner.cloudflareaccess.com',
    audience: 'a'.repeat(64),
    owner: 'owner@example.test',
    port: 4998,
  });
  phone.setEnabled(true);
  const identity = {
    email: 'owner@example.test',
    subject: 'fixture-phone',
    expiresAt: Date.now() + 60_000,
  };
  vi.spyOn(phone, 'identity').mockResolvedValue(identity);
  const paired = phone.pair(identity, {
    code: phone.issueCode(randomUUID()).code,
    name: 'Owned test phone',
  });
  const app = await createServer(store, runtime, {
    port: 4998,
    phone,
    terminals: new Terminals(runtime),
    nativeConnections: native,
    remote: true,
    ownsRuntime: false,
  });
  const headers = {
    host: 'swa.example.test',
    origin: 'https://swa.example.test',
    cookie: paired.cookie.split(';')[0],
    'cf-access-jwt-assertion': 'fixture-only',
  };
  let socket: WebSocket | undefined;
  try {
    const view = (await app.inject({ url: '/api/native-connections', headers })).json();
    const response = await app.inject({
      method: 'POST',
      url: '/api/native-connections/attach',
      headers,
      payload: { key: randomUUID(), targetId: view.targets[0].id, mode: 'observe' },
    });
    expect(response.statusCode).toBe(200);
    const info = response.json();
    socket = await app.injectWS(`/api/native-connections/attachments/${info.id}/socket`, {
      headers,
    });
    await vi.waitFor(() => expect(native.read(info.id).status).toBe('connected'));
    phone.revoke((store.db.prepare('SELECT id FROM phone_devices').get() as { id: string }).id);
    await vi.waitFor(() => expect(native.read(info.id).status).toBe('detached'));
    expect(clients[0]!.closed).toBe(true);
  } finally {
    socket?.terminate();
    await app.close();
    await runtime.close();
  }
});
