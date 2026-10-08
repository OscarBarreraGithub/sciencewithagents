import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { detailSchema, snapshotSchema, type Run } from '@dock/shared';

test('a delivery event during a pending chat read is reconciled before the next timer poll', async ({
  page,
}) => {
  const snapshot = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = snapshot.projects.find((value) => !value.internal)!;
  const agent = snapshot.agents.find((value) => value.id === project.managerId)!;
  const retained = detailSchema.parse(
    await (await page.request.get(`/api/agents/${agent.id}`)).json(),
  );
  const runId = randomUUID();
  const text = 'Synthetic delivered owner request';
  const createdAt = new Date().toISOString();
  let status: Run['status'] = 'queued';
  let delay = false;
  let reads = 0;
  let active = 0;
  let maximumActive = 0;
  let release!: () => void;
  let gate: Promise<void>;
  const holdNextRead = () => {
    delay = true;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  let writes = 0;
  await page.addInitScript(() => {
    const sources: EventTarget[] = [];
    class FixtureEvents extends EventTarget {
      onopen = null;
      onerror = null;
      constructor() {
        super();
        sources.push(this);
      }
      close() {
        const index = sources.indexOf(this);
        if (index >= 0) sources.splice(index, 1);
      }
    }
    Object.assign(window, {
      EventSource: FixtureEvents,
      emitLatestChatChange: () => sources.at(-1)?.dispatchEvent(new Event('change')),
    });
  });
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route(new RegExp(`/api/agents/${agent.id}(?:\\?.*)?$`), async (route) => {
    reads++;
    active++;
    maximumActive = Math.max(maximumActive, active);
    const captured = status;
    const held = delay;
    delay = false;
    if (held) await gate;
    try {
      await route.fulfill({
        json: {
          ...retained,
          agent: { ...agent, status: captured === 'completed' ? 'idle' : captured },
          runs: [
            {
              id: runId,
              agentId: agent.id,
              sourceId: null,
              text,
              kind: 'user',
              status: captured,
              createdAt,
            },
          ],
          entries: [
            {
              id: runId,
              agentId: agent.id,
              runId,
              kind: 'user',
              title: 'You',
              text,
              status: 'queued',
              createdAt,
            },
          ],
        },
      });
    } finally {
      active--;
    }
  });
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(messages|resume|queued)(?:\/|$)/.test(new URL(request.url()).pathname)
    )
      writes++;
  });
  await page.goto(`/#/chat/${agent.id}`);
  const label = page.locator(`.message.user[data-prompt-id="${runId}"] .message-delivery`);
  await expect(label).toHaveText('Queued');
  const composer = page.locator('.composer textarea');
  await composer.fill('An unrelated unsent draft');
  // Isolate event-driven refresh from the fallback timer. Native transport is entirely stubbed.
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const before = reads;
  holdNextRead();
  const change = () =>
    page.evaluate(() =>
      (window as unknown as { emitLatestChatChange(): void }).emitLatestChatChange(),
    );
  await change();
  await expect.poll(() => reads).toBeGreaterThan(before);
  const inFlight = reads;
  status = 'completed';
  for (let i = 0; i < 4; i++) await change();
  expect(reads).toBe(inFlight); // Multiple events retain one follow-up, with no concurrent read.
  release();
  await expect(label).toHaveCount(0, { timeout: 1500 });
  await expect(page.locator('.message-queue-summary')).toHaveCount(0);
  expect(reads).toBe(inFlight + 1);
  expect(maximumActive).toBe(1);
  await expect(composer).toHaveValue('An unrelated unsent draft');
  expect(writes).toBe(0);

  // Leaving the chat discards its coalesced follow-up rather than fetching the old target.
  holdNextRead();
  await change();
  await expect.poll(() => active).toBe(1);
  await change();
  await page.evaluate(() => {
    location.hash = '#/chats';
  });
  await expect(composer).toHaveCount(0);
  const beforeLeaving = reads;
  release();
  await expect.poll(() => active).toBe(0);
  expect(reads).toBe(beforeLeaving);
});
