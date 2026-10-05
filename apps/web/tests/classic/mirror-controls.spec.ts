import { test, expect } from './fixture';
import { randomUUID } from 'node:crypto';

test('stop reply preserves drafts and uses only read-only receipt checks after uncertainty', async ({
  page,
}) => {
  const state = {
    windowId: randomUUID(),
    threadId: 'stop-fixture',
    provider: 'claude',
    label: 'Fixture computer',
    title: 'Working Claude chat',
    status: 'busy',
    message: '',
    stopToken: 'turn-one',
    entries: [{ id: 'reply', role: 'assistant', text: 'Working on your request' }],
  };
  const controls: Record<string, string>[] = [];
  let checks = 0;
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) => route.fulfill({ json: [state] }));
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: state }),
  );
  await page.route(`**/api/vscode/windows/${state.windowId}/control`, (route) => {
    controls.push(route.request().postDataJSON());
    return route.abort('failed');
  });
  await page.route('**/api/vscode/deliveries/*', (route) => {
    checks++;
    expect(route.request().method()).toBe('GET');
    expect(route.request().url()).toContain(controls[0]!.key);
    return route.fulfill({
      json: {
        state: 'sent',
        message: 'Stop requested for this reply. Completed actions are not undone.',
      },
    });
  });
  await page.goto('/?mirror=1');
  await page.getByLabel('Message Claude Code').fill('Keep my next question');
  await expect(page.getByRole('button', { name: 'Stop reply', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check stop status' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Check stop status' }).click();
  await expect(
    page.getByText('Stop requested for this reply. Completed actions are not undone.'),
  ).toBeVisible();
  await expect(page.getByLabel('Message Claude Code')).toHaveValue('Keep my next question');
  expect(controls).toEqual([
    {
      key: expect.any(String),
      threadId: state.threadId,
      provider: 'claude',
      action: 'interrupt',
      token: 'turn-one',
    },
  ]);
  expect(checks).toBe(1);
  await expect(page.getByRole('button', { name: 'Stop reply', exact: true })).toBeDisabled();
  state.stopToken = 'turn-two';
  await expect(page.getByRole('button', { name: 'Stop reply', exact: true })).toBeEnabled();
  await page.unrouteAll({ behavior: 'wait' });
});

test('old companions keep plain chat without a nonfunctional stop button', async ({ page }) => {
  const state = {
    windowId: randomUUID(),
    threadId: 'old-bridge',
    label: 'Computer',
    title: 'Older companion',
    status: 'busy',
    message: '',
    entries: [],
  };
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) => route.fulfill({ json: [state] }));
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: state }),
  );
  await page.goto('/?mirror=1');
  await expect(page.getByText('Codex is working…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop reply', exact: true })).toHaveCount(0);
  await page.getByLabel('Message Codex').fill('A separate draft');
  await expect(page.getByLabel('Message Codex')).toHaveValue('A separate draft');
  await page.unrouteAll({ behavior: 'wait' });
});
