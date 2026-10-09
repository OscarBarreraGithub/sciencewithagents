import { groupContextSchema, type GroupContext } from '@dock/shared';
import { z } from 'zod';
import type { ClaudeHostTool } from './claude-session.js';
import type { Runtime } from './runtime.js';
import { Conflict } from './store.js';
import { groupHostTurnSchema } from './group-host-work-continuation.js';
import { publicationCanonical } from './group-publication-protocol.js';

const factories = new WeakMap<Runtime, (context: GroupContext) => ClaudeHostTool[]>();
/** Scoped app coordination only. Native provider tools, hooks and permissions stay native. */
export function registerGroupHostCoordination(
  runtime: Runtime,
  factory: (context: GroupContext) => ClaudeHostTool[],
) {
  if (factories.has(runtime)) throw new Conflict('Group coordination already registered.');
  factories.set(runtime, factory);
  return () => factories.delete(runtime);
}
function boundTools(runtime: Runtime, agentId: string) {
  const marker = runtime.store.getSetting(`group:host-native-agent:${agentId}`) as {
    context?: unknown;
  } | null;
  const context = groupContextSchema.safeParse(marker?.context);
  if (!context.success || context.data.visibility !== 'shared') return [];
  const manager = runtime.store.agent(agentId).role === 'manager';
  return (factories.get(runtime)?.(context.data) ?? [])
    .filter((tool) => manager || tool.name === 'dock_inspect')
    .map((tool) => ({
      ...tool,
      name: tool.name === 'dock_inspect' ? 'dock_group_actions' : tool.name,
    }));
}
export function groupHostCoordinationDefinitions(runtime: Runtime, agentId: string) {
  return boundTools(runtime, agentId).map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    inputSchema: z.record(z.string(), z.unknown()).parse(tool.inputSchema),
    deferLoading: false,
  }));
}
export async function invokeGroupHostCoordination(
  runtime: Runtime,
  agentId: string,
  runId: string,
  key: string,
  name: string,
  raw: unknown,
) {
  const tool = boundTools(runtime, agentId).find((item) => item.name === name),
    run = runtime.store.run(runId),
    turn = groupHostTurnSchema.parse(runtime.store.getSetting(`group:host-native-run:${runId}`)),
    marker = runtime.store.getSetting(`group:host-native-agent:${agentId}`) as {
      context: GroupContext;
    };
  if (
    !tool ||
    run.agentId !== agentId ||
    run.status !== 'running' ||
    publicationCanonical(turn.context) !== publicationCanonical(marker.context) ||
    (name !== 'dock_group_actions' && turn.intent !== 'work')
  )
    throw new Conflict('An original admitted shared Work turn is required for coordination.');
  await runtime.groupHostNativeAdmission?.(agentId, runId);
  const result = await tool.invoke(raw as Record<string, unknown>, {
    sessionId: turn.context.nativeSessionId,
    requestId: key,
    signal: AbortSignal.timeout(30_000),
  });
  if (result.isError || result.content.length !== 1)
    throw new Conflict('Group coordination did not complete.');
  return JSON.parse(result.content[0]!.text) as unknown;
}
