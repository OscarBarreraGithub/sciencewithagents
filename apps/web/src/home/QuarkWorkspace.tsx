import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Layers3, MessageCircle, Settings2, Clock3, Users } from 'lucide-react';
import {
  latestFamily,
  quarkCoordinatorStatusSchema,
  quarkDefaultFamilies,
  type Model,
  type QuarkCoordinatorStatus,
  type Task,
  type ProviderCapacity,
} from '@dock/shared';
import { api, models } from '../api';
import { ProviderActions } from './ProviderActions';
import { ago, resetLabel } from './HomeOverview';
import { SchedulerPanel } from '../SchedulerPanel';
import { useReading, type HomeData } from './useHomeData';
import { ChatPage, FlowHeading, FlowEmpty, stateNames } from './WorkspaceFlow';
import { AssistantFullscreen } from './AssistantFullscreen';
import { BudgetSlider, type BoardBudget, type BudgetEdits } from './BudgetSlider';
import './quark-workspace.css';

const columns = ['Waiting', 'Working', 'Paused / needs input', 'Completed'] as const;
type Column = (typeof columns)[number];
type Job = QuarkCoordinatorStatus['queue']['jobs'][number];
type Card = {
  id: string;
  column: Column;
  project: string;
  title: string;
  model: string;
  href: string;
  reason: string;
  priority: string;
  weight: number;
  estimate: string;
  resources: string;
  actual: string;
  budgets: BoardBudget[];
  team: string;
  resume: string[];
};
const live = (j: Job) => j.status === 'queued' || j.status === 'running';
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const familyName = (family: string) => family.charAt(0).toUpperCase() + family.slice(1);
// Bounded lists keep the board reachable on a phone; nothing is dropped without a control.
const pageSize = (column: Column) => (column === 'Completed' ? 10 : 30);
const projectPage = 6;

/** The task's own status decides completion; a finished turn only says that turn ended.
 *  Turns are ordered active first, then newest finished first. */
function placeTask(
  task: Task | undefined,
  turns: Job[],
  asking: string | undefined,
  projectPaused: boolean,
  quotaReason?: string,
  budgetReason?: string,
): [Column, string] {
  const active = turns.filter(live);
  const lead = active.find((j) => j.status === 'running') ?? active[0];
  const held = active.find((j) => j.held || (!j.eligible && j.budgetBlock));
  const latest = turns.find((j) => !live(j));
  if (budgetReason) return [columns[2], budgetReason];
  if (!active.length && task && ['done', 'integrated', 'split', 'cancelled'].includes(task.status))
    return [columns[3], task.closure?.reason ?? ''];
  if (task?.status === 'needs_decision') return [columns[2], 'Your manager needs input.'];
  if (asking) return [columns[2], `${asking} is waiting for your answer.`];
  if (quotaReason) return [columns[2], quotaReason];
  if (held) return [columns[2], held.reason];
  if (projectPaused) return [columns[2], lead?.reason ?? 'This project is paused in QUARK.'];
  if (lead) return [lead.status === 'running' ? columns[1] : columns[0], lead.reason];
  if (latest && ['failed', 'interrupted'].includes(latest.status))
    return [columns[2], latest.reason];
  return [
    columns[0],
    task?.status === 'review'
      ? 'Being reviewed. Open the task for its review and changes.'
      : task?.status === 'working'
        ? 'Between turns. Open the task for its plan and team.'
        : 'Open the task for its plan and team.',
  ];
}

function QuarkAllowance({ provider, forecast }: { provider: ProviderCapacity; forecast: string }) {
  const [open, setOpen] = useState(false);
  const stale = provider.stale || provider.state !== 'ready';
  const now = Date.now();
  return (
    <div className="quark-account" aria-label={`${provider.label} allowance`}>
      <h2>{provider.label}</h2>
      {provider.windows.length ? (
        provider.windows.map((window) => (
          <div className="quark-account-window" key={window.id}>
            <span>{window.label}</span>
            <strong>
              {Math.round(100 - window.usedPercent)}% left{stale && ' · old'}
            </strong>
            <small>{resetLabel(window.resetsAt, now)}</small>
          </div>
        ))
      ) : (
        <p>
          {provider.observedAt
            ? 'The last reading has no allowance windows.'
            : 'Allowance hasn’t been reported yet.'}
        </p>
      )}
      <small>
        {stale ? 'Last reading' : 'Updated'} {ago(provider.observedAt, now) ?? 'not available'}
      </small>
      <p>{forecast}</p>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>{stale ? 'Reading needs attention' : 'Account actions'}</summary>
        {stale && <p>{provider.message}</p>}
        {stale && provider.nextRefreshAt && (
          <small>
            Next automatic check:{' '}
            {new Date(provider.nextRefreshAt).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
            })}
            . Refresh uses the same waiting period.
          </small>
        )}
        {open && <ProviderActions provider={provider.provider} showQuarkLink={false} />}
      </details>
    </div>
  );
}

