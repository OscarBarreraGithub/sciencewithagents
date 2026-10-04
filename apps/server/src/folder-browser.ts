import { randomUUID } from 'node:crypto';
import { opendir, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, relative, sep } from 'node:path';
import { Conflict } from './store.js';

type Folder = { path: string; identity: string };
type Link = { id: string; name: string };
type Options = { query?: string; scope?: 'children' | 'descendants'; hidden?: boolean };
const searchSkips = new Set(['node_modules', 'Library', 'Caches', '.git', '.venv', 'venv']);
/** Paired clients navigate server-issued directory IDs, never submitted filesystem paths. */
export class FolderBrowser {
  private folders = new Map<string, Folder>();
  constructor(
    private dataDir: string,
    private home = homedir(),
  ) {}
  private privatePath(path: string) {
    return path === this.dataDir || path.startsWith(this.dataDir + sep);
  }
  private async inspect(path: string): Promise<Folder> {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isDirectory() || this.privatePath(canonical)) throw new Error('Unavailable');
    return { path: canonical, identity: `${info.dev}:${info.ino}` };
  }
  private issue(folder: Folder) {
    for (const [id, previous] of this.folders) {
      if (previous.path === folder.path && previous.identity === folder.identity) {
        this.folders.delete(id);
        this.folders.set(id, folder);
        return id;
      }
    }
    const id = randomUUID();
    this.folders.set(id, folder);
    if (this.folders.size > 2048) this.folders.delete(this.folders.keys().next().value!);
    return id;
  }
  async resolve(id: string) {
    const saved = this.folders.get(id);
    if (!saved) throw new Conflict('This folder list expired. Open the folder browser again.');
    try {
      const current = await this.inspect(saved.path);
      if (current.path !== saved.path || current.identity !== saved.identity)
        throw new Error('Changed');
      this.issue(current);
      return current.path;
    } catch {
      throw new Conflict('That folder changed or is no longer accessible. Browse again.');
    }
  }
  private async navigation(path: string) {
    const breadcrumbs: Link[] = [];
    for (let parent = path; ; parent = dirname(parent)) {
      try {
        breadcrumbs.unshift({
          id: this.issue(await this.inspect(parent)),
          name: basename(parent) || 'This computer',
        });
      } catch {
        /* A readable descendant does not imply access to all its ancestors. */
      }
      if (dirname(parent) === parent) break;
    }
    const home = await realpath(this.home);
    const places = [
      ['Home', home, 'home'],
      ['Desktop', join(home, 'Desktop'), 'desktop'],
      ['Documents', join(home, 'Documents'), 'documents'],
      ['Downloads', join(home, 'Downloads'), 'downloads'],
      ['Developer', join(home, 'Developer'), 'developer'],
      ['This computer', parse(home).root, 'computer'],
      ...(process.platform === 'darwin' ? [['Drives', '/Volumes', 'volumes']] : []),
    ] as const;
    const locations: { id: string; name: string; kind: string }[] = [];
    for (const [name, target, kind] of places) {
      try {
        locations.push({ id: this.issue(await this.inspect(target)), name, kind });
      } catch {
        /* Only offer locations which exist and are accessible on this computer. */
      }
    }
    return { breadcrumbs, locations };
  }
  private async search(root: string, options: Options) {
    const query = options.query!.toLocaleLowerCase();
    const folders: (Link & { location: string })[] = [];
    const queue = [root],
      visited = new Set<string>();
    const deadline = Date.now() + 1500;
    let partial = false,
      scanned = 0;
    // Bounded, asynchronous name search; never index file contents or crawl in the background.
    for (let index = 0; index < queue.length; index++) {
      if (index >= 500 || Date.now() >= deadline) {
        partial = true;
        break;
      }
      const current = queue[index]!;
      try {
        const directory = await this.inspect(current);
        if (visited.has(directory.identity)) continue;
        visited.add(directory.identity);
        const entries = await opendir(directory.path);
        for await (const entry of entries) {
          if (++scanned > 20000 || folders.length >= 100 || Date.now() >= deadline) {
            partial = true;
            break;
          }
          if (
            !(entry.isDirectory() || entry.isSymbolicLink()) ||
            entry.name === '.git' ||
            (!options.hidden && entry.name.startsWith('.'))
          )
            continue;
          let folder: Folder;
          try {
            folder = await this.inspect(join(directory.path, entry.name));
          } catch {
            continue;
          }
          // Do not follow a directory link out of the selected search location.
          if (
            folder.path !== root &&
            !folder.path.startsWith(root === parse(root).root ? root : root + sep)
          )
            continue;
          if (entry.name.toLocaleLowerCase().includes(query)) {
            const id = this.issue(folder);
            if (!folders.some((result) => result.id === id))
              folders.push({
                id,
                name: entry.name,
                location: relative(root, dirname(folder.path)) || basename(root) || 'This computer',
              });
          }
          if (options.scope !== 'children' && !visited.has(folder.identity)) {
            if (
              searchSkips.has(entry.name) ||
              entry.name.endsWith('.app') ||
              queue.length >= 5000
            ) {
              partial = true;
              continue;
            }
            queue.push(folder.path);
          }
        }
      } catch {
        partial = true;
      }
      if (folders.length >= 100 || scanned > 20000 || Date.now() >= deadline) {
        partial = true;
        break;
      }
    }
    return {
      folders: folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      nextOffset: null,
      search: { query: options.query!, partial },
    };
  }
  async browse(folderId?: string, offset = 0, options: Options = {}) {
    this.dataDir = await realpath(this.dataDir);
    const path = folderId ? await this.resolve(folderId) : await realpath(this.home);
    try {
      const current = await this.inspect(path);
      let listing: {
        folders: (Link & { location?: string })[];
        nextOffset: number | null;
        search: { query: string; partial: boolean } | null;
      };
      if (options.query) listing = await this.search(path, options);
      else {
        const entries = (await readdir(path, { withFileTypes: true }))
          .filter(
            (entry) =>
              (entry.isDirectory() || entry.isSymbolicLink()) &&
              entry.name !== '.git' &&
              (options.hidden || !entry.name.startsWith('.')) &&
              !this.privatePath(join(path, entry.name)),
          )
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        const folders: Link[] = [];
        for (const entry of entries.slice(offset, offset + 100)) {
          try {
            folders.push({
              id: this.issue(await this.inspect(join(path, entry.name))),
              name: entry.name,
            });
          } catch {
            /* Skip files linked from a directory and inaccessible folders. */
          }
        }
        listing = {
          folders,
          nextOffset: offset + 100 < entries.length ? offset + 100 : null,
          search: null,
        };
      }
      const navigation = await this.navigation(path);
      const parentId = navigation.breadcrumbs.at(-2)?.id ?? null;
      return {
        current: {
          id: this.issue(current),
          name: basename(path) || 'This computer',
          canSelect: path !== parse(path).root && path !== (await realpath(this.home)),
        },
        parentId,
        ...listing,
        ...navigation,
      };
    } catch (error) {
      if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw new Conflict(
          process.platform === 'darwin'
            ? 'macOS has not allowed sciencewithagents to read this folder. On the computer, allow folder access in System Settings → Privacy & Security → Files and Folders (or Full Disk Access for protected folders), then try again.'
            : 'The operating system has not allowed this app to read this folder. Check this computer’s filesystem permissions, then try again.',
        );
      throw new Conflict(
        'This computer could not read that folder. Check its filesystem access or choose another folder.',
      );
    }
  }
}
