import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../../../server/dist/store.js';
import { parseCapacity } from '../../../server/dist/capacity.js';

test('board budget sliders save durable caps, retry lost replies and respect concurrent changes', async ({
  page,
  baseURL,
}, info) => {
  const headers = { Origin: baseURL! };
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  expect(snapshot.provider.version).toBe('demo');
  const fixtureRoot = resolve(process.env.DOCK_E2E_DATA_DIR ?? '../../data/browser-data/home');
  const database = join(fixtureRoot, 'demo', 'dock.sqlite');
  expect(existsSync(database)).toBe(true);
  const store = new Store(database);
  try {
    store.setSetting(
      'capacity:v1:codex',
      parseCapacity(
        'codex',
        [
          {
            provider: 'codex',
            source: 'oauth',
            usage: {
              updatedAt: new Date().toISOString(),
              secondary: {
                usedPercent: 6,
                windowMinutes: 10080,
                resetsAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
              },
            },
          },
        ],
        Date.now(),
      ),
    );
  } finally {
    store.close();
  }
  const project = snapshot.projects.find((p: { internal?: boolean }) => !p.internal);
  const taskResult = await page.request.post(`/api/projects/${project.id}/tasks`, {
    headers,
    data: {
      key: crypto.randomUUID(),
      task: {
        title: `Budget slider ${info.project.name} ${crypto.randomUUID().slice(0, 8)}`,
        goal: 'Fixture only',
        acceptance: 'Retain budget changes',
        parentId: null,
      },
    },
  });
  expect(taskResult.ok()).toBe(true);
  const task = await taskResult.json();
  const capacities = await (await page.request.get('/api/capacity')).json();
  const provider = capacities.providers.find((p: { provider: string }) => p.provider === 'codex');
  const window = provider.windows.find((w: { scope: string }) => w.scope === 'general');
  const response = await page.request.post('/api/quark/budgets', {
    headers,
    data: {
      key: crypto.randomUUID(),
      projectId: project.id,
      taskId: task.id,
      provider: 'codex',
      windowId: window.id,
      limitPercent: 10,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const original = (await response.json()).budgets.find(
    (b: { taskId: string }) => b.taskId === task.id,
  );
  const writes: Record<string, unknown>[] = [];
  let loseReply = true;
  await page.route('**/api/quark/budgets', async (route) => {
    writes.push(route.request().postDataJSON());
    const result = await route.fetch(); // Actual write; the first successful reply is lost.
    if (loseReply) {
      loseReply = false;
      return route.fulfill({
        status: 502,
        json: { error: 'Save response lost. Retry to confirm.' },
      });
    }
    return route.fulfill({ response: result });
  });
  await page.goto('/#/work');
  const card = page
    .locator('.quark-ticket')
    .filter({ has: page.getByRole('link', { name: task.title, exact: true }) });
  const slider = card.getByRole('slider');
  await expect(slider).toHaveValue('10');
  expect(writes).toHaveLength(0); // Viewing never creates a budget or starts work.
  await slider.focus();
  await slider.press('End');
  await expect(card.getByRole('alert')).toContainText('Save response lost');
  await card.getByRole('button', { name: 'Retry save' }).click();
  await expect(card.getByRole('status')).toHaveText('Saved');
  expect(writes).toHaveLength(2);
  expect(writes[0]).toEqual(writes[1]);
  const readBudget = async () =>
    (await (await page.request.get('/api/quark')).json()).budgets.find(
      (b: { id: string }) => b.id === original.id,
    );
  let saved = await readBudget();
  expect(saved.limitPercent).toBe(100);
  expect(saved.revision).toBe(original.revision + 1);
  expect(saved.startSequence).toBe(original.startSequence);
  await page.reload();
  await expect(slider).toHaveValue('100');
  // A pointer gesture previews locally and writes once on release, not at each movement.
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 5 });
  expect(writes).toHaveLength(2);
  const preview = Number(await slider.inputValue());
  expect(preview).toBeLessThan(100);
  await page.mouse.up();
  await expect.poll(async () => (await readBudget()).limitPercent).toBe(preview);
  await expect(card.getByRole('status')).toHaveText('Saved');
  expect(writes).toHaveLength(3);
  // A different device changes the cap during this user's next gesture.
  saved = await readBudget();
  await slider.focus();
  await page.keyboard.down('ArrowRight');
  const changed = await page.request.post('/api/quark/budgets', {
    headers,
    data: {
      key: crypto.randomUUID(),
      id: saved.id,
      expectedRevision: saved.revision,
      projectId: saved.projectId,
      taskId: saved.taskId,
      provider: saved.provider,
      windowId: saved.windowId,
      limitPercent: 42,
    },
  });
  expect(changed.ok()).toBe(true);
  await page.keyboard.up('ArrowRight');
  await expect(card.getByRole('alert')).toContainText('Budget changed');
  await card.getByRole('button', { name: 'Use current budget' }).click();
  await expect(slider).toHaveValue('42');
  expect((await readBudget()).limitPercent).toBe(42);
  await expect(card.locator('.quark-budget-slider')).toContainText('42% left');
  if (info.project.use.hasTouch) {
    await slider.scrollIntoViewIfNeeded();
    const touchBox = (await slider.boundingBox())!;
    await page.touchscreen.tap(
      touchBox.x + touchBox.width * 0.65,
      touchBox.y + touchBox.height / 2,
    );
    const touched = Number(await slider.inputValue());
    expect(touched).toBeGreaterThan(42);
    await expect.poll(async () => (await readBudget()).limitPercent).toBe(touched);
    await expect(card.getByRole('status')).toHaveText('Saved');
    await expect(page).toHaveURL(/#\/work$/);
  }
  await card.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('board-budget-slider.png') });
});

test('copy-prompt help has no extra settings, computer or allowance links', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Help and setup', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'Help and setup' });
  await expect(help.locator('.setup-prompt')).toHaveCount(2);
  for (const name of ['Settings', 'Computers and accounts', 'Usage and allowances'])
    await expect(help.getByRole('link', { name, exact: true })).toHaveCount(0);
});
