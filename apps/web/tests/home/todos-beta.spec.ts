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

test('explicit to-do refresh waits for fresh coalesced reads and cancels follow-up on leaving Home', async ({
  page,
  baseURL,
}) => {
  // Hold passive polling so it cannot hide a lost explicit refresh.
  const time = new Date('2026-10-09T12:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 60_000));
  const title = `Refresh race ${randomUUID()}`;
  const created = await page.request.post('/api/work-items', {
    headers: { origin: baseURL! },
    data: { key: randomUUID(), title, detail: 'Before the edit.' },
  });
  expect(created.ok()).toBe(true);
  const item = workItemSchema.parse(await created.json());
  await page.goto('/#/home');
  const row = page
    .locator('.todo-list > li')
    .filter({ has: page.getByText(title, { exact: true }) });
  await expect(row.locator('.todo-detail')).toHaveText('Before the edit.');

  let reads = 0;
  let active = 0;
  let maximumActive = 0;
  let leaving = false;
  const retained: ReturnType<typeof workItemSchema.parse>[] = [];
  const release: (() => void)[] = [];
  const gates = Array.from(
    { length: 4 },
    (_, index) => new Promise<void>((done) => (release[index] = done)),
  );
  await page.route('**/api/work-items', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const index = reads++;
    active++;
    maximumActive = Math.max(maximumActive, active);
    try {
      const response = await route.fetch();
      retained[index] = workItemsSchema
        .parse(await response.json())
        .items.find((i) => i.id === item.id)!;
      await gates[index];
      try {
        await route.fulfill({ response });
      } catch (error) {
        if (!leaving) throw error; // The final owned read is deliberately canceled on unmount.
      }
    } finally {
      active--;
    }
  });
  const requestRefresh = (mark: string, count = 1) =>
    page.evaluate(
      async ({ mark, count }) => {
        const readings: Promise<boolean>[] = [];
        for (let i = 0; i < count; i++)
          window.dispatchEvent(
            new CustomEvent('swa:refresh-home', {
              detail: { waitUntil: (reading: Promise<boolean>) => readings.push(reading) },
            }),
          );
        document.documentElement.dataset.todoRefreshDispatched = mark;
        return Promise.all(readings);
      },
      { mark, count },
    );
  const dispatched = (mark: string) =>
    expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.todoRefreshDispatched))
      .toBe(mark);
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
    await expect.poll(() => retained[0]?.detail).toBe('Before the edit.');
    const edited = await page.request.post('/api/work-items', {
      headers: { origin: baseURL! },
      data: {
        key: randomUUID(),
        id: item.id,
        expectedRevision: item.revision,
        detail: 'After the edit.',
      },
    });
    expect(edited.ok()).toBe(true);
    const edit = workItemSchema.parse(await edited.json());
    let settled = false;
    const requested = requestRefresh('first', 2);
    void requested.then(() => (settled = true));
    await dispatched('first');
    release[0]!();
    await expect.poll(() => retained[1]?.detail).toBe('After the edit.');
    expect(settled).toBe(false);
    expect(reads).toBe(2);
    expect(maximumActive).toBe(1);

    // A later mutation while that follow-up is pending needs its own fresh read.
    const laterEdit = await page.request.post('/api/work-items', {
      headers: { origin: baseURL! },
      data: {
        key: randomUUID(),
        id: item.id,
        expectedRevision: edit.revision,
        detail: 'After another edit.',
      },
    });
    expect(laterEdit.ok()).toBe(true);
    let laterSettled = false;
    const laterRequested = requestRefresh('later');
    void laterRequested.then(() => (laterSettled = true));
    await dispatched('later');
    release[1]!();
    expect((await requested).every(Boolean)).toBe(true);
    await expect.poll(() => retained[2]?.detail).toBe('After another edit.');
    expect(laterSettled).toBe(false);
    expect(reads).toBe(3);
    expect(maximumActive).toBe(1);
    release[2]!();
    expect((await laterRequested).every(Boolean)).toBe(true);
    await expect(row.locator('.todo-detail')).toHaveText('After another edit.');

    await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
    await expect.poll(() => retained[3]?.detail).toBe('After another edit.');
    const canceled = requestRefresh('leaving');
    await dispatched('leaving');
    leaving = true;
    await page.evaluate(() => (location.hash = '#/chats'));
    await expect(row).toHaveCount(0);
    expect((await canceled).some((ok) => !ok)).toBe(true);
    expect(reads).toBe(4);
    expect(maximumActive).toBe(1);
    release[3]!();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  } finally {
    release.forEach((done) => done());
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

test('a lost direct ticket reply survives reload and confirms one worker without a manager turn', async ({
  page,
  baseURL,
}, info) => {
  const title = `Direct ticket ${info.project.name} ${randomUUID()}`;
  const scheduler = await (await page.request.get('/api/scheduler')).json();
  const pause = await page.request.post('/api/scheduler/settings', {
    headers: { origin: baseURL! },
    data: { key: randomUUID(), settings: { ...scheduler.settings, paused: true } },
  });
  expect(pause.ok()).toBe(true);
  let taskId: string | undefined;
  try {
    const projectResponse = await page.request.post('/api/projects', {
      headers: { origin: baseURL! },
      data: { key: randomUUID(), name: title, provider: 'codex' },
    });
    expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
    const project = await projectResponse.json();
    const response = await page.request.post('/api/work-items', {
      headers: { origin: baseURL! },
      data: { key: randomUUID(), title },
    });
    const item = workItemSchema.parse(await response.json());
    const submissions: Record<string, unknown>[] = [];
    await page.route('**/api/work-items/tickets', async (route) => {
      submissions.push(route.request().postDataJSON());
      const saved = await route.fetch();
      expect(saved.ok()).toBe(true);
      taskId = (await saved.json()).task.id;
      if (submissions.length === 1)
        return route.fulfill({ status: 502, json: { error: 'Ticket response lost' } });
      return route.fulfill({ response: saved });
    });
    await page.goto('/#/home');
    const row = page.locator('.todo-list > li').filter({ hasText: title });
    await row.getByRole('button', { name: 'Send to project', exact: true }).click();
    const form = page.getByRole('form', { name: 'Package a QUARK ticket' });
    await form.getByRole('combobox', { name: 'Send to', exact: true }).selectOption(project.id);
    await form.getByRole('slider', { name: 'Priority', exact: true }).press('End');
    await form.getByRole('slider', { name: 'Estimated compute', exact: true }).press('Home');
    await form.getByRole('slider', { name: 'Estimated compute', exact: true }).press('ArrowRight');
    await form.getByRole('button', { name: 'Queue with QUARK', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Ticket response lost');
    await expect(row).toContainText('QUARK ticket');
    await page.reload();
    await page.getByRole('button', { name: 'Retry ticket save' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Queued' })).toContainText(title);
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
    const items = workItemsSchema.parse(await (await page.request.get('/api/work-items')).json());
    const assigned = items.items.find((source) => source.id === item.id)!;
    expect(assigned).toMatchObject({ revision: 2, taskId, assignmentRunId: null });
    expect(assigned.ownerTicketId).toBeTruthy();
    const state = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
    expect(state.tasks.filter((task) => task.id === taskId)).toHaveLength(1);
    expect(state.agents.filter((agent) => agent.taskId === taskId)).toHaveLength(1);
    const queue = await (await page.request.get('/api/scheduler')).json();
    expect(
      queue.items.filter((run: { agentId: string }) => run.agentId === project.managerId),
    ).toEqual([]);
    await expect(row).toContainText('priority 5/5 · compute 2/5');
    await expect(row).toContainText('task working');
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    if (taskId) {
      const cancelled = await page.request.post(`/api/tasks/${taskId}/cancel`, {
        headers: { origin: baseURL! },
        data: { key: randomUUID(), reason: 'Owned browser fixture completed.' },
      });
      expect(cancelled.ok(), await cancelled.text()).toBe(true);
    }
    const restored = await page.request.post('/api/scheduler/settings', {
      headers: { origin: baseURL! },
      data: { key: randomUUID(), settings: scheduler.settings },
    });
    expect(restored.ok()).toBe(true);
  }
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
