import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

type Agent = { id: string; name: string; role: string; projectId: string; nativeRootId?: string };
type FixtureEntry = {
  id: string;
  agentId: string;
  runId: string | null;
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'message';
  title: string;
  text: string;
  status: string;
  createdAt: string;
  coordination?: { kind: 'message' | 'report'; sourceId: string | null };
};

/** Serves bounded demo history the way the server channels it: filter, then keyset page. */
async function serveHistory(page: Page, manager: Agent, entries: FixtureEntry[]) {
  const calls: string[] = [];
  const failures = { latest: 0, earlier: 0 };
  await page.route(`**/api/agents/${manager.id}*`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== `/api/agents/${manager.id}` || route.request().method() !== 'GET')
      return route.continue();
    const channel = url.searchParams.get('channel') ?? 'all';
    const before = url.searchParams.get('before');
    calls.push(`${channel}:${before ? 'earlier' : 'latest'}`);
    const step = before ? 'earlier' : 'latest';
    if (channel === 'coordination' && failures[step] > 0) {
      failures[step]--;
      return route.fulfill({
        status: 500,
        json: { error: 'Saved activity is briefly unavailable.' },
      });
    }
    const response = await route.fetch({ url: `${url.origin}${url.pathname}` });
    const pool = entries.filter(
      (entry) => channel === 'all' || (channel === 'coordination') === !!entry.coordination,
    );
    const end = before ? pool.findIndex((entry) => entry.id === before) : pool.length;
    await route.fulfill({
      json: {
        ...(await response.json()),
        entries: pool.slice(Math.max(0, end - 200), end),
        hasMore: end > 200,
      },
    });
  });
  return { calls, failures };
}

