import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureGroups } from './groups-claude-setup.mjs';

test('setup retains the exact private connection across retries and refuses another installation or a symlink', () => {
  const base = join(dirname(fileURLToPath(import.meta.url)), '../data/groups-setup-tests');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(base, 'case-'));
  try {
    const data = join(root, 'data'),
      other = join(root, 'other');
    for (const path of [data, other]) {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(
        join(path, 'local-access.json'),
        JSON.stringify({
          version: 1,
          origin: 'http://127.0.0.1:4330',
          owner: 'private-owner-secret',
        }),
        { mode: 0o600 },
      );
    }
    const file = join(root, 'connection/config.json');
    assert.equal(configureGroups(data, file), file);
    const original = readFileSync(file, 'utf8');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
    assert.ok(!original.includes('private-owner-secret'));
    assert.equal(configureGroups(data, file), file);
    assert.throws(() => configureGroups(other, file), /another installation/);
    assert.equal(readFileSync(file, 'utf8'), original);
    const linked = join(root, 'connection/linked.json');
    symlinkSync(file, linked);
    assert.throws(() => configureGroups(data, linked));
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
