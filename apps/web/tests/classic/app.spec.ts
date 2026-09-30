import { test, expect, type BrowserContext } from './fixture';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../../../server/dist/store.js';

async function drainRoutes(context: BrowserContext) {
  // Polling can leave route.fetch()/response.json() in flight after the last UI
  // assertion. Finish those handlers before Playwright disposes their responses.
  // 'wait' preserves errors; 'ignoreErrors' would hide genuine fixture failures.
  await Promise.all(context.pages().map((page) => page.unrouteAll({ behavior: 'wait' })));
  await context.unrouteAll({ behavior: 'wait' });
}

test.afterEach(async ({ context }) => drainRoutes(context));

test('routed response cleanup waits for pending JSON reads without disposing their context', async ({
  page,
  context,
}) => {
  let entered!: () => void, release!: () => void;
  const responseFetched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const allowRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;
  await page.route('**/api/host-info', async (route) => {
    const response = await route.fetch();
    entered();
    await allowRead;
    const body = await response.json();
    expect(body).toMatchObject({ hostId: expect.any(String), protocolVersion: 1 });
    await route.fulfill({ response, json: body });
    completed = true;
  });
  try {
    await page.goto('/');
    await page.evaluate(() => {
      void fetch('/api/host-info');
    });
    await responseFetched;
    const draining = drainRoutes(context);
    expect(completed).toBe(false);
    release();
    await draining;
    expect(completed).toBe(true);
  } finally {
    release();
  }
});

