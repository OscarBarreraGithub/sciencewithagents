import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  quotaSnapshotSchema,
  tokenUsageSnapshotSchema,
  usageContextSchema,
  usageSummarySchema,
  type QuotaBucket,
  type QuotaSnapshot,
  type QuotaWindow,
  type TokenUsageSnapshot,
} from '@dock/shared';
import { Conflict, Store, now, type PrivateAgent } from './store.js';

const prefix = 'usage:v1:';
export const usageStaleAfterMs = 5 * 60_000;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sourceId = z.string().min(1).max(256);
const counts = z.object({
  totalTokens: count,
  inputTokens: count,
  cachedInputTokens: count,
  cacheWriteInputTokens: count.nullish().transform((value) => value ?? null),
  outputTokens: count,
  reasoningOutputTokens: count,
});
const codexUsage = z.object({
  threadId: sourceId,
  turnId: sourceId.nullish(),
  tokenUsage: z.object({ total: counts, last: counts, modelContextWindow: count.nullish() }),
});
const claudeCounts = z
  .object({
    inputTokens: count.nullable(),
    outputTokens: count.nullable(),
    cacheReadInputTokens: count.nullable(),
    cacheCreationInputTokens: count.nullable(),
  })
  .strict();
const claudeModels = z
  .record(sourceId, claudeCounts)
  .refine((value) => Object.keys(value).length <= 100);
const claudeUsage = z
  .object({
    sessionId: z.string().uuid(),
    deliveryId: z.string().uuid(),
    resultId: sourceId,
    usage: claudeCounts.nullable(),
    modelUsage: claudeModels.optional(),
    helpersPending: z.boolean().optional(),
  })
  .strict();
const claudeStep = claudeUsage
  .omit({ resultId: true, modelUsage: true, helpersPending: true })
  .extend({ messageId: sourceId, usage: claudeCounts });
const window = z.object({
  usedPercent: z.number().finite().nonnegative().max(1_000_000),
  windowDurationMins: count.nullish(),
  resetsAt: count.nullish(),
});
const bucket = z.object({
  limitId: z.string().min(1).max(100).nullish(),
  limitName: z.string().max(200).nullish(),
  normalModelSlug: z.string().max(100).nullish(),
  primary: window.nullish(),
  secondary: window.nullish(),
  spendControlReached: z.boolean().nullish(),
  rateLimitReachedType: z.string().max(100).nullish(),
});
const codexLimits = z.object({
  rateLimits: bucket,
  rateLimitsByLimitId: z
    .record(z.string().min(1).max(100), bucket)
    .nullish()
    .refine((value) => !value || Object.keys(value).length <= 32),
  ordinaryUsageAllowed: z.boolean().nullish(),
});
export type UsageRecordResult = { status: 'recorded' | 'duplicate' | 'ignored'; reason?: string };

function codexAgent(store: Store, agentId: string): PrivateAgent | null {
  try {
    const agent = store.agent(agentId);
    return ((agent as PrivateAgent & { provider?: string }).provider ?? 'codex') === 'codex'
      ? agent
      : null;
  } catch {
    return null;
  }
}
function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function save(
  store: Store,
  key: string,
  receipt: string,
  value: TokenUsageSnapshot | QuotaSnapshot,
  inputHash: string,
  relatedReceipts: string[] = [],
  settings: Array<[string, unknown]> = [],
): UsageRecordResult {
  // A savepoint works both from notification handlers and an existing host transaction.
  store.db.exec('SAVEPOINT usage_observation');
  try {
    const receipts = [receipt, ...relatedReceipts];
    for (const name of receipts) {
      const previous = store.getSetting(name);
      if (previous) {
        store.db.exec('RELEASE usage_observation');
        return previous === inputHash
          ? { status: 'duplicate' }
          : {
              status: 'ignored',
              reason: 'The observation receipt was already used for another report.',
            };
      }
    }
    store.setSetting(key, value);
    for (const [name, setting] of settings) store.setSetting(name, setting);
    for (const name of receipts) store.setSetting(name, inputHash);
    store.event('usage.observed', value.projectId, value.agentId, {
      kind: 'threadId' in value ? 'tokens' : 'quota',
      observation: value,
    });
    store.db.exec('RELEASE usage_observation');
    return { status: 'recorded' };
  } catch (error) {
    store.db.exec('ROLLBACK TO usage_observation; RELEASE usage_observation');
    throw error;
  }
}

