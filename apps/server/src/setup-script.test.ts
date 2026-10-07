import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './paths.js';
const exec = promisify(execFile);
it('verifies stable Homebrew discovery and preservation of explicit executable choices', async () => {
  await exec(process.execPath, ['--test', join(repoRoot, 'scripts/executables.test.mjs')], {
    timeout: 10_000,
  });
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(cloud = false) {
  const temporary = mkdtempSync(join(tmpdir(), 'swa-setup-script-'));
  roots.push(temporary);
  const root = cloud ? join(temporary, 'CloudStorage', 'project') : temporary;
  const scripts = join(root, 'scripts'),
    bin = join(root, 'bin');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin);
  for (const file of ['setup.mjs', 'executables.mjs'])
    copyFileSync(join(repoRoot, 'scripts', file), join(scripts, file));
  writeFileSync(join(scripts, 'pnpm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> setup-steps\n', {
    mode: 0o700,
  });
  writeFileSync(join(scripts, 'setup-usage-collector.mjs'), 'process.exit(1);');
  writeFileSync(
    join(scripts, 'create-launcher.mjs'),
    "import { writeFileSync } from 'node:fs'; writeFileSync('launcher-made', 'yes');",
  );
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(
    join(bin, 'codex'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli fixture"; exit 0; fi\nexit 7\n',
    { mode: 0o700 },
  );
  symlinkSync('/bin/sh', join(bin, 'sh'));
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin };
  delete env.DOCK_CODEX_BIN;
  delete env.DOCK_CLAUDE_BIN;
  return {
    root,
    bin,
    run: (args: string[] = [], patch: NodeJS.ProcessEnv = {}) =>
      exec(process.execPath, [join(scripts, 'setup.mjs'), ...args], {
        cwd: root,
        env: { ...env, ...patch },
        timeout: 10_000,
      }),
  };
}
it('checks prerequisites without installation or sign-in and refuses a missing or wrong Codex executable before writes', async () => {
  const f = fixture();
  const check = (await f.run(['--check'])).stdout;
  expect(check).toContain('Prerequisites available');
  expect(check).toContain(`Codex CLI: codex-cli fixture (${join(f.bin, 'codex')})`);
  expect(check).toContain('docs/CONTRIBUTOR_SETUP.md#install-or-update-your-agent-cli');
  expect(existsSync(join(f.root, 'setup-steps'))).toBe(false);
  await expect(f.run([], { DOCK_CODEX_BIN: '/missing/codex' })).rejects.toThrow('Codex CLI');
  await expect(f.run([], { DOCK_CODEX_BIN: process.execPath })).rejects.toThrow(
    'did not identify itself',
  );
  expect(existsSync(join(f.root, 'setup-steps'))).toBe(false);
  expect(existsSync(join(f.root, 'launcher-made'))).toBe(false);
});
it('finishes app setup after an optional reader failure, reports unknown quotas and keeps cloud-folder advice non-destructive', async () => {
  const f = fixture(true);
  const result = await f.run();
  expect(result.stderr).toContain('may be cloud-synced');
  expect(result.stderr).toContain('allowance readings stay unknown');
  expect(result.stdout).toContain('Available providers: Codex CLI');
  expect(readFileSync(join(f.root, 'setup-steps'), 'utf8')).toBe(
    'install --frozen-lockfile\nbuild\n',
  );
  expect(readFileSync(join(f.root, 'launcher-made'), 'utf8')).toBe('yes');
});

it('builds for Claude-only and no-provider installations, with explicit invalid choices still rejected', async () => {
  const f = fixture();
  rmSync(join(f.bin, 'codex'));
  writeFileSync(
    join(f.bin, 'claude'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\nexit 7\n',
    { mode: 0o700 },
  );
  expect((await f.run()).stdout).toContain('Available providers: Claude Code');
  expect(existsSync(join(f.root, 'launcher-made'))).toBe(true);
  rmSync(join(f.bin, 'claude'));
  expect((await f.run()).stdout).toContain('No agent provider is available yet');
  await expect(f.run(['--check'], { DOCK_CLAUDE_BIN: '/missing/claude' })).rejects.toThrow(
    'Claude Code',
  );
});
