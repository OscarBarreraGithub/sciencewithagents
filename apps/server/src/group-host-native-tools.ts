import { groupContextSchema, type GroupContext } from '@dock/shared';
import { z } from 'zod';
import type { Runtime } from './runtime.js';
import type { ClaudeHostTool } from './claude-session.js';
import { Conflict } from './store.js';
import { GROUP_PRIVATE_EVIDENCE_TOOL } from './group-evidence-private.js';
import { GROUP_EVIDENCE_ORIGINAL_TOOL } from './group-evidence-original.js';
import {
  GROUP_NATIVE_ORIGINAL_TOOL,
  groupNativeReadingNames,
} from './group-native-reading-names.js';

const readers = new WeakMap<Runtime, (context: GroupContext) => ClaudeHostTool[]>();
export const GROUP_HOST_EVIDENCE_TOOL = 'dock_group_evidence_query';
export const GROUP_HOST_ORIGINAL_TOOL = 'dock_group_evidence_original';

/** Both managed aliases and optional direct Group names use the same
 * visibility-specific reader and admitted context. */
export function registerGroupHostEvidence(
  runtime: Runtime,
  factory: (context: GroupContext) => ClaudeHostTool[],
) {
  if (readers.has(runtime)) throw new Conflict('Group evidence reader already registered.');
  readers.set(runtime, factory);
}
function reader(
  runtime: Runtime,
  agentId: string,
  name: string = GROUP_PRIVATE_EVIDENCE_TOOL.name,
) {
  const marker = runtime.store.getSetting(`group:host-native-agent:${agentId}`) as {
    context?: unknown;
  } | null;
  const context = groupContextSchema.safeParse(marker?.context);
  if (!context.success || context.data.provider !== runtime.store.agent(agentId).provider)
    return null;
  const tool = readers
    .get(runtime)?.(context.data)
    .find((value) => value.name === name);
  return tool ? { context: context.data, marker, tool } : null;
}
export function groupHostEvidenceDefinition(
  runtime: Runtime,
  agentId: string,
  name = GROUP_HOST_EVIDENCE_TOOL,
) {
  if (
    ![GROUP_HOST_EVIDENCE_TOOL, GROUP_HOST_ORIGINAL_TOOL, ...groupNativeReadingNames].includes(name)
  )
    return null;
  const bound = reader(
    runtime,
    agentId,
    name === GROUP_HOST_ORIGINAL_TOOL || name === GROUP_NATIVE_ORIGINAL_TOOL
      ? GROUP_EVIDENCE_ORIGINAL_TOOL.name
      : GROUP_PRIVATE_EVIDENCE_TOOL.name,
  );
  return bound
    ? {
        type: 'function' as const,
        name,
        description: bound.tool.description,
        inputSchema: z.record(z.string(), z.unknown()).parse(bound.tool.inputSchema),
        deferLoading: false,
      }
    : null;
}
export async function invokeGroupHostEvidence(
  runtime: Runtime,
  agentId: string,
  runId: string,
  key: string,
  raw: unknown,
  name = GROUP_HOST_EVIDENCE_TOOL,
) {
  if (!groupHostEvidenceDefinition(runtime, agentId, name))
    throw new Conflict('This group reading capability is unavailable.');
  const bound = reader(
      runtime,
      agentId,
      name === GROUP_HOST_ORIGINAL_TOOL || name === GROUP_NATIVE_ORIGINAL_TOOL
        ? GROUP_EVIDENCE_ORIGINAL_TOOL.name
        : GROUP_PRIVATE_EVIDENCE_TOOL.name,
    ),
    run = runtime.store.run(runId),
    marker = runtime.store.getSetting(`group:host-native-run:${runId}`) as {
      context?: unknown;
    } | null,
    context = groupContextSchema.safeParse(marker?.context);
  if (
    !bound ||
    run.agentId !== agentId ||
    run.status !== 'running' ||
    !context.success ||
    JSON.stringify(context.data) !== JSON.stringify(bound.context)
  )
    throw new Conflict('The original admitted group turn is required.');
  const agent = runtime.store.agent(agentId);
  const value = await bound.tool.invoke(raw as Record<string, unknown>, {
    sessionId: bound.context.nativeSessionId,
    requestId: key,
    signal: AbortSignal.timeout(30_000),
  });
  const current = reader(runtime, agentId, bound.tool.name),
    currentRun = runtime.store.run(runId),
    currentAgent = runtime.store.agent(agentId),
    currentMarkerRaw = runtime.store.getSetting(`group:host-native-run:${runId}`) as {
      context?: unknown;
    } | null,
    currentMarker = groupContextSchema.safeParse(currentMarkerRaw?.context);
  if (
    !current ||
    currentRun.status !== 'running' ||
    currentRun.turnId !== run.turnId ||
    currentAgent.threadId !== agent.threadId ||
    currentAgent.turnId !== agent.turnId ||
    !currentMarker.success ||
    JSON.stringify(currentMarkerRaw) !== JSON.stringify(marker) ||
    JSON.stringify(current.marker) !== JSON.stringify(bound.marker) ||
    JSON.stringify(currentMarker.data) !== JSON.stringify(bound.context) ||
    JSON.stringify(current.context) !== JSON.stringify(bound.context)
  )
    throw new Conflict('The original admitted group turn is no longer current.');
  if (value.isError || value.content.length !== 1)
    throw new Conflict('Shared-evidence query could not complete.');
  return JSON.parse(value.content[0]!.text) as unknown;
}
