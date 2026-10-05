import { useRef, useState } from 'react';
import {
  providerReservePolicy,
  pulsarStatusSchema,
  type ProviderCapacity,
  type PulsarPolicy,
  type QuarkCoordinatorStatus,
} from '@dock/shared';
import { api, ApiError } from '../api';
export function ProviderReserveControl({
  provider,
  policy,
  pacing,
  refresh,
}: {
  provider: ProviderCapacity;
  policy: PulsarPolicy;
  pacing: QuarkCoordinatorStatus['utilization'];
  refresh: () => void;
}) {
  const confirmed = useRef(policy);
  if (policy.revision >= confirmed.current.revision) confirmed.current = policy;
  const draft = useRef<{
    config: ReturnType<typeof providerReservePolicy>;
    base: PulsarPolicy;
  } | null>(null);
  const pending = useRef<{ key: string; policy: PulsarPolicy } | null>(null);
  const busy = useRef(false),
    next = useRef(false);
  const errorRef = useRef('');
  const [error, setErrorValue] = useState(''),
    [status, setStatus] = useState('');
  const setError = (message: string) => {
    errorRef.current = message;
    setErrorValue(message);
  };
  const [, render] = useState(0);
  const latest = confirmed.current,
    saved = providerReservePolicy(latest, provider.provider);
  const config = draft.current?.config ?? saved;
  const change = (patch: Partial<typeof config>) => {
    if (error) return;
    draft.current = { base: draft.current?.base ?? latest, config: { ...config, ...patch } };
    setStatus('Unsaved');
    render((n) => n + 1);
  };
  async function save() {
    if (busy.current) {
      next.current = true;
      return;
    }
    const proposed = draft.current;
    if (!pending.current && !proposed) return;
    if (errorRef.current && !pending.current) return;
    if (!pending.current && proposed)
      pending.current = {
        key: crypto.randomUUID(),
        policy: {
          ...proposed.base,
          providerReserves: {
            codex: providerReservePolicy(proposed.base, 'codex'),
            claude: providerReservePolicy(proposed.base, 'claude'),
            [provider.provider]: proposed.config,
          },
        },
      };
    busy.current = true;
    setError('');
    setStatus('Saving…');
    render((n) => n + 1);
    let succeeded = false;
    try {
      const response = pulsarStatusSchema.parse(await api('/pulsar/policy', pending.current));
      confirmed.current = response.policy;
      if (draft.current === proposed) draft.current = null;
      else if (draft.current) draft.current.base = response.policy;
      pending.current = null;
      setStatus('Saved');
      succeeded = true;
      refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) pending.current = null;
      setStatus('Save unconfirmed');
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not confirm this reserve. Retry the same request.',
      );
      refresh();
    } finally {
      busy.current = false;
      render((n) => n + 1);
      const again = next.current && succeeded;
      next.current = false;
      if (again) void save();
    }
  }
  const release = () => {
    if (!errorRef.current) void save();
  };
  return (
    <section
      className="quark-provider-reserve"
      aria-label={`${provider.label} shared reserve control`}
    >
      <label className="quark-rate-label">
        <span>{provider.label} minimum remaining reserve</span>
        <strong>{config.reservePercent}%</strong>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={config.reservePercent}
          aria-label={`${provider.label} shared reserve`}
          aria-valuetext={`${config.reservePercent}% of full allowance kept remaining`}
          aria-disabled={error ? true : undefined}
          onChange={(event) => change({ reservePercent: Number(event.target.value) })}
          onPointerUp={release}
          onBlur={release}
          onKeyUp={(event) => {
            if (
              [
                'ArrowLeft',
                'ArrowRight',
                'ArrowUp',
                'ArrowDown',
                'Home',
                'End',
                'PageUp',
                'PageDown',
              ].includes(event.key)
            )
              release();
          }}
        />
      </label>
      <small>
        Saved baseline {saved.reservePercent}% ·{' '}
        {latest.enabled ? 'shared protection on' : 'shared protection off'}
      </small>
      {pacing.map((window) => (
        <small key={window.windowId}>
          {window.label}: effective reserve {window.reservePercent}%
          {window.reserveReleased ? ' · timed release active' : ''}
          {window.resetsAt
            ? ` · reset ${new Date(window.resetsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
            : ' · reset unknown'}
          .
        </small>
      ))}
      <small role="status">{status || 'Release to save'}</small>
      {error && (
        <div className="quark-budget-error">
          <p role="alert">{error}</p>
          {pending.current && (
            <button type="button" onClick={() => void save()}>
              Retry reserve save
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              pending.current = null;
              draft.current = null;
              confirmed.current = policy;
              setError('');
              setStatus('');
              refresh();
            }}
          >
            Use current reserve
          </button>
        </div>
      )}
      <details>
        <summary>Optional timed release</summary>
        <label className="quark-reserve-check">
          <input
            type="checkbox"
            checked={config.releaseEnabled}
            disabled={busy.current || !!pending.current || !!error}
            onChange={(event) => change({ releaseEnabled: event.target.checked })}
          />
          Release reserve to 0 before a reported reset
        </label>
        <label>
          Minutes before each reported reset
          <input
            type="number"
            min="1"
            max="10080"
            step="1"
            value={config.releaseBeforeResetMinutes}
            disabled={busy.current || !!pending.current || !!error}
            onChange={(event) => change({ releaseBeforeResetMinutes: event.target.valueAsNumber })}
          />
        </label>
        <button
          type="button"
          className="flow-button"
          disabled={
            busy.current ||
            !!pending.current ||
            !!error ||
            !draft.current ||
            !Number.isInteger(config.releaseBeforeResetMinutes) ||
            config.releaseBeforeResetMinutes < 1 ||
            config.releaseBeforeResetMinutes > 10080
          }
          onClick={() => void save()}
        >
          Save reserve settings
        </button>
        <small>
          Off by default. Each fresh reported window releases its saved reserve to 0 inside this
          interval. A verified new reset restores the baseline outside it. Stale or elapsed readings
          never grant capacity.{' '}
          {provider.provider === 'codex'
            ? 'With 12 hours selected, a five-hour window is always inside the release interval; a weekly window is released only in its final 12 hours.'
            : 'The default is 45 minutes; every reported model window keeps its own reset.'}
        </small>
      </details>
    </section>
  );
}

/** Explicitly turns on the existing shared pacing policy without changing its saved limits. */
export function SharedProtectionControl({
  policy,
  refresh,
}: {
  policy: PulsarPolicy;
  refresh: () => void;
}) {
  const confirmed = useRef(policy);
  if (policy.revision >= confirmed.current.revision) confirmed.current = policy;
  const pending = useRef<{ key: string; policy: PulsarPolicy } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function enable() {
    if (busy) return;
    pending.current ??= {
      key: crypto.randomUUID(),
      policy: { ...confirmed.current, enabled: true },
    };
    setBusy(true);
    setError('');
    try {
      confirmed.current = pulsarStatusSchema.parse(
        await api('/pulsar/policy', pending.current),
      ).policy;
      pending.current = null;
      refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) pending.current = null;
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not confirm shared protection. Retry the same request.',
      );
      refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="quark-shared-protection">
      <p>
        {confirmed.current.enabled
          ? 'Shared protection is on.'
          : 'Shared protection is off. Enable the saved capacity pacing policy to enforce these reserves.'}
      </p>
      {(!confirmed.current.enabled || pending.current) && (
        <button type="button" className="flow-button" disabled={busy} onClick={() => void enable()}>
          {busy
            ? 'Saving…'
            : pending.current
              ? 'Retry shared protection change'
              : 'Enable shared protection'}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
