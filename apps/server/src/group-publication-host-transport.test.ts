import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { groupAppendSchema, groupScopeSchema, type GroupContext } from '@dock/shared';
import {
  membershipReplySchema,
  membershipFailureSchema,
  type MembershipIdentity,
} from '@dock/shared/dist/group-membership.js';
import * as wire from '@dock/shared/dist/group-delivery.js';
import * as protocol from './group-publication-protocol.js';
import { GroupEventRepository } from './group-events.js';
import { GroupPublicationController, type PublicationAccess } from './group-publication.js';
import {
  HostedPublicationTransport,
  HostedPublicationError,
} from './group-publication-host-transport.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const secret = () => randomBytes(32).toString('hex');
const setup = secret(),
  hash = createHash('sha256').update(`dock-group-setup-v1:${setup}`).digest('hex');
let directory: string, worker: ChildProcess | undefined, endpoint: string, port: number;
let now = Date.now();
async function start() {
  worker = spawn(
    process.execPath,
    [
      join(root, 'apps/group-service/node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      '0',
      '--persist-to',
      join(directory, 'workerd'),
      '--var',
      'HOSTING_MODE:local-test',
      '--var',
      `GROUP_SETUP_HASH:${hash}`,
      '--log-level',
      'error',
    ],
    {
      cwd: join(root, 'apps/group-service'),
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: 'pipe',
    },
  );
  // Drain owned process output; no URLs, auth headers or capability bodies are retained.
  worker.stdout?.resume();
  worker.stderr?.resume();
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (worker.exitCode !== null) throw new Error('Local workerd exited');
    try {
      const r = await fetch(`${endpoint}/v1/create`, {
        method: 'POST',
        signal: AbortSignal.timeout(300),
      });
      if (r.status === 403 || r.status === 400) return;
    } catch {
      /* startup only */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Local workerd startup timeout');
}
async function stop() {
  const owned = worker;
  worker = undefined;
  if (!owned || owned.exitCode !== null) return;
  const exited = new Promise<void>((r) => owned.once('exit', () => r()));
  owned.kill('SIGTERM');
  await exited;
}
async function memberCall(path: string, credential: string, command: unknown, create = false) {
  const result = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential}`,
      ...(create ? { 'X-Group-Setup': setup } : {}),
    },
    body: JSON.stringify(command),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const raw = (await result.json()) as { ok: boolean; value: unknown; error: unknown };
  return raw.ok
    ? { ok: true as const, value: membershipReplySchema.parse(raw.value) }
    : { ok: false as const, error: membershipFailureSchema.parse(raw.error) };
}
function identity(r: Awaited<ReturnType<typeof memberCall>>): MembershipIdentity {
  if (!r.ok || r.value.kind !== 'identity') throw new Error('Membership fixture failed');
  return r.value.identity;
}
beforeAll(async () => {
  mkdirSync(join(root, 'data'), { recursive: true });
  directory = mkdtempSync(join(root, 'data/delivery-http-'));
  const listener = createServer();
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('port');
  port = address.port;
  await new Promise<void>((r) => listener.close(() => r()));
  endpoint = `http://127.0.0.1:${port}`;
  await start();
}, 30000);
afterAll(async () => {
  await stop();
  if (directory) rmSync(directory, { recursive: true, force: true });
}, 30000);
async function group() {
  const aCredential = secret(),
    bCredential = secret();
  const alice = identity(
    await memberCall(
      '/v1/create',
      aCredential,
      { kind: 'initialize', operationId: randomUUID(), groupName: 'Shared', displayName: 'Alice' },
      true,
    ),
  );
  const path = `/v1/groups/${alice.groupId}`,
    inviteSecret = secret(),
    confirmation = secret();
  const invitation = await memberCall(path, aCredential, {
    kind: 'invite',
    operationId: randomUUID(),
    inviteSecret,
    ttlSeconds: 900,
  });
  expect(invitation.ok).toBe(true);
  const bobPending = identity(
    await memberCall(path, bCredential, {
      kind: 'join',
      operationId: randomUUID(),
      inviteSecret,
      confirmation,
      displayName: 'Bob',
    }),
  );
  const bob = identity(
    await memberCall(path, aCredential, {
      kind: 'approve',
      operationId: randomUUID(),
      installationId: bobPending.installationId,
      confirmation,
    }),
  );
  return { alice, bob, aCredential, bCredential, path };
}
function client(
  name: string,
  remote: MembershipIdentity,
  credential: string,
  http: typeof fetch = fetch,
) {
  const base = join(directory, randomUUID());
  mkdirSync(base);
  const events = join(base, 'events.sqlite'),
    outbox = join(base, 'outbox.sqlite');
  let repo = new GroupEventRepository(events);
  const local = repo.createGroup(name);
  const binding: protocol.PublicationBinding = {
    groupId: local.groupId,
    installationId: local.installationId,
    remoteGroupId: remote.groupId,
    epoch: randomUUID(),
    endpointId: randomUUID(),
    credentialRevision: 1,
  };
  const transport = new HostedPublicationTransport(
    () => ({
      kind: 'enrolled',
      binding,
      endpoint,
      credential,
      remoteInstallationId: remote.installationId,
      remoteMemberId: remote.memberId,
    }),
    'local-test',
    http,
  );
  let controller: GroupPublicationController | undefined;
  let grant: PublicationAccess | undefined;
  const shared: GroupContext = repo.createContext({
    groupId: local.groupId,
    memberId: local.memberId,
    installationId: local.installationId,
    visibility: 'shared',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  async function append(text: string, chunks?: string[], enqueue = true) {
    const ctx = shared;
    const source = {
      sessionId: ctx.sessionId,
      provider: 'owner' as const,
      nativeSessionId: ctx.nativeSessionId,
      messageId: randomUUID(),
    };
    const registered = await transport.query(
      binding,
      {
        kind: 'registerSource',
        operationId: randomUUID(),
        binding,
        memberId: local.memberId,
        source,
      },
      new AbortController().signal,
    );
    if (registered.kind !== 'registered') throw new Error('source');
    const scope = groupScopeSchema.parse({
      groupId: ctx.groupId,
      memberId: ctx.memberId,
      installationId: ctx.installationId,
      visibility: 'shared',
      source: {
        sessionId: ctx.sessionId,
        provider: 'owner',
        nativeSessionId: ctx.nativeSessionId,
        messageId: source.messageId,
      },
      causalRefs: [],
    });
    const access = repo.trustedHostScope(scope);
    const record = repo.append(
      access,
      groupAppendSchema.parse({
        operationId: randomUUID(),
        entityId: randomUUID(),
        expectedRevision: 0,
        category: 'Finding',
        condensedText: 'Exact research record',
        original: chunks ? { kind: 'chunked', chunks } : { kind: 'inline', text },
        evidenceRefs: [],
        corrects: null,
      }),
    );
    controller?.close();
    controller = new GroupPublicationController(outbox, repo, transport, {
      now: () => now,
      deadline: (cb, ms) => {
        const timer = setTimeout(cb, ms);
        return () => clearTimeout(timer);
      },
    });
    grant = controller.trustedHostRegister(binding, () => ({ access, binding }));
    const operationId = enqueue
      ? controller.enqueue(grant, [record.event.eventId]).operations[0]
      : randomUUID();
    return { event: record.event, operationId, scope, original: chunks ? chunks.join('') : text };
  }
  async function step(operationId: string) {
    if (!controller || !grant) throw new Error('controller');
    now += 60000;
    return controller.step(grant, operationId);
  }
  async function complete(operationId: string) {
    for (let i = 0; i < 90; i++) {
      const result = await step(operationId);
      if (result.state === 'complete') return;
      expect(['pending', 'waiting']).toContain(result.state);
    }
    throw new Error('Bounded completion failed');
  }
  function restart(scope: ReturnType<typeof groupScopeSchema.parse>) {
    controller?.close();
    repo.close();
    repo = new GroupEventRepository(events);
    controller = new GroupPublicationController(outbox, repo, transport, {
      now: () => now,
      deadline: (cb, ms) => {
        const timer = setTimeout(cb, ms);
        return () => clearTimeout(timer);
      },
    });
    const access = repo.trustedHostScope(scope);
    grant = controller.trustedHostRegister(binding, () => ({ access, binding }));
  }
  return {
    events,
    outbox,
    local,
    binding,
    transport,
    append,
    step,
    complete,
    restart,
    get repo() {
      return repo;
    },
    get shared() {
      return shared;
    },
    close() {
      controller?.close();
      repo.close();
    },
  };
}
it('two independent Node repositories/outboxes enroll, publish, recover a lost commit ack after workerd/process restart and expand exact 64-chunk 1MiB originals', async () => {
  const g = await group();
  let drop = true,
    commits = 0;
  const dropping: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      kind?: string;
      packet?: { kind?: string };
    };
    if (body.kind === 'effect' && body.packet?.kind === 'commit') {
      commits++;
      if (drop) {
        drop = false;
        await response.body?.cancel();
        throw new Error('Simulated lost ack');
      }
    }
    return response;
  };
  const a = client('Local Alice', g.alice, g.aCredential, dropping),
    b = client('Local Bob', g.bob, g.bCredential);
  try {
    expect(a.events).not.toBe(b.events);
    expect(a.outbox).not.toBe(b.outbox);
    const first = await a.append(' \n e\u0301 é 🧬 \u202e exact original');
    for (let i = 0; i < 8; i++) {
      const result = await a.step(first.operationId);
      if (result.state === 'uncertain') break;
    }
    expect(commits).toBe(1);
    await stop();
    a.restart(first.scope);
    await start();
    await a.complete(first.operationId);
    expect(commits).toBe(1);
    const chunks = Array.from({ length: 64 }, (_, i) =>
      String.fromCharCode(65 + (i % 26)).repeat(16384),
    );
    const second = await b.append('', chunks);
    await b.complete(second.operationId);
    const third = await a.append('second message from the same persisted context');
    expect(third.scope.source.sessionId).toBe(first.scope.source.sessionId);
    expect(third.scope.source.nativeSessionId).toBe(first.scope.source.nativeSessionId);
    expect(third.scope.source.messageId).not.toBe(first.scope.source.messageId);
    await a.complete(third.operationId);
    const signal = new AbortController().signal;
    const page = await b.transport.query(
      b.binding,
      { kind: 'feed', after: 0, limit: 1, cursor: null },
      signal,
    );
    if (page.kind !== 'feed' || !page.continuation) throw new Error('feed');
    expect(page.entries[0].header.event).toEqual(first.event);
    const next = await a.transport.query(
      a.binding,
      { kind: 'feed', after: 0, limit: 1, cursor: page.continuation },
      signal,
    );
    expect(next).toMatchObject({
      kind: 'feed',
      watermark: 3,
      entries: [{ header: { event: second.event }, remoteSequence: 2 }],
    });
    let original = '';
    for (let start = 0; start < 64; start += 4) {
      const expanded = await a.transport.query(
        a.binding,
        { kind: 'expand', eventId: second.event.eventId, start, count: 4 },
        signal,
      );
      if (expanded.kind !== 'expansion') throw new Error('expansion');
      original += expanded.chunks.map((c) => c.text).join('');
    }
    expect(Buffer.byteLength(original)).toBe(1048576);
    expect(original).toBe(second.original);
    const exact = await b.transport.query(
      b.binding,
      { kind: 'expand', eventId: first.event.eventId, start: 0, count: 1 },
      signal,
    );
    expect(exact).toMatchObject({ kind: 'expansion', chunks: [{ text: first.original }] });
    const privateContext = a.repo.createContext({
      groupId: a.local.groupId,
      memberId: a.local.memberId,
      installationId: a.local.installationId,
      visibility: 'private',
      provider: 'owner',
      nativeSessionId: 'private-native-canary',
    });
    const privateScope = groupScopeSchema.parse({
      groupId: privateContext.groupId,
      memberId: privateContext.memberId,
      installationId: privateContext.installationId,
      visibility: 'private',
      source: {
        sessionId: privateContext.sessionId,
        provider: 'owner',
        nativeSessionId: privateContext.nativeSessionId,
        messageId: 'private-message-canary',
      },
      causalRefs: [],
    });
    const privateEvent = a.repo.append(
      a.repo.trustedHostScope(privateScope),
      groupAppendSchema.parse({
        operationId: randomUUID(),
        entityId: randomUUID(),
        expectedRevision: 0,
        category: 'Idea',
        condensedText: 'Private',
        original: { kind: 'inline', text: 'PRIVATE ORIGINAL CANARY' },
        evidenceRefs: [],
        corrects: null,
      }),
    ).event;
    await expect(
      b.transport.query(
        b.binding,
        { kind: 'expand', eventId: privateEvent.eventId, start: 0, count: 1 },
        signal,
      ),
    ).rejects.toBeInstanceOf(HostedPublicationError);
    expect(
      (
        await memberCall(g.path, g.bCredential, {
          kind: 'revoke',
          operationId: randomUUID(),
          installationId: g.alice.installationId,
        })
      ).ok,
    ).toBe(true);
    await expect(
      a.transport.query(a.binding, { kind: 'feed', after: 0, limit: 8, cursor: null }, signal),
    ).rejects.toBeInstanceOf(HostedPublicationError);
    const { event: _event, ...key } = protocol.publicationEnvelope(a.binding, first.operationId, {
      event: first.event,
      original: first.original,
    }).header;
    expect(await a.transport.receipt(key, signal)).toEqual({
      kind: 'unavailable',
      reason: 'offline',
    });
    await expect(a.transport.effect({ kind: 'commit', key }, signal)).rejects.toBeInstanceOf(
      HostedPublicationError,
    );
  } finally {
    a.close();
    b.close();
  }
}, 120000);
it('wire schemas preserve exact protocol180 serialization and hash decisions', () => {
  const binding = {
    groupId: randomUUID(),
    installationId: randomUUID(),
    remoteGroupId: randomUUID(),
    epoch: randomUUID(),
    endpointId: randomUUID(),
    credentialRevision: 1,
  };
  const key = {
    version: 1 as const,
    binding,
    operationId: randomUUID(),
    payloadHash: 'a'.repeat(64),
  };
  expect(wire.publicationCanonical(key)).toBe(protocol.publicationCanonical(key));
  expect(wire.publicationHash(wire.publicationCanonical(key))).toBe(
    protocol.publicationHash(protocol.publicationCanonical(key)),
  );
  expect(wire.publicationKeySchema.parse(key)).toEqual(protocol.publicationKeySchema.parse(key));
  for (const state of ['absent', 'collision'] as const)
    expect(wire.publicationReceiptSchema.parse({ ...key, state })).toEqual(
      protocol.publicationReceiptSchema.parse({ ...key, state }),
    );
  expect(wire.PUBLICATION_LIMITS).toEqual(protocol.PUBLICATION_LIMITS);
});
it('default-disabled and preflight unavailable/aborted effects have genuine no-handoff proof', async () => {
  const binding = {
    groupId: randomUUID(),
    installationId: randomUUID(),
    remoteGroupId: randomUUID(),
    epoch: randomUUID(),
    endpointId: randomUUID(),
    credentialRevision: 1,
  };
  const key = {
    version: 1 as const,
    binding,
    operationId: randomUUID(),
    payloadHash: 'b'.repeat(64),
  };
  let calls = 0;
  const http: typeof fetch = async () => {
    calls++;
    throw new Error('unused');
  };
  const disabled = new HostedPublicationTransport(
    () => {
      throw new Error('should not resolve');
    },
    'disabled',
    http,
  );
  expect(await disabled.effect({ kind: 'commit', key }, new AbortController().signal)).toEqual({
    kind: 'not_sent',
    reason: 'offline',
  });
  const known = new HostedPublicationTransport(
    () => ({ kind: 'unavailable', reason: 'revoked' }),
    'local-test',
    http,
  );
  expect(await known.effect({ kind: 'commit', key }, new AbortController().signal)).toEqual({
    kind: 'not_sent',
    reason: 'revoked',
  });
  const aborted = new HostedPublicationTransport(
    () => ({
      kind: 'enrolled',
      binding,
      endpoint,
      credential: secret(),
      remoteInstallationId: randomUUID(),
      remoteMemberId: randomUUID(),
    }),
    'local-test',
    http,
  );
  expect(await aborted.effect({ kind: 'commit', key }, AbortSignal.abort())).toEqual({
    kind: 'not_sent',
    reason: 'offline',
  });
  expect(calls).toBe(0);
});
it('bounds malformed, excessive and mismatched replies and never labels a possible handoff not_sent', async () => {
  const binding = {
    groupId: randomUUID(),
    installationId: randomUUID(),
    remoteGroupId: randomUUID(),
    epoch: randomUUID(),
    endpointId: randomUUID(),
    credentialRevision: 1,
  };
  const key = {
    version: 1 as const,
    binding,
    operationId: randomUUID(),
    payloadHash: 'b'.repeat(64),
  };
  const resolveGrant = () => ({
    kind: 'enrolled' as const,
    binding,
    endpoint,
    credential: secret(),
    remoteInstallationId: randomUUID(),
    remoteMemberId: randomUUID(),
  });
  const replies = [
    new Response('a'.repeat(5000), { headers: { 'Content-Type': 'application/json' } }),
    Response.json({
      ok: true,
      value: { kind: 'receipt', receipt: { ...key, operationId: randomUUID(), state: 'absent' } },
    }),
    new Response(null, { status: 403 }),
    Response.json({ ok: false, error: 'denied' }),
    new Response('{bad', { headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const response of replies) {
    const adapter = new HostedPublicationTransport(
      resolveGrant,
      'local-test',
      async (_input, init) => {
        expect(init?.redirect).toBe('error');
        expect(init?.credentials).toBe('omit');
        return response;
      },
    );
    await expect(
      adapter.effect({ kind: 'commit', key }, new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedPublicationError);
  }
  const slow = new HostedPublicationTransport(
    resolveGrant,
    'local-test',
    async () =>
      new Response(
        new ReadableStream({
          start() {
            /* stays pending */
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const abort = new AbortController();
  const pending = slow.effect({ kind: 'commit', key }, abort.signal);
  setTimeout(() => abort.abort(), 20);
  await expect(pending).rejects.toBeInstanceOf(HostedPublicationError);
});

it('HTTP event staging limit preserves both independent local outboxes and member revocation', async () => {
  const g = await group(),
    a = client('Quota Alice', g.alice, g.aCredential),
    b = client('Quota Bob', g.bob, g.bCredential);
  try {
    for (let i = 0; i < 64; i++) {
      const c = a,
        record = await c.append(`staged ${i}`);
      const envelope = protocol.publicationEnvelope(c.binding, record.operationId, {
        event: record.event,
        original: record.original,
      });
      const reply = await c.transport.effect(
        { kind: 'begin', header: envelope.header },
        new AbortController().signal,
      );
      expect(reply).toMatchObject({ kind: 'receipt', receipt: { state: 'staged', missing: [0] } });
    }
    const independent = await b.append('Bob still has independent staging capacity');
    expect(
      await b.transport.effect(
        {
          kind: 'begin',
          header: protocol.publicationEnvelope(b.binding, independent.operationId, {
            event: independent.event,
            original: independent.original,
          }).header,
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ kind: 'receipt', receipt: { state: 'staged' } });
    const record = await a.append('over remote staging quota', undefined, false);
    const envelope = protocol.publicationEnvelope(a.binding, record.operationId, {
      event: record.event,
      original: record.original,
    });
    await expect(
      a.transport.effect({ kind: 'begin', header: envelope.header }, new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedPublicationError);
    const { event: _event, ...key } = envelope.header;
    expect(await a.transport.receipt(key, new AbortController().signal)).toMatchObject({
      kind: 'receipt',
      receipt: { state: 'absent' },
    });
    expect(
      (
        await memberCall(g.path, g.bCredential, {
          kind: 'revoke',
          operationId: randomUUID(),
          installationId: g.alice.installationId,
        })
      ).ok,
    ).toBe(true);
    expect(
      (await memberCall(g.path, g.aCredential, { kind: 'roster', after: 0, limit: 1 })).ok,
    ).toBe(false);
    const afterRevoke = await b.append('Bob remains usable after revoked staging is retained');
    expect(
      await b.transport.effect(
        {
          kind: 'begin',
          header: protocol.publicationEnvelope(b.binding, afterRevoke.operationId, {
            event: afterRevoke.event,
            original: afterRevoke.original,
          }).header,
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ kind: 'receipt', receipt: { state: 'staged' } });
  } finally {
    a.close();
    b.close();
  }
}, 60000);

it('native Node fetch refuses redirects without forwarding credentials to a second receiver', async () => {
  let firstHandoffs = 0,
    redirectHandoffs = 0;
  const target = createHttpServer((_request, response) => {
    redirectHandoffs++;
    response.writeHead(200).end();
  });
  const redirector = createHttpServer((_request, response) => {
    firstHandoffs++;
    const address = target.address();
    if (!address || typeof address === 'string') throw new Error('address');
    response.writeHead(307, { Location: `http://127.0.0.1:${address.port}/capture` }).end();
  });
  try {
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    const address = redirector.address();
    if (!address || typeof address === 'string') throw new Error('address');
    const binding = {
      groupId: randomUUID(),
      installationId: randomUUID(),
      remoteGroupId: randomUUID(),
      epoch: randomUUID(),
      endpointId: randomUUID(),
      credentialRevision: 1,
    };
    const transport = new HostedPublicationTransport(
      () => ({
        kind: 'enrolled',
        binding,
        endpoint: `http://127.0.0.1:${address.port}`,
        credential: secret(),
        remoteInstallationId: randomUUID(),
        remoteMemberId: randomUUID(),
      }),
      'local-test',
    );
    await expect(
      transport.effect(
        {
          kind: 'commit',
          key: { version: 1, binding, operationId: randomUUID(), payloadHash: 'c'.repeat(64) },
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HostedPublicationError);
    expect(firstHandoffs).toBe(1);
    expect(redirectHandoffs).toBe(0);
  } finally {
    redirector.closeAllConnections();
    target.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => redirector.close(() => r())),
      new Promise<void>((r) => target.close(() => r())),
    ]);
  }
});

it('bounds an unresponsive fetch and sanitizes host resolution/schema failures', async () => {
  const binding = {
    groupId: randomUUID(),
    installationId: randomUUID(),
    remoteGroupId: randomUUID(),
    epoch: randomUUID(),
    endpointId: randomUUID(),
    credentialRevision: 1,
  };
  const key = {
    version: 1 as const,
    binding,
    operationId: randomUUID(),
    payloadHash: 'd'.repeat(64),
  };
  const resolveGrant = () => ({
    kind: 'enrolled' as const,
    binding,
    endpoint,
    credential: secret(),
    remoteInstallationId: randomUUID(),
    remoteMemberId: randomUUID(),
  });
  const hanging = new HostedPublicationTransport(
    resolveGrant,
    'local-test',
    async () => new Promise<Response>(() => {}),
  );
  const abort = new AbortController();
  const pending = hanging.effect({ kind: 'commit', key }, abort.signal);
  setTimeout(() => abort.abort(), 20);
  await expect(pending).rejects.toBeInstanceOf(HostedPublicationError);
  const canary = 'PRIVATE HOST PATH AND CAPABILITY';
  const throwing = new HostedPublicationTransport(() => {
    throw new Error(canary);
  }, 'local-test');
  try {
    await throwing.effect({ kind: 'commit', key }, new AbortController().signal);
    throw new Error('should fail');
  } catch (error) {
    expect(error).toBeInstanceOf(HostedPublicationError);
    expect(String(error)).not.toContain(canary);
  }
  const unsafe = new HostedPublicationTransport(
    () => ({ ...resolveGrant(), endpoint: `http://user:${canary}@127.0.0.1/` }),
    'local-test',
  );
  await expect(
    unsafe.effect({ kind: 'commit', key }, new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedPublicationError);
});

it('native Node HTTPS retains TLS verification and sends protected approval/auth headers only to the approved origin', async () => {
  const fixtureDir = mkdtempSync(join(directory, 'tls-'));
  const cert = join(fixtureDir, 'cert.pem'),
    keyFile = join(fixtureDir, 'key.pem');
  const generated = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      cert,
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-days',
      '1',
    ],
    { stdio: 'ignore' },
  );
  expect(generated.status).toBe(0);
  const binding = {
    groupId: randomUUID(),
    installationId: randomUUID(),
    remoteGroupId: randomUUID(),
    epoch: randomUUID(),
    endpointId: randomUUID(),
    credentialRevision: 1,
  };
  const key = {
    version: 1 as const,
    binding,
    operationId: randomUUID(),
    payloadHash: 'e'.repeat(64),
  };
  const credential = secret(),
    approval = secret();
  let handoffs = 0;
  const receiver = createHttpsServer(
    { cert: readFileSync(cert), key: readFileSync(keyFile) },
    (req, res) => {
      handoffs++;
      expect(req.headers.authorization).toBe(`Bearer ${credential}`);
      expect(req.headers['x-hosting-approval']).toBe(approval);
      expect(req.url).toBe(`/v1/groups/${binding.remoteGroupId}/delivery`);
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          ok: true,
          value: { kind: 'receipt', receipt: { ...key, state: 'absent' } },
        }),
      );
    },
  );
  try {
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    const address = receiver.address();
    if (!address || typeof address === 'string') throw new Error('port');
    const endpoint = `https://127.0.0.1:${address.port}`;
    const resolution = {
      kind: 'enrolled' as const,
      binding,
      endpoint,
      credential,
      remoteInstallationId: randomUUID(),
      remoteMemberId: randomUUID(),
      hostingAuthorization: {
        origin: endpoint,
        approvalCapability: approval,
        freeApprovalId: randomUUID(),
      },
    };
    const transport = new HostedPublicationTransport(() => resolution, 'hosted');
    // Default native fetch must reject this test-owned self-signed certificate.
    await expect(
      transport.effect({ kind: 'commit', key }, new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedPublicationError);
    expect(handoffs).toBe(0);
    const script = join(fixtureDir, 'client.mjs');
    writeFileSync(
      script,
      `import {HostedPublicationTransport} from ${JSON.stringify(new URL('./group-publication-host-transport.ts', import.meta.url).href)};\nprocess.once('message',async({resolution,key})=>{try{const result=await new HostedPublicationTransport(()=>resolution,'hosted').effect({kind:'commit',key},new AbortController().signal);process.send({ok:result.kind==='receipt'&&result.receipt.state==='absent'});}catch{process.send({ok:false});}process.disconnect();});\n`,
    );
    const child = spawn(
      process.execPath,
      ['--import', join(root, 'apps/server/node_modules/tsx/dist/loader.mjs'), script],
      {
        cwd: join(root, 'apps/server'),
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    try {
      const reply = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('TLS fixture timeout')), 10000);
        child.once('message', (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        child.once('error', () => {
          clearTimeout(timer);
          reject(new Error('TLS fixture child failed'));
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('TLS fixture child exited'));
        });
        child.send({ resolution, key });
      });
      expect(reply).toEqual({ ok: true });
      await exited;
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
    }
    expect(handoffs).toBe(1);
    for (const invalid of [
      { ...resolution, endpoint: endpoint.replace('https:', 'http:') },
      { ...resolution, endpoint: `${endpoint}/unexpected` },
      { ...resolution, endpoint: `${endpoint}?capability=${approval}` },
      {
        ...resolution,
        hostingAuthorization: {
          ...resolution.hostingAuthorization,
          origin: 'https://different.example.invalid',
        },
      },
    ]) {
      await expect(
        new HostedPublicationTransport(() => invalid, 'hosted').effect(
          { kind: 'commit', key },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(HostedPublicationError);
    }
    expect(handoffs).toBe(1);
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((r) => receiver.close(() => r()));
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}, 30000);

it('validates server-attested enrollment authors without trusting visible local member labels', async () => {
  const g = await group(),
    a = client('Attested Alice', g.alice, g.aCredential);
  try {
    const record = await a.append('immutable author-bound original');
    const header = protocol.publicationEnvelope(a.binding, record.operationId, {
      event: record.event,
      original: record.original,
    }).header;
    const author = {
      groupId: g.alice.groupId,
      installationId: g.alice.installationId,
      memberId: g.alice.memberId,
    };
    const resolution = {
      kind: 'enrolled' as const,
      binding: a.binding,
      endpoint,
      credential: g.aCredential,
      remoteInstallationId: g.alice.installationId,
      remoteMemberId: g.alice.memberId,
    };
    for (const counterfeit of [
      { ...author, groupId: randomUUID() },
      { ...author, installationId: randomUUID() },
      { ...author, memberId: randomUUID() },
    ]) {
      const transport = new HostedPublicationTransport(
        () => resolution,
        'local-test',
        async () =>
          Response.json({
            ok: true,
            value: {
              kind: 'feed',
              entries: [{ header, author: counterfeit, remoteSequence: 1 }],
              watermark: 1,
              continuation: null,
            },
          }),
      );
      await expect(
        transport.query(
          a.binding,
          { kind: 'feed', after: 0, limit: 1, cursor: null },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(HostedPublicationError);
    }
    const exact = new HostedPublicationTransport(
      () => resolution,
      'local-test',
      async () =>
        Response.json({
          ok: true,
          value: {
            kind: 'feed',
            entries: [{ header, author, remoteSequence: 1 }],
            watermark: 1,
            continuation: null,
          },
        }),
    );
    expect(
      await exact.query(
        a.binding,
        { kind: 'feed', after: 0, limit: 1, cursor: null },
        new AbortController().signal,
      ),
    ).toMatchObject({ kind: 'feed', entries: [{ header, author }] });
  } finally {
    a.close();
  }
});
