import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FolderOpen, RefreshCw, Sparkles } from 'lucide-react';
import {
  effortLabel,
  id as uuidSchema,
  latestFamily,
  modelPolicyStatusSchema,
  policyProvider,
  projectConnectionSchema,
  projectOptionsSchema,
  projectSchema,
  projectTrackingSchema,
  providerDefaultEffort,
  taskTiers,
  type Agent,
  type Model,
  type ModelPolicy,
  type Project,
  type ProviderId,
} from '@dock/shared';
import { api, apiScope, ApiError, detail, models } from '../api';
import { SessionSettings } from '../SessionSettings';
import {
  modelFamilies,
  parseProjectQuark,
  parseWorkflow,
  providerMixes,
  spendingLevels,
  workerDefault,
  workerDefaults,
  workerPurposes,
  type ProjectWorkflow,
  type QuarkPriority,
  type WorkerChoice,
  type WorkerPurpose,
} from './chat-contracts';
import {
  blankQuarkPlan,
  chosenCaps,
  ProjectQuarkSettings,
  QuarkControls,
  readQuarkPlan,
  useCoordinator,
  type CapRequest,
  type QuarkPlan,
} from './ProjectQuark';
import './ProjectConfiguration.css';

const providerNames: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude' };
const mixLabels = {
  'codex-only': 'Codex only',
  'codex-heavy': 'Codex heavy',
  balanced: 'Balanced',
  'claude-heavy': 'Claude heavy',
  'claude-only': 'Claude only',
} as const;
const spendingLabels = { light: 'Light', default: 'Default', tokenmax: 'Tokenmax' } as const;
const purposeLabels: Record<WorkerPurpose, string> = {
  research: 'Research & coding',
  review: 'Review',
  bulk: 'Bulk tasks',
};
const family = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const blankWorkflow = (): ProjectWorkflow => parseWorkflow({ spending: 'default' });
type Catalogs = Record<ProviderId, { models: Model[]; error: string; loaded: boolean }>;

/** Live native catalogs for both providers; never a hard-coded version list. */
export function useCatalogs() {
  const empty = { models: [], error: '', loaded: false };
  const [catalogs, setCatalogs] = useState<Catalogs>({ codex: empty, claude: empty });
  const [policy, setPolicy] = useState<ModelPolicy | null>(null);
  const load = () => {
    for (const provider of ['codex', 'claude'] as const)
      void models(undefined, provider)
        .then((list) =>
          setCatalogs((old) => ({ ...old, [provider]: { models: list, error: '', loaded: true } })),
        )
        .catch((reason: unknown) =>
          setCatalogs((old) => ({
            ...old,
            [provider]: {
              models: old[provider].models,
              loaded: true,
              error:
                reason instanceof Error
                  ? reason.message
                  : `${providerNames[provider]} models could not be read.`,
            },
          })),
        );
    void api('/model-policy')
      .then((value) => setPolicy(modelPolicyStatusSchema.parse(value).policy))
      .catch(() => {
        /* Provider choices still work without the central summary. */
      });
  };
  useEffect(load, []);
  return { catalogs, policy, reload: load };
}

function resolved(choice: WorkerChoice, catalogs: Catalogs) {
  const list = catalogs[choice.provider].models;
  return choice.model
    ? list.find((model) => model.id === choice.model)
    : latestFamily(list, choice.family);
}
function familyFor(model: Model, provider: ProviderId, fallback: string) {
  const known = Object.entries(modelFamilies).find(
    ([name, value]) => value.provider === provider && latestFamily([model], name),
  );
  return (
    known?.[0] ??
    (modelFamilies[fallback]?.provider === provider ? fallback : model.id).slice(0, 60)
  );
}