/** Accept only the attached Codex identity; malformed/old notifications are inert. */
export function recordCodexUsage(store: Store, agentId: string, raw: unknown): UsageRecordResult {
  const parsed = codexUsage.safeParse(raw);
  const agent = codexAgent(store, agentId);
  if (!parsed.success || !agent || !agent.threadId || parsed.data.threadId !== agent.threadId)
    return { status: 'ignored', reason: 'Malformed usage or an unrelated provider/thread.' };
  const input = parsed.data;
  const turnId = input.turnId ?? null;
  const run = turnId
    ? store.db
        .prepare(
          "SELECT rowid AS ordinal, id FROM runs WHERE agent_id=? AND json_extract(body, '$.turnId')=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(agentId, turnId)
    : undefined;
  if (turnId && ((agent.turnId && agent.turnId !== turnId) || (!run && agent.turnId !== turnId)))
    return { status: 'ignored', reason: 'Usage belongs to an unknown or superseded turn.' };
  const key = `${prefix}tokens:codex:${agent.id}:${fingerprint(agent.threadId)}`;
  const previous = tokenUsageSnapshotSchema.safeParse(store.getSetting(key));
  if (previous.success && previous.data.runId && run) {
    const previousRun = store.db
      .prepare('SELECT rowid AS ordinal FROM runs WHERE id=? AND agent_id=?')
      .get(previous.data.runId, agentId);
    if (previousRun && Number(run.ordinal) < Number(previousRun.ordinal))
      return { status: 'ignored', reason: 'Usage belongs to an older recorded turn.' };
  }
  const values = {
    provider: 'codex' as const,
    projectId: agent.projectId,
    agentId: agent.id,
    threadId: agent.threadId,
    turnId,
    runId: run ? String(run.id) : null,
    modelAtObservation: agent.model,
    modelScope: 'context-only-not-billing' as const,
    total: input.tokenUsage.total,
    last: input.tokenUsage.last,
    modelContextWindow: input.tokenUsage.modelContextWindow ?? null,
  };
  const receipt = `${prefix}receipt:tokens:${fingerprint(values)}`;
  return save(
    store,
    key,
    receipt,
    tokenUsageSnapshotSchema.parse({ ...values, observedAt: now() }),
    fingerprint(values),
  );
}

function claudeBaselineKey(agentId: string, sessionId: string) {
  return `${prefix}claude:baseline:${agentId}:${fingerprint(sessionId)}`;
}

/** A fresh owned session starts at zero. Resumed CLI versions can restore or reset
 * counters, so the first result establishes a baseline, never bills old history. */
export function beginClaudeUsageSession(
  store: Store,
  agentId: string,
  sessionId: string,
  resume: boolean,
) {
  store.setSetting(claudeBaselineKey(agentId, sessionId), resume ? null : {});
}

function claudeDelta(
  current: z.infer<typeof claudeModels>,
  previous: z.infer<typeof claudeModels>,
) {
  if (!Object.keys(current).length || Object.keys(previous).some((model) => !(model in current)))
    return null;
  const result = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  for (const [model, counters] of Object.entries(current)) {
    for (const key of Object.keys(result) as (keyof typeof result)[]) {
      const value = counters[key],
        baseline = previous[model]?.[key] ?? (model in previous ? null : 0);
      if (value === null || baseline === null || value < baseline) return null;
      result[key] += value - baseline;
      if (!Number.isSafeInteger(result[key])) return null;
    }
  }
  return result;
}

/** Main-loop usage is turn-local; modelUsage is cumulative and includes helpers.
 * Difference only known consecutive totals. Missing/reset counters stay partial. */
export function recordClaudeUsage(store: Store, agentId: string, raw: unknown): UsageRecordResult {
  const parsed = claudeUsage.safeParse(raw);
  let agent: PrivateAgent;
  try {
    agent = store.agent(agentId);
  } catch {
    return { status: 'ignored', reason: 'Unknown Claude agent.' };
  }
  if (
    !parsed.success ||
    agent.provider !== 'claude' ||
    !agent.threadId ||
    parsed.data.sessionId !== agent.threadId
  )
    return { status: 'ignored', reason: 'Malformed usage or an unrelated provider/session.' };
  const input = parsed.data;
  const run = store.db
    .prepare(
      "SELECT rowid AS ordinal, id, status FROM runs WHERE id=? AND agent_id=? AND json_extract(body, '$.turnId')=?",
    )
    .get(input.deliveryId, agent.id, input.deliveryId);
  if (!run || run.status === 'queued' || (agent.turnId && agent.turnId !== input.deliveryId))
    return { status: 'ignored', reason: 'Usage belongs to an unknown or superseded submission.' };
  const latest = store.db
    .prepare(
      "SELECT rowid AS ordinal FROM runs WHERE agent_id=? AND json_extract(body, '$.turnId') IS NOT NULL ORDER BY rowid DESC LIMIT 1",
    )
    .get(agent.id);
  if (latest && Number(run.ordinal) < Number(latest.ordinal))
    return { status: 'ignored', reason: 'Usage belongs to an older submitted turn.' };
  const key = `${prefix}tokens:claude:${agent.id}:${fingerprint(agent.threadId)}`;
  const unknown = {
    totalTokens: null,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
  };
  const baselineKey = claudeBaselineKey(agent.id, agent.threadId);
  const baseline = claudeModels.safeParse(store.getSetting(baselineKey));
  const saved = tokenUsageSnapshotSchema.safeParse(store.getSetting(key));
  const progress =
    saved.success &&
    saved.data.runId === input.deliveryId &&
    saved.data.coverage === 'observed-steps'
      ? saved.data.last
      : null;
  const known = (value: number | null | undefined, observed: number | null | undefined) =>
    value == null && observed == null ? null : Math.max(value ?? 0, observed ?? 0);
  const reported = {
    inputTokens: known(input.usage?.inputTokens, progress?.inputTokens),
    outputTokens: input.usage?.outputTokens ?? null,
    cacheReadInputTokens: known(input.usage?.cacheReadInputTokens, progress?.cachedInputTokens),
    cacheCreationInputTokens: known(
      input.usage?.cacheCreationInputTokens,
      progress?.cacheWriteInputTokens,
    ),
  };
  const candidate =
    input.modelUsage && baseline.success && !input.helpersPending
      ? claudeDelta(input.modelUsage, baseline.data)
      : null;
  const delta =
    candidate &&
    Object.entries(reported).every(
      ([key, value]) => value === null || candidate[key as keyof typeof candidate] >= value,
    )
      ? candidate
      : null;
  const counters = delta ?? reported;
  const values = {
    provider: 'claude' as const,
    projectId: agent.projectId,
    agentId: agent.id,
    threadId: agent.threadId,
    turnId: input.deliveryId,
    runId: String(run.id),
    modelAtObservation: agent.model,
    modelScope: 'context-only-not-billing' as const,
    coverage: delta
      ? ('whole-tree' as const)
      : progress
        ? ('observed-steps' as const)
        : ('main-loop' as const),
    ...(delta && input.modelUsage && baseline.success
      ? {
          observedModels: Object.keys(input.modelUsage).filter((model) => {
            const previous = baseline.data[model];
            return Object.entries(input.modelUsage![model]!).some(
              ([key, value]) =>
                value !== null && value > (previous?.[key as keyof typeof previous] ?? 0),
            );
          }),
        }
      : {}),
    total: unknown,
    last: {
      ...unknown,
      inputTokens: counters?.inputTokens ?? null,
      outputTokens: counters?.outputTokens ?? null,
      cachedInputTokens: counters?.cacheReadInputTokens ?? null,
      cacheWriteInputTokens: counters?.cacheCreationInputTokens ?? null,
    },
    modelContextWindow: null,
  };
  // Bind both native result identity and host delivery identity. A delayed result
  // mislabeled with the next delivery cannot become another turn's reported usage.
  const identity = { agentId: agent.id, threadId: agent.threadId };
  return save(
    store,
    key,
    `${prefix}receipt:claude:result:${fingerprint({ ...identity, resultId: input.resultId })}`,
    tokenUsageSnapshotSchema.parse({ ...values, observedAt: now() }),
    fingerprint({ ...input, agentId: agent.id }),
    [
      `${prefix}receipt:claude:delivery:${fingerprint({ ...identity, deliveryId: input.deliveryId })}`,
    ],
    // Missing reports and helpers that outlive the result break the consecutive
    // boundary. Updating this and both receipts atomically makes retries inert.
    [[baselineKey, input.helpersPending ? null : (input.modelUsage ?? null)]],
  );
}

/** Running input/cache evidence from native API message IDs; terminal totals
 * replace this projection. No output placeholder, polling or model turn. */
export function recordClaudeStepUsage(
  store: Store,
  agentId: string,
  raw: unknown,
): UsageRecordResult {
  const parsed = claudeStep.safeParse(raw);
  if (!parsed.success) return { status: 'ignored', reason: 'Malformed Claude step usage.' };
  const input = parsed.data;
  let agent: PrivateAgent;
  try {
    agent = store.agent(agentId);
  } catch {
    return { status: 'ignored' };
  }
  const run = store.db
    .prepare(
      "SELECT id FROM runs WHERE id=? AND agent_id=? AND status='running' AND json_extract(body, '$.turnId')=?",
    )
    .get(input.deliveryId, agentId, input.deliveryId);
  if (
    !run ||
    agent.provider !== 'claude' ||
    agent.threadId !== input.sessionId ||
    agent.turnId !== input.deliveryId
  )
    return { status: 'ignored', reason: 'Step belongs to an inactive or unrelated submission.' };
  const identity = { agentId, threadId: agent.threadId };
  const terminal = `${prefix}receipt:claude:delivery:${fingerprint({ ...identity, deliveryId: input.deliveryId })}`;
  if (store.getSetting(terminal))
    return { status: 'ignored', reason: 'Terminal accounting is already recorded.' };
  const key = `${prefix}tokens:claude:${agentId}:${fingerprint(agent.threadId)}`;
  const previous = tokenUsageSnapshotSchema.safeParse(store.getSetting(key));
  const prior =
    previous.success && previous.data.runId === input.deliveryId ? previous.data.last : null;
  const add = (value: number | null, before: number | null | undefined) => {
    const sum = value === null || before === null ? null : value + (before ?? 0);
    return sum !== null && Number.isSafeInteger(sum) ? sum : null;
  };
  const unknown = {
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningOutputTokens: null,
  };
  return save(
    store,
    key,
    `${prefix}receipt:claude:step:${fingerprint({ ...identity, messageId: input.messageId })}`,
    tokenUsageSnapshotSchema.parse({
      provider: 'claude',
      projectId: agent.projectId,
      agentId,
      threadId: agent.threadId,
      runId: input.deliveryId,
      turnId: input.deliveryId,
      modelAtObservation: agent.model,
      modelScope: 'context-only-not-billing',
      coverage: 'observed-steps',
      total: unknown,
      last: {
        ...unknown,
        inputTokens: add(input.usage.inputTokens, prior?.inputTokens),
        cachedInputTokens: add(input.usage.cacheReadInputTokens, prior?.cachedInputTokens),
        cacheWriteInputTokens: add(
          input.usage.cacheCreationInputTokens,
          prior?.cacheWriteInputTokens,
        ),
      },
      modelContextWindow: null,
      observedAt: now(),
    }),
    fingerprint({ ...input, agentId }),
  );
}

/** No account lookup, credential handling, polling, balance arithmetic or billing inference. */
/** Helper transcript input/cache counters. Native per-message output values are
 * placeholders, so these observations stay partial even after the helper stops. */
export function recordClaudeHelperUsage(
  store: Store,
  agentId: string,
  runId: string,
  sessionId: string,
  nativeId: string,
  message: Record<string, unknown>,
): UsageRecordResult {
  const parsed = z
    .object({
      id: sourceId,
      model: sourceId.optional(),
      usage: z.object({
        input_tokens: count.nullish(),
        cache_read_input_tokens: count.nullish(),
        cache_creation_input_tokens: count.nullish(),
      }),
    })
    .safeParse(message);
  if (!parsed.success) return { status: 'ignored' };
  const agent = store.agent(agentId),
    run = store.run(runId);
  const path = `${sessionId}/${nativeId}`;
  if (
    agent.provider !== 'claude' ||
    !agent.nativeRootId ||
    agent.nativePath !== path ||
    run.agentId !== agentId
  )
    return { status: 'ignored' };
  const receipt = `${prefix}receipt:claude:helper:${fingerprint({ agentId, path, messageId: parsed.data.id })}`;
  const key = `${prefix}tokens:claude:${agentId}:${fingerprint(path)}:${runId}`;
  const previous = tokenUsageSnapshotSchema.safeParse(store.getSetting(key));
  const prior = previous.success ? previous.data.last : null;
  const add = (value: number | null | undefined, before: number | null | undefined) => {
    if (value == null || before === null) return null;
    const sum = value + (before ?? 0);
    return Number.isSafeInteger(sum) ? sum : null;
  };
  const usage = parsed.data.usage;
  const unknown = {
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningOutputTokens: null,
  };
  const model = parsed.data.model && parsed.data.model !== '<synthetic>' ? parsed.data.model : null;
  const observedModels = [
    ...new Set([
      ...(previous.success ? (previous.data.observedModels ?? []) : []),
      ...(model ? [model] : []),
    ]),
  ].slice(0, 100);
  return save(
    store,
    key,
    receipt,
    tokenUsageSnapshotSchema.parse({
      provider: 'claude',
      projectId: agent.projectId,
      agentId,
      threadId: path,
      runId,
      turnId: runId,
      modelAtObservation: model?.slice(0, 100) ?? null,
      modelScope: 'context-only-not-billing',
      coverage: 'observed-steps',
      observedModels,
      total: unknown,
      last: {
        ...unknown,
        totalTokens: prior?.totalTokens ?? null,
        inputTokens: add(usage.input_tokens, prior?.inputTokens),
        cachedInputTokens: add(usage.cache_read_input_tokens, prior?.cachedInputTokens),
        cacheWriteInputTokens: add(usage.cache_creation_input_tokens, prior?.cacheWriteInputTokens),
      },
      modelContextWindow: null,
      observedAt: now(),
    }),
    fingerprint({ agentId, path, messageId: parsed.data.id, usage }),
  );
}

/** A native helper's completed Agent/Task call reports its own run total. Keep it
 * separate from the parent's inclusive total and from partial transcript counters. */
export function recordClaudeHelperTotal(
  store: Store,
  agentId: string,
  runId: string,
  sessionId: string,
  nativeId: string,
  toolId: string,
  totalTokens: number,
): UsageRecordResult {
  if (!count.safeParse(totalTokens).success || !sourceId.safeParse(toolId).success)
    return { status: 'ignored' };
  const agent = store.agent(agentId),
    run = store.run(runId),
    path = `${sessionId}/${nativeId}`;
  if (
    agent.provider !== 'claude' ||
    !agent.nativeRootId ||
    agent.nativePath !== path ||
    run.agentId !== agent.id
  )
    return { status: 'ignored' };
  const key = `${prefix}tokens:claude:${agentId}:${fingerprint(path)}:${runId}`;
  const previous = tokenUsageSnapshotSchema.safeParse(store.getSetting(key));
  const unknown = {
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningOutputTokens: null,
  };
  return save(
    store,
    key,
    `${prefix}receipt:claude:helper-result:${fingerprint({ agentId, path, toolId })}`,
    tokenUsageSnapshotSchema.parse({
      provider: 'claude',
      projectId: agent.projectId,
      agentId,
      threadId: path,
      runId,
      turnId: runId,
      modelAtObservation: previous.success ? previous.data.modelAtObservation : null,
      modelScope: 'context-only-not-billing',
      coverage: 'observed-steps',
      observedModels: previous.success ? previous.data.observedModels : undefined,
      total: unknown,
      last: { ...(previous.success ? previous.data.last : unknown), totalTokens },
      modelContextWindow: null,
      observedAt: now(),
    }),
    fingerprint({ agentId, path, toolId, totalTokens }),
  );
}

export function recordCodexRateLimits(
  store: Store,
  agentId: string,
  raw: unknown,
  source: 'read' | 'update' = 'update',
  observationKey?: string,
): UsageRecordResult {
  const parsed = codexLimits.safeParse(raw);
  const agent = codexAgent(store, agentId);
  if (
    !parsed.success ||
    !agent ||
    !['read', 'update'].includes(source) ||
    (observationKey !== undefined && !sourceId.safeParse(observationKey).success)
  )
    return { status: 'ignored', reason: 'Malformed quota report or unrelated provider.' };
  const input = parsed.data;
  const entries =
    source === 'read' && input.rateLimitsByLimitId && Object.keys(input.rateLimitsByLimitId).length
      ? Object.entries(input.rateLimitsByLimitId)
      : [[input.rateLimits.limitId ?? null, input.rateLimits] as const];
  if (entries.some(([id, value]) => id && value.limitId && id !== value.limitId))
    return { status: 'ignored', reason: 'Quota bucket identities disagree.' };
  const key = `${prefix}quota:codex:${agent.id}`;
  const inputHash = fingerprint({ agentId, source, input });
  const receipt = `${prefix}receipt:quota:${observationKey === undefined ? inputHash : fingerprint({ agentId, source, observationKey })}`;
  const priorReceipt = store.getSetting(receipt);
  if (priorReceipt)
    return priorReceipt === inputHash
      ? { status: 'duplicate' }
      : {
          status: 'ignored',
          reason: 'The observation receipt was already used for another report.',
        };
  const previous = quotaSnapshotSchema.safeParse(store.getSetting(key));
  const prior = previous.success ? previous.data : null;
  const observedAt = now();
  const next = source === 'update' ? [...(prior?.buckets ?? [])] : [];
  for (const [id, value] of entries) {
    const old = prior?.buckets.find((item) => item.id === id);
    const carryWindow = (
      reported: z.infer<typeof window> | null | undefined,
      retained: QuotaWindow | null | undefined,
    ) =>
      reported
        ? {
            usedPercent: reported.usedPercent,
            windowDurationMins: reported.windowDurationMins ?? null,
            resetsAt: reported.resetsAt ?? null,
            observedAt,
          }
        : source === 'update'
          ? (retained ?? null)
          : null;
    const metadata = (reported: string | null | undefined, retained: string | null | undefined) =>
      reported ?? (source === 'update' ? (retained ?? null) : null);
    const normalized: QuotaBucket = {
      id,
      name: metadata(value.limitName, old?.name),
      normalModel: metadata(value.normalModelSlug, old?.normalModel),
      primary: carryWindow(value.primary, old?.primary),
      secondary: carryWindow(value.secondary, old?.secondary),
      // Installed schema explicitly says null is unavailable, not evidence of recovery.
      spendControlReached: value.spendControlReached ?? null,
      rateLimitReachedType: value.rateLimitReachedType ?? null,
      observedAt,
    };
    const index = next.findIndex((item) => item.id === id);
    if (index < 0) next.push(normalized);
    else next[index] = normalized;
  }
  if (next.length > 32)
    return { status: 'ignored', reason: 'Quota report exceeds the bounded bucket catalog.' };
  next.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));
  const value = quotaSnapshotSchema.parse({
    provider: 'codex',
    projectId: agent.projectId,
    agentId,
    scope: 'provider-local-installation',
    accountAffinity: 'unknown',
    source,
    ordinaryUsageAllowed:
      source === 'read'
        ? (input.ordinaryUsageAllowed ?? null)
        : (prior?.ordinaryUsageAllowed ?? null),
    ordinaryUsageObservedAt:
      source === 'read' ? observedAt : (prior?.ordinaryUsageObservedAt ?? null),
    buckets: next,
    observedAt,
  });
  return save(store, key, receipt, value, inputHash);
}

