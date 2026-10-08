import { useEffect, useId, useRef, useState } from 'react';
import {
  clusterDevelopmentSchema,
  clusterWorkspaceLeaseRequestSchema,
  clusterWorkspaceRefreshSchema,
  clusterWorkspaceSchema,
  clusterWorkspaceSettingsSchema,
  clusterWorkspaceSiteRulesSchema,
  clusterWorkspaceUpdateResultSchema,
  projectWorkflowSchema,
  type ClusterWorkspaceRoot,
  type ClusterWorkspaceStatus,
} from '@dock/shared';
import { controllerApi as api, apiScope, ApiError, connectionLost } from '../api';
import { ago } from './HomeOverview';
import { trackRefresh } from './refreshHome';
import './cluster-workspace.css';

type Workspace = ClusterWorkspaceStatus;
type Index = ClusterWorkspaceRoot['index'];
const names = ['partition', 'qos'] as const;
const numbers = ['cpus', 'memoryMb', 'timeMinutes', 'idleMinutes'] as const;
const fields = [...names, ...numbers];
type Field = (typeof fields)[number];
/** Values as typed; converted and checked against the shared contract when saved. */
type Content = {
  roots: { id?: string; label: string; path: string }[];
  account: string | null;
  development: Record<Field, string>;
  siteRules: Workspace['siteRules'];
  workflow: Workspace['workflow'];
};
/** Unsaved edits stay bound to the alias and saved revision (base) they started from. */
type Draft = Content & { alias: string; revision: number; base: Content };
const requestSchemas = {
  '/cluster/workspace/settings': clusterWorkspaceSettingsSchema,
  '/cluster/workspace/lease': clusterWorkspaceLeaseRequestSchema,
  '/cluster/workspace/refresh': clusterWorkspaceRefreshSchema,
};
type Path = keyof typeof requestSchemas;
/** A request whose delivery is unknown. A retry sends it unchanged, with its original key. */
type Pending = {
  path: Path;
  body: { key: string; alias: string; hours?: number | null } & Record<string, unknown>;
};
type Stored = { draft: Draft | null; pending: Pending | null };

const sections = ['roots', 'account', 'development', 'siteRules', 'workflow'] as const;
const sectionLabels = {
  roots: 'folders',
  account: 'account',
  development: 'job defaults',
  siteRules: 'site preset',
  workflow: 'source review',
};
const fieldLabels: Record<Field, string> = {
  partition: 'Partition',
  qos: 'QOS',
  cpus: 'CPUs',
  memoryMb: 'Memory (MB)',
  timeMinutes: 'Time limit (minutes)',
  idleMinutes: 'Stop when idle (minutes)',
};
const bounds = (field: (typeof numbers)[number]) => {
  const schema = clusterDevelopmentSchema.shape[field].unwrap();
  return { min: schema.minValue ?? 0, max: schema.maxValue ?? Number.MAX_SAFE_INTEGER };
};
const leaseHours = [1, 2, 4, 8, 12, 24, 48, 72];
type Freshness = Index['state'] | 'earlier';
const freshnessLabels: Record<Freshness, string> = {
  ready: 'Listed',
  earlier: 'From an earlier connection',
  stale: 'Needs refresh',
  indexing: 'Reading…',
  error: 'Could not read',
  truncated: 'Partly listed',
};
/** A listing read before the current connection is not presented as current. */
const freshness = (index: Index, connectionId: string | null): Freshness =>
  index.state === 'ready' && index.connectionId !== connectionId ? 'earlier' : index.state;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const changed = (a: Content, b: Content) =>
  sections.filter((section) => !same(a[section], b[section]));
const isText = (value: unknown): value is string => typeof value === 'string';
const record = (value: unknown) =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const typed = (development: Workspace['development']) =>
  Object.fromEntries(
    fields.map((field) => [field, String(development[field] ?? '')]),
  ) as Content['development'];
function contentOf(state: Workspace): Content {
  return {
    roots: state.roots.map(({ id, label, path }) => ({ id, label, path })),
    // Only a confirmed account is carried forward. The app never picks one.
    account: state.setup.accountConfirmed ? state.setup.selectedAccount : null,
    development: typed(state.development),
    siteRules: state.siteRules,
    workflow: state.workflow,
  };
}

