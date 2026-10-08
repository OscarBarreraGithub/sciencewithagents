import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { localRequestProof, type LocalRole } from '@dock/shared/dist/local-authorization.js';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { DemoProvider } from './demo.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';
import { createServer } from './server.js';
import { proxyPath } from './hosts.js';
import { localEntryOptions, phoneEntryOptions } from './entry-options.js';
import type { ClusterRemoteAdmission } from './cluster-remote-admission.js';
import type { ClusterProjects } from './cluster-projects.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
it('keeps compute admission private to the authenticated controller, including nested browser paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-compute-route-'));
  const store = new Store(join(root, 'dock.sqlite'));
  const runtime = new Runtime(store, root, '/unused-cli', async () => new DemoProvider());
  const config = prepareLocalAccess(root, 4397);
  const access = new LocalAccess(config);
  const app = await createServer(store, runtime, {
    port: 4397,
    localAccess: access,
    ownsRuntime: false,
    clusterAdmission: { snapshot: () => ({ verified: true }) } as unknown as ClusterRemoteAdmission,
  });
  cleanup.push(async () => {
    await app.close();
    await runtime.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const path = '/api/cluster/runtime/admission';
  const request = async (role: LocalRole) => {
    const challenge = randomBytes(32).toString('hex');
    const { nonce } = access.proof({ role, challenge });
    return app.inject({
      method: 'GET',
      url: path,
      headers: {
        host: '127.0.0.1:4397',
        authorization: `Dock ${role}.${nonce}.${localRequestProof(config[role], config.origin, role, challenge, nonce, 'GET', path)}`,
      },
    });
  };
  expect((await request('host')).json()).toEqual({ verified: true });
  expect((await request('owner')).statusCode).toBe(409);
  expect(
    (await app.inject({ method: 'GET', url: path, headers: { host: '127.0.0.1:4397' } }))
      .statusCode,
  ).toBe(401);
  const project = randomUUID();
  expect(proxyPath('GET', '/cluster/runtime/admission')).toBeNull();
  expect(
    proxyPath('GET', `/cluster/projects/${project}/proxy/cluster/runtime/admission`),
  ).toBeNull();
  expect(
    proxyPath('POST', `/cluster/projects/${project}/proxy/cluster/runtime/admission/grants`),
  ).toBeNull();
  expect(
    proxyPath('GET', `/cluster/projects/${project}/proxy/agents/${randomUUID()}?unknown=1`),
  ).toBeNull();
  expect(proxyPath('GET', `/cluster/projects/${project}/proxy/snapshot`)).toBe(
    `/api/cluster/projects/${project}/proxy/snapshot`,
  );
  expect(
    proxyPath(
      'GET',
      `/cluster/projects/${project}/proxy/cluster/projects/${randomUUID()}/proxy/snapshot`,
    ),
  ).toBeNull();
});
it('shares the same project service across local and paired-phone entries without compute-private routes', () => {
  const projects = {} as ClusterProjects;
  const services = { clusterProjects: projects };
  expect(localEntryOptions(services, { port: 4330 }).clusterProjects).toBe(projects);
  expect(phoneEntryOptions(services, { port: 4331 }).clusterProjects).toBe(projects);
  expect(phoneEntryOptions(services, { port: 4331 }).clusterAdmission).toBeUndefined();
});
