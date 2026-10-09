import { groupContextSchema, type GroupContext } from '@dock/shared';
import { z } from 'zod';
import type { Runtime } from './runtime.js';
import type { ClaudeHostTool } from './claude-session.js';
import { Conflict } from './store.js';
import { GROUP_PRIVATE_EVIDENCE_TOOL } from './group-evidence-private.js';
import { GROUP_EVIDENCE_ORIGINAL_TOOL } from './group-evidence-original.js';

const readers = new WeakMap<Runtime, (context: GroupContext) => ClaudeHostTool[]>();
export const GROUP_HOST_EVIDENCE_TOOL = 'dock_group_evidence_query';
export const GROUP_HOST_ORIGINAL_TOOL = 'dock_group_evidence_original';

/** Bind the visibility-specific reader in ordinary native sessions. The dock_
 * alias is compatible with both providers' existing app-tool transport. */
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
  if (!context.success || context.data.provider === 'owner') return null;
  const tool = readers
    .get(runtime)?.(context.data)
    .find((value) => value.name === name);
  return tool ? { context: context.data, tool } : null;
}
export function groupHostEvidenceDefinition(
  runtime: Runtime,
  agentId: string,
  name = GROUP_HOST_EVIDENCE_TOOL,
) {
  const bound = reader(
    runtime,
    agentId,
    name === GROUP_HOST_ORIGINAL_TOOL
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
  const bound = reader(
      runtime,
      agentId,
      name === GROUP_HOST_ORIGINAL_TOOL
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
  const value = await bound.tool.invoke(raw as Record<string, unknown>, {
    sessionId: bound.context.nativeSessionId,
    requestId: key,
    signal: AbortSignal.timeout(30_000),
  });
  if (value.isError || value.content.length !== 1)
    throw new Conflict('Shared-evidence query could not complete.');
  return JSON.parse(value.content[0]!.text) as unknown;
}
