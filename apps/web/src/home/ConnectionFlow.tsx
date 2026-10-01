import { useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  DatabaseBackup,
  Laptop,
  MessageCircle,
  Monitor,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import { frontdeskStatusSchema } from '@dock/shared';
import { api, apiScope } from '../api';
import { FrontdeskSettings } from '../FrontdeskSettings';
import { RecoveryBackups } from '../RecoveryBackups';
import { RetainedBrowserDrafts } from '../RetainedBrowserDrafts';
import { PhoneSettings } from '../PhoneAccess';
import { HostSelector } from '../HostSelector';
import { HistoryBrowser } from '../HistoryBrowser';
import { WorkspacePanel } from '../WorkspacePanel';
import { useWorkspaceState } from '../useWorkspaceState';
import { useMirrorChats, mirrorDaemon, mirrorKey } from '../useMirrorChats';
import { MirrorHome, VscodeMirror } from '../VscodeMirror';
import { ChatPage, FlowEmpty, FlowHeading } from './WorkspaceFlow';
import type { HomeData } from './useHomeData';
import './connection-flow.css';

export const connectionPages = new Set([
  'settings',
  'assistant',
  'assistant-settings',
  'vscode',
  'search',
  'workspace',
  'computers',
  'phone',
  'recovery',
]);
const navigate = (path: string) => {
  location.hash = `#/${path}`;
};
const chat = (id: string) => navigate(`chat/${id}`);

function SettingsCard({
  to,
  title,
  children,
  icon,
}: {
  to: string;
  title: string;
  children: ReactNode;
  icon: ReactNode;
}) {
  return (
    <a className="connection-card" href={`#/${to}`}>
      <span className="connection-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{children}</p>
      <span className="connection-open">
        Open <ArrowUpRight size={17} />
      </span>
    </a>
  );
}

export function ConnectionFlow({ route, data }: { route: string; data: HomeData }) {
  const [page, target] = route.split('/');
  if (page === 'assistant') return <AssistantPage data={data} />;
  if (page === 'vscode') return <EditorPage target={target} />;
  if (page === 'search') return <SearchPage data={data} projectId={target} />;
  if (page === 'workspace') return <SavedWorkspace data={data} />;
  if (page === 'settings')
    return (
      <section className="flow-page connection-page">
        <FlowHeading label="YOUR WORKSPACE" title="Settings">
          Choose how your team works and how you stay connected.
        </FlowHeading>
        <div className="connection-grid">
          <SettingsCard to="welcome" title="Welcome and setup" icon={<ShieldCheck />}>
            Check native sign-in and model readiness, then choose your team and first project.
          </SettingsCard>
          <SettingsCard to="advanced" title="Advanced controls" icon={<Settings2 />}>
            Session settings, provider tools, history import and deliberate context changes.
          </SettingsCard>
          <SettingsCard to="models" title="Model preferences" icon={<Settings2 />}>
            Set your general manager, worker and assistant defaults. Restore the recommended choices
            any time.
          </SettingsCard>
          <SettingsCard to="computers" title="Computers and accounts" icon={<Laptop />}>
            Choose where work happens. Accounts, files and history stay on their computer.
          </SettingsCard>
          <SettingsCard to="phone" title="Phone access" icon={<Smartphone />}>
            Pair a phone, manage its access and add the app to your home screen.
          </SettingsCard>
          <SettingsCard to="recovery" title="Recovery copies" icon={<DatabaseBackup />}>
            Keep private copies of your records and prepare an update with your setup agent.
          </SettingsCard>
          <SettingsCard to="workspace" title="Open conversations" icon={<MessageCircle />}>
            Return to saved views and deliberately continue from another browser.
          </SettingsCard>
          <SettingsCard to="work" title="QUARK" icon={<Monitor />}>
            See remaining allowance, adjust budgets and manage waiting work.
          </SettingsCard>
          <SettingsCard to="search" title="Saved history" icon={<BookOpen />}>
            Find conversations, results and the recorded decisions behind them.
          </SettingsCard>
        </div>
      </section>
    );
  if (page === 'computers')
    return (
      <section className="flow-page connection-page">
        <FlowHeading label="COMPUTERS AND ACCOUNTS" title="Computers and accounts">
          Switch computers without moving conversations or mixing account allowances.
        </FlowHeading>
        <div className="flow-form-panel">
          <HostSelector
            selected={apiScope()}
            onChange={(id) => {
              localStorage.setItem('dock:host', id);
              location.replace(`${location.pathname}${location.search}#/computers`);
              location.reload();
            }}
          />
        </div>
        <div className="activity-shortcuts">
          <a href="#/welcome">
            <ShieldCheck />
            <strong>Check this computer</strong>
            <span>Sign-in and available models, without sending a prompt</span>
            <ArrowUpRight />
          </a>
        </div>
      </section>
    );
  if (page === 'recovery')
    return (
      <section className="flow-page connection-page">
        <FlowHeading label="RECOVERY" title="Recovery copies">
          Verified local copies give your managed records an extra checkpoint.
        </FlowHeading>
        <RetainedBrowserDrafts />
        <RecoveryBackups embedded close={() => navigate('settings')} />
      </section>
    );
  if (page === 'phone')
    return (
      <section className="flow-page connection-page">
        <FlowHeading label="PHONE ACCESS" title="Phone access">
          Your computer keeps the work. Your paired phone gives you a private way to reach it.
        </FlowHeading>
        <PhoneSettings embedded close={() => navigate('settings')} />
      </section>
    );
  return (
    <section className="flow-page connection-page">
      <FlowHeading label="ASSISTANT PRIVACY" title="Assistant privacy">
        Projects and personal notes are shared only when you choose them.
      </FlowHeading>
      {data.snapshot.data ? (
        <FrontdeskSettings
          embedded
          projects={data.snapshot.data.projects.filter(
            (p) => p.id !== data.resources.data?.projectId,
          )}
          close={() => navigate('settings')}
          open={() => navigate('assistant')}
        />
      ) : (
        <Unavailable data={data} />
      )}
    </section>
  );
}

function Unavailable({ data }: { data: HomeData }) {
  return (
    <FlowEmpty
      title={data.snapshot.error ? 'The computer is unavailable' : 'Reading your workspace…'}
    >
      <button className="flow-button" onClick={data.snapshot.retry}>
        Try again
      </button>
    </FlowEmpty>
  );
}

function AssistantPage({ data }: { data: HomeData }) {
  const [provider, setProvider] = useState<'policy' | 'codex' | 'claude'>('policy');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const pending = useRef<{ key: string; provider?: 'codex' | 'claude' } | null>(null);
  const current = created ?? data.frontdesk.data?.agentId;
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const storageKey = `dock:${apiScope()}:assistant-start`;
      const saved = sessionStorage.getItem(storageKey);
      pending.current ??= saved
        ? JSON.parse(saved)
        : { key: crypto.randomUUID(), ...(provider === 'policy' ? {} : { provider }) };
      sessionStorage.setItem(storageKey, JSON.stringify(pending.current));
      const status = frontdeskStatusSchema.parse(await api('/frontdesk/start', pending.current));
      sessionStorage.removeItem(storageKey);
      pending.current = null;
      setCreated(status.agentId);
      window.dispatchEvent(new Event('swa:refresh-home'));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not confirm. Try again to check the same request.',
      );
    } finally {
      setBusy(false);
    }
  };
  if (current && data.snapshot.data)
    return (
      <ChatPage
        key={current}
        id={current}
        state={data.snapshot.data}
        personal
        refresh={() => window.dispatchEvent(new Event('swa:refresh-home'))}
      />
    );
  return (
    <section className="flow-page connection-page">
      <FlowHeading label="YOUR PERSONAL AGENT" title="Personal assistant">
        A private place for priorities, questions and coordinating the work you choose to share.
      </FlowHeading>
      <div className="connection-welcome">
        <span className="connection-orb">
          <Sparkles size={34} />
        </span>
        <h2>Start a conversation</h2>
        <p>
          Your assistant can explain saved progress and pass requests to project managers. Choose
          its access before sharing project details.
        </p>
        <a className="flow-button" href="#/assistant-settings">
          Choose what’s shared <ArrowUpRight size={17} />
        </a>
      </div>
      <div className="flow-form-panel">
        <h2>Your assistant’s conversation</h2>
        <p>
          Creating it saves a place to talk. It starts working when you send your first message.
        </p>
        {error && <p role="alert">{error}</p>}
        {data.frontdesk.error && (
          <p role="alert">
            Could not read your assistant. <button onClick={data.frontdesk.retry}>Try again</button>
          </p>
        )}
        <label>
          Personal agent provider
          <select
            value={provider}
            disabled={busy || !!pending.current}
            onChange={(e) => setProvider(e.target.value as typeof provider)}
          >
            <option value="policy">Follow model settings</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <button
          className="primary"
          disabled={busy || !data.frontdesk.loaded || data.frontdesk.error}
          onClick={() => void start()}
        >
          {busy
            ? 'Opening…'
            : pending.current
              ? 'Check the same request'
              : 'Create personal conversation'}
        </button>
      </div>
    </section>
  );
}

