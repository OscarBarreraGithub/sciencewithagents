import { SessionSettings } from './SessionSettings';
import { TaskModal, ManagerModal } from './ProjectActions';
import {
  Conversation,
  Composer,
  Badge,
  TaskBadge,
  Avatar,
  roleLabel,
  statusLabel,
  time,
} from './Conversation';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  Aperture,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleHelp,
  Clock3,
  Download,
  FileText,
  GitBranch,
  Layers3,
  Menu,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Smartphone,
  Terminal,
  Users,
  X,
} from 'lucide-react';
import {
  effortLabel,
  attention,
  frontdeskStatusSchema,
  type Agent,
  type AgentDetail,
  type Snapshot,
  type Task,
  type FrontdeskStatus,
} from '@dock/shared';
import { api, apiScope, apiUrl, detail, snapshot } from './api';
import claudeMark from './assets/claude.svg';
import { Modal } from './Modal';
import { ProjectModal } from './ProjectModal';
import { SessionBrowser } from './SessionBrowser';
import { useFormAction } from './useFormAction';
import { PhoneSettings, usePhoneMode } from './PhoneAccess';
import { AttentionPanel } from './AttentionPanel';
import { SchedulerPanel } from './SchedulerPanel';
import { CapacityPanel } from './CapacityPanel';
import { LocalJobsPanel } from './LocalJobsPanel';
import { HistoryBrowser } from './HistoryBrowser';
import { useWorkspaceState } from './useWorkspaceState';
import { WorkspacePanel } from './WorkspacePanel';
import { HostSelector } from './HostSelector';
import { FrontdeskSettings } from './FrontdeskSettings';
import { RecoveryBackups } from './RecoveryBackups';
import { VscodeMirror, MirrorHome, MirrorChatList } from './VscodeMirror';
import { useMirrorChats, mirrorKey } from './useMirrorChats';
import { useVisibleViewport } from './useVisibleViewport';
const NativeTerminal = lazy(() =>
  import('./NativeTerminal').then((module) => ({ default: module.NativeTerminal })),
);

