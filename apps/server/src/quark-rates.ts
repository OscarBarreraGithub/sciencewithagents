import { sameAllowanceReset, type CapacityProvider } from '@dock/shared';
export type RateInterval = {
  provider: CapacityProvider;
  windowId: string;
  observedAt: string;
  resetsAt: string | null;
  from?: string | null;
  baseline?: boolean;
  gap?: boolean;
  delta: number;
  unattributed: number;
  allocations: { projectId: string; percent: number }[];
};
/** Only one contiguous, comparable segment may train a current rate. */
export function currentRateSamples(rows: RateInterval[], reset: string | null, maxGap: number) {
  const matching = rows.filter((row) => sameAllowanceReset(row.resetsAt, reset));
  let start = 0;
  for (let i = 0; i < matching.length; i++) {
    const row = matching[i]!;
    if (
      row.baseline ||
      row.gap ||
      (i > 0 && Date.parse(row.observedAt) - Date.parse(matching[i - 1]!.observedAt) > maxGap)
    )
      start = i;
  }
  return matching.slice(start);
}
/** Fixed half-hour display buckets; only observed intervals supply coverage or spending. */
export function rateHistory(rows: RateInterval[], projectId: string, now: number, maxGap: number) {
  const size = 30 * 60_000,
    since = now - 12 * 3600_000;
  const buckets = Array.from({ length: 24 }, (_, index) => ({
    from: new Date(since + index * size).toISOString(),
    to: new Date(since + (index + 1) * size).toISOString(),
    percent: 0,
    coverage: 0,
    samples: 0,
    resets: new Set<string | null>(),
  }));
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!,
      previous = rows[index - 1];
    const from = row.from ? Date.parse(row.from) : previous ? Date.parse(previous.observedAt) : NaN;
    const to = Date.parse(row.observedAt),
      duration = to - from;
    if (
      row.baseline ||
      row.gap ||
      !Number.isFinite(from) ||
      duration <= 0 ||
      duration > maxGap ||
      (previous && !sameAllowanceReset(previous.resetsAt, row.resetsAt)) ||
      row.unattributed > 0
    )
      continue;
    const percent = row.allocations
      .filter((a) => a.projectId === projectId)
      .reduce((sum, a) => sum + a.percent, 0);
    for (const bucket of buckets) {
      const overlap = Math.max(
        0,
        Math.min(to, Date.parse(bucket.to)) - Math.max(from, Date.parse(bucket.from)),
      );
      if (!overlap) continue;
      bucket.percent += (Math.max(0, percent) * overlap) / duration;
      bucket.coverage += overlap;
      bucket.samples++;
      bucket.resets.add(row.resetsAt);
    }
  }
  return buckets.map((bucket) => ({
    from: bucket.from,
    to: bucket.to,
    estimatedPercent: bucket.coverage > 0 ? bucket.percent : null,
    estimatedPercentPerHour:
      bucket.coverage >= 5 * 60_000 && bucket.resets.size <= 1
        ? bucket.percent / (bucket.coverage / 3600_000)
        : null,
    coverageMinutes: Math.min(30, bucket.coverage / 60_000),
    samples: bucket.samples,
    resetsAt: bucket.resets.size === 1 ? [...bucket.resets][0]! : null,
    resetBoundary: bucket.resets.size > 1,
  }));
}