function EditorPage({ target }: { target?: string }) {
  const mirrors = useMirrorChats();
  let selected = '';
  try {
    selected = decodeURIComponent(target ?? '');
  } catch {
    /* invalid link shows list */
  }
  const current = mirrors.chats.find((item) => mirrorKey(item) === selected);
  const choose = (id: string) => navigate(`vscode/${encodeURIComponent(id)}`);
  return (
    <section className="flow-page connection-page editor-page">
      {current ? (
        <a className="flow-button editor-back" href="#/vscode">
          {mirrorDaemon(current) ? 'All shared chats' : 'All editor chats'}{' '}
          <ArrowUpRight size={17} />
        </a>
      ) : (
        <FlowHeading label="SHARED EDITOR CHATS" title="VS Code chats">
          Shared Codex and Claude chats keep their original editor identity, tools and account.
        </FlowHeading>
      )}
      {current ? (
        <div className="editor-conversation-frame">
          <VscodeMirror key={mirrorKey(current)} chat={current} />
        </div>
      ) : (
        <>
          {target && mirrors.loaded && (
            <p className="flow-chat-notice" role="status">
              This shared conversation is unavailable. Share it from its original editor to
              continue; no other chat has been selected.
            </p>
          )}
          <MirrorHome
            embedded
            chats={mirrors.chats.filter((item) => !mirrorDaemon(item))}
            loaded={mirrors.loaded}
            error={mirrors.error}
            choose={choose}
          />
        </>
      )}
    </section>
  );
}

