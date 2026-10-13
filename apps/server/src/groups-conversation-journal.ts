import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { constants, openSync, closeSync, fstatSync, lstatSync } from 'node:fs';
import { z } from 'zod';
import {
  groupConversationSelectionSchema,
  groupConversationStopSchema,
} from '@dock/shared/dist/group-conversation-sharing.js';
import { groupConversationIdSchema } from '@dock/shared/dist/group-conversation-sharing.js';

const selectionSchema = groupConversationSelectionSchema.extend({
  enabled: z.boolean(),
  generation: z.number().int().positive(),
});
export type ConversationSelection = z.infer<typeof selectionSchema>;
const stopResultSchema = selectionSchema.partial().extend({
  outcome: z.enum(['stopped', 'superseded']),
});
const stateSchema = z.strictObject({
  state: z.enum(['queued', 'summarizing', 'ready', 'published', 'skipped', 'unknown']),
  message: z.string().max(500),
  summary: z.string().max(1200).optional(),
  model: z.string().max(200).optional(),
  generation: z.number().int().positive().optional(),
  retries: z.number().int().nonnegative().optional(),
  nextAttemptAt: z.number().int().nonnegative().optional(),
});
export type ConversationJobState = z.infer<typeof stateSchema>;
export type ConversationJob = {
  id: string;
  handle: string;
  sessionId: string;
  generation: number;
  text: string;
};

