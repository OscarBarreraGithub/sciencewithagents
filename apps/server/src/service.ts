import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { binary, dataDir, port, repoRoot } from './paths.js';

const exec = promisify(execFile);
const label = 'dev.agentdock.server';
export async function waitForServiceExit(pid: number | undefined, timeout = 10_000) {
  if (pid === undefined) return;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid service process ID.');
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() >= deadline)
      throw new Error(
        'sciencewithagents is still shutting down. Wait for its process to exit before restarting; history is retained.',
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function unloadService(target: string, required = false) {
  let state: string;
  try {
    state = (await exec('launchctl', ['print', target])).stdout;
  } catch (error) {
    if (required) throw error;
    else return;
  }
  const match = state.match(/\n\tpid = (\d+)/);
  await exec('launchctl', ['bootout', target]);
  // bootout can acknowledge before Node has closed all provider processes. Do
  // not report "stopped" or bootstrap a replacement while that PID is alive.
  await waitForServiceExit(match ? Number(match[1]) : undefined);
}
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
async function verifyService(target: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const state = (await exec('launchctl', ['print', target])).stdout;
      const pid = Number(state.match(/\n\tpid = (\d+)/)?.[1]);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const health = (await response.json()) as { ok?: boolean; pid?: number };
      if (response.ok && health.ok && health.pid === pid) return;
    } catch {
      /* Startup is still in progress. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    await unloadService(target);
  } catch {}
  throw new Error(
    'The login service did not become healthy and has been unloaded. Check data/logs/service.stderr.log. macOS may block background access to Documents/Desktop; use an owner-approved development directory or grant access in System Settings. Foreground use is pnpm start.',
  );
}
export async function service(action: string) {
  if (process.platform !== 'darwin')
    throw new Error(
      'The service helper currently supports macOS. On Linux, supervise pnpm start with your user service manager.',
    );
  const domain = `gui/${process.getuid!()}`;
  const target = `${domain}/${label}`;
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  if (action === 'status') {
    try {
      const { stdout } = await exec('launchctl', ['print', target]);
      console.log(
        stdout
          .split('\n')
          .filter((line) => /^\t(?:state =|pid =|last exit code)/.test(line))
          .map((line) => line.trim())
          .join('\n'),
      );
    } catch {
      console.log('sciencewithagents service is not loaded.');
    }
    return;
  }
  if (action === 'stop') {
    await unloadService(target, true);
    console.log('sciencewithagents stopped. Its history is retained.');
    return;
  }
  if (action === 'start') {
    await exec('launchctl', ['bootstrap', domain, plist]);
    await verifyService(target);
    console.log(`sciencewithagents started at http://127.0.0.1:${port}`);
    return;
  }
  if (action !== 'install') throw new Error('Use service install, start, stop, or status.');
  const entry = join(repoRoot, 'apps/server/dist/main.js');
  if (!existsSync(entry)) throw new Error('Run pnpm build before installing the service.');
  const codex = realpathSync(
    isAbsolute(binary) ? binary : (await exec('/usr/bin/which', [binary])).stdout.trim(),
  );
  mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
  mkdirSync(join(dataDir, 'logs'), { recursive: true, mode: 0o700 });
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string></array>
<key>WorkingDirectory</key><string>${xml(repoRoot)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/bin:/bin')}</string><key>DOCK_DATA_DIR</key><string>${xml(dataDir)}</string><key>DOCK_CODEX_BIN</key><string>${xml(codex)}</string><key>DOCK_PORT</key><string>${port}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml(join(dataDir, 'logs/service.stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(dataDir, 'logs/service.stderr.log'))}</string>
</dict></plist>\n`;
  const preview = join(dataDir, 'service.plist');
  writeFileSync(preview, body, { mode: 0o600 });
  await exec('/usr/bin/plutil', ['-lint', preview]);
  writeFileSync(plist, body, { mode: 0o600 });
  await unloadService(target);
  await exec('launchctl', ['bootstrap', domain, plist]);
  await verifyService(target);
  console.log(
    `sciencewithagents will start after login and restart after failure. Open http://127.0.0.1:${port}`,
  );
}
