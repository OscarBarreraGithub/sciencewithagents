import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import type { ProviderCapacity, ProviderId, QuarkCoordinatorStatus } from '@dock/shared';
import { api, ApiError } from '../api';
import {
  parseCoordinator,
  parseProjectQuark,
  quarkPriorities,
  type ProjectQuark,
  type QuarkPriority,
} from './chat-contracts';
import './project-quark.css';

type Budget = QuarkCoordinatorStatus['accounting']['budgets'][number];
type Window = ProviderCapacity['windows'][number];
/** One optional cap per provider, in percentage points of that window's entire allowance. */
export type CapChoice = { windowId: string; limit: string };
export type QuarkPlan = {
  priority: QuarkPriority | null;
  limitUsage: boolean;
  caps: Partial<Record<ProviderId, CapChoice>>;
};
export type CapRequest = {
  key: string;
  id?: string;
  expectedRevision: number;
  projectId: string;
  taskId: null;
  provider: ProviderId;
  windowId: string;
  limitPercent: number;
};

const providers = ['codex', 'claude'] as const;
const names: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude' };
const priorities = [
  ['high', 'High', 'Goes first when projects wait for room.'],
  [null, 'Default', 'Each task keeps its own priority.'],
  ['background', 'Back burner', 'Uses room other work leaves.'],
] as const;

export const blankQuarkPlan = (): QuarkPlan => ({ priority: null, limitUsage: false, caps: {} });
export function readQuarkPlan(value: unknown): QuarkPlan {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<QuarkPlan>;
  const caps: QuarkPlan['caps'] = {};
  for (const provider of providers) {
    const cap = raw.caps?.[provider];
    if (cap && typeof cap.windowId === 'string' && typeof cap.limit === 'string')
      caps[provider] = { windowId: cap.windowId, limit: cap.limit };
  }
  return {
    priority: quarkPriorities.includes(raw.priority as QuarkPriority)
      ? (raw.priority as QuarkPriority)
      : null,
    limitUsage: raw.limitUsage === true,
    caps,
  };
}
function capLimit(cap: CapChoice) {
  const value = Number(cap.limit);
  return cap.limit.trim() && Number.isFinite(value) && value > 0 && value <= 100
    ? Math.round(value * 10) / 10
    : null;
}
/** The caps this plan would save; a blank or out-of-range limit blocks saving. */
export function chosenCaps(plan: QuarkPlan) {
  return plan.limitUsage
    ? providers.flatMap((provider) => {
        const cap = plan.caps[provider];
        return cap ? [{ provider, windowId: cap.windowId, limitPercent: capLimit(cap) }] : [];
      })
    : [];
}
const projectBudget = (
  status: QuarkCoordinatorStatus | null,
  projectId: string | null,
  provider: ProviderId,
): Budget | undefined =>
  projectId
    ? status?.accounting.budgets.find(
        (b) => b.projectId === projectId && b.taskId === null && b.provider === provider,
      )
    : undefined;

const general = (capacity: ProviderCapacity) =>
  capacity.windows.filter((w) => w.scope === 'general');
const usable = (capacity: ProviderCapacity | undefined): capacity is ProviderCapacity =>
  !!capacity && capacity.state === 'ready' && !capacity.stale && general(capacity).length > 0;
/** Weekly when reported; otherwise the reported general window (a session on some plans). */
function defaultWindow(capacity: ProviderCapacity) {
  const windows = general(capacity);
  return (
    windows.find((w) => (w.windowMinutes ?? 0) >= 7 * 24 * 60) ??
    windows.find((w) => /week/i.test(w.label)) ??
    [...windows].sort((a, b) => (b.windowMinutes ?? 0) - (a.windowMinutes ?? 0))[0]
  );
}
function span(minutes: number | null) {
  if (!minutes) return '';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}
const windowName = (w: Window) =>
  `${w.label}${span(w.windowMinutes) ? ` (${span(w.windowMinutes)})` : ''}`;
