import { useEffect, useState } from 'react';
import { capacityStatusSchema, type CapacityStatus, type ProviderCapacity } from '@dock/shared';
import { api } from './api';
import { Modal } from './Modal';
import './CapacityPanel.css';

function summary(provider: ProviderCapacity) {
  if (!provider.observedAt) return 'Usage unavailable';
  const window = provider.windows.find((w) => w.scope === 'general');
  if (!window) return 'See allowances';
  const duration =
    window.windowMinutes === 300 ? '5h' : window.windowMinutes === 10080 ? 'week' : window.label;
  return `${Math.round(window.usedPercent)}% used · ${duration}${provider.stale ? ' · stale' : ''}`;
}
const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function CapacityPanel() {
  const [state, setState] = useState<CapacityStatus | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const value = capacityStatusSchema.parse(await api('/capacity'));
        if (active) {
          setState(value);
          setError('');
        }
      } catch {
        if (active) setError('Usage connection unavailable. Retry when connected.');
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const refresh = async () => {
    setBusy(true);
    try {
      setState(capacityStatusSchema.parse(await api('/capacity/refresh', {})));
      setError('');
    } catch {
      setError('Could not refresh usage. Your work and saved reading are retained.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className="capacity-strip"
        onClick={() => setOpen(true)}
        aria-label="Usage and computer capacity"
      >
        {state ? (
          state.providers.map((provider) => (
            <span key={provider.provider}>
              <b>{provider.label}</b>
              <span>{summary(provider)}</span>
              {provider.windows
                .filter((w) => w.model === 'fable')
                .map((window) => (
                  <span key={window.id}>
                    Fable {Math.round(window.usedPercent)}% used
                    {window.windowMinutes === 10080 ? ' · week' : ''}
                  </span>
                ))}
            </span>
          ))
        ) : (
          <span>
            <b>Usage and capacity</b>
            <span>{error || 'Reading allowances…'}</span>
          </span>
        )}
        <small>Details</small>
      </button>
      {open && (
        <Modal title="Usage and computer capacity" close={() => setOpen(false)}>
          <p>
            All managers share these readings. QUARK uses capacity and your priorities to pace
            queued work.
          </p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button
            className="secondary"
            disabled={busy || state?.refreshing}
            onClick={() => void refresh()}
          >
            {busy || state?.refreshing ? 'Refreshing usage…' : 'Refresh usage'}
          </button>
          <p className="muted">
            Refreshes are shared, normally once a minute. A short cooldown prevents repeated
            requests.
          </p>
          {state?.providers.map((provider) => (
            <section className="capacity-provider" key={provider.provider}>
              <h3>
                {provider.label}
                {provider.plan ? ` · ${provider.plan}` : ''}
              </h3>
              <p>{provider.message}</p>
              <small>
                {provider.observedAt
                  ? `${provider.stale ? 'Stale reading' : 'Updated'} ${new Date(provider.observedAt).toLocaleTimeString()}`
                  : 'No verified reading yet'}
              </small>
              {provider.windows.map((window) => (
                <div className="capacity-window" key={window.id}>
                  <div>
                    <b>
                      {window.label}
                      {window.windowMinutes === 300
                        ? ' · 5 hours'
                        : window.windowMinutes === 10080
                          ? ' · 7 days'
                          : ''}
                    </b>
                    <span>{window.usedPercent.toFixed(0)}% used</span>
                  </div>
                  <progress
                    max={100}
                    value={window.usedPercent}
                    aria-label={`${provider.label} ${window.label} used`}
                  />
                  <small>
                    {window.resetsAt
                      ? `Resets ${new Date(window.resetsAt).toLocaleString()}`
                      : 'Reset time not reported'}
                    {window.scope === 'model' ? ' · separate model allowance' : ''}
                  </small>
                </div>
              ))}
              {provider.weeklyPolicy !== 'reported' && (
                <p className="muted">
                  {provider.weeklyPolicy === 'owner-reported-none'
                    ? 'Owner reports no general weekly cap for this account.'
                    : 'A general weekly window was not reported. This alone does not establish an unlimited plan.'}
                </p>
              )}
            </section>
          ))}
          {state?.machine && (
            <section className="capacity-provider">
              <h3>This computer</h3>
              <p>
                {state.machine.cpuCount} CPU cores ·{' '}
                {state.machine.cpuUsedPercent === null
                  ? 'Measuring CPU use…'
                  : `${state.machine.cpuUsedPercent.toFixed(0)}% CPU in use`}
              </p>
              <p>
                {gigabytes(state.machine.memoryAvailableBytes)}{' '}
                {state.machine.memoryBasis === 'free-plus-reclaimable-estimate'
                  ? 'estimated available (including reclaimable memory)'
                  : 'free'}{' '}
                of {gigabytes(state.machine.memoryTotalBytes)} memory
              </p>
              <p>
                {state.machine.diskAvailableBytes === null
                  ? 'Free disk space unknown'
                  : `${gigabytes(state.machine.diskAvailableBytes)} disk space available`}
              </p>
              <small>
                Measured {new Date(state.machine.observedAt).toLocaleTimeString()}; includes other
                applications.
              </small>
            </section>
          )}
          <p className="muted">{state?.notice}</p>
        </Modal>
      )}
    </>
  );
}
