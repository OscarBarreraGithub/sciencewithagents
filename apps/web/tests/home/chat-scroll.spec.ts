import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { detailSchema, mirrorPage, snapshotSchema, type MirrorState } from '@dock/shared';

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function fixture(page: Page, shared: boolean, origin: string) {
  if (shared) {
    const state: MirrorState = {
      windowId: randomUUID(),
      provider: 'codex',
      label: 'Draft fixture editor',
      threadId: randomUUID(),
      title: 'Live draft fixture',
      status: 'busy',
      message: '',
      canSteer: true,
      steerToken: 'fixture-turn',
      paged: true,
      groupedActivity: true,
      canReadNativeRequests: true,
      nativeRequests: [],
      nativeRequestCount: 0,
      nativeRequestsUnavailable: false,
      entries: Array.from({ length: 30 }, (_, i) => ({
        id: `fixture-message-${i}`,
        role: i % 2 ? 'assistant' : 'user',
        text: `Saved message ${i}. ${'Retain the reading position while drafting a follow-up. '.repeat(5)}`,
      })),
    };
    const { entries: _, nativeRequests: __, ...window } = state;
    await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
      route.fulfill({ json: [window] }),
    );
    await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
      route.fulfill({ json: mirrorPage(state) }),
    );
    await page.route(`**/api/vscode/windows/${state.windowId}/questions`, (route) =>
      route.fulfill({
        json: {
          windowId: state.windowId,
          provider: state.provider,
          threadId: state.threadId,
          status: state.status,
          message: '',
          nativeRequests: [],
          nativeRequestCount: 0,
          nativeRequestsUnavailable: false,
        },
      }),
    );
    await page.goto(`/#/chats/vscode/${encodeURIComponent(`codex:${state.threadId}`)}`);
    return {
      input: page.locator('.mirror-input-row textarea'),
      log: page.locator('.mirror-log'),
      working: page.locator('.mirror-working'),
      entries: page.locator('.mirror-message'),
      update: (text: string) =>
        state.entries.push(
          { id: randomUUID(), role: 'assistant', text },
          { id: randomUUID(), role: 'activity', text: 'commandExecution\nSaved tool checkpoint.' },
        ),
    };
  }
  const created = await page.request.post('/api/projects', {
    headers: { origin },
    data: { key: randomUUID(), name: 'Managed draft fixture', provider: 'codex' },
  });
  expect(created.ok()).toBe(true);
  const project = await created.json();
  const detail = detailSchema.parse(
    await (await page.request.get(`/api/agents/${project.managerId}`)).json(),
  );
  detail.agent.status = 'running';
  detail.entries = Array.from({ length: 30 }, (_, i) => ({
    id: randomUUID(),
    agentId: project.managerId,
    runId: null,
    kind: i % 2 ? 'assistant' : 'user',
    title: i % 2 ? 'Assistant' : 'You',
    status: 'completed',
    createdAt: new Date().toISOString(),
    text: `Saved message ${i}. ${'Retain the reading position while drafting a follow-up. '.repeat(5)}`,
  }));
  detail.hasMore = false;
  const snapshot = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  snapshot.agents.find((agent) => agent.id === project.managerId)!.status = 'running';
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route(new RegExp(`/api/agents/${project.managerId}(?:\\?.*)?$`), (route) =>
    route.fulfill({ json: detail }),
  );
  await page.goto(`/#/chat/${project.managerId}`);
  return {
    input: page.locator('.composer textarea'),
    log: page.locator('.conversation'),
    working: page.locator('.conversation .thinking'),
    entries: page.locator('.conversation .message'),
    update: (text: string) =>
      detail.entries.push(
        {
          id: randomUUID(),
          agentId: project.managerId,
          runId: null,
          kind: 'assistant',
          title: 'Assistant',
          text,
          status: 'completed',
          createdAt: new Date().toISOString(),
        },
        {
          id: randomUUID(),
          agentId: project.managerId,
          runId: null,
          kind: 'tool',
          title: 'Saved tool checkpoint',
          text: 'Fixture activity.',
          status: 'completed',
          createdAt: new Date().toISOString(),
        },
      ),
  };
}