const pct = (n: number) => `${Math.round(n * 10) / 10}%`;
function freshness(capacity: ProviderCapacity, now: number) {
  if (!capacity.observedAt) return 'not read yet';
  const minutes = Math.round((now - Date.parse(capacity.observedAt)) / 60_000);
  const read =
    minutes < 1
      ? 'read just now'
      : minutes < 60
        ? `read ${minutes} min ago`
        : minutes < 1440
          ? `read ${Math.round(minutes / 60)} h ago`
          : `read ${new Date(capacity.observedAt).toLocaleDateString()}`;
  return capacity.stale ? `${read} · out of date` : read;
}
function resets(w: Window, now: number) {
  if (!w.resetsAt) return 'reset not reported';
  const at = Date.parse(w.resetsAt);
  if (at <= now) return 'reset passed · waiting for a new reading';
  return `resets ${new Date(at).toLocaleString([], at - now < 86_400_000 ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', month: 'short', day: 'numeric' })}`;
}
/** Honest wording when the capped window is not a weekly one. */
function windowNote(capacity: ProviderCapacity, w: Window) {
  if ((w.windowMinutes ?? 0) >= 7 * 24 * 60 || /week/i.test(w.label)) return '';
  return capacity.weeklyPolicy === 'owner-reported-none'
    ? `This plan has no general weekly allowance, so the cap counts ${w.label.toLowerCase()} allowance.`
    : `No weekly allowance is reported, so the cap counts ${w.label.toLowerCase()} allowance.`;
}

/** GET /quark/coordinator: provider windows plus measured spend and reservations. */
export function useCoordinator() {
  const [status, setStatus] = useState<QuarkCoordinatorStatus | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const alive = useRef(true);
  const load = async () => {
    try {
      const value = parseCoordinator(await api('/quark/coordinator'));
      if (alive.current) {
        setStatus(value);
        setError('');
      }
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : 'Usage could not be read.');
    }
  };
  const check = async () => {
    setChecking(true);
    try {
      await api('/capacity/refresh', {});
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : 'Usage could not be checked.');
    }
    await load();
    if (alive.current) setChecking(false);
  };
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 60_000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, []);
  return { status, error, checking, load, check };
}

