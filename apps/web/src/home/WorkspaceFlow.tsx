import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  MessageCircle,
  NotebookPen,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Terminal,
  Users,
} from 'lucide-react';
import { agentSchema, type Agent, type AgentDetail, type Snapshot, type Task } from '@dock/shared';
import { api, apiUrl, detail } from '../api';
import { Conversation, Composer } from '../Conversation';
import { TaskModal, ManagerModal } from '../ProjectActions';
import { ProjectTools } from './ProjectTools';
import { SourceBackup } from './SourceBackup';
import { TaskProgress } from './TaskProgress';
import { useWorkspaceState } from '../useWorkspaceState';
import {
  useMirrorChats,
  mirrorDaemon,
  mirrorKey,
  mirrorProvider,
  mirrorStatus,
  type MirrorChat,
} from '../useMirrorChats';
import { VscodeMirror } from '../VscodeMirror';
import { ProjectConfiguration } from './ProjectConfiguration';
import { NewConversation } from './NewConversation';
import { AssistedSearch } from './AssistedSearch';
import { EditorStatus } from './EditorStatus';
import { surfaceOf } from './chat-contracts';
import { ConfigPanel, NotesPanel, PanelFrame, SubagentsPanel, type ChatPanel } from './ChatPanels';
import type { HomeData } from './useHomeData';
import { resourceAssistantOf } from './resource-chat';
import './workspace-flow.css';

export const flowPages = new Set([
  'projects',
  'project',
  'new',
  'chats',
  'managers',
  'chat',
  'task',
]);
export const stateNames: Record<string, string> = {
  idle: 'Ready',
  queued: 'Waiting in QUARK',
  running: 'Working',
  waiting: 'Needs your input',
  interrupted: 'Paused',
  failed: 'Needs attention',
  open: 'Not started',
  working: 'In progress',
  review: 'Being reviewed',
  needs_decision: 'Decision needed',
  done: 'Completed',
  integrated: 'Changes applied',
  split: 'Split into smaller tasks',
  cancelled: 'Closed',
};
const closed = (task?: Task) =>
  !!task && ['done', 'integrated', 'split', 'cancelled'].includes(task.status);
const go = (page: string, id?: string) => `#/${page}${id ? `/${encodeURIComponent(id)}` : ''}`;

export function FlowHeading({
  label,
  title,
  children,
  action,
}: {
  label: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flow-heading">
      <div>
        <p className="home-eyebrow">{label}</p>
        <h1 tabIndex={-1}>{title}</h1>
        <p className="flow-subtitle">{children}</p>
      </div>
      {action}
    </header>
  );
}
export function FlowEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flow-empty">
      <FolderOpen size={28} />
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
function AgentLink({ agent, caption }: { agent: Agent; caption?: string }) {
  return (
    <a className="flow-person" href={go('chat', agent.id)}>
      <span className={`flow-avatar ${agent.role === 'manager' ? 'manager' : ''}`}>
        {agent.role === 'manager' ? <Users size={19} /> : <MessageCircle size={19} />}
      </span>
      <span>
        <strong>{agent.name}</strong>
        <small>
          {caption ??
            `${agent.provider === 'codex' ? 'Codex' : 'Claude'} · ${agent.interview ? 'Read-only discussion' : agent.role}`}
        </small>
      </span>
      <span className={`flow-state ${agent.status}`}>{stateNames[agent.status]}</span>
      <ArrowUpRight size={16} />
    </a>
  );
}
function TaskLink({ task }: { task: Task }) {
  return (
    <a className="flow-person" href={go('task', task.id)}>
      <span className="flow-avatar">
        {closed(task) ? <Check size={18} /> : <FolderOpen size={18} />}
      </span>
      <span>
        <strong>{task.title}</strong>
        <small>{task.goal}</small>
      </span>
      <span className={`flow-state ${task.status}`}>
        {task.status === 'done' && task.hasReviewedChanges
          ? 'Ready to apply'
          : stateNames[task.status]}
      </span>
      <ArrowUpRight size={16} />
    </a>
  );
}

