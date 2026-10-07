import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { groupScopeSchema, type GroupContext } from '@dock/shared';
import { groupPromotionSourceSchema } from '@dock/shared/dist/group-promotion.js';
import { GroupEventRepository } from './group-events.js';
import { Store } from './store.js';
import { publicationCanonical } from './group-publication-protocol.js';
import type { GroupPromotionSynthesis, GroupPromotionSynthesisRequest } from './group-promotion.js';
import {
  createGroupPromotionNativeSynthesis,
  groupPromotionNativeMode,
  groupPromotionNativeScope,
  type PromotionNativeJournal,
  type PromotionNativeExecution,
  type PromotionNativeRuntime,
} from './group-promotion-native-synthesis.js';

type Receipt = { state: string; text?: string; nativeToolItems?: number; source?: unknown };
let root: string, events: GroupEventRepository, store: Store, owner: GroupContext;
let journal: PromotionNativeJournal<string>, runtime: PromotionNativeRuntime<object, string>;
let rows: Map<string, { context: GroupContext; agentId: string }>, receipts: Map<string, Receipt>;
type Adapter = GroupPromotionSynthesis & { close(): Promise<void> };
let adapters: Adapter[], allowed: boolean, ready: boolean, fail: string, rawOutput: string;
let requestWriter: string;
let turns: ReturnType<typeof vi.fn>, reconciles: ReturnType<typeof vi.fn>;
const bridge = {};
const signal = () => new AbortController().signal;
const decision = {
  category: 'Idea',
  sentences: ['The group could compare the two treatment arms using a blinded control.'],
  evidenceRefs: [],
};
const route = () => ({
  image: `sha256:${'b'.repeat(64)}`,
  stateBase: root,
  forbiddenPaths: [join(root, 'private')],
  outbound: [{ host: 'api.openai.com', ports: [443] }],
});
function scope(context = owner) {
  return groupScopeSchema.parse({
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
  });
}
function request(
  text = 'A blinded control would make it easier to compare the treatment arms, although we still need to agree which measurements matter most.',
): GroupPromotionSynthesisRequest {
  const original =
    text.length > 16384
      ? { kind: 'chunked', chunks: [text.slice(0, 16384), text.slice(16384)] }
      : { kind: 'inline', text };
  const source = groupPromotionSourceSchema.parse({
    key: { groupId: randomUUID(), sourceId: randomUUID(), version: '1' },
    writerId: requestWriter,
    scope: scope(),
    projectionScope: scope(),
    kind: 'human',
    activity: 'substantive',
    contentMode: 'shared-content',
    original,
    evidenceRefs: [],
    correction: null,
    decision: null,
    synthesisAuthorized: true,
  });
  return {
    synthesisId: randomUUID(),
    identity: {
      key: source.key,
      sourceHash: createHash('sha256').update(publicationCanonical(source)).digest('hex'),
    },
    source,
    evidence: [],
  } satisfies GroupPromotionSynthesisRequest;
}
function make(): Adapter {
  const adapter = createGroupPromotionNativeSynthesis({
    path: join(root, 'synthesis.sqlite'),
    runtime,
    journal,
    bridge,
    events,
    authorize: async () => {
      if (!allowed) throw new Error('Source authorization revoked');
      return { sharedContextId: owner.sessionId, writerId: requestWriter };
    },
    availability: async () => ({ productionReady: ready }),
    route,
  });
  adapters.push(adapter);
  return adapter;
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'group-synthesis-'));
  events = new GroupEventRepository(join(root, 'events.sqlite'));
  store = new Store(join(root, 'store.sqlite'));
  const project = store.register(root, 'Synthesis fixture', 'No provider launch', 'codex');
  const { displayName: _, ...member } = events.createGroup('Owner');
  owner = events.createContext({
    ...member,
    visibility: 'shared',
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
  rows = new Map([[owner.sessionId, { context: owner, agentId: project.managerId }]]);
  receipts = new Map();
  adapters = [];
  requestWriter = randomUUID();
  allowed = true;
  ready = true;
  fail = '';
  rawOutput = JSON.stringify(decision);
  turns = vi.fn();
  reconciles = vi.fn();
  journal = {
    reopen: (id) => {
      if (!rows.has(id)) throw new Error('No context');
      return id;
    },
    resolve: (id) => rows.get(id)!,
    issue: (input, agentId, provider) => {
      const c = events.createContext({
        groupId: input.groupId,
        memberId: input.memberId,
        installationId: input.installationId,
        visibility: input.visibility,
        provider,
        nativeSessionId: randomUUID(),
      });
      rows.set(c.sessionId, { context: c, agentId });
      return c.sessionId;
    },
    savedContainer: (id) =>
      id === owner.sessionId ? { volume: `swa-group-${owner.sessionId}` } : null,
    beginRequest: (_id, req) => {
      receipts.set(req, { state: 'queued' });
    },
    request: (_id, req) => receipts.get(req) ?? null,
    requestEvent: (_id, req, patch) => {
      receipts.set(req, { ...receipts.get(req)!, ...patch });
    },
  };
  runtime = {
    store,
    interrupt: vi.fn(async () => {}),
    queueGroupNativeRequest: vi.fn((_bridge, handle, resources) => {
      const row = journal.resolve(handle),
        binding = groupPromotionNativeMode(store, row.agentId)!;
      expect(resources.tools).toEqual([]);
      expect(resources.workspace).toBeNull();
      expect(resources.readResources).toEqual([]);
      groupPromotionNativeScope(store, events, journal, handle, resources);
      return {
        runId: randomUUID(),
        admitted: Promise.resolve({
          synthesisBinding: fail === 'ordinary-executor' ? undefined : binding,
          authentication: async () => (fail === 'signed-out' ? 'signed-out' : 'authenticated'),
          turn: async (prompt: string, id: string) => {
            turns(prompt, id);
            receipts.set(id, { state: 'native-started' });
            if (fail === 'lost-ack') throw new Error('Lost acknowledgment');
            receipts.set(id, {
              state: 'completed',
              text: rawOutput,
              nativeToolItems: 0,
              ...(fail === 'recursive-source' ? { source: { bad: true } } : {}),
            });
            if (fail === 'lost-completion-ack') throw new Error('Ack lost after completion');
          },
          reconcile: async (id: string) => {
            reconciles(id);
            if (fail === 'recover')
              receipts.set(id, { state: 'completed', text: rawOutput, nativeToolItems: 0 });
          },
          close: async () => {},
        }),
      };
    }),
  };
});
afterEach(async () => {
  await Promise.all(adapters.map((a) => a.close()));
  events.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it('synthesizes substantive ordinary text once through the actual native queue method, outside chat/feed sources', async () => {
  const a = make(),
    r = request();
  expect((await a.submit(r, signal())).state).toBe('pending');
  await tick();
  expect(await a.inspect(r.synthesisId, r.identity, signal())).toEqual({
    state: 'completed',
    identity: r.identity,
    decision,
  });
  await a.submit(r, signal());
  await a.inspect(r.synthesisId, r.identity, signal());
  expect(turns).toHaveBeenCalledTimes(1);
  expect(turns.mock.calls[0][1]).toBe(r.synthesisId);
  expect(turns.mock.calls[0][0]).toContain(r.identity.sourceHash);
  const lane = [...rows.values()].find((r) => r.context.sessionId !== owner.sessionId)!;
  expect(lane.context.visibility).toBe('shared');
  expect(lane.context.memberId).toBe(owner.memberId);
  expect(store.agent(lane.agentId).permission).toBe('read-only');
  expect(store.entries(lane.agentId)).toHaveLength(0);
  expect(store.tasks()).toHaveLength(0);
});
it('lost native ack survives host restart and reconciles only the exact synthesis turn, never resubmits', async () => {
  let a = make();
  const r = request();
  fail = 'lost-ack';
  await a.submit(r, signal());
  await tick();
  await a.close();
  adapters = [];
  a = make();
  fail = 'recover';
  await a.inspect(r.synthesisId, r.identity, signal());
  await tick();
  expect((await a.inspect(r.synthesisId, r.identity, signal())).state).toBe('completed');
  expect(turns).toHaveBeenCalledTimes(1);
  expect(reconciles.mock.calls).toEqual([[r.synthesisId]]);
});
it('completion before lost acknowledgment retains the result with no second model turn', async () => {
  const a = make(),
    r = request();
  fail = 'lost-completion-ack';
  await a.submit(r, signal());
  await tick();
  expect((await a.submit(r, signal())).state).toBe('completed');
  expect(turns).toHaveBeenCalledTimes(1);
});
it('competing adapters claim one source/version and one model submission', async () => {
  const a = make(),
    b = make(),
    r = request();
  await Promise.all([a.submit(r, signal()), b.submit(r, signal())]);
  await tick();
  expect(turns).toHaveBeenCalledTimes(1);
  await expect(b.submit({ ...r, synthesisId: randomUUID() }, signal())).rejects.toThrow(
    'already has a synthesis',
  );
});
it.each([
  'not JSON',
  '{"category":"Idea","sentences":["First sentence. Second sentence."],"evidenceRefs":[]}',
  JSON.stringify({ ...decision, evidenceRefs: [randomUUID()] }),
])(
  'invalid output remains retained and inspectable without a replacement turn (%s)',
  async (output) => {
    rawOutput = output;
    const a = make(),
      r = request();
    await a.submit(r, signal());
    await tick();
    expect((await a.inspect(r.synthesisId, r.identity, signal())).state).toBe('unknown');
    await a.submit(r, signal());
    expect(turns).toHaveBeenCalledTimes(1);
    expect(receipts.get(r.synthesisId)?.text).toBe(output);
  },
);
it.each(['ordinary-executor', 'recursive-source', 'signed-out'])(
  'does not certify an ordinary, publishing or signed-out execution (%s)',
  async (mode) => {
    fail = mode;
    const a = make(),
      r = request();
    await a.submit(r, signal());
    await tick();
    expect((await a.inspect(r.synthesisId, r.identity, signal())).state).not.toBe('completed');
    if (mode !== 'recursive-source') expect(turns).not.toHaveBeenCalled();
  },
);
it('source revocation blocks submission and retrieval after a valid result', async () => {
  const a = make(),
    r = request();
  allowed = false;
  await expect(a.submit(r, signal())).rejects.toThrow('revoked');
  expect(turns).not.toHaveBeenCalled();
  allowed = true;
  await a.submit(r, signal());
  await tick();
  allowed = false;
  await expect(a.inspect(r.synthesisId, r.identity, signal())).rejects.toThrow('revoked');
});
it('local membership revocation blocks inspect and the native scope check', async () => {
  const a = make(),
    r = request();
  await a.submit(r, signal());
  await tick();
  events.revokeMember(owner.groupId, owner.memberId);
  await expect(a.inspect(r.synthesisId, r.identity, signal())).rejects.toThrow();
  expect(turns).toHaveBeenCalledTimes(1);
});
it('excludes private headers before reading originals, leaving no source journal or queue payload', async () => {
  const a = make(),
    r = request();
  r.source.scope.visibility = 'private';
  Object.defineProperty(r.source, 'original', {
    get() {
      throw new Error('PRIVATE CANARY READ');
    },
  });
  await expect(a.submit(r, signal())).rejects.toThrow('no shared synthesis');
  expect(runtime.queueGroupNativeRequest).not.toHaveBeenCalled();
  expect(readFileSync(join(root, 'synthesis.sqlite')).includes(Buffer.from('PRIVATE CANARY'))).toBe(
    false,
  );
});
it('rejects hash forgery, private evidence, and >32KiB context before admission', async () => {
  const a = make(),
    r = request();
  r.identity.sourceHash = '0'.repeat(64);
  await expect(a.submit(r, signal())).rejects.toThrow('source hash');
  const big = request('x'.repeat(32768));
  await expect(a.submit(big, signal())).rejects.toThrow('32KiB');
  const { sessionId: _, ...privateOwner } = owner;
  const privateContext = events.createContext({
    ...privateOwner,
    visibility: 'private',
    nativeSessionId: randomUUID(),
  });
  const privateEvent = events.append(events.trustedHostScope(scope(privateContext)), {
    operationId: randomUUID() as never,
    entityId: randomUUID() as never,
    expectedRevision: 0,
    category: 'Finding',
    condensedText: 'Private',
    original: { kind: 'inline', text: 'PRIVATE EVIDENCE CANARY' },
    evidenceRefs: [],
    corrects: null,
  }).event;
  const invalid = request();
  invalid.evidence = [{ event: privateEvent, original: 'PRIVATE EVIDENCE CANARY' }];
  await expect(a.submit(invalid, signal())).rejects.toThrow('authorized evidence');
  expect(turns).not.toHaveBeenCalled();
});
it('offline availability never creates a lane and permits a later single admitted submission', async () => {
  const a = make(),
    r = request();
  ready = false;
  expect(await a.submit(r, signal())).toEqual({ state: 'unavailable' });
  expect(rows.size).toBe(1);
  ready = true;
  await a.submit(r, signal());
  await tick();
  expect(turns).toHaveBeenCalledTimes(1);
});
it('exact owner/account scope rejects private contexts, changed volume, mounts and mutation tools', async () => {
  const a = make(),
    r = request();
  await a.submit(r, signal());
  await tick();
  const id = [...rows.keys()].find((id) => id !== owner.sessionId)!,
    binding = groupPromotionNativeMode(store, journal.resolve(id).agentId)!;
  const resources = {
    ...route(),
    workspace: null,
    readResources: [],
    expiresAt: Date.now() + 1000,
    tools: [],
  };
  expect(groupPromotionNativeScope(store, events, journal, id, resources)?.volume).toBe(
    binding.volume,
  );
  expect(() =>
    groupPromotionNativeScope(store, events, journal, id, {
      ...resources,
      tools: ['dock_update_goal'],
    }),
  ).toThrow();
  expect(() =>
    groupPromotionNativeScope(store, events, journal, id, { ...resources, readResources: [root] }),
  ).toThrow();
  journal.savedContainer = () => ({ volume: `swa-group-${randomUUID()}` });
  expect(() => groupPromotionNativeScope(store, events, journal, id, resources)).toThrow();
});

it('cross-host source B uses writer A account and never looks up a B native HOME or sign-in', async () => {
  const b = events.addMember(owner.groupId, 'Remote source B');
  const sourceContext = events.createContext({
    groupId: owner.groupId,
    memberId: b.memberId,
    installationId: b.installationId,
    visibility: 'shared',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  const r = request();
  r.source.scope = scope(sourceContext);
  r.identity.sourceHash = createHash('sha256').update(publicationCanonical(r.source)).digest('hex');
  journal.reopen = vi.fn(journal.reopen);
  const a = make();
  await a.submit(r, signal());
  await tick();
  expect((await a.inspect(r.synthesisId, r.identity, signal())).state).toBe('completed');
  const lane = [...rows.values()].find((row) => row.context.sessionId !== owner.sessionId)!;
  const binding = groupPromotionNativeMode(store, lane.agentId)!;
  expect(binding.sharedContextId).toBe(owner.sessionId);
  expect(binding.writer.memberId).toBe(owner.memberId);
  expect(binding.writer.installationId).toBe(owner.installationId);
  expect(binding.writerId).toBe(r.source.writerId);
  expect(binding.volume).toBe(`swa-group-${owner.sessionId}`);
  expect(lane.context.memberId).not.toBe(b.memberId);
  expect(vi.mocked(journal.reopen).mock.calls.some(([id]) => id === sourceContext.sessionId)).toBe(
    false,
  );
  expect(turns).toHaveBeenCalledTimes(1);
});

it('rejects a stale designated writer grant independently of valid original source attribution', async () => {
  const a = make(),
    r = request();
  requestWriter = randomUUID();
  await expect(a.submit(r, signal())).rejects.toThrow('Designated shared writer');
  expect(runtime.queueGroupNativeRequest).not.toHaveBeenCalled();
  expect(rows.size).toBe(1);
});

it('retains exact authorized evidence and leaves unknown causality empty', async () => {
  const a = make(),
    r = request(),
    evidenceScope = scope();
  const event = events.append(events.trustedHostScope(evidenceScope), {
    operationId: randomUUID() as never,
    entityId: randomUUID() as never,
    expectedRevision: 0,
    category: 'Finding',
    condensedText: 'The blind preserved the control comparison.',
    original: { kind: 'inline', text: 'EXACT ORIGINAL — αβγ control comparison' },
    evidenceRefs: [],
    corrects: null,
  }).event;
  r.source.evidenceRefs = [event.eventId];
  r.evidence = events.sharedPublication(events.trustedHostScope(r.source.scope), [event.eventId]);
  r.identity.sourceHash = createHash('sha256').update(publicationCanonical(r.source)).digest('hex');
  rawOutput = JSON.stringify({ ...decision, evidenceRefs: [event.eventId] });
  await a.submit(r, signal());
  await tick();
  const result = await a.inspect(r.synthesisId, r.identity, signal());
  expect(result.state).toBe('completed');
  expect(turns.mock.calls[0][0]).toContain('EXACT ORIGINAL — αβγ control comparison');
  expect(turns.mock.calls[0][0]).toContain('"causalRefs":[]');
});

it('revocation while awaiting admission prevents even the first model write', async () => {
  const a = make(),
    r = request();
  let admitted!: (
    e: Awaited<
      ReturnType<PromotionNativeRuntime<object, string>['queueGroupNativeRequest']>['admitted']
    >,
  ) => void;
  const original = runtime.queueGroupNativeRequest;
  runtime.queueGroupNativeRequest = vi.fn((b, h, resources) => {
    const queued = original(b, h, resources);
    return {
      ...queued,
      admitted: new Promise<PromotionNativeExecution>((resolve) => {
        admitted = resolve;
        void queued.admitted.then((e) => {
          allowed = false;
          admitted(e);
        });
      }),
    };
  });
  await a.submit(r, signal());
  await tick();
  expect(turns).not.toHaveBeenCalled();
});
