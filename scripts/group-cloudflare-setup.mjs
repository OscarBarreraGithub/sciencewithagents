#!/usr/bin/env node
// Local file preparation only. No sign-in, deployment, fetch or account changes.
import {
  mkdirSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secret = () => randomBytes(32).toString('hex');
const hash = (prefix, value) => createHash('sha256').update(`${prefix}:${value}`).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hex = /^[a-f0-9]{64}$/;
class SetupError extends Error {}
function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Use a private same-owner directory (0700), without symlinks.');
}
function privateRead(path) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.mode & 0o077 ||
    stat.size > 8192 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Use a private same-owner regular input file (0600).');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
function privateWrite(path, value) {
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
function publicOrigin(value) {
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
    throw new Error('Choose an exact public HTTPS root origin, without paths or credentials.');
  return value;
}
function memberService(raw) {
  const value = raw;
  const keys = ['version', 'mode', 'endpoint', 'endpointId', 'hostingAuthorization'];
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in value)) ||
    value.version !== 1 ||
    value.mode !== 'hosted' ||
    !uuid.test(value.endpointId) ||
    typeof value.endpoint !== 'string'
  )
    throw new Error('Invalid invitation service descriptor.');
  const auth = value.hostingAuthorization;
  if (
    !auth ||
    Object.keys(auth).sort().join(',') !== 'approvalCapability,freeApprovalId,origin' ||
    !hex.test(auth.approvalCapability) ||
    !uuid.test(auth.freeApprovalId)
  )
    throw new Error('Invalid invitation routing authorization.');
  const origin = publicOrigin(auth.origin);
  if (value.endpoint !== `${origin}/`) throw new Error('Invitation origin mismatch.');
  return value;
}
function ownerService(raw) {
  const { setupCapability, ...member } = raw ?? {};
  if (!hex.test(setupCapability)) throw new Error('Missing private creator capability.');
  memberService(member);
  return raw;
}
function descriptor(config) {
  const { setupCapability: _, ...member } = config;
  return memberService(member);
}
function install(dataDir, config) {
  // Never replace an installation's existing mapping or pending membership.
  const directory = join(resolve(dataDir), 'groups');
  privateDirectory(directory);
  const path = join(directory, 'service.json');
  if (exists(path)) {
    const saved = JSON.parse(privateRead(path));
    if ('setupCapability' in saved) ownerService(saved);
    else memberService(saved);
    if (
      !isDeepStrictEqual(descriptor(saved), descriptor(config)) ||
      ('setupCapability' in config && !isDeepStrictEqual(saved, config))
    )
      throw new SetupError(
        'The existing Groups service differs. It was preserved; reconcile the intended service before continuing.',
      );
    console.log(
      'Reused the matching saved Groups service. Existing credentials and files were preserved.',
    );
    return;
  }
  privateWrite(path, config);
  console.log('Saved private Groups service configuration. Reopen Groups and verify connection.');
}

