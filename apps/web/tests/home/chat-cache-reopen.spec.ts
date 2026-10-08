import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { detailSchema, snapshotSchema } from '@dock/shared';

test('reopening keeps saved text while refreshing, without a blank introduction or model call', async ({
  page,
}, info) => {
  const state = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = state.projects.find((p) => !p.internal)!;
  const agent = state.agents.find((a) => a.id === project.managerId)!;
  agent.name = `${project.name} manager`;
  agent.status = 'idle';
  const detail = detailSchema.parse(
    await (await page.request.get(`/api/agents/${agent.id}`)).json(),
  );
  const saved = {
    ...detail,
    agent,
    runs: [],
    hasMore: false,
    entries: [
      {
        id: randomUUID(),
        agentId: agent.id,
        runId: null,
        status: 'complete',
        kind: 'assistant',
        title: 'Answer',
        text: 'The retained answer is still readable.',
        createdAt: new Date().toISOString(),
      },
    ],
  };
  let delay = false;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const starts: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(?:send|commands|run-recovery|spawn|quark\/chat)(?:\?|$)/.test(request.url())
    )
      starts.push(request.url());
  });
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: state }));
  await page.route(new RegExp(`/api/agents/${agent.id}(?:\\?.*)?$`), async (route) => {
    if (delay) await waiting;
    await route.fulfill({ json: saved });
  });
  await page.goto(`/#/chat/${agent.id}`);
  await expect(
    page.getByText('The retained answer is still readable.', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.chat-pane-title h1')).toHaveText(project.name);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const open = indexedDB.open('swa-read-cache', 1);
            open.onsuccess = () => {
              const db = open.result;
              const request = db.transaction('meta').objectStore('meta').count();
              request.onsuccess = () => {
                resolve(request.result);
                db.close();
              };
            };
          }),
      ),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    location.hash = '#/chats';
  });
  await expect(page.locator('.flow-chat-main')).toHaveCount(0);
  delay = true;
  await page.evaluate((id) => {
    location.hash = `#/chat/${id}`;
  }, agent.id);
  await expect(
    page.getByText('The retained answer is still readable.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Saved messages · updating…', { exact: true })).toBeVisible();
  await expect(page.locator('.conversation-intro')).toHaveCount(0);
  await expect(page.locator('.conversation-scroll-hint, .home-scroll-hint')).toHaveCount(0);
  await page.locator('.composer textarea').fill('Unsent while reconnecting');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('saved-chat-refreshing.png') });
  release();
  await expect(page.getByText('Saved messages · updating…', { exact: true })).toHaveCount(0);
  expect(starts).toEqual([]);
});
