/** Disposable deterministic acceptance host; no providers/installed host/service/account. */
import Fastify from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../../web/node_modules/vite/dist/node/index.js';
import react from '../../web/node_modules/@vitejs/plugin-react/dist/index.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  groupEntityIdSchema,
  groupOperationIdSchema,
  type GroupScope,
  type GroupEvent,
} from '@dock/shared';
import type { GroupEvidenceFacts } from '@dock/shared/dist/group-evidence.js';
import { GroupEventRepository } from './group-events.js';
import { GroupCatchupStore } from './group-catchup.js';
import { GroupEvidenceIndex } from './group-evidence.js';
import { registerGroupCatchupRoutes } from './group-catchup-routes.js';
import type { GroupCatchupReader } from './group-catchup-context.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
mkdirSync(resolve(root, 'data/group-catchup-ui'), { recursive: true });
const directory = mkdtempSync(resolve(root, 'data/group-catchup-ui/fixture-'));
const repo = new GroupEventRepository(resolve(directory, 'events.sqlite'));
const member = repo.createGroup('Alice');
const context = repo.createContext({
  groupId: member.groupId,
  memberId: member.memberId,
  installationId: member.installationId,
  visibility: 'private',
  provider: 'codex',
  nativeSessionId: randomUUID(),
});
const shared = repo.createContext({
  groupId: member.groupId,
  memberId: member.memberId,
  installationId: member.installationId,
  visibility: 'shared',
  provider: 'codex',
  nativeSessionId: randomUUID(),
});
const scope = (ctx = context, refs: GroupEvent['eventId'][] = []): GroupScope => ({
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
const events: GroupEvent[] = [];
const facts = new Map<string, GroupEvidenceFacts>();
for (let i = 0; i < 37; i++) {
  const category = (
    [
      'Instruction',
      'Decision',
      'Finding',
      'Action',
      'Conflict',
      'Blocker',
      'Question',
      'Idea',
    ] as const
  )[i % 8];
  const refs = i > 0 ? [events[0].eventId] : [];
  const e = repo.append(repo.trustedHostScope(scope(shared, refs)), {
    operationId: groupOperationIdSchema.parse(randomUUID()),
    entityId: groupEntityIdSchema.parse(randomUUID()),
    expectedRevision: 0,
    category,
    condensedText: `${i + 1}. ${category}: River team verified a changed calibration and retained exact responsibility evidence. ${i === 1 ? 'Long evidence '.repeat(40) : ''}`,
    original: {
      kind: 'inline',
      text: `  Original ${i + 1}\n\nKeep exact whitespace and 🧬 unicode.\t${'long-source-'.repeat(40)}`,
    },
    evidenceRefs: [],
    corrects: null,
  }).event;
  events.push(e);
  facts.set(e.eventId, {
    sourceId: `group-action:${member.groupId}:${i + 1}`,
    sourceVersion: 1,
    kinds: [
      category === 'Decision'
        ? 'decision'
        : category === 'Action'
          ? 'action'
          : category === 'Finding'
            ? 'file'
            : category === 'Blocker'
              ? 'unresolved'
              : 'finding',
    ],
    subjectIds: [e.entityId],
    paths: ['src/river.ts'],
    instructionIds: refs,
    originalIds: { taskId: e.entityId },
    edges: refs.map((id) => ({ fromId: id, toId: e.entityId, relation: 'instruction' })),
    autonomous: category === 'Decision' ? true : null,
    unresolved: category === 'Blocker' ? true : null,
  });
}
repo.append(repo.trustedHostScope(scope()), {
  operationId: groupOperationIdSchema.parse(randomUUID()),
  entityId: groupEntityIdSchema.parse(randomUUID()),
  expectedRevision: 0,
  category: 'Question',
  condensedText: 'PRIVATE ASIDE CANARY',
  original: { kind: 'inline', text: 'PRIVATE ORIGINAL CANARY' },
  evidenceRefs: [],
  corrects: null,
});
let offline = false;
let loseAck = false;
let loseQuery = false;
const reader: GroupCatchupReader = {
  context,
  enrollmentHandle: context.installationId,
  revalidate: async () => {
    if (offline) throw new Error('offline');
    repo.trustedHostScope(scope());
  },
  readShared: async (q) => repo.feed(repo.trustedHostScope(scope()), q),
  original: async (id) => {
    const v = repo.expand(repo.trustedHostScope(scope()), id);
    if (v.event.scope.visibility !== 'shared') throw new Error('private');
    return { eventId: v.event.eventId, text: v.original };
  },
};
const catchup = new GroupCatchupStore(resolve(directory, 'catchup.sqlite'));
const evidence = new GroupEvidenceIndex(resolve(directory, 'evidence.sqlite'), {
  readVerifiedShared: async (_, id) => ({
    event: events.find((e) => e.eventId === id)!,
    facts: facts.get(id)!,
  }),
});
for (const e of events) await evidence.ingestVerifiedShared(reader, e.eventId);
const app = Fastify();
registerGroupCatchupRoutes(app, {
  authenticated: (r) => r.headers.cookie?.includes('gc_fixture=1') === true,
  resolve: async (handle) => {
    if (handle !== 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') throw new Error('handle');
    return reader;
  },
  catchup,
  evidence,
});
app.post('/__test/control', { bodyLimit: 1024 }, async (request, reply) => {
  if (!request.headers.cookie?.includes('gc_fixture=1')) return reply.code(401).send();
  const v = request.body as {
    offline?: boolean;
    loseAck?: boolean;
    loseQuery?: boolean;
    reset?: boolean;
  };
  if (v.reset) {
    const db = new DatabaseSync(resolve(directory, 'catchup.sqlite'));
    db.exec(
      'PRAGMA foreign_keys=OFF; DELETE FROM gc_continuations; DELETE FROM gc_pages; DELETE FROM gc_snapshots; DELETE FROM gc_members;',
    );
    db.close();
  }
  offline = v.offline ?? offline;
  loseAck = v.loseAck ?? loseAck;
  loseQuery = v.loseQuery ?? loseQuery;
  return { ok: true };
});
app.addHook('onSend', async (request, reply, payload) => {
  if (loseQuery && request.url === '/api/groups/evidence/query' && reply.statusCode === 200) {
    loseQuery = false;
    reply.code(503);
    return JSON.stringify({
      error: 'Simulated lost private query response. Resume the saved request.',
    });
  }
  if (loseAck && request.url === '/api/groups/catchup/ack' && reply.statusCode === 200) {
    loseAck = false;
    reply.code(503);
    return JSON.stringify({ error: 'Simulated lost acknowledgement. Retry the same page.' });
  }
  return payload;
});
const vite = await createServer({
  root: resolve(root, 'apps/web/group-catchup-preview'),
  publicDir: false,
  plugins: [react()],
  server: {
    middlewareMode: true,
    hmr: false,
    watch: null,
    fs: {
      allow: [
        resolve(root, 'apps/web'),
        resolve(root, 'packages/shared/dist'),
        resolve(root, 'node_modules'),
      ],
    },
  },
  appType: 'spa',
});
app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api/') || request.url.startsWith('/__test/'))
    return reply.code(404).send();
  if (request.url === '/')
    reply.raw.setHeader('Set-Cookie', 'gc_fixture=1; HttpOnly; SameSite=Strict; Path=/');
  reply.hijack();
  vite.middlewares(request.raw, reply.raw, () => {
    reply.raw.statusCode = 404;
    reply.raw.end();
  });
});
await app.listen({ host: '127.0.0.1', port: 53317 });
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await vite.close();
  evidence.close();
  catchup.close();
  repo.close();
  rmSync(directory, { recursive: true, force: true });
};
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
