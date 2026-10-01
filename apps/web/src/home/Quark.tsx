import { BackLink } from './Navigation';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Pause, ShieldCheck, Clock3 } from 'lucide-react';
import { quarkStatusSchema, type QuarkStatus, type QuarkSettings } from '@dock/shared';
import { api } from '../api';
import type { HomeData } from './useHomeData';
import './Quark.css';

const percent = (n: number) => `${n.toFixed(1)}%`;
const number = (n: number | null) => (n === null ? 'Not reported' : n.toLocaleString());
export function Quark({ data, now, taskId }: { data: HomeData; now: number; taskId?: string }) {
  const [state, setState] = useState<QuarkStatus | null>(null);
  const [settings, setSettings] = useState<QuarkSettings | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [project, setProject] = useState(''),
    [task, setTask] = useState(''),
    [provider, setProvider] = useState<'codex' | 'claude'>('codex');
  const [windowId, setWindowId] = useState(''),
    [limit, setLimit] = useState('10');
  const alive = useRef(true),
    pending = useRef(false),
    receipt = useRef<{ signature: string; key: string } | null>(null);
  const projects = data.snapshot.data?.projects ?? [];
  const tasks = data.snapshot.data?.tasks.filter((t) => t.projectId === project) ?? [];
  const capacity = data.capacity.data?.providers.find((p) => p.provider === provider);
  const initialTask = data.snapshot.data?.tasks.find((item) => item.id === taskId);
  useEffect(() => {
    if (initialTask) {
      setProject(initialTask.projectId);
      setTask(initialTask.id);
    }
  }, [initialTask?.id]);
  async function load() {
    if (pending.current) return;
    pending.current = true;
    try {
      const value = quarkStatusSchema.parse(await api('/quark'));
      if (alive.current) {
        setState(value);
        setSettings((old) => old ?? value.settings);
        setError('');
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Could not load QUARK. Try again.');
    } finally {
      pending.current = false;
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, []);
  async function mutate(path: string, payload: object, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    const signature = JSON.stringify({ path, payload });
    if (receipt.current?.signature !== signature)
      receipt.current = { signature, key: crypto.randomUUID() };
    try {
      const value = quarkStatusSchema.parse(
        await api(path, { ...payload, key: receipt.current.key }),
      );
      if (alive.current) {
        setState(value);
        if (path.endsWith('settings')) setSettings(value.settings);
        receipt.current = null;
        setNotice(message);
        window.dispatchEvent(new Event('swa:refresh-home'));
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const valid = project && windowId && Number(limit) > 0 && Number(limit) <= 100;
  return (
    <section className="quark-page">
      <BackLink />
      <header className="quark-heading">
        <p className="home-eyebrow">QUARK · USAGE & WORK</p>
        <h1 tabIndex={-1}>Usage and allowances</h1>
        <p>Account allowances, project budgets and recorded usage.</p>
      </header>
      {error && (
        <div className="quark-alert" role="alert">
          {error} <button onClick={() => void load()}>Retry reading</button>
        </div>
      )}
      {notice && (
        <p role="status" className="quark-notice">
          {notice}
        </p>
      )}
      {!state && !error && <p role="status">Reading usage and saved budgets…</p>}
      <div className="quark-allowances">
        {data.capacity.data?.providers.map((p) => (
          <article key={p.provider}>
            <p className="home-eyebrow">{p.label}</p>
            {p.windows.map((w) => (
              <div key={w.id}>
                <span>{w.label}</span>
                <strong>
                  {percent(100 - w.usedPercent)} <small>remaining</small>
                </strong>
              </div>
            ))}
            {!p.windows.length && <p>Allowance not reported yet.</p>}
            <p className="quark-muted">
              {p.stale
                ? 'Last reading · refresh needed'
                : 'Shared by all projects on this computer'}
            </p>
            {p.stale && (
              <>
                <p className="quark-muted">{p.message}</p>
                {p.observedAt && (
                  <p className="quark-muted">
                    Last successful reading: {new Date(p.observedAt).toLocaleString()}
                  </p>
                )}
                {p.nextRefreshAt && (
                  <p className="quark-muted">
                    Next automatic check: {new Date(p.nextRefreshAt).toLocaleString()}. Refresh
                    shares this waiting period.
                  </p>
                )}
              </>
            )}
          </article>
        ))}
      </div>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api('/capacity/refresh', {});
            window.dispatchEvent(new Event('swa:refresh-home'));
            await load();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Refresh failed.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <RefreshCw size={14} /> Refresh allowance
      </button>
      {state && (
        <>
          <section className="quark-section">
            <h2>
              <ShieldCheck size={19} /> Spending limits
            </h2>
            <p>
              “Use at most 10%” means ten percentage points of the full allowance, starting when you
              save. Tasks share their cap with descendants. A project cap also includes manager
              overhead. Resets do not refill these budgets.
            </p>
            <form
              className="quark-budget-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid)
                  void mutate(
                    '/quark/budgets',
                    {
                      projectId: project,
                      taskId: task || null,
                      provider,
                      windowId,
                      limitPercent: Number(limit),
                    },
                    'Budget saved. QUARK will enforce it automatically.',
                  );
              }}
            >
              <label>
                Project
                <select
                  aria-label="Project"
                  value={project}
                  onChange={(e) => {
                    setProject(e.target.value);
                    setTask('');
                  }}
                  required
                >
                  <option value="">Choose a project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Work covered
                <select
                  aria-label="Work covered"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                >
                  <option value="">Whole project</option>
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Provider
                <select
                  aria-label="Provider"
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value as 'codex' | 'claude');
                    setWindowId('');
                  }}
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              </label>
              <label>
                Allowance
                <select
                  aria-label="Allowance"
                  value={windowId}
                  onChange={(e) => setWindowId(e.target.value)}
                  required
                >
                  <option value="">Choose a reported window</option>
                  {capacity?.windows
                    .filter((w) => w.scope !== 'other')
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.label}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Use at most (%)
                <input
                  type="number"
                  min="0.1"
                  max="100"
                  step="0.1"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  required
                />
              </label>
              <button className="quark-primary" disabled={busy || !valid}>
                Set budget
              </button>
            </form>
            {!projects.length && (
              <p className="quark-muted">Your workspace projects will appear here when added.</p>
            )}
            {!state.budgets.length && (
              <p className="quark-empty">
                No project caps yet. Shared QUARK pacing still applies when enabled.
              </p>
            )}
            <div className="quark-budget-list">
              {state.budgets.map((b) => (
                <Budget
                  key={b.id}
                  budget={b}
                  name={projects.find((p) => p.id === b.projectId)?.name ?? 'Project'}
                  task={data.snapshot.data?.tasks.find((t) => t.id === b.taskId)?.title}
                  busy={busy}
                  save={(n) =>
                    mutate(
                      '/quark/budgets',
                      {
                        id: b.id,
                        expectedRevision: b.revision,
                        projectId: b.projectId,
                        taskId: b.taskId,
                        provider: b.provider,
                        windowId: b.windowId,
                        limitPercent: n,
                      },
                      'Budget updated. Paused conversations stay paused until you continue them.',
                    )
                  }
                />
              ))}
            </div>
          </section>
          <section className="quark-section">
            <h2>
              <Pause size={19} /> Paused work
            </h2>
            {!state.holds.length ? (
              <p className="quark-empty">
                No quota pauses. If a limit is reached, the affected conversations appear here.
              </p>
            ) : (
              state.holds.map((h) => (
                <article className="quark-hold" key={h.runId}>
                  <strong>
                    {state.runs.find((r) => r.runId === h.runId)?.agentName ?? 'Saved conversation'}
                  </strong>
                  <p>{h.reason}</p>
                  {h.error && <p role="alert">Stop could not be confirmed: {h.error}</p>}
                  <p className="quark-muted">
                    Files, messages and queued work are retained.{' '}
                    {['monitoring', 'reset', 'headroom', 'cache'].includes(h.cause)
                      ? 'QUARK can continue after the stop is confirmed and capacity is verified. Budget limits and your pauses still apply; uncertain actions are not replayed.'
                      : 'Review the allowance, then explicitly continue. This pause will not clear automatically.'}
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        '/quark/resume',
                        { runId: h.runId },
                        'Continuation queued in the same saved conversation.',
                      )
                    }
                  >
                    Continue saved work
                  </button>
                </article>
              ))
            )}
          </section>
          <section className="quark-section">
            <h2>Usage by project</h2>
            <p>
              Estimated shares since tracking began in each current window. Concurrent activity
              outside this app can affect attribution. Accuracy within 2–3 percentage points has not
              been validated.
            </p>
            <div className="quark-share-grid">
              {state.windows.map((w) => (
                <article key={`${w.provider}:${w.windowId}`}>
                  <h3>
                    {w.provider === 'codex' ? 'Codex' : 'Claude'} · {w.label}
                  </h3>
                  {w.projects.map((p) => (
                    <div className="quark-share" key={p.projectId}>
                      <span>{p.name}</span>
                      <strong>≈ {percent(p.estimatedPercent)}</strong>
                    </div>
                  ))}
                  <div className="quark-share">
                    <span>Unattributed</span>
                    <span>{percent(w.unattributedPercent)}</span>
                  </div>
                  <small>
                    {w.samples} observed changes · estimates include elapsed-work fallback when
                    counters are missing
                  </small>
                </article>
              ))}
            </div>
          </section>
          <details className="quark-section quark-report">
            <summary>Tokens by agent</summary>
            <p>
              Provider-reported counters for individual runs. Native helpers stay separate from
              parent totals until their overlap can be verified. Missing counts are unknown, not
              zero.
            </p>
            {!state.runs.length && (
              <p className="quark-empty">
                New agent work will appear automatically. Earlier conversations are preserved;
                historical totals are not invented.
              </p>
            )}
            <div className="quark-share-grid">
              {state.totals
                .filter((t) => !t.agentId)
                .map((t) => (
                  <article key={`${t.projectId}:${t.provider}`}>
                    <h3>
                      {t.name} · {t.provider}
                    </h3>
                    <strong>{number(t.tokens.totalTokens)} observed tokens</strong>
                    <p className="quark-muted">
                      {t.measuredRuns} complete counters · {t.incompleteRuns} incomplete runs
                      {t.nativeOverlap ? ' · native helper overlap unverified' : ''}
                    </p>
                    {state.totals
                      .filter(
                        (a) =>
                          a.agentId && a.projectId === t.projectId && a.provider === t.provider,
                      )
                      .map((a) => (
                        <div className="quark-share" key={a.agentId}>
                          <span>
                            {a.name}
                            {a.nativeOverlap ? ' (separate helper)' : ''}
                          </span>
                          <span>{number(a.tokens.totalTokens)}</span>
                        </div>
                      ))}
                  </article>
                ))}
            </div>
            <div className="quark-runs">
              {state.runs.map((r) => (
                <details key={r.runId}>
                  <summary>
                    <span>
                      <strong>{r.agentName}</strong>
                      <small>
                        {r.projectName} · {r.provider} · {r.status}
                        {r.cacheNudge ? ' · cache refresh' : ''}
                        {r.nativeRootId ? ' · native helper' : ''}
                      </small>
                    </span>
                    <span>
                      {number(r.tokens.totalTokens)}
                      <small>
                        {r.basis === 'measured'
                          ? 'reported tokens'
                          : r.basis === 'partial'
                            ? r.nativeRootId &&
                              r.provider === 'claude' &&
                              r.tokens.totalTokens !== null
                              ? 'reported total · partial breakdown'
                              : 'partial counters'
                            : 'awaiting counters'}
                      </small>
                    </span>
                  </summary>
                  {r.nativeRootId &&
                    r.provider === 'claude' &&
                    r.tokens.totalTokens !== null &&
                    r.basis === 'partial' && (
                      <p className="quark-muted">
                        Claude reported this helper’s run total. The breakdown below may be
                        incomplete. This helper is shown separately and is not added again to the
                        project total.
                      </p>
                    )}
                  <dl>
                    <dt>Model at dispatch</dt>
                    <dd>{r.model ?? 'Provider default'}</dd>
                    {!!r.observedModels?.length && (
                      <>
                        <dt>Models reported in this turn</dt>
                        <dd>{r.observedModels.join(', ')}</dd>
                      </>
                    )}
                    <dt>Input</dt>
                    <dd>{number(r.tokens.inputTokens)}</dd>
                    <dt>Output</dt>
                    <dd>{number(r.tokens.outputTokens)}</dd>
                    <dt>Cache read</dt>
                    <dd>{number(r.tokens.cachedInputTokens)}</dd>
                    <dt>Cache write</dt>
                    <dd>{number(r.tokens.cacheWriteInputTokens)}</dd>
                    <dt>Reasoning output</dt>
                    <dd>{number(r.tokens.reasoningOutputTokens)}</dd>
                  </dl>
                </details>
              ))}
            </div>
            {state.omittedRuns > 0 && (
              <p>
                Showing the latest 200 runs; {state.omittedRuns} earlier runs remain in the ledger
                and budgets.
              </p>
            )}
          </details>
          <details className="quark-section quark-report">
            <summary>
              <Clock3 size={19} /> Context cache settings
            </summary>
            <p>
              Cache expiry does not delete a conversation. A small refresh can help reuse its cached
              prompt, but also spends allowance. Paused work is never nudged, and quota limits take
              precedence.
            </p>
            <div className="quark-cache-grid">
              {state.cache.map((c) => (
                <article key={c.agentId}>
                  <h3>{c.name}</h3>
                  <strong>
                    {c.estimatedExpiresAt
                      ? `${Math.max(0, Math.ceil((Date.parse(c.estimatedExpiresAt) - now) / 60_000))} min estimated`
                      : 'Expiry not exposed'}
                  </strong>
                  <p>{c.state}</p>
                  <small>
                    {number(c.cachedTokens)} cached tokens last reported · {c.nudgesToday} refreshes
                    today
                  </small>
                </article>
              ))}
            </div>
            {settings && (
              <form
                className="quark-settings"
                onSubmit={(e) => {
                  e.preventDefault();
                  void mutate('/quark/settings', { settings }, 'QUARK settings saved.');
                }}
              >
                <label className="quark-check">
                  <input
                    type="checkbox"
                    checked={settings.cacheEnabled}
                    onChange={(e) => setSettings({ ...settings, cacheEnabled: e.target.checked })}
                  />{' '}
                  Automatically refresh eligible idle task conversations
                </label>
                <div className="quark-budget-form">
                  <label>
                    Claude estimated lifetime (minutes)
                    <input
                      type="number"
                      min="5"
                      max="1440"
                      value={settings.cacheMinutes.claude ?? ''}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          cacheMinutes: {
                            ...settings.cacheMinutes,
                            claude: e.target.value ? Number(e.target.value) : null,
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    Codex estimated lifetime (optional)
                    <input
                      type="number"
                      min="5"
                      max="1440"
                      placeholder="Not exposed"
                      value={settings.cacheMinutes.codex ?? ''}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          cacheMinutes: {
                            ...settings.cacheMinutes,
                            codex: e.target.value ? Number(e.target.value) : null,
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    Max refreshes per agent / day
                    <input
                      type="number"
                      min="0"
                      max="24"
                      value={settings.maxNudgesPerAgentDay}
                      onChange={(e) =>
                        setSettings({ ...settings, maxNudgesPerAgentDay: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    Stopping buffer (percentage points)
                    <input
                      type="number"
                      min="0"
                      max="10"
                      step="0.1"
                      value={settings.bufferPercent}
                      onChange={(e) =>
                        setSettings({ ...settings, bufferPercent: Number(e.target.value) })
                      }
                    />
                  </label>
                </div>
                <p className="quark-muted">
                  Claude starts with a 60-minute assumption for included subscription usage. Actual
                  cache lifetime can differ. Codex does not expose an expiry timestamp in our
                  adapter; leave blank to track cache hits without timed refreshes. At most two
                  refreshes per agent per day by default, for unfinished idle tasks only.
                </p>
                <button disabled={busy}>Save QUARK settings</button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSettings(state.settings);
                    setNotice('Loaded the latest settings.');
                  }}
                >
                  Reload settings
                </button>
              </form>
            )}
          </details>
          <footer className="quark-footnote">
            QUARK acts while this computer and app are running. Interruptions can overshoot while a
            provider finishes an in-flight request. It does not control independent editor sessions
            or other computers.
          </footer>
        </>
      )}
    </section>
  );
}
function Budget({
  budget: b,
  name,
  task,
  busy,
  save,
}: {
  budget: QuarkStatus['budgets'][number];
  name: string;
  task?: string;
  busy: boolean;
  save: (n: number) => Promise<void>;
}) {
  const [limit, setLimit] = useState(String(b.limitPercent));
  useEffect(() => setLimit(String(b.limitPercent)), [b.limitPercent]);
  return (
    <article className="quark-budget">
      <h3>
        {name}
        {task ? ` · ${task}` : ''}
      </h3>
      <p className="home-eyebrow">
        {b.provider} · {b.windowId === 'secondary' ? 'Weekly' : b.windowId}
      </p>
      <strong>
        {percent(b.remainingPercent)} <small>of budget remaining</small>
      </strong>
      <p>
        ≈ {percent(b.spentPercent)} spent · {percent(b.reservedPercent)} reserved for recent or
        running work
      </p>
      <progress
        max={b.limitPercent}
        value={Math.min(b.limitPercent, b.spentPercent)}
        aria-label={`${name} estimated budget consumed`}
      />
      {b.reason && <p className="quark-warning">{b.reason}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(Number(limit));
        }}
      >
        <label>
          Budget for {name}
          <input
            type="number"
            min="0.1"
            max="100"
            step="0.1"
            required
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
        <button disabled={busy}>Update budget</button>
      </form>
    </article>
  );
}
