import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  mirrorPage,
  mirrorQueuedMessagesSchema,
  mirrorQueuedMessageSchema,
  type MirrorState,
  type MirrorCommand,
} from '@dock/shared';
const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const WebSocket = require('ws') as typeof import('ws').default;

for (const provider of ['codex', 'claude'] as const)
  test(`a busy shared ${provider} chat keeps messages visible and sends once after a lost response`, async ({
    page,
    baseURL,
  }, info) => {
    const name = provider === 'codex' ? 'Codex' : 'Claude Code';
    const state: MirrorState = {
      windowId: randomUUID(),
      provider,
      label: 'Test editor',
      threadId: randomUUID(),
      title: 'Ongoing project',
      status: 'busy',
      message: '',
      paged: true,
      groupedActivity: true,
      ...(provider === 'codex'
        ? { canSteer: true, steerToken: 'current-turn' }
        : { canQueue: true }),
      entries: [
        { id: 'question', role: 'user', text: 'Keep working on the whole project.' },
        {
          id: 'progress',
          role: 'assistant',
          text: 'I have finished setup and am implementing chat.',
        },
        ...Array.from({ length: 700 }, (_, i) => ({
          id: `tool-${i}`,
          role: 'activity' as const,
          text: `commandExecution\nPrivate tool detail ${i}`,
        })),
      ],
    };
    const socket = new WebSocket('ws://127.0.0.1:4339/api/vscode/bridge');
    const writes: MirrorCommand[] = [];
    const queued = async () =>
      mirrorQueuedMessagesSchema.parse(
        await (
          await page.request.get(
            `/api/vscode/queued?provider=${provider}&threadId=${state.threadId}`,
          )
        ).json(),
      ).items;
    socket.on('message', (raw) => {
      const command = JSON.parse(raw.toString()) as MirrorCommand;
      let value: unknown;
      if (command.type === 'read') value = mirrorPage(state, command.page);
      else {
        writes.push(command);
        value = { state: 'sent', message: 'Update sent to the current reply.' };
        if (command.type === 'send')
          state.entries.push({ id: 'steer-message', role: 'user', text: command.input.text });
      }
      const text = JSON.stringify(value);
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
            (item: { windowId: string }) => item.windowId === state.windowId,
          ),
        )
        .toBe(true);
      await page.goto('/#/vscode');
      await page.getByRole('button', { name: /Ongoing project/ }).click();
      await expect(
        page.getByText('Keep working on the whole project.', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText('I have finished setup and am implementing chat.', { exact: true }),
      ).toBeVisible();
      await expect(page.locator('.mirror-activity-group > summary')).toContainText('700 actions');
      await expect(page.locator('.mirror-activity')).toHaveCount(0);
      await expect(page.locator('.mirror-message').first()).toBeInViewport();
      await expect(page.getByLabel(`Message ${name}`)).toBeInViewport();
      await info.attach('shared-chat-reading-space', {
        contentType: 'application/json',
        body: JSON.stringify({
          viewport: page.viewportSize(),
          history: await page.locator('.mirror-log').boundingBox(),
          composer: await page.locator('.mirror-composer').boundingBox(),
        }),
      });
      await page.screenshot({
        path: `../../data/screenshots/mirror/${info.project.name}-${provider}-working-chat.png`,
      });
      await page.locator('.mirror-activity-group > summary').click();
      await expect(page.locator('.mirror-activity')).toHaveCount(40);
      await page.getByRole('button', { name: 'Earlier activity', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Later activity', exact: true })).toBeEnabled();
      await page.locator('.mirror-activity-group > summary').click();
      let submissions = 0;
      await page.route('**/api/vscode/windows/*/send', async (route) => {
        submissions++;
        await route.fetch();
        await route.fulfill({ status: 502, json: { error: 'Response lost' } });
      });
      await page.getByLabel(`Message ${name}`).fill('Make the phone chat simpler.');
      await page
        .getByRole('button', {
          name: provider === 'codex' ? 'Send' : 'Queue follow-up',
          exact: true,
        })
        .click();
      await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeEnabled();
      await expect(page.getByLabel(`Message ${name}`)).toHaveValue('Make the phone chat simpler.');
      if (provider === 'claude') {
        await expect.poll(async () => (await queued()).length).toBe(1);
        expect((await queued())[0]).toMatchObject({
          status: 'queued',
          text: 'Make the phone chat simpler.',
        });
        expect(writes).toHaveLength(0);
      }
      await page.reload();
      await page.getByRole('button', { name: 'Check delivery', exact: true }).click();
      await expect(page.getByLabel(`Message ${name}`)).toHaveValue('');
      expect(submissions).toBe(1);
      if (provider === 'claude') {
        expect(await queued()).toHaveLength(1);
        expect(writes).toHaveLength(0);
        state.status = 'idle';
        await expect.poll(() => writes.length).toBe(1);
        await expect.poll(async () => (await queued()).length).toBe(0);
      }
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        type: 'send',
        input: {
          ...(provider === 'codex' ? { expectedTurnId: 'current-turn' } : { provider: 'claude' }),
          text: 'Make the phone chat simpler.',
        },
      });
      if (provider === 'claude' && writes[0].type === 'send') {
        expect(writes[0].input.mode).toBeUndefined();
        expect(writes[0].input.expectedTurnId).toBeUndefined();
      }
      await expect(
        page.locator('.mirror-log').getByText('Make the phone chat simpler.', { exact: true }),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    } finally {
      await page.unrouteAll({ behavior: 'wait' });
      try {
        const items = await queued();
        if (items.length) {
          const headers = { Origin: baseURL! };
          const client = await (
            await page.request.post('/api/workspace/clients', {
              headers,
              data: { key: randomUUID(), label: 'Owned shared fixture cleanup' },
            })
          ).json();
          for (let item of items) {
            if (item.status === 'queued' && !item.queueEdit) {
              const held = await page.request.post(`/api/vscode/queued/${item.id}`, {
                headers,
                data: {
                  key: randomUUID(),
                  clientId: client.client.id,
                  revision: item.queueRevision,
                  action: 'edit',
                },
              });
              expect(held.ok()).toBe(true);
              item = mirrorQueuedMessageSchema.parse(await held.json());
            }
            expect(
              (
                await page.request.post(`/api/vscode/queued/${item.id}`, {
                  headers,
                  data: {
                    key: randomUUID(),
                    clientId: item.queueEdit?.clientId ?? client.client.id,
                    revision: item.queueRevision,
                    action: 'remove',
                  },
                })
              ).ok(),
            ).toBe(true);
          }
        }
      } finally {
        if (socket.readyState !== WebSocket.CLOSED) {
          const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
          socket.terminate();
          await closed;
        }
      }
    }
  });
