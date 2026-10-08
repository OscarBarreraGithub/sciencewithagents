import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Server } from 'lucide-react';
import {
  clusterProjectCreateSchema,
  clusterProjectListSchema,
  clusterProjectOpenedSchema,
  clusterProjectSummarySchema,
  clusterWorkspaceSchema,
  effortLabel,
  latestFamily,
  managerModelChoice,
  policyDefaultEffort,
  policyProvider,
  taskTiers,
  type ClusterProjectSummary,
  type ProviderId,
} from '@dock/shared';
import {
  apiCluster,
  apiComputer,
  apiScope,
  ApiError,
  connectionLost,
  controllerApi,
  leaveClusterProject,
  selectClusterProject,
} from '../api';
import { Notepad } from '../Notepad';
import { useBrowserNotepad } from '../useBrowserNotepad';
import { useCatalogs } from './ProjectConfiguration';
import { useReading } from './useHomeData';
import { useClusterProjectDiscovery } from './ClusterProjectDestination';
import './cluster-project-setup.css';

const providerNames: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude' };
type Manager = { provider: ProviderId; model: string | null; effort: string | null };
type CreateBody = ReturnType<typeof clusterProjectCreateSchema.parse>;
/** Typed choices, the unsent first brief and a create request whose reply may have been lost. */
type Saved = {
  id: string;
  folderId: string;
  name: string;
  nameEdited: boolean;
  description: string;
  manager: Manager | null;
  brief: string;
  create: CreateBody | null;
  projectId: string | null;
};
const fresh = (): Saved => ({
  id: crypto.randomUUID(),
  folderId: '',
  name: '',
  nameEdited: false,
  description: '',
  manager: null,
  brief: '',
  create: null,
  projectId: null,
});
const setupKey = () => `dock:${apiScope()}:cluster-project-setup`;
// Kept on the controller's own scope so the setup page and a reopened cluster document agree.
const openKey = (id: string) => `dock:${apiComputer()}:cluster-project-open:${id}`;
const briefKey = (id: string) => `dock:${apiComputer()}:cluster-brief:${id}`;
function read<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return fallback;
    const restored = { ...fallback, ...value };
    // Earlier cluster drafts predate the flag; keep their typed names when folders change.
    if (Object.hasOwn(restored, 'nameEdited') && !Object.hasOwn(value, 'nameEdited') && value.name)
      restored.nameEdited = true;
    return restored;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
const readBrief = (id: string) => {
  try {
    return localStorage.getItem(briefKey(id)) ?? '';
  } catch {
    return '';
  }
};
const writeBrief = (id: string, text: string) => {
  try {
    localStorage.setItem(briefKey(id), text);
    return true;
  } catch {
    return false;
  }
};
/** One plain UUID per project, retained: every open (including after reloads) repeats it. */
function durableOpenKey(id: string) {
  let key: string = crypto.randomUUID();
  try {
    key = localStorage.getItem(openKey(id)) ?? key;
    localStorage.setItem(openKey(id), key);
  } catch {
    throw new Error(
      'This browser could not save the open request. Allow browser storage and retry; nothing was opened.',
    );
  }
  return key;
}
/** A refusal means nothing was applied; any other failure may have arrived. */
const refused = (error: unknown) =>
  error instanceof ApiError && error.status >= 400 && error.status < 500 && !connectionLost(error);
const failure = (error: unknown) =>
  error instanceof Error ? error.message : 'The reply could not be read. Retry sends it again.';

const developmentText: Record<ClusterProjectSummary['development']['state'], string> = {
  absent: 'No development allocation yet',
  allocating: 'Requesting a development allocation',
  uncertain: 'Checking whether an allocation was submitted',
  pending: 'Waiting in the Slurm queue',
  ready: 'Allocation running',
  disconnected: 'Allocation not reachable',
  idle: 'Allocation idle',
  released: 'Allocation released',
  rejected: 'Slurm rejected the request',
  error: 'Allocation problem',
};
const statusText = (project: ClusterProjectSummary) =>
  [
    developmentText[project.development.state],
    project.development.jobId && `job ${project.development.jobId}`,
    project.development.message,
    project.opening?.message,
    project.review?.pending && 'Waiting for submission review',
  ]
    .filter(Boolean)
    .join(' · ');