try {
  const [command, dataDir, input, workerName, accountId, approval] = process.argv.slice(2);
  if (!dataDir) throw new Error('Missing installation data directory.');
  if (command === 'prepare') {
    const origin = publicOrigin(input);
    if (
      !/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(workerName ?? '') ||
      !/^[a-f0-9]{32}$/.test(accountId ?? '') ||
      approval !== '--verified-workers-free'
    )
      throw new Error(
        'Provide a Worker name, your verified account ID and --verified-workers-free.',
      );
    if (!new URL(origin).hostname.startsWith(`${workerName}.`) || !origin.endsWith('.workers.dev'))
      throw new Error('The prepared origin must be this Worker’s own workers.dev address.');
    const directory = join(resolve(dataDir), 'groups');
    privateDirectory(directory);
    if (exists(join(directory, 'service.json')))
      throw new SetupError(
        'Groups is already configured. Use the saved deployment files and the upgrade command; no new credentials were prepared.',
      );
    if (readdirSync(directory).some((name) => name.startsWith('cloudflare-deploy-')))
      throw new SetupError(
        'A prepared Groups deployment already exists. Reuse its private files; no new credentials were prepared.',
      );
    const prepared = join(directory, `cloudflare-deploy-${randomUUID()}`);
    privateDirectory(prepared);
    const setupCapability = secret(),
      approvalCapability = secret();
    const config = {
      version: 1,
      mode: 'hosted',
      endpoint: `${origin}/`,
      endpointId: randomUUID(),
      setupCapability,
      hostingAuthorization: { origin, approvalCapability, freeApprovalId: randomUUID() },
    };
    privateWrite(join(prepared, 'owner-service.json'), config);
    privateWrite(join(prepared, 'wrangler.json'), {
      name: workerName,
      account_id: accountId,
      main: join(repoRoot, 'apps/group-service/src/index.ts'),
      compatibility_date: '2026-10-06',
      compatibility_flags: ['nodejs_compat'],
      workers_dev: true,
      preview_urls: false,
      vars: {
        HOSTING_MODE: 'hosted',
        HOSTING_ORIGIN: origin,
        GROUP_SETUP_HASH: hash('dock-group-setup-v1', setupCapability),
        HOSTING_APPROVAL_HASH: hash('dock-hosting-approval-v1', approvalCapability),
        GROUP_BETA_SERVICE_ID: '',
        GROUP_BETA_KEYS: '',
      },
      durable_objects: { bindings: [{ name: 'GROUPS', class_name: 'GroupMembership' }] },
      migrations: [{ tag: 'membership-v1', new_sqlite_classes: ['GroupMembership'] }],
      observability: { enabled: false },
    });
    console.log(`Prepared private files in ${prepared}`);
    console.log(
      'No deployment performed. Deploy wrangler.json in your verified account, then activate owner-service.json.',
    );
  } else if (command === 'upgrade') {
    if (workerName !== '--verified-workers-free' || accountId)
      throw new Error('Verify the existing account is Workers Free before preparing an upgrade.');
    const directory = join(resolve(dataDir), 'groups');
    privateDirectory(directory);
    const active = ownerService(JSON.parse(privateRead(join(directory, 'service.json'))));
    const savedPath = resolve(input);
    privateDirectory(dirname(savedPath));
    const owner = ownerService(
      JSON.parse(privateRead(join(dirname(savedPath), 'owner-service.json'))),
    );
    const worker = JSON.parse(privateRead(savedPath));
    const bindings = worker?.durable_objects?.bindings;
    if (
      !isDeepStrictEqual(active, owner) ||
      !/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(worker?.name ?? '') ||
      !/^[a-f0-9]{32}$/.test(worker?.account_id ?? '') ||
      typeof worker?.main !== 'string' ||
      worker.workers_dev !== true ||
      worker.vars?.HOSTING_MODE !== 'hosted' ||
      worker.vars?.HOSTING_ORIGIN !== owner.hostingAuthorization.origin ||
      !new URL(owner.hostingAuthorization.origin).hostname.startsWith(`${worker.name}.`) ||
      worker.vars?.GROUP_SETUP_HASH !== hash('dock-group-setup-v1', owner.setupCapability) ||
      worker.vars?.HOSTING_APPROVAL_HASH !==
        hash('dock-hosting-approval-v1', owner.hostingAuthorization.approvalCapability) ||
      !Array.isArray(bindings) ||
      bindings.filter((binding) => binding.name === 'GROUPS').length !== 1 ||
      !bindings.some(
        (binding) =>
          binding.name === 'GROUPS' &&
          binding.class_name === 'GroupMembership' &&
          !binding.script_name,
      ) ||
      !Array.isArray(worker.migrations) ||
      !worker.migrations.some((migration) =>
        migration.new_sqlite_classes?.includes('GroupMembership'),
      )
    )
      throw new SetupError(
        'Saved deployment files do not match the active creator service. Nothing was changed; reconcile the original configuration first.',
      );
    const source = join(repoRoot, 'apps/group-service/src/index.ts');
    if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink())
      throw new Error('The current checkout is missing the Groups Worker source.');
    const candidate = join(dirname(savedPath), `wrangler-upgrade-${randomUUID()}.json`);
    privateWrite(candidate, { ...worker, main: source });
    console.log(`Prepared private upgrade configuration in ${candidate}`);
    console.log(
      'Only the source path changed. Verify this checkout is the reviewed revision, inspect the candidate, then dry-run and deploy it. No deployment performed.',
    );
  } else if (command === 'activate') {
    const config = ownerService(JSON.parse(privateRead(resolve(input))));
    install(dataDir, config);
  } else if (command === 'join') {
    const url = new URL(privateRead(resolve(input)).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search)
      throw new Error('Invalid invitation.');
    const fields = new URLSearchParams(url.hash.replace(/^#\/?groups\??/, ''));
    const invitation = JSON.parse(fields.get('invite') ?? 'null');
    if (!invitation || !uuid.test(invitation.groupId) || !hex.test(invitation.secret))
      throw new Error('Invalid invitation.');
    install(dataDir, memberService(invitation.service));
  } else {
    throw new Error(
      'Usage: prepare <data-dir> <https-origin> <worker-name> <account-id> --verified-workers-free | upgrade <data-dir> <private-wrangler-file> --verified-workers-free | activate <data-dir> <private-owner-file> | join <data-dir> <private-invitation-file>',
    );
  }
} catch (error) {
  // Do not echo arguments, invitation fragments or parsed credentials.
  console.error(
    error instanceof SetupError
      ? error.message
      : error?.code === 'EEXIST'
        ? 'An existing file/service mapping was preserved. Reconcile it explicitly before changing services.'
        : 'Groups configuration was not completed. Check the command, private input file and hosting runbook.',
  );
  process.exitCode = 1;
}
