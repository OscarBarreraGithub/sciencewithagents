import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  agentSchema,
  conversationCreateSchema,
  conversationListQuerySchema,
  conversationVisibilitySchema,
  conversationVisibilityIdentity,
  conversationVisibilityTargetSchema,
  conversationVisibilityUpdateSchema,
  conversationVisibilityQuerySchema,
  conversationVisibilityPageSchema,
  effortSchema,
  type Assignment,
  type Agent,
  type ConversationVisibilityTarget,
  type MirrorState,
} from '@dock/shared';
import type { FastifyInstance } from 'fastify';
import { Conflict, Missing, type Store } from './store.js';
import type { ModelPolicy } from './model-policy.js';

type Intent = {
  input: string;
  model: string;
  effort: Agent['effort'];
  assignment: Assignment | null;
};

function privateDirectory(path: string) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Conflict(
      'Conversation storage is not a private directory. Existing files were not changed.',
    );
}

/** One host-owned folder and retained native identity; creation never starts a model turn. */
export async function createConversation(
  store: Store,
  models: ModelPolicy,
  dataDir: string,
  raw: unknown,
) {
  const input = conversationCreateSchema.parse(raw);
  const key = `conversation.create:${input.key}`;
  // A completed retry returns its original receipt even after settings, catalogs or history change.
  if (store.db.prepare('SELECT 1 FROM operations WHERE key=?').get(key)) {
    return store.operation(key, input, (): Agent => {
      throw new Error('Missing conversation receipt.');
    });
  }
  const serialized = JSON.stringify(input);
  let intent = store.getSetting(key) as Intent | null;
  if (intent && intent.input !== serialized)
    throw new Conflict('This retry key already belongs to another conversation.');
  if (!intent) {
    if (!models.policy().enabledProviders.includes(input.provider))
      throw new Conflict('Enable this provider in Model settings before starting a conversation.');
    const assignment = input.model
      ? null
      : await models.resolve('reasoning', {
          mode: 'automatic',
          difficulty: 'unspecified',
          provider: input.provider,
          ...(input.effort ? { effort: input.effort } : {}),
        });
    const catalog = await models.catalog(input.provider);
    const model = catalog.find((item) => item.id === (input.model ?? assignment?.model));
    const effort =
      input.effort ??
      assignment?.effort ??
      (model?.efforts.includes('medium')
        ? 'medium'
        : model?.efforts.find((value) => effortSchema.safeParse(value).success));
    if (!model || !effort || !model.efforts.includes(effort))
      throw new Conflict('Choose a model and thinking level from the current provider catalog.');
    intent = { input: serialized, model: model.id, effort: effortSchema.parse(effort), assignment };
    store.setSetting(key, intent);
  }
  const parent = join(realpathSync(dataDir), 'conversations');
  const root = join(parent, input.key);
  privateDirectory(parent);
  privateDirectory(root);
  const existing = store.projects().find((project) => project.root === root);
  if (!existing && readdirSync(root).length)
    throw new Conflict(
      'Unexpected files exist in this unfinished conversation folder. Existing files were not changed.',
    );
  const project =
    existing ??
    store.register(
      root,
      input.name,
      'Private conversation workspace, separate from work projects.',
      input.provider,
    );
  const choice = intent;
  return store.operation(key, input, () => {
    const agent = store.agent(project.managerId);
    if (
      agent.threadId ||
      agent.taskId ||
      agent.parentId ||
      store.runs().some((run) => run.agentId === agent.id)
    )
      throw new Conflict(
        'This unfinished conversation has already been used. Its saved history is unchanged.',
      );
    const result = store.updateAgent(agent.id, {
      name: input.name,
      surface: input.saveContact ? 'misc' : 'terminal',
      scope: 'A direct conversation with the owner, in its own private folder.',
      toolPolicy: 'native',
      permission: 'workspace-write',
      model: choice.model,
      effort: choice.effort,
      assignment: choice.assignment,
      modelSelection: input.model || input.effort ? 'exact' : 'policy',
    });
    store.setSetting(`model-policy:follow:${agent.id}`, !input.model && !input.effort);
    store.event('conversation.created', project.id, agent.id, { surface: result.surface });
    return agentSchema.parse(result);
  });
}