function readContent(value: unknown): Content | null {
  const raw = record(value);
  const development = record(raw?.development);
  if (!raw || !development || !Array.isArray(raw.roots) || raw.roots.length > 8) return null;
  const roots: Content['roots'] = [];
  for (const item of raw.roots) {
    const root = record(item);
    if (!root || !isText(root.label) || !isText(root.path)) return null;
    if (root.id === undefined) roots.push({ label: root.label, path: root.path });
    else if (isText(root.id)) roots.push({ id: root.id, label: root.label, path: root.path });
    else return null;
  }
  const workflow = projectWorkflowSchema.safeParse(raw.workflow);
  // A draft from before site presets reads as none, so a difference shows before saving.
  const siteRules = clusterWorkspaceSiteRulesSchema.safeParse(raw.siteRules ?? null);
  if (!workflow.success || !siteRules.success) return null;
  if (raw.account !== null && !isText(raw.account)) return null;
  if (!fields.every((field) => isText(development[field]))) return null;
  return {
    roots,
    account: raw.account,
    development: Object.fromEntries(
      fields.map((field) => [field, development[field]]),
    ) as Content['development'],
    siteRules: siteRules.data,
    workflow: workflow.data,
  };
}

function restore(key: string): Stored {
  try {
    const raw = record(JSON.parse(localStorage.getItem(key) ?? 'null'));
    const draftRaw = record(raw?.draft);
    const content = readContent(draftRaw);
    const base = readContent(draftRaw?.base);
    const draft =
      content &&
      base &&
      isText(draftRaw?.alias) &&
      Number.isInteger(draftRaw.revision) &&
      Number(draftRaw.revision) >= 0
        ? { ...content, alias: draftRaw.alias, revision: Number(draftRaw.revision), base }
        : null;
    const pendingRaw = record(raw?.pending);
    const path = pendingRaw?.path;
    // Validated, but kept exactly as stored so a retry repeats the original request.
    const pending =
      isText(path) &&
      Object.hasOwn(requestSchemas, path) &&
      requestSchemas[path as Path].safeParse(pendingRaw?.body).success
        ? (pendingRaw as Pending)
        : null;
    return { draft, pending };
  } catch {
    return { draft: null, pending: null };
  }
}

function problem(issue: { path: PropertyKey[]; message: string }) {
  const [section, index, field] = issue.path;
  if (section === 'roots' && typeof index === 'number')
    return field === 'label'
      ? `Folder ${index + 1}: add a short name (up to 100 characters).`
      : `Folder ${index + 1}: ${issue.message}`;
  if (section === 'development' && isText(index) && index in fieldLabels) {
    const name = index as Field;
    if (name === 'partition' || name === 'qos')
      return `${fieldLabels[name]}: use the exact Slurm name, or leave it blank for Slurm’s default.`;
    const { min, max } = bounds(name);
    return `${fieldLabels[name]}: enter a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}.`;
  }
  return issue.message;
}

