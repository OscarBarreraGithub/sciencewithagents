import { useEffect, useRef, useState } from 'react';
import {
  documentFormatStatusSchema,
  documentAutomaticFormatSchema,
  effortLabel,
  latestFamily,
  modelPolicyStatusSchema,
  modelSchema,
  policyDefaultEffort,
  type DocumentFormatStatus,
  type DocumentAutomaticFormat,
  type Model,
  type ProviderId,
} from '@dock/shared';
import { api, ApiError } from './api';

export function DocumentFormatControls({
  id,
  selected,
  select,
  overflowSource = null,
}: {
  id: string;
  selected: string | null;
  select: (id: string | null) => void;
  overflowSource?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<DocumentFormatStatus | null>(null);
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [automatic, setAutomatic] = useState<DocumentAutomaticFormat | null>(null);
  const [savingAutomatic, setSavingAutomatic] = useState(false);
  const [automaticIntent, setAutomaticIntent] = useState<boolean | null>(null);
  const automaticAttempts = useRef(new Set<string>());
  const saveAttempt = useRef<{ input: string; key: string } | null>(null);
  const generation = useRef(0);
  const statusGeneration = useRef(0);
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [id]);
  useEffect(() => {
    const abort = new AbortController();
    const version = statusGeneration.current;
    void api(`/documents/${id}/format`, undefined, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted && statusGeneration.current === version)
          setStatus(value === null ? null : documentFormatStatusSchema.parse(value));
      })
      .catch((error) => {
        if (!abort.signal.aborted && statusGeneration.current === version) setError(error.message);
      });
    return () => abort.abort();
  }, [id]);
  useEffect(() => {
    const abort = new AbortController();
    void api(`/documents/${id}/format/automatic`, undefined, abort.signal)
      .then(documentAutomaticFormatSchema.parse)
      .then((value) => {
        if (!abort.signal.aborted) setAutomatic(value);
      })
      .catch((error) => {
        // Older hosts retain their explicit formatter without an automatic option.
        if (!abort.signal.aborted && !(error instanceof ApiError && error.status === 404))
          setError(error.message);
      });
    return () => abort.abort();
  }, [id]);
  useEffect(() => {
    if (!automatic?.enabled || !overflowSource || selected || savingAutomatic) return;
    const observation = `${automatic.revision}:${overflowSource}`;
    if (automaticAttempts.current.has(observation)) return;
    automaticAttempts.current.add(observation);
    const scope = generation.current;
    const version = ++statusGeneration.current;
    // Do not abort an authorized request when a subsequent geometry sample arrives.
    // A lost acknowledgement can be read safely after reopening via the host receipt.
    void api(`/documents/${id}/format/automatic/request`, { sourceHash: overflowSource })
      .then((value) => {
        const next = value === null ? null : documentFormatStatusSchema.parse(value);
        if (generation.current === scope && statusGeneration.current === version && next) {
          setStatus(next);
          setError('');
        }
      })
      .catch((error) => {
        if (generation.current === scope && statusGeneration.current === version)
          setError(error.message);
      });
  }, [id, automatic, overflowSource, selected, savingAutomatic]);
  useEffect(() => {
    if (!status || !['queued', 'running'].includes(status.state)) return;
    const abort = new AbortController();
    const version = statusGeneration.current;
    const timer = setTimeout(() => {
      void api(`/documents/${id}/format`, undefined, abort.signal)
        .then((value) => {
          const next = documentFormatStatusSchema.parse(value);
          if (!abort.signal.aborted && statusGeneration.current === version) {
            setStatus(next);
            setError('');
          }
        })
        .catch((error) => {
          if (!abort.signal.aborted && statusGeneration.current === version) {
            setError(error.message);
            setStatus({ ...status });
          }
        });
    }, 3000);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [id, status]);
  useEffect(() => {
    if (!expanded) return;
    const abort = new AbortController();
    setModels([]);
    setLoaded(false);
    void (async () => {
      const config = modelPolicyStatusSchema.parse(
        await api('/model-policy', undefined, abort.signal),
      );
      const choice = config.policy.documentFormatter;
      if (!provider) {
        if (!abort.signal.aborted) setProvider(automatic?.provider ?? choice.provider);
        return;
      }
      const found = modelSchema
        .array()
        .parse(await api(`/models?provider=${provider}`, undefined, abort.signal));
      if (abort.signal.aborted) return;
      const preferred =
        automatic?.enabled && provider === automatic.provider
          ? { ...automatic, family: '' }
          : provider === choice.provider
            ? choice
            : config.policy.models[provider].undergrad;
      const chosen =
        found.find((m) => m.id === preferred.model) ?? latestFamily(found, preferred.family);
      setModels(found);
      setModel(chosen?.id ?? '');
      setEffort(
        chosen ? (preferred.effort ?? policyDefaultEffort(chosen.efforts, 'undergrad') ?? '') : '',
      );
      setLoaded(true);
      setError('');
    })().catch((error) => {
      if (!abort.signal.aborted) setError(error.message);
    });
    return () => abort.abort();
  }, [expanded, provider]);
  async function start() {
    if (!provider) return;
    const scope = generation.current;
    const version = ++statusGeneration.current;
    setSending(true);
    setError('');
    try {
      const next = documentFormatStatusSchema.parse(
        await api(`/documents/${id}/format`, { key: key.current, provider, model, effort }),
      );
      if (generation.current === scope && statusGeneration.current === version) {
        setStatus(next);
        key.current = crypto.randomUUID();
      }
    } catch (error) {
      if (generation.current === scope && statusGeneration.current === version)
        setError((error as Error).message);
    } finally {
      if (generation.current === scope) setSending(false);
    }
  }
  async function saveAutomatic(enabled: boolean) {
    if (!automatic) return;
    const input = {
      expectedRevision: automatic.revision,
      enabled,
      provider: enabled ? provider : automatic.provider,
      model: enabled ? model : automatic.model,
      effort: enabled ? effort : automatic.effort,
    };
    const serialized = JSON.stringify(input);
    if (saveAttempt.current?.input !== serialized)
      saveAttempt.current = { input: serialized, key: crypto.randomUUID() };
    setSavingAutomatic(true);
    setAutomaticIntent(enabled);
    setError('');
    try {
      setAutomatic(
        documentAutomaticFormatSchema.parse(
          await api(`/documents/${id}/format/automatic`, {
            ...input,
            key: saveAttempt.current.key,
          }),
        ),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSavingAutomatic(false);
      setAutomaticIntent(null);
    }
  }
  const automaticModelChanged =
    automatic?.enabled &&
    (provider !== automatic.provider || model !== automatic.model || effort !== automatic.effort);
  const busy = sending || (!!status && ['running', 'queued'].includes(status.state));
  return (
    <details
      className="document-format"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        Format for phone{' '}
        {status?.state === 'running'
          ? '· Formatting…'
          : status?.state === 'queued'
            ? '· Queued'
            : status?.state === 'ready'
              ? '· Copy ready'
              : status && ['failed', 'interrupted', 'stale'].includes(status.state)
                ? '· Check copy'
                : ''}
      </summary>
      {expanded && (
        <div className="document-format-content">
          <p>
            An agent adjusts equation layouts in a separate reading copy. Your original source and
            PDF stay saved. This uses your AI allowance.
          </p>
          <div className="document-format-fields">
            <label>
              Provider
              <select
                aria-label="Provider"
                value={provider ?? 'claude'}
                disabled={busy}
                onChange={(event) => {
                  setProvider(event.target.value as ProviderId);
                  key.current = crypto.randomUUID();
                }}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label>
              Model
              <select
                aria-label="Model"
                value={model}
                disabled={busy || !loaded}
                onChange={(event) => {
                  setModel(event.target.value);
                  const m = models.find((m) => m.id === event.target.value)!;
                  setEffort(m.efforts.includes('medium') ? 'medium' : (m.efforts[0] ?? ''));
                  key.current = crypto.randomUUID();
                }}
              >
                {!loaded && <option value="">Loading models…</option>}
                {loaded && !model && <option value="">Choose a model</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Thinking
              <select
                aria-label="Thinking"
                value={effort}
                disabled={busy || !model}
                onChange={(event) => {
                  setEffort(event.target.value);
                  key.current = crypto.randomUUID();
                }}
              >
                {models
                  .find((m) => m.id === model)
                  ?.efforts.map((e) => (
                    <option key={e} value={e}>
                      {effortLabel(e)}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {automatic && (
            <div className="document-format-automatic">
              <label>
                <input
                  type="checkbox"
                  checked={automaticIntent ?? automatic.enabled}
                  disabled={
                    savingAutomatic || (!automatic.enabled && (!loaded || !model || !effort))
                  }
                  onChange={(event) => void saveAutomatic(event.target.checked)}
                />
                Automatically request a copy when equations stay wide
              </label>
              <p>
                Uses your AI allowance. The original stays selected. Failed passes need an explicit
                retry.
              </p>
              {automatic.enabled && (
                <p>
                  Automatic model:{' '}
                  {models.find((model) => model.id === automatic.model)?.label ?? automatic.model}
                </p>
              )}
              {automaticModelChanged && (
                <button
                  disabled={savingAutomatic || busy || !loaded || !model || !effort}
                  onClick={() => void saveAutomatic(true)}
                >
                  Save automatic model
                </button>
              )}
            </div>
          )}
          {status && <p role="status">{status.message}</p>}
          {error && <p role="alert">{error}</p>}
          <div className="document-format-actions">
            <button disabled={busy || !loaded || !model || !effort} onClick={() => void start()}>
              {busy ? 'Formatting requested…' : 'Create reading copy'}
            </button>
            {status?.state === 'ready' && (
              <button
                aria-pressed={selected === status.id}
                onClick={() => select(selected === status.id ? null : status.id)}
              >
                {selected === status.id ? 'Read original' : 'Read formatted copy'}
              </button>
            )}
          </div>
        </div>
      )}
    </details>
  );
}
