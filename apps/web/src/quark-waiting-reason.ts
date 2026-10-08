/** Plain board/chat reason; full calculation belongs in Details. */
export function compactQuarkReason(message: string) {
  const text = message.replace(/\s+/g, ' ').trim();
  const pacedWindow = /^Pacing ([^:]{1,80}):/.exec(text)?.[1];
  if (pacedWindow)
    return `Paused to spread ${pacedWindow} allowance until reset. QUARK retries automatically.`;
  if (text.length <= 140) return text;
  return /^.{1,140}?[.!?](?= )/.exec(text)?.[0] ?? `${text.slice(0, 139).replace(/ \S*$/, '')}…`;
}
