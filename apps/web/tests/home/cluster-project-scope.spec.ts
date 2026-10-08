import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
import { clusterProjectOpenedSchema } from '@dock/shared';

const projectId = randomUUID();
const controller = randomUUID();

// Use the real routing/request module in a blank document, without mounting the app.
// The unrelated detail/snapshot parsers are not called in these context checks.
let contextModule = '';
test.beforeAll(async () => {
  const source = await readFile(new URL('../../src/api.ts', import.meta.url), 'utf8');
  contextModule = (
    await transformWithEsbuild(source, 'api.ts', { loader: 'ts', format: 'esm' })
  ).code.replace(/^import .* from ["']@dock\/shared["'];?\s*/m, '');
});
async function contextFixture(page: Page) {
  await page.route('**/cluster-api-fixture.html*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>API context</title>' }),
  );
  await page.route('**/cluster-api-fixture.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: contextModule }),
  );
}

/** Serves a pinned cluster scope from the demo app and records which prefix each request used. */
async function nested(page: Page, prefix: string, baseURL: string) {
  const seen: string[] = [];
  await page.route(`**${prefix}/**`, async (route) => {
    const source = route.request();
    const url = source.url().replace(prefix, '/api');
    seen.push(new URL(source.url()).pathname);
    if (new URL(url).pathname === '/api/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'event: ready\ndata: {}\n\n',
      });
    const response = await page.request.fetch(url, {
      method: source.method(),
      data: source.postData() ?? undefined,
      headers: { 'Content-Type': 'application/json', Origin: baseURL },
    });
    return route.fulfill({ response });
  });
  return seen;
}
const hosts = {
  local: { id: 'local', label: 'Entry fixture' },
  setupError: null,
  hosts: [
    {
      id: controller,
      label: 'Controller fixture',
      accountLabel: 'owner fixture',
      status: 'connected',
      error: null,
    },
  ],
};

for (const via of ['local', 'selected'] as const)
  test(`a cluster project on the ${via} controller uses its nested route and keeps its own drafts`, async ({
    page,
    baseURL,
  }) => {
    const host = via === 'local' ? 'local' : controller;
    await page.addInitScript(
      ([host, projectId]) => {
        localStorage.setItem('dock:host', host);
        localStorage.setItem(
          'dock:cluster-project',
          JSON.stringify({ controllerHost: host, projectId }),
        );
      },
      [host, projectId],
    );
    await page.route('**/api/hosts', (route) => route.fulfill({ json: hosts }));
    const prefix =
      via === 'local'
        ? `/api/cluster/projects/${projectId}/proxy`
        : `/api/hosts/${controller}/proxy/cluster/projects/${projectId}/proxy`;
    const seen = await nested(page, prefix, baseURL!);
    // The controller verifies this exact project before any nested request (startup gate).
    const remote = { hostId: randomUUID(), projectId: randomUUID(), managerId: randomUUID() };
    await page.route(
      `**/api${via === 'local' ? '' : `/hosts/${controller}/proxy`}/cluster/projects/${projectId}/open`,
      (route) =>
        route.fulfill({
          json: clusterProjectOpenedSchema.parse({
            project: {
              id: projectId,
              name: 'Scope fixture',
              description: '',
              alias: 'hpc',
              folderId: randomUUID(),
              createdAt: new Date().toISOString(),
              provider: 'codex',
              hostId: remote.hostId,
              remoteProjectId: remote.projectId,
              remoteManagerId: remote.managerId,
              development: {
                state: 'ready',
                jobId: '5100',
                node: 'node101',
                observedAt: new Date().toISOString(),
                message: '',
              },
              setupRequired: null,
            },
            destination: remote,
          }),
        }),
    );
    await page.goto('/');
    const computer = page.locator('.home-computer-name').first();
    await expect(computer).toHaveText(
      `Cluster project via ${via === 'local' ? 'Entry fixture' : 'Controller fixture'}`,
    );
    await expect.poll(() => seen.some((path) => path.endsWith('/snapshot'))).toBe(true);
    expect(seen.every((path) => path.startsWith(prefix))).toBe(true);
    // Device-wide routes stay on the entry computer, never the cluster destination.
    expect(
      seen.filter((path) => /\/(hosts|phone|notifications)(\/|$)/.test(path.slice(prefix.length))),
    ).toEqual([]);
  });

