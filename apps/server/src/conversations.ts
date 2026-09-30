import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentSchema,
  conversationCreateSchema,
  effortSchema,
  type Assignment,
  type Agent,
} from '@dock/shared';
import type { FastifyInstance } from 'fastify';
import { Conflict, type Store } from './store.js';
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
  app.get('/api/conversations', async () => ({
    conversations: store
      .agents()
      .filter((agent) => agent.surface === 'misc' || agent.surface === 'terminal')
      .map((agent) => agentSchema.parse(agent)),
  }));
  app.post('/api/conversations', async (request, reply) => {
    const input = conversationCreateSchema.parse(request.body);
    const result = await lock(`conversation:${input.key}`, () =>
      createConversation(store, models, dataDir, input),
    );
    return reply.code(201).send(result);
  });
}
