import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolderBrowser } from './folder-browser.js';
let root: string, browser: FolderBrowser;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'swa-browser-')));
  mkdirSync(join(root, 'private'));
  mkdirSync(join(root, 'Project'));
  writeFileSync(join(root, 'private', 'secret'), 'never list this');
  writeFileSync(join(root, 'file'), 'not a folder');
  symlinkSync(join(root, 'private'), join(root, 'private-link'));
  browser = new FolderBrowser(join(root, 'private'), root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('returns opaque folder identities, excludes private storage and files, and rechecks replacements', async () => {
  const list = await browser.browse();
  expect(list.current.canSelect).toBe(false);
  expect(list.folders.map((f) => f.name)).toEqual(['Project']);
  expect(JSON.stringify(list)).not.toContain(root);
  const folder = list.folders[0]!;
  expect(await browser.resolve(folder.id)).toBe(join(root, 'Project'));
  expect((await browser.browse(folder.id)).current.canSelect).toBe(true);
  renameSync(join(root, 'Project'), join(root, 'old'));
  mkdirSync(join(root, 'Project'));
  await expect(browser.resolve(folder.id)).rejects.toThrow('changed');
  await expect(new FolderBrowser(join(root, 'private'), root).resolve(folder.id)).rejects.toThrow(
    'expired',
  );
});
it('paginates directories and returns stable IDs while navigating', async () => {
  for (let i = 0; i < 120; i++) mkdirSync(join(root, `Folder ${i}`));
  const first = await browser.browse();
  expect(first.folders).toHaveLength(100);
  expect(first.nextOffset).toBe(100);
  const second = await browser.browse(first.current.id, first.nextOffset!);
  expect(second.folders).toHaveLength(21);
  expect(second.nextOffset).toBeNull();
  const child = await browser.browse(first.folders[0]!.id);
  expect(child.parentId).toBe(first.current.id);
});
