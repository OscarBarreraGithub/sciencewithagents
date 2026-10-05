import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  appUpdateCheckSchema,
  appUpdateJobSchema,
  appUpdateStartSchema,
  type AppUpdateCheck,
  type AppUpdateJob,
} from '@dock/shared';
import { Conflict, Store } from './store.js';
import { BugReports } from './bug-reports.js';
import { recoveryBackupsFor } from './recovery-backups.js';

const upstream = 'https://github.com/OscarBarreraGithub/sciencewithagents.git';
const ref = 'refs/sciencewithagents/updates/main';
const execute = promisify(execFile);
const revision = z.string().regex(/^[a-f0-9]{40,64}$/);
type Inspection = { head: string; target: string; current: boolean; localChanges: boolean };
type SavedCheck = AppUpdateCheck & { head?: string; target?: string };
type SavedJob = AppUpdateJob & { checkId: string; target: string };
const services = new WeakMap<Store, AppUpdates>();

/** Only fetch source metadata. No checkout, reset, clean, credential transfer or model work. */
export async function inspectAppSource(root: string, source = upstream): Promise<Inspection> {
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
  await git(['fetch', '--no-tags', '--no-recurse-submodules', source, `+refs/heads/main:${ref}`]);
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

/** Reuse the maintenance manager and QUARK; this is not a second agent runtime. */
export class AppUpdates {
  private checking: Promise<AppUpdateCheck> | null = null;
  private starting: Promise<AppUpdateJob> | null = null;
  constructor(
    readonly store: Store,
    readonly dataDir: string,
    readonly sourceRoot: string,
    readonly maintenance: BugReports,
    readonly inspect: () => Promise<Inspection> = () => inspectAppSource(sourceRoot),
  ) {}

  status() {
    const saved = this.store.getSetting('app-updates:check');
    const job = this.store.getSetting('app-updates:latest');
    return {
      check: saved ? appUpdateCheckSchema.parse(saved) : null,
      job: job ? this.current(job as SavedJob) : null,
    };
  }
  check() {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      let result: SavedCheck;
      try {
        const info = await this.inspect();
        result = {
          id: randomUUID(),
          checkedAt: new Date().toISOString(),
          ...info,
          state: info.current ? 'current' : 'available',
          message: info.current
            ? 'Up to date with GitHub. Local customizations are retained.'
            : 'An update is available on GitHub.',
        };
      } catch {
        result = {
          id: randomUUID(),
          checkedAt: new Date().toISOString(),
          state: 'error',
          localChanges: false,
          message:
            'Could not check GitHub. Your installation is unchanged. Try again, or use the setup-agent instructions below.',
        };
      }
      this.store.setSetting('app-updates:check', result);
      return appUpdateCheckSchema.parse(result);
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  async start(raw: unknown) {
    const input = appUpdateStartSchema.parse(raw);
    // A lost response (including across app restart) never creates a second agent turn.
    const saved = this.store.getSetting(`app-update:${input.key}`) as SavedJob | null;
    if (saved) {
      if (saved.checkId !== input.checkId)
        throw new Conflict('This update request was already used for a different check.');
      return this.current(saved);
    }
    if (this.starting)
      throw new Conflict('An update request is already being prepared. Wait for it to finish.');
    const latest = this.status().job;
    if (latest && latest.state !== 'ready')
      throw new Conflict(
        'An update is already assigned. Open its maintenance conversation to continue.',
      );
    const check = this.store.getSetting('app-updates:check') as SavedCheck | null;
    if (
      !check ||
      check.id !== input.checkId ||
      check.state !== 'available' ||
      !check.target ||
      Date.now() - Date.parse(check.checkedAt) > 60 * 60 * 1000
    )
      throw new Conflict('Check for updates again before starting.');
    const target = revision.parse(check.target);
    const previousJob = this.store.getSetting('app-updates:latest') as SavedJob | null;
    if (previousJob?.target === target)
      throw new Conflict(
        'This update is already prepared. Open its conversation to finish or revise it.',
      );
    this.starting = (async () => {
      const copy = await recoveryBackupsFor(this.store, this.dataDir).create({ key: input.key });
      if (copy.state !== 'verified')
        throw new Conflict(
          'The recovery copy could not be verified. Nothing was assigned or updated. Check Recovery copies, then try a new update request.',
        );
      const manager = this.maintenance.manager();
      const detail = [
        'The owner clicked Update with an agent for THIS sciencewithagents installation. Carry out docs/UPDATE_APP.md using the existing central model policy and normal bounded independent review.',
        `Source root: ${this.sourceRoot}\nPrivate data: ${this.dataDir}\nUpstream: ${upstream}\nExact checked target: ${target}\nChecked local revision: ${check.head}\nVerified database recovery copy: ${copy.id}`,
        'Inspect local changes again. Preserve chats, projects, images, notes, saved drafts, settings, model choices, account sign-ins, phone trust and computer connections. Never delete or reinitialize data, reset/clean the working tree, force-push, copy secrets to GitHub, or replace local customizations with upstream defaults. Source files may be replaced/removed only as necessary for the reviewed update; preserve their previous version privately. A database copy does not cover configuration, project files or native provider history: preserve those separately before changing them. Keep the same data directory.',
        'Compare the exact target against the prior upstream base; an unrelated source history needs a reviewed port, not a forced merge. Use a separate branch/worktree to prepare and test the update. Do not run tests against live data. Only apply reviewed in-scope source changes according to the project’s policy. Build the result and check meaningful installation/workflow compatibility. Keep local update notes under ignored data/app-updates/. If a customization conflicts, preserve current behavior and ask one specific question; continue independent work.',
        'This manager runs inside the app being updated: do NOT stop or restart its own runtime or unrelated work. Prepare source and build artifacts, report any remaining step honestly, and mark the internal work item done only once the update is ready to reopen. Tell the owner to reopen through the existing launcher when active work is finished. Do not report the running server as updated before restart and verification. Keep human questions in action items; never write owner Notes. A failed step leaves the existing data and recovery copies intact and must not replay model requests.',
      ].join('\n\n');
      const item = this.maintenance.items.saveForManager(manager.id, {
        key: input.key,
        kind: 'internal',
        title: 'Update sciencewithagents from GitHub',
        detail,
      });
      return this.store.transaction(() => {
        const run = this.store.enqueue(
          manager.id,
          `app-update-run:${input.key}`,
          `Please update sciencewithagents from GitHub, preserving my chats, projects, settings and local customizations. A verified database recovery copy is ready. Read your internal work item ${item.id} for the pinned update and preservation instructions before starting. Prepare and review the update without interrupting running work, then tell me when it is ready to reopen.`,
        );
        const job: SavedJob = {
          id: input.key,
          checkId: input.checkId,
          target,
          createdAt: new Date().toISOString(),
          managerId: manager.id,
          workItemId: item.id,
          runId: run.id,
          recoveryCopyId: copy.id,
          state: 'queued',
          message: 'Recovery copy verified. Queued for the maintenance manager.',
        };
        this.store.setSetting(`app-update:${input.key}`, job);
        this.store.setSetting('app-updates:latest', job);
        this.store.event('app-update.requested', manager.projectId, manager.id, {
          id: job.id,
          workItemId: item.id,
        });
        return this.current(job);
      });
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  private current(job: SavedJob): AppUpdateJob {
    const run = this.store.run(job.runId),
      item = this.maintenance.items.get(job.workItemId);
    const ready = item.status === 'done' && run.status === 'completed';
    const state = ready
      ? 'ready'
      : item.status === 'waiting' ||
          ['failed', 'interrupted', 'cancelled', 'completed'].includes(run.status)
        ? 'attention'
        : run.status === 'queued'
          ? 'queued'
          : 'working';
    const reason = this.maintenance.pulsar.status().jobs.find((j) => j.runId === run.id)?.reason;
    return appUpdateJobSchema.parse({
      ...job,
      state,
      message: ready
        ? 'The agent marked the update ready. Read its checks, then reopen the app when active work is finished.'
        : state === 'attention'
          ? 'The update needs attention. Open the maintenance conversation; existing records are retained.'
          : state === 'queued'
            ? `Queued for the maintenance manager. ${reason || 'The current app stays available.'}`
            : 'The maintenance manager is preparing the update. Open its conversation for progress.',
    });
  }
  async idle() {
    await Promise.allSettled([this.checking, this.starting]);
  }
}

export function registerAppUpdateRoutes(
  app: FastifyInstance,
  maintenance: BugReports,
  kick: () => void,
  demo = false,
) {
  let updates = services.get(maintenance.store);
  if (!updates) {
    updates = new AppUpdates(
      maintenance.store,
      maintenance.dataDir,
      maintenance.sourceRoot,
      maintenance,
    );
    services.set(maintenance.store, updates);
  }
  const service = updates;
  app.addHook('preClose', async () => {
    await service.idle();
  });
  app.get('/api/app-updates', async () => service.status());
  app.post('/api/app-updates/check', async (request) => {
    z.object({}).strict().parse(request.body);
    if (demo) throw new Conflict('GitHub update checks run in your installed app.');
    return service.check();
  });
  app.post('/api/app-updates/start', async (request) => {
    if (demo) throw new Conflict('Updates run in your installed app.');
    const job = await service.start(request.body);
    kick();
    return job;
  });
}
