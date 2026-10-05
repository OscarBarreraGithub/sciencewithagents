import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  archiveEditorsSchema,
  archiveItemSchema,
  archivePageSchema,
  archiveQuerySchema,
  archiveReadSchema,
  mirrorWindowSchema,
  type ArchiveItem,
  type ArchiveQuery,
  type ArchiveRead,
  type HistoryItem,
  type MirrorPageQuery,
  type MirrorState,
} from '@dock/shared';
import { ownerHistoryPage, ownerHistoryRead } from './history.js';
import { Conflict, Missing, type Store } from './store.js';
import type { VscodeMirrors } from './vscode-mirror.js';

const editorCursorSchema = z
  .object({
    scope: z.string().length(64),
    before: z.string().max(2048).optional(),
    activity: z.string().max(2048).optional(),
    activityBefore: z.string().max(2048).optional(),
    entry: z
      .object({
        id: z.string().max(2048),
        offset: z.number().int().positive(),
        role: z.enum(['user', 'assistant', 'activity']),
        tail: z.string().max(199),
      })
      .strict()
      .optional(),
  })
  .strict();
type EditorCursor = z.infer<typeof editorCursorSchema>;
type Mirrors = Pick<VscodeMirrors, 'windows' | 'list' | 'read'>;
const editorNotice =
  'Read-only scan of the selected available native thread, including message parts and grouped tool activity. Follow every page even when it has no matches. New native entries require refresh. Offline/unshared VS Code histories, other computers, unsent drafts and hidden reasoning are not searched.';

