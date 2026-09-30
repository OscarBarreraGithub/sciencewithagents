import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  backupConnectRequestSchema,
  backupPreviewRequestSchema,
  backupPreviewSchema,
  backupRepositorySchema,
  backupSetupSchema,
} from '@dock/shared';
import { Conflict } from './store.js';
import { SourceBackups, sourceBackupStatus } from './source-backups.js';

const execute = promisify(execFile);
async function openGitHubSignIn() {
  if (process.platform !== 'darwin')
    throw new Conflict('Native GitHub sign-in opens on the Mac running this app.');
  let binary: string;
  try {
    binary = (
      await execute('/usr/bin/which', ['gh'], { timeout: 5000, maxBuffer: 8192 })
    ).stdout.trim();
    if (!isAbsolute(binary) || binary.includes('\0')) throw Error('Executable unavailable');
  } catch {
    throw new Conflict(
      'GitHub CLI is not installed on this computer. Ask your setup agent to install it, then return here to sign in.',
    );
  }
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const command = [binary, 'auth', 'login', '--hostname', 'github.com', '--web', '--skip-ssh-key']
    .map(quote)
    .join(' ');
  try {
    await execute(
      '/usr/bin/osascript',
      [
        '-e',
        'on run argv\n tell application "Terminal"\n do script (item 1 of argv)\n activate\n end tell\nend run',
        command,
      ],
      { timeout: 20_000, maxBuffer: 8192 },
    );
  } catch {
    throw new Conflict(
      'The GitHub sign-in window could not be confirmed. Check Terminal on this Mac before opening another window.',
    );
  }
}
const accountSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
});
const repositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: backupRepositorySchema,
  private: z.boolean(),
  archived: z.boolean(),
  disabled: z.boolean(),
  permissions: z.object({ push: z.boolean() }),
  default_branch: z.string().min(1).max(160),
  description: z.string().nullable(),
});
type Account = z.infer<typeof accountSchema>;
type Repository = z.infer<typeof repositorySchema>;
export interface BackupSetupTransport {
  account(signal: AbortSignal): Promise<Account>;
  repository(name: string, signal: AbortSignal): Promise<Repository | null>;
  create(name: string, description: string, signal: AbortSignal): Promise<void>;
}
// Read only selected public metadata from gh's native authentication. Never read a token.
async function githubApi(path: string, signal: AbortSignal) {
  let output: string;
  try {
    output = (
      await execute('gh', ['api', '--hostname', 'github.com', '--include', path], {
        signal,
        timeout: 20_000,
        maxBuffer: 262144,
        env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' },
      })
    ).stdout;
  } catch (error) {
    output =
      typeof (error as { stdout?: unknown }).stdout === 'string'
        ? (error as { stdout: string }).stdout
        : '';
    if (!/^HTTP\/\S+ 404\b/.test(output))
      throw new Conflict(
        'GitHub could not be checked. Confirm GitHub CLI is installed and signed in on this computer, then retry. Your local work is unchanged.',
      );
  }
  if (/^HTTP\/\S+ 404\b/.test(output)) return null;
  const split = output.search(/\r?\n\r?\n/);
  if (!/^HTTP\/\S+ 200\b/.test(output) || split < 0)
    throw new Conflict('GitHub returned an unreadable response. Try the check again.');
  try {
    return JSON.parse(output.slice(split).trim());
  } catch {
    throw new Conflict('GitHub returned an unreadable response. Try the check again.');
  }
}
export const githubBackupSetup: BackupSetupTransport = {
  async account(signal) {
    return accountSchema.parse(await githubApi('user', signal));
  },
  async repository(name, signal) {
    const value = await githubApi(`repos/${backupRepositorySchema.parse(name)}`, signal);
    return value === null ? null : repositorySchema.parse(value);
  },
  async create(name, description, signal) {
    // No --source, --push, clone, checkout or remote mutation: this creates an empty private destination.
    await execute(
      'gh',
      [
        'repo',
        'create',
        backupRepositorySchema.parse(name),
        '--private',
        '--description',
        description,
      ],
      {
        signal,
        timeout: 30_000,
        maxBuffer: 16384,
        env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' },
      },
    );
  },
};

