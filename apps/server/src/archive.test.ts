import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  mirrorPage,
  mirrorWindowSchema,
  type MirrorPageQuery,
  type MirrorState,
  type ArchiveQuery,
} from '@dock/shared';
import { Store, Conflict } from './store.js';
import { Archive, registerArchiveRoutes } from './archive.js';
import { historyPage } from './history.js';

let root: string, store: Store, archive: Archive, state: MirrorState;
let calls: MirrorPageQuery[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dock-archive-'));
  store = new Store(join(root, 'dock.sqlite'));
  state = {
    windowId: randomUUID(),
    provider: 'claude',
    threadId: 'original-native-thread',
    label: 'Editor',
    title: 'Native conversation',
    status: 'idle',
    message: '',
    entries: [],
    paged: true,
    groupedActivity: true,
  };
  calls = [];
  archive = new Archive(store, {
    windows: () => [mirrorWindowSchema.parse(state)],
    list: async () => [mirrorWindowSchema.parse(state)],
    read: async (_id, page) => {
      calls.push(page ?? {});
      return mirrorPage(state, page);
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
const editor = () => ({
  source: 'editor' as const,
  windowId: state.windowId,
  provider: state.provider!,
  threadId: state.threadId!,
});
async function scan(input: Partial<ArchiveQuery> & Pick<ArchiveQuery, 'source'>) {
  const items = [];
  let cursor: string | null = null,
    pages = 0,
    empty = 0;
  do {
    const page = await archive.page({ ...input, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor;
    pages++;
    if (!page.items.length) empty++;
    expect(pages).toBeLessThan(150);
  } while (cursor);
  return { items, pages, empty };
}
it('searches and pages all retained app evidence beyond recent project/chat/excerpt limits, with stable IDs after restart', async () => {
  const ids: string[] = [];
  let manager = '';
  for (let project = 0; project < 25; project++) {
    const p = store.register(join(root, String(project)), `Project ${project}`, '');
    manager = p.managerId;
    for (let entry = 0; entry < 7; entry++) {
      const id = randomUUID();
      ids.push(id);
      store.entry({
        id,
        agentId: manager,
        runId: null,
        kind: 'user',
        title: 'Unrelated title',
        text: 'a'.repeat(25000) + ` archive-needle ${project}-${entry}`,
        status: 'complete',
        createdAt: '2026-10-05T12:00:00.000Z',
      });
    }
  }
  const first = await archive.page({ source: 'managed', query: 'archive-needle', limit: 13 });
  expect(first.items).toHaveLength(13);
  expect(first.complete).toBe(false);
  const collected = first.items.map((item) => item.id);
  let cursor = first.nextCursor;
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  archive = new Archive(store, {
    windows: () => [],
    list: async () => [],
    read: async () => {
      throw new Error('No native reads for app history');
    },
  });
  store.enqueue(manager, randomUUID(), 'New archive-needle arriving during scan');
  while (cursor) {
    const page = await archive.page({
      source: 'managed',
      query: 'archive-needle',
      limit: 13,
      cursor,
    });
    collected.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  }
  expect(collected).toEqual(ids.toReversed());
  expect(new Set(collected).size).toBe(175);
  expect(first.items[0]!.offset).toBeGreaterThan(24000);
  const read = await archive.read({ source: 'managed', id: ids[0], offset: 24000 });
  expect(read.text).toContain('archive-needle 0-0');
  expect(read.id).toBe(ids[0]);
  expect(() =>
    historyPage(store, store.agent(manager).projectId, {
      query: 'archive-needle',
      cursor: first.nextCursor,
    }),
  ).toThrow(Conflict);
  await expect(
    archive.page({ source: 'managed', query: 'changed', cursor: first.nextCursor }),
  ).rejects.toThrow('different project or search');
  expect(calls).toHaveLength(0);
});
it('exhausts native conversation rows, grouped tool activity and long message parts without omission or duplicate rows', async () => {
  state.entries = [
    ...Array.from({ length: 95 }, (_, i) => ({
      id: `old-${i}`,
      role: 'user' as const,
      text: `Old ${i}`,
    })),
    ...Array.from({ length: 85 }, (_, i) => ({
      id: `activity-${i}`,
      role: 'activity' as const,
      text: `Full tool result ${i}`,
    })),
    { id: 'long-message', role: 'assistant', text: 'z'.repeat(25000) },
    ...Array.from({ length: 95 }, (_, i) => ({
      id: `new-${i}`,
      role: 'assistant' as const,
      text: `New ${i}`,
    })),
  ];
  const result = await scan({ ...editor(), query: '', limit: 7 });
  expect(new Set(result.items.map((item) => item.id))).toEqual(
    new Set(state.entries.map((entry) => entry.id)),
  );
  for (const entry of state.entries.filter((entry) => entry.id !== 'long-message'))
    expect(result.items.filter((item) => item.id === entry.id)).toHaveLength(1);
  expect(result.items.filter((item) => item.id === 'long-message')).toHaveLength(4);
  expect(calls.some((query) => query.activity === 'activity-0')).toBe(true);
  let offset = 0,
    text = '';
  do {
    const part = await archive.read({ ...editor(), id: 'long-message', offset });
    text += part.text;
    offset = part.nextOffset ?? -1;
  } while (offset >= 0);
  expect(text).toBe('z'.repeat(25000));
});
it('finds literal matches beyond native title/previews and across chunk boundaries, while empty pages retain continuation', async () => {
  state.entries = [
    { id: 'old-match', role: 'user', text: 'needle-at-start' },
    ...Array.from({ length: 110 }, (_, i) => ({
      id: `no-match-${i}`,
      role: 'assistant' as const,
      text: 'Nothing here',
    })),
    {
      id: 'boundary',
      role: 'assistant',
      text: 'a'.repeat(7997) + 'cross-boundary-needle' + 'z'.repeat(9000),
    },
  ];
  const found = await scan({ ...editor(), query: 'cross-boundary-needle' });
  expect(found.items.map((item) => item.id)).toEqual(['boundary']);
  expect(found.items[0]!.offset).toBeGreaterThan(7800);
  expect(found.items[0]!.text).toContain('cross-boundary-needle');
  expect(found.empty).toBeGreaterThan(1);
  expect(
    (await scan({ ...editor(), query: 'needle-at-start' })).items.map((item) => item.id),
  ).toEqual(['old-match']);
});
it('refuses stale/foreign cursors and reports offline/unavailable native coverage without calling it empty', async () => {
  state.entries = Array.from({ length: 60 }, (_, i) => ({
    id: `entry-${i}`,
    role: 'user' as const,
    text: 'saved',
  }));
  const selection = editor();
  const first = await archive.page({ ...selection, query: 'saved' });
  await expect(
    archive.page({ ...selection, query: 'changed', cursor: first.nextCursor }),
  ).rejects.toThrow('different thread or search');
  state.status = 'offline';
  await expect(
    archive.page({ ...selection, cursor: first.nextCursor, query: 'saved' }),
  ).rejects.toThrow('offline');
  state.status = 'idle';
  state.historyUnavailable = true;
  await expect(archive.page({ ...selection })).rejects.toThrow('not treated as an empty');
  state.historyUnavailable = false;
  state.threadId = 'different-native-thread';
  await expect(archive.page({ ...selection })).rejects.toThrow('different thread');
  state.threadId = selection.threadId;
  state.entries = state.entries.slice(45);
  await expect(
    archive.page({ ...selection, query: 'saved', cursor: first.nextCursor }),
  ).rejects.toThrow('silently skipped');
});
it('exposes only typed read/search routes and reports missing offline catalog coverage, without enqueue', async () => {
  const app = Fastify();
  registerArchiveRoutes(app, archive);
  try {
    const sources = (await app.inject('/api/archive/editors')).json();
    expect(sources.notice).toContain('unshared histories');
    expect(sources.windows[0].windowId).toBe(state.windowId);
    const result = await app.inject({
      method: 'POST',
      url: '/api/archive/search',
      payload: { source: 'managed', query: 'no saved messages' },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ items: [], complete: true, nextCursor: null });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/archive/search',
          payload: { source: 'managed', path: '/tmp/private' },
        })
      ).statusCode,
    ).toBe(500);
    expect(store.runs()).toEqual([]);
    expect(calls).toEqual([]);
  } finally {
    await app.close();
  }
});
