import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { snapshotSchema, workspaceDraftsSchema, type Agent } from '@dock/shared';

async function fixture(page: Page) {
  const state = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const manager = state.agents.find(
    (a) =>
      a.role === 'manager' &&
      state.agents.some((w) => w.projectId === a.projectId && w.role !== 'manager'),
  )!;
  const template = state.agents.find(
    (a) => a.projectId === manager.projectId && a.role !== 'manager',
  )!;
  const requestedAt = '2026-10-01T14:00:00.000Z';
  const worker = (
    name: string,
    status: Agent['status'],
    runStatus?: NonNullable<Agent['latestRun']>['status'],
  ): Agent => ({
    ...template,
    id: randomUUID(),
    name,
    parentId: manager.id,
    nativeRootId: manager.id,
    status,
    scope: 'A saved fixture assignment.',
    checkpoint:
      'The saved checkpoint says a calculation is continuing.\nThis is historical evidence, not current activity.',
    latestRun: runStatus
      ? { id: randomUUID(), status: runStatus, createdAt: requestedAt }
      : undefined,
  });
  const completed = {
    ...worker('Saved worker', 'idle', 'completed'),
    id: template.id,
    nativeRootId: null,
  };
  const running = worker('Running worker', 'running', 'completed');
  const queued = worker('Queued worker', 'idle', 'queued');
  const waiting = worker('Waiting worker', 'waiting', 'completed');
  const stopped = worker('Stopped worker', 'interrupted', 'completed');
  const failed = worker('Failed worker', 'failed', 'completed');
  const idle = worker('Older host worker', 'idle');
  const nested = {
    ...worker('Nested worker', 'idle', 'completed'),
    nativeRootId: completed.id,
    parentId: completed.id,
  };
  const workers = [completed, running, queued, waiting, stopped, failed, idle, nested];
  state.agents = [
    ...state.agents.filter((a) => a.projectId !== manager.projectId || a.role === 'manager'),
    ...workers,
  ];
  const task = state.tasks.find((t) => t.id === template.taskId)!;
  task.status = 'review';
  task.title = 'Fixture task awaiting independent review';
  let snapshotFailure = false;
  let historyFailure = false;
  const modelWrites: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' &&
      /\/(messages|resume|interviews|restore)(?:\/|$)/.test(new URL(request.url()).pathname)
    )
      modelWrites.push(request.url());
  });
  await page.route('**/api/snapshot', (route) =>
    snapshotFailure
      ? route.fulfill({ status: 503, json: { error: 'Fixture refresh unavailable.' } })
      : route.fulfill({ json: state }),
  );
  await page.route(/\/api\/agents\/[^/?]+(?:\?.*)?$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const agent = workers.find((a) => a.id === id);
    if (!agent || route.request().method() !== 'GET') return route.continue();
    if (historyFailure)
      return route.fulfill({ status: 503, json: { error: 'Worker history unavailable.' } });
    return route.fulfill({
      json: {
        agent,
        entries: [
          {
            id: `fixture-${agent.id}`,
            agentId: agent.id,
            runId: null,
            kind: 'assistant',
            title: agent.name,
            text: 'Retained worker finding. The task still needs review.',
            status: 'complete',
            createdAt: requestedAt,
          },
        ],
        runs: [],
        hasMore: false,
      },
    });
  });
  return {
    state,
    manager,
    workers,
    completed,
    running,
    nested,
    modelWrites,
    failSnapshot: (value: boolean) => {
      snapshotFailure = value;
    },
    failHistory: (value: boolean) => {
      historyFailure = value;
    },
  };
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Subagents', exact: true });
const row = (page: Page, agent: Agent) =>
  panel(page).locator(`.worker-card[data-agent="${agent.id}"]`);
const route = (manager: Agent, worker?: Agent) =>
  `#/chat/${manager.id}/subagents${worker ? `/${worker.id}` : ''}`;
async function layout(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({
    path: `../../data/screenshots/subagents/${test.info().project.name}-${name}.png`,
  });
}

test('worker states separate current activity, completed turns and retained task/checkpoint evidence through failed refresh', async ({
  page,
}) => {
  const data = await fixture(page);
  await page.goto(`/${route(data.manager)}`);
  const labels = [
    'Turn completed',
    'Running',
    'Queued',
    'Waiting for input',
    'Stopped',
    'Error',
    'Idle',
    'Turn completed',
  ];
  for (let i = 0; i < data.workers.length; i++)
    await expect(row(page, data.workers[i]!).locator('.worker-state')).toHaveText(labels[i]!);
  const completed = row(page, data.completed);
  await expect(completed).toContainText('Task: Awaiting review');
  await expect(completed).toContainText('Last saved checkpoint · time not recorded');
  await expect(completed.locator('time')).toHaveAttribute(
    'dateTime',
    data.completed.latestRun!.createdAt,
  );
  await expect(completed).toContainText('Last run requested');
  await completed.locator('.worker-checkpoint summary').click();
  await expect(completed.locator('.worker-checkpoint p')).toHaveText(data.completed.checkpoint);
  await layout(page, 'states');
  data.failSnapshot(true);
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(panel(page)).toContainText('Could not refresh worker activity.');
  await expect(row(page, data.running).locator('.worker-state')).toHaveText(
    'Last reported: Running',
  );
  await expect(panel(page).locator('.worker-card')).toHaveCount(data.workers.length);
  data.failSnapshot(false);
  data.running.status = 'idle';
  await panel(page).getByRole('button', { name: 'Retry worker activity', exact: true }).click();
  await expect(row(page, data.running).locator('.worker-state')).toHaveText('Turn completed');
  await page.reload();
  await expect(panel(page)).toBeVisible();
  await expect(row(page, data.running).locator('.worker-state')).toHaveText('Turn completed');
  expect(data.modelWrites).toEqual([]);
});

