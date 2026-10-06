import { expect, test, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  mirrorPage,
  type MirrorState,
  type NativeGoal,
  type NativeGoalAction,
  type NativeGoalView,
} from '@dock/shared';

const tokenA = 'a'.repeat(64);
const tokenB = 'b'.repeat(64);
type Result = { state: 'sent' | 'not_sent' | 'uncertain'; message: string };
test.afterEach(async ({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

/** Typed HTTP fixtures for one shared conversation; nothing reaches a native provider. */
async function sharedChat(page: Page, provider: 'codex' | 'claude' = 'codex', host?: string) {
  const prefix = host ? `/api/hosts/${host}/proxy` : '/api';
  if (host) {
    await page.addInitScript((id) => localStorage.setItem('dock:host', id), host);
    await page.route('**/api/hosts', (route) =>
      route.fulfill({
        json: {
          local: { id: 'local', label: 'Entry fixture' },
          setupError: null,
          hosts: [
            {
              id: host,
              label: 'Selected fixture',
              accountLabel: 'Owner fixture',
              status: 'connected',
              error: null,
            },
          ],
        },
      }),
    );
    await page.route(`**${prefix}/**`, async (route) => {
      const request = route.request();
      const url = request.url().replace(prefix, '/api');
      if (new URL(url).pathname === '/api/events')
        return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      if (request.method() === 'POST' && url.includes('/vscode/'))
        return route.fulfill({ status: 500, json: { error: 'Unexpected native fixture action.' } });
      return route.fulfill({ response: await route.fetch({ url }) });
    });
  }
  const state: MirrorState = {
    windowId: randomUUID(),
    threadId: randomUUID(),
    provider,
    label: 'Existing editor',
    title: 'Goal conversation',
    status: 'idle',
    message: '',
    paged: true,
    entries: [{ id: 'reply', role: 'assistant', text: 'Ready when you are.' }],
  };
  const fixture = {
    state,
    view: {
      threadId: state.threadId,
      supported: true,
      goal: null,
      token: null,
      message: '',
    } as NativeGoalView,
    reads: 0,
    posts: [] as NativeGoalAction[],
    postUrls: [] as string[],
    deliveries: [] as string[],
    deliveryUrls: [] as string[],
    post: (_: NativeGoalAction): Result | 'lost' => ({ state: 'sent', message: 'Goal updated.' }),
    delivery: (_: string): Result => ({ state: 'uncertain', message: 'No record yet.' }),
    hold: null as null | ((route: Route) => void),
  };
  await page.route(new RegExp(`${prefix}/vscode/windows(?:\\?.*)?$`), (route) => {
    const { entries: _, ...summary } = state;
    return route.fulfill({ json: [summary] });
  });
  await page.route(new RegExp(`${prefix}/vscode/windows/[^/?]+$`), (route) =>
    route.fulfill({ json: mirrorPage(state) }),
  );
  await page.route(new RegExp(`${prefix}/vscode/windows/[^/?]+/goal$`), (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON() as NativeGoalAction;
      fixture.posts.push(input);
      fixture.postUrls.push(route.request().url());
      const result = fixture.post(input);
      return result === 'lost'
        ? route.fulfill({ status: 502, json: { error: 'Response lost' } })
        : route.fulfill({ json: result });
    }
    fixture.reads++;
    if (fixture.hold) {
      const hold = fixture.hold;
      fixture.hold = null;
      return hold(route);
    }
    return route.fulfill({ json: fixture.view });
  });
  await page.route(`**${prefix}/vscode/deliveries/*`, (route) => {
    const key = route.request().url().split('/').at(-1)!;
    fixture.deliveries.push(key);
    fixture.deliveryUrls.push(route.request().url());
    return route.fulfill({ json: fixture.delivery(key) });
  });
  await page.goto(`/#/chats/vscode/${encodeURIComponent(`${provider}:${state.threadId}`)}`);
  await expect(page.getByText('Ready when you are.')).toBeVisible();
  return fixture;
}
async function openGoal(page: Page) {
  await page.getByRole('button', { name: 'Show commands' }).click();
  await page
    .getByRole('dialog', { name: 'Session commands' })
    .getByRole('button', { name: '/goal Goal', exact: true })
    .click();
}
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Conversation goal' });
const goal = (threadId: string, patch: Partial<NativeGoal> = {}): NativeGoal => ({
  threadId,
  objective: 'Write the methods section with citations.',
  status: 'active',
  createdAt: 1_790_000_000,
  updatedAt: 1_790_000_000,
  tokensUsed: 1200,
  timeUsedSeconds: 75,
  tokenBudget: null,
  ...patch,
});

test('a selected computer and reconnect keep the same thread receipt without sending again', async ({
  page,
}) => {
  const host = randomUUID();
  const chat = await sharedChat(page, 'codex', host);
  chat.post = () => 'lost';
  await openGoal(page);
  await dialog(page)
    .getByLabel('What should Codex accomplish?')
    .fill('Check the selected computer’s data.');
  await dialog(page).getByRole('button', { name: 'Set goal' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Check status' })).toBeEnabled();
  chat.state.windowId = randomUUID();
  await page.reload();
  await openGoal(page);
  await expect(dialog(page).getByLabel('What should Codex accomplish?')).toHaveValue(
    'Check the selected computer’s data.',
  );
  const retained = await page.evaluate(
    ({ host, thread }) => {
      const key = `dock:native-goal:${host}:codex:${thread}`;
      return JSON.parse(sessionStorage.getItem(key) ?? 'null');
    },
    { host, thread: chat.state.threadId },
  );
  expect(retained.pending).toEqual(chat.posts[0]);
  // Another tab changing its selector does not retarget this document's request.
  await page.evaluate((id) => localStorage.setItem('dock:host', id), randomUUID());
  chat.delivery = () => ({ state: 'not_sent', message: 'Native goal was not changed.' });
  await dialog(page).getByRole('button', { name: 'Check status' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Check status' })).toHaveCount(0);
  await expect(dialog(page).getByLabel('What should Codex accomplish?')).toHaveValue(
    'Check the selected computer’s data.',
  );
  expect(chat.posts).toHaveLength(1);
  expect(chat.deliveries).toEqual([chat.posts[0].key]);
  expect(
    [...chat.postUrls, ...chat.deliveryUrls].every((url) =>
      url.includes(`/api/hosts/${host}/proxy/vscode/`),
    ),
  ).toBe(true);
});

test('a goal is created once; a definite refusal keeps the objective for an explicit retry', async ({
  page,
}) => {
  const chat = await sharedChat(page);
  const composer = page.getByRole('textbox', { name: 'Message Codex' });
  await composer.fill('Unsent message draft');
  chat.post = () => ({ state: 'not_sent', message: 'Codex did not accept the goal.' });
  await openGoal(page);
  const objective = dialog(page).getByLabel('What should Codex accomplish?');
  await objective.fill('Write the methods section with citations.');
  const reads = chat.reads;
  await dialog(page).getByRole('button', { name: 'Set goal' }).click();
  await expect(dialog(page).getByText('Codex did not accept the goal.')).toBeVisible();
  expect(chat.posts).toEqual([
    {
      key: expect.stringMatching(/^[0-9a-f-]{36}$/),
      threadId: chat.state.threadId,
      provider: 'codex',
      action: 'create',
      objective: 'Write the methods section with citations.',
      expectedToken: null,
    },
  ]);
  await expect(objective).toHaveValue('Write the methods section with citations.');
  // The native view is read again before another explicit action.
  await expect.poll(() => chat.reads).toBeGreaterThan(reads);
  chat.post = (input) => {
    chat.view = {
      ...chat.view,
      goal: goal(chat.state.threadId, {
        objective: input.action === 'create' ? input.objective : '',
      }),
      token: tokenA,
    };
    return { state: 'sent', message: 'Goal set in Codex.' };
  };
  await dialog(page).getByRole('button', { name: 'Set goal' }).click();
  await expect(dialog(page).getByText('Active', { exact: true })).toBeVisible();
  expect(chat.posts).toHaveLength(2);
  expect(chat.posts[1].key).not.toBe(chat.posts[0].key);
  await expect(dialog(page).getByText('1,200')).toBeVisible();
  await expect(dialog(page).getByText('Native token budget')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(composer).toHaveValue('Unsent message draft');
});

test('an unconfirmed goal survives reload and is only inspected, never posted again', async ({
  page,
}) => {
  const chat = await sharedChat(page);
  chat.post = () => 'lost';
  await openGoal(page);
  const objective = dialog(page).getByLabel('What should Codex accomplish?');
  await objective.fill('Draft the discussion.');
  await dialog(page).getByRole('button', { name: 'Set goal' }).click();
  await expect(dialog(page).getByText(/nothing is repeated automatically/)).toBeVisible();
  await expect(objective).toHaveAttribute('readonly', '');
  await expect(
    dialog(page).getByRole('button', { name: 'I checked the conversation' }),
  ).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Set goal' })).toHaveCount(0);
  await page.reload();
  await openGoal(page);
  await expect(dialog(page).getByLabel(/Objective awaiting|What should Codex/)).toHaveValue(
    'Draft the discussion.',
  );
  await dialog(page).getByRole('button', { name: 'Check status' }).click();
  await expect(dialog(page).getByText(/No record yet\./)).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Check status' })).toBeVisible();
  chat.delivery = () => {
    chat.view = {
      ...chat.view,
      goal: goal(chat.state.threadId, { objective: 'Draft the discussion.' }),
      token: tokenA,
    };
    return { state: 'sent', message: 'Goal set in Codex.' };
  };
  await dialog(page).getByRole('button', { name: 'Check status' }).click();
  await expect(dialog(page).getByText('Active', { exact: true })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Check status' })).toHaveCount(0);
  expect(chat.posts).toHaveLength(1);
  expect(chat.deliveries).toEqual([chat.posts[0].key, chat.posts[0].key]);
  await page.reload();
  await openGoal(page);
  await expect(dialog(page).getByText('Draft the discussion.')).toBeVisible();
  expect(chat.posts).toHaveLength(1);
});

test('pause and resume use the displayed native token; progress and terminal states stay native', async ({
  page,
}, info) => {
  const chat = await sharedChat(page);
  chat.view = { ...chat.view, goal: goal(chat.state.threadId), token: tokenA };
  await page.reload();
  const entry = await page.getByRole('button', { name: 'Show commands' }).boundingBox();
  await expect(page.locator('.mirror-header').getByRole('button', { name: /^Goal/ })).toHaveCount(
    0,
  );
  expect(entry!.height).toBeGreaterThanOrEqual(44);
  expect(entry!.width).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole('textbox', { name: 'Message Codex' })).toBeInViewport();
  // The goal entry must not squeeze the conversation title into a narrow column.
  const title = await page.locator('.mirror-header h1').boundingBox();
  expect(title!.width).toBeGreaterThanOrEqual(90);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('goal-entry.png') });
  await openGoal(page);
  await expect(dialog(page).getByRole('button', { name: 'Clear goal' })).toHaveCount(0);
  // Native progress does not change the lifecycle token used for pause.
  chat.view = {
    ...chat.view,
    goal: goal(chat.state.threadId, {
      tokensUsed: 5000,
      timeUsedSeconds: 3725,
      tokenBudget: 90000,
    }),
  };
  await dialog(page).getByRole('button', { name: 'Refresh from Codex' }).click();
  await expect(dialog(page).getByText('5,000')).toBeVisible();
  await expect(dialog(page).getByText('1h 2m')).toBeVisible();
  await expect(dialog(page).getByText('90,000')).toBeVisible();
  await expect(dialog(page).getByText('Native token budget')).toBeVisible();
  for (const button of await dialog(page).getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await dialog(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('goal-dialog.png') });
  chat.post = (input) => {
    chat.view = {
      ...chat.view,
      goal: goal(chat.state.threadId, {
        status: input.action === 'pause' ? 'paused' : 'active',
        updatedAt: 1_790_000_100 + chat.posts.length,
      }),
      token: input.action === 'pause' ? tokenB : tokenA,
    };
    return { state: 'sent', message: 'Goal updated.' };
  };
  await dialog(page).getByRole('button', { name: 'Pause goal' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Resume goal' })).toBeEnabled();
  await dialog(page).getByRole('button', { name: 'Resume goal' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Pause goal' })).toBeEnabled();
  expect(chat.posts.map(({ action, expectedToken }) => [action, expectedToken])).toEqual([
    ['pause', tokenA],
    ['resume', tokenB],
  ]);
  for (const status of ['blocked', 'usageLimited'] as const) {
    chat.view = { ...chat.view, goal: goal(chat.state.threadId, { status }) };
    await dialog(page).getByRole('button', { name: 'Refresh from Codex' }).click();
    await expect(dialog(page).getByRole('button', { name: 'Resume goal' })).toBeEnabled();
  }
  for (const status of ['budgetLimited', 'complete'] as const) {
    chat.view = { ...chat.view, goal: goal(chat.state.threadId, { status, tokenBudget: 1200 }) };
    await dialog(page).getByRole('button', { name: 'Refresh from Codex' }).click();
    await expect(dialog(page).getByText(/cannot be resumed/)).toBeVisible();
    await expect(
      dialog(page).getByRole('button', { name: /Resume goal|Pause goal|Set goal/ }),
    ).toHaveCount(0);
    await expect(dialog(page).getByRole('button', { name: 'Clear goal' })).toBeEnabled();
  }
  chat.view = {
    threadId: chat.state.threadId,
    supported: false,
    goal: null,
    token: null,
    message: 'This Codex version does not expose goals.',
  };
  await dialog(page).getByRole('button', { name: 'Refresh from Codex' }).click();
  await expect(dialog(page).getByText('This Codex version does not expose goals.')).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Set goal' })).toHaveCount(0);
  expect(chat.posts).toHaveLength(2);
});

test('a delayed older reading or another conversation never replaces the native goal', async ({
  page,
}) => {
  const chat = await sharedChat(page);
  await openGoal(page);
  await expect(dialog(page).getByRole('button', { name: 'Set goal' })).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const stale = structuredClone(chat.view);
  chat.hold = (route) => void held.then(() => route.fulfill({ json: stale }));
  await dialog(page).getByRole('button', { name: 'Refresh from Codex' }).click();
  await expect.poll(() => chat.hold).toBeNull();
  chat.post = (input) => {
    chat.view = {
      ...chat.view,
      goal: goal(chat.state.threadId, {
        objective: input.action === 'create' ? input.objective : '',
      }),
      token: tokenA,
    };
    return { state: 'sent', message: 'Goal set in Codex.' };
  };
  await dialog(page).getByLabel('What should Codex accomplish?').fill('Check every figure.');
  await dialog(page).getByRole('button', { name: 'Set goal' }).click();
  await expect(dialog(page).getByText('Check every figure.')).toBeVisible();
  release();
  await page.waitForTimeout(300);
  await expect(dialog(page).getByText('Check every figure.')).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Set goal' })).toHaveCount(0);
  chat.view = { ...chat.view, threadId: randomUUID(), goal: null, token: null };
  await dialog(page).getByRole('button', { name: 'Refresh from Codex' }).click();
  await expect(dialog(page).getByText(/reports a different conversation/)).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: /Set goal|Pause goal/ })).toHaveCount(0);
  expect(chat.posts).toHaveLength(1);
});

test('Claude Code conversations have no unsupported goal control or goal requests', async ({
  page,
}) => {
  const chat = await sharedChat(page, 'claude');
  await openGoal(page);
  await expect(dialog(page)).toContainText('Claude Code does not offer native goals');
  expect(chat.reads).toBe(0);
  expect(chat.posts).toHaveLength(0);
});

test('the objective survives closing, navigating, reloading and recovery without a tab draft', async ({
  page,
}) => {
  const chat = await sharedChat(page);
  await openGoal(page);
  const text = 'Finish the derivation.\nKeep the boundary conditions explicit.';
  await dialog(page).getByLabel('What should Codex accomplish?').fill(text);
  await page.keyboard.press('Escape');
  await openGoal(page);
  await expect(dialog(page).getByLabel('What should Codex accomplish?')).toHaveValue(text);
  await page.goto('/#/chats');
  await page.goto(`/#/chats/vscode/${encodeURIComponent(`codex:${chat.state.threadId}`)}`);
  await openGoal(page);
  await expect(dialog(page).getByLabel('What should Codex accomplish?')).toHaveValue(text);
  await page.reload();
  await openGoal(page);
  await expect(dialog(page).getByLabel('What should Codex accomplish?')).toHaveValue(text);
  const key = `dock:native-goal:local:codex:${chat.state.threadId}`;
  await page.evaluate((key) => sessionStorage.removeItem(key), key);
  await page.reload();
  await openGoal(page);
  await expect(dialog(page).getByLabel('What should Codex accomplish?')).toHaveValue(text);
  expect(chat.posts).toHaveLength(0);
});

test('clearing a completed native goal explicitly permits a new goal without deleting the chat', async ({
  page,
}) => {
  const chat = await sharedChat(page);
  chat.view = {
    ...chat.view,
    goal: goal(chat.state.threadId, { status: 'complete' }),
    token: tokenA,
  };
  chat.post = (input) => {
    chat.view = {
      ...chat.view,
      goal:
        input.action === 'clear'
          ? null
          : goal(chat.state.threadId, {
              objective: input.action === 'create' ? input.objective : '',
            }),
      token: input.action === 'clear' ? null : tokenB,
    };
    return {
      state: 'sent',
      message: input.action === 'clear' ? 'Native goal cleared.' : 'Goal set.',
    };
  };
  await page.reload();
  await openGoal(page);
  await expect(dialog(page).getByRole('button', { name: 'Resume goal' })).toHaveCount(0);
  page.once('dialog', (confirmation) => confirmation.accept());
  await dialog(page).getByRole('button', { name: 'Clear goal' }).click();
  await expect(dialog(page).getByLabel('What should Codex accomplish?')).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Set goal' })).toBeDisabled();
  await dialog(page).getByLabel('What should Codex accomplish?').fill('Now check the appendix.');
  await dialog(page).getByRole('button', { name: 'Set goal' }).click();
  await expect(dialog(page).getByText('Now check the appendix.')).toBeVisible();
  expect(chat.posts.map(({ action, expectedToken }) => [action, expectedToken])).toEqual([
    ['clear', tokenA],
    ['create', null],
  ]);
  expect(chat.posts[0].key).not.toBe(chat.posts[1].key);
  await page.keyboard.press('Escape');
  await expect(page.getByText('Ready when you are.')).toBeVisible();
});

test('goal creation fits above the phone keyboard with one form scroller', async ({
  page,
}, info) => {
  test.skip(
    !['phone', 'small-phone', 'iphone-webkit'].includes(info.project.name),
    'Tall phone viewport geometry.',
  );
  // Simulate keyboard geometry/events without claiming an actual iOS keyboard transition.
  await page.addInitScript(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 420 },
      offsetTop: { configurable: true, value: 20 },
      scale: { configurable: true, value: 1 },
    });
  });
  const chat = await sharedChat(page);
  await openGoal(page);
  const objective = dialog(page).getByLabel('What should Codex accomplish?');
  const text = 'Preserve the original evidence while checking the derivation.\n'.repeat(50);
  await objective.fill(text);
  const bounds = await dialog(page).boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(20);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(441);
  const field = await objective.boundingBox();
  expect(field!.y).toBeGreaterThanOrEqual(20);
  expect(field!.y + field!.height).toBeLessThanOrEqual(441);
  const form = dialog(page).locator('form');
  expect(await dialog(page).evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  expect(await form.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await form.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const set = dialog(page).getByRole('button', { name: 'Set goal' });
  const action = await set.boundingBox();
  expect(action!.y).toBeGreaterThanOrEqual(20);
  expect(action!.y + action!.height).toBeLessThanOrEqual(441);
  const close = dialog(page).getByRole('button', { name: 'Close dialog' });
  const closing = await close.boundingBox();
  expect(closing!.y).toBeGreaterThanOrEqual(20);
  expect(closing!.y + closing!.height).toBeLessThanOrEqual(441);
  await page.screenshot({ path: info.outputPath('phone-goal-keyboard.png') });
  await close.click();
  await openGoal(page);
  await expect(objective).toHaveValue(text);
  await form.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await set.click();
  await expect.poll(() => chat.posts.length).toBe(1);
  expect(chat.posts[0].action === 'create' && chat.posts[0].objective).toBe(text.trim());
});

test('typed /goal and the command menu read locally, retaining the shared draft through unsupported and offline states', async ({
  page,
}) => {
  const chat = await sharedChat(page);
  const calls: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/vscode/'))
      calls.push(request.url());
  });
  const composer = page.getByRole('textbox', { name: 'Message Codex' });
  await composer.fill('Unsent shared notes');
  await openGoal(page);
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Close dialog' }).click();
  await expect(composer).toHaveValue('Unsent shared notes');
  await composer.fill('/goal');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  expect(chat.posts).toEqual([]);
  expect(calls).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(composer).toHaveValue('/goal');
  chat.view = { ...chat.view, supported: false, message: 'This companion needs a safe update.' };
  await page.reload();
  await openGoal(page);
  await expect(dialog(page)).toContainText('This companion needs a safe update.');
  await page.keyboard.press('Escape');
  await expect(composer).toHaveValue('/goal');
  chat.state.status = 'offline';
  await page.reload();
  await expect(composer).toHaveValue('/goal');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog(page)).toContainText('Reconnect this conversation to change its goal.');
  expect(calls).toEqual([]);
});

test('shared /goal arguments retain text and unknown slash messages keep their existing literal behavior', async ({
  page,
}) => {
  const chat = await sharedChat(page);
  const messages: unknown[] = [];
  await page.route('**/api/vscode/windows/*/send', (route) => {
    messages.push(route.request().postDataJSON());
    return route.fulfill({ json: { state: 'sent', message: 'Fixture message sent.' } });
  });
  const composer = page.getByRole('textbox', { name: 'Message Codex' });
  await composer.fill('/goal preserve these words');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.mirror-delivery-status summary')).toHaveText(
    'Use /goal by itself to open goal controls. Your draft is retained.',
  );
  await expect(composer).toHaveValue('/goal preserve these words');
  expect(messages).toEqual([]);
  expect(chat.posts).toEqual([]);
  await composer.fill('/native-unknown');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composer).toHaveValue('');
  expect(messages).toEqual([
    expect.objectContaining({ threadId: chat.state.threadId, text: '/native-unknown' }),
  ]);
});

