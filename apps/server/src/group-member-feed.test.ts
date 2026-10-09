import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { latestGroupFeedEntries, type GroupContext, type GroupEvent } from '@dock/shared';
import { Store } from './store.js';
import { GroupHost } from './group-host.js';
import { ModelPolicy } from './model-policy.js';
import { GroupMemberFeed, MEMBER_FEED_LIMITS, type MemberFeedInput } from './group-member-feed.js';
import type { GroupHostNativeRuntime } from './group-native-host-runtime.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { claudeArguments, type ClaudeSessionOptions } from './claude-session.js';

let directory: string, store: Store, host: GroupHost, feed: GroupMemberFeed, context: GroupContext;
let enabled: boolean,
  visible: boolean,
  allowed: boolean,
  committed: boolean,
  publicationCommitted: boolean,
  now: number;
let inputs: Map<string, MemberFeedInput>,
  operations: Map<string, string>,
  originalTexts: Map<string, string>;
let enrollment: string, projectId: string, nativeContext: GroupContext;
const kick = vi.fn(),
  registerHelper = vi.fn(),
  publish = vi.fn(),
  discover = vi.fn();
const make = () => {
  const policy = new ModelPolicy(store, discover);
  const connector = {
    resolveLocalContext: (_context: GroupContext, handle: string) => {
      if (!enabled || handle !== enrollment) throw new Error('Enable native access first');
      return {
        context: nativeContext,
        enrollmentHandle: enrollment,
        anchor: context,
        projectId,
        agentId: store.project(projectId).managerId,
        provider: 'codex',
        executionMode: 'direct',
        cwd: directory,
      };
    },
    registerHelper,
  } as Pick<GroupHostNativeRuntime, 'resolveLocalContext' | 'registerHelper'>;
  return new GroupMemberFeed(
    { store, kick, modelPolicy: policy },
    directory,
    connector,
    {
      allowed: () => visible,
      source: (input) => host.memberFeedSource(input),
      publish: async (input, decision, operationId) => {
        publish(input, decision, operationId);
        return host.publishMemberFeed(input, decision, operationId);
      },
    },
    () => now,
  );
};
function source(
  text = 'The first measurement was noisier than expected; a repeated sample may clarify the result.',
): MemberFeedInput {
  const scope = {
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
  const event = host.events.append(host.events.trustedHostScope(scope), {
    operationId: randomUUID() as never,
    entityId: randomUUID() as never,
    expectedRevision: 0,
    category: 'Question',
    condensedText: text.slice(0, 240),
    original: { kind: 'inline', text },
    evidenceRefs: [],
    corrects: null,
  }).event;
  const input = { event, enrollmentHandle: enrollment, deliveryOperation: randomUUID() };
  inputs.set(event.eventId, input);
  operations.set(event.eventId, input.deliveryOperation);
  originalTexts.set(event.eventId, text);
  return input;
}
function reply(output?: unknown) {
  const run = store.runs().at(-1)!;
  const batch = JSON.parse(
    String(
      store.db
        .prepare('SELECT body FROM group_member_feed_batches ORDER BY rowid DESC LIMIT 1')
        .get()!.body,
    ),
  );
  store.entry({
    id: randomUUID(),
    agentId: run.agentId,
    runId: run.id,
    createdAt: new Date().toISOString(),
    kind: 'assistant',
    title: 'Assistant',
    phase: 'final',
    text: JSON.stringify(
      output ??
        batch.sources.map((s: { event: GroupEvent }) => ({
          eventId: s.event.eventId,
          decision: {
            category: 'Finding',
            sentences: ['Repeated measurements may clarify the noisy result.'],
            evidenceRefs: [s.event.eventId],
          },
        })),
    ),
    status: 'complete',
  });
  store.updateRun(run.id, { status: 'completed' });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'member-feed-'));
  store = new Store(join(directory, 'dock.sqlite'));
  host = new GroupHost(directory, { betaProfile: null });
  projectId = store.register(directory, 'Groups fixture', '', 'codex', undefined, 'direct').id;
  const { displayName: _, ...member } = host.events.createGroup('Owner');
  context = host.events.createContext({
    ...member,
    visibility: 'shared',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  nativeContext = host.events.createContext({
    ...member,
    visibility: 'shared',
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
  enrollment = randomUUID();
  now = 100_000;
  enabled = visible = allowed = committed = publicationCommitted = true;
  inputs = new Map();
  operations = new Map();
  originalTexts = new Map();
  kick.mockClear();
  registerHelper.mockClear();
  publish.mockClear();
  discover.mockReset();
  discover.mockResolvedValue([{ id: 'luna', label: 'Luna', isDefault: true, efforts: ['low'] }]);
  vi.spyOn(host, 'promotionContext').mockImplementation(async () => {
    if (!allowed) throw new Error('Membership revoked');
    return {
      context,
      enrollment: member,
      revalidate: async () => {
        if (!allowed) throw new Error('Membership revoked');
      },
      registerSource: vi.fn(async () => randomUUID()),
      enqueue: async (_scope: unknown, eventId: string) => ({
        operationId: operations.get(eventId) ?? randomUUID(),
        state: publicationCommitted ? 'committed' : 'pending',
      }),
    } as never;
  });
  const internal = host as unknown as { active(): Promise<unknown>; publication(): unknown };
  vi.spyOn(internal, 'active').mockResolvedValue({});
  vi.spyOn(internal, 'publication').mockReturnValue({
    access: {},
    controller: {
      inspect: () => ({ state: committed ? 'complete' : 'pending' }),
      enqueue: (_access: unknown, ids: string[]) => ({
        operations: ids.map((id) => operations.get(id)),
      }),
    },
  });
  feed = make();
});
afterEach(async () => {
  await feed.close();
  await host.close();
  store.close();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
it('local removal pauses new summaries before discovery and preserves pending sources for restore', async () => {
  const input = source();
  feed.retain(input);
  now += 20_000;
  visible = false;
  await feed.pass();
  expect(discover).not.toHaveBeenCalled();
  expect(store.runs()).toHaveLength(0);
  expect(
    store.db
      .prepare('SELECT state,batch_id FROM group_member_feed_sources WHERE event_id=?')
      .get(input.event.eventId),
  ).toMatchObject({ state: 'pending', batch_id: null });
  visible = true;
  await feed.pass();
  const run = store.runs()[0];
  expect(run).toBeDefined();
  visible = false;
  const receipts = store.db.prepare('SELECT body FROM group_member_feed_batches').all();
  await feed.pass();
  expect(store.runs()).toEqual([run]);
  expect(store.db.prepare('SELECT body FROM group_member_feed_batches').all()).toEqual(receipts);
  visible = true;
  await feed.pass();
  expect(store.runs()).toEqual([run]);
});
it('removal while model discovery awaits cannot enqueue a background summary', async () => {
  feed.retain(source());
  now += 20_000;
  discover.mockImplementation(async () => {
    visible = false;
    return [{ id: 'luna', label: 'Luna', isDefault: true, efforts: ['low'] }];
  });
  await feed.pass();
  expect(discover).toHaveBeenCalledOnce();
  expect(store.runs()).toHaveLength(0);
  expect(registerHelper).not.toHaveBeenCalled();
});

it('batches own committed originals on the central bulk model, then publishes idempotent attributed corrections', async () => {
  const a = source(),
    b = source('A second run also produced a noisy measurement.');
  feed.retain(a);
  feed.retain(b);
  feed.retain(a);
  await feed.pass();
  expect(store.runs()).toHaveLength(0);
  expect(discover).not.toHaveBeenCalled();
  now += 20_000;
  await Promise.all([feed.pass(), feed.pass()]);
  expect(store.runs()).toHaveLength(1);
  expect(kick).toHaveBeenCalledTimes(1);
  const run = store.runs()[0],
    agent = store.agent(run.agentId);
  expect(agent.assignment).toMatchObject({
    provider: 'codex',
    model: 'luna',
    tier: 'uncle',
    taskClass: 'bulk',
  });
  expect(agent).toMatchObject({
    executionMode: 'managed',
    parentId: null,
    taskId: null,
    toolPolicy: 'restricted',
    permission: 'read-only',
    webSearch: 'disabled',
    pluginsEnabled: false,
  });
  expect(store.agent(store.project(projectId).managerId).executionMode).toBe('direct');
  expect(run.kind).toBe('delegation');
  expect(run.text).toContain(originalTexts.get(a.event.eventId));
  expect(run.text).toContain(originalTexts.get(b.event.eventId));
  await feed.pass();
  expect(store.runs()).toHaveLength(1);
  reply();
  publicationCommitted = false;
  await feed.pass();
  const firstOperation = publish.mock.calls[0][2];
  await feed.close();
  store.close();
  store = new Store(join(directory, 'dock.sqlite'));
  feed = make();
  publicationCommitted = true;
  await feed.pass();
  expect(publish.mock.calls[1][2]).toBe(firstOperation);
  expect(store.runs()).toHaveLength(1);
  expect(kick).toHaveBeenCalledTimes(1);
  const access = host.events.trustedHostScope(a.event.scope);
  const page = host.events.feed(access, {
    visibility: 'shared',
    limit: 20,
    after: 0,
    cursor: null,
  });
  expect(page.entries).toHaveLength(4);
  const latest = latestGroupFeedEntries(page.entries);
  expect(latest).toHaveLength(2);
  expect(latest.map((e) => e.category)).toEqual(['Finding', 'Finding']);
  for (const event of latest) {
    const original = inputs.get(event.corrects!)!;
    expect(event).toMatchObject({
      revision: 2,
      entityId: original.event.entityId,
      scope: { memberId: context.memberId, installationId: context.installationId },
      evidenceRefs: [original.event.eventId],
    });
    expect(event.manifest.sha256).toBe(original.event.manifest.sha256);
    expect(host.events.expand(access, event.eventId).original).toBe(
      originalTexts.get(original.event.eventId),
    );
  }
  expect(host.events.expand(access, a.event.eventId).event.category).toBe('Question');
  // An unrelated author with the same entity ID cannot hide the source's row.
  const foreign = {
    ...a.event,
    eventId: randomUUID() as never,
    revision: 3,
    sequence: 5,
    scope: {
      ...a.event.scope,
      memberId: randomUUID() as never,
      installationId: randomUUID() as never,
    },
  };
  expect(latestGroupFeedEntries([...page.entries, foreign])).toHaveLength(3);
});

it('starts no turn for construction/status reads, private sources, disabled access, uncommitted delivery or revoked membership', async () => {
  expect(store.runs()).toHaveLength(0);
  const input = source();
  feed.retain({
    ...input,
    event: { ...input.event, scope: { ...input.event.scope, visibility: 'private' } },
  });
  expect(store.db.prepare('SELECT count(*) n FROM group_member_feed_sources').get()!.n).toBe(0);
  feed.retain(input);
  now += 20_000;
  committed = false;
  await feed.pass();
  committed = true;
  enabled = false;
  await feed.pass();
  enabled = true;
  allowed = false;
  await feed.pass();
  expect(discover).not.toHaveBeenCalled();
  expect(store.runs()).toHaveLength(0);
  await expect(
    host.memberFeedSource({ ...input, deliveryOperation: randomUUID() }),
  ).rejects.toThrow();
});

it('keeps a failed/uncertain batch across restart without replay and rejects invented evidence', async () => {
  const input = source();
  feed.retain(input);
  now += 20_000;
  await feed.pass();
  store.updateRun(store.runs()[0].id, { status: 'interrupted' });
  await feed.close();
  feed = make();
  await feed.pass();
  await feed.pass();
  expect(store.runs()).toHaveLength(1);
  expect(publish).not.toHaveBeenCalled();
  expect(store.db.prepare('SELECT state FROM group_member_feed_batches').get()!.state).toBe(
    'unknown',
  );
  const next = source('Further testing is needed.');
  feed.retain(next);
  now += 20_000;
  await feed.pass();
  const run = store.runs()[1];
  store.entry({
    id: randomUUID(),
    agentId: run.agentId,
    runId: run.id,
    createdAt: new Date().toISOString(),
    kind: 'assistant',
    title: 'Assistant',
    phase: 'final',
    text: JSON.stringify([
      {
        eventId: next.event.eventId,
        decision: {
          category: 'Action',
          sentences: ['Run another experiment.'],
          evidenceRefs: [randomUUID()],
        },
      },
    ]),
    status: 'complete',
  });
  store.updateRun(run.id, { status: 'completed' });
  await feed.pass();
  expect(publish).not.toHaveBeenCalled();
  await feed.pass();
  expect(store.runs()).toHaveLength(2);
});

it('bounds a batch, preserves oversized originals and never substitutes another provider/model', async () => {
  const big = source('x'.repeat(MEMBER_FEED_LIMITS.sourceBytes + 1));
  feed.retain(big);
  for (let i = 0; i < 10; i++) feed.retain(source(`Measurement ${i} needs another check.`));
  now += 20_000;
  discover.mockResolvedValue([{ id: 'astra', label: 'Astra', isDefault: true, efforts: ['high'] }]);
  await feed.pass();
  expect(store.runs()).toHaveLength(0);
  expect(discover.mock.calls.map((c) => c[0])).toEqual(['codex']);
  expect(
    store.db
      .prepare('SELECT state FROM group_member_feed_sources WHERE event_id=?')
      .get(big.event.eventId)!.state,
  ).toBe('oversized');
  expect(
    host.events.expand(host.events.trustedHostScope(big.event.scope), big.event.eventId).original,
  ).toHaveLength(MEMBER_FEED_LIMITS.sourceBytes + 1);
  await feed.close();
  feed = make();
  discover.mockResolvedValue([{ id: 'luna', label: 'Luna', isDefault: true, efforts: ['low'] }]);
  await feed.pass();
  const batch = JSON.parse(
    String(store.db.prepare('SELECT body FROM group_member_feed_batches').get()!.body),
  );
  expect(batch.sources).toHaveLength(8);
  expect(Buffer.byteLength(JSON.stringify(batch.sources))).toBeLessThanOrEqual(
    MEMBER_FEED_LIMITS.bytes,
  );
});

it('retains a newer owner correction instead of overwriting it or blocking later batches', async () => {
  const input = source();
  feed.retain(input);
  now += 20_000;
  await feed.pass();
  reply();
  const correctedScope = {
    ...input.event.scope,
    source: { ...input.event.scope.source, messageId: randomUUID() },
  };
  const corrected = host.events.append(host.events.trustedHostScope(correctedScope), {
    operationId: randomUUID() as never,
    entityId: input.event.entityId,
    expectedRevision: 1,
    category: 'Decision',
    condensedText: 'The owner retained this correction.',
    original: { kind: 'inline', text: originalTexts.get(input.event.eventId)! },
    evidenceRefs: [],
    corrects: input.event.eventId,
  }).event;
  await feed.pass();
  expect(store.db.prepare('SELECT state FROM group_member_feed_sources').get()!.state).toBe(
    'superseded',
  );
  expect(store.db.prepare('SELECT state FROM group_member_feed_batches').get()!.state).toBe(
    'complete',
  );
  expect(
    host.events.expand(host.events.trustedHostScope(correctedScope), corrected.eventId).event
      .category,
  ).toBe('Decision');
  feed.retain(source('A later original can still receive labels.'));
  now += 20_000;
  await feed.pass();
  expect(store.runs()).toHaveLength(2);
});

it('admits the 65th batch while retaining completed/unknown history and one active native run', async () => {
  for (let i = 0; i < 65; i++) {
    feed.retain(source(`Measurement ${i} needs another check.`));
    now += 20_000;
    await feed.pass();
    expect(store.runs()).toHaveLength(i + 1);
    expect(
      store.db
        .prepare("SELECT count(*) n FROM group_member_feed_batches WHERE state='pending'")
        .get()!.n,
    ).toBe(1);
    await feed.pass();
    expect(store.runs()).toHaveLength(i + 1);
    if (i % 2) store.updateRun(store.runs().at(-1)!.id, { status: 'interrupted' });
    else reply();
    await feed.pass();
  }
  expect(store.db.prepare('SELECT count(*) n FROM group_member_feed_batches').get()!.n).toBe(65);
  expect(store.db.prepare('SELECT count(*) n FROM group_member_feed_sources').get()!.n).toBe(65);
  expect(
    store.db
      .prepare("SELECT count(*) n FROM group_member_feed_batches WHERE state='pending'")
      .get()!.n,
  ).toBe(0);
  const original = [...inputs.values()][0];
  feed.retain(original);
  await feed.pass();
  expect(store.runs()).toHaveLength(65);
});

it('parks a finished group result with unavailable authority so another group can make progress', async () => {
  feed.retain(source());
  now += 20_000;
  await feed.pass();
  reply();
  allowed = false;
  await feed.pass();
  expect(store.db.prepare('SELECT state FROM group_member_feed_batches').get()!.state).toBe(
    'waiting',
  );
  const oldEnrollment = enrollment;
  const { displayName: _, ...member } = host.events.createGroup('Another group');
  context = host.events.createContext({
    ...member,
    visibility: 'shared',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  nativeContext = host.events.createContext({
    ...member,
    visibility: 'shared',
    provider: 'codex',
    nativeSessionId: randomUUID(),
  });
  enrollment = randomUUID();
  allowed = true;
  vi.mocked(host.promotionContext).mockImplementation(async (handle) => {
    if (handle === oldEnrollment) throw new Error('Old group authority unavailable');
    // This fixture uses the same retained current-membership port for the second group.
    return {
      context,
      enrollment: member,
      revalidate: async () => {},
      registerSource: vi.fn(async () => randomUUID()),
      enqueue: async () => ({ operationId: randomUUID(), state: 'committed' }),
    } as never;
  });
  feed.retain(source('The other group has a new shared result.'));
  now += 20_000;
  await feed.pass();
  expect(store.runs()).toHaveLength(2);
  expect(
    store.db
      .prepare("SELECT count(*) n FROM group_member_feed_batches WHERE state='pending'")
      .get()!.n,
  ).toBe(1);
  expect(
    store.db
      .prepare("SELECT count(*) n FROM group_member_feed_batches WHERE state='waiting'")
      .get()!.n,
  ).toBe(1);
  await feed.pass();
  expect(store.runs()).toHaveLength(2);
});

it('bounds unprocessed backlog while allowing disposed history to retain dedupe receipts', async () => {
  for (let i = 0; i <= MEMBER_FEED_LIMITS.pendingSources; i++)
    feed.retain(source(`Pending original ${i}.`));
  expect(store.db.prepare('SELECT count(*) n FROM group_member_feed_sources').get()!.n).toBe(
    MEMBER_FEED_LIMITS.pendingSources,
  );
  now += 20_000;
  await feed.pass();
  store.updateRun(store.runs()[0].id, { status: 'interrupted' });
  await feed.pass();
  feed.retain(source('Another source after a disposed batch.'));
  expect(store.db.prepare('SELECT count(*) n FROM group_member_feed_sources').get()!.n).toBe(
    MEMBER_FEED_LIMITS.pendingSources + 1,
  );
  expect(
    Number(
      store.db
        .prepare(
          "SELECT count(*) n FROM group_member_feed_sources WHERE state IN ('pending','waiting')",
        )
        .get()!.n,
    ),
  ).toBeLessThanOrEqual(MEMBER_FEED_LIMITS.pendingSources);
});

it('denies native tools/children for feed helpers without changing ordinary native agents', async () => {
  feed.retain(source());
  now += 20_000;
  await feed.pass();
  const helper = store.agent(store.runs()[0].agentId),
    provider = new DemoProvider();
  const requests = vi.spyOn(provider, 'request');
  const runtime = new Runtime(store, directory, 'never-native', async () => provider);
  vi.spyOn(runtime.modelPolicy, 'catalog').mockResolvedValue([
    { id: 'luna', label: 'Luna', isDefault: true, efforts: ['low'] },
  ]);
  try {
    await runtime.attach(helper.id);
    const params = requests.mock.calls.find(([method]) => method === 'thread/start')![1] as {
      dynamicTools: unknown[];
      config: {
        features: Record<string, boolean>;
        agents: { enabled: boolean };
        web_search: string;
      };
    };
    expect(params.dynamicTools).toEqual([]);
    expect(params.config.features).toMatchObject({
      shell_tool: false,
      unified_exec: false,
      view_image: false,
      skill_search: false,
      multi_agent: false,
      multi_agent_v2: false,
    });
    expect(params.config.agents.enabled).toBe(false);
    expect(params.config.web_search).toBe('disabled');
    await expect(runtime.tool(helper.id, randomUUID(), 'dock_inspect', {})).rejects.toThrow(
      'cannot call tools',
    );
    expect(() => runtime.requireDirectControl(helper.id)).toThrow('single-batch');
    const base = {
      binary: 'never-native',
      cwd: directory,
      sessionId: randomUUID(),
      resume: false,
      accountAffinity: 'a'.repeat(64),
      role: 'read-only',
      model: 'sonnet',
      effort: 'low',
      charter: 'Fixture',
      tools: [],
    } as ClaudeSessionOptions;
    const summary = claudeArguments({ ...base, nativeTools: 'off' });
    expect(summary[summary.indexOf('--tools') + 1]).toBe('');
    const ordinary = claudeArguments({ ...base, inheritNative: true });
    expect(ordinary).not.toContain('--tools');
    expect(ordinary).not.toContain('--restricted');
  } finally {
    await runtime.close();
  }
});
