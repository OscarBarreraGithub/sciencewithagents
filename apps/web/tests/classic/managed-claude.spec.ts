import { test, expect, type Page } from './fixture';
import { randomUUID } from 'node:crypto';
import type { Agent } from '@dock/shared';

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});
async function projectMenu(page: Page) {
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
}

test('a fresh Claude project keeps provider and one retry receipt after lost response and reload', async ({
  page,
}, info) => {
  let completed = false;
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    await route.fulfill({
      json: completed
        ? state
        : { ...state, projects: [], agents: [], tasks: [], approvals: [], decisions: [] },
    });
  });
  const submissions: Array<{ key: string; provider: string }> = [];
  await page.route('**/api/projects', async (route) => {
    submissions.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    if (submissions.length === 1) return route.abort('failed');
    completed = true;
    await route.fulfill({ response });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create your first project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a project' });
  const name = `Claude idea ${info.project.name} ${Date.now()}`;
  await dialog.getByLabel('Project name', { exact: true }).fill(name);
  await dialog.getByLabel('Manager provider').selectOption('claude');
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your details are saved');
  await page.reload();
  await page.getByRole('button', { name: 'Create your first project', exact: true }).click();
  await expect(dialog.getByLabel('Manager provider')).toHaveValue('claude');
  await expect(dialog.getByLabel('Project name', { exact: true })).toHaveValue(name);
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: `${name} manager`, level: 1, exact: true }),
  ).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[0]).toEqual(submissions[1]);
  expect(submissions[0].provider).toBe('claude');
  const state = await (await page.request.get('/api/snapshot')).json();
  const project = state.projects.find((item: { name: string }) => item.name === name);
  expect(state.projects.filter((item: { name: string }) => item.name === name)).toHaveLength(1);
  const saved = await (await page.request.get(`/api/agents/${project.managerId}`)).json();
  expect(saved.agent.provider).toBe('claude');
  expect(saved.runs).toEqual([]);
  await expect(page.getByRole('button', { name: 'Native terminal', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Session commands', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Compact context', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Resume from history', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New context, keep history', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('mixed-provider module manager creation preserves the provider and receipt across reload', async ({
  page,
}, info) => {
  const initial = await (await page.request.get('/api/snapshot')).json();
  const project = initial.projects[0];
  await page.addInitScript(
    (id) => localStorage.setItem('dock:local:selected', id),
    project.managerId,
  );
  const submissions: object[] = [];
  await page.route(`**/api/projects/${project.id}/managers`, async (route) => {
    submissions.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (submissions.length === 1) return route.abort('failed');
    await route.fulfill({ response });
  });
  const open = async () => {
    if (page.viewportSize()!.width < 1191)
      await page.getByRole('button', { name: 'Open team' }).click();
    await page.getByRole('button', { name: 'Add module manager', exact: true }).click();
  };
  await page.goto('/');
  await open();
  const dialog = page.getByRole('dialog', { name: 'Add module manager' });
  const name = `Claude module ${info.project.name} ${Date.now()}`;
  await dialog.getByLabel('Manager name', { exact: true }).fill(name);
  await dialog.getByLabel('Area of responsibility').fill('Independent research and review.');
  await dialog.getByLabel('Manager provider').selectOption('claude');
  await dialog.getByRole('button', { name: 'Create manager', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your details are still here');
  await page.reload();
  await open();
  await expect(dialog.getByLabel('Manager provider')).toHaveValue('claude');
  await expect(dialog.getByLabel('Manager name', { exact: true })).toHaveValue(name);
  await dialog.getByRole('button', { name: 'Check manager request', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(submissions).toHaveLength(2);
  expect(submissions[0]).toEqual(submissions[1]);
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  expect(snapshot.agents.filter((item: Agent) => item.name === name)).toHaveLength(1);
  expect(snapshot.agents.find((item: Agent) => item.name === name).provider).toBe('claude');
  expect(snapshot.agents.find((item: Agent) => item.id === project.managerId).provider).toBe(
    'codex',
  );
});

test('existing-folder setup keeps the chosen provider and pending request across a reload', async ({
  page,
}) => {
  await page.route('**/api/project-options', (route) =>
    route.fulfill({ json: { canChooseFolder: true } }),
  );
  const submitted: Array<{ key: string; provider?: string }> = [];
  await page.route('**/api/projects/connect-folder', async (route) => {
    submitted.push(route.request().postDataJSON());
    if (submitted.length === 1) return route.abort('failed');
    await route.fulfill({ json: { project: null } });
  });
  const open = async () => {
    await projectMenu(page);
    await page.getByRole('button', { name: 'Add a project', exact: true }).click();
  };
  await page.goto('/');
  await open();
  const dialog = page.getByRole('dialog', { name: 'Create a project' });
  await dialog.getByLabel('Manager provider').selectOption('claude');
  await dialog.getByRole('button', { name: 'Use an existing project folder' }).click();
  await expect(dialog.getByRole('alert')).toContainText('will not be duplicated');
  await page.reload();
  await open();
  await expect(dialog.getByLabel('Manager provider')).toHaveValue('claude');
  await dialog.getByRole('button', { name: 'Use an existing project folder' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect(submitted[0]).toEqual(submitted[1]);
  expect(submitted[0].provider).toBe('claude');
  await dialog.getByLabel('Manager provider').selectOption('codex');
  await dialog.getByRole('button', { name: 'Use an existing project folder' }).click();
  await expect.poll(() => submitted.length).toBe(3);
  expect(submitted[2].provider).toBe('codex');
  expect(submitted[2].key).not.toBe(submitted[0].key);
});

test('Claude settings use its installed model scope, explain native-only controls and show last-turn usage honestly', async ({
  page,
}, info) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const original: Agent = snapshot.agents.find(
    (item: Agent) => item.role === 'implementer' && !item.nativeRootId,
  );
  const agent: Agent = {
    ...original,
    provider: 'claude',
    model: 'claude-fixture',
    effort: 'medium',
    status: 'running',
  };
  await page.addInitScript((id) => localStorage.setItem('dock:local:selected', id), agent.id);
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    value.agents = value.agents.map((item: Agent) => (item.id === agent.id ? agent : item));
    await route.fulfill({ json: value });
  });
  await page.route(`**/api/agents/${agent.id}`, async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({ json: { ...value, agent } });
  });
  let modelReads = 0,
    forbiddenRequests = 0;
  const savedSettings: object[] = [];
  await page.route(`**/api/agents/${agent.id}/settings`, async (route) => {
    savedSettings.push(route.request().postDataJSON());
    await route.fulfill({ json: agent });
  });
  await page.route('**/api/models?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get('agentId')).toBe(agent.id);
    expect(query.get('provider')).toBe('claude');
    if (++modelReads === 1)
      return route.fulfill({ status: 500, json: { error: 'Fixture model discovery failed.' } });
    return route.fulfill({
      json: [
        {
          id: 'claude-fixture',
          label: 'Claude fixture model',
          isDefault: true,
          efforts: ['medium', 'high'],
        },
      ],
    });
  });
  page.on('request', (request) => {
    if (
      /\/mcp$|\/usage\/refresh$|\/commands$|\/terminal(?:\?|$)/.test(
        new URL(request.url()).pathname,
      )
    )
      forbiddenRequests++;
  });
  const unknown = {
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningOutputTokens: null,
  };
  await page.route(`**/api/agents/${agent.id}/usage`, (route) =>
    route.fulfill({
      json: {
        projectId: agent.projectId,
        agentId: agent.id,
        asOf: new Date().toISOString(),
        tokenSnapshots: [
          {
            provider: 'claude',
            projectId: agent.projectId,
            agentId: agent.id,
            threadId: randomUUID(),
            turnId: null,
            runId: null,
            modelAtObservation: agent.model,
            modelScope: 'context-only-not-billing',
            total: unknown,
            last: {
              ...unknown,
              inputTokens: 13,
              outputTokens: 7,
              cachedInputTokens: 100,
              cacheWriteInputTokens: 20,
            },
            modelContextWindow: null,
            observedAt: new Date().toISOString(),
            currentContext: true,
            stale: false,
          },
        ],
        quotaSnapshots: [],
        unknownTokenAgentIds: [],
        unknownQuotaAgentIds: [agent.id],
        omitted: { agents: 0, tokenSnapshots: 0, quotaSnapshots: 0 },
        notice: 'Unknown is not zero. No costs are inferred.',
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Stop agent', exact: true })).toBeVisible();
  await expect(page.getByLabel('Steer this turn')).toHaveCount(0);
  await page.locator('.model-button').click();
  await expect(page.locator('.settings-card').getByRole('alert')).toContainText('discovery failed');
  agent.status = 'idle';
  await page.getByRole('button', { name: 'Try loading models again' }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'claude-fixture',
  );
  await expect(page.getByLabel('Web search', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Use installed Codex plugins', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Use built-in image generation', { exact: true })).toHaveCount(0);
  await page.getByText('Provider, usage and assignment', { exact: true }).click();
  const usage = page.getByRole('region', { name: 'Provider and usage', exact: true });
  await expect(usage).toContainText('Last reported turn: 13 input tokens · 7 output tokens');
  await expect(usage.locator('.execution-total')).toContainText('Not reported');
  await usage.getByText('Token details', { exact: true }).click();
  await expect(usage).toContainText('not cumulative conversation totals');
  await expect(
    usage.getByRole('button', { name: 'Refresh reported limits', exact: true }),
  ).toHaveCount(0);
  await usage.getByRole('button', { name: 'Read saved usage again', exact: true }).click();
  await expect(usage).toContainText('Claude account limits are not available');
  expect(forbiddenRequests).toBe(0);
  await page.screenshot({ path: `../../data/managed-claude-${info.project.name}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.locator('.settings-card')).toHaveCount(0);
  expect(savedSettings).toEqual([
    {
      model: 'claude-fixture',
      effort: 'medium',
      permission: agent.permission,
      toolPolicy: 'native',
    },
  ]);
  const composer = page.getByRole('textbox', { name: `Message ${agent.name}`, exact: true });
  await composer.fill('/compact');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Claude manages compaction itself');
  await expect(composer).toHaveValue('/compact');
  expect(forbiddenRequests).toBe(0);
});
