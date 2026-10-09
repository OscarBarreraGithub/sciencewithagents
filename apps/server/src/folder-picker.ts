import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join, isAbsolute } from 'node:path';
import {
  lstatSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { id, projectSchema, type Project, type ProviderId, type ExecutionMode } from '@dock/shared';
import { Conflict, type Store } from './store.js';
import { FolderBrowser } from './folder-browser.js';
import { validateRoot, git } from './workspaces.js';

const exec = promisify(execFile);
export type FolderPicker = (signal: AbortSignal) => Promise<string | null>;
export const chooseFolder: FolderPicker = async (signal) => {
  try {
    const result = await exec(
      '/usr/bin/osascript',
      [
        '-e',
        'POSIX path of (choose folder with prompt "Choose an existing project for sciencewithagents. Its files will stay where they are.")',
      ],
      { signal, timeout: 120_000, maxBuffer: 16_384 },
    );
    return result.stdout.trimEnd();
  } catch (error) {
    if (signal.aborted || /\(-128\)/.test(String((error as { stderr?: string }).stderr)))
      return null;
    throw new Conflict('The folder chooser could not open. Try again from this computer.');
  }
};

type Selection = {
  root: string;
  name?: string;
  description?: string;
  provider?: ProviderId;
  requestedProvider?: ProviderId | 'policy';
  needsTracking?: boolean;
  initializationKey?: string;
  identity?: string;
  fresh?: boolean;
  executionMode?: ExecutionMode;
};
const identity = (root: string) => {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Folder changed.');
  return `${stat.dev}:${stat.ino}`;
};

/** Native picks and server-issued folder IDs select one folder; clients never supply paths. */
export class FolderConnections {
  readonly browser: FolderBrowser;
  private active: {
    key: string;
    provider: ProviderId | undefined;
    selectOnly: boolean;
    folderId?: string;
    name?: string;
    fresh: boolean;
    executionMode: ExecutionMode;
    promise: Promise<Project | null>;
    controller: AbortController;
  } | null = null;
  constructor(
    readonly store: Store,
    readonly dataDir: string,
    readonly picker: FolderPicker | null,
  ) {
    this.browser = new FolderBrowser(dataDir);
  }
  async connect(
    key: string,
    requestedProvider?: ProviderId,
    selectOnly = false,
    folderId?: string,
    name?: string,
    fresh = false,
    requestedMode?: ExecutionMode,
  ): Promise<Project | null> {
    id.parse(key);
    const setting = `project-folder:${key}`;
    const previous = this.store.getSetting(setting) as Selection | null;
    const executionMode = previous?.provider
      ? (previous.executionMode ?? 'managed')
      : (requestedMode ?? 'managed');
    const provider = selectOnly
      ? undefined
      : (previous?.provider ?? this.store.defaultProvider('manager', requestedProvider));
    if (previous) {
      if (folderId && previous.root !== (await this.browser.resolve(folderId)))
        throw new Conflict(
          'This request already selected another folder. Choose again with a new request.',
        );
      this.assertSelection(previous);
      if (selectOnly) return null;
      if (previous.provider && requestedMode && requestedMode !== executionMode)
        throw new Conflict(
          'This folder request already chose another execution mode. Start a new setup.',
        );
      if (previous.provider && !!previous.fresh !== fresh)
        throw new Conflict('This folder request belongs to an earlier setup. Start a new setup.');
      if (previous.provider && previous.name !== name)
        throw new Conflict(
          'This folder request already chose another project name. Retry with the original name or start a new setup.',
        );
      if (
        previous.provider &&
        (previous.requestedProvider ?? previous.provider ?? 'policy') !==
          (requestedProvider ?? 'policy')
      )
        throw new Conflict(
          'This folder request already chose another provider. Reopen the form for a new connection.',
        );
      // Picking a folder does not choose a model or create a manager. Pin the
      // provider only when the person submits the completed setup form.
      if (!previous.provider)
        this.store.setSetting(setting, {
          ...previous,
          provider,
          requestedProvider: requestedProvider ?? 'policy',
          name,
          fresh,
          executionMode,
        });
      const existing = this.existing(key, { ...previous, fresh });
      if (existing) return projectSchema.parse(existing);
      if (previous.needsTracking) {
        return null;
      }
      return this.register(previous.root, provider!, name, fresh ? key : undefined, executionMode);
    }
    if (!folderId && !this.picker)
      throw new Conflict('Open the folder browser to choose an existing project.');
    if (this.active) {
      if (
        this.active.key === key &&
        this.active.provider === provider &&
        this.active.selectOnly === selectOnly &&
        this.active.folderId === folderId &&
        this.active.name === name &&
        this.active.fresh === fresh &&
        this.active.executionMode === executionMode
      )
        return this.active.promise;
      throw new Conflict('The folder chooser is already open. Choose a folder or cancel it first.');
    }
    const controller = new AbortController();
    const promise = (async () => {
      const selected = folderId
        ? await this.browser.resolve(folderId)
        : await this.picker!(controller.signal);
      if (!selected || controller.signal.aborted) return null;
      const selection = await this.inspect(selected);
      const { root } = selection;
      if (controller.signal.aborted) return null;
      this.store.transaction(() => {
        this.store.setSetting(setting, {
          ...selection,
          ...(selectOnly
            ? {}
            : {
                provider,
                requestedProvider: requestedProvider ?? 'policy',
                name,
                fresh,
                executionMode,
              }),
        });
        this.store.event('project.folder_selected', null, null, { key });
      });
      return selectOnly || selection.needsTracking
        ? null
        : this.register(root, provider!, name, fresh ? key : undefined, executionMode);
    })();
    this.active = {
      key,
      provider,
      selectOnly,
      folderId,
      name,
      fresh,
      executionMode,
      promise,
      controller,
    };
    try {
      return await promise;
    } finally {
      if (this.active?.promise === promise) this.active = null;
    }
  }
  selection(key: string) {
    const saved = this.store.getSetting(`project-folder:${key}`) as Selection | null;
    return saved
      ? {
          key,
          name: basename(saved.root),
          needsTracking: !!saved.needsTracking,
          workspacePath: saved.root,
        }
      : undefined;
  }
  /** Owner-selected identity for shared work; never accepts a client path. */
  sharedSelection(key: string): { key: string; root: string; identity: string } {
    id.parse(key);
    const saved = this.store.getSetting(`project-folder:${key}`) as Selection | null;
    if (!saved) throw new Conflict('Choose the shared folder before attaching it to this group.');
    this.assertSelection(saved);
    const root = realpathSync(saved.root),
      data = realpathSync(this.dataDir);
    if (
      root !== saved.root ||
      root === data ||
      root.startsWith(`${data}/`) ||
      data.startsWith(`${root}/`)
    )
      throw new Conflict(
        'Choose a shared folder outside the app’s private storage and its parent folders.',
      );
    return { key, root, identity: saved.identity! };
  }
  tracking(key: string) {
    const saved = this.store.getSetting(`project-folder:${key}`) as Selection | null;
    if (!saved?.needsTracking || this.existing(key, saved)) return undefined;
    return { key, name: basename(saved.root) };
  }
  private assertSelection(saved: Selection) {
    try {
      if (!saved.identity || identity(saved.root) !== saved.identity) throw new Error('Changed');
    } catch {
      throw new Conflict(
        'The selected folder changed or is unavailable. Choose it again; nothing was replaced.',
      );
    }
  }
  private existing(key: string, saved: Selection) {
    const projectId = this.store.getSetting(`project-spawn:${key}`);
    return saved.fresh
      ? projectId
        ? this.store.project(String(projectId))
        : undefined
      : this.store.projects().find((project) => project.root === saved.root);
  }
  async inspect(selected: string): Promise<Selection> {
    try {
      if (!isAbsolute(selected)) throw new Error('Absolute selection required');
      const root = realpathSync(selected),
        data = realpathSync(this.dataDir);
      const folderIdentity = identity(root);
      if (
        root === '/' ||
        root === realpathSync(homedir()) ||
        root === data ||
        root.startsWith(`${data}/`)
      )
        throw new Error('Not a project folder');
      try {
        const top = realpathSync(await git(root, ['rev-parse', '--show-toplevel']));
        if (top !== root)
          throw new Conflict(
            'Choose the main project folder, not a folder inside another tracked project.',
          );
        await git(root, ['rev-parse', '--verify', 'HEAD']);
        return { root, identity: folderIdentity, needsTracking: false };
      } catch (error) {
        if (error instanceof Conflict) throw error;
        if (existsSync(join(root, '.git'))) {
          identity(join(root, '.git'));
          const marker = join(root, '.git', 'sciencewithagents-init');
          if (lstatSync(marker).isSymbolicLink()) throw new Error('Unowned history');
          const initializationKey = id.parse(readFileSync(marker, 'utf8'));
          const original = this.store.getSetting(
            `project-folder:${initializationKey}`,
          ) as Selection | null;
          if (
            !original?.needsTracking ||
            original.root !== root ||
            original.identity !== folderIdentity
          )
            throw new Error('Existing version history is not ready');
          return { root, identity: folderIdentity, needsTracking: true, initializationKey };
        }
        // Distinguish a missing Git executable from an ordinary folder.
        await git(root, ['--version']);
      }
      if (data.startsWith(`${root}/`)) throw new Error('Contains runtime storage');
      return { root, identity: folderIdentity, needsTracking: true };
    } catch (error) {
      if (error instanceof Conflict) throw error;
      throw new Conflict(
        'That folder cannot be connected safely. Choose an accessible project folder outside the app’s private storage. Existing version history may need attention.',
      );
    }
  }
  /** Server-owned cluster bootstrap only: input comes from its pinned, consented destination. */
  async connectPreparedFolder(
    key: string,
    root: string,
    provider: ProviderId,
    name: string,
    description: string,
    expectedIdentity: string | null,
    trackingConsent: boolean,
  ) {
    id.parse(key);
    const setting = `project-folder:${key}`;
    let saved = this.store.getSetting(setting) as Selection | null;
    if (saved) {
      if (saved.root !== root || saved.provider !== provider || saved.name !== name || !saved.fresh)
        throw new Conflict('This folder receipt belongs to a different project setup.');
      this.assertSelection(saved);
    } else {
      const selected = await this.inspect(root);
      if (expectedIdentity && selected.identity !== expectedIdentity)
        throw new Conflict(
          'The saved cluster folder identity changed. Refresh and choose it again.',
        );
      saved = {
        ...selected,
        provider,
        requestedProvider: provider,
        name,
        description,
        fresh: true,
      };
      this.store.setSetting(setting, saved);
      this.store.event('project.folder_selected', null, null, { key });
    }
    const existing = this.existing(key, saved);
    if (existing) return projectSchema.parse(existing);
    if (saved.needsTracking) {
      if (!trackingConsent || !expectedIdentity || saved.identity !== expectedIdentity)
        throw new Conflict(
          'This saved cluster folder needs explicit Start tracking in the app before a manager can use task worktrees. No files were added or committed.',
        );
      return this.track(key);
    }
    return this.store.register(root, name, description, provider, key);
  }
  /** Explicit owner action. Retries only finish the directory this receipt originally selected. */
  async track(key: string): Promise<Project> {
    id.parse(key);
    const saved = this.store.getSetting(`project-folder:${key}`) as Selection | null;
    if (!saved?.needsTracking || !saved.provider)
      throw new Conflict('Choose a folder that needs tracking first.');
    this.assertSelection(saved);
    const existing = this.existing(key, saved);
    if (existing) return projectSchema.parse(existing);
    const initializationKey = saved.initializationKey ?? key;
    const metadata = join(saved.root, '.git'),
      marker = join(metadata, 'sciencewithagents-init');
    try {
      if (!existsSync(metadata)) {
        mkdirSync(metadata, { mode: 0o700 });
        writeFileSync(marker, initializationKey, { flag: 'wx', mode: 0o600 });
      }
      const assertOwned = () => {
        this.assertSelection(saved);
        identity(metadata);
        if (
          lstatSync(marker).isSymbolicLink() ||
          readFileSync(marker, 'utf8') !== initializationKey
        )
          throw new Error('Unowned history');
      };
      const run = (args: string[]) => {
        assertOwned();
        return git(saved.root, ['--git-dir', metadata, '--work-tree', saved.root, ...args]);
      };
      await run(['init', '--template=', '--initial-branch=main', '--', saved.root]);
      let head = '';
      try {
        head = await run(['rev-parse', '--verify', 'HEAD']);
      } catch {
        /* Unfinished initial checkpoint. */
      }
      if (!head) {
        await run(['config', '--local', 'user.name', 'sciencewithagents']);
        await run(['config', '--local', 'user.email', 'agent-dock@localhost']);
        assertOwned();
        // Private repository metadata only; never rewrite the person's .gitignore or files.
        const info = join(metadata, 'info');
        if (!existsSync(info)) mkdirSync(info, { mode: 0o700 });
        identity(info);
        writeFileSync(
          join(info, 'exclude'),
          '# Local setup exclusions\n.env\n.env.*\n!.env.example\nnode_modules/\n.venv/\nvenv/\n__pycache__/\n.DS_Store\n.cache/\n',
          { mode: 0o600 },
        );
        await run(['add', '--all', '--', '.']);
        await run([
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--allow-empty',
          '-m',
          'Start tracking project',
        ]);
      }
      assertOwned();
      return this.store.register(
        saved.root,
        saved.name ?? basename(saved.root),
        saved.description ?? '',
        saved.provider,
        saved.fresh ? key : undefined,
        saved.executionMode ?? 'managed',
      );
    } catch (error) {
      if (error instanceof Conflict) throw error;
      throw new Conflict(
        'We couldn’t finish the local starting version. Your files are retained. Try Start tracking again to continue this same folder; if it still fails, its storage or existing version history needs attention.',
      );
    }
  }
  private async validRoot(root: string) {
    try {
      return await validateRoot(root, this.dataDir);
    } catch {
      throw new Conflict(
        'That folder is not a ready-to-use software project, or sciencewithagents cannot read it. Choose the main folder of an existing Git project. To begin something new without Git setup, use Create project instead.',
      );
    }
  }
  private async register(
    root: string,
    provider: ProviderId,
    name?: string,
    freshKey?: string,
    executionMode: ExecutionMode = 'managed',
  ) {
    // Already registered projects can be reopened without touching their files/history.
    const existing = freshKey
      ? undefined
      : this.store.projects().find((project) => project.root === root);
    if (existing) return projectSchema.parse(existing);
    const canonical = await this.validRoot(root);
    return this.store.register(
      canonical,
      name ?? basename(canonical),
      '',
      provider,
      freshKey,
      executionMode,
    );
  }
  close() {
    this.active?.controller.abort();
  }
}
