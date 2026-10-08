import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  clusterProjectCreateSchema,
  clusterProjectOpenedSchema,
  clusterProjectSummarySchema,
  clusterWorkspaceSchema,
  snapshotSchema,
} from '@dock/shared';

const shots = fileURLToPath(
  new URL('../../../../data/screenshots/cluster-project/', import.meta.url),
);
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const rootFolder = randomUUID();
const srcFolder = randomUUID();
const connection = randomUUID();
const controller = randomUUID();
const workspace = clusterWorkspaceSchema.parse({
  alias: 'hpc',
  revision: 2,
  connectionId: connection,
  connected: true,
  setup: {
    username: 'researcher',
    defaultAccount: 'lab_account',
    accounts: [{ name: 'lab_account', fairShare: 0.2 }],
    partitions: [],
    selectedAccount: 'lab_account',
    accountConfirmed: true,
    observedAt: at(2),
    error: null,
  },
  roots: [
    {
      id: randomUUID(),
      label: 'Thesis',
      path: '~/projects/thesis',
      index: {
        state: 'ready',
        observedAt: at(2),
        connectionId: connection,
        canonicalPath: '/n/home01/researcher/projects/thesis',
        error: null,
        entries: [
          {
            id: rootFolder,
            relativePath: '.',
            kind: 'directory',
            size: null,
            modifiedAt: null,
            git: true,
          },
          {
            id: srcFolder,
            relativePath: 'src',
            kind: 'directory',
            size: null,
            modifiedAt: null,
            git: false,
          },
          {
            id: randomUUID(),
            relativePath: 'README.md',
            kind: 'file',
            size: 10,
            modifiedAt: null,
            git: false,
          },
        ],
        omitted: 0,
      },
    },
  ],
  development: { partition: 'test' },
  workflow: {},
  keepConnected: { enabled: false, expiresAt: null, state: 'off', message: '' },
});
const hosts = {
  local: { id: 'local', label: 'Entry fixture' },
  setupError: null,
  hosts: [
    {
      id: controller,
      label: 'Controller fixture',
      accountLabel: 'owner',
      status: 'connected',
      error: null,
    },
  ],
};

const uuidKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const summary = (
  id: string,
  state: 'pending' | 'ready',
  remote?: { projectId: string; managerId: string },
) =>
  clusterProjectSummarySchema.parse({
    id,
    name: 'Cluster thesis',
    description: '',
    alias: 'hpc',
    folderId: rootFolder,
    createdAt: at(1),
    provider: 'codex',
    hostId: randomUUID(),
    remoteProjectId: state === 'ready' ? remote!.projectId : null,
    remoteManagerId: state === 'ready' ? remote!.managerId : null,
    development: {
      state,
      jobId: '5100',
      node: state === 'ready' ? 'node101' : null,
      observedAt: at(0),
      message: state === 'ready' ? '' : 'Priority',
    },
    setupRequired: null,
  });
/** Message, goal, editor, model-policy or host-registry writes: none are allowed in these flows. */
function forbidden(page: Page) {
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() !== 'GET' &&
      (/\/(messages|goal|turns)(\/|$)/.test(path) ||
        (request.method() === 'POST' &&
          !path.includes('/proxy/') &&
          path !== `/api/hosts/${controller}/connect` &&
          /^\/api\/(hosts|model-policy|projects\/[^/]+\/open-in-editor)(\/|$)/.test(path)))
    )
      writes.push(`${request.method()} ${path}`);
  });
  return writes;
}

