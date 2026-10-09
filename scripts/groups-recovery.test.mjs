import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile, symlink, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { saveGroups, verifyGroups, stageGroups, recoveryInventory } from './groups-recovery.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'groups-recovery-')));
  await mkdir(join(root, 'launcher'), { mode: 0o700 });
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await writeFile(join(root, 'launcher/config.json'), JSON.stringify({ dataDir: root, port }));
  await mkdir(join(root, 'groups'), { mode: 0o700 });
  const db = new DatabaseSync(join(root, 'dock.sqlite'));
  db.exec(
    "CREATE TABLE runs(body TEXT); CREATE TABLE tasks(id TEXT,project_id TEXT,body TEXT); CREATE TABLE settings(value TEXT); INSERT INTO settings VALUES('original identity')",
  );
  db.close();
  const host = new DatabaseSync(join(root, 'groups/host-native.sqlite'));
  host.exec(
    'CREATE TABLE hnr_bindings(body TEXT); INSERT INTO hnr_bindings VALUES(\'{"projectId":"project"}\')',
  );
  host.close();
  await writeFile(join(root, 'groups/config.json'), '{"privateCredential":"PRIVATE_FIXTURE"}', {
    mode: 0o600,
  });
  return { root, port };
}
test('offline archive preserves Group/task bytes and identities, verifies receipt, and stages without opening or replacing live data', async () => {
  const { root } = await fixture();
  try {
    const task = join(root, 'worktrees/task');
    await mkdir(task, { recursive: true, mode: 0o700 });
    await writeFile(join(task, 'unfinished.txt'), 'unfinished change');
    await mkdir(join(root, 'groups/host-workspaces/empty-ask'), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(root, 'dock.sqlite'));
    db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(
      'task',
      'project',
      JSON.stringify({ worktree: task }),
    );
    db.close();
    const saved = await saveGroups(root);
    assert.equal(saved.externalWorktrees, 0);
    assert.equal((await verifyGroups(root, saved.id)).verified, true);
    const staged = await stageGroups(root, saved.id);
    assert.equal(staged.started, false);
    const stage = join(root, 'group-recovery-staging', staged.stageId);
    assert.equal((await stat(join(stage, 'groups/host-workspaces/empty-ask'))).isDirectory(), true);
    assert.equal(
      await readFile(join(stage, 'worktrees/task/unfinished.txt'), 'utf8'),
      'unfinished change',
    );
    assert.equal(
      await readFile(join(stage, 'groups/config.json'), 'utf8'),
      await readFile(join(root, 'groups/config.json'), 'utf8'),
    );
    assert.equal((await stat(join(stage, 'groups/config.json'))).mode & 0o077, 0);
    const restored = new DatabaseSync(join(stage, 'dock.sqlite'), { readOnly: true });
    assert.equal(restored.prepare('SELECT value FROM settings').get().value, 'original identity');
    restored.close();
    await writeFile(join(root, 'group-recovery', saved.id, 'groups/config.json'), 'changed');
    await assert.rejects(verifyGroups(root, saved.id), /bytes changed/);
    assert.equal(
      await readFile(join(root, 'groups/config.json'), 'utf8'),
      '{"privateCredential":"PRIVATE_FIXTURE"}',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('source inventory detects a main-database WAL-only write', async () => {
  const { root } = await fixture();
  const db = new DatabaseSync(join(root, 'dock.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    const before = await recoveryInventory([join(root, 'dock.sqlite')]);
    const mainBefore = await stat(join(root, 'dock.sqlite'));
    db.exec("INSERT INTO settings VALUES('new queued identity')");
    assert.equal((await stat(join(root, 'dock.sqlite'))).mtimeMs, mainBefore.mtimeMs);
    assert.notEqual(await recoveryInventory([join(root, 'dock.sqlite')]), before);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('refuses a listening app, recorded running work and linked files without changing originals', async () => {
  const { root, port } = await fixture();
  const listener = createServer();
  try {
    await new Promise((resolve) => listener.listen(port, '127.0.0.1', resolve));
    await assert.rejects(saveGroups(root), /Quit sciencewithagents/);
    await new Promise((resolve) => listener.close(resolve));
    const db = new DatabaseSync(join(root, 'dock.sqlite'));
    db.exec('INSERT INTO runs VALUES(\'{"status":"running"}\')');
    await assert.rejects(saveGroups(root), /Running work/);
    db.exec('DELETE FROM runs');
    db.close();
    await symlink(join(root, 'groups/config.json'), join(root, 'groups/unsafe-link'));
    await assert.rejects(saveGroups(root), /file type/);
    assert.equal(
      await readFile(join(root, 'groups/config.json'), 'utf8'),
      '{"privateCredential":"PRIVATE_FIXTURE"}',
    );
  } finally {
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
