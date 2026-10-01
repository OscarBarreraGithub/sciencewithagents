/** Provenance for app-created sessions; this is not a native visibility flag. */
export const managedCodexSource = 'sciencewithagents';

/** Personal chat pickers exclude helpers, but their task transcripts remain saved. */
export function isBackgroundCodexThread(thread: {
  source?: unknown;
  threadSource?: unknown;
  parentThreadId?: unknown;
  ephemeral?: unknown;
  canAcceptDirectInput?: unknown;
}) {
  const source = thread.source;
  return (
    thread.ephemeral === true ||
    thread.canAcceptDirectInput === false ||
    typeof thread.parentThreadId === 'string' ||
    thread.threadSource === managedCodexSource ||
    (typeof source === 'string' && source.startsWith('subAgent')) ||
    (source !== null &&
      typeof source === 'object' &&
      ('subAgent' in source || 'subagent' in source))
  );
}