function SearchPage({ data, projectId }: { data: HomeData; projectId?: string }) {
  const [query, setQuery] = useState('');
  const state = data.snapshot.data;
  const selected = state?.projects.find((p) => p.id === projectId);
  const term = query.toLowerCase().trim();
  const projects =
    state?.projects.filter(
      (p) => p.id !== data.resources.data?.projectId && p.id !== data.frontdesk.data?.projectId,
    ) ?? [];
  return (
    <section className="flow-page connection-page">
      <FlowHeading label="SAVED HISTORY" title="Saved history">
        Find your projects and conversations, then read the saved evidence behind their work.
      </FlowHeading>
      {!state ? (
        <Unavailable data={data} />
      ) : (
        <>
          <div className="flow-form-panel">
            <label>
              Search projects and conversations
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="A project or agent name"
              />
            </label>
            {!!term && (
              <div className="connection-search-results">
                {projects
                  .filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(term))
                  .map((p) => (
                    <a key={p.id} className="flow-button" href={`#/project/${p.id}`}>
                      {p.name}
                      <ArrowUpRight size={16} />
                    </a>
                  ))}
                {state.agents
                  .filter((a) => `${a.name} ${a.scope ?? ''}`.toLowerCase().includes(term))
                  .slice(0, 30)
                  .map((a) => (
                    <a key={a.id} className="flow-button" href={`#/chat/${a.id}`}>
                      {a.name}
                      <ArrowUpRight size={16} />
                    </a>
                  ))}
              </div>
            )}
            <label>
              Read a project’s saved evidence
              <select
                value={selected?.id ?? ''}
                onChange={(e) => navigate(e.target.value ? `search/${e.target.value}` : 'search')}
              >
                <option value="">Choose a project</option>
                {state.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {selected ? (
            <HistoryBrowser
              key={selected.id}
              embedded
              projectId={selected.id}
              projectName={selected.name}
              agents={state.agents}
              close={() => navigate('search')}
              open={chat}
            />
          ) : (
            <FlowEmpty title="No matching history">
              Choose a project to search saved conversations, tool results and messages between
              agents. Reading does not start work.
            </FlowEmpty>
          )}
        </>
      )}
    </section>
  );
}

function SavedWorkspace({ data }: { data: HomeData }) {
  const workspace = useWorkspaceState(
    window.matchMedia('(pointer: coarse)').matches ? 'Phone browser' : 'Computer browser',
  );
  return (
    <section className="flow-page connection-page">
      <FlowHeading label="YOUR SAVED VIEWS" title="Open conversations">
        Open conversations and browser drafts have separate, deliberate handoffs.
      </FlowHeading>
      <WorkspacePanel
        key={workspace.state?.client.id ?? 'connecting'}
        embedded
        workspace={workspace}
        agents={data.snapshot.data?.agents ?? []}
        onSelect={(id) => {
          if (id) chat(id);
        }}
        close={() => {}}
      />
      <a className="flow-button" href="#/chats">
        Find a conversation <ArrowUpRight size={17} />
      </a>
    </section>
  );
}
