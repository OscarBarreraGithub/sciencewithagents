import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { snapshotSchema } from '@dock/shared';

test('attention and to-dos grow from compact panels into one natural page scroll', async ({
  page,
}, info) => {
  let questionCount = 0,
    todoCount = 0;
  let managerId = '',
    projectId = '';
  const questionIds = new Set<string>();
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
  const questionId = () => {
    const id = randomUUID();
    questionIds.add(id);
    return id;
  };
  await page.route('**/api/work-items', async (route) => {
    // Wait for the snapshot identity; this read never changes the demo database.
    await expect.poll(() => managerId).not.toBe('');
    const now = new Date().toISOString();
    await route.fulfill({
      json: {
        items: Array.from({ length: questionCount + todoCount }, (_, n) => ({
          id: n < questionCount ? questionId() : randomUUID(),
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
  const attention = page.locator('.overview-attention');
  const todos = page.locator('.overview-todo');
  const resources = page.locator('.overview-resources');
  await expect(attention).toContainText('Nothing needs you');
  await expect(todos.locator('.overview-count')).toHaveText('0');
  const emptyHeight = (await attention.boundingBox())!.height;
  expect(emptyHeight).toBeLessThan(320);
  const editor = todos.getByRole('textbox', { name: 'New to-do' });
  expect((await editor.boundingBox())!.height).toBeLessThan(100);
  const resourcesBefore = (await resources.boundingBox())!;
  await attention.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('compact-empty.png') });

  questionCount = 4;
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  const count = attention.locator('button.attention-project-count');
  // Four questions plus one stopped-work item for the same project; routine checks stay out.
  await expect(count).toHaveText('5');
  await count.click();
  await expect(attention.locator('.attention-item')).toHaveCount(5);
  expect((await attention.boundingBox())!.height).toBeGreaterThan(emptyHeight);
  await expect(attention).not.toContainText('Routine check');
  // A question opens its own answer form in the manager's conversation.
  const question = attention.getByRole('link', { name: /Question 1/ });
  await expect(question).toHaveAttribute('href', new RegExp(`^#/chat/${managerId}/answer/`));
  const answerId = (await question.getAttribute('href'))!.split('/answer/')[1]!;
  expect(questionIds.has(answerId)).toBe(true);
  await expect(attention.locator('a[href="#/work"]')).toHaveCount(2);

  questionCount = 30;
  todoCount = 30;
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(attention.locator('.attention-item')).toHaveCount(31);
  await expect(todos.locator('.todo-list > li')).toHaveCount(30);
  // Long lists grow the page instead of becoming separate scroll traps.
  for (const section of [attention, todos]) {
    expect(
      await section.evaluate((root) =>
        [root, ...root.querySelectorAll('*')].some((node) => {
          const style = getComputedStyle(node);
          return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
        }),
      ),
    ).toBe(false);
  }
  const main = page.locator('.home-content');
  expect(await main.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  const lastQuestion = attention.getByText('Question 30', { exact: true });
  await lastQuestion.scrollIntoViewIfNeeded();
  await expect(lastQuestion).toBeInViewport();
  await todos.getByText('Saved to-do 30', { exact: true }).scrollIntoViewIfNeeded();
  await expect(todos.getByText('Saved to-do 30', { exact: true })).toBeInViewport();
  expect(await main.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  // Expanding requests never resizes the resource panel beside or below it.
  const resourcesAfter = (await resources.boundingBox())!;
  expect(Math.abs(resourcesAfter.height - resourcesBefore.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(resourcesAfter.width - resourcesBefore.width)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('full-page-scroll.png') });

  questionCount = 0;
  todoCount = 0;
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(attention.locator('.attention-item')).toHaveCount(0);
  await expect(todos.locator('.todo-list > li')).toHaveCount(0);
  await expect
    .poll(async () => (await attention.boundingBox())!.height)
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
