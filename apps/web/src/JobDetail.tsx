import { useEffect, useRef, useState } from 'react';
import {
  jobDetailSchema,
  type JobDetail as SavedJob,
  type JobDetailText,
  type JobEstimate,
} from '@dock/shared';
import { api, ApiError } from './api';
import { ChatMarkdown } from './ChatMarkdown';
import { JobEstimateFields } from './JobEstimateFields';
import './JobDetail.css';

type Change = {
  action: 'hold' | 'release' | 'cancel' | 'override' | 'configure';
  estimate?: JobEstimate;
};
const route = (page: string, id: string) => `#/${page}/${encodeURIComponent(id)}`;
const readError = 'Could not read this saved job. Reconnect and try again.';
const date = (value: string) => new Date(value).toLocaleString();

function SavedText({
  value,
  entry,
  location = 'conversation',
}: {
  value: JobDetailText;
  entry?: { id: string; agentId: string };
  location?: 'task' | 'conversation';
}) {
  return (
    <>
      <ChatMarkdown entry={entry}>{value.text}</ChatMarkdown>
      {value.truncated && (
        <p className="muted">This preview is shortened. Open the {location} for the full text.</p>
      )}
    </>
  );
}

export function JobDetail({ jobId, open }: { jobId: string; open: (agentId: string) => void }) {
  return <SavedJobDetail key={jobId} jobId={jobId} open={open} />;
}
function SavedJobDetail({ jobId, open }: { jobId: string; open: (agentId: string) => void }) {
  const [state, setState] = useState<SavedJob | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(false);
  const [estimate, setEstimate] = useState<JobEstimate | null>(null);
  const pending = useRef<(Change & { key: string; runId: string }) | null>(null);
  const mounted = useRef(true);
  const readGeneration = useRef(0);
  const refresh = async (signal?: AbortSignal) => {
    const generation = ++readGeneration.current;
    try {
      const value = jobDetailSchema.parse(
        await api(`/pulsar/jobs/${encodeURIComponent(jobId)}`, undefined, signal),
      );
      if (mounted.current && !signal?.aborted && generation === readGeneration.current) {
        setState(value);
        setError((previous) => (previous === readError ? '' : previous));
      }
    } catch (cause) {
      if (mounted.current && !signal?.aborted && generation === readGeneration.current)
        setError(
          cause instanceof ApiError && cause.status === 404
            ? 'This saved job could not be found on the selected computer.'
            : readError,
        );
    }
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(controller.signal), 4000);
    return () => {
      mounted.current = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [jobId]);
  const change = async (input?: Change) => {
    if (busy) return;
    const body =
      pending.current ?? (input ? { ...input, runId: jobId, key: crypto.randomUUID() } : null);
    if (!body) return;
    pending.current = body;
    setBusy(true);
    setError('');
    try {
      await api('/pulsar/jobs', body);
      pending.current = null;
      if (!mounted.current) return;
      setRetry(false);
      setEstimate(null);
      window.dispatchEvent(new Event('swa:refresh-home'));
      await refresh();
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && [400, 404, 409].includes(cause.status))
        pending.current = null;
      setRetry(pending.current !== null);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not confirm this change. Retry the same request.',
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  if (!state)
    return (
      <section className="job-detail" aria-label="Saved job">
        <p role={error ? 'alert' : 'status'}>{error || 'Reading saved job…'}</p>
        {error && (
          <button className="secondary" onClick={() => void refresh()}>
            Try again
          </button>
        )}
      </section>
    );
  const job = state.job;
  const active = ['queued', 'running'].includes(job.status);
  const heldForEdit = state.queueHold !== null;
  const disabled = busy || retry;
  const status = state.approval
    ? 'Waiting for your answer'
    : heldForEdit
      ? state.queueHold === 'steering'
        ? 'Waiting to steer'
        : 'Held for editing'
      : job.status === 'queued'
        ? job.held
          ? 'Paused'
          : job.eligible
            ? 'Ready to start'
            : 'Waiting'
        : job.status[0].toUpperCase() + job.status.slice(1);
  return (
    <section className="job-detail" aria-label="Saved job">
      {error && (
        <div role="alert" className="form-error">
          <p>{error}</p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void (retry ? change() : refresh())}
          >
            {retry ? 'Retry same change' : 'Try again'}
          </button>
        </div>
      )}
      <header className="job-detail-heading">
        <small>
          {job.projectName} · {job.provider === 'codex' ? 'Codex' : 'Claude'}
        </small>
        <h2>
          {state.task?.title ||
            state.request.text.split('\n')[0].slice(0, 160) ||
            'Saved conversation turn'}
        </h2>
        <strong className="job-detail-status">{status}</strong>
        <p>{job.reason}</p>
        {state.approval && <p>{state.approval.title}</p>}
        <div className="job-detail-actions">
          <button className="secondary" onClick={() => open(job.agentId)}>
            {state.approval
              ? 'Answer in conversation'
              : heldForEdit
                ? 'Open queued message'
                : 'Open conversation'}
          </button>
          <a className="flow-button" href={route('project', state.projectId)}>
            Open project
          </a>
          {state.task && (
            <a className="flow-button" href={route('task', state.task.id)}>
              Open task
            </a>
          )}
          <a className="flow-button" href={route('work', state.projectId)}>
            Project hourly rate and caps
          </a>
        </div>
      </header>
      <dl className="job-detail-facts">
        <div>
          <dt>Worker</dt>
          <dd>
            {job.agentName} · {state.worker.role}
          </dd>
        </div>
        <div>
          <dt>
            {state.worker.modelBasis === 'admission'
              ? 'Model at admission'
              : 'Current model setting'}
          </dt>
          <dd>{state.worker.model ?? 'Native default (model not recorded)'}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{date(state.createdAt)}</dd>
        </div>
        {state.startedAt && (
          <div>
            <dt>Admitted / started</dt>
            <dd>{date(state.startedAt)}</dd>
          </div>
        )}
        {state.finishedAt && (
          <div>
            <dt>Finished</dt>
            <dd>{date(state.finishedAt)}</dd>
          </div>
        )}
        {state.task && (
          <div>
            <dt>Task status</dt>
            <dd>{state.task.status.replaceAll('_', ' ')}</dd>
          </div>
        )}
      </dl>
      <div className="job-detail-section">
        <h3>Request for this turn</h3>
        <SavedText value={state.request} />
      </div>
      {state.task && (
        <details className="job-detail-section">
          <summary>Task goal and acceptance</summary>
          <h3>Goal</h3>
          <SavedText value={state.task.goal} location="task" />
          <h3>Acceptance</h3>
          <SavedText value={state.task.acceptance} location="task" />
        </details>
      )}
      <div className="job-detail-section">
        <h3>{active ? 'Saved progress for this turn' : 'Saved outcome for this turn'}</h3>
        {state.outcome.map((entry) => (
          <article className="job-detail-outcome" key={entry.id}>
            {entry.title && <h4>{entry.title}</h4>}
            <SavedText value={entry.text} entry={{ id: entry.id, agentId: job.agentId }} />
          </article>
        ))}
        {!state.outcome.length && (
          <p className="muted">
            No response is saved against this turn. Open the conversation for its full history and
            any interruption details.
          </p>
        )}
        {state.moreOutcome && (
          <p className="muted">Earlier progress is retained in the conversation.</p>
        )}
        {state.task?.closure && (
          <>
            <h4>Task closure</h4>
            <SavedText value={state.task.closure.reason} location="task" />
          </>
        )}
        {state.task?.review && (
          <details>
            <summary>Task review</summary>
            <SavedText value={state.task.review} location="task" />
          </details>
        )}
      </div>
      {active && !heldForEdit && (
        <div className="job-detail-actions" aria-label="Job controls">
          <button
            className="secondary"
            disabled={disabled}
            onClick={() => void change({ action: job.held ? 'release' : 'hold' })}
          >
            {job.held
              ? 'Release job'
              : job.status === 'running'
                ? 'Pause after this turn'
                : 'Pause job'}
          </button>
          {job.status === 'queued' && (
            <>
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => setEstimate(job.estimate)}
              >
                Change scheduling estimate
              </button>
              {!job.override && (
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={() => void change({ action: 'override' })}
                >
                  Use reserved capacity
                </button>
              )}
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => void change({ action: 'cancel' })}
              >
                Cancel queued job
              </button>
            </>
          )}
        </div>
      )}
      {estimate && !heldForEdit && job.status === 'queued' && (
        <form
          className="job-detail-section"
          onSubmit={(event) => {
            event.preventDefault();
            void change({ action: 'configure', estimate });
          }}
        >
          <JobEstimateFields value={estimate} change={setEstimate} disabled={disabled} />
          <div className="job-detail-actions">
            <button className="secondary" disabled={disabled}>
              Save scheduling estimate
            </button>
            <button
              type="button"
              className="secondary"
              disabled={disabled}
              onClick={() => setEstimate(null)}
            >
              Close
            </button>
          </div>
        </form>
      )}
      <details className="job-detail-section">
        <summary>Scheduling and usage</summary>
        <p>
          {job.estimate.priority} priority · about {job.estimate.expectedTokens.toLocaleString()}{' '}
          tokens and {Math.ceil(job.estimate.expectedSeconds / 60)} minutes estimated per turn.
        </p>
        <p>
          {job.tokenBasis === 'none'
            ? 'No usage charge is recorded for this turn.'
            : `${job.tokensCharged.toLocaleString()} tokens ${job.tokenBasis === 'measured' ? 'charged from measured counters' : job.tokenBasis === 'reserved' ? 'reserved at admission' : 'charged by estimate; provider measurement unavailable'}.`}
        </p>
        {job.estimate.estimateNote && <p>{job.estimate.estimateNote}</p>}
        <p className="muted">
          Estimates guide scheduling; they are not completion promises or provider-enforced token
          caps. Running work stops through its conversation controls.
        </p>
      </details>
    </section>
  );
}