/** Controller routes for one journey: a lost first create, then pending, then a verified chat. */
async function controllerRoutes(page: Page, prefix: string) {
  const projectId = randomUUID();
  const fixture = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const manager = fixture.agents.find((agent) => agent.role === 'manager' && agent.projectId);
  if (!manager?.projectId)
    throw new Error('The isolated demo needs a manager for draft readiness.');
  const remote = { projectId: manager.projectId, managerId: manager.id };
  const nested = `${prefix}/cluster/projects/${projectId}/proxy`;
  await page.route(`**${nested}/**`, async (route) => {
    const source = route.request();
    const url = source.url().replace(nested, '/api');
    if (new URL(url).pathname === '/api/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'event: ready\ndata: {}\n\n',
      });
    return route.continue({
      url,
      headers: { ...source.headers(), Origin: new URL(source.url()).origin },
    });
  });
  const calls = { creates: [] as Record<string, unknown>[], opens: [] as { key: string }[] };
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${prefix}/cluster/workspace`, (route) => route.fulfill({ json: workspace }));
  await page.route(`**${prefix}/cluster/projects`, async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: [] });
    const body = route.request().postDataJSON();
    clusterProjectCreateSchema.parse(body);
    calls.creates.push(body);
    // The first request is held, then its reply is lost after it left the browser.
    if (calls.creates.length === 1) {
      await held;
      return route.abort('connectionreset');
    }
    if (calls.creates.length === 2)
      return route.fulfill({
        status: 403,
        json: { error: 'Reconnect to inspect the saved request.' },
      });
    return route.fulfill({ json: summary(projectId, 'pending') });
  });
  const ready = () => calls.opens.length > 1;
  await page.route(`**${prefix}/cluster/projects/${projectId}`, (route) =>
    route.fulfill({ json: summary(projectId, ready() ? 'ready' : 'pending', remote) }),
  );
  await page.route(`**${prefix}/cluster/projects/${projectId}/open`, async (route) => {
    if (route.request().method() === 'POST') calls.opens.push(route.request().postDataJSON());
    await route.fulfill({
      json: clusterProjectOpenedSchema.parse({
        project: summary(projectId, ready() ? 'ready' : 'pending', remote),
        destination: ready() ? { hostId: randomUUID(), ...remote } : null,
      }),
    });
  });
  return { projectId, remote, managerName: manager.name, calls, release: () => release() };
}

for (const via of ['local', 'selected'] as const)
  test(`one Spawn from the ${via} controller keeps an unsent brief until its verified chat`, async ({
    page,
  }, info) => {
    const host = via === 'local' ? 'local' : controller;
    const writes = forbidden(page);
    if (via === 'selected')
      await page.addInitScript((id) => {
        if (!sessionStorage.getItem('fixture-started')) {
          sessionStorage.setItem('fixture-started', '1');
          localStorage.setItem('dock:host', id);
        }
      }, controller);
    await page.route('**/api/hosts', (route) => route.fulfill({ json: hosts }));
    const prefix = via === 'local' ? '/api' : `/api/hosts/${controller}/proxy`;
    if (via === 'selected')
      // The selected controller is this demo app; specific cluster routes below take precedence.
      await page.route(`**${prefix}/**`, async (route) => {
        const source = route.request();
        const url = source.url().replace(prefix, '/api');
        if (new URL(url).pathname === '/api/events')
          return route.fulfill({
            contentType: 'text/event-stream',
            body: 'event: ready\ndata: {}\n\n',
          });
        return route.continue({
          url,
          headers: { ...source.headers(), Origin: new URL(source.url()).origin },
        });
      });
    const { projectId, remote, managerName, calls, release } = await controllerRoutes(page, prefix);
    await page.goto('/#/new');
    const choice = page.getByRole('radiogroup', { name: 'Where the project runs' });
    await expect(choice).toBeVisible();
    const destination = await choice.locator('label').first().boundingBox();
    expect(destination && destination.height >= 44 && destination.height <= 56).toBe(true);
    // The local branch is unchanged and keeps its own draft.
    await page.getByLabel('Project name').fill('Local notes');
    await choice.getByRole('radio', { name: 'Cluster project' }).check();
    const setup = page.getByRole('region', { name: 'Cluster project setup' });
    const folder = setup.getByLabel('Folder on the cluster');
    await folder.selectOption({ label: 'Thesis (whole folder)' });
    await expect(folder).toHaveValue(rootFolder);
    await expect(folder.locator('option', { hasText: 'README.md' })).toHaveCount(0);
    const name = setup.getByLabel('Name', { exact: true });
    await expect(name).toHaveValue('Thesis');
    await folder.selectOption(srcFolder);
    await expect(name).toHaveValue('src');
    await name.fill('A chosen title');
    await folder.selectOption(rootFolder);
    await expect(name).toHaveValue('A chosen title');
    await name.fill('');
    await folder.selectOption(srcFolder);
    await expect(name).toHaveValue('');
    await folder.selectOption(rootFolder);
    await setup.getByLabel('Name', { exact: true }).fill('Cluster thesis');
    await expect(setup.getByLabel('Model')).not.toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/setup-${via}-${info.project.name}.png` });

    // One Spawn: the writing surface opens at once while creation is still in flight.
    await setup.getByRole('button', { name: 'Spawn cluster project' }).click();
    const notepad = page.getByRole('dialog');
    const text = notepad.getByLabel('Project description');
    await expect(text).toBeEditable();
    await expect.poll(() => calls.creates.length).toBe(1);
    await text.fill('First: profile the solver on the test partition.');
    release();
    await expect(notepad).toContainText('Creation may not have finished');
    await page.reload();
    await expect(text).toHaveValue('First: profile the solver on the test partition.');
    await expect(page.getByRole('button', { name: 'Stop retrying' })).toHaveCount(0);
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/uncertain-${via}-${info.project.name}.png` });
    await notepad.getByRole('button', { name: 'Spawn cluster project' }).click();
    await expect(notepad).toContainText('Reconnect to inspect the saved request.');
    await expect(notepad).toContainText('Creation may not have finished');
    await page.reload();
    await expect(text).toHaveValue('First: profile the solver on the test partition.');
    await notepad.getByRole('button', { name: 'Spawn cluster project' }).click();
    await expect(notepad).toContainText('Waiting in the Slurm queue · job 5100 · Priority');
    // The lost request was repeated exactly; one project record exists.
    expect(calls.creates).toEqual([calls.creates[0], calls.creates[0], calls.creates[0]]);
    expect(new Set(calls.creates.map((body) => body.key)).size).toBe(1);
    expect(calls.creates[0]).toMatchObject({ folderId: rootFolder, name: 'Cluster thesis' });
    expect((calls.creates[0].manager as { effort: string }).effort).toBeTruthy();
    expect(JSON.stringify(calls.creates)).not.toMatch(/projects\/thesis|\/n\/home|ssh|\.sh\b/);

    await page.reload();
    await expect(text).toHaveValue('First: profile the solver on the test partition.');
    await expect(notepad).toContainText('Waiting in the Slurm queue');
    await page.screenshot({ path: `${shots}/pending-${via}-${info.project.name}.png` });
    await notepad.getByRole('button', { name: 'Check again and open' }).click();
    await expect.poll(() => page.url()).toContain(`#/chat/${remote.managerId}`);
    // The reopened cluster document verifies the same project through the controller first.
    await expect(page.locator('.home-computer-name').first()).toHaveText(
      `Cluster project via ${via === 'local' ? 'Entry fixture' : 'Controller fixture'}`,
    );
    expect(calls.opens.length).toBeGreaterThanOrEqual(3);
    expect(new Set(calls.opens.map((body) => body.key)).size).toBe(1);
    expect(calls.opens[0].key).toMatch(uuidKey);
    const scope = `cluster:${host}:${projectId}`;
    const draftKey = `dock:${scope}:workspace:draft:${remote.managerId}`;
    await expect(page.getByRole('textbox', { name: `Message ${managerName}` })).toHaveValue(
      'First: profile the solver on the test partition.',
    );
    expect(
      JSON.parse((await page.evaluate((key) => localStorage.getItem(key), draftKey))!),
    ).toMatchObject({
      text: 'First: profile the solver on the test partition.',
    });
    await page.screenshot({ path: `${shots}/ready-chat-${via}-${info.project.name}.png` });

    expect(writes).toEqual([]);
    // An explicit computer choice leaves the cluster project and keeps its saved draft.
    await page.goto('/#/computers');
    await page
      .getByLabel('Computer', { exact: true })
      .selectOption(via === 'local' ? controller : 'local');
    await expect(page.locator('.home-computer-name').first()).toHaveText(
      via === 'local' ? 'Controller fixture' : 'Entry fixture',
    );
    expect(await page.evaluate(() => localStorage.getItem('dock:cluster-project'))).toBeNull();
    expect(await page.evaluate((key) => localStorage.getItem(key), draftKey)).toContain(
      'profile the solver',
    );
    // Only the existing connection to the computer the owner explicitly chose; no registry change.
    expect(writes.filter((write) => write !== `POST /api/hosts/${controller}/connect`)).toEqual([]);
  });

test('a cluster create makes no request when its exact retry receipt cannot be saved', async ({
  page,
}) => {
  const { calls } = await controllerRoutes(page, '/api');
  const writes = forbidden(page);
  await page.goto('/#/new');
  await page.getByRole('radio', { name: 'Cluster project', exact: true }).check();
  const setup = page.getByRole('region', { name: 'Cluster project setup' });
  await setup.getByLabel('Folder on the cluster').selectOption(rootFolder);
  await setup.getByLabel('Name', { exact: true }).fill('Retained request');
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith(':cluster-project-setup'))
        throw new DOMException('Storage unavailable', 'QuotaExceededError');
      set.call(this, key, value);
    };
  });
  await setup.getByRole('button', { name: 'Spawn cluster project' }).click();
  const note = page.getByRole('dialog');
  await expect(note.getByRole('alert')).toContainText('could not save the create request');
  await expect(note.getByRole('alert')).toContainText('no project was created');
  expect(calls.creates).toEqual([]);
  expect(calls.opens).toEqual([]);
  expect(writes).toEqual([]);
});

test('a saved cluster scope mounts nothing nested until its controller verifies the project', async ({
  page,
  baseURL,
}, info) => {
  const projectId = randomUUID();
  const remote = { projectId: randomUUID(), managerId: randomUUID() };
  const writes = forbidden(page);
  await page.addInitScript((projectId) => {
    if (sessionStorage.getItem('fixture-started')) return;
    sessionStorage.setItem('fixture-started', '1');
    localStorage.setItem('dock:host', 'local');
    localStorage.setItem(
      'dock:cluster-project',
      JSON.stringify({ controllerHost: 'local', projectId }),
    );
    localStorage.setItem(`dock:local:cluster-brief:${projectId}`, 'Keep this first request.');
  }, projectId);
  const nested: string[] = [];
  const prefix = `/api/cluster/projects/${projectId}/proxy`;
  await page.route(`**${prefix}/**`, async (route) => {
    const source = route.request();
    nested.push(new URL(source.url()).pathname);
    const url = source.url().replace(prefix, '/api');
    if (new URL(url).pathname === '/api/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'event: ready\ndata: {}\n\n',
      });
    return route.continue({
      url,
      headers: { ...source.headers(), Origin: baseURL! },
    });
  });
  const opens: { key: string }[] = [];
  let answer: 'hold' | 'pending' | 'ready' = 'hold';
  let release = () => {};
  await page.route(`**/api/cluster/projects/${projectId}/open`, async (route) => {
    if (route.request().method() === 'POST') opens.push(route.request().postDataJSON());
    if (answer === 'hold' && route.request().method() === 'POST')
      await new Promise<void>((resolve) => (release = resolve));
    // This case exercises an explicit retry. Cached GET readiness has a separate case below.
    const ready = answer === 'ready' && route.request().method() === 'POST';
    await route.fulfill({
      json: {
        project: summary(projectId, ready ? 'ready' : 'pending', remote),
        destination: ready ? { hostId: randomUUID(), ...remote } : null,
      },
    });
  });
  await page.goto('/');
  const gate = page.getByRole('main', { name: 'Reconnecting cluster project' });
  await expect(gate.getByRole('status')).toHaveText('Reconnecting through its controller…');
  await expect.poll(() => opens.length).toBe(1);
  expect(nested).toEqual([]);
  answer = 'pending';
  release();
  await expect(gate.getByRole('status')).toContainText('Waiting in the Slurm queue');
  await expect(gate.getByLabel(/Your unsent first request/)).toHaveValue(
    'Keep this first request.',
  );
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/gate-pending-${info.project.name}.png` });
  expect(nested).toEqual([]);
  // A reload repeats the same plain key; it never creates or replays anything.
  await page.reload();
  await expect(gate.getByRole('status')).toContainText('Waiting in the Slurm queue');
  expect(opens.map((body) => body.key)).toEqual([opens[0].key, opens[0].key]);
  expect(opens[0].key).toMatch(uuidKey);
  expect(nested).toEqual([]);
  answer = 'ready';
  await gate.getByRole('button', { name: 'Check again' }).click();
  await expect(page.locator('.home-computer-name').first()).toHaveText(/Cluster project via/);
  await expect.poll(() => nested.length).toBeGreaterThan(0);
  // After a controller restart its gateway map is empty: a reload reconnects the same project.
  const before = opens.length;
  await page.reload();
  await expect(page.locator('.home-computer-name').first()).toHaveText(/Cluster project via/);
  expect(opens.length).toBe(before + 1);
  expect(new Set(opens.map((body) => body.key)).size).toBe(1);
  expect(writes).toEqual([]);
  // Readiness assertions are complete; reload hydration may still have canceled mock reads.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('Return to controller from a pending cluster scope keeps its brief and the local journey', async ({
  page,
}) => {
  const projectId = randomUUID();
  const writes = forbidden(page);
  await page.addInitScript((projectId) => {
    if (sessionStorage.getItem('fixture-started')) return;
    sessionStorage.setItem('fixture-started', '1');
    localStorage.setItem('dock:host', 'local');
    localStorage.setItem(
      'dock:cluster-project',
      JSON.stringify({ controllerHost: 'local', projectId }),
    );
    localStorage.setItem(`dock:local:cluster-brief:${projectId}`, 'Keep this first request.');
  }, projectId);
  const nested: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`/cluster/projects/${projectId}/proxy`)) nested.push(request.url());
  });
  await page.route(`**/api/cluster/projects/${projectId}/open`, (route) =>
    route.fulfill({ status: 503, json: { error: 'The controller could not reach the cluster.' } }),
  );
  await page.route('**/api/cluster/workspace', (route) => route.fulfill({ json: workspace }));
  await page.route('**/api/cluster/projects', (route) => route.fulfill({ json: [] }));
  await page.goto('/#/chats');
  const gate = page.getByRole('main', { name: 'Reconnecting cluster project' });
  await expect(gate.getByRole('alert')).toHaveText('The controller could not reach the cluster.');
  await page.evaluate((key) => {
    const set = Storage.prototype.setItem;
    Object.defineProperty(window, 'restoreBriefFixture', {
      value: () => (Storage.prototype.setItem = set),
    });
    Storage.prototype.setItem = function (item, value) {
      if (item === key) throw new DOMException('Storage unavailable', 'QuotaExceededError');
      set.call(this, item, value);
    };
  }, `dock:local:cluster-brief:${projectId}`);
  await gate.getByLabel(/Your unsent first request/).fill('An edit that cannot be saved yet.');
  await expect(gate.getByRole('alert').last()).toHaveText(
    'This browser could not save the draft. Copy it before leaving.',
  );
  await page.evaluate(() =>
    (window as unknown as { restoreBriefFixture: () => void }).restoreBriefFixture(),
  );
  await gate.getByLabel(/Your unsent first request/).fill('Keep this first request, edited.');
  await expect(
    gate.getByText('This browser could not save the draft. Copy it before leaving.'),
  ).toHaveCount(0);
  await gate.getByRole('button', { name: 'Return to controller' }).click();
  await expect(page.locator('.home-computer-name').first()).not.toHaveText(/Cluster project/);
  await expect(page.locator('.home-computer-name').first()).toHaveText(/\S/);
  expect(await page.evaluate(() => localStorage.getItem('dock:cluster-project'))).toBeNull();
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      `dock:local:cluster-brief:${projectId}`,
    ),
  ).toBe('Keep this first request, edited.');
  await page.goto('/#/new');
  await expect(page.getByRole('radiogroup', { name: 'Where the project runs' })).toBeVisible();
  await expect(page.getByLabel('Project name')).toBeVisible();
  expect(nested).toEqual([]);
  expect(writes).toEqual([]);
});