test('a notification tap pins the entry computer over a saved cluster project', async ({
  page,
}) => {
  await page.addInitScript((projectId) => {
    localStorage.setItem('dock:host', 'local');
    localStorage.setItem(
      'dock:cluster-project',
      JSON.stringify({ controllerHost: 'local', projectId }),
    );
  }, projectId);
  const nestedRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/cluster/projects/')) nestedRequests.push(request.url());
  });
  await page.goto('/?computer=entry');
  const label = page.locator('.home-computer-name').first();
  await expect.poll(() => label.textContent()).toMatch(/\S/);
  await expect(label).not.toHaveText(/Cluster project/);
  expect(nestedRequests).toEqual([]);
  // The saved cluster choice is untouched for an explicit return later.
  expect(await page.evaluate(() => localStorage.getItem('dock:cluster-project'))).toContain(
    projectId,
  );
});

test('Return to controller keeps another tab’s newer computer and cluster selection', async ({
  page,
  baseURL,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Document routing is independent of layout.');
  const newer = { controllerHost: 'local', projectId: randomUUID() };
  await page.addInitScript(
    ({ controller, projectId }) => {
      if (sessionStorage.getItem('fixture-return-seeded')) return;
      sessionStorage.setItem('fixture-return-seeded', '1');
      localStorage.setItem('dock:host', controller);
      localStorage.setItem(
        'dock:cluster-project',
        JSON.stringify({ controllerHost: controller, projectId }),
      );
    },
    { controller, projectId },
  );
  const prefix = `/api/hosts/${controller}/proxy`;
  await nested(page, prefix, baseURL!);
  await page.route('**/api/hosts', (route) => route.fulfill({ json: hosts }));
  await page.route(`**${prefix}/cluster/projects/${projectId}/open`, (route) =>
    route.fulfill({ status: 503, json: { error: 'The saved project is not reachable yet.' } }),
  );
  await page.goto('/#/chats');
  const gate = page.getByRole('main', { name: 'Reconnecting cluster project' });
  await expect(gate.getByRole('alert')).toHaveText('The saved project is not reachable yet.');
  await page.evaluate((newer) => {
    localStorage.setItem('dock:host', newer.controllerHost);
    localStorage.setItem('dock:cluster-project', JSON.stringify(newer));
  }, newer);
  await gate.getByRole('button', { name: 'Return to controller' }).click();
  await expect(page.locator('.home-computer-name').first()).toHaveText('Controller fixture');
  expect(await page.evaluate(() => localStorage.getItem('dock:host'))).toBe('local');
  expect(
    JSON.parse((await page.evaluate(() => localStorage.getItem('dock:cluster-project')))!),
  ).toEqual(newer);
});

test('cluster API requests, uploads and cache scope stay pinned across two tabs', async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Document routing is independent of layout.');
  await contextFixture(page);
  await page.goto('/cluster-api-fixture.html');
  await page.evaluate(
    ({ controller, projectId }) => {
      localStorage.setItem('dock:host', controller);
      localStorage.setItem(
        'dock:cluster-project',
        JSON.stringify({ controllerHost: controller, projectId }),
      );
    },
    { controller, projectId },
  );
  const first = await page.evaluate(async () => {
    const api = await import(/* @vite-ignore */ `${location.origin}/cluster-api-fixture.js`);
    return {
      scope: api.apiScope(),
      upload: api.apiUrl('/chat-files'),
      query: api.apiUrl('/models?provider=claude'),
    };
  });
  const newer = { controllerHost: 'local', projectId: randomUUID() };
  const other = await context.newPage();
  try {
    await contextFixture(other);
    await other.goto('/cluster-api-fixture.html');
    await other.evaluate((newer) => {
      localStorage.setItem('dock:host', newer.controllerHost);
      localStorage.setItem('dock:cluster-project', JSON.stringify(newer));
    }, newer);
    const otherScope = await other.evaluate(async () => {
      const api = await import(/* @vite-ignore */ `${location.origin}/cluster-api-fixture.js`);
      return api.apiScope();
    });
    const requests: string[] = [];
    await page.route('**/api/**', (route) => {
      requests.push(
        new URL(route.request().url()).pathname + new URL(route.request().url()).search,
      );
      return route.fulfill({ json: { ok: true } });
    });
    const still = await page.evaluate(async () => {
      const api = await import(/* @vite-ignore */ `${location.origin}/cluster-api-fixture.js`);
      await api.api('/models?provider=claude');
      await api.controllerApi('/cluster/projects?limit=3');
      return {
        scope: api.apiScope(),
        upload: api.apiUrl('/chat-files'),
        query: api.apiUrl('/models?provider=claude'),
        hosts: api.apiUrl('/hosts?refresh=1'),
        notifications: api.apiUrl('/notifications?enabled=1'),
      };
    });
    const prefix = `/api/hosts/${controller}/proxy`;
    expect(still).toMatchObject(first);
    expect(first).toEqual({
      scope: `cluster:${controller}:${projectId}`,
      upload: `${prefix}/cluster/projects/${projectId}/proxy/chat-files`,
      query: `${prefix}/cluster/projects/${projectId}/proxy/models?provider=claude`,
    });
    expect(otherScope).toBe(`cluster:local:${newer.projectId}`);
    expect(otherScope).not.toBe(first.scope);
    expect(still.hosts).toBe('/api/hosts?refresh=1');
    expect(still.notifications).toBe('/api/notifications?enabled=1');
    expect(requests).toEqual([first.query, `${prefix}/cluster/projects?limit=3`]);
  } finally {
    await other.close();
  }
});

