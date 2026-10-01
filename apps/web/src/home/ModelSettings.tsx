import { BackLink } from './Navigation';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, RefreshCw } from 'lucide-react';
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
  type ModelPolicy,
  type ModelPolicyStatus,
  type ProviderId,
} from '@dock/shared';
import { api } from '../api';
import './ModelSettings.css';

const tiersHighToLow = modelTierSchema.options.slice().reverse();
const descriptions = {
  uncle:
    'They sound confident, but also believe whatever they read. Be careful trusting them. Use for cheap, bulk work',
  undergrad: 'Routine checks and recurring monitoring. Can ask a grad student for help.',
  grad: 'Research, implementation, review, calculations and difficult questions.',
  postdoc: 'Project managers and your overarching personal agent.',
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
        setNotice('Model settings saved. New assignments will use these choices.');
      }
    } catch (e) {
      if (active.current)
        setError(e instanceof Error ? e.message : 'Could not save. Your choices are still here.');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const dirty = draft && saved && JSON.stringify(draft) !== JSON.stringify(saved.policy);
  return (
    <section className="model-settings">
      <BackLink />
      <header className="model-heading">
        <p className="home-eyebrow">WORKSPACE SETTINGS</p>
        <h1 tabIndex={-1}>Models and roles</h1>
        <p>Choose default models for managers, workers and routine computer checks.</p>
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
      {!draft ? (
        <button disabled={busy} onClick={() => void load()}>
          {busy ? 'Loading model settings…' : 'Retry loading settings'}
        </button>
      ) : (
        <>
          <fieldset className="model-enabled" disabled={busy}>
            <legend>Providers in your defaults</legend>
            <p>
              Choose the subscriptions you use. With one provider, it handles both managers and
              workers. Explicit conversation choices still keep their original provider.
            </p>
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
                  {providerNames[provider]}
                </label>
              ))}
            </div>
            <p>
              Save provider changes before refreshing models.{' '}
              <a href="#/welcome">Check accounts and setup</a>
            </p>
          </fieldset>
          <fieldset className="model-presets" disabled={busy}>
            <legend>01 / Who takes the lead?</legend>
            {(
              [
                [
                  'codex-heavy',
                  'Codex heavy',
                  'Codex defaults for managers and research/coding. Projects choose their worker mix separately.',
                ],
                [
                  'claude-heavy',
                  'Claude heavy',
                  'Claude defaults for managers and research/coding. Projects choose their worker mix separately.',
                ],
                [
                  'pick',
                  'Pick as I go',
                  'Choose when creating a manager. Managers choose and explain each worker’s provider.',
                ],
              ] as const
            ).map(([value, label, description]) => (
              <label className={draft.preset === value ? 'selected' : ''} key={value}>
                <input
                  type="radio"
                  name="model-preset"
                  value={value}
                  checked={draft.preset === value}
                  onChange={() => setDraft({ ...draft, preset: value })}
                />
                <span>
                  <strong>{label}</strong>
                  <small>
                    {value !== 'pick' && draft.enabledProviders.length === 1
                      ? `${providerNames[draft.enabledProviders[0]!]} managers and workers while it is your only provider.`
                      : description}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          {draft.enabledProviders.length === 1 && (
            <p className="model-feedback">
              {providerNames[draft.enabledProviders[0]!]} is your only default provider. Either
              heavy preset keeps all automatic work there; Pick as I go still asks for a choice.
            </p>
          )}
          <section className="model-team">
            <div className="model-section-heading">
              <div>
                <p className="home-eyebrow">02 / YOUR TEAM</p>
                <h2>Model levels</h2>
              </div>
              <button onClick={() => void refresh()} disabled={busy}>
                <RefreshCw size={15} /> {busy ? 'Working…' : 'Refresh available models'}
              </button>
            </div>
            <p className="model-explainer">
              “Latest” follows the newest available model in each family when a new assignment
              starts. An exact model keeps that version. These levels express your work preferences,
              not an accuracy guarantee.
            </p>
            {saved?.catalogs
              .filter((c) => saved.policy.enabledProviders.includes(c.provider))
              .map((c) =>
                c.error ? (
                  <p role="status" className="model-feedback error" key={c.provider}>
                    {c.error}
                  </p>
                ) : (
                  <p className="model-catalog-note" key={c.provider}>
                    {providerNames[c.provider]}:{' '}
                    {c.observedAt
                      ? `${c.models.length} models · checked ${new Date(c.observedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                      : 'Refresh to see models available on this computer.'}
                  </p>
                ),
              )}
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
                          {catalog?.observedAt && !catalog.error && !selection.model && !latest && (
                            <p className="model-unavailable">
                              Family unavailable. Choose another provider or update the mapping. We
                              won’t substitute silently.
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
                                value={selection.effort ?? ''}
                                onChange={(e) =>
                                  update({
                                    effort: (e.target.value as typeof selection.effort) || null,
                                  })
                                }
                              >
                                <option value="">Automatic for this level</option>
                                {[
                                  ...new Set([
                                    ...(selected?.efforts ?? []),
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
            <p className="home-eyebrow">03 / TASK DEFAULTS</p>
            <h2>Task defaults</h2>
            <p>
              These provider choices take precedence over the preset. Managers always use the
              postdoc level. Serious work starts at grad student.
            </p>
            <div className="model-route-list">
              {taskClassSchema.options.map((task) => {
                const provider = policyProvider(draft, task);
                return (
                  <label key={task}>
                    <span>
                      <strong>{taskLabels[task]}</strong>
                      <small>
                        {tierLabels[taskTiers[task]]} ·{' '}
                        {provider ? providerNames[provider] : 'Choose at dispatch'}
                      </small>
                    </span>
                    <select
                      aria-label={`${taskLabels[task]} provider`}
                      disabled={busy}
                      value={draft.providers[task]}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          providers: {
                            ...draft.providers,
                            [task]: e.target.value as 'preset' | ProviderId,
                          },
                        })
                      }
                    >
                      <option value="preset">Follow preset</option>
                      {draft.enabledProviders.map((provider) => (
                        <option key={provider} value={provider}>
                          {providerNames[provider]}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
            <label className="model-scheduled">
              <span>
                <strong>Unattended checks in “pick as I go”</strong>
                <small>Used when the routine provider follows the preset.</small>
              </span>
              <select
                aria-label="Unattended checks provider"
                value={draft.scheduledProvider}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, scheduledProvider: e.target.value as ProviderId })
                }
              >
                {draft.enabledProviders.map((provider) => (
                  <option key={provider} value={provider}>
                    {providerNames[provider]}
                  </option>
                ))}
              </select>
            </label>
            <label className="model-escalation">
              <input
                type="checkbox"
                disabled={busy}
                checked={draft.escalation}
                onChange={(e) => setDraft({ ...draft, escalation: e.target.checked })}
              />
              <span>
                <strong>Let undergrads ask a grad student</strong>
                <small>
                  One consultation on the same provider, through QUARK. Computer checks keep their
                  daily limit. No repeated escalation.
                </small>
              </span>
            </label>
          </section>
          <aside className="model-scope">
            <ArrowUpRight size={20} />
            <p>
              New app assignments use this policy. Policy-managed chats follow updates between
              turns, on the same provider. Existing pinned or imported conversations retain their
              model; use their advanced model control to follow the central default. Native editor
              conversations retain their own settings. <a href="#/resources">Computer health</a>{' '}
              uses the routine-check default.
            </p>
          </aside>
          <div className="model-save">
            <span>{dirty ? 'You have unsaved changes' : 'Your shared model policy'}</span>
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
