import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { localAuthorization } from '@dock/shared/dist/local-authorization.js';
import { LocalAccess, readLocalAccess } from './local-access.js';

const handoffSchema = z
  .object({
    ticket: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime(),
  })
  .strict();

/** Native opening only: no provider credentials, URLs with secrets, or browser-selected paths. */
export async function prepareBrowserHandoff(root: string, port: number): Promise<string | null> {
  let config;
  try {
    config = readLocalAccess(root);
  } catch (error) {
    // Compatibility only for a server that has never enabled the local boundary (including demo).
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const origin = `http://127.0.0.1:${port}`;
  if (config.origin !== origin)
    throw new Error('The launcher address no longer matches this installation.');
  const path = '/api/local-access/handoff';
  const authorization = await localAuthorization(origin, config.owner, 'owner', 'POST', path);
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: { Origin: origin, Authorization: authorization, 'Content-Type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw new Error('The app could not prepare a browser connection.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The app did not provide a browser connection.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) throw new Error('Invalid browser connection response.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const handoff = handoffSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const directory = join(root, 'launcher/browser');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.mode & 0o077 ||
    (process.getuid && directoryStat.uid !== process.getuid())
  )
    throw new Error('Browser handoffs need a private directory owned by this OS account.');
  // Only our expired regular files are eligible; unrelated files and links are untouched.
  for (const name of await readdir(directory)) {
    if (!/^handoff-[a-f0-9-]{36}\.html$/.test(name)) continue;
    const file = join(directory, name);
    const stat = await lstat(file);
    if (
      stat.isFile() &&
      (!process.getuid || stat.uid === process.getuid()) &&
      stat.mtimeMs < Date.now() - 120_000
    )
      await unlink(file);
  }
  const target = new LocalAccess(config).browserOrigin;
  const file = join(directory, `handoff-${randomUUID()}.html`);
  await writeFile(
    file,
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Open sciencewithagents</title><form method="post" action="${target}/api/local-access/consume"><input type="hidden" name="ticket" value="${handoff.ticket}"><p>Opening your private workspace…</p><button>Open workspace</button></form><script>document.forms[0].submit()</script></html>`,
    { mode: 0o600, flag: 'wx' },
  );
  return pathToFileURL(file).href;
}
