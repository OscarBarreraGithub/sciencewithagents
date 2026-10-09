import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  chmodSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  groupServiceHash,
  installService,
  readRegistryService,
  readCreatorService,
  registerService,
} from './group-service-registry.mjs';

test('own-account preparation/activation and invitation handoff isolate creator authority and preserve mappings', () => {
  const root = mkdtempSync(join(tmpdir(), 'groups-cloudflare-setup-'));
  const run = (...args) =>
    spawnSync(process.execPath, ['scripts/group-cloudflare-setup.mjs', ...args], {
      encoding: 'utf8',
    });
  const owner = join(root, 'owner'),
    member = join(root, 'member');
  try {
    const origin = 'https://test-group.person.workers.dev';
    assert.equal(
      run('prepare', owner, origin, 'test-group', 'a'.repeat(32), '--verified-workers-free').status,
      0,
    );
    const prepared = join(owner, 'groups', readdirSync(join(owner, 'groups'))[0]);
    const source = join(prepared, 'owner-service.json');
    const config = JSON.parse(readFileSync(source, 'utf8'));
    const worker = JSON.parse(readFileSync(join(prepared, 'wrangler.json'), 'utf8'));
    assert.equal(worker.account_id, 'a'.repeat(32));
    assert.equal(worker.vars.HOSTING_ORIGIN, origin);
    assert.equal(
      worker.vars.GROUP_SETUP_HASH,
      createHash('sha256').update(`dock-group-setup-v1:${config.setupCapability}`).digest('hex'),
    );
    assert.equal(statSync(source).mode & 0o077, 0);
    assert.equal(run('activate', owner, source).status, 0);
    assert.equal(run('activate', owner, source).status, 0);
    const { setupCapability, ...service } = config;
    const invitation = {
      groupId: crypto.randomUUID(),
      secret: 'b'.repeat(64),
      name: 'Shared',
      service,
    };
    const input = join(root, 'invitation.txt');
    writeFileSync(
      input,
      `http://127.0.0.1:4330/#/groups?invite=${encodeURIComponent(JSON.stringify(invitation))}`,
      { mode: 0o600 },
    );
    const joined = run('join', member, input);
    assert.equal(joined.status, 0, joined.stderr);
    const memberConfig = readFileSync(join(member, 'groups/service.json'), 'utf8');
    assert.deepEqual(JSON.parse(memberConfig), service);
    assert.ok(!memberConfig.includes(setupCapability));
    const savedStat = statSync(join(member, 'groups/service.json'));
    assert.equal(run('join', member, input).status, 0);
    assert.equal(readFileSync(join(member, 'groups/service.json'), 'utf8'), memberConfig);
    assert.equal(statSync(join(member, 'groups/service.json')).ino, savedStat.ino);
    const ownerConfig = readFileSync(join(owner, 'groups/service.json'), 'utf8');
    assert.equal(run('join', owner, input).status, 0);
    assert.equal(readFileSync(join(owner, 'groups/service.json'), 'utf8'), ownerConfig);
    assert.ok(!joined.stdout.includes(invitation.secret));
    assert.ok(!joined.stdout.includes(config.hostingAuthorization.approvalCapability));
    const malicious = { ...invitation, service: { ...service, setupCapability } };
    writeFileSync(
      input,
      `http://127.0.0.1:4330/#/groups?invite=${encodeURIComponent(JSON.stringify(malicious))}`,
    );
    assert.equal(run('join', join(root, 'refused'), input).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh prepare refuses saved mapping or pending bundle before creating new credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'groups-setup-preserve-'));
  const run = (...args) =>
    spawnSync(process.execPath, ['scripts/group-cloudflare-setup.mjs', ...args], {
      encoding: 'utf8',
    });
  try {
    const args = [
      'prepare',
      root,
      'https://test-group.person.workers.dev',
      'test-group',
      'a'.repeat(32),
      '--verified-workers-free',
    ];
    assert.equal(run(...args).status, 0);
    const directory = join(root, 'groups');
    const before = readdirSync(directory);
    assert.equal(run(...args).status, 1);
    assert.deepEqual(readdirSync(directory), before);
    const prepared = join(directory, before[0]);
    assert.equal(run('activate', root, join(prepared, 'owner-service.json')).status, 0);
    const mapping = readFileSync(join(directory, 'service.json'), 'utf8');
    const after = readdirSync(directory);
    const refused = run(...args);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /already configured/);
    assert.deepEqual(readdirSync(directory), after);
    assert.equal(readFileSync(join(directory, 'service.json'), 'utf8'), mapping);
    assert.ok(!refused.stderr.includes(JSON.parse(mapping).setupCapability));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upgrade rebinds only reviewed-checkout source while preserving saved service identity and config', () => {
  const root = mkdtempSync(join(tmpdir(), 'groups-setup-upgrade-'));
  const run = (...args) =>
    spawnSync(process.execPath, ['scripts/group-cloudflare-setup.mjs', ...args], {
      encoding: 'utf8',
    });
  try {
    assert.equal(
      run(
        'prepare',
        root,
        'https://test-group.person.workers.dev',
        'test-group',
        'a'.repeat(32),
        '--verified-workers-free',
      ).status,
      0,
    );
    const directory = join(root, 'groups');
    const bundle = join(directory, readdirSync(directory)[0]);
    const owner = join(bundle, 'owner-service.json');
    const savedPath = join(bundle, 'wrangler.json');
    assert.equal(run('activate', root, owner).status, 0);
    const saved = JSON.parse(readFileSync(savedPath, 'utf8'));
    saved.main = '/old/removed/checkout/apps/group-service/src/index.ts';
    saved.vars.PRESERVED_CUSTOM_SETTING = 'kept';
    saved.migrations.push({ tag: 'later-reviewed-migration' });
    writeFileSync(savedPath, JSON.stringify(saved));
    const configBytes = readFileSync(savedPath, 'utf8');
    const ownerBytes = readFileSync(owner, 'utf8');
    const activeBytes = readFileSync(join(directory, 'service.json'), 'utf8');
    const upgraded = run('upgrade', root, savedPath, '--verified-workers-free');
    assert.equal(upgraded.status, 0, upgraded.stderr);
    const candidateName = readdirSync(bundle).find((name) => name.startsWith('wrangler-upgrade-'));
    const candidatePath = join(bundle, candidateName);
    const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
    assert.equal(candidate.main, join(process.cwd(), 'apps/group-service/src/index.ts'));
    assert.deepEqual({ ...candidate, main: saved.main }, saved);
    assert.equal(statSync(candidatePath).mode & 0o077, 0);
    assert.equal(readFileSync(savedPath, 'utf8'), configBytes);
    assert.equal(readFileSync(owner, 'utf8'), ownerBytes);
    assert.equal(readFileSync(join(directory, 'service.json'), 'utf8'), activeBytes);
    assert.ok(!upgraded.stdout.includes(JSON.parse(ownerBytes).setupCapability));
    assert.match(upgraded.stdout, /No deployment performed/);
    const before = readdirSync(bundle);
    saved.vars.GROUP_SETUP_HASH = 'f'.repeat(64);
    writeFileSync(savedPath, JSON.stringify(saved));
    assert.equal(run('upgrade', root, savedPath, '--verified-workers-free').status, 1);
    assert.deepEqual(readdirSync(bundle), before);
    assert.equal(readFileSync(join(directory, 'service.json'), 'utf8'), activeBytes);
    assert.equal(run('upgrade', root, savedPath).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('joining another descriptor retains the original mapping and creator authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'groups-setup-mismatch-'));
  const run = (...args) =>
    spawnSync(process.execPath, ['scripts/group-cloudflare-setup.mjs', ...args], {
      encoding: 'utf8',
    });
  try {
    assert.equal(
      run(
        'prepare',
        root,
        'https://test-group.person.workers.dev',
        'test-group',
        'a'.repeat(32),
        '--verified-workers-free',
      ).status,
      0,
    );
    const directory = join(root, 'groups');
    const bundle = join(directory, readdirSync(directory)[0]);
    const owner = JSON.parse(readFileSync(join(bundle, 'owner-service.json'), 'utf8'));
    assert.equal(run('activate', root, join(bundle, 'owner-service.json')).status, 0);
    const mapping = readFileSync(join(directory, 'service.json'), 'utf8');
    const { setupCapability, ...service } = owner;
    const input = join(root, 'invitation.txt');
    writeFileSync(
      input,
      `https://test-group.person.workers.dev/join#/groups?invite=${encodeURIComponent(JSON.stringify({ groupId: crypto.randomUUID(), secret: 'b'.repeat(64), service: { ...service, endpointId: crypto.randomUUID() } }))}`,
      { mode: 0o600 },
    );
    const original = statSync(join(directory, 'service.json'));
    assert.equal(run('join', root, input).status, 0);
    assert.equal(readFileSync(join(directory, 'service.json'), 'utf8'), mapping);
    assert.equal(statSync(join(directory, 'service.json')).ino, original.ino);
    assert.deepEqual(readCreatorService(directory), owner);
    assert.deepEqual(readRegistryService(directory, groupServiceHash(owner), true), owner);
    assert.ok(!run('join', root, input).stderr.includes(setupCapability));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const configuration = () => {
  const origin = 'https://' + crypto.randomUUID() + '.workers.dev';
  return {
    version: 1,
    mode: 'hosted',
    endpoint: origin + '/',
    endpointId: crypto.randomUUID(),
    setupCapability: 'a'.repeat(64),
    hostingAuthorization: {
      origin,
      approvalCapability: 'b'.repeat(64),
      freeApprovalId: crypto.randomUUID(),
    },
  };
};
test('join-first creator preparation and activation preserves member default and the exact pending bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'groups-join-first-'));
  const directory = join(root, 'groups');
  const run = (...args) =>
    spawnSync(process.execPath, ['scripts/group-cloudflare-setup.mjs', ...args], {
      encoding: 'utf8',
    });
  try {
    const { setupCapability: _, ...member } = configuration();
    installService(directory, member);
    const path = join(directory, 'service.json'),
      bytes = readFileSync(path, 'utf8'),
      inode = statSync(path).ino;
    assert.equal(readCreatorService(directory), null);
    const args = [
      'prepare',
      root,
      'https://own-service.person.workers.dev',
      'own-service',
      'a'.repeat(32),
      '--verified-workers-free',
    ];
    assert.equal(run(...args).status, 0);
    const bundle = readdirSync(directory).find((n) => n.startsWith('cloudflare-deploy-'));
    const ownerPath = join(directory, bundle, 'owner-service.json'),
      owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    const pending = readFileSync(ownerPath, 'utf8'),
      pendingInode = statSync(ownerPath).ino;
    assert.equal(run(...args).status, 1);
    assert.equal(readFileSync(ownerPath, 'utf8'), pending);
    assert.equal(statSync(ownerPath).ino, pendingInode);
    assert.equal(run('activate', root, ownerPath).status, 0);
    assert.equal(run('activate', root, ownerPath).status, 0);
    assert.equal(readFileSync(path, 'utf8'), bytes);
    assert.equal(statSync(path).ino, inode);
    assert.deepEqual(readCreatorService(directory), owner);
    assert.deepEqual(readRegistryService(directory, groupServiceHash(member)), member);
    assert.deepEqual(readRegistryService(directory, groupServiceHash(owner), true), owner);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('matching member import preserves owner capability; altered approval or creator capability refuses without writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'groups-role-preserve-'));
  try {
    const owner = configuration(),
      { setupCapability: _, ...member } = owner;
    installService(root, member);
    const memberPath = join(root, 'services', groupServiceHash(owner) + '.member.json');
    const original = readFileSync(memberPath, 'utf8'),
      inode = statSync(memberPath).ino;
    installService(root, owner, true);
    const before = readdirSync(join(root, 'services'));
    installService(root, member);
    assert.equal(readFileSync(memberPath, 'utf8'), original);
    assert.equal(statSync(memberPath).ino, inode);
    assert.deepEqual(readRegistryService(root, groupServiceHash(owner), true), owner);
    assert.throws(
      () =>
        installService(root, {
          ...member,
          hostingAuthorization: {
            ...member.hostingAuthorization,
            approvalCapability: 'c'.repeat(64),
          },
        }),
      /differs/,
    );
    assert.throws(
      () => installService(root, { ...owner, setupCapability: 'd'.repeat(64) }, true),
      /preserved/,
    );
    assert.deepEqual(readdirSync(join(root, 'services')), before);
    assert.deepEqual(readCreatorService(root), owner);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('finite private registry refuses changed entries, concurrent imports and overflow while retaining every saved route', () => {
  const root = mkdtempSync(join(tmpdir(), 'groups-registry-fences-'));
  try {
    const configs = Array.from({ length: 32 }, () => configuration());
    for (const value of configs) registerService(root, value);
    const before = readdirSync(join(root, 'services'));
    assert.throws(() => registerService(root, configuration()), /full/);
    assert.deepEqual(readdirSync(join(root, 'services')), before);
    const file = join(root, 'services', groupServiceHash(configs[0]) + '.owner.json'),
      saved = readFileSync(file, 'utf8');
    chmodSync(file, 0o644);
    assert.throws(() => readRegistryService(root, groupServiceHash(configs[0]), true), /Private/);
    chmodSync(file, 0o600);
    const outside = join(root, 'original.fixture');
    renameSync(file, outside);
    symlinkSync(outside, file);
    assert.throws(() => readRegistryService(root, groupServiceHash(configs[0]), true));
    rmSync(file);
    renameSync(outside, file);
    const changed = JSON.parse(saved);
    changed.service.hostingAuthorization.approvalCapability = 'e'.repeat(64);
    writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => readRegistryService(root, groupServiceHash(configs[0]), true), /changed/);
    writeFileSync(file, saved);
    for (const value of configs)
      assert.deepEqual(readRegistryService(root, groupServiceHash(value), true), value);
    mkdirSync(join(root, 'service-import.lock'), { mode: 0o700 });
    assert.throws(() => registerService(root, configs[0]), /active or interrupted/);
    assert.deepEqual(readdirSync(join(root, 'services')), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent fresh creator preparation retains one pending bundle and no active choice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'groups-prepare-serialized-'));
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          'scripts/group-cloudflare-setup.mjs',
          'prepare',
          root,
          'https://owned.person.workers.dev',
          'owned',
          'a'.repeat(32),
          '--verified-workers-free',
        ],
        { stdio: 'ignore' },
      );
      child.once('error', reject);
      child.once('exit', (code) => resolve(code));
    });
  try {
    const codes = await Promise.all([run(), run()]);
    assert.deepEqual(codes.sort(), [0, 1]);
    const directory = join(root, 'groups');
    assert.equal(
      readdirSync(directory).filter((name) => name.startsWith('cloudflare-deploy-')).length,
      1,
    );
    assert.equal(readCreatorService(directory), null);
    assert.ok(!readdirSync(directory).includes('service-import.lock'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
