import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mirrorPage, type MirrorState, type MirrorCommand } from '@dock/shared';
const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const WebSocket = require('ws') as typeof import('ws').default;

test('an existing native Codex session opens from Chats, steers once and keeps native attention on the computer', async ({
  page,
}, info) => {
  const state: MirrorState = {
    windowId: randomUUID(),
    provider: 'codex',
    source: 'codex-daemon',
    label: 'Codex on this computer',
    threadId: randomUUID(),
    title: 'Existing terminal conversation',
    status: 'busy',
    message:
      'Same live Codex conversation. Simultaneous computer and phone input may join the same reply.',
    paged: true,
    groupedActivity: true,
    canSteer: true,
    steerToken: 'native-turn',
    stopToken: 'native-turn',
    entries: [
      { id: 'user', role: 'user', text: 'Finish the report in this terminal.' },
      { id: 'reply', role: 'assistant', text: 'The first section is complete.' },
      ...Array.from({ length: 250 }, (_, i) => ({
        id: `tool-${i}`,
        role: 'activity' as const,
        text: `commandExecution\nTool output ${i}`,
      })),
    ],
  };
  const workingEntries = state.entries;
  state.status = 'idle';
  state.entries = [];
  state.historyUnavailable = true;
  state.message =
    'Codex has not exposed this session’s history yet. You can send a message or read it on the computer.';
  delete state.steerToken;
  delete state.stopToken;
  const socket = new WebSocket('ws://127.0.0.1:4339/api/vscode/bridge');
  const writes: MirrorCommand[] = [];
  socket.on('message', (raw) => {
    const command = JSON.parse(raw.toString()) as MirrorCommand;
    let result: unknown;
    if (command.type === 'read') result = mirrorPage(state, command.page);
    else {
      writes.push(command);
      result = { state: 'sent', message: 'Sent guidance to this reply.' };
      if (command.type === 'send') {
        if (state.historyUnavailable) {
          state.historyUnavailable = false;
          state.message = '';
          state.entries = workingEntries;
          state.status = 'busy';
          state.steerToken = 'native-turn';
          state.stopToken = 'native-turn';
        } else state.entries.push({ id: 'steer', role: 'user', text: command.input.text });
      }
    }
    const text = JSON.stringify(result);
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
    const { entries: _, ...window } = state;
    socket.send(JSON.stringify({ type: 'hello', window }));
    await expect
      .poll(async () =>
        (await (await page.request.get('/api/vscode/windows')).json()).some(
          (x: { windowId: string }) => x.windowId === state.windowId,
        ),
      )
      .toBe(true);
    await page.goto('/#/chats');
    await page.getByRole('link', { name: /Existing terminal conversation/ }).click();
    await expect(page.getByText(state.message, { exact: true })).toBeVisible();
    await expect(
      page.getByText('No messages yet. Say hello when the conversation is ready.'),
    ).toHaveCount(0);
    await page.getByLabel('Message Codex').fill('Finish the report in this terminal.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByLabel('Message Codex')).toHaveValue('');
    expect(writes[0]).toMatchObject({
      type: 'send',
      input: { text: 'Finish the report in this terminal.' },
    });
    expect(writes[0].type === 'send' && writes[0].input.expectedTurnId).toBeUndefined();
    await expect(page.getByText('The first section is complete.', { exact: true })).toBeVisible();
    await expect(page.locator('.mirror-activity-group > summary')).toContainText('250 actions');
    await expect(page.getByLabel('Message Codex')).toBeInViewport();
    const chat = page.locator('.mirror-conversation');
    // A native session must not tell the person to install/reload/share VS Code.
    await expect(chat).not.toContainText(
      /Share a Conversation in VS Code|update.*companion|Same conversation as VS Code/,
    );
    await page.getByLabel('Message Codex').fill('Use the shorter conclusion.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByLabel('Message Codex')).toHaveValue('');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({
      type: 'send',
      input: {
        threadId: state.threadId,
        expectedTurnId: 'native-turn',
        text: 'Use the shorter conclusion.',
      },
    });
    state.status = 'attention';
    state.message = 'Codex needs your attention on the computer. Native permissions remain there.';
    delete state.steerToken;
    delete state.stopToken;
    await expect(page.getByText(state.message, { exact: true })).toBeVisible();
    await page.getByLabel('Message Codex').fill('Retain this draft while I check.');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.getByLabel('Message Codex')).toHaveValue('Retain this draft while I check.');
    expect(writes).toHaveLength(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `../../data/screenshots/mirror/${info.project.name}-daemon-session.png`,
    });
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.terminate();
      await closed;
    }
  }
});
