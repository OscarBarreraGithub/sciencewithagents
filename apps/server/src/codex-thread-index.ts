import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isBackgroundCodexThread,
  latestConversationActivity,
  type MirrorState,
} from '@dock/shared';

export type CodexThreadLabels = Pick<MirrorState, 'source' | 'label' | 'title' | 'lastActivityAt'>;

/** The owner's own Codex home on this computer; never a client-selected path. */
export const defaultCodexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');

/** Newest `state_<n>.sqlite` Codex keeps for its own thread list, if Codex has one here. */
function stateIndex(home: string) {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const versions = names
    .map((name) => /^state_(\d{1,4})\.sqlite$/.exec(name)?.[1])
    .filter((value): value is string => !!value)
    .map(Number);
  return versions.length ? join(home, `state_${Math.max(...versions)}.sqlite`) : null;
}

/**
 * Display metadata for one exact thread from Codex's local index, read-only. Never reads
 * transcripts, starts Codex or writes native files. `null` means Codex keeps no such
 * (titled, owner-facing) thread here; an unreadable index throws so the caller can report
 * a retryable condition.
 */
export function readCodexThreadLabels(home: string, threadId: string): CodexThreadLabels | null {
  const index = stateIndex(home);
  if (!index) return null;
  const db = new DatabaseSync(index, { readOnly: true, timeout: 500 });
  try {
    const row = db
      .prepare(
        'SELECT source, thread_source, cwd, name, title, preview, updated_at_ms, updated_at, created_at FROM threads WHERE id=?',
      )
      .get(threadId);
    if (!row) return null;
    const source = String(row.source ?? '');
    if (
      /subagent/i.test(source) ||
      isBackgroundCodexThread({ source, threadSource: row.thread_source ?? undefined })
    )
      return null;
    const title = [row.name, row.title, row.preview]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find(Boolean);
    if (!title) return null;
    const editor = source === 'vscode';
    return {
      source: editor ? 'vscode' : 'codex-daemon',
      label: editor
        ? (basename(String(row.cwd ?? '')) || 'VS Code').slice(0, 200)
        : 'Codex on this computer',
      title: title.slice(0, 500),
      lastActivityAt: latestConversationActivity([
        row.updated_at_ms,
        row.updated_at,
        row.created_at,
      ]),
    };
  } finally {
    db.close();
  }
}