export function registerConversationRoutes(
  app: FastifyInstance,
  store: Store,
  models: ModelPolicy,
  dataDir: string,
  lock: <T>(key: string, fn: () => Promise<T>) => Promise<T>,
) {
  app.get('/api/conversations', async (request) => {
    const query = conversationListQuerySchema.parse(request.query);
    return {
      conversations: store
        .agents()
        .filter((agent) => agent.surface === 'misc' || agent.surface === 'terminal')
        .filter(
          (agent) =>
            query.includeArchived === 'true' ||
            !conversationHidden(store, { kind: 'agent', agentId: agent.id }),
        )
        .map((agent) => agentSchema.parse(agent)),
    };
  });
  app.post('/api/conversations', async (request, reply) => {
    const input = conversationCreateSchema.parse(request.body);
    const result = await lock(`conversation:${input.key}`, () =>
      createConversation(store, models, dataDir, input),
    );
    return reply.code(201).send(result);
  });
}

const visibilityPrefix = 'conversation:visibility:';
const visibilityKey = (target: ConversationVisibilityTarget) =>
  visibilityPrefix +
  createHash('sha256').update(conversationVisibilityIdentity(target)).digest('hex');

export function conversationVisibility(store: Store, raw: ConversationVisibilityTarget) {
  const target = conversationVisibilityTargetSchema.parse(raw);
  const saved = store.getSetting(visibilityKey(target));
  return saved ? conversationVisibilitySchema.parse(saved) : null;
}
export function conversationHidden(store: Store, target: ConversationVisibilityTarget) {
  return conversationVisibility(store, target)?.archived ?? false;
}

/** Visibility only: never changes agent/native lifecycle, files, history, or work. */
export function registerConversationVisibilityRoutes(
  app: FastifyInstance,
  store: Store,
  windows: () => Omit<MirrorState, 'entries'>[],
) {
  app.get('/api/conversations/visibility', async (request) => {
    const input = conversationVisibilityQuerySchema.parse(request.query);
    let after = 0;
    if (input.cursor) {
      const row = store.db
        .prepare("SELECT rowid FROM settings WHERE key LIKE ? AND json_extract(value,'$.id')=?")
        .get(`${visibilityPrefix}%`, input.cursor);
      if (!row)
        throw new Missing(
          'This conversation visibility page could not be found. Refresh the list.',
        );
      after = Number(row.rowid);
    }
    const filter = input.archived === undefined ? '' : "AND json_extract(value,'$.archived')=?";
    const args = input.archived === undefined ? [] : [input.archived === 'true' ? 1 : 0];
    const rows = store.db
      .prepare(
        `SELECT value FROM settings WHERE key LIKE ? AND rowid>? ${filter} ORDER BY rowid LIMIT ?`,
      )
      .all(`${visibilityPrefix}%`, after, ...args, input.limit + 1);
    const records = rows
      .slice(0, input.limit)
      .map((row) => conversationVisibilitySchema.parse(JSON.parse(String(row.value))));
    return conversationVisibilityPageSchema.parse({
      records,
      nextCursor: rows.length > input.limit ? records.at(-1)!.id : null,
    });
  });
  app.post('/api/conversations/visibility', async (request) => {
    const input = conversationVisibilityUpdateSchema.parse(request.body);
    return store.operation(`conversation.visibility:${input.key}`, input, () => {
      const saved = conversationVisibility(store, input.target);
      if ((saved?.revision ?? 0) !== input.expectedRevision)
        throw new Conflict(
          'This conversation visibility changed on another device. Refresh before saving.',
          'VISIBILITY_CHANGED',
        );
      const agent = input.target.kind === 'agent' ? store.agent(input.target.agentId) : null;
      const target = input.target;
      const window =
        target.kind === 'shared'
          ? windows().find(
              (item) =>
                (item.provider ?? 'codex') === target.provider && item.threadId === target.threadId,
            )
          : null;
      if (!agent && !window && !saved)
        throw new Missing('Share this native conversation before changing its visibility.');
      const updatedAt = new Date().toISOString();
      const record = conversationVisibilitySchema.parse({
        id: saved?.id ?? randomUUID(),
        target,
        revision: (saved?.revision ?? 0) + 1,
        archived: input.archived,
        archivedAt: input.archived ? (saved?.archivedAt ?? updatedAt) : null,
        updatedAt,
        provider: agent?.provider ?? window?.provider ?? saved?.provider ?? 'codex',
        source: agent ? 'app' : window ? (window.source ?? 'vscode') : saved!.source,
        title: (
          agent?.name ??
          (window ? window.title || window.label || 'Shared native conversation' : saved!.title)
        ).slice(0, 500),
        caption: (agent
          ? store.project(agent.projectId).name
          : (window?.label ?? saved!.caption)
        ).slice(0, 200),
      });
      store.setSetting(visibilityKey(target), record);
      store.event('conversation.visibility', agent?.projectId ?? null, agent?.id ?? null, {
        id: record.id,
        target,
        revision: record.revision,
        archived: record.archived,
      });
      return record;
    });
  });
}
