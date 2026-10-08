import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  MessageCircle,
  RefreshCw,
} from 'lucide-react';
import {
  projectAppsStatusSchema,
  publishingAccountsSchema,
  type PublishingAccounts,
  type ProjectAppView,
} from '@dock/shared';
import { api, apiScope } from '../api';
import { documentLibraryResponseSchema } from '../document-responses';
import { PromptCard } from '../SetupPrompt';
import { useReading } from './useHomeData';
import './apps-gallery.css';

type AppsReading = ReturnType<typeof useAppsReading>;
const parseApps = projectAppsStatusSchema.parse;
const useAppsReading = () => useReading('/apps', parseApps);
const stateLabel = {
  running: 'Running',
  stopped: 'Stopped',
  not_responding: 'Not responding',
} as const;
// Soft icon colours, chosen from the app ID so a tile keeps its look between visits.
const iconColours = [
  ['#e6e9f8', '#3f4fae'],
  ['#f6e8df', '#8a4a25'],
  ['#efe6f4', '#6b3f8a'],
  ['#e3eef0', '#2f6670'],
  ['#f4ecd9', '#7a5a14'],
  ['#f6e3e6', '#8f3446'],
] as const;
function AppIcon({ app }: { app: ProjectAppView }) {
  const [background, color] = iconColours[parseInt(app.id.slice(0, 2), 16) % iconColours.length]!;
  const letters = app.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase())
    .join('');
  return (
    <span className="project-app-icon" style={{ background, color }} aria-hidden="true">
      {letters}
    </span>
  );
}
function appState(app: ProjectAppView, reading: AppsReading) {
  return reading.error ? 'Status unavailable' : stateLabel[app.state];
}
const host = (url: string) => new URL(url).host;

// Setup prompts are copied, never executed here. Each step is needed only by the
// app or connection route that uses it, not by ordinary local chats.
const setupSteps = [
  {
    id: 'github',
    title: 'GitHub account and gh sign-in',
    detail:
      'Needed for apps whose code is backed up or published through GitHub. Create a GitHub account first if you do not have one.',
    label: 'Prompt for your setup agent',
    prompt:
      'Set up GitHub sign-in on this computer. Check the installed GitHub CLI and existing account first. If gh is missing, install it using the official method for this operating system; handle the technical steps yourself. Preserve a working sign-in. Otherwise open the native browser sign-in and tell me when I need to complete it. Never ask me to paste credentials into chat. This step does not create repositories or upload files. Finish by checking the connected account and explaining any step that still needs me.',
  },
  {
    id: 'cloudflare',
    title: 'Cloudflare account and Wrangler sign-in',
    detail:
      'Needed for apps hosted on Cloudflare and for the Cloudflare phone connection. Create a Cloudflare account first if you do not have one.',
    label: 'Prompt for your setup agent',
    prompt:
      'Set up Cloudflare sign-in on this computer using my own Cloudflare account and the official Wrangler CLI. Check for an existing installation and working account first, and preserve them. Handle any required CLI setup yourself, then open the native browser sign-in only if needed and tell me when I need to complete it. Never ask me to paste credentials into chat. Finish by checking the connected account. This account check alone does not deploy a project or configure phone access. For Groups, follow docs/GROUP_HOSTING.md to deploy the creator’s shared service in their own Workers Free account; other members join by invitation. For phone access, follow the current docs/CLOUDFLARE_SETUP.md runbook using my own Workers Free account and a free workers.dev address, and walk me through account selection and device pairing. No domain purchase is needed. Preserve existing connections. Local desktop chats do not require Cloudflare.',
  },
] as const;

type AccountSetup = ReturnType<typeof useAccountSetup>;
/** Reads saved sign-in results, then asks the selected computer for a bounded refresh. */
function useAccountSetup(enabled = true) {
  const [status, setStatus] = useState<PublishingAccounts | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const check = useCallback(async (force: boolean) => {
    setChecking(true);
    setError('');
    try {
      setStatus(
        publishingAccountsSchema.parse(
          await api('/publishing-accounts/check', { force }, undefined, 45_000),
        ),
      );
    } catch (failure) {
      setError(
        `Sign-in could not be checked. ${failure instanceof Error ? failure.message : 'Try again.'}`,
      );
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      try {
        const saved = publishingAccountsSchema.parse(await api('/publishing-accounts'));
        if (!alive) return;
        setStatus(saved);
        // The computer reuses a recent result, so opening a guide rarely runs the CLIs.
        if (saved.available) await check(false);
      } catch (failure) {
        if (alive)
          setError(
            `Sign-in could not be checked. ${failure instanceof Error ? failure.message : 'Try again.'}`,
          );
      }
    })();
    return () => {
      alive = false;
    };
  }, [check, enabled]);
  const account = (id: string) => status?.accounts.find((item) => item.id === id);
  return {
    status,
    account,
    checking: checking || !!status?.checking,
    error,
    check,
    complete:
      !!status?.available && setupSteps.every((step) => account(step.id)?.state === 'connected'),
  };
}
const checkedLabel = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** One numbered copy-prompt guide, shared by Apps and Help. */
export function SetupGuide(props: { headingLevel?: 2 | 3; computer: string }) {
  const setup = useAccountSetup();
  return <SetupGuideView {...props} setup={setup} />;
}

