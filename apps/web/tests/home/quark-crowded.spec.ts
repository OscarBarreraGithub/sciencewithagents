import { expect, test, type Page } from '@playwright/test';

/** 30 projects and 40 queued tasks, routed over the demo snapshot. No model turn starts. */
async function crowd(page: Page) {
  const state = await (await page.request.get('/api/snapshot')).json();
  const coordinator = await (await page.request.get('/api/quark/coordinator')).json();
  const template = state.projects.find((p: { internal?: boolean }) => !p.internal);
  const manager = state.agents.find((a: { id: string }) => a.id === template.managerId);
  const task = state.tasks.find((t: { projectId: string }) => t.projectId === template.id);
  const projects = Array.from({ length: 30 }, (_, i) => ({
    ...template,
    id: crypto.randomUUID(),
    managerId: crypto.randomUUID(),
    name: i ? `Crowded project ${i + 1}` : 'UnbrokenProjectNameWithoutAnySpaces'.repeat(3),
  }));
  const tasks = Array.from({ length: 41 }, (_, i) => ({
    ...task,
    id: crypto.randomUUID(),
    projectId: projects[i % 30]!.id,
    title: `Crowded task ${i + 1}`,
    status: i === 40 ? 'done' : 'open',
    closure: i === 40 ? { reason: 'Finished', closedAt: new Date().toISOString() } : undefined,
  }));
  state.projects = [
    ...state.projects.filter((p: { internal?: boolean }) => p.internal),
    ...projects,
  ];
  state.agents = projects.map((p) => ({ ...manager, id: p.managerId, projectId: p.id }));
  state.tasks = tasks;
  coordinator.agentId = null;
  coordinator.localJobs = [];
  coordinator.projects = projects.map((p) => ({
    id: p.id,
    name: p.name,
    managerId: p.managerId,
    policy: { revision: 0, priority: null, weight: 1, paused: false, instruction: '' },
  }));
  coordinator.queue.jobs = tasks.slice(0, 40).map((t, i) => ({
    runId: crypto.randomUUID(),
    agentId: projects[i % 30]!.managerId,
    taskId: t.id,
    projectName: projects[i % 30]!.name,
    agentName: 'Fixture manager',
    provider: 'codex',
    status: 'queued',
    estimate: { ...task.scheduling },
    held: false,
    override: false,
    reason: 'Waiting for a turn under the shared reserve.',
    eligible: false,
    expectedFinishAt: null,
    tokensCharged: 0,
    tokenBasis: 'none',
  }));
  coordinator.queue.history = [];
  const budget = (projectId: string, taskId: string | null, limitPercent: number) => ({
    id: crypto.randomUUID(),
    projectId,
    taskId,
    provider: 'codex',
    windowId: 'primary',
    limitPercent,
    revision: 0,
    createdAt: new Date().toISOString(),
    startSequence: 0,
    source: 'owner',
    spentPercent: 0,
    reservedPercent: 0,
    remainingPercent: limitPercent,
    reason: null,
  });
  coordinator.accounting.holds = [];
  coordinator.accounting.budgets = [
    budget(projects[29]!.id, null, 0.1),
    budget(projects[0]!.id, tasks[0]!.id, 7.5),
  ];
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: state }));
  await page.route('**/api/quark/coordinator', (route) => route.fulfill({ json: coordinator }));
  return { projects, tasks, coordinator };
}

test('a crowded board bounds lists without hiding work and links land on their card', async ({
  page,
}) => {
  const { projects, tasks } = await crowd(page);
  await page.goto('/#/work');
  const waiting = page.getByRole('region', { name: 'Waiting', exact: true });
  await expect(waiting.locator('.quark-ticket')).toHaveCount(30);
  await waiting.getByRole('button', { name: 'Show 10 more', exact: true }).click();
  await expect(waiting.locator('.quark-ticket')).toHaveCount(40);
  await expect(page.locator('.quark-project-card')).toHaveCount(6);
  await expect(page.locator('.quark-project-card').first()).toContainText(
    'No project total cap saved. Ask QUARK to set one using a reported window.',
  );
  await expect(page.locator('.quark-project-card').nth(1)).toContainText(
    'No project total cap saved. Ask QUARK to set one using a reported window.',
  );
  await expect(page.getByRole('button', { name: 'Show all 30 projects' })).toBeVisible();
  // A project cap beyond the bounded list and a finished task are revealed and focused.
  await page.goto(`/#/work/${projects[29]!.id}`);
  const project = page.locator(`#quark-project-${projects[29]!.id}`);
  await expect(project.locator('.quark-total-caps').getByRole('slider')).toBeVisible();
  await expect(project).toBeFocused();
  await page.goto(`/#/work/${tasks[40]!.id}`);
  const done = page.locator(`#quark-task-${tasks[40]!.id}`);
  await expect(done).toBeFocused();
  await expect(page.getByRole('button', { name: 'Completed', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('keyboard budget changes keep focus through a slow save and save the newest value', async ({
  page,
}) => {
  const { coordinator, tasks } = await crowd(page);
  const writes: { limitPercent: number; expectedRevision: number }[] = [];
  await page.route('**/api/quark/budgets', async (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const saved = coordinator.accounting.budgets.find((b: { id: string }) => b.id === body.id);
    Object.assign(saved, {
      limitPercent: body.limitPercent,
      remainingPercent: body.limitPercent,
      revision: saved.revision + 1,
    });
    await route.fulfill({ json: coordinator.accounting });
  });
  await page.goto('/#/work');
  const slider = page.locator(`#quark-task-${tasks[0]!.id}`).getByRole('slider');
  await slider.focus();
  await slider.press('ArrowRight');
  await slider.press('ArrowRight');
  await expect(slider).toBeFocused();
  await expect(page.locator(`#quark-task-${tasks[0]!.id}`).getByRole('status')).toHaveText('Saved');
  await expect(slider).toHaveValue('7.7');
  expect(writes.map((w) => [w.limitPercent, w.expectedRevision])).toEqual([
    [7.6, 0],
    [7.7, 1],
  ]);
  await expect(slider).toBeFocused();
});
