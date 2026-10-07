import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (dataDir, origin = 'https://my-phone.person.workers.dev', ...extra) =>
  spawnSync(
    process.execPath,
    [
      'scripts/phone-cloudflare-setup.mjs',
      'prepare',
      dataDir,
      origin,
      'my-phone',
      'a'.repeat(32),
      '12345678-1234-1234-1234-123456789abc',
      '--verified-workers-free',
      ...extra,
    ],
    { encoding: 'utf8' },
  );

test('phone preparation keeps active configuration intact and generates one fixed private binding', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'phone-cloudflare-setup-'));
  try {
    const existing = '{"origin":"https://existing.example.test","port":4337}';
    writeFileSync(join(dataDir, 'phone-access.json'), existing, { mode: 0o600 });
    const prepared = run(dataDir);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(readFileSync(join(dataDir, 'phone-access.json'), 'utf8'), existing);
    const directory = join(dataDir, 'phone-cloudflare');
    const release = join(directory, readdirSync(directory)[0]);
    const worker = JSON.parse(readFileSync(join(release, 'wrangler.json'), 'utf8'));
    const phone = JSON.parse(readFileSync(join(release, 'phone-access.json'), 'utf8'));
    assert.equal(worker.account_id, 'a'.repeat(32));
    assert.equal(worker.vars.PHONE_PUBLIC_ORIGIN, 'https://my-phone.person.workers.dev');
    assert.deepEqual(worker.vpc_services, [
      { binding: 'PAIRED_APP', service_id: '12345678-1234-1234-1234-123456789abc' },
    ]);
    assert.equal(worker.workers_dev, true);
    assert.equal(worker.preview_urls, false);
    assert.equal(worker.observability.enabled, false);
    assert.deepEqual(phone, {
      origin: 'https://my-phone.person.workers.dev',
      authentication: 'paired',
      port: 4331,
      transport: 'cloudflare',
    });
    for (const path of [
      directory,
      release,
      join(release, 'wrangler.json'),
      join(release, 'phone-access.json'),
    ])
      assert.equal(statSync(path).mode & 0o077, 0);
    assert.equal(run(dataDir, undefined, '--paired-port=4330').status, 1);
    assert.equal(run(dataDir, 'https://my-phone.person.workers.dev/elsewhere').status, 1);
    assert.equal(run(dataDir, 'https://another-phone.person.workers.dev').status, 1);
    assert.equal(run(dataDir, 'http://my-phone.person.workers.dev').status, 1);
    assert.equal(readdirSync(directory).length, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('phone preparation refuses a symlinked private output directory', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'phone-cloudflare-symlink-'));
  try {
    const target = join(dataDir, 'existing');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(dataDir, 'phone-cloudflare'));
    assert.equal(run(dataDir).status, 1);
    assert.deepEqual(readdirSync(target), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