/**
 * Writes the unsent brief as the remote manager chat's browser draft (the same key and shape as
 * useSharedDraft), then reopens in that verified scope. Nothing is sent; a different existing
 * draft there is never replaced, and the source brief stays saved here.
 */
function handOff(projectId: string, managerId: string, text: string) {
  const scope = `cluster:${apiComputer()}:${projectId}`;
  const key = `dock:${scope}:workspace:draft:${managerId}`;
  if (text.trim()) {
    const current = read<{ text?: string; baseRevision?: number }>(key, { baseRevision: 0 });
    const existing = current.text ?? '';
    if (existing && existing !== text)
      return 'The cluster chat already has a different unsent draft. Your brief stays here.';
    if (!write(key, { ...current, text }) || read<{ text?: string }>(key, {}).text !== text)
      return 'This browser could not save the brief for the cluster chat. It stays here.';
  }
  selectClusterProject(projectId, `#/chat/${managerId}`);
  return '';
}
/** Opens through the controller with the project's durable key; never sends a message. */
async function openProject(id: string) {
  const opened = clusterProjectOpenedSchema.parse(
    await controllerApi(
      `/cluster/projects/${id}/open`,
      { key: durableOpenKey(id) },
      undefined,
      90_000,
    ),
  );
  if (opened.project.id !== id)
    throw new Error('A different cluster project answered. Nothing was opened.');
  return opened;
}

/** Explicit consent; retries retain the exact project-bound receipt and never send a brief. */
async function startTracking(project: ClusterProjectSummary) {
  const storage = `dock:${apiComputer()}:cluster-project-tracking:${project.id}`;
  let key: string;
  try {
    key = localStorage.getItem(storage) ?? crypto.randomUUID();
    localStorage.setItem(storage, key);
  } catch {
    throw new Error(
      'This browser could not save the tracking request. Allow browser storage and retry; tracking was not started.',
    );
  }
  const result = clusterProjectSummarySchema.parse(
    await controllerApi(`/cluster/projects/${project.id}/tracking`, { key }),
  );
  if (result.id !== project.id || result.folderId !== project.folderId || result.needsTracking)
    throw new Error('Project tracking could not be confirmed. Retry the same action.');
  return result;
}