export function WorkspaceFlow({ route, data }: { route: string; data: HomeData }) {
  const [page, target] = route.split('/');
  const state = data.snapshot.data;
  const [adding, setAdding] = useState<'task' | 'manager' | null>(null);
  useEffect(() => {
    setAdding(null);
  }, [page, target]);
  if (!state)
    return (
      <section className="flow-page">
        <FlowHeading label="YOUR WORKSPACE" title="Workspace">
          Projects and conversations stay on this computer.
        </FlowHeading>
        <FlowEmpty
          title={data.snapshot.error ? 'The computer is unavailable' : 'Opening your workspace…'}
        >
          {data.snapshot.error ? (
            <button className="flow-button" onClick={data.snapshot.retry}>
              Try again
            </button>
          ) : (
            'Your saved work will appear here.'
          )}
        </FlowEmpty>
      </section>
    );
  const refresh = () => {
    data.snapshot.retry();
    window.dispatchEvent(new Event('swa:refresh-home'));
  };
  if (page === 'chat' || page === 'chats' || page === 'managers')
    return <MainChat route={route} data={data} state={state} refresh={refresh} />;
  if (page === 'new' && (target === 'chat' || target === 'terminal'))
    return (
      <NewConversation
        key={target}
        terminal={target === 'terminal'}
        heading={
          <FlowHeading
            label={target === 'terminal' ? 'ADVANCED · NATIVE TERMINAL' : 'A NEW CHAT'}
            title={target === 'terminal' ? 'Start a terminal session' : 'Start a chat'}
          >
            {target === 'terminal'
              ? 'A native Codex terminal with its own history. It stays out of your chat list.'
              : 'A saved conversation outside your projects. Nothing runs until you send a message.'}
          </FlowHeading>
        }
        onCreated={(agentId) => {
          refresh();
          location.hash = target === 'terminal' ? go('advanced', agentId) : go('chat', agentId);
        }}
      />
    );
  if (page === 'new')
    return (
      <ProjectConfiguration
        heading={
          <FlowHeading label="A NEW PROJECT" title="Start or connect a project">
            Name it, choose its manager and how its team works. Nothing runs until you send the
            first request.
          </FlowHeading>
        }
        onCreated={(managerId, fresh) => {
          refresh();
          location.hash = fresh ? `${go('chat', managerId)}/brief` : go('chat', managerId);
        }}
      />
    );
  if (page === 'project') {
    const project = state.projects.find((item) => item.id === target);
    if (!project)
      return (
        <FlowEmpty title="Project not available">
          <a href={go('projects')}>Return to your projects</a>
        </FlowEmpty>
      );
    const team = state.agents.filter(
      (a) => a.projectId === target && a.role === 'manager' && !a.nativeRootId,
    );
    const tasks = state.tasks.filter((t) => t.projectId === target);
    return (
      <section className="flow-page">
        <FlowHeading
          label="PROJECT OVERVIEW"
          title={project.name}
          action={
            <a className="flow-button primary" href={go('chat', project.managerId)}>
              <MessageCircle size={17} /> Talk to manager
            </a>
          }
        >
          {project.description || 'Your project’s managers, tasks and results in one place.'}
        </FlowHeading>
        <div className="flow-stats">
          <div>
            <strong>{tasks.filter((t) => !closed(t)).length}</strong>
            <span>Active tasks</span>
          </div>
          <div>
            <strong>
              {state.agents.filter((a) => a.projectId === target && !a.interview).length}
            </strong>
            <span>Team members</span>
          </div>
          <div>
            <strong>{tasks.filter(closed).length}</strong>
            <span>Finished tasks</span>
          </div>
        </div>
        <div className="flow-columns">
          <section className="flow-panel">
            <div className="flow-section-title">
              <h2>Work in progress</h2>
              <button className="flow-button" onClick={() => setAdding('task')}>
                <Plus size={16} /> Add task
              </button>
            </div>
            {tasks.length ? (
              tasks.map((task) => <TaskLink key={task.id} task={task} />)
            ) : (
              <FlowEmpty title="Start with an outcome">
                Tell your manager what you want to achieve and how you’ll know it worked.
              </FlowEmpty>
            )}
          </section>
          <section className="flow-panel">
            <div className="flow-section-title">
              <h2>Your managers</h2>
              <button className="flow-button" onClick={() => setAdding('manager')}>
                <Plus size={16} /> Add manager
              </button>
            </div>
            {team.map((agent) => (
              <AgentLink key={agent.id} agent={agent} caption={agent.scope || 'Whole project'} />
            ))}
            <p className="flow-note">
              Your managers coordinate the work and apply reviewed changes. You can require your
              review in project settings.
            </p>
          </section>
        </div>
        <ProjectTools key={project.id} projectId={project.id} />
        <SourceBackup
          key={`backup-${project.id}`}
          projectId={project.id}
          status={state.backups.find((b) => b.projectId === project.id)}
          refresh={refresh}
        />
        {adding === 'task' && (
          <TaskModal
            key={project.id}
            projectId={project.id}
            managers={team}
            initialManagerId={project.managerId}
            close={() => setAdding(null)}
            act={async (fn) => {
              try {
                await fn();
                refresh();
              } catch {
                /* Form owns the error. */
              }
            }}
          />
        )}
        {adding === 'manager' && (
          <ManagerModal
            key={project.id}
            projectId={project.id}
            close={() => setAdding(null)}
            act={async (fn) => {
              try {
                await fn();
                refresh();
              } catch {
                /* Form owns the error. */
              }
            }}
            onCreated={(id) => {
              refresh();
              location.hash = go('chat', id);
            }}
          />
        )}
      </section>
    );
  }
  if (page === 'task') {
    const task = state.tasks.find((item) => item.id === target);
    if (!task)
      return (
        <FlowEmpty title="Task not available">
          <a href={go('projects')}>Return to your projects</a>
        </FlowEmpty>
      );
    const team = state.agents.filter((a) => a.taskId === task.id);
    return (
      <section className="flow-page">
        <FlowHeading
          label="TASK AND TEAM"
          title={task.title}
          action={
            <a className="flow-button" href={go('chat', task.managerId)}>
              Talk to manager <ArrowUpRight size={16} />
            </a>
          }
        >
          {stateNames[task.status]} · {state.projects.find((p) => p.id === task.projectId)?.name}
        </FlowHeading>
        <div className="flow-columns">
          <section className="flow-panel flow-prose">
            <h2>The deliverable</h2>
            <p>{task.goal}</p>
            <h3>What success looks like</h3>
            <p>{task.acceptance}</p>
            <h3>Independent review</h3>
            <p>{task.review ?? 'No review has been recorded yet.'}</p>
            {task.reconciliationTaskId ? (
              <p>
                <a className="flow-button primary" href={go('task', task.reconciliationTaskId)}>
                  Open updated task <ArrowUpRight size={16} />
                </a>
              </p>
            ) : task.status === 'done' && task.hasReviewedChanges ? (
              <p>
                <a className="flow-button primary" href={go('review', task.id)}>
                  Review changes <ArrowUpRight size={16} />
                </a>
              </p>
            ) : null}
            <a className="flow-button" href={go('usage', task.id)}>
              View allowance budgets <ArrowUpRight size={16} />
            </a>
          </section>
          <section className="flow-panel">
            <div className="flow-section-title">
              <h2>Agents</h2>
              <span>{team.length}</span>
            </div>
            {team.length ? (
              team.map((agent) => <AgentLink key={agent.id} agent={agent} />)
            ) : (
              <FlowEmpty title="Your team will appear here">
                Your manager will assign workers when this task is ready.
              </FlowEmpty>
            )}
            <p className="flow-note">
              <ShieldCheck size={17} /> Open a finished worker to explore its saved activity and ask
              about its decisions.
            </p>
          </section>
        </div>
        <TaskProgress key={task.id} task={task} data={data} />
      </section>
    );
  }
  // Saved chats and terminal sessions have private backing projects; they are not work projects.
  const listedProjects = state.projects.filter(
    (project) =>
      !project.internal &&
      project.id !== data.resources.data?.projectId &&
      project.id !== data.frontdesk.data?.projectId &&
      !surfaceOf(state.agents.find((a) => a.id === project.managerId)),
  );
  return (
    <section className="flow-page">
      <FlowHeading
        label="YOUR PROJECTS"
        title="Projects"
        action={
          <a className="flow-button primary" href="#/new">
            <Plus size={18} /> Add project
          </a>
        }
      >
        See what your projects are working toward and how they are progressing.
      </FlowHeading>
      <div className="flow-project-grid">
        {listedProjects.map((project) => {
          const manager = state.agents.find((a) => a.id === project.managerId);
          const tasks = state.tasks.filter((t) => t.projectId === project.id);
          return (
            <a className="flow-project-card" key={project.id} href={go('project', project.id)}>
              <div className="flow-section-title">
                <span className="flow-avatar">
                  <FolderOpen size={21} />
                </span>
                <ArrowUpRight size={20} />
              </div>
              <h2>{project.name}</h2>
              <p>{project.description || 'A place for your ideas, team and results.'}</p>
              <div className="flow-project-meta">
                <span>{manager?.name ?? 'Project manager'}</span>
                <span>{tasks.filter((t) => !closed(t)).length} active tasks</span>
              </div>
            </a>
          );
        })}
      </div>
      {!listedProjects.length && (
        <FlowEmpty title="What would you like to work on?">
          Create your first project, or connect a folder already on this computer.
        </FlowEmpty>
      )}
    </section>
  );
}

