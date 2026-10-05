import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { projectSchema, snapshotSchema, workItemSchema, workItemsSchema } from '@dock/shared';

test('Ideas stay distinct; selected ticket drafts, completion and Undo persist visibly', async ({
  page,
  baseURL,
}, info) => {
  const mark = randomUUID().slice(0, 8);
  const state = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = state.projects.find((project) => !project.internal)!;
  await page.goto('/#/home');
  const board = page.locator('.owner-work-board');
  await board.getByRole('button', { name: 'Ideas', exact: true }).click();
  const editor = board.getByRole('textbox', { name: 'New idea', exact: true });
  const ideaTitle = `A retained idea ${mark}`;
  await editor.fill(`${ideaTitle}\nKeep its scientific detail and source.`);
  await board.getByRole('button', { name: 'Add', exact: true }).click();
  const ideaRow = board.locator('.todo-list > li').filter({ hasText: ideaTitle });
  await expect(ideaRow).toHaveCount(1);
  await board.getByRole('button', { name: 'To-dos', exact: true }).click();
  await expect(ideaRow).toHaveCount(0);
  const sources = [];
  for (const title of [`Compare both datasets ${mark}`, `Write uncertainty evidence ${mark}`]) {
    const response = await page.request.post('/api/work-items', {
      headers: { origin: baseURL! },
      data: {
        key: randomUUID(),
        title,
        detail: 'Preserve every observation and explain assumptions.',
      },
    });
    expect(response.ok()).toBe(true);
    sources.push(workItemSchema.parse(await response.json()));
  }
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  for (const item of sources)
    await board.getByRole('checkbox', { name: `Select “${item.title}”`, exact: true }).check();
  await board.getByRole('button', { name: 'Package 2 to-dos', exact: true }).click();
  const form = board.getByRole('form', { name: 'Package a QUARK ticket' });
  const dialog = board.getByRole('dialog', { name: 'QUARK background ticket', exact: true });
  await expect(dialog).toBeVisible();
  const dialogBounds = (await dialog.boundingBox())!;
  expect(dialogBounds.height).toBeGreaterThan((page.viewportSize()?.height ?? 1000) * 0.85);
  const actionBounds = (await form
    .getByRole('button', { name: 'Queue with QUARK', exact: true })
    .boundingBox())!;
  expect(actionBounds.y).toBeGreaterThan(0);
  expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(
    page.viewportSize()?.height ?? 1000,
  );
  await form.getByRole('combobox', { name: 'Send to', exact: true }).selectOption(project.id);
  await form
    .getByRole('textbox', { name: 'Ticket title', exact: true })
    .fill(`Packaged outcome ${mark}`);
  await form
    .getByRole('textbox', { name: 'Additional brief', exact: true })
    .fill('Keep this draft through navigation and reload.');
  await form.getByRole('slider', { name: 'Priority', exact: true }).press('Home');
  for (let n = 0; n < 3; n++)
    await form.getByRole('slider', { name: 'Priority', exact: true }).press('ArrowRight');
  await form.getByRole('slider', { name: 'Estimated compute', exact: true }).press('Home');
  await page.reload();
  await expect(form.getByRole('textbox', { name: 'Additional brief', exact: true })).toHaveValue(
    'Keep this draft through navigation and reload.',
  );
  await expect(form.getByRole('slider', { name: 'Priority', exact: true })).toHaveValue('4');
  await expect(form.locator('.owner-ticket-sources li')).toHaveCount(2);
  for (const slider of await form.getByRole('slider').all()) {
    expect(await slider.getAttribute('min')).toBe('1');
    expect(await slider.getAttribute('max')).toBe('5');
    const bounds = (await slider.boundingBox())!;
    expect(bounds.width).toBeGreaterThanOrEqual(100);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 1440) + 1);
  }
  const source = sources[0]!;
  const changed = await page.request.post('/api/work-items', {
    headers: { origin: baseURL! },
    data: {
      key: randomUUID(),
      id: source.id,
      expectedRevision: source.revision,
      detail: 'New evidence from another tab.',
    },
  });
  expect(changed.ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(form.getByRole('button', { name: 'Queue with QUARK', exact: true })).toBeDisabled();
  await form.getByRole('button', { name: 'Use latest selection', exact: true }).click();
  await expect(form.getByRole('button', { name: 'Queue with QUARK', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await form.evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: info.outputPath('owner-ticket-viewport.png') });
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await board.getByRole('button', { name: 'Ideas', exact: true }).click();
  await expect(ideaRow).toContainText('Keep its scientific detail and source.');
  await ideaRow.getByRole('button', { name: `Mark “${ideaTitle}” done`, exact: true }).click();
  await expect(board.getByRole('status').filter({ hasText: 'Completed' })).toContainText(ideaTitle);
  await board.getByRole('button', { name: /^Completed \(\d+\)$/ }).click();
  const completed = board.locator('.todo-completed-list > li').filter({ hasText: ideaTitle });
  await expect(completed).toHaveCount(1);
  await page.reload();
  await expect(completed).toHaveCount(1);
  await completed
    .getByRole('button', { name: `Undo completion of “${ideaTitle}”`, exact: true })
    .click();
  await board.getByRole('button', { name: 'Ideas', exact: true }).click();
  await expect(ideaRow).toHaveCount(1);
  await ideaRow.getByRole('button', { name: 'Make to-do', exact: true }).click();
  await board.getByRole('button', { name: 'To-dos', exact: true }).click();
  await expect(ideaRow).toHaveCount(1);
  const saved = workItemsSchema
    .parse(await (await page.request.get('/api/work-items')).json())
    .items.find((item) => item.title === ideaTitle)!;
  expect(saved).toMatchObject({
    kind: 'general',
    detail: 'Keep its scientific detail and source.',
    status: 'open',
    taskId: null,
  });
});