test('an older host without a goal endpoint explains capability and keeps the objective draft', async ({
  page,
}) => {
  const chat = await sharedChat(page);
  await openGoal(page);
  const objective = 'Keep this native objective draft';
  await dialog(page).getByLabel('What should Codex accomplish?').fill(objective);
  await page.keyboard.press('Escape');
  await page.route('**/api/vscode/windows/*/goal', (route) =>
    route.fulfill({ status: 404, json: { error: 'No goal endpoint' } }),
  );
  await page.reload();
  await openGoal(page);
  await expect(dialog(page)).toContainText('Native goals are not connected here.');
  await expect(dialog(page).getByRole('button', { name: 'Set goal' })).toHaveCount(0);
  expect(chat.posts).toEqual([]);
  const saved = await page.evaluate(
    (thread) =>
      JSON.parse(
        localStorage.getItem(`dock:native-goal:local:codex:${thread}:objective`) ?? 'null',
      ),
    chat.state.threadId,
  );
  expect(saved).toBe(objective);
  await page.goto('/#/chats');
  await expect(dialog(page)).toHaveCount(0);
});

test('shared goal Back keeps the thread and expanded offline /goal restores composer focus', async ({
  page,
}) => {
  const chat = await sharedChat(page);
  const messages: unknown[] = [];
  await page.route('**/api/vscode/windows/*/send', (route) => {
    messages.push(route.request().postDataJSON());
    return route.fulfill({ json: { state: 'sent', message: 'Unexpected message' } });
  });
  const here = page.url();
  const composer = page.getByRole('textbox', { name: 'Message Codex' });
  await composer.fill('Keep this shared draft');
  await openGoal(page);
  await expect(dialog(page)).toBeVisible();
  // Native goal owns the local Back step while its modal makes the page inert.
  await page.locator('a.home-back').evaluate((node) => (node as HTMLElement).click());
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(here);
  await expect(composer).toHaveValue('Keep this shared draft');
  await expect(composer).toBeFocused();

  chat.state.status = 'offline';
  await page.reload();
  await expect(composer).toBeVisible();
  await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
  const notepad = page.getByRole('dialog', { name: 'Write at length' });
  await notepad.getByRole('textbox').fill('/goal');
  const send = notepad.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(notepad).toHaveCount(0);
  await expect(dialog(page)).toContainText('Reconnect this conversation to change its goal.');
  await page.keyboard.press('Escape');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('/goal');
  await expect(page).toHaveURL(here);
  expect(chat.posts).toEqual([]);
  expect(messages).toEqual([]);
});
