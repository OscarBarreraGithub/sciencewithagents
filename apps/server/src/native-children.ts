import { z } from 'zod';
import { effortSchema, providerDefaultEffort, providerThreadId } from '@dock/shared';
import type { Provider } from './codex.js';
import { Store, type PrivateAgent } from './store.js';
import { setTimeout as delay } from 'node:timers/promises';
import { omitNullOptions } from './mcp.js';

/** Apply only native-workgroup settings; preserve other feature gates and role definitions. */
export async function nativeChildConfig(
  client: Provider,
  manager: boolean,
  selection?: { model: string | null; effort: string },
) {
  const record = z.record(z.string(), z.unknown());
  const { config } = z
    .object({ config: record })
    .parse(await client.request('config/read', { includeLayers: false }));
  const features = z.record(z.string(), z.boolean()).parse(omitNullOptions(config.features ?? {}));
  const agents = record.parse(omitNullOptions(config.agents ?? {}));
  // Do not forward both spellings of the provider's concurrency setting.
  delete agents.max_threads;
  return {
    features: { ...features, multi_agent: !manager, multi_agent_v2: !manager },
    agents: {
      ...agents,
      enabled: !manager,
      max_concurrent_threads_per_session: 2,
      ...(selection?.model
        ? {
            default_subagent_model: selection.model,
            default_subagent_reasoning_effort: selection.effort,
          }
        : {}),
    },
  };
}

const thread = z.object({
  id: providerThreadId,
  sessionId: providerThreadId,
  parentThreadId: providerThreadId.nullable(),
  cwd: z.string(),
  ephemeral: z.boolean(),
  agentNickname: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  reasoningEffort: z.string().nullable().optional(),
  source: z.unknown(),
});
const source = z.object({
  subAgent: z.object({
    thread_spawn: z.object({
      parent_thread_id: providerThreadId,
      agent_path: z.string().min(1).max(1000).nullable(),
    }),
  }),
});

