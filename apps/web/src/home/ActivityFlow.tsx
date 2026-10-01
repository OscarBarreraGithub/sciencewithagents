import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  CheckCheck,
  GitBranch,
  Inbox,
  ShieldCheck,
  Volume2,
} from 'lucide-react';
import {
  attention,
  integrationPreviewSchema,
  taskSchema,
  type IntegrationPreview,
  type Snapshot,
} from '@dock/shared';
import { api } from '../api';
import { Modal } from '../Modal';
import { QuarkWorkspace } from './QuarkWorkspace';
import { PulsarPanel } from '../PulsarPanel';
import { LocalJobsPanel } from '../LocalJobsPanel';
import { FlowEmpty, FlowHeading } from './WorkspaceFlow';
import type { HomeData } from './useHomeData';
import './activity-flow.css';

export const activityPages = new Set([
  'attention',
  'work',
  'job',
  'activity',
  'review',
  'transcribe',
]);
const labels = {
  approval: 'Permission request',
  decision: 'Manager decision',
  failed: 'Stopped work',
  interrupted: 'Interrupted work',
  integration: 'Ready for review',
  backup: 'Source backup',
};
const route = (page: string, id: string) => `#/${page}/${encodeURIComponent(id)}`;
const refresh = () => window.dispatchEvent(new Event('swa:refresh-home'));