export function App({ onHostChange }: { onHostChange?: (id: string) => void }) {
  const scope = apiScope();
  const workspace = useWorkspaceState(
    window.innerWidth < 700 ? 'Phone browser' : 'Computer browser',
  );
  const workspaceRef = useRef(workspace.state);
  workspaceRef.current = workspace.state;
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const mirrors = useMirrorChats();
  const [mirrorSelection, setMirrorSelection] = useState<string | null>(() => {
    try {
      const saved = sessionStorage.getItem(`dock:mirror-view:${scope}`);
      return saved ?? (new URLSearchParams(location.search).has('mirror') ? '' : null);
    } catch {
      return new URLSearchParams(location.search).has('mirror') ? '' : null;
    }
  });
  const mirrorOpen = mirrorSelection !== null;
  // The fixed mirror shell covers the area above an open keyboard; see useVisibleViewport.
  const mirrorView = useVisibleViewport(mirrorOpen);
  const mirrorHeight = mirrorView?.height;
  const mirrorChat = mirrors.chats.find((chat) => mirrorKey(chat) === mirrorSelection);
  useEffect(() => {
    try {
      if (mirrorSelection === null) sessionStorage.removeItem(`dock:mirror-view:${scope}`);
      else sessionStorage.setItem(`dock:mirror-view:${scope}`, mirrorSelection);
    } catch {
      /* Navigation remains usable without browser storage. */
    }
  }, [mirrorSelection, scope]);
  const mirrorAutoOpened = useRef(false);
  useEffect(() => {
    if (!mirrors.loaded || mirrorAutoOpened.current) return;
    mirrorAutoOpened.current = true;
    if (
      mirrorSelection === '' &&
      new URLSearchParams(location.search).has('mirror') &&
      mirrors.chats.length === 1
    )
      setMirrorSelection(mirrorKey(mirrors.chats[0]));
    // Consume the entry link so choosing a normal chat survives a later reload.
    if (new URLSearchParams(location.search).has('mirror')) {
      const url = new URL(location.href);
      url.searchParams.delete('mirror');
      history.replaceState(null, '', url);
    }
  }, [mirrors.loaded]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [assistantProvider, setAssistantProvider] = useState<'policy' | Agent['provider']>(
    'policy',
  );
  const [frontdesk, setFrontdesk] = useState<FrontdeskStatus | null>(null);
  const [assistantSettings, setAssistantSettings] = useState(false);
  const restored = useRef(false);
  const userSelected = useRef(false);
  const phoneMode = usePhoneMode();
  const [phoneSettings, setPhoneSettings] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [localJobsOpen, setLocalJobsOpen] = useState(false);
  const [backupRetryBusy, setBackupRetryBusy] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [state, setState] = useState<Snapshot | null>(null);
  useEffect(() => {
    let active = true;
    void api('/frontdesk')
      .then((raw) => {
        if (active) setFrontdesk(frontdeskStatusSchema.parse(raw));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [state?.eventId]);
  const [agentId, setAgentId] = useState<string>(
    () =>
      localStorage.getItem(`dock:${scope}:selected`) ??
      (scope === 'local' ? localStorage.getItem('dock:selected') : '') ??
      '',
  );
  const [conversation, setConversation] = useState<AgentDetail | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'conversation' | 'workspace' | 'terminal'>('conversation');
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const [newManager, setNewManager] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [setup, setSetup] = useState(false);
  const [help, setHelp] = useState(false);
  const [settings, setSettings] = useState(false);
  const [commands, setCommands] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = useRef(agentId);
  selected.current = agentId;
  const refreshId = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++refreshId.current;
    try {
      const value = await snapshot();
      if (ticket !== refreshId.current) return;
      setState(value);
      setConnected(true);
      setConnectionError('');
      const current =
        selected.current && value.agents.some((a) => a.id === selected.current)
          ? selected.current
          : workspaceRef.current &&
              workspaceRef.current.client.revision > 0 &&
              !workspaceRef.current.client.openAgentIds.length
            ? undefined
            : value.projects[0]?.managerId;
      if (current) {
        if (current !== selected.current) setAgentId(current);
        const result = await detail(current);
        if (ticket === refreshId.current && (!selected.current || current === selected.current))
          setConversation(result);
      }
    } catch (e) {
      if (ticket !== refreshId.current) return;
      setConnected(false);
      setConnectionError(e instanceof Error ? e.message : 'Could not connect.');
    }
  }, []);
  useEffect(() => {
    let disposed = false,
      source: EventSource | null = null,
      timer: ReturnType<typeof setTimeout> | null = null;
    let bootstrapId = 0;
    const bootstrap = async () => {
      const ticket = ++bootstrapId;
      try {
        const value = await snapshot();
        if (disposed || ticket !== bootstrapId) return;
        setState(value);
        setConnected(true);
        setConnectionError('');
        source = new EventSource(apiUrl(`/events?after=${value.eventId}`));
        source.onopen = () => {
          setConnected(true);
          setConnectionError('');
        };
        source.onerror = () => setConnected(false);
        const invalidate = () => {
          if (!timer)
            timer = setTimeout(() => {
              timer = null;
              void refresh();
            }, 250);
        };
        source.addEventListener('change', invalidate);
        source.addEventListener('reset', invalidate);
        void refresh();
      } catch (e) {
        if (!disposed && ticket === bootstrapId) {
          setConnectionError(e instanceof Error ? e.message : 'Could not connect.');
          setConnected(false);
        }
      }
    };
    void bootstrap();
    const reconnect = () => {
      source?.close();
      source = null;
      void bootstrap();
    };
    window.addEventListener('dock:host-connected', reconnect);
    const poll = setInterval(() => void refresh(), 5000);
    return () => {
      disposed = true;
      source?.close();
      window.removeEventListener('dock:host-connected', reconnect);
      if (timer) clearTimeout(timer);
      clearInterval(poll);
    };
  }, [refresh]);
  useEffect(() => {
    localStorage.setItem(`dock:${scope}:selected`, agentId);
    setConversation(null);
    if (!agentId) return;
    setSettings(false);
    setCommands(false);
    let stale = false;
    void detail(agentId)
      .then((value) => {
        if (!stale) setConversation(value);
      })
      .catch((e) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [agentId]);
  useEffect(() => {
    if (!workspace.state || restored.current || !state) return;
    restored.current = true;
    const saved = workspace.state.client.selectedAgentId;
    if (saved && !userSelected.current && state.agents.some((agent) => agent.id === saved))
      setAgentId(saved);
    else if (
      !userSelected.current &&
      workspace.state.client.revision > 0 &&
      !workspace.state.client.openAgentIds.length
    )
      setAgentId('');
    else if (workspace.state.client.revision === 0 && !workspace.state.client.openAgentIds.length) {
      const initial = state.agents.some((agent) => agent.id === agentId)
        ? agentId
        : state.projects[0]?.managerId;
      if (initial) void workspace.open(initial);
    }
    if (workspace.state.client.openAgentIds.length) void workspace.restore();
  }, [workspace.state, state]);
  const choose = (id: string) => {
    setMirrorSelection(null);
    userSelected.current = true;
    setAgentId(id);
    void workspace.open(id);
    setTab('conversation');
    setLeftOpen(false);
    setRightOpen(false);
  };
  const chooseMirror = (key: string) => {
    setMirrorSelection(key);
    setLeftOpen(false);
    setRightOpen(false);
    setSettings(false);
    setCommands(false);
  };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The operation failed.');
    } finally {
      setBusy(false);
    }
  };
  const command = (name: 'compact' | 'new' | 'resume' | 'interrupt') => {
    setCommands(false);
    void act(() => api(`/agents/${agentId}/commands`, { command: name, key: crypto.randomUUID() }));
  };
  const agent = state?.agents.find((a) => a.id === agentId);
  const isAssistant = !!frontdesk?.agentId && agentId === frontdesk.agentId;
  const project = state?.projects.find((p) => p.id === agent?.projectId);
  const agents = state?.agents.filter((a) => a.projectId === project?.id) ?? [];
  const tasks = state?.tasks.filter((t) => t.projectId === project?.id) ?? [];
  const managers = agents.filter((a) => a.role === 'manager');
  const taskManagerId =
    agent?.role === 'manager'
      ? agent.id
      : (tasks.find((t) => t.id === agent?.taskId)?.managerId ?? project?.managerId);
  const team: { agent: Agent; depth: number }[] = [];
  const visited = new Set<string>();
  const visit = (a: Agent, depth = 0) => {
    if (visited.has(a.id)) return;
    visited.add(a.id);
    team.push({ agent: a, depth });
    for (const child of agents.filter((candidate) => candidate.parentId === a.id))
      visit(child, depth + 1);
  };
  for (const a of [...managers, ...agents]) visit(a);
  const openNative = () => {
    if (agent?.provider === 'claude') return;
    if (agent?.nativeRootId) choose(agent.nativeRootId);
    setTab('terminal');
    setCommands(false);
  };
  const approvals = state?.approvals.filter((a) => a.agentId === agentId) ?? [];
  const runningCount =
    state?.agents.filter((a) => ['running', 'queued'].includes(a.status)).length ?? 0;

  const composer =
    !mirrorOpen && agent && project && tab === 'conversation' ? (
      <div className="composer-area">
        {agent.nativeRootId ? (
          <div className="native-child-note">
            <strong>Native child · {agent.nativePath ?? agent.name}</strong>
            <p>
              Available tools, replies and checkpoints are retained here. Native providers may omit
              some delegated prompt text. The parent controls this helper’s work.
            </p>
            <button
              className="secondary"
              onClick={() => choose(agent.parentId ?? agent.nativeRootId!)}
            >
              Open parent conversation
            </button>
            {['running', 'waiting'].includes(agent.status) && (
              <button className="stop-button" onClick={() => command('interrupt')}>
                Stop child
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="model-row">
              <button className="model-button" onClick={() => setSettings(!settings)}>
                <span className="model-spark" aria-hidden="true">
                  {agent.provider === 'claude' ? (
                    <img src={claudeMark} width={16} height={16} alt="" />
                  ) : (
                    <Aperture size={15} />
                  )}
                </span>
                {agent.model ?? (agent.provider === 'claude' ? 'Claude default' : 'Codex default')}
                <ChevronDown size={13} />
              </button>
              <span className="permission">
                <span />{' '}
                {agent.role === 'manager'
                  ? 'Coordinates only'
                  : agent.permission === 'workspace-write'
                    ? 'Task workspace'
                    : 'Read only'}
              </span>
              <span className="reasoning">{effortLabel(agent.effort)} reasoning</span>
            </div>
            {settings && (
              <SessionSettings
                key={`settings:${scope}:${agent.id}`}
                agent={agent}
                close={() => setSettings(false)}
                act={act}
              />
            )}
            <Composer
              key={`${scope}:${agentId}`}
              agent={agent}
              workspace={workspace.state}
              disabled={busy || !connected}
              send={async (text, key, steer, draft, scheduling) => {
                await api(`/agents/${agentId}/messages`, {
                  text,
                  key,
                  steer,
                  ...(draft ? { draft } : {}),
                  ...(scheduling ? { scheduling } : {}),
                });
                void refresh();
              }}
              onError={setError}
              onCommand={command}
              onStop={() => command('interrupt')}
              onHelp={() => setCommands(true)}
            />
            <div className="composer-caption">
              <span>Saved locally. Ready when you return.</span>
              <span>
                Enter to send <span className="desktop-only">· Shift + Enter for a new line</span>
              </span>
            </div>
          </>
        )}
      </div>
    ) : null;

  return (
    <div
      className={`app-shell ${mirrorOpen ? 'mirror-view' : ''} ${mirrorOpen && mirrorHeight && mirrorHeight < 500 ? 'compact-view' : ''}`}
      style={
        mirrorView?.keyboard
          ? {
              position: 'fixed',
              top: mirrorView.top,
              left: 0,
              right: 0,
              height: mirrorView.height,
              minHeight: 0,
            }
          : undefined
      }
    >
      {(leftOpen || rightOpen) && (
        <button
          aria-label="Close panel"
          className="scrim"
          onClick={() => {
            setLeftOpen(false);
            setRightOpen(false);
          }}
        />
      )}
      <aside className={`sidebar ${leftOpen ? 'open' : ''}`}>
        <a className="brand" href="/" aria-label="sciencewithagents home">
          <img src="/dock.svg?v=drawn-alien" alt="" />
          <span>
            sciencewithagents<span className="brand-period">.</span>
          </span>
          <span className="version">{phoneMode === 'remote' ? 'CONNECTED' : 'LOCAL'}</span>
        </a>
        <div className="workspace-label">
          <span className="workspace-symbol">E</span>
          <div>
            Agent workspace<small>Your agents, together</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <HostSelector selected={scope} onChange={(id) => onHostChange?.(id)} />
        <div className="search-box">
          <Search size={15} />
          <input
            aria-label="Find chats and projects"
            placeholder="Find a conversation…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button className="help-link attention-link" onClick={() => chooseMirror('')}>
          <MessageSquare size={16} /> VS Code chats
        </button>
        <MirrorChatList
          chats={mirrors.chats.filter((chat) =>
            `${chat.title} ${chat.provider ?? 'codex'}`.toLowerCase().includes(query.toLowerCase()),
          )}
          selected={mirrorSelection}
          choose={chooseMirror}
        />
        {!frontdesk?.agentId && (
          <label className="muted">
            Personal agent provider
            <select
              value={assistantProvider}
              onChange={(e) => setAssistantProvider(e.target.value as typeof assistantProvider)}
            >
              <option value="policy">Follow model settings</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>
        )}
        <button
          className="help-link attention-link"
          disabled={busy || !connected}
          onClick={() => {
            if (frontdesk?.agentId) {
              choose(frontdesk.agentId);
              return;
            }
            void act(async () => {
              const value = frontdeskStatusSchema.parse(
                await api('/frontdesk/start', {
                  key: crypto.randomUUID(),
                  ...(assistantProvider === 'policy' ? {} : { provider: assistantProvider }),
                }),
              );
              setFrontdesk(value);
              if (value.agentId) {
                selected.current = value.agentId;
                choose(value.agentId);
              }
              setAssistantSettings(true);
            });
          }}
        >
          <MessageSquare size={16} /> Your assistant
        </button>
        <button
          className="help-link attention-link"
          disabled={!state}
          onClick={() => setAssistantSettings(true)}
        >
          <Settings2 size={16} /> Assistant settings
        </button>
        <div className="section-heading">
          <span>PROJECTS</span>
          <button aria-label="Add project" onClick={() => setSetup(true)}>
            <Plus size={16} />
          </button>
        </div>
        <nav className="project-list" aria-label="Projects">
          {state?.projects
            .filter(
              (p) =>
                p.id !== frontdesk?.projectId && p.name.toLowerCase().includes(query.toLowerCase()),
            )
            .map((p) => (
              <button
                key={p.id}
                className={`project-link ${!mirrorOpen && project?.id === p.id ? 'selected' : ''}`}
                onClick={() => choose(p.managerId)}
              >
                <span className="project-icon">{p.name.slice(0, 1).toUpperCase()}</span>
                <span>{p.name}</span>
                {state.agents.some((a) => a.projectId === p.id && a.status === 'running') ? (
                  <span className="live-dot" />
                ) : (
                  <ChevronRight size={13} />
                )}
              </button>
            ))}
          {state?.projects.length === 0 && (
            <p className="sidebar-empty">Start a project. Your manager will help with the rest.</p>
          )}
        </nav>
        <button className="add-project" onClick={() => setSetup(true)}>
          <Plus size={15} /> Add a project
        </button>
        <button
          className="help-link attention-link"
          onClick={() => setAttentionOpen(true)}
          disabled={!state}
        >
          <Clock3 size={16} /> Needs your attention
          {state ? ` (${attention(state).items.length})` : ''}
        </button>
        <button className="help-link attention-link" onClick={() => setQueueOpen(true)}>
          <Layers3 size={16} /> Work queue
        </button>
        <button className="help-link attention-link" onClick={() => setWorkspaceOpen(true)}>
          <MessageSquare size={16} /> Open conversations
          {workspace.state ? ` (${workspace.state.client.openAgentIds.length})` : ''}
        </button>
        <button
          className="help-link attention-link"
          disabled={!project}
          onClick={() => setHistoryOpen(true)}
        >
          <Search size={16} /> Search saved history
        </button>
        <div className="sidebar-bottom">
          {project && !isAssistant && !mirrorOpen && (
            <div className="backup-status">
              <small>
                {state?.backups.find((backup) => backup.projectId === project.id)?.message ??
                  'Private GitHub source backup is not configured.'}
              </small>
              {state?.backups.some(
                (backup) =>
                  backup.projectId === project.id &&
                  backup.state === 'needs_attention' &&
                  backup.configured,
              ) && (
                <button
                  className="help-link"
                  disabled={backupRetryBusy}
                  onClick={() => {
                    if (backupRetryBusy) return;
                    setBackupRetryBusy(true);
                    void api(`/projects/${project.id}/backup/retry`, { key: crypto.randomUUID() })
                      .then(refresh)
                      .catch((e) => setError(e.message))
                      .finally(() => setBackupRetryBusy(false));
                  }}
                >
                  {backupRetryBusy ? 'Checking backup…' : 'Retry source backup'}
                </button>
              )}
            </div>
          )}
          <div className="host-card">
            <span className={`connection-dot ${connected ? 'online' : ''}`} />
            <div>
              {connected ? 'Selected computer connected' : 'Reconnecting…'}
              <small>
                {state?.provider.version === 'demo'
                  ? 'Demo · no model calls'
                  : 'History stays on selected computer'}
              </small>
            </div>
          </div>
          <button className="help-link" onClick={() => setHelp(true)}>
            <CircleHelp size={16} /> Getting started
            <ArrowUpRight size={14} />
          </button>
          <button className="help-link" onClick={() => setPhoneSettings(true)}>
            <Smartphone size={16} /> Phone access
          </button>
          <button className="help-link" onClick={() => setLocalJobsOpen(true)}>
            <FileText size={16} /> Transcribe a video
          </button>
          <button className="help-link" onClick={() => setRecoveryOpen(true)}>
            <Download size={16} /> Recovery copies
          </button>
        </div>
      </aside>
      {phoneSettings && <PhoneSettings close={() => setPhoneSettings(false)} />}
      {recoveryOpen && <RecoveryBackups close={() => setRecoveryOpen(false)} />}
      {assistantSettings && state && (
        <FrontdeskSettings
          projects={state.projects}
          close={() => {
            setAssistantSettings(false);
            void refresh();
          }}
          open={(id) => {
            choose(id);
            setAssistantSettings(false);
          }}
        />
      )}
      {workspaceOpen && state && (
        <WorkspacePanel
          workspace={workspace}
          agents={state.agents}
          onSelect={(id) => {
            setMirrorSelection(null);
            userSelected.current = true;
            selected.current = id;
            setAgentId(id);
            setTab('conversation');
            setLeftOpen(false);
          }}
          close={() => setWorkspaceOpen(false)}
        />
      )}
      {historyOpen && project && (
        <HistoryBrowser
          projectId={project.id}
          projectName={project.name}
          agents={agents}
          close={() => setHistoryOpen(false)}
          open={(id) => {
            choose(id);
            setHistoryOpen(false);
          }}
        />
      )}
      {queueOpen && (
        <SchedulerPanel
          close={() => setQueueOpen(false)}
          openLocalJobs={() => {
            setQueueOpen(false);
            setLocalJobsOpen(true);
          }}
          open={(id) => {
            choose(id);
            setTab('conversation');
            setQueueOpen(false);
          }}
        />
      )}
      {localJobsOpen && (
        <LocalJobsPanel close={() => setLocalJobsOpen(false)} projectId={project?.id} />
      )}
      {attentionOpen && state && (
        <AttentionPanel
          state={state}
          close={() => setAttentionOpen(false)}
          open={(item) => {
            choose(item.agentId);
            setTab(item.destination);
            setAttentionOpen(false);
          }}
        />
      )}
      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="mobile-only icon-button"
              aria-label={mirrorOpen ? 'Open chats' : 'Open projects'}
              onClick={() => setLeftOpen(true)}
            >
              <Menu size={19} />
            </button>
            <span className="desktop-only">Workspace</span>
            <ChevronRight className="desktop-only" size={13} />
            <strong>{mirrorOpen ? 'VS Code chats' : (project?.name ?? 'Welcome')}</strong>
          </div>
          <div className="topbar-right">
            {mirrorOpen ? (
              <button className="mirror-all-chats" onClick={() => chooseMirror('')}>
                All chats
              </button>
            ) : (
              <span className="activity-count">
                <span className={runningCount ? 'live-dot' : 'quiet-dot'} />
                {runningCount ? `${runningCount} working` : 'All quiet'}
              </span>
            )}
            {!mirrorOpen && (
              <button
                className="icon-button team-toggle"
                aria-label="Open team"
                onClick={() => setRightOpen(!rightOpen)}
              >
                <PanelRight size={18} />
              </button>
            )}
          </div>
        </header>
        <CapacityPanel />
        <div className={`main-scroll ${mirrorOpen ? 'mirror-content' : ''}`}>
          {state?.schedulingError && <p role="status">{state.schedulingError}</p>}
          {connectionError && (
            <div className="error-banner" role="alert">
              <span>{connectionError}</span>
              <button aria-label="Dismiss connection error" onClick={() => setConnectionError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {workspace.error && (
            <div className="error-banner" role="alert">
              <span>{workspace.error}</span>
              <button onClick={() => setWorkspaceOpen(true)}>Open saved views</button>
            </div>
          )}
          {(workspace.restoreError ||
            workspace.restoreResults?.some((result) => result.state === 'unavailable')) && (
            <div className="error-banner" role="alert">
              <span>
                Your saved conversations need a connection retry. Their histories are retained; no
                message was sent.
              </span>
              <button onClick={() => setWorkspaceOpen(true)}>Reconnect saved conversations</button>
            </div>
          )}
          {mirrorOpen ? (
            mirrorChat ? (
              <VscodeMirror key={mirrorKey(mirrorChat)} chat={mirrorChat} />
            ) : (
              <MirrorHome
                chats={mirrors.chats}
                loaded={mirrors.loaded}
                error={mirrors.error}
                choose={chooseMirror}
              />
            )
          ) : !state ? (
            <div className="welcome">
              <span className="eyebrow">WORKSPACE</span>
              <h1>sciencewithagents</h1>
              <p>{connected ? 'Loading your workspace…' : 'Connecting to sciencewithagents…'}</p>
              <button className="secondary" onClick={() => void refresh()}>
                <RefreshCw size={16} /> Retry connection
              </button>
            </div>
          ) : !agent || !project ? (
            <div className="welcome">
              <div className="welcome-mark">
                <Layers3 size={32} />
              </div>
              <span className="eyebrow">A LITTLE STRUCTURE. A LOT OF POSSIBILITY.</span>
              <h1>
                {state.projects.length
                  ? 'Your conversations are safely saved.'
                  : 'Give your agents a home.'}
              </h1>
              <p>
                {state.projects.length
                  ? 'Choose a project or reopen a conversation when you are ready. Closing a view has not stopped your agents or removed any history.'
                  : 'Start with an idea. Your manager will help you figure out the next step and bring in the right people to work on it.'}
              </p>
              <button
                className="primary"
                onClick={() => (state.projects.length ? setLeftOpen(true) : setSetup(true))}
              >
                <Plus size={17} />{' '}
                {state.projects.length ? 'Choose a project' : 'Create your first project'}
              </button>
              <div className="welcome-features">
                <span>
                  <MessageSquare size={18} /> Conversations that stay
                </span>
                <span>
                  <GitBranch size={18} /> Work you can trace
                </span>
                <span>
                  <Users size={18} /> A team you can see
                </span>
              </div>
            </div>
          ) : (
            <>
              <section className="channel-header">
                <div className="channel-identity">
                  <Avatar role={agent.role} />
                  <div>
                    <div className="channel-title">
                      <h1>{agent.name}</h1>
                      <Badge status={agent.status} />
                    </div>
                    <p>
                      {agent.role === 'manager'
                        ? agent.scope || 'Whole project · The team takes care of the work.'
                        : `${roleLabel[agent.role]} · ${tasks.find((t) => t.id === agent.taskId)?.title ?? 'Project session'}`}
                    </p>
                  </div>
                </div>
                <div className="channel-actions">
                  {!isAssistant && (
                    <button className="secondary task-button" onClick={() => setNewTask(true)}>
                      <Plus size={16} /> New task
                    </button>
                  )}
                  {isAssistant && (
                    <button className="secondary" onClick={() => setAssistantSettings(true)}>
                      Personalize assistant
                    </button>
                  )}
                  <div className="menu-wrap">
                    <button
                      className="icon-button"
                      aria-label="Session commands"
                      onClick={() => setCommands(!commands)}
                    >
                      <MoreHorizontal size={20} />
                    </button>
                    {commands && (
                      <div className="popover commands">
                        <strong>Session controls</strong>
                        <button disabled={!!agent.nativeRootId} onClick={() => command('resume')}>
                          <RefreshCw size={15} /> Resume from history
                        </button>
                        {agent.provider === 'codex' && (
                          <button
                            disabled={!!agent.nativeRootId}
                            onClick={() => command('compact')}
                          >
                            <Layers3 size={15} /> Compact context
                          </button>
                        )}
                        <button disabled={!!agent.nativeRootId} onClick={() => command('new')}>
                          <Plus size={15} /> New context, keep history
                        </button>
                        <a href={apiUrl(`/agents/${agentId}/export`)} download>
                          <Download size={15} /> Export conversation
                        </a>
                        {agent.provider === 'codex' && (
                          <button onClick={openNative}>
                            <Terminal size={15} />{' '}
                            {agent.nativeRootId ? 'Open parent native Codex' : 'Open native Codex'}
                          </button>
                        )}
                        {agent.provider === 'claude' && (
                          <p className="settings-help">
                            Claude manages compaction itself. Its native terminal, slash commands,
                            MCPs and plugins remain in Claude Code or its shared VS Code chat.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </section>
              <nav className="tabs" aria-label="Project views">
                <button
                  className={tab === 'conversation' ? 'active' : ''}
                  onClick={() => setTab('conversation')}
                >
                  <MessageSquare size={15} /> Conversation
                </button>
                {!isAssistant && (
                  <button
                    className={tab === 'workspace' ? 'active' : ''}
                    onClick={() => setTab('workspace')}
                  >
                    <Layers3 size={15} /> Workboard<span className="tab-count">{tasks.length}</span>
                  </button>
                )}
                {agent.provider === 'codex' && (
                  <button className={tab === 'terminal' ? 'active' : ''} onClick={openNative}>
                    <Terminal size={15} />{' '}
                    {agent.nativeRootId ? 'Parent terminal' : 'Native terminal'}
                  </button>
                )}
              </nav>
              {tab === 'terminal' && approvals.some((approval) => approval.kind === 'mcp_url') && (
                <div className="terminal-note" role="status">
                  <button className="secondary" onClick={() => setTab('conversation')}>
                    URL request needs your input — open Conversation
                  </button>
                </div>
              )}
              {tab === 'terminal' ? (
                <Suspense fallback={<p className="terminal-note">Loading native terminal…</p>}>
                  <NativeTerminal
                    agentId={agentId}
                    onTransfer={(id) => {
                      setAgentId(id);
                      void workspace.open(id);
                    }}
                    onClose={() => {
                      setTab('conversation');
                      void refresh();
                    }}
                  />
                </Suspense>
              ) : tab === 'workspace' ? (
                <Workboard
                  tasks={tasks}
                  agents={agents}
                  state={state}
                  onNew={() => setNewTask(true)}
                  onAgent={choose}
                  act={act}
                />
              ) : (
                <>
                  <Conversation
                    key={agentId}
                    personal={isAssistant}
                    agent={agent}
                    detail={conversation}
                    approvals={approvals}
                    act={act}
                  />
                </>
              )}
            </>
          )}
        </div>
        {composer}
      </main>
      {!mirrorOpen && (
        <aside className={`team-panel ${rightOpen ? 'open' : ''}`}>
          <header>
            <span>PROJECT ACTIVITY</span>
            <button
              className="icon-button mobile-close"
              aria-label="Close team"
              onClick={() => setRightOpen(false)}
            >
              <X size={18} />
            </button>
            <span className="team-live">LIVE</span>
          </header>
          <div className="team-content">
            <div className="section-title">
              <h2>Your team</h2>
              <span>{agents.length}</span>
            </div>
            <p className="team-description">
              Shared project. Focused managers and specialists.
              <br />
              Every conversation stays with the work.
            </p>
            {project && !isAssistant && (
              <>
                <button className="secondary add-manager" onClick={() => setNewManager(true)}>
                  <Plus size={15} /> Add module manager
                </button>
                <button className="secondary add-manager" onClick={() => setSessionsOpen(true)}>
                  <RefreshCw size={15} /> Existing Codex sessions
                </button>
              </>
            )}
            <div className="agent-list">
              {team.map(({ agent: a, depth }) => (
                <button
                  key={a.id}
                  className={`agent-card ${a.role !== 'manager' ? 'worker' : ''} ${a.id === agentId ? 'selected' : ''}`}
                  style={depth > 1 ? { marginLeft: Math.min(depth - 1, 2) * 10 } : undefined}
                  onClick={() => choose(a.id)}
                >
                  <Avatar role={a.role} small />
                  <div>
                    <strong>{a.name}</strong>
                    <small>
                      {a.nativeRootId
                        ? `Native child of ${agents.find((parent) => parent.id === a.parentId)?.name ?? 'parent'}`
                        : roleLabel[a.role]}
                      <span>·</span>
                      {statusLabel[a.status]}
                    </small>
                  </div>
                  <ChevronRight size={13} />
                </button>
              ))}
              {!agents.length && (
                <p className="muted">Your team appears here when you add a project.</p>
              )}
            </div>
            <div className="panel-divider" />
            <div className="section-title">
              <h2>In focus</h2>
              <Layers3 size={15} />
            </div>
            {tasks
              .filter((t) => !['integrated', 'split', 'cancelled'].includes(t.status))
              .slice(-4)
              .map((task) => (
                <button
                  className="focus-task"
                  key={task.id}
                  onClick={() => {
                    setTab('workspace');
                    setRightOpen(false);
                  }}
                >
                  <span className="task-kicker">TASK {tasks.indexOf(task) + 1}</span>
                  <strong>{task.title}</strong>
                  <TaskBadge task={task} />
                </button>
              ))}
            {tasks.length === 0 && (
              <div className="empty-focus">
                <Circle size={23} />
                <p>
                  No tasks yet.
                  <br />
                  Start with the result you want.
                </p>
              </div>
            )}
            <div className="panel-divider" />
            <div className="section-title">
              <h2>Latest decisions</h2>
              <FileText size={15} />
            </div>
            {state?.decisions
              .filter((d) => d.projectId === project?.id)
              .slice(-3)
              .reverse()
              .map((d) => (
                <div className="decision-note" key={d.id}>
                  <div>
                    <span className="decision-dot" />
                    <span>{d.kind.replaceAll('_', ' ')}</span>
                    <time>{time(d.createdAt)}</time>
                  </div>
                  <p>{d.rationale}</p>
                </div>
              ))}
            {!state?.decisions.some((d) => d.projectId === project?.id) && (
              <p className="muted small-text">The why behind the work will appear here.</p>
            )}
          </div>
          <footer>
            <GitBranch size={15} />
            <span>Changes stay separate until you approve applying them.</span>
          </footer>
        </aside>
      )}
      {setup && (
        <ProjectModal
          close={() => setSetup(false)}
          onCreated={async (created) => {
            await refresh();
            setQuery('');
            choose(created.managerId);
            setSetup(false);
          }}
        />
      )}
      {help && (
        <Modal title="A little help getting started" close={() => setHelp(false)}>
          <ol className="getting-started">
            <li>
              <h3>Give your idea a home</h3>
              <p>Create a project with a name. We’ll set up everything behind the scenes.</p>
            </li>
            <li>
              <h3>Tell your manager what you want</h3>
              <p>
                Write the way you’d talk to a person. You don’t need a plan or any technical
                knowledge. Your manager brings in specialist AI agents to help.
              </p>
            </li>
            <li>
              <h3>Follow along, at your own pace</h3>
              <p>
                Open Your team to see who’s working, or Workboard to see progress. Your
                conversations stay here when you close the app.
              </p>
            </li>
          </ol>
          <p>
            You stay in control. When a change needs your permission, the app will ask. Advanced
            tools are there when you want them, but you don’t need them to get started.
          </p>
          <button
            className="primary"
            onClick={() => {
              setHelp(false);
              setSetup(true);
            }}
          >
            Create a project
            <Plus size={16} />
          </button>
        </Modal>
      )}
      {newTask && project && (
        <TaskModal
          projectId={project.id}
          managers={managers}
          initialManagerId={taskManagerId ?? project.managerId}
          close={() => setNewTask(false)}
          act={act}
        />
      )}
      {newManager && project && (
        <ManagerModal
          projectId={project.id}
          close={() => setNewManager(false)}
          act={act}
          onCreated={choose}
        />
      )}
      {sessionsOpen && project && (
        <SessionBrowser
          projectId={project.id}
          managers={managers}
          initialManagerId={taskManagerId ?? project.managerId}
          close={() => setSessionsOpen(false)}
          onOpen={(id) => {
            choose(id);
            setSessionsOpen(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function Workboard({
  tasks,
  agents,
  state,
  onNew,
  onAgent,
  act,
}: {
  tasks: Task[];
  agents: Agent[];
  state: Snapshot;
  onNew: () => void;
  onAgent: (id: string) => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [diff, setDiff] = useState<{ title: string; diff: string; status: string } | null>(null);
  const [preview, setPreview] = useState<{
    taskId: string;
    source: string;
    target: string;
    changes: string;
    key: string;
  } | null>(null);
  const applyAction = useFormAction(act);
  return (
    <div className="workboard">
      <div className="board-heading">
        <div>
          <span className="eyebrow">SMALL TASKS. VISIBLE PROGRESS.</span>
          <h2>The work, at a glance.</h2>
          <p>Each task has one outcome, its own team, and a record of the decisions.</p>
        </div>
        <button className="secondary" onClick={onNew}>
          <Plus size={16} /> New task
        </button>
      </div>
      {tasks.length === 0 ? (
        <div className="board-empty">
          <Layers3 size={28} />
          <h3>No work in flight.</h3>
          <p>Ask the manager to get started, or describe a task.</p>
        </div>
      ) : (
        <div className="task-grid">
          {tasks.map((task, index) => (
            <article key={task.id} className="task-card">
              <div className="task-card-heading">
                <span className="task-kicker">TASK {String(index + 1).padStart(2, '0')}</span>
                <TaskBadge task={task} />
              </div>
              <h3>{task.title}</h3>
              <p>{task.goal}</p>
              <div className="acceptance">
                <span>DONE WHEN</span>
                <p>{task.acceptance}</p>
              </div>
              <div className="task-agents">
                <button onClick={() => onAgent(task.managerId)} title="Task manager">
                  <Avatar role="manager" small />
                  <span>{agents.find((a) => a.id === task.managerId)?.name ?? 'Manager'}</span>
                </button>
                {agents
                  .filter((a) => a.taskId === task.id)
                  .map((a) => (
                    <button key={a.id} title={a.name} onClick={() => onAgent(a.id)}>
                      <Avatar role={a.role} small />
                      <span>{a.name}</span>
                    </button>
                  ))}
              </div>
              <footer>
                <span>{task.revisions}/2 revisions</span>
                <button
                  onClick={() =>
                    void act(async () => {
                      const value = await api<{ diff: string; status: string }>(
                        `/tasks/${task.id}/diff`,
                      );
                      setDiff({ title: task.title, ...value });
                    })
                  }
                >
                  View changes
                  <ArrowUpRight size={13} />
                </button>
                {task.status === 'done' && task.hasReviewedChanges && (
                  <button
                    onClick={() =>
                      void act(async () => {
                        const value = await api<Omit<NonNullable<typeof preview>, 'key'>>(
                          `/tasks/${task.id}/integration`,
                        );
                        applyAction.clearError();
                        setPreview({ ...value, key: crypto.randomUUID() });
                      })
                    }
                  >
                    Apply changes
                    <GitBranch size={13} />
                  </button>
                )}
              </footer>
            </article>
          ))}
        </div>
      )}
      {state.decisions.length > 0 && (
        <section className="decisions-section">
          <h3>Decision record</h3>
          {state.decisions
            .filter((d) => tasks.some((t) => t.id === d.taskId))
            .slice(-15)
            .reverse()
            .map((d) => (
              <details className="decision-row" key={d.id}>
                <summary>
                  <FileText size={15} />
                  <span>{d.rationale}</span>
                  <time>{time(d.createdAt)}</time>
                </summary>
                <p>{d.evidence}</p>
              </details>
            ))}
        </section>
      )}
      {diff && (
        <Modal title={diff.title} close={() => setDiff(null)}>
          <p>These are changes in the task’s separate copy, not your main project.</p>
          <h3>Changes since this task began</h3>
          <pre className="diff-view">
            {diff.diff ||
              'No saved changes yet. New files appear after the agent saves a checkpoint.'}
          </pre>
          <details>
            <summary>Technical details: files waiting to be saved</summary>
            <pre>{diff.status || 'No uncommitted changes.'}</pre>
          </details>
        </Modal>
      )}
      {preview && (
        <Modal
          title="Apply reviewed changes"
          close={() => {
            if (!applyAction.pending) setPreview(null);
          }}
        >
          <p>
            Add this task’s reviewed changes to your project. Nothing is applied until you confirm.
            If either copy has changed or has unsaved work, we’ll stop instead of overwriting it.
          </p>
          <h3>What will change</h3>
          <pre>{preview.changes || 'No file changes.'}</pre>
          <details>
            <summary>Technical details: exact saved versions</summary>
            <p>Only a clean Git fast-forward to this exact reviewed commit is allowed.</p>
            <pre>{`From ${preview.target}\nTo ${preview.source}`}</pre>
          </details>
          {applyAction.error && (
            <p className="session-error" role="alert">
              {applyAction.error}
            </p>
          )}
          <button
            className="primary"
            disabled={applyAction.pending}
            onClick={() =>
              void applyAction.run(async () => {
                await api(`/tasks/${preview.taskId}/integrate`, {
                  source: preview.source,
                  target: preview.target,
                  key: preview.key,
                });
                setPreview(null);
              })
            }
          >
            <GitBranch size={16} />{' '}
            {applyAction.pending ? 'Applying changes…' : 'Confirm and apply changes'}
          </button>
        </Modal>
      )}
    </div>
  );
}
