import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type DevelopmentFixture = { root: string; data: string; workspace: string; port: number };
const marker = '.sciencewithagents-fixture';
const identity = 'stub-only-development-v1\n';

/** Explicit developer selection. Never adopt an existing installation or follow symlink roots. */
export function selectDevelopmentFixture(
  args: string[],
  env: NodeJS.ProcessEnv,
  sourceRoot: string,
): DevelopmentFixture | undefined {
  const selected = args.includes('--fixture');
  if (!selected && env.DOCK_FIXTURE_ROOT !== undefined)
    throw new Error('DOCK_FIXTURE_ROOT requires --demo --fixture; refusing production fallback.');
  if (!selected) return undefined;
  if (!args.includes('--demo')) throw new Error('--fixture requires --demo.');
  const root = env.DOCK_FIXTURE_ROOT;
  const port = Number(env.DOCK_PORT);
  if (!root || !isAbsolute(root)) throw new Error('Set an absolute DOCK_FIXTURE_ROOT.');
  if (
    !env.DOCK_PORT ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    [4330, 4331, 5178].includes(port)
  )
    throw new Error(
      'Set DOCK_PORT to a nonreserved loopback port (1024–65535; not 4330, 4331 or 5178).',
    );
  if (
    env.DOCK_DATA_DIR !== undefined ||
    env.DOCK_DEV !== undefined ||
    env.DOCK_LAUNCHER_LIFETIME !== undefined
  )
    throw new Error(
      'Fixture mode cannot use DOCK_DATA_DIR, DOCK_DEV or launcher lifetime configuration.',
    );
  // Keep developer writes beneath this checkout's ignored fixture area. No other
  // clone, source folder, home directory or pre-existing installation can be adopted.
  const base = join(sourceRoot, 'data', 'fixtures');
  const sub = relative(base, resolve(root));
  if (!sub || sub.startsWith(`..${sep}`) || sub === '..' || isAbsolute(sub))
    throw new Error('DOCK_FIXTURE_ROOT must be below this checkout’s data/fixtures/.');
  const canonical = resolve(root);
  // Inspect every existing ancestor before mkdir; a symlinked data/ also fails.
  for (let path = canonical; ; path = resolve(path, '..')) {
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
        throw new Error('Fixture directories must be real directories without symlink ancestors.');
    }
    if (path === resolve(path, '..')) break;
  }
  if (
    existsSync(canonical) &&
    readdirSync(canonical).length &&
    (!existsSync(join(canonical, marker)) ||
      lstatSync(join(canonical, marker)).isSymbolicLink() ||
      readFileSync(join(canonical, marker), 'utf8') !== identity)
  )
    throw new Error('Fixture root is not empty or owned by this developer fixture.');
  mkdirSync(canonical, { recursive: true, mode: 0o700 });
  if (!existsSync(join(canonical, marker)))
    writeFileSync(join(canonical, marker), identity, { flag: 'wx', mode: 0o600 });
  const data = join(canonical, 'data');
  const workspace = join(canonical, 'workspace');
  for (const path of [data, workspace]) {
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()))
      throw new Error('Fixture data and workspace must be real directories.');
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const checkTree = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink())
        throw new Error('Symlinks are unavailable in developer fixture storage.');
      if (stat.isDirectory()) checkTree(child);
      else if (!stat.isFile() || stat.nlink !== 1)
        throw new Error('Fixture files must be regular files without hard links.');
    }
  };
  checkTree(canonical);
  return { root: canonical, data, workspace, port };
}

/** Intentionally small fixture surface. New routes stay unavailable until audited.
 * This is not a production permission system or a provider sandbox. */
export function fixtureRouteAllowed(
  method: string,
  route: string | undefined,
  path = route,
): boolean {
  if (!route) return false;
  if (!route.startsWith('/api/'))
    return (
      !path?.startsWith('/api/') &&
      (method === 'GET' || method === 'HEAD') &&
      ['/', '/*'].includes(route)
    );
  const reads = [
    '/api/group-fixture/status',
    '/api/group-fixture/groups',
    '/api/health',
    '/api/events',
    '/api/models',
    '/api/snapshot',
    '/api/local-access/status',
    '/api/host-info',
    '/api/hosts',
    '/api/frontdesk',
    '/api/attention',
    '/api/project-rates',
    '/api/capacity',
    '/api/cluster',
    '/api/resources',
    '/api/pulsar',
    '/api/quark',
    '/api/quark/coordinator',
    '/api/scheduler',
    '/api/local-jobs',
    '/api/providers',
    '/api/model-policy',
    '/api/setup',
    '/api/browser/setup',
    '/api/phone/status',
    '/api/conversations',
    '/api/conversations/visibility',
    '/api/vscode/windows',
    '/api/agents/:id',
    '/api/agents/:id/recovery',
    '/api/agents/:id/chat-quark',
    '/api/agents/:id/receipts/:key',
    '/api/workspace/:id',
    '/api/workspace/:id/drafts/:agentId',
    '/api/workspace/:id/drafts/:agentId/history',
  ];
  const writes = [
    ...['connect', 'create', 'open', 'chat', 'send', 'draft', 'feed', 'original', 'catch-up'].map(
      (name) => `/api/group-fixture/${name}`,
    ),
    '/api/conversations',
    '/api/conversations/visibility',
    '/api/agents/:id/messages',
    '/api/workspace/clients',
    '/api/workspace/:id',
    '/api/workspace/:id/restore',
    '/api/workspace/:id/drafts/:agentId',
  ];
  return method === 'GET' || method === 'HEAD'
    ? reads.includes(route)
    : method === 'POST' && writes.includes(route);
}
