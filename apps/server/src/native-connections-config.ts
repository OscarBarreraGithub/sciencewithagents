import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { lstatSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';

const absolute = z.string().min(1).max(4096).refine(isAbsolute, 'Use an absolute host-owned path.');
/** Host-only configuration: neither paths nor SSH destinations come from an HTTP request. */
export const nativeConnectionProfileSchema = z
  .object({
    id: z.uuid(),
    label: z.string().min(1).max(200),
    kind: z.enum(['tmux', 'herdr']),
    socket: absolute,
    binary: absolute.optional(),
    sshAlias: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/)
      .optional(),
  })
  .strict();
export const nativeConnectionsConfigSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(nativeConnectionProfileSchema).max(34),
  })
  .strict()
  .refine(
    (v) => new Set(v.profiles.map((p) => p.id)).size === v.profiles.length,
    'Native source IDs must be unique.',
  );
export type NativeConnectionProfile = z.infer<typeof nativeConnectionProfileSchema>;
const privateJson = (path: string) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 64_000)
    throw new Error(
      'Native connection profiles must be a private, owner-owned regular file (0600).',
    );
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
};
export function readNativeConnectionProfiles(root: string): NativeConnectionProfile[] {
  const path = join(root, 'native-connections.json');
  try {
    return nativeConnectionsConfigSchema.parse(privateJson(path)).profiles;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // IDs are durable even when an optional CLI is absent. No native server is started here.
  const value = nativeConnectionsConfigSchema.parse({
    version: 1,
    profiles: [
      {
        id: randomUUID(),
        label: 'Local tmux',
        kind: 'tmux',
        socket: join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.()}`, 'default'),
      },
      {
        id: randomUUID(),
        label: 'Local Herdr',
        kind: 'herdr',
        socket: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'herdr/herdr.sock'),
      },
    ],
  });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return value.profiles;
}
/** Explicit setup-agent CLI action. Existing native/SSH configuration is never modified. */
export function saveNativeConnectionProfiles(root: string, inputPath: string) {
  const value = nativeConnectionsConfigSchema.parse(privateJson(inputPath));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'native-connections.json'),
    temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
