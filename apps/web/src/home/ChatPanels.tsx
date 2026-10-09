import { agentName } from '../agentName';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Quote, X } from 'lucide-react';
import { quarkStatusSchema, type Agent, type Project, type Snapshot } from '@dock/shared';
import { api, ApiError } from '../api';
import { ExecutionInfo } from '../ExecutionInfo';
import { SessionSettings } from '../SessionSettings';
import { ChatQuarkPreference } from './ChatQuarkPreference';
import {
  parseNotes,
  parseProjectRates,
  parseWorkItems,
  type ProjectNotes,
  type ProjectRate,
  type WorkItem,
} from './chat-contracts';
import { ProjectSettings } from './ProjectConfiguration';
import { ProjectFocus } from './ProjectFocus';
import { TeamActivity } from './TeamActivity';
import type { HomeData } from './useHomeData';
import { workerActivity, workerRoute, workerTaskStatus } from './worker-activity';

export type ChatPanel = 'notes' | 'subagents' | 'config';
const panelTitles: Record<ChatPanel, string> = {
  notes: 'Notes and to-dos',
  subagents: 'Subagents',
  config: 'Configuration',
};
const listLimit = 50;
const when = (value: string) =>
  new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
const failure = (reason: unknown, missing: string) =>
  reason instanceof ApiError && reason.status === 404
    ? missing
    : reason instanceof Error
      ? reason.message
      : 'The computer could not be reached. Try again.';
/** One receipt key per exact request, so a retry cannot apply a change twice. */
function useReceipts() {
  const keys = useRef(new Map<string, string>());
  return {
    key: (signature: string) => {
      let key = keys.current.get(signature);
      if (!key) keys.current.set(signature, (key = crypto.randomUUID()));
      return key;
    },
    done: (signature: string) => keys.current.delete(signature),
  };
}
/** GET-only polling while visible; opening a panel never starts model work. */
function usePoll(read: () => Promise<void>, deps: unknown[], every = 15_000) {
  useEffect(() => {
    void read();
    const timer = window.setInterval(() => {
      if (!document.hidden) void read();
    }, every);
    return () => window.clearInterval(timer);
  }, deps);
}

export function PanelFrame({
  panel,
  close,
  children,
}: {
  panel: ChatPanel;
  close: () => void;
  children: ReactNode;
}) {
  return (
    <aside className="chat-side" aria-label={panelTitles[panel]}>
      <header className="chat-side-head">
        <h2>{panelTitles[panel]}</h2>
        <button type="button" className="chat-icon-button" aria-label="Close panel" onClick={close}>
          <X size={18} />
        </button>
      </header>
      <div className="chat-side-body">{children}</div>
    </aside>
  );
}

const statusNames: Record<WorkItem['status'], string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting: 'Waiting for you',
  done: 'Done',
};
const kindNames: Record<WorkItem['kind'], string> = {
  human: 'to-do for you',
  internal: 'internal to-do',
  general: 'to-do',
  idea: 'idea',
};