/** Owner-account-only state outside plugin caches/work folders. No provider launch here. */
export class GroupsConversationJournal {
  readonly db: DatabaseSync;
  constructor(root: string) {
    const directory = lstatSync(root);
    if (
      !directory.isDirectory() ||
      directory.mode & 0o022 ||
      (process.getuid && directory.uid !== process.getuid())
    )
      throw new Error('Use the owner’s SWA data directory without group/other write access.');
    const file = join(root, 'groups-conversations.sqlite');
    const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
        throw new Error('Groups sharing journal must be private.');
    } finally {
      closeSync(fd);
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=500;
      CREATE TABLE IF NOT EXISTS gc_selections(seq INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, handle TEXT NOT NULL, input TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gc_prompts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL, selection_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS gc_jobs(id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, handle TEXT NOT NULL, session_id TEXT NOT NULL, generation INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gc_states(seq INTEGER PRIMARY KEY, id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gc_attempts(id TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gc_sessions(session_id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gc_batches(id TEXT PRIMARY KEY, text TEXT NOT NULL, members TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gc_closures(key TEXT PRIMARY KEY, handle TEXT NOT NULL, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gc_stops(key TEXT PRIMARY KEY, handle TEXT NOT NULL, target_generation INTEGER, result TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gc_states_id ON gc_states(id,seq);
      CREATE INDEX IF NOT EXISTS gc_jobs_handle ON gc_jobs(handle);
      CREATE INDEX IF NOT EXISTS gc_selections_handle ON gc_selections(handle,seq);
    `);
    if (
      !this.db
        .prepare('PRAGMA table_info(gc_prompts)')
        .all()
        .some((row) => row.name === 'selection_seq')
    )
      this.db.exec('ALTER TABLE gc_prompts ADD COLUMN selection_seq INTEGER NOT NULL DEFAULT 0');
    for (const table of [
      'gc_selections',
      'gc_prompts',
      'gc_jobs',
      'gc_states',
      'gc_attempts',
      'gc_sessions',
      'gc_batches',
      'gc_closures',
      'gc_stops',
    ]) {
      this.db
        .exec(`CREATE TRIGGER IF NOT EXISTS ${table}_retain BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'retained Groups receipt'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable Groups receipt'); END;`);
    }
  }
  close() {
    this.db.close();
  }
  registerSession(sessionId: string) {
    groupConversationIdSchema.parse(sessionId);
    this.db.prepare('INSERT OR IGNORE INTO gc_sessions VALUES(?,?)').run(sessionId, Date.now());
  }
  selections(): ConversationSelection[] {
    return this.db
      .prepare(
        'SELECT seq,input FROM gc_selections s WHERE seq=(SELECT MAX(seq) FROM gc_selections WHERE handle=s.handle)',
      )
      .all()
      .map((row) =>
        selectionSchema.parse({ ...JSON.parse(String(row.input)), generation: Number(row.seq) }),
      );
  }
  selection(handle: string) {
    return this.selections().find((value) => value.handle === handle);
  }
  closurePending(handle: string) {
    const selected = this.selection(handle);
    return (
      !!selected &&
      (selected.enabled ||
        !this.db
          .prepare('SELECT 1 FROM gc_closures WHERE handle=? AND generation=?')
          .get(handle, selected.generation))
    );
  }
  confirmClosed(raw: unknown) {
    const input = z
      .strictObject({ handle: z.uuid(), key: z.uuid(), generation: z.number().int().positive() })
      .parse(raw);
    const prior = this.db
      .prepare('SELECT handle,generation FROM gc_closures WHERE key=?')
      .get(input.key);
    if (prior) {
      if (prior.handle !== input.handle || Number(prior.generation) !== input.generation)
        throw new Error('Retry the exact retained conversation closure confirmation.');
      return { closed: true };
    }
    const selected = this.selection(input.handle);
    if (!selected || selected.enabled || selected.generation !== input.generation)
      throw new Error(
        'Stop automatic sharing and inspect the current conversation before confirming that it and its jobs are closed.',
      );
    this.db
      .prepare('INSERT INTO gc_closures VALUES(?,?,?)')
      .run(input.key, input.handle, input.generation);
    return { closed: true };
  }
  select(raw: unknown) {
    const input = groupConversationSelectionSchema.parse(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('SELECT 1 FROM gc_sessions WHERE session_id=?').get(input.sessionId))
        throw new Error(
          'This native conversation has not reached the Groups hooks. Enable/reload the plugin through Claude’s native controls, then invoke /swa-groups:groups in the conversation you intend to share.',
        );
      const result = this.recordSelection({ ...input, enabled: true });
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  stop(raw: unknown) {
    const input = groupConversationStopSchema.parse(raw);
    // Selection and Stop can arrive from separate native/browser processes. Bind the
    // target and append its receipt under the same writer lock, including no-effect stops.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT * FROM gc_stops WHERE key=?').get(input.key);
      const exact = (handle: unknown, generation: unknown) => {
        if (
          handle !== input.handle ||
          (input.generation !== undefined && input.generation !== Number(generation))
        )
          throw new Error('Sharing stop retry changed. Retain the original key and generation.');
      };
      if (prior) {
        exact(prior.handle, prior.target_generation);
        const result = stopResultSchema.parse(JSON.parse(String(prior.result)));
        this.db.exec('COMMIT');
        return result;
      }
      // Accepted Stop receipts from older installations are already durable. Recover
      // them before looking at today's selection, without reapplying their old effect.
      const legacy = this.db
        .prepare('SELECT seq,handle,input FROM gc_selections WHERE key=?')
        .get(input.key);
      let target = input.generation,
        result;
      if (legacy) {
        const saved = selectionSchema.parse({
          ...JSON.parse(String(legacy.input)),
          generation: Number(legacy.seq),
        });
        target = Number(
          this.db
            .prepare('SELECT MAX(seq) AS generation FROM gc_selections WHERE handle=? AND seq<?')
            .get(legacy.handle, legacy.seq)!.generation,
        );
        exact(legacy.handle, target);
        if (saved.enabled) throw new Error('This key belongs to a sharing selection, not a Stop.');
        result = { ...saved, outcome: 'stopped' as const };
      } else if (input.recoverOnly) {
        this.db.exec('COMMIT');
        return { outcome: 'unresolved' as const };
      } else {
        const current = this.selection(input.handle);
        target ??= current?.generation;
        result =
          input.generation !== undefined && input.generation !== current?.generation
            ? { enabled: current?.enabled ?? false, outcome: 'superseded' as const }
            : {
                ...(current
                  ? this.recordSelection({
                      handle: input.handle,
                      key: input.key,
                      sessionId: current.sessionId,
                      enabled: false,
                    })
                  : { enabled: false }),
                outcome: 'stopped' as const,
              };
      }
      this.db
        .prepare('INSERT INTO gc_stops VALUES(?,?,?,?)')
        .run(input.key, input.handle, target ?? null, JSON.stringify(result));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private recordSelection(input: Omit<ConversationSelection, 'generation'>) {
    if (this.db.prepare('SELECT 1 FROM gc_stops WHERE key=?').get(input.key))
      throw new Error('This key belongs to a retained Stop request. Use a new selection key.');
    const exact = JSON.stringify(input),
      prior = this.db.prepare('SELECT seq,input FROM gc_selections WHERE key=?').get(input.key);
    if (prior && prior.input !== exact)
      throw new Error('Sharing selection retry changed. Retain the original key and input.');
    if (!prior)
      this.db
        .prepare('INSERT INTO gc_selections(key,handle,input) VALUES(?,?,?)')
        .run(input.key, input.handle, exact);
    const result = selectionSchema.parse({
      ...input,
      generation: Number(
        prior?.seq ??
          this.db.prepare('SELECT seq FROM gc_selections WHERE key=?').get(input.key)!.seq,
      ),
    });
    if (!prior)
      this.mark(input.handle, {
        state: 'skipped',
        generation: result.generation,
        message: 'Sharing selection changed; earlier warnings remain in private history.',
      });
    return result;
  }
  observe(sessionId: string, event: 'UserPromptSubmit' | 'Stop' | 'StopFailure', text: string) {
    const selected = this.selections().filter(
      (value) => value.enabled && value.sessionId === sessionId,
    );
    if (!selected.length) return; // No private material from unselected conversations is retained.
    if (Buffer.byteLength(text) > 16 * 1024) {
      if (event === 'UserPromptSubmit')
        this.db
          .prepare('INSERT INTO gc_prompts VALUES(?,?,?,?)')
          .run(
            randomUUID(),
            sessionId,
            '[This prompt exceeded the sharing limit and was withheld.]',
            0,
          );
      for (const item of selected)
        this.warn(
          item.handle,
          'An exchange was too large for automatic sharing. Ask Claude to share a selected shorter update.',
        );
      return;
    }
    if (event === 'StopFailure') return;
    if (event === 'UserPromptSubmit') {
      this.db
        .prepare('INSERT INTO gc_prompts VALUES(?,?,?,?)')
        .run(
          randomUUID(),
          sessionId,
          text,
          Number(this.db.prepare('SELECT MAX(seq) AS seq FROM gc_selections').get()!.seq),
        );
      return;
    }
    const prompt = this.db
      .prepare(
        'SELECT id,text,selection_seq FROM gc_prompts WHERE session_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(sessionId);
    const source = JSON.stringify({ prompt: prompt?.text ?? '', reply: text });
    if (Buffer.byteLength(source) > 30 * 1024) {
      for (const item of selected)
        this.warn(
          item.handle,
          'An exchange was too large for automatic sharing. Share a selected shorter update.',
        );
      return;
    }
    for (const selection of selected) {
      if (!prompt || Number(prompt.selection_seq) < selection.generation) continue;
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([selection.generation, prompt?.id ?? '', text]))
        .digest('hex');
      if (this.db.prepare('SELECT 1 FROM gc_jobs WHERE fingerprint=?').get(fingerprint)) continue;
      const pending = this.jobs(['queued', 'summarizing', 'ready'], selection.handle).filter(
        (job) =>
          job.handle === selection.handle &&
          job.generation === selection.generation &&
          ['queued', 'summarizing', 'ready'].includes(this.state(job.id).state),
      );
      if (pending.length >= 8) {
        this.warn(
          selection.handle,
          'The bounded sharing queue is full. This exchange stayed private; reconnect SWA and ask Claude to share a selected catch-up.',
        );
        continue;
      }
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO gc_jobs VALUES(?,?,?,?,?,?)')
        .run(id, fingerprint, selection.handle, sessionId, selection.generation, source);
      this.mark(id, { state: 'queued', message: 'Waiting for the next background summary.' });
    }
  }
  jobs(states?: ConversationJobState['state'][], handle?: string): ConversationJob[] {
    const where = [
      handle ? 'handle=?' : '',
      states?.length
        ? `COALESCE((SELECT json_extract(body,'$.state') FROM gc_states WHERE id=j.id ORDER BY seq DESC LIMIT 1),'queued') IN (${states.map(() => '?').join(',')})`
        : '',
    ].filter(Boolean);
    return this.db
      .prepare(
        `SELECT id,handle,session_id,generation,text FROM gc_jobs j ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rowid ${states ? 'ASC' : 'DESC'} LIMIT 256`,
      )
      .all(...(handle ? [handle] : []), ...(states ?? []))
      .map((row) => ({
        id: String(row.id),
        handle: String(row.handle),
        sessionId: String(row.session_id),
        generation: Number(row.generation),
        text: String(row.text),
      }));
  }
  counts(handle: string) {
    const generation = this.selection(handle)?.generation ?? 0;
    const result = this.db
      .prepare(
        `SELECT
      SUM(CASE WHEN state IN ('queued','summarizing','ready') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END) AS blocked
      FROM (SELECT COALESCE((SELECT json_extract(body,'$.state') FROM gc_states WHERE id=j.id ORDER BY seq DESC LIMIT 1),'queued') AS state FROM gc_jobs j WHERE handle=? AND generation=?)`,
      )
      .get(handle, generation)!;
    return { pending: Number(result.pending ?? 0), blocked: Number(result.blocked ?? 0) };
  }
  state(id: string): ConversationJobState {
    const row = this.db
      .prepare('SELECT body FROM gc_states WHERE id=? ORDER BY seq DESC LIMIT 1')
      .get(id);
    return row
      ? stateSchema.parse(JSON.parse(String(row.body)))
      : { state: 'queued', message: 'Waiting for a background summary.' };
  }
  warn(handle: string, message: string) {
    const generation = this.selection(handle)?.generation;
    if (generation) this.mark(handle, { state: 'unknown', generation, message });
  }
  warning(handle: string) {
    const row = this.db
      .prepare('SELECT seq,body FROM gc_states WHERE id=? ORDER BY seq DESC LIMIT 1')
      .get(handle);
    if (!row) return null;
    const state = stateSchema.parse(JSON.parse(String(row.body))),
      generation = this.selection(handle)?.generation;
    const latest = this.db
      .prepare(
        "SELECT MAX(s.seq) AS seq FROM gc_states s JOIN gc_jobs j ON j.id=s.id WHERE j.handle=? AND j.generation=? AND json_extract(s.body,'$.state') IN ('published','skipped') AND json_extract(s.body,'$.message') != 'Included in a combined background update.'",
      )
      .get(handle, generation ?? 0)!;
    return state.state === 'unknown' &&
      state.generation === generation &&
      Number(row.seq) > Number(latest.seq ?? 0)
      ? state.message
      : null;
  }
  job(id: string): ConversationJob | null {
    const row = this.db.prepare('SELECT * FROM gc_jobs WHERE id=?').get(id);
    return row
      ? {
          id: String(row.id),
          handle: String(row.handle),
          sessionId: String(row.session_id),
          generation: Number(row.generation),
          text: String(row.text),
        }
      : null;
  }
  mark(id: string, state: ConversationJobState) {
    this.db
      .prepare('INSERT INTO gc_states(id,body) VALUES(?,?)')
      .run(id, JSON.stringify(stateSchema.parse(state)));
  }
  startAttempt(id: string, now: number) {
    this.db.prepare('INSERT OR IGNORE INTO gc_attempts VALUES(?,?)').run(id, now);
    return Number(this.db.prepare('SELECT changes() AS n').get()!.n) === 1;
  }
  attempted(id: string) {
    return !!this.db.prepare('SELECT 1 FROM gc_attempts WHERE id=?').get(id);
  }
  lastAttempt() {
    return Number(this.db.prepare('SELECT MAX(started_at) AS n FROM gc_attempts').get()!.n ?? 0);
  }
  batch(job: ConversationJob, now: number): string | null {
    const prior = this.db.prepare('SELECT text FROM gc_batches WHERE id=?').get(job.id);
    if (prior) return String(prior.text);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.attempted(job.id)) {
        this.db.exec('COMMIT');
        return null;
      }
      const members: ConversationJob[] = [];
      let text = '';
      for (const candidate of this.jobs(['queued'], job.handle)) {
        if (
          candidate.handle !== job.handle ||
          candidate.generation !== job.generation ||
          this.state(candidate.id).state !== 'queued' ||
          this.attempted(candidate.id)
        )
          continue;
        const next = text + `\nEXCHANGE ${members.length + 1}:\n${candidate.text}\n`;
        if (Buffer.byteLength(next) > 32 * 1024) break;
        text = next;
        members.push(candidate);
      }
      if (!members.length || members[0].id !== job.id) throw new Error('Sharing batch changed.');
      this.db
        .prepare('INSERT INTO gc_batches VALUES(?,?,?)')
        .run(job.id, text, JSON.stringify(members.map((member) => member.id)));
      for (const member of members) {
        this.startAttempt(member.id, now);
        if (member.id !== job.id)
          this.mark(member.id, {
            state: 'skipped',
            message: 'Included in a combined background update.',
          });
      }
      this.db.exec('COMMIT');
      return text;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
