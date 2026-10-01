import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { snapshotSchema, workItemSchema, workItemsSchema } from '@dock/shared';

test('a delayed add keeps a newer draft after leaving and returning Home', async ({
  page,
  baseURL,
}) => {
  const title = `Pending add ${randomUUID()}`;
  const newer = `Newer draft ${randomUUID()}\nKeep this after the old response.`;
  let committed = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/work-items', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    committed = true;
    await gate;
    await route.fulfill({ response });
  });
  await page.goto('/#/home');
  const editor = page.getByRole('textbox', { name: 'New to-do', exact: true });
  // On a crowded phone Home the editor starts below the viewport. Reach it as
  // a person would before sending native WebKit text input.
  await editor.scrollIntoViewIfNeeded();
  await editor.fill(title);
  await expect(editor).toHaveValue(title);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => committed).toBe(true);
  await page.evaluate(() => (location.hash = '#/chats'));
  await expect(editor).toHaveCount(0);
  await page.evaluate(() => (location.hash = '#/home'));
  await expect(editor).toHaveValue(title);
  await editor.fill(newer);
  release();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('dock:local:home-todo:add')))
    .toBeNull();
  await page.reload();
  await expect(editor).toHaveValue(newer);
  const items = workItemsSchema.parse(await (await page.request.get('/api/work-items')).json());
  expect(items.items.filter((item) => item.title === title)).toHaveLength(1);
});

test('an older add response keeps the retry receipt for a newer uncertain add', async ({
  page,
}) => {
  const first = `Older receipt ${randomUUID()}`;
  const second = `Newer receipt ${randomUUID()}`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const submissions: Record<string, unknown>[] = [];
  await page.route('**/api/work-items', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const index = submissions.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (index === 1) await gate;
    if (index === 2) return route.fulfill({ status: 502, json: { error: 'Newer response lost' } });
    return route.fulfill({ response });
  });
  await page.goto('/#/home');
  const editor = page.getByRole('textbox', { name: 'New to-do', exact: true });
  try {
    await editor.fill(first);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => submissions.length).toBe(1);
    await page.evaluate(() => (location.hash = '#/chats'));
    await expect(editor).toHaveCount(0);
    await page.evaluate(() => (location.hash = '#/home'));
    await editor.fill(second);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('.todo-error')).toContainText('Newer response lost');
    const oldResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.request().postDataJSON().title === first,
    );
    release();
    await (await oldResponse).finished();
    // Let the older fetch's JSON/React callbacks finish before reloading storage.
    await page.waitForTimeout(150);
    await page.reload();
    await expect(editor).toHaveValue(second);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(editor).toHaveValue('');
    expect(submissions).toHaveLength(3);
    expect(submissions[2]).toEqual(submissions[1]);
    const items = workItemsSchema.parse(await (await page.request.get('/api/work-items')).json());
    expect(items.items.filter((item) => item.title === first)).toHaveLength(1);
    expect(items.items.filter((item) => item.title === second)).toHaveLength(1);
  } finally {
    release();
  }
});

test('long multiline to-dos wrap, keep kinds separate, and support API edits done undo and stale conflicts', async ({
  page,
  baseURL,
}, info) => {
  const title = `${info.project.name}-${randomUUID()}-` + 'x'.repeat(300);
  const detail = 'First detail.\nSecond detail.';
  await page.goto('/#/home');
  const editor = page.getByRole('textbox', { name: 'New to-do', exact: true });
  await editor.fill(`${title}\n${detail}`);
  await page.reload();
  await expect(editor).toHaveValue(`${title}\n${detail}`);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(editor).toHaveValue('');
  const savedTitle = title.slice(0, 240);
  const row = page
    .locator('.todo-list > li')
    .filter({ has: page.getByText(savedTitle, { exact: true }) });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.todo-detail')).toHaveText(`${title.slice(240)}\n${detail}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('long-todo.png') });
  const items = workItemsSchema.parse(await (await page.request.get('/api/work-items')).json());
  const item = items.items.find((item) => item.title === savedTitle)!;
  const state = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = state.projects.find((project) => !project.internal)!;
  for (const kind of ['human', 'internal'] as const) {
    const response = await page.request.post('/api/work-items', {
      headers: { origin: baseURL! },
      data: {
        key: randomUUID(),
        kind,
        title: `${kind} only ${randomUUID()}`,
        managerId: project.managerId,
        projectId: project.id,
      },
    });
    expect(response.ok()).toBe(true);
    const separate = workItemSchema.parse(await response.json());
    await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
    await expect(page.locator('.overview-todo')).not.toContainText(separate.title);
  }
  const edit = await page.request.post('/api/work-items', {
    headers: { origin: baseURL! },
    data: {
      key: randomUUID(),
      id: item.id,
      expectedRevision: item.revision,
      detail: 'Edited in a second tab.',
    },
  });
  expect(edit.ok()).toBe(true);
  const conflict = await page.request.post('/api/work-items', {
    headers: { origin: baseURL! },
    data: {
      key: randomUUID(),
      id: item.id,
      expectedRevision: item.revision,
      status: 'done',
    },
  });
  expect(conflict.status()).toBe(409);
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(row.locator('.todo-detail')).toHaveText('Edited in a second tab.');
  await row.getByRole('button', { name: `Mark “${savedTitle}” done`, exact: true }).click();
  await expect(row).toHaveCount(0);
  const completed = workItemsSchema
    .parse(await (await page.request.get('/api/work-items')).json())
    .items.find((i) => i.id === item.id)!;
  expect(completed.status).toBe('done');
  const undo = await page.request.post('/api/work-items', {
    headers: { origin: baseURL! },
    data: {
      key: randomUUID(),
      id: item.id,
      expectedRevision: completed.revision,
      status: 'open',
    },
  });
  expect(undo.ok()).toBe(true);
  await page.reload();
  await expect(row).toHaveCount(1);
});