function clock(iso: string, now: number) {
  const date = new Date(iso);
  const today = date.toDateString() === new Date(now).toDateString();
  return date.toLocaleString([], {
    ...(today ? {} : { weekday: 'short' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}
function remaining(iso: string, now: number) {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return 'ending now';
  return minutes < 60
    ? `${minutes} min left`
    : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''} left`;
}
function leaseText(lease: Workspace['keepConnected'], now: number) {
  const until = lease.expiresAt;
  if (lease.state === 'holding')
    return until
      ? `Kept connected until ${clock(until, now)} · ${remaining(until, now)}`
      : 'Kept connected';
  if (lease.state === 'reconnecting') return 'Reconnecting the kept connection…';
  if (lease.state === 'expired')
    return until ? `Keep connected ended at ${clock(until, now)}` : 'Keep connected ended';
  if (lease.state === 'error') return 'Keep connected stopped';
  return 'Keep connected is off';
}
const memory = (mb: number) =>
  mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`;
const minutes = (value: number) =>
  value >= 60
    ? `${Math.floor(value / 60)} h${value % 60 ? ` ${value % 60} min` : ''}`
    : `${value} min`;
function describe(request: Pending) {
  if (request.path === '/cluster/workspace/settings') return 'Saving your setup';
  if (request.path === '/cluster/workspace/refresh') return 'Refreshing folder details';
  return request.body.hours == null
    ? 'Turning off keep connected'
    : `Keeping connected for ${request.body.hours} h`;
}

/** Cached on the computer: reading it opens no SSH connection and makes no model call. */
function useWorkspace(initial: Workspace) {
  const [reading, setReading] = useState<{
    data: Workspace | null;
    error: string;
    unavailable: boolean;
    loaded: boolean;
  }>({ data: initial, error: '', unavailable: false, loaded: true });
  const read = useRef<() => Promise<boolean>>(async () => false);
  const generation = useRef(0);
  const unsupported = useRef(false);
  useEffect(() => {
    let alive = true;
    let pending: Promise<boolean> | null = null;
    const controller = new AbortController();
    read.current = () =>
      (pending ??= (async () => {
        // A reply from a reading started before an accepted update is older than it.
        const started = generation.current;
        try {
          const data = clusterWorkspaceSchema.parse(
            await api('/cluster/workspace', undefined, controller.signal, 15_000),
          );
          if (alive && started === generation.current)
            setReading({ data, error: '', unavailable: false, loaded: true });
          return true;
        } catch (error) {
          if (!alive || started !== generation.current) return false;
          // Only an explicit JSON 404/501 shows this optional route absent: an older app, an
          // older connecting computer or one without it. HTML, network and malformed replies
          // prove nothing and keep a retry.
          const absent =
            error instanceof ApiError &&
            (error.status === 404 || error.status === 501) &&
            error.code !== 'INTERRUPTED';
          if (absent) unsupported.current = true;
          setReading((old) =>
            absent
              ? { data: null, error: error.message, unavailable: true, loaded: true }
              : {
                  ...old,
                  error:
                    error instanceof ApiError
                      ? error.message
                      : 'This computer sent a workspace reading this page cannot use.',
                  loaded: true,
                },
          );
          return false;
        } finally {
          pending = null;
        }
      })());
    const refresh = () => {
      if (!document.hidden && !unsupported.current) void read.current();
    };
    const requested = (event: Event) => {
      if (!unsupported.current) trackRefresh(event, read.current());
    };
    const timer = window.setInterval(refresh, 10_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('swa:refresh-home', requested);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('swa:refresh-home', requested);
    };
  }, []);
  return {
    ...reading,
    retry: () => void read.current(),
    accept: (data: Workspace) => {
      generation.current++;
      setReading({ data, error: '', unavailable: false, loaded: true });
    },
  };
}

function IndexSummary({
  path,
  index,
  connectionId,
  now,
}: {
  path: string;
  index: Index;
  connectionId: string | null;
  now: number;
}) {
  const state = freshness(index, connectionId);
  const top = index.entries.filter((entry) => !entry.relativePath.includes('/')).slice(0, 6);
  return (
    <>
      <small>
        <span className={`cluster-workspace-index is-${state}`}>{freshnessLabels[state]}</span>
        {index.observedAt
          ? ` · read ${ago(index.observedAt, now)} · ${index.entries.length} item${index.entries.length === 1 ? '' : 's'}`
          : ' · not read yet'}
        {index.omitted > 0 && ` · at least ${index.omitted.toLocaleString()} more not listed`}
      </small>
      {index.canonicalPath && index.canonicalPath !== path && (
        <small className="cluster-workspace-path">Resolves to {index.canonicalPath}</small>
      )}
      {top.length > 0 && (
        <small className="cluster-workspace-path">
          {top
            .map(
              (entry) =>
                `${entry.relativePath}${entry.kind === 'directory' ? '/' : ''}${entry.git ? ' (Git)' : ''}`,
            )
            .join('  ')}
        </small>
      )}
      {index.error && <small className="form-error">{index.error}</small>}
    </>
  );
}

/** `panelConnected`: the cluster panel above already reports a connected reading. */
export function ClusterWorkspace({
  panelConnected,
  initial: initialWorkspace,
}: {
  panelConnected: boolean;
  initial: Workspace;
}) {
  const reading = useWorkspace(initialWorkspace);
  const storageKey = `dock:${apiScope()}:cluster-workspace`;
  const [initial] = useState(() => restore(storageKey));
  const stored = useRef(initial);
  const [draft, setDraftState] = useState(initial.draft);
  const [pending, setPendingState] = useState(initial.pending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(8);
  const sending = useRef(false);
  const partitionList = useId();
  const accountGroup = useId();

  function persist(next: Partial<Stored>) {
    stored.current = { ...stored.current, ...next };
    try {
      if (stored.current.draft || stored.current.pending)
        localStorage.setItem(storageKey, JSON.stringify(stored.current));
      else localStorage.removeItem(storageKey);
    } catch {
      /* Storage can be unavailable; the visible draft remains. */
    }
  }
  const setDraft = (next: Draft | null) => {
    setDraftState(next);
    persist({ draft: next });
  };
  const setPending = (next: Pending | null) => {
    setPendingState(next);
    persist({ pending: next });
  };

  const state = reading.data;
  if (!reading.loaded) return null;
  if (reading.unavailable) return null;
  if (!state)
    return (
      <div className="cluster-workspace cluster-workspace-notice" role="alert">
        <p>Saved folders and keep connected could not load. {reading.error}</p>
        <button className="flow-button" onClick={reading.retry}>
          Retry
        </button>
      </div>
    );

  const now = Date.now();
  const latest = contentOf(state);
  const setup = state.setup;
  const lease = state.keepConnected;
  // Edits made for another alias are kept here but never applied to this one.
  const foreign = !!draft && draft.alias !== state.alias;
  const active = draft && !foreign && changed(draft, latest).length ? draft : null;
  const form: Content = active ?? latest;
  const behind = !!active && active.revision !== state.revision;
  const overlap = active
    ? sections.filter(
        (section) =>
          !same(active[section], active.base[section]) &&
          !same(latest[section], active.base[section]) &&
          !same(active[section], latest[section]),
      )
    : [];
  const locked = busy || !!pending;
  const editable = !locked && !foreign && !!state.alias;
  const accountChoice = active && !same(active.account, latest.account) ? active.account : null;
  const stale = state.roots.filter(
    (root) => freshness(root.index, state.connectionId) !== 'ready',
  ).length;
  const accountSummary =
    setup.accountConfirmed && setup.selectedAccount
      ? setup.selectedAccount
      : setup.accounts.length > 1
        ? 'choose an account'
        : setup.accounts.length
          ? 'confirm the account'
          : 'accounts not read yet';
  const partitions = setup.partitions.filter((partition) => partition.accessible !== false);
  // A confirmed choice stays visible and selected while the cluster is offline. Choosing a
  // different account needs a successful current reading.
  const canChoose = state.connected && !setup.error;
  const accountOptions = [
    ...new Set([
      ...setup.accounts.map((account) => account.name),
      ...(latest.account ? [latest.account] : []),
      ...(form.account ? [form.account] : []),
    ]),
  ];
  const suggested = setup.suggestedDevelopment && typed(setup.suggestedDevelopment);
  const read = (label: string, at: string | null) =>
    `${label} ${at ? `read ${ago(at, now)}` : 'not read yet'}`;

  function edit(patch: Partial<Content>) {
    if (!editable || !state?.alias) return;
    const next: Draft = {
      ...(active ?? { ...latest, alias: state.alias, revision: state.revision, base: latest }),
      ...patch,
    };
    setDraft(changed(next, latest).length ? next : null);
  }
  const editRoot = (at: number, patch: Partial<Content['roots'][number]>) =>
    edit({ roots: form.roots.map((root, index) => (index === at ? { ...root, ...patch } : root)) });
  const editDevelopment = (field: Field, value: string) =>
    edit({ development: { ...form.development, [field]: value } });

  async function send(request: Pending) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    setReason('');
    // Recorded before sending: after a lost reply, even a reload retries this exact request.
    setPending(request);
    try {
      const result = clusterWorkspaceUpdateResultSchema.parse(
        await api(
          request.path,
          request.body,
          undefined,
          request.path === '/cluster/workspace/settings' ? 30_000 : 90_000,
        ),
      );
      setPending(null);
      reading.accept(result.state);
      if (result.status === 'conflict')
        setReason(result.reason ?? 'The saved setup changed before this request arrived.');
      else if (request.path === '/cluster/workspace/settings') setDraft(null);
    } catch (e) {
      // The computer answered with a refusal, so nothing was applied. Anything else may have
      // arrived and stays recorded for an exact retry.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && !connectionLost(e))
        setPending(null);
      setError(
        e instanceof ApiError ? e.message : 'The reply could not be read. Retry sends it again.',
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  function save() {
    if (!active || behind) return;
    const development = active.development;
    const parsed = clusterWorkspaceSettingsSchema.safeParse({
      key: crypto.randomUUID(),
      alias: active.alias,
      revision: active.revision,
      roots: active.roots,
      account: active.account,
      development: {
        partition: development.partition.trim() || null,
        qos: development.qos.trim() || null,
        ...Object.fromEntries(
          numbers.map((field) => [
            field,
            development[field].trim() ? Number(development[field]) : Number.NaN,
          ]),
        ),
      },
      siteRules: active.siteRules,
      workflow: active.workflow,
    });
    if (!parsed.success) return setError(problem(parsed.error.issues[0]!));
    void send({ path: '/cluster/workspace/settings', body: parsed.data });
  }
  /** Explicit rebase: sections changed only elsewhere take the latest; your edits stay. */
  function rebase() {
    if (!active || !state) return;
    const kept = Object.fromEntries(
      sections.map((section) => [
        section,
        same(active[section], active.base[section]) ? latest[section] : active[section],
      ]),
    ) as Content;
    setReason('');
    const next: Draft = { ...active, ...kept, revision: state.revision, base: latest };
    setDraft(changed(next, latest).length ? next : null);
  }
  function request(path: Path, body: Record<string, unknown>) {
    if (state?.alias)
      void send({ path, body: { key: crypto.randomUUID(), alias: state.alias, ...body } });
  }

  return (
    <section className="cluster-workspace" aria-label="Cluster workspace">
      <div className="cluster-workspace-head">
        <p>
          {(!state.connected || !panelConnected) && (
            <>
              <span
                className={`cluster-workspace-connection${state.connected ? ' is-connected' : ''}`}
              >
                {state.connected ? 'Workspace connected' : 'Workspace not connected'}
              </span>{' '}
              ·{' '}
            </>
          )}
          {leaseText(lease, now)}
        </p>
        <div className="cluster-workspace-actions">
          <select
            aria-label="How long to keep connected"
            value={hours}
            disabled={locked || !state.alias}
            onChange={(event) => setHours(Number(event.target.value))}
          >
            {leaseHours.map((value) => (
              <option key={value} value={value}>
                {value} hour{value === 1 ? '' : 's'}
              </option>
            ))}
          </select>
          <button
            className="flow-button"
            disabled={locked || !state.alias}
            onClick={() => request('/cluster/workspace/lease', { revision: state.revision, hours })}
          >
            {lease.enabled ? 'Renew' : 'Keep connected'}
          </button>
          {lease.enabled && (
            <button
              className="flow-button"
              disabled={locked}
              onClick={() =>
                request('/cluster/workspace/lease', { revision: state.revision, hours: null })
              }
            >
              Turn off
            </button>
          )}
        </div>
      </div>
      {lease.message && <small className="cluster-workspace-note">{lease.message}</small>}
      <small className="cluster-workspace-note">
        Holds the app’s own SSH connection, not your terminal’s. The cluster can still end it or ask
        you to sign in again before then.
      </small>
      {!state.alias && (
        <p className="cluster-workspace-note">Save the cluster’s SSH host alias first.</p>
      )}
      {pending && !busy && (
        <div className="cluster-workspace-notice" role="status">
          <p>
            {describe(pending)} for {pending.body.alias} may not have arrived. Retry sends the same
            request; if it already arrived, it is not applied twice.
          </p>
          <div className="cluster-workspace-actions">
            <button className="flow-button primary" onClick={() => void send(pending)}>
              Retry
            </button>
            <button className="flow-button" onClick={() => setPending(null)}>
              Stop retrying
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {reading.error && (
        <p className="cluster-workspace-note" role="status">
          Showing the last workspace reading. {reading.error}
        </p>
      )}
      {reason && !behind && (
        <p className="cluster-workspace-notice" role="status">
          Not changed: {reason}
        </p>
      )}
      {foreign && draft && (
        <div className="cluster-workspace-notice" role="status">
          <p>
            Unsaved edits for {draft.alias} are kept in this browser. The cluster is now{' '}
            {state.alias ?? 'not set'}, so they are not applied here.
          </p>
          <button className="flow-button" disabled={locked} onClick={() => setDraft(null)}>
            Discard those edits
          </button>
        </div>
      )}
      {behind && active && (
        <div className="cluster-workspace-notice" role="status">
          <p>
            Not saved: {reason || 'the saved setup changed after you started editing.'} Your edits
            are kept.{' '}
            {overlap.length
              ? `Changed in both places: ${overlap.map((section) => sectionLabels[section]).join(', ')}. Your version would replace the latest there.`
              : 'The other changes do not overlap yours.'}
          </p>
          <div className="cluster-workspace-actions">
            <button className="flow-button primary" disabled={locked} onClick={rebase}>
              Apply my edits to the latest
            </button>
            <button className="flow-button" disabled={locked} onClick={() => setDraft(null)}>
              Use the latest
            </button>
          </div>
        </div>
      )}

      <details className="quark-advanced">
        <summary>
          Saved folders ({state.roots.length})
          {state.roots.length ? (stale ? ` · ${stale} not current` : ' · listed') : ''}
        </summary>
        <p className="cluster-workspace-note">
          Setup only: agents later pick these folders by name. Nothing runs from a path typed here.
        </p>
        {form.roots.length > 0 && (
          <ul className="cluster-workspace-roots">
            {form.roots.map((root, at) => {
              const saved = root.id ? state.roots.find((item) => item.id === root.id) : undefined;
              return (
                <li key={root.id ?? `new-${at}`}>
                  <div className="cluster-workspace-fields">
                    <label>
                      Name
                      <input
                        value={root.label}
                        disabled={!editable}
                        onChange={(event) => editRoot(at, { label: event.target.value })}
                      />
                    </label>
                    <label>
                      Folder on the cluster
                      <input
                        className="cluster-workspace-path"
                        value={root.path}
                        placeholder="~/projects/thesis"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        disabled={!editable}
                        onChange={(event) => editRoot(at, { path: event.target.value })}
                      />
                    </label>
                    <button
                      type="button"
                      className="flow-button"
                      disabled={!editable}
                      onClick={() => edit({ roots: form.roots.filter((_, index) => index !== at) })}
                    >
                      Remove
                    </button>
                  </div>
                  {saved && saved.path === root.path ? (
                    <IndexSummary
                      path={saved.path}
                      index={saved.index}
                      connectionId={state.connectionId}
                      now={now}
                    />
                  ) : (
                    <small>Listed after you save and refresh.</small>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="cluster-workspace-actions">
          <button
            type="button"
            className="flow-button"
            disabled={!editable || form.roots.length >= 8}
            onClick={() => edit({ roots: [...form.roots, { label: '', path: '' }] })}
          >
            Add folder
          </button>
          <button
            type="button"
            className="flow-button"
            disabled={locked || !state.alias || !state.roots.length}
            onClick={() => request('/cluster/workspace/refresh', {})}
          >
            Refresh folder details
          </button>
        </div>
        {form.roots.length >= 8 && (
          <small className="cluster-workspace-note">Up to 8 folders.</small>
        )}
      </details>

      <details className="quark-advanced">
        <summary>
          Account and job defaults ·{' '}
          <span className={setup.accountConfirmed ? undefined : 'cluster-workspace-attention'}>
            {accountSummary}
          </span>{' '}
          · {state.development.cpus} CPU, {memory(state.development.memoryMb)},{' '}
          {minutes(state.development.timeMinutes)}
          {!state.development.partition && (
            <span className="cluster-workspace-attention"> · no partition</span>
          )}
        </summary>
        <fieldset className="cluster-workspace-group" disabled={!editable}>
          <legend>Account for agent jobs</legend>
          {latest.account && (
            <small className="cluster-workspace-note">
              Confirmed: <strong>{latest.account}</strong>
            </small>
          )}
          <small className="cluster-workspace-note">
            Slurm default account: <strong>{setup.defaultAccount ?? 'not reported'}</strong> ·{' '}
            {read('accounts', setup.observedAt)}
          </small>
          {accountOptions.map((name) => {
            const account = setup.accounts.find((item) => item.name === name);
            return (
              <label key={name} className="cluster-workspace-choice">
                <input
                  type="radio"
                  name={accountGroup}
                  checked={form.account === name}
                  disabled={!canChoose && name !== latest.account}
                  onChange={() => edit({ account: name })}
                />
                <span>
                  {name}
                  <small>
                    {!account
                      ? 'saved choice · not in the latest account reading'
                      : `fairshare ${account.fairShare === null ? 'not current' : account.fairShare.toFixed(3)}`}
                  </small>
                </span>
              </label>
            );
          })}
          {!accountOptions.length && (
            <small className="cluster-workspace-note">No accounts read yet.</small>
          )}
          <small className="cluster-workspace-note">
            {setup.accounts.length > 1 ? 'Choose the account for development jobs. ' : ''}
            Fairshare ({read('', setup.fairshareObservedAt).trim()}) is a priority factor, not
            remaining capacity.
          </small>
          {!canChoose && (
            <small className="cluster-workspace-note">
              {state.connected ? 'The latest account reading failed.' : 'Not connected now.'} A
              confirmed account is kept; choosing another needs a current reading.
            </small>
          )}
          {setup.error && <small className="form-error">{setup.error}</small>}
        </fieldset>
        <fieldset className="cluster-workspace-group" disabled={!editable}>
          <legend>Development job defaults</legend>
          {suggested && !same(suggested, form.development) && (
            <div className="cluster-workspace-notice" role="status">
              <p>
                {setup.developmentSuggestion ?? 'Suggested development defaults are available.'}
              </p>
              <button
                type="button"
                className="flow-button"
                onClick={() => edit({ development: suggested })}
              >
                Use suggested defaults
              </button>
            </div>
          )}
          <div className="cluster-workspace-defaults">
            <label>
              Site preset
              <select
                value={form.siteRules ?? ''}
                onChange={(event) =>
                  edit({ siteRules: event.target.value === 'fasrc-cannon' ? 'fasrc-cannon' : null })
                }
              >
                <option value="">None</option>
                <option value="fasrc-cannon">FASRC Cannon</option>
              </select>
            </label>
            {names.map((field) => (
              <label key={field}>
                {fieldLabels[field]}
                <input
                  value={form.development[field]}
                  placeholder={field === 'partition' ? 'Choose a partition' : 'Slurm default'}
                  list={field === 'partition' ? partitionList : undefined}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => editDevelopment(field, event.target.value)}
                />
              </label>
            ))}
            {numbers.map((field) => (
              <label key={field}>
                {fieldLabels[field]}
                <input
                  type="number"
                  inputMode="numeric"
                  step={1}
                  {...bounds(field)}
                  value={form.development[field]}
                  onChange={(event) => editDevelopment(field, event.target.value)}
                />
              </label>
            ))}
          </div>
          <datalist id={partitionList}>
            {partitions.map((partition) => (
              <option key={partition.name} value={partition.name} />
            ))}
          </datalist>
          <small className="cluster-workspace-note">
            Development jobs need a partition before one can start; until then the rest of this
            setup still saves. A blank QOS uses Slurm’s default.{' '}
            {read('Partitions', setup.partitionsObservedAt)}. The FASRC Cannon preset only suggests
            defaults from a current reading; nothing changes until you save.
          </small>
        </fieldset>
      </details>

      {active && !behind && (
        <div className="cluster-workspace-save" role="group" aria-label="Unsaved workspace setup">
          <p>
            Unsaved:{' '}
            {changed(active, latest)
              .map((section) => sectionLabels[section])
              .join(', ')}
            {accountChoice && ` · agent jobs on ${active.alias} will use ${accountChoice}`}
          </p>
          <div className="cluster-workspace-actions">
            <button className="flow-button primary" disabled={locked} onClick={save}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="flow-button" disabled={locked} onClick={() => setDraft(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
