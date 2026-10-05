import { expect, it } from 'vitest';
import { currentRateSamples, rateHistory, type RateInterval } from './quark-rates.js';
const now = Date.parse('2026-10-05T12:00:00Z');
const stamp = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const row = (
  from: number,
  to: number,
  percent = 1,
  fields: Partial<RateInterval> = {},
): RateInterval => ({
  provider: 'claude',
  windowId: 'primary',
  from: stamp(from),
  observedAt: stamp(to),
  resetsAt: stamp(180),
  delta: percent,
  unattributed: 0,
  allocations: [{ projectId: 'project', percent }],
  ...fields,
});
it('returns a bounded12-hour history with prorated interval coverage and unknown gaps', () => {
  const history = rateHistory(
    [row(-65, -60, 0.5), row(-60, -55, 0), row(-10, -5, 1, { gap: true }), row(-5, 0, 0.5)],
    'project',
    now,
    360_000,
  );
  expect(history).toHaveLength(24);
  expect(history[0]).toMatchObject({
    estimatedPercent: null,
    estimatedPercentPerHour: null,
    coverageMinutes: 0,
  });
  expect(history[21]).toMatchObject({
    estimatedPercent: 0.5,
    estimatedPercentPerHour: 6,
    coverageMinutes: 5,
  });
  expect(history[22]).toMatchObject({
    estimatedPercent: 0,
    estimatedPercentPerHour: 0,
    coverageMinutes: 5,
  });
  expect(history[23]).toMatchObject({
    estimatedPercent: 0.5,
    estimatedPercentPerHour: 6,
    coverageMinutes: 5,
  });
});
it('does not turn reset boundaries, long gaps or unattributed spending into project rates', () => {
  const rows = [
    row(-30, -25),
    row(-25, -20, 0, { baseline: true, resetsAt: stamp(300) }),
    row(-20, -15, 0.5, { resetsAt: stamp(300) }),
    row(-15, -5, 1),
    row(-5, 0, 1, { unattributed: 1, allocations: [] }),
  ];
  const last = rateHistory(rows, 'project', now, 360_000).at(-1)!;
  expect(last).toMatchObject({
    estimatedPercent: 1.5,
    estimatedPercentPerHour: null,
    coverageMinutes: 10,
    resetBoundary: true,
  });
  const current = currentRateSamples(rows, stamp(180), 360_000);
  expect(current).toHaveLength(2);
  expect(current[0]!.observedAt).toBe(stamp(-5));
});
it('can read old evidence without stored from timestamps without inventing an initial interval', () => {
  const rows = [
    row(-20, -15, 0, { from: undefined, baseline: true }),
    row(-15, -10, 0.5, { from: undefined }),
  ];
  expect(rateHistory(rows, 'project', now, 360_000).at(-1)).toMatchObject({
    estimatedPercent: 0.5,
    coverageMinutes: 5,
    estimatedPercentPerHour: 6,
  });
});
