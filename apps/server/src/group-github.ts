import { z } from 'zod';
import {
  groupGitHubMetadataSchema,
  groupGitHubRequestSchema,
  groupGitHubViewSchema,
  githubRepositorySchema,
  type GroupGitHubView,
} from '@dock/shared/dist/group-github.js';
import type { GroupHost } from './group-host.js';
import type { GroupNativeGitView } from '@dock/shared/dist/group-native-git.js';
import { GroupGitHubAccess } from './group-github-access.js';
import { Conflict } from './store.js';
const prefix = 'GitHub onboarding · ';
export class GroupGitHub {
  private active = new Map<string, Promise<unknown>>();
  constructor(
    readonly host: GroupHost,
    private readonly git: (handle: string) => Promise<GroupNativeGitView>,
    readonly access = new GroupGitHubAccess(),
  ) {
    host.db
      .exec(`CREATE TABLE IF NOT EXISTS gh_github_intents(key TEXT PRIMARY KEY,handle TEXT NOT NULL,input TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS gh_github_metadata(handle TEXT NOT NULL,event_id TEXT NOT NULL,sequence INTEGER NOT NULL,member_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(handle,event_id));
      CREATE TABLE IF NOT EXISTS gh_github_cursors(handle TEXT PRIMARY KEY,body TEXT NOT NULL);`);
  }
  async request(raw: unknown): Promise<GroupGitHubView> {
    const input = groupGitHubRequestSchema.parse(raw);
    if (input.action === 'profile' || input.action === 'repository' || input.action === 'retry') {
      this.host.githubContribution(input.handle);
      let metadata;
      const old = this.host.db
        .prepare('SELECT handle,input FROM gh_github_intents WHERE key=?')
        .get(input.key);
      if (input.action === 'retry') {
        if (!old || old.handle !== input.handle)
          throw new Conflict('Original GitHub publication is unavailable.');
        metadata = groupGitHubMetadataSchema.parse(JSON.parse(String(old.input)));
      } else if (input.action === 'profile')
        metadata = groupGitHubMetadataSchema.parse({
          kind: 'swa-github-profile-v1',
          username: input.username,
        });
      else {
        if (!(await this.host.githubRoster(input.handle)).creator)
          throw new Conflict('Only the creator can advertise the group repository.');
        const view = await this.git(input.handle);
        if (!view.connected || !view.available || !view.repository)
          throw new Conflict(
            'Verify the creator’s intended private repository in Work folder first.',
          );
        const repository = githubRepositorySchema.parse(
          view.repository.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''),
        );
        if (old && old.handle === input.handle) {
          const prior = groupGitHubMetadataSchema.parse(JSON.parse(String(old.input)));
          if (
            prior.kind === 'swa-github-repository-v1' &&
            prior.repository.toLowerCase() !== repository.toLowerCase()
          )
            throw new Conflict(
              'The intended repository differs from the saved advertisement. The original server receipt remains retained; prepare a new advertisement explicitly.',
              'GROUP_GITHUB_REPOSITORY_PRECONDITION',
            );
        }
        const check = await this.access.check(repository);
        if (!check.viewer)
          throw new Conflict(
            'Native GitHub could not verify this intended private repository and write access.',
          );
        metadata = groupGitHubMetadataSchema.parse({
          kind: 'swa-github-repository-v1',
          repository,
        });
      }
      if (metadata.kind === 'swa-github-repository-v1') {
        if (!(await this.host.githubRoster(input.handle)).creator)
          throw new Conflict('Only the creator can advertise the repository.');
        const current = await this.git(input.handle);
        const name = current.repository
          ?.replace(/^https:\/\/github\.com\//, '')
          .replace(/\.git$/, '');
        if (!current.connected || name?.toLowerCase() !== metadata.repository.toLowerCase())
          throw new Conflict(
            'Creator repository changed. Keep the original receipt and review the intended binding.',
            'GROUP_GITHUB_REPOSITORY_PRECONDITION',
          );
      }
      const exact = JSON.stringify(metadata);
      if (
        old &&
        old.handle === input.handle &&
        old.input !== exact &&
        input.action === 'repository' &&
        groupGitHubMetadataSchema.parse(JSON.parse(String(old.input))).kind ===
          'swa-github-repository-v1'
      )
        throw new Conflict(
          'The intended repository differs from this saved advertisement. Keep its original server receipt; prepare a new advertisement with another explicit click.',
          'GROUP_GITHUB_REPOSITORY_PRECONDITION',
        );
      if (old && (old.handle !== input.handle || old.input !== exact))
        throw new Conflict('Retry the exact saved GitHub profile publication.');
      if (
        !old &&
        Number(this.host.db.prepare('SELECT count(*) n FROM gh_github_intents').get()!.n) >= 2048
      )
        throw new Conflict(
          'Retained GitHub announcement history is full; original receipts are preserved.',
        );
      if (!old)
        this.host.db
          .prepare('INSERT OR IGNORE INTO gh_github_intents(key,handle,input) VALUES(?,?,?)')
          .run(input.key, input.handle, exact);
      const saved = this.host.db
        .prepare('SELECT handle,input FROM gh_github_intents WHERE key=?')
        .get(input.key)!;
      if (saved.handle !== input.handle || saved.input !== exact)
        throw new Conflict('Retry the original GitHub announcement identity.');
      await this.publish(input.handle, input.key, metadata).catch(() => {});
    }
    const view = await this.view(input.handle, input.action === 'check');
    if ('key' in input && input.key) {
      const receipt = this.host.db
        .prepare('SELECT complete FROM gh_github_intents WHERE key=? AND handle=?')
        .get(input.key, input.handle);
      if (receipt)
        return { ...view, receipt: { key: input.key, committed: receipt.complete === 1 } };
    }
    return view;
  }
  private publish(
    handle: string,
    key: string,
    metadata: z.infer<typeof groupGitHubMetadataSchema>,
  ) {
    const pending = this.active.get(key);
    if (pending) return pending;
    const operation = (async () => {
      this.host.githubContribution(handle);
      await this.host.publishFeatureEvent(
        handle,
        `github-onboarding:${key}`,
        JSON.stringify(metadata),
        prefix +
          (metadata.kind === 'swa-github-profile-v1'
            ? metadata.username
              ? `Username @${metadata.username}`
              : 'Username cleared'
            : `Private repository ${metadata.repository}`),
      );
      this.host.db.prepare('UPDATE gh_github_intents SET complete=1 WHERE key=?').run(key);
    })().finally(() => this.active.delete(key));
    this.active.set(key, operation);
    return operation;
  }
  private async scan(handle: string) {
    const reader = await this.host.authenticatedContext({ handle });
    let position = { after: 0, cursor: null as import('@dock/shared').GroupFeedCursor | null };
    const row = this.host.db
      .prepare('SELECT body FROM gh_github_cursors WHERE handle=?')
      .get(handle);
    if (row) position = JSON.parse(String(row.body));
    for (let batch = 0; batch < 4; batch++) {
      const page = await reader.readShared({ ...position, visibility: 'shared', limit: 50 });
      let safeAfter = position.after;
      for (const event of page.entries) {
        // Human posts are Question; metadata requires an owner-produced typed Decision and reserved summary.
        if (
          event.category !== 'Decision' ||
          event.scope.source.provider !== 'owner' ||
          !event.condensedText.startsWith(prefix) ||
          event.corrects ||
          event.revision !== 1 ||
          event.manifest.bytes > 1024
        ) {
          safeAfter = event.sequence;
          continue;
        }
        let original;
        try {
          original = await reader.original(event.eventId);
        } catch {
          this.host.db
            .prepare(
              'INSERT INTO gh_github_cursors VALUES(?,?) ON CONFLICT(handle) DO UPDATE SET body=excluded.body',
            )
            .run(handle, JSON.stringify({ after: safeAfter, cursor: null }));
          return false;
        }
        let metadata;
        try {
          metadata = groupGitHubMetadataSchema.parse(JSON.parse(original.text));
        } catch {
          safeAfter = event.sequence;
          continue;
        }
        this.host.db
          .prepare('INSERT OR IGNORE INTO gh_github_metadata VALUES(?,?,?,?,?)')
          .run(
            handle,
            event.eventId,
            event.sequence,
            event.scope.memberId,
            JSON.stringify(metadata),
          );
        safeAfter = event.sequence;
      }
      position = { after: page.continuation?.after ?? page.watermark, cursor: page.continuation };
      this.host.db
        .prepare(
          'INSERT INTO gh_github_cursors VALUES(?,?) ON CONFLICT(handle) DO UPDATE SET body=excluded.body',
        )
        .run(handle, JSON.stringify(position));
      if (!page.continuation) return true;
    }
    return false;
  }
  private async view(handle: string, check: boolean): Promise<GroupGitHubView> {
    const roster = await this.host.githubRoster(handle);
    const complete = await this.scan(handle);
    const usernames = new Map<string, string>();
    let repository: string | null = null;
    for (const row of this.host.db
      .prepare('SELECT member_id,body FROM gh_github_metadata WHERE handle=? ORDER BY sequence')
      .all(handle)) {
      const metadata = groupGitHubMetadataSchema.parse(JSON.parse(String(row.body)));
      if (metadata.kind === 'swa-github-profile-v1')
        usernames.set(String(row.member_id), metadata.username);
      else if (row.member_id === roster.creatorMemberId) repository = metadata.repository;
    }
    const result =
      complete && repository
        ? check
          ? await this.access.check(repository)
          : this.access.peek(repository)
        : null;
    return groupGitHubViewSchema.parse({
      ...roster,
      repository,
      complete,
      pending: this.host.db
        .prepare('SELECT key,input FROM gh_github_intents WHERE handle=? AND complete=0 LIMIT 64')
        .all(handle)
        .map((row) => ({
          key: row.key,
          kind: groupGitHubMetadataSchema.parse(JSON.parse(String(row.input))).kind,
          message:
            'Profile/repository announcement pending. Retry this exact publication; membership is already retained.',
        })),
      members: roster.members.map((member) => {
        const username = usernames.get(member.memberId) ?? null;
        const normalized = username?.toLowerCase();
        return {
          memberId: member.memberId,
          displayName: member.displayName,
          username,
          status:
            !normalized || !result
              ? 'Not checked'
              : result.confirmed.includes(normalized)
                ? 'Access confirmed'
                : result.invited.includes(normalized)
                  ? 'Invitation pending'
                  : result.authoritative
                    ? 'No access'
                    : 'Not checked',
        };
      }),
      checkedAt: result?.checkedAt ?? null,
      viewer: result?.viewer ?? null,
      message: !complete
        ? 'Metadata is incomplete. Previously observed usernames and repository may be outdated; retry reading before checking access or preparing invitations.'
        : (result?.message ??
          (repository
            ? 'Choose Check GitHub access to read native account evidence. Usernames are self-declared, not identity verification.'
            : 'Shared repository setup needed if you want files. Chat works without GitHub. Only the creator can advertise a verified private repository.')),
    });
  }
  async idle() {
    await Promise.allSettled(this.active.values());
    await this.access.idle();
  }
}