/** Bounded project evidence only; there is deliberately no cross-agent/provider total. */
export function usageSummary(store: Store, projectId: string, agentId?: string) {
  store.project(projectId);
  if (agentId && store.agent(agentId).projectId !== projectId)
    throw new Conflict('Agent is outside this project.');
  const asOf = now();
  const at = Date.parse(asOf);
  const stale = (time: string) =>
    at - Date.parse(time) >= usageStaleAfterMs || Date.parse(time) > at;
  const records = (kind: 'tokens' | 'quota') =>
    store.db
      .prepare(
        "SELECT value FROM settings WHERE key LIKE ? AND json_extract(value, '$.projectId')=? AND (? IS NULL OR json_extract(value, '$.agentId')=?) ORDER BY json_extract(value, '$.observedAt') DESC, key LIMIT 51",
      )
      .all(`${prefix}${kind}:%`, projectId, agentId ?? null, agentId ?? null);
  const recordCount = (kind: 'tokens' | 'quota') =>
    Number(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM settings WHERE key LIKE ? AND json_extract(value, '$.projectId')=? AND (? IS NULL OR json_extract(value, '$.agentId')=?)",
        )
        .get(`${prefix}${kind}:%`, projectId, agentId ?? null, agentId ?? null)!.n,
    );
  const agents = store
    .agents()
    .filter((agent) => agent.projectId === projectId && (!agentId || agent.id === agentId));
  const tokens = records('tokens')
    .slice(0, 50)
    .flatMap((row) => {
      const result = tokenUsageSnapshotSchema.safeParse(JSON.parse(String(row.value)));
      if (!result.success) return [];
      const value = result.data;
      const current = agents.find((agent) => agent.id === value.agentId);
      return [
        {
          ...value,
          currentContext:
            (current?.threadId === value.threadId ||
              (current?.provider === 'claude' && current.nativePath === value.threadId)) &&
            ((current as (PrivateAgent & { provider?: string }) | undefined)?.provider ??
              'codex') === value.provider,
          stale: stale(value.observedAt),
        },
      ];
    });
  const quotas = records('quota')
    .slice(0, 50)
    .flatMap((row) => {
      const result = quotaSnapshotSchema.safeParse(JSON.parse(String(row.value)));
      if (!result.success) return [];
      const value = result.data;
      const windowStale = (window: QuotaWindow | null) =>
        window
          ? stale(window.observedAt) || (window.resetsAt !== null && window.resetsAt * 1000 <= at)
          : null;
      return [
        {
          ...value,
          stale: stale(value.observedAt),
          ordinaryUsageStale: value.ordinaryUsageObservedAt
            ? stale(value.ordinaryUsageObservedAt)
            : null,
          buckets: value.buckets.map((bucket) => ({
            ...bucket,
            primaryStale: windowStale(bucket.primary),
            secondaryStale: windowStale(bucket.secondary),
          })),
        },
      ];
    });
  const providerFor = (agent: PrivateAgent) =>
    (agent as PrivateAgent & { provider?: string }).provider ?? 'codex';
  const hasCurrentTokens = (agent: PrivateAgent) =>
    !!agent.threadId &&
    tokenUsageSnapshotSchema.safeParse(
      store.getSetting(
        `${prefix}tokens:${providerFor(agent)}:${agent.id}:${fingerprint(agent.threadId)}`,
      ),
    ).success;
  return usageSummarySchema.parse({
    projectId,
    agentId: agentId ?? null,
    asOf,
    tokenSnapshots: tokens,
    quotaSnapshots: quotas,
    unknownTokenAgentIds: agents
      .filter((agent) => !hasCurrentTokens(agent))
      .slice(0, 50)
      .map((agent) => agent.id),
    unknownQuotaAgentIds: agents
      .filter(
        (agent) =>
          !quotaSnapshotSchema.safeParse(
            store.getSetting(`${prefix}quota:${providerFor(agent)}:${agent.id}`),
          ).success,
      )
      .slice(0, 50)
      .map((agent) => agent.id),
    omitted: {
      tokenSnapshots: Math.max(0, recordCount('tokens') - 50),
      quotaSnapshots: Math.max(0, recordCount('quota') - 50),
      agents: Math.max(0, agents.length - 50),
    },
    notice:
      'Provider-reported snapshots only. Thread totals, when reported, are cumulative, never additive events. Claude result snapshots contain last-turn counters only; cumulative totals stay unknown. Parent and native-child counters may overlap and are not summed. Model labels describe context, not historical per-model billing. Quota observations belong to the provider on this computer; account affinity is unknown, so separate agents do not imply separate capacity. Missing values are unknown, not zero. Old observations or elapsed reset times are not permission to assume quota recovery. No cost or context-cache preservation is inferred.',
  });
}

