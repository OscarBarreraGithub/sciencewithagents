import type { ChildProcess } from 'node:child_process';
import { GroupIsolationBlocked } from './group-isolation.js';
/** Fixed reviewed helper returned an explicit denial and its whole namespace stopped. */
export class GroupDocumentGuestDenied extends GroupIsolationBlocked {
  constructor(readonly reason: 'compiler' | 'input') {
    super(`Document guest denied ${reason}; exact receipt retained.`);
  }
}
/** Fixed public guest helper, data on stdin only. Entire namespace is closed on timeout/failure,
 * since killing a Docker client wrapper does not prove its guest process tree stopped. */
export async function runGroupDocumentGuest(
  container: { spawn(argv: readonly string[]): ChildProcess; close(): Promise<void> },
  mode: 'capture' | 'export' | 'build',
  input: unknown,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<unknown> {
  // Ignore guest-written user site packages, PYTHONPATH and cwd imports in retained native homes.
  const child = container.spawn([
    '/usr/bin/python3',
    '-I',
    '-B',
    '/opt/dock/group-documents.py',
    mode,
  ]);
  let stdout: Buffer[] = [],
    size = 0,
    failed = false;
  let denial: GroupDocumentGuestDenied | undefined;
  return new Promise((resolve, reject) => {
    const stop = () => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      void container.close().then(
        () =>
          reject(
            denial ??
              new GroupIsolationBlocked('Owned document operation failed; exact receipt retained.'),
          ),
        () =>
          reject(
            new GroupIsolationBlocked(
              'Document namespace stop is unverified; inspect retained receipt before retry.',
            ),
          ),
      );
    };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutputBytes) stop();
      else if (!failed) stdout.push(chunk);
    });
    child.stderr?.resume();
    child.stdin?.on('error', stop);
    child.once('error', stop);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) {
        try {
          const value = JSON.parse(Buffer.concat(stdout).toString('utf8'));
          if (
            code === 1 &&
            value.state === 'denied' &&
            ['compiler', 'input'].includes(value.reason) &&
            Object.keys(value).sort().join(',') === 'reason,state'
          )
            denial = new GroupDocumentGuestDenied(value.reason);
        } catch {
          /* Preserve an uncertain non-protocol failure. */
        }
        stop();
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(stdout).toString('utf8'));
        stdout = [];
        resolve(value);
      } catch {
        stop();
      }
    });
    if (!child.stdin || !child.stdout) {
      clearTimeout(timer);
      stop();
      return;
    }
    const bytes = Buffer.from(JSON.stringify(input));
    if (bytes.length > 12 * 1024 ** 2) {
      clearTimeout(timer);
      stop();
      return;
    }
    child.stdin.end(bytes);
  });
}