test('an idea opens independent project setup and project boards retain scoped owner ideas', async ({
  page,
  baseURL,
}) => {
  const mark = randomUUID().slice(0, 8);
  const snapshot = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = snapshot.projects.find((value) => !value.internal)!;
  const response = await page.request.post('/api/work-items', {
    headers: { origin: baseURL! },
    data: {
      key: randomUUID(),
      kind: 'idea',
      title: `New study ${mark}`,
      detail: 'Keep all three measurements and their uncertainty.',
    },
  });
  const idea = workItemSchema.parse(await response.json());
  await page.goto('/#/home');
  const board = page.locator('.owner-work-board');
  await board.getByRole('button', { name: 'Ideas', exact: true }).click();
  await board
    .locator('.todo-list > li')
    .filter({ hasText: idea.title })
    .getByRole('button', { name: 'Start new project', exact: true })
    .click();
  await expect(page).toHaveURL(/#\/new\/idea\/[^/]+$/);
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(idea.title);
  const requests: { key: string; name: string; description: string; provider: string }[] = [];
  const projectIds: string[] = [];
  let release = () => {};
  const heldResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    projectIds.push(projectSchema.parse(await response.json()).id);
    if (requests.length === 1) {
      // The host accepted setup, but reload must recover without that acknowledgement.
      await heldResponse;
      await route.abort('aborted').catch(() => {}); // Its original document has been replaced.
    } else await route.fulfill({ response });
  });
  let sent = 0;
  await page.route('**/api/agents/*/messages', (route) => {
    sent++;
    return route.abort();
  });
  const editor = page.getByRole('textbox', { name: 'Project description', exact: true });
  try {
    await page.getByRole('button', { name: 'Spawn', exact: true }).click();
    await expect(editor).toHaveValue(`1. ${idea.title}\n${idea.detail}`);
    await expect.poll(() => projectIds.length).toBe(1);
    await page.getByRole('button', { name: 'Minimize', exact: true }).click();
    await page.reload();
    // Without a project acknowledgement, Spawn resumes the saved exact request.
    await page.getByRole('button', { name: 'Spawn', exact: true }).click();
    await expect(editor).toHaveValue(`1. ${idea.title}\n${idea.detail}`);
    await expect.poll(() => projectIds.length).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(new Set(projectIds).size).toBe(1);
    expect(sent).toBe(0);
  } finally {
    release();
  }
  const retained = workItemsSchema
    .parse(await (await page.request.get('/api/work-items')).json())
    .items.find((value) => value.id === idea.id)!;
  expect(retained).toEqual(idea);
  // Leaving setup without Send starts no model work, and other project boards stay separate.
  await page.goto(`/#/project/${project.id}`);
  const scoped = page.locator('.project-owner-board');
  await scoped.getByRole('button', { name: 'Ideas', exact: true }).click();
  await scoped
    .getByRole('textbox', { name: 'New idea', exact: true })
    .fill(`Existing project idea ${mark}`);
  await scoped.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(scoped.locator('.todo-list')).toContainText(`Existing project idea ${mark}`);
  await expect(scoped.locator('.todo-list')).not.toContainText(idea.title);
  const saved = workItemsSchema.parse(
    await (await page.request.get(`/api/work-items?projectId=${project.id}`)).json(),
  );
  expect(
    saved.items.find((item) => item.title === `Existing project idea ${mark}`)?.projectId,
  ).toBe(project.id);
});
