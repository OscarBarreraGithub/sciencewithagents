import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertGroupGitBlob, groupProjectDataAllowed } from './group-native-git-files.js';
import { groupNativePrivatePath } from './group-native-private-path.js';
import { git } from './workspaces.js';

let directory: string;
beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'group-git-blob-')));
  await git(directory, ['init', '--initial-branch=main']);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
async function blob(name: string, bytes: Buffer) {
  writeFileSync(join(directory, name), bytes);
  return git(directory, ['hash-object', '-w', name]);
}
it('streams a committed binary above the old 4MiB limit and checks exact length without mutable files', async () => {
  const bytes = Buffer.alloc(5 * 1024 ** 2, 0x41);
  bytes[0] = 0;
  const oid = await blob('figure.bin', bytes);
  writeFileSync(join(directory, 'figure.bin'), 'A later unrelated working file');
  await expect(assertGroupGitBlob(directory, oid, bytes.length)).resolves.toBeUndefined();
  await expect(assertGroupGitBlob(directory, oid, bytes.length - 1)).rejects.toThrow('verified');
  await expect(assertGroupGitBlob(directory, oid, bytes.length + 1)).rejects.toThrow('verified');
});
it('refuses a credential in a large committed binary without returning its bytes', async () => {
  const bytes = Buffer.alloc(5 * 1024 ** 2, 0);
  const token = `ghp_${'a'.repeat(36)}`;
  bytes.write(token, 65_520, 'ascii');
  const oid = await blob('bad.bin', bytes);
  await expect(assertGroupGitBlob(directory, oid, bytes.length)).rejects.toThrow(
    'likely credential',
  );
  try {
    await assertGroupGitBlob(directory, oid, bytes.length);
  } catch (error) {
    expect(String(error)).not.toContain(token);
  }
});
it('refuses oversized blobs and invalid identities before starting a Git read', async () => {
  const missing = 'a'.repeat(40);
  await expect(assertGroupGitBlob(directory, missing, 100 * 1024 ** 2)).rejects.toThrow('100 MiB');
  await expect(assertGroupGitBlob(directory, '--help', 1)).rejects.toThrow('No files were sent');
  await expect(assertGroupGitBlob(directory, missing, 1)).rejects.toThrow('verified');
});
it('permits reviewed scientific data only outside canonical runtime storage and its ancestors', () => {
  const runtime = join(directory, 'runtime'),
    project = join(directory, 'science'),
    internal = join(runtime, 'groups', 'workspace');
  mkdirSync(internal, { recursive: true });
  mkdirSync(project);
  expect(groupProjectDataAllowed(project, runtime)).toBe(true);
  expect(groupProjectDataAllowed(internal, runtime)).toBe(false);
  expect(groupProjectDataAllowed(runtime, runtime)).toBe(false);
  expect(groupProjectDataAllowed(directory, runtime)).toBe(false);
  const alias = join(directory, 'alias');
  symlinkSync(project, alias, 'dir');
  expect(groupProjectDataAllowed(alias, runtime)).toBe(false);
  expect(groupNativePrivatePath('data/measurements.csv')).toBe(true);
  expect(groupNativePrivatePath('data/measurements.csv', true)).toBe(false);
  for (const name of [
    'data/auth.json',
    'data/private.sqlite',
    '.env',
    '.codex/auth.json',
    'logs/run.txt',
  ])
    expect(groupNativePrivatePath(name, true)).toBe(true);
});
