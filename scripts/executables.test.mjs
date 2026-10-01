import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executableEntry, nodeEntry } from './executables.mjs';

test('automatic discovery survives removal of a Cellar target while absolute choices stay exact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-executables-'));
  const oldPath = process.env.PATH;
  try {
    const versioned = join(root, 'Cellar/node/24-fixture/bin');
    const stable = join(root, 'bin');
    mkdirSync(versioned, { recursive: true });
    mkdirSync(stable);
    const pinned = join(versioned, 'node');
    const alias = join(stable, 'node');
    symlinkSync(process.execPath, pinned);
    symlinkSync(pinned, alias);
    process.env.PATH = versioned + ':' + stable;
    assert.equal(await nodeEntry(), alias);
    assert.equal(await executableEntry('node'), alias);
    assert.equal(await nodeEntry(pinned), pinned);
    assert.equal(await executableEntry(pinned), pinned);
    unlinkSync(alias);
    symlinkSync(process.execPath, alias);
    unlinkSync(pinned);
    assert.equal(execFileSync(alias, ['--version'], { encoding: 'utf8' }).trim(), process.version);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('discovery preserves the selected version when the global alias points elsewhere', async () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-executables-'));
  try {
    const versioned = join(root, 'Cellar/node@24/24-fixture/bin');
    const stable = join(root, 'bin');
    const opt = join(root, 'opt/node@24/bin');
    for (const folder of [versioned, stable, opt]) mkdirSync(folder, { recursive: true });
    const pinned = join(versioned, 'node');
    symlinkSync(process.execPath, pinned);
    symlinkSync('/bin/sh', join(stable, 'node'));
    symlinkSync(pinned, join(opt, 'node'));
    assert.equal(await executableEntry('node', { directories: [versioned] }), join(opt, 'node'));
    unlinkSync(join(opt, 'node'));
    assert.equal(await executableEntry('node', { directories: [versioned] }), pinned);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
