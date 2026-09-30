// Keep the small maintained usage reader; the menu-bar application need not run.
import {
  access,
  mkdir,
  copyFile,
  chmod,
  readFile,
  writeFile,
  rename,
  realpath,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = process.env.DOCK_DATA_DIR ?? join(root, 'data');
const target = join(dataDir, 'tools', 'codexbar');
const candidates = [
  process.env.DOCK_CODEXBAR_BIN,
  target,
  '/opt/homebrew/bin/codexbar',
  '/usr/local/bin/codexbar',
  ...(process.env.PATH ?? '')
    .split(':')
    .filter(Boolean)
    .map((part) => join(part, 'codexbar')),
].filter(Boolean);
let source;
for (const candidate of candidates) {
  try {
    await access(candidate, constants.X_OK);
    source = await realpath(candidate);
    break;
  } catch {
    /* Next known installation. */
  }
}
// Pinned standalone release for the verified Apple Silicon installation. No app bundle required.
if (!source && process.platform === 'darwin' && process.arch === 'arm64') {
  await mkdir(join(dataDir, 'tools'), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(dataDir, 'tools', 'codexbar-install-'));
  try {
    const archive = join(stage, 'reader.tar.gz');
    await execute(
      '/usr/bin/curl',
      [
        '--fail',
        '--location',
        '--proto',
        '=https',
        '--max-time',
        '120',
        '--max-filesize',
        '100000000',
        '--output',
        archive,
        'https://github.com/steipete/CodexBar/releases/download/v0.65.0/CodexBarCLI-v0.65.0-macos-arm64.tar.gz',
      ],
      { timeout: 130000, maxBuffer: 16000 },
    );
    if (
      createHash('sha256')
        .update(await readFile(archive))
        .digest('hex') !== '72ad0da39058a84f36cd178ac2a492eb139f8c9939997346302a43b19d4cf0fb'
    )
      throw new Error('Usage reader archive checksum differs; nothing installed.');
    await execute('/usr/bin/tar', ['-xzf', archive, '-C', stage, 'CodexBarCLI'], {
      timeout: 10000,
    });
    await execute(join(stage, 'CodexBarCLI'), ['--help'], { timeout: 10000, maxBuffer: 64000 });
    await copyFile(join(stage, 'CodexBarCLI'), target);
    await chmod(target, 0o700);
    source = target;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (!source) {
  console.log(
    'Usage collector is not installed. Ask your setup agent to install the standalone CodexBar CLI from its official release, then rerun this setup step. No account sign-in or model work was started.',
  );
  process.exitCode = 2;
} else {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const bytes = await readFile(source);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (source !== target) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    await copyFile(source, temporary);
    await chmod(temporary, 0o700);
    await execute(temporary, ['--help'], { timeout: 10_000, maxBuffer: 64 * 1024 });
    await rename(temporary, target);
  }
  await writeFile(
    join(dataDir, 'tools', 'codexbar-receipt.json'),
    JSON.stringify(
      {
        upstream: 'https://github.com/steipete/CodexBar',
        installedAt: new Date().toISOString(),
        sha256,
        purpose:
          'Standalone OAuth usage reader. No menu-bar process, model prompts or copied credentials.',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await copyFile(
    join(root, 'third_party', 'CodexBar-LICENSE'),
    join(dataDir, 'tools', 'CodexBar-LICENSE'),
  );
  console.log(
    'Standalone usage collector installed and checked. sciencewithagents can read usage without running the CodexBar menu-bar app.',
  );
}