function SetupGuideView({
  headingLevel = 3,
  computer,
  setup,
}: {
  headingLevel?: 2 | 3;
  computer: string;
  setup: AccountSetup;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const available = !!setup.status?.available;
  const checkedAt = setup.status?.accounts.find((item) => item.checkedAt)?.checkedAt;
  return (
    <div className="setup-guide">
      <p className="setup-guide-note">
        Paste a prompt into a Codex or Claude chat on {computer}. Copying does not run it.{' '}
        {available
          ? 'Completed steps come from a read-only sign-in check on that computer. Checking never signs in or changes an account.'
          : 'This installation does not check GitHub or Cloudflare for you; your agent’s answer is the result.'}
      </p>
      {available && (
        <div className="setup-check">
          <span role="status">
            {setup.checking
              ? 'Checking sign-in…'
              : checkedAt
                ? `Checked ${checkedLabel(checkedAt)}`
                : 'Not checked yet'}
          </span>
          <button
            type="button"
            className="setup-link"
            disabled={setup.checking}
            onClick={() => void setup.check(true)}
          >
            <RefreshCw size={16} aria-hidden="true" /> Check again
          </button>
        </div>
      )}
      {setup.error && (
        <p className="apps-problem" role="alert">
          {setup.error}
        </p>
      )}
      <ol>
        {setupSteps.map((step, index) => {
          const account = available ? setup.account(step.id) : undefined;
          const done = account?.state === 'connected';
          return (
            <li key={step.id} className={done ? 'setup-step-done' : undefined}>
              <Heading>
                <span className="setup-step-number">
                  {done ? <Check size={16} aria-label="Done" /> : index + 1}
                </span>
                {step.title}
              </Heading>
              {account && (
                <p className={`setup-account state-${account.state}`}>
                  {account.state === 'unchecked' && setup.checking ? 'Checking…' : account.message}
                </p>
              )}
              {done ? (
                // Completed steps stay available for a different account or another computer.
                <details className="setup-step-help">
                  <summary>
                    Show setup prompt <ChevronDown size={18} aria-hidden="true" />
                  </summary>
                  <p>{step.detail}</p>
                  <PromptCard label={step.label} prompt={step.prompt} />
                </details>
              ) : (
                <>
                  <p>{step.detail}</p>
                  <PromptCard label={step.label} prompt={step.prompt} />
                </>
              )}
            </li>
          );
        })}
        <li>
          <Heading>
            <span className="setup-step-number">{setupSteps.length + 1}</span>
            Phone access, if you want to open it on your phone
          </Heading>
          <p>Phone access has its own setup and pairing. Existing pairing and devices are kept.</p>
          <a className="setup-link" href="#/phone">
            Open phone access <ArrowUpRight size={16} />
          </a>
        </li>
      </ol>
    </div>
  );
}

/** Registered apps and the reader already used on this computer; fresh installs stay empty. */
export function AppsGallery({ route, computer }: { route: string; computer: string }) {
  const reading = useAppsReading();
  const id = route.split('/')[1];
  return id ? (
    <AppDetail key={id} id={id} reading={reading} computer={computer} />
  ) : (
    <Gallery reading={reading} computer={computer} />
  );
}

function Gallery({ reading, computer }: { reading: AppsReading; computer: string }) {
  const library = useReading('/documents', documentLibraryResponseSchema.parse);
  const hasReader = !!library.data?.documents.length;
  const heading = useRef<HTMLHeadingElement>(null);
  // A display preference, not a claim that an account is authenticated.
  const setupKey = `dock:${apiScope()}:apps:hide-setup`;
  const [hideSetup, setHideSetup] = useState(() => {
    try {
      return localStorage.getItem(setupKey) === '1';
    } catch {
      return false;
    }
  });
  function dismissSetup() {
    try {
      localStorage.setItem(setupKey, '1');
    } catch {
      // The shortcut still hides for this visit when storage is unavailable.
    }
    setHideSetup(true);
    heading.current?.focus();
  }
  const setup = useAccountSetup(!hideSetup);
  const github = setup.account('github');
  const done = setupSteps.filter((step) => setup.account(step.id)?.state === 'connected').length;
  const apps = reading.data?.apps ?? [];
  return (
    <section className="apps-page" aria-labelledby="apps-heading">
      <header className="apps-heading">
        <p className="home-eyebrow">APPS</p>
        <h1 id="apps-heading" tabIndex={-1} ref={heading}>
          Apps
        </h1>
        <p>Tools for your projects.</p>
      </header>
      <ul className="apps-grid">
        {hasReader && (
          <li>
            <a href="#/latex" className="apps-tile" aria-label="LaTeX / PDF reader">
              <span className="latex-app-icon" aria-hidden="true">
                T<span>E</span>X
              </span>
              <span className="apps-tile-name">LaTeX</span>
              <span className="apps-tile-project">PDFs &amp; reading</span>
            </a>
          </li>
        )}
        {apps.map((app) => (
          <li key={app.id}>
            <a
              href={`#/apps/${app.id}`}
              className="apps-tile"
              aria-label={`${app.name}, ${app.projectName}: ${appState(app, reading)}`}
            >
              <AppIcon app={app} />
              <span className="apps-tile-name" title={app.name}>
                {app.name}
              </span>
              <span className="apps-tile-project">{app.projectName}</span>
              <span className={`apps-state state-${reading.error ? 'unknown' : app.state}`}>
                {appState(app, reading)}
              </span>
            </a>
          </li>
        ))}
      </ul>
      {!reading.loaded || !library.loaded ? (
        <p className="apps-note" role="status">
          Checking apps…
        </p>
      ) : reading.error ? (
        <div className="apps-note apps-problem" role="status">
          <p>Project apps could not be read from this computer. Nothing was changed.</p>
          <button type="button" className="setup-link" onClick={reading.retry}>
            <RefreshCw size={16} aria-hidden="true" /> Try again
          </button>
        </div>
      ) : (
        !apps.length &&
        !hasReader &&
        !library.error && (
          <p className="apps-note">
            No apps added yet. Web apps your project managers build appear here after they register
            them.
          </p>
        )
      )}
      {library.error && (
        <div className="apps-note apps-problem" role="status">
          <p>Saved documents could not be checked.</p>
          <a className="setup-link" href="#/latex">
            Open LaTeX / PDF reader
          </a>
          <button type="button" className="setup-link" onClick={library.retry}>
            Retry documents
          </button>
        </div>
      )}
      {!hideSetup &&
        (setup.complete ? (
          <p className="apps-setup-complete">
            <CheckCircle2 size={18} aria-hidden="true" />
            <span>
              GitHub{github?.identity ? ` (${github.identity})` : ''} and Cloudflare are signed in
              on {computer}. Setup help stays in Help and setup.
            </span>
          </p>
        ) : (
          <details className="apps-setup">
            <summary>
              <span>
                Set up publishing accounts
                {setup.status?.available && done > 0 && (
                  <span className="apps-setup-progress">
                    {' '}
                    · {done} of {setupSteps.length} done
                  </span>
                )}
              </span>
              <ChevronDown size={20} aria-hidden="true" />
            </summary>
            <div className="apps-setup-content">
              <p>
                Only apps that use GitHub or Cloudflare need these accounts. Local chats and
                projects work without them.
              </p>
              <div className="apps-setup-dismiss">
                <p>Already set up? These instructions are always available in Help and setup.</p>
                <button type="button" className="setup-link" onClick={dismissSetup}>
                  Hide setup shortcut
                </button>
              </div>
              <SetupGuideView setup={setup} computer={computer} />
            </div>
          </details>
        ))}
    </section>
  );
}

function AppDetail({
  id,
  reading,
  computer,
}: {
  id: string;
  reading: AppsReading;
  computer: string;
}) {
  const app = reading.data?.apps.find((item) => item.id === id);
  const [confirm, setConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');
  const removal = useRef<string | null>(null);
  if (!app)
    return (
      <section className="apps-page" aria-labelledby="app-heading">
        <header className="apps-heading">
          <p className="home-eyebrow">APPS</p>
          <h1 id="app-heading" tabIndex={-1}>
            {!reading.loaded
              ? 'Checking app…'
              : reading.error
                ? 'App unavailable'
                : 'App not found'}
          </h1>
          {reading.loaded && (
            <p>
              {reading.error
                ? 'This computer’s apps could not be read. Nothing was changed.'
                : 'This app is no longer registered on this computer.'}
            </p>
          )}
        </header>
        <div className="apps-actions">
          {reading.error && (
            <button type="button" className="setup-link" onClick={reading.retry}>
              <RefreshCw size={16} aria-hidden="true" /> Try again
            </button>
          )}
          <a className="setup-link" href="#/apps">
            All apps
          </a>
        </div>
      </section>
    );
  const openHere = reading.data!.openHere;
  async function remove() {
    if (!app || removing) return;
    setRemoving(true);
    setError('');
    // Reuse the receipt after an ambiguous failure so a retry cannot remove twice.
    removal.current ??= crypto.randomUUID();
    try {
      await api(`/apps/${app.id}/remove`, { key: removal.current, expectedRevision: app.revision });
      reading.retry();
      location.hash = '#/apps';
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The app could not be removed.');
    } finally {
      setRemoving(false);
    }
  }
  const state = reading.error ? 'unknown' : app.state;
  return (
    <section className="apps-page app-detail" aria-labelledby="app-heading">
      <header className="apps-heading app-detail-heading">
        <AppIcon app={app} />
        <div>
          <p className="home-eyebrow">APP · {app.projectName}</p>
          <h1 id="app-heading" tabIndex={-1}>
            {app.name}
          </h1>
          {app.description && <p>{app.description}</p>}
        </div>
      </header>
      <div className="app-status-card" role="status">
        <span className={`apps-state state-${state}`}>{appState(app, reading)}</span>
        <p>
          {reading.error
            ? 'The latest check could not reach this computer. The app itself was not changed.'
            : app.state === 'running'
              ? `Available on ${computer} at localhost:${app.port}.`
              : app.state === 'stopped'
                ? `Nothing is listening on localhost:${app.port}. Ask its manager to start the app.`
                : `localhost:${app.port} is not answering. The app may be starting or busy.`}
        </p>
        <button type="button" className="setup-link" onClick={reading.retry}>
          <RefreshCw size={16} aria-hidden="true" /> Check again
        </button>
      </div>
      <div className="apps-actions">
        {openHere ? (
          // The status can be seconds old, so a stopped app stays openable but quieter.
          <a
            className={`app-open${app.state === 'running' ? '' : ' quiet'}`}
            href={app.localUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open app <ArrowUpRight size={18} aria-hidden="true" />
          </a>
        ) : (
          <p className="apps-note">
            This app runs on {computer}. Its local address opens only in a browser on that computer.
          </p>
        )}
        {app.remoteUrl && (
          <a className="setup-link" href={app.remoteUrl} target="_blank" rel="noopener noreferrer">
            Open {host(app.remoteUrl)} <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        )}
        {app.managerId && (
          <a className="setup-link" href={`#/chat/${app.managerId}`}>
            <MessageCircle size={16} aria-hidden="true" /> {app.managerName ?? 'Project manager'}
          </a>
        )}
      </div>
      <dl className="app-facts">
        <div>
          <dt>Local address</dt>
          <dd>{app.localUrl}</dd>
        </div>
        {app.remoteUrl && (
          <div>
            <dt>Other devices</dt>
            <dd>{app.remoteUrl}</dd>
          </div>
        )}
        <div>
          <dt>Project</dt>
          <dd>
            <a href={`#/project/${app.projectId}`}>{app.projectName}</a>
          </dd>
        </div>
      </dl>
      <div className="app-remove">
        {confirm ? (
          <>
            <p>Remove from Apps? The app, its files and anything running stay unchanged.</p>
            <div className="apps-actions">
              <button
                type="button"
                className="setup-link danger"
                disabled={removing}
                onClick={() => void remove()}
              >
                {removing ? 'Removing…' : 'Remove'}
              </button>
              <button type="button" className="setup-link" onClick={() => setConfirm(false)}>
                Keep
              </button>
            </div>
          </>
        ) : (
          <button type="button" className="setup-link" onClick={() => setConfirm(true)}>
            Remove from Apps
          </button>
        )}
        {error && (
          <p className="apps-problem" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
