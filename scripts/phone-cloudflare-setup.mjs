#!/usr/bin/env node
// Prepare private files only. Never sign in, deploy, start a tunnel or activate phone access.
import { closeSync, constants, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Use a private same-owner directory.');
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

try {
  const [command, dataDir, origin, workerName, accountId, serviceId, approval, ...extra] =
    process.argv.slice(2);
  if (
    command !== 'prepare' ||
    !dataDir ||
    !/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(workerName ?? '') ||
    !/^[a-f0-9]{32}$/.test(accountId ?? '') ||
    !uuid.test(serviceId ?? '') ||
    serviceId === '00000000-0000-0000-0000-000000000000' ||
    approval !== '--verified-workers-free' ||
    extra.length
  )
    throw new Error('Invalid preparation arguments.');
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !new RegExp(`^${workerName}\\.[a-z0-9-]+\\.workers\\.dev$`).test(url.hostname)
  )
    throw new Error('Use this Worker’s exact public HTTPS workers.dev origin.');

  const directory = join(resolve(dataDir), 'phone-cloudflare');
  privateDirectory(directory);
  const prepared = join(directory, `deploy-${randomUUID()}`);
  privateDirectory(prepared);
  privateWrite(join(prepared, 'wrangler.json'), {
    name: workerName,
    account_id: accountId,
    main: join(repoRoot, 'deployment/phone-worker.ts'),
    compatibility_date: '2026-10-07',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    preview_urls: false,
    vars: { PHONE_PUBLIC_ORIGIN: origin },
    vpc_services: [{ binding: 'PAIRED_APP', service_id: serviceId }],
    dev: { ip: '127.0.0.1' },
    observability: { enabled: false },
  });
  // The binding's service must separately be verified as HTTP 127.0.0.1:4331.
  // No argument or incoming request can select the local owner listener's port.
  privateWrite(join(prepared, 'phone-access.json'), {
    origin,
    authentication: 'paired',
    port: 4331,
    transport: 'cloudflare',
  });
  console.log(`Prepared private files in ${prepared}`);
  console.log(
    'No deployment or app change performed. Verify the VPC service targets only 127.0.0.1:4331, then follow the phone setup runbook.',
  );
} catch {
  // Do not echo account details, arguments, private file contents or credentials.
  console.error(
    'Phone preparation was not completed. Existing configuration was preserved. Check the private directory and phone setup runbook.',
  );
  process.exitCode = 1;
}
