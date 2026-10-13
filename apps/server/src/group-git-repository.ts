import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Conflict } from './store.js';
import { groupSharingGit as git } from './group-sharing-git.js';
import { groupNativePrivatePath } from './group-native-private-path.js';
import {
  assertGroupGitBlob,
  assertGroupGitMetadata,
  groupProjectDataAllowed,
  GROUP_NATIVE_GIT_FILE_LIMITS,
} from './group-native-git-files.js';
const exec = promisify(execFile);
const oid = /^[a-f0-9]{40,64}$/;
export type GroupGitWorkspace = { cwd: string; scopeKey: string };
/** Shared native Git verification and raw-object scans; never changes the checkout. */
export class GroupGitRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir: () => string,
    private readonly localFixture = false,
  ) {}
  async privateAccess(cwd: string, origin: string, requireWrite = false) {
    const label = origin
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/\.git\/?$/, '')
      .replace(/\/$/, '');
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(label))
      throw new Conflict('Connect the chosen folder to the intended private GitHub repository.');
    try {
      const { stdout } = await exec(
        'gh',
        ['repo', 'view', label, '--json', 'nameWithOwner,isPrivate,viewerPermission'],
        {
          cwd,
          timeout: 10_000,
          maxBuffer: 16_384,
          env: { ...process.env, GH_PROMPT_DISABLED: '1' },
        },
      );
      const result = z
        .object({
          nameWithOwner: z.string().max(300),
          isPrivate: z.literal(true),
          viewerPermission: z.enum(['READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN']),
        })
        .parse(JSON.parse(stdout));
      if (`https://github.com/${result.nameWithOwner}`.toLowerCase() !== label.toLowerCase())
        throw Error('Repository changed');
      if (requireWrite && !['WRITE', 'MAINTAIN', 'ADMIN'].includes(result.viewerPermission))
        throw Error('Write access required');
    } catch {
      throw new Conflict(
        'Verify native GitHub sign-in and access to this intended private repository with your setup agent, then retry the same saved connection.',
      );
    }
  }

  async optional(cwd: string, args: string[]) {
    try {
      return await git(cwd, args);
    } catch {
      return '';
    }
  }
  async repository(binding: GroupGitWorkspace) {
    const cwd = binding.cwd;
    if (!existsSync(join(cwd, '.git'))) return null;
    if (
      realpathSync(cwd) !== resolve(cwd) ||
      lstatSync(join(cwd, '.git')).isSymbolicLink() ||
      (await git(cwd, ['rev-parse', '--show-toplevel'])) !== cwd
    )
      throw new Conflict('The saved shared repository needs repair; its files were preserved.');
    const origin = await this.optional(cwd, ['remote', 'get-url', 'origin']);
    if (!origin) return null; // Local task worktrees do not require GitHub or a remote.
    const https = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;
    const ssh = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
    if (!https.test(origin) && !ssh.test(origin) && !(this.localFixture && origin.startsWith('/')))
      throw new Conflict(
        'Connect the shared workspace to its intended GitHub repository with your setup agent.',
      );
    const canonical = (url: string) =>
      url
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/\/$/, '')
        .replace(/\.git$/, '')
        .toLowerCase();
    const pushes = (await git(cwd, ['remote', 'get-url', '--push', '--all', 'origin']))
      .split('\n')
      .filter(Boolean);
    if (pushes.length !== 1 || canonical(pushes[0]!) !== canonical(origin))
      throw new Conflict(
        'The fetch and push destinations differ. Ask your setup agent to reconcile them before syncing.',
      );
    const retained = this.db
      .prepare('SELECT origin FROM gng_repositories WHERE handle=?')
      .get(binding.scopeKey);
    if (retained && retained.origin !== origin)
      throw new Conflict(
        'The repository remote changed. Ask your setup agent to reconcile it before syncing.',
      );
    this.db
      .prepare('INSERT OR IGNORE INTO gng_repositories VALUES (?,?)')
      .run(binding.scopeKey, origin);
    return {
      cwd,
      origin,
      label: origin.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git\/?$/, ''),
    };
  }

  baseline(binding: GroupGitWorkspace, origin: string, head: string) {
    if (!oid.test(head)) throw new Conflict('A valid shared commit is required.');
    this.db
      .prepare('INSERT OR IGNORE INTO gng_baselines VALUES (?,?,?)')
      .run(binding.scopeKey, origin, head);
  }
  async ancestor(cwd: string, older: string, newer: string) {
    try {
      await git(cwd, ['merge-base', '--is-ancestor', older, newer]);
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return false;
      throw error;
    }
  }
  async fetchDefault(binding: GroupGitWorkspace, repo: { cwd: string; origin: string }) {
    const remote = await git(repo.cwd, ['ls-remote', '--symref', 'origin', 'HEAD']);
    const main = /^ref: refs\/heads\/([^\s]+)\s+HEAD$/m.exec(remote)?.[1] ?? 'main';
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,200}$/.test(main) || main.includes('..'))
      throw new Conflict('The remote default branch needs inspection.');
    const remoteHead = /^([a-f0-9]{40,64})\s+HEAD$/m.exec(remote)?.[1] ?? null;
    if (remoteHead) {
      await git(repo.cwd, [
        'fetch',
        '--no-tags',
        '--no-prune',
        '--no-prune-tags',
        '--no-recurse-submodules',
        'origin',
        `refs/heads/${main}`,
      ]);
      const fetched = await git(repo.cwd, ['rev-parse', 'FETCH_HEAD']);
      if (fetched !== remoteHead)
        throw new Conflict('The remote advanced during sync. Retry safely.');
      this.baseline(binding, repo.origin, fetched);
    }
    return { main, remoteHead };
  }

  async shareable(cwd: string, base: string, head: string) {
    const allowProjectData = groupProjectDataAllowed(cwd, this.dataDir());
    const scanned = new Set<string>();
    const allFiles = new Set<string>();
    const commits = (await git(cwd, ['rev-list', '--max-count=129', `${base}..${head}`]))
      .split('\n')
      .filter(Boolean);
    if (commits.length > 128)
      throw new Conflict('This publication needs a bounded history review with your setup agent.');
    const metadata = await git(cwd, [
      'log',
      '--no-mailmap',
      '--format=fuller',
      '--no-color',
      `${base}..${head}`,
      '--',
    ]);
    if (Buffer.byteLength(metadata) > 131072)
      throw new Conflict('Prepare a smaller checkpoint for the exact 128 KiB metadata review.');
    assertGroupGitMetadata(metadata);
    let count = 0,
      bytes = 0;
    for (const commit of commits) {
      const names = (
        await git(cwd, [
          'diff-tree',
          '--root',
          '-m',
          '--no-commit-id',
          '--name-only',
          '-r',
          '-z',
          commit,
        ])
      )
        .split('\0')
        .filter(Boolean);
      for (const name of names) {
        allFiles.add(name);
        if (++count > 1000)
          throw new Conflict('This publication exceeds the shared file review limit.');
        if (groupNativePrivatePath(name, allowProjectData))
          throw new Conflict(
            'Publication stopped at a likely private or runtime file. Inspect the shared task locally.',
          );
        const type = await this.optional(cwd, ['cat-file', '-t', `${commit}:${name}`]);
        if (!type) continue; // Deleted in this checkpoint.
        if (type !== 'blob')
          throw new Conflict('Publication needs inspection of non-file content.');
        const blob = await git(cwd, ['rev-parse', '--verify', `${commit}:${name}`]);
        if (scanned.has(blob)) continue;
        const size = Number(await git(cwd, ['cat-file', '-s', blob]));
        bytes += size;
        if (bytes > GROUP_NATIVE_GIT_FILE_LIMITS.scanBytes)
          throw new Conflict(
            'This sync exceeds 512 MiB of changed files. No files were sent; ask your setup agent to review smaller checkpoints.',
          );
        await assertGroupGitBlob(cwd, blob, size);
        scanned.add(blob);
      }
    }
    return { files: [...allFiles] };
  }
}
