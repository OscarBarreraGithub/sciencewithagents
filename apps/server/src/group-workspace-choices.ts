import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import { type GroupContext } from '@dock/shared';
import { publicationCanonical } from './group-publication-protocol.js';
import { Conflict } from './store.js';
export const workspaceChoiceSchema = z.strictObject({
  key: z.uuid(),
  revision: z.number().int().positive().safe(),
  selection: z.strictObject({
    key: z.uuid(),
    root: z.string().max(4096),
    identity: z.string().max(100),
  }),
});
export type WorkspaceChoice = z.infer<typeof workspaceChoiceSchema>;
export function groupWorkspaceKey(
  anchor: GroupContext,
  enrollment: string,
  workspaceChoiceKey?: string,
) {
  return createHash('sha256')
    .update(
      publicationCanonical({
        anchor,
        enrollment,
        ...(workspaceChoiceKey ? { workspaceChoiceKey } : {}),
      }),
    )
    .digest('hex');
}
export function assertGroupWorkspaceFolder(selection: WorkspaceChoice['selection']) {
  try {
    const stat = lstatSync(selection.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(selection.root) !== selection.root ||
      `${stat.dev}:${stat.ino}` !== selection.identity
    )
      throw Error('Changed');
  } catch {
    throw new Conflict(
      'The chosen group folder changed or is unavailable. Its saved work was preserved; choose it again.',
    );
  }
}
export type WorkspaceChange = { key: string; revision: number } & (
  | { selection: WorkspaceChoice['selection'] }
  | { selectionKey: string; resolveSelection(): WorkspaceChoice['selection'] }
);
/** Compatible append-only hnr_workspaces identities, independent of agent provisioning. */
export class GroupWorkspaceChoices {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS hnr_workspaces(anchor_key TEXT NOT NULL,key TEXT PRIMARY KEY,input TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL,UNIQUE(anchor_key,revision));
      CREATE TRIGGER IF NOT EXISTS hnr_workspaces_immutable BEFORE UPDATE ON hnr_workspaces BEGIN SELECT RAISE(ABORT,'retained native receipt'); END;
      CREATE TRIGGER IF NOT EXISTS hnr_workspaces_retain BEFORE DELETE ON hnr_workspaces BEGIN SELECT RAISE(ABORT,'retained native receipt'); END;`);
  }
  get(anchor: GroupContext, enrollment: string): WorkspaceChoice | null {
    const row = this.db
      .prepare('SELECT body FROM hnr_workspaces WHERE anchor_key=? ORDER BY revision DESC LIMIT 1')
      .get(groupWorkspaceKey(anchor, enrollment));
    return row ? workspaceChoiceSchema.parse(JSON.parse(String(row.body))) : null;
  }
  select(
    anchor: GroupContext,
    enrollment: string,
    change: WorkspaceChange,
    assertIdle: (root: string) => void,
  ): WorkspaceChoice {
    z.uuid().parse(change.key);
    z.number().int().nonnegative().safe().parse(change.revision);
    if ('selectionKey' in change) z.uuid().parse(change.selectionKey);
    const prior = this.db
      .prepare('SELECT input,body FROM hnr_workspaces WHERE key=?')
      .get(change.key);
    if (prior) {
      const saved = workspaceChoiceSchema.parse(JSON.parse(String(prior.body)));
      const selection =
        'selection' in change
          ? workspaceChoiceSchema.shape.selection.parse(change.selection)
          : saved.selection;
      const exact = publicationCanonical({
        anchor,
        enrollment,
        key: change.key,
        revision: change.revision,
        selection,
      });
      if (
        ('selectionKey' in change && change.selectionKey !== saved.selection.key) ||
        prior.input !== exact
      )
        throw new Conflict('Retry the exact saved group folder selection.');
      return saved;
    }
    const current = this.get(anchor, enrollment);
    if ((current?.revision ?? 0) !== change.revision)
      throw new Conflict('The shared folder selection changed. Refresh before choosing again.');
    const selection = workspaceChoiceSchema.shape.selection.parse(
      'selection' in change ? change.selection : change.resolveSelection(),
    );
    if ('selectionKey' in change && selection.key !== change.selectionKey)
      throw new Conflict('Saved folder selection changed. Choose it again.');
    const exact = publicationCanonical({
      anchor,
      enrollment,
      key: change.key,
      revision: change.revision,
      selection,
    });
    assertGroupWorkspaceFolder(selection);
    assertIdle(selection.root);
    if (Number(this.db.prepare('SELECT count(*) n FROM hnr_workspaces').get()!.n) >= 2048)
      throw new Conflict(
        'Retained group folder-selection history is full; files and original bindings remain preserved.',
      );
    const choice = workspaceChoiceSchema.parse({
      key: change.key,
      revision: change.revision + 1,
      selection,
    });
    this.db
      .prepare('INSERT INTO hnr_workspaces VALUES (?,?,?,?,?)')
      .run(
        groupWorkspaceKey(anchor, enrollment),
        change.key,
        exact,
        JSON.stringify(choice),
        choice.revision,
      );
    return choice;
  }
}

export interface GroupWorkspacePort {
  workspace(
    context: GroupContext,
    enrollment: string,
    change?: WorkspaceChange,
  ): import('@dock/shared/dist/group-workspace.js').GroupWorkspaceView;
}