/** Literal, paged archive review. No model queue, native resume, or filesystem scan. */
export class Archive {
  constructor(
    readonly store: Store,
    private mirrors: Mirrors,
  ) {}
  async editors() {
    return archiveEditorsSchema.parse({
      windows: await this.mirrors.list(),
      notice:
        'Available shared VS Code and loaded Codex server threads on this computer. Offline or unshared histories are not an exhaustive native catalog; reconnect/share them to review their transcript.',
    });
  }
  private managed(item: HistoryItem): ArchiveItem {
    const agent = this.store.agent(item.agentId);
    return archiveItemSchema.parse({
      source: 'managed',
      recordType: item.source,
      id: item.id,
      agentId: item.agentId,
      projectId: item.projectId,
      windowId: null,
      threadId: null,
      provider: agent.provider,
      role: item.kind,
      title: `${agent.name}: ${item.title}`.slice(0, 500),
      text: item.text,
      offset: item.offset,
      totalCharacters: item.totalCharacters,
      nextOffset: item.nextOffset,
      href: `#/chat/${item.agentId}`,
    });
  }
  private window(input: ArchiveQuery | ArchiveRead) {
    const selected = this.mirrors
      .windows()
      .map((value) => mirrorWindowSchema.parse(value))
      .find((window) => window.windowId === input.windowId);
    if (!selected)
      throw new Missing('This editor connection is unavailable. Reconnect or share it again.');
    if (selected.threadId !== input.threadId || (selected.provider ?? 'codex') !== input.provider)
      throw new Conflict(
        'The editor selected a different thread. Refresh archive sources; this scan was not continued into another conversation.',
      );
    if (selected.status === 'offline')
      throw new Missing(
        'This editor is offline. Its transcript was not searched. Reconnect and retry this page.',
      );
    return selected;
  }
  private async native(
    input: ArchiveQuery | ArchiveRead,
    page: MirrorPageQuery,
  ): Promise<MirrorState> {
    this.window(input);
    const state = await this.mirrors.read(input.windowId!, page);
    if (
      state.windowId !== input.windowId ||
      state.threadId !== input.threadId ||
      (state.provider ?? 'codex') !== input.provider
    )
      throw new Conflict(
        'The editor thread changed during the read. Refresh sources; no replacement transcript was searched.',
      );
    if (state.page?.reset)
      throw new Conflict(
        'Native history changed or this cursor is unavailable. Restart the scan; no entries were silently skipped.',
      );
    if (state.historyUnavailable || state.status === 'offline')
      throw new Missing(
        'Native history is unavailable. It was not treated as an empty or completed archive. Reconnect and retry this page.',
      );
    return state;
  }
  private editorItem(
    input: ArchiveQuery | ArchiveRead,
    state: MirrorState,
    entry: MirrorState['entries'][number],
    text = entry.text,
    offset = entry.textOffset ?? 0,
  ): ArchiveItem {
    const total = entry.textLength ?? entry.text.length;
    return archiveItemSchema.parse({
      source: 'editor',
      recordType: 'entry',
      id: entry.id,
      agentId: null,
      projectId: null,
      windowId: input.windowId,
      threadId: input.threadId,
      provider: input.provider,
      role: entry.role,
      title: state.title || state.label || 'Editor conversation',
      text,
      offset,
      totalCharacters: total,
      nextOffset: offset + text.length < total ? offset + text.length : null,
      href: `#/chats/vscode/${input.provider}:${encodeURIComponent(input.threadId!)}`,
    });
  }
  async read(raw: unknown) {
    const input = archiveReadSchema.parse(raw);
    if (input.source === 'managed')
      return this.managed(
        ownerHistoryRead(this.store, {
          source: input.recordType,
          id: input.id,
          offset: input.offset,
          limit: input.limit,
        }),
      );
    if (input.recordType !== 'entry')
      throw new Conflict('Editor archives contain transcript entries, not app decisions.');
    const state = await this.native(input, { entry: input.id, offset: input.offset });
    const entry = state.entries.find((entry) => entry.id === input.id);
    if (!entry || (entry.textOffset ?? 0) !== input.offset)
      throw new Conflict(
        'The requested native message part is unavailable. Read it again from the beginning.',
      );
    return this.editorItem(input, state, entry, entry.text.slice(0, input.limit));
  }
  async page(raw: unknown) {
    const input = archiveQuerySchema.parse(raw);
    if (input.source === 'managed') {
      const page = ownerHistoryPage(this.store, {
        query: input.query,
        cursor: input.cursor,
        limit: input.limit,
      });
      return archivePageSchema.parse({
        items: page.items.map((item) => this.managed(item)),
        nextCursor: page.nextCursor,
        complete: page.nextCursor === null,
        scannedEntries: page.items.length,
        notice:
          'All retained visible app entries and decisions on this computer, including archived projects and workers. Literal text search examines full retained text; results are previews. Follow pages to completion and open parts to read original wording. ' +
          page.notice,
      });
    }
    const scope = createHash('sha256')
      .update(JSON.stringify([input.windowId, input.threadId, input.provider, input.query]))
      .digest('hex');
    let cursor: EditorCursor = { scope };
    if (input.cursor) {
      try {
        cursor = editorCursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')),
        );
      } catch {
        throw new Conflict('Invalid native archive cursor. Restart the scan.');
      }
      if (cursor.scope !== scope)
        throw new Conflict('Native archive cursor belongs to a different thread or search.');
    }
    const query: MirrorPageQuery = cursor.entry
      ? { entry: cursor.entry.id, offset: cursor.entry.offset }
      : cursor.activity
        ? {
            activity: cursor.activity,
            ...(cursor.activityBefore ? { before: cursor.activityBefore } : {}),
          }
        : cursor.before
          ? { before: cursor.before }
          : {};
    const state = await this.native(input, query);
    if (!state.page)
      throw new Conflict(
        'This native connection did not provide a bounded history page. Update/reconnect the companion before continuing.',
      );
    const items: ArchiveItem[] = [];
    let next: EditorCursor | null = null,
      scannedEntries = 0;
    const entries = state.entries.toReversed();
    if (
      cursor.entry &&
      (entries.length !== 1 ||
        entries[0]!.id !== cursor.entry.id ||
        (entries[0]!.textOffset ?? 0) !== cursor.entry.offset)
    )
      throw new Conflict('This native message part changed. Restart the scan.');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.activityGroup && !cursor.activity && !cursor.entry) {
        next = { scope, before: entry.id, activity: entry.id };
        break;
      }
      scannedEntries++;
      const offset = entry.textOffset ?? 0,
        total = entry.textLength ?? entry.text.length;
      const tail = cursor.entry?.tail ?? '';
      const text = tail + entry.text;
      const match = input.query ? text.toLowerCase().indexOf(input.query.toLowerCase()) : 0;
      if (match >= 0) {
        const start = Math.max(0, match - 100);
        const item = this.editorItem(
          input,
          state,
          entry,
          text.slice(start, start + 1200),
          Math.max(0, offset - tail.length + start),
        );
        items.push(item);
      }
      if (offset + entry.text.length < total) {
        if (!entry.text.length)
          throw new Conflict(
            'Native history made no progress through this message. Restart the scan.',
          );
        next = {
          scope,
          before: cursor.before,
          ...(cursor.activity
            ? { activity: cursor.activity, activityBefore: entry.id }
            : { before: entry.id }),
          entry: {
            id: entry.id,
            offset: offset + entry.text.length,
            role: entry.role,
            tail: input.query.length > 1 ? text.slice(-(input.query.length - 1)) : '',
          },
        };
        break;
      }
      if (cursor.entry) {
        next = {
          scope,
          before: cursor.before,
          ...(cursor.activity
            ? { activity: cursor.activity, activityBefore: cursor.activityBefore }
            : {}),
        };
        break;
      }
      // A selected page can exceed the requested result count. Resume at the last
      // consumed original ID, so neither unmatched rows nor remaining results vanish.
      if (items.length >= input.limit && i < entries.length - 1) {
        next = {
          scope,
          ...(cursor.activity
            ? { before: cursor.before, activity: cursor.activity, activityBefore: entry.id }
            : { before: entry.id }),
        };
        break;
      }
    }
    if (!next) {
      if (cursor.activity)
        next = state.page.before
          ? {
              scope,
              before: cursor.before,
              activity: cursor.activity,
              activityBefore: state.page.before,
            }
          : { scope, before: cursor.before };
      else if (state.page.before) next = { scope, before: state.page.before };
    }
    const nextCursor = next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null;
    return archivePageSchema.parse({
      items,
      nextCursor,
      complete: nextCursor === null,
      scannedEntries,
      notice: editorNotice,
    });
  }
}

export function registerArchiveRoutes(app: FastifyInstance, archive: Archive) {
  app.get('/api/archive/editors', () => archive.editors());
  app.post('/api/archive/search', (request) => archive.page(request.body));
  app.post('/api/archive/read', (request) => archive.read(request.body));
}
