import { LatexApp } from '../Documents';
import { ProviderActions } from './ProviderActions';
import { ModelSettings } from './ModelSettings';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
} from 'react';
import {
  ArrowRight,
  ChevronRight,
  CircleHelp,
  Layers3,
  LayoutGrid,
  MessageCircle,
  Settings2,
  Smartphone,
} from 'lucide-react';
import {
  phoneStatusSchema,
  type CapacityWindow,
  type PhoneStatus,
  type ProviderCapacity,
} from '@dock/shared';
import { apiScope } from '../api';
import { Modal } from '../Modal';
import { PhoneSettings } from '../PhoneAccess';
import { useHomeData, useReading, type HomeData } from './useHomeData';
import './home.css';
import { Resources } from './Resources';
import { WorkspaceFlow, flowPages } from './WorkspaceFlow';
import { ActivityFlow, activityPages } from './ActivityFlow';
import { ConnectionFlow, connectionPages } from './ConnectionFlow';
import { AdvancedFlow } from './AdvancedFlow';
import { Welcome } from './Welcome';
import { useScrollHints } from './useScrollHints';
import { HomeOverview, ProviderMark, ago, providerName, resetLabel } from './HomeOverview';
import { AppsGallery, SetupGuide } from './AppsGallery';
import { AppUpdate } from './AppUpdate';
import { HomeOrb } from './HomeOrb';
import { PullToRefresh } from './PullToRefresh';
import { BackLink, Navigation, useNavigation } from './Navigation';

// Document titles only. Every route below keeps its existing screen.
const titles: Record<string, string> = {
  home: 'Home',
  welcome: 'Welcome and setup',
  apps: 'Apps',
  latex: 'LaTeX',
  chats: 'Chats',
  managers: 'Managers',
  vscode: 'VS Code chats',
  assistant: 'Personal assistant',
  'assistant-settings': 'Assistant privacy',
  work: 'QUARK',
  job: 'QUARK job',
  attention: 'For your attention',
  activity: 'Recent results',
  review: 'Saved changes',
  transcribe: 'Local transcription',
  projects: 'Projects',
  new: 'Start or connect a project',
  resources: 'Computer health',
  computers: 'Computers and accounts',
  search: 'Saved history',
  settings: 'Settings',
  advanced: 'Advanced controls',
  models: 'Model preferences',
  phone: 'Phone access',
  recovery: 'Recovery copies',
  workspace: 'Open conversations',
};
const href = (page: string) => `#/${page}`;
const route = () =>
  window.location.hash.startsWith('#/')
    ? (window.location.hash.slice(2) || 'home')
        .replace(/^usage(?=\/|$)/, 'work')
        .replace(/^advanced\/?$/, 'settings')
    : new URLSearchParams(window.location.search).has('mirror')
      ? 'vscode'
      : 'home';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const nav = [
  { key: 'chats', label: 'Chats', icon: MessageCircle },
  { key: 'apps', label: 'Apps', icon: LayoutGrid },
  { key: 'work', label: 'QUARK', icon: Layers3 },
];
const section = (page: string) =>
  [
    'chats',
    'managers',
    'vscode',
    'chat',
    'assistant',
    'projects',
    'project',
    'task',
    'new',
  ].includes(page)
    ? 'chats'
    : ['work', 'job', 'attention', 'activity', 'review', 'transcribe', 'resources'].includes(page)
      ? 'work'
      : page;

