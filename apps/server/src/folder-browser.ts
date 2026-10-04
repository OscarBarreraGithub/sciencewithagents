import { randomUUID } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, sep } from 'node:path';
import { Conflict } from './store.js';

type Folder = { path: string; identity: string };
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
  async browse(folderId?: string, offset = 0) {
    this.dataDir = await realpath(this.dataDir);
    const path = folderId ? await this.resolve(folderId) : await realpath(this.home);
    try {
      const current = await this.inspect(path);
      const entries = (await readdir(path, { withFileTypes: true }))
        .filter(
          (entry) =>
            (entry.isDirectory() || entry.isSymbolicLink()) &&
            entry.name !== '.git' &&
            !this.privatePath(join(path, entry.name)),
        )
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const folders: { id: string; name: string }[] = [];
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
      const parent = dirname(path);
      const parentId = parent === path ? null : this.issue(await this.inspect(parent));
      return {
        current: {
          id: this.issue(current),
          name: basename(path) || 'This computer',
          canSelect: path !== parse(path).root && path !== (await realpath(this.home)),
        },
        parentId,
        folders,
        nextOffset: offset + 100 < entries.length ? offset + 100 : null,
      };
    } catch {
      throw new Conflict(
        'This computer could not read that folder. Check its filesystem access or choose another folder.',
      );
    }
  }
}
