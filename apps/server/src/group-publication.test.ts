import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  groupAppendSchema,
  groupScopeSchema,
  type GroupContext,
  type GroupScope,
} from '@dock/shared';
import { GroupEventRepository, type GroupAccess } from './group-events.js';
import {
  GroupPublicationController,
  GroupPublicationError,
  type PublicationAccess,
  type PublicationScheduling,
} from './group-publication.js';
import {
  PUBLICATION_LIMITS as LIMITS,
  publicationEnvelope,
  publicationEnvelopeSchema,
  publicationEffectSchema,
  publicationHash,
  publicationCanonical,
  type PublicationBinding,
  type PublicationHeader,
  type PublicationKey,
  type PublicationReceipt,
  type PublicationTransport,
} from './group-publication-protocol.js';
import {
  PublicationReceiverFixture,
  PublicationLoopbackFixture,
} from './group-publication-receiver.fixture.js';

let directory: string, eventsPath: string, journalPath: string, receiverPath: string;
let repo: GroupEventRepository, controller: GroupPublicationController;
let receiver: PublicationReceiverFixture, http: PublicationLoopbackFixture;
let member: ReturnType<GroupEventRepository['createGroup']>;
let shared: GroupContext, privateContext: GroupContext, otherContext: GroupContext;
let localAccess: GroupAccess, grant: PublicationAccess;
let binding: PublicationBinding, liveBinding: PublicationBinding;
let now: number;
const context = (person: typeof member, visibility: 'shared' | 'private') =>
  repo.createContext({
    groupId: person.groupId,
    memberId: person.memberId,
    installationId: person.installationId,
    visibility,
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
const scope = (ctx: GroupContext, refs: GroupScope['causalRefs'] = []): GroupScope =>
  groupScopeSchema.parse({
    groupId: ctx.groupId,
    memberId: ctx.memberId,
    installationId: ctx.installationId,
    visibility: ctx.visibility,
    source: {
      sessionId: ctx.sessionId,
      provider: ctx.provider,
      nativeSessionId: ctx.nativeSessionId,
      messageId: randomUUID(),
    },
    causalRefs: refs,
  });
const append = (
  ctx = shared,
  text = 'Original \n  e\u0301 é 🧬 \u202e exact',
  refs: GroupScope['causalRefs'] = [],
  chunks?: string[],
) =>
  repo.append(
    repo.trustedHostScope(scope(ctx, refs)),
    groupAppendSchema.parse({
      operationId: randomUUID(),
      entityId: randomUUID(),
      expectedRevision: 0,
      category: 'Question',
      condensedText: 'Shared scientific question.',
      original: chunks ? { kind: 'chunked', chunks } : { kind: 'inline', text },
      evidenceRefs: refs,
      corrects: null,
    }),
  ).event;
const scheduling: PublicationScheduling = {
  now: () => now,
  deadline(callback, delay) {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};
const authority = () => ({ access: localAccess, binding: liveBinding });
const open = (transport: PublicationTransport = http) => {
  controller = new GroupPublicationController(journalPath, repo, transport, scheduling);
  grant = controller.trustedHostRegister(binding, authority);
};
const enqueue = (eventId: string) => controller.enqueue(grant, [eventId]).operations[0];
const advance = (ms: number = LIMITS.maxBackoffMs) => {
  now += ms;
};
const complete = async (operationId: string) => {
  for (let i = 0; i < 80; i++) {
    const result = await controller.step(grant, operationId);
    if (result.state === 'complete') return;
    expect(['pending', 'waiting']).toContain(result.state);
    advance();
  }
  throw new Error('Bounded fixture did not complete');
};
const journalRows = () => {
  const db = new DatabaseSync(journalPath, { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT operation_id,event_id,state,intent,receipt_json,header_json FROM gp_operations',
      )
      .all() as {
      operation_id: string;
      event_id: string;
      state: string;
      intent: number;
      receipt_json: string | null;
      header_json: string;
    }[];
  } finally {
    db.close();
  }
};
// Materialize a genuine old journal layout, including completed full headers.
const legacyJournal = (version: 1 | 2) => {
  const db = new DatabaseSync(journalPath);
  try {
    db.exec(`DROP TRIGGER gp_identity_immutable; DROP TRIGGER gp_header_immutable;
      DROP TRIGGER gp_complete_immutable; DROP INDEX gp_event_identity`);
    for (const raw of db.prepare('SELECT * FROM gp_operations WHERE compact=1').iterate()) {
      const row = raw as { operation_id: string; event_id: string; partition_id: string };
      const partition = db
        .prepare('SELECT binding_json FROM gp_partitions WHERE partition_id=?')
        .get(row.partition_id) as { binding_json: string };
      const record = repo.sharedPublication(localAccess, [row.event_id])[0];
      db.prepare('UPDATE gp_operations SET header_json=? WHERE operation_id=?').run(
        publicationCanonical(
          publicationEnvelope(
            JSON.parse(partition.binding_json) as PublicationBinding,
            row.operation_id,
            record,
          ).header,
        ),
        row.operation_id,
      );
    }
    db.exec(`ALTER TABLE gp_operations DROP COLUMN header_hash;
      ALTER TABLE gp_operations DROP COLUMN source_json; ALTER TABLE gp_operations DROP COLUMN compact;
      CREATE TRIGGER gp_identity_immutable BEFORE UPDATE OF operation_id,partition_id,event_id,header_json,payload_hash ON gp_operations
      BEGIN SELECT RAISE(ABORT,'immutable publication identity'); END;`);
    if (version === 1) db.exec('ALTER TABLE gp_operations DROP COLUMN budget');
    db.prepare('UPDATE gp_schema SET version=?').run(version);
  } finally {
    db.close();
  }
};
const crash = (
  mode:
    | 'enqueue'
    | 'enqueue-result'
    | 'offline'
    | 'before-effect'
    | 'after-effect'
    | 'after-receipt'
    | 'before-completion'
    | 'after-completion'
    | 'before-migration'
    | 'after-migration',
  eventId: string,
  journal = journalPath,
  childBinding = binding,
  offlineDeadlineMs = 10_000,
) =>
  new Promise<{ code: number | null; output: string }>((resolveChild, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./group-publication-crash.fixture.ts', import.meta.url)),
      ],
      {
        cwd: resolve('.'),
        env: {
          PATH: process.env.PATH,
          GROUP_PUBLICATION_FIXTURE: JSON.stringify({
            events: eventsPath,
            journal,
            scope: scope(shared),
            binding: childBinding,
            url: receiver.url,
            secret: receiver.secret,
            eventId,
            now,
            mode,
          }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '',
      error = '';
    // Full-payload offline cases perform 110 recovery steps in this one child.
    const timeout = setTimeout(
      () => {
        child.kill('SIGKILL');
        reject(new Error('Owned child deadline'));
      },
      mode === 'offline' ? offlineDeadlineMs : 10_000,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString();
    });
    child.on('error', (cause) => {
      clearTimeout(timeout);
      reject(cause);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 1) reject(new Error(error));
      else resolveChild({ code, output });
    });
  });
beforeEach(async () => {
  expect(process.versions.node.split('.')[0]).toBe('24');
  const root = resolve(process.env.GROUP_PUBLICATION_TEST_TMPDIR ?? 'data/group-publication-tests');
  mkdirSync(root, { recursive: true });
  directory = mkdtempSync(join(root, 'case-'));
  eventsPath = join(directory, 'events.sqlite');
  journalPath = join(directory, 'outbox.sqlite');
  receiverPath = join(directory, 'receiver.sqlite');
  repo = new GroupEventRepository(eventsPath);
  member = repo.createGroup('Alice');
  shared = context(member, 'shared');
  privateContext = context(member, 'private');
  otherContext = context(repo.createGroup('Other'), 'shared');
  localAccess = repo.trustedHostScope(scope(shared));
  binding = {
    groupId: member.groupId,
    installationId: member.installationId,
    epoch: randomUUID(),
    remoteGroupId: randomUUID(),
    endpointId: randomUUID(),
    credentialRevision: 1,
  };
  liveBinding = { ...binding };
  now = 1_000_000;
  receiver = new PublicationReceiverFixture(receiverPath, binding);
  await receiver.listen();
  http = new PublicationLoopbackFixture(receiver.url, receiver.secret);
  open();
});
afterEach(async () => {
  try {
    controller.close();
  } catch {
    /* A crash test may already have closed it. */
  }
  try {
    repo.close();
  } finally {
    try {
      await receiver.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

it('uses repository and controller capabilities; rejects browser labels, private handles and wrong installation mappings', () => {
  const event = append();
  expect(() =>
    controller.enqueue(binding as unknown as PublicationAccess, [event.eventId]),
  ).toThrow('unauthorized');
  expect(() =>
    controller.trustedHostRegister(binding, () => ({
      access: scope(shared) as unknown as GroupAccess,
      binding,
    })),
  ).toThrow('unauthorized');
  expect(() =>
    controller.trustedHostRegister(binding, () => ({
      access: repo.trustedHostScope(scope(privateContext)),
      binding,
    })),
  ).toThrow('unauthorized');
  const wrongJournal = new GroupPublicationController(
    join(directory, 'wrong.sqlite'),
    repo,
    http,
    scheduling,
  );
  try {
    const wrong = { ...binding, installationId: randomUUID() };
    const wrongGrant = wrongJournal.trustedHostRegister(wrong, () => ({
      access: localAccess,
      binding: wrong,
    }));
    expect(() => wrongJournal.enqueue(wrongGrant, [event.eventId])).toThrow('unauthorized');
  } finally {
    wrongJournal.close();
  }
  expect(journalRows()).toEqual([]);
});

it('atomically enqueues only authorized refs and never journals or transports private/other-group activity', async () => {
  const first = append();
  const canaries = Array.from({ length: 12 }, (_, index) =>
    append(index % 2 ? privateContext : otherContext, `PRIVATE-CANARY-${index}-🔐`),
  );
  const second = append();
  expect(second.sequence).toBe(first.sequence + 1);
  for (const canary of canaries) {
    expect(() => controller.enqueue(grant, [first.eventId, canary.eventId])).toThrow(
      /^Group publication: unauthorized$/,
    );
    expect(controller.inspect(grant, canary.eventId)).toEqual({ state: 'idle' });
  }
  expect(journalRows()).toHaveLength(0);
  const operations = controller.enqueue(grant, [first.eventId, second.eventId]).operations;
  for (const operation of operations) await complete(operation);
  const persisted =
    readFileSync(journalPath).toString('utf8') + readFileSync(receiverPath).toString('utf8');
  for (const event of canaries) {
    for (const value of [
      event.eventId,
      event.scope.source.sessionId,
      event.scope.source.messageId,
      event.scope.source.nativeSessionId,
      event.entityId,
    ])
      expect(persisted).not.toContain(value);
  }
  expect(persisted).not.toContain('PRIVATE-CANARY');
  expect(persisted).not.toContain(receiver.secret);
  expect(receiver.trace.every((item) => operations.includes(item.operationId))).toBe(true);
});

it('preserves exact Unicode, original byte boundaries, manifests and causal IDs through partial chunks and restart', async () => {
  const cause = append();
  const chunks = ['e\u0301🧬\n'.repeat(1600), 'é \u202e\t'.repeat(1600), '终'.repeat(3000)];
  const event = append(shared, '', [cause.eventId], chunks);
  const operation = enqueue(event.eventId);
  expect(await controller.step(grant, operation)).toEqual({ state: 'pending' }); // begin
  advance();
  expect(await controller.step(grant, operation)).toEqual({ state: 'pending' }); // chunk 0
  controller.close();
  repo.close();
  repo = new GroupEventRepository(eventsPath);
  localAccess = repo.trustedHostScope(scope(shared));
  open();
  expect(enqueue(event.eventId)).toBe(operation);
  await complete(operation);
  const storedHeader = JSON.parse(
    (
      receiver.db
        .prepare('SELECT header_json FROM operations WHERE operation_id=?')
        .get(operation) as { header_json: string }
    ).header_json,
  ) as PublicationHeader;
  const storedChunks = receiver.db
    .prepare('SELECT text FROM chunks WHERE operation_id=? ORDER BY chunk_index')
    .all(operation) as { text: string }[];
  expect(storedHeader.event).toEqual(event);
  expect(storedHeader.event.evidenceRefs).toEqual([cause.eventId]);
  expect(storedHeader.event.scope.causalRefs).toEqual([cause.eventId]);
  expect(storedChunks.map((item) => item.text)).toEqual(chunks);
  expect(receiver.trace.filter((item) => item.kind === 'chunk')).toHaveLength(3);
  expect(journalRows()[0].receipt_json).not.toBeNull();
});

it.each(['begin', 'chunk', 'commit'] as const)(
  'reconciles a lost %s acknowledgement before another same-ID effect',
  async (kind) => {
    const event = append();
    const operation = enqueue(event.eventId);
    if (kind !== 'begin') {
      await controller.step(grant, operation);
      advance();
    }
    if (kind === 'commit') {
      await controller.step(grant, operation);
      advance();
    }
    receiver.dropAcknowledgement = kind;
    expect(await controller.step(grant, operation)).toEqual({ state: 'uncertain' });
    expect(controller.inspect(grant, operation).uncertain).toBe(true);
    const traceStart = receiver.trace.length;
    controller.close();
    open();
    advance();
    await complete(operation);
    expect(receiver.trace[traceStart]).toEqual({ kind: 'receipt', operationId: operation });
    expect(receiver.trace.filter((item) => item.kind === kind)).toHaveLength(1);
    expect(
      (
        receiver.db
          .prepare("SELECT COUNT(*) AS n FROM operations WHERE state='committed'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
    expect(receiver.trace.every((item) => item.operationId === operation)).toBe(true);
  },
);

it('deduplicates concurrent cross-process enqueue and fences overlapping controller steps with a durable lease', async () => {
  const event = append();
  const children = await Promise.all([
    crash('enqueue', event.eventId),
    crash('enqueue', event.eventId),
  ]);
  expect(children.map((child) => child.code)).toEqual([0, 0]);
  expect(children[0].output).toBe(children[1].output);
  const operation = enqueue(event.eventId);
  expect(operation).toBe(children[0].output);
  const peer = new GroupPublicationController(journalPath, repo, http, scheduling);
  try {
    const peerGrant = peer.trustedHostRegister(binding, authority);
    const results = await Promise.all([
      controller.step(grant, operation),
      peer.step(peerGrant, operation),
    ]);
    expect(results.map((result) => result.state).sort()).toEqual(['busy', 'pending']);
    expect(journalRows()).toHaveLength(1);
    expect(receiver.trace.filter((item) => item.kind === 'begin')).toHaveLength(1);
  } finally {
    peer.close();
  }
});

it.each(['before-effect', 'after-effect', 'after-receipt'] as const)(
  'recovers an actual process exit at %s without a new operation or duplicate effect',
  async (mode) => {
    const event = append();
    const operation = enqueue(event.eventId);
    if (mode !== 'before-effect') {
      await controller.step(grant, operation);
      advance(); // begin
      await controller.step(grant, operation);
      advance(); // chunk
    }
    if (mode === 'after-receipt') {
      receiver.dropAcknowledgement = 'commit';
      expect(await controller.step(grant, operation)).toEqual({ state: 'uncertain' });
      advance();
    }
    controller.close();
    const exited = await crash(mode, event.eventId);
    expect(exited.code).toBe(mode === 'before-effect' ? 77 : mode === 'after-effect' ? 78 : 79);
    open();
    const before = receiver.trace.length;
    expect(journalRows()[0].operation_id).toBe(operation);
    expect(controller.inspect(grant, operation).budgetAttempts).toBe(
      mode === 'before-effect' ? 1 : 3,
    );
    expect(await controller.step(grant, operation)).toEqual({ state: 'busy' });
    advance(LIMITS.leaseMs + 1);
    await complete(operation);
    expect(receiver.trace[before]).toEqual({ kind: 'receipt', operationId: operation });
    expect(receiver.trace.filter((item) => item.kind === 'begin')).toHaveLength(1);
    expect(journalRows()[0].state).toBe('complete');
    expect(journalRows()[0].intent).toBe(0);
    expect(controller.inspect(grant, operation).budgetAttempts).toBe(
      mode === 'before-effect' ? 4 : 3,
    );
  },
);

it('bounds offline retries, deadlines and output; definite pre-effect failure remains recoverable', async () => {
  const operation = enqueue(append().eventId);
  http.offline = true;
  expect(await controller.step(grant, operation)).toEqual({ state: 'offline' });
  expect(controller.inspect(grant, operation)).toMatchObject({
    attempts: 1,
    uncertain: false,
    nextAttemptAt: now + 1000,
  });
  for (let i = 0; i < 10; i++)
    expect(await controller.step(grant, operation)).toEqual({ state: 'waiting' });
  expect(receiver.trace).toHaveLength(0);
  advance(1000);
  await controller.step(grant, operation);
  expect(controller.inspect(grant, operation).nextAttemptAt).toBe(now + 2000);
  advance();
  http.offline = false;
  controller.close();
  open({
    receipt: (key, signal) => http.receipt(key, signal),
    async effect() {
      return { kind: 'not_sent', reason: 'offline' };
    },
  });
  expect(await controller.step(grant, operation)).toEqual({ state: 'offline' });
  expect(controller.inspect(grant, operation).uncertain).toBe(false);
  controller.close();
  open();
  advance();
  await complete(operation);
});

it('bounds newly attempted uncertain effects without blocking receipt-only reconciliation or allowing a new epoch/ID', async () => {
  const event = append();
  const operation = enqueue(event.eventId);
  controller.close();
  let effects = 0;
  open({
    receipt: (key, signal) => http.receipt(key, signal),
    async effect() {
      effects++;
      throw new Error('Unknown handoff result');
    },
  });
  for (let i = 0; i < LIMITS.attempts; i++) {
    expect(await controller.step(grant, operation)).toEqual({
      state: i + 1 === LIMITS.attempts ? 'exhausted' : 'uncertain',
    });
    advance();
  }
  expect(effects).toBe(LIMITS.attempts);
  expect(controller.inspect(grant, operation)).toMatchObject({
    state: 'exhausted',
    attempts: LIMITS.attempts,
    budgetAttempts: LIMITS.attempts,
    uncertain: true,
  });
  controller.close();
  open();
  const trace = receiver.trace.length;
  expect(await controller.step(grant, operation)).toEqual({ state: 'exhausted' });
  expect(receiver.trace.slice(trace)).toEqual([{ kind: 'receipt', operationId: operation }]);
  expect(enqueue(event.eventId)).toBe(operation);
  liveBinding = { ...binding, epoch: randomUUID() };
  const nextGrant = controller.trustedHostRegister(liveBinding, authority);
  expect(() => controller.enqueue(nextGrant, [event.eventId])).toThrow(
    /^Group publication: identity_changed$/,
  );
  expect(journalRows()).toHaveLength(1);
  expect(receiver.trace.filter((entry) => entry.kind !== 'receipt')).toEqual([]);
});

it('authorizes again after receipt and before accepting send results; revocation prevents retries and journal/status disclosure', async () => {
  const operation = enqueue(append().eventId);
  controller.close();
  open({
    async receipt(key, signal) {
      const reply = await http.receipt(key, signal);
      repo.revokeMember(member.groupId, member.memberId);
      return reply;
    },
    effect: (packet, signal) => http.effect(packet, signal),
  });
  expect(await controller.step(grant, operation)).toEqual({ state: 'unauthorized' });
  expect(receiver.trace).toEqual([{ kind: 'receipt', operationId: operation }]);
  expect(controller.inspect(grant, operation)).toEqual({ state: 'unauthorized' });
  advance();
  expect(await controller.step(grant, operation)).toEqual({ state: 'unauthorized' });
  expect(() => enqueue(append(privateContext).eventId)).toThrow();
});

it('reauthorizes after a remote effect; revocation cannot turn its acknowledgement into local completion or another send', async () => {
  const operation = enqueue(append().eventId);
  controller.close();
  open({
    receipt: (key, signal) => http.receipt(key, signal),
    async effect(packet, signal) {
      const reply = await http.effect(packet, signal);
      repo.revokeMember(member.groupId, member.memberId);
      return reply;
    },
  });
  expect(await controller.step(grant, operation)).toEqual({ state: 'unauthorized' });
  const row = journalRows()[0];
  expect(row.state).toBe('pending');
  expect(row.intent).toBe(1);
  expect(row.receipt_json).toBeNull();
  expect(controller.inspect(grant, operation)).toEqual({ state: 'unauthorized' });
  advance();
  expect(await controller.step(grant, operation)).toEqual({ state: 'unauthorized' });
  expect(receiver.trace.map((item) => item.kind)).toEqual(['receipt', 'begin']);
});

it('rejects a live authority context swap before journal observation and retains fixed revoked/offline remote status', async () => {
  const operation = enqueue(append().eventId);
  localAccess = repo.trustedHostScope(scope(otherContext));
  expect(controller.inspect(grant, operation)).toEqual({ state: 'unauthorized' });
  expect(await controller.step(grant, operation)).toEqual({ state: 'unauthorized' });
  expect(receiver.trace).toEqual([]);
  localAccess = repo.trustedHostScope(scope(shared));
  controller.close();
  open();
  receiver.revoked = true;
  expect(await controller.step(grant, operation)).toEqual({ state: 'revoked' });
  expect(receiver.trace).toEqual([]);
  receiver.revoked = false;
  advance();
  await complete(operation);
});

it('fences an expired in-flight lease before another effect and handles a late completion with durable same-ID receiver idempotency', async () => {
  const event = append();
  const operation = enqueue(event.eventId);
  let release!: () => void, entered!: () => void;
  const entry = new Promise<void>((resolveEntry) => {
    entered = resolveEntry;
  });
  const hold = new Promise<void>((resolveHold) => {
    release = resolveHold;
  });
  controller.close();
  open({
    async receipt(key, signal) {
      const reply = await http.receipt(key, signal);
      entered();
      await hold;
      return reply;
    },
    effect: (packet, signal) => http.effect(packet, signal),
  });
  const old = controller.step(grant, operation);
  await entry;
  const peer = new GroupPublicationController(journalPath, repo, http, scheduling);
  try {
    const peerGrant = peer.trustedHostRegister(binding, authority);
    advance(LIMITS.leaseMs + 1);
    expect(await peer.step(peerGrant, operation)).toEqual({ state: 'pending' });
    release();
    expect(await old).toEqual({ state: 'busy' });
    expect(receiver.trace.filter((item) => item.kind === 'begin')).toHaveLength(1);
  } finally {
    release();
    await old;
    peer.close();
  }
  controller.close();
  open();
  advance();
  await complete(operation);
});

it('reconciles before retransmission when an aborted adapter delivers its old effect late', async () => {
  const operation = enqueue(append().eventId);
  let deadline!: () => void, deliver!: () => void;
  const delayed = new Promise<void>((resolveDelivery) => {
    deliver = resolveDelivery;
  });
  let late!: Promise<unknown>;
  controller.close();
  controller = new GroupPublicationController(
    journalPath,
    repo,
    {
      receipt: (key, signal) => http.receipt(key, signal),
      effect(packet) {
        late = delayed.then(() => http.effect(packet, new AbortController().signal));
        queueMicrotask(() => deadline());
        return late as ReturnType<PublicationTransport['effect']>;
      },
    },
    {
      now: () => now,
      deadline(callback) {
        deadline = callback;
        return () => {};
      },
    },
  );
  grant = controller.trustedHostRegister(binding, authority);
  expect(await controller.step(grant, operation)).toEqual({ state: 'uncertain' });
  controller.close();
  open();
  advance();
  expect(await controller.step(grant, operation)).toEqual({ state: 'pending' });
  expect(receiver.trace.map((item) => item.kind)).toEqual(['receipt', 'receipt', 'begin']);
  deliver();
  await late;
  advance();
  await complete(operation);
  expect(
    (
      receiver.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE state='committed'").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
  expect(receiver.trace.every((item) => item.operationId === operation)).toBe(true);
});

it('leaves a lost-ack operation untouched when revoked before retry, with explicit host/remote revoked states', async () => {
  const operation = enqueue(append().eventId);
  receiver.dropAcknowledgement = 'begin';
  expect(await controller.step(grant, operation)).toEqual({ state: 'uncertain' });
  const trace = receiver.trace.length;
  repo.revokeMember(member.groupId, member.memberId);
  advance();
  expect(await controller.step(grant, operation)).toEqual({ state: 'unauthorized' });
  expect(receiver.trace).toHaveLength(trace);
  expect(controller.inspect(grant, operation)).toEqual({ state: 'unauthorized' });
  const revokedGrant = controller.trustedHostRegister; // Host errors expose only the fixed revoked code.
  expect(() =>
    revokedGrant.call(controller, binding, () => {
      throw new GroupPublicationError('revoked');
    }),
  ).toThrow(/^Group publication: revoked$/);
});

it.each(['endpointId', 'credentialRevision', 'remoteGroupId', 'epoch'] as const)(
  'blocks uncertain delivery after a changed %s and never accepts stale receipts',
  async (field) => {
    const operation = enqueue(append().eventId);
    receiver.dropAcknowledgement = 'begin';
    await controller.step(grant, operation);
    const trace = receiver.trace.length;
    liveBinding = { ...binding, [field]: field === 'credentialRevision' ? 2 : randomUUID() };
    advance();
    expect(await controller.step(grant, operation)).toEqual({ state: 'identity_changed' });
    expect(controller.inspect(grant, operation)).toEqual({ state: 'identity_changed' });
    expect(receiver.trace).toHaveLength(trace);
    if (field !== 'epoch') {
      const newGrant = controller.trustedHostRegister(liveBinding, authority);
      expect(await controller.step(newGrant, operation)).toEqual({ state: 'identity_changed' });
    }
  },
);

it.each(['hash', 'binding', 'operation', 'event', 'extra', 'missing'] as const)(
  'quarantines a mismatched %s receipt instead of accepting a claimed authenticated boolean',
  async (mutation) => {
    const event = append();
    const operation = enqueue(event.eventId);
    controller.close();
    open({
      async receipt(key) {
        let receipt: unknown = {
          ...key,
          state: 'committed',
          eventId: event.eventId,
          remoteSequence: 1,
        };
        if (mutation === 'hash')
          receipt = { ...(receipt as object), payloadHash: publicationHash('collision') };
        if (mutation === 'binding')
          receipt = { ...(receipt as object), binding: { ...binding, credentialRevision: 2 } };
        if (mutation === 'operation')
          receipt = { ...(receipt as object), operationId: randomUUID() };
        if (mutation === 'event') receipt = { ...(receipt as object), eventId: randomUUID() };
        if (mutation === 'extra')
          receipt = { ...(receipt as object), authenticated: true, secret: 'PRIVATE-CANARY' };
        if (mutation === 'missing') receipt = { ...key, state: 'staged', missing: [63] };
        return { kind: 'receipt', receipt: receipt as PublicationReceipt };
      },
      async effect() {
        throw new Error('No effect allowed');
      },
    });
    expect(await controller.step(grant, operation)).toEqual({ state: 'protocol' });
    expect(journalRows()[0].receipt_json).toBeNull();
    expect(readFileSync(journalPath).toString()).not.toContain('PRIVATE-CANARY');
    expect(await controller.step(grant, operation)).toEqual({ state: 'protocol' });
  },
);

it('receiver idempotency rejects operation collisions, altered chunks and a second effect for an already committed event', async () => {
  const event = append();
  const operation = enqueue(event.eventId);
  await complete(operation);
  const envelope = publicationEnvelope(
    binding,
    operation,
    repo.sharedPublication(localAccess, [event.eventId])[0],
  );
  const { version, payloadHash } = envelope.header;
  const key: PublicationKey = { version, binding, operationId: operation, payloadHash };
  const signal = new AbortController().signal;
  const duplicate = await http.effect({ kind: 'begin', header: envelope.header }, signal);
  expect(duplicate.kind === 'receipt' && duplicate.receipt.state).toBe('committed');
  const collision = await http.receipt(
    { ...key, payloadHash: publicationHash('different') },
    signal,
  );
  expect(collision.kind === 'receipt' && collision.receipt.state).toBe('collision');
  const next = publicationEnvelope(
    binding,
    randomUUID(),
    repo.sharedPublication(localAccess, [event.eventId])[0],
  );
  const nextKey: PublicationKey = {
    ...key,
    operationId: next.header.operationId,
    payloadHash: next.header.payloadHash,
  };
  await http.effect({ kind: 'begin', header: next.header }, signal);
  await http.effect({ kind: 'chunk', key: nextKey, chunk: next.chunks[0] }, signal);
  const second = await http.effect({ kind: 'commit', key: nextKey }, signal);
  expect(second.kind === 'receipt' && second.receipt.state).toBe('collision');
  expect(
    (
      receiver.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE state='committed'").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
  const altered = { header: envelope.header, chunks: [{ ...envelope.chunks[0], text: 'altered' }] };
  expect(publicationEnvelopeSchema.safeParse(altered).success).toBe(false);
  expect(
    publicationEffectSchema.safeParse({
      kind: 'chunk',
      key,
      chunk: { ...envelope.chunks[0], text: '\ud800' },
    }).success,
  ).toBe(false);
});

it('bounds atomic queue capacity and history and keeps other groups out of journal ownership/status', () => {
  const events = Array.from({ length: 65 }, () => append());
  for (let i = 0; i < 63; i++) enqueue(events[i].eventId);
  expect(() => controller.enqueue(grant, [events[63].eventId, events[64].eventId])).toThrow(
    'capacity',
  );
  expect(journalRows()).toHaveLength(63);
  expect(enqueue(events[0].eventId)).toBe(
    journalRows().find((row) => row.event_id === events[0].eventId)!.operation_id,
  );
  const otherBinding = {
    ...binding,
    groupId: otherContext.groupId,
    installationId: otherContext.installationId,
  };
  expect(() =>
    controller.trustedHostRegister(otherBinding, () => ({
      access: repo.trustedHostScope(scope(otherContext)),
      binding: otherBinding,
    })),
  ).toThrow('unauthorized');
  expect(() =>
    controller.enqueue(
      grant,
      Array.from({ length: 17 }, () => randomUUID()),
    ),
  ).toThrow('invalid');
  const db = new DatabaseSync(journalPath);
  try {
    expect(() => db.prepare("UPDATE gp_operations SET payload_hash='changed'").run()).toThrow(
      'immutable',
    );
    expect(() => db.prepare('DELETE FROM gp_operations').run()).toThrow('retained');
  } finally {
    db.close();
  }
});

it('turns over >300 actual completions with compact identities, restarts and concurrent identical replay', async () => {
  const identities: { event: string; operation: string; receipt: string | null }[] = [];
  for (let i = 0; i < 320; i++) {
    const event = append();
    const operation = enqueue(event.eventId);
    await complete(operation);
    identities.push({
      event: event.eventId,
      operation,
      receipt: journalRows().find((row) => row.operation_id === operation)!.receipt_json,
    });
    receiver.trace.length = 0;
    if (i % 80 === 79) {
      controller.close();
      repo.close();
      repo = new GroupEventRepository(eventsPath);
      localAccess = repo.trustedHostScope(scope(shared));
      open();
    }
  }
  const rows = journalRows();
  expect(rows).toHaveLength(320);
  expect(rows.every((row) => row.header_json === '' && row.state === 'complete')).toBe(true);
  const first = identities[0];
  const replies = await Promise.all([crash('enqueue', first.event), crash('enqueue', first.event)]);
  expect(replies.map((reply) => reply.output)).toEqual([first.operation, first.operation]);
  for (const identity of identities) {
    expect(enqueue(identity.event)).toBe(identity.operation);
    expect(rows.find((row) => row.operation_id === identity.operation)!.receipt_json).toBe(
      identity.receipt,
    );
  }
  expect(await controller.step(grant, first.operation)).toEqual({ state: 'complete' });
  expect(receiver.trace).toEqual([]);
  expect(repo.sharedPublication(localAccess, [first.event])[0].original).toBe(
    'Original \n  e\u0301 é 🧬 \u202e exact',
  );
  const db = new DatabaseSync(journalPath, { readOnly: true });
  const pages = db.prepare('PRAGMA page_count').get() as { page_count: number };
  const size = db.prepare('PRAGMA page_size').get() as { page_size: number };
  console.info('compact turnover storage', {
    identities: rows.length,
    pages: pages.page_count,
    bytes: statSync(journalPath).size,
    pageBytes: size.page_size,
  });
  expect(statSync(journalPath).size).toBe(pages.page_count * size.page_size);
  expect(statSync(journalPath).size).toBeLessThan(2 * 1024 * 1024);
  db.close();
}, 30_000);

it('transmits the full 1 MiB/64-chunk original within strict packet and attempt limits without truncating control characters', async () => {
  const chunks = Array.from({ length: 64 }, (_, i) =>
    i % 2 ? '\u0000'.repeat(16_384) : '🧬'.repeat(4096),
  );
  const event = repo.append(
    repo.trustedHostScope(scope(shared)),
    groupAppendSchema.parse({
      operationId: randomUUID(),
      entityId: randomUUID(),
      expectedRevision: 0,
      category: 'Finding',
      condensedText: '\u0000'.repeat(4096),
      original: { kind: 'chunked', chunks },
      evidenceRefs: [],
      corrects: null,
    }),
  ).event;
  let maxPacket = 0;
  controller.close();
  open({
    receipt: (key, signal) => http.receipt(key, signal),
    effect(packet, signal) {
      maxPacket = Math.max(maxPacket, Buffer.byteLength(JSON.stringify(packet), 'utf8'));
      return http.effect(packet, signal);
    },
  });
  const operation = enqueue(event.eventId);
  await complete(operation);
  expect(maxPacket).toBeLessThanOrEqual(LIMITS.packetBytes);
  expect(controller.inspect(grant, operation).attempts).toBe(66);
  const original = receiver.db
    .prepare('SELECT text FROM chunks WHERE operation_id=? ORDER BY chunk_index')
    .all(operation) as { text: string }[];
  expect(original.map((item) => item.text)).toEqual(chunks);
  expect(
    publicationEnvelope(binding, operation, repo.sharedPublication(localAccess, [event.eventId])[0])
      .header.event.manifest.bytes,
  ).toBe(1_048_576);
}, 30_000);

it('cancels bounded transport deadlines and preserves intent if a transport never acknowledges', async () => {
  const operation = enqueue(append().eventId);
  let deadline: (() => void) | undefined,
    canceled = 0;
  controller.close();
  controller = new GroupPublicationController(
    journalPath,
    repo,
    {
      receipt: (key, signal) => http.receipt(key, signal),
      effect: async () => {
        queueMicrotask(() => deadline!());
        return new Promise(() => {});
      },
    },
    {
      now: () => now,
      deadline(callback, delay) {
        expect(delay).toBe(LIMITS.timeoutMs);
        deadline = callback;
        return () => {
          canceled++;
        };
      },
    },
  );
  grant = controller.trustedHostRegister(binding, authority);
  expect(await controller.step(grant, operation)).toEqual({ state: 'uncertain' });
  expect(canceled).toBe(2);
  expect(controller.inspect(grant, operation)).toMatchObject({ uncertain: true, attempts: 1 });
});

it('rejects unsupported journal schema without resetting its identities', () => {
  const operation = enqueue(append().eventId);
  controller.close();
  const db = new DatabaseSync(journalPath);
  db.prepare('UPDATE gp_schema SET version=999').run();
  db.close();
  expect(() => new GroupPublicationController(journalPath, repo, http, scheduling)).toThrow(
    /^Group publication: storage$/,
  );
  expect(journalRows()[0].operation_id).toBe(operation);
  const repair = new DatabaseSync(journalPath);
  repair.prepare('UPDATE gp_schema SET version=3').run();
  repair.close();
  open();
});

it.each(['uncertain', 'complete'] as const)(
  'blocks journal-wide %s event identity in another epoch across restart and atomic mixed batches',
  async (state) => {
    const event = append();
    const operation = enqueue(event.eventId);
    if (state === 'complete') await complete(operation);
    else {
      receiver.dropAcknowledgement = 'begin';
      expect(await controller.step(grant, operation)).toEqual({ state: 'uncertain' });
    }
    const original = journalRows();
    const trace = [...receiver.trace];
    controller.close();
    repo.close();
    repo = new GroupEventRepository(eventsPath);
    localAccess = repo.trustedHostScope(scope(shared));
    open();
    liveBinding = { ...binding, epoch: randomUUID() };
    const nextGrant = controller.trustedHostRegister(liveBinding, authority);
    const fresh = append();
    for (const refs of [
      [event.eventId],
      [fresh.eventId, event.eventId],
      [event.eventId, fresh.eventId],
    ]) {
      expect(() => controller.enqueue(nextGrant, refs)).toThrow(
        /^Group publication: identity_changed$/,
      );
      expect(journalRows()).toEqual(original);
    }
    expect(await controller.step(nextGrant)).toEqual({ state: 'idle' });
    expect(receiver.trace).toEqual(trace);
    const children = await Promise.all([
      crash('enqueue-result', event.eventId, journalPath, liveBinding),
      crash('enqueue-result', event.eventId, journalPath, liveBinding),
    ]);
    expect(children.map((child) => child.output)).toEqual(['identity_changed', 'identity_changed']);
    expect(children.every((child) => child.code === 0)).toBe(true);
    expect(journalRows()).toEqual(original);
  },
);

it('atomically admits only one event identity when different epochs enqueue concurrently in processes', async () => {
  const event = append();
  const results = await Promise.all([
    crash('enqueue-result', event.eventId),
    crash('enqueue-result', event.eventId, journalPath, { ...binding, epoch: randomUUID() }),
  ]);
  expect(results.every((child) => child.code === 0)).toBe(true);
  expect(results.filter((child) => child.output === 'identity_changed')).toHaveLength(1);
  expect(journalRows()).toHaveLength(1);
  expect(results.map((child) => child.output)).toContain(journalRows()[0].operation_id);
  expect(receiver.trace).toEqual([]);
});

it.each(['offline', 'unavailable', 'not_sent'] as const)(
  'keeps >96 definite pre-handoff %s steps retryable across restart at capped backoff',
  async (mode) => {
    const event = append();
    const operation = enqueue(event.eventId);
    http.offline = mode === 'offline';
    const transport: PublicationTransport = {
      receipt:
        mode === 'unavailable'
          ? async () => ({ kind: 'unavailable', reason: 'offline' })
          : (key, signal) => http.receipt(key, signal),
      effect:
        mode === 'not_sent'
          ? async () => ({ kind: 'not_sent', reason: 'offline' })
          : (packet, signal) => http.effect(packet, signal),
    };
    controller.close();
    open(transport);
    for (let i = 0; i < 120; i++) {
      if (i === 60) {
        controller.close();
        repo.close();
        repo = new GroupEventRepository(eventsPath);
        localAccess = repo.trustedHostScope(scope(shared));
        open(transport);
        expect(enqueue(event.eventId)).toBe(operation);
      }
      expect(await controller.step(grant, operation)).toEqual({ state: 'offline' });
      if (i > 6)
        expect(controller.inspect(grant, operation).nextAttemptAt).toBe(now + LIMITS.maxBackoffMs);
      expect(await controller.step(grant, operation)).toEqual({ state: 'waiting' });
      advance();
    }
    expect(controller.inspect(grant, operation)).toMatchObject({
      attempts: 120,
      budgetAttempts: 0,
      uncertain: false,
    });
    expect(receiver.trace.filter((item) => item.kind !== 'receipt')).toEqual([]);
    http.offline = false;
    controller.close();
    open();
    await complete(operation);
    expect(enqueue(event.eventId)).toBe(operation);
    expect(controller.inspect(grant, operation).budgetAttempts).toBe(3);
    expect(receiver.trace.filter((item) => item.kind === 'begin')).toHaveLength(1);
    expect(receiver.trace.every((item) => item.operationId === operation)).toBe(true);
  },
);

it('keeps a full 64-chunk publication retryable through prolonged offline before and during delivery', async () => {
  const chunks = Array.from({ length: 64 }, (_, i) =>
    i % 2 ? '\u0000'.repeat(16_384) : '🧬'.repeat(4096),
  );
  const event = append(shared, '', [], chunks);
  const operation = enqueue(event.eventId);
  const outage = async () => {
    controller.close();
    const child = await crash('offline', event.eventId, journalPath, binding, 20_000);
    expect(child).toEqual({ code: 0, output: operation });
    advance(110 * LIMITS.maxBackoffMs);
    repo.close();
    repo = new GroupEventRepository(eventsPath);
    localAccess = repo.trustedHostScope(scope(shared));
    open();
  };
  await outage();
  expect(await controller.step(grant, operation)).toEqual({ state: 'pending' });
  advance();
  for (let i = 0; i < 32; i++) {
    expect(await controller.step(grant, operation)).toEqual({ state: 'pending' });
    advance();
  }
  expect(controller.inspect(grant, operation).budgetAttempts).toBe(33);
  await outage();
  controller.close();
  repo.close();
  repo = new GroupEventRepository(eventsPath);
  localAccess = repo.trustedHostScope(scope(shared));
  open();
  expect(enqueue(event.eventId)).toBe(operation);
  await complete(operation);
  expect(controller.inspect(grant, operation)).toMatchObject({
    state: 'complete',
    attempts: 286,
    budgetAttempts: 66,
  });
  expect(receiver.trace.filter((item) => item.kind === 'begin')).toHaveLength(1);
  expect(receiver.trace.filter((item) => item.kind === 'chunk')).toHaveLength(64);
  expect(receiver.trace.filter((item) => item.kind === 'commit')).toHaveLength(1);
  const original = receiver.db
    .prepare('SELECT text FROM chunks WHERE operation_id=? ORDER BY chunk_index')
    .all(operation) as { text: string }[];
  expect(original.map((item) => item.text)).toEqual(chunks);
}, 30_000);

it('saturates diagnostic and backoff counters without exhausting definite offline retries', async () => {
  const operation = enqueue(append().eventId);
  const db = new DatabaseSync(journalPath);
  db.prepare('UPDATE gp_operations SET attempts=2147483646,failures=95 WHERE operation_id=?').run(
    operation,
  );
  db.close();
  http.offline = true;
  for (let i = 0; i < 5; i++) {
    expect(await controller.step(grant, operation)).toEqual({ state: 'offline' });
    expect(controller.inspect(grant, operation)).toMatchObject({
      attempts: 2147483647,
      budgetAttempts: 0,
      nextAttemptAt: now + LIMITS.maxBackoffMs,
    });
    advance();
  }
  const read = new DatabaseSync(journalPath, { readOnly: true });
  expect(read.prepare('SELECT failures FROM gp_operations').get()).toMatchObject({ failures: 96 });
  read.close();
  http.offline = false;
  await complete(operation);
});

it('skips leased and future rows when selecting other due work without an operation ID', async () => {
  const operations = controller.enqueue(grant, [
    append().eventId,
    append().eventId,
    append().eventId,
  ]).operations;
  const db = new DatabaseSync(journalPath);
  db.prepare(
    'UPDATE gp_operations SET lease_owner=?,lease_until=?,next_at=0 WHERE operation_id=?',
  ).run(randomUUID(), now + LIMITS.leaseMs, operations[0]);
  db.prepare('UPDATE gp_operations SET next_at=? WHERE operation_id=?').run(
    now + LIMITS.maxBackoffMs,
    operations[1],
  );
  db.close();
  expect(await controller.step(grant)).toEqual({ state: 'pending' });
  expect(receiver.trace).toEqual([
    { kind: 'receipt', operationId: operations[2] },
    { kind: 'begin', operationId: operations[2] },
  ]);
  expect(controller.inspect(grant, operations[0]).attempts).toBe(0);
  expect(controller.inspect(grant, operations[1]).attempts).toBe(0);
});

it('fails closed before transport when the intent UPDATE affects no row', async () => {
  const operation = enqueue(append().eventId);
  const db = new DatabaseSync(journalPath);
  db.exec(
    'CREATE TRIGGER reject_intent BEFORE UPDATE OF intent ON gp_operations WHEN NEW.intent=1 BEGIN SELECT RAISE(IGNORE); END',
  );
  db.close();
  expect(await controller.step(grant, operation)).toEqual({ state: 'busy' });
  expect(journalRows()[0].intent).toBe(0);
  expect(receiver.trace).toEqual([{ kind: 'receipt', operationId: operation }]);
});

it('rejects already-authorized same-group other-installation shared canaries atomically before journaling or transport', async () => {
  const peer = { groupId: member.groupId, ...repo.addMember(member.groupId, 'Peer') };
  const peerContext = context(peer, 'shared');
  const event = append(peerContext, 'OTHER-INSTALLATION-CANARY-🔐');
  // Prove it is shared content visible to this repository-issued handle.
  expect(repo.sharedPublication(localAccess, [event.eventId])[0].original).toBe(
    'OTHER-INSTALLATION-CANARY-🔐',
  );
  const own = append();
  for (const refs of [[event.eventId], [own.eventId, event.eventId]]) {
    expect(() => controller.enqueue(grant, refs)).toThrow(/^Group publication: unauthorized$/);
    expect(journalRows()).toEqual([]);
  }
  expect(await controller.step(grant)).toEqual({ state: 'idle' });
  expect(receiver.trace).toEqual([]);
  const bytes = readFileSync(journalPath).toString('utf8');
  for (const canary of [
    event.eventId,
    event.scope.source.sessionId,
    event.scope.source.nativeSessionId,
    event.scope.source.messageId,
    event.scope.installationId,
    event.entityId,
    'OTHER-INSTALLATION-CANARY',
  ])
    expect(bytes).not.toContain(canary);
});

it('migrates version 1 identities and conservative budgets atomically without resetting uncertain history', async () => {
  const operation = enqueue(append().eventId);
  receiver.dropAcknowledgement = 'begin';
  await controller.step(grant, operation);
  const rows = journalRows();
  controller.close();
  legacyJournal(1);
  const db = new DatabaseSync(journalPath);
  db.prepare('UPDATE gp_operations SET attempts=7 WHERE operation_id=?').run(operation);
  db.close();
  open();
  expect(journalRows()).toEqual(rows);
  expect(controller.inspect(grant, operation)).toMatchObject({
    state: 'uncertain',
    attempts: 7,
    budgetAttempts: 7,
    uncertain: true,
  });
  advance();
  await complete(operation);
  expect(receiver.trace.filter((item) => item.kind === 'begin')).toHaveLength(1);
});

it('rejects incompatible legacy cross-epoch duplicate identities without altering rows or schema', () => {
  const event = append();
  enqueue(event.eventId);
  liveBinding = { ...binding, epoch: randomUUID() };
  controller.trustedHostRegister(liveBinding, authority);
  controller.close();
  legacyJournal(1);
  const db = new DatabaseSync(journalPath);
  const partitions = db.prepare('SELECT partition_id FROM gp_partitions').all() as {
    partition_id: string;
  }[];
  const old = db.prepare('SELECT partition_id FROM gp_operations').get() as {
    partition_id: string;
  };
  const next = partitions.find((row) => row.partition_id !== old.partition_id)!.partition_id;
  db.prepare(
    `INSERT INTO gp_operations(operation_id,partition_id,event_id,header_json,payload_hash,state)
    SELECT ?,?,event_id,header_json,payload_hash,'pending' FROM gp_operations LIMIT 1`,
  ).run(randomUUID(), next);
  db.close();
  const before = journalRows();
  expect(() => new GroupPublicationController(journalPath, repo, http, scheduling)).toThrow(
    /^Group publication: storage$/,
  );
  expect(journalRows()).toEqual(before);
  const read = new DatabaseSync(journalPath, { readOnly: true });
  expect(read.prepare('SELECT version FROM gp_schema').get()).toMatchObject({ version: 1 });
  expect(
    read.prepare("SELECT 1 FROM sqlite_master WHERE name='gp_event_identity'").get(),
  ).toBeUndefined();
  expect(
    read
      .prepare('PRAGMA table_info(gp_operations)')
      .all()
      .some((column) => column.name === 'budget'),
  ).toBe(false);
  read.close();
  expect(receiver.trace).toEqual([]);
});

it.each(['begin', 'chunk', 'commit'] as const)(
  'preserves the effect budget through >110 unavailable receipt checks after lost %s acknowledgement and actual process restart',
  async (kind) => {
    const chunks =
      kind === 'chunk'
        ? Array.from({ length: 64 }, (_, i) =>
            i % 2 ? '\u0000'.repeat(16_384) : '🧬'.repeat(4096),
          )
        : ['exact e\u0301 é 🧬 original'];
    const event = kind === 'chunk' ? append(shared, '', [], chunks) : append(shared, chunks[0]);
    const operation = enqueue(event.eventId);
    if (kind !== 'begin') {
      expect(await controller.step(grant, operation)).toEqual({ state: 'pending' });
      advance();
    }
    const acknowledgedChunks = kind === 'chunk' ? 32 : kind === 'commit' ? 1 : 0;
    for (let i = 0; i < acknowledgedChunks; i++) {
      expect(await controller.step(grant, operation)).toEqual({ state: 'pending' });
      advance();
    }
    receiver.dropAcknowledgement = kind;
    expect(await controller.step(grant, operation)).toEqual({ state: 'uncertain' });
    const spent = controller.inspect(grant, operation).budgetAttempts;
    const trace = [...receiver.trace];
    advance();
    controller.close();
    const child = await crash(
      'offline',
      event.eventId,
      journalPath,
      binding,
      kind === 'chunk' ? 20_000 : 10_000,
    );
    expect(child).toEqual({ code: 0, output: operation });
    advance(110 * LIMITS.maxBackoffMs);
    repo.close();
    repo = new GroupEventRepository(eventsPath);
    localAccess = repo.trustedHostScope(scope(shared));
    open({
      async receipt() {
        throw new Error('Unavailable receipt connection');
      },
      effect: (packet, signal) => http.effect(packet, signal),
    });
    for (let i = 0; i < 2; i++) {
      expect(await controller.step(grant, operation)).toEqual({ state: 'uncertain' });
      expect(controller.inspect(grant, operation)).toMatchObject({
        budgetAttempts: spent,
        uncertain: true,
        nextAttemptAt: now + LIMITS.maxBackoffMs,
      });
      expect(await controller.step(grant, operation)).toEqual({ state: 'waiting' });
      advance();
    }
    expect(receiver.trace).toEqual(trace);
    expect(enqueue(event.eventId)).toBe(operation);
    controller.close();
    open();
    await complete(operation);
    expect(controller.inspect(grant, operation)).toMatchObject({
      state: 'complete',
      budgetAttempts: chunks.length + 2,
      uncertain: false,
    });
    expect(receiver.trace.filter((item) => item.kind === 'begin')).toHaveLength(1);
    expect(receiver.trace.filter((item) => item.kind === 'chunk')).toHaveLength(chunks.length);
    expect(receiver.trace.filter((item) => item.kind === 'commit')).toHaveLength(1);
    expect(receiver.trace.every((item) => item.operationId === operation)).toBe(true);
    const committed = receiver.db
      .prepare("SELECT header_json FROM operations WHERE state='committed'")
      .all() as { header_json: string }[];
    expect(committed).toHaveLength(1);
    expect((JSON.parse(committed[0].header_json) as PublicationHeader).event).toEqual(event);
    const original = receiver.db
      .prepare('SELECT text FROM chunks WHERE operation_id=? ORDER BY chunk_index')
      .all(operation) as { text: string }[];
    expect(original.map((item) => item.text)).toEqual(chunks);
  },
  30_000,
);

it('refunds only the current not_sent reservation after reconciling historical uncertain intent', async () => {
  const event = append();
  const operation = enqueue(event.eventId);
  receiver.dropAcknowledgement = 'begin';
  await controller.step(grant, operation);
  expect(controller.inspect(grant, operation)).toMatchObject({
    budgetAttempts: 1,
    uncertain: true,
  });
  advance();
  controller.close();
  const transport: PublicationTransport = {
    receipt: (key, signal) => http.receipt(key, signal),
    async effect() {
      return { kind: 'not_sent', reason: 'offline' };
    },
  };
  open(transport);
  for (let i = 0; i < 120; i++) {
    if (i === 60) {
      controller.close();
      open(transport);
    }
    expect(await controller.step(grant, operation)).toEqual({ state: 'offline' });
    expect(controller.inspect(grant, operation)).toMatchObject({
      budgetAttempts: 1,
      uncertain: false,
    });
    advance();
  }
  expect(receiver.trace.filter((item) => item.kind !== 'receipt')).toEqual([
    { kind: 'begin', operationId: operation },
  ]);
  controller.close();
  open();
  await complete(operation);
  expect(controller.inspect(grant, operation).budgetAttempts).toBe(3);
  expect(receiver.trace.filter((item) => item.kind === 'begin')).toHaveLength(1);
});

it.each(['absent', 'staged-missing', 'staged-ready'] as const)(
  'permits only due, authorized receipt reconciliation at the effect ceiling with an %s receipt',
  async (state) => {
    const operation = enqueue(append().eventId);
    if (state !== 'absent') {
      await controller.step(grant, operation);
      advance();
    }
    if (state === 'staged-ready') {
      await controller.step(grant, operation);
      advance();
    }
    const db = new DatabaseSync(journalPath);
    db.prepare(
      'UPDATE gp_operations SET budget=?,intent=1,state=?,next_at=? WHERE operation_id=?',
    ).run(LIMITS.attempts, state === 'absent' ? 'pending' : 'exhausted', now, operation);
    db.close();
    controller.close();
    open();
    const trace = receiver.trace.length;
    expect(await controller.step(grant)).toEqual({ state: 'exhausted' });
    expect(controller.inspect(grant, operation)).toMatchObject({
      state: 'exhausted',
      budgetAttempts: LIMITS.attempts,
      uncertain: true,
      nextAttemptAt: now + LIMITS.backoffMs,
    });
    expect(receiver.trace.slice(trace)).toEqual([{ kind: 'receipt', operationId: operation }]);
    expect(await controller.step(grant, operation)).toEqual({ state: 'waiting' });
    advance();
    expect(await controller.step(grant, operation)).toEqual({ state: 'exhausted' });
    expect(receiver.trace.slice(trace)).toEqual([
      { kind: 'receipt', operationId: operation },
      { kind: 'receipt', operationId: operation },
    ]);
    repo.revokeMember(member.groupId, member.memberId);
    advance();
    expect(await controller.step(grant, operation)).toEqual({ state: 'unauthorized' });
    expect(receiver.trace).toHaveLength(trace + 2);
    expect(controller.inspect(grant, operation)).toEqual({ state: 'unauthorized' });
  },
);

it('completes the same ID by receipt only at the effect ceiling after lost commit acknowledgement and a prolonged outage', async () => {
  const event = append();
  const operation = enqueue(event.eventId);
  await controller.step(grant, operation);
  advance();
  await controller.step(grant, operation);
  advance();
  const db = new DatabaseSync(journalPath);
  db.prepare('UPDATE gp_operations SET budget=? WHERE operation_id=?').run(
    LIMITS.attempts - 1,
    operation,
  );
  db.close();
  receiver.dropAcknowledgement = 'commit';
  expect(await controller.step(grant, operation)).toEqual({ state: 'exhausted' });
  const trace = receiver.trace.length;
  advance();
  controller.close();
  repo.close();
  repo = new GroupEventRepository(eventsPath);
  localAccess = repo.trustedHostScope(scope(shared));
  open();
  http.offline = true;
  for (let i = 0; i < 112; i++) {
    expect(await controller.step(grant, operation)).toEqual({ state: 'exhausted' });
    expect(controller.inspect(grant, operation)).toMatchObject({
      state: 'exhausted',
      budgetAttempts: LIMITS.attempts,
      uncertain: true,
    });
    if (i > 6)
      expect(controller.inspect(grant, operation).nextAttemptAt).toBe(now + LIMITS.maxBackoffMs);
    expect(await controller.step(grant, operation)).toEqual({ state: 'waiting' });
    advance();
  }
  expect(receiver.trace).toHaveLength(trace);
  http.offline = false;
  expect(await controller.step(grant)).toEqual({ state: 'complete' });
  expect(receiver.trace.slice(trace)).toEqual([{ kind: 'receipt', operationId: operation }]);
  expect(controller.inspect(grant, operation)).toMatchObject({
    state: 'complete',
    budgetAttempts: LIMITS.attempts,
    uncertain: false,
  });
  expect(enqueue(event.eventId)).toBe(operation);
  expect(journalRows()[0].receipt_json).not.toBeNull();
  expect(receiver.trace.filter((item) => item.kind === 'begin')).toHaveLength(1);
  expect(receiver.trace.filter((item) => item.kind === 'chunk')).toHaveLength(1);
  expect(receiver.trace.filter((item) => item.kind === 'commit')).toHaveLength(1);
});

it('checks compacted payload/source collisions and live authorization before lookup without network', async () => {
  const event = append();
  const operation = enqueue(event.eventId);
  await complete(operation);
  receiver.trace.length = 0;
  const original = repo.sharedPublication.bind(repo);
  repo.sharedPublication = (access, refs) =>
    original(access, refs).map((record) => ({
      ...record,
      event: { ...record.event, condensedText: 'changed payload' },
    }));
  expect(() => enqueue(event.eventId)).toThrow('integrity');
  expect(journalRows()[0].operation_id).toBe(operation);
  repo.sharedPublication = (access, refs) =>
    original(access, refs).map((record) => ({
      ...record,
      event: {
        ...record.event,
        scope: {
          ...record.event.scope,
          source: { ...record.event.scope.source, messageId: 'changed-source' },
        },
      },
    }));
  expect(() => enqueue(event.eventId)).toThrow('integrity');
  repo.sharedPublication = original;
  liveBinding = { ...binding, credentialRevision: 2 };
  expect(() => enqueue(event.eventId)).toThrow('identity_changed');
  liveBinding = binding;
  repo.revokeMember(member.groupId, member.memberId);
  expect(() => enqueue(event.eventId)).toThrow('unauthorized');
  expect(controller.inspect(grant, operation)).toEqual({ state: 'unauthorized' });
  expect(await controller.step(grant, operation)).toEqual({ state: 'unauthorized' });
  expect(receiver.trace).toEqual([]);
});

it('retains unfinished, uncertain, exhausted and quarantined full headers through migration and completed turnover', async () => {
  const states = [
    'pending',
    'uncertain',
    'exhausted',
    'collision',
    'protocol',
    'integrity',
  ] as const;
  const operations = states.map(() => enqueue(append().eventId));
  controller.close();
  const db = new DatabaseSync(journalPath);
  states.forEach((state, index) =>
    db
      .prepare('UPDATE gp_operations SET state=?,intent=?,budget=? WHERE operation_id=?')
      .run(
        state,
        state === 'uncertain' || state === 'exhausted' ? 1 : 0,
        state === 'exhausted' ? 96 : 0,
        operations[index],
      ),
  );
  db.close();
  const before = journalRows();
  legacyJournal(2);
  open();
  for (let i = 0; i < 140; i++) {
    await complete(enqueue(append().eventId));
    receiver.trace.length = 0;
  }
  controller.close();
  open();
  expect(journalRows().filter((row) => operations.includes(row.operation_id))).toEqual(before);
  const read = new DatabaseSync(journalPath, { readOnly: true });
  expect(
    read
      .prepare('SELECT compact FROM gp_operations WHERE state!=?')
      .all('complete')
      .every((row) => row.compact === 0),
  ).toBe(true);
  read.close();
});

it.each(['before-completion', 'after-completion'] as const)(
  'keeps exact identity and receipt through the %s crash boundary',
  async (mode) => {
    const event = append();
    const operation = enqueue(event.eventId);
    await controller.step(grant, operation);
    advance();
    await controller.step(grant, operation);
    advance();
    receiver.dropAcknowledgement = 'commit';
    expect(await controller.step(grant, operation)).toEqual({ state: 'uncertain' });
    const old = journalRows();
    advance();
    controller.close();
    const result = await crash(mode, event.eventId);
    expect(result.code).toBe(mode === 'before-completion' ? 80 : 81);
    if (mode === 'before-completion') expect(journalRows()).toEqual(old);
    else
      expect(journalRows()[0]).toMatchObject({
        operation_id: operation,
        state: 'complete',
        header_json: '',
      });
    const effects = receiver.trace.filter((item) => item.kind !== 'receipt').length;
    open();
    expect(enqueue(event.eventId)).toBe(operation);
    if (mode === 'before-completion') {
      expect(await controller.step(grant, operation)).toEqual({ state: 'busy' });
      advance(LIMITS.leaseMs);
    }
    await complete(operation);
    expect(receiver.trace.filter((item) => item.kind !== 'receipt')).toHaveLength(effects);
    const receipt = JSON.parse(journalRows()[0].receipt_json!) as PublicationReceipt;
    expect(receipt).toMatchObject({
      state: 'committed',
      eventId: event.eventId,
      operationId: operation,
      remoteSequence: 1,
    });
  },
);

it.each(['before-migration', 'after-migration'] as const)(
  'preserves legacy receipt/counters across the %s crash boundary',
  async (mode) => {
    const event = append();
    const operation = enqueue(event.eventId);
    await complete(operation);
    controller.close();
    legacyJournal(2);
    const before = journalRows();
    const result = await crash(mode, event.eventId);
    expect(result.code).toBe(mode === 'before-migration' ? 80 : 81);
    const read = new DatabaseSync(journalPath, { readOnly: true });
    expect(read.prepare('SELECT version FROM gp_schema').get()?.version).toBe(
      mode === 'before-migration' ? 2 : 3,
    );
    read.close();
    if (mode === 'before-migration') expect(journalRows()).toEqual(before);
    open();
    expect(enqueue(event.eventId)).toBe(operation);
    expect(journalRows()[0].receipt_json).toBe(before[0].receipt_json);
    expect(controller.inspect(grant, operation)).toMatchObject({
      state: 'complete',
      attempts: 3,
      budgetAttempts: 3,
    });
    expect(journalRows()[0].header_json).toBe('');
  },
);

it.each(['receipt', 'header', 'state'] as const)(
  'rolls back version 2 migration on corrupt %s without losing any recovery history',
  async (field) => {
    const operation = enqueue(append().eventId);
    await complete(operation);
    controller.close();
    legacyJournal(2);
    const db = new DatabaseSync(journalPath);
    if (field === 'receipt') db.prepare("UPDATE gp_operations SET receipt_json='{}'").run();
    if (field === 'state') db.prepare("UPDATE gp_operations SET state='unknown'").run();
    if (field === 'header') {
      db.exec('DROP TRIGGER gp_identity_immutable');
      db.prepare("UPDATE gp_operations SET header_json='{}'").run();
      db.exec(`CREATE TRIGGER gp_identity_immutable BEFORE UPDATE OF header_json ON gp_operations
        BEGIN SELECT RAISE(ABORT,'immutable publication identity'); END`);
    }
    db.close();
    const before = journalRows();
    expect(() => open()).toThrow('storage');
    expect(journalRows()).toEqual(before);
    const read = new DatabaseSync(journalPath, { readOnly: true });
    expect(read.prepare('SELECT version FROM gp_schema').get()?.version).toBe(2);
    expect(
      read
        .prepare('PRAGMA table_info(gp_operations)')
        .all()
        .some((column) => column.name === 'compact'),
    ).toBe(false);
    read.close();
  },
);

it('preserves IDs and receipts under real 64 MiB SQLite pressure and resumes using freed pages', async () => {
  const event = append();
  const operation = enqueue(event.eventId);
  await complete(operation);
  const before = journalRows();
  const pending = append();
  const db = new DatabaseSync(journalPath);
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  db.prepare(`PRAGMA max_page_count=${Math.floor(LIMITS.journalBytes / pageSize)}`).get();
  db.exec('CREATE TABLE pressure (id INTEGER PRIMARY KEY, bytes BLOB NOT NULL)');
  const fill = db.prepare('INSERT INTO pressure(bytes) VALUES (zeroblob(?))');
  for (const bytes of [1024 * 1024, pageSize]) {
    for (;;) {
      try {
        fill.run(bytes);
      } catch (error) {
        expect(String(error)).toContain('full');
        break;
      }
    }
  }
  const pages = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  console.info('physical pressure', { pages, pageSize, bytes: statSync(journalPath).size });
  expect(pages * pageSize).toBe(LIMITS.journalBytes);
  const batch = Array.from({ length: 16 }, () => append());
  expect(() =>
    controller.enqueue(
      grant,
      batch.map((item) => item.eventId),
    ),
  ).toThrow('storage');
  expect(journalRows()).toEqual(before);
  controller.close();
  open();
  expect(enqueue(event.eventId)).toBe(operation);
  expect(await controller.step(grant, operation)).toEqual({ state: 'complete' });
  expect(journalRows()).toEqual(before);
  db.exec('DELETE FROM pressure'); // Owned artificial pressure, never publication history.
  db.close();
  const next = enqueue(pending.eventId);
  await complete(next);
  expect(journalRows().find((row) => row.operation_id === operation)).toEqual(before[0]);
  expect(statSync(journalPath).size).toBeLessThanOrEqual(LIMITS.journalBytes);
});

it('bounds the global compact lifetime across epochs while retaining completed lookup at capacity', async () => {
  controller.close();
  let sequence = 0;
  open({
    async receipt(key) {
      // Trusted fixture models pre-existing remote receipts; no effects are needed.
      const db = new DatabaseSync(journalPath, { readOnly: true });
      const row = db
        .prepare('SELECT event_id FROM gp_operations WHERE operation_id=?')
        .get(key.operationId) as { event_id: string };
      db.close();
      return {
        kind: 'receipt',
        receipt: { ...key, state: 'committed', eventId: row.event_id, remoteSequence: ++sequence },
      };
    },
    async effect() {
      throw new Error('Unexpected effect at receipt-only fixture');
    },
  });
  const capacity = Math.floor(
    (LIMITS.journalBytes - LIMITS.partitions * LIMITS.lifetimeOperations * LIMITS.headerBytes) /
      8192,
  );
  let firstEvent = '',
    firstOperation = '';
  for (let i = 0; i < capacity; i++) {
    const event = append();
    const operation = enqueue(event.eventId);
    if (i === 0) {
      firstEvent = event.eventId;
      firstOperation = operation;
    }
    expect(await controller.step(grant, operation)).toEqual({ state: 'complete' });
  }
  const before = journalRows();
  expect(capacity).toBe(2048);
  expect(enqueue(firstEvent)).toBe(firstOperation);
  const next = append();
  expect(() => enqueue(next.eventId)).toThrow('capacity');
  liveBinding = { ...binding, epoch: randomUUID() };
  const nextGrant = controller.trustedHostRegister(liveBinding, authority);
  expect(() => controller.enqueue(nextGrant, [next.eventId])).toThrow('capacity');
  expect(() => controller.enqueue(nextGrant, [firstEvent])).toThrow('identity_changed');
  expect(journalRows()).toEqual(before);
  liveBinding = binding;
  controller.close();
  open();
  expect(enqueue(firstEvent)).toBe(firstOperation);
  expect(await controller.step(grant, firstOperation)).toEqual({ state: 'complete' });
  expect(receiver.trace).toEqual([]);
}, 30_000);

it('keeps the 128 unfinished-header ceiling when exhausted and quarantine history fills the active budget', () => {
  for (let i = 0; i < LIMITS.lifetimeOperations; i++) {
    const operation = enqueue(append().eventId);
    const db = new DatabaseSync(journalPath);
    db.prepare('UPDATE gp_operations SET state=? WHERE operation_id=?').run(
      i % 2 ? 'collision' : 'exhausted',
      operation,
    );
    db.close();
  }
  const before = journalRows();
  expect(() => enqueue(append().eventId)).toThrow('capacity');
  controller.close();
  open();
  expect(journalRows()).toEqual(before);
  expect(before.every((row) => row.header_json.length > 0)).toBe(true);
});

it('reuses real overflow pages released by completion without replacing the journal or losing provenance', async () => {
  const record = () =>
    repo.append(
      repo.trustedHostScope(scope(shared)),
      groupAppendSchema.parse({
        operationId: randomUUID(),
        entityId: randomUUID(),
        expectedRevision: 0,
        category: 'Question',
        condensedText: '\u0000'.repeat(4096),
        original: { kind: 'inline', text: 'Exact original' },
        evidenceRefs: [],
        corrects: null,
      }),
    ).event;
  const event = record();
  const operation = enqueue(event.eventId);
  const db = new DatabaseSync(journalPath, { readOnly: true });
  const before = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const header = journalRows()[0].header_json;
  await complete(operation);
  const free = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number })
    .freelist_count;
  expect(free).toBeGreaterThan(0);
  const retained = db.prepare('SELECT header_hash,source_json FROM gp_operations').get();
  expect(retained).toEqual({
    header_hash: publicationHash(header),
    source_json: publicationCanonical(event.scope.source),
  });
  const size = statSync(journalPath).size;
  const inode = statSync(journalPath).ino;
  const completedPages = (db.prepare('PRAGMA page_count').get() as { page_count: number })
    .page_count;
  const next = enqueue(record().eventId);
  const after = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  expect(after).toBeLessThanOrEqual(completedPages + 1); // Possible leaf/index split.
  expect(
    (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count,
  ).toBeLessThan(free);
  expect(statSync(journalPath).ino).toBe(inode);
  expect(statSync(journalPath).size).toBeLessThanOrEqual(size + 4096);
  console.info('overflow-page reuse', {
    beforePages: before,
    completedPages,
    releasedPages: free,
    afterPages: after,
  });
  db.close();
  await complete(next);
  expect(enqueue(event.eventId)).toBe(operation);
  expect(repo.sharedPublication(localAccess, [event.eventId])[0].event).toEqual(event);
  const write = new DatabaseSync(journalPath);
  expect(() =>
    write
      .prepare("UPDATE gp_operations SET header_json='changed' WHERE operation_id=?")
      .run(operation),
  ).toThrow('retained');
  expect(() =>
    write.prepare("UPDATE gp_operations SET receipt_json='{}' WHERE operation_id=?").run(operation),
  ).toThrow('retained');
  expect(() =>
    write.prepare('UPDATE gp_operations SET compact=0 WHERE operation_id=?').run(operation),
  ).toThrow('retained');
  write.close();
});
