import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const common = {
  version: z.literal(1),
  endpointId: z.uuid(),
  setupCapability: z.string().regex(/^[a-f0-9]{64}$/),
};
const safeEndpoint = (protocol: 'http:' | 'https:') =>
  z
    .string()
    .max(2048)
    .url()
    .refine((value) => {
      const u = new URL(value);
      return (
        u.protocol === protocol &&
        u.pathname === '/' &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    });
const local = z.strictObject({
  ...common,
  mode: z.literal('local-test'),
  endpoint: z
    .string()
    .url()
    .refine((value) => {
      const u = new URL(value);
      return (
        u.protocol === 'http:' &&
        u.hostname === '127.0.0.1' &&
        !!u.port &&
        u.pathname === '/' &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    }),
});
const hosted = z
  .strictObject({
    ...common,
    mode: z.literal('hosted'),
    endpoint: safeEndpoint('https:'),
    hostingAuthorization: z.strictObject({
      origin: safeEndpoint('https:').refine((v) => new URL(v).origin === v),
      approvalCapability: z.string().regex(/^[a-f0-9]{64}$/),
      freeApprovalId: z.uuid(),
    }),
  })
  .refine((v) => new URL(v.endpoint).origin === v.hostingAuthorization.origin);
export const groupServiceConfigurationSchema = z.discriminatedUnion('mode', [
  z.strictObject({ version: z.literal(1), mode: z.literal('disabled') }),
  local,
  hosted,
]);
export type GroupServiceConfiguration = z.infer<typeof groupServiceConfigurationSchema>;
export type ActiveGroupServiceConfiguration = Exclude<
  GroupServiceConfiguration,
  { mode: 'disabled' }
>;
export function privateGroupDirectory(root: string) {
  const directory = join(root, 'groups');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Groups storage must be private and owned by this OS account.');
  return directory;
}
export function privateGroupFile(path: string) {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.mode & 0o077 ||
      (process.getuid && s.uid !== process.getuid())
    )
      throw new Error('Groups file must be private and owned by this OS account.');
  } finally {
    closeSync(fd);
  }
}
export function readGroupServiceConfiguration(directory: string): GroupServiceConfiguration | null {
  const path = join(directory, 'service.json');
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      'Groups service configuration unavailable. Ask your setup agent to check protected host configuration.',
    );
  }
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.mode & 0o077 ||
      s.size > 4096 ||
      (process.getuid && s.uid !== process.getuid())
    )
      throw new Error('private configuration required');
    return groupServiceConfigurationSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } catch {
    throw new Error(
      'Groups service configuration unavailable. Ask your setup agent to check protected host configuration.',
    );
  } finally {
    closeSync(fd);
  }
}
export function protectGroupSidecars(path: string) {
  for (const suffix of ['-wal', '-shm']) {
    try {
      chmodSync(path + suffix, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