test('missing browser storage falls back to the entry computer and fails explicit selection clearly', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Browser storage is independent of layout.');
  await contextFixture(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage unavailable', 'SecurityError');
      },
    });
  });
  await page.goto('/cluster-api-fixture.html');
  const state = await page.evaluate(async (projectId) => {
    const api = await import(/* @vite-ignore */ `${location.origin}/cluster-api-fixture.js`);
    const errors: string[] = [];
    for (const choose of [
      () => api.selectComputer('local'),
      () => api.selectClusterProject(projectId),
    ]) {
      try {
        choose();
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    return {
      scope: api.apiScope(),
      cluster: api.apiCluster(),
      url: api.apiUrl('/snapshot'),
      errors,
    };
  }, projectId);
  expect(state).toMatchObject({ scope: 'local', cluster: null, url: '/api/snapshot' });
  expect(state.errors).toHaveLength(2);
  expect(
    state.errors.every(
      (error) => error.includes('Allow browser storage') || error.includes('allow browser storage'),
    ),
  ).toBe(true);
});

for (const entry of [false, true])
  test(`submission policy PUT and model refresh stay pinned to ${entry ? 'notification entry' : 'selected controller'} after storage changes`, async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'Pinned request routing does not depend on layout.');
    await contextFixture(page);
    await page.addInitScript(
      ([computer, project]) => {
        localStorage.setItem('dock:host', computer);
        localStorage.setItem(
          'dock:cluster-project',
          JSON.stringify({ controllerHost: computer, projectId: project }),
        );
      },
      [controller, projectId],
    );
    await page.goto(`/cluster-api-fixture.html${entry ? '?computer=entry' : ''}`);
    const seen: { method: string; path: string; body: unknown }[] = [];
    await page.route('**/api/**', (route) => {
      seen.push({
        method: route.request().method(),
        path: new URL(route.request().url()).pathname,
        body: route.request().postDataJSON(),
      });
      return route.fulfill({ json: { ok: true } });
    });
    const body = { key: randomUUID(), expectedRevision: 2, policy: { enabled: false } };
    await page.evaluate(async (body) => {
      const api = await import(/* @vite-ignore */ `${location.origin}/cluster-api-fixture.js`);
      localStorage.setItem('dock:host', 'local');
      localStorage.removeItem('dock:cluster-project');
      await api.saveSlurmPolicy(body);
      await api.controllerApi('/model-policy/catalogs', {});
    }, body);
    expect(seen).toEqual([
      {
        method: 'PUT',
        path: `/api${entry ? '' : `/hosts/${controller}/proxy`}/slurm-review/policy`,
        body,
      },
      {
        method: 'POST',
        path: `/api${entry ? '' : `/hosts/${controller}/proxy`}/model-policy/catalogs`,
        body: {},
      },
    ]);
  });
