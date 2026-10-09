import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('read-only setup check warns about actually absent Python without failing or installing core tools', () => {
  const directory = mkdtempSync(join(tmpdir(), 'swa-report-prerequisite-'));
  try {
    writeFileSync(join(directory, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const env = { ...process.env, PATH: directory };
    delete env.DOCK_CODEX_BIN;
    delete env.DOCK_CLAUDE_BIN;
    const output = spawnSync(process.execPath, ['scripts/setup.mjs', '--check'], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(output.status, 0);
    assert.match(output.stdout, /Prerequisites available: Node 24\+ and Git/);
    assert.match(output.stderr, /Native Group report capture is unavailable/);
    assert.match(output.stderr, /no tool was installed/);
    assert.match(output.stderr, /Core installation and existing PDFs remain available/);
    assert.deepEqual(readdirSync(directory), ['git']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