/** Current agent only, with at most four recent quota buckets and no invented sum. */
export function usageContext(store: Store, projectId: string, agentId: string) {
  const summary = usageSummary(store, projectId, agentId);
  const provider =
    (store.agent(agentId) as PrivateAgent & { provider?: string }).provider ?? 'codex';
  const token = summary.tokenSnapshots.find((value) => value.currentContext);
  const quota = summary.quotaSnapshots.find((value) => value.provider === provider);
  const recent = quota
    ? [...quota.buckets].sort(
        (a, b) =>
          b.observedAt.localeCompare(a.observedAt) || (a.id ?? '').localeCompare(b.id ?? ''),
      )
    : [];
  return usageContextSchema.parse({
    agentId,
    provider,
    asOf: summary.asOf,
    tokens: token
      ? {
          threadId: token.threadId,
          modelAtObservation: token.modelAtObservation,
          modelScope: token.modelScope,
          coverage: token.coverage,
          observedModels: token.observedModels,
          total: token.total,
          last: token.last,
          modelContextWindow: token.modelContextWindow,
          observedAt: token.observedAt,
          stale: token.stale,
        }
      : null,
    quota: quota
      ? {
          scope: quota.scope,
          accountAffinity: quota.accountAffinity,
          observedAt: quota.observedAt,
          stale: quota.stale,
          ordinaryUsageAllowed: quota.ordinaryUsageAllowed,
          ordinaryUsageStale: quota.ordinaryUsageStale,
          buckets: recent.slice(0, 4).map((bucket) => ({
            id: bucket.id,
            normalModel: bucket.normalModel,
            primary: bucket.primary ? { ...bucket.primary, stale: bucket.primaryStale } : null,
            secondary: bucket.secondary
              ? { ...bucket.secondary, stale: bucket.secondaryStale }
              : null,
            spendControlReached: bucket.spendControlReached,
            observedAt: bucket.observedAt,
          })),
          omittedBuckets: Math.max(0, recent.length - 4),
        }
      : null,
    notice: summary.notice,
  });
}
