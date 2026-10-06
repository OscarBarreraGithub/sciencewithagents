import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, FolderOpen, RefreshCw, Sparkles } from 'lucide-react';
import {
  effortLabel,
  id as uuidSchema,
  latestFamily,
  newProjectWorkflow,
  projectManagerDefault,
  managerModelChoice,
  modelPolicyStatusSchema,
  policyProvider,
  projectConnectionSchema,
  projectFolderSelectionSchema,
  projectOptionsSchema,
  projectSchema,
  projectTrackingSchema,
  policyDefaultEffort,
  workerDefaultEffort,
  withProjectDecisionPolicy,
  taskTiers,
  type Agent,
  type Model,
  type ModelPolicy,
  type Project,
  type ProviderId,
} from '@dock/shared';
import { api, apiScope, ApiError, connectionLost, detail, models } from '../api';
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
import { FolderBrowser } from '../FolderBrowser';
import { SpawnBrief, type ProjectBriefSeed } from './SpawnBrief';

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
  const [policyError, setPolicyError] = useState('');
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
      .then((value) => {
        setPolicy(modelPolicyStatusSchema.parse(value).policy);
        setPolicyError('');
      })
      .catch(() => {
        setPolicyError('Could not read your model defaults. Try reading them again.');
      });
  };
  useEffect(load, []);
  return { catalogs, policy, policyError, reload: load };
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
export function WorkerSettings({
  workflow,
  catalogs,
  disabled,
  onChange,
  modelsOnly = false,
}: {
  workflow: ProjectWorkflow;
  catalogs: Catalogs;
  disabled: boolean;
  onChange: (next: ProjectWorkflow) => void;
  modelsOnly?: boolean;
}) {
  const custom = workerPurposes.some((purpose) => workflow.overrides[purpose]);
  const mixIndex = providerMixes.indexOf(workflow.providerMix);
  const spendIndex = spendingLevels.indexOf(workflow.spending);
  const setOverride = (purpose: WorkerPurpose, value: WorkerChoice | null) => {
    const overrides = { ...workflow.overrides };
    if (value) overrides[purpose] = value;
    else delete overrides[purpose];
    onChange({ ...workflow, overrides });
  };
  return (
    <fieldset className="config-section" disabled={disabled}>
      <legend>Workers</legend>
      <details className="config-defaults">
        <summary>
          See worker defaults <span aria-hidden="true">⌄</span>
        </summary>
        <p>
          Each cell lists Research &amp; coding · Review · Bulk tasks. The mix slider tells your
          manager which provider you would like it to lean on; it is not a metered percentage. This
          is the recommended family matrix; your mappings and overrides are reflected in Task
          models.
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
      <section className={`config-models ${custom ? 'is-custom' : ''}`}>
        <h3>{custom ? 'Custom task models' : 'Task models'}</h3>
        {workerPurposes.map((purpose) => {
          const preset = workerDefault({ ...workflow, overrides: {} }, purpose);
          const saved = workflow.overrides[purpose];
          const current = saved ?? preset;
          const model = resolved(current, catalogs);
          const presetModel = resolved(preset, catalogs);
          const catalog = catalogs[current.provider];
          const value = saved ? `${saved.provider}:${saved.model ?? ''}` : '';
          return (
            <details className="config-task-choice" key={purpose} open={!!saved || undefined}>
              <summary>
                <span className="config-task-summary">
                  <strong>{purposeLabels[purpose]}</strong>
                  <small>{model?.label ?? family(current.family)}</small>
                </span>
                <span className="config-task-change">
                  Change <ChevronDown size={18} aria-hidden="true" />
                </span>
              </summary>
              <div className="config-model-row">
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
                      Slider default ·{' '}
                      {presetModel?.label ?? `${family(preset.family)} (not found)`}
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
                      value={
                        saved.effort ??
                        workerDefaultEffort(
                          model.efforts,
                          modelFamilies[familyFor(model, current.provider, current.family)]?.tier ??
                            'grad',
                        ) ??
                        ''
                      }
                      onChange={(event) =>
                        setOverride(purpose, { ...saved, effort: event.target.value || null })
                      }
                    >
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
            </details>
          );
        })}
        <p className="config-help">
          Slider defaults follow the newest available model in each family when work starts. An
          exact choice keeps that model.
        </p>
      </section>

      {!modelsOnly && (
        <>
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
              checked={workflow.reviewPlan}
              onChange={(event) => onChange({ ...workflow, reviewPlan: event.target.checked })}
            />
            <span>
              Plan review: check the plan’s overall direction before work starts
              <small>
                A short, high-level check. Finished work is still reviewed independently.
              </small>
            </span>
          </label>
          <div className="config-decisions">
            <label>
              When a decision is needed
              <select
                value={workflow.reviewLimit}
                onChange={(event) =>
                  onChange(
                    withProjectDecisionPolicy(
                      workflow,
                      event.target.value as ProjectWorkflow['reviewLimit'],
                    ),
                  )
                }
              >
                <option value="manager-decides">Let the manager decide</option>
                <option value="ask-human">Ask me</option>
              </select>
            </label>
            <p className="config-help">
              Applies to unclear details and unresolved issues after two review rounds.
              {workflow.reviewLimit === 'ask-human'
                ? ' Pause that item and ask you.'
                : ' The manager records its decision and tells you.'}{' '}
              Other unblocked work continues. Required approvals still come to you.
            </p>
          </div>
        </>
      )}
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
  const { catalogs, policy, reload } = useCatalogs();
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
        <p className="config-help">Model and reasoning changes apply from the next turn.</p>
        <SessionSettings agent={manager} close={() => {}} act={act} embedded titled={false} />
      </section>
      {draft ? (
        <>
          <p className="config-help">
            These choices belong to this project. General preferences are in{' '}
            <a href="#/models">Model preferences</a>.
          </p>
          <button
            type="button"
            className="flow-button"
            disabled={busy || !policy}
            onClick={() => {
              if (policy)
                setDraft({
                  ...draft,
                  ...newProjectWorkflow(policy),
                  managerDefaults: draft.managerDefaults,
                  revision: draft.revision,
                  applyChanges: draft.applyChanges,
                  reviewLimit: draft.reviewLimit,
                  reviewPlan: draft.reviewPlan,
                  ambiguity: draft.ambiguity,
                });
            }}
          >
            Use my general worker preferences
          </button>
          <WorkerSettings
            workflow={draft}
            catalogs={catalogs}
            disabled={busy}
            onChange={setDraft}
          />
        </>
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
  nameEdited?: boolean;
  folder: 'fresh' | 'connect';
  provider: ProviderId | null;
  managerModel: string | null;
  managerEffort: string | null;
  workflow: ProjectWorkflow;
  workflowChosen: boolean;
  project?: { id: string; managerId: string; existing: boolean };
  tracking?: { key: string; name: string };
  selection?: { key: string; name: string; needsTracking: boolean };
  connectionPending?: boolean;
  connectionName?: string;
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
  setupReady?: boolean;
};
const spawnKey = (seedId?: string) =>
  `dock:${apiScope()}:project-spawn${seedId ? `:idea:${seedId}` : ''}`;
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
    workflowChosen: false,
    quark: blankQuarkPlan(),
  };
}
function readSpawn(seed?: ProjectBriefSeed): Spawn {
  try {
    const raw = JSON.parse(
      localStorage.getItem(spawnKey(seed?.id)) ?? 'null',
    ) as Partial<Spawn> | null;
    if (
      raw &&
      uuidSchema.safeParse(raw.createKey).success &&
      uuidSchema.safeParse(raw.folderKey).success &&
      typeof raw.name === 'string'
    )
      return {
        ...freshSpawn(),
        ...raw,
        name:
          raw.folder === 'connect' && raw.name === suggestedName && !raw.nameEdited && raw.selection
            ? raw.selection.name.slice(0, 100)
            : raw.name,
        workflow: parseWorkflow(raw.workflow ?? {}),
        // Older saved drafts already contain the user's choices. Keep them on upgrade.
        workflowChosen: raw.workflowChosen ?? !!raw.workflow,
        quark: readQuarkPlan(raw.quark),
        tracking: raw.tracking ? projectTrackingSchema.parse(raw.tracking) : undefined,
        selection: raw.selection ? projectFolderSelectionSchema.parse(raw.selection) : undefined,
      } as Spawn;
  } catch {
    /* A readable new setup still works when storage holds an older shape. */
  }
  return {
    ...freshSpawn(),
    ...(seed?.suggestedName ? { name: seed.suggestedName.slice(0, 100) } : {}),
  };
}

/** New project page: name, folder, manager, workers; Spawn creates without a model turn. */
export function ProjectConfiguration({
  onCreated,
  heading,
  seed,
}: {
  onCreated: (managerId: string, fresh: boolean) => void;
  heading: ReactNode;
  seed?: ProjectBriefSeed;
}) {
  const { catalogs, policy, policyError, reload } = useCatalogs();
  const coordinator = useCoordinator();
  const setupStorageKey = useRef(spawnKey(seed?.id)).current;
  const [spawn, setSpawn] = useState(() => readSpawn(seed));
  const latestSpawn = useRef(spawn);
  const [busy, setBusy] = useState(false);
  const [briefOpen, updateBriefOpen] = useState(() => {
    try {
      return sessionStorage.getItem(`${setupStorageKey}:brief-open`) === spawn.createKey;
    } catch {
      return false;
    }
  });
  const setBriefOpen = (open: boolean) => {
    updateBriefOpen(open);
    try {
      if (open) sessionStorage.setItem(`${setupStorageKey}:brief-open`, spawn.createKey);
      else sessionStorage.removeItem(`${setupStorageKey}:brief-open`);
    } catch {
      // Local notepad recovery still retains the text.
    }
  };
  const [error, setError] = useState('');
  const [errorAtFolder, setErrorAtFolder] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [folderBrowser, setFolderBrowser] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [canChooseFolder, setCanChooseFolder] = useState<boolean | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const resumedPreparation = useRef(false);
  const locked = !!spawn.project || !!spawn.tracking || !!spawn.connectionPending;
  const enabled = policy?.enabledProviders ?? (['codex', 'claude'] as ProviderId[]);
  const provider =
    spawn.provider ?? (policy && policyProvider(policy, 'manager')) ?? enabled[0] ?? 'codex';
  const catalog = catalogs[provider];
  const centralChoice =
    projectManagerDefault(spawn.workflow, provider) ??
    (policy ? managerModelChoice(policy, provider) : undefined);
  const needsManagerChoice = !!policy && !spawn.provider && !policyProvider(policy, 'manager');
  const centralModel = centralChoice
    ? centralChoice.model
      ? catalog.models.find((m) => m.id === centralChoice.model)
      : latestFamily(catalog.models, centralChoice.family)
    : undefined;
  const managerModel = spawn.managerModel
    ? catalog.models.find((m) => m.id === spawn.managerModel)
    : centralModel;
  const managerEffort =
    spawn.managerEffort ??
    centralChoice?.effort ??
    (managerModel ? policyDefaultEffort(managerModel.efforts, taskTiers.manager) : undefined);
  const persist = (next: Spawn) => {
    latestSpawn.current = next;
    setSpawn(next);
    try {
      localStorage.setItem(setupStorageKey, JSON.stringify(next));
    } catch {
      /* The exact request stays in this view when storage is unavailable. */
    }
    return next;
  };
  const edit = (patch: Partial<Spawn>, identity = false) => {
    setError('');
    // A different project request needs a new receipt; worker edits keep it.
    persist({
      ...latestSpawn.current,
      ...patch,
      ...(identity && !locked ? { createKey: crypto.randomUUID() } : {}),
    });
  };
  const editName = (name: string) => {
    const current = latestSpawn.current;
    if (current.name === name && current.nameEdited) return;
    edit({ name, nameEdited: true }, true);
  };
  useEffect(() => {
    const current = latestSpawn.current;
    if (
      !policy ||
      current.workflowChosen ||
      current.project ||
      current.tracking ||
      current.workflowRequest
    )
      return;
    persist({
      ...current,
      provider: current.provider ?? policyProvider(policy, 'manager') ?? null,
      workflow: newProjectWorkflow(policy),
      workflowChosen: true,
    });
  }, [policy, spawn.workflowChosen, locked]);
  useEffect(() => {
    // After the shell focuses the page heading on navigation, select the proposed name.
    const frame = requestAnimationFrame(() => {
      if (spawn.name === suggestedName) {
        nameInput.current?.focus({ preventScroll: true });
        nameInput.current?.select();
      }
    });
    void api('/project-options')
      .then((value) => {
        const options = projectOptionsSchema.parse(value);
        setCanChooseFolder(options.canChooseFolder);
        setFolderBrowser(!!options.folderBrowser);
      })
      .catch(() => setCanChooseFolder(false));
    return () => cancelAnimationFrame(frame);
  }, []);

  const finish = async (current: Spawn) => {
    let next = current;
    const project = next.project!;
    if (project.existing) {
      persist({ ...next, setupReady: true });
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
    persist({ ...next, setupReady: true });
  };
  /** A definite refusal clears that request so its choice can be changed or turned off. */
  const rejected = (reason: unknown, label: string, clear: () => void) => {
    if (!(reason instanceof ApiError) || reason.status < 400 || reason.status >= 500) return reason;
    clear();
    return new Error(
      `${label} was not saved: ${reason.message} The project exists; change or turn off this choice, then finish setup.`,
    );
  };
  const run = async (step: (current: Spawn) => Promise<void>, folder = false) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setErrorAtFolder(folder);
    setChoosingFolder(folder);
    try {
      await step(latestSpawn.current);
    } catch (reason) {
      setError(
        connectionLost(reason)
          ? folder
            ? 'The connection was interrupted. Choose a folder again to recover the saved selection.'
            : 'The connection was interrupted. Your choices are saved; retrying continues the same project.'
          : reason instanceof Error
            ? reason.message
            : 'Could not finish setting up. Your choices are saved; try again.',
      );
    } finally {
      running.current = false;
      setBusy(false);
      setChoosingFolder(false);
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
        existing: false,
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
  const choose = (folderId?: string) => {
    if (folderBrowser && !folderId) {
      edit({ folder: 'connect' });
      setBrowsing(true);
      return;
    }
    setBrowsing(false);
    return run(async (current) => {
      const next = persist({
        ...current,
        folder: 'connect',
        selection: undefined,
        tracking: undefined,
        trackingPending: false,
        connectionPending: false,
        folderKey:
          folderId || current.selection || current.tracking
            ? crypto.randomUUID()
            : current.folderKey,
      });
      const value = projectConnectionSchema.parse(
        await api('/projects/connect-folder', {
          key: next.folderKey,
          selectOnly: true,
          ...(folderId ? { folderId } : {}),
        }),
      );
      // Defaults may have loaded while the folder selection was pending. Keep those
      // choices as well as the receipt, without creating or freezing a manager.
      persist({
        ...latestSpawn.current,
        selection: value.selection,
        name: latestSpawn.current.nameEdited
          ? latestSpawn.current.name
          : (value.selection?.name.slice(0, 100) ?? latestSpawn.current.name),
      });
    }, true);
  };
  const connect = () =>
    run(async (current) => {
      if (!current.selection) return;
      if (!current.name.trim()) throw new Error('Give your project a name to get started.');
      let next = persist({
        ...current,
        provider: current.provider ?? provider,
        // Retain the exact name on retries, including older pending requests without one.
        connectionName: current.connectionPending ? current.connectionName : current.name.trim(),
        connectionPending: true,
      });
      if (!next.project) {
        const value = projectConnectionSchema.parse(
          await api('/projects/connect-folder', {
            key: next.folderKey,
            provider: next.provider,
            ...(next.connectionName ? { name: next.connectionName } : {}),
            fresh: true,
          }),
        );
        if (value.tracking) {
          await trackSelected(
            persist({ ...next, tracking: value.tracking, trackingPending: false }),
          );
          return;
        }
        if (!value.project) throw new Error('No folder was connected. Choose a folder again.');
        next = adopt(next, value.project);
      }
      await finish(next);
    });
  const trackSelected = async (current: Spawn) => {
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
        persist({ ...latestSpawn.current, trackingPending: false });
      throw reason;
    }
  };
  const submit = () => {
    if (busy || capsInvalid || needsManagerChoice || (!policy && !locked)) return;
    if (spawn.folder === 'connect' && !spawn.project && !spawn.tracking && !canChooseFolder) return;
    resumedPreparation.current = true;
    setBriefOpen(true);
    if (spawn.setupReady) return;
    if (spawn.tracking) void run(trackSelected);
    else if (spawn.folder === 'fresh' || spawn.project) void create();
    else void connect();
  };
  const workerDisabled = busy || !policy || !!spawn.workflowRequest;
  const quarkPending =
    (!!spawn.priorityRequest && !spawn.prioritySaved) ||
    Object.keys(spawn.capRequests ?? {}).some(
      (provider) => !spawn.capsSaved?.[provider as ProviderId],
    );
  const capsInvalid = chosenCaps(spawn.quark).some((cap) => cap.limitPercent === null);
  useEffect(() => {
    if (briefOpen && !spawn.setupReady && !resumedPreparation.current && (policy || locked)) {
      submit();
    }
  }, [briefOpen, policy, locked, canChooseFolder, capsInvalid, needsManagerChoice]);
  return (
    <section className="flow-page project-config">
      {heading}
      <SpawnBrief
        key={spawn.createKey}
        identity={spawn.createKey}
        name={spawn.name}
        initialText={seed?.brief}
        open={briefOpen}
        preparing={busy}
        preparationError={error}
        managerId={spawn.setupReady ? spawn.project?.managerId : undefined}
        retryPreparation={submit}
        minimize={() => setBriefOpen(false)}
        sent={(managerId) => {
          localStorage.removeItem(setupStorageKey);
          setBriefOpen(false);
          onCreated(managerId, false);
        }}
      />
      {browsing && (
        <FolderBrowser close={() => setBrowsing(false)} select={(id) => void choose(id)} />
      )}
      <form
        className="config-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset className="config-section" disabled={locked || (busy && !choosingFolder)}>
          <legend>Project</legend>
          <div className="config-folder" role="radiogroup" aria-label="Project files">
            {(
              [
                ['fresh', 'New folder', 'A new, empty project folder on this computer.'],
                ['connect', 'Existing folder', 'Choose a folder; its files stay where they are.'],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={value} className={spawn.folder === value ? 'selected' : ''}>
                <input
                  type="radio"
                  name="project-folder"
                  value={value}
                  checked={spawn.folder === value}
                  disabled={busy || (value === 'connect' && canChooseFolder === null)}
                  onChange={() => {
                    if (value === 'connect' && canChooseFolder) void choose();
                    else edit({ folder: value });
                  }}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </span>
              </label>
            ))}
          </div>
          {spawn.folder === 'connect' && (
            <div className="config-folder-selection">
              {spawn.selection && <strong>Selected folder: {spawn.selection.name}</strong>}
              <p className="config-help">
                {canChooseFolder
                  ? 'Spawn creates a new manager with these settings. Earlier managers and conversations stay separate; the folder’s files are shared.'
                  : 'Folder browsing is unavailable. Reload this page to try again.'}
              </p>
              {!locked && (
                <button
                  type="button"
                  className="flow-button"
                  disabled={busy || !canChooseFolder}
                  onClick={() => void choose()}
                >
                  <FolderOpen size={17} />
                  {choosingFolder
                    ? 'Selecting folder…'
                    : spawn.selection
                      ? 'Choose another folder'
                      : 'Choose a folder'}
                </button>
              )}
              {error && errorAtFolder && (
                <p className="config-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
          <label className="config-name">
            Project name
            <input
              ref={nameInput}
              required
              maxLength={100}
              value={spawn.name}
              onInput={(event) => editName(event.currentTarget.value)}
              onChange={(event) => editName(event.target.value)}
            />
          </label>
          {spawn.folder === 'connect' && (
            <p className="config-help">The name shown in the app. Your folder keeps its name.</p>
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
            {!spawn.trackingPending && (
              <button
                type="button"
                className="flow-button"
                disabled={busy}
                onClick={() => void choose()}
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
                value={needsManagerChoice ? '' : provider}
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
                {needsManagerChoice && (
                  <option value="" disabled>
                    Choose a manager provider
                  </option>
                )}
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
                value={managerModel?.id ?? ''}
                onChange={(event) => {
                  const next = catalog.models.find((m) => m.id === event.target.value);
                  edit({
                    managerModel: next?.id ?? null,
                    managerEffort: next
                      ? (policyDefaultEffort(next.efforts, taskTiers.manager) ?? null)
                      : null,
                  });
                }}
              >
                {!managerModel && (
                  <option value="">
                    {catalog.loaded ? 'Choose an available model' : 'Reading models…'}
                  </option>
                )}
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
                value={managerEffort ?? ''}
                disabled={!managerModel}
                onChange={(event) =>
                  edit({ managerModel: managerModel!.id, managerEffort: event.target.value })
                }
              >
                {!managerModel && <option value="">Read models first</option>}
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
          onChange={(workflow) => edit({ workflow, workflowChosen: true })}
        />
        <p className="config-help">
          Starting from your <a href="#/models">general model preferences</a>. Changes here apply
          only to this project.{' '}
          <button
            type="button"
            className="config-link-button"
            disabled={workerDisabled}
            onClick={() => {
              if (policy)
                edit({
                  workflow: {
                    ...spawn.workflow,
                    ...newProjectWorkflow(policy),
                    managerDefaults: spawn.workflow.managerDefaults,
                    applyChanges: spawn.workflow.applyChanges,
                    reviewLimit: spawn.workflow.reviewLimit,
                    reviewPlan: spawn.workflow.reviewPlan,
                    ambiguity: spawn.workflow.ambiguity,
                  },
                  workflowChosen: true,
                });
            }}
          >
            Use my current worker preferences
          </button>
        </p>
        <QuarkControls
          coordinator={coordinator}
          projectId={spawn.project && !spawn.project.existing ? spawn.project.id : null}
          plan={spawn.quark}
          onChange={(quark) => edit({ quark })}
          disabled={busy || quarkPending}
          note={
            spawn.folder === 'connect'
              ? 'These settings apply to your new project and manager.'
              : undefined
          }
        />
        <div className="config-actions">
          {!policy && !locked && (
            <p role={policyError ? 'alert' : 'status'}>
              {policyError || 'Reading your model defaults…'}
              {policyError && (
                <button type="button" className="config-link-button" onClick={reload}>
                  Read defaults again
                </button>
              )}
            </p>
          )}
          {error && !errorAtFolder && !briefOpen && (
            <p className="config-error" role="alert">
              {error}
            </p>
          )}
          {spawn.project && !error && (
            <p role="status">
              The project exists. Finishing its settings will not create another one.
            </p>
          )}
          {(spawn.tracking || (spawn.folder === 'connect' && spawn.selection?.needsTracking)) && (
            <p className="config-help">
              Spawn also saves a local starting version of this folder so your team can track
              changes. Your files stay in place; nothing is uploaded.
            </p>
          )}
          <button
            type="submit"
            className="flow-button primary config-spawn"
            disabled={
              busy ||
              needsManagerChoice ||
              (!policy && !locked) ||
              capsInvalid ||
              (!spawn.project && !spawn.name.trim()) ||
              (spawn.folder === 'connect' &&
                !spawn.project &&
                !spawn.tracking &&
                (!spawn.selection || !canChooseFolder))
            }
          >
            <Sparkles size={17} />
            {busy
              ? choosingFolder
                ? 'Choose a folder first'
                : 'Setting up…'
              : spawn.setupReady
                ? 'Continue writing'
                : spawn.project
                  ? 'Finish setup'
                  : spawn.trackingPending || spawn.connectionPending
                    ? 'Retry Spawn'
                    : 'Spawn'}
          </button>
          <p className="config-help">
            Spawn opens your notepad immediately and prepares the project while you write. No model
            work starts until you choose Send.
          </p>
          {(spawn.project || spawn.tracking || spawn.connectionPending) && !busy && (
            <button
              type="button"
              className="config-link-button"
              onClick={() => {
                if (
                  window.confirm(
                    'Start a different setup? Anything already created stays in your projects.',
                  )
                ) {
                  persist(freshSpawn());
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
