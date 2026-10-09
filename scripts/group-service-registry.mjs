// Protected local routing only: no network, sign-in, deployment or model calls.
import {
  mkdirSync,
  lstatSync,
  fstatSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmdirSync,
  constants,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const hex = /^[a-f0-9]{64}$/;
export class SetupError extends Error {}
export function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Private same-owner directory required.');
}
export function privateRead(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      stat.size > 8192 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Private same-owner regular file required.');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
export function privateWrite(path, value) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}
export function publicOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.origin !== value ||
    url.username ||
    url.password ||
    isIP(url.hostname) ||
    !url.hostname.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)
  )
    throw new Error('Exact public HTTPS origin required.');
  return value;
}
export function memberService(raw) {
  const keys = ['version', 'mode', 'endpoint', 'endpointId', 'hostingAuthorization'];
  if (
    !raw ||
    typeof raw !== 'object' ||
    Object.keys(raw).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in raw)) ||
    raw.version !== 1 ||
    raw.mode !== 'hosted' ||
    !uuid.test(raw.endpointId) ||
    typeof raw.endpoint !== 'string'
  )
    throw new Error('Invalid invitation service descriptor.');
  const auth = raw.hostingAuthorization;
  if (
    !auth ||
    Object.keys(auth).sort().join(',') !== 'approvalCapability,freeApprovalId,origin' ||
    !hex.test(auth.approvalCapability) ||
    !uuid.test(auth.freeApprovalId)
  )
    throw new Error('Invalid invitation routing authorization.');
  const origin = publicOrigin(auth.origin);
  if (raw.endpoint !== `${origin}/` || raw.endpoint.length > 2048)
    throw new Error('Invitation origin mismatch.');
  return raw;
}
export function ownerService(raw) {
  const { setupCapability, ...member } = raw ?? {};
  if (!hex.test(setupCapability)) throw new Error('Private creator capability required.');
  memberService(member);
  return raw;
}
const descriptor = (config) => {
  const { setupCapability: _, ...member } = config;
  return memberService(member);
};
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(',')}}`
      : JSON.stringify(value);
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
/** Exact historical service identity; routing capabilities remain separately compared. */
export function groupServiceHash(value) {
  return digest({
    mode: value.mode,
    endpoint: value.endpoint,
    endpointId: value.endpointId,
    ...(value.mode === 'hosted'
      ? {
          hostingOrigin: value.hostingAuthorization.origin,
          freeApprovalId: value.hostingAuthorization.freeApprovalId,
        }
      : {}),
    ...(value.mode === 'beta' ? { serviceId: value.profile.serviceId } : {}),
  });
}
function directory(root) {
  const path = join(root, 'services');
  if (!exists(path)) return null;
  privateDirectory(path);
  const names = readdirSync(path);
  if (
    names.length > 64 ||
    names.some((name) => !/^[a-f0-9]{64}\.(?:owner|member)\.json$/.test(name))
  )
    throw new SetupError('Protected Groups service registry needs repair.');
  if (new Set(names.map((name) => name.slice(0, 64))).size > 32)
    throw new SetupError('Groups service registry is full. Existing services remain.');
  return path;
}
function entry(root, key, role) {
  if (!hex.test(key)) throw new Error('Exact saved service identity required.');
  const dir = directory(root);
  if (!dir) return null;
  const path = join(dir, `${key}.${role}.json`);
  if (!exists(path)) return null;
  const raw = JSON.parse(privateRead(path));
  if (
    !raw ||
    Object.keys(raw).sort().join(',') !== 'fingerprint,service,version' ||
    raw.version !== 1
  )
    throw new SetupError('Protected Groups routing record changed.');
  const config = role === 'owner' ? ownerService(raw.service) : memberService(raw.service);
  if (groupServiceHash(config) !== key || raw.fingerprint !== digest(config))
    throw new SetupError('Protected Groups routing record changed.');
  return config;
}
export function readRegistryService(root, key, creator = false) {
  const owner = entry(root, key, 'owner'),
    member = entry(root, key, 'member');
  if (owner && member && !isDeepStrictEqual(descriptor(owner), member))
    throw new SetupError('Saved owner and member routes differ. Existing files were preserved.');
  return creator ? owner : (member ?? (owner ? descriptor(owner) : null));
}
export function readCreatorService(root) {
  const path = join(root, 'creator-service.json');
  if (!exists(path)) return null;
  const raw = JSON.parse(privateRead(path));
  if (
    !raw ||
    Object.keys(raw).sort().join(',') !== 'serviceHash,version' ||
    raw.version !== 1 ||
    !hex.test(raw.serviceHash)
  )
    throw new SetupError('Protected creator choice needs repair.');
  const owner = readRegistryService(root, raw.serviceHash, true);
  if (!owner)
    throw new SetupError(
      'The activated creator service is unavailable. Preserve the original files and restore its exact route.',
    );
  return owner;
}
export function currentCreatorService(root) {
  const path = join(root, 'service.json');
  const legacy = exists(path) ? JSON.parse(privateRead(path)) : null;
  if (legacy?.mode === 'disabled')
    throw new SetupError('Groups is explicitly disabled. Its setting was preserved.');
  const creator = readCreatorService(root);
  if (creator) return creator;
  return legacy?.setupCapability ? ownerService(legacy) : null;
}
function register(root, raw) {
  const owner = Object.hasOwn(raw ?? {}, 'setupCapability');
  const config = owner ? ownerService(raw) : memberService(raw),
    key = groupServiceHash(config);
  const priorOwner = entry(root, key, 'owner'),
    priorMember = entry(root, key, 'member');
  for (const prior of [priorOwner, priorMember])
    if (prior && !isDeepStrictEqual(descriptor(prior), descriptor(config)))
      throw new SetupError('The saved routing approval differs. Existing services were preserved.');
  if (owner && priorOwner && !isDeepStrictEqual(priorOwner, config))
    throw new SetupError('The creator capability differs. Existing authority was preserved.');
  if (priorOwner || (!owner && priorMember)) return key;
  const dir = join(root, 'services');
  privateDirectory(dir);
  directory(root);
  const identities = new Set(readdirSync(dir).map((name) => name.slice(0, 64)));
  if (!identities.has(key) && identities.size >= 32)
    throw new SetupError('Groups service registry is full. Existing services remain.');
  privateWrite(join(dir, `${key}.${owner ? 'owner' : 'member'}.json`), {
    version: 1,
    service: config,
    fingerprint: digest(config),
  });
  return key;
}
function install(root, raw, creator = false) {
  privateDirectory(root);
  const config = creator ? ownerService(raw) : memberService(raw),
    key = groupServiceHash(config);
  const path = join(root, 'service.json');
  const legacy = exists(path) ? JSON.parse(privateRead(path)) : null;
  if (legacy?.mode === 'disabled')
    throw new SetupError('Groups is explicitly disabled. Its setting was preserved.');
  if (legacy) {
    const saved = legacy.setupCapability ? ownerService(legacy) : memberService(legacy);
    if (groupServiceHash(saved) === key) {
      if (
        !isDeepStrictEqual(descriptor(saved), descriptor(config)) ||
        (creator && saved.setupCapability && !isDeepStrictEqual(saved, config))
      )
        throw new SetupError(
          'The original service authority differs. Existing files were preserved.',
        );
      if (saved.setupCapability) register(root, saved);
    }
  }
  if (creator) {
    const current = currentCreatorService(root);
    if (current && !isDeepStrictEqual(current, config))
      throw new SetupError(
        'An activated creator service already exists. Its authority and files were preserved.',
      );
  }
  register(root, config);
  if (creator && !exists(join(root, 'creator-service.json')))
    privateWrite(join(root, 'creator-service.json'), { version: 1, serviceHash: key });
  if (!legacy) privateWrite(path, config);
}

// Serialize owner-operated imports/activation so concurrent helpers cannot exceed
// the finite registry or choose two creators. Readers never acquire this lock.
export function withServiceSetup(root, work) {
  privateDirectory(root);
  const lock = join(root, 'service-import.lock');
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new SetupError(
        'A service import is active or interrupted. Preserve its files; retry after the owner reconciles that import.',
      );
    throw error;
  }
  try {
    return work();
  } finally {
    rmdirSync(lock);
  }
}
export function registerService(root, raw) {
  return withServiceSetup(root, () => register(root, raw));
}
export function installService(root, raw, creator = false) {
  return withServiceSetup(root, () => install(root, raw, creator));
}