/** Worker preferences: two independent sliders plus exact per-purpose choices. */
function WorkerSettings({
  workflow,
  catalogs,
  disabled,
  onChange,
}: {
  workflow: ProjectWorkflow;
  catalogs: Catalogs;
  disabled: boolean;
  onChange: (next: ProjectWorkflow) => void;
}) {
  const custom = workerPurposes.some((purpose) => workflow.overrides[purpose]);
  const mixIndex = providerMixes.indexOf(workflow.providerMix);
  const spendIndex = spendingLevels.indexOf(workflow.spending);
  const summary = workerPurposes
    .map((purpose) => {
      const choice = workerDefault(workflow, purpose);
      return `${purposeLabels[purpose]}: ${resolved(choice, catalogs)?.label ?? family(choice.family)}`;
    })
    .join(' · ');
  const setOverride = (purpose: WorkerPurpose, value: WorkerChoice | null) => {
    const overrides = { ...workflow.overrides };
    if (value) overrides[purpose] = value;
    else delete overrides[purpose];
    onChange({ ...workflow, overrides });
  };
  return (
    <fieldset className="config-section" disabled={disabled}>
      <legend>Workers</legend>
      <p className="config-help">
        These describe the team your manager delegates to. They do not change the manager chosen
        above.
      </p>
      <div className={`config-sliders ${custom ? 'is-custom' : ''}`}>
        <label className="config-slider">
          <span>Provider mix</span>
          <input
            type="range"
            min={0}
            max={providerMixes.length - 1}
            step={1}
            value={mixIndex}
            aria-valuetext={mixLabels[workflow.providerMix]}
            onChange={(event) =>
              onChange({ ...workflow, providerMix: providerMixes[Number(event.target.value)]! })
            }
          />
          <span className="config-stops" aria-hidden="true">
            {providerMixes.map((mix) => (
              <span key={mix} className={mix === workflow.providerMix ? 'active' : ''}>
                {mixLabels[mix]}
              </span>
            ))}
          </span>
        </label>
        <label className="config-slider">
          <span>Usage</span>
          <input
            type="range"
            min={0}
            max={spendingLevels.length - 1}
            step={1}
            value={spendIndex}
            aria-valuetext={spendingLabels[workflow.spending]}
            onChange={(event) =>
              onChange({ ...workflow, spending: spendingLevels[Number(event.target.value)]! })
            }
          />
          <span className="config-stops three" aria-hidden="true">
            {spendingLevels.map((level) => (
              <span key={level} className={level === workflow.spending ? 'active' : ''}>
                {spendingLabels[level]}
              </span>
            ))}
          </span>
        </label>
        {custom && (
          <p className="config-custom-note">
            Custom task models are in use, so these sliders no longer describe every choice.{' '}
            <button
              type="button"
              className="config-link-button"
              onClick={() => onChange({ ...workflow, overrides: {} })}
            >
              Use the slider defaults
            </button>
          </p>
        )}
      </div>
      <details className={`config-models ${custom ? 'is-custom' : ''}`} open={custom || undefined}>
        <summary>
          <strong>{custom ? 'Custom task models' : 'Task models'}</strong>
          <small>{summary}</small>
        </summary>
        {workerPurposes.map((purpose) => {
          const preset = workerDefault({ ...workflow, overrides: {} }, purpose);
          const saved = workflow.overrides[purpose];
          const current = saved ?? preset;
          const model = resolved(current, catalogs);
          const presetModel = resolved(preset, catalogs);
          const catalog = catalogs[current.provider];
          const value = saved ? `${saved.provider}:${saved.model ?? ''}` : '';
          return (
            <div className="config-model-row" key={purpose}>
              <label>
                {purposeLabels[purpose]}
                <select
                  value={value}
                  onChange={(event) => {
                    if (!event.target.value) return setOverride(purpose, null);
                    const [provider, id] = event.target.value.split(/:(.*)/s) as [
                      ProviderId,
                      string,
                    ];
                    const next = catalogs[provider].models.find((m) => m.id === id);
                    if (!next) return;
                    setOverride(purpose, {
                      provider,
                      family: familyFor(next, provider, preset.family),
                      model: next.id,
                      effort: null,
                    });
                  }}
                >
                  <option value="">
                    Slider default · {presetModel?.label ?? `${family(preset.family)} (not found)`}
                  </option>
                  {saved?.model && !model && (
                    <option value={value}>{saved.model} · not in the current catalog</option>
                  )}
                  {(['codex', 'claude'] as const).map((provider) =>
                    catalogs[provider].models.length ? (
                      <optgroup key={provider} label={providerNames[provider]}>
                        {catalogs[provider].models.map((m) => (
                          <option key={m.id} value={`${provider}:${m.id}`}>
                            {m.label}
                          </option>
                        ))}
                      </optgroup>
                    ) : null,
                  )}
                </select>
              </label>
              {saved?.model && model && (
                <label>
                  Thinking
                  <select
                    value={saved.effort ?? ''}
                    onChange={(event) =>
                      setOverride(purpose, { ...saved, effort: event.target.value || null })
                    }
                  >
                    <option value="">Automatic</option>
                    {model.efforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {effortLabel(effort)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!saved && catalog.loaded && !presetModel && (
                <p className="config-warning">
                  {catalog.error ||
                    `No ${family(preset.family)} model is offered by ${providerNames[preset.provider]} on this computer. Choose a replacement here; nothing is substituted silently.`}
                </p>
              )}
            </div>
          );
        })}
        <p className="config-help">
          Slider defaults follow the newest available model in each family when work starts. An
          exact choice keeps that model.
        </p>
      </details>
      <details className="config-defaults">
        <summary>See defaults</summary>
        <p>
          Each cell lists Research &amp; coding · Review · Bulk tasks. The mix slider tells your
          manager which provider you would like it to lean on; it is not a metered percentage.
        </p>
        <div className="config-table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Usage</th>
                {providerMixes.map((mix) => (
                  <th scope="col" key={mix}>
                    {mixLabels[mix]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spendingLevels.map((level) => (
                <tr key={level}>
                  <th scope="row">{spendingLabels[level]}</th>
                  {providerMixes.map((mix) => (
                    <td
                      key={mix}
                      className={
                        mix === workflow.providerMix && level === workflow.spending ? 'current' : ''
                      }
                    >
                      {workerDefaults[level][mix].map(family).join(' · ')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          If you have FAS Claude, I recommend Balanced or Claude heavy for default usage. I
          personally use Balanced + Tokenmax.
        </p>
      </details>
      <label className="config-check">
        <input
          type="checkbox"
          checked={workflow.applyChanges === 'human'}
          onChange={(event) =>
            onChange({ ...workflow, applyChanges: event.target.checked ? 'human' : 'manager' })
          }
        />
        <span>Let me review changes before they are applied</span>
      </label>
      <label className="config-check">
        <input
          type="checkbox"
          checked={workflow.reviewLimit === 'ask-human'}
          onChange={(event) =>
            onChange({
              ...workflow,
              reviewLimit: event.target.checked ? 'ask-human' : 'manager-decides',
            })
          }
        />
        <span>After two review rounds, ask me instead of letting the manager decide</span>
      </label>
      <label className="config-check">
        <input
          type="checkbox"
          checked={workflow.reviewPlan}
          onChange={(event) => onChange({ ...workflow, reviewPlan: event.target.checked })}
        />
        <span>
          Plan review: check the plan’s overall direction before work starts
          <small>A short, high-level check. Finished work is still reviewed independently.</small>
        </span>
      </label>
      <label className="config-check">
        <input
          type="checkbox"
          checked={workflow.ambiguity === 'ask-human'}
          onChange={(event) =>
            onChange({ ...workflow, ambiguity: event.target.checked ? 'ask-human' : 'continue' })
          }
        />
        <span>
          Stop and ask me when something is unclear
          <small>
            Otherwise the manager records a reasonable assumption, tells you, and continues other
            unblocked work. Genuine approvals always come to you.
          </small>
        </span>
      </label>
    </fieldset>
  );
}

/** Manager configuration for an existing project: native session settings + worker prefs. */
export function ProjectSettings({
  project,
  manager,
  act,
}: {
  project: Project;
  manager: Agent;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { catalogs, reload } = useCatalogs();
  const [saved, setSaved] = useState<ProjectWorkflow | null>(null);
  const [draft, setDraft] = useState<ProjectWorkflow | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const receipt = useRef<{ signature: string; key: string } | null>(null);
  const load = async () => {
    setError('');
    try {
      const value = parseWorkflow(await api(`/projects/${project.id}/workflow`));
      setSaved(value);
      setDraft(value);
      receipt.current = null;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Project settings could not be read.');
    }
  };
  useEffect(() => {
    void load();
  }, [project.id]);
  const save = async () => {
    if (!draft || !saved) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = { expectedRevision: saved.revision, workflow: draft };
      const signature = JSON.stringify(payload);
      if (receipt.current?.signature !== signature)
        receipt.current = { signature, key: crypto.randomUUID() };
      const value = parseWorkflow(
        await api(`/projects/${project.id}/workflow`, { key: receipt.current.key, ...payload }),
      );
      setSaved(value);
      setDraft(value);
      receipt.current = null;
      setNotice('Worker preferences saved. New delegations use them; running work is unchanged.');
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not save. Your choices are still here.',
      );
    } finally {
      setBusy(false);
    }
  };
  const dirty = draft && saved && JSON.stringify(draft) !== JSON.stringify(saved);
  return (
    <div className="project-config embedded">
      <section className="config-section">
        <h3>Manager</h3>
        <p className="config-help">
          {providerNames[manager.provider]} · this conversation keeps its provider and history.
          Model and reasoning changes apply from the manager’s next turn.
        </p>
        <SessionSettings agent={manager} close={() => {}} act={act} embedded />
      </section>
      {draft ? (
        <WorkerSettings workflow={draft} catalogs={catalogs} disabled={busy} onChange={setDraft} />
      ) : (
        !error && <p className="config-help">Reading {project.name} settings…</p>
      )}
      {error && (
        <div className="config-error" role="alert">
          <p>{error}</p>
          <button type="button" className="flow-button" onClick={() => void load()}>
            Reload saved settings
          </button>
          <button type="button" className="flow-button" onClick={reload}>
            <RefreshCw size={15} /> Read models again
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {draft && (
        <div className="config-save">
          <span>{dirty ? 'Unsaved worker changes' : 'Saved worker preferences'}</span>
          <button
            type="button"
            className="flow-button primary"
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save worker preferences'}
          </button>
        </div>
      )}
      <ProjectQuarkSettings projectId={project.id} />
    </div>
  );
}

type Spawn = {
  createKey: string;
  folderKey: string;
  startedAt: string;
  name: string;
  folder: 'fresh' | 'connect';
  provider: ProviderId | null;
  managerModel: string | null;
  managerEffort: string | null;
  workflow: ProjectWorkflow;
  project?: { id: string; managerId: string; existing: boolean };
  tracking?: { key: string; name: string };
  trackingPending?: boolean;
  managerSaved?: boolean;
  workflowRequest?: { key: string; expectedRevision: number; workflow: ProjectWorkflow };
  workflowSaved?: boolean;
  quark: QuarkPlan;
  // Each exact request is recorded before it is sent, so a retry or reload repeats its key.
  priorityRequest?: { key: string; expectedRevision: number; priority: QuarkPriority };
  prioritySaved?: boolean;
  capRequests?: Partial<Record<ProviderId, CapRequest>>;
  capsSaved?: Partial<Record<ProviderId, true>>;
};
const spawnKey = () => `dock:${apiScope()}:project-spawn`;
const suggestedName = 'New project';
function freshSpawn(): Spawn {
  return {
    createKey: crypto.randomUUID(),
    folderKey: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    name: suggestedName,
    folder: 'fresh',
    provider: null,
    managerModel: null,
    managerEffort: null,
    workflow: blankWorkflow(),
    quark: blankQuarkPlan(),
  };
}
function readSpawn(): Spawn {
  try {
    const raw = JSON.parse(localStorage.getItem(spawnKey()) ?? 'null') as Partial<Spawn> | null;
    if (
      raw &&
      uuidSchema.safeParse(raw.createKey).success &&
      uuidSchema.safeParse(raw.folderKey).success &&
      typeof raw.name === 'string'
    )
      return {
        ...freshSpawn(),
        ...raw,
        workflow: parseWorkflow(raw.workflow ?? {}),
        quark: readQuarkPlan(raw.quark),
        tracking: raw.tracking ? projectTrackingSchema.parse(raw.tracking) : undefined,
      } as Spawn;
  } catch {
    /* A readable new setup still works when storage holds an older shape. */
  }
  return freshSpawn();
}

/** New project page: name, folder, manager, workers; Spawn creates without a model turn. */
export function ProjectConfiguration({
  onCreated,
  heading,
}: {
  onCreated: (managerId: string, fresh: boolean) => void;
  heading: ReactNode;
}) {
  const { catalogs, policy, reload } = useCatalogs();
  const coordinator = useCoordinator();
  const [spawn, setSpawn] = useState(readSpawn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [canChooseFolder, setCanChooseFolder] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const locked = !!spawn.project || !!spawn.tracking;
  const enabled = policy?.enabledProviders ?? (['codex', 'claude'] as ProviderId[]);
  const provider =
    spawn.provider ?? (policy && policyProvider(policy, 'manager')) ?? enabled[0] ?? 'codex';
  const catalog = catalogs[provider];
  const managerModel = catalog.models.find((m) => m.id === spawn.managerModel);
  const centralChoice = policy?.models[provider][taskTiers.manager];
  const centralModel = centralChoice
    ? centralChoice.model
      ? catalog.models.find((m) => m.id === centralChoice.model)
      : latestFamily(catalog.models, centralChoice.family)
    : undefined;
  const persist = (next: Spawn) => {
    setSpawn(next);
    try {
      localStorage.setItem(spawnKey(), JSON.stringify(next));
    } catch {
      /* The exact request stays in this view when storage is unavailable. */
    }
    return next;
  };
  const edit = (patch: Partial<Spawn>, identity = false) => {
    setError('');
    // A different project request needs a new receipt; worker edits keep it.
    persist({
      ...spawn,
      ...patch,
      ...(identity && !locked ? { createKey: crypto.randomUUID() } : {}),
    });
  };
  useEffect(() => {
    // After the shell focuses the page heading on navigation, select the proposed name.
    const frame = requestAnimationFrame(() => {
      nameInput.current?.focus();
      nameInput.current?.select();
    });
    void api('/project-options')
      .then((value) =>
        setCanChooseFolder(
          apiScope() === 'local' && projectOptionsSchema.parse(value).canChooseFolder,
        ),
      )
      .catch(() => {});
    return () => cancelAnimationFrame(frame);
  }, []);

  const finish = async (current: Spawn) => {
    let next = current;
    const project = next.project!;
    if (project.existing) {
      localStorage.removeItem(spawnKey());
      onCreated(project.managerId, false);
      return;
    }
    if (!next.managerSaved && next.managerModel) {
      const manager = (await detail(project.managerId)).agent;
      await api(`/agents/${project.managerId}/settings`, {
        model: next.managerModel,
        effort: next.managerEffort ?? manager.effort,
        permission: manager.permission,
      });
      next = persist({ ...next, managerSaved: true });
    }
    if (!next.workflowSaved) {
      if (!next.workflowRequest) {
        const saved = parseWorkflow(await api(`/projects/${project.id}/workflow`));
        next = persist({
          ...next,
          workflowRequest: {
            key: crypto.randomUUID(),
            expectedRevision: saved.revision,
            workflow: { ...next.workflow, revision: saved.revision },
          },
        });
      }
      await api(`/projects/${project.id}/workflow`, next.workflowRequest);
      next = persist({ ...next, workflowSaved: true });
    }
    // Default priority (null) is the new project's saved state, so nothing is sent for it.
    if (next.quark.priority !== null && !next.prioritySaved) {
      if (!next.priorityRequest) {
        let saved;
        try {
          saved = parseProjectQuark(await api(`/projects/${project.id}/quark`));
        } catch (reason) {
          throw rejected(reason, 'Priority', () => {});
        }
        next = persist({
          ...next,
          priorityRequest: {
            key: crypto.randomUUID(),
            expectedRevision: saved.revision,
            priority: next.quark.priority,
          },
        });
      }
      try {
        await api(`/projects/${project.id}/quark`, next.priorityRequest);
      } catch (reason) {
        throw rejected(reason, 'Priority', () => {
          next = persist({ ...next, priorityRequest: undefined });
        });
      }
      next = persist({ ...next, prioritySaved: true });
    }
    for (const cap of chosenCaps(next.quark)) {
      if (next.capsSaved?.[cap.provider]) continue;
      if (cap.limitPercent === null)
        throw new Error('Enter a usage limit from 0.1 to 100, or turn that cap off.');
      const request = next.capRequests?.[cap.provider] ?? {
        key: crypto.randomUUID(),
        expectedRevision: 0,
        projectId: project.id,
        taskId: null,
        provider: cap.provider,
        windowId: cap.windowId,
        limitPercent: cap.limitPercent,
      };
      next = persist({ ...next, capRequests: { ...next.capRequests, [cap.provider]: request } });
      try {
        await api('/quark/budgets', request);
      } catch (reason) {
        throw rejected(reason, `${providerNames[cap.provider]} usage cap`, () => {
          const { [cap.provider]: _dropped, ...rest } = next.capRequests ?? {};
          next = persist({ ...next, capRequests: rest });
        });
      }
      next = persist({ ...next, capsSaved: { ...next.capsSaved, [cap.provider]: true } });
    }
    localStorage.removeItem(spawnKey());
    onCreated(project.managerId, true);
  };
  /** A definite refusal clears that request so its choice can be changed or turned off. */
  const rejected = (reason: unknown, label: string, clear: () => void) => {
    if (!(reason instanceof ApiError) || reason.status < 400 || reason.status >= 500) return reason;
    clear();
    return new Error(
      `${label} was not saved: ${reason.message} The project exists; change or turn off this choice, then finish setup.`,
    );
  };
  const run = async (step: (current: Spawn) => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await step(spawn);
    } catch (reason) {
      setError(
        reason instanceof TypeError
          ? 'The connection was interrupted. Your choices are saved; retrying continues the same project.'
          : reason instanceof Error
            ? reason.message
            : 'Could not finish setting up. Your choices are saved; try again.',
      );
    } finally {
      running.current = false;
      setBusy(false);
      void coordinator.load();
    }
  };
  const adopt = (current: Spawn, value: Project) =>
    persist({
      ...current,
      tracking: undefined,
      trackingPending: false,
      project: {
        id: value.id,
        managerId: value.managerId,
        // A connected folder that already had a project keeps its manager and settings.
        existing: Date.parse(value.createdAt) < Date.parse(current.startedAt) - 1000,
      },
    });
  const create = () =>
    run(async (current) => {
      let next = current;
      if (!next.project) {
        const name = next.name.trim();
        if (!name) throw new Error('Give your project a name to get started.');
        // Fix the exact request first so a retry repeats it under the same receipt key.
        next = persist({ ...next, provider: next.provider ?? provider });
        const value = projectSchema.parse(
          await api('/projects', {
            key: next.createKey,
            name,
            description: '',
            provider: next.provider,
          }),
        );
        next = adopt(next, value);
      }
      await finish(next);
    });
  const connect = () =>
    run(async (current) => {
      let next = persist({ ...current, provider: current.provider ?? provider });
      if (!next.project) {
        const value = projectConnectionSchema.parse(
          await api('/projects/connect-folder', { key: next.folderKey, provider: next.provider }),
        );
        if (value.tracking) {
          persist({ ...next, tracking: value.tracking, trackingPending: false });
          return;
        }
        if (!value.project) throw new Error('No folder was connected. Choose a folder again.');
        next = adopt(next, value.project);
      }
      await finish(next);
    });
  const track = () =>
    run(async (current) => {
      if (!current.tracking) return;
      const next = persist({ ...current, trackingPending: true });
      try {
        const value = projectConnectionSchema.parse(
          await api('/projects/track-folder', { key: next.tracking!.key, confirmedTracking: true }),
        );
        if (!value.project)
          throw new Error('The starting version is not ready. Check this same request again.');
        await finish(adopt(next, value.project));
      } catch (reason) {
        if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500)
          persist({ ...next, trackingPending: false });
        throw reason;
      }
    });
  const workerDisabled = busy || !!spawn.workflowRequest;
  const quarkPending =
    (!!spawn.priorityRequest && !spawn.prioritySaved) ||
    Object.keys(spawn.capRequests ?? {}).some(
      (provider) => !spawn.capsSaved?.[provider as ProviderId],
    );
  const capsInvalid = chosenCaps(spawn.quark).some((cap) => cap.limitPercent === null);
  return (
    <section className="flow-page project-config">
      {heading}
      <form
        className="config-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (spawn.folder === 'fresh' || spawn.project) void create();
        }}
      >
        <fieldset className="config-section" disabled={busy || locked}>
          <legend>Project</legend>
          <div className="config-folder" role="radiogroup" aria-label="Project files">
            {(
              [
                ['fresh', 'Start fresh', 'A new, empty project folder on this computer.'],
                ['connect', 'Connect a folder', 'Existing files stay where they are.'],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={value} className={spawn.folder === value ? 'selected' : ''}>
                <input
                  type="radio"
                  name="project-folder"
                  value={value}
                  checked={spawn.folder === value}
                  onChange={() => edit({ folder: value })}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </span>
              </label>
            ))}
          </div>
          {spawn.folder === 'fresh' && !spawn.tracking && (
            <label className="config-name">
              Project name
              <input
                ref={nameInput}
                required
                maxLength={100}
                value={spawn.name}
                onChange={(event) => edit({ name: event.target.value }, true)}
              />
            </label>
          )}
          {spawn.folder === 'connect' && !spawn.tracking && (
            <p className="config-help">
              {canChooseFolder
                ? 'The project takes the folder’s name. An already connected folder keeps its existing manager and settings.'
                : 'Choosing a folder opens a picker on the computer running sciencewithagents, so it is available only there. Start fresh works from any device.'}
            </p>
          )}
        </fieldset>
        {spawn.tracking && (
          <div className="config-tracking" role="region" aria-label="Start tracking this folder">
            <h3>{spawn.tracking.name}</h3>
            <p>This folder needs a local starting version before your team can work with it.</p>
            <p className="config-help">
              Your files stay in place. Common environment and dependency files are excluded
              alongside your own ignore rules. Nothing is uploaded.
            </p>
            {spawn.trackingPending && (
              <p role="status">
                Your request is saved. Check it again to finish this same folder; no second project
                will be created.
              </p>
            )}
            <button
              type="button"
              className="flow-button primary"
              disabled={busy}
              onClick={() => void track()}
            >
              {busy
                ? 'Saving the starting version…'
                : spawn.trackingPending
                  ? 'Check tracking request'
                  : 'Start tracking this folder'}
            </button>
            {!spawn.trackingPending && (
              <button
                type="button"
                className="flow-button"
                disabled={busy}
                onClick={() =>
                  persist({ ...spawn, tracking: undefined, folderKey: crypto.randomUUID() })
                }
              >
                Choose another folder
              </button>
            )}
          </div>
        )}
        <fieldset className="config-section" disabled={busy || locked}>
          <legend>Manager</legend>
          <p className="config-help">
            Chosen separately from the workers. It uses this computer’s existing{' '}
            {providerNames[provider]} sign-in.
          </p>
          <div className="config-grid">
            <label>
              Provider
              <select
                value={provider}
                onChange={(event) =>
                  edit(
                    {
                      provider: event.target.value as ProviderId,
                      managerModel: null,
                      managerEffort: null,
                    },
                    true,
                  )
                }
              >
                {(['codex', 'claude'] as const)
                  .filter((p) => enabled.includes(p) || p === provider)
                  .map((p) => (
                    <option key={p} value={p}>
                      {providerNames[p]}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Model
              <select
                value={spawn.managerModel ?? ''}
                onChange={(event) => {
                  const next = catalog.models.find((m) => m.id === event.target.value);
                  edit({
                    managerModel: next?.id ?? null,
                    managerEffort: next
                      ? next.efforts.includes(providerDefaultEffort)
                        ? providerDefaultEffort
                        : next.efforts.includes('high')
                          ? 'high'
                          : (next.efforts[0] ?? null)
                      : null,
                  });
                }}
              >
                <option value="">
                  Central default{centralModel ? ` · ${centralModel.label}` : ''}
                </option>
                {catalog.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reasoning
              <select
                value={spawn.managerEffort ?? ''}
                disabled={!managerModel}
                onChange={(event) => edit({ managerEffort: event.target.value || null })}
              >
                {!managerModel && <option value="">Follows the central default</option>}
                {managerModel?.efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effortLabel(effort)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {catalog.error && (
            <p className="config-warning" role="alert">
              {catalog.error}{' '}
              <button type="button" className="config-link-button" onClick={reload}>
                Read models again
              </button>
            </p>
          )}
        </fieldset>
        <WorkerSettings
          workflow={spawn.workflow}
          catalogs={catalogs}
          disabled={workerDisabled}
          onChange={(workflow) => edit({ workflow })}
        />
        <QuarkControls
          coordinator={coordinator}
          projectId={spawn.project && !spawn.project.existing ? spawn.project.id : null}
          plan={spawn.quark}
          onChange={(quark) => edit({ quark })}
          disabled={busy || quarkPending}
          note={
            spawn.folder === 'connect'
              ? 'An already connected folder keeps its existing priority and caps.'
              : undefined
          }
        />
        <div className="config-actions">
          {error && (
            <p className="config-error" role="alert">
              {error}
            </p>
          )}
          {spawn.project && !error && (
            <p role="status">
              The project exists. Finishing its settings will not create another one.
            </p>
          )}
          {(spawn.folder === 'fresh' || spawn.project) && !spawn.tracking ? (
            <button
              type="submit"
              className="flow-button primary config-spawn"
              disabled={busy || capsInvalid || (!spawn.project && !spawn.name.trim())}
            >
              <Sparkles size={17} />
              {busy ? 'Setting up…' : spawn.project ? 'Finish setup' : 'Spawn'}
            </button>
          ) : (
            !spawn.tracking && (
              <button
                type="button"
                className="flow-button primary config-spawn"
                disabled={busy || !canChooseFolder}
                onClick={() => void connect()}
              >
                <FolderOpen size={17} />
                {busy ? 'Waiting for the folder picker…' : 'Use an existing project folder'}
              </button>
            )
          )}
          <p className="config-help">
            Spawn creates the project and its manager, saves these settings, then opens a page to
            describe the work. No model work starts until you choose Send.
          </p>
          {(spawn.project || spawn.tracking) && !busy && (
            <button
              type="button"
              className="config-link-button"
              onClick={() => {
                if (
                  window.confirm(
                    'Start a different setup? Anything already created stays in your projects.',
                  )
                ) {
                  localStorage.removeItem(spawnKey());
                  setSpawn(freshSpawn());
                  setError('');
                }
              }}
            >
              Start a different setup
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
