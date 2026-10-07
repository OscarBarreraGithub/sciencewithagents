import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  groupContextSchema,
  groupMemberSchema,
  groupOperationIdSchema,
  groupEntityIdSchema,
  groupFeedPageSchema,
} from '@dock/shared';
import {
  groupFixtureCreateSchema,
  groupFixtureSelectSchema,
  groupFixtureOpenSchema,
  groupFixtureSendSchema,
  groupFixtureDraftSchema,
  groupFixtureChatSchema,
  groupFixtureFeedSchema,
  groupFixtureOriginalSchema,
  groupFixtureReceiptSchema,
  groupFixtureSummarySchema,
} from '@dock/shared/dist/group-fixture.js';
import { Store, Conflict, Missing } from './store.js';
import type { Runtime } from './runtime.js';
import { createConversation } from './conversations.js';
import { GroupEventRepository } from './group-events.js';

const slot = z.strictObject({ handle: z.uuid(), context: groupContextSchema, agentId: z.uuid() });
const record = z.strictObject({
  group: groupFixtureSummarySchema,
  member: groupMemberSchema,
  shared: slot,
  private: slot,
});
type Record = z.infer<typeof record>;
type Slot = z.infer<typeof slot>;
const uuid = (value: string) => {
  const h = createHash('sha256').update(value).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Explicit stub-only integration. No general Store event subscriber, transport or native authority. */
export class GroupFixtureHost {
  readonly events: GroupEventRepository;
  readonly token: string;
  constructor(
    readonly store: Store,
    readonly runtime: Runtime,
  ) {
    if (!runtime.fixture) throw new Error('Groups test host requires explicit fixture runtime.');
    this.events = new GroupEventRepository(join(runtime.dataDir, 'group-fixture-events.sqlite'));
    try {
      store.db
        .exec(`CREATE TABLE IF NOT EXISTS gf_groups (handle TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gf_sends (session TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE, PRIMARY KEY(session,key));
      CREATE TABLE IF NOT EXISTS gf_projection (entry_id TEXT PRIMARY KEY, event_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gf_drafts (session TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL);`);
      const saved = store.getSetting('group-fixture:authentication');
      this.token =
        saved === null
          ? randomBytes(32).toString('hex')
          : z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .parse(saved);
      if (saved === null) store.setSetting('group-fixture:authentication', this.token);
    } catch (error) {
      this.events.close();
      throw error;
    }
  }
  close() {
    this.events.close();
  }
  get cookieName() {
    return `swa_group_fixture_${createHash('sha256').update(this.token).digest('hex').slice(0, 16)}`;
  }
  authenticate(authorization?: string, cookie?: string) {
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const cookies = (cookie ?? '')
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(`${this.cookieName}=`));
    return (
      equal(bearer, this.token) ||
      (cookies.length === 1 && equal(cookies[0].slice(this.cookieName.length + 1), this.token))
    );
  }
  records(): Record[] {
    return this.store.db
      .prepare('SELECT body FROM gf_groups ORDER BY rowid')
      .all()
      .map((r) => record.parse(JSON.parse(String(r.body))));
  }
  resolve(handle: string): { group: Record; slot: Slot } {
    // Bounded local fixture (max 32 groups). A browser never supplies a context/agent/path.
    for (const group of this.records()) {
      for (const selected of [group.shared, group.private])
        if (selected.handle === handle) {
          this.access(selected, 'authorization');
          return { group, slot: selected };
        }
    }
    throw new Missing('Saved test session unavailable. Reopen the group.');
  }
  access(selected: Slot, messageId: string) {
    const { sessionId, provider, nativeSessionId, ...identity } = selected.context;
    return this.events.trustedHostScope({
      ...identity,
      source: { sessionId, provider, nativeSessionId, messageId },
      causalRefs: [],
    });
  }
  async create(raw: unknown) {
    const input = groupFixtureCreateSchema.parse(raw);
    return this.runtime.withLock('group-fixture:create', async () => {
      const receiptKey = `group-fixture:create:${input.key}`;
      const receipt = this.store.getSetting(receiptKey) as { input: string; handle: string } | null;
      if (receipt) {
        if (receipt.input !== JSON.stringify(input))
          throw new Conflict('Create retry content changed.');
        return this.open({ handle: receipt.handle });
      }
      if (this.records().length >= 32)
        throw new Conflict('Local test host limit: 32 saved groups. Use a fresh fixture root.');
      // The normal conversation factory chooses owned folders/model catalog and retains creation receipts.
      const make = (visibility: 'shared' | 'private') =>
        createConversation(this.store, this.runtime.modelPolicy, this.runtime.dataDir, {
          key: uuid(`${input.key}:${visibility}`),
          name: `${visibility === 'shared' ? 'Group' : 'Private aside'} · ${input.projectName}`.slice(
            0,
            120,
          ),
          provider: 'codex',
          model: 'demo',
          effort: 'medium',
          saveContact: true,
        });
      const shared = await make('shared');
      const privateAgent = await make('private');
      // Only synchronous trusted provisioning below. An abrupt crash may leave unreachable
      // orphan provisioning rows; no browser receipt or saved group refers to them.
      const { groupId, ...member } = this.events.createGroup(input.displayName);
      const context = (agentId: string, visibility: 'shared' | 'private'): Slot => ({
        handle: randomUUID(),
        agentId,
        context: this.events.createContext({
          groupId,
          memberId: member.memberId,
          installationId: member.installationId,
          visibility,
          provider: 'codex',
          nativeSessionId: `fixture:${groupId}:${agentId}`,
        }),
      });
      const value = record.parse({
        group: {
          id: groupId,
          handle: randomUUID(),
          name: input.projectName,
          members: 1,
          sync: 'Local test host · fake replies',
        },
        member: { groupId, ...member, active: true },
        shared: context(shared.id, 'shared'),
        private: context(privateAgent.id, 'private'),
      });
      this.store.transaction(() => {
        this.store.db
          .prepare('INSERT INTO gf_groups VALUES (?,?)')
          .run(value.group.handle, JSON.stringify(value));
        this.store.setSetting(receiptKey, {
          input: JSON.stringify(input),
          handle: value.group.handle,
        });
      });
      return this.open({ handle: value.group.handle });
    });
  }
  open(raw: unknown) {
    const { handle } = groupFixtureSelectSchema.parse(raw);
    const value = this.records().find((g) => g.group.handle === handle);
    if (!value) throw new Missing('Saved group unavailable.');
    this.access(value.shared, 'open');
    this.access(value.private, 'open');
    const present = ({ agentId, ...selected }: Slot) => ({
      ...selected,
      agent: this.store.agent(agentId),
    });
    return groupFixtureOpenSchema.parse({
      ...value,
      shared: present(value.shared),
      private: present(value.private),
    });
  }
  project(selected: Slot) {
    const runs = new Set(
      this.store.db
        .prepare('SELECT run_id FROM gf_sends WHERE session=?')
        .all(selected.handle)
        .map((r) => String(r.run_id)),
    );
    // <=256 sends with one fake reply each. No tools, unrelated runs or host events forwarded.
    const entries = this.store
      .entries(selected.agentId, undefined, 1024)
      .filter(
        (e) =>
          e.runId &&
          runs.has(e.runId) &&
          ['user', 'assistant'].includes(e.kind) &&
          e.text.length > 0 &&
          (e.kind === 'user' || e.status === 'complete'),
      );
    for (const entry of entries) {
      if (this.store.db.prepare('SELECT 1 FROM gf_projection WHERE entry_id=?').get(entry.id))
        continue;
      const id = uuid(`${selected.context.sessionId}:${entry.id}`);
      const preview = Array.from(entry.text).slice(0, 240).join('');
      const event = this.events.append(this.access(selected, entry.id), {
        operationId: groupOperationIdSchema.parse(id),
        entityId: groupEntityIdSchema.parse(id),
        expectedRevision: 0,
        category: entry.kind === 'user' ? 'Question' : 'Finding',
        condensedText: `Test excerpt · ${entry.kind === 'user' ? 'Message' : 'Fake reply'}: ${preview}`,
        original: { kind: 'inline', text: entry.text },
        evidenceRefs: [],
        corrects: null,
      }).event;
      this.store.db.prepare('INSERT INTO gf_projection VALUES (?,?)').run(entry.id, event.eventId);
    }
  }
  recover() {
    for (const group of this.records())
      for (const selected of [group.shared, group.private]) this.project(selected);
  }
  send(raw: unknown) {
    const input = groupFixtureSendSchema.parse(raw);
    const { slot: selected } = this.resolve(input.handle);
    const result = this.store.transaction(() => {
      const saved = this.store.db
        .prepare('SELECT text,run_id FROM gf_sends WHERE session=? AND key=?')
        .get(input.handle, input.key);
      if (saved) {
        if (saved.text !== input.text) throw new Conflict('Send retry content changed.');
        const runId = String(saved.run_id);
        const run = this.store.run(runId);
        // Explicit retry of an interrupted fake turn only; never a production/native replay.
        if (run.status === 'interrupted') {
          const completed = this.store
            .entries(selected.agentId, undefined, 1024)
            .some((e) => e.runId === runId && e.kind === 'assistant' && e.status === 'complete');
          this.store.updateRun(runId, { status: completed ? 'completed' : 'queued', turnId: null });
          this.store.updateAgent(selected.agentId, {
            status: completed ? 'idle' : 'queued',
            turnId: null,
          });
        }
        return { key: input.key, runId, status: 'accepted' as const };
      }
      const count = this.store.db
        .prepare('SELECT COUNT(*) AS n FROM gf_sends WHERE session=?')
        .get(input.handle)!;
      if (Number(count.n) >= 256)
        throw new Conflict(
          'Local test session limit: 256 sends. Existing receipts remain readable.',
        );
      const agent = this.store.agent(selected.agentId);
      if (['failed', 'interrupted', 'waiting'].includes(agent.status) && !agent.turnId)
        this.store.updateAgent(agent.id, { status: 'idle', autoTurns: 0 });
      const run = this.store.enqueue(
        selected.agentId,
        `group-fixture:${input.handle}:${input.key}`,
        input.text,
      );
      this.runtime.quark.captureOwnerChat(this.store.run(run.id));
      this.store.db
        .prepare('INSERT INTO gf_sends VALUES (?,?,?,?)')
        .run(input.handle, input.key, input.text, run.id);
      return { key: input.key, runId: run.id, status: 'accepted' as const };
    });
    this.project(selected);
    this.runtime.kick();
    return groupFixtureReceiptSchema.parse(result);
  }
  draft(selected: Slot) {
    const row = this.store.db
      .prepare('SELECT text,revision FROM gf_drafts WHERE session=?')
      .get(selected.handle);
    return { text: row ? String(row.text) : '', revision: row ? Number(row.revision) : 0 };
  }
  saveDraft(raw: unknown) {
    const input = groupFixtureDraftSchema.parse(raw);
    const { slot: selected } = this.resolve(input.handle);
    return this.store.operation(`group-fixture:draft:${input.handle}:${input.key}`, input, () => {
      const prior = this.draft(selected);
      if (input.revision !== prior.revision)
        throw new Conflict('Draft changed in another view. Choose which version to keep.');
      const value = { text: input.text, revision: prior.revision + 1 };
      this.store.db
        .prepare(
          'INSERT INTO gf_drafts VALUES (?,?,?) ON CONFLICT(session) DO UPDATE SET text=excluded.text,revision=excluded.revision',
        )
        .run(input.handle, value.text, value.revision);
      return value;
    });
  }
  chat(raw: unknown) {
    const { handle } = groupFixtureSelectSchema.parse(raw);
    const { slot: selected } = this.resolve(handle);
    this.project(selected);
    const entries = this.store.entries(selected.agentId, undefined, 201);
    return groupFixtureChatSchema.parse({
      detail: {
        agent: this.store.agent(selected.agentId),
        entries: entries.slice(-200),
        runs: [],
        hasMore: entries.length > 200,
      },
      draft: this.draft(selected),
    });
  }
  feed(raw: unknown) {
    const { handle, query } = groupFixtureFeedSchema.parse(raw);
    const { group, slot: selected } = this.resolve(handle);
    if (selected.context.visibility !== 'shared') throw new Conflict('Use the shared feed handle.');
    this.project(group.shared);
    return groupFeedPageSchema.parse(this.events.feed(this.access(selected, 'feed'), query));
  }
  original(raw: unknown) {
    const { handle, eventId } = groupFixtureOriginalSchema.parse(raw);
    const { slot: selected } = this.resolve(handle);
    if (selected.context.visibility !== 'shared')
      throw new Conflict('Only shared originals expand into this feed.');
    const original = this.events.expand(this.access(selected, 'original'), eventId);
    return { eventId, text: original.original };
  }
  catchUp(raw: unknown) {
    const { handle } = groupFixtureSelectSchema.parse(raw);
    const { group } = this.resolve(handle);
    this.project(group.shared);
    const access = this.access(group.shared, 'catch-up');
    const first = this.events.feed(access, {
      visibility: 'shared',
      after: 0,
      limit: 1,
      cursor: null,
    });
    const page = this.events.feed(access, {
      visibility: 'shared',
      after: Math.max(0, first.watermark - 20),
      limit: 20,
      cursor: null,
    });
    return {
      text: `Deterministic test catch-up · latest ${page.entries.length} shared events through ${page.watermark}. No LLM summary.\n${page.entries.map((e) => `${e.sequence}. ${e.condensedText}`).join('\n') || 'No shared messages yet.'}`,
    };
  }
}

