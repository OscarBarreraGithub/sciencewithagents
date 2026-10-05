import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
test('QUARK shows chat entry, real queue columns and forecasts without starting a model on open', async ({
  page,
}, info) => {
  let starts = 0;
  page.on('request', (r) => {
    if (r.url().includes('/coordinator/start')) starts++;
  });
  await page.goto('/#/work');
  await expect(page.getByRole('heading', { name: 'QUARK', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Talk to QUARK', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open QUARK conversation' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Waiting', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Paused / needs input', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Waiting', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Active work', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shared reserves', exact: true })).toBeVisible();
  expect(starts).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('../../data/screenshots/quark-board', { recursive: true });
  await page
    .locator('.home-content')
    .evaluate((el) => {
      el.scrollTop = 0;
    })
    .catch(() => {});
  await page.getByRole('heading', { name: 'QUARK', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `../../data/screenshots/quark-board/${info.project.name}.png`,
    fullPage: true,
  });
});
test('usage opens provider actions with explicit connection and update results', async ({
  page,
}) => {
  let updates = 0;
  await page.route('**/api/providers/update', async (route) => {
    updates++;
    await route.fulfill({
      json: {
        provider: 'codex',
        state: 'current',
        message: 'Up to date · 1.2.3',
        before: '1.2.3',
        after: '1.2.3',
        checkedAt: new Date().toISOString(),
        command: null,
      },
    });
  });
  await page.goto('/');
  const card = page.locator('.home-usage-codex');
  await card.locator('summary').first().click();
  await expect(card.getByRole('button', { name: 'Refresh usage' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Check connection', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Check & install updates' }).click();
  await expect(card.getByRole('status')).toContainText('Up to date');
  expect(updates).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('one task card groups worker turns and only task completion moves it to Completed', async ({
  page,
}) => {
  const state = await (await page.request.get('/api/snapshot')).json();
  const coordinator = await (await page.request.get('/api/quark/coordinator')).json();
  const project = state.projects.find((p: { internal?: boolean }) => !p.internal);
  const template = state.tasks.find((t: { projectId: string }) => t.projectId === project.id);
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
  state.tasks = [
    { ...template, id: ids[0], title: 'Several workers one task', status: 'working' },
    { ...template, id: ids[1], title: 'Review still pending', status: 'review' },
    { ...template, id: ids[2], title: 'Finished task with retries', status: 'done' },
  ];
  const agent = state.agents.find((a: { id: string }) => a.id === project.managerId);
  agent.status = 'idle';
  coordinator.agentId = null;
  coordinator.projects = coordinator.projects.filter((p: { id: string }) => p.id === project.id);
  coordinator.projects[0].policy.paused = false;
  coordinator.localJobs = [];
  const job = (taskId: string, status: string) => ({
    runId: crypto.randomUUID(),
    agentId: agent.id,
    taskId,
    projectName: project.name,
    agentName: 'Fixture worker',
    provider: 'codex',
    status,
    estimate: {
      priority: 'normal',
      expectedTokens: 10000,
      tokenBudget: 100000,
      quotaPercent: 1,
      expectedSeconds: 120,
      cpuCores: 1,
      memoryMb: 512,
      estimatedCostUsd: null,
      estimateNote: 'Fixture estimate',
      deadline: null,
    },
    held: false,
    override: false,
    reason: 'Fixture turn',
    eligible: false,
    expectedFinishAt: null,
    tokensCharged: 200,
    tokenBasis: 'measured',
  });
  coordinator.queue.jobs = [job(ids[0], 'running'), job(ids[0], 'queued')];
  coordinator.queue.history = [
    job(ids[0], 'completed'),
    job(ids[1], 'completed'),
    job(ids[2], 'completed'),
    job(ids[2], 'interrupted'),
  ];
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: state }));
  await page.route('**/api/quark/coordinator', (route) => route.fulfill({ json: coordinator }));
  await page.goto('/#/work');
  const working = page.getByRole('region', { name: 'Working', exact: true });
  await expect(working.locator('.quark-ticket')).toHaveCount(1);
  await expect(working.locator('.quark-ticket h4 a')).toHaveAttribute('href', `#/task/${ids[0]}`);
  await expect(working.locator('.quark-ticket')).toContainText('3 recent turns');
  await expect(page.getByRole('region', { name: 'Waiting', exact: true })).toContainText(
    'Review still pending',
  );
  await expect(page.locator('.quark-ticket')).toHaveCount(2);
  // A stopped worker's durable quota hold still pauses its task when newer manager turns queue.
  coordinator.accounting.holds = [
    {
      runId: coordinator.queue.history[1].runId,
      agentId: agent.id,
      projectId: project.id,
      reason: 'Retained worker quota pause',
      cause: 'budget',
      createdAt: new Date().toISOString(),
      stopAcknowledgedAt: new Date().toISOString(),
      releasedAt: null,
      lastAttemptAt: null,
      error: null,
    },
  ];
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Paused / needs input', exact: true }),
  ).toContainText('Retained worker quota pause');
  await expect(working.locator('.quark-ticket')).toHaveCount(1);
  coordinator.accounting.holds[0].releasedAt = new Date().toISOString();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Waiting', exact: true })).toContainText(
    'Review still pending',
  );
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(page.locator('.quark-ticket')).toHaveCount(1);
  await expect(page.locator('.quark-ticket')).toContainText('Finished task with retries');
  await expect(page.locator('.quark-ticket h4 a')).toHaveAttribute('href', `#/task/${ids[2]}`);
});

test('closing obsolete work cancels its queue and keeps the saved task and reason after reload', async ({
  page,
  baseURL,
}) => {
  const headers = { Origin: baseURL! };
  const scheduler = await (await page.request.get('/api/scheduler')).json();
  const pause = await page.request.post('/api/scheduler/settings', {
    headers,
    data: { key: crypto.randomUUID(), settings: { ...scheduler.settings, paused: true } },
  });
  expect(pause.ok()).toBe(true);
  try {
    const snapshot = await (await page.request.get('/api/snapshot')).json();
    const project = snapshot.projects.find((p: { internal?: boolean }) => !p.internal);
    const response = await page.request.post(`/api/projects/${project.id}/tasks`, {
      headers,
      data: {
        key: crypto.randomUUID(),
        task: {
          title: 'Obsolete queue fixture',
          goal: 'Retain this saved brief',
          acceptance: 'Retain all records',
          parentId: null,
        },
      },
    });
    expect(response.ok()).toBe(true);
    const task = await response.json();
    await page.goto(`/#/task/${task.id}`);
    await page.getByRole('button', { name: 'Close task…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Close this task' });
    await dialog
      .getByRole('textbox', { name: 'Reason for closing task' })
      .fill('This work was handled elsewhere. Keep its history.');
    await dialog.getByRole('button', { name: 'Close task and retain history' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('This work was handled elsewhere.');
    await page.reload();
    await expect(page.getByRole('status')).toContainText('This work was handled elsewhere.');
    await expect(page.getByText('Retain this saved brief', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close task…' })).toHaveCount(0);
    const queue = await (await page.request.get('/api/pulsar')).json();
    expect(queue.jobs.some((j: { taskId: string }) => j.taskId === task.id)).toBe(false);
    await page.goto('/#/work');
    await expect(page.locator('.quark-board')).not.toContainText('Obsolete queue fixture');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await page.request.post('/api/scheduler/settings', {
      headers,
      data: { key: crypto.randomUUID(), settings: scheduler.settings },
    });
  }
});
