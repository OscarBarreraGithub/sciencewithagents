import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { GroupGitBlocked } from './group-git.js';
import type { GitHubIdentity } from './group-git-github.js';

/** Protected host only. Reads gh's existing native authentication, never enrolls/switches
 * accounts or persists/copies credentials. Callers never receive token-bearing errors.
 * Construction verifies the chosen installed binary; tests use a disposable executable. */
export async function openNativeGitHubIdentity(
  executable: string,
  accountId: string,
): Promise<GitHubIdentity> {
  const path = await realpath(executable),
    info = await stat(path);
  if (
    !/^\d+$/.test(accountId) ||
    !info.isFile() ||
    info.mode & 0o022 ||
    info.size > 64 * 1024 * 1024
  )
    throw new GroupGitBlocked('Trusted existing GitHub identity/executable required');
  const hash = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  return {
    async resolve() {
      if (
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex') !== hash
      )
        throw new GroupGitBlocked('Native GitHub executable changed');
      const token = await new Promise<string>((resolve, reject) => {
        execFile(
          path,
          ['auth', 'token', '--hostname', 'github.com'],
          {
            cwd: homedir(),
            env: { HOME: homedir(), PATH: '/usr/bin:/bin', LANG: 'C', GH_PROMPT_DISABLED: '1' },
            timeout: 10000,
            maxBuffer: 8192,
            encoding: 'utf8',
          },
          (error, stdout) => {
            if (error) reject(new GroupGitBlocked('Existing native GitHub sign-in unavailable'));
            else resolve(stdout.trim());
          },
        );
      });
      if (!token || /[\r\n\0]/.test(token))
        throw new GroupGitBlocked('Native GitHub credential unavailable');
      return { token, accountId }; // Actual authenticated /user ID is checked on every network request.
    },
  };
}