/** Priority, optional usage caps and a compact reading of actual QUARK allocations. */
export function QuarkControls({
  coordinator,
  projectId,
  plan,
  onChange,
  disabled,
  note,
  warning,
  savedPriority,
  priorityLocked = false,
}: {
  coordinator: ReturnType<typeof useCoordinator>;
  projectId: string | null;
  plan: QuarkPlan;
  onChange: (plan: QuarkPlan) => void;
  disabled: boolean;
  note?: string;
  warning?: string;
  savedPriority?: QuarkPriority | null;
  priorityLocked?: boolean;
}) {
  const name = useId();
  const { status, error, checking, check } = coordinator;
  const now = Date.now();
  const capacityOf = (provider: ProviderId) =>
    status?.capacity.find((item) => item.provider === provider);
  const saved = providers.filter((provider) => projectBudget(status, projectId, provider));
  const limitOn = plan.limitUsage || saved.length > 0;
  const setCap = (provider: ProviderId, cap: CapChoice | null) => {
    const caps = { ...plan.caps };
    if (cap) caps[provider] = cap;
    else delete caps[provider];
    onChange({ ...plan, caps });
  };
  const turnOn = () => {
    const caps = { ...plan.caps };
    for (const provider of providers) {
      const capacity = capacityOf(provider);
      if (!caps[provider] && usable(capacity))
        caps[provider] = { windowId: defaultWindow(capacity)!.id, limit: '10' };
    }
    onChange({ ...plan, limitUsage: true, caps });
  };
  return (
    <fieldset className="config-section quark-controls" disabled={disabled}>
      <legend>Priority and usage</legend>
      <div className="quark-priority" role="radiogroup" aria-label="Project priority">
        {priorities.map(([value, label, hint]) => {
          const checked = plan.priority === value || (value === null && plan.priority === 'normal');
          return (
            <label key={label} className={checked ? 'selected' : ''}>
              <input
                type="radio"
                name={name}
                checked={checked}
                disabled={priorityLocked}
                onChange={() => onChange({ ...plan, priority: value })}
              />
              <span>
                <strong>{label}</strong>
                <small>{hint}</small>
              </span>
            </label>
          );
        })}
      </div>
      <p className="config-help">
        Messages you send directly still go first, and a priority set on a single run wins.
        {savedPriority === 'normal' && plan.priority === 'normal'
          ? ' Saved in QUARK as Normal.'
          : ''}
        {note ? ` ${note}` : ''}
      </p>
      {warning && <p className="config-warning">{warning}</p>}
      <label className="config-check">
        <input
          type="checkbox"
          checked={limitOn}
          disabled={saved.length > 0}
          onChange={(event) =>
            event.target.checked ? turnOn() : onChange({ ...plan, limitUsage: false })
          }
        />
        <span>
          Set max usage
          <small>
            {saved.length
              ? 'Saved caps stay in place. You can change their limits here or in QUARK.'
              : 'Off by default: QUARK shares room across projects without a fixed cap.'}
          </small>
        </span>
      </label>
      {limitOn && (
        <div className="quark-caps">
          <p className="config-help">
            A cap counts percentage points of the entire reported allowance, starting when it is
            saved. Resets do not refill it.
          </p>
          {providers.map((provider) => {
            const capacity = capacityOf(provider);
            const budget = projectBudget(status, projectId, provider);
            const cap =
              plan.caps[provider] ??
              (budget
                ? { windowId: budget.windowId, limit: String(budget.limitPercent) }
                : undefined);
            const windows = capacity ? general(capacity) : [];
            const current = windows.find((w) => w.id === (budget?.windowId ?? cap?.windowId));
            const invalid = cap && capLimit(cap) === null;
            const unavailable = !status
              ? 'Reading usage…'
              : !capacity
                ? `${names[provider]} usage is not reported on this computer.`
                : capacity.state !== 'ready' || capacity.stale
                  ? `${capacity.message} A cap needs a fresh reading; you can continue without one.`
                  : !windows.length
                    ? `${names[provider]} reports no general allowance, so a cap cannot be measured.`
                    : '';
            return (
              <div className="quark-cap" key={provider}>
                <label className="config-check">
                  <input
                    type="checkbox"
                    checked={!!cap || !!budget}
                    disabled={!!budget || (!cap && !!unavailable)}
                    onChange={(event) =>
                      setCap(
                        provider,
                        event.target.checked && usable(capacity)
                          ? { windowId: defaultWindow(capacity)!.id, limit: '10' }
                          : null,
                      )
                    }
                  />
                  <span>
                    {names[provider]}
                    <small>
                      {budget
                        ? `Saved cap on the ${current ? windowName(current) : budget.windowId} allowance.`
                        : cap && current
                          ? `${windowName(current)} allowance. ${capacity ? windowNote(capacity, current) : ''}`
                          : cap
                            ? 'The chosen allowance is no longer reported. Turn this cap off or check usage again.'
                            : unavailable || 'No cap.'}
                    </small>
                  </span>
                </label>
                {cap && (
                  <div className="quark-cap-fields">
                    <label>
                      Use at most (% of the full allowance)
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0.1"
                        max="100"
                        step="0.1"
                        value={cap.limit}
                        aria-invalid={invalid || undefined}
                        onChange={(event) =>
                          setCap(provider, { ...cap, limit: event.target.value })
                        }
                      />
                    </label>
                    {!budget && windows.length > 1 && (
                      <label>
                        Allowance
                        <select
                          value={cap.windowId}
                          onChange={(event) =>
                            setCap(provider, { ...cap, windowId: event.target.value })
                          }
                        >
                          {windows.map((w) => (
                            <option key={w.id} value={w.id}>
                              {windowName(w)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {invalid && (
                      <p className="config-warning" role="alert">
                        Enter a limit from 0.1 to 100.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="quark-allocations" aria-label="QUARK allocations">
        {!status && !error && <p className="config-help">Reading usage…</p>}
        {error && (
          <p className="config-warning" role="alert">
            {error} Nothing is estimated in its place.
          </p>
        )}
        {status &&
          providers.map((provider) => (
            <Allocation
              key={provider}
              provider={provider}
              capacity={capacityOf(provider)}
              status={status}
              projectId={projectId}
              cap={limitOn ? plan.caps[provider] : undefined}
              now={now}
            />
          ))}
      </div>
      <div className="quark-links">
        <a className="flow-button" href="#/usage">
          QUARK allocations <ArrowRight size={16} />
        </a>
        <button
          type="button"
          className="flow-button"
          disabled={checking}
          onClick={() => void check()}
        >
          <RefreshCw size={15} /> {checking ? 'Checking usage…' : 'Check usage again'}
        </button>
      </div>
    </fieldset>
  );
}

/** Existing manager configuration: saved priority plus caps; a saved cap is updated in place. */
export function ProjectQuarkSettings({ projectId }: { projectId: string }) {
  const coordinator = useCoordinator();
  const { status } = coordinator;
  const [policy, setPolicy] = useState<ProjectQuark | null>(null);
  const [policyError, setPolicyError] = useState('');
  const [policyRead, setPolicyRead] = useState(false);
  const [plan, setPlan] = useState<QuarkPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const receipts = useRef(new Map<string, string>());
  const loadPolicy = async () => {
    try {
      const value = parseProjectQuark(await api(`/projects/${projectId}/quark`));
      setPolicy(value);
      setPolicyError('');
      return value;
    } catch (reason) {
      setPolicy(null);
      setPolicyError(
        reason instanceof ApiError && reason.status === 404
          ? 'Project priority is not available on this computer yet. Usage caps still work.'
          : reason instanceof Error
            ? reason.message
            : 'Project priority could not be read.',
      );
      return null;
    } finally {
      setPolicyRead(true);
    }
  };
  const baseline = (value: ProjectQuark | null): QuarkPlan => ({
    priority: value?.priority ?? null,
    limitUsage: false,
    caps: Object.fromEntries(
      providers.flatMap((provider) => {
        const budget = projectBudget(status, projectId, provider);
        return budget
          ? [[provider, { windowId: budget.windowId, limit: String(budget.limitPercent) }]]
          : [];
      }),
    ),
  });
  useEffect(() => {
    setPlan(null);
    setPolicyRead(false);
    void loadPolicy();
  }, [projectId]);
  useEffect(() => {
    if (!plan && policyRead && (status || coordinator.error)) setPlan(baseline(policy));
  }, [plan, policyRead, status, coordinator.error]);
  if (!plan) return <p className="config-help">Reading priority and usage…</p>;
  const limitOn = plan.limitUsage || providers.some((p) => projectBudget(status, projectId, p));
  const steps: { label: string; path: string; body: object }[] = [];
  if (policy && plan.priority !== policy.priority)
    steps.push({
      label: 'Priority',
      path: `/projects/${projectId}/quark`,
      body: { expectedRevision: policy.revision, priority: plan.priority },
    });
  const caps = chosenCaps({ ...plan, limitUsage: limitOn });
  for (const cap of caps) {
    const budget = projectBudget(status, projectId, cap.provider);
    if (cap.limitPercent === null || (budget && budget.limitPercent === cap.limitPercent)) continue;
    steps.push({
      label: `${names[cap.provider]} cap`,
      path: '/quark/budgets',
      body: budget
        ? {
            id: budget.id,
            expectedRevision: budget.revision,
            projectId,
            taskId: null,
            provider: cap.provider,
            windowId: budget.windowId,
            limitPercent: cap.limitPercent,
          }
        : {
            expectedRevision: 0,
            projectId,
            taskId: null,
            provider: cap.provider,
            windowId: cap.windowId,
            limitPercent: cap.limitPercent,
          },
    });
  }
  const invalid = caps.some((cap) => cap.limitPercent === null);
  const save = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    let done = 0;
    try {
      for (const step of steps) {
        const signature = JSON.stringify(step);
        const key = receipts.current.get(signature) ?? crypto.randomUUID();
        receipts.current.set(signature, key);
        try {
          await api(step.path, { key, ...step.body });
        } catch (reason) {
          throw new Error(
            `${step.label} was not saved${done ? ' (earlier changes were)' : ''}: ${reason instanceof Error ? reason.message : 'try again.'}`,
          );
        }
        receipts.current.delete(signature);
        done += 1;
      }
      setNotice('Priority and usage saved. QUARK applies them to new and waiting work.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save. Try again.');
    } finally {
      const value = await loadPolicy();
      await coordinator.load();
      if (done === steps.length) setPlan({ ...baseline(value), caps: plan.caps });
      setBusy(false);
    }
  };
  return (
    <>
      <QuarkControls
        coordinator={coordinator}
        projectId={projectId}
        plan={plan}
        onChange={(next) => {
          setNotice('');
          setPlan(next);
        }}
        disabled={busy}
        warning={policyError}
        savedPriority={policy?.priority}
        priorityLocked={!policy}
      />
      {error && (
        <p className="config-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="config-save">
        <span>
          {invalid
            ? 'Enter a limit from 0.1 to 100'
            : steps.length
              ? 'Unsaved priority or usage changes'
              : 'Saved priority and usage'}
        </span>
        <button
          type="button"
          className="flow-button primary"
          disabled={busy || invalid || !steps.length}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save priority and usage'}
        </button>
      </div>
    </>
  );
}

/** One bar = the entire reported allowance of a general window. */
function Allocation({
  provider,
  capacity,
  status,
  projectId,
  cap,
  now,
}: {
  provider: ProviderId;
  capacity: ProviderCapacity | undefined;
  status: QuarkCoordinatorStatus;
  projectId: string | null;
  cap: CapChoice | undefined;
  now: number;
}) {
  const budget = projectBudget(status, projectId, provider);
  const window = capacity
    ? (general(capacity).find((w) => w.id === (budget?.windowId ?? cap?.windowId)) ??
      defaultWindow(capacity))
    : undefined;
  if (!capacity || !window)
    return (
      <div className="quark-allocation">
        <p className="quark-allocation-head">
          <strong>{names[provider]}</strong>
          <span>{capacity?.message || 'No general allowance reported.'}</span>
        </p>
      </div>
    );
  const used = Math.min(100, window.usedPercent);
  const share = projectId
    ? Math.min(
        used,
        status.accounting.windows
          .find((w) => w.provider === provider && w.windowId === window.id)
          ?.projects.find((p) => p.projectId === projectId)?.estimatedPercent ?? 0,
      )
    : 0;
  const room = 100 - used;
  const limit = cap ? capLimit(cap) : null;
  const reserved =
    budget?.windowId === window.id
      ? Math.min(room, budget.reservedPercent, budget.remainingPercent)
      : 0;
  const capRoom =
    budget?.windowId === window.id
      ? Math.min(room - reserved, Math.max(0, budget.remainingPercent - reserved))
      : limit !== null && cap?.windowId === window.id
        ? Math.min(room, limit)
        : 0;
  const summary = `${names[provider]} ${window.label}: ${pct(room)} of the allowance left, ${resets(window, now)}, ${freshness(capacity, now)}.`;
  return (
    <div className="quark-allocation">
      <p className="quark-allocation-head">
        <strong>
          {names[provider]} · {window.label}
        </strong>
        <span>
          {pct(room)} left · {resets(window, now)} · {freshness(capacity, now)}
        </span>
      </p>
      <div className={`quark-bar${capacity.stale ? ' stale' : ''}`} role="img" aria-label={summary}>
        <span className="quark-bar-used" style={{ width: `${used - share}%` }} />
        <span className="quark-bar-project" style={{ width: `${share}%` }} />
        <span className="quark-bar-reserved" style={{ width: `${reserved}%` }} />
        <span className="quark-bar-cap" style={{ width: `${capRoom}%` }} />
      </div>
      <p className="quark-allocation-note">
        {budget
          ? `Cap ${pct(budget.limitPercent)} · ≈${pct(budget.spentPercent)} spent · ${pct(budget.remainingPercent)} left, of which ${pct(budget.reservedPercent)} is reserved for running work`
          : limit !== null
            ? `Cap ${pct(limit)} from when it is saved`
            : 'No cap · shared pacing'}
        {share > 0 ? ` · this project ≈${pct(share)} of this window so far` : ''}
      </p>
    </div>
  );
}
