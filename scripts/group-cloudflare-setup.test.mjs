import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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

test('joining another descriptor refuses instead of changing retained groups or creator authority', () => {
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
    assert.equal(run('join', root, input).status, 1);
    assert.equal(readFileSync(join(directory, 'service.json'), 'utf8'), mapping);
    assert.ok(!run('join', root, input).stderr.includes(setupCapability));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
