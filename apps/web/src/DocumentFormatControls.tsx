import { useEffect, useRef, useState } from 'react';
import {
  documentFormatStatusSchema,
  effortLabel,
  latestFamily,
  modelPolicyStatusSchema,
  modelSchema,
  policyDefaultEffort,
  type DocumentFormatStatus,
  type Model,
  type ProviderId,
} from '@dock/shared';
import { api } from './api';

export function DocumentFormatControls({
  id,
  selected,
  select,
}: {
  id: string;
  selected: string | null;
  select: (id: string | null) => void;
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
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    const abort = new AbortController();
    void api(`/documents/${id}/format`, undefined, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted)
          setStatus(value === null ? null : documentFormatStatusSchema.parse(value));
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(error.message);
      });
    return () => abort.abort();
  }, [id]);
  useEffect(() => {
    if (!status || !['queued', 'running'].includes(status.state)) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void api(`/documents/${id}/format`, undefined, abort.signal)
        .then((value) => {
          const next = documentFormatStatusSchema.parse(value);
          if (!abort.signal.aborted) {
            setStatus(next);
            setError('');
          }
        })
        .catch((error) => {
          if (!abort.signal.aborted) {
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
        if (!abort.signal.aborted) setProvider(choice.provider);
        return;
      }
      const found = modelSchema
        .array()
        .parse(await api(`/models?provider=${provider}`, undefined, abort.signal));
      if (abort.signal.aborted) return;
      const preferred =
        provider === choice.provider ? choice : config.policy.models[provider].undergrad;
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
    setSending(true);
    setError('');
    try {
      const next = documentFormatStatusSchema.parse(
        await api(`/documents/${id}/format`, { key: key.current, provider, model, effort }),
      );
      setStatus(next);
      key.current = crypto.randomUUID();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSending(false);
    }
  }
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
