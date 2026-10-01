import { useEffect, useRef, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import {
  latestFamily,
  effortLabel,
  modelPolicyStatusSchema,
  modelPolicySchema,
  modelTierSchema,
  taskClassSchema,
  taskLabels,
  taskTiers,
  tierLabels,
  policyProvider,
  newProjectWorkflow,
  managerModelChoice,
  recommendedModelPolicy,
  policyDefaultEffort,
  type ModelPolicy,
  type ModelPolicyStatus,
  type ProviderId,
  type TaskClass,
} from '@dock/shared';
import { api } from '../api';
import { WorkerSettings } from './ProjectConfiguration';
import './ModelSettings.css';

const tiersHighToLow = modelTierSchema.options.slice().reverse();
const descriptions = {
  uncle:
    'They sound confident, but also believe whatever they read. Be careful trusting them. Use for cheap, bulk work',
  undergrad: 'Routine checks and recurring monitoring. Can ask a grad student for help.',
  grad: 'Research, implementation, review, calculations and difficult questions.',
  postdoc: 'Managers and the strongest workers.',
};
const providerNames = { codex: 'Codex', claude: 'Claude' };
export function ModelSettings() {
  const [saved, setSaved] = useState<ModelPolicyStatus | null>(null);
  const [draft, setDraft] = useState<ModelPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const receipt = useRef<{ signature: string; key: string } | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
    };
  }, []);
  async function load() {
    setBusy(true);
    setError('');
    try {
      const value = modelPolicyStatusSchema.parse(await api('/model-policy'));
      if (!active.current) return;
      setSaved(value);
      setDraft(value.policy);
      receipt.current = null;
      setNotice('');
    } catch (e) {
      if (active.current)
        setError(e instanceof Error ? e.message : 'Could not load settings. Try again.');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function refresh() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = modelPolicyStatusSchema.parse(await api('/model-policy/catalogs', {}));
      if (active.current) {
        setSaved(value);
        setNotice('Available models refreshed. Your unsaved choices are still here.');
      }
    } catch (e) {
      if (active.current) setError(e instanceof Error ? e.message : 'Could not refresh models.');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function save() {
    if (!draft || !saved) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const policy = modelPolicySchema.parse(draft);
      const payload = { policy, expectedRevision: draft.revision };
      const signature = JSON.stringify(payload);
      if (receipt.current?.signature !== signature)
        receipt.current = { signature, key: crypto.randomUUID() };
      const value = modelPolicyStatusSchema.parse(
        await api('/model-policy', { ...payload, key: receipt.current.key }),
      );
      if (active.current) {
        setSaved(value);
        setDraft(value.policy);
        receipt.current = null;
        setNotice('Model settings saved. New projects and app assistants will use these choices.');
      }
    } catch (e) {
      if (active.current)
        setError(e instanceof Error ? e.message : 'Could not save. Your choices are still here.');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const dirty = draft && saved && JSON.stringify(draft) !== JSON.stringify(saved.policy);
  const managerProvider = draft ? policyProvider(draft, 'manager') : undefined;
  const managerChoice =
    draft && managerProvider ? managerModelChoice(draft, managerProvider) : null;
  const managerCatalog = saved?.catalogs.find((c) => c.provider === managerProvider)?.models ?? [];
  const managerModel = managerChoice?.model
    ? managerCatalog.find((m) => m.id === managerChoice.model)
    : managerChoice
      ? latestFamily(managerCatalog, managerChoice.family)
      : undefined;
  function assistantChoice(task: TaskClass, label: string = taskLabels[task]) {
    if (!draft) return null;
    const policy = draft;
    const provider = policyProvider(policy, task, undefined, task === 'routine');
    const modelName = (provider: ProviderId) => {
      const choice = policy.models[provider][taskTiers[task]];
      const status = saved?.catalogs.find((c) => c.provider === provider);
      const catalog = status?.models ?? [];
      const model = choice.model
        ? catalog.find((m) => m.id === choice.model)
        : latestFamily(catalog, choice.family);
      return (
        model?.label ??
        (status?.observedAt && !status.error
          ? `${choice.model ?? choice.family} · unavailable`
          : (choice.model ?? `Latest ${choice.family}`))
      );
    };
    return (
      <label key={task}>
        <span>
          <strong>{label}</strong>
        </span>
        <select
          aria-label={`${label} provider`}
          disabled={busy}
          value={provider ?? ''}
          onChange={(event) => {
            const provider = event.target.value as ProviderId;
            setDraft({
              ...draft,
              providers: { ...draft.providers, [task]: provider },
              ...(task === 'routine' ? { scheduledProvider: provider } : {}),
            });
          }}
        >
          {!provider && (
            <option value="" disabled>
              Choose a provider
            </option>
          )}
          {draft.enabledProviders.map((provider) => (
            <option key={provider} value={provider}>
              {providerNames[provider]} · {modelName(provider)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <section className="model-settings">
      <header className="model-heading">
        <div className="model-section-heading">
          <h1 tabIndex={-1}>Model preferences</h1>
          <button onClick={() => void refresh()} disabled={busy}>
            <RefreshCw size={15} /> {busy ? 'Working…' : 'Refresh available models'}
          </button>
        </div>
        <p>Set your starting choices here. Existing projects keep their own settings.</p>
      </header>
      {error && (
        <div className="model-feedback error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="model-feedback" role="status">
          <Check size={18} /> {notice}
        </div>
      )}
      {saved?.catalogs
        .filter((c) => draft?.enabledProviders.includes(c.provider) && c.error)
        .map((c) => (
          <p role="status" className="model-feedback error" key={c.provider}>
            {c.error}
          </p>
        ))}
      {!draft ? (
        <button disabled={busy} onClick={() => void load()}>
          {busy ? 'Loading model settings…' : 'Retry loading settings'}
        </button>
      ) : (
        <>
          <fieldset className="model-enabled config-section" disabled={busy}>
            <legend>Providers in your defaults</legend>
            <p>Choose the subscriptions you use.</p>
            <div>
              {(['codex', 'claude'] as const).map((provider) => (
                <label key={provider}>
                  <input
                    type="checkbox"
                    aria-label={`Use ${providerNames[provider]} in defaults`}
                    checked={draft.enabledProviders.includes(provider)}
                    disabled={
                      busy ||
                      (draft.enabledProviders.length === 1 &&
                        draft.enabledProviders.includes(provider))
                    }
                    onChange={(event) => {
                      const enabledProviders = event.target.checked
                        ? [...draft.enabledProviders, provider]
                        : draft.enabledProviders.filter((p) => p !== provider);
                      const providers = { ...draft.providers };
                      for (const task of taskClassSchema.options)
                        if (
                          providers[task] !== 'preset' &&
                          !enabledProviders.includes(providers[task] as ProviderId)
                        )
                          providers[task] = 'preset';
                      setDraft({
                        ...draft,
                        enabledProviders,
                        providers,
                        scheduledProvider: enabledProviders.includes(draft.scheduledProvider)
                          ? draft.scheduledProvider
                          : enabledProviders[0]!,
                      });
                    }}
                  />
                  <span>{providerNames[provider]}</span>
                </label>
              ))}
            </div>
            <p>
              Save provider changes before refreshing models.{' '}
              <a href="#/welcome">Check accounts and setup</a>
            </p>
          </fieldset>
          <section
            className="model-project-defaults"
            aria-labelledby="model-project-defaults-title"
          >
            <h2 id="model-project-defaults-title">New project defaults</h2>
            <p className="model-explainer">You can change these for each project during setup.</p>
            <div className="config-form">
              <fieldset className="config-section" disabled={busy}>
                <legend>Manager default</legend>
                <div className="config-grid model-manager-grid">
                  <label>
                    Manager provider
                    <select
                      value={policyProvider(draft, 'manager') ?? 'ask'}
                      onChange={(event) => {
                        const value = event.target.value;
                        const providers = { ...draft.providers };
                        // The legacy preset also routes assistants. Choosing a manager at
                        // setup must not change those independent defaults.
                        if (value === 'ask') {
                          for (const task of taskClassSchema.options) {
                            if (task !== 'manager' && providers[task] === 'preset')
                              providers[task] =
                                policyProvider(draft, task, undefined, task === 'routine') ??
                                'preset';
                          }
                        }
                        setDraft({
                          ...draft,
                          ...(value === 'ask' ? { preset: 'pick' as const } : {}),
                          providers: {
                            ...providers,
                            manager: value === 'ask' ? 'preset' : (value as ProviderId),
                          },
                        });
                      }}
                    >
                      {draft.enabledProviders.map((provider) => (
                        <option key={provider} value={provider}>
                          {providerNames[provider]}
                        </option>
                      ))}
                      <option value="ask">Choose at project setup</option>
                    </select>
                  </label>
                  {managerChoice && managerProvider && (
                    <>
                      <label>
                        Manager model
                        <select
                          value={managerChoice.model ?? ''}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              managerModels: {
                                ...draft.managerModels,
                                [managerProvider]: {
                                  ...managerChoice,
                                  model: event.target.value || null,
                                  effort: null,
                                },
                              },
                            })
                          }
                        >
                          <option value="">
                            {latestFamily(managerCatalog, managerChoice.family)?.label ??
                              managerChoice.family}{' '}
                            · latest available
                          </option>
                          {managerChoice.model && !managerModel && (
                            <option value={managerChoice.model}>
                              {managerChoice.model} · unavailable
                            </option>
                          )}
                          {managerCatalog.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Manager reasoning
                        <select
                          disabled={!managerModel}
                          value={
                            managerChoice.effort ??
                            (managerModel
                              ? policyDefaultEffort(managerModel.efforts, 'postdoc')
                              : '')
                          }
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              managerModels: {
                                ...draft.managerModels,
                                [managerProvider]: {
                                  ...managerChoice,
                                  effort: event.target.value || null,
                                },
                              },
                            })
                          }
                        >
                          {!managerModel && <option value="">Refresh available models</option>}
                          {managerModel?.efforts.map((effort) => (
                            <option key={effort} value={effort}>
                              {effortLabel(effort)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                </div>
              </fieldset>
              <WorkerSettings
                workflow={newProjectWorkflow(draft)}
                catalogs={{
                  codex: {
                    models: saved?.catalogs.find((c) => c.provider === 'codex')?.models ?? [],
                    error: saved?.catalogs.find((c) => c.provider === 'codex')?.error ?? '',
                    loaded: !!saved?.catalogs.find((c) => c.provider === 'codex')?.observedAt,
                  },
                  claude: {
                    models: saved?.catalogs.find((c) => c.provider === 'claude')?.models ?? [],
                    error: saved?.catalogs.find((c) => c.provider === 'claude')?.error ?? '',
                    loaded: !!saved?.catalogs.find((c) => c.provider === 'claude')?.observedAt,
                  },
                }}
                disabled={busy}
                modelsOnly
                onChange={(workflow) =>
                  setDraft({
                    ...draft,
                    projectDefaults: {
                      providerMix: workflow.providerMix,
                      spending: workflow.spending,
                      overrides: workflow.overrides,
                    },
                  })
                }
              />
            </div>
          </section>
          <section className="model-routing">
            <h2>App assistants</h2>
            <p className="model-explainer">
              Defaults for computer checks and searching saved chats.
            </p>
            <div className="model-route-list">
              {assistantChoice('routine', 'Computer health checks')}
              {assistantChoice('bulk', 'Assisted search')}
            </div>
            <label className="model-escalation">
              <input
                type="checkbox"
                disabled={busy}
                checked={draft.escalation}
                onChange={(event) => setDraft({ ...draft, escalation: event.target.checked })}
              />
              <span>
                <strong>Let routine helpers ask for help</strong>
                <small>One stronger-model consultation, within QUARK’s limits.</small>
              </span>
            </label>
          </section>
          <details className="model-advanced">
            <summary>Model levels and advanced choices</summary>
            <section className="model-team">
              <h2>Model levels</h2>
              <p className="model-explainer">
                Change the models behind each level, or pin an exact version. Latest follows
                available updates.
              </p>
              <div className="model-tier-grid">
                {tiersHighToLow.map((tier, index) => (
                  <article className="model-tier" key={tier}>
                    <header>
                      <span className="model-tier-number">0{index + 1}</span>
                      <div>
                        <h3>{tierLabels[tier]}</h3>
                        <p>{descriptions[tier]}</p>
                      </div>
                    </header>
                    <div className="model-provider-grid">
                      {(['codex', 'claude'] as const).map((provider) => {
                        const selection = draft.models[provider][tier];
                        const catalog = saved?.catalogs.find((c) => c.provider === provider);
                        const models = catalog?.models ?? [];
                        const update = (patch: Partial<typeof selection>) =>
                          setDraft({
                            ...draft,
                            models: {
                              ...draft.models,
                              [provider]: {
                                ...draft.models[provider],
                                [tier]: { ...selection, ...patch },
                              },
                            },
                          });
                        const latest = latestFamily(models, selection.family);
                        const selected = models.find((m) => m.id === selection.model);
                        const availableEfforts = (selected ?? latest)?.efforts ?? [];
                        const effort =
                          selection.effort ?? policyDefaultEffort(availableEfforts, tier) ?? '';
                        return (
                          <div className="model-provider-choice" key={provider}>
                            <label>
                              {providerNames[provider]} model
                              <select
                                aria-label={`${tierLabels[tier]} ${providerNames[provider]} model`}
                                disabled={busy}
                                value={selection.model ?? ''}
                                onChange={(e) =>
                                  update({ model: e.target.value || null, effort: null })
                                }
                              >
                                <option value="">Latest {selection.family}</option>
                                {selection.model && !selected && (
                                  <option value={selection.model}>
                                    {selection.model} · unavailable
                                  </option>
                                )}
                                {models.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.label} · {m.id}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {catalog?.observedAt &&
                              !catalog.error &&
                              !selection.model &&
                              !latest && (
                                <p className="model-unavailable">
                                  Family unavailable. Choose another provider or update the mapping.
                                  We won’t substitute silently.
                                </p>
                              )}
                            {!selection.model && latest && (
                              <p className="model-catalog-note">Resolves to {latest.label}</p>
                            )}
                            <details>
                              <summary>Family & thinking level</summary>
                              <label>
                                Family name
                                <input
                                  aria-label={`${tierLabels[tier]} ${providerNames[provider]} family`}
                                  value={selection.family}
                                  maxLength={60}
                                  disabled={busy}
                                  onChange={(e) => update({ family: e.target.value })}
                                />
                              </label>
                              <label>
                                Thinking level
                                <select
                                  aria-label={`${tierLabels[tier]} ${providerNames[provider]} thinking level`}
                                  disabled={busy}
                                  value={effort}
                                  onChange={(e) =>
                                    update({
                                      effort: (e.target.value as typeof selection.effort) || null,
                                    })
                                  }
                                >
                                  {!effort && <option value="">Refresh available models</option>}
                                  {[
                                    ...new Set([
                                      ...availableEfforts,
                                      ...(selection.effort ? [selection.effort] : []),
                                    ]),
                                  ].map((e) => (
                                    <option key={e} value={e}>
                                      {effortLabel(e)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={selection.requiresModelAllowance}
                                  disabled={busy}
                                  onChange={(e) =>
                                    update({ requiresModelAllowance: e.target.checked })
                                  }
                                />{' '}
                                Require its own usage meter
                              </label>
                              <p>
                                Change the family here if a provider renames it. Exact models and
                                thinking levels must be offered by the installed provider.
                              </p>
                            </details>
                          </div>
                        );
                      })}
                    </div>
                  </article>
                ))}
              </div>
            </section>
            <section className="model-routing">
              <h2>Other task defaults</h2>
              <p className="model-explainer">Used for work without saved project worker choices.</p>
              <div className="model-route-list">
                {assistantChoice('calculation')}
                {assistantChoice('orchestration')}
              </div>
            </section>
          </details>
          <section className="model-restore">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(recommendedModelPolicy(draft));
                setNotice(
                  'Recommended defaults restored in this form. Save to apply them. Existing projects stay unchanged.',
                );
              }}
            >
              Restore recommended defaults
            </button>
            <p>Reset to my recommendations, then Save to apply.</p>
          </section>
          <div className="model-save">
            <span>{dirty ? 'You have unsaved changes' : 'All changes saved'}</span>
            <div>
              <button disabled={busy} onClick={() => void load()}>
                Reload saved settings
              </button>
              <button
                className="model-primary"
                disabled={busy || !dirty}
                onClick={() => void save()}
              >
                {busy ? 'Working…' : 'Save model settings'}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
