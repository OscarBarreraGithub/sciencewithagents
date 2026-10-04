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

it('provides direct locations and an ancestor path without accepting filesystem paths', async () => {
  mkdirSync(join(root, 'Documents', 'Science', 'Analysis'), { recursive: true });
  mkdirSync(join(root, 'Downloads'));
  mkdirSync(join(root, 'Developer'));
  const home = await browser.browse();
  expect(home.locations.map((place) => place.name)).toEqual(
    expect.arrayContaining(['Home', 'Documents', 'Downloads', 'Developer', 'This computer']),
  );
  const documents = home.locations.find((place) => place.name === 'Documents')!;
  const science = (await browser.browse(documents.id)).folders.find(
    (folder) => folder.name === 'Science',
  )!;
  const analysis = (await browser.browse(science.id)).folders[0]!;
  const deep = await browser.browse(analysis.id);
  expect(deep.breadcrumbs.slice(-3).map((part) => part.name)).toEqual([
    'Documents',
    'Science',
    'Analysis',
  ]);
  expect(
    (await browser.browse(deep.breadcrumbs.find((part) => part.name === 'Documents')!.id)).current
      .id,
  ).toBe(documents.id);
  await expect(browser.resolve(join(root, 'Documents'))).rejects.toThrow('expired');
});

it('searches unlisted descendants, reports their locations and keeps hidden/private/link targets bounded', async () => {
  mkdirSync(join(root, 'Documents', 'Nested', 'Measurements'), { recursive: true });
  mkdirSync(join(root, '.hidden', 'Measurements'), { recursive: true });
  mkdirSync(join(root, 'private', 'Measurements'));
  symlinkSync(root, join(root, 'Documents', 'Nested', 'loop'));
  symlinkSync(join(root, 'Documents', 'Nested', 'Measurements'), join(root, 'Measurements alias'));
  const all = await browser.browse(undefined, 0, { query: 'measurements' });
  expect(all.folders).toHaveLength(1); // One real folder, even when reached through aliases.
  expect(all.folders[0]!.location).toBe(join('Documents', 'Nested'));
  expect(await browser.resolve(all.folders[0]!.id)).toBe(
    join(root, 'Documents', 'Nested', 'Measurements'),
  );
  const local = await browser.browse(undefined, 0, { query: 'Measurements', scope: 'children' });
  expect(local.folders.map((folder) => folder.name)).toEqual(['Measurements alias']);
  const hidden = await browser.browse(undefined, 0, { query: 'Measurements', hidden: true });
  expect(hidden.folders).toHaveLength(2);
  expect(hidden.folders.some((folder) => folder.location.startsWith('private'))).toBe(false);
  expect((await browser.browse()).folders.some((folder) => folder.name === '.hidden')).toBe(false);
  expect(
    (await browser.browse(undefined, 0, { hidden: true })).folders.some(
      (folder) => folder.name === '.hidden',
    ),
  ).toBe(true);
});

it('bounds broad searches and marks partial results rather than claiming every folder was searched', async () => {
  for (let n = 0; n < 105; n++) mkdirSync(join(root, `Match ${n}`));
  const result = await browser.browse(undefined, 0, { query: 'Match' });
  expect(result.folders).toHaveLength(100);
  expect(result.search?.partial).toBe(true);
  expect(result.nextOffset).toBeNull();
});