test('create a project entirely in the app, keeping a retry safe after a lost response and reload', async ({
  page,
}, testInfo) => {
  // Force the first-run state while retaining the real production creation endpoint.
  let created = false;
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    if (created) return route.fulfill({ response });
    const state = await response.json();
    await route.fulfill({
      response,
      json: { ...state, projects: [], agents: [], tasks: [], approvals: [], decisions: [] },
    });
  });
  let attempt = 0;
  const keys: string[] = [];
  await page.route('**/api/projects', async (route) => {
    keys.push(route.request().postDataJSON().key);
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    if (++attempt === 1) return route.abort('failed'); // Server succeeded; the browser did not see it.
    created = true;
    await route.fulfill({ response });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create your first project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a project' });
  await expect(dialog).not.toContainText(/pnpm|Git repository|\/path\//);
  await expect(dialog.getByRole('button', { name: 'Create project', exact: true })).toBeDisabled();
  const name = `Garden ${testInfo.project.name} ${Date.now()}`;
  await page.getByLabel('Project name', { exact: true }).fill(name);
  await page
    .getByLabel('What would you like to do?', { exact: false })
    .fill('Help me keep a garden journal.');
  await page.screenshot({
    path: `../../data/screenshots/${testInfo.project.name}-project-create.png`,
  });
  await expect(
    dialog.getByRole('button', { name: 'Create project', exact: true }),
  ).toBeInViewport();
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your details are saved');
  await page.reload();
  await page.getByRole('button', { name: 'Create your first project', exact: true }).click();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(name);
  await expect(page.getByLabel('What would you like to do?', { exact: false })).toHaveValue(
    'Help me keep a garden journal.',
  );
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: `${name} manager`, exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  const state = await (await page.request.get('/api/snapshot')).json();
  expect(state.projects.filter((project: { name: string }) => project.name === name)).toHaveLength(
    1,
  );
  const project = state.projects.find((project: { name: string }) => project.name === name);
  const detail = await (await page.request.get(`/api/agents/${project.managerId}`)).json();
  expect(detail.runs).toHaveLength(0);
  expect(detail.entries).toHaveLength(0);
  await expect(page.getByRole('textbox', { name: `Message ${name} manager` })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: `${name} manager`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('dock:project-draft'))).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('existing-folder selection has visible actions, safe cancellation and an in-app handoff', async ({
  page,
}, testInfo) => {
  await page.route('**/api/project-options', (route) =>
    route.fulfill({ json: { canChooseFolder: true } }),
  );
  const state = await (await page.request.get('/api/snapshot')).json();
  const project = state.projects[0];
  const manager = state.agents.find((agent: { id: string }) => agent.id === project.managerId);
  let attempts = 0;
  const keys: string[] = [];
  await page.route('**/api/projects/connect-folder', async (route) => {
    const input = route.request().postDataJSON();
    expect(Object.keys(input)).toEqual(['key']); // Never a browser-provided path.
    keys.push(input.key);
    await route.fulfill({ json: { project: ++attempts === 1 ? null : project } });
  });
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Add a project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a project' });
  const folder = dialog.getByRole('button', { name: 'Use an existing project folder' });
  await expect(folder).toBeInViewport();
  await expect(
    dialog.getByRole('button', { name: 'Create project', exact: true }),
  ).toBeInViewport();
  await page.getByLabel('Project name', { exact: true }).fill('Keep my other idea');
  await page.screenshot({
    path: `../../data/screenshots/${testInfo.project.name}-project-folder.png`,
  });
  await folder.click();
  await expect(folder).toBeEnabled();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Keep my other idea');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await folder.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: manager.name, exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
  expect(
    JSON.parse((await page.evaluate(() => localStorage.getItem('dock:project-draft'))) || '{}')
      .name,
  ).toBe('Keep my other idea');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('native controls remain available and a failed return to chat explains how to retry', async ({
  page,
}) => {
  // UI-only fixture: never attach a real CLI or start a provider during this check.
  await page.routeWebSocket('**/api/agents/*/terminal', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }));
  });
  let attempts = 0;
  await page.route('**/api/agents/*/terminal/close', (route) =>
    ++attempts === 1 ? route.abort('failed') : route.fulfill({ json: { ok: true } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Native terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Native Codex help', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'Native Codex help' });
  await expect(help).toContainText('/skills or $');
  await expect(help).toContainText('/plugins');
  await expect(help).toContainText('/mcp');
  await help.getByRole('button', { name: 'Close dialog' }).click();
  for (const label of ['Esc', 'Tab', '↑', '↓', 'Ctrl C', 'Enter'])
    await expect(
      page.locator('.terminal-keys').getByRole('button', { name: label, exact: true }),
    ).toBeVisible();
  await page.getByRole('button', { name: 'Return to chat', exact: true }).click();
  await expect(page.locator('.terminal-pane').getByRole('alert')).toContainText('try again');
  await expect(page.locator('.terminal-pane').getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Return to chat', exact: true }).click();
  await expect(page.locator('.terminal-pane')).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: 'Message Fieldnotes manager', exact: true }),
  ).toBeVisible();
});

test('getting started explains the normal workflow without terminal commands', async ({ page }) => {
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Getting started' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Write the way you’d talk to a person');
  await expect(dialog).not.toContainText(/pnpm|Git repository|\/path\//);
  await dialog.getByRole('button', { name: 'Create a project' }).click();
  await expect(page.getByRole('dialog', { name: 'Create a project' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('generated images render with agent-scoped download links after reload', async ({ page }) => {
  const imageId = '00000000-0000-4000-8000-400000000001';
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
    'base64',
  );
  await page.route('**/api/agents/*', async (route) => {
    const response = await route.fetch(),
      detail = await response.json();
    if (detail.agent?.name === 'Draft persistence')
      detail.entries.push({
        id: 'image-fixture',
        agentId: detail.agent.id,
        runId: null,
        kind: 'tool',
        title: 'Generated image',
        text: 'A harmless image <img src="https://example.invalid/never-fetch">',
        status: 'complete',
        createdAt: new Date().toISOString(),
        image: { id: imageId, mimeType: 'image/png', byteLength: png.length, width: 1, height: 1 },
      });
    await route.fulfill({ response, json: detail });
  });
  await page.route(`**/api/agents/*/images/${imageId}`, (route) =>
    route.fulfill({ contentType: 'image/png', body: png }),
  );
  await page.goto('/');
  if (page.viewportSize()!.width < 1191)
    await page.getByRole('button', { name: 'Open team' }).click();
  await page.getByRole('button', { name: /Draft persistence Builder/ }).click();
  await page.reload();
  const image = page.getByRole('img', { name: 'Generated image', exact: true });
  await image.scrollIntoViewIfNeeded();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
  await page.getByText('Generation prompt', { exact: true }).click();
  await expect(page.locator('.generated-image')).toContainText(
    '<img src="https://example.invalid/never-fetch">',
  );
  await expect(page.locator('.generated-image img')).toHaveCount(1);
  // This response stub checks previews and link wiring. Actual download completion
  // is covered against the running server by smoke-image-generation.mjs.
  const download = page.getByRole('link', { name: 'Download PNG', exact: true });
  await expect(download).toHaveAttribute('download', `generated-${imageId}.png`);
  await expect(download).toHaveAttribute(
    'href',
    new RegExp(`/api/agents/[a-f0-9-]+/images/${imageId}$`),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('MCP URLs need explicit opening and a separate decision, with retained owner links', async ({
  page,
}, testInfo) => {
  let decision: string | undefined,
    visits = 0,
    workerId = '';
  const approvalId = '00000000-0000-4000-8000-300000000002';
  const urlRequest = {
    serverName: 'example-fixture',
    url: 'https://example.invalid/continue?state=fixture%2Btoken',
  };
  await page.context().route('https://example.invalid/**', async (route) => {
    visits++;
    expect(route.request().headers().referer).toBeUndefined();
    await route.fulfill({
      contentType: 'text/html',
      body: '<h1>Local test of requested destination</h1>',
    });
  });
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch(),
      state = await response.json();
    workerId = state.agents.find(
      (agent: { name: string }) => agent.name === 'Draft persistence',
    ).id;
    await route.fulfill({
      response,
      json: {
        ...state,
        approvals: decision
          ? []
          : [
              {
                id: approvalId,
                agentId: workerId,
                kind: 'mcp_url',
                status: 'pending',
                title: 'Continue fixture setup',
                details: 'Demonstration only',
                questions: [],
                createdAt: new Date().toISOString(),
                urlRequest,
              },
            ],
      },
    });
  });
  await page.route('**/api/agents/*', async (route) => {
    const response = await route.fetch(),
      detail = await response.json();
    if (detail.agent?.id === workerId && decision === 'accept')
      detail.entries.push({
        id: 'fixture-url-entry',
        agentId: workerId,
        runId: null,
        kind: 'system',
        title: 'URL request allowed',
        text: 'Permission recorded, not successful sign-in or completion.',
        status: 'accepted',
        createdAt: new Date().toISOString(),
        urlRequest,
      });
    await route.fulfill({ response, json: detail });
  });
  await page.route(`**/api/approvals/${approvalId}`, async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ decision: body.decision, answers: {} });
    decision = body.decision;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  if (page.viewportSize()!.width < 1191)
    await page.getByRole('button', { name: 'Open team' }).click();
  await page.getByRole('button', { name: /Draft persistence Builder/ }).click();
  await expect(page.getByRole('heading', { name: 'Continue fixture setup' })).toBeVisible();
  await page.reload();
  const card = page.locator('.approval-card');
  await expect(card.getByText('example-fixture', { exact: true })).toBeVisible();
  await expect(card.getByText('https://example.invalid', { exact: true })).toBeVisible();
  const link = card.getByRole('link', { name: 'Open requested page' });
  await expect(link).toHaveAttribute('href', urlRequest.url);
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(visits).toBe(0);
  expect(decision).toBeUndefined();
  await card.getByText('https://example.invalid', { exact: true }).scrollIntoViewIfNeeded();
  await expect(card.getByText('https://example.invalid', { exact: true })).toBeInViewport();
  await page.screenshot({
    path: `../../data/screenshots/${testInfo.project.name}-mcp-url.png`,
    fullPage: true,
  });
  await card.getByText('Inspect the full URL', { exact: true }).click();
  await expect(card.getByText(urlRequest.url, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const popupPromise = page.waitForEvent('popup');
  await link.click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading')).toHaveText('Local test of requested destination');
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  expect(await popup.evaluate(() => document.referrer)).toBe('');
  expect(visits).toBe(1);
  expect(decision).toBeUndefined();
  await popup.close();
  await card.getByRole('button', { name: 'Allow URL request' }).click();
  await expect(card).toHaveCount(0);
  expect(decision).toBe('accept');
  await page.reload();
  await expect(page.getByText('URL request allowed', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open requested page' })).toHaveAttribute(
    'href',
    urlRequest.url,
  );
  expect(visits).toBe(1);
  decision = undefined;
  await page.reload();
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(decision).toBe('decline');
  expect(visits).toBe(1);
});

test('MCP forms retain the pending request across reload and submit typed choices explicitly', async ({
  page,
}, testInfo) => {
  let submitted: unknown, decision: string | undefined;
  const approvalId = '00000000-0000-4000-8000-300000000001';
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch(),
      state = await response.json();
    const worker = state.agents.find(
      (agent: { name: string }) => agent.name === 'Draft persistence',
    );
    await route.fulfill({
      response,
      json: {
        ...state,
        approvals: decision
          ? []
          : [
              {
                id: approvalId,
                agentId: worker.id,
                kind: 'mcp_form',
                status: 'pending',
                title: 'Example MCP preferences',
                details: 'Demonstration form; no external tool or model call.',
                questions: [],
                createdAt: new Date().toISOString(),
                form: {
                  serverName: 'example-fixture',
                  message: 'Example MCP preferences',
                  requestedSchema: {
                    type: 'object',
                    required: ['name', 'count', 'enabled', 'theme', 'channels'],
                    properties: {
                      name: { type: 'string', title: 'Display name', minLength: 2 },
                      count: { type: 'integer', title: 'Result count', minimum: 0, maximum: 4 },
                      enabled: { type: 'boolean', title: 'Include details' },
                      theme: {
                        type: 'string',
                        title: 'Theme',
                        oneOf: [
                          { const: '', title: 'No theme' },
                          { const: 'dark', title: 'Dark' },
                        ],
                      },
                      channels: {
                        type: 'array',
                        title: 'Channels',
                        minItems: 1,
                        items: {
                          anyOf: [
                            { const: 'web', title: 'Web' },
                            { const: 'cli', title: 'Terminal' },
                          ],
                        },
                      },
                      note: { type: 'string', title: 'Optional note' },
                    },
                  },
                },
              },
            ],
      },
    });
  });
  await page.route(`**/api/approvals/${approvalId}`, async (route) => {
    const body = route.request().postDataJSON();
    submitted = body.formValues;
    decision = body.decision;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  if (page.viewportSize()!.width < 1191)
    await page.getByRole('button', { name: 'Open team' }).click();
  await page.getByRole('button', { name: /Draft persistence Builder/ }).click();
  await expect(page.getByRole('heading', { name: 'Example MCP preferences' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Submit form', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'an answer is required' })).toBeVisible();
  expect(decision).toBeUndefined();
  await page.getByRole('textbox', { name: 'Display name' }).fill('Fixture');
  await page.getByRole('spinbutton', { name: 'Result count' }).fill('0');
  await page.getByRole('combobox', { name: 'Include details' }).selectOption({ label: 'No' });
  await page.getByRole('combobox', { name: 'Theme' }).selectOption({ label: 'No theme' });
  await page.getByRole('checkbox', { name: 'Web', exact: true }).check();
  await expect(page.getByText('Do not enter passwords', { exact: false })).toBeVisible();
  await page.screenshot({
    path: `../../data/screenshots/${testInfo.project.name}-mcp-form.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Submit form', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Example MCP preferences' })).toHaveCount(0);
  expect(decision).toBe('accept');
  expect(submitted).toEqual({
    name: 'Fixture',
    count: 0,
    enabled: false,
    theme: '',
    channels: ['web'],
  });
  decision = undefined;
  await page.reload();
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Example MCP preferences' })).toHaveCount(0);
  expect(decision).toBe('decline');
  expect(submitted).toBeUndefined();
});

test('completed results are distinct from code awaiting exact integration after reload', async ({
  page,
}, testInfo) => {
  let previewRequests = 0;
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch(),
      state = await response.json();
    const task = state.tasks.find(
      (t: { title: string }) => t.title === 'Keep drafts across reloads',
    );
    const examples = [
      ['Example completed research', 'done', false],
      ['Example completed plan', 'done', false],
      ['Example reviewed code', 'done', true],
      ['Example integrated code', 'integrated', true],
    ];
    await route.fulfill({
      response,
      json: {
        ...state,
        tasks: examples.map(([title, status, hasReviewedChanges], index) => ({
          ...task,
          id: `00000000-0000-4000-8000-20000000000${index + 1}`,
          title,
          status,
          hasReviewedChanges,
          goal: 'Demonstration task result for the workboard presentation check.',
          acceptance: 'The recorded result is visible and only reviewed code offers integration.',
        })),
      },
    });
  });
  await page.route('**/api/tasks/*/integration', async (route) => {
    previewRequests++;
    expect(route.request().url()).toContain('200000000003/integration');
    await route.fulfill({
      json: {
        taskId: '00000000-0000-4000-8000-200000000003',
        source: 'reviewed-example-commit',
        target: 'current-example-commit',
        changes: 'Example reviewed change',
      },
    });
  });
  await page.goto('/');
  const card = (title: string) =>
    page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await page.getByRole('button', { name: /Workboard/ }).click();
    for (const title of ['Example completed research', 'Example completed plan']) {
      await expect(card(title).getByText('Completed', { exact: true })).toBeVisible();
      await expect(
        card(title).getByRole('button', { name: 'Apply changes', exact: true }),
      ).toHaveCount(0);
    }
    await expect(
      card('Example reviewed code').getByText('Ready to apply', { exact: true }),
    ).toBeVisible();
    await expect(
      card('Example reviewed code').getByRole('button', { name: 'Apply changes', exact: true }),
    ).toBeVisible();
    await expect(
      card('Example integrated code').getByText('Changes applied', { exact: true }),
    ).toBeVisible();
    await expect(
      card('Example integrated code').getByRole('button', { name: 'Apply changes', exact: true }),
    ).toHaveCount(0);
  }
  expect(previewRequests).toBe(0);
  await card('Example reviewed code')
    .getByRole('button', { name: 'Apply changes', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('Example reviewed change');
  await expect(
    page.getByRole('button', { name: 'Confirm and apply changes', exact: true }),
  ).toBeVisible();
  expect(previewRequests).toBe(1);
  const dialog = page.getByRole('dialog', { name: 'Apply reviewed changes' });
  await expect(dialog).toContainText('Nothing is applied until you confirm');
  await dialog.getByText('Technical details: exact saved versions', { exact: true }).click();
  await expect(dialog).toContainText('reviewed-example-commit');
  await expect(dialog).toContainText('current-example-commit');
  const confirmations: unknown[] = [];
  await page.route('**/api/tasks/*/integrate', async (route) => {
    confirmations.push(route.request().postDataJSON());
    await route.fulfill({
      status: 409,
      json: { error: 'The project changed. Review its latest changes before trying again.' },
    });
  });
  await dialog.getByRole('button', { name: 'Confirm and apply changes' }).click();
  await expect(dialog.getByRole('alert')).toContainText('The project changed');
  await dialog.getByRole('alert').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `../../data/screenshots/${testInfo.project.name}-apply-error.png`,
  });
  await dialog.getByRole('button', { name: 'Confirm and apply changes' }).click();
  await expect.poll(() => confirmations.length).toBe(2);
  expect(confirmations[1]).toEqual(confirmations[0]); // Same exact preview and retry ID.
  expect(confirmations[0]).toMatchObject({
    source: 'reviewed-example-commit',
    target: 'current-example-commit',
  });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/screenshots/${testInfo.project.name}-completed-results.png`,
    fullPage: true,
  });
  // The workboard scrolls inside the shell, so fullPage alone can miss earlier cards.
  await card('Example completed research').screenshot({
    path: `../../data/screenshots/${testInfo.project.name}-completed-research-card.png`,
  });
  await card('Example reviewed code').screenshot({
    path: `../../data/screenshots/${testInfo.project.name}-awaiting-integration-card.png`,
  });
});

test('native children show their own retained history and return to their controlling parent', async ({
  page,
}, testInfo) => {
  // Seed the explicit demo fixture, not an invented snapshot-only child. The real
  // workspace validator and reload must see the same retained child identity.
  const state = await (await page.request.get('/api/snapshot')).json();
  expect(state.provider.version).toBe('demo');
  const parent = state.agents.find((agent: { name: string }) => agent.name === 'Draft persistence');
  const fixtureRoot = resolve(process.env.DOCK_E2E_DATA_DIR ?? '../../data/browser-data/classic');
  const database = join(fixtureRoot, 'demo', 'dock.sqlite');
  expect(existsSync(database)).toBe(true);
  const store = new Store(database);
  const childId = randomUUID();
  const childName = `Native evidence helper ${testInfo.project.name} ${childId.slice(0, 8)}`;
  try {
    const savedParent = store.agent(parent.id);
    expect(savedParent.name).toBe('Draft persistence');
    expect(store.project(savedParent.projectId).name).toBe('Fieldnotes');
    store.transaction(() => {
      store.addAgent({
        id: childId,
        projectId: savedParent.projectId,
        parentId: savedParent.id,
        taskId: savedParent.taskId,
        role: savedParent.role,
        cwd: savedParent.cwd,
        name: childName,
      });
      store.updateAgent(childId, {
        nativeRootId: savedParent.id,
        nativePath: '/root/evidence_helper',
        status: 'idle',
        checkpoint: 'Example child checkpoint',
      });
      store.entry({
        id: `example-child-answer:${childId}`,
        agentId: childId,
        runId: null,
        kind: 'assistant',
        title: childName,
        text: 'Example native child evidence, retained separately.',
        status: 'complete',
        createdAt: new Date().toISOString(),
      });
    });
  } finally {
    store.close();
  }
  await page.goto('/');
  if (page.viewportSize()!.width < 1191)
    await page.getByRole('button', { name: 'Open team' }).click();
  await page
    .getByRole('button', { name: new RegExp(`${childName} Native child of Draft persistence`) })
    .click();
  await expect(page.getByRole('heading', { name: childName, exact: true })).toBeVisible();
  await expect(
    page.getByText('Example native child evidence, retained separately.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: `Message ${childName}` })).toHaveCount(0);
  await expect(
    page.getByText('Codex does not expose all delegated prompt text.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Parent terminal', exact: true })).toBeVisible();
  await page.screenshot({
    path: `../../data/screenshots/${testInfo.project.name}-native-child.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect
    .poll(async () => {
      const clientId = await page.evaluate(() =>
        localStorage.getItem('dock:local:workspace:client'),
      );
      if (!clientId) return null;
      const workspace = await (await page.request.get(`/api/workspace/${clientId}`)).json();
      return workspace.client.selectedAgentId;
    })
    .toBe(childId);
  await page.reload();
  await expect(page.getByRole('heading', { name: childName, exact: true })).toBeVisible();
  await expect(
    page.getByText('Example native child evidence, retained separately.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open parent conversation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Draft persistence', exact: true })).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Message Draft persistence', exact: true }),
  ).toBeVisible();
});

test('worker web search, MCP and plugin selection persist without enabling tools for managers', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  if (page.viewportSize()!.width < 1191)
    await page.getByRole('button', { name: 'Open team' }).click();
  await page.getByRole('button', { name: /Draft persistence Builder/ }).click();
  await page.locator('.model-button').click();
  const selected = page.getByRole('checkbox', { name: 'demo_docs', exact: true });
  await selected.check();
  const plugins = page.getByRole('checkbox', { name: 'Use installed Codex plugins', exact: true });
  await plugins.check();
  const webSearch = page.getByRole('combobox', { name: 'Web search', exact: true });
  await webSearch.selectOption('indexed');
  await expect(webSearch.locator('option')).toHaveCount(4);
  const images = page.getByRole('checkbox', { name: 'Use built-in image generation', exact: true });
  await images.check();
  await expect(
    page.getByText('Every MCP tool call requires approval.', { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: `../../data/screenshots/${testInfo.project.name}-mcp-settings.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.locator('.settings-card')).toHaveCount(0);
  await page.reload();
  await page.locator('.model-button').click();
  await expect(selected).toBeChecked();
  await expect(plugins).toBeChecked();
  await expect(webSearch).toHaveValue('indexed');
  await expect(images).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  if (page.viewportSize()!.width < 1191)
    await page.getByRole('button', { name: 'Open team' }).click();
  await page.getByRole('button', { name: /Fieldnotes manager Manager/ }).click();
  await page.locator('.model-button').click();
  await expect(page.getByRole('group', { name: 'MCP tools for this worker' })).toHaveCount(0);
  await expect(plugins).toHaveCount(0);
  await expect(webSearch).toHaveCount(0);
  await expect(images).toHaveCount(0);
});

test('saved sessions can be discovered and imported without starting work', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Fieldnotes manager' })).toBeVisible();
  if (page.viewportSize()!.width < 1191)
    await page.getByRole('button', { name: 'Open team' }).click();
  await page.getByRole('button', { name: 'Existing Codex sessions', exact: true }).click();
  const name = `Saved ${testInfo.project.name} session`;
  const row = page.getByRole('dialog').getByRole('button', { name: new RegExp(name) });
  const importedBefore = (await row.textContent())?.includes('Already in sciencewithagents');
  await row.click();
  if (!importedBefore) {
    await expect(page.getByRole('button', { name: 'Import history', exact: true })).toBeDisabled();
    await page
      .getByRole('checkbox', {
        name: 'I have stopped this conversation in its original Codex window.',
      })
      .check();
    await page.screenshot({
      path: `../../data/screenshots/${testInfo.project.name}-session-import.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Import history', exact: true }).click();
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByText('Example historical question', { exact: true })).toBeVisible();
  await expect(page.getByText('Example saved answer.', { exact: false })).toBeVisible();
  await expect(page.locator('.channel-title')).toContainText('Ready');
  await page.reload();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByText('Example historical question', { exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('module managers retain separate conversations and own the selected tasks', async ({
  page,
}, testInfo) => {
  const managerKeys: string[] = [],
    taskKeys: string[] = [];
  for (const [suffix, keys] of [
    ['managers', managerKeys],
    ['tasks', taskKeys],
  ] as const) {
    await page.route(`**/api/projects/*/${suffix}`, async (route) => {
      keys.push(route.request().postDataJSON().key);
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      if (keys.length === 1) return route.abort('failed'); // Acknowledgement lost after saving.
      await route.fulfill({ response });
    });
  }
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Fieldnotes manager' })).toBeVisible();
  if (page.viewportSize()!.width < 1191)
    await page.getByRole('button', { name: 'Open team' }).click();
  await page.getByRole('button', { name: 'Add module manager', exact: true }).click();
  const name = `Interface ${testInfo.project.name} ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Manager name', exact: true }).fill(name);
  await page
    .getByRole('textbox', { name: 'Area of responsibility' })
    .fill('Web interface and mobile layout.');
  await page.getByRole('button', { name: 'Create manager', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'Your details are still here',
  );
  await expect(page.getByRole('textbox', { name: 'Manager name', exact: true })).toHaveValue(name);
  await page.getByRole('button', { name: 'Check manager request', exact: true }).click();
  expect(managerKeys).toHaveLength(2);
  expect(managerKeys[1]).toBe(managerKeys[0]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const message = 'Keep this module conversation separate.';
  await page.getByRole('textbox', { name: `Message ${name}`, exact: true }).fill(message);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message-body').getByText(message, { exact: true })).toBeVisible();
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: /Workboard/ }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(page.getByLabel('Responsible manager')).toHaveValue(
    (await page
      .getByLabel('Responsible manager')
      .locator('option', { hasText: name })
      .getAttribute('value')) ?? '',
  );
  await page.getByRole('textbox', { name: 'Task name', exact: true }).fill(`Layout ${name}`);
  await page
    .getByRole('textbox', { name: 'What should change?' })
    .fill('One mobile layout improvement.');
  await page
    .getByRole('textbox', { name: 'How will we know it works?' })
    .fill('No horizontal overflow.');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'Your details are still here',
  );
  await expect(page.getByRole('textbox', { name: 'Task name', exact: true })).toHaveValue(
    `Layout ${name}`,
  );
  await page.getByRole('button', { name: 'Check task request', exact: true }).click();
  expect(taskKeys).toHaveLength(2);
  expect(taskKeys[1]).toBe(taskKeys[0]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const saved = await (await page.request.get('/api/snapshot')).json();
  expect(saved.agents.filter((agent: { name: string }) => agent.name === name)).toHaveLength(1);
  expect(
    saved.tasks.filter((task: { title: string }) => task.title === `Layout ${name}`),
  ).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.locator('.message-body').getByText(message, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Workboard/ }).click();
  const card = page
    .locator('.task-card')
    .filter({ has: page.getByRole('heading', { name: `Layout ${name}`, exact: true }) });
  await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/screenshots/${testInfo.project.name}-module-managers.png`,
    fullPage: true,
  });
  if (page.viewportSize()!.width < 1191)
    await page.getByRole('button', { name: 'Open team' }).click();
  await page.getByRole('button', { name: /Fieldnotes manager Manager/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Fieldnotes manager', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.message-body').getByText(message, { exact: true })).toHaveCount(0);
});

test('chat survives reload and recovers the draft without a model call', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Fieldnotes manager' })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message Fieldnotes manager' });
  const message = `A durable test message ${testInfo.project.name} ${Date.now()}`;
  await composer.fill(message);
  await page.reload();
  await expect(composer).toHaveValue(message);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message-body').getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByText('Your message is saved.', { exact: false }).last()).toBeVisible();
  await page.reload();
  await expect(page.locator('.message-body').getByText(message, { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('');
  const size = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: innerWidth,
  }));
  expect(size.scroll).toBeLessThanOrEqual(size.width);
  const rect = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  if (page.viewportSize()!.width <= 720)
    expect(
      await composer.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(16);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: `../../data/screenshots/${testInfo.project.name}-conversation.png`,
    fullPage: true,
  });
});

test('team conversations, workboard and setup are usable at this viewport', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Fieldnotes manager' })).toBeVisible();
  if (page.viewportSize()!.width < 1191)
    await page.getByRole('button', { name: 'Open team' }).click();
  await page.getByRole('button', { name: /Draft persistence Builder/ }).click();
  await expect(page.getByRole('heading', { name: 'Draft persistence', exact: true })).toBeVisible();
  await expect(page.getByText('Example implementation report:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: /Workboard/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Keep drafts across reloads' }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'View changes' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  const size = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: innerWidth,
  }));
  expect(size.scroll).toBeLessThanOrEqual(size.width);
  await page.screenshot({
    path: `../../data/screenshots/${testInfo.project.name}-workboard.png`,
    fullPage: true,
  });
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Add a project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Create a project' })).toBeVisible();
  await expect(page.getByLabel('Project name', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).not.toContainText('pnpm');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('slash command errors retain the draft and export returns this agent history', async ({
  page,
}) => {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message Fieldnotes manager' });
  await composer.fill('/unsupported-command');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Native terminal');
  await expect(composer).toHaveValue('/unsupported-command');
  await page.getByRole('button', { name: 'Show commands', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export conversation' }).click();
  expect((await download).suggestedFilename()).toMatch(/^agent-.*\.json$/);
  await composer.fill('');
});
