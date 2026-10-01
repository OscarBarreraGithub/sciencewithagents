import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { snapshotSchema } from '@dock/shared';

test('attention and to-dos grow from compact panels to independently scrolling sections', async ({
  page,
}, info) => {
  let questionCount = 0,
    todoCount = 0;
  let managerId = '',
    projectId = '';
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const snapshot = snapshotSchema.parse(await response.json());
    const project = snapshot.projects.find((p) => !p.internal)!;
    const manager = snapshot.agents.find((a) => a.id === project.managerId)!;
    managerId = manager.id;
    projectId = project.id;
    const internalId = randomUUID();
    snapshot.projects.push({
      ...project,
      id: internalId,
      name: 'Automatic checks',
      internal: true,
    });
    snapshot.agents = [
      { ...manager, status: 'idle' },
      ...Array.from({ length: 30 }, (_, n) => ({
        ...manager,
        id: randomUUID(),
        projectId: internalId,
        name: `Routine check ${n}`,
        status: 'interrupted' as const,
      })),
      ...Array.from({ length: questionCount ? 5 : 0 }, (_, n) => ({
        ...manager,
        id: randomUUID(),
        role: 'implementer' as const,
        name: `Stopped worker ${n}`,
        status: 'interrupted' as const,
      })),
    ];
    snapshot.tasks = [];
    snapshot.approvals = [];
    snapshot.backups = [];
    await route.fulfill({ json: snapshot });
  });
  await page.route('**/api/work-items', async (route) => {
    // Wait for the snapshot identity; this read never changes the demo database.
    await expect.poll(() => managerId).not.toBe('');
    const now = new Date().toISOString();
    await route.fulfill({
      json: {
        items: Array.from({ length: questionCount + todoCount }, (_, n) => ({
          id: randomUUID(),
          projectId: n < questionCount ? projectId : null,
          managerId: n < questionCount ? managerId : null,
          taskId: null,
          kind: n < questionCount ? 'human' : 'general',
          status: n < questionCount ? 'waiting' : 'open',
          title: n < questionCount ? `Question ${n + 1}` : `Saved to-do ${n - questionCount + 1}`,
          detail: 'Choose the input needed to continue this task.',
          revision: 1,
          humanReply: null,
          repliedAt: null,
          replyRunId: null,
          assignmentRunId: null,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        })),
      },
    });
  });
  await page.goto('/#/home');
  const panel = page.locator('.overview-side');
  const attention = page.locator('.overview-attention');
  const todos = page.locator('.overview-todo');
  await expect(attention).toContainText('Nothing needs you right now.');
  await expect(todos.locator('.overview-count')).toHaveText('0');
  const emptyHeight = (await panel.boundingBox())!.height;
  expect(emptyHeight).toBeLessThan(320);
  const editor = todos.getByRole('textbox', { name: 'New to-do' });
  expect((await editor.boundingBox())!.height).toBeLessThan(100);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('compact-empty.png') });

  questionCount = 4;
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(attention.locator('.attention-item')).toHaveCount(5);
  expect((await panel.boundingBox())!.height).toBeGreaterThan(emptyHeight);
  await expect(attention).not.toContainText('Routine check');
  await expect(attention.getByRole('link', { name: /Question 1/ })).toHaveAttribute(
    'href',
    `#/chat/${managerId}`,
  );
  await expect(attention.locator('a[href="#/work"]')).toHaveCount(1);

  questionCount = 30;
  todoCount = 30;
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(attention.locator('.attention-item')).toHaveCount(31);
  await expect(todos.locator('.todo-list > li')).toHaveCount(30);
  const visibleHeight = await page.evaluate(() => window.visualViewport!.height);
  expect((await panel.boundingBox())!.height).toBeLessThan(visibleHeight);
  await panel.scrollIntoViewIfNeeded();
  const panes = panel.locator('.overview-section-body');
  for (const pane of await panes.all()) {
    expect(await pane.evaluate((e) => e.scrollHeight > e.clientHeight + 40)).toBe(true);
    expect((await pane.boundingBox())!.height).toBeGreaterThan(20);
    await pane.evaluate((e) => e.scrollTo(0, 0));
  }
  const mainScroll = await page.locator('.home-content').evaluate((e) => e.scrollTop);
  await panes.nth(0).evaluate((e) => e.scrollTo(0, e.scrollHeight));
  expect(await panes.nth(0).evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  expect(await panes.nth(1).evaluate((e) => e.scrollTop)).toBe(0);
  const attentionScroll = await panes.nth(0).evaluate((e) => e.scrollTop);
  await panes.nth(1).evaluate((e) => e.scrollTo(0, e.scrollHeight));
  expect(await panes.nth(1).evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  expect(await panes.nth(0).evaluate((e) => e.scrollTop)).toBe(attentionScroll);
  expect(await page.locator('.home-content').evaluate((e) => e.scrollTop)).toBe(mainScroll);
  // A large-text row can exceed the short landscape pane. Its title must remain
  // reachable by scrolling that pane, not necessarily visible at its bottom edge.
  await todos.getByText('Saved to-do 30', { exact: true }).scrollIntoViewIfNeeded();
  await expect(todos.getByText('Saved to-do 30', { exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('full-independent-scroll.png') });

  questionCount = 0;
  todoCount = 0;
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(attention.locator('.attention-item')).toHaveCount(0);
  await expect(todos.locator('.todo-list > li')).toHaveCount(0);
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeLessThanOrEqual(emptyHeight + 1);
});

test('main pages use the browser width and mobile allowances scroll away', async ({ page }) => {
  await page.goto('/#/home');
  await expect(page.locator('.overview')).toBeVisible();
  const width = page.viewportSize()!.width;
  const box = await page.locator('.overview').boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(width - 70);
  if (width <= 700) {
    await expect(page.locator('.home-mobile-status')).toBeVisible();
    await page.locator('.home-content').evaluate((e) => e.scrollTo(0, e.scrollHeight));
    const usage = await page.locator('.home-mobile-status').boundingBox();
    expect(usage!.y + usage!.height).toBeLessThanOrEqual(52);
  }
  await page.goto('/#/computers');
  await expect(
    page.getByRole('heading', { name: 'Computers and accounts', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.activity-shortcuts a[href="#/recovery"]')).toHaveCount(0);
  await expect(page.locator('.activity-shortcuts a[href="#/usage"]')).toHaveCount(0);
});