type PaneContext = {
  panel: ChatPanel | null;
  setPanel: (panel: ChatPanel | null) => void;
  brief: boolean;
  answerId?: string;
  data: HomeData;
  /** Personal-assistant and resource projects: their chats are Misc, not project managers. */
  special: Set<string>;
};

export function ChatPage({
  id,
  state,
  refresh,
  personal = false,
  embedded = false,
  pane,
}: {
  id: string;
  state: Snapshot;
  refresh: () => void;
  personal?: boolean;
  embedded?: boolean;
  /** Main-chat pane: compact drawn header, side panels and the brief notepad. */
  pane?: PaneContext;
}) {
  const [reference, setReference] = useState<{ nonce: number; text: string } | null>(null);
  const workspace = useWorkspaceState(
    window.matchMedia('(pointer: coarse)').matches ? 'Phone browser' : 'Computer browser',
  );
  const [conversation, setConversation] = useState<AgentDetail | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const interviewKeys = useRef({ evidence: crypto.randomUUID(), native: crypto.randomUUID() });
  const [nativeDiscussion, setNativeDiscussion] = useState(true);
  const alive = useRef(true);
  const read = useCallback(async () => {
    try {
      const value = await detail(id);
      if (alive.current) {
        setConversation(value);
        setConnected(true);
      }
    } catch {
      if (alive.current) setConnected(false);
    }
  }, [id]);
  useEffect(() => {
    alive.current = true;
    let pending = false;
    const reload = () => {
      if (!pending) {
        pending = true;
        void read().finally(() => {
          pending = false;
        });
      }
    };
    reload();
    const source = new EventSource(apiUrl(`/events?after=${state.eventId}`));
    source.addEventListener('change', reload);
    source.addEventListener('reset', reload);
    source.onopen = reload;
    const timer = window.setInterval(reload, 5000);
    return () => {
      alive.current = false;
      source.close();
      window.clearInterval(timer);
    };
  }, [id, read]);
  const agent = conversation?.agent ?? state.agents.find((a) => a.id === id);
  const canForkDiscussion = conversation?.nativeDiscussion === 'available';
  useEffect(() => {
    if (agent && workspace.state && workspace.state.client.selectedAgentId !== id)
      void workspace.open(id);
  }, [id, agent?.id, workspace.state?.client.id]);
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await read();
      refresh();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'The connection was interrupted. Try again.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  if (!agent)
    return (
      <FlowEmpty title="Opening the conversation…">
        <button className="flow-button" onClick={() => void read()}>
          Try again
        </button>
        <a href="#/chats">All conversations</a>
      </FlowEmpty>
    );
  const task = state.tasks.find((t) => t.id === agent.taskId);
  const readOnly = !agent.interview && (closed(task) || !!agent.nativeRootId);
  const approvals = state.approvals.filter((a) => a.agentId === id && a.status === 'pending');
  const project = state.projects.find((p) => p.id === agent.projectId);
  const surface = surfaceOf(agent);
  const managerView =
    !!pane &&
    agent.role === 'manager' &&
    !agent.interview &&
    !surface &&
    !pane.special.has(agent.projectId);
  const panel = pane?.panel && (pane.panel === 'config' || managerView) ? pane.panel : null;
  const togglePanel = (next: ChatPanel) => pane?.setPanel(panel === next ? null : next);
  const onReference = (text: string) => {
    setReference((old) => ({ nonce: (old?.nonce ?? 0) + 1, text }));
    // On narrow screens the panel covers the composer; return to it after referencing.
    if (window.matchMedia('(max-width: 900px)').matches) pane?.setPanel(null);
  };
  const paneHeader = pane && (
    <header className="chat-pane-head">
      <a className="chat-icon-button chat-back" href="#/chats" aria-label="All chats">
        <ChevronLeft size={20} />
      </a>
      <div className="chat-pane-title">
        <p className="chat-pane-project">
          {managerView && project ? (
            <>
              <OpenInEditor projectId={project.id} />
              <a className="chat-project-link" href={go('project', project.id)}>
                {project.name}
              </a>
            </>
          ) : (
            <span>
              {personal
                ? 'Personal conversation'
                : agent.interview
                  ? `Read-only discussion · ${project?.name ?? ''}`
                  : surface === 'misc'
                    ? 'Saved conversation'
                    : surface === 'terminal'
                      ? 'Terminal session'
                      : (project?.name ?? '')}
            </span>
          )}
        </p>
        <h1 tabIndex={-1}>{agent.name}</h1>
        <p className="chat-pane-meta">
          <span className={`chat-dot ${agent.status}`} aria-hidden="true" />
          {agent.provider === 'codex' ? 'Codex' : 'Claude'} ·{' '}
          {agent.model ??
            (agent.nativeRootId ? 'Native model not reported' : 'Central model default')}{' '}
          · {stateNames[agent.status]}
        </p>
      </div>
      <div className="chat-pane-tools" role="group" aria-label="Conversation tools">
        {agent.interview && (
          <a className="chat-tool" href={go('chat', agent.interview.sourceAgentId)}>
            <ArrowLeft size={17} />
            <span className="chat-tool-label">Original worker</span>
          </a>
        )}
        {personal && (
          <a className="chat-tool" href="#/assistant-settings">
            <ShieldCheck size={17} />
            <span className="chat-tool-label">Assistant privacy</span>
          </a>
        )}
        {managerView && (
          <>
            <button
              type="button"
              className="chat-tool"
              aria-pressed={panel === 'notes'}
              onClick={() => togglePanel('notes')}
            >
              <NotebookPen size={17} />
              <span className="chat-tool-label">Notes</span>
            </button>
            <button
              type="button"
              className="chat-tool"
              aria-pressed={panel === 'subagents'}
              onClick={() => togglePanel('subagents')}
            >
              <Users size={17} />
              <span className="chat-tool-label">Subagents</span>
            </button>
          </>
        )}
        <button
          type="button"
          className="chat-tool"
          aria-pressed={panel === 'config'}
          onClick={() => togglePanel('config')}
        >
          <Settings2 size={17} />
          <span className="chat-tool-label">Configure</span>
        </button>
      </div>
    </header>
  );
  const sidePanel = pane && panel && (
    <PanelFrame panel={panel} close={() => pane.setPanel(null)}>
      {panel === 'notes' ? (
        project && (
          <NotesPanel
            project={project}
            managerId={agent.id}
            onReference={onReference}
            answerId={pane.answerId}
          />
        )
      ) : panel === 'subagents' ? (
        <SubagentsPanel state={state} manager={agent} />
      ) : (
        <ConfigPanel
          agent={agent}
          project={project}
          state={state}
          data={pane.data}
          managerView={managerView}
          act={act}
        />
      )}
    </PanelFrame>
  );
  // The pane keeps the notice area for connection, errors and record explanations only.
  const showNotice =
    !pane ||
    !!(error || workspace.error || !connected || agent.interview || agent.nativeRootId || readOnly);
  return (
    <section className={pane ? 'chat-pane-inner flow-chat' : 'flow-page flow-chat'}>
      {pane
        ? paneHeader
        : !embedded && (
            <FlowHeading
              label={
                personal
                  ? 'YOUR PERSONAL AGENT'
                  : agent.interview
                    ? 'ABOUT THIS WORK'
                    : agent.role === 'manager'
                      ? 'MANAGER CONVERSATION'
                      : 'WORKER AND ITS DECISIONS'
              }
              title={agent.name}
              action={
                personal ? (
                  <a className="flow-button" href="#/assistant-settings">
                    Assistant privacy <ShieldCheck size={16} />
                  </a>
                ) : task ? (
                  <a className="flow-button" href={go('task', task.id)}>
                    View task and team <ArrowUpRight size={16} />
                  </a>
                ) : (
                  <a className="flow-button" href={go('project', agent.projectId)}>
                    Project overview <ArrowUpRight size={16} />
                  </a>
                )
              }
            >
              {agent.provider === 'codex' ? 'Codex' : 'Claude'} ·{' '}
              {agent.model ??
                (agent.nativeRootId ? 'Native model not reported' : 'Central model default')}{' '}
              · {stateNames[agent.status]}
            </FlowHeading>
          )}
      {showNotice && (
        <div className="flow-chat-notice" role="status">
          {(error || workspace.error) && <p role="alert">{error || workspace.error}</p>}
          {!connected
            ? 'Connecting to this computer. Your saved messages and draft are retained.'
            : agent.interview
              ? agent.interview.continuity === 'native-fork'
                ? `A separate read-only discussion using the saved ${agent.provider === 'claude' ? 'Claude' : 'Codex'} conversation. ${conversation?.nativeDiscussion === 'prepared' ? 'The native history has been copied.' : 'The copy is prepared when you send your first question.'} The original work and review stay unchanged. If that history is unavailable, open Original worker and choose Saved evidence only.`
                : 'A new read-only discussion using saved evidence. The original task, review and conversation stay unchanged.'
              : agent.nativeRootId
                ? 'Native helper activity is retained here. Direct input and stop controls belong to the owning conversation.'
                : readOnly
                  ? 'This is the saved record. Ask about the work in a separate read-only discussion.'
                  : 'Your draft stays private to this browser. Sending is always your choice.'}
        </div>
      )}
      <div
        className={pane ? `chat-pane-body${sidePanel ? ' with-panel' : ''}` : 'flow-chat-layout'}
      >
        <div className="flow-chat-main">
          <Conversation
            key={id}
            personal={personal}
            intro={
              embedded
                ? {
                    title: 'QUARK',
                    description: 'Set project priorities, pause work, or allocate allowance.',
                    note: 'Your instructions and allocation decisions stay saved here. Project managers carry out the work.',
                  }
                : undefined
            }
            agent={agent}
            detail={conversation}
            approvals={approvals}
            act={act}
          />
          {readOnly ? (
            <div className="flow-archive-action">
              <div>
                <strong>Curious about a decision?</strong>
                <p>Use the saved messages, tools and results to ask what happened.</p>
                {canForkDiscussion && (
                  <label className="flow-field">
                    Discussion context
                    <select
                      value={nativeDiscussion ? 'native' : 'evidence'}
                      onChange={(event) => setNativeDiscussion(event.target.value === 'native')}
                      disabled={busy}
                    >
                      <option value="native">
                        Original {agent.provider === 'claude' ? 'Claude' : 'Codex'} conversation
                      </option>
                      <option value="evidence">Saved evidence only</option>
                    </select>
                    <small>
                      The native option copies history through the recorded final reply. If that
                      history is unavailable, choose saved evidence. Files are not rewound.
                    </small>
                  </label>
                )}
                {agent.nativeRootId && (
                  <p>
                    This helper shares the owning conversation’s budget and stop control. Its exact
                    model may not be reported; available evidence is kept here.
                  </p>
                )}
              </div>
              <button
                className="flow-button primary"
                disabled={
                  busy || !agent.model || ['running', 'waiting', 'queued'].includes(agent.status)
                }
                onClick={() =>
                  void act(async () => {
                    const created = agentSchema.parse(
                      await api(
                        `/agents/${agent.id}/interviews`,
                        canForkDiscussion && nativeDiscussion
                          ? { key: interviewKeys.current.native, continuity: 'native-fork' }
                          : { key: interviewKeys.current.evidence },
                      ),
                    );
                    location.hash = go('chat', created.id);
                  })
                }
              >
                Ask about this work <ArrowUpRight size={17} />
              </button>
              {agent.nativeRootId && (
                <>
                  {agent.parentId && agent.parentId !== agent.nativeRootId && (
                    <a className="flow-button" href={go('chat', agent.parentId)}>
                      Open invoking helper <ArrowUpRight size={17} />
                    </a>
                  )}
                  <a className="flow-button" href={go('chat', agent.nativeRootId)}>
                    Open controlling conversation <ArrowUpRight size={17} />
                  </a>
                </>
              )}
            </div>
          ) : (
            <Composer
              key={id}
              agent={agent}
              workspace={workspace.state}
              disabled={!connected || busy}
              onError={setError}
              send={async (text, key, steer, draft, scheduling) => {
                setError('');
                await api(`/agents/${id}/messages`, { text, key, steer, draft, scheduling });
                await read();
                refresh();
              }}
              onCommand={(command) => {
                if (command === 'interrupt')
                  void act(() =>
                    api(`/agents/${id}/commands`, { command, key: crypto.randomUUID() }),
                  );
                else location.hash = `${go('advanced', agent.id)}/${command}`;
              }}
              onStop={() =>
                void act(() =>
                  api(`/agents/${id}/commands`, { command: 'interrupt', key: crypto.randomUUID() }),
                )
              }
              onHelp={() => {
                location.hash = go('advanced', agent.id);
              }}
              notepad={pane?.brief ? 'brief' : undefined}
              reference={reference}
              onNotepadClose={() => {
                // Leave the brief route without a hash change; a reload then opens normal chat.
                if (location.hash.endsWith('/brief'))
                  history.replaceState(history.state, '', go('chat', id));
              }}
            />
          )}
        </div>
        {pane
          ? sidePanel
          : !embedded && (
              <aside className="flow-chat-aside">
                <span className="home-eyebrow">PROJECT DETAILS</span>
                <h2>{agent.interview ? 'Evidence' : 'Project team'}</h2>
                <p>
                  {agent.interview
                    ? 'Answers should point to the saved record and say when details are missing. New work belongs with your manager.'
                    : 'Follow the assignment, meet each worker and return to the decisions that shaped the result.'}
                </p>
                {agent.interview && (
                  <a className="flow-button" href={go('chat', agent.interview.sourceAgentId)}>
                    Original worker <ArrowUpRight size={16} />
                  </a>
                )}
                <a className="flow-button" href="#/work">
                  QUARK budgets <ArrowUpRight size={16} />
                </a>
                <a className="flow-button" href="#/chats">
                  All conversations <ArrowUpRight size={16} />
                </a>
                <a className="flow-button" href={`#/search/${agent.projectId}`}>
                  Saved history <Search size={16} />
                </a>
                <a className="flow-button" href="#/workspace">
                  Open conversations <ArrowUpRight size={16} />
                </a>
                <a className="flow-button" href={go('advanced', agent.id)}>
                  Advanced controls <ArrowUpRight size={16} />
                </a>
              </aside>
            )}
      </div>
    </section>
  );
}

