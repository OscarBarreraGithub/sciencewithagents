import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Conflict } from './store.js';

export const GROUP_NATIVE_GIT_FILE_LIMITS = {
  // Normal GitHub blobs only. This does not enable paid Git LFS.
  blobBytes: 100 * 1024 ** 2,
  scanBytes: 512 * 1024 ** 2,
} as const;
const credential =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16})\b/;

/** A project's data folder is distinct from the app's private runtime storage.
 * Legacy internal workspaces retain the stricter publication-name policy. */
export function groupProjectDataAllowed(cwd: string, dataDir: string): boolean {
  try {
    const project = realpathSync(cwd),
      runtime = realpathSync(dataDir);
    return (
      project === resolve(cwd) &&
      project !== runtime &&
      !project.startsWith(`${runtime}${sep}`) &&
      !runtime.startsWith(`${project}${sep}`)
    );
  } catch {
    return false;
  }
}

/** Scan an immutable committed blob, never a mutable working file. Keep only a
 * bounded overlap for credentials crossing pipe chunks; no file content is logged. */
export async function assertGroupGitBlob(cwd: string, oid: string, expectedBytes: number) {
  if (
    !/^[a-f0-9]{40,64}$/.test(oid) ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes >= GROUP_NATIVE_GIT_FILE_LIMITS.blobBytes
  )
    throw new Conflict('Shared files must be smaller than 100 MiB each. No files were sent.');
  await new Promise<void>((resolveScan, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', 'cat-file', 'blob', oid], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bytes = 0,
      overlap = '',
      failure: Conflict | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (message: string) => {
      if (failure) return;
      failure = new Conflict(message);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
      killTimer.unref();
    };
    const timeout = setTimeout(
      () => stop('Shared file inspection timed out. No files were sent; retry when ready.'),
      30_000,
    );
    timeout.unref();
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > expectedBytes) {
        stop('The committed file could not be verified. No files were sent.');
        return;
      }
      if (failure) return;
      // Credential signatures are ASCII, including when embedded in a binary.
      const text = overlap + chunk.toString('latin1');
      if (credential.test(text))
        stop('Publication stopped at a likely credential. No credential was sent.');
      overlap = text.slice(-128);
    });
    child.on('error', () => stop('Shared file inspection could not start. No files were sent.'));
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code !== 0 || bytes !== expectedBytes)
        reject(new Conflict('The committed file could not be verified. No files were sent.'));
      else resolveScan();
    });
  });
}
