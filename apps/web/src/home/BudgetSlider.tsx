import { quarkStatusSchema, type QuarkStatus } from '@dock/shared';
import { api } from '../api';

export type BoardBudget = QuarkStatus['budgets'][number];
type BudgetEdit = {
  confirmed?: BoardBudget;
  draft?: { value: number; base: BoardBudget };
  receipt?: { key: string; body: object };
  busy?: boolean;
  /** A release/key-up arrived while a save was in flight. */
  pending?: boolean;
  error?: string;
  saved?: boolean;
};
// The board owns edits so a live move between columns cannot lose a pending save.
export type BudgetEdits = Map<string, BudgetEdit>;
const pct = (value: number) => `${Number(value.toFixed(1))}%`;

/** Owner adjustment of the existing durable cap; release saves one idempotent operation. */
export function BudgetSlider({
  budget,
  windowLabel,
  refresh,
  edits,
  changed,
}: {
  budget: BoardBudget;
  windowLabel: string;
  refresh: () => void;
  edits: BudgetEdits;
  changed: () => void;
}) {
  let edit = edits.get(budget.id);
  if (!edit) {
    edit = {};
    edits.set(budget.id, edit);
  }
  const state = edit;
  const latest =
    !state.confirmed || budget.revision >= state.confirmed.revision ? budget : state.confirmed;
  const value = state.draft?.value ?? latest.limitPercent;
  const { busy, error, saved } = state;
  // Keyboard moves during a save become the next draft; the slider stays focusable throughout.
  const change = (next: number) => {
    if (state.error) return;
    state.draft = { value: next, base: state.draft?.base ?? latest };
    state.saved = false;
    changed();
  };
  const save = async (retry = false) => {
    if (state.busy) state.pending = true;
    if (state.busy || (state.error && !retry)) return;
    const proposed = state.draft;
    if (!proposed) return;
    if (!state.receipt && proposed.value === proposed.base.limitPercent) {
      state.draft = undefined;
      changed();
      return;
    }
    state.busy = true;
    state.error = '';
    if (!state.receipt) {
      const b = proposed.base;
      state.receipt = {
        key: crypto.randomUUID(),
        body: {
          id: b.id,
          expectedRevision: b.revision,
          projectId: b.projectId,
          taskId: b.taskId,
          provider: b.provider,
          windowId: b.windowId,
          limitPercent: proposed.value,
          period: b.period,
          enabled: b.period === 'hour' ? true : b.enabled,
        },
      };
    }
    changed();
    try {
      const response = quarkStatusSchema.parse(
        await api('/quark/budgets', {
          key: state.receipt.key,
          ...state.receipt.body,
        }),
      );
      const updated = response.budgets.find((b) => b.id === budget.id);
      if (!updated) throw new Error('The saved budget could not be confirmed.');
      state.confirmed = updated;
      state.draft =
        state.draft === proposed ? undefined : state.draft && { ...state.draft, base: updated };
      state.receipt = undefined;
      state.saved = !state.draft;
      refresh();
    } catch (reason) {
      state.error = reason instanceof Error ? reason.message : 'Could not save this budget.';
      refresh();
    } finally {
      state.busy = false;
      const again = state.pending && !state.error;
      state.pending = false;
      changed();
      if (again) void save();
    }
  };
  const hourly = budget.period === 'hour';
  const label = `${budget.provider === 'claude' ? 'Claude' : 'Codex'} · ${windowLabel}${hourly ? ' per hour' : ''}`;
  return (
    <section className="quark-budget-slider" aria-label={`${label} budget`}>
      <label>
        <span className="quark-budget-slider-heading">
          <span>{label}</span>
          <strong>
            {pct(value)}
            {hourly ? ' / hour' : ''}
          </strong>
        </span>
        <input
          type="range"
          min={hourly ? '0' : '0.1'}
          max="100"
          step="0.1"
          value={value}
          aria-label={`${label} spending limit`}
          aria-valuetext={`${pct(value)} of the full allowance${hourly ? ' in a rolling hour' : ''}`}
          // Not `disabled`: that drops keyboard focus to the page mid-adjustment.
          aria-disabled={error ? true : undefined}
          onChange={(event) => change(Number(event.target.value))}
          onPointerUp={() => void save()}
          onKeyUp={(event) => {
            if (
              [
                'ArrowLeft',
                'ArrowRight',
                'ArrowUp',
                'ArrowDown',
                'PageUp',
                'PageDown',
                'Home',
                'End',
              ].includes(event.key)
            )
              void save();
          }}
          onBlur={() => void save()}
        />
      </label>
      <div
        className="quark-budget-meter"
        role="meter"
        aria-label={`${label} estimated spending`}
        aria-valuemin={0}
        aria-valuemax={latest.limitPercent}
        aria-valuenow={Math.min(latest.limitPercent, latest.spentPercent)}
        aria-valuetext={`${pct(latest.spentPercent)} spent of ${pct(latest.limitPercent)}`}
      >
        <span
          style={{
            width: `${latest.limitPercent > 0 ? Math.min(100, (latest.spentPercent / latest.limitPercent) * 100) : 0}%`,
          }}
        />
      </div>
      <p>
        ≈{pct(latest.spentPercent)} spent{hourly ? ' in the last hour' : ''} ·{' '}
        {pct(latest.remainingPercent)} left
      </p>
      {latest.reservedPercent > 0 && <small>≈{pct(latest.reservedPercent)} in flight</small>}
      {latest.reason && <small>{latest.reason}</small>}
      {hourly && !latest.enabled && <small>Hourly limit is off</small>}
      {hourly && latest.enabled && latest.limitPercent === 0 && (
        <small>
          Provider paused at 0% / hour. Raise the rate to permit recovery after a confirmed stop and
          fresh readings.
        </small>
      )}
      {hourly && latest.nextEligibleAt && (
        <small>
          Earlier usage begins to leave the hour at{' '}
          {new Date(latest.nextEligibleAt).toLocaleTimeString()}
        </small>
      )}
      <small role="status">
        {busy
          ? 'Saving…'
          : saved
            ? 'Saved'
            : budget.source === 'manager'
              ? 'Starting budget set by your manager'
              : 'Release to save'}
      </small>
      {error && (
        <div className="quark-budget-error">
          <p role="alert">{error}</p>
          <button type="button" disabled={busy} onClick={() => void save(true)}>
            Retry save
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              state.draft = undefined;
              state.receipt = undefined;
              state.error = '';
              state.saved = false;
              changed();
              refresh();
            }}
          >
            Use current budget
          </button>
        </div>
      )}
    </section>
  );
}
