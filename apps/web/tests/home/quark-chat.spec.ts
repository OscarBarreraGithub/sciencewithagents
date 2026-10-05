import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { AgentDetail } from '@dock/shared';

// Only browser responses change. Every message POST is intercepted; no provider turn runs.
async function fixture(page: Page) {
  const state = await (await page.request.get('/api/snapshot')).json();
  const coordinator = await (await page.request.get('/api/quark/coordinator')).json();
  const original = state.agents.find(
    (agent: { role: string; parentId: string | null }) =>
      agent.role === 'manager' && !agent.parentId,
  );
  const agent = {
    ...original,
    name: 'QUARK',
    status: 'idle',
    provider: 'codex',
    archivedAt: undefined,
  };
  state.agents = state.agents.map((saved: { id: string }) =>
    saved.id === agent.id ? agent : saved,
  );
  coordinator.agentId = agent.id;
  coordinator.projectId = agent.projectId;
  const now = new Date().toISOString();
  const detail: AgentDetail = {
    agent,
    entries: [
      {
        id: randomUUID(),
        agentId: agent.id,
        runId: null,
        kind: 'assistant',
        title: '',
        text: 'Current saved scheduling explanation.',
        status: 'complete',
        createdAt: now,
      },
    ],
    runs: [],
    hasMore: true,
  };
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: state }));
  await page.route('**/api/quark/coordinator', (route) => route.fulfill({ json: coordinator }));
  return { state, coordinator, agent, detail, now };
}

test('QUARK fullscreen shows failed reads and sends, retains drafts, retries once and pages saved history', async ({
  page,
}, info) => {
  const { agent, detail, now } = await fixture(page);
  let unavailable = true;
  await page.route(`**/api/agents/${agent.id}*`, async (route) => {
    if (new URL(route.request().url()).pathname !== `/api/agents/${agent.id}`)
      return route.fallback();
    if (unavailable)
      return route.fulfill({
        status: 503,
        json: { error: 'Saved QUARK history is temporarily unavailable.' },
      });
    if (new URL(route.request().url()).searchParams.has('before'))
      return route.fulfill({
        json: {
          ...detail,
          hasMore: false,
          entries: [
            {
              id: randomUUID(),
              agentId: agent.id,
              runId: null,
              kind: 'user',
              title: 'You',
              text: 'Earlier owner instruction remains readable.',
              status: 'complete',
              createdAt: now,
            },
            ...detail.entries,
          ],
        },
      });
    return route.fulfill({ json: detail });
  });
  const attempts: { key: string; text: string; steer: boolean }[] = [];
  await page.route(`**/api/agents/${agent.id}/messages`, async (route) => {
    const input = route.request().postDataJSON();
    attempts.push(input);
    if (attempts.length === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'QUARK could not confirm this message. Retry checks the same request.' },
      });
    detail.entries.push({
      id: randomUUID(),
      agentId: agent.id,
      runId: null,
      kind: 'user',
      title: 'You',
      text: input.text,
      status: 'queued',
      createdAt: now,
    });
    return route.fulfill({ json: { queued: true } });
  });
  await page.goto('/#/work');
  await page.getByRole('button', { name: 'Open QUARK conversation', exact: true }).click();
  const full = page.getByRole('dialog', { name: 'QUARK conversation' });
  const notice = full.locator('.flow-chat-notice');
  await expect(notice.getByRole('alert')).toHaveText(
    'Saved QUARK history is temporarily unavailable.',
  );
  await expect(full.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  unavailable = false;
  await full.getByRole('button', { name: 'Back to QUARK', exact: true }).click();
  await page.getByRole('button', { name: 'Open QUARK conversation', exact: true }).click();
  const message = full.getByRole('textbox', { name: 'Message QUARK' });
  await expect(message).toBeEnabled();
  await expect(full.locator('.flow-chat-notice')).toHaveCount(0);
  await message.fill('Preserve this allocation request.');
  await full.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(notice.getByRole('alert')).toContainText('QUARK could not confirm this message.');
  await expect(message).toHaveValue('Preserve this allocation request.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await notice.boundingBox();
  expect(bounds!.height).toBeGreaterThan(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await mkdir('../../data/screenshots/quark-chat', { recursive: true });
  await page.screenshot({ path: `../../data/screenshots/quark-chat/${info.project.name}.png` });
  await full.getByRole('button', { name: 'Retry previous message', exact: true }).click();
  await expect(message).toHaveValue('');
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.key).toBe(attempts[0]!.key);
  expect(attempts[1]!.steer).toBe(attempts[0]!.steer);
  await full.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
  await expect(
    full.getByText('Earlier owner instruction remains readable.', { exact: true }),
  ).toBeVisible();
});

test('a late old QUARK read cannot replace the newly selected coordinator conversation', async ({
  page,
}) => {
  const { state, coordinator, agent, detail, now } = await fixture(page);
  let release!: () => void;
  let reading = false;
  await page.route(`**/api/agents/${agent.id}`, async (route) => {
    reading = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: detail });
  });
  await page.goto('/#/work');
  await page.getByRole('button', { name: 'Open QUARK conversation', exact: true }).click();
  await expect.poll(() => reading).toBe(true);
  const next = { ...agent, id: randomUUID(), name: 'Current QUARK' };
  state.agents.push(next);
  coordinator.agentId = next.id;
  await page.route(`**/api/agents/${next.id}`, (route) =>
    route.fulfill({
      json: {
        agent: next,
        entries: [
          {
            id: randomUUID(),
            agentId: next.id,
            runId: null,
            kind: 'assistant',
            title: '',
            text: 'New coordinator saved explanation.',
            status: 'complete',
            createdAt: now,
          },
        ],
        runs: [],
        hasMore: false,
      },
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  const full = page.getByRole('dialog', { name: 'QUARK conversation' });
  await expect(full.getByText('New coordinator saved explanation.', { exact: true })).toBeVisible();
  const oldResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/agents/${agent.id}`,
  );
  release();
  await oldResponse;
  await expect(full.getByRole('textbox', { name: 'Message Current QUARK' })).toBeEnabled();
  await expect(
    full.getByText('Current saved scheduling explanation.', { exact: true }),
  ).toHaveCount(0);
});