test('Chats lists cluster projects as separate destinations and reports setup honestly', async ({
  page,
}, info) => {
  const id = randomUUID();
  const project = clusterProjectSummarySchema.parse({
    id,
    name: 'Cluster thesis',
    description: '',
    alias: 'hpc',
    folderId: rootFolder,
    createdAt: at(5),
    provider: 'claude',
    hostId: randomUUID(),
    remoteProjectId: null,
    remoteManagerId: null,
    development: { state: 'absent', jobId: null, node: null, observedAt: null, message: '' },
    setupRequired: 'Confirm the cluster account for development jobs.',
  });
  const opens: unknown[] = [];
  const sends: string[] = [];
  page.on('request', (request) => {
    if (/\/(messages|goal)(\/|$)/.test(new URL(request.url()).pathname)) sends.push(request.url());
  });
  await page.route('**/api/cluster/workspace', (route) => route.fulfill({ json: workspace }));
  await page.route('**/api/cluster/projects', (route) => route.fulfill({ json: [project] }));
  await page.route(`**/api/cluster/projects/${id}/open`, async (route) => {
    if (route.request().method() === 'POST') opens.push(route.request().postDataJSON());
    await route.fulfill({ json: { project, destination: null } });
  });
  await page.goto('/#/chats');
  const list = page.getByRole('region', { name: 'Cluster projects' });
  await expect(list).toContainText('Cluster thesis');
  await expect(list).toContainText('hpc · No development allocation yet · setup needed');
  // Not a local manager row.
  await expect(
    page.getByRole('navigation', { name: 'Conversation list' }).getByText('Cluster thesis'),
  ).toHaveCount(0);
  await list.getByRole('button', { name: 'Open' }).click();
  await expect(list.getByRole('status')).toContainText(
    'Setup needed: Confirm the cluster account for development jobs.',
  );
  await expect(list.getByRole('link', { name: 'Open QUARK cluster setup' })).toHaveAttribute(
    'href',
    '#/work',
  );
  expect(page.url()).toContain('#/chats');
  expect(opens).toHaveLength(1);
  expect(sends).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(shots, { recursive: true });
  await list.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/chats-${info.project.name}.png` });
});

test('a reconnecting chat keeps edits in its actual scoped draft before nested hydration', async ({
  page,
}) => {
  const { projectId, remote, managerName } = await controllerRoutes(page, '/api');
  const writes = forbidden(page);
  const draftKey = `dock:cluster:local:${projectId}:workspace:draft:${remote.managerId}`;
  await page.addInitScript(
    ({ projectId, draftKey }) => {
      if (sessionStorage.getItem('fixture-started')) return;
      sessionStorage.setItem('fixture-started', '1');
      localStorage.setItem('dock:host', 'local');
      localStorage.setItem(
        'dock:cluster-project',
        JSON.stringify({ controllerHost: 'local', projectId }),
      );
      localStorage.setItem(
        draftKey,
        JSON.stringify({ text: 'My current chat draft.', baseRevision: 0 }),
      );
    },
    { projectId, draftKey },
  );
  await page.goto(`/#/chat/${remote.managerId}`);
  const gate = page.getByRole('main', { name: 'Reconnecting cluster project' });
  await expect(gate.getByRole('status')).toContainText('Waiting in the Slurm queue');
  const draft = gate.getByLabel('Your unsent chat draft (saved here)');
  await expect(draft).toHaveValue('My current chat draft.');
  await draft.fill('My current chat draft, edited while reconnecting.');
  await gate.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('textbox', { name: `Message ${managerName}` })).toHaveValue(
    'My current chat draft, edited while reconnecting.',
  );
  expect(writes).toEqual([]);
});

