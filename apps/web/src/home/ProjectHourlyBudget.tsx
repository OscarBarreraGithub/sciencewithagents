import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  quarkStatusSchema,
  allowanceWindowLabel,
  type ProjectRates,
  type ProviderCapacity,
  type QuarkStatus,
} from '@dock/shared';
import { api, ApiError } from '../api';
import { RateHistory } from './RateHistory';
type Budget = QuarkStatus['budgets'][number];
const finiteRate = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100;
const validRate = (value: number) =>
  finiteRate(value) && Math.abs(value * 10 - Math.round(value * 10)) < 1e-6;

/** A release creates one revisioned receipt, retained until its outcome is confirmed. */
export function ProjectHourlyBudget({
  projectId,
  provider,
  budgets,
  rates,
  refresh,
}: {
  projectId: string;
  provider: ProviderCapacity;
  budgets: QuarkStatus['budgets'];
  rates?: ProjectRates['rates'];
  refresh: () => void;
}) {
  const windows = provider.windows.filter((w) => w.scope !== 'other');
  const saved = budgets.filter(
    (b) =>
      !b.taskId &&
      b.projectId === projectId &&
      b.provider === provider.provider &&
      b.period === 'hour',
  );
  const preferred = windows.find(
    (w) =>
      w.scope === 'general' && w.windowMinutes === (provider.provider === 'codex' ? 10080 : 300),
  );
  const [windowId, setWindowId] = useState(
    saved[0]?.windowId ?? preferred?.id ?? windows.find((w) => w.scope === 'general')?.id ?? '',
  );
  useEffect(() => {
    if (!windowId && windows.length)
      setWindowId(
        preferred?.id ?? windows.find((w) => w.scope === 'general')?.id ?? windows[0]!.id,
      );
  }, [windowId, preferred?.id, windows.length]);
  const confirmed = useRef<Budget | undefined>(undefined);
  const existing = saved.find((b) => b.windowId === windowId);
  if (
    existing &&
    (!confirmed.current ||
      (existing.id === confirmed.current.id && existing.revision >= confirmed.current.revision))
  )
    confirmed.current = existing;
  const latest = confirmed.current?.windowId === windowId ? confirmed.current : existing;
  const rangeId = useId();
  const detailsId = useId();
  const [details, setDetails] = useState(false);
  const draft = useRef<number | null>(null);
  const numericText = useRef<string | null>(null);
  const pending = useRef<{ key: string; [field: string]: unknown } | null>(null);
  const busy = useRef(false),
    followup = useRef(false);
  const errorRef = useRef('');
  const [error, setErrorValue] = useState(''),
    [status, setStatus] = useState('');
  const setError = (message: string) => {
    errorRef.current = message;
    setErrorValue(message);
  };
  const [, render] = useState(0);
  // A saved owner cap (including 0) is authoritative; without one there is no invented value.
  const value: number | null = draft.current ?? latest?.limitPercent ?? null;
  const selectedWindow = windows.find((w) => w.id === windowId);
  const selectedLabel = selectedWindow ? allowanceWindowLabel(selectedWindow) : 'Saved allowance';
  const limited = draft.current !== null || latest?.enabled;
  const rate = rates?.find(
    (r) => r.projectId === projectId && r.provider === provider.provider && r.windowId === windowId,
  );
  const rateLabel =
    rate?.estimatedPercentPerHour === null || rate?.estimatedPercentPerHour === undefined
      ? 'Now: waiting for readings'
      : `Now ≈${Number(rate.estimatedPercentPerHour.toFixed(1))}% / hour${rate.stale ? ' · old reading' : ''}`;
  // Advisory only: a ready reading may prefill an unsaved field; it is never saved on its own.
  const advice = rate?.adaptive;
  const advised =
    advice?.state === 'ready' && advice.percentPerHour !== null
      ? Math.round(advice.percentPerHour * 10) / 10
      : null;
  const suggestion = advised !== null && validRate(advised) && !latest ? advised : null;
  const adviceText = !advice
    ? 'No suggested pace from this computer; set a rate manually or keep the shared pace.'
    : advice.state === 'ready' && advised !== null
      ? `Suggested ${advised}% / hour for this window · not saved${advice.reason ? ` · ${advice.reason}` : ''}`
      : `No suggestion (${advice.state})${advice.reason ? `: ${advice.reason}` : ''}`;
  async function save(enabled = true) {
    if (busy.current) {
      followup.current = true;
      return;
    }
    if (errorRef.current && !pending.current) return;
    const base = confirmed.current?.windowId === windowId ? confirmed.current : existing;
    if (!pending.current && draft.current === null && enabled === !!base?.enabled) return;
    if (!windowId) return;
    if (!pending.current && draft.current !== null && !validRate(draft.current)) {
      setStatus('Enter a rate from 0 to 100 in 0.1 steps before saving.');
      return;
    }
    pending.current ??= {
      key: crypto.randomUUID(),
      ...(base ? { id: base.id, expectedRevision: base.revision } : {}),
      projectId,
      taskId: null,
      provider: provider.provider,
      windowId,
      period: 'hour',
      enabled,
      limitPercent: draft.current ?? base?.limitPercent,
    };
    if (pending.current.limitPercent === undefined) {
      pending.current = null;
      return;
    }
    const request = pending.current;
    busy.current = true;
    setError('');
    setStatus('Saving…');
    render((n) => n + 1);
    let succeeded = false;
    try {
      const response = quarkStatusSchema.parse(await api('/quark/budgets', request));
      const updated = response.budgets.find(
        (b) =>
          b.projectId === projectId &&
          !b.taskId &&
          b.provider === provider.provider &&
          b.windowId === windowId &&
          b.period === 'hour',
      );
      if (!updated)
        throw new Error('The saved rate could not be confirmed. Retry the same request.');
      confirmed.current = updated;
      if (draft.current === request.limitPercent) {
        draft.current = null;
        numericText.current = null;
      }
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
          : 'Could not confirm this rate. Retry the same request.',
      );
      refresh();
    } finally {
      busy.current = false;
      render((n) => n + 1);
      const again = followup.current && succeeded;
      followup.current = false;
      if (again) void save();
    }
  }
  const release = () => {
    if (!errorRef.current && draft.current !== null) void save();
  };
  return (
    <section className="quark-project-rate" aria-label={`${provider.label} project rate`}>
      <div className="quark-rate-current">
        <strong>{provider.label}</strong>
        <span>{rateLabel}</span>
      </div>
      {!windowId ? (
        <p>No reported allowance window yet. Refresh usage before setting a rate.</p>
      ) : (
        <>
          <div className="quark-rate-label">
            <label htmlFor={rangeId}>Saved rate · {selectedLabel}</label>
            <strong>
              {limited
                ? value !== null && validRate(value)
                  ? `${value}% / hour`
                  : 'Unsaved rate'
                : 'Shared pace'}
            </strong>
            <label className="quark-rate-exact">
              Rate value
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={
                  numericText.current ??
                  (value !== null && finiteRate(value) ? value : (suggestion ?? ''))
                }
                placeholder="Manual"
                aria-label={`${provider.label} rate value (% per hour)`}
                aria-disabled={error ? true : undefined}
                onChange={(event) => {
                  if (errorRef.current) return;
                  numericText.current = event.target.value;
                  draft.current = event.target.valueAsNumber;
                  setStatus(
                    validRate(event.target.valueAsNumber)
                      ? 'Leave the field or press Enter to save'
                      : 'Enter a rate from 0 to 100 in 0.1 steps before saving.',
                  );
                  render((n) => n + 1);
                }}
                onBlur={release}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    // Enter on a shown suggestion is the owner's explicit choice to save it.
                    if (draft.current === null && suggestion !== null) draft.current = suggestion;
                    release();
                  }
                }}
                onKeyUp={(event) => {
                  if (['ArrowUp', 'ArrowDown'].includes(event.key)) release();
                }}
              />
            </label>
            <input
              type="range"
              id={rangeId}
              min="0"
              max="100"
              step="0.1"
              value={value !== null && validRate(value) ? value : (suggestion ?? 0)}
              aria-label={`${provider.label} project rate limit`}
              aria-valuetext={
                limited
                  ? `${value !== null && validRate(value) ? value : (latest?.limitPercent ?? 'unsaved')}% per hour${value === 0 ? ', provider paused' : ''}`
                  : 'No project rate limit; move to set one'
              }
              aria-disabled={error ? true : undefined}
              onChange={(event) => {
                if (error) return;
                numericText.current = null;
                draft.current = Number(event.target.value);
                setStatus('Release to save');
                render((n) => n + 1);
              }}
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
          </div>
          {latest?.enabled && latest.limitPercent === 0 && (
            <p className="quark-rate-paused">
              {provider.label} paused for this project. Raise the rate to allow recovery.
            </p>
          )}
          {latest?.reason && latest.limitPercent !== 0 && <small>{latest.reason}</small>}
          {suggestion !== null && draft.current === null && (
            <small>Suggested {suggestion}% / hour · not saved</small>
          )}
          {/* Status and the Details button share one row, so saving never shifts the card. */}
          <div className="quark-rate-foot">
            <small role="status">{status}</small>
            <button
              type="button"
              className="flow-button quark-more-button"
              aria-expanded={details}
              aria-controls={detailsId}
              onClick={() => setDetails(!details)}
            >
              Details <ChevronDown size={16} aria-hidden="true" />
            </button>
          </div>
          {error && (
            <div className="quark-budget-error">
              <p role="alert">{error}</p>
              {pending.current && (
                <button type="button" onClick={() => void save()}>
                  Retry rate save
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  pending.current = null;
                  draft.current = null;
                  numericText.current = null;
                  confirmed.current = existing;
                  setError('');
                  setStatus('');
                  refresh();
                }}
              >
                Use current rate
              </button>
            </div>
          )}
          {/* Already-loaded readings only: opening Details makes no request or model call. */}
          <div id={detailsId} className="quark-more-panel" hidden={!details}>
            <RateHistory rate={rate} />
            <small className="quark-rate-advice">{adviceText}</small>
            {advice?.resetsAt && (
              <small>
                Reported window resets{' '}
                {new Date(advice.resetsAt).toLocaleString([], {
                  weekday: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </small>
            )}
            {latest?.enabled && (
              <small>
                ≈{Number(latest.spentPercent.toFixed(1))}% used in the rolling hour
                {latest.reservedPercent > 0 &&
                  ` · ≈${Number(latest.reservedPercent.toFixed(1))}% in flight`}
              </small>
            )}
            {latest?.nextEligibleAt && (
              <small>
                Earlier usage starts to leave the hour at{' '}
                {new Date(latest.nextEligibleAt).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                .
              </small>
            )}
            <label>
              Reported allowance window
              <select
                value={windowId}
                disabled={busy.current || !!pending.current}
                onChange={(event) => {
                  setWindowId(event.target.value);
                  draft.current = null;
                  numericText.current = null;
                  confirmed.current = undefined;
                  setStatus('');
                  setError('');
                }}
              >
                {!windows.some((w) => w.id === windowId) && (
                  <option value={windowId}>Saved window · reading unavailable</option>
                )}
                {windows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
            {latest?.enabled && (
              <button
                type="button"
                className="flow-button"
                disabled={busy.current || !!pending.current || !!error}
                onClick={() => {
                  draft.current = null;
                  numericText.current = null;
                  void save(false);
                }}
              >
                Use shared pace
              </button>
            )}
            {saved
              .filter((b) => b.windowId !== windowId && b.enabled)
              .map((b) => (
                <small key={b.id}>
                  Also enforced: {windows.find((w) => w.id === b.windowId)?.label ?? b.windowId} ·{' '}
                  {b.limitPercent}% / hour.
                </small>
              ))}
            <small>
              {!limited && 'No project rate limit; moving the slider sets one and 0 pauses. '}
              Current rates are estimates; saved rates cap the rolling hour alongside total caps,
              shared reserves and other pauses. A lower rate can wait for recent usage to leave the
              hour, and work in flight may overshoot while stopping. Raising from 0 needs a
              confirmed stop, fresh readings and room under every other hold. Chart gaps mean no
              reading.
            </small>
          </div>
        </>
      )}
    </section>
  );
}