test('worker navigation returns to manager Subagents through browser Back, reload and read failure without losing the manager draft', async ({
  page,
}) => {
  const data = await fixture(page);
  await page.goto(`/#/chat/${data.manager.id}`);
  const draft = 'Unsent fixture draft 🧪 café 漢字';
  const editor = page.locator('.composer textarea');
  // Establish a ready draft and actual typing before testing navigation retention.
  await expect(page.locator('.composer [data-draft]')).toHaveAttribute('data-draft', 'saved');
  await editor.fill(draft);
  await expect(editor).toHaveValue(draft);
  expect(
    await page.evaluate(
      (id) => JSON.parse(localStorage.getItem(`dock:local:workspace:draft:${id}`)!).text,
      data.manager.id,
    ),
  ).toBe(draft);
  await page.getByRole('button', { name: 'Subagents', exact: true }).click();
  await row(page, data.completed)
    .getByRole('link', { name: 'Open activity', exact: false })
    .click();
  await expect(page).toHaveURL(new RegExp(`${route(data.manager, data.completed)}$`));
  await expect(
    page.getByText('Retained worker finding. The task still needs review.', { exact: true }),
  ).toBeVisible();
  const activity = page.locator('.chat-worker-heading .worker-state');
  await expect(activity).toHaveText('Turn completed');
  await expect(activity).toBeVisible();
  const bounds = await activity.boundingBox();
  expect(bounds?.width).toBeGreaterThan(80);
  expect(bounds && bounds.x + bounds.width <= (page.viewportSize()?.width ?? 0)).toBe(true);
  const returnLink = page.getByRole('link', { name: 'Back to manager', exact: true });
  await expect(returnLink).toBeVisible();
  await layout(page, 'worker-return');
  await page.goBack();
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(editor).toHaveValue(draft);
  await page.getByRole('button', { name: 'Subagents', exact: true }).click();
  await row(page, data.completed)
    .getByRole('link', { name: 'Open activity', exact: false })
    .click();
  await page.reload();
  // The same manager ownership is in the route even when the in-memory panel state was lost.
  await page.locator('a.home-back').evaluate((node) => (node as HTMLElement).click());
  await expect(panel(page)).toBeVisible();
  await row(page, data.completed)
    .getByRole('link', { name: 'Open activity', exact: false })
    .click();
  data.failHistory(true);
  await page.reload();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Worker history unavailable.' }),
  ).toBeVisible();
  await expect(returnLink).toBeVisible();
  await returnLink.click();
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(editor).toHaveValue(draft);
  expect(data.modelWrites).toEqual([]);
});

test('an initial draft read preserves owner typing entered before its response', async ({
  page,
}) => {
  const data = await fixture(page);
  let release!: () => void;
  let observed!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (observed = resolve));
  const path = `/api/workspace/`;
  const suffix = `/drafts/${data.manager.id}`;
  const initialRead = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname.startsWith(path) &&
      new URL(response.url()).pathname.endsWith(suffix),
  );
  let first = true;
  await page.route(`**${path}*${suffix}`, async (route) => {
    if (first && route.request().method() === 'GET') {
      first = false;
      const response = await route.fetch();
      observed();
      await held;
      await route.fulfill({ response });
    } else await route.continue();
  });
  const draft = 'Typed before the initial draft read 🧪 café 漢字';
  const editor = page.locator('.composer textarea');
  try {
    await page.goto(`/#/chat/${data.manager.id}`);
    await started;
    await expect(page.locator('.composer [data-draft]')).toHaveAttribute(
      'data-draft',
      'connecting',
    );
    await editor.fill(draft);
    await expect(editor).toHaveValue(draft);
    expect(
      await page.evaluate(
        (id) => JSON.parse(localStorage.getItem(`dock:local:workspace:draft:${id}`)!).text,
        data.manager.id,
      ),
    ).toBe(draft);
  } finally {
    release();
  }
  expect(workspaceDraftsSchema.parse(await (await initialRead).json()).own.text).toBe('');
  await expect(page.locator('.composer [data-draft]')).not.toHaveAttribute(
    'data-draft',
    'connecting',
  );
  await expect(editor).toHaveValue(draft);
  expect(data.modelWrites).toEqual([]);
});

test('an existing direct worker route follows nested ownership back to the manager', async ({
  page,
}) => {
  const data = await fixture(page);
  await page.goto(`/#/chat/${data.nested.id}`);
  const back = page.getByRole('link', { name: 'Back to manager', exact: true });
  await expect(back).toHaveAttribute('href', route(data.manager));
  await back.click();
  await expect(panel(page)).toBeVisible();
  await expect(row(page, data.nested).locator('.worker-state')).toHaveText('Turn completed');
  expect(data.modelWrites).toEqual([]);
});