test('retry after a lost assignment response opens the confirmed assignment without another write', async ({
  page,
  baseURL,
}, info) => {
  const title = `Assign once ${info.project.name} ${randomUUID()}`;
  const response = await page.request.post('/api/work-items', {
    headers: { origin: baseURL! },
    data: { key: randomUUID(), title },
  });
  expect(response.ok()).toBe(true);
  const item = workItemSchema.parse(await response.json());
  const state = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = state.projects.find((project) => !project.internal)!;
  const submissions: Record<string, unknown>[] = [];
  await page.route('**/api/work-items', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions.push(route.request().postDataJSON());
    const saved = await route.fetch();
    expect(saved.ok()).toBe(true);
    if (submissions.length === 1)
      return route.fulfill({ status: 502, json: { error: 'Assignment response lost' } });
    return route.fulfill({ response: saved });
  });
  await page.goto('/#/home');
  const row = page.locator('.todo-list > li').filter({ hasText: title });
  await row.getByRole('button', { name: 'Send to project', exact: true }).click();
  await row.getByRole('combobox', { name: 'Send to', exact: true }).selectOption(project.id);
  await row.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(row.locator('.todo-error')).toContainText('Assignment response lost');
  await expect(row).toContainText('Sent to');
  await row.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${project.managerId}$`));
  expect(submissions).toHaveLength(1);
  const items = workItemsSchema.parse(await (await page.request.get('/api/work-items')).json());
  const assigned = items.items.find((i) => i.id === item.id)!;
  expect(assigned.revision).toBe(2);
  expect(assigned.assignmentRunId).toBeTruthy();
  const manager = await (await page.request.get(`/api/agents/${project.managerId}`)).json();
  expect(
    manager.entries.filter((entry: { text: string }) =>
      entry.text.includes(`To-do ID: ${item.id}`),
    ),
  ).toHaveLength(1);
});

test('a pending change conflicts with another tab and retry preserves the other edit', async ({
  page,
  context,
  baseURL,
}) => {
  const title = `Tab conflict ${randomUUID()}`;
  const response = await page.request.post('/api/work-items', {
    headers: { origin: baseURL! },
    data: { key: randomUUID(), title },
  });
  const item = workItemSchema.parse(await response.json());
  await page.goto('/#/home');
  const other = await context.newPage();
  try {
    await other.goto('/#/home');
    await expect(other.locator('.todo-list')).toContainText(title);
    let pending = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let writes = 0;
    await page.route('**/api/work-items', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      if (++writes === 1) {
        pending = true;
        await gate;
      }
      return route.continue();
    });
    const row = page.locator('.todo-list > li').filter({ hasText: title });
    await row.getByRole('button', { name: `Mark “${title}” done`, exact: true }).click();
    await expect.poll(() => pending).toBe(true);
    const edited = await other.request.post('/api/work-items', {
      headers: { origin: baseURL! },
      data: {
        key: randomUUID(),
        id: item.id,
        expectedRevision: item.revision,
        detail: 'Retain the edit from the other tab.',
      },
    });
    expect(edited.ok()).toBe(true);
    await other.reload();
    await expect(other.locator('.todo-list')).toContainText('Retain the edit from the other tab.');
    release();
    await expect(row.locator('.todo-error')).toContainText('changed');
    await expect(row.locator('.todo-detail')).toHaveText('Retain the edit from the other tab.');
    await row.getByRole('button', { name: `Mark “${title}” done`, exact: true }).click();
    await expect(row).toHaveCount(0);
    const items = workItemsSchema.parse(await (await page.request.get('/api/work-items')).json());
    expect(items.items.find((entry) => entry.id === item.id)).toMatchObject({
      status: 'done',
      revision: 3,
      detail: 'Retain the edit from the other tab.',
    });
  } finally {
    await other.close();
  }
});
