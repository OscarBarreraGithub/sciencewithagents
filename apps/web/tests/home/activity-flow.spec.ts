import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

test('the new Work screen operates the real queue with a single retry receipt and responsive local-work navigation', async ({
  page,
}, info) => {
  const before = await (await page.request.get('/api/scheduler')).json();
  const seen: Record<string, unknown>[] = [];
  try {
    const setup = await page.request.post('/api/scheduler/settings', {
      headers: { Origin: 'http://127.0.0.1:4339' },
      data: { key: randomUUID(), settings: { paused: false, maxConcurrent: 4 } },
    });
    expect(setup.status()).toBe(200);
    await page.route('**/api/scheduler/settings', async (route) => {
      seen.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (seen.length === 1)
        await route.fulfill({
          status: 502,
          json: { error: 'The response was lost. Retry uses the same request.' },
        });
      else await route.fulfill({ response });
    });
    // Hold an old queue reading until after the mutation's acknowledgement is lost.
    // A delayed refresh must not change the meaning of the retry button.
    let releaseReading!: () => void;
    let readingHeld!: () => void;
    const heldReading = new Promise<void>((resolve) => {
      readingHeld = resolve;
    });
    const readingGate = new Promise<void>((resolve) => {
      releaseReading = resolve;
    });
    let readings = 0;
    await page.route('**/api/scheduler', async (route) => {
      const response = await route.fetch();
      if (++readings === 2) {
        readingHeld();
        await readingGate;
      }
      await route.fulfill({ response });
    });
    await page.goto('/#/work');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Make room for what matters.');
    await page.getByText('Queue controls & local jobs', { exact: true }).click();
    await heldReading;
    await page.getByRole('button', { name: 'Pause new work', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('response was lost');
    releaseReading();
    await expect(page.getByRole('button', { name: 'Pause new work', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Retry queue change', exact: true }).click();
    await expect.poll(() => seen.length).toBe(2);
    expect(seen[0]).toEqual(seen[1]);
    await expect(
      page.getByRole('button', { name: 'Resume queued work', exact: true }),
    ).toBeVisible();
    await page.getByLabel('Concurrent work groups').selectOption('2');
    await page.getByRole('button', { name: 'Save work limit' }).click();
    await expect
      .poll(async () => (await (await page.request.get('/api/scheduler')).json()).settings)
      .toEqual({ paused: true, maxConcurrent: 2 });
    await expect(
      page.getByRole('button', { name: 'Resume queued work', exact: true }),
    ).toBeEnabled();
    await mkdir('../../data/screenshots/activity', { recursive: true });
    await page.screenshot({
      path: `../../data/screenshots/activity/${info.project.name}-work.png`,
    });
    await page.getByRole('link', { name: /Transcribe a video/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('From video to transcript.');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByLabel('YouTube video link').fill('https://www.youtube.com/watch?v=fixture');
    await page.getByRole('combobox', { name: 'Priority', exact: true }).selectOption('background');
    await page.reload();
    await expect(page.getByLabel('YouTube video link')).toHaveValue(
      'https://www.youtube.com/watch?v=fixture',
    );
    await expect(page.getByRole('combobox', { name: 'Priority', exact: true })).toHaveValue(
      'background',
    );
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
  } finally {
    await page.request.post('/api/scheduler/settings', {
      headers: { Origin: 'http://127.0.0.1:4339' },
      data: { key: randomUUID(), settings: before.settings },
    });
  }
});
async function reviewFixture(page: import('@playwright/test').Page, diverged = false) {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const task = snapshot.tasks[0];
  Object.assign(task, {
    title: 'Reviewed fieldnotes change',
    status: 'done',
    hasReviewedChanges: true,
    review: 'Independent reviewer checked persistence and recovery.',
  });
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  const preview = {
    taskId: task.id,
    source: 'a'.repeat(40),
    target: 'b'.repeat(40),
    changes: 'draft.ts | 4 ++++',
    patch: 'diff --git a/draft.ts b/draft.ts\n+Save each draft once.\n',
    canApply: !diverged,
    relation: diverged ? 'diverged' : 'fast-forward',
    reconciliationTaskId: null,
  };
  await page.route(`**/api/tasks/${task.id}/integration`, (route) =>
    route.fulfill({ json: preview }),
  );
  return { snapshot, task, preview };
}
test('Attention opens the original reviewed result and applies only after exact confirmation, retaining retry identity', async ({
  page,
}, info) => {
  const { task, preview } = await reviewFixture(page);
  const sent: Record<string, unknown>[] = [];
  await page.route(`**/api/tasks/${task.id}/integrate`, (route) => {
    sent.push(route.request().postDataJSON());
    return sent.length === 1
      ? route.fulfill({
          status: 502,
          json: { error: 'Connection lost. The exact confirmation is retained.' },
        })
      : route.fulfill({ json: preview });
  });
  await page.goto('/#/attention');
  await page.getByRole('link', { name: 'Review changes', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(task.title);
  await page.getByText('Read the full changes', { exact: true }).click();
  await expect(page.locator('.activity-diff pre').first()).toContainText('Save each draft once.');
  expect(sent).toHaveLength(0);
  await mkdir('../../data/screenshots/activity', { recursive: true });
  await page.screenshot({
    path: `../../data/screenshots/activity/${info.project.name}-review.png`,
  });
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
  await page.getByRole('button', { name: 'Keep reviewing', exact: true }).click();
  expect(sent).toHaveLength(0);
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm and apply changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('exact confirmation is retained');
  await page.getByRole('button', { name: 'Confirm and apply changes', exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[0]).toEqual(sent[1]);
  expect(sent[0]).toMatchObject({ source: preview.source, target: preview.target });
  await expect(page.getByRole('heading', { name: 'Changes are in your project.' })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
});
test('a divergent review has an explicit follow-up instead of applying or removing parallel work', async ({
  page,
}) => {
  const { snapshot, task, preview } = await reviewFixture(page, true);
  const followup = {
    ...task,
    id: randomUUID(),
    title: 'Update the fieldnotes result',
    status: 'open',
    hasReviewedChanges: false,
    parentId: task.id,
    review: null,
  };
  const calls: Record<string, unknown>[] = [];
  await page.route(`**/api/tasks/${task.id}/reconcile`, (route) => {
    calls.push(route.request().postDataJSON());
    snapshot.tasks.push(followup);
    task.reconciliationTaskId = followup.id;
    return route.fulfill({ json: followup });
  });
  await page.goto(`/#/review/${task.id}`);
  await expect(page.getByText('Your project moved forward.', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Apply reviewed changes', exact: true }),
  ).toHaveCount(0);
  expect(calls).toHaveLength(0);
  await page.getByRole('button', { name: 'Prepare updated changes', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(followup.title);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ source: preview.source, target: preview.target });
  await page.goto(`/#/review/${task.id}`);
  await page.getByRole('link', { name: 'Open follow-up task', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(followup.title);
});
