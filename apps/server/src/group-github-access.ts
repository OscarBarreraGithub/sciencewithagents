import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { githubRepositorySchema, githubUsernameSchema } from '@dock/shared/dist/group-github.js';
const execute = promisify(execFile);
export type GitHubRead = (args: string[]) => Promise<unknown>;
export const nativeGitHubRead: GitHubRead = async (args) =>
  JSON.parse(
    (
      await execute('gh', ['api', '--hostname', 'github.com', '--method', 'GET', ...args], {
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      })
    ).stdout,
  );
export type AccessResult = {
  confirmed: string[];
  invited: string[];
  authoritative: boolean;
  viewer: string | null;
  checkedAt: string;
  message: string;
};
/** Fixed github.com, bounded complete enumeration; no shell or GitHub mutation. */
export class GroupGitHubAccess {
  private cache = new Map<string, AccessResult>();
  private active = new Map<string, Promise<AccessResult>>();
  constructor(
    private readonly read: GitHubRead = nativeGitHubRead,
    private readonly now = Date.now,
  ) {}
  peek(repository: string) {
    return this.cache.get(repository.toLowerCase()) ?? null;
  }
  check(raw: string) {
    const repository = githubRepositorySchema.parse(raw).toLowerCase();
    const cached = this.cache.get(repository);
    if (cached && this.now() - Date.parse(cached.checkedAt) < 60_000)
      return Promise.resolve(cached);
    const pending = this.active.get(repository);
    if (pending) return pending;
    const operation = this.inspect(repository)
      .then((result) => {
        this.cache.set(repository, result);
        if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
        return result;
      })
      .finally(() => this.active.delete(repository));
    this.active.set(repository, operation);
    return operation;
  }
  private async inspect(repository: string): Promise<AccessResult> {
    const result: AccessResult = {
      confirmed: [],
      invited: [],
      authoritative: false,
      viewer: null,
      checkedAt: new Date(this.now()).toISOString(),
      message:
        'Not checked: native GitHub sign-in, private repository or permission is unavailable.',
    };
    const deadline = this.now() + 20_000;
    const read: GitHubRead = (args) => {
      if (this.now() >= deadline) return Promise.reject(new Error('GitHub check deadline'));
      return this.read(args);
    };
    try {
      const user = z
        .object({ login: githubUsernameSchema.refine(Boolean) })
        .parse(await read(['user']));
      const repo = z
        .object({
          full_name: githubRepositorySchema,
          private: z.literal(true),
          permissions: z.object({ push: z.literal(true) }),
        })
        .parse(await read([`repos/${repository}`]));
      if (repo.full_name.toLowerCase() !== repository) return result;
      result.viewer = user.login;
      let expired = 0;
      const list = async (kind: 'collaborators' | 'invitations') => {
        for (let page = 1; page <= 10; page++) {
          const raw = z
            .array(z.unknown())
            .max(100)
            .parse(await read([`repos/${repository}/${kind}?per_page=100&page=${page}`]));
          for (const value of raw) {
            if (kind === 'collaborators')
              result.confirmed.push(
                z
                  .object({ login: githubUsernameSchema.refine(Boolean) })
                  .parse(value)
                  .login.toLowerCase(),
              );
            else {
              const invitation = z
                .object({
                  invitee: z.object({ login: githubUsernameSchema.refine(Boolean) }),
                  expired: z.boolean().optional(),
                })
                .parse(value);
              // This endpoint lists open invitations; GitHub may omit expired.
              if (invitation.expired === true) expired++;
              else result.invited.push(invitation.invitee.login.toLowerCase());
            }
          }
          if (raw.length < 100) return true;
        }
        return false;
      };
      const collaborators = await list('collaborators');
      try {
        const invitations = await list('invitations');
        result.authoritative = collaborators && invitations;
      } catch {
        /* confirmed positives remain evidence; absence stays unknown */
      }
      result.message = result.authoritative
        ? 'Checked using your native GitHub account. This verifies each supplied username’s repository access, not the member’s personal identity.'
        : 'Partial GitHub check: known positives are shown; absence is Not checked because enumeration or permissions are incomplete.';
      if (expired)
        result.message +=
          ' Expired invitations do not grant access; resend a new invitation if access is still wanted.';
    } catch {
      /* Auth/network/private 404 failures never prove absence. */
    }
    return result;
  }
  async idle() {
    await Promise.allSettled(this.active.values());
  }
}
