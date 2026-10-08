import type { Entry } from '@dock/shared';

export type ProviderErrorPresentation = { cause: string; action: string; records: Entry[] };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only unwrap the native Codex error envelope, never arbitrary chat JSON or prose. */
export function providerErrorPresentation(entry: Entry): ProviderErrorPresentation | null {
  if (
    entry.kind !== 'system' ||
    !['Codex reported an error', 'Turn failed'].includes(entry.title) ||
    entry.image ||
    entry.urlRequest ||
    entry.text.length > 16_384
  )
    return null;
  try {
    const envelope: unknown = JSON.parse(entry.text);
    if (
      !record(envelope) ||
      typeof envelope.codexErrorInfo !== 'string' ||
      typeof envelope.message !== 'string'
    )
      return null;
    let cause = envelope.message.trim();
    for (let depth = 0; cause.startsWith('{') && depth < 2; depth++) {
      const nested: unknown = JSON.parse(cause);
      if (!record(nested)) return null;
      if (
        nested.type === 'error' &&
        record(nested.error) &&
        typeof nested.error.message === 'string'
      )
        cause = nested.error.message.trim();
      else if (typeof nested.message === 'string') cause = nested.message.trim();
      else return null;
    }
    if (!cause || cause.startsWith('{') || cause.startsWith('[')) return null;
    const unsupported =
      /^The '([\w.:/+\-]{1,100})' model is not supported when using Codex with a ChatGPT account\.$/.exec(
        cause,
      );
    return {
      cause: unsupported
        ? `Codex rejected ${unsupported[1]}.`
        : cause.length <= 600
          ? cause
          : 'Codex reported an error. Open Details for the full message.',
      action: unsupported
        ? 'Update Codex or choose an available model before trying again.'
        : 'Review the details before continuing.',
      records: [entry],
    };
  } catch {
    return null;
  }
}

/** A display projection only; both saved records remain available in Details. */
export function providerErrorRows(entries: Entry[]) {
  const presentations = new Map<string, ProviderErrorPresentation>();
  const hidden = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (hidden.has(entry.id)) continue;
    const presentation = providerErrorPresentation(entry);
    if (!presentation) continue;
    presentations.set(entry.id, presentation);
    const next = entries[index + 1];
    const elapsed = next ? Date.parse(next.createdAt) - Date.parse(entry.createdAt) : NaN;
    // Completion currently has no runId. Require an adjacent, exact, immediate pair
    // with a bound provider run; never combine later turns, owner messages or imports.
    if (
      entry.title === 'Codex reported an error' &&
      entry.runId &&
      next?.title === 'Turn failed' &&
      next.runId === null &&
      next.agentId === entry.agentId &&
      next.text === entry.text &&
      elapsed >= 0 &&
      elapsed <= 1000 &&
      providerErrorPresentation(next)
    ) {
      presentation.records.push(next);
      hidden.add(next.id);
    }
  }
  return { presentations, hidden };
}
