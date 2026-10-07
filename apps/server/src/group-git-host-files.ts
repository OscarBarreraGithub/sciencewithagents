import { constants } from 'node:fs';
import {
  open,
  lstat,
  realpath,
  readdir,
  mkdir,
  writeFile,
  mkdtemp,
  rm,
  rename,
} from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GroupGitBlocked } from './group-git.js';

export interface PinnedGitResource {
  readonly id: string;
  readonly root: string;
  readonly gitDirectory: string;
  readonly rootIdentity: string;
  readonly gitIdentity: string;
  readonly bare: boolean;
}
const identity = (info: { dev: bigint; ino: bigint }) => `${info.dev}:${info.ino}`;
export async function pinGitResource(
  id: string,
  root: string,
  bare = false,
): Promise<PinnedGitResource> {
  if ((await realpath(root)) !== resolve(root))
    throw new GroupGitBlocked('Git resource must be canonical');
  const gitDirectory = bare ? root : join(root, '.git');
  const top = await lstat(root, { bigint: true });
  const git = await lstat(gitDirectory, { bigint: true });
  if (!top.isDirectory() || top.isSymbolicLink() || !git.isDirectory() || git.isSymbolicLink())
    throw new GroupGitBlocked(
      'Linked gitdir/common-dir requires a separately pinned resource; unsupported',
    );
  return { id, root, gitDirectory, rootIdentity: identity(top), gitIdentity: identity(git), bare };
}
export async function verifyResource(resource: PinnedGitResource): Promise<void> {
  if (
    (await realpath(resource.root)) !== resource.root ||
    (await realpath(resource.gitDirectory)) !== resource.gitDirectory
  )
    throw new GroupGitBlocked('Git resource mapping changed');
  for (const [path, expected] of [
    [resource.root, resource.rootIdentity],
    [resource.gitDirectory, resource.gitIdentity],
  ]) {
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || identity(info) !== expected)
      throw new GroupGitBlocked('Git resource identity changed');
  }
  for (const name of [
    'commondir',
    'shallow',
    'objects/info/alternates',
    'objects/info/http-alternates',
  ]) {
    try {
      await lstat(join(resource.gitDirectory, name));
      throw new GroupGitBlocked('Unsupported Git common-dir, shallow or alternate object store');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
/** Strict canonical ancestors and stable open-file identity. The host root must be outside
 * agent write grants. These checks detect ordinary swaps; they are not an OS sandbox for
 * active editor paths. Active copies are never mutated or adopted as observation stores. */
export async function readPinnedFile(
  root: string,
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  let parent = dirname(path);
  const ancestors: { path: string; identity: string }[] = [];
  while (true) {
    const info = await lstat(parent, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new GroupGitBlocked('Unsafe Git data ancestor');
    ancestors.push({ path: parent, identity: identity(info) });
    if (parent === root) break;
    const next = dirname(parent);
    if (next === parent) throw new GroupGitBlocked('Git data escaped resource');
    parent = next;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes))
      throw new GroupGitBlocked('Git input byte limit');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      length !== Number(before.size) ||
      identity(before) !== identity(current) ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new GroupGitBlocked('Git input changed');
    for (const ancestor of ancestors) {
      const now = await lstat(ancestor.path, { bigint: true });
      if (now.isSymbolicLink() || identity(now) !== ancestor.identity)
        throw new GroupGitBlocked('Git data ancestor changed');
    }
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
export async function createGitStore(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await mkdir(join(path, 'objects'), { mode: 0o700 });
  await mkdir(join(path, 'refs'), { mode: 0o700 });
  await writeFile(join(path, 'HEAD'), 'ref: refs/heads/host-unborn\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(path, 'config'), '[core]\nrepositoryformatversion = 0\nbare = true\n', {
    flag: 'wx',
    mode: 0o600,
  });
}
/** Never copy config, includes, hooks, attributes, external-driver definitions or gitdir files.
 * Git sees only bounded data copies in a new host-owned directory, not mutable original metadata. */
export async function withGitShadow<T>(
  resource: PinnedGitResource,
  hostRoot: string,
  maxInputBytes: number,
  work: (shadow: string) => Promise<T>,
): Promise<T> {
  await verifyResource(resource);
  const shadow = await mkdtemp(join(hostRoot, 'git-shadow-'));
  let total = 0;
  let entries = 0;
  try {
    await mkdir(join(shadow, 'objects'), { mode: 0o700 });
    await mkdir(join(shadow, 'refs'), { mode: 0o700 });
    const copy = async (relative: string, optional = false): Promise<void> => {
      const from = join(resource.gitDirectory, relative);
      let info;
      try {
        info = await lstat(from);
      } catch (error) {
        if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (++entries > 32768) throw new GroupGitBlocked('Git input file limit');
      if (info.isSymbolicLink()) throw new GroupGitBlocked('Symlink in Git data store');
      if (info.isDirectory()) {
        await mkdir(join(shadow, relative), { recursive: true, mode: 0o700 });
        for (const name of await readdir(from)) {
          if (relative === 'objects' && !/^(?:[a-f0-9]{2}|pack)$/.test(name)) continue;
          if (relative === 'objects/pack' && !/^pack-[a-f0-9]{40}\.(?:pack|idx)$/.test(name))
            continue;
          if (name === '.' || name === '..') throw new GroupGitBlocked('Unsafe Git data name');
          await copy(`${relative}/${name}`);
        }
      } else {
        const bytes = await readPinnedFile(resource.gitDirectory, from, maxInputBytes - total);
        total += bytes.length;
        await mkdir(dirname(join(shadow, relative)), { recursive: true, mode: 0o700 });
        await writeFile(join(shadow, relative), bytes, { flag: 'wx', mode: 0o600 });
      }
    };
    for (const name of ['objects', 'refs', 'HEAD', 'packed-refs', 'index', 'info/exclude'])
      await copy(name, name === 'packed-refs' || name === 'index' || name === 'info/exclude');
    // Split-index requires a different bound/pinning contract; never follow its mutable shared file.
    try {
      const index = await readPinnedFile(shadow, join(shadow, 'index'), maxInputBytes);
      if (index.includes(Buffer.from('link')))
        throw new GroupGitBlocked('Split index is unsupported');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFile(
      join(shadow, 'config'),
      '[core]\nrepositoryformatversion = 0\nbare = true\n[protocol]\nallow = never\n',
      { flag: 'wx', mode: 0o600 },
    );
    await verifyResource(resource);
    return await work(shadow);
  } finally {
    await rm(shadow, { recursive: true, force: true });
  }
}
export async function durableFile(path: string, bytes: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.git-write-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    const parent = await open(dirname(path), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