test('non-Git tracking is explicit and a lost consent receipt retries once across reload without sending the brief', async ({
  page,
}, info) => {
  const projectId = randomUUID();
  const fixture = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const manager = fixture.agents.find((a) => a.role === 'manager' && a.projectId)!;
  const remote = { projectId: manager.projectId!, managerId: manager.id };
  const created = {
    ...summary(projectId, 'pending', remote),
    folderId: srcFolder,
    needsTracking: true,
    setupRequired: 'Start tracking to prepare this folder.',
  };
  const tracking: unknown[] = [];
  const creates: unknown[] = [];
  const opens: unknown[] = [];
  let consented = false;
  await page.route('**/api/cluster/workspace', (route) => route.fulfill({ json: workspace }));
  await page.route('**/api/cluster/projects', (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: [] });
    creates.push(route.request().postDataJSON());
    return route.fulfill({ json: created });
  });
  await page.route(`**/api/cluster/projects/${projectId}`, (route) =>
    route.fulfill({ json: created }),
  );
  await page.route(`**/api/cluster/projects/${projectId}/tracking`, (route) => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ key: expect.stringMatching(uuidKey) });
    tracking.push(body);
    // The remote consent could have arrived even though its response was lost.
    consented = true;
    if (tracking.length === 1)
      return route.fulfill({ status: 502, json: { error: 'Consent receipt not confirmed.' } });
    created.needsTracking = false;
    created.setupRequired = null;
    return route.fulfill({ json: created });
  });
  await page.route(`**/api/cluster/projects/${projectId}/open`, (route) => {
    if (route.request().method() === 'POST') opens.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        project: created,
        destination:
          consented && !created.needsTracking ? { hostId: created.hostId, ...remote } : null,
      },
    });
  });
  const nested = `/api/cluster/projects/${projectId}/proxy`;
  await page.route(`**${nested}/**`, async (route) => {
    const source = route.request();
    const url = source.url().replace(nested, '/api');
    if (new URL(url).pathname === '/api/events')
      return route.fulfill({ contentType: 'text/event-stream', body: '' });
    return route.continue({
      url,
      headers: { ...source.headers(), Origin: new URL(source.url()).origin },
    });
  });
  const writes = forbidden(page);
  await page.goto('/#/new');
  await page.getByRole('radio', { name: 'Cluster project', exact: true }).check();
  const setup = page.getByRole('region', { name: 'Cluster project setup' });
  await setup.getByLabel('Folder on the cluster').selectOption(srcFolder);
  await setup.getByLabel('Name', { exact: true }).fill('Cluster thesis');
  await expect(setup.getByLabel('Model')).not.toHaveValue('');
  await setup.getByRole('button', { name: 'Spawn cluster project' }).click();
  const note = page.getByRole('dialog');
  const text = note.getByLabel('Project description');
  await text.fill('Retain this non-Git brief');
  await expect(note.getByRole('button', { name: 'Start tracking', exact: true })).toBeVisible();
  expect(tracking).toEqual([]);
  expect(creates).toHaveLength(1);
  expect(opens).toHaveLength(1);
  await expect(note).toContainText('initial project Git history');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const send = await note
    .getByRole('button', { name: 'Start tracking', exact: true })
    .boundingBox();
  const { height, width } = await page.evaluate(() => ({ height: innerHeight, width: innerWidth }));
  expect(
    send &&
      send.y >= 0 &&
      send.y + send.height <= height &&
      send.x >= 0 &&
      send.x + send.width <= width,
  ).toBe(true);
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/tracking-consent-${info.project.name}.png` });
  await note.getByRole('button', { name: 'Start tracking', exact: true }).click();
  await expect(note).toContainText('Consent receipt not confirmed');
  await page.reload();
  await note.getByRole('button', { name: 'Start tracking', exact: true }).click();
  await expect(page.getByRole('textbox', { name: `Message ${manager.name}` })).toHaveValue(
    'Retain this non-Git brief',
  );
  expect(tracking).toHaveLength(2);
  expect(tracking[1]).toEqual(tracking[0]);
  expect(creates).toHaveLength(1);
  expect(new Set(opens.map((v) => (v as { key: string }).key)).size).toBe(1);
  expect(writes).toEqual([]);
});

test('first compute preparation keeps Notepad editable and opens verified cached readiness without POST polling', async ({
  page,
}) => {
  const projectId = randomUUID();
  const fixture = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const manager = fixture.agents.find((a) => a.role === 'manager' && a.projectId)!;
  const remote = { projectId: manager.projectId!, managerId: manager.id };
  const preparing = {
    ...summary(projectId, 'pending', remote),
    opening: {
      state: 'preparing',
      startedAt: at(1),
      updatedAt: at(0),
      message: 'Preparing the first compute runtime.',
    },
  };
  const posts: unknown[] = [],
    creates: unknown[] = [];
  let reads = 0,
    ready = false;
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/cluster/workspace', (route) => route.fulfill({ json: workspace }));
  await page.route('**/api/cluster/projects', (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: [] });
    creates.push(route.request().postDataJSON());
    return route.fulfill({ json: preparing });
  });
  await page.route(`**/api/cluster/projects/${projectId}`, (route) =>
    route.fulfill({ json: preparing }),
  );
  await page.route(`**/api/cluster/projects/${projectId}/open`, async (route) => {
    if (route.request().method() === 'POST') posts.push(route.request().postDataJSON());
    else {
      reads++;
      await held;
    }
    await route.fulfill({
      json: {
        project: ready
          ? {
              ...preparing,
              opening: { ...preparing.opening, state: 'ready' },
              development: { ...preparing.development, state: 'ready' },
            }
          : preparing,
        destination: ready ? { hostId: preparing.hostId, ...remote } : null,
      },
    });
  });
  const nested = `/api/cluster/projects/${projectId}/proxy`;
  await page.route(`**${nested}/**`, async (route) => {
    const source = route.request(),
      url = source.url().replace(nested, '/api');
    if (new URL(url).pathname === '/api/events')
      return route.fulfill({ contentType: 'text/event-stream', body: '' });
    return route.continue({
      url,
      headers: { ...source.headers(), Origin: new URL(source.url()).origin },
    });
  });
  const writes = forbidden(page);
  await page.goto('/#/new');
  await page.getByRole('radio', { name: 'Cluster project', exact: true }).check();
  const setup = page.getByRole('region', { name: 'Cluster project setup' });
  await setup.getByLabel('Folder on the cluster').selectOption(rootFolder);
  await setup.getByLabel('Name', { exact: true }).fill('Preparing thesis');
  await expect(setup.getByLabel('Model')).not.toHaveValue('');
  await setup.getByRole('button', { name: 'Spawn cluster project' }).click();
  const note = page.getByRole('dialog');
  await expect(note).toContainText('First setup may take several minutes');
  await note.getByLabel('Project description').fill('Still typing during compute preparation.');
  await expect.poll(() => reads).toBeGreaterThan(0);
  expect(posts).toHaveLength(1);
  ready = true;
  release();
  await expect(page.getByRole('textbox', { name: `Message ${manager.name}` })).toHaveValue(
    'Still typing during compute preparation.',
  );
  expect(creates).toHaveLength(1);
  expect(posts).toHaveLength(2); // initial owner open, then one new-document gateway check
  expect(posts[1]).toEqual(posts[0]);
  expect(writes).toEqual([]);
});
