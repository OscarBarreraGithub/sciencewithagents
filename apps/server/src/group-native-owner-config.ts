import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { groupNativeHostRouteSchema, configureGroupNativeRoute } from './group-native-connector.js';
import { privateGroupDirectory } from './group-host-storage.js';
import type { Runtime } from './runtime.js';

export const groupNativeOwnerConfigSchema = z
  .strictObject({
    route: groupNativeHostRouteSchema,
    reviewedCommit: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .superRefine((v, ctx) => {
    const paths = [
      v.route.resources.stateBase,
      ...v.route.resources.forbiddenPaths,
      ...v.route.resources.readResources,
      ...(v.route.resources.workspace ? [v.route.resources.workspace] : []),
    ];
    if (paths.some((p) => !isAbsolute(p)))
      ctx.addIssue({ code: 'custom', message: 'Host resource paths must be absolute.' });
  });
export type GroupNativeOwnerConfig = z.infer<typeof groupNativeOwnerConfigSchema>;
function readPrivate(path: string): GroupNativeOwnerConfig {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== process.getuid!() ||
      st.mode & 0o077 ||
      st.size > 32 * 1024
    )
      throw new Error('Private same-owner native route file required.');
    return groupNativeOwnerConfigSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } finally {
    closeSync(fd);
  }
}
/** Setup-agent/owner CLI only. A browser cannot choose this file or its resource paths. */
export function saveGroupNativeOwnerConfig(root: string, source: string) {
  const value = readPrivate(source);
  const directory = privateGroupDirectory(root);
  const target = join(directory, 'native-route.json');
  if (existsSync(target)) readPrivate(target);
  const temporary = join(directory, `native-route-${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, target);
  return target;
}
export function loadGroupNativeOwnerConfig(root: string, runtime: Runtime) {
  const path = join(privateGroupDirectory(root), 'native-route.json');
  if (!existsSync(path)) return null;
  const config = readPrivate(path);
  configureGroupNativeRoute(runtime, config.route);
  return config;
}