type ChatKind = 'manager' | 'vscode' | 'misc';
type ChatFilter = 'all' | ChatKind;
type RowState = 'awaiting' | 'working' | 'queued' | 'attention' | 'idle' | 'offline';
type ChatRow = {
  key: string;
  kind: ChatKind;
  // Replaces the kind label, e.g. a native Codex session inside the shared tab.
  tag?: string;
  name: string;
  caption: string;
  time: string | null;
  state: RowState;
  label: string;
  href: string;
  selected: boolean;
};
const rowLabels: Record<RowState, string> = {
  awaiting: 'Needs your response',
  working: 'Working',
  queued: 'Waiting in QUARK',
  attention: 'Needs attention',
  idle: 'Ready',
  offline: 'Offline',
};
const rowOrder: RowState[] = ['awaiting', 'working', 'queued', 'attention', 'idle', 'offline'];
const filters: [ChatFilter, string][] = [
  ['all', 'All'],
  ['manager', 'Managers'],
  // VS Code chats and native Codex sessions; the saved filter key stays 'vscode'.
  ['vscode', 'Shared'],
  ['misc', 'Misc'],
];
const kindLabels: Record<ChatKind, string> = {
  manager: 'Manager',
  vscode: 'VS Code',
  misc: 'Misc',
};
const listKey = 'dock:chat-list';
const rowLimit = 200;
function ago(value: string | null) {
  if (!value) return '';
  const minutes = Math.floor((Date.now() - Date.parse(value)) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function savedList(): { query: string; filter: ChatFilter } {
  try {
    const value = JSON.parse(sessionStorage.getItem(listKey) ?? 'null');
    if (typeof value?.query === 'string' && filters.some(([f]) => f === value.filter))
      return { query: value.query.slice(0, 200), filter: value.filter };
  } catch {
    /* Filters are navigation convenience only. */
  }
  return { query: '', filter: 'all' };
}

/** Drawn main chat: filterable conversation list beside the selected conversation. */
function MainChat({
  route,
  data,
  state,
  refresh,
}: {
  route: string;
  data: HomeData;
  state: Snapshot;
  refresh: () => void;
}) {
  const parts = route.split('/');
  const page = parts[0];
  const agentId = page === 'chat' ? (parts[1] ?? '') : '';
  const brief = page === 'chat' && parts[2] === 'brief';
  const answerId = page === 'chat' && parts[2] === 'answer' ? parts[3] : undefined;
  let editorKey = '';
  if (page === 'chats' && parts[1] === 'vscode')
    try {
      editorKey = decodeURIComponent(parts.slice(2).join('/'));
    } catch {
      /* An invalid link shows the list without selecting another chat. */
    }
  const [query, setQuery] = useState(() => savedList().query);
  const [filter, setFilter] = useState<ChatFilter>(() =>
    page === 'managers' ? 'manager' : savedList().filter,
  );
  const [panel, setPanel] = useState<ChatPanel | null>(answerId ? 'notes' : null);
  useEffect(() => {
    setPanel(answerId ? 'notes' : null);
  }, [agentId, answerId]);
  const [menu, setMenu] = useState(false);
  const mirrors = useMirrorChats();
  useEffect(() => {
    if (page === 'managers') setFilter('manager');
  }, [page]);
  useEffect(() => {
    try {
      sessionStorage.setItem(listKey, JSON.stringify({ query, filter }));
    } catch {
      /* Keep the in-memory filters. */
    }
  }, [query, filter]);
  const special = new Set(
    [data.frontdesk.data?.projectId, data.resources.data?.projectId].filter(
      (value): value is string => !!value,
    ),
  );
  const personalId = data.frontdesk.data?.agentId;
  const waiting = new Set(
    state.approvals.filter((a) => a.status === 'pending').map((a) => a.agentId),
  );
  const projectName = (id: string) => state.projects.find((p) => p.id === id)?.name ?? '';
  const rows: ChatRow[] = [
    ...state.agents.flatMap((agent): ChatRow[] => {
      const surface = surfaceOf(agent);
      // Terminal-only sessions live in Advanced controls, not the normal chat list.
      if (agent.nativeRootId || surface === 'terminal') return [];
      // Computer health owns every diagnosis and consultation, including old records
      // without a reason. They remain searchable there, never one row per check here.
      if (resourceAssistantOf(agent) || agent.projectId === data.resources.data?.projectId)
        return [];
      if (
        state.projects.find((p) => p.id === agent.projectId)?.internal &&
        surface !== 'misc' &&
        agent.id !== personalId
      )
        return [];
      const kind: ChatKind | null =
        agent.interview || surface === 'misc' || special.has(agent.projectId)
          ? 'misc'
          : agent.role === 'manager'
            ? 'manager'
            : null;
      if (!kind) return [];
      const rowState: RowState =
        waiting.has(agent.id) || agent.status === 'waiting'
          ? 'awaiting'
          : agent.status === 'running'
            ? 'working'
            : agent.status === 'queued'
              ? 'queued'
              : ['failed', 'interrupted'].includes(agent.status)
                ? 'attention'
                : 'idle';
      return [
        {
          key: agent.id,
          kind,
          name: agent.name,
          caption:
            agent.id === personalId
              ? 'Personal conversation'
              : agent.interview
                ? `Read-only discussion · ${projectName(agent.projectId)}`
                : `${surface === 'misc' ? 'Saved chat' : projectName(agent.projectId)} · ${agent.provider === 'codex' ? 'Codex' : 'Claude'}`,
          time: agent.updatedAt,
          state: rowState,
          label: rowLabels[rowState],
          href: go('chat', agent.id),
          selected: agent.id === agentId,
        },
      ];
    }),
    ...mirrors.chats.flatMap((chat: MirrorChat): ChatRow[] => {
      if (!chat.threadId) return [];
      const key = mirrorKey(chat);
      const daemon = mirrorDaemon(chat);
      const rowState: RowState =
        chat.status === 'busy'
          ? 'working'
          : chat.status === 'attention'
            ? 'awaiting'
            : chat.status === 'offline'
              ? 'offline'
              : 'idle';
      return [
        {
          key,
          kind: 'vscode',
          tag: daemon ? 'Codex session' : undefined,
          name: chat.title || 'Untitled conversation',
          caption: daemon ? chat.label : `${mirrorProvider(chat)} · ${chat.label}`,
          time: null,
          state: rowState,
          label: mirrorStatus(chat),
          href: `#/chats/vscode/${encodeURIComponent(key)}`,
          selected: key === editorKey,
        },
      ];
    }),
  ].sort(
    (a, b) =>
      rowOrder.indexOf(a.state) - rowOrder.indexOf(b.state) ||
      (b.time ?? '').localeCompare(a.time ?? ''),
  );
  const term = query.trim().toLowerCase();
  const shown = rows.filter(
    (row) =>
      (filter === 'all' || row.kind === filter) &&
      (!term || `${row.name} ${row.caption} ${row.tag ?? ''}`.toLowerCase().includes(term)),
  );
  const editor = mirrors.chats.find((chat) => mirrorKey(chat) === editorKey);
  const selected = !!agentId || !!editorKey;
  const ListTitle = selected ? 'h2' : 'h1';
  return (
    <section className={`flow-page main-chat${selected ? ' has-selection' : ''}`}>
      <aside className="chat-list" aria-label="Conversations">
        <div className="chat-list-head">
          <ListTitle className="chat-list-title" tabIndex={-1}>
            Chats
          </ListTitle>
          <div className="chat-new">
            <button
              type="button"
              className="flow-button primary"
              aria-expanded={menu}
              aria-controls="chat-new-menu"
              onClick={() => setMenu((open) => !open)}
            >
              <Plus size={17} /> New
            </button>
            {menu && <NewMenu close={() => setMenu(false)} />}
          </div>
        </div>
        <div className="chat-editor-setup">
          <EditorStatus data={data} />
        </div>
        <label className="flow-search chat-search">
          <Search size={17} />
          <input
            aria-label="Find a conversation"
            placeholder="Search chats"
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <AssistedSearch />
        <div className="flow-tabs chat-filters" role="group" aria-label="Conversation type">
          {filters.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <nav className="chat-list-scroll" aria-label="Conversation list">
          {shown.slice(0, rowLimit).map((row) => (
            <a
              key={`${row.kind}:${row.key}`}
              className={`flow-person chat-row ${row.kind}${row.selected ? ' selected' : ''}`}
              href={row.href}
              aria-current={row.selected ? 'page' : undefined}
            >
              <span className={`chat-row-icon ${row.kind}`} aria-hidden="true">
                {row.kind === 'manager' ? (
                  <Users size={17} />
                ) : row.kind === 'vscode' ? (
                  <Terminal size={17} />
                ) : (
                  <MessageCircle size={17} />
                )}
              </span>
              <span className="chat-row-text">
                <strong>{row.name}</strong>
                <small>
                  <span className="chat-row-kind">{row.tag ?? kindLabels[row.kind]}</span>{' '}
                  {row.caption}
                </small>
              </span>
              <span className="chat-row-side">
                {row.time && <time dateTime={row.time}>{ago(row.time)}</time>}
                <span className={`chat-row-state ${row.state}`}>
                  <span className="chat-dot" aria-hidden="true" />
                  {row.label}
                </span>
              </span>
            </a>
          ))}
          {!shown.length && (
            <p className="chat-list-empty">
              {term
                ? 'No conversation names match. Try a project name, Assisted search, or clear the search.'
                : filter === 'vscode'
                  ? mirrors.error ||
                    (mirrors.loaded
                      ? 'No shared chats. Share a Codex or Claude chat from VS Code to continue it here. Codex sessions on this computer’s shared Codex server also appear here.'
                      : 'Checking for shared chats…')
                  : filter === 'misc'
                    ? 'Personal and read-only discussions appear here.'
                    : 'No conversations yet. Choose New to start a project.'}
            </p>
          )}
          {shown.length > rowLimit && (
            <p className="chat-list-empty">
              Showing the first {rowLimit} of {shown.length}. Search to narrow the list.
            </p>
          )}
        </nav>
      </aside>
      <div className="chat-pane">
        {agentId ? (
          <ChatPage
            key={agentId}
            id={agentId}
            state={state}
            refresh={refresh}
            personal={agentId === personalId}
            pane={{ panel, setPanel, brief, answerId, data, special }}
          />
        ) : editorKey ? (
          <div className="chat-editor">
            <a className="chat-icon-button chat-back" href="#/chats" aria-label="All chats">
              <ChevronLeft size={20} />
            </a>
            {editor ? (
              <VscodeMirror key={mirrorKey(editor)} chat={editor} />
            ) : (
              <p className="flow-chat-notice" role="status">
                {mirrors.loaded
                  ? 'This shared conversation is unavailable. Reopen or share it again where it started on your computer; no other chat has been selected.'
                  : 'Looking for this shared conversation…'}
              </p>
            )}
          </div>
        ) : (
          <div className="chat-pane-empty">
            <MessageCircle size={26} />
            <h2>Choose a conversation</h2>
            <p>
              Managers, shared VS Code chats, Codex sessions and saved discussions keep their own
              history.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

/** Keyed "open once" request; a retry after a lost reply reuses its receipt. */
function OpenInEditor({ projectId }: { projectId: string }) {
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 8000);
    return () => window.clearTimeout(timer);
  }, [message]);
  return (
    <>
      <button
        type="button"
        className="chat-folder"
        aria-label="Open project in VS Code"
        title="Open project in VS Code"
        disabled={busy}
        onClick={() => {
          key.current ??= crypto.randomUUID();
          setBusy(true);
          setMessage('');
          void api<{ message?: string }>(`/projects/${projectId}/open-in-editor`, {
            key: key.current,
          })
            .then((result) => {
              key.current = null;
              setMessage(result.message ?? 'Opened in VS Code on this project’s computer.');
            })
            .catch((reason: unknown) =>
              setMessage(
                reason instanceof Error
                  ? `${reason.message} Try again; the same request will not open it twice.`
                  : 'VS Code could not be opened. Try again.',
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        <FolderOpen size={17} />
      </button>
      {message && (
        <span className="chat-editor-status" role="status">
          {message}
        </span>
      )}
    </>
  );
}

/** New: Project manager, or a chat. The native terminal stays an advanced choice. */
function NewMenu({ close }: { close: () => void }) {
  const [step, setStep] = useState<'start' | 'chat'>('start');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('a, button')?.focus();
  }, [step]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !box.current?.parentElement?.contains(target)) close();
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
    };
  }, [close]);
  return (
    <div className="chat-new-menu" id="chat-new-menu" ref={box} role="group" aria-label="Start new">
      {step === 'start' ? (
        <>
          <a className="chat-new-option" href="#/new" onClick={close}>
            <Users size={19} />
            <span>
              <strong>Project manager</strong>
              <small>Set up a project, its manager and how its team works.</small>
            </span>
          </a>
          <button type="button" className="chat-new-option" onClick={() => setStep('chat')}>
            <MessageCircle size={19} />
            <span>
              <strong>Chat</strong>
              <small>A conversation outside a project.</small>
            </span>
            <ChevronRight size={17} />
          </button>
        </>
      ) : (
        <>
          <button type="button" className="chat-new-back" onClick={() => setStep('start')}>
            <ChevronLeft size={17} /> Back
          </button>
          <a className="chat-new-option" href="#/new/chat" onClick={close}>
            <MessageCircle size={19} />
            <span>
              <strong>Start chat + save contact</strong>
              <small>A saved conversation under Misc, using the normal chat.</small>
            </span>
          </a>
          <a className="chat-new-option advanced" href="#/new/terminal" onClick={close}>
            <Terminal size={19} />
            <span>
              <strong>
                Terminal experience <em>Advanced</em>
              </strong>
              <small>A native Codex terminal session. It is not added to your chat list.</small>
            </span>
          </a>
        </>
      )}
    </div>
  );
}
