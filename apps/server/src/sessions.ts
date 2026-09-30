import { z } from 'zod';
import {
  agentSchema,
  sessionImportSchema,
  sessionListSchema,
  providerThreadId,
} from '@dock/shared';
import { Conflict, type PrivateProject } from './store.js';
import type { Provider } from './codex.js';
import type { Runtime } from './runtime.js';

const metadata = z.object({
  id: providerThreadId,
  cwd: z.string(),
  preview: z.string(),
  name: z.string().nullable().optional(),
  updatedAt: z.number(),
  status: z.object({ type: z.string() }).optional(),
  ephemeral: z.boolean().optional(),
});

/** A narrow history adapter. Listing/reading never resumes or executes a Codex thread. */
export class Sessions {
  constructor(readonly runtime: Runtime) {}
  private async connection<T>(
    projectId: string,
    read: (value: { project: PrivateProject; client: Provider }) => Promise<T>,
  ) {
    const project = this.runtime.store.project(projectId);
    return this.runtime.withCodexHistory(this.runtime.store.agent(project.managerId), (client) =>
      read({ project, client }),
    );
  }
  async list(projectId: string, cursor?: string) {
    return this.connection(projectId, async ({ project, client }) => {
      const page = z.object({ data: z.array(metadata), nextCursor: z.string().nullable() }).parse(
        await client.request('thread/list', {
          cwd: project.root,
          limit: 50,
          cursor,
          sortKey: 'updated_at',
          sourceKinds: [
            'cli',
            'vscode',
            'appServer',
            'exec',
            'subAgent',
            'subAgentReview',
            'subAgentCompact',
            'subAgentThreadSpawn',
            'subAgentOther',
            'unknown',
          ],
        }),
      );
      return sessionListSchema.parse({
        data: page.data
          .filter((t) => t.cwd === project.root && !t.ephemeral)
          .map((t) => ({
            id: t.id,
            title: (t.name || t.preview || 'Untitled Codex session')
              .replace(/\s+/g, ' ')
              .slice(0, 160),
            preview: t.preview.slice(0, 1000),
            updatedAt: t.updatedAt,
            agentId: this.runtime.store.contextOwner(t.id),
          })),
        nextCursor: page.nextCursor,
      });
    });
  }
  async import(projectId: string, raw: unknown) {
    const value = sessionImportSchema.parse(raw);
    const store = this.runtime.store;
    const input = { kind: 'session.import', projectId, ...value };
    return this.runtime.withLock(`import:${value.threadId}`, async () => {
      if (store.db.prepare('SELECT key FROM operations WHERE key=?').get(value.key))
        return store.operation(value.key, input, () => {
          throw new Conflict('Missing import receipt.');
        });
      const manager = store.agent(value.managerId);
      if (manager.projectId !== projectId || manager.role !== 'manager')
        throw new Conflict('Select a manager belonging to this project.');
      return this.connection(projectId, async ({ project, client }) => {
        const read = async () =>
          z.object({ thread: metadata }).parse(
            await client.request('thread/read', {
              threadId: value.threadId,
              includeTurns: false,
            }),
          ).thread;
        const thread = await read();
        if (thread.id !== value.threadId || thread.cwd !== project.root || thread.ephemeral)
          throw new Conflict('This saved session does not belong to the registered repository.');
        if (thread.status?.type === 'active')
          throw new Conflict('Stop the original session before importing its history.');
        const existingId = store.contextOwner(value.threadId);
        const existing = existingId ? store.agent(existingId) : null;
        if (existing) {
          if (existing.projectId !== projectId)
            throw new Conflict('This session is already registered elsewhere.');
          return store.operation(value.key, input, () => agentSchema.parse(existing));
        }
        const turns: unknown[] = [];
        const cursors = new Set<string>();
        let cursor: string | null = null;
        let bytes = 0;
        let pages = 0;
        do {
          const page = z
            .object({
              data: z.array(
                z.object({ id: z.string(), items: z.array(z.unknown()) }).passthrough(),
              ),
              nextCursor: z.string().nullable(),
            })
            .parse(
              await client.request('thread/turns/list', {
                threadId: value.threadId,
                cursor,
                limit: 10,
                sortDirection: 'asc',
                itemsView: 'full',
              }),
            );
          bytes += Buffer.byteLength(JSON.stringify(page.data));
          turns.push(...page.data);
          if (bytes > 32 * 1024 * 1024 || turns.length > 5000 || ++pages > 500)
            throw new Conflict(
              'This history exceeds the local import limit. Nothing was imported; the original Codex history is unchanged.',
            );
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor))
            throw new Conflict('Codex repeated a history cursor. Nothing was imported.');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        const after = await read();
        if (
          after.id !== thread.id ||
          after.updatedAt !== thread.updatedAt ||
          after.status?.type === 'active' ||
          after.cwd !== project.root
        )
          throw new Conflict(
            'The original session changed while reading it. Stop that client before importing.',
          );
        return store.operation(value.key, input, () => {
          // Recheck inside the transaction: another local client may have imported meanwhile.
          const registeredId = store.contextOwner(thread.id);
          const registered = registeredId ? store.agent(registeredId) : null;
          if (registered) {
            if (registered.projectId !== projectId)
              throw new Conflict('This session is already registered elsewhere.');
            return agentSchema.parse(registered);
          }
          const agent = store.addAgent({
            projectId,
            parentId: manager.id,
            taskId: null,
            role: 'researcher',
            provider: 'codex',
            name: (thread.name || thread.preview || 'Imported session')
              .replace(/\s+/g, ' ')
              .slice(0, 80),
            cwd: project.root,
          });
          const saved = store.updateAgent(agent.id, { threadId: thread.id });
          this.runtime.hydrate(agent.id, turns);
          store.observeContext(thread.id, 'codex');
          this.runtime.system(
            agent.id,
            'History imported',
            'Visible history was imported without starting a turn. This session begins read-only; delegate new implementation into a task worktree. Historical agent relationships are not reconstructed.',
          );
          store.event('session.imported', projectId, agent.id, {
            turns: turns.length,
            managerId: manager.id,
          });
          return agentSchema.parse(saved);
        });
      });
    });
  }
}