/** Durable child identities; native execution remains owned by one provider tree. */
export class NativeChildren {
  constructor(readonly store: Store) {}
  rootId(agentId: string) {
    return this.store.agent(agentId).nativeRootId ?? agentId;
  }
  family(agentId: string) {
    const rootId = this.rootId(agentId);
    return this.store.agents().filter((a) => a.id === rootId || a.nativeRootId === rootId);
  }
  /** Hook identities are native helper IDs, not independently resumable sessions. */
  claude(rootId: string, sessionId: string, nativeId: string, name?: string): PrivateAgent | null {
    const root = this.store.agent(rootId);
    if (
      root.provider !== 'claude' ||
      root.nativeRootId ||
      root.threadId !== sessionId ||
      !providerThreadId.safeParse(nativeId).success
    )
      return null;
    const path = `${sessionId}/${nativeId}`;
    const known = this.family(rootId).find((a) => a.nativePath === path);
    if (known) return known;
    return this.store.transaction(() => {
      const agent = this.store.addAgent({
        projectId: root.projectId,
        provider: 'claude',
        parentId: root.id,
        taskId: root.taskId,
        role: 'researcher',
        name: (name || 'Native Claude helper').slice(0, 80),
        cwd: root.cwd,
        scope:
          'Observed native helper in the owning Claude session. Its exact nested parent and model may be unavailable; control belongs to the root.',
      });
      const saved = this.store.updateAgent(agent.id, {
        nativeRootId: rootId,
        nativePath: path,
        toolPolicy: root.toolPolicy,
        permission: root.permission,
        effort: providerDefaultEffort,
        modelSelection: 'native',
      });
      const affinity = this.store.getSetting(`claude:account:${rootId}`);
      if (affinity) this.store.setSetting(`claude:account:${agent.id}`, affinity);
      this.store.event('native.child_registered', root.projectId, agent.id, {
        rootAgentId: rootId,
        sessionId,
        nativeAgentId: nativeId,
        hierarchy: 'owning-session',
      });
      return saved;
    });
  }
  /** A completed native Agent call identifies both caller and helper. A lifecycle
   * hook alone identifies only the owning session, never an exact nested parent. */
  claudeParent(
    rootId: string,
    sessionId: string,
    childId: string,
    parentId: string,
    toolId: string,
  ) {
    const root = this.store.agent(rootId);
    const family = this.family(rootId);
    const child = family.find((a) => a.id === childId);
    const parent = family.find((a) => a.id === parentId);
    if (
      root.provider !== 'claude' ||
      root.threadId !== sessionId ||
      !child?.nativeRootId ||
      !parent ||
      child.id === parent.id ||
      !child.nativePath?.startsWith(`${sessionId}/`) ||
      (parent.id !== rootId && !parent.nativePath?.startsWith(`${sessionId}/`))
    )
      return;
    const key = `claude:parent:${child.id}`;
    if (this.store.getSetting(key)) return; // Resumes never rewrite the first observed parent.
    const seen = new Set([child.id]);
    let ancestor = parent;
    while (ancestor.id !== rootId) {
      if (seen.has(ancestor.id)) return;
      seen.add(ancestor.id);
      const next = family.find((a) => a.id === ancestor.parentId);
      if (!next) return;
      ancestor = next;
    }
    this.store.transaction(() => {
      const proof = { parentId, sessionId, toolId };
      this.store.setSetting(key, proof);
      this.store.updateAgent(child.id, {
        parentId,
        scope: `Native helper invoked by ${parent.name}. Budget and stop control belong to the owning session.`,
      });
      this.store.event('native.child_linked', child.projectId, child.id, {
        rootAgentId: rootId,
        ...proof,
      });
    });
  }
  async resolve(
    rootId: string,
    threadId: string,
    client: Provider,
    seen = new Set<string>(),
  ): Promise<PrivateAgent | null> {
    const root = this.store.agent(rootId);
    if (
      (root.role === 'manager' && root.toolPolicy !== 'native') ||
      root.nativeRootId ||
      seen.size >= 32 ||
      seen.has(threadId)
    )
      return null;
    const knownId = this.store.contextOwner(threadId);
    if (knownId) {
      const known = this.store.agent(knownId);
      return known.threadId === threadId && known.nativeRootId === rootId ? known : null;
    }
    seen.add(threadId);
    const read = async (id: string) => {
      // Classic children can publish activity before their initial metadata is flushed.
      // Retry only that specific read-only race; never replay a turn or tool request.
      for (let attempt = 0; ; attempt++) {
        try {
          const result = z.object({ thread }).safeParse(
            await client.request('thread/read', {
              threadId: id,
              includeTurns: false,
            }),
          );
          return result.success ? result.data.thread : null;
        } catch (error) {
          if (
            !client.ready ||
            attempt >= 7 ||
            !(error instanceof Error) ||
            !/failed to read session metadata .*rollout at .* is empty/.test(error.message)
          )
            throw new Error(
              'Native child metadata could not be read. Inspect the retained parent history before resuming.',
            );
          await delay(Math.min(50 * 2 ** attempt, 250));
        }
      }
    };
    const child = await read(threadId);
    if (!child) return null;
    const provenance = source.safeParse(child.source);
    if (
      child.id !== threadId ||
      child.ephemeral ||
      // Native manager contexts use an isolated working directory; the child's
      // directory is verified against its actual native parent below.
      !child.parentThreadId ||
      !provenance.success ||
      provenance.data.subAgent.thread_spawn.parent_thread_id !== child.parentThreadId
    )
      return null;
    const parentId = this.store.contextOwner(child.parentThreadId);
    const parent = parentId
      ? this.store.agent(parentId)
      : await this.resolve(rootId, child.parentThreadId, client, seen);
    if (
      !parent ||
      parent.threadId !== child.parentThreadId ||
      parent.projectId !== root.projectId ||
      (parent.id !== rootId && parent.nativeRootId !== rootId)
    )
      return null;
    const parentThread = await read(child.parentThreadId);
    if (
      !parentThread ||
      parentThread.id !== child.parentThreadId ||
      parentThread.sessionId !== child.sessionId ||
      child.cwd !== parentThread.cwd
    )
      return null;
    const path = provenance.data.subAgent.thread_spawn.agent_path;
    return this.store.transaction(() => {
      // Recheck before installation so concurrent notifications cannot duplicate identity.
      const registered = this.store.contextOwner(threadId);
      if (registered) {
        const existing = this.store.agent(registered);
        return existing.threadId === threadId && existing.nativeRootId === rootId ? existing : null;
      }
      const agent = this.store.addAgent({
        projectId: root.projectId,
        provider: root.provider,
        parentId: parent.id,
        taskId: root.taskId,
        role: parent.role === 'manager' ? 'researcher' : parent.role,
        name: (path?.split('/').at(-1) || child.agentNickname || 'Native child').slice(0, 80),
        cwd: child.cwd,
        scope: 'Native subagent within the parent’s existing task.',
      });
      const saved = this.store.updateAgent(agent.id, {
        nativeRootId: rootId,
        toolPolicy: root.toolPolicy,
        nativePath: path,
        threadId,
        permission: root.permission,
        model: child.model ?? parent.model,
        effort: effortSchema.safeParse(child.reasoningEffort).data ?? parent.effort,
        mcpServers: root.mcpServers,
        pluginsEnabled: root.pluginsEnabled,
        webSearch: root.webSearch,
        imageGeneration: root.imageGeneration,
      });
      this.store.observeContext(threadId, 'codex');
      this.store.event('native.child_registered', root.projectId, agent.id, {
        rootAgentId: rootId,
        parentAgentId: parent.id,
        parentThreadId: child.parentThreadId,
        threadId,
      });
      return saved;
    });
  }
}
