import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const WebSocket = require('ws') as typeof import('ws').default;

test('manager prompts page through tool-only history, retry the failed page and preserve the draft', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const manager = snapshot.agents.find((agent: { role: string }) => agent.role === 'manager');
  const base = await (await page.request.get(`/api/agents/${manager.id}`)).json();
  const entries = Array.from({ length: 600 }, (_, index) => ({
    id: randomUUID(),
    agentId: manager.id,
    runId: null,
    kind: index === 20 || index === 420 ? 'user' : index === 180 ? 'system' : 'assistant',
    title: index === 180 ? 'Owner steering' : index === 20 || index === 420 ? 'You' : manager.name,
    text:
      index === 20
        ? 'Find my original experiment prompt 🧪'
        : index === 21
          ? 'The original experiment answer.'
          : index === 180
            ? 'Steer the original experiment toward persistence.'
            : index === 420
              ? 'My current prompt'
              : index === 599
                ? 'The latest answer.'
                : `Retained conversation ${index}`,
    status: 'complete',
    createdAt: new Date(Date.UTC(2026, 9, 1, 10) + index * 60_000).toISOString(),
  }));
  const beforeReads: string[] = [];
  let failOlder = true;
  const writes: string[] = [];
  page.on('request', (request) => {
    if (
      /\/agents\/[^/]+\/(messages|commands|native-commands)$/.test(
        new URL(request.url()).pathname,
      ) &&
      request.method() === 'POST'
    )
      writes.push(request.url());
  });
  await page.route(new RegExp(`/api/agents/${manager.id}(?:\\?.*)?$`), async (route) => {
    const before = new URL(route.request().url()).searchParams.get('before');
    if (before) {
      beforeReads.push(before);
      if (failOlder) {
        failOlder = false;
        return route.fulfill({
          status: 503,
          json: { error: 'History is temporarily unavailable.' },
        });
      }
    }
    const end = before ? entries.findIndex((entry) => entry.id === before) : entries.length;
    return route.fulfill({
      json: {
        ...base,
        entries: entries.slice(Math.max(0, end - 200), end),
        runs: [],
        hasMore: end > 200,
      },
    });
  });
  await page.goto(`/#/chat/${manager.id}`);
  const composer = page.getByRole('textbox', { name: `Message ${manager.name}`, exact: true });
  await expect(page.getByText('The latest answer.', { exact: true })).toBeVisible();
  await composer.fill('Keep my unsent experiment draft 🧪');
  await expect(
    page.getByRole('button', { name: 'Load earlier messages', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Your prompts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Your prompts', exact: true });
  await expect(dialog.getByRole('button', { name: /My current prompt/ })).toBeVisible();
  expect(beforeReads).toEqual([]);
  await dialog.getByRole('button', { name: 'Older prompts', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('History is temporarily unavailable.');
  await expect(dialog.getByRole('button', { name: /My current prompt/ })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(dialog).toContainText('No prompts on this page. Try Older prompts.');
  expect(beforeReads).toEqual([entries[400]!.id, entries[400]!.id]);
  await dialog.getByRole('button', { name: 'Older prompts', exact: true }).click();
  await expect(dialog.locator('time').first()).toBeVisible();
  await dialog.getByRole('button', { name: /Find my original experiment prompt/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.message.prompt-selected')).toBeInViewport();
  await expect(page.getByText('The original experiment answer.', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('Keep my unsent experiment draft 🧪');
  await expect(composer).toBeInViewport();
  await page.getByRole('button', { name: 'Continue reading', exact: true }).click();
  await expect(page.getByText('Retained conversation 200', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to latest', exact: true }).click();
  await expect(page.getByText('The latest answer.', { exact: true })).toBeVisible();
  // Steering has the same owner bubble and can be selected directly.
  await page.getByRole('button', { name: 'Your prompts', exact: true }).click();
  await dialog.getByRole('button', { name: 'Older prompts', exact: true }).click();
  await dialog.getByRole('button', { name: 'Older prompts', exact: true }).click();
  await dialog.getByRole('button', { name: /Steer the original experiment/ }).click();
  await expect(page.locator('.message.prompt-selected')).toBeInViewport();
  await expect(page.locator('.message.prompt-selected')).toContainText(
    'Steer the original experiment',
  );
  await page.getByRole('button', { name: 'Back to latest', exact: true }).click();
  await expect(page.getByText('The latest answer.', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('Keep my unsent experiment draft 🧪');
  expect(writes).toEqual([]);
});

test('shared prompts open a bounded surrounding page and return to the live tail without sending', async ({
  page,
}) => {
  const entries = Array.from({ length: 120 }, (_, index) => ({
    id: `prompt-history-${index}`,
    role: index === 5 || index === 85 ? 'user' : 'assistant',
    text:
      index === 5
        ? 'The first shared experiment prompt'
        : index === 6
          ? 'The answer around that shared prompt.'
          : index === 85
            ? 'The current shared prompt'
            : index === 119
              ? 'Latest shared answer.'
              : `Shared answer ${index}`,
  }));
  const window = {
    windowId: randomUUID(),
    provider: 'codex',
    label: 'Prompt navigation fixture',
    threadId: randomUUID(),
    title: 'Shared prompt navigation',
    status: 'idle',
    message: '',
  };
  const socket = new WebSocket('ws://127.0.0.1:4339/api/vscode/bridge');
  const commands: string[] = [];
  socket.on('message', (raw) => {
    const command = JSON.parse(raw.toString());
    commands.push(command.type);
    if (command.type === 'read') {
      const text = JSON.stringify({ ...window, entries });
      for (let offset = 0; offset < text.length; offset += 4096)
        socket.send(
          JSON.stringify({
            type: 'chunk',
            id: command.id,
            text: text.slice(offset, offset + 4096),
            last: offset + 4096 >= text.length,
          }),
        );
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'hello', window }));
    await expect
      .poll(async () =>
        (await (await page.request.get('/api/vscode/windows')).json()).some(
          (value: { windowId: string }) => value.windowId === window.windowId,
        ),
      )
      .toBe(true);
    await page.goto('/#/vscode');
    await page.getByRole('button', { name: /Shared prompt navigation/ }).click();
    await expect(page.getByText('Latest shared answer.', { exact: true })).toBeVisible();
    const composer = page.getByLabel('Message Codex');
    await composer.fill('Shared draft stays here');
    const nav = page.getByRole('navigation', { name: 'Conversation history', exact: true });
    await expect(nav.getByRole('button')).toHaveCount(1);
    await nav.getByRole('button', { name: 'Your prompts', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Your prompts', exact: true });
    await expect(dialog.getByRole('button', { name: /The current shared prompt/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Older prompts', exact: true }).click();
    await expect(dialog).toContainText('No prompts on this page. Try Older prompts.');
    await dialog.getByRole('button', { name: 'Older prompts', exact: true }).click();
    await dialog.getByRole('button', { name: /The first shared experiment prompt/ }).click();
    await expect(page.locator('.mirror-message.prompt-selected')).toBeInViewport();
    await expect(
      page.getByText('The answer around that shared prompt.', { exact: true }),
    ).toBeVisible();
    expect(await page.locator('.mirror-message').count()).toBeLessThanOrEqual(40);
    await expect(composer).toHaveValue('Shared draft stays here');
    await nav.getByRole('button', { name: 'Continue reading', exact: true }).click();
    await expect(page.getByText('Shared answer 40', { exact: true })).toBeVisible();
    await nav.getByRole('button', { name: 'Back to latest', exact: true }).click();
    await expect(page.getByText('Latest shared answer.', { exact: true })).toBeVisible();
    entries.push({
      id: 'new-live-answer',
      role: 'assistant',
      text: 'A live shared answer arrived.',
    });
    await expect(page.getByText('A live shared answer arrived.', { exact: true })).toBeVisible();
    await expect(composer).toHaveValue('Shared draft stays here');
    await expect(composer).toBeInViewport();
    expect(commands.every((type) => type === 'read')).toBe(true);
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.terminate();
      await closed;
    }
  }
});
