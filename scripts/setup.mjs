import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { executableEntry } from './executables.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(
    'sciencewithagents needs Node 24 or newer. Ask your setup agent to install a supported version.',
  );
  process.exit(1);
}
try {
  execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 10_000 });
  const available = [];
  for (const [label, command, environment, identifies] of [
    ['Codex CLI', 'codex', 'DOCK_CODEX_BIN', /^codex-cli\s+\S+/],
    ['Claude Code', 'claude', 'DOCK_CLAUDE_BIN', /\bClaude Code\b/],
  ]) {
    const explicit = process.env[environment] !== undefined;
    const binary = await executableEntry(process.env[environment] ?? command, {
      label,
      required: explicit,
    });
    if (!binary) continue;
    try {
      const version = execFileSync(binary, ['--version'], {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 8192,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (!identifies.test(version))
        throw new Error(
          `The selected executable did not identify itself as ${label}. Check its host setup selection.`,
        );
      available.push(label);
      console.log(`${label}: ${version} (${binary})`);
    } catch (error) {
      if (explicit) throw error;
      console.warn(
        `${label} could not be verified. The app can open; repair that provider before starting its agents. No sign-in was attempted.`,
      );
    }
  }
  const providers = available.length
    ? `Available providers: ${available.join(', ')}.`
    : 'No agent provider is available yet. The app can open; use Welcome and setup to connect Codex or Claude before starting work.';
  console.log(
    'Install or update your chosen CLI before checking models. A desktop app alone is not enough. Terminal commands: docs/CONTRIBUTOR_SETUP.md#install-or-update-your-agent-cli',
  );
  const source = resolve(root),
    home = homedir();
  if (
    source.startsWith(join(home, 'Documents') + '/') ||
    /(?:^|\/)(?:Mobile Documents|CloudStorage|Dropbox|OneDrive|Google Drive)(?:\/|$)/i.test(source)
  )
    console.warn(
      'This source folder may be cloud-synced. Prefer a local Developer folder before creating projects: syncing live databases and worktrees can cause conflicts. Existing folders have not been moved.',
    );
  if (process.argv.includes('--check')) {
    console.log(
      `Prerequisites available: Node 24+ and Git. ${providers} This check did not sign in, install dependencies or start the app.`,
    );
    process.exit(0);
  }
  for (const args of [['install', '--frozen-lockfile'], ['build']]) {
    execFileSync('sh', [join(root, 'scripts/pnpm'), ...args], {
      cwd: root,
      stdio: 'inherit',
      timeout: 10 * 60 * 1000,
    });
  }
  try {
    execFileSync(process.execPath, [join(root, 'scripts/setup-usage-collector.mjs')], {
      cwd: root,
      stdio: 'inherit',
      timeout: 180_000,
    });
  } catch {
    // This collector is optional. A network/checksum/platform failure must not be
    // mistaken for a broken source build or hide that quota readings remain unknown.
    console.warn(
      'Optional usage reader setup did not finish. The app can open; allowance readings stay unknown until the reader is repaired. QUARK may hold work that requires a fresh reading. Retry the usage-reader setup step when ready.',
    );
  }
  execFileSync(process.execPath, [join(root, 'scripts/create-launcher.mjs')], {
    cwd: root,
    stdio: 'inherit',
    timeout: 45_000,
  });
  console.log(
    `sciencewithagents is built. ${providers} Open Welcome and setup to choose your provider and check native sign-in and model choices. Initial account sign-in stays with the person. No background service or phone access was started.`,
  );
} catch (error) {
  console.error(
    `Setup did not finish: ${error.message}. Existing projects and history were not removed. Your setup agent can correct this step and retry.`,
  );
  process.exitCode = typeof error.status === 'number' ? error.status || 1 : 1;
}
