import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const WebSocket = require('ws') as typeof import('ws').default;

// A real bridge sends the full legacy response, so the server must bound phone traffic.
// Optional private reproduction data stays outside the tracked repository.
test('large shared history stays responsive, paged and usable on a phone', async ({
  page,
}, info) => {
  const supplied = process.env.DOCK_MIRROR_REPLAY;
  const entries = supplied
    ? JSON.parse(readFileSync(supplied, 'utf8')).entries
    : Array.from({ length: 6309 }, (_, i) => ({
        id: `entry-${i}`,
        role: i % 12 ? 'activity' : 'assistant',
        text: `commandExecution ${i}\n${'Saved output with enough text to reproduce a long native conversation. '.repeat(48)}`,
      }));
  entries.push({
    id: 'large-last',
    role: 'activity',
    text: `Large final tool result\n${'part of a long tool result\n'.repeat(14000)}`,
  });
  entries.push({ id: 'last-reply', role: 'assistant', text: 'Latest reply ready on your phone.' });
  const window = {
    windowId: randomUUID(),
    provider: 'codex',
    label: 'Long history fixture',
    threadId: randomUUID(),
    title: 'Large shared conversation',
    status: 'idle',
    message: '',
  };
  const socket = new WebSocket('ws://127.0.0.1:4339/api/vscode/bridge');
  const sends: unknown[] = [];
  socket.on('message', (raw) => {
    const command = JSON.parse(raw.toString());
    if (command.type !== 'read') {
      sends.push(command);
      return;
    }
    const text = JSON.stringify({ ...window, entries });
    for (let i = 0; i < text.length; i += 4096)
      socket.send(
        JSON.stringify({
          type: 'chunk',
          id: command.id,
          text: text.slice(i, i + 4096),
          last: i + 4096 >= text.length,
        }),
      );
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
          (x: { windowId: string }) => x.windowId === window.windowId,
        ),
      )
      .toBe(true);
    const response = await page.request.get(`/api/vscode/windows/${window.windowId}`);
    const bytes = (await response.body()).length;
    expect(bytes).toBeLessThan(100_000);
    await page.goto('/#/vscode');
    const started = Date.now();
    await page.getByRole('button', { name: /Large shared conversation/ }).click();
    await expect(
      page.getByText('Latest reply ready on your phone.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Message Codex')).toBeInViewport();
    const openMs = Date.now() - started;
    expect(
      await page.locator('.mirror-message, .mirror-activity-group').count(),
    ).toBeLessThanOrEqual(40);
    expect(await page.locator('.mirror-activity pre').count()).toBe(0);
    await page.getByLabel('Message Codex').fill('Keep this unsent draft');
    await page.locator('.mirror-activity-group').last().locator('summary').first().click();
    const tool = page.locator('.mirror-activity').filter({ hasText: 'Large final tool result' });
    await tool.locator('summary').click();
    await expect(tool.locator('pre')).toBeVisible();
    await tool.getByRole('button', { name: 'Next part', exact: true }).click();
    await expect(tool).toContainText('characters 8001');
    await tool.getByRole('button', { name: 'Previous part', exact: true }).click();
    await expect(tool).toContainText('characters 1–8000');
    await tool.locator('summary').click();
    await page.getByRole('button', { name: 'Older messages', exact: true }).click();
    await expect(page.getByText('Earlier history', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Newer messages', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Back to latest', exact: true }).click();
    await expect(
      page.getByText('Latest reply ready on your phone.', { exact: true }),
    ).toBeVisible();
    entries.push({ id: 'live-reply', role: 'assistant', text: 'A new live reply arrived.' });
    await expect(page.getByText('A new live reply arrived.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Message Codex')).toHaveValue('Keep this unsent draft');
    await expect(page.getByLabel('Message Codex')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `../../data/mirror-phone-freeze/${info.project.name}-history.png`,
    });
    await page.getByRole('link', { name: 'All editor chats', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'From your editor, to here.' })).toBeVisible();
    expect(sends).toEqual([]);
    console.log(
      JSON.stringify({
        viewport: info.project.name,
        entries: entries.length,
        bytes,
        openMs,
        privateReplay: !!supplied,
      }),
    );
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.terminate();
      await closed;
    }
  }
});
