import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { keygen, issue } from './group-beta-operator.mjs';
import {
  parseGroupBetaSetupCode,
  verifyGroupBetaAdmission,
  groupBetaSigningBytes,
  groupBetaDecode,
  groupBetaEncode,
} from '../packages/shared/dist/group-beta-admission.js';

test('offline operator issues private single-group code with a portable verified signature', async () => {
  const root = mkdtempSync(join(tmpdir(), 'groups-beta-operator-'));
  chmodSync(root, 0o700);
  try {
    const files = await keygen(join(root, 'key'), 'https://groups.example', crypto.randomUUID());
    const output = join(root, 'setup.txt');
    const metadata = await issue(files.privateKeyFile, output, 1);
    const setup = parseGroupBetaSetupCode(readFileSync(output, 'utf8').trim());
    const profile = JSON.parse(readFileSync(files.publicProfileFile, 'utf8'));
    const payload = await verifyGroupBetaAdmission(setup.admission, profile);
    assert.equal(payload.groupId, metadata.groupId);
    assert.equal(payload.createExpiresAt - payload.issuedAt, 60_000);
    assert.equal(statSync(output).mode & 0o077, 0);
    assert.equal(statSync(files.privateKeyFile).mode & 0o077, 0);
    assert.ok(!readFileSync(files.publicProfileFile, 'utf8').includes('privateKeyPkcs8'));
    await assert.rejects(issue(files.privateKeyFile, output)); // no overwrites
    await assert.rejects(keygen(join(root, 'key'), profile.origin, profile.serviceId));
    const parts = setup.admission.split('.');
    parts[2] = groupBetaEncode(
      Uint8Array.from(groupBetaDecode(parts[2]), (b, i) => (i ? b : b ^ 1)),
    );
    await assert.rejects(verifyGroupBetaAdmission(parts.join('.'), profile));
    const cli = spawnSync(
      process.execPath,
      ['scripts/group-beta-operator.mjs', 'issue', files.privateKeyFile, join(root, 'second.txt')],
      { encoding: 'utf8' },
    );
    assert.equal(cli.status, 0);
    assert.ok(!cli.stdout.includes('swa-groups-beta-v1:'));
    assert.ok(!cli.stdout.includes(setup.createCapability));
    assert.ok(!cli.stdout.includes('privateKeyPkcs8'));
    assert.ok(groupBetaSigningBytes(payload).length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