export function ActivityFlow({ currentRoute, data }: { currentRoute: string; data: HomeData }) {
  const [page, id] = currentRoute.split('/');
  if (page === 'job')
    return (
      <section className="flow-page activity-page">
        <FlowHeading
          label="QUARK JOB"
          title="Job details"
          action={
            <a href="#/work" className="flow-button">
              All work <ArrowUpRight size={16} />
            </a>
          }
        >
          See its allowance and resource estimates, why it is waiting, and the conversation
          responsible for the result.
        </FlowHeading>
        <div className="flow-form-panel">
          <PulsarPanel
            jobId={id}
            open={(agentId) => {
              location.hash = route('chat', agentId);
            }}
          />
        </div>
      </section>
    );
  if (page === 'work') return <QuarkWorkspace data={data} />;
  if (page === 'transcribe')
    return (
      <section className="flow-page activity-page">
        <FlowHeading
          label="LOCAL WORK"
          title="Local transcription"
          action={
            <a href="#/work" className="flow-button">
              Open QUARK <ArrowUpRight size={16} />
            </a>
          }
        >
          Turn a public YouTube video into a transcript on this computer. Choose how soon you need
          it; QUARK makes room.
        </FlowHeading>
        <LocalJobsPanel
          embedded
          close={() => {
            location.hash = '#/work';
          }}
        />
      </section>
    );
  const state = data.snapshot.data;
  if (!state)
    return (
      <section className="flow-page">
        <FlowHeading label="YOUR WORK" title="Opening your saved work…">
          Your projects and records stay on this computer.
        </FlowHeading>
        <FlowEmpty
          title={data.snapshot.error ? 'The computer is unavailable' : 'Reading your workspace…'}
        >
          <button className="flow-button" onClick={data.snapshot.retry}>
            Try again
          </button>
        </FlowEmpty>
      </section>
    );
  if (page === 'review') return <ReviewPage key={id} id={id ?? ''} state={state} />;
  if (page === 'activity') return <Results data={data} state={state} />;
  return <Attention state={state} />;
}
function Attention({ state }: { state: Snapshot }) {
  const [filter, setFilter] = useState('all');
  const all = attention(state).items;
  const items = all.filter(
    (item) =>
      filter === 'all' ||
      (filter === 'review' ? item.kind === 'integration' : item.kind !== 'integration'),
  );
  return (
    <section className="flow-page activity-page">
      <FlowHeading
        label="YOUR ATTENTION"
        title="For your attention"
        action={
          <span className="activity-total">
            {all.length} open {all.length === 1 ? 'item' : 'items'}
          </span>
        }
      >
        Permissions, paused work and reviewed changes. Each decision stays with its original
        conversation and project.
      </FlowHeading>
      <div className="flow-filters" aria-label="Attention filters">
        {(
          [
            ['all', 'Everything'],
            ['decisions', 'Needs a response'],
            ['review', 'Changes to review'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={filter === value ? 'selected' : ''}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {items.length ? (
        <div className="activity-grid">
          {items.map((item) => (
            <article className={`activity-card ${item.kind}`} key={`${item.kind}:${item.id}`}>
              <div className="activity-card-top">
                <span className="activity-kind">
                  <ShieldCheck size={16} />
                  {labels[item.kind]}
                </span>
                <span>{item.projectName}</span>
              </div>
              <h2>{item.title}</h2>
              <p>{item.description}</p>
              <a
                className="flow-button"
                href={
                  item.destination === 'workspace' && item.taskId
                    ? route('review', item.taskId)
                    : route('chat', item.agentId)
                }
              >
                {item.kind === 'integration'
                  ? 'Review changes'
                  : item.kind === 'approval'
                    ? 'Review original request'
                    : 'Open conversation'}{' '}
                <ArrowUpRight size={16} />
              </a>
            </article>
          ))}
        </div>
      ) : (
        <div className="activity-calm">
          <Inbox size={36} />
          <h2>{all.length ? 'Nothing in this view.' : 'No pending requests'}</h2>
          <p>
            Your managers can keep working within their approved budgets. New decisions will appear
            here.
          </p>
          <a className="flow-button" href="#/work">
            See the work queue <ArrowUpRight size={16} />
          </a>
        </div>
      )}
    </section>
  );
}
function Results({ state, data }: { state: Snapshot; data: HomeData }) {
  const tasks = state.tasks.filter((t) =>
    ['done', 'integrated', 'split', 'cancelled'].includes(t.status),
  );
  const local = data.local.data?.jobs.filter((j) => j.status === 'completed') ?? [];
  return (
    <section className="flow-page activity-page">
      <FlowHeading
        label="RECENT RESULTS"
        title="Recent results"
        action={
          <a href="#/projects" className="flow-button">
            All projects <ArrowUpRight size={16} />
          </a>
        }
      >
        Finished tasks, reviewed changes and local transcripts. Open any result to meet the team and
        see its evidence.
      </FlowHeading>
      {!tasks.length && !local.length ? (
        <FlowEmpty title="Your results will collect here">
          Give a manager an outcome, and return here as the work finishes.
        </FlowEmpty>
      ) : (
        <div className="activity-grid">
          {[...tasks].reverse().map((task) => (
            <article className="activity-card result" key={task.id}>
              <div className="activity-card-top">
                <span className="activity-kind">
                  <CheckCheck size={17} />
                  {task.status === 'cancelled'
                    ? 'Closed · history retained'
                    : task.reconciliationTaskId
                      ? 'Update in progress'
                      : task.status === 'integrated'
                        ? 'Applied to project'
                        : task.hasReviewedChanges
                          ? 'Reviewed changes'
                          : 'Saved result'}
                </span>
                <span>{state.projects.find((p) => p.id === task.projectId)?.name}</span>
              </div>
              <h2>{task.title}</h2>
              <p>{task.goal}</p>
              <a href={route('task', task.id)} className="flow-button">
                Open result <ArrowUpRight size={16} />
              </a>
            </article>
          ))}
          {local.map((job) => (
            <article className="activity-card result" key={job.id}>
              <div className="activity-kind">
                <Volume2 size={17} />
                Transcript
              </div>
              <h2>Video transcript</h2>
              <p>{job.url}</p>
              <a className="flow-button" href="#/transcribe">
                Read transcript <ArrowUpRight size={16} />
              </a>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
function ReviewPage({ id, state }: { id: string; state: Snapshot }) {
  const task = state.tasks.find((t) => t.id === id);
  const [preview, setPreview] = useState<IntegrationPreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [applied, setApplied] = useState(false);
  const [revision, setRevision] = useState(0);
  const receipt = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    setPreview(null);
    if (!task || task.status === 'integrated' || task.reconciliationTaskId) {
      setLoading(false);
      return;
    }
    void api(`/tasks/${id}/integration`)
      .then((raw) => {
        if (live) setPreview(integrationPreviewSchema.parse(raw));
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : 'Could not load the reviewed changes.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [id, task?.status, task?.reconciliationTaskId, revision]);
  async function mutate(action: 'integrate' | 'reconcile') {
    if (!preview || busy) return;
    const body = { source: preview.source, target: preview.target },
      signature = JSON.stringify({ action, ...body });
    if (receipt.current?.signature !== signature)
      receipt.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      const result = await api(`/tasks/${id}/${action}`, { ...body, key: receipt.current.key });
      refresh();
      if (action === 'reconcile') location.hash = route('task', taskSchema.parse(result).id);
      else {
        setApplied(true);
        setConfirm(false);
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Connection lost. Your preview is retained; check status before retrying.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flow-page activity-page review-page">
      <FlowHeading
        label="REVIEWED CHANGES"
        title={task?.title ?? 'Saved changes'}
        action={
          task && (
            <a href={route('task', id)} className="flow-button">
              Task & team <ArrowUpRight size={16} />
            </a>
          )
        }
      >
        Read the result and its independent review. Only your confirmation applies changes to the
        project.
      </FlowHeading>
      {!task ? (
        <FlowEmpty title="Task not available">
          <a href="#/projects">Return to your projects</a>
        </FlowEmpty>
      ) : applied || task.status === 'integrated' ? (
        <div className="activity-calm">
          <Check size={36} />
          <h2>Changes are in your project.</h2>
          <p>The review and original worker conversations remain available.</p>
          <a className="flow-button" href={route('project', task.projectId)}>
            Open project <ArrowUpRight size={16} />
          </a>
        </div>
      ) : task.reconciliationTaskId ? (
        <div className="flow-panel flow-prose">
          <h2>An update has its own task.</h2>
          <p>
            The original review is preserved. Your manager is preparing updated changes separately,
            with another review before anything is applied.
          </p>
          <a className="flow-button primary" href={route('task', task.reconciliationTaskId)}>
            Open follow-up task <ArrowUpRight size={16} />
          </a>
        </div>
      ) : (
        <>
          <div className="flow-panel flow-prose">
            <h2>What was reviewed</h2>
            <p>{task.goal}</p>
            <h3>Independent review</h3>
            <p>{task.review ?? 'No review text is available.'}</p>
            <a href={route('chat', task.managerId)} className="flow-button">
              Ask the manager <ArrowUpRight size={16} />
            </a>
          </div>
          {loading && <p role="status">Checking the exact saved versions…</p>}
          {error && !confirm && (
            <div className="flow-panel">
              <p role="alert" className="form-error">
                {error}
              </p>
              <button className="flow-button" onClick={() => setRevision((n) => n + 1)}>
                Refresh preview
              </button>
            </div>
          )}
          {preview && (
            <section className="flow-form-panel">
              <div className="flow-section-title">
                <h2>
                  {preview.relation === 'diverged' ? 'This task’s changes' : 'What will change'}
                </h2>
                <GitBranch size={20} />
              </div>
              {preview.relation === 'diverged' && (
                <div className="activity-warning">
                  <h3>Project changed since review</h3>
                  <p>
                    Other work has reached the project since this task began. These are this task’s
                    changes, not a preview of a completed merge. Prepare an updated task that
                    preserves both, then review it separately.
                  </p>
                  <p>
                    Your manager will use the existing queue and allowance limits. Nothing is
                    applied by this action.
                  </p>
                  <button
                    className="flow-button primary"
                    disabled={busy}
                    onClick={() => void mutate('reconcile')}
                  >
                    {busy ? 'Preparing follow-up…' : 'Prepare updated changes'}
                  </button>
                </div>
              )}
              {preview.relation === 'already-present' && (
                <p>
                  The reviewed changes are already in the project’s history. Confirmation will
                  record this task as applied without changing files.
                </p>
              )}
              <pre className="activity-diff-stat">
                {preview.changes || 'No additional file changes.'}
              </pre>
              <details className="activity-diff">
                <summary>Read the full changes</summary>
                <pre>{preview.patch || 'No file changes.'}</pre>
              </details>
              <details className="activity-diff">
                <summary>Technical details: exact versions</summary>
                <p>
                  This approval is tied to these versions. A changed project or task requires a new
                  preview.
                </p>
                <pre>{`Project: ${preview.target}\nReviewed task: ${preview.source}`}</pre>
              </details>
              {preview.canApply && (
                <button className="flow-button primary" onClick={() => setConfirm(true)}>
                  Apply reviewed changes <ArrowUpRight size={16} />
                </button>
              )}
            </section>
          )}
        </>
      )}
      {confirm && preview && (
        <Modal
          title="Apply these reviewed changes?"
          close={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <p>
            This adds the reviewed result to your project. The exact preview remains behind this
            confirmation.
          </p>
          <pre>
            {preview.changes || 'The result is already present; record the task as applied.'}
          </pre>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="activity-confirm-actions">
            <button className="flow-button" disabled={busy} onClick={() => setConfirm(false)}>
              Keep reviewing
            </button>
            <button
              className="flow-button primary"
              disabled={busy}
              onClick={() => void mutate('integrate')}
            >
              {busy ? 'Applying changes…' : 'Confirm and apply changes'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