function Mark({ className = '' }: { className?: string }) {
  return <img className={className} src="/dock.svg?v=drawn-alien" alt="" width="36" height="32" />;
}
// The most constrained general window is the headline; model windows stay in detail.
function headline(provider: ProviderCapacity) {
  const general = provider.windows.filter((w) => w.scope === 'general');
  return (general.length ? general : provider.windows).reduce<CapacityWindow | undefined>(
    (low, w) => (!low || w.usedPercent > low.usedPercent ? w : low),
    undefined,
  );
}
/** Closes an open disclosure on an outside press or Escape. */
function useDismiss(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    const close = (event: Event) => {
      const element = ref.current;
      if (!element?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        element.open = false;
        element.querySelector('summary')?.focus();
      } else if (!element.contains(event.target as Node)) element.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [ref]);
}
function AllowanceChip({
  provider,
  error,
  now,
}: {
  provider: ProviderCapacity;
  error: boolean;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);
  useDismiss(ref);
  const window = headline(provider);
  const stale =
    error ||
    provider.stale ||
    provider.state !== 'ready' ||
    !provider.observedAt ||
    (!!provider.nextRefreshAt && now > Date.parse(provider.nextRefreshAt) + 60_000) ||
    (!!window?.resetsAt && Date.parse(window.resetsAt) <= now);
  const remaining = window ? Math.round(100 - window.usedPercent) : null;
  const name = provider.label || providerName(provider.provider);
  return (
    <details
      ref={ref}
      className={`home-allowance home-usage-${provider.provider} ${stale ? 'is-stale' : ''}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        aria-label={`${name}: ${
          remaining === null
            ? 'remaining allowance unknown'
            : `${remaining}% left in the ${window!.label} window${stale ? ', last reading' : ''}`
        }. Show allowance details`}
      >
        <ProviderMark provider={provider.provider} />
        <span className="home-allowance-value">{remaining === null ? '—' : `${remaining}%`}</span>
        <span className="home-allowance-label">left</span>
      </summary>
      <div className="home-popover">
        <p className="home-popover-title">
          {name}
          {provider.plan && <span> · {provider.plan}</span>}
        </p>
        {provider.windows.length ? (
          <ul className="home-allowance-windows">
            {provider.windows.map((w) => (
              <li key={w.id}>
                <span>{w.label}</span>
                <strong>{Math.round(100 - w.usedPercent)}% left</strong>
                <span className="home-allowance-track" aria-hidden="true">
                  <span style={{ width: `${Math.max(0, 100 - w.usedPercent)}%` }} />
                </span>
                <small>{resetLabel(w.resetsAt, now)}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p>No allowance windows reported. Unknown is not the same as empty.</p>
        )}
        <p className="home-popover-note">
          {stale
            ? `Last reading ${ago(provider.observedAt, now) ?? 'not available'}. ${provider.message}`
            : `Read ${ago(provider.observedAt, now)}. One shared reading for all agents on this computer.`}
        </p>
        {open && <ProviderActions provider={provider.provider} />}
      </div>
    </details>
  );
}
function Allowances({ data, now }: { data: HomeData; now: number }) {
  const usage = data.capacity.data;
  if (!usage)
    return data.capacity.error ? (
      <a className="home-chip" href={href('work')}>
        Allowance unavailable
      </a>
    ) : (
      <span className="home-chip muted">Reading allowance…</span>
    );
  if (!usage.providers.length)
    return (
      <a className="home-chip" href={href('work')}>
        No accounts reported
      </a>
    );
  return (
    <>
      {usage.providers.map((provider) => (
        <AllowanceChip
          key={`${provider.provider}:${provider.account}`}
          provider={provider}
          error={data.capacity.error}
          now={now}
        />
      ))}
    </>
  );
}

function selectedHost(data: HomeData) {
  const scope = apiScope();
  return scope === 'local'
    ? (data.hosts.data?.local.label ?? 'This computer')
    : (data.hosts.data?.hosts.find((h) => h.id === scope)?.label ?? 'Selected computer');
}
function ComputerLink({ data }: { data: HomeData }) {
  const scope = apiScope();
  const host = scope === 'local' ? null : data.hosts.data?.hosts.find((h) => h.id === scope);
  const state = data.snapshot.error
    ? 'offline'
    : host && host.status !== 'connected'
      ? host.status === 'connecting'
        ? 'connecting'
        : host.status === 'error'
          ? 'connection problem'
          : 'offline'
      : data.snapshot.data
        ? 'online'
        : 'checking';
  const label = selectedHost(data);
  return (
    <a
      href={href('computers')}
      className="home-computer"
      aria-label={`${label}: ${state}. Check and manage computers and accounts`}
    >
      <span
        className={`home-status-dot ${state === 'online' ? '' : state === 'checking' || state === 'connecting' ? 'muted' : 'bad'}`}
      />
      <span className="home-computer-name">{label}</span>
      <span className="home-computer-state">{state}</span>
      <ChevronRight size={14} aria-hidden="true" />
    </a>
  );
}
// Configured access is not a connected phone; only observed state is shown.
function phoneState(
  status: PhoneStatus | null,
  error: boolean,
  loaded: boolean,
  now: number,
): [string, 'ok' | 'muted' | 'bad'] {
  if (!loaded) return ['Checking', 'muted'];
  if (error || !status) return ['Status unavailable', 'muted'];
  if (status.mode === 'remote') return ['Using this device', 'ok'];
  if (!status.configured) return ['Not set up', 'muted'];
  if (status.setupIssue) return ['Setup needs attention', 'bad'];
  if (!status.enabled || status.connection === 'off') return ['Off', 'muted'];
  if (status.connection === 'connecting') return ['Connecting', 'muted'];
  if (status.connection === 'error') return ['Connection problem', 'bad'];
  if (status.pending) return ['Pairing waiting for confirmation', 'bad'];
  const devices = status.devices.filter(
    (d) => !d.revokedAt && (!d.expiresAt || Date.parse(d.expiresAt) > now),
  ).length;
  return devices
    ? [`On · ${plural(devices, 'paired device')}`, 'ok']
    : ['On · no phone paired', 'muted'];
}

export function Home() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 700px)');
    const change = () => setMobile(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  const [visible, setVisible] = useState<{ height: number; top: number }>();
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    // iOS keyboards shrink the visible area and pan it (offsetTop) without updating
    // 100dvh. The fixed shell covers exactly that area, so the page itself never
    // scrolls and the composer stays above the keyboard. Pinch zoom is left alone.
    const resize = () => {
      if (viewport.scale !== 1) return;
      const height = viewport.height;
      // A full-height viewport can move during iOS rubber-band scrolling. Following
      // that offset moves the whole app and opens blank bands. Only follow a pan
      // while the keyboard actually reduces the visible height.
      const top = height < window.innerHeight - 80 ? Math.max(0, viewport.offsetTop) : 0;
      setVisible((old) => (old?.height === height && old.top === top ? old : { height, top }));
    };
    resize();
    viewport.addEventListener('resize', resize);
    viewport.addEventListener('scroll', resize);
    return () => {
      viewport.removeEventListener('resize', resize);
      viewport.removeEventListener('scroll', resize);
    };
  }, []);
  const data = useHomeData();
  const phone = useReading('/phone/status', phoneStatusSchema.parse);
  const [currentRoute, setPage] = useState(route);
  useEffect(() => {
    const replaceAlias = () => {
      if (/^#\/usage(?:\/|$)/.test(location.hash) || /^#\/advanced\/?$/.test(location.hash))
        history.replaceState(
          history.state,
          '',
          `${location.pathname}${location.search}#/${route()}`,
        );
    };
    replaceAlias();
    window.addEventListener('hashchange', replaceAlias);
    return () => window.removeEventListener('hashchange', replaceAlias);
  }, []);
  const page = currentRoute.split('/')[0]!;
  const [now, setNow] = useState(Date.now);
  const [dialog, setDialog] = useState<'help' | 'phone' | null>(null);
  const main = useRef<HTMLElement>(null);
  const back = useNavigation(currentRoute, main);
  const scrollHint = useScrollHints(main, currentRoute);
  const previousRoute = useRef(currentRoute);
  const hasNavigated = useRef(false);
  const scrollPositions = useRef(new Map<string, number>());
  useEffect(() => {
    if (
      currentRoute !== 'home' ||
      location.hash ||
      !data.snapshot.data ||
      data.snapshot.data.projects.length
    )
      return;
    location.replace(`${location.pathname}${location.search}#/welcome`);
  }, [data.snapshot.data, currentRoute]);
  useEffect(() => {
    const change = () => {
      scrollPositions.current.set(previousRoute.current, main.current?.scrollTop ?? 0);
      const next = route();
      previousRoute.current = next;
      hasNavigated.current = true;
      setPage(next);
      if (next === 'home') scrollPositions.current.clear();
    };
    window.addEventListener('hashchange', change);
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      window.removeEventListener('hashchange', change);
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!hasNavigated.current) return;
    main.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
    main.current?.scrollTo({
      top: scrollPositions.current.get(currentRoute) ?? 0,
      behavior: 'instant',
    });
  }, [currentRoute]);
  useEffect(() => {
    const id = currentRoute.split('/')[1];
    const name =
      page === 'chat'
        ? data.snapshot.data?.agents.find((agent) => agent.id === id)?.name
        : page === 'project'
          ? data.snapshot.data?.projects.find((project) => project.id === id)?.name
          : page === 'task'
            ? data.snapshot.data?.tasks.find((task) => task.id === id)?.title
            : undefined;
    document.title = `${name ?? (page === 'chat' ? 'Conversation' : page === 'task' ? 'Task' : (titles[page] ?? 'Page not found'))} · sciencewithagents`;
  }, [page, currentRoute, data.snapshot.data]);
  const active = section(page);
  const [phoneText, phoneTone] = phoneState(phone.data, phone.error, phone.loaded, now);
  // Following a link inside a dialog leaves the dialog behind.
  const closeOnLink = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('a')) setDialog(null);
  };
  return (
    <Navigation.Provider value={back}>
      <div
        className="home-shell"
        style={
          visible
            ? ({
                position: 'fixed',
                top: visible.top,
                left: 0,
                right: 0,
                height: visible.height,
                // Composer caps use the visible height; 100dvh ignores an open keyboard.
                '--home-visible-height': `${visible.height}px`,
                '--home-visible-top': `${visible.top}px`,
              } as CSSProperties)
            : undefined
        }
      >
        <a
          className="home-skip"
          href="#home-content"
          onClick={(event) => {
            event.preventDefault();
            main.current?.querySelector<HTMLElement>('h1')?.focus();
            main.current?.scrollIntoView();
          }}
        >
          Skip to content
        </a>
        <header className="home-header">
          <div className="home-header-inner">
            {page !== 'home' && <BackLink />}
            <a className="home-brand" href={href('home')} aria-label="sciencewithagents home">
              <Mark />
              {page === 'home' && (
                <span>
                  science<span className="home-brand-light">with</span>agents
                </span>
              )}
            </a>
            {page !== 'home' && (
              <nav className="home-desktop-nav" aria-label="Main navigation">
                {nav.map((item) => (
                  <a
                    key={item.key}
                    href={href(item.key)}
                    aria-current={active === item.key ? 'page' : undefined}
                  >
                    {item.label}
                  </a>
                ))}
              </nav>
            )}
            {!mobile && (
              <div className="home-header-status" aria-label="Allowance">
                <Allowances data={data} now={now} />
              </div>
            )}
            <div className="home-header-actions">
              <button
                type="button"
                className="home-icon-button"
                aria-label="Help and setup"
                aria-haspopup="dialog"
                onClick={() => setDialog('help')}
              >
                <CircleHelp size={20} />
              </button>

              <a href={href('settings')} className="home-icon-button" aria-label="Settings">
                <Settings2 size={19} />
              </a>
            </div>
          </div>
        </header>
        <AppUpdate />
        <div className="home-topline">
          <ComputerLink data={data} />
          {page === 'home' && !mobile && <HomeOrb size={20} />}
          <button
            type="button"
            className={`home-phone tone-${phoneTone}`}
            aria-haspopup="dialog"
            aria-label={`Phone access: ${phoneText}. Open phone setup and devices`}
            onClick={() => setDialog('phone')}
          >
            <Smartphone size={16} aria-hidden="true" />
            <span>Phone:</span>
            <strong>{phoneText}</strong>
          </button>
        </div>
        <main className="home-content" id="home-content" ref={main}>
          {page === 'home' && <PullToRefresh main={main} />}
          {mobile && page === 'home' && (
            <div className="home-mobile-status" aria-label="Computer and allowances">
              <div className="home-mobile-readings">
                <ComputerLink data={data} />
                <div className="home-mobile-allowances">
                  <Allowances data={data} now={now} />
                </div>
              </div>
              <HomeOrb />
            </div>
          )}
          {page === 'welcome' ? (
            <Welcome data={data} />
          ) : page === 'home' ? (
            <HomeOverview data={data} now={now} />
          ) : page === 'apps' ? (
            <AppsGallery key={apiScope()} />
          ) : page === 'latex' ? (
            <LatexApp initialId={currentRoute.split('/')[1]} />
          ) : flowPages.has(page) ? (
            <WorkspaceFlow route={currentRoute} data={data} />
          ) : activityPages.has(page) ? (
            <ActivityFlow currentRoute={currentRoute} data={data} />
          ) : page === 'advanced' ? (
            <AdvancedFlow route={currentRoute} data={data} />
          ) : connectionPages.has(page) ? (
            <ConnectionFlow route={currentRoute} data={data} />
          ) : page === 'models' ? (
            <ModelSettings />
          ) : page === 'resources' ? (
            <Resources reading={data.resources} />
          ) : (
            <section className="home-placeholder">
              <div className="home-placeholder-content">
                <h1 tabIndex={-1}>This page is not available</h1>
                <p>
                  This address does not match a page in this version of the app. Nothing changed.
                </p>
                <a href={href('home')} className="home-placeholder-return">
                  Go to Home <ArrowRight size={17} />
                </a>
              </div>
            </section>
          )}
        </main>
        <div className="home-scroll-hint" aria-hidden={!scrollHint}>
          {scrollHint}
        </div>
        {dialog === 'help' && (
          <Modal title="Help and setup" close={() => setDialog(null)} className="home-help-dialog">
            <div className="home-help" onClickCapture={closeOnLink}>
              <section>
                <h3>App display</h3>
                <p>Reload to load the latest interface. Work running on your computer continues.</p>
                <button type="button" className="setup-link" onClick={() => location.reload()}>
                  Reload app
                </button>
              </section>
              <section>
                <h3>Check this computer</h3>
                <p>Check provider sign-in and available models. This does not send a prompt.</p>
                <a className="setup-link" href={href('welcome')}>
                  Open setup checks <ArrowRight size={16} />
                </a>
              </section>
              <section>
                <h3>Phone access</h3>
                <p>Pair a phone or manage paired devices. Existing pairing is kept.</p>
                <button type="button" className="setup-link" onClick={() => setDialog('phone')}>
                  Open phone access <ArrowRight size={16} />
                </button>
              </section>
              <section>
                <h3>Accounts for apps that publish online</h3>
                <SetupGuide />
              </section>
            </div>
          </Modal>
        )}
        {dialog === 'phone' && (
          <PhoneSettings
            close={() => {
              setDialog(null);
              phone.retry();
            }}
          />
        )}
      </div>
    </Navigation.Provider>
  );
}
