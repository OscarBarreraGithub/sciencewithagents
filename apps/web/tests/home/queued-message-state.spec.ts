import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  detailSchema,
  snapshotSchema,
  mirrorPage,
  type Run,
  type MirrorState,
  type MirrorQueuedMessage,
} from '@dock/shared';

test('one saved owner bubble follows queued, active reply and completed run state', async ({
  page,
}, info) => {
  const state = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = state.projects.find((value) => !value.internal)!;
  const agent = state.agents.find((value) => value.id === project.managerId)!;
  const retained = detailSchema.parse(
    await (await page.request.get(`/api/agents/${agent.id}`)).json(),
  );
  const runId = randomUUID();
  const text = 'Please keep this saved request visible while it waits.';
  let status: Run['status'] = 'queued';
  let reads = 0;
  let sends = 0;
  const createdAt = new Date().toISOString();
  await page.route('**/api/snapshot', (route) => {
    agent.status = status === 'completed' ? 'idle' : status;
    return route.fulfill({ json: state });
  });
  await page.route(new RegExp(`/api/agents/${agent.id}(?:\\?.*)?$`), (route) => {
    reads++;
    return route.fulfill({
      json: {
        ...retained,
        agent: { ...agent, status: status === 'completed' ? 'idle' : status },
        runs: [
          { id: runId, agentId: agent.id, sourceId: null, text, kind: 'user', status, createdAt },
        ],
        entries: [
          {
            id: runId,
            agentId: agent.id,
            runId,
            kind: 'user',
            title: 'You',
            text,
            // Deliberately stale: saved entry status must never decide delivery.
            status: 'complete',
            createdAt,
          },
          ...(status === 'running'
            ? [
                {
                  id: 'active-reply',
                  agentId: agent.id,
                  runId,
                  kind: 'assistant',
                  title: 'Agent',
                  text: 'I am already working on this request.',
                  status: 'streaming',
                  createdAt,
                },
              ]
            : []),
        ],
      },
    });
  });
  await page.route(`**/api/agents/${agent.id}/messages`, (route) => {
    sends++;
    return route.fulfill({ status: 500, json: { error: 'Unexpected delivery' } });
  });
  await page.goto(`/#/chat/${agent.id}`);
  const bubble = page.locator(`.message.user[data-prompt-id="${runId}"]`);
  const label = bubble.locator('.message-delivery');
  await expect(bubble).toHaveCount(1);
  await expect(bubble).toContainText(text);
  await expect(label).toHaveText('Queued');
  await expect(page.getByRole('button', { name: /^1 queued message/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('saved-owner-message-queued.png') });
  const beforeStart = reads;
  status = 'running';
  await expect.poll(() => reads, { timeout: 10_000 }).toBeGreaterThan(beforeStart);
  await expect(label).toHaveText('In progress');
  await expect(
    page.getByText('I am already working on this request.', { exact: true }),
  ).toBeVisible();
  await expect(bubble).not.toContainText('Sending');
  await expect(page.getByRole('button', { name: /^1 queued message/ })).toHaveCount(0);
  await expect(bubble).toHaveCount(1);
  const beforeFinish = reads;
  status = 'completed';
  await expect.poll(() => reads, { timeout: 10_000 }).toBeGreaterThan(beforeFinish);
  await expect(label).toHaveCount(0);
  await expect(bubble).toContainText(text);
  await expect(bubble).toHaveCount(1);
  expect(sends).toBe(0);
});

test('shared queue counts queued, handed-off, uncertain and held inputs by stage without removing them', async ({
  page,
}, info) => {
  const state: MirrorState = {
    windowId: randomUUID(),
    threadId: randomUUID(),
    provider: 'codex',
    label: 'Delivery stages',
    title: 'Shared delivery stages',
    status: 'busy',
    message: '',
    canSteer: true,
    canQueue: true,
    steerToken: 'active-turn',
    stopToken: 'active-turn',
    entries: [
      { id: 'active-reply', role: 'assistant', text: 'The native agent is already replying.' },
    ],
  };
  const item = (status: MirrorQueuedMessage['status'], text: string): MirrorQueuedMessage => ({
    id: randomUUID(),
    provider: 'codex',
    threadId: state.threadId!,
    text,
    status,
    createdAt: new Date().toISOString(),
    queueRevision: 0,
    queueEdit: null,
    deliveryKey: null,
    message: '',
  });
  const queued = item('queued', 'Genuinely queued follow-up');
  const handedOff = item('running', 'Handed-off input awaits confirmation');
  const uncertain = item('uncertain', 'Unknown delivery remains saved for inspection');
  const held = {
    ...item('queued', 'Held edit remains saved'),
    queueEdit: {
      clientId: randomUUID(),
      text: 'Held edit remains saved',
      state: 'editing' as const,
    },
  };
  let items: MirrorQueuedMessage[] = [queued, handedOff, uncertain, held];
  let writes = 0;
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) => {
    const { entries: _, ...window } = state;
    return route.fulfill({ json: [window] });
  });
  await page.route('**/api/vscode/windows/' + state.windowId, (route) =>
    route.fulfill({ json: mirrorPage(state) }),
  );
  await page.route(/\/api\/vscode\/queued\?.*$/, (route) => route.fulfill({ json: { items } }));
  await page.route(/\/api\/vscode\/queued\/[^?]+$/, (route) => {
    if (route.request().method() !== 'GET') writes++;
    return route.fulfill({ status: 500, json: { error: 'No delivery change expected' } });
  });
  await page.goto('/#/chats/vscode/' + encodeURIComponent('codex:' + state.threadId));
  const summary = page.getByRole('button', { name: /Expand queue/ });
  await expect(summary).toContainText(
    '1 queued message · 1 awaiting confirmation · 1 delivery uncertain · 1 held',
  );
  await expect(
    page.getByText('The native agent is already replying.', { exact: true }),
  ).toBeVisible();
  await summary.click();
  const dialog = page.getByRole('dialog', { name: 'Queued messages', exact: true });
  const list = dialog.getByRole('list', { name: 'Queued messages' });
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await expect(list.getByText(uncertain.text, { exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Inspect delivery', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  items = [
    { ...queued, status: 'running' },
    { ...handedOff, status: 'completed' },
    uncertain,
    held,
  ];
  await expect(summary).toContainText('1 awaiting confirmation · 1 delivery uncertain · 1 held');
  await expect(summary).not.toContainText('queued message');
  await summary.click();
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByText(uncertain.text, { exact: true })).toBeVisible();
  await expect(list.getByText(held.text, { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mixed-delivery-stages.png') });
});
