import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('Chats sorts managers, shared and saved offline chats by message activity through polling and reconnect', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const original = snapshot.agents.find((agent: { role: string }) => agent.role === 'manager');
  const manager = (name: string, lastActivityAt: string, status: string) => ({
    ...original,
    id: randomUUID(),
    name,
    lastActivityAt,
    status,
    updatedAt: '2026-10-09T14:00:00Z',
  });
  const idle = manager('Chronology recent manager', '2026-10-05T14:00:00Z', 'idle');
  const busy = manager('Chronology old working manager', '2026-10-01T14:00:00Z', 'running');
  const shared = (title: string, lastActivityAt?: string) => ({
    windowId: randomUUID(),
    threadId: randomUUID(),
    provider: 'codex',
    label: 'Chronology fixture',
    title,
    status: 'idle',
    message: '',
    ...(lastActivityAt ? { lastActivityAt } : {}),
  });
  const cached = shared('Chronology cached offline', '2026-10-06T14:00:00Z');
  const connected = shared('Chronology connected editor', '2026-10-03T14:00:00Z');
  const undated = shared('Chronology undated editor');
  const saved = shared('Chronology retained offline', '2026-10-07T14:00:00Z');
  await page.addInitScript(
    (cached) => sessionStorage.setItem('dock:mirror-chats:local:all', JSON.stringify([cached])),
    cached,
  );
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { ...snapshot, agents: [busy, idle], approvals: [] } }),
  );
  await page.route(/\/api\/conversations\/visibility(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        records: [
          {
            id: randomUUID(),
            target: { kind: 'shared', provider: 'codex', threadId: saved.threadId },
            revision: 1,
            archived: false,
            archivedAt: null,
            updatedAt: '2026-10-10T14:00:00Z',
            lastActivityAt: saved.lastActivityAt,
            provider: 'codex',
            source: 'vscode',
            title: saved.title,
            caption: saved.label,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  let live = [undated, connected];
  let polls = 0;
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) => {
    polls++;
    return route.fulfill({ json: live });
  });
  await page.goto('/#/chats');
  await page.getByRole('textbox', { name: 'Find a conversation' }).fill('Chronology');
  const rows = page.locator('.chat-row');
  const expected = [
    saved.title,
    cached.title,
    idle.name,
    connected.title,
    busy.name,
    undated.title,
  ];
  await expect(rows.locator('strong')).toHaveText(expected);
  live = [
    { ...connected, status: 'busy' },
    undated,
    { ...cached, windowId: randomUUID(), status: 'idle' },
  ];
  await expect(rows.filter({ hasText: cached.title }).locator('.chat-row-state')).toHaveText(
    'Connected',
  );
  await expect(rows.locator('strong')).toHaveText(expected);
  const after = polls;
  // Older companions may omit the date on reconnect; retain previously known native time.
  live = [
    { ...connected, lastActivityAt: undefined, status: 'idle' },
    { ...undated, status: 'busy' },
  ];
  await expect.poll(() => polls).toBeGreaterThan(after);
  await expect(rows.locator('strong')).toHaveText(expected);
  idle.updatedAt = '2026-10-11T14:00:00Z';
  busy.status = 'idle';
  connected.lastActivityAt = '2026-10-08T14:00:00Z';
  live = [undated, connected];
  await expect(rows.locator('strong')).toHaveText([
    connected.title,
    saved.title,
    cached.title,
    idle.name,
    busy.name,
    undated.title,
  ]);
  const newerRead = polls;
  connected.lastActivityAt = '2026-10-02T14:00:00Z';
  live = [connected, undated];
  await expect.poll(() => polls).toBeGreaterThan(newerRead);
  await expect(rows.first().locator('strong')).toHaveText(connected.title);
  await page.reload();
  await expect(rows.locator('strong')).toHaveText([
    connected.title,
    saved.title,
    cached.title,
    idle.name,
    busy.name,
    undated.title,
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
