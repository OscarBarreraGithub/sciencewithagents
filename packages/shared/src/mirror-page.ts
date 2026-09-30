import type { MirrorPageQuery, MirrorState } from './mirror.js';

const entryLimit = 40;
const textLimit = 8000;
const pageTextLimit = 64_000;

/** A tool burst occupies one place in the conversation, however many calls it contains. */
function conversationRows(entries: MirrorState['entries']): MirrorState['entries'] {
  const rows: MirrorState['entries'] = [];
  for (let i = 0; i < entries.length; i++) {
    const first = entries[i];
    if (first.role !== 'activity' || first.activityGroup) {
      rows.push(first);
      continue;
    }
    let last = i;
    while (last + 1 < entries.length && entries[last + 1].role === 'activity') last++;
    rows.push({
      id: first.id,
      role: 'activity',
      text: entries[last].text.split('\n', 1)[0].slice(0, 180),
      activityGroup: { count: last - i + 1 },
    });
    i = last;
  }
  return rows;
}

/** Bound payload and display rows; original tools are retrieved only on expansion. */
export function mirrorPage(state: MirrorState, query: MirrorPageQuery = {}): MirrorState {
  if (query.entry) return pageEntries(state, query);
  if (query.activity) {
    const start = state.entries.findIndex((entry) => entry.id === query.activity);
    if (start < 0 || state.entries[start].role !== 'activity') {
      return { ...state, entries: [], page: { total: 0, reset: true } };
    }
    let end = start + 1;
    while (end < state.entries.length && state.entries[end].role === 'activity') end++;
    return pageEntries({ ...state, entries: state.entries.slice(start, end) }, query);
  }
  const page = pageEntries({ ...state, entries: conversationRows(state.entries) }, query);
  return { ...page, page: { ...page.page!, total: state.entries.length } };
}

function pageEntries(state: MirrorState, query: MirrorPageQuery): MirrorState {
  const entries = state.entries;
  const cursor = query.entry ?? query.before ?? query.after;
  if (cursor && !entries.some((entry) => entry.id === cursor)) {
    const latest = pageEntries(state, {});
    return { ...latest, page: { ...latest.page!, reset: true } };
  }
  const index = (id: string) => {
    const found = entries.findIndex((entry) => entry.id === id);
    if (found < 0) throw new Error('This history position changed. Return to latest messages.');
    return found;
  };
  const excerpt = (entry: MirrorState['entries'][number], offset = 0) => ({
    ...entry,
    text: entry.text.slice(offset, offset + textLimit),
    ...(entry.text.length > textLimit ? { textOffset: offset, textLength: entry.text.length } : {}),
  });
  if (query.entry) {
    const entry = entries[index(query.entry)];
    const offset = query.offset ?? 0;
    if (offset >= entry.text.length && offset !== 0)
      return { ...state, entries: [excerpt(entry)], page: { total: entries.length, reset: true } };
    return { ...state, entries: [excerpt(entry, offset)], page: { total: entries.length } };
  }
  let start = query.after ? index(query.after) + 1 : 0;
  let end = query.before ? index(query.before) : entries.length;
  const selected: MirrorState['entries'] = [];
  let size = 0;
  const forward = !!query.after;
  for (let i = forward ? start : end - 1; i >= start && i < end; i += forward ? 1 : -1) {
    const entry = excerpt(entries[i]);
    if (
      selected.length &&
      (selected.length >= entryLimit || size + entry.text.length > pageTextLimit)
    )
      break;
    selected.push(entry);
    size += entry.text.length;
  }
  if (forward) end = start + selected.length;
  else {
    start = end - selected.length;
    selected.reverse();
  }
  return {
    ...state,
    entries: selected,
    page: {
      total: entries.length,
      ...(start > 0 && selected.length ? { before: selected[0].id } : {}),
      ...(end < entries.length && selected.length
        ? { after: selected[selected.length - 1].id }
        : {}),
    },
  };
}