export function NotesPanel({
  project,
  managerId,
  onReference,
  answerId,
}: {
  project: Project;
  managerId: string;
  onReference: (text: string) => void;
  answerId?: string;
}) {
  const [notes, setNotes] = useState<ProjectNotes | null>(null);
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [notesError, setNotesError] = useState('');
  const [itemsError, setItemsError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [replying, setReplying] = useState<Record<string, string>>({});
  useEffect(() => {
    if (answerId) setReplying((old) => ({ ...old, [answerId]: old[answerId] ?? '' }));
  }, [answerId]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const receipts = useReceipts();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const read = async () => {
    await Promise.all([
      api(`/projects/${project.id}/notes`)
        .then((value) => {
          if (!alive.current) return;
          setNotes(parseNotes(value));
          setNotesError('');
        })
        .catch((reason: unknown) => {
          if (alive.current)
            setNotesError(
              failure(reason, 'Project notes are not available from this computer yet.'),
            );
        }),
      api(`/work-items?projectId=${encodeURIComponent(project.id)}`)
        .then((value) => {
          if (!alive.current) return;
          setItems(parseWorkItems(value));
          setItemsError('');
        })
        .catch((reason: unknown) => {
          if (alive.current)
            setItemsError(failure(reason, 'To-dos are not available from this computer yet.'));
        }),
    ]);
  };
  usePoll(read, [project.id]);
  const act = async (
    label: string,
    signature: string,
    body: Record<string, unknown>,
    path: string,
  ) => {
    setBusy(label);
    setActionError('');
    try {
      await api(path, { key: receipts.key(signature), ...body });
      receipts.done(signature);
      await read();
      return true;
    } catch (reason) {
      setActionError(failure(reason, 'This action is not available from this computer yet.'));
      return false;
    } finally {
      if (alive.current) setBusy('');
    }
  };
  const paragraphs = (notes?.text ?? '')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const open = (items ?? []).filter((item) => item.status !== 'done');
  const selected = items?.find((item) => item.id === answerId);
  const human = open.filter((item) => item.kind !== 'internal' && item.id !== selected?.id);
  const internal = open.filter((item) => item.kind === 'internal');
  const done = (items ?? []).filter((item) => item.status === 'done').slice(0, listLimit);
  const reference = (item: WorkItem) =>
    onReference(`Re: ${kindNames[item.kind]} “${item.title}” (id ${item.id})`);
  const row = (item: WorkItem) => (
    <li key={item.id} className={`chat-item ${item.kind}`}>
      <div className="chat-item-text">
        <strong>{item.title}</strong>
        {item.detail && <p>{item.detail}</p>}
        <small>
          {statusNames[item.status]} · updated {when(item.updatedAt)}
          {item.humanReply ? ' · answered' : ''}
        </small>
      </div>
      <div className="chat-item-actions">
        <button type="button" className="chat-small-button" onClick={() => reference(item)}>
          <Quote size={15} /> Reference
        </button>
        {item.kind === 'human' && item.status !== 'done' && !item.humanReply && item.managerId && (
          <button
            type="button"
            className="chat-small-button"
            aria-expanded={item.id in replying}
            onClick={() =>
              setReplying((old) => {
                const next = { ...old };
                if (item.id in next) delete next[item.id];
                else next[item.id] = '';
                return next;
              })
            }
          >
            {item.id in replying ? 'Hide answer' : 'Reply'}
          </button>
        )}
        {item.kind === 'general' && !item.managerId && (
          <button
            type="button"
            className="chat-small-button"
            disabled={!!busy}
            onClick={() =>
              void act(
                `assign:${item.id}`,
                `assign:${item.id}:${item.revision}`,
                { id: item.id, expectedRevision: item.revision, managerId },
                '/work-items',
              )
            }
          >
            Ask the manager to handle it
          </button>
        )}
      </div>
      {item.id in replying &&
        item.kind === 'human' &&
        item.status !== 'done' &&
        !item.humanReply &&
        item.managerId && (
          <form
            className="chat-reply"
            onSubmit={(event) => {
              event.preventDefault();
              const text = replying[item.id]?.trim();
              if (!text) return;
              void act(
                `reply:${item.id}`,
                `reply:${item.id}:${item.revision}:${text}`,
                { id: item.id, expectedRevision: item.revision, humanReply: text },
                '/work-items',
              ).then((sent) => {
                if (sent)
                  setReplying((old) => {
                    const next = { ...old };
                    delete next[item.id];
                    return next;
                  });
              });
            }}
          >
            <label>
              Your answer
              <textarea
                value={replying[item.id]}
                maxLength={8000}
                rows={3}
                onChange={(event) =>
                  setReplying((old) => ({ ...old, [item.id]: event.target.value }))
                }
              />
            </label>
            <p>Sends this answer to the manager once, linked to this to-do.</p>
            <button type="submit" className="chat-small-button primary" disabled={!!busy}>
              {busy === `reply:${item.id}` ? 'Sending…' : 'Send answer'}
            </button>
          </form>
        )}
    </li>
  );
  return (
    <div className="chat-notes">
      {answerId && (
        <section aria-label="Selected request">
          <div className="chat-side-section">
            <h3>
              {selected?.humanReply || selected?.status === 'done'
                ? 'Request resolved'
                : 'Needs your answer'}
            </h3>
          </div>
          {selected ? (
            <ul className="chat-item-list">{row(selected)}</ul>
          ) : (
            <p className="chat-side-empty">
              {items
                ? 'This request is no longer available in this project.'
                : 'Loading the request…'}
            </p>
          )}
        </section>
      )}
      {actionError && (
        <p className="chat-panel-error" role="alert">
          {actionError}
        </p>
      )}
      <section>
        <div className="chat-side-section">
          <h3>Notes</h3>
          {notes && editing === null && (
            <button
              type="button"
              className="chat-small-button"
              onClick={() => setEditing(notes.text)}
            >
              Edit
            </button>
          )}
        </div>
        {notesError && <p className="chat-panel-error">{notesError}</p>}
        {editing !== null && notes ? (
          <form
            className="chat-reply"
            onSubmit={(event) => {
              event.preventDefault();
              void act(
                'notes',
                `notes:${notes.revision}:${editing}`,
                { expectedRevision: notes.revision, text: editing },
                `/projects/${project.id}/notes`,
              ).then((saved) => {
                if (saved) setEditing(null);
              });
            }}
          >
            <label>
              Project notes
              <textarea
                value={editing}
                maxLength={24_000}
                rows={10}
                onChange={(event) => setEditing(event.target.value)}
              />
            </label>
            <div className="chat-item-actions">
              <button type="submit" className="chat-small-button primary" disabled={!!busy}>
                {busy === 'notes' ? 'Saving…' : 'Save notes'}
              </button>
              <button type="button" className="chat-small-button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        ) : paragraphs.length ? (
          <ol className="chat-note-list">
            {(showAll ? paragraphs : paragraphs.slice(0, 12)).map((paragraph, index) => (
              <li key={index}>
                <p>{paragraph}</p>
                <button
                  type="button"
                  className="chat-small-button"
                  onClick={() =>
                    onReference(
                      `Re: project note:\n${paragraph
                        .split('\n')
                        .map((line) => `> ${line}`)
                        .join('\n')}`,
                    )
                  }
                >
                  <Quote size={15} /> Reference
                </button>
              </li>
            ))}
          </ol>
        ) : (
          notes && <p className="chat-side-empty">Your notes go here. Only you can edit them.</p>
        )}
        {paragraphs.length > 12 && (
          <button type="button" className="chat-small-button" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${paragraphs.length} notes`}
          </button>
        )}
      </section>
      <section>
        <div className="chat-side-section">
          <h3>To do</h3>
          <span>{items ? human.length : '—'}</span>
        </div>
        {itemsError && <p className="chat-panel-error">{itemsError}</p>}
        {items && (
          <>
            <ul className="chat-item-list">{human.slice(0, listLimit).map(row)}</ul>
            {!human.length && <p className="chat-side-empty">Nothing needs you right now.</p>}
            <form
              className="chat-add"
              onSubmit={(event) => {
                event.preventDefault();
                const value = title.trim();
                if (!value) return;
                void act(
                  'add',
                  `add:${value}`,
                  { projectId: project.id, kind: 'general', title: value },
                  '/work-items',
                ).then((saved) => {
                  if (saved) setTitle('');
                });
              }}
            >
              <label>
                Add a to-do
                <input
                  value={title}
                  maxLength={240}
                  placeholder="One line"
                  onChange={(event) => setTitle(event.target.value.replace(/[\r\n]/g, ' '))}
                />
              </label>
              <button
                type="submit"
                className="chat-small-button"
                disabled={!!busy || !title.trim()}
              >
                Add
              </button>
            </form>
          </>
        )}
      </section>
      <section>
        <div className="chat-side-section">
          <h3>Internal to do</h3>
          <span>{items ? internal.length : '—'}</span>
        </div>
        <ul className="chat-item-list">{internal.slice(0, listLimit).map(row)}</ul>
        {items && !internal.length && (
          <p className="chat-side-empty">The manager’s own to-dos appear here.</p>
        )}
      </section>
      {done.length > 0 && (
        <details className="chat-done">
          <summary>Completed ({done.length})</summary>
          <ul className="chat-item-list">{done.map(row)}</ul>
        </details>
      )}
      <p className="chat-side-note">
        Referencing adds the item to your message. It does not send, answer or complete anything.
      </p>
    </div>
  );
}

export function SubagentsPanel({
  state,
  manager,
  stale = false,
  retry,
}: {
  state: Snapshot;
  manager: Agent;
  stale?: boolean;
  retry?: () => void;
}) {
  const [tokens, setTokens] = useState<Map<string, { total: number | null; partial: boolean }>>(
    new Map(),
  );
  const [tokenError, setTokenError] = useState(false);
  const [limit, setLimit] = useState(listLimit);
  usePoll(
    async () => {
      try {
        const status = quarkStatusSchema.parse(await api('/quark'));
        const next = new Map<string, { total: number | null; partial: boolean }>();
        for (const row of status.totals) {
          if (!row.agentId) continue;
          const old = next.get(row.agentId);
          const total = row.tokens.totalTokens;
          next.set(row.agentId, {
            total: old?.total == null || total == null ? (old?.total ?? total) : old.total + total,
            partial: !!old?.partial || row.incompleteRuns > 0 || row.nativeOverlap,
          });
        }
        setTokens(next);
        setTokenError(false);
      } catch {
        setTokenError(true);
      }
    },
    [manager.id],
    30_000,
  );
  const team = state.agents
    .filter(
      (a) =>
        a.id !== manager.id &&
        !a.interview &&
        (a.nativeRootId === manager.id ||
          (a.projectId === manager.projectId && a.role !== 'manager')),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="chat-subagents">
      <section aria-label="Workers">
        <div className="chat-side-section">
          <h3>Workers</h3>
          <span>{team.length}</span>
        </div>
        {stale && (
          <div className="team-activity-error" role="status">
            <p>Could not refresh worker activity. Showing the last reported states.</p>
            {retry && (
              <button className="chat-small-button" onClick={retry}>
                Retry worker activity
              </button>
            )}
          </div>
        )}
        {tokenError && (
          <p className="chat-panel-error">Token readings are unavailable right now.</p>
        )}
        <ul className="chat-item-list">
          {team.slice(0, limit).map((agent) => {
            const task = state.tasks.find((t) => t.id === agent.taskId);
            const closed =
              !!task && ['done', 'integrated', 'split', 'cancelled'].includes(task.status);
            const reading = tokens.get(agent.id);
            const activity = workerActivity(agent);
            const summary = task?.title ?? (agent.scope || 'No saved assignment');
            return (
              <li key={agent.id} className="chat-item worker-card" data-agent={agent.id}>
                <div className="chat-item-text">
                  <div className="worker-heading">
                    <strong>{agentName(agent)}</strong>
                    <span className={`worker-state ${stale ? 'stale' : activity.state}`}>
                      {stale ? 'Last reported: ' : ''}
                      {activity.label}
                    </span>
                  </div>
                  <p>Assignment: {summary}</p>
                  {task && <p>Task: {workerTaskStatus(task)}</p>}
                  {agent.latestRun && (
                    <small>
                      Last run requested{' '}
                      <time dateTime={agent.latestRun.createdAt}>
                        {when(agent.latestRun.createdAt)}
                      </time>
                    </small>
                  )}
                  <div className="worker-checkpoint">
                    <small>
                      Last saved checkpoint{agent.checkpoint ? ' · time not recorded' : ''}
                    </small>
                    {agent.checkpoint ? (
                      <details>
                        <summary>{agent.checkpoint.split('\n')[0]?.slice(0, 200)}</summary>
                        <p>{agent.checkpoint}</p>
                      </details>
                    ) : (
                      <p>No checkpoint recorded.</p>
                    )}
                  </div>
                  <small>
                    Spawned {when(agent.createdAt)} ·{' '}
                    {agent.model ?? agent.assignment?.model ?? 'model not reported'} ·{' '}
                    {reading?.total != null
                      ? `${reading.total.toLocaleString()} tokens${reading.partial ? ' (partial)' : ''}`
                      : 'tokens not reported'}
                    {agent.nativeRootId ? ' · native helper' : ''}
                  </small>
                </div>
                <div className="chat-item-actions">
                  <a className="chat-small-button" href={workerRoute(manager.id, agent.id)}>
                    {closed ? 'Ask about this work' : 'Open activity'} <ArrowUpRight size={15} />
                  </a>
                  {task && (
                    <a className="chat-small-button" href={`#/task/${task.id}`}>
                      Task record
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {!team.length && (
          <p className="chat-side-empty">
            No subagents yet. The manager brings in workers once there is work to delegate.
          </p>
        )}
        {team.length > limit && (
          <button
            type="button"
            className="chat-small-button"
            onClick={() => setLimit((value) => value + listLimit)}
          >
            Show more ({team.length - limit} left)
          </button>
        )}
        <p className="chat-side-note">
          Token counts are provider-reported QUARK measurements; missing values are unknown, not
          zero. Turn completion does not complete the task or its background jobs. Closed tasks
          retain their saved record and offer a separate read-only discussion.
        </p>
      </section>
      <TeamActivity key={manager.id} manager={manager} state={state} />
    </div>
  );
}

export function ConfigPanel({
  agent,
  project,
  state,
  data,
  managerView,
  act,
}: {
  agent: Agent;
  project: Project | undefined;
  state: Snapshot;
  data: HomeData;
  managerView: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [rates, setRates] = useState<ProjectRate[] | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const removeKey = useRef(crypto.randomUUID());
  const remove = async () => {
    setRemoveBusy(true);
    setRemoveError('');
    try {
      await api(`/agents/${agent.id}/remove`, { key: removeKey.current });
      window.location.hash = '/chats';
    } catch (reason) {
      setRemoveError(failure(reason, 'Could not remove this manager. Try again.'));
    } finally {
      setRemoveBusy(false);
    }
  };
  const [ratesError, setRatesError] = useState('');
  usePoll(
    async () => {
      if (!project) return;
      try {
        const value = parseProjectRates(await api('/project-rates'));
        setRates(value.rates.filter((rate) => rate.projectId === project.id));
        setRatesError('');
      } catch (reason) {
        setRatesError(failure(reason, 'Project usage rates are not available yet.'));
      }
    },
    [project?.id],
    60_000,
  );
  const task = state.tasks.find((t) => t.id === agent.taskId);
  const closed = !!task && ['done', 'integrated', 'split', 'cancelled'].includes(task.status);
  const team = state.agents.filter(
    (a) => a.projectId === agent.projectId && a.id !== agent.id && a.role !== 'manager',
  );
  const jobs = data.work.data?.jobs.filter((job) => job.agentId === agent.id) ?? [];
  const machine = data.capacity.data?.machine;
  const fresh = !!machine && Date.now() - Date.parse(machine.observedAt) < 60_000;
  return (
    <div className="chat-config">
      <section>
        {!(managerView && project) && <h3>Session settings</h3>}
        {managerView && project ? (
          <ProjectSettings project={project} manager={agent} act={act} />
        ) : agent.nativeRootId || closed ? (
          <p>
            This saved record keeps its original model. Settings belong to its owning conversation.
          </p>
        ) : (
          <SessionSettings agent={agent} close={() => {}} act={act} embedded titled={false} />
        )}
      </section>
      <section>
        <h3>Usage and resources</h3>
        <dl className="chat-facts">
          <div>
            <dt>Conversation started</dt>
            <dd>{when(agent.createdAt)}</dd>
          </div>
          {managerView && (
            <div>
              <dt>Subagents</dt>
              <dd>
                {team.length} total · {team.filter((a) => a.status === 'running').length} working
              </dd>
            </div>
          )}
          <div>
            <dt>This computer</dt>
            <dd>
              {fresh
                ? `${machine.cpuUsedPercent === null ? 'CPU not measured' : `${Math.round(machine.cpuUsedPercent)}% CPU in use`} · ${(machine.memoryAvailableBytes / 1024 ** 3).toFixed(1)} GB memory available`
                : 'Waiting for a fresh reading'}{' '}
              <a href="#/resources">Details</a>
            </dd>
          </div>
        </dl>
        {project && (
          <div className="chat-rates">
            <h4>Project usage rate (estimated)</h4>
            {ratesError && <p className="chat-panel-error">{ratesError}</p>}
            {rates?.length === 0 && <p>No usage has been attributed to this project yet.</p>}
            <ul>
              {rates?.map((rate) => (
                <li key={`${rate.provider}:${rate.label}`}>
                  {rate.provider === 'codex' ? 'Codex' : 'Claude'} {rate.label}:{' '}
                  {rate.estimatedPercentPerHour === null
                    ? 'still measuring'
                    : `about ${rate.estimatedPercentPerHour.toFixed(1)}% of the window per hour`}
                  {rate.stale ? ' · last reading' : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Optional, read-only detail: mounted only when opened, and it never starts work. */}
        <details
          className="chat-usage-details"
          onToggle={(event) => setUsageOpen(event.currentTarget.open)}
        >
          <summary>Reported usage and assignment</summary>
          {usageOpen && <ExecutionInfo agent={agent} />}
        </details>
      </section>
      <section>
        <h3>Scheduling</h3>
        {!managerView &&
          agent.role === 'manager' &&
          !agent.taskId &&
          !agent.nativeRootId &&
          !agent.interview &&
          agent.surface !== 'terminal' &&
          !agent.archivedAt && <ChatQuarkPreference key={agent.id} agentId={agent.id} />}
        {jobs.length ? (
          <ul className="chat-item-list">
            {jobs.map((job) => (
              <li key={job.runId} className="chat-item">
                <div className="chat-item-text">
                  <strong>{job.status}</strong>
                  <p>{job.reason}</p>
                </div>
                <a className="chat-small-button" href={`#/job/${job.runId}`}>
                  Job controls <ArrowUpRight size={15} />
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p>No queued or running job for this conversation.</p>
        )}
        {managerView && project && <ProjectFocus project={project} state={state} />}
        <p className="chat-side-note">
          Each message also has its own priority in the composer. You can pause or reprioritize
          individual jobs in QUARK.
        </p>
        <a className="chat-small-button" href="#/work">
          Open QUARK <ArrowUpRight size={15} />
        </a>
      </section>
      <section>
        <h3>More controls</h3>
        <div className="chat-links">
          {managerView && project && (
            <a className="chat-small-button" href={`#/project/${project.id}`}>
              Project overview <ArrowUpRight size={15} />
            </a>
          )}
          <a className="chat-small-button" href={`#/advanced/${agent.id}`}>
            Advanced controls <ArrowUpRight size={15} />
          </a>
          {task && (
            <a className="chat-small-button" href={`#/task/${task.id}`}>
              View task and team <ArrowUpRight size={15} />
            </a>
          )}
          <a className="chat-small-button" href={`#/search/${agent.projectId}`}>
            Saved history <ArrowUpRight size={15} />
          </a>
          <a className="chat-small-button" href="#/workspace">
            Open conversations <ArrowUpRight size={15} />
          </a>
          <a className="chat-small-button" href="#/work">
            QUARK budgets <ArrowUpRight size={15} />
          </a>
        </div>
      </section>
      {managerView && !agent.archivedAt && (
        <section>
          <h3>Manager</h3>
          <div className="chat-remove-manager">
            {removing ? (
              <>
                <p>
                  Remove this manager from Chats? Queued work will be cancelled. Project files and
                  saved conversation history will stay on this computer. Running work must be
                  stopped first.
                </p>
                <div className="chat-links">
                  <button
                    className="chat-small-button"
                    disabled={removeBusy}
                    onClick={() => void remove()}
                  >
                    {removeBusy ? 'Removing…' : 'Confirm removal'}
                  </button>
                  <button
                    className="chat-small-button"
                    disabled={removeBusy}
                    onClick={() => setRemoving(false)}
                  >
                    Keep manager
                  </button>
                </div>
              </>
            ) : (
              <button className="chat-small-button" onClick={() => setRemoving(true)}>
                Remove manager
              </button>
            )}
            {removeError && (
              <p className="chat-panel-error" role="alert">
                {removeError}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
