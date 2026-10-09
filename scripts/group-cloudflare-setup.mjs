#!/usr/bin/env node
// Local file preparation only. No sign-in, deployment, fetch or account changes.
import { lstatSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  uuid,
  hex,
  SetupError,
  privateDirectory,
  privateRead,
  privateWrite,
  publicOrigin,
  memberService,
  ownerService,
  installService,
  currentCreatorService,
  withServiceSetup,
} from './group-service-registry.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secret = () => randomBytes(32).toString('hex');
const hash = (prefix, value) => createHash('sha256').update(`${prefix}:${value}`).digest('hex');

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
    withServiceSetup(directory, () => {
      if (currentCreatorService(directory))
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
    });
  } else if (command === 'upgrade') {
    if (workerName !== '--verified-workers-free' || accountId)
      throw new Error('Verify the existing account is Workers Free before preparing an upgrade.');
    const directory = join(resolve(dataDir), 'groups');
    privateDirectory(directory);
    const active = currentCreatorService(directory);
    if (!active)
      throw new SetupError('Activate your own creator service before preparing an upgrade.');
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
    installService(join(resolve(dataDir), 'groups'), config, true);
    console.log(
      'Activated the private creator choice. Existing memberships and service files were preserved.',
    );
  } else if (command === 'join') {
    const url = new URL(privateRead(resolve(input)).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search)
      throw new Error('Invalid invitation.');
    const fields = new URLSearchParams(url.hash.replace(/^#\/?groups\??/, ''));
    const invitation = JSON.parse(fields.get('invite') ?? 'null');
    if (!invitation || !uuid.test(invitation.groupId) || !hex.test(invitation.secret))
      throw new Error('Invalid invitation.');
    installService(join(resolve(dataDir), 'groups'), memberService(invitation.service));
    console.log(
      'Saved the invitation service route. Existing Groups services and creator authority were preserved.',
    );
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
