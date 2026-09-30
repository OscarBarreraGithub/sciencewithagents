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
import { id, projectSchema, type Project, type ProviderId } from '@dock/shared';
import { Conflict, type Store } from './store.js';
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
  provider?: ProviderId;
  requestedProvider?: ProviderId | 'policy';
  needsTracking?: boolean;
  initializationKey?: string;
  identity?: string;
};
const identity = (root: string) => {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Folder changed.');
  return `${stat.dev}:${stat.ino}`;
};

/** A host-native chooser grants one folder; the browser can never supply a path. */
export class FolderConnections {
  private active: {
    key: string;
    provider: ProviderId;
    promise: Promise<Project | null>;
    controller: AbortController;
  } | null = null;
  constructor(
    readonly store: Store,
    readonly dataDir: string,
    readonly picker: FolderPicker | null,
  ) {}
  async connect(key: string, requestedProvider?: ProviderId): Promise<Project | null> {
    id.parse(key);
    if (!this.picker)
      throw new Conflict(
        'Choosing an existing folder is currently available on Mac. You can still create a new project here.',
      );
    const setting = `project-folder:${key}`;
    const previous = this.store.getSetting(setting) as Selection | null;
    const provider = previous?.provider ?? this.store.defaultProvider('manager', requestedProvider);
    if (previous) {
      if (
        (previous.requestedProvider ?? previous.provider ?? 'policy') !==
        (requestedProvider ?? 'policy')
      )
        throw new Conflict(
          'This folder request already chose another provider. Reopen the form for a new connection.',
        );
      const existing = this.store.projects().find((project) => project.root === previous.root);
      if (existing) return projectSchema.parse(existing);
      if (previous.needsTracking) {
        this.assertSelection(previous);
        return null;
      }
      return this.register(previous.root, provider);
    }
    if (this.active) {
      if (this.active.key === key && this.active.provider === provider) return this.active.promise;
      throw new Conflict('The folder chooser is already open. Choose a folder or cancel it first.');
    }
    const controller = new AbortController();
    const promise = (async () => {
      const selected = await this.picker!(controller.signal);
      if (!selected || controller.signal.aborted) return null;
      const selection = await this.inspect(selected);
      const { root } = selection;
      if (controller.signal.aborted) return null;
      this.store.transaction(() => {
        this.store.setSetting(setting, {
          ...selection,
          provider,
          requestedProvider: requestedProvider ?? 'policy',
        });
        this.store.event('project.folder_selected', null, null, { key });
      });
      return selection.needsTracking ? null : this.register(root, provider);
    })();
    this.active = { key, provider, promise, controller };
    try {
      return await promise;
    } finally {
      if (this.active?.promise === promise) this.active = null;
    }
  }
  tracking(key: string) {
    const saved = this.store.getSetting(`project-folder:${key}`) as Selection | null;
    if (
      !saved?.needsTracking ||
      this.store.projects().some((project) => project.root === saved.root)
    )
      return undefined;
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
  private async inspect(selected: string): Promise<Selection> {
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
  /** Explicit owner action. Retries only finish the directory this receipt originally selected. */
  async track(key: string): Promise<Project> {
    id.parse(key);
    const saved = this.store.getSetting(`project-folder:${key}`) as Selection | null;
    if (!saved?.needsTracking || !saved.provider)
      throw new Conflict('Choose a folder that needs tracking first.');
    this.assertSelection(saved);
    const existing = this.store.projects().find((project) => project.root === saved.root);
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
      return this.store.register(saved.root, basename(saved.root), '', saved.provider);
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
  private async register(root: string, provider: ProviderId) {
    // Already registered projects can be reopened without touching their files/history.
    const existing = this.store.projects().find((project) => project.root === root);
    if (existing) return projectSchema.parse(existing);
    const canonical = await this.validRoot(root);
    return this.store.register(canonical, basename(canonical), '', provider);
  }
  close() {
    this.active?.controller.abort();
  }
}