async function bottomGap(log: Locator) {
  return log.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
}

for (const shared of [true, false]) {
  test(`${shared ? 'shared' : 'managed'} chat keeps its live tail and older reading position while typing and polling`, async ({
    page,
    baseURL,
  }, info) => {
    const handoffs: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/(messages|send|control)$/.test(request.url()))
        handoffs.push(request.url());
    });
    const { input, log, working, entries, update } = await fixture(
      page,
      shared,
      new URL(baseURL!).origin,
    );
    await expect(entries).toHaveCount(30);
    await expect.poll(() => bottomGap(log)).toBeLessThanOrEqual(2);
    await frames(page);
    const atTail = async () => {
      await frames(page);
      expect(await bottomGap(log)).toBeLessThanOrEqual(2);
      await expect(working).toContainText('is working');
      await expect(working).toBeInViewport();
      if (shared) await expect(page.locator('.mirror-latest')).toHaveCount(0);
    };
    const draft = Array.from({ length: 20 }, (_, i) => `Draft line ${i + 1}`).join('\n');
    await input.fill(draft);
    await atTail();
    // Natural edits at the same height used to clamp WebKit's log during the
    // temporary height:auto measurement; no ResizeObserver repin then occurs.
    for (const extra of [' one', ' two', ' three']) {
      await input.fill(draft + extra);
      await atTail();
    }
    await input.evaluate((field) => {
      const area = field as HTMLTextAreaElement;
      area.setSelectionRange(area.value.length - 3, area.value.length - 3);
    });
    await input.press('x');
    const edited = await input.inputValue();
    const caret = await input.evaluate((field) => (field as HTMLTextAreaElement).selectionStart);
    await atTail();
    update('Fresh provider checkpoint while drafting.');
    await expect(
      log.getByText('Fresh provider checkpoint while drafting.', { exact: true }),
    ).toBeAttached();
    await atTail();
    await expect(input).toHaveValue(edited);
    expect(await input.evaluate((field) => (field as HTMLTextAreaElement).selectionStart)).toBe(
      caret,
    );
    // Genuine composer growth/shrink still follows the tail after the measurement.
    await input.fill('Short draft');
    await atTail();
    await input.fill(draft);
    await atTail();
    const anchor = entries.nth(24);
    await anchor.evaluate((node) => {
      const pane = node.closest<HTMLElement>('.mirror-log, .conversation')!;
      pane.scrollTop += node.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12;
      pane.dispatchEvent(new Event('scroll'));
    });
    await frames(page);
    const offset = () =>
      anchor.evaluate(
        (node) =>
          node.getBoundingClientRect().top -
          node.closest('.mirror-log, .conversation')!.getBoundingClientRect().top,
      );
    const before = await offset();
    for (const extra of [' history one', ' history two']) {
      await input.fill(draft + extra);
      await frames(page);
      expect(Math.abs((await offset()) - before)).toBeLessThanOrEqual(2);
    }
    update('Fresh checkpoint while reading older messages.');
    await expect(
      log.getByText('Fresh checkpoint while reading older messages.', { exact: true }),
    ).toBeAttached();
    await frames(page);
    expect(Math.abs((await offset()) - before)).toBeLessThanOrEqual(2);
    await expect(working).toContainText('is working');
    await expect(input).toHaveValue(draft + ' history two');
    if (shared) await expect(page.locator('.mirror-latest')).toBeVisible();
    expect(handoffs).toEqual([]);
    await page.screenshot({
      path: `../../data/scroll-evidence/${info.project.name}-${shared ? 'shared' : 'managed'}.png`,
    });
  });
}