function ProjectStatus({
  project,
  onTrack,
  busy = false,
}: {
  project: ClusterProjectSummary;
  onTrack?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="cluster-project-status" role="status">
      <strong>{developmentText[project.development.state]}</strong>
      {project.development.jobId && ` · job ${project.development.jobId}`}
      {project.development.node && ` on ${project.development.node}`}
      {project.development.message && ` · ${project.development.message}`}
      {project.opening && project.opening.state !== 'ready' && (
        <small>{project.opening.message}</small>
      )}
      {project.review && !project.review.allowed && (
        <small>
          Submission review: {project.review.status.replaceAll('_', ' ')} · {project.review.message}
          <a className="flow-button" href="#/work">
            Open submission review
          </a>
        </small>
      )}
      {project.setupRequired && (
        <>
          <br />
          Setup needed: {project.setupRequired}{' '}
          <a className="flow-button" href="#/work">
            Open QUARK cluster setup
          </a>
        </>
      )}
      {project.needsTracking && (
        <div className="cluster-project-tracking">
          <p>
            Start tracking creates the initial project Git history using the app’s file exclusions.
            Your files and unsent request are retained.
          </p>
          {onTrack && (
            <button type="button" className="flow-button" disabled={busy} onClick={onTrack}>
              Start tracking
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Saved cluster projects: separate destinations, never shown as local managers. */
export function ClusterProjectList() {
  const discovery = useClusterProjectDiscovery();
  const list = useReading(
    '/cluster/projects',
    clusterProjectListSchema.parse,
    controllerApi,
    !!discovery && !apiCluster(),
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ClusterProjectSummary | null>(null);
  if (apiCluster() || !list.data?.length) return null;
  async function open(project: ClusterProjectSummary, track = false) {
    setChosen(project.id);
    setBusy(true);
    setError('');
    setStatus(null);
    try {
      if (track) await startTracking(project);
      const opened = await openProject(project.id);
      if (!opened.destination) return setStatus(opened.project);
      const problem = handOff(project.id, opened.destination.managerId, readBrief(project.id));
      if (problem) setError(problem);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="cluster-project-list" aria-label="Cluster projects">
      <h3>
        <Server size={15} /> Cluster projects
      </h3>
      {list.data.map((project) => (
        <div key={project.id} className="cluster-project-row">
          <span>
            <strong>{project.name}</strong>
            <small>
              {project.alias} · {developmentText[project.development.state]}
              {project.setupRequired ? ' · setup needed' : ''}
            </small>
          </span>
          <button
            type="button"
            className="flow-button"
            disabled={busy}
            onClick={() => void open(project)}
          >
            {busy && chosen === project.id ? 'Opening…' : 'Open'}
          </button>
        </div>
      ))}
      {status && status.id === chosen && (
        <ProjectStatus project={status} busy={busy} onTrack={() => void open(status, true)} />
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}

const summaryList = (value: unknown) => [clusterProjectSummarySchema.parse(value)];
export function ClusterProjectSetup() {
  const key = setupKey();
  const [saved, setSaved] = useState<Saved>(() => read(key, fresh()));
  const update = (patch: Partial<Saved>) =>
    setSaved((old) => {
      const next = { ...old, ...patch };
      write(key, next);
      // A created project keeps its own copy, so another setup never takes its brief.
      if (next.projectId) writeBrief(next.projectId, next.brief);
      return next;
    });
  const writingKey = `${key}:writing`;
  const [writing, setWritingState] = useState(() => {
    try {
      return sessionStorage.getItem(writingKey) === saved.id;
    } catch {
      return false;
    }
  });
  const setWriting = (open: boolean) => {
    setWritingState(open);
    try {
      if (open) sessionStorage.setItem(writingKey, saved.id);
      else sessionStorage.removeItem(writingKey);
    } catch {
      /* The notepad still opens on this page. */
    }
  };
  const workspace = useReading('/cluster/workspace', clusterWorkspaceSchema.parse, controllerApi);
  const project = useReading(
    saved.projectId ? `/cluster/projects/${saved.projectId}` : '/cluster/projects',
    saved.projectId ? summaryList : clusterProjectListSchema.parse,
    controllerApi,
  );
  const opening = useReading(
    `/cluster/projects/${saved.projectId}/open`,
    clusterProjectOpenedSchema.parse,
    controllerApi,
    !!saved.projectId,
  );
  const { catalogs, policy } = useCatalogs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<ClusterProjectSummary | null>(null);
  const running = useRef(false);
  const handedOff = useRef<string | null>(null);
  const selection = useRef({ start: 0, end: 0 });
  const { draft, history, checkpoint } = useBrowserNotepad(
    `${key}:${saved.id}`,
    saved.brief,
    (brief) => update({ brief }),
  );
  const summary = opened ?? (saved.projectId ? (project.data?.[0] ?? null) : null);
  useEffect(() => {
    const latest = opening.data;
    if (!latest || latest.project.id !== saved.projectId || busy) return;
    setOpened(latest.project);
    if (!latest.destination || !writing || handedOff.current === latest.project.id) return;
    handedOff.current = latest.project.id;
    const problem = handOff(latest.project.id, latest.destination.managerId, draft.currentText());
    if (problem) setError(problem);
  }, [opening.data, saved.projectId, busy, writing]);

  const roots = workspace.data?.roots ?? [];
  const folders = roots.flatMap((root) =>
    root.index.entries
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => ({
        id: entry.id,
        name: entry.relativePath === '.' ? root.label : entry.relativePath.split('/').at(-1)!,
        current:
          workspace.data?.connected &&
          root.index.connectionId === workspace.data.connectionId &&
          ['ready', 'truncated'].includes(root.index.state),
        label:
          entry.relativePath === '.'
            ? `${root.label} (whole folder)`
            : `${root.label} / ${entry.relativePath}`,
      })),
  );
  const setup = workspace.data?.setup;
  const needs = [
    workspace.data && !setup?.accountConfirmed && 'confirm the account for development jobs',
    workspace.data && !workspace.data.development.partition && 'save a development partition',
  ].filter(Boolean);
  const enabled = policy?.enabledProviders ?? (['codex', 'claude'] as ProviderId[]);
  const provider =
    saved.manager?.provider ??
    (policy && policyProvider(policy, 'manager')) ??
    enabled[0] ??
    'codex';
  const catalog = catalogs[provider];
  const central = policy ? managerModelChoice(policy, provider) : undefined;
  const model = saved.manager?.model
    ? catalog.models.find((item) => item.id === saved.manager!.model)
    : central?.model
      ? catalog.models.find((item) => item.id === central.model)
      : central
        ? latestFamily(catalog.models, central.family)
        : undefined;
  const effort =
    saved.manager?.effort ??
    central?.effort ??
    (model ? policyDefaultEffort(model.efforts, taskTiers.manager) : null);
  // Fixed once a create request exists: its exact body is retried until it reconciles.
  const locked = busy || !!saved.create || !!saved.projectId;

  /** One action: create if needed (exact retained request), then open with the durable key. */
  async function spawn(track = false) {
    if (running.current) return;
    const reconciling = !!saved.create;
    let body = saved.create;
    if (!saved.projectId && !body) {
      const parsed = clusterProjectCreateSchema.safeParse({
        key: crypto.randomUUID(),
        folderId: saved.folderId,
        name: saved.name,
        description: saved.description,
        manager: { provider, model: saved.manager?.model ?? null, effort },
      });
      if (!parsed.success)
        return setError(
          !saved.folderId
            ? 'Choose a saved cluster folder.'
            : !saved.name.trim()
              ? 'Name the project.'
              : 'Choose the manager’s model and reasoning once models are read.',
        );
      body = parsed.data;
    }
    running.current = true;
    setWriting(true);
    setBusy(true);
    setError('');
    checkpoint();
    let creating = false;
    try {
      let id = saved.projectId;
      if (!id && body) {
        // Recorded first: a lost reply (even after reload) retries this exact request.
        creating = true;
        if (!write(key, { ...saved, create: body }))
          throw new Error(
            'This browser could not save the create request. Allow browser storage and retry; no project was created.',
          );
        update({ create: body });
        id = clusterProjectSummarySchema.parse(await controllerApi('/cluster/projects', body)).id;
        creating = false;
        update({ create: null, projectId: id });
      }
      if (!id) return;
      if (track && summary?.id === id) await startTracking(summary);
      const result = await openProject(id);
      setOpened(result.project);
      project.retry();
      if (result.destination) {
        handedOff.current = id;
        const problem = handOff(id, result.destination.managerId, draft.currentText());
        if (problem) setError(problem);
      }
    } catch (e) {
      // A refused create was not applied, so its fields may change. Any unknown outcome keeps
      // the exact request; it is only ever retried, never replaced by a new one.
      if (creating && refused(e) && !reconciling) update({ create: null });
      setError(failure(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  const status = busy
    ? saved.projectId
      ? 'Opening the cluster project…'
      : 'Creating the cluster project…'
    : saved.create
      ? 'Creation may not have finished'
      : summary
        ? statusText(summary)
        : 'Not created yet';
  return (
    <section className="cluster-project-setup" aria-label="Cluster project setup">
      {writing && (
        <Notepad
          className="cluster-project-notepad"
          draft={draft}
          agentId={saved.id}
          clientId={null}
          agentName={saved.name || 'Cluster project'}
          mode="brief"
          title="First request for the cluster manager"
          sendLabel={
            summary?.needsTracking
              ? 'Start tracking'
              : saved.projectId
                ? 'Check again and open'
                : 'Spawn cluster project'
          }
          statusLabel={status}
          selection={selection}
          canSend={!busy}
          sending={busy}
          localOnly
          localHistory={history}
          notice=""
          overlay={
            error ||
            summary?.needsTracking ||
            summary?.opening?.state === 'preparing' ||
            summary?.review?.pending ? (
              <p className="cluster-project-notepad-note" role={error ? 'alert' : 'status'}>
                {error ||
                  (summary?.needsTracking
                    ? 'Start tracking creates the initial project Git history with the app’s exclusions. Your unsent text is kept.'
                    : summary?.review?.pending
                      ? 'Waiting for submission review. Keep writing; nothing is sent.'
                      : 'Preparing the project. First setup may take several minutes; keep writing. Nothing is sent.')}
              </p>
            ) : undefined
          }
          onSend={() => void spawn(!!summary?.needsTracking)}
          onMinimize={() => setWriting(false)}
          controls={
            <>
              {summary?.setupRequired && (
                <p className="cluster-project-status">
                  Setup needed: {summary.setupRequired}{' '}
                  <a className="flow-button" href="#/work">
                    Open QUARK cluster setup
                  </a>
                </p>
              )}
              <p className="cluster-project-status">
                Saved in this browser and not sent. Text only here: attach files in the cluster chat
                once it is connected, then press Send there.
              </p>
            </>
          }
        />
      )}
      <fieldset className="config-section" disabled={locked}>
        <legend>Cluster project</legend>
        <label>
          Folder on the cluster
          <select
            value={saved.folderId}
            onChange={(e) => {
              const folder = folders.find((item) => item.id === e.target.value);
              update({
                folderId: e.target.value,
                name: saved.nameEdited ? saved.name : (folder?.name ?? ''),
              });
            }}
          >
            <option value="">
              {workspace.loaded ? 'Choose a saved folder' : 'Reading saved folders…'}
            </option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id} disabled={!folder.current}>
                {folder.label}
                {!folder.current && ' · needs refresh'}
              </option>
            ))}
          </select>
        </label>
        {workspace.loaded && !folders.length && (
          <p className="config-help">
            No listed cluster folders yet. Save one and refresh its listing in{' '}
            <a className="flow-button" href="#/work">
              QUARK cluster setup
            </a>
            .
          </p>
        )}
        {needs.length > 0 && (
          <p className="config-help">
            Before it can start: {needs.join(' and ')} in{' '}
            <a className="flow-button" href="#/work">
              QUARK cluster setup
            </a>
            .
          </p>
        )}
        <label>
          Name
          <input
            value={saved.name}
            maxLength={100}
            onChange={(e) => update({ name: e.target.value, nameEdited: true })}
          />
        </label>
        <label>
          Description (optional)
          <input
            value={saved.description}
            maxLength={2000}
            onChange={(e) => update({ description: e.target.value })}
          />
        </label>
        <div className="config-grid">
          <label>
            Manager provider
            <select
              value={provider}
              onChange={(e) =>
                update({
                  manager: { provider: e.target.value as ProviderId, model: null, effort: null },
                })
              }
            >
              {(['codex', 'claude'] as const)
                .filter((item) => enabled.includes(item) || item === provider)
                .map((item) => (
                  <option key={item} value={item}>
                    {providerNames[item]}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Model
            <select
              value={model?.id ?? ''}
              onChange={(e) => {
                const next = catalog.models.find((item) => item.id === e.target.value);
                update({
                  manager: {
                    provider,
                    model: next?.id ?? null,
                    effort: next
                      ? (policyDefaultEffort(next.efforts, taskTiers.manager) ?? null)
                      : null,
                  },
                });
              }}
            >
              {!model && (
                <option value="">{catalog.loaded ? 'Choose a model' : 'Reading models…'}</option>
              )}
              {catalog.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reasoning
            <select
              value={effort ?? ''}
              disabled={!model}
              onChange={(e) =>
                update({
                  manager: {
                    provider,
                    model: saved.manager?.model ?? null,
                    effort: e.target.value,
                  },
                })
              }
            >
              {!model && <option value="">Read models first</option>}
              {model?.efforts.map((item) => (
                <option key={item} value={item}>
                  {effortLabel(item)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="config-help">
          Defaults come from your central model settings. The manager runs on the cluster with that
          computer’s own sign-in.
        </p>
      </fieldset>
      {saved.create && !busy && (
        <div className="cluster-project-notice" role="status">
          <p>
            Creating “{saved.create.name}” may not have finished. Retry sends the same request; it
            is never sent as a new project. You can leave this page; it stays saved.
          </p>
        </div>
      )}
      {summary && <ProjectStatus project={summary} busy={busy} onTrack={() => void spawn(true)} />}
      {error && !writing && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="cluster-project-actions">
        <button
          type="button"
          className="flow-button primary"
          disabled={busy}
          onClick={() => void spawn()}
        >
          {busy
            ? 'Working…'
            : saved.create
              ? 'Retry'
              : saved.projectId
                ? 'Check again and open'
                : 'Spawn cluster project'}
        </button>
        {!writing && (
          <button type="button" className="flow-button" onClick={() => setWriting(true)}>
            {saved.brief ? 'Continue first request' : 'Write first request'}
          </button>
        )}
        {saved.projectId && !busy && (
          <button
            type="button"
            className="flow-button"
            onClick={() => {
              const next = fresh();
              write(key, next);
              setSaved(next);
              setOpened(null);
            }}
          >
            Start another
          </button>
        )}
      </div>
    </section>
  );
}

/** Reconnect a saved cluster scope through its controller before anything nested mounts. */
export function ClusterGate({ children }: { children: ReactNode }) {
  const cluster = apiCluster();
  const chatId = location.hash.match(/^#\/chat\/([0-9a-f-]{36})(?:[/?]|$)/i)?.[1];
  const draftKey = chatId ? `dock:${apiScope()}:workspace:draft:${chatId}` : null;
  const [state, setState] = useState<{
    phase: 'checking' | 'ready' | 'waiting' | 'error';
    project?: ClusterProjectSummary;
    error?: string;
  }>({ phase: cluster ? 'checking' : 'ready' });
  const [brief, setBrief] = useState(() =>
    draftKey
      ? read<{ text: string }>(draftKey, { text: '' }).text
      : cluster
        ? readBrief(cluster.projectId)
        : '',
  );
  const [draftError, setDraftError] = useState('');
  const draftWritable = useRef(true);
  const started = useRef(false);
  const opening = useReading(
    `/cluster/projects/${cluster?.projectId}/open`,
    clusterProjectOpenedSchema.parse,
    controllerApi,
    !!cluster && state.phase === 'waiting',
  );
  useEffect(() => {
    const latest = opening.data;
    if (!cluster || state.phase !== 'waiting' || latest?.project.id !== cluster.projectId) return;
    if (latest.destination && !draftWritable.current)
      setState({ phase: 'error', error: 'Copy your unsaved draft before opening the chat.' });
    else
      setState(
        latest.destination ? { phase: 'ready' } : { phase: 'waiting', project: latest.project },
      );
  }, [opening.data]);
  async function check(track = false) {
    if (!cluster) return;
    setState((old) => ({ ...old, phase: 'checking', error: '' }));
    try {
      if (track && state.project) await startTracking(state.project);
      // The controller route itself: the nested gateway may not exist after a restart.
      const opened = clusterProjectOpenedSchema.parse(
        await controllerApi(
          `/cluster/projects/${cluster.projectId}/open`,
          { key: durableOpenKey(cluster.projectId) },
          undefined,
          90_000,
        ),
      );
      if (opened.project.id !== cluster.projectId)
        throw new Error('A different cluster project answered. Return to the controller.');
      if (opened.destination && !draftWritable.current)
        throw new Error('Copy your unsaved draft before opening the chat.');
      setState(
        opened.destination ? { phase: 'ready' } : { phase: 'waiting', project: opened.project },
      );
    } catch (e) {
      if (refused(e))
        try {
          localStorage.removeItem(openKey(cluster.projectId));
        } catch {
          /* A new key is chosen next time either way. */
        }
      setState({ phase: 'error', error: failure(e) });
    }
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void check();
  }, []);
  if (!cluster || state.phase === 'ready') return <>{children}</>;
  return (
    <main className="cluster-gate" aria-label="Reconnecting cluster project">
      <h1>
        <Server size={20} /> Cluster project
      </h1>
      {state.phase === 'checking' ? (
        <p role="status">Reconnecting through its controller…</p>
      ) : state.project ? (
        <ProjectStatus project={state.project} onTrack={() => void check(true)} />
      ) : (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      )}
      <label className="cluster-project-brief">
        {draftKey
          ? 'Your unsent chat draft (saved here)'
          : 'Your unsent first request (saved here)'}
        <textarea
          rows={5}
          value={brief}
          onChange={(event) => {
            setBrief(event.target.value);
            if (draftKey) {
              const current = read<{ text: string; baseRevision: number }>(draftKey, {
                text: '',
                baseRevision: 0,
              });
              draftWritable.current = write(draftKey, { ...current, text: event.target.value });
            } else draftWritable.current = writeBrief(cluster.projectId, event.target.value);
            setDraftError(
              draftWritable.current
                ? ''
                : 'This browser could not save the draft. Copy it before leaving.',
            );
          }}
        />
        <small>Nothing is sent. Chat drafts saved for this project stay in this browser.</small>
      </label>
      {draftError && (
        <p role="alert" className="form-error">
          {draftError}
        </p>
      )}
      <div className="cluster-project-actions">
        <button
          type="button"
          className="flow-button primary"
          disabled={state.phase === 'checking'}
          onClick={() => void check()}
        >
          Check again
        </button>
        <button type="button" className="flow-button" onClick={() => leaveClusterProject()}>
          Return to controller
        </button>
      </div>
    </main>
  );
}
