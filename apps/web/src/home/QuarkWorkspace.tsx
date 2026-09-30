import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Layers3, MessageCircle, Settings2, Clock3 } from 'lucide-react';
import {
  quarkCoordinatorStatusSchema,
  quarkDefaultFamilies,
  type Model,
  type QuarkCoordinatorStatus,
} from '@dock/shared';
import { api, models } from '../api';
import { SchedulerPanel } from '../SchedulerPanel';
import { useReading, type HomeData } from './useHomeData';
import { ChatPage, FlowHeading, FlowEmpty } from './WorkspaceFlow';
import { AssistantFullscreen } from './AssistantFullscreen';
import './quark-workspace.css';

const columns = ['Waiting', 'Working', 'Paused / needs input', 'Completed'] as const;
export function QuarkWorkspace({ data }: { data: HomeData }) {
  const reading = useReading('/quark/coordinator', quarkCoordinatorStatusSchema.parse);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [filter, setFilter] = useState('all');
  const [completedSearch, setCompletedSearch] = useState('');
  const [completedLimit, setCompletedLimit] = useState(10);
  const startKey = useRef(crypto.randomUUID());
  const s = reading.data;
  useEffect(() => {
    if (s?.agentId) startKey.current = crypto.randomUUID();
  }, [s?.agentId]);
  const refresh = () => {
    reading.retry();
    data.snapshot.retry();
  };
  async function start() {
    setBusy(true);
    setError('');
    try {
      await api('/quark/coordinator/start', { key: startKey.current });
      setChatOpen(true);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open QUARK. Retry when connected.');
    } finally {
      setBusy(false);
    }
  }
  const state = data.snapshot.data;
  const jobs = s
    ? [...s.queue.jobs, ...s.queue.history].filter((j) => j.agentId !== s.agentId)
    : [];
  const jobCards = jobs.map((j) => {
    const agent = state?.agents.find((a) => a.id === j.agentId);
    const task = state?.tasks.find((t) => t.id === j.taskId);
    const project = s?.projects.find((p) => p.id === agent?.projectId);
    const paused =
      j.held ||
      project?.policy.paused ||
      ['failed', 'interrupted'].includes(j.status) ||
      agent?.status === 'waiting';
    const column = paused
      ? columns[2]
      : j.status === 'running'
        ? columns[1]
        : j.status === 'queued'
          ? columns[0]
          : columns[3];
    return {
      id: j.runId,
      column,
      project: j.projectName,
      title: task?.title ?? j.agentName,
      model: agent?.model ?? j.provider,
      href: `#/job/${j.runId}`,
      reason: j.reason,
      priority: j.estimate.priority,
      weight: project?.policy.weight ?? 1,
      estimate: `~${j.estimate.quotaPercent}% allowance · ~${Math.ceil(j.estimate.expectedSeconds / 60)} min`,
      resources: `${j.estimate.cpuCores} CPU cores · ${j.estimate.memoryMb} MB`,
      actual: `${j.tokensCharged.toLocaleString()} tokens · ${j.tokenBasis}`,
    };
  });
  const backlog = (state?.tasks ?? [])
    .filter((t) => !jobs.some((j) => j.taskId === t.id))
    .map((t) => {
      const project = s?.projects.find((p) => p.id === t.projectId);
      return {
        id: t.id,
        column: ['done', 'integrated', 'split'].includes(t.status)
          ? columns[3]
          : t.status === 'needs_decision' || project?.policy.paused
            ? columns[2]
            : columns[0],
        project: project?.name ?? 'Project',
        title: t.title,
        model: 'Manager planning',
        href: `#/task/${t.id}`,
        reason:
          t.status === 'needs_decision'
            ? 'Your manager needs input.'
            : 'Open the task for its plan and team.',
        priority: t.scheduling?.priority ?? 'normal',
        weight: project?.policy.weight ?? 1,
        estimate: t.scheduling
          ? `~${t.scheduling.quotaPercent}% allowance · ~${Math.ceil(t.scheduling.expectedSeconds / 60)} min`
          : 'Awaiting a manager estimate',
        resources: '',
        actual: '',
      };
    });
  const localCards = (s?.localJobs ?? []).map((j) => ({
    id: j.id,
    column:
      j.status === 'running'
        ? columns[1]
        : j.status === 'queued'
          ? columns[0]
          : ['paused', 'failed', 'interrupted'].includes(j.status)
            ? columns[2]
            : columns[3],
    project: s?.projects.find((p) => p.id === j.projectId)?.name ?? 'This computer',
    title: 'Video transcription',
    model: 'Local Whisper',
    href: '#/transcribe',
    reason: j.message,
    priority: j.resources.priority,
    weight: j.projectId ? (s?.projects.find((p) => p.id === j.projectId)?.policy.weight ?? 1) : 1,
    estimate: `~${Math.ceil(j.resources.expectedSeconds / 60)} min · no AI allowance`,
    resources: `${j.resources.cpuCores} CPU cores · ${j.resources.memoryMb} MB`,
    actual: j.phase,
  }));
  const cards = [...jobCards, ...backlog, ...localCards];
  const visibleCards = cards.filter(
    (c) =>
      c.column !== 'Completed' ||
      `${c.project} ${c.title} ${c.model}`.toLowerCase().includes(completedSearch.toLowerCase()),
  );
  return (
    <section className="flow-page activity-page quark-workspace">
      <FlowHeading
        label="QUARK"
        title="QUARK"
        action={
          <a className="flow-button" href="#/usage">
            Allowance details <ArrowUpRight size={16} />
          </a>
        }
      >
        Tell QUARK what comes first. It coordinates the queue, protects your allowance and keeps
        your decisions.
      </FlowHeading>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!s ? (
        <FlowEmpty title={reading.error ? 'QUARK could not connect' : 'Reading the shared queue…'}>
          <button className="flow-button" onClick={reading.retry}>
            Try again
          </button>
        </FlowEmpty>
      ) : (
        <>
          <div className="quark-overview">
            <div>
              <span>Shared reserve</span>
              <strong>{s.queue.policy.reservePercent}%</strong>
              <small>
                kept available {s.queue.policy.enabled ? 'across projects' : '· pacing is off'}
              </small>
            </div>
            <div>
              <span>Running</span>
              <strong>{cards.filter((c) => c.column === 'Working').length}</strong>
              <small>
                {cards.filter((c) => c.column === 'Waiting').length} waiting for their turn
              </small>
            </div>
            {s.capacity.map((provider) => {
              const windows = provider.windows.filter((w) => w.scope === 'general');
              const room =
                windows.length && !provider.stale
                  ? Math.max(
                      0,
                      Math.min(...windows.map((w) => 100 - w.usedPercent)) -
                        s.queue.policy.reservePercent,
                    )
                  : null;
              const demand = s.queue.jobs
                .filter((j) => j.provider === provider.provider && j.agentId !== s.agentId)
                .reduce((n, j) => n + j.estimate.quotaPercent, 0);
              return (
                <div key={provider.provider}>
                  <span>
                    {provider.provider === 'claude' ? 'Claude' : 'Codex'} · queue forecast
                  </span>
                  <strong>{room === null ? 'Unknown' : `${Math.round(room)}%`}</strong>
                  <small>
                    {room === null
                      ? 'Needs a fresh allowance reading'
                      : `${demand.toFixed(1)}% forecast · ${demand <= room ? 'within shared headroom' : 'some work must wait'}`}
                  </small>
                </div>
              );
            })}
          </div>
          <section className="quark-desk" aria-label="Talk to QUARK">
            <header>
              <div className="quark-desk-title">
                <MessageCircle size={20} />
                <div>
                  <h2>Talk to QUARK</h2>
                  <p>
                    {s.modelLabel ??
                      state?.agents.find((a) => a.id === s.agentId)?.model ??
                      (s.settings.model.model || `Latest ${s.settings.model.family}`)}{' '}
                    · decisions saved across conversations
                  </p>
                </div>
              </div>
              <button
                className="flow-button"
                onClick={() => setSettingsOpen(!settingsOpen)}
                aria-expanded={settingsOpen}
              >
                <Settings2 size={16} /> Model & settings
              </button>
            </header>
            {settingsOpen && !chatOpen && (
              <CoordinatorSettings key={s.settings.revision} state={s} done={refresh} />
            )}
            {s.agentId && state ? (
              <div className="quark-welcome">
                <p>
                  Your instructions and scheduling decisions stay in QUARK’s saved conversation.
                </p>
                <button className="flow-button primary" onClick={() => setChatOpen(true)}>
                  Open QUARK conversation <ArrowUpRight size={16} />
                </button>
              </div>
            ) : (
              <div className="quark-welcome">
                <span className="quark-symbol">
                  <Layers3 size={30} />
                </span>
                <h3>QUARK orchestrator</h3>
                <p>
                  “Pause the website, prioritize my analysis, and give it at most 20% of my weekly
                  Codex allowance.”
                </p>
                <button
                  className="flow-button primary"
                  disabled={busy}
                  onClick={() => void start()}
                >
                  {busy ? 'Preparing QUARK…' : 'Open QUARK conversation'}
                </button>
                <small>
                  Opening prepares its workspace. It replies when you send a message or active work
                  needs a scheduling check.
                </small>
              </div>
            )}
          </section>
          {chatOpen && s.agentId && state && (
            <AssistantFullscreen
              title="QUARK conversation"
              back="Back to QUARK"
              close={() => setChatOpen(false)}
              controls={
                <button
                  className="flow-button"
                  onClick={() => setSettingsOpen(!settingsOpen)}
                  aria-expanded={settingsOpen}
                >
                  <Settings2 size={16} /> Model & settings
                </button>
              }
            >
              {settingsOpen && (
                <CoordinatorSettings key={s.settings.revision} state={s} done={refresh} />
              )}
              <ChatPage embedded id={s.agentId} state={state} refresh={refresh} />
            </AssistantFullscreen>
          )}
          {s.decisions.length > 0 && (
            <details className="quark-decisions">
              <summary>
                Saved instructions & decisions <span>{s.decisions.length} recent</span>
              </summary>
              {s.decisions.slice(0, 10).map((d) => (
                <article key={d.key}>
                  <strong>{d.source === 'owner' ? 'Your instruction' : 'Scheduling check'}</strong>
                  <p>{d.action.reason}</p>
                  <small>{new Date(d.at).toLocaleString()}</small>
                </article>
              ))}
            </details>
          )}
          <div className="activity-shortcuts">
            <a href="#/resources">
              <Layers3 size={18} />
              <strong>Computer health</strong>
              <span>See what is using your computer</span>
            </a>
          </div>
          <div className="quark-board-heading">
            <div>
              <h2>Project queue</h2>
            </div>
            <a className="flow-button" href="#/projects">
              Projects <ArrowUpRight size={16} />
            </a>
          </div>
          <div className="quark-projects">
            {s.projects.map((p) => (
              <a key={p.id} href={`#/project/${p.id}`}>
                <strong>{p.name}</strong>
                <span>{p.policy.paused ? 'Paused' : `Priority weight ${p.policy.weight}`}</span>
                {p.policy.instruction && <small>{p.policy.instruction}</small>}
                {s.accounting.budgets
                  .filter((b) => b.projectId === p.id && !b.taskId)
                  .map((b) => (
                    <small key={b.id}>
                      {b.provider}: {b.remainingPercent.toFixed(1)}% left of {b.limitPercent}%
                      allocated{b.reason ? ' · waiting' : ''}
                    </small>
                  ))}
              </a>
            ))}
          </div>
          <div className="flow-filters quark-filters" aria-label="Board status">
            {['all', ...columns].map((c) => (
              <button
                key={c}
                aria-pressed={filter === c}
                className={filter === c ? 'selected' : ''}
                onClick={() => setFilter(c)}
              >
                {c === 'all' ? 'Active work' : c}
              </button>
            ))}
          </div>
          {filter === 'Completed' && (
            <label className="quark-history-search">
              Find completed work
              <input
                type="search"
                value={completedSearch}
                placeholder="Project, task or model"
                onChange={(event) => {
                  setCompletedSearch(event.target.value);
                  setCompletedLimit(10);
                }}
              />
            </label>
          )}
          <div className={`quark-board ${filter !== 'all' ? 'filtered' : ''}`}>
            {columns
              .filter((c) => (filter === 'all' ? c !== 'Completed' : filter === c))
              .map((column, index) => (
                <section
                  key={column}
                  className={`quark-column column-${index}${column === 'Completed' ? ' quark-completed' : ''}`}
                  aria-label={column}
                >
                  <h3>
                    <span className="quark-dot" />
                    {column}
                    <b>{visibleCards.filter((c) => c.column === column).length}</b>
                  </h3>
                  <div className="quark-cards">
                    {visibleCards
                      .filter((c) => c.column === column)
                      .slice(0, column === 'Completed' ? completedLimit : 30)
                      .map((c) => (
                        <a key={c.id} className="quark-ticket" href={c.href}>
                          <span className="quark-ticket-project">{c.project}</span>
                          <h4>{c.title}</h4>
                          <span className="quark-ticket-model">{c.model}</span>
                          {column !== 'Completed' && <p>{c.reason}</p>}
                          {column !== 'Completed' && (
                            <div className="quark-ticket-facts">
                              <span>
                                <Clock3 size={13} />
                                {c.estimate}
                              </span>
                              {c.resources && <span>{c.resources}</span>}
                              {c.actual && <span>{c.actual}</span>}
                            </div>
                          )}
                          <footer>
                            <span>
                              {column === 'Completed'
                                ? c.actual || 'Open details'
                                : `${c.priority} · weight ${c.weight}`}
                            </span>
                            <ArrowUpRight size={15} />
                          </footer>
                        </a>
                      ))}
                    {!visibleCards.some((c) => c.column === column) && (
                      <p className="quark-column-empty">
                        {column === 'Completed'
                          ? completedSearch
                            ? 'No matching completed work.'
                            : 'No completed work.'
                          : 'Nothing here right now.'}
                      </p>
                    )}
                    {column === 'Completed' &&
                      visibleCards.filter((c) => c.column === column).length > completedLimit && (
                        <button
                          className="flow-button"
                          onClick={() => setCompletedLimit((n) => n + 10)}
                        >
                          Show 10 more
                        </button>
                      )}
                  </div>
                </section>
              ))}
          </div>
          <p className="quark-footnote">
            Forecasts are approximate. Model-specific limits, project caps, work already in flight
            and computer resources can still make a job wait.
          </p>
          <details className="quark-advanced">
            <summary>Queue controls</summary>
            <SchedulerPanel
              embedded
              openJob={(id) => {
                location.hash = `#/job/${id}`;
              }}
              close={() => {}}
              open={(id) => {
                location.hash = `#/chat/${id}`;
              }}
            />
          </details>
          <p className="quark-footnote">{s.notice}</p>
        </>
      )}
    </section>
  );
}
function CoordinatorSettings({ state, done }: { state: QuarkCoordinatorStatus; done: () => void }) {
  const [draft, setDraft] = useState(state.settings);
  const [catalog, setCatalog] = useState<Model[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const receipt = useRef({ signature: '', key: crypto.randomUUID() });
  useEffect(() => {
    let alive = true;
    setCatalog([]);
    setError('');
    void models(undefined, draft.model.provider)
      .then((m) => {
        if (alive) setCatalog(m);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [draft.model.provider]);
  async function save() {
    setBusy(true);
    setError('');
    const signature = JSON.stringify(draft);
    if (receipt.current.signature !== signature)
      receipt.current = { signature, key: crypto.randomUUID() };
    try {
      await api('/quark/coordinator/settings', { key: receipt.current.key, settings: draft });
      done();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Your choices are retained.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="quark-settings">
      <label>
        Provider
        <select
          value={draft.model.provider}
          onChange={(e) =>
            setDraft({
              ...draft,
              model: {
                ...draft.model,
                provider: e.target.value as 'codex' | 'claude',
                family: quarkDefaultFamilies[e.target.value as 'claude' | 'codex'],
                model: null,
                effort: null,
              },
            })
          }
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <label>
        Model
        <select
          value={draft.model.model ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              model: { ...draft.model, model: e.target.value || null, effort: null },
            })
          }
        >
          <option value="">Latest {draft.model.family} (default)</option>
          {catalog.map((m) => (
            <option value={m.id} key={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label className="quark-check">
        <input
          type="checkbox"
          checked={draft.automatic}
          onChange={(e) => setDraft({ ...draft, automatic: e.target.checked })}
        />{' '}
        Automatic scheduling checks
      </label>
      <button className="flow-button" disabled={busy} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
      <small>
        Provider changes preserve the old conversation and prepare a fresh one. Saved project
        instructions remain.
      </small>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
