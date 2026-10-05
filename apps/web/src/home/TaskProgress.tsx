import { useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { Modal } from '../Modal';
import { ArrowUpRight } from 'lucide-react';
import { quarkStatusSchema, type Task } from '@dock/shared';
import { useReading, type HomeData } from './useHomeData';

/** A view of the existing ledgers; opening a task starts no model work. */
export function TaskProgress({ task, data }: { task: Task; data: HomeData }) {
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ key: string; reason: string } | null>(null);
  const closed = ['done', 'integrated', 'split', 'cancelled'].includes(task.status);
  async function closeTask() {
    const request = pending.current ?? { key: crypto.randomUUID(), reason: reason.trim() };
    pending.current = request;
    setBusy(true);
    try {
      await api(`/tasks/${task.id}/cancel`, request);
      pending.current = null;
      setClosing(false);
      window.dispatchEvent(new Event('swa:refresh-home'));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) pending.current = null;
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not confirm closure. Retry the same request.',
      );
    } finally {
      setBusy(false);
    }
  }
  const accounting = useReading('/quark', quarkStatusSchema.parse);
  const state = data.snapshot.data!;
  const work = data.work;
  const family = new Set([task.id]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const item of state.tasks)
      if (item.parentId && family.has(item.parentId) && !family.has(item.id)) {
        family.add(item.id);
        changed = true;
      }
  }
  const ancestors = new Set([task.id]);
  let parent = task.parentId;
  while (parent && !ancestors.has(parent)) {
    ancestors.add(parent);
    parent = state.tasks.find((item) => item.id === parent)?.parentId ?? null;
  }
  const agents = new Set(
    state.agents
      .filter((agent) => agent.taskId && family.has(agent.taskId))
      .map((agent) => agent.id),
  );
  const jobs = work.data?.jobs.filter((job) => job.taskId && family.has(job.taskId)) ?? [];
  const finished = work.data?.history.filter((job) => job.taskId && family.has(job.taskId)) ?? [];
  const holds =
    accounting.data?.holds.filter(
      (hold) => !closed && !hold.releasedAt && agents.has(hold.agentId),
    ) ?? [];
  const budgets =
    accounting.data?.budgets.filter(
      (budget) =>
        budget.projectId === task.projectId && (!budget.taskId || ancestors.has(budget.taskId)),
    ) ?? [];
  const runs =
    accounting.data?.runs
      .filter((run) => run.taskId && family.has(run.taskId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 6) ?? [];
  const decisions = state.decisions
    .filter((decision) => decision.taskId && family.has(decision.taskId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3);
  const usageLink = `#/work/${task.id}`;
  return (
    <section className="flow-panel task-progress" aria-label="Task progress and spending">
      {task.closure && (
        <p role="status">
          <strong>Closed:</strong> {task.closure.reason} Files, conversations and spending records
          are retained.
        </p>
      )}
      {!closed && (
        <button className="flow-button" onClick={() => setClosing(true)}>
          Close task…
        </button>
      )}
      {closing && (
        <Modal title="Close this task" close={() => !busy && setClosing(false)}>
          <p>
            Use this when no more work is needed on this assignment. Queued replies are cancelled.
            Files, conversations, reviews and allowance records stay saved. This does not mark
            changes reviewed or applied.
          </p>
          <label>
            Reason
            <textarea
              aria-label="Reason for closing task"
              rows={4}
              value={reason}
              disabled={busy || !!pending.current}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button
            className="flow-button"
            disabled={busy || !reason.trim()}
            onClick={() => void closeTask()}
          >
            {busy
              ? 'Closing…'
              : pending.current
                ? 'Retry closure'
                : 'Close task and retain history'}
          </button>
        </Modal>
      )}
      <div className="flow-section-title">
        <h2>Work and spending</h2>
        <a className="flow-button" href={usageLink}>
          Manage budgets <ArrowUpRight size={16} />
        </a>
      </div>
      <p className="flow-note">
        This task and its subtasks. Opening this view does not start work.
      </p>
      {(work.error || accounting.error) && (
        <div className="task-progress-warning" role="alert">
          Some readings are unavailable. Last saved readings may be out of date.
          <button
            className="flow-button"
            onClick={() => {
              work.retry();
              accounting.retry();
            }}
          >
            Retry readings
          </button>
        </div>
      )}
      <div className="task-progress-grid">
        <div>
          <h3>What is happening</h3>
          {holds.map((hold) => (
            <article className="task-progress-item held" key={hold.runId}>
              <strong>
                Paused · {state.agents.find((agent) => agent.id === hold.agentId)?.name ?? 'Worker'}
              </strong>
              <p>{hold.reason}</p>
              <p>
                {hold.error
                  ? `Stopping needs attention: ${hold.error}`
                  : hold.stopAcknowledgedAt
                    ? 'Work has stopped. Saved progress is retained.'
                    : 'Stop requested; confirmation is pending.'}
              </p>
              <a className="flow-button" href={usageLink}>
                Review pause <ArrowUpRight size={16} />
              </a>
            </article>
          ))}
          {jobs.map((job) => (
            <article className="task-progress-item" key={job.runId}>
              <strong>{job.agentName}</strong>
              <small>
                {job.provider === 'codex' ? 'Codex' : 'Claude'} · {job.estimate.priority} priority
              </small>
              <p>{job.reason}</p>
              {job.expectedFinishAt && (
                <p>
                  Estimated finish: {new Date(job.expectedFinishAt).toLocaleString()}
                  {Date.parse(job.expectedFinishAt) < Date.now()
                    ? ' · taking longer than estimated'
                    : ''}
                </p>
              )}
              <a className="flow-button" href={`#/job/${job.runId}`}>
                Job details and controls <ArrowUpRight size={16} />
              </a>
            </article>
          ))}
          {!jobs.length && !holds.length && (
            <p>
              {!work.loaded || !accounting.loaded
                ? 'Reading current work…'
                : work.error || accounting.error
                  ? 'Current work could not be confirmed.'
                  : 'No current jobs or pauses are reported for this task.'}
            </p>
          )}
          {finished.length > 0 && (
            <details className="task-progress-item">
              <summary>Finished turns in QUARK’s recent history ({finished.length})</summary>
              {finished.map((job) => (
                <p key={job.runId}>
                  <a className="flow-button" href={`#/job/${job.runId}`}>
                    {job.agentName} · {job.status} <ArrowUpRight size={16} />
                  </a>
                </p>
              ))}
            </details>
          )}
          <h3>Planning estimate</h3>
          <p>
            {task.scheduling.expectedTokens.toLocaleString()} tokens and about{' '}
            {Math.ceil(task.scheduling.expectedSeconds / 60)} minutes per turn ·{' '}
            {task.scheduling.priority} priority.
          </p>
          <p>
            {task.scheduling.estimatedCostUsd === null
              ? 'No monetary estimate supplied.'
              : `Estimated cost $${task.scheduling.estimatedCostUsd.toFixed(2)}.`}
          </p>
        </div>
        <div>
          <h3>Allowance limits that apply</h3>
          {budgets.map((budget) => (
            <article className="task-progress-item" key={budget.id}>
              <strong>
                {budget.provider === 'codex' ? 'Codex' : 'Claude'} ·{' '}
                {accounting.data?.windows.find(
                  (window) =>
                    window.provider === budget.provider && window.windowId === budget.windowId,
                )?.label ?? budget.windowId}
                {budget.period === 'hour' ? ' · rolling hour' : ''}
              </strong>
              <small>
                {!budget.taskId
                  ? 'Shared project cap, including manager overhead'
                  : budget.taskId === task.id
                    ? 'This task and its subtasks'
                    : 'Shared parent-task cap'}
              </small>
              <p>
                <b>{budget.remainingPercent.toFixed(1)} percentage points left</b> of{' '}
                {budget.limitPercent.toFixed(1)} allowed.
              </p>
              {!budget.enabled && <p>This hourly limit is off.</p>}
              <p>
                ≈ {budget.spentPercent.toFixed(1)} spent
                {budget.period === 'hour' ? ' in the last hour' : ''} ·{' '}
                {budget.reservedPercent.toFixed(1)} reserved.
              </p>
              {budget.reason && <p>{budget.reason}</p>}
            </article>
          ))}
          {!budgets.length && (
            <p>
              {!accounting.loaded
                ? 'Reading allowance limits…'
                : accounting.error
                  ? 'Allowance limits could not be confirmed.'
                  : 'No saved task, parent-task or project allowance cap. QUARK’s shared pacing and reserve still apply.'}
            </p>
          )}
          <p className="flow-note">
            Allowance shares are estimates. Reservations and work in flight can affect the remaining
            room.
          </p>
        </div>
      </div>
      <h3>Recent recorded activity</h3>
      {!runs.length && (
        <p>
          {!accounting.loaded
            ? 'Reading activity…'
            : 'No runs in the recent accounting view. Earlier evidence stays in the team’s conversations.'}
        </p>
      )}
      <div className="task-progress-runs">
        {runs.map((run) => (
          <a className="task-progress-item" key={run.runId} href={`#/chat/${run.agentId}`}>
            <strong>
              {run.agentName} <ArrowUpRight size={15} />
            </strong>
            <small>
              {run.status} ·{' '}
              {new Date(run.observedAt ?? run.finishedAt ?? run.startedAt).toLocaleString()}
            </small>
            <p>
              {run.tokens.totalTokens === null
                ? 'Token total not reported'
                : `${run.tokens.totalTokens.toLocaleString()} observed tokens`}
              {run.basis !== 'measured'
                ? ` · ${run.basis === 'partial' ? 'partial reading' : 'measurement unavailable'}`
                : ''}
            </p>
            {run.tokens.totalTokens === null && run.tokens.inputTokens !== null && (
              <small>
                {run.tokens.inputTokens.toLocaleString()} input ·{' '}
                {run.tokens.cachedInputTokens?.toLocaleString() ?? 'Unknown'} cache read ·{' '}
                {run.tokens.cacheWriteInputTokens?.toLocaleString() ?? 'Unknown'} cache write
              </small>
            )}
          </a>
        ))}
      </div>
      {!!runs.length && (
        <p className="flow-note">
          Readings are per run and may include native helpers. They are not added together here.
        </p>
      )}
      {decisions.length > 0 && (
        <>
          <h3>Recorded decisions</h3>
          {decisions.map((decision) => (
            <details className="task-progress-item" key={decision.id}>
              <summary>
                {decision.kind} · {new Date(decision.createdAt).toLocaleString()}
              </summary>
              <p>{decision.rationale}</p>
              <p>{decision.evidence}</p>
              <a href={`#/chat/${decision.agentId}`} className="flow-button">
                Open the conversation <ArrowUpRight size={16} />
              </a>
            </details>
          ))}
        </>
      )}
    </section>
  );
}
