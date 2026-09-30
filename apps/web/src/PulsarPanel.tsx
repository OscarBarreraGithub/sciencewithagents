import { useEffect, useRef, useState } from 'react';
import {
  pulsarStatusSchema,
  type JobEstimate,
  type PulsarStatus,
  type PulsarPolicy,
} from '@dock/shared';
import { api } from './api';
import { JobEstimateFields } from './JobEstimateFields';
import './PulsarPanel.css';

export function PulsarPanel({
  open,
  openJob,
  jobId,
}: {
  open: (agentId: string) => void;
  openJob?: (runId: string) => void;
  jobId?: string;
}) {
  const [state, setState] = useState<PulsarStatus | null>(null);
  const [policy, setPolicy] = useState<PulsarPolicy | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<JobEstimate | null>(null);
  const pending = useRef<{
    path: string;
    fingerprint: string;
    body: Record<string, unknown>;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const value = pulsarStatusSchema.parse(await api('/pulsar'));
        if (active) {
          setState(value);
          setError((previous) =>
            previous === 'Could not read QUARK. Your queued work is retained.' ? '' : previous,
          );
          setPolicy((previous) => previous ?? value.policy);
        }
      } catch {
        if (active) setError('Could not read QUARK. Your queued work is retained.');
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const mutate = async (path: string, input: Record<string, unknown>) => {
    if (busy) return;
    const fingerprint = JSON.stringify(input);
    if (
      !pending.current ||
      pending.current.path !== path ||
      pending.current.fingerprint !== fingerprint
    )
      pending.current = { path, fingerprint, body: { ...input, key: crypto.randomUUID() } };
    setBusy(true);
    setError('');
    try {
      const value = pulsarStatusSchema.parse(await api(path, pending.current.body));
      pending.current = null;
      setState(value);
      setPolicy(value.policy);
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Check the queue and retry.');
    } finally {
      setBusy(false);
    }
  };
  if (!state || !policy) return <p role="status">{error || 'Reading QUARK…'}</p>;
  return (
    <section className="pulsar-panel">
      {!jobId && (
        <>
          <h3>QUARK</h3>
          <p>Queued Usage, Agent Routing Kernel</p>
          <p>
            One shared budget for every manager. Background jobs make progress when provider
            allowance and this computer have room.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void mutate('/pulsar/policy', {
                policy: { ...policy, enabled: !state.policy.enabled },
              })
            }
          >
            {state.policy.enabled ? 'Turn off capacity pacing' : 'Enable shared capacity pacing'}
          </button>
          <details>
            <summary>Shared headroom and pacing</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void mutate('/pulsar/policy', { policy });
              }}
            >
              <div className="estimate-grid">
                <label>
                  Automatic turns before a progress check
                  <input
                    type="number"
                    min="12"
                    max="1000"
                    value={policy.maxAutomaticTurns}
                    onChange={(e) =>
                      setPolicy({ ...policy, maxAutomaticTurns: e.target.valueAsNumber })
                    }
                  />
                </label>
                <label>
                  Allowance reserved for active work (%)
                  <input
                    type="number"
                    min="5"
                    max="80"
                    value={policy.reservePercent}
                    onChange={(e) =>
                      setPolicy({ ...policy, reservePercent: e.target.valueAsNumber })
                    }
                  />
                </label>
                <label>
                  Concurrent Claude workers
                  <select
                    value={policy.claudeConcurrent}
                    onChange={(e) =>
                      setPolicy({ ...policy, claudeConcurrent: Number(e.target.value) })
                    }
                  >
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Concurrent Codex workers
                  <select
                    value={policy.codexConcurrent}
                    onChange={(e) =>
                      setPolicy({ ...policy, codexConcurrent: Number(e.target.value) })
                    }
                  >
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Background start interval (seconds)
                  <input
                    type="number"
                    min="0"
                    max="3600"
                    value={policy.backgroundGapSeconds}
                    onChange={(e) =>
                      setPolicy({ ...policy, backgroundGapSeconds: e.target.valueAsNumber })
                    }
                  />
                </label>
                <label>
                  Maximum CPU use (%)
                  <input
                    type="number"
                    min="20"
                    max="100"
                    value={policy.maxCpuPercent}
                    onChange={(e) =>
                      setPolicy({ ...policy, maxCpuPercent: e.target.valueAsNumber })
                    }
                  />
                </label>
                <label>
                  Free memory reserve (MB)
                  <input
                    type="number"
                    min="256"
                    max="131072"
                    value={policy.memoryReserveMb}
                    onChange={(e) =>
                      setPolicy({ ...policy, memoryReserveMb: e.target.valueAsNumber })
                    }
                  />
                </label>
              </div>
              <button className="secondary" disabled={busy}>
                Save pacing rules
              </button>
            </form>
          </details>
        </>
      )}
      {jobId && error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {state.jobs
        .filter((job) => !jobId || job.runId === jobId)
        .map((job) => (
          <article className="pulsar-job" key={job.runId}>
            <small>
              {job.projectName} · {job.provider} · {job.estimate.priority}
            </small>
            <h4>{job.agentName}</h4>
            <p>{job.reason}</p>
            <p className="muted">
              About {job.estimate.expectedTokens.toLocaleString()} tokens ·{' '}
              {Math.ceil(job.estimate.expectedSeconds / 60)} min per turn · task budget{' '}
              {job.estimate.tokenBudget.toLocaleString()} tokens
              {job.estimate.estimatedCostUsd !== null
                ? ` · estimated $${job.estimate.estimatedCostUsd.toFixed(2)}`
                : ''}
            </p>
            <p className="muted">
              {job.expectedFinishAt
                ? `Estimated finish ${new Date(job.expectedFinishAt).toLocaleTimeString()}${Date.parse(job.expectedFinishAt) < Date.now() ? ' — taking longer than estimated' : ''}`
                : 'Finish time depends on admission and available capacity.'}
              {job.estimate.deadline
                ? ` Target: ${new Date(job.estimate.deadline).toLocaleString()}.`
                : ''}
            </p>
            <div className="pulsar-actions">
              {openJob && (
                <button className="secondary" onClick={() => openJob(job.runId)}>
                  Job details
                </button>
              )}
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void mutate('/pulsar/jobs', {
                    runId: job.runId,
                    action: job.held ? 'release' : 'hold',
                  })
                }
              >
                {job.held
                  ? 'Release job'
                  : job.status === 'running'
                    ? 'Pause after this turn'
                    : 'Pause job'}
              </button>
              <button className="secondary" onClick={() => open(job.agentId)}>
                Open conversation
              </button>
              {job.status === 'queued' && (
                <>
                  <button
                    className="secondary"
                    onClick={() => {
                      setEditing(job.runId);
                      setEstimate(job.estimate);
                    }}
                  >
                    Change priority or budget
                  </button>
                  <button
                    className="secondary"
                    disabled={busy || job.override}
                    onClick={() =>
                      void mutate('/pulsar/jobs', { runId: job.runId, action: 'override' })
                    }
                  >
                    Use reserved capacity
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void mutate('/pulsar/jobs', { runId: job.runId, action: 'cancel' })
                    }
                  >
                    Cancel queued job
                  </button>
                </>
              )}
            </div>
            {editing === job.runId && estimate && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void mutate('/pulsar/jobs', { runId: job.runId, action: 'configure', estimate });
                }}
              >
                <JobEstimateFields value={estimate} change={setEstimate} disabled={busy} />
                <button className="secondary" disabled={busy}>
                  Save job estimate
                </button>
              </form>
            )}
          </article>
        ))}
      {!jobId && !state.jobs.length && <p>No work is waiting for QUARK.</p>}
      {jobId && ![...state.jobs, ...state.history].some((j) => j.runId === jobId) && (
        <p>
          This job is outside the recent queue view. Open its conversation to inspect older work.
        </p>
      )}
      {!!state.history.filter((j) => !jobId || j.runId === jobId).length && (
        <details open={!!jobId}>
          <summary>Recent outcomes and estimates</summary>
          {state.history
            .filter((j) => !jobId || j.runId === jobId)
            .map((job) => (
              <article className="pulsar-job" key={job.runId}>
                <h4>
                  {job.agentName} · {job.status}
                </h4>
                <p>
                  {job.projectName} · {job.provider}
                </p>
                <p>
                  {job.estimate.expectedTokens.toLocaleString()} tokens estimated;{' '}
                  {job.tokensCharged.toLocaleString()}{' '}
                  {job.tokenBasis === 'measured'
                    ? 'measured'
                    : 'charged by estimate (provider measurement unavailable)'}
                  .
                </p>
                <p className="muted">
                  {job.estimate.estimateNote}{' '}
                  {job.estimate.estimatedCostUsd === null
                    ? 'No monetary price supplied.'
                    : `Planning price: $${job.estimate.estimatedCostUsd.toFixed(2)}; not a bill.`}
                </p>
                <button className="secondary" onClick={() => open(job.agentId)}>
                  Open conversation
                </button>
              </article>
            ))}
        </details>
      )}
      <p className="muted">{state.notice}</p>
    </section>
  );
}