test('routine team coordination moves to Team activity while owner conversation stays in the chat', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const manager: Agent = snapshot.agents.find(
    (agent: Agent) =>
      agent.role === 'manager' &&
      snapshot.agents.some((a: Agent) => a.projectId === agent.projectId && a.role !== 'manager'),
  );
  const [worker, reviewer] = snapshot.agents.filter(
    (agent: Agent) => agent.projectId === manager.projectId && agent.role !== 'manager',
  ) as Agent[];
  let minute = 0;
  const entry = (
    kind: FixtureEntry['kind'],
    title: string,
    text: string,
    extra: Partial<FixtureEntry> = {},
  ): FixtureEntry => ({
    id: randomUUID(),
    agentId: manager.id,
    runId: null,
    kind,
    title,
    text,
    status: 'complete',
    createdAt: new Date(Date.UTC(2026, 9, 1, 8) + minute++ * 60_000).toISOString(),
    ...extra,
  });
  const exchange = (index: number, tools = false) => {
    const runId = randomUUID();
    const coordination = {
      kind: index % 2 ? 'message' : 'report',
      sourceId: (index % 2 ? reviewer : worker)!.id,
    } as const;
    return [
      entry('message', 'Team message', `Report #${index} from the team.`, { runId, coordination }),
      ...(tools
        ? [1, 2, 3].map((step) =>
            entry('tool', `Read drafts step ${step}`, `FULL-TOOL-OUTPUT-${step}`, {
              runId,
              coordination,
            }),
          )
        : []),
      entry(
        'assistant',
        manager.name,
        index === 239 ? `Ack #239 ${'detail '.repeat(80)}FULL-TAIL-239` : `Ack #${index}, noted.`,
        { runId, coordination },
      ),
    ];
  };
  const steering = randomUUID();
  const entries: FixtureEntry[] = [
    entry('user', 'You', 'Earlier request from the owner.'),
    ...Array.from({ length: 205 }, (_, index) =>
      entry('assistant', manager.name, `Earlier answer #${index} for the owner.`),
    ),
    entry('user', 'You', 'Owner asks: keep drafts across reloads.', { runId: randomUUID() }),
    ...Array.from({ length: 120 }, (_, index) => exchange(index)).flat(),
    entry('system', 'Owner steering', 'Steer: prefer local storage first.', { runId: steering }),
    entry('assistant', manager.name, 'Owner-facing answer: local storage first.', {
      runId: steering,
    }),
    entry('message', 'Team message', 'Legacy unclassified team note.'),
    entry('system', 'Needs your answer', 'Which browsers matter most?'),
    ...Array.from({ length: 120 }, (_, index) => exchange(index + 120, index === 119)).flat(),
  ];
  const history = await serveHistory(page, manager, entries);
  const approval = {
    id: randomUUID(),
    agentId: manager.id,
    kind: 'input',
    title: 'Approve the draft storage plan',
    details: 'The manager needs your decision.',
    questions: [],
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await page.route('**/api/snapshot', async (route) => {
    const value = await (await route.fetch()).json();
    await route.fulfill({ json: { ...value, approvals: [...value.approvals, approval] } });
  });

  await page.goto(`/#/chat/${manager.id}`);
  const main = page.locator('.conversation');
  await expect(main.getByText('Owner-facing answer: local storage first.')).toBeVisible();
  for (const text of [
    'Owner asks: keep drafts across reloads.',
    'Steer: prefer local storage first.',
    'Legacy unclassified team note.',
    'Which browsers matter most?',
    'Approve the draft storage plan',
  ])
    await expect(main.getByText(text)).toBeVisible();
  await expect(main.getByText(/Report #|Ack #/)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('main-chat.png') });
  // Earlier chat history pages through the same conversation channel.
  await page.getByRole('button', { name: 'Your prompts', exact: true }).click();
  const prompts = page.getByRole('dialog', { name: 'Your prompts', exact: true });
  await prompts.getByRole('button', { name: 'Older prompts', exact: true }).click();
  await prompts.getByRole('button', { name: /Earlier request from the owner/ }).click();
  await expect(main.getByText('Earlier answer #0 for the owner.')).toBeVisible();
  await expect(main.getByText(/Report #|Ack #/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to latest', exact: true }).click();
  await expect(main.getByText('Owner-facing answer: local storage first.')).toBeVisible();
  expect(history.calls).toContain('conversation:latest');
  expect(history.calls).toContain('conversation:earlier');
  expect(history.calls.filter((call) => !call.startsWith('conversation'))).toEqual([]);

  // Opening, paging and expanding only read saved history.
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/'))
      writes.push(request.url());
  });
  const layout = async (name: string) => {
    await expect(page.getByRole('button', { name: 'Close panel' })).toBeInViewport();
    expect(
      await page.evaluate(() => {
        const side = document.querySelector('.chat-side-body')!;
        return [
          document.documentElement.scrollWidth <= innerWidth,
          side.scrollWidth <= side.clientWidth,
        ];
      }),
    ).toEqual([true, true]);
    await page.screenshot({ path: info.outputPath(`${name}.png`) });
  };
  history.failures.latest = 1;
  await page.getByRole('button', { name: 'Subagents', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Subagents' });
  await expect(panel.getByText('Saved activity is briefly unavailable.')).toBeVisible();
  await panel.getByRole('button', { name: 'Try again' }).click();
  const rows = panel.locator('.team-activity-item');
  await expect(rows.first()).toContainText('Manager reply');
  await expect(rows.first()).toContainText('Ack #239');
  await expect(rows.first()).toContainText(`about a message from ${reviewer!.name}`);
  await expect(panel.getByText(worker!.name, { exact: true })).toBeVisible();
  await layout('team-activity-open');
  await expect(panel.locator('.team-activity-item', { hasText: '3 manager actions' })).toHaveCount(
    1,
  );
  await expect(panel.getByText('FULL-TAIL-239')).toHaveCount(0);
  await rows.first().locator('.team-activity-toggle').click();
  await expect(panel.getByText(/FULL-TAIL-239/)).toBeVisible();
  const tools = panel.locator('.team-activity-item', { hasText: '3 manager actions' });
  await tools.locator('.team-activity-toggle').click();
  await tools.getByText('Read drafts step 2').click();
  await expect(tools.getByText('FULL-TOOL-OUTPUT-2')).toBeVisible();
  await expect(panel.getByText('Owner-facing answer: local storage first.')).toHaveCount(0);

  await layout('team-activity-latest');

  // Earlier pages come from the coordination channel only, without duplicates.
  const earlier = panel.getByRole('button', { name: 'Load earlier activity' });
  history.failures.earlier = 1;
  await earlier.click();
  await expect(panel.getByText('Could not load earlier activity.', { exact: false })).toBeVisible();
  await earlier.click();
  await expect(panel.getByText('Report #140 from the team.')).toHaveCount(1);
  await earlier.click();
  await expect(panel.getByText('Report #0 from the team.')).toHaveCount(1);
  await expect(earlier).toHaveCount(0);
  await expect(rows).toHaveCount(481);
  expect(history.calls.filter((call) => call.startsWith('coordination:earlier'))).toHaveLength(3);
  await layout('team-activity-earliest');

  // New activity arrives above without moving a reader who is in older history.
  const reading = panel.locator('.team-activity-item', { hasText: 'Report #60 from' });
  await reading.scrollIntoViewIfNeeded();
  const before = (await reading.boundingBox())!.y;
  entries.push(...exchange(240));
  await expect(panel.locator('.team-activity-item', { hasText: 'Ack #240' })).toHaveCount(1, {
    timeout: 12_000,
  });
  await expect(rows).toHaveCount(483);
  expect(Math.abs((await reading.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
  await expect(main.getByText(/Report #|Ack #/)).toHaveCount(0);
  expect(writes).toEqual([]);

  // Reload keeps the same saved history in the same channels.
  await page.reload();
  await expect(main.getByText('Owner-facing answer: local storage first.')).toBeVisible();
  await page.getByRole('button', { name: 'Subagents', exact: true }).click();
  await expect(rows.first()).toContainText('Ack #240');
  await expect(panel.getByText('Report #0 from the team.')).toHaveCount(0);
  await earlier.click();
  await earlier.click();
  await expect(panel.getByText('Report #0 from the team.')).toHaveCount(1);
  await expect(rows).toHaveCount(483);
  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(panel).toHaveCount(0);
  await expect(main.getByText('Owner-facing answer: local storage first.')).toBeVisible();

  // Worker chats keep reading every saved entry.
  const workerRead = page.waitForRequest(
    (request) => new URL(request.url()).pathname === `/api/agents/${worker!.id}`,
  );
  await page.goto(`/#/chat/${worker!.id}`);
  expect(new URL((await workerRead).url()).searchParams.has('channel')).toBe(false);
});

test('a complete refreshed activity page removes replies reclassified after owner steering', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const manager: Agent = snapshot.agents.find(
    (agent: Agent) =>
      agent.role === 'manager' &&
      snapshot.agents.some((a: Agent) => a.projectId === agent.projectId && a.role !== 'manager'),
  );
  const runId = randomUUID();
  const entry = (kind: FixtureEntry['kind'], text: string): FixtureEntry => ({
    id: randomUUID(),
    agentId: manager.id,
    runId,
    kind,
    title: kind === 'user' ? 'You' : 'Saved evidence',
    text,
    status: 'complete',
    createdAt: new Date().toISOString(),
    coordination: { kind: 'report', sourceId: null },
  });
  const reply = entry('assistant', 'Response now retained for the owner.');
  const tool = entry('tool', 'Retained tool evidence.');
  const remaining = entry('message', 'Another saved team report remains.');
  remaining.runId = randomUUID();
  const entries = [reply, tool, remaining];
  await serveHistory(page, manager, entries);
  await page.goto(`/#/chat/${manager.id}`);
  await page.getByRole('button', { name: 'Subagents', exact: true }).click();
  const activity = page.getByRole('region', { name: 'Team activity', exact: true });
  await expect(activity.locator('.team-activity-item')).toHaveCount(3);

  // The server's conservative mixed-run rule moves these saved rows to conversation.
  // Its complete coordination response is authoritative, not an append-only delta.
  delete reply.coordination;
  delete tool.coordination;
  const owner = entry('user', 'Please explain this result to me.');
  delete owner.coordination;
  entries.push(owner);
  await expect(activity.locator('.team-activity-item')).toHaveCount(1, { timeout: 12_000 });
  await expect(activity.locator(`[data-entry="${reply.id}"]`)).toHaveCount(0);
  await expect(activity.locator(`[data-entry="${tool.id}"]`)).toHaveCount(0);
  await expect(activity).toContainText(remaining.text);
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  const main = page.locator('.conversation');
  await expect(main.getByText(reply.text, { exact: true })).toBeVisible();
  await expect(main.getByText(owner.text, { exact: true })).toBeVisible();
});
