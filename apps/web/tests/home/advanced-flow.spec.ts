import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function project(page: Page, provider: 'codex' | 'claude' = 'codex') {
  const response = await page.request.post('/api/projects', {
    headers: { origin: 'http://127.0.0.1:4339' },
    data: { key: randomUUID(), name: `Controls ${randomUUID().slice(0, 8)}`, provider },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('advanced controls read metadata, retry a model failure and save an explicit model without starting work', async ({
  page,
}, info) => {
  const owner = await project(page);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  let reads = 0;
  await page.route('**/api/models?*', async (route) => {
    if (++reads === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'Model catalog temporarily unavailable.' },
      });
    await route.fallback();
  });
  await page.goto(`/#/advanced/${owner.managerId}`);
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await page.getByRole('button', { name: 'Try loading models again' }).click();
  await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeEnabled();
  await expect(page.getByRole('combobox', { name: 'Tools and connections' })).toHaveValue('native');
  expect(writes).toEqual([]);
  expect(
    await page.locator('.settings-card').evaluate((node) => {
      const card = node.getBoundingClientRect();
      const panel = node.parentElement!.getBoundingClientRect();
      return (
        card.top >= panel.top &&
        card.bottom <= panel.bottom &&
        card.left >= panel.left &&
        card.right <= panel.right
      );
    }),
  ).toBe(true);
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption({ index: 1 });
  const model = await page.getByRole('combobox', { name: 'Model', exact: true }).inputValue();
  await page.screenshot({
    path: `../../data/screenshots/advanced/${info.project.name}-settings.png`,
  });
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${owner.managerId}$`));
  const detail = await (await page.request.get(`/api/agents/${owner.managerId}`)).json();
  expect(detail.agent.model).toBe(model);
  expect(detail.agent.toolPolicy).toBe('native');
  expect(detail.runs).toEqual([]);
  expect(writes.filter((url) => /\/(messages|commands)$/.test(url))).toEqual([]);
  await page.goto(`/#/advanced/${owner.managerId}`);
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(model);
  await page.getByRole('combobox', { name: 'Tools and connections' }).selectOption('restricted');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${owner.managerId}$`));
  await page.goto(`/#/advanced/${owner.managerId}`);
  await expect(page.getByRole('combobox', { name: 'Tools and connections' })).toHaveValue(
    'restricted',
  );
  await expect(page.getByRole('region', { name: 'Provider and usage', exact: true })).toContainText(
    'Automatic routing: On.',
  );
});

test('slash shortcuts open the matching confirmation and a lost context-command receipt survives reload', async ({
  page,
}, info) => {
  const owner = await project(page);
  await page.goto(`/#/chat/${owner.managerId}`);
  const composer = page.getByRole('textbox', {
    name: `Message ${owner.name} manager`,
    exact: true,
  });
  await composer.fill('Retain this visible history.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message.assistant')).toContainText('demo mode');
  await composer.fill('/new');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New context, keep history' })).toBeVisible();
  const requests: object[] = [];
  await page.route('**/api/agents/*/commands', async (route) => {
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    return requests.length === 1
      ? route.fulfill({ status: 502, json: { error: 'Command confirmation lost.' } })
      : route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('confirmation lost');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Check a previous request' })).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.getByRole('button', { name: 'Check the same request', exact: true }).click();
  await page.getByRole('button', { name: 'Check command receipt', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('New context is ready');
  expect(requests[0]).toEqual(requests[1]);
  await page.screenshot({
    path: `../../data/screenshots/advanced/${info.project.name}-commands.png`,
  });
  await page.getByRole('link', { name: 'Return to conversation', exact: true }).click();
  await expect(page.locator('.message.user')).toContainText('Retain this visible history.');
  const detail = await (await page.request.get(`/api/agents/${owner.managerId}`)).json();
  expect(detail.runs).toHaveLength(1);
});

test('module manager and task drafts recover the same actual creations after lost responses', async ({
  page,
}, info) => {
  const owner = await project(page);
  await page.goto(`/#/project/${owner.id}`);
  await page.getByRole('button', { name: 'Add manager', exact: true }).click();
  await page.getByLabel('Manager name', { exact: true }).fill('Design manager');
  await page.getByLabel('Area of responsibility').fill('Interface and accessibility');
  await page.reload();
  await page.getByRole('button', { name: 'Add manager', exact: true }).click();
  await expect(page.getByLabel('Manager name', { exact: true })).toHaveValue('Design manager');
  const managers: object[] = [];
  await page.route('**/api/projects/*/managers', async (route) => {
    managers.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    return managers.length === 1
      ? route.fulfill({ status: 502, json: { error: 'Creation confirmation lost.' } })
      : route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Create manager', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('confirmation lost');
  await expect(page.getByLabel('Manager name', { exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Add manager', exact: true }).click();
  await page.getByRole('button', { name: 'Check manager request', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Design manager');
  expect(managers[0]).toEqual(managers[1]);
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const added = snapshot.agents.filter(
    (a: { projectId: string; name: string }) =>
      a.projectId === owner.id && a.name === 'Design manager',
  );
  expect(added).toHaveLength(1);
  expect((await (await page.request.get(`/api/agents/${added[0].id}`)).json()).runs).toEqual([]);
  await page.getByRole('link', { name: 'Project overview', exact: true }).click();
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await page.getByLabel('Responsible manager').selectOption(added[0].id);
  await page.getByLabel('Task name', { exact: true }).fill('Improve keyboard navigation');
  await page.getByLabel('What should change?').fill('Make all actions reachable by keyboard.');
  await page
    .getByLabel('How will we know it works?')
    .fill('The full flow is operable without a mouse.');
  await page.reload();
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByLabel('Task name', { exact: true })).toHaveValue(
    'Improve keyboard navigation',
  );
  await expect(page.getByLabel('Responsible manager')).toHaveValue(added[0].id);
  await page.screenshot({ path: `../../data/screenshots/advanced/${info.project.name}-task.png` });
  const tasks: object[] = [];
  await page.route('**/api/projects/*/tasks', async (route) => {
    tasks.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    return tasks.length === 1
      ? route.fulfill({ status: 502, json: { error: 'Task confirmation lost.' } })
      : route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('confirmation lost');
  await expect(page.getByLabel('Task name', { exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await page.getByRole('button', { name: 'Check task request', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(tasks[0]).toEqual(tasks[1]);
  const after = await (await page.request.get('/api/snapshot')).json();
  expect(after.tasks.filter((t: { projectId: string }) => t.projectId === owner.id)).toHaveLength(
    1,
  );
  const detail = await (await page.request.get(`/api/agents/${added[0].id}`)).json();
  expect(detail.runs).toHaveLength(1);
});

test('literal absolute paths can be sent while native commands keep an explicit route', async ({
  page,
}) => {
  const owner = await project(page);
  await page.goto(`/#/chat/${owner.managerId}`);
  const composer = page.getByRole('textbox', {
    name: `Message ${owner.name} manager`,
    exact: true,
  });
  const text = '/Users/example/project Please explain this folder.';
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(composer).toHaveValue(text);
  await page.getByRole('button', { name: 'Send as text', exact: true }).click();
  await expect(page.locator('.message.user')).toContainText(text);
  await expect(page.locator('.message.assistant')).toContainText('demo mode');
  await composer.fill('/compact');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Compact working context' })).toContainText(
    'QUARK',
  );
  await page.getByRole('button', { name: 'Keep reviewing', exact: true }).click();
  expect(
    (await (await page.request.get(`/api/agents/${owner.managerId}`)).json()).runs,
  ).toHaveLength(1);
});

test('native terminal is explicit and returns control before returning to chat', async ({
  page,
}, info) => {
  const owner = await project(page);
  let opened = 0;
  let closed = 0;
  await page.routeWebSocket('**/api/agents/*/terminal', (socket) => {
    opened++;
    socket.send(JSON.stringify({ type: 'ready' }));
    socket.send(JSON.stringify({ type: 'output', data: 'Native provider controls\r\n' }));
  });
  await page.route('**/api/agents/*/terminal/close', (route) => {
    closed++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/#/advanced/${owner.managerId}`);
  await expect(page.getByRole('button', { name: 'Open native Codex', exact: true })).toBeVisible();
  expect(opened).toBe(0);
  await page.getByRole('button', { name: 'Open native Codex', exact: true }).click();
  await expect(page.locator('.terminal-bar')).toContainText('connected');
  expect(opened).toBe(1);
  await page.screenshot({
    path: `../../data/screenshots/advanced/${info.project.name}-native.png`,
  });
  await page.getByRole('link', { name: 'Return to conversation', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${owner.managerId}$`));
  expect(closed).toBe(1);
});

test('Codex history can be read and imported in a Claude-managed project without starting work', async ({
  page,
}, info) => {
  const owner = await project(page, 'claude');
  // Catalog rendering uses a fixture; history is served by the real Sessions API and
  // metadata-only demo provider. No Claude account discovery or model turn occurs.
  await page.route('**/api/models?*', (route) =>
    route.fulfill({
      json: [
        { id: 'claude-fixture', label: 'Claude fixture', efforts: ['medium'], isDefault: true },
      ],
    }),
  );
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.goto(`/#/advanced/${owner.managerId}`);
  await expect(page.getByRole('button', { name: 'Open native Codex', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Browse saved Codex sessions', exact: true }).click();
  // Demo history identities are global, like native provider sessions. Each browser
  // profile takes a separate identity in this isolated demo database.
  await page
    .getByRole('button', { name: new RegExp(`Saved ${info.project.name} session`) })
    .click();
  await expect(page.getByRole('button', { name: 'Import history', exact: true })).toBeDisabled();
  await page
    .getByRole('checkbox', {
      name: 'I have stopped this conversation in its original Codex window.',
    })
    .check();
  await page.getByRole('button', { name: 'Import history', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    `Saved ${info.project.name} session`,
  );
  await expect(page.locator('.message.assistant')).toContainText('Example saved answer');
  expect(writes.filter((url) => /\/(messages|commands)$/.test(url))).toEqual([]);
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const imported = snapshot.agents.find(
    (agent: { projectId: string; name: string }) =>
      agent.projectId === owner.id && agent.name === `Saved ${info.project.name} session`,
  );
  expect(imported.provider).toBe('codex');
  expect(imported.parentId).toBe(owner.managerId);
  expect(
    (await (await page.request.get(`/api/agents/${owner.managerId}`)).json()).agent.provider,
  ).toBe('claude');
  expect((await (await page.request.get(`/api/agents/${imported.id}`)).json()).runs).toEqual([]);
});
