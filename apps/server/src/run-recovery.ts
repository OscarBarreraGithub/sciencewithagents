import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  runRecoveryReceiptSchema,
  runRecoveryRequestSchema,
  runRecoveryViewSchema,
  type RunRecoveryRequest,
} from '@dock/shared';
import { ClaudePreflightError } from './claude-session.js';
import { Conflict, now, type PrivateRun, type Store } from './store.js';

const attemptSchema = z.object({
  id: z.uuid(),
  configuration: z.string(),
  handoffAt: z.string().nullable(),
  forkAt: z.string().nullable(),
  failure: z
    .object({ id: z.uuid(), retry: z.boolean(), boundary: z.string(), code: z.string() })
    .optional(),
});
const attemptKey = (runId: string) => `run:delivery:${runId}`;
const receiptKey = (agentId: string, key: string) => `run:recovery:${agentId}:${key}`;
const retryBoundarySchema = z.object({
  configuration: z.string(),
  threadId: z.string().nullable(),
  account: z.string().nullable(),
});
function configuration(store: Store, agentId: string) {
  const a = store.agent(agentId);
  return JSON.stringify([
    a.provider,
    a.model,
    a.effort,
    a.permission,
    a.toolPolicy,
    a.mcpServers,
    a.pluginsEnabled,
    a.webSearch,
    a.imageGeneration,
    a.nativeChrome,
  ]);
}
function boundary(store: Store, agentId: string) {
  const a = store.agent(agentId);
  return createHash('sha256')
    .update(
      JSON.stringify([
        configuration(store, agentId),
        a.threadId,
        store.getSetting(`claude:account:${agentId}`),
      ]),
    )
    .digest('hex');
}
function attempt(store: Store, runId: string) {
  const value = attemptSchema.safeParse(store.getSetting(attemptKey(runId)));
  return value.success ? value.data : null;
}
/** No transport intent is inferred from a missing provider turn ID. */
export function prepareRunDelivery(store: Store, run: PrivateRun) {
  store.setSetting(attemptKey(run.id), {
    id: randomUUID(),
    configuration: configuration(store, run.agentId),
    handoffAt: null,
    forkAt: null,
  });
}
/** Persist before native I/O. An uncertain input handoff cannot be replayed. */
export function markRunHandoff(store: Store, run: PrivateRun, phase: 'input' | 'fork' = 'input') {
  const retry = retryBoundarySchema.safeParse(store.getSetting(`run:retry-boundary:${run.id}`));
  const agent = store.agent(run.agentId);
  if (
    retry.success &&
    (retry.data.configuration !== configuration(store, run.agentId) ||
      (retry.data.threadId !== null && retry.data.threadId !== agent.threadId) ||
      (retry.data.account !== null &&
        retry.data.account !== store.getSetting(`claude:account:${run.agentId}`)))
  )
    throw new Conflict(
      'The saved retry’s model, account or context changed before delivery. No input was sent; inspect the conversation before continuing.',
    );
  let saved = attempt(store, run.id);
  if (run.status !== 'running')
    throw new Conflict('This turn no longer has an admitted provider handoff.');
  if (!saved) {
    // Other typed native launch lanes already own admission; retain their write
    // intent too, without inventing a pre-send proof for a prior failure.
    prepareRunDelivery(store, run);
    saved = attempt(store, run.id)!;
  }
  const field = phase === 'input' ? 'handoffAt' : 'forkAt';
  if (saved[field])
    throw new Conflict('This turn already reached its native handoff. Inspect its saved result.');
  store.setSetting(attemptKey(run.id), { ...saved, [field]: now() });
  store.event('run.provider_handoff', store.agent(run.agentId).projectId, run.agentId, {
    runId: run.id,
    attemptId: saved.id,
    phase,
  });
}
export function recordRunFailure(store: Store, run: PrivateRun, error: unknown) {
  const saved = attempt(store, run.id);
  if (!saved) return;
  const retry =
    store.agent(run.agentId).provider === 'claude' &&
    error instanceof ClaudePreflightError &&
    !saved.handoffAt &&
    !saved.forkAt &&
    run.kind === 'user' &&
    saved.configuration === configuration(store, run.agentId) &&
    !store.getSetting(`native:command:${run.id}`);
  const failure = {
    id: randomUUID(),
    retry,
    boundary: boundary(store, run.agentId),
    code: error instanceof ClaudePreflightError ? error.code : 'uncertain',
  };
  store.setSetting(attemptKey(run.id), { ...saved, failure });
  store.event('run.recovery_available', store.agent(run.agentId).projectId, run.agentId, {
    runId: run.id,
    failureId: failure.id,
    action: retry ? 'retry' : 'continue',
    code: failure.code,
  });
}
export function runRecoveryView(store: Store, agentId: string) {
  const a = store.agent(agentId);
  if (a.archivedAt || a.nativeRootId || !['failed', 'interrupted'].includes(a.status) || a.turnId)
    return null;
  const latest = store.runsForAgent(agentId, 1).at(-1);
  let run = latest;
  if (latest?.status === 'queued' && ['report', 'message'].includes(latest.kind)) {
    // Late automatic updates retain a stopped conversation's Continue action.
    // A later owner/resume request already has explicit authority and suppresses it.
    const failed = store.db
      .prepare(
        "SELECT body FROM runs WHERE agent_id=? AND status IN ('failed','interrupted') ORDER BY rowid DESC LIMIT 1",
      )
      .get(agentId);
    run = failed ? (JSON.parse(String(failed.body)) as PrivateRun) : undefined;
    if (
      run &&
      store.db
        .prepare(
          `SELECT 1 FROM runs WHERE agent_id=? AND rowid>(SELECT rowid FROM runs WHERE id=?)
       AND (status='running' OR json_extract(body,'$.kind') IN ('user','resume')) LIMIT 1`,
        )
        .get(agentId, run.id)
    )
      return null;
  }
  if (!run || !['failed', 'interrupted'].includes(run.status)) return null;
  const saved = attempt(store, run.id);
  const retry =
    run.status === 'failed' &&
    latest?.id === run.id &&
    saved?.failure?.retry &&
    !saved.handoffAt &&
    !saved.forkAt &&
    saved.failure.boundary === boundary(store, agentId);
  return runRecoveryViewSchema.parse({
    runId: run.id,
    failureId: saved?.failure?.id ?? run.id,
    action: retry ? 'retry' : 'continue',
    explanation: retry
      ? 'This message was saved but never sent to the model. Retry sends the original message once.'
      : 'Saved work may already include changes. Continue inspects progress and unfinished requests before taking the next step.',
  });
}
export function runRecoveryReceipt(store: Store, agentId: string, key: string) {
  store.agent(agentId);
  const row = store.db
    .prepare('SELECT result FROM operations WHERE key=?')
    .get(receiptKey(agentId, key));
  return row ? runRecoveryReceiptSchema.parse(JSON.parse(String(row.result))) : null;
}
/** Synchronous durable admission; callers must then kick the normal supervised queue. */
export function recoverRun(
  store: Store,
  agentId: string,
  raw: RunRecoveryRequest,
  onRetryQueued?: (run: PrivateRun) => void,
) {
  const input = runRecoveryRequestSchema.parse(raw);
  const intent = { agentId, runId: input.runId, failureId: input.failureId, action: input.action };
  return store.operation(receiptKey(agentId, input.key), intent, () => {
    const canonical = `run:recovery:failure:${input.failureId}`;
    const previous = store.db
      .prepare('SELECT input,result FROM operations WHERE key=?')
      .get(canonical);
    if (previous) {
      if (previous.input !== JSON.stringify(intent))
        throw new Conflict('This recovery was already requested with a different action.');
      return runRecoveryReceiptSchema.parse(JSON.parse(String(previous.result)));
    }
    const view = runRecoveryView(store, agentId);
    if (!view || view.runId !== input.runId || view.failureId !== input.failureId)
      throw new Conflict('This conversation changed. Refresh it before recovering the turn.');
    if (view.action !== input.action)
      throw new Conflict(
        'This message cannot be safely resent. Refresh and choose Continue to inspect saved progress.',
      );
    const source = store.run(input.runId);
    store.updateAgent(agentId, { status: 'idle', autoTurns: 0 });
    let next: PrivateRun;
    if (input.action === 'retry') {
      // A fresh run owns its own native handoff and allowance ledger. Keep the
      // original owner input once; this entry is only the explicit retry receipt.
      const queued = store.enqueue(agentId, `recovery:${input.failureId}`, source.text);
      next = store.run(queued.id);
      const agent = store.agent(agentId);
      store.setSetting(`run:retry-boundary:${next.id}`, {
        configuration: configuration(store, agentId),
        threadId: agent.threadId,
        account: store.getSetting(`claude:account:${agentId}`),
      });
      store.entry({
        id: next.id,
        agentId,
        runId: next.id,
        kind: 'system',
        title: 'Retry message',
        text: 'Retrying the saved message that did not reach the model.',
        status: 'queued',
        createdAt: next.createdAt,
      });
      onRetryQueued?.(next);
    } else {
      const queued = store.enqueue(
        agentId,
        `recovery:${input.failureId}`,
        `Continue the unfinished objective from saved state. Inspect actual task/worktree progress and unfinished owner requests, including saved run ${source.id}, before acting. Reconcile what already completed. Do not blindly repeat the earlier prompt or uncertain side effects; report any blocker.`,
        'resume',
      );
      next = store.run(queued.id);
    }
    const receipt = runRecoveryReceiptSchema.parse({
      sourceRunId: source.id,
      failureId: input.failureId,
      runId: next.id,
      action: input.action,
    });
    store.event('run.recovery_requested', store.agent(agentId).projectId, agentId, receipt);
    store.db
      .prepare('INSERT INTO operations VALUES(?,?,?)')
      .run(canonical, JSON.stringify(intent), JSON.stringify(receipt));
    return receipt;
  });
}
