import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  CircleHelp,
  Cpu,
  FolderPlus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Users,
} from 'lucide-react';
import {
  latestFamily,
  modelTierSchema,
  policyProvider,
  setupStatusSchema,
  signInStatusSchema,
  taskClassSchema,
  taskTiers,
  tierLabels,
  type SetupStatus,
  type SignInStatus,
} from '@dock/shared';
import { api } from '../api';
import { ClaudeSignIn } from './ClaudeSignIn';
import { ProviderCliSetup } from './ProviderCliSetup';
import { FlowHeading } from './WorkspaceFlow';
import type { HomeData } from './useHomeData';
import './welcome.css';

const names = { codex: 'Codex', claude: 'Claude' };
const tiersHighToLow = modelTierSchema.options.slice().reverse();
const accountLabels = {
  unchecked: 'Not checked yet',
  'signed-in': 'Native sign-in found',
  'sign-in': 'Sign-in needed',
  custom: 'Custom authentication configured',
  unavailable: 'Could not verify sign-in',
};
const fresh = (time: string | null) => !!time && Date.now() - Date.parse(time) < 300_000;

function CodexSignIn({ checked }: { checked: () => void }) {
  const [value, setValue] = useState<SignInStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const notified = useRef<string | null>(null);
  const checking = useRef(false);
  async function read() {
    if (checking.current) return;
    checking.current = true;
    try {
      const next = signInStatusSchema.parse(await api('/setup/sign-in'));
      if (!active.current) return;
      setValue(next);
      setError('');
      if (next.state === 'completed' && notified.current !== next.key) {
        notified.current = next.key;
        checked();
      }
    } catch (e) {
      if (active.current) setError(e instanceof Error ? e.message : 'Could not check sign-in.');
    } finally {
      checking.current = false;
    }
  }
  useEffect(() => {
    active.current = true;
    void read();
    const timer = window.setInterval(() => {
      if (!document.hidden) void read();
    }, 3000);
    return () => {
      active.current = false;
      window.clearInterval(timer);
    };
  }, []);
  async function act(cancel = false) {
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = signInStatusSchema.parse(
        await api(cancel ? '/setup/sign-in/cancel' : '/setup/sign-in', {
          key: cancel ? value.key : crypto.randomUUID(),
        }),
      );
      if (active.current) setValue(next);
    } catch (e) {
      if (active.current) {
        setValue(null);
        setError(
          e instanceof Error
            ? e.message
            : 'Sign-in could not be confirmed. Check its status before trying again.',
        );
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className="welcome-sign-in">
      {error && <p role="alert">{error}</p>}
      {!value ? (
        <button className="flow-button" disabled={busy} onClick={() => void read()}>
          Check sign-in status
        </button>
      ) : value.state === 'pending' ? (
        <>
          <p>
            Enter this one-time code on OpenAI’s sign-in page. Credentials stay with Codex on the
            selected computer.
          </p>
          <strong className="welcome-code">{value.userCode}</strong>
          <a
            className="flow-button primary"
            href={value.verificationUrl!}
            target="_blank"
            rel="noreferrer"
          >
            Open OpenAI sign-in <ArrowUpRight size={16} />
          </a>
          <button className="flow-button" disabled={busy} onClick={() => void act(true)}>
            Cancel sign-in
          </button>
          <small>This window closes after 15 minutes. A provider code may expire sooner.</small>
        </>
      ) : value.state === 'starting' ? (
        <p role="status">Opening native sign-in…</p>
      ) : value.state === 'completed' ? (
        <p role="status">Sign-in completed. Check this computer to verify your available models.</p>
      ) : (
        <>
          {['expired', 'failed'].includes(value.state) && (
            <p>The previous sign-in is no longer active. Starting again requests a new code.</p>
          )}
          <button className="flow-button primary" disabled={busy} onClick={() => void act()}>
            {busy ? 'Opening sign-in…' : 'Sign in with Codex'}
          </button>
          <small>
            For a new sign-in only. Existing accounts and custom credentials are not replaced.
          </small>
        </>
      )}
    </div>
  );
}

export function Welcome({ data }: { data: HomeData }) {
  const [state, setState] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  async function load(check = false) {
    setBusy(true);
    setError('');
    try {
      const result = setupStatusSchema.parse(
        await api(check ? '/setup/check' : '/setup', check ? {} : undefined),
      );
      if (active.current) setState(result);
      return result;
    } catch (e) {
      if (active.current)
        setError(
          e instanceof Error ? e.message : 'Could not read setup. Your settings are retained.',
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void load().then((value) => {
      if (
        active.current &&
        value &&
        value.policy.policy.enabledProviders.some(
          (provider) =>
            !fresh(
              value.accounts.find((account) => account.provider === provider)?.checkedAt ?? null,
            ),
        )
      )
        void load(true);
    });
    data.work.retry();
    data.capacity.retry();
    return () => {
      active.current = false;
    };
  }, []);
  const projects =
    data.snapshot.data?.projects.filter(
      (p) => p.id !== data.frontdesk.data?.projectId && p.id !== data.resources.data?.projectId,
    ) ?? [];
  const projectReady = !!projects.length;
  return (
    <section className="flow-page welcome-page">
      <FlowHeading label="WELCOME / WORKSPACE SETUP" title="Welcome and setup">
        Set up your private workspace and start your first project. Your team, shared allowances and
        results stay connected across computer and phone.
      </FlowHeading>
      <div className="welcome-intro">
        <div>
          <ShieldCheck size={27} />
          <strong>Your computer. Your accounts.</strong>
          <p>
            Managers coordinate the work. QUARK paces the team against shared limits. You review
            decisions and results in one place.
          </p>
        </div>
        <div className="welcome-orbit" aria-hidden="true">
          <span>
            <Users size={25} />
          </span>
          <i>QUARK</i>
          <span>
            <Cpu size={25} />
          </span>
        </div>
      </div>
      {error && (
        <p className="flow-error" role="alert">
          {error}
        </p>
      )}
      <div className="welcome-steps">
        <article className="welcome-step">
          <div className="welcome-step-top">
            <span className="welcome-number">01</span>
            <div>
              <h2>Choose your team</h2>
              <p>
                Use Codex, Claude, or both. Choose the subscriptions you have before checking this
                computer. With one provider, it handles both managers and workers.
              </p>
            </div>
          </div>
          {state && (
            <p className="welcome-saved">
              <Check size={16} /> Saved defaults:{' '}
              {state.policy.policy.enabledProviders.map((p) => names[p]).join(' + ')}
            </p>
          )}
          <a className="flow-button" href="#/models">
            <Users size={17} />
            Choose team defaults
          </a>
          <p className="welcome-fine">
            Already right? Continue below. Model versions and roles can be changed later; existing
            conversations keep their choices.
          </p>
        </article>
        <article className="welcome-step">
          <div className="welcome-step-top">
            <span className="welcome-number">02</span>
            <div>
              <h2>Check this computer</h2>
              <p>
                We check your existing sign-in and available models automatically. No prompt is
                sent.
              </p>
            </div>
          </div>
          <ProviderCliSetup
            key={state?.policy.policy.enabledProviders[0] ?? 'codex'}
            initialProvider={state?.policy.policy.enabledProviders[0] ?? 'codex'}
          />
          <button className="flow-button primary" disabled={busy} onClick={() => void load(true)}>
            <RefreshCw size={17} />
            {busy ? 'Checking…' : 'Check this computer'}
          </button>
          {!state && !busy && (
            <button className="flow-button" onClick={() => void load()}>
              Retry setup status
            </button>
          )}
          {state && (
            <div className="welcome-provider-grid">
              {state.policy.policy.enabledProviders.map((provider) => {
                const account = state.accounts.find((item) => item.provider === provider);
                const catalog = state.policy.catalogs.find((item) => item.provider === provider);
                const ready = account?.state === 'signed-in' && fresh(account.checkedAt);
                const validCatalog =
                  !!catalog?.observedAt && fresh(catalog.observedAt) && !catalog.error;
                const required = new Set(
                  taskClassSchema.options
                    .filter(
                      (task) =>
                        policyProvider(state.policy.policy, task, undefined, true) === provider ||
                        state.policy.policy.preset === 'pick',
                    )
                    .map((task) => taskTiers[task]),
                );
                return (
                  <section
                    className="welcome-provider"
                    key={provider}
                    aria-label={`${names[provider]} readiness`}
                  >
                    <div className="welcome-provider-heading">
                      <h3>{names[provider]}</h3>
                      <span className={`welcome-pill ${ready ? 'ready' : ''}`}>
                        {ready ? <Check size={14} /> : <CircleHelp size={14} />}
                        {accountLabels[account?.state ?? 'unchecked']}
                      </span>
                    </div>
                    {account?.checkedAt && (
                      <p className="welcome-fine">
                        Checked{' '}
                        {new Date(account.checkedAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                        . {!fresh(account.checkedAt) && 'Check again for a current reading.'}
                      </p>
                    )}
                    {account?.state === 'unavailable' && (
                      <p>
                        Check that the {names[provider]} CLI is installed, current and signed in on
                        this computer. Use “Install or update Codex / Claude” above, then retry.
                        This result does not prove you are signed out.
                      </p>
                    )}
                    {account?.state === 'custom' && (
                      <p>
                        {names[provider]} manages this authentication. The catalog can be inspected,
                        but a metadata check cannot confirm credentials for a custom service.
                        {provider === 'claude' &&
                          ' Managed Claude work currently requires subscription sign-in.'}
                      </p>
                    )}
                    {provider === 'codex' && account?.state === 'sign-in' && (
                      <CodexSignIn checked={() => void load(true)} />
                    )}
                    {provider === 'claude' && account?.state === 'sign-in' && (
                      <ClaudeSignIn checked={() => void load(true)} checking={busy} />
                    )}
                    {catalog?.error && (
                      <p role="status" className="welcome-problem">
                        {catalog.error}
                      </p>
                    )}
                    <ul className="welcome-model-list">
                      {tiersHighToLow.map((tier) => {
                        const choice = state.policy.policy.models[provider][tier];
                        const model = choice.model
                          ? catalog?.models.find((item) => item.id === choice.model)
                          : latestFamily(catalog?.models ?? [], choice.family);
                        const usable =
                          validCatalog &&
                          !!model &&
                          (!choice.effort || model.efforts.includes(choice.effort));
                        return (
                          <li key={tier}>
                            <span>
                              <strong>{tierLabels[tier]}</strong>
                              <small>
                                {required.has(tier)
                                  ? 'In your task defaults'
                                  : 'Available for explicit choices'}
                              </small>
                            </span>
                            <span>
                              {usable
                                ? model!.label
                                : !validCatalog
                                  ? 'Needs a current check'
                                  : choice.model
                                    ? `${choice.model} unavailable`
                                    : `${choice.family} unavailable`}
                              {validCatalog && model && !usable && (
                                <small>Choose an available thinking level</small>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                    <a className="welcome-text-link" href="#/models">
                      Review {names[provider]} model choices <ArrowUpRight size={15} />
                    </a>
                  </section>
                );
              })}
            </div>
          )}
          <p className="welcome-fine">
            Readiness can change. Every assignment still checks its model and QUARK allowance before
            starting. A failed check never switches providers.
          </p>
        </article>
        <div className="welcome-next-grid">
          <article className="welcome-step">
            <div className="welcome-step-top">
              <span className="welcome-number">{projectReady ? <Check size={18} /> : '03'}</span>
              <div>
                <h2>{projectReady ? 'Your projects are here' : 'Create a project'}</h2>
                <p>
                  Give a project its own manager. Creating the project starts no model work; your
                  first message does.
                </p>
              </div>
            </div>
            <a className="flow-button primary" href={projectReady ? '#/projects' : '#/new'}>
              <FolderPlus size={17} />
              {projectReady ? 'Open projects' : 'Create first project'}
            </a>
          </article>
          <article className="welcome-step" aria-label="QUARK setup">
            <div className="welcome-step-top">
              <span className="welcome-number">04</span>
              <div>
                <h2>QUARK scheduling</h2>
                <p>QUARK shares provider allowance and computer capacity across your projects.</p>
              </div>
            </div>
            {!data.work.data || data.work.error ? (
              <>
                <p role="status">Pacing status is unavailable. Your saved choice is retained.</p>
                <button className="flow-button" onClick={data.work.retry}>
                  Check pacing status
                </button>
              </>
            ) : (
              <>
                <p className="welcome-saved">
                  <ShieldCheck size={16} />
                  Shared pacing {data.work.data.policy.enabled ? 'on' : 'off'}
                </p>
                <p>
                  {data.work.data.policy.enabled
                    ? 'New work waits for fresh usage readings and enough computer capacity.'
                    : 'Off by default. Turn on shared pacing in QUARK when you want it. Tasks still obey saved allowance caps and manager leases.'}
                </p>
                {data.work.data.policy.enabled &&
                  state &&
                  state.policy.policy.enabledProviders.some((provider) => {
                    const reading = data.capacity.data?.providers.find(
                      (item) => item.provider === provider,
                    );
                    return (
                      data.capacity.error ||
                      !reading ||
                      reading.state !== 'ready' ||
                      reading.stale ||
                      !reading.windows.length
                    );
                  }) && (
                    <p className="welcome-problem" role="status">
                      Some usage readings are missing or out of date. Open QUARK to see which
                      provider needs attention. Protected work may wait.
                    </p>
                  )}
              </>
            )}
            <div className="welcome-actions">
              <a className="flow-button" href="#/work">
                Open QUARK
              </a>
            </div>
          </article>
        </div>
        <aside className="welcome-phone">
          <Smartphone size={25} />
          <div>
            <h2>Phone setup</h2>
            <p>
              Optional after your local workspace is ready. Pairing and phone access have their own
              setup.
            </p>
          </div>
          <a className="flow-button" href="#/phone">
            Connect phone <ArrowUpRight size={16} />
          </a>
        </aside>
      </div>
      <a className="welcome-text-link" href="#/home">
        Open home <ArrowUpRight size={16} />
      </a>
    </section>
  );
}
