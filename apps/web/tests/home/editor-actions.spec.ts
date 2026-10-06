import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const owned = new WeakMap<object, string>();
test.afterEach(async ({ page, baseURL }) => {
  await page.unrouteAll({ behavior: 'wait' });
  const agentId = owned.get(page);
  if (!agentId) return;
  const removed = await page.request.post(`/api/agents/${agentId}/remove`, {
    headers: { Origin: baseURL! },
    data: { key: randomUUID() },
  });
  expect(removed.ok()).toBe(true);
});

test('an unconfirmed editor launch requires deliberate Open again for a new receipt', async ({
  page,
  baseURL,
}, info) => {
  const response = await page.request.post('/api/projects', {
    headers: { Origin: baseURL! },
    data: { key: randomUUID(), name: `Editor ${randomUUID().slice(0, 8)}`, provider: 'codex' },
  });
  expect(response.ok()).toBe(true);
  const { managerId: id } = await response.json();
  owned.set(page, id);
  const detail = await (await page.request.get(`/api/agents/${id}`)).json();
  const calls: { url: string; key: string }[] = [];
  await page.route('**/api/projects/*/open-in-editor', async (route) => {
    calls.push({
      url: new URL(route.request().url()).pathname,
      key: route.request().postDataJSON().key,
    });
    if (calls.length === 1)
      return route.fulfill({
        status: 500,
        json: { error: 'VS Code is unavailable on this computer.' },
      });
    if (calls.length === 2)
      return route.fulfill({
        status: 409,
        json: { error: 'This command has an uncertain or failed outcome.' },
      });
    return route.fulfill({
      json: { opened: true, message: 'Opened in VS Code on this project’s computer.' },
    });
  });
  await page.goto(`/#/chat/${id}`);
  const button = page
    .getByRole('group', { name: 'Conversation tools' })
    .getByRole('button', { name: 'Open project in VS Code' });
  await button.click();
  const feedback = page.locator('.chat-editor-status');
  await expect(feedback).toContainText('Opening wasn’t confirmed.');
  await expect(feedback).toContainText('may open another window');
  expect(calls).toHaveLength(1);
  expect(
    await feedback.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
    }),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('editor-deliberate-retry.png') });
  await page.clock.install();
  await page.clock.fastForward(9000);
  await expect(feedback.getByRole('button', { name: 'Open again', exact: true })).toBeVisible();
  await button.click();
  await expect(feedback).toContainText('Opening wasn’t confirmed.');
  await expect(feedback).not.toContainText('This command has an uncertain or failed outcome');
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  await feedback.getByRole('button', { name: 'Open again', exact: true }).click();
  await expect(feedback).toContainText('Opened in VS Code');
  await expect(feedback.getByRole('button', { name: 'Open again', exact: true })).toHaveCount(0);
  expect(calls).toHaveLength(3);
  expect(calls[2].key).not.toBe(calls[0].key);
  expect(calls.map((call) => call.url)).toEqual(
    Array(3).fill(`/api/projects/${detail.agent.projectId}/open-in-editor`),
  );
});
