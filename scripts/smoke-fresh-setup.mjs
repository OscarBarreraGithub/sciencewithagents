/** Source-only collaborator setup check. No browser, owner installation, or model calls. */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--run')) {
  console.log(
    'Use --run to verify source-only setup in a disposable copy. No browser or owner app is opened.',
  );
  process.exit(0);
}
process.umask(0o077);
const root = fileURLToPath(new URL('../', import.meta.url));
const receiptDir = join(root, 'data/smoke', `fresh-setup-${randomUUID().slice(0, 8)}`);
mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
const copy = mkdtempSync(join(tmpdir(), 'dock-fresh-'));
const receipt = {
  version: 1,
  startedAt: new Date().toISOString(),
  sourceFiles: 0,
  setup: false,
  verification: false,
  launcherCompiled: false,
  removedDisposableCopy: false,
};
const log = openSync(join(receiptDir, 'verification.log'), 'a', 0o600);
const env = {
  ...process.env,
  DOCK_DATA_DIR: join(copy, 'data'),
  // All tests use fake providers. Even the empty real-main fixture must not read an account.
  DOCK_CODEX_BIN: join(copy, 'setup-bin/codex'),
  npm_config_cache: join(copy, 'data/npm-cache'),
  npm_config_store_dir: join(copy, 'data/pnpm-store'),
};
async function run(binary, args) {
  const child = spawn(binary, args, { cwd: copy, env, stdio: ['ignore', log, log] });
  let timer;
  try {
    const result = await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('exit', (code, signal) => done({ code, signal }));
      timer = setTimeout(
        () => {
          child.kill('SIGTERM');
        },
        12 * 60 * 1000,
      );
    });
    if (result.code !== 0)
      throw new Error(
        `Disposable setup step failed (${result.code ?? result.signal}); inspect its private log.`,
      );
  } finally {
    clearTimeout(timer);
  }
}
try {
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  for (const file of new Set(files)) {
    if (
      file.startsWith('data/') ||
      file.split('/').some((part) => ['node_modules', 'dist', '.git', '.codex'].includes(part))
    )
      throw new Error('A private or generated file was unexpectedly included in the source list.');
    const source = join(root, file);
    if (!existsSync(source)) continue; // Respect a tracked deletion in the active worktree.
    if (!lstatSync(source).isFile())
      throw new Error('Source-only verification requires regular source files.');
    const destination = join(copy, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    receipt.sourceFiles++;
  }
  mkdirSync(join(copy, 'setup-bin'), { recursive: true });
  writeFileSync(
    env.DOCK_CODEX_BIN,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli setup-fixture"; exit 0; fi\nexit 1\n',
    { mode: 0o700 },
  );
  for (const file of ['data', 'node_modules', 'apps/server/dist', 'apps/web/dist'])
    if (existsSync(join(copy, file))) throw new Error('Disposable setup was not fresh.');
  console.log(
    `Fresh source copied (${receipt.sourceFiles} files). Installing and building privately…`,
  );
  await run(process.execPath, ['scripts/setup.mjs']);
  receipt.setup = true;
  const config = JSON.parse(readFileSync(join(copy, 'data/launcher/config.json'), 'utf8'));
  if (config.root !== realpathSync(copy) || config.dataDir !== join(copy, 'data'))
    throw new Error('The generated launcher did not stay inside the disposable copy.');
  receipt.launcherCompiled =
    process.platform === 'darwin'
      ? existsSync(join(copy, 'data/launcher/sciencewithagents.app/Contents/MacOS/applet'))
      : false;
  console.log(
    'Fresh setup passed. Running complete type, backend, and production-build verification…',
  );
  await run('sh', ['scripts/pnpm', 'verify']);
  receipt.verification = true;
  const processes = execFileSync('/bin/ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8' });
  if (processes.split('\n').some((line) => line.includes(copy)))
    throw new Error('A disposable-copy process remains; inspect it before removing its files.');
  rmSync(copy, { recursive: true });
  receipt.removedDisposableCopy = true;
  console.log('Fresh setup and verification passed; the disposable copy was removed.');
} catch (error) {
  receipt.error = error.message;
  receipt.retainedDisposableCopy = copy;
  process.exitCode = 1;
  console.error(
    'The fresh setup check needs attention. Only its disposable copy and private log were retained.',
  );
} finally {
  closeSync(log);
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(join(receiptDir, 'verification.json'), JSON.stringify(receipt, null, 2), {
    mode: 0o600,
  });
  console.log(`Verification receipt: ${join(receiptDir, 'verification.json')}`);
}
