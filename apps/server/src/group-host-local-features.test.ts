import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { GroupHost } from './group-host.js';
import { registerGroupHostRoutes } from './group-host-routes.js';
import { attachGroupHostLocalFeatures } from './group-host-local-features.js';
import type { GroupHostNativeRuntime } from './group-native-host-runtime.js';
import { groupFeatureGit } from './group-feature-git.js';
import { groupFeatureDocuments } from './group-feature-documents.js';
import { groupFeatureCoordination } from './group-feature-coordination.js';

it('an adapter without secondary ports keeps core Groups routes responsive and export controls unavailable', async () => {
  mkdirSync('data/tests', { recursive: true });
  const root = mkdtempSync('data/tests/host-optional-features-');
  const store = new Store(join(root, 'dock.sqlite'));
  const provider = vi.fn(async () => {
    throw new Error('No provider in optional feature check');
  });
  const runtime = new Runtime(store, root, 'never-native', provider);
  const host = new GroupHost(root, { betaProfile: null });
  const app = Fastify();
  let features: { close(): Promise<void> } | undefined;
  try {
    const resolve = vi.fn(() => {
      throw new Error('No turn admitted in route check');
    });
    // The helper only receives these two side-effect-free adapter ports until an
    // actual retained shared source requires synthesis. No native run starts here.
    features = attachGroupHostLocalFeatures(runtime, host, {
      resolveLocalContext: resolve,
      registerHelper: vi.fn(),
    } as unknown as GroupHostNativeRuntime);
    expect(groupFeatureGit(host)).toBeUndefined();
    expect(groupFeatureDocuments(host)).toBeUndefined();
    expect(groupFeatureCoordination(host)).toBeUndefined();
    registerGroupHostRoutes(app, host, () => true);
    expect((await app.inject({ method: 'GET', url: '/api/groups' })).statusCode).toBe(200);
    const git = await app.inject({ method: 'POST', url: '/api/groups/git', payload: {} });
    expect(git.statusCode).toBe(503);
    expect(git.json().code).toBe('GROUP_GIT_UNAVAILABLE');
    expect(
      (await app.inject({ method: 'POST', url: '/api/groups/documents/read', payload: {} }))
        .statusCode,
    ).toBe(404);
    expect(store.runs()).toHaveLength(0);
    expect(provider).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await features?.close();
    await host.close();
    await runtime.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