export function QuarkWorkspace({ data, taskId }: { data: HomeData; taskId?: string }) {
  const reading = useReading('/quark/coordinator', quarkCoordinatorStatusSchema.parse);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [filter, setFilter] = useState('all');
  const [completedSearch, setCompletedSearch] = useState('');
  const [limits, setLimits] = useState<Partial<Record<Column, number>>>({});
  const [projectLimit, setProjectLimit] = useState(projectPage);
  const limit = (column: Column) => limits[column] ?? pageSize(column);
  const budgetEdits = useRef<BudgetEdits>(new Map());
  const [, renderBudgets] = useState(0);
  const startKey = useRef(crypto.randomUUID());
  const resumeKeys = useRef(new Map<string, string>());
  const s = reading.data;
  useEffect(() => {
    if (s?.agentId) startKey.current = crypto.randomUUID();
  }, [s?.agentId]);
  const refresh = () => {
    reading.retry();
    data.snapshot.retry();
  };
  async function continueWork(runIds: string[]) {
    setBusy(true);
    setError('');
    try {
      for (const runId of runIds) {
        const key = resumeKeys.current.get(runId) ?? crypto.randomUUID();
        resumeKeys.current.set(runId, key);
        await api('/quark/resume', { key, runId });
        resumeKeys.current.delete(runId);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not continue this work.');
    } finally {
      setBusy(false);
      refresh();
    }
  }
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
  const budgetSlider = (budget: BoardBudget) => (
    <BudgetSlider
      key={budget.id}
      budget={budget}
      edits={budgetEdits.current}
      changed={() => renderBudgets((n) => n + 1)}
      windowLabel={
        s?.capacity
          .find((p) => p.provider === budget.provider)
          ?.windows.find((w) => w.id === budget.windowId)?.label ??
        s?.accounting.windows.find(
          (w) => w.provider === budget.provider && w.windowId === budget.windowId,
        )?.label ??
        'Saved allowance'
      }
      refresh={refresh}
    />
  );
  const state = data.snapshot.data;
  const focusedTask = useRef<string | null>(null);
  const runs = s
    ? [...s.queue.jobs, ...s.queue.history].filter((j) => j.agentId !== s.agentId)
    : [];
  const agentOf = (id: string) => state?.agents.find((a) => a.id === id);
  const projectOf = (id: string | undefined) => s?.projects.find((p) => p.id === id);
  // Turns outside any task stay individual cards and open their job details.
  const runCard = (j: Job): Card => {
    const agent = agentOf(j.agentId);
    const project = projectOf(agent?.projectId);
    const paused =
      j.held ||
      (!j.eligible && !!j.budgetBlock) ||
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
      title: j.agentName,
      model: agent?.model ?? j.provider,
      href: `#/job/${j.runId}`,
      reason: j.reason,
      priority: j.estimate.priority,
      weight: project?.policy.weight ?? 1,
      estimate: `~${j.estimate.quotaPercent}% allowance · ~${Math.ceil(j.estimate.expectedSeconds / 60)} min`,
      resources: `${j.estimate.cpuCores} CPU cores · ${j.estimate.memoryMb} MB`,
      actual: `${j.tokensCharged.toLocaleString()} tokens · ${j.tokenBasis}`,
      budgets: [],
      team: '',
      resume:
        s?.accounting.holds
          .filter((h) => !h.releasedAt && h.runId === j.runId)
          .map((h) => h.runId) ?? [],
    };
  };
  // One card per task, however many workers, managers or retries took turns on it. The task
  // page keeps its team, current jobs and recent finished turns.
  const taskCard = (taskId: string, turns: Job[]): Card[] => {
    const task = state?.tasks.find((t) => t.id === taskId);
    const active = turns.filter(live);
    // Without the saved task status, a finished turn says nothing about completion.
    if (!task && !active.length) return [];
    const lead = active.find((j) => j.status === 'running') ?? active[0];
    const recent = lead ?? turns[0];
    const team = state?.agents.filter((a) => a.taskId === taskId) ?? [];
    const asking = [...team, ...active.map((j) => agentOf(j.agentId))].find(
      (a) => a?.status === 'waiting',
    );
    const project = projectOf(task?.projectId ?? (lead && agentOf(lead.agentId)?.projectId));
    const quotaHolds = s?.accounting.holds.filter(
      (hold) =>
        !hold.releasedAt &&
        (team.some((agent) => agent.id === hold.agentId) ||
          turns.some((turn) => turn.runId === hold.runId)),
    );
    const [column, reason] = placeTask(
      task,
      turns,
      asking?.name,
      !!project?.policy.paused,
      quotaHolds?.[0]?.reason,
      runs.find((j) => j.status === 'queued' && !j.eligible && j.budgetBlock?.targetId === taskId)
        ?.reason,
    );
    const plan = lead?.estimate ?? task?.scheduling;
    return [
      {
        id: taskId,
        column,
        project: project?.name ?? recent?.projectName ?? 'Project',
        title: task?.title ?? recent?.agentName ?? 'Task',
        model: [
          task && stateNames[task.status],
          recent && (agentOf(recent.agentId)?.model ?? recent.provider),
        ]
          .filter(Boolean)
          .join(' · '),
        href: `#/task/${taskId}`,
        reason,
        priority: plan?.priority ?? 'normal',
        weight: project?.policy.weight ?? 1,
        estimate: plan
          ? `~${plan.quotaPercent}% allowance · ~${Math.ceil(plan.expectedSeconds / 60)} min per turn`
          : 'Awaiting a manager estimate',
        resources: lead ? `${lead.estimate.cpuCores} CPU cores · ${lead.estimate.memoryMb} MB` : '',
        actual: lead
          ? `Current turn: ${lead.tokensCharged.toLocaleString()} tokens · ${lead.tokenBasis}`
          : '',
        // Allowance caps come from QUARK's accounting; bounded turn history is never summed.
        budgets: (s?.accounting.budgets ?? []).filter((b) => b.taskId === taskId),
        resume: quotaHolds?.map((h) => h.runId) ?? [],
        team:
          team.length > 1 || turns.length > 1
            ? [team.length && count(team.length, 'agent'), count(turns.length, 'recent turn')]
                .filter(Boolean)
                .join(' · ')
            : '',
      },
    ];
  };
  const groups = new Map<string, Job[]>();
  const order: (Job | string)[] = [];
  for (const j of runs) {
    const group = j.taskId ? groups.get(j.taskId) : undefined;
    if (!j.taskId) order.push(j);
    else if (group) group.push(j);
    else {
      groups.set(j.taskId, [j]);
      order.push(j.taskId);
    }
  }
  for (const t of state?.tasks ?? [])
    if (!groups.has(t.id)) {
      groups.set(t.id, []);
      order.push(t.id);
    }
  const workCards = order.flatMap((item) =>
    typeof item === 'string' ? taskCard(item, groups.get(item) ?? []) : [runCard(item)],
  );
  const localCards = (s?.localJobs ?? []).map(
    (j): Card => ({
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
      budgets: [],
      team: '',
      resume: [],
    }),
  );
  const cards = [...workCards, ...localCards];
  const visibleCards = cards.filter(
    (c) =>
      c.column !== 'Completed' ||
      `${c.project} ${c.title} ${c.model}`.toLowerCase().includes(completedSearch.toLowerCase()),
  );
  const boardProjects = (s?.projects ?? []).filter((p) =>
    state?.projects.some((project) => project.id === p.id && !project.internal),
  );
  // Budget and task links land on their card: reveal it behind a filter, search or bounded
  // list, then move focus there so keyboard and screen-reader users arrive with the view.
  useEffect(() => {
    if (!taskId || focusedTask.current === taskId || !s || !state) return;
    const card =
      document.getElementById(`quark-task-${taskId}`) ??
      document.getElementById(`quark-project-${taskId}`);
    if (card) {
      // A card taller than a landscape phone would lose its title when centred.
      const tall = card.offsetHeight > (card.closest('.home-content')?.clientHeight ?? innerHeight);
      card.scrollIntoView({ block: tall ? 'start' : 'center' });
      card.focus({ preventScroll: true });
      focusedTask.current = taskId;
      return;
    }
    if (boardProjects.findIndex((p) => p.id === taskId) >= projectLimit)
      return setProjectLimit(boardProjects.length);
    const target = cards.find((c) => c.id === taskId);
    if (!target) return;
    const shown = target.column === 'Completed' ? 'Completed' : 'all';
    if (filter !== shown && filter !== target.column) return setFilter(shown);
    if (target.column === 'Completed' && !visibleCards.includes(target))
      return setCompletedSearch('');
    const index = visibleCards.filter((c) => c.column === target.column).indexOf(target);
    if (index >= limit(target.column)) setLimits({ ...limits, [target.column]: index + 1 });
  });
  return (
    <section className="flow-page activity-page quark-workspace">
      <FlowHeading label="QUARK" title="QUARK">
        QUARK stands for Queued Usage, Agent Routing Kernel. Tell it what comes first. It
        coordinates the queue, protects your allowance and keeps your decisions.
      </FlowHeading>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {s && reading.error && (
        <p role="alert">
          Spending readings could not update. Showing the last saved readings.{' '}
          <button className="flow-button" onClick={reading.retry}>
            Retry readings
          </button>
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
                <QuarkAllowance
                  key={provider.provider}
                  provider={provider}
                  forecast={
                    room === null
                      ? 'Waiting for a fresh reading before starting more work.'
                      : demand <= room
                        ? 'The queued work fits the available allowance.'
                        : 'Some queued work will need to wait for more allowance.'
                  }
                />
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
                      (s.settings.model.model ||
                        `Latest ${familyName(s.settings.model.family)}`)}{' '}
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
              <h2>Projects and budgets</h2>
              <p className="quark-budget-help">
                Managers set starting task budgets. Adjust a slider to change one; it saves on
                release. Spending updates automatically.
              </p>
              <small className="quark-budget-help">
                Percentages refer to the full allowance. Project limits and the shared reserve still
                apply.
              </small>
            </div>
            <a className="flow-button" href="#/projects">
              Projects <ArrowUpRight size={16} />
            </a>
          </div>
          <div className="quark-projects">
            {boardProjects.slice(0, projectLimit).map((p) => (
              <article
                key={p.id}
                id={`quark-project-${p.id}`}
                className={`quark-project-card${p.id === taskId ? ' is-target' : ''}`}
                tabIndex={p.id === taskId ? -1 : undefined}
              >
                <a href={`#/project/${p.id}`}>
                  <strong>{p.name}</strong>
                  <ArrowUpRight size={15} />
                </a>
                <span>{p.policy.paused ? 'Paused' : `Priority weight ${p.policy.weight}`}</span>
                {p.policy.instruction && <small>{p.policy.instruction}</small>}
                {s.accounting.budgets
                  .filter((b) => b.projectId === p.id && !b.taskId)
                  .map(budgetSlider)}
                {!s.accounting.budgets.some((b) => b.projectId === p.id && !b.taskId) && (
                  <small>
                    {s.accounting.budgets.some((b) => b.projectId === p.id)
                      ? 'No project cap. Task budgets are on the cards below.'
                      : 'No allowance cap set. The shared reserve still applies.'}
                  </small>
                )}
              </article>
            ))}
            {boardProjects.length > projectLimit && (
              <button
                className="flow-button quark-more-projects"
                onClick={() => setProjectLimit(boardProjects.length)}
              >
                Show all {boardProjects.length} projects
              </button>
            )}
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
                  setLimits({ ...limits, Completed: undefined });
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
                      .slice(0, limit(column))
                      .map((c) => (
                        <article
                          key={c.id}
                          id={`quark-task-${c.id}`}
                          className={`quark-ticket${c.id === taskId ? ' is-target' : ''}`}
                          tabIndex={c.id === taskId ? -1 : undefined}
                        >
                          <span className="quark-ticket-project">{c.project}</span>
                          <h4>
                            <a href={c.href}>{c.title}</a>
                          </h4>
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
                              {c.team && (
                                <span>
                                  <Users size={13} />
                                  {c.team}
                                </span>
                              )}
                            </div>
                          )}
                          {column !== 'Completed' && c.budgets.map(budgetSlider)}
                          {column !== 'Completed' && c.resume.length > 0 && (
                            <button
                              className="flow-button quark-continue"
                              disabled={busy}
                              onClick={() => void continueWork(c.resume)}
                            >
                              Continue work
                            </button>
                          )}
                          <footer>
                            <span>
                              {column === 'Completed'
                                ? c.team || c.actual || 'Open details'
                                : `${c.priority} · weight ${c.weight}`}
                            </span>
                            <a href={c.href} aria-label={`Open ${c.title}`}>
                              <ArrowUpRight size={15} />
                            </a>
                          </footer>
                        </article>
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
                    {visibleCards.filter((c) => c.column === column).length > limit(column) && (
                      <button
                        className="flow-button"
                        onClick={() =>
                          setLimits({ ...limits, [column]: limit(column) + pageSize(column) })
                        }
                      >
                        Show{' '}
                        {Math.min(
                          pageSize(column),
                          visibleCards.filter((c) => c.column === column).length - limit(column),
                        )}{' '}
                        more
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
        if (alive) setError(e instanceof Error ? e.message : String(e));
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
          <option value="">
            {latestFamily(catalog, draft.model.family)
              ? `${latestFamily(catalog, draft.model.family)!.label} · latest available (default)`
              : `Latest ${familyName(draft.model.family)} (default)`}
          </option>
          {draft.model.model && !catalog.some((m) => m.id === draft.model.model) && (
            <option value={draft.model.model}>{draft.model.model} · saved choice</option>
          )}
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
