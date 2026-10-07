import { mkdir, writeFile, readdir, lstat, chmod, rename, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  GroupGitBlocked,
  digest,
  sharedPath,
  type ImmutableViews,
  type ViewExpectation,
  type ViewFile,
} from './group-git.js';

const receiptSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
    repositoryId: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
    baseOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const viewManifestDigest = (files: readonly ViewFile[]) =>
  digest(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => [f.path, f.mode, digest(f.bytes.toString('base64'))]),
  );

async function boundedRead(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error('View byte limit');
    const buffer = Buffer.alloc(Math.min(Number(before.size) + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      length > maxBytes ||
      length !== Number(before.size) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.ino !== current.ino ||
      before.dev !== current.dev ||
      current.isSymbolicLink()
    )
      throw new Error('View changed during verification');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** Host-owned immutable views only. Not a working copy creator or a resource sandbox. */
export class DirectoryGitViews implements ImmutableViews {
  constructor(
    private readonly root: string,
    private readonly limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number },
  ) {
    for (const limit of Object.values(limits))
      z.number()
        .int()
        .positive()
        .max(64 * 1024 * 1024)
        .parse(limit);
  }
  private async directory(id: string, create = false): Promise<string> {
    z.string()
      .regex(/^[a-zA-Z0-9_-]{1,160}$/)
      .parse(id);
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await realpath(this.root)) !== resolve(this.root))
      throw new Error('View root must be canonical and host-owned');
    const path = join(this.root, id);
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe view directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return path;
  }
  private async receipt(path: string): Promise<ViewExpectation> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
      throw new Error('Invalid view receipt');
    return receiptSchema.parse(JSON.parse((await boundedRead(path, 4096)).toString('utf8')));
  }
  async inspect(id: string): Promise<ViewExpectation | null> {
    let directory: string;
    try {
      directory = await this.directory(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let expected;
    try {
      expected = await this.receipt(join(directory, 'receipt.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await lstat(directory);
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw missing;
        }
        throw new GroupGitBlocked('Existing directory lacks a view receipt');
      }
      throw error;
    }
    if (expected.id !== id) throw new Error('View identity mismatch');
    const files: ViewFile[] = [];
    let total = 0;
    let entriesSeen = 0;
    const walk = async (path: string, relative: string) => {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe view path');
      const entries = await readdir(path);
      entriesSeen += entries.length;
      if (entriesSeen > this.limits.maxFiles * 16) throw new Error('View directory limit');
      if (entries.length > this.limits.maxFiles) throw new Error('View file limit');
      for (const name of entries.sort()) {
        const child = join(path, name);
        const relativeChild = relative ? `${relative}/${name}` : name;
        sharedPath(relativeChild);
        const stat = await lstat(child);
        if (stat.isSymbolicLink()) throw new Error('Unsafe view path');
        if (stat.isDirectory()) {
          await walk(child, relativeChild);
          continue;
        }
        if (
          !stat.isFile() ||
          stat.size > this.limits.maxFileBytes ||
          files.length >= this.limits.maxFiles
        )
          throw new Error('View file limit');
        total += stat.size;
        if (total > this.limits.maxTotalBytes) throw new Error('View byte limit');
        const bytes = await boundedRead(
          child,
          Math.min(this.limits.maxFileBytes, this.limits.maxTotalBytes - total + stat.size),
        );
        if (bytes.length !== stat.size) throw new Error('View changed during verification');
        files.push({ path: relativeChild, mode: stat.mode & 0o111 ? '100755' : '100644', bytes });
      }
    };
    await walk(join(directory, 'content'), '');
    if (viewManifestDigest(files) !== expected.manifestDigest)
      throw new Error('Immutable view content changed');
    return expected;
  }
  async create(input: ViewExpectation, files: readonly ViewFile[]): Promise<void> {
    const expected = receiptSchema.parse(input);
    if (
      files.length > this.limits.maxFiles ||
      viewManifestDigest(files) !== expected.manifestDigest
    )
      throw new Error('View manifest mismatch or limit');
    let total = 0;
    const seen = new Set<string>();
    for (const file of files) {
      sharedPath(file.path);
      if (seen.has(file.path) || !['100644', '100755'].includes(file.mode))
        throw new Error('Invalid view entry');
      seen.add(file.path);
      total += file.bytes.length;
      if (file.bytes.length > this.limits.maxFileBytes || total > this.limits.maxTotalBytes)
        throw new Error('View byte limit');
    }
    const directory = await this.directory(expected.id, true);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const actual = await this.inspect(expected.id);
      if (!actual || digest(actual) !== digest(expected))
        throw new Error('Existing directory must not be overwritten');
      return;
    }
    // Reserved directory is never replaced. A crash before receipt is intentionally not adopted;
    // the host must reconcile/quarantine partial output, never reset or delete user content.
    const content = join(directory, 'content');
    await mkdir(content, { mode: 0o700 });
    const directories = new Set<string>([content]);
    for (const file of files) {
      const path = join(content, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      let parent = dirname(path);
      while (parent !== directory) {
        directories.add(parent);
        if (parent === content) break;
        parent = dirname(parent);
      }
      const handle = await open(path, 'wx', file.mode === '100755' ? 0o555 : 0o444);
      try {
        await handle.writeFile(file.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const path of [...directories].sort((a, b) => b.length - a.length)) {
      const directoryHandle = await open(path, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      await chmod(path, 0o555);
    }
    const temporary = join(directory, `receipt-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(expected), { flag: 'wx', mode: 0o400 });
    const handle = await open(temporary, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, 'receipt.json'));
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await chmod(directory, 0o555);
  }
}
