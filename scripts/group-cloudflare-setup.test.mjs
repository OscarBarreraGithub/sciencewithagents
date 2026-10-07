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
    assert.equal(run('activate', owner, source).status, 1);
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
    assert.equal(run('join', member, input).status, 1);
    assert.equal(readFileSync(join(member, 'groups/service.json'), 'utf8'), memberConfig);
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
