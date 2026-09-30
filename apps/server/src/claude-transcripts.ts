import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { normalizeClaudeEvent, type ClaudeHook } from './claude-session.js';
import { recordClaudeHelperUsage } from './usage.js';
import { Store, type PrivateRun } from './store.js';

const prefix = 'claude:transcript:';
const sourceSchema = z.object({
  agentId: z.uuid(),
  sessionId: z.uuid(),
  nativeId: z.string(),
  path: z.string(),
  offset: z.number().int().nonnegative(),
  fileId: z.string().nullable(),
  nextReadAt: z.number(),
  retryUntil: z.number(),
  error: z.string().nullable(),
  settled: z.boolean().default(false),
});
const recordSchema = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  timestamp: z.string(),
  type: z.string(),
  uuid: z.string().optional(),
  message: z.record(z.string(), z.unknown()).optional(),
});
const inside = (root: string, path: string) => {
  const sub = relative(root, path);
  return sub !== '' && sub !== '..' && !sub.startsWith(`..${sep}`) && !sub.startsWith(sep);
};

/** Read only paths reported by owned native hooks. The existing host heartbeat
 * catches delayed writes; no recursive account scan, model turn or extra service. */
export class ClaudeTranscripts {
  private pending: Promise<void> | null = null;
  private stopped = false;
  private nextPollAt = 0;
  private readonly projects: string;
  constructor(
    readonly store: Store,
    configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  ) {
    this.projects = resolve(configDir, 'projects');
  }
  register(agentId: string, event: ClaudeHook) {
    const agent = this.store.agent(agentId);
    if (
      !agent.nativeRootId ||
      agent.provider !== 'claude' ||
      !event.agent_id ||
      agent.nativePath !== `${event.session_id}/${event.agent_id}`
    )
      return;
    const reported = event.agent_transcript_path ?? event.transcript_path;
    if (!reported) return;
    const path = resolve(reported.startsWith('~/') ? join(homedir(), reported.slice(2)) : reported);
    // The hook supplies the project folder (which may use a native hash or custom
    // name). Check session/helper ownership, without deriving that folder ourselves.
    if (
      !inside(this.projects, path) ||
      basename(path) !== `agent-${event.agent_id}.jsonl` ||
      basename(dirname(path)) !== 'subagents' ||
      basename(dirname(dirname(path))) !== event.session_id
    )
      return;
    const key = prefix + agentId;
    const previous = sourceSchema.safeParse(this.store.getSetting(key));
    const same = previous.success && previous.data.path === path;
    this.store.setSetting(
      key,
      sourceSchema.parse({
        agentId,
        sessionId: event.session_id,
        nativeId: event.agent_id,
        path,
        offset: same ? previous.data.offset : 0,
        fileId: same ? previous.data.fileId : null,
        nextReadAt: same ? previous.data.nextReadAt : 0,
        retryUntil: Date.now() + 120_000,
        error: same ? previous.data.error : null,
        settled: false,
      }),
    );
  }
  poll() {
    if (this.stopped || this.pending || Date.now() < this.nextPollAt) return;
    this.nextPollAt = Date.now() + 1000;
    this.pending = this.readSources().finally(() => {
      this.pending = null;
    });
  }
  async flush() {
    this.poll();
    await this.pending;
  }
  async close() {
    this.stopped = true;
    await this.pending;
  }
  private async readSources() {
    const rows = this.store.db
      .prepare('SELECT value FROM settings WHERE key LIKE ?')
      .all(`${prefix}%`);
    const sources = rows
      .flatMap((row) => {
        const parsed = sourceSchema.safeParse(JSON.parse(String(row.value)));
        return parsed.success ? [parsed.data] : [];
      })
      .filter(
        (source) =>
          source.nextReadAt <= Date.now() &&
          (!source.settled || this.store.agent(source.agentId).status === 'running'),
      )
      .sort((a, b) => a.nextReadAt - b.nextReadAt)
      .slice(0, 16);
    for (const source of sources) {
      if (this.stopped) return;
      try {
        await this.read(source);
      } catch {
        this.save(source, {
          error:
            'Native helper transcript is unavailable; retained evidence and usage may be partial.',
          settled: this.canSettle(source),
        });
      }
    }
  }
  private save(
    source: z.infer<typeof sourceSchema>,
    updates: Partial<z.infer<typeof sourceSchema>>,
  ) {
    // A hook can arrive during the async read. Do not discard its later retry window.
    const current = sourceSchema.parse(this.store.getSetting(prefix + source.agentId));
    if (current.path !== source.path) return;
    this.store.setSetting(prefix + source.agentId, {
      ...current,
      ...updates,
      nextReadAt: Date.now() + 10_000,
    });
  }
  private canSettle(source: z.infer<typeof sourceSchema>) {
    const current = sourceSchema.parse(this.store.getSetting(prefix + source.agentId));
    return (
      current.retryUntil <= Date.now() && this.store.agent(source.agentId).status !== 'running'
    );
  }
  private async read(source: z.infer<typeof sourceSchema>) {
    const root = await realpath(this.projects),
      path = await realpath(source.path);
    if (
      !inside(root, path) ||
      basename(path) !== `agent-${source.nativeId}.jsonl` ||
      basename(dirname(path)) !== 'subagents' ||
      basename(dirname(dirname(path))) !== source.sessionId
    )
      throw new Error('Transcript ownership changed');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Not a regular transcript');
      const fileId = `${stat.dev}:${stat.ino}`;
      let offset = source.fileId === fileId && stat.size >= source.offset ? source.offset : 0;
      if (offset === stat.size) {
        this.save(source, { error: null, fileId, offset, settled: this.canSettle(source) });
        return;
      }
      const buffer = Buffer.alloc(Math.min(2 * 1024 * 1024, stat.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const complete = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (complete < 0) {
        this.save(source, {
          error:
            bytesRead === 2 * 1024 * 1024
              ? 'A native transcript record exceeds the observation limit; usage remains partial.'
              : this.canSettle(source)
                ? 'A native transcript record was not fully written; usage remains partial.'
                : null,
          settled: this.canSettle(source),
        });
        return; // Retry a trailing, incompletely flushed JSON line later.
      }
      const records = buffer.subarray(0, complete).toString('utf8').split('\n');
      const runs = this.store
        .runs()
        .filter(
          (run) =>
            run.agentId === source.agentId &&
            run.key.startsWith(`native:claude:${source.agentId}:`),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      this.store.transaction(() => {
        for (const line of records) {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          this.observe(source, value, runs);
        }
        offset += complete + 1;
        this.save(source, {
          offset,
          fileId,
          error: null,
          settled: offset === stat.size && this.canSettle(source),
        });
      });
    } finally {
      await file.close();
    }
  }
  private observe(source: z.infer<typeof sourceSchema>, raw: unknown, runs: PrivateRun[]) {
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (
      frame.sessionId !== source.sessionId ||
      frame.agentId !== source.nativeId ||
      !['assistant', 'user'].includes(frame.type) ||
      !frame.message
    )
      return;
    const timestamp = Date.parse(frame.timestamp);
    if (!Number.isFinite(timestamp)) return;
    const run = runs.find((run) => Date.parse(run.createdAt) <= timestamp);
    if (!run) return; // Inherited/pre-registration history is not new task spending.
    let events;
    try {
      events = normalizeClaudeEvent({ ...frame, session_id: source.sessionId });
    } catch {
      return;
    } // Unknown native shapes do not invalidate the owned session.
    const agent = this.store.agent(source.agentId);
    if (frame.type === 'assistant') {
      recordClaudeHelperUsage(
        this.store,
        agent.id,
        run.id,
        source.sessionId,
        source.nativeId,
        frame.message,
      );
      const model = frame.message.model;
      if (
        typeof model === 'string' &&
        model.length > 0 &&
        model.length <= 100 &&
        model !== '<synthetic>' &&
        agent.model !== model
      )
        this.store.updateAgent(agent.id, { model, modelSelection: 'native' });
    }
    for (const event of events) {
      if (event.type !== 'message' && event.type !== 'tool' && event.type !== 'tool_result')
        continue;
      if (event.type === 'message' && event.role === 'user') continue;
      const entryId =
        event.type === 'message'
          ? `${agent.id}:claude:transcript:${event.id}`
          : `${agent.id}:claude:${event.id}`;
      const previous = this.store.savedEntry(agent.id, entryId);
      if (previous && !(event.type === 'tool_result' && previous.status === 'observed')) continue;
      const text = event.type === 'tool' ? JSON.stringify(event.input, null, 2) : event.text;
      this.store.entry({
        id: entryId,
        agentId: agent.id,
        runId: run.id,
        kind: event.type === 'message' ? 'assistant' : 'tool',
        title:
          event.type === 'message'
            ? 'Saved native helper reply'
            : event.type === 'tool'
              ? event.name
              : (previous?.title ?? 'Saved native tool result'),
        text: text.slice(0, 200_000),
        status:
          event.type === 'tool'
            ? 'observed'
            : event.type === 'tool_result' && event.isError
              ? 'failed'
              : 'complete',
        createdAt: new Date(timestamp).toISOString(),
      });
    }
  }
}
