/** Native providers expose epoch seconds/milliseconds or an ISO timestamp. Never use read time. */
export function latestConversationActivity(values: Iterable<unknown>): string | undefined {
  let latest = -Infinity;
  for (const value of values) {
    const at =
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value < 1e12
          ? value * 1000
          : value
        : typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
          ? Date.parse(value)
          : NaN;
    if (Number.isFinite(at) && at <= 8.64e15) latest = Math.max(latest, at);
  }
  return latest === -Infinity ? undefined : new Date(latest).toISOString();
}

/** Recency first; connection status and discovery order never move a conversation. */
export function compareConversationActivity(
  a: string | null | undefined,
  b: string | null | undefined,
  aKey: string,
  bKey: string,
) {
  const at = a ? Date.parse(a) : NaN;
  const bt = b ? Date.parse(b) : NaN;
  const order = (Number.isFinite(bt) ? bt : -Infinity) - (Number.isFinite(at) ? at : -Infinity);
  return (Number.isNaN(order) ? 0 : order) || aKey.localeCompare(bKey);
}