const storedPreview = backupPreviewSchema.extend({
  account: accountSchema,
  repositoryId: z.number().int().positive().nullable(),
  marker: z.string(),
});
/** An opt-in destination handshake around the existing backup engine, not another exporter. */
export class SourceBackupSetup {
  constructor(
    private backups: SourceBackups,
    private transport: BackupSetupTransport = githubBackupSetup,
    private clock = Date.now,
    private openSignIn = openGitHubSignIn,
  ) {}
  async signIn(projectId: string, raw: unknown) {
    const { key } = z.object({ key: z.uuid() }).strict().parse(raw);
    this.backups.store.project(projectId);
    return this.backups.store.externalOperation(
      `backup-sign-in:${key}`,
      { projectId },
      async () => {
        let current: Account | null = null;
        try {
          current = accountSchema.parse(await this.transport.account(this.backups.signal));
        } catch {
          /* Native sign-in was explicitly requested; credentials stay with gh. */
        }
        if (current)
          throw new Conflict(
            'GitHub is already signed in on this computer. Preview your private backup to use that account.',
          );
        await this.openSignIn();
        return { opened: true };
      },
    );
  }
  private previewKey(projectId: string) {
    return `backup-setup-preview:${projectId}`;
  }
  status(projectId: string) {
    const destination = this.backups.destination(projectId);
    const stored = storedPreview.safeParse(
      this.backups.store.getSetting(this.previewKey(projectId)),
    );
    return backupSetupSchema.parse({
      status: sourceBackupStatus(this.backups.store, projectId),
      destination: destination
        ? { repository: destination.repository, branch: destination.branch }
        : null,
      preview: !destination && stored.success ? backupPreviewSchema.parse(stored.data) : null,
    });
  }
  private async account() {
    try {
      return accountSchema.parse(await this.transport.account(this.backups.signal));
    } catch {
      throw new Conflict(
        'GitHub could not be checked. Confirm GitHub CLI is installed and signed in on this computer, then retry. Your local work is unchanged.',
      );
    }
  }
  private async repository(name: string) {
    try {
      const value = await this.transport.repository(name, this.backups.signal);
      return value === null ? null : repositorySchema.parse(value);
    } catch {
      throw new Conflict(
        'The private GitHub destination could not be checked. Check your connection and GitHub access, then retry.',
      );
    }
  }
  private validate(repo: Repository | null, name: string) {
    if (
      !repo ||
      repo.full_name.toLowerCase() !== name.toLowerCase() ||
      !repo.private ||
      !repo.permissions.push ||
      repo.archived ||
      repo.disabled
    )
      throw new Conflict(
        'Choose a private, writable GitHub repository. Archived, public or unavailable destinations cannot be connected.',
      );
    return repo;
  }
  async preview(projectId: string, raw: unknown) {
    const input = backupPreviewRequestSchema.parse(raw);
    const project = this.backups.store.project(projectId);
    if (this.backups.destination(projectId))
      throw new Conflict('This project already has a backup. Its destination was kept.');
    const old = storedPreview.safeParse(this.backups.store.getSetting(this.previewKey(projectId)));
    if (old.success && old.data.attempted)
      throw new Conflict(
        'A connection is awaiting confirmation. Check the saved destination before starting another.',
      );
    const account = await this.account();
    const id = randomUUID();
    const slug =
      project.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50) || 'project';
    const name =
      input.choice === 'existing' ? input.repository : `${account.login}/${slug}-${id.slice(0, 8)}`;
    const repo = await this.repository(name);
    if (input.choice === 'create' && repo)
      throw new Conflict('That backup name is already in use. Preview a new destination.');
    if (input.choice === 'existing') this.validate(repo, name);
    const value = storedPreview.parse({
      id,
      repository: repo?.full_name ?? name,
      repositoryId: repo?.id ?? null,
      branch: repo?.default_branch ?? 'main',
      choice: input.choice,
      account,
      expiresAt: new Date(this.clock() + 10 * 60_000).toISOString(),
      attempted: false,
      marker: `sciencewithagents source backup ${projectId}/${id}`,
    });
    this.backups.store.setSetting(this.previewKey(projectId), value);
    return this.status(projectId);
  }
  async connect(projectId: string, raw: unknown) {
    const input = backupConnectRequestSchema.parse(raw);
    const store = this.backups.store;
    store.project(projectId);
    const receiptKey = `backup-setup:${input.key}`;
    const signature = JSON.stringify({ projectId, ...input });
    const receipt = store.getSetting(receiptKey) as { signature: string; complete: boolean } | null;
    if (receipt && receipt.signature !== signature)
      throw new Conflict('This confirmation belongs to a different destination.');
    if (receipt?.complete) return this.status(projectId);
    const parsed = storedPreview.safeParse(store.getSetting(this.previewKey(projectId)));
    if (!parsed.success || parsed.data.id !== input.previewId)
      throw new Conflict('Preview this project’s destination before connecting it.');
    const preview = parsed.data;
    if (!receipt && this.clock() > Date.parse(preview.expiresAt))
      throw new Conflict('This preview expired. Check the destination again before connecting.');
    const configured = this.backups.destination(projectId);
    if (configured) {
      if (
        !receipt ||
        configured.repository !== preview.repository ||
        configured.branch !== preview.branch
      )
        throw new Conflict('This project already has a different backup. Its settings were kept.');
      store.setSetting(receiptKey, { signature, complete: true });
      return this.status(projectId);
    }
    const account = await this.account();
    if (account.id !== preview.account.id || account.login !== preview.account.login)
      throw new Conflict(
        'The GitHub account changed. Restore the account shown in the preview before continuing.',
      );
    let repo = await this.repository(preview.repository);
    if (preview.choice === 'create') {
      if (repo) {
        if (!preview.attempted || repo.description !== preview.marker)
          throw new Conflict(
            'The proposed name is now in use. Nothing was replaced; inspect the saved destination on GitHub.',
          );
      } else {
        store.transaction(() => {
          store.setSetting(receiptKey, { signature, complete: false });
          store.setSetting(this.previewKey(projectId), { ...preview, attempted: true });
          store.event('backup.connection_requested', projectId, null, { previewId: preview.id });
        });
        try {
          await this.transport.create(preview.repository, preview.marker, this.backups.signal);
        } catch {
          /* Inspect the exact remote after a failed or lost acknowledgement. */
        }
        repo = await this.repository(preview.repository);
        if (!repo || repo.description !== preview.marker)
          throw new Conflict(
            'Creation could not be confirmed. Check GitHub, then retry this same destination. No source has been uploaded.',
          );
      }
    } else {
      if (!repo || repo.id !== preview.repositoryId || repo.default_branch !== preview.branch)
        throw new Conflict(
          'The destination changed after preview. Check it again before connecting.',
        );
    }
    this.validate(repo, preview.repository);
    if (preview.choice === 'existing') store.setSetting(receiptKey, { signature, complete: false });
    this.backups.connectInitial({
      projectId,
      repository: preview.repository,
      branch: preview.branch,
    });
    store.transaction(() => {
      store.setSetting(receiptKey, { signature, complete: true });
      store.event('backup.connected', projectId, null, {
        repository: preview.repository,
        branch: preview.branch,
      });
    });
    return this.status(projectId);
  }
}
