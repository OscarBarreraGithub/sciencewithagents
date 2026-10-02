import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { snapshotSchema, type WorkItem } from '@dock/shared';

test('unanswered human requests stay visible regardless of open progress status', async ({
  page,
}) => {
  const snapshot = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = snapshot.projects.find((p) => !p.internal)!;
  const now = new Date().toISOString();
  const items: WorkItem[] = (['open', 'in_progress', 'waiting', 'done'] as const).map((status) => ({
    id: randomUUID(),
    projectId: project.id,
    managerId: project.managerId,
    taskId: null,
    kind: 'human',
    title: `Human question ${status}`,
    detail: 'Work can continue while you decide.',
    status,
    revision: 1,
    humanReply: null,
    repliedAt: null,
    replyRunId: null,
    assignmentRunId: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: status === 'done' ? now : null,
  }));
  items.push({
    ...items[0]!,
    id: randomUUID(),
    title: 'Answered question',
    humanReply: 'Fractions',
  });
  let failed = false;
  await page.route('**/api/work-items', (route) =>
    failed
      ? route.fulfill({ status: 503, json: { error: 'Temporary read failure' } })
      : route.fulfill({ json: { items } }),
  );
  await page.goto('/#/home');
  const panel = page.getByRole('region', { name: 'For your attention', exact: true });
  for (const status of ['open', 'in_progress', 'waiting']) {
    const item = items.find((item) => item.status === status && !item.humanReply)!;
    await expect(
      panel.getByRole('link', { name: new RegExp(`Human question ${status}`) }),
    ).toHaveAttribute('href', `#/chat/${project.managerId}/answer/${item.id}`);
  }
  await expect(panel).not.toContainText('Human question done');
  await expect(panel).not.toContainText('Answered question');
  await expect(panel).not.toContainText('Nothing needs you');
  failed = true;
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(panel.locator('.overview-count')).toHaveText('—');
  await expect(panel.getByRole('link', { name: /Human question open/ })).toBeVisible();
  await page.reload();
  await expect(panel).toContainText('Requests will appear when the computer reconnects.');
  await expect(panel).not.toContainText('Nothing needs you');
  failed = false;
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(panel.getByRole('link', { name: /Human question open/ })).toBeVisible();
});

test('running project shows its request and opens the exact answer form without starting work', async ({
  page,
}, info) => {
  const snapshot = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = snapshot.projects.find((p) => !p.internal)!;
  snapshot.agents.forEach((agent) => {
    agent.status = agent.id === project.managerId ? 'running' : 'idle';
  });
  snapshot.approvals = [];
  snapshot.tasks = [];
  snapshot.backups = [];
  const now = new Date().toISOString();
  const items: WorkItem[] = Array.from({ length: 3 }, (_, i) => ({
    id: randomUUID(),
    projectId: project.id,
    managerId: project.managerId,
    taskId: null,
    kind: 'human',
    title: i === 0 ? 'Which source accounts should the project watch?' : `Another question ${i}`,
    detail: 'Send the profile links and confirm which reset window to track.',
    status: 'waiting',
    revision: 1,
    humanReply: null,
    repliedAt: null,
    replyRunId: null,
    assignmentRunId: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  }));
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  const queue = await (await page.request.get('/api/pulsar')).json();
  await page.route('**/api/pulsar', (route) => route.fulfill({ json: { ...queue, jobs: [] } }));
  await page.route('**/api/local-jobs', (route) => route.fulfill({ json: { jobs: [] } }));
  const writes: unknown[] = [];
  await page.route('**/api/work-items*', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      writes.push(body);
      const item = items.find((item) => item.id === body.id)!;
      item.humanReply = body.humanReply;
      item.revision++;
      return route.fulfill({ json: item });
    }
    return route.fulfill({ json: { items } });
  });
  const starts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/messages|\/resume|\/start/.test(request.url()))
      starts.push(request.url());
  });
  await page.goto('/#/home');
  const running = page.getByRole('region', { name: '% usage / hour', exact: true });
  const row = running.getByRole('row').filter({ hasText: project.name });
  const request = row.getByRole('link', { name: /Question Which source accounts/ });
  await expect(request).toHaveAttribute(
    'href',
    `#/chat/${project.managerId}/answer/${items[0]!.id}`,
  );
  await expect(row).not.toContainText('Yes ·');
  await row.getByText('2 more requests', { exact: true }).click();
  await expect(row.getByRole('link', { name: /Another question 2/ })).toBeVisible();
  await row.getByText('2 more requests', { exact: true }).click();
  await running.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('request-in-running-project.png'), scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await row.getByRole('link', { name: /^Open request for/ }).click();
  const selected = page.getByRole('region', { name: 'Selected request' });
  await expect(selected).toContainText(items[0]!.title);
  await expect(selected).toContainText(items[0]!.detail);
  await expect(selected.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
  await page.reload();
  await expect(selected.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
  expect(writes).toEqual([]);
  expect(starts).toEqual([]);
  await page.screenshot({ path: info.outputPath('selected-question.png'), scale: 'css' });
  await selected
    .getByRole('textbox', { name: 'Your answer' })
    .fill('Use the five-hour window and the supplied example profiles.');
  await selected.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(selected).toContainText('Request resolved');
  await expect(selected.getByRole('button', { name: 'Send answer', exact: true })).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    id: items[0]!.id,
    expectedRevision: 1,
    humanReply: 'Use the five-hour window and the supplied example profiles.',
  });
  await page.goto('/#/home');
  await expect(running).not.toContainText(items[0]!.title);
});