export function registerGroupFixtureRoutes(app: FastifyInstance, host: GroupFixtureHost) {
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/') || ['/api/health', '/api/group-fixture/status'].includes(path))
      return;
    if (!host.authenticate(request.headers.authorization, request.headers.cookie))
      return reply.code(401).send({
        error: 'Open the fixture URL printed by its owned foreground host.',
        code: 'FIXTURE_UNLOCK_REQUIRED',
      });
    // Generic chat APIs cannot mutate or expose Groups sessions outside this boundary.
    const agent = /^\/api\/agents\/([^/]+)/.exec(path)?.[1];
    if (agent && host.records().some((g) => [g.shared.agentId, g.private.agentId].includes(agent)))
      return reply.code(403).send({ error: 'Use the Groups test-host routes for this session.' });
  });
  app.get('/api/group-fixture/status', async () => ({ enabled: true }));
  app.post('/api/group-fixture/connect', async (request, reply) => {
    z.strictObject({}).parse(request.body);
    reply.header(
      'Set-Cookie',
      `${host.cookieName}=${host.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
    );
    return { connected: true };
  });
  app.get('/api/group-fixture/groups', async () => ({
    groups: host.records().map((g) => {
      host.access(g.shared, 'list');
      return g.group;
    }),
  }));
  const routes = {
    create: (v: unknown) => host.create(v),
    open: (v: unknown) => host.open(v),
    chat: (v: unknown) => host.chat(v),
    send: (v: unknown) => host.send(v),
    draft: (v: unknown) => host.saveDraft(v),
    feed: (v: unknown) => host.feed(v),
    original: (v: unknown) => host.original(v),
    'catch-up': (v: unknown) => host.catchUp(v),
  };
  for (const [name, action] of Object.entries(routes))
    app.post(`/api/group-fixture/${name}`, { bodyLimit: 24 * 1024 }, async (request) =>
      action(request.body),
    );
}
