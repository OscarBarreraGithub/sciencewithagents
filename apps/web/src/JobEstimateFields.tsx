import type { JobEstimate } from '@dock/shared';

export function JobEstimateFields({
  value,
  change,
  disabled = false,
}: {
  value: JobEstimate;
  change: (value: JobEstimate) => void;
  disabled?: boolean;
}) {
  const number = (key: keyof JobEstimate, label: string, min: number, max: number, step = 1) => (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={Number(value[key])}
        onChange={(e) => change({ ...value, [key]: e.target.valueAsNumber })}
      />
    </label>
  );
  return (
    <fieldset className="job-estimate" disabled={disabled}>
      <label>
        Priority
        <select
          value={value.priority}
          onChange={(e) =>
            change({ ...value, priority: e.target.value as JobEstimate['priority'] })
          }
        >
          <option value="interactive">Do this soon — I’m waiting</option>
          <option value="high">High priority</option>
          <option value="normal">Normal</option>
          <option value="background">Background — spare capacity</option>
        </select>
      </label>
      <details>
        <summary>Work estimate</summary>
        <p className="muted">
          Planning estimates your manager can refine. Spending limits use percentage points of the
          reported Codex or Claude allowance, including optional hourly limits in QUARK. Token
          counts are accounting evidence.
        </p>
        <div className="estimate-grid">
          {number('expectedTokens', 'Estimated tokens per turn', 100, 10_000_000)}
          {number('quotaPercent', 'Allowance reservation (%)', 0.1, 100, 0.1)}
          {number('expectedSeconds', 'Estimated seconds per turn', 1, 604800)}
          {number('cpuCores', 'Estimated CPU cores', 0.1, 256, 0.05)}
          {number('memoryMb', 'Estimated memory (MB)', 64, 1_048_576)}
          <label>
            Estimated cost (USD, optional)
            <input
              type="number"
              min="0"
              max="1000000"
              step="0.01"
              value={value.estimatedCostUsd ?? ''}
              onChange={(e) =>
                change({
                  ...value,
                  estimatedCostUsd: e.target.value === '' ? null : e.target.valueAsNumber,
                })
              }
            />
          </label>
          <label>
            Target completion (optional)
            <input
              type="datetime-local"
              value={
                value.deadline
                  ? new Date(
                      Date.parse(value.deadline) -
                        new Date(value.deadline).getTimezoneOffset() * 60_000,
                    )
                      .toISOString()
                      .slice(0, 16)
                  : ''
              }
              onChange={(e) =>
                change({
                  ...value,
                  deadline: e.target.value ? new Date(e.target.value).toISOString() : null,
                })
              }
            />
          </label>
        </div>
        <label>
          Estimate basis
          <input
            maxLength={500}
            value={value.estimateNote}
            onChange={(e) => change({ ...value, estimateNote: e.target.value })}
          />
        </label>
        <p className="muted">
          Subscription percentages and tokens are separate estimates. A cost estimate is not a bill
          or permission for paid API fallback.
        </p>
      </details>
    </fieldset>
  );
}
