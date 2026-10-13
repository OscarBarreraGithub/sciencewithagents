import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  groupExternalFilesRequestSchema,
  groupExternalFilePreviewSchema,
  groupExternalFilesViewSchema,
  type GroupExternalFilePreview,
  type GroupExternalFilesView,
} from '@dock/shared/dist/group-external-files.js';
import { groupSharingGit as git, groupGitHistory } from './group-sharing-git.js';
import { Conflict } from './store.js';

export type ExternalFileScope = {
  handle: string;
  cwd: string;
  scopeKey: string;
  origin: string;
  repository: string;
  sessionId: string;
  generation: number;
  author: string;
  autoSync: boolean;
  connected: boolean;
  revalidate(): Promise<void>;
  verify(): Promise<void>;
  fetch(): Promise<{ main: string; remoteHead: string | null }>;
  scan(base: string, head: string): Promise<{ files: string[] }>;
  announce(input: { key: string; text: string }): Promise<boolean>;
  lock<T>(body: () => Promise<T>): Promise<T>;
};
type Identity = Pick<
  ExternalFileScope,
  'handle' | 'cwd' | 'scopeKey' | 'origin' | 'sessionId' | 'generation' | 'author'
>;
const identity = (s: ExternalFileScope): Identity => ({
  handle: s.handle,
  cwd: s.cwd,
  scopeKey: s.scopeKey,
  origin: s.origin,
  sessionId: s.sessionId,
  generation: s.generation,
  author: s.author,
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const savedSchema = z.object({
  identity: z.object({
    handle: z.uuid(),
    cwd: z.string(),
    scopeKey: z.string(),
    origin: z.string(),
    sessionId: z.string(),
    generation: z.number().int().positive(),
    author: z.string(),
  }),
  preview: groupExternalFilePreviewSchema,
});
type Saved = z.infer<typeof savedSchema>;
type Phase = 'approved' | 'shared' | 'branch-shared';

/** Immutable checkpoint publication only: no stage, commit, checkout, reset or merge. */
export class GroupExternalFiles {
  constructor(
    private db: DatabaseSync,
    private scope: (handle: string) => Promise<ExternalFileScope>,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS gex_proposals(id TEXT PRIMARY KEY,handle TEXT NOT NULL,input TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gex_proposals_handle ON gex_proposals(handle);
      CREATE INDEX IF NOT EXISTS gex_proposals_scope ON gex_proposals(handle,json_extract(body,'$.identity.generation'),json_extract(body,'$.identity.scopeKey'));
      CREATE TABLE IF NOT EXISTS gex_decisions(key TEXT PRIMARY KEY,id TEXT NOT NULL,input TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS gex_one_decision ON gex_decisions(id) WHERE kind IN ('approved','rejected');
      CREATE TABLE IF NOT EXISTS gex_publications(seq INTEGER PRIMARY KEY,id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gex_publications_id ON gex_publications(id,seq);`);
    for (const table of ['gex_proposals', 'gex_decisions', 'gex_publications'])
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_retain BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'retained external file receipt'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable external file receipt'); END;`);
  }
  private saved(id: string, handle: string): Saved {
    const row = this.db
      .prepare('SELECT body FROM gex_proposals WHERE id=? AND handle=?')
      .get(id, handle);
    if (!row) throw new Conflict('This file checkpoint is not retained for this group.');
    const saved = savedSchema.parse(JSON.parse(String(row.body)));
    const { fingerprint, id: _, ...display } = saved.preview;
    if (digest({ identity: saved.identity, display }) !== fingerprint)
      throw new Conflict('This exact file preview could not be verified. No files were shared.');
    return saved;
  }
  private same(s: ExternalFileScope, saved: Saved) {
    if (JSON.stringify(identity(s)) !== JSON.stringify(saved.identity))
      throw new Conflict(
        'The selected conversation, folder or repository changed. Make a fresh checkpoint proposal; files were preserved.',
      );
  }
  private async verifyPreview(s: ExternalFileScope, saved: Saved) {
    if (
      (await git(s.cwd, ['rev-parse', `${saved.preview.head}^{tree}`])) !== saved.preview.tree ||
      (await groupGitHistory(s.cwd, saved.preview.base, saved.preview.head)) !== saved.preview.patch
    )
      throw new Conflict(
        'The raw committed history no longer matches this exact review. Make a fresh checkpoint proposal; no files were shared.',
      );
  }
  private phase(id: string): {
    state: Phase;
    message: string;
    failures: number;
    nextAt: number;
    announced: boolean;
  } {
    const row = this.db
      .prepare('SELECT body FROM gex_publications WHERE id=? ORDER BY seq DESC LIMIT 1')
      .get(id);
    return row
      ? JSON.parse(String(row.body))
      : {
          state: 'approved',
          message: 'Your exact file review is recorded; publication is waiting for sync.',
          failures: 0,
          nextAt: 0,
          announced: false,
        };
  }
  private decision(id: string) {
    return this.db
      .prepare(
        "SELECT kind,message FROM gex_decisions WHERE id=? AND kind IN ('approved','rejected') ORDER BY rowid DESC LIMIT 1",
      )
      .get(id);
  }
  private mark(id: string, body: ReturnType<GroupExternalFiles['phase']>) {
    this.db
      .prepare('INSERT INTO gex_publications(id,body) VALUES(?,?)')
      .run(id, JSON.stringify(body));
  }
  private view(
    scope: ExternalFileScope,
    preview: GroupExternalFilePreview | null = null,
  ): GroupExternalFilesView {
    const rows = this.db
      .prepare('SELECT id,body FROM gex_proposals WHERE handle=? ORDER BY rowid DESC LIMIT 20')
      .all(scope.handle);
    return groupExternalFilesViewSchema.parse({
      preview,
      proposals: rows.map((row) => {
        const saved = this.saved(String(row.id), scope.handle),
          decision = this.decision(String(row.id)),
          phase = this.phase(String(row.id)),
          identityChanged = JSON.stringify(identity(scope)) !== JSON.stringify(saved.identity),
          stale =
            identityChanged &&
            (!decision || (decision.kind === 'approved' && phase.state === 'approved'));
        return {
          id: row.id,
          head: saved.preview.head,
          repository: saved.preview.repository,
          state: stale
            ? 'stale'
            : decision?.kind === 'rejected'
              ? 'rejected'
              : decision?.kind === 'approved'
                ? phase.state
                : 'review',
          message: stale
            ? 'This checkpoint belongs to an earlier selection, folder or repository. Make a fresh proposal; it will not publish automatically.'
            : decision?.kind === 'rejected'
              ? decision.message
              : decision?.kind === 'approved'
                ? phase.message
                : 'Claude proposed this committed checkpoint. Review it before sharing.',
          retryable: !identityChanged && decision?.kind === 'approved' && phase.failures > 0,
        };
      }),
    });
  }
  async request(raw: unknown, humanReview = false): Promise<GroupExternalFilesView> {
    const input = groupExternalFilesRequestSchema.parse(raw);
    if ((input.action === 'approve' || input.action === 'reject') && !humanReview)
      throw new Conflict(
        'Review these exact files in the authenticated app. Native agents cannot attest owner file approval.',
      );
    const s = await this.scope(input.handle);
    if (input.action === 'status') return this.view(s);
    if (input.action === 'preview') return this.view(s, this.saved(input.id, s.handle).preview);
    if (input.action === 'propose') {
      const exact = JSON.stringify({ handle: s.handle, head: input.head }),
        old = this.db.prepare('SELECT input FROM gex_proposals WHERE id=?').get(input.key);
      if (old) {
        if (old.input !== exact)
          throw new Conflict('Retry the original file proposal key and committed SHA.');
        return this.view(s);
      }
      return s.lock(async () => {
        const retained = this.db
          .prepare('SELECT input FROM gex_proposals WHERE id=?')
          .get(input.key);
        if (retained) {
          if (retained.input !== exact)
            throw new Conflict('Retry the original file proposal key and committed SHA.');
          return this.view(s);
        }
        await s.revalidate();
        await s.verify();
        const { remoteHead } = await s.fetch();
        if (!s.connected || !remoteHead)
          throw new Conflict(
            'Verify the intended shared repository and its initial shared history before proposing files.',
          );
        const current = await git(s.cwd, ['rev-parse', 'HEAD']);
        await git(s.cwd, ['merge-base', '--is-ancestor', input.head, current]).catch(() => {
          throw new Conflict('Propose a commit from this selected folder’s current history.');
        });
        const base = await git(s.cwd, ['merge-base', remoteHead, input.head]).catch(() => {
          throw new Conflict(
            'The selected repository has unrelated history. Preserve it and ask Claude to reconcile.',
          );
        });
        if (base === input.head)
          throw new Conflict('This checkpoint is already in the shared default history.');
        const { files } = await s.scan(base, input.head);
        const patch = await groupGitHistory(s.cwd, base, input.head).catch(() => {
          throw new Conflict(
            'The complete committed history cannot fit the file review. Prepare a smaller checkpoint.',
          );
        });
        if (
          Buffer.byteLength(patch) > 131072 ||
          files.length > 1000 ||
          files.some((f) => f.length > 512)
        )
          throw new Conflict('Prepare a smaller checkpoint for the exact 128 KiB file review.');
        const tree = await git(s.cwd, ['rev-parse', `${input.head}^{tree}`]);
        const branch = `swa/member-${createHash('sha256').update(s.author).digest('hex').slice(0, 12)}/checkpoint-${input.key}`;
        const display = {
          repository: s.repository,
          branch,
          sessionId: s.sessionId,
          base,
          head: input.head,
          tree,
          files,
          patch,
        };
        const preview = groupExternalFilePreviewSchema.parse({
          id: input.key,
          ...display,
          fingerprint: digest({ identity: identity(s), display }),
        });
        const fresh = await this.scope(input.handle);
        this.same(fresh, { identity: identity(s), preview });
        await fresh.revalidate();
        this.db
          .prepare('INSERT INTO gex_proposals VALUES(?,?,?,?)')
          .run(input.key, s.handle, exact, JSON.stringify({ identity: identity(s), preview }));
        return this.view(s);
      });
    }
    const exact = JSON.stringify(input),
      old = this.db
        .prepare('SELECT input,kind,message FROM gex_decisions WHERE key=?')
        .get(input.key);
    if (old) {
      if (old.input !== exact)
        throw new Conflict('Retain the original exact file review key and display.');
      if (old.kind === 'refused') throw new Conflict(String(old.message));
      if (old.kind === 'approved' || old.kind === 'retry')
        await this.publish(input.id, input.handle);
      return this.view(s);
    }
    if (input.action === 'retry') {
      const saved = this.saved(input.id, s.handle);
      this.same(s, saved);
      if (this.decision(input.id)?.kind !== 'approved')
        throw new Conflict('This checkpoint has no retained owner approval.');
      this.db
        .prepare('INSERT INTO gex_decisions VALUES(?,?,?,?,?)')
        .run(
          input.key,
          input.id,
          exact,
          'retry',
          'Explicit retry of the same reviewed checkpoint.',
        );
      this.mark(input.id, { ...this.phase(input.id), failures: 0, nextAt: 0 });
      await this.publish(input.id, input.handle);
      return this.view(s);
    }
    try {
      const saved = this.saved(input.id, s.handle);
      this.same(s, saved);
      if (this.decision(input.id))
        throw new Conflict(
          'This proposal already has an owner decision. Make a new proposal for another review.',
        );
      if (input.action === 'approve') {
        if (input.fingerprint !== saved.preview.fingerprint)
          throw new Conflict('The saved file display changed. Refresh before approving.');
        await s.verify();
        await s.revalidate();
        this.same(await this.scope(input.handle), saved);
        await this.verifyPreview(s, saved);
      }
      this.db
        .prepare('INSERT INTO gex_decisions VALUES(?,?,?,?,?)')
        .run(
          input.key,
          input.id,
          exact,
          input.action === 'approve' ? 'approved' : 'rejected',
          input.action === 'approve'
            ? 'Exact owner review recorded.'
            : 'You declined this checkpoint. No files were shared.',
        );
    } catch (error) {
      const message =
        error instanceof Conflict
          ? error.message
          : 'This exact file review could not be recorded. No files were shared.';
      this.db
        .prepare('INSERT INTO gex_decisions VALUES(?,?,?,?,?)')
        .run(input.key, input.id, exact, 'refused', message);
      throw new Conflict(message);
    }
    if (input.action === 'approve') await this.publish(input.id, input.handle);
    return this.view(s);
  }
  private async publish(id: string, handle: string) {
    if (this.decision(id)?.kind !== 'approved') return;
    const prior = this.phase(id);
    if (
      ((prior.state === 'shared' || prior.state === 'branch-shared') && prior.announced) ||
      prior.failures >= 8 ||
      prior.nextAt > Date.now()
    )
      return;
    let s: ExternalFileScope | undefined;
    try {
      s = await this.scope(handle);
      const saved = this.saved(id, s.handle);
      this.same(s, saved);
      if (!s.autoSync || !s.connected) return;
      const scope = s;
      await scope.lock(async () => {
        const current = this.phase(id);
        if (current.failures >= 8 || current.nextAt > Date.now()) return;
        const note = async () => {
          await scope.revalidate();
          this.same(await this.scope(handle), saved);
          if (
            !(await scope.announce({
              key: id,
              text: `Reviewed files published · ${saved.preview.repository}\nCommit ${saved.preview.head}\nCheckpoint ${saved.preview.branch}`,
            }))
          )
            throw new Conflict(
              'The reviewed files are on GitHub; their group message is still waiting for delivery. The exact message will be retried without a model.',
            );
          const shared = this.phase(id);
          this.mark(id, { ...shared, announced: true, failures: 0, nextAt: 0 });
        };
        if (current.state === 'shared' || current.state === 'branch-shared') {
          if (!current.announced) await note();
          return;
        }
        await scope.verify();
        await scope.revalidate();
        this.same(await this.scope(handle), saved);
        await this.verifyPreview(scope, saved);
        await scope.scan(saved.preview.base, saved.preview.head);
        const { main, remoteHead } = await scope.fetch();
        await scope.verify();
        if (!remoteHead)
          throw new Conflict(
            'The shared default history is unavailable. Review its current history and make a fresh checkpoint; no files were shared.',
          );
        await git(scope.cwd, ['merge-base', '--is-ancestor', saved.preview.base, remoteHead]).catch(
          () => {
            throw new Conflict(
              'The shared default history was rewritten after this review. Make a fresh checkpoint proposal; no files were shared.',
            );
          },
        );
        const push = [
          '-c',
          'remote.origin.mirror=false',
          'push',
          '--porcelain',
          '--no-follow-tags',
          '--recurse-submodules=no',
          saved.identity.origin,
        ];
        const remoteBranch = await git(scope.cwd, [
          'ls-remote',
          saved.identity.origin,
          `refs/heads/${saved.preview.branch}`,
        ]);
        const existing = remoteBranch.split(/\s+/)[0];
        if (existing && existing !== saved.preview.head)
          throw new Conflict(
            'The generated checkpoint reference changed. Nothing was overwritten.',
          );
        if (existing !== saved.preview.head) {
          await scope.revalidate();
          this.same(await this.scope(handle), saved);
          await git(scope.cwd, [
            ...push,
            `${saved.preview.head}:refs/heads/${saved.preview.branch}`,
          ]);
        }
        let canAdvance = !remoteHead;
        let alreadyShared = false;
        if (remoteHead)
          try {
            await git(scope.cwd, ['merge-base', '--is-ancestor', remoteHead, saved.preview.head]);
            canAdvance = true;
          } catch {
            canAdvance = false;
          }
        if (remoteHead && !canAdvance)
          try {
            await git(scope.cwd, ['merge-base', '--is-ancestor', saved.preview.head, remoteHead]);
            alreadyShared = true;
          } catch {
            /* A separate peer history stays in place. */
          }
        await scope.revalidate();
        this.same(await this.scope(handle), saved);
        let defaultRefused = false;
        if (canAdvance)
          try {
            await git(scope.cwd, [...push, `${saved.preview.head}:refs/heads/${main}`]);
          } catch {
            const refs = await git(scope.cwd, [
              'ls-remote',
              saved.identity.origin,
              `refs/heads/${main}`,
              `refs/heads/${saved.preview.branch}`,
            ]);
            const observed = new Map(
              refs
                .split('\n')
                .filter(Boolean)
                .map((line) => line.split(/\s+/) as [string, string])
                .map(([sha, ref]) => [ref, sha]),
            );
            if (observed.get(`refs/heads/${saved.preview.branch}`) !== saved.preview.head)
              throw new Conflict(
                'Git sharing is unconfirmed. The exact checkpoint and approval are retained; no working files were changed.',
              );
            canAdvance = observed.get(`refs/heads/${main}`) === saved.preview.head;
            defaultRefused = !canAdvance;
          }
        this.mark(id, {
          state: canAdvance || alreadyShared ? 'shared' : 'branch-shared',
          message:
            canAdvance || alreadyShared
              ? 'Your exact reviewed checkpoint was shared. Working files and local branches were unchanged.'
              : defaultRefused
                ? `Your exact checkpoint is shared on ${saved.preview.branch}. The default branch could not be updated; ask Claude to check repository rules and prepare a reviewed correction.`
                : `Your exact checkpoint is shared on ${saved.preview.branch}. The default branch diverged; ask Claude to prepare a reviewed correction.`,
          failures: 0,
          nextAt: 0,
          announced: false,
        });
        await note();
      });
    } catch (error) {
      this.mark(id, {
        ...this.phase(id),
        message:
          error instanceof Conflict
            ? error.message
            : ['shared', 'branch-shared'].includes(this.phase(id).state)
              ? 'The reviewed files were published to GitHub; announcing them to the group is unconfirmed. The exact message and checkpoint are retained.'
              : 'Git sharing is unconfirmed. The exact checkpoint and approval are retained; check GitHub sign-in or connection. No working files were changed.',
        failures: prior.failures + 1,
        nextAt: Date.now() + Math.min(300000, 60000 * 2 ** prior.failures),
      });
    }
  }
  async sync(handle: string) {
    const s = await this.scope(handle);
    for (const row of this.db
      .prepare(
        "SELECT p.id FROM gex_proposals p WHERE p.handle=? AND json_extract(p.body,'$.identity.generation')=? AND json_extract(p.body,'$.identity.scopeKey')=? AND json_extract(p.body,'$.identity.sessionId')=? AND json_extract(p.body,'$.identity.origin')=? AND json_extract(p.body,'$.identity.cwd')=? AND json_extract(p.body,'$.identity.author')=? AND EXISTS(SELECT 1 FROM gex_decisions d WHERE d.id=p.id AND d.kind='approved') AND COALESCE((SELECT json_extract(body,'$.announced') FROM gex_publications WHERE id=p.id ORDER BY seq DESC LIMIT 1),0)=0 AND COALESCE((SELECT json_extract(body,'$.failures') FROM gex_publications WHERE id=p.id ORDER BY seq DESC LIMIT 1),0)<8 AND COALESCE((SELECT json_extract(body,'$.nextAt') FROM gex_publications WHERE id=p.id ORDER BY seq DESC LIMIT 1),0)<=? ORDER BY p.rowid LIMIT 20",
      )
      .all(s.handle, s.generation, s.scopeKey, s.sessionId, s.origin, s.cwd, s.author, Date.now()))
      if (
        JSON.stringify(identity(s)) ===
        JSON.stringify(this.saved(String(row.id), s.handle).identity)
      )
        await this.publish(String(row.id), handle);
  }
}
