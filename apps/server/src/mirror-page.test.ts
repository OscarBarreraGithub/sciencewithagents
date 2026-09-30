import { describe, expect, it } from 'vitest';
import { mirrorPage, mirrorPageQuerySchema, type MirrorState } from '@dock/shared';
import { randomUUID } from 'node:crypto';

const state: MirrorState = {
  windowId: randomUUID(),
  label: 'Fixture',
  threadId: 'long-history',
  title: 'Long history',
  status: 'idle',
  message: '',
  entries: Array.from({ length: 6309 }, (_, i) => ({
    id: `entry-${i}`,
    role: i % 12 ? ('activity' as const) : ('assistant' as const),
    text: `Entry ${i}\n${'text '.repeat(650)}`,
  })),
};

describe('bounded editor history', () => {
  it('keeps the newest entries, pages both ways without gaps, and limits total text', () => {
    const latest = mirrorPage(state);
    expect(latest.entries.at(-1)?.activityGroup?.count).toBe(8);
    expect(latest.entries.length).toBeLessThanOrEqual(40);
    expect(latest.entries.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(64_000);
    expect(latest.page?.total).toBe(6309);
    const older = mirrorPage(state, { before: latest.page!.before });
    const newer = mirrorPage(state, { after: older.page!.after });
    expect(new Set([...older.entries, ...latest.entries].map((e) => e.id)).size).toBe(
      older.entries.length + latest.entries.length,
    );
    expect(newer.entries).toEqual(latest.entries);
    const appended = {
      ...state,
      entries: [...state.entries, { id: 'live', role: 'assistant' as const, text: 'Live reply' }],
    };
    expect(mirrorPage(appended, { before: latest.page!.before }).entries).toEqual(older.entries);
    expect(mirrorPage(appended).entries.at(-1)?.text).toBe('Live reply');
    expect(state.entries).toHaveLength(6309);
    let page = latest;
    const messages = latest.entries.filter((entry) => entry.role !== 'activity');
    while (page.page?.before) {
      page = mirrorPage(state, { before: page.page.before });
      messages.unshift(...page.entries.filter((entry) => entry.role !== 'activity'));
    }
    expect(messages).toEqual(state.entries.filter((entry) => entry.role !== 'activity'));
  });
  it('keeps messages visible through a long tool burst and expands every original action', () => {
    const entries: MirrorState['entries'] = [
      { id: 'question', role: 'user', text: 'Keep working on this goal.' },
      { id: 'commentary', role: 'assistant', text: 'I am checking the result.' },
      ...Array.from({ length: 1500 }, (_, i) => ({
        id: `tool-${i}`,
        role: 'activity' as const,
        text: `commandExecution\n${'original output '.repeat(100)}`,
      })),
    ];
    const source = { ...state, status: 'busy' as const, entries };
    const latest = mirrorPage(source);
    expect(latest.entries.map((entry) => entry.id)).toEqual(['question', 'commentary', 'tool-0']);
    expect(latest.entries.at(-1)?.activityGroup).toEqual({ count: 1500 });
    expect(JSON.stringify(latest).length).toBeLessThan(1000);
    const group = 'tool-0';
    let page = mirrorPage(source, { activity: group });
    const tools = [...page.entries];
    while (page.page?.before) {
      page = mirrorPage(source, { activity: group, before: page.page.before });
      tools.unshift(...page.entries);
    }
    expect(tools).toEqual(entries.slice(2));
    source.entries.push({ id: 'tool-new', role: 'activity', text: 'webSearch\nnext search' });
    expect(mirrorPage(source).entries.at(-1)).toMatchObject({
      id: group,
      activityGroup: { count: 1501 },
    });
    source.entries.push({ id: 'answer', role: 'assistant', text: 'Finished the check.' });
    expect(mirrorPage(source).entries.at(-1)?.id).toBe('answer');
    expect(mirrorPage(source, { activity: 'question' }).page?.reset).toBe(true);
  });
  it('reads every part of a huge entry without truncating the original or sending it all', () => {
    const text = 'large tool output '.repeat(30_000);
    const source = { ...state, entries: [{ id: 'huge', role: 'activity' as const, text }] };
    const parts: string[] = [];
    for (let offset = 0; offset < text.length; offset += 8000) {
      const page = mirrorPage(source, { entry: 'huge', offset });
      expect(page.entries[0].text.length).toBeLessThanOrEqual(8000);
      expect(page.entries[0].textLength).toBe(text.length);
      parts.push(page.entries[0].text);
    }
    expect(parts.join('')).toBe(text);
    expect(source.entries[0].text).toBe(text);
  });
  it('reports a changed cursor and rejects ambiguous or unbounded queries', () => {
    expect(mirrorPage(state, { before: 'removed' }).page?.reset).toBe(true);
    expect(mirrorPage(state, { entry: 'entry-6308', offset: 1_000_000 }).page?.reset).toBe(true);
    for (const query of [
      { before: 'x', after: 'y' },
      { offset: 2 },
      { entry: 'x', offset: -1 },
      { entry: 'x', activity: 'y' },
      { limit: 100000 },
    ])
      expect(mirrorPageQuerySchema.safeParse(query).success).toBe(false);
  });
});
