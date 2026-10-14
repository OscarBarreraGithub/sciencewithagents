import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  appSourceBranchSchema,
  type AppSourceBranch,
} from '@dock/shared/dist/app-source-updates.js';
export const appSourceUpstream = 'https://github.com/OscarBarreraGithub/sciencewithagents.git';
const execute = promisify(execFile);
const revision = z.string().regex(/^[a-f0-9]{40,64}$/);
export type Inspection = { head: string; target: string; current: boolean; localChanges: boolean };
/** Only fetch source metadata. No checkout, reset, clean, credential transfer or model work. */
export async function inspectAppSource(
  root: string,
  source = appSourceUpstream,
  branch: AppSourceBranch = 'main',
): Promise<Inspection> {
  appSourceBranchSchema.parse(branch);
  const ref = `refs/sciencewithagents/updates/${branch}`;
  const git = async (args: string[]) =>
    (
      await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: root,
        timeout: 20_000,
        maxBuffer: 512 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      })
    ).stdout.trim();
  const succeeds = async (args: string[]) => {
    try {
      await git(args);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return false;
      throw error;
    }
  };
  await git([
    'fetch',
    '--no-write-fetch-head',
    '--no-auto-maintenance',
    '--no-tags',
    '--no-recurse-submodules',
    source,
    `+refs/heads/${branch}:${ref}`,
  ]);
  const head = revision.parse(await git(['rev-parse', 'HEAD']));
  const target = revision.parse(await git(['rev-parse', `${ref}^{commit}`]));
  // Local commits on top of upstream are legitimate customizations. The maintainer's
  // public tree can also have a different history from the development checkout.
  const current =
    head === target ||
    (await succeeds(['merge-base', '--is-ancestor', target, head])) ||
    (await succeeds(['diff', '--quiet', head, target, '--']));
  return {
    head,
    target,
    current,
    localChanges: !!(await git(['status', '--porcelain', '--untracked-files=normal'])),
  };
}
