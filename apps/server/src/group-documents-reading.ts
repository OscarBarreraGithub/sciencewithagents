import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentReadingSchema } from '@dock/shared';
import { GROUP_DOCUMENT_LIMITS as limits } from '@dock/shared/dist/group-documents.js';
import type { GroupDocumentReadingBuilder } from './group-documents.js';
/** Reuse the existing bounded include loader/Pandoc sandbox in an owned subprocess.
 * Kill its process group at the total deadline/output limit (including PDF figure helpers).
 */
export const buildGroupDocumentReading: GroupDocumentReadingBuilder = (source, root, assets) =>
  new Promise((resolve, reject) => {
    const sourceMode = import.meta.url.endsWith('.ts');
    const worker = fileURLToPath(
      new URL(
        sourceMode ? './group-documents-reading-worker.ts' : './group-documents-reading-worker.js',
        import.meta.url,
      ),
    );
    const child = spawn(
      process.execPath,
      [
        ...(sourceMode ? ['--import', createRequire(import.meta.url).resolve('tsx')] : []),
        worker,
        source,
        root,
        assets,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env: { PATH: process.env.PATH, HOME: root, TMPDIR: root },
      },
    );
    let size = 0,
      stdout = '',
      stderr = '',
      failure: Error | undefined,
      checking = false;
    const stop = (message: string) => {
      failure ??= new Error(message);
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* owned process already exited */
      }
    };
    const timer = setTimeout(
      () => stop('Reading conversion exceeded 30 seconds. Retry reading mode.'),
      limits.readingMs,
    );
    const monitor = setInterval(() => {
      if (checking) return;
      checking = true;
      void (async () => {
        let bytes = 0;
        for (const name of await readdir(assets).catch(() => [] as string[])) {
          const info = await lstat(join(assets, name));
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            (bytes += info.size) > limits.outputBytes
          ) {
            stop('Reading figures exceeded their output limit.');
            break;
          }
        }
      })()
        .catch(() => stop('Reading figure output could not be verified.'))
        .finally(() => {
          checking = false;
        });
    }, 100);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limits.outputBytes) stop('Reading output exceeded its limit.');
      else stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-1500);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      clearInterval(monitor);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(monitor);
      if (failure || code !== 0)
        reject(failure ?? new Error(stderr || 'Reading conversion failed.'));
      else {
        try {
          resolve(documentReadingSchema.parse(JSON.parse(stdout)));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
