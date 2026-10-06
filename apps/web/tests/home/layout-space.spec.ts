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
  // Synthetic, shaped like retained evidence: identifiers and paths in one long checkpoint,
  // and multiline notes long enough to make the to-do list several screens tall.
  const checkpoint = [
    'Checkpoint 3f9c1a2e-7b4d-4c1e-9a8f-2d6b5e0c4a17: reviewed task',
    '8e2d4f60-1c3b-4a9e-b7d5-0f6a2c9e1b38 in',
    '/Users/example/Developer/sample-project/apps/web/src/home/ExamplePanel.tsx;',
    'next: rerun run 5c7e9b1d-2a4f-4d6e-8b0c-3e1f7a9d2c46 and compare',
    '/Users/example/Developer/sample-project/data/receipts/example-receipt.json.',
  ].join(' ');
  const note = (n: number) =>
    Array.from(
      { length: 6 },
      (_, line) =>
        `Step ${line + 1} for note ${n}: gather the sample inputs, record which settings were used, and keep the comparison table beside the draft so the next pass can check it.`,
    ).join('\n');
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
      { ...manager, status: 'idle', checkpoint },
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
          detail:
            n < questionCount
              ? 'Choose the input needed to continue this task.'
              : note(n - questionCount + 1),
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
  const main = page.locator('.home-content');
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
  await expect(todos.locator('.todo-list > li').last()).toContainText('Step 6 for note 30');
  const summary = attention.locator('.attention-project-name small');
  const preview = `Idle · Last checkpoint: ${checkpoint.slice(0, 160)}`;
  await expect(summary).toHaveText(preview);
  // The checkpoint preview is two readable lines; the exact text stays in its title and DOM,
  // and the manager chat link is unchanged.
  await expect(summary).toHaveAttribute('title', preview);
  await expect(attention.locator('.attention-project-name')).toHaveAttribute(
    'href',
    `#/chat/${managerId}`,
  );
  const lines = await summary.evaluate((element) => {
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    return element.getBoundingClientRect().height / line;
  });
  expect(lines).toBeGreaterThan(1.5);
  expect(lines).toBeLessThanOrEqual(2.05);
  // A long to-do list must not stretch the destinations or open a gap below them.
  await main.evaluate((e) => e.scrollTo(0, 0));
  const viewport = page.viewportSize()!;
  for (const card of await page.locator('.overview-destinations .destination').all()) {
    const box = (await card.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(viewport.height * 0.5);
    await expect(card.locator('strong')).toBeInViewport();
  }
  const nav = (await page.locator('.overview-destinations').boundingBox())!;
  const below = [];
  for (const section of [attention, todos, resources]) {
    const box = (await section.boundingBox())!;
    if (box.y >= nav.y + nav.height - 1) below.push(box.y);
  }
  expect(Math.min(...below) - (nav.y + nav.height)).toBeLessThanOrEqual(40);
  await page.screenshot({ path: info.outputPath('long-lists-top.png') });
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
  expect(await main.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  const lastQuestion = attention.getByText('Question 30', { exact: true });
  await lastQuestion.scrollIntoViewIfNeeded();
  await expect(lastQuestion).toBeInViewport();
  await todos.getByText('Saved to-do 30', { exact: true }).scrollIntoViewIfNeeded();
  await expect(todos.getByText('Saved to-do 30', { exact: true })).toBeInViewport();
  const finalNote = todos.locator('.todo-list > li').last().locator('.todo-detail');
  await finalNote.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  await expect(finalNote).toBeInViewport();
  await expect(finalNote).toContainText('Step 6 for note 30');
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
