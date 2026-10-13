import { git } from './workspaces.js';

/** Sharing reviews the raw objects transported by Git, preserving native replacements. */
export function groupSharingGit(cwd: string, args: string[]) {
  return git(cwd, ['--no-replace-objects', ...args]);
}

export function groupGitHistory(cwd: string, base: string, head: string) {
  return groupSharingGit(cwd, [
    'log',
    '--no-mailmap',
    '--reverse',
    '--format=fuller',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '-p',
    '--diff-merges=separate',
    `${base}..${head}`,
    '--',
  ]);
}
