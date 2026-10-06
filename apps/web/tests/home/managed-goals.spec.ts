import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import {
  managedGoalActionSchema,
  managedGoalViewSchema,
  type Agent,
  type ManagedGoalAction,
  type ManagedGoalView,
} from '@dock/shared';

const shots = '../../data/managed-goals';
const owned = new WeakMap<Page, string[]>();
test.afterEach(async ({ page, baseURL }) => {
  await page.unrouteAll({ behavior: 'wait' });
  for (const agentId of owned.get(page) ?? []) {
    const removed = await page.request.post(`/api/agents/${agentId}/remove`, {
      headers: { Origin: baseURL! },
      data: { key: randomUUID() },
    });
    expect(removed.ok()).toBe(true);
  }
});

/** A real demo project manager; Claude is presented through typed snapshot/detail overrides. */
async function manager(page: Page, origin: string, provider: 'codex' | 'claude') {
  const response = await page.request.post('/api/projects', {
    headers: { Origin: origin },
    data: { key: randomUUID(), name: `Goal ${randomUUID().slice(0, 8)}`, provider: 'codex' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const project = (await response.json()) as { managerId: string };
  owned.set(page, [...(owned.get(page) ?? []), project.managerId]);
  if (provider === 'claude') {
    const override: Partial<Agent> = {
      provider: 'claude',
      model: 'claude-fixture',
      modelSelection: 'exact',
    };
    const id = project.managerId;
    await page.route('**/api/snapshot', async (route) => {
      const value = await (await route.fetch()).json();
      value.agents = value.agents.map((item: Agent) =>
        item.id === id ? { ...item, ...override } : item,
      );
      await route.fulfill({ json: value });
    });
    await page.route(new RegExp(`/api/agents/${id}(?:\\?.*)?$`), async (route) => {
      const value = await (await route.fetch()).json();
      value.agent = { ...value.agent, ...override };
      await route.fulfill({ json: value });
    });
  }
  return project.managerId;
}

type Answer = 'lost' | 'conflict' | 'inspect' | 'apply';
/** The goal endpoint as typed fixtures: revisions, idempotent keys and one queued receipt. */
async function goalEndpoint(page: Page, agentId: string, initial: ManagedGoalView['goal'] = null) {
  const runId = randomUUID();
  const fixture = {
    runId,
    view: managedGoalViewSchema.parse({
      supported: true,
      goal: initial,
      continuation: initial ? { runId, status: 'queued', reason: null } : null,
      message: '',
    }),
    gets: 0,
    posts: [] as ManagedGoalAction[],
    answer: (_: ManagedGoalAction): Answer => 'apply',
    held: null as null | { method: string; arrived: () => void; release: Promise<void> },
    results: new Map<string, ManagedGoalView>(),
  };
  const hold = (method: 'GET' | 'POST') => {
    let release!: () => void;
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    fixture.held = { method, arrived, release: new Promise((resolve) => (release = resolve)) };
    return { reached, release };
  };
  const apply = (input: ManagedGoalAction): ManagedGoalView | 'conflict' => {
    const old = fixture.results.get(input.key);
    // The server retains the action receipt, then returns the current view on a retry.
    if (old) return fixture.view;
    const goal = fixture.view.goal;
    if ((goal?.revision ?? null) !== input.expectedRevision) return 'conflict';
    const now = new Date().toISOString();
    const replacement = input.action === 'replace';
    const newObjective = input.action === 'create' || replacement;
    const continuationId = replacement ? randomUUID() : fixture.runId;
    const status = {
      create: 'active',
      replace: 'active',
      pause: 'paused',
      resume: 'active',
      stop: 'stopped',
    } as const;
    const next = managedGoalViewSchema.parse({
      supported: true,
      goal: {
        id: newObjective ? randomUUID() : goal!.id,
        agentId,
        revision: newObjective ? 1 : goal!.revision + 1,
        objective: 'objective' in input ? input.objective : goal!.objective,
        status: status[input.action],
        progress: newObjective ? { summary: '', nextAction: null } : goal!.progress,
        lastRunId: null,
        continuationRunId: input.action === 'stop' ? null : continuationId,
        createdAt: newObjective ? now : goal!.createdAt,
        updatedAt: now,
      },
      continuation:
        input.action === 'stop'
          ? null
          : {
              runId: continuationId,
              status: 'queued',
              reason:
                input.action === 'pause'
                  ? 'Goal paused. Resume keeps this same queued continuation.'
                  : 'Waiting for this project’s hourly share',
            },
      message: '',
    });
    fixture.results.set(input.key, next);
    fixture.runId = continuationId;
    fixture.view = next;
    return next;
  };
  await page.route(new RegExp(`/api/agents/${agentId}/goal$`), async (route: Route) => {
    const request = route.request();
    const held = fixture.held?.method === request.method() ? fixture.held : null;
    if (held) fixture.held = null;
    if (request.method() === 'GET') {
      fixture.gets++;
      const json = fixture.view;
      if (held) {
        held.arrived();
        await held.release;
      }
      return route.fulfill({ json });
    }
    const input = managedGoalActionSchema.parse(request.postDataJSON());
    fixture.posts.push(input);
    const answer = fixture.answer(input);
    const result = answer === 'conflict' || answer === 'inspect' ? answer : apply(input);
    if (held) {
      held.arrived();
      await held.release;
    }
    if (result === 'conflict')
      return route.fulfill({
        status: 409,
        json: { error: 'The goal changed. Refresh and try again.', code: 'GOAL_REVISION' },
      });
    // The manager's own failed turn: rejected before any change or queued work.
    if (result === 'inspect')
      return route.fulfill({
        status: 409,
        json: { error: 'Inspect the manager first.', code: 'GOAL_INSPECT_RESUME' },
      });
    // Applied, but the answer is cut off by a proxy: delivery is unknown to the browser.
    if (answer === 'lost') return route.fulfill({ status: 502, body: 'Bad gateway' });
    return route.fulfill({ json: result });
  });
  return { fixture, hold };
}

/** Any POST under this agent other than the goal endpoint could start a model turn. */
function watchModelCalls(page: Page, agentId: string) {
  const calls: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === 'POST' &&
      path.includes(`/agents/${agentId}`) &&
      path !== `/api/agents/${agentId}/goal`
    )
      calls.push(path);
  });
  return calls;
}

const tools = (page: Page) => page.getByRole('group', { name: 'Conversation tools' });
const stored = (page: Page, agentId: string) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{}'),
    `dock:managed-goal:local:${agentId}`,
  );

/** The dialog and its Close button fit the visible viewport; targets stay touch-sized. */
async function expectFits(page: Page, dialog: Locator) {
  const issues = await dialog.evaluate((node) => {
    const problems: string[] = [];
    // The useVisibleViewport model: a shortened visual viewport is the visible area.
    const view = visualViewport!;
    const layout = Math.max(document.documentElement.clientHeight, innerHeight);
    const keyboard = Math.abs(view.scale - 1) < 0.01 && view.height < layout - 80;
    const top = keyboard ? Math.max(0, view.offsetTop) : 0;
    const bottom = keyboard ? top + view.height : innerHeight;
    const box = node.getBoundingClientRect();
    if (box.top < top - 0.5 || box.bottom > bottom + 0.5) problems.push('dialog leaves viewport');
    if (box.left < -0.5 || box.right > innerWidth + 0.5) problems.push('dialog leaves sideways');
    for (const button of node.querySelectorAll('button, summary')) {
      const rect = button.getBoundingClientRect();
      if (!rect.width) continue;
      if (rect.height < 43.5) problems.push(`${button.textContent}: ${rect.height}px target`);
    }
    const close = node.querySelector('[aria-label="Close dialog"]')!.getBoundingClientRect();
    if (close.top < top || close.bottom > bottom) problems.push('Close is off screen');
    if (node.scrollWidth > node.clientWidth + 1) problems.push('dialog scrolls sideways');
    return problems;
  });
  expect(issues).toEqual([]);
}

for (const provider of ['codex', 'claude'] as const)
  test(`${provider} manager goal is off until created, then pauses, resumes and stops one queued receipt`, async ({
    page,
    baseURL,
  }, info) => {
    await mkdir(shots, { recursive: true });
    const id = await manager(page, baseURL!, provider);
    const { fixture } = await goalEndpoint(page, id);
    const modelCalls = watchModelCalls(page, id);
    await page.goto(`/#/chat/${id}`);
    await expect(page.locator('.chat-pane-meta')).toContainText(
      provider === 'codex' ? 'Codex' : 'Claude',
    );
    const entry = tools(page).getByRole('button', { name: /^Goal/ });
    await expect(entry).toHaveAccessibleName('Goal');
    expect((await entry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await entry.click();
    const dialog = page.getByRole('dialog', { name: 'Manager goal' });
    await expect(dialog.getByText('No goal is set.')).toBeVisible();
    // Opening reads only: no enrollment and no lifecycle or model request.
    expect(fixture.posts).toEqual([]);
    expect(fixture.view.goal).toBeNull();
    await expectFits(page, dialog);
    await dialog.screenshot({ path: `${shots}/${info.project.name}-${provider}-off.png` });

    const objective = 'Ship the reviewed data importer and summarize remaining risks.';
    await dialog.getByLabel('What should this manager accomplish?').fill(objective);
    await dialog.getByRole('button', { name: 'Start goal' }).click();
    await expect(dialog.getByText('Active', { exact: true })).toBeVisible();
    await expect(dialog.locator('.managed-goal-queue')).toHaveText(
      'Next goal turn: Waiting in QUARK · Waiting for this project’s hourly share',
    );
    await expect(entry).toHaveAccessibleName('Goal: Active');
    expect(fixture.posts).toEqual([
      { key: fixture.posts[0].key, action: 'create', expectedRevision: null, objective },
    ]);
    await expectFits(page, dialog);
    await dialog.screenshot({ path: `${shots}/${info.project.name}-${provider}-active.png` });
    await page.screenshot({ path: `${shots}/${info.project.name}-${provider}-page.png` });

    await page.reload();
    await expect(entry).toHaveAccessibleName('Goal: Active');
    await entry.click();
    await expect(dialog.getByText(objective)).toBeVisible();
    expect(fixture.posts).toHaveLength(1);

    await dialog.getByRole('button', { name: 'Pause goal' }).click();
    await expect(dialog.getByText('Paused', { exact: true })).toBeVisible();
    await expect(dialog.locator('.managed-goal-queue')).toHaveText(
      'Next goal turn: Waiting in QUARK · Goal paused. Resume keeps this same queued continuation.',
    );
    await dialog.getByRole('button', { name: 'Resume goal' }).click();
    await expect(dialog.getByText('Active', { exact: true })).toBeVisible();
    expect(fixture.view.continuation?.runId).toBe(fixture.runId);

    await dialog.getByRole('button', { name: 'Stop goal' }).click();
    const confirm = dialog.getByRole('group', { name: 'Stop goal' });
    await expect(confirm).toContainText('does not mark the goal complete');
    await expect(confirm).toContainText('Stop reply');
    await expectFits(page, dialog);
    await confirm.getByRole('button', { name: 'Stop goal' }).click();
    await expect(dialog.getByText('Stopped', { exact: true })).toBeVisible();
    await expect(dialog).toContainText('the goal was not completed');
    await expect(dialog.getByText('Completed', { exact: true })).toHaveCount(0);
    await expect(entry).toHaveAccessibleName('Goal: Stopped');
    await expect(dialog.getByRole('button', { name: 'New objective' })).toBeVisible();

    expect(fixture.posts.map((p) => [p.action, p.expectedRevision])).toEqual([
      ['create', null],
      ['pause', 1],
      ['resume', 2],
      ['stop', 3],
    ]);
    expect(new Set(fixture.posts.map((p) => p.key)).size).toBe(4);
    expect(modelCalls).toEqual([]);
    await dialog.screenshot({ path: `${shots}/${info.project.name}-${provider}-stopped.png` });

    if (info.project.name === 'desktop' && provider === 'codex') {
      // Faithful layout emulation of 200% zoom on 1440×1000: a 720×500 CSS-pixel viewport.
      await page.setViewportSize({ width: 720, height: 500 });
      await expectFits(page, dialog);
      await page.screenshot({ path: `${shots}/desktop-zoom200-emulated.png` });
    }
    const close = dialog.getByRole('button', { name: 'Close dialog' });
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await page
      .locator('.chat-pane-head')
      .screenshot({ path: `${shots}/${info.project.name}-${provider}-toolbar.png` });
  });

test('ended goals retain their receipt without presenting another goal turn', async ({
  page,
  baseURL,
}, info) => {
  const id = await manager(page, baseURL!, 'claude');
  const now = new Date().toISOString();
  const { fixture } = await goalEndpoint(page, id, {
    id: randomUUID(),
    agentId: id,
    revision: 1,
    objective: 'Finish the reviewed bounded change.',
    status: 'completed',
    progress: { summary: 'All scoped work was reconciled.', nextAction: null },
    lastRunId: null,
    continuationRunId: null,
    createdAt: now,
    updatedAt: now,
  });
  fixture.view.goal!.lastRunId = fixture.runId;
  fixture.view.goal!.continuationRunId = fixture.runId;
  fixture.view.continuation!.status = 'completed';
  const modelCalls = watchModelCalls(page, id);
  await page.goto(`/#/chat/${id}`);
  await tools(page).getByRole('button', { name: /^Goal/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Manager goal' });
  const queue = dialog.locator('.managed-goal-queue');
  await expect(dialog.locator('.managed-goal-state strong')).toHaveText('Completed');
  await expect(queue).toHaveCount(0);
  await expect(dialog.getByText(/Next goal turn/)).toHaveCount(0);
  await dialog.screenshot({ path: info.outputPath('completed-retained-receipt.png') });

  for (const state of [
    { goal: 'stopped', turn: 'cancelled', text: null, reason: null },
    { goal: 'active', turn: 'queued', text: 'Next goal turn: Waiting in QUARK', reason: null },
    { goal: 'active', turn: 'running', text: 'Goal turn: Working', reason: null },
    {
      goal: 'blocked',
      turn: 'failed',
      text: 'Goal turn: Failed · Inspect the retained failed reply.',
      reason: 'Inspect the retained failed reply.',
    },
  ] as const) {
    fixture.view.goal!.revision++;
    fixture.view.goal!.status = state.goal;
    fixture.view.continuation!.status = state.turn;
    fixture.view.continuation!.reason = state.reason;
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(dialog.locator('.managed-goal-state strong')).toHaveText(
      state.goal === 'stopped' ? 'Stopped' : state.goal === 'blocked' ? 'Blocked' : 'Active',
    );
    if (state.text) await expect(queue).toHaveText(state.text);
    else await expect(queue).toHaveCount(0);
  }
  expect(fixture.view.continuation?.runId).toBe(fixture.runId);
  expect(fixture.posts).toEqual([]);
  expect(modelCalls).toEqual([]);
});

test('Claude manager keeps the exact unconfirmed goal change across reload and retries it only when asked', async ({
  page,
  baseURL,
}, info) => {
  const id = await manager(page, baseURL!, 'claude');
  const { fixture } = await goalEndpoint(page, id);
  fixture.answer = () => (fixture.posts.length === 1 ? 'lost' : 'apply');
  await page.goto(`/#/chat/${id}`);
  const entry = tools(page).getByRole('button', { name: /^Goal/ });
  await entry.click();
  const dialog = page.getByRole('dialog', { name: 'Manager goal' });
  const objective = 'Draft the methods section from the saved notes.';
  await dialog.getByLabel('What should this manager accomplish?').fill(objective);
  await dialog.getByRole('button', { name: 'Start goal' }).click();
  await expect(dialog.locator('.managed-goal-pending p')).toHaveText(
    'Not confirmed. Your text is saved. Retry safely checks the same change.',
  );
  const sent = fixture.posts[0];
  expect(sent).toEqual({ key: sent.key, action: 'create', expectedRevision: null, objective });
  expect(await stored(page, id)).toEqual({ draft: objective, pending: sent });
  await expectFits(page, dialog);
  await dialog.screenshot({ path: `${shots}/${info.project.name}-claude-unconfirmed.png` });

  // The server applied it; a matching reading still never closes the receipt by itself.
  await page.reload();
  await expect(entry).toHaveAccessibleName('Goal: Unconfirmed');
  await entry.click();
  await expect(dialog.getByLabel('Objective awaiting confirmation')).toHaveValue(objective);
  await expect(dialog.getByText('Active', { exact: true })).toBeVisible();
  const retry = dialog.getByRole('button', { name: 'Retry same change' });
  await expect(retry).toBeVisible();
  expect(fixture.posts).toHaveLength(1);
  expect(await stored(page, id)).toEqual({ draft: objective, pending: sent });

  await retry.click();
  await expect(retry).toBeHidden();
  await expect(entry).toHaveAccessibleName('Goal: Active');
  expect(fixture.posts).toEqual([sent, sent]);
  expect(fixture.view.goal!.revision).toBe(1);
  expect(await stored(page, id)).toEqual({ draft: null, pending: null });
});

test('Codex manager keeps a replacement draft through a revision conflict and ignores late answers after switching', async ({
  page,
  baseURL,
}, info) => {
  const first = await manager(page, baseURL!, 'codex');
  const second = await manager(page, baseURL!, 'codex');
  const now = new Date().toISOString();
  const saved = {
    id: randomUUID(),
    agentId: first,
    revision: 1,
    objective: 'Original saved objective.',
    status: 'waiting' as const,
    progress: { summary: 'Reviewed two of five datasets.', nextAction: 'Review dataset three.' },
    lastRunId: null,
    continuationRunId: null,
    createdAt: now,
    updatedAt: now,
  };
  const a = await goalEndpoint(page, first, saved);
  const b = await goalEndpoint(page, second);
  await page.goto(`/#/chat/${first}`);
  const entry = tools(page).getByRole('button', { name: /^Goal/ });
  await expect(entry).toHaveAccessibleName('Goal: Waiting');
  await entry.click();
  const dialog = page.getByRole('dialog', { name: 'Manager goal' });
  await expect(dialog).toContainText('Review dataset three.');
  await dialog.getByRole('button', { name: 'Change objective' }).click();
  const replacement = 'Finish all five datasets and draft the comparison table.';
  await dialog.getByLabel('Replacement objective').fill(replacement);
  // The saved objective stays visible until the replacement is saved.
  await expect(dialog.getByText('Original saved objective.')).toBeVisible();

  // Another device changes the goal first.
  a.fixture.view = managedGoalViewSchema.parse({
    ...a.fixture.view,
    goal: { ...saved, revision: 2, objective: 'Changed on another device.' },
  });
  await dialog.getByRole('button', { name: 'Save objective' }).click();
  await expect(dialog.getByText(/The goal changed before this was saved/)).toBeInViewport();
  await expect(dialog.getByText('Changed on another device.')).toBeVisible();
  await expect(dialog.getByLabel('Replacement objective')).toHaveValue(replacement);
  expect(await stored(page, first)).toEqual({ draft: replacement, pending: null });
  await expectFits(page, dialog);
  await dialog.screenshot({ path: `${shots}/${info.project.name}-codex-conflict.png` });

  await page.reload();
  await entry.click();
  await expect(dialog.getByLabel('Replacement objective')).toHaveValue(replacement);
  await dialog.getByRole('button', { name: 'Save objective' }).click();
  await expect(dialog.getByText(replacement)).toBeVisible();
  expect(a.fixture.view.goal).toMatchObject({
    revision: 1,
    objective: replacement,
    progress: { summary: '', nextAction: null },
  });
  expect(a.fixture.view.goal!.id).not.toBe(saved.id);
  const [rejected, accepted] = a.fixture.posts;
  expect(rejected).toMatchObject({ action: 'replace', expectedRevision: 1 });
  expect(accepted).toEqual({
    key: accepted.key,
    action: 'replace',
    expectedRevision: 2,
    objective: replacement,
  });
  expect(accepted.key).not.toBe(rejected.key);

  // A reading started before a newer answer is ignored when it arrives late.
  const late = a.hold('GET');
  await dialog.getByRole('button', { name: 'Refresh' }).click();
  await late.reached;
  a.fixture.view = managedGoalViewSchema.parse({
    ...a.fixture.view,
    goal: { ...a.fixture.view.goal!, revision: 4, status: 'blocked' },
  });
  // The held reading captured the new goal's revision 1; a later one reports revision 4.
  await expect(dialog.getByRole('button', { name: 'Refreshing…' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await entry.click();
  await expect(dialog.getByText('Blocked', { exact: true })).toBeVisible();
  late.release();
  // Every reading has answered once Refresh is offered again; the late one changed nothing.
  await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expect(dialog.getByText('Blocked', { exact: true })).toBeVisible();

  // Blocked resumes directly; a manager turn that needs inspection is refused unchanged.
  await expect(dialog.getByRole('button', { name: 'Pause goal' })).toBeVisible();
  a.fixture.answer = (input) => (input.action === 'resume' ? 'inspect' : 'apply');
  await dialog.getByRole('button', { name: 'Resume goal' }).click();
  await expect(dialog.locator('.managed-goal-notice')).toContainText('inspect it in the chat');
  await expect(dialog.getByText('Blocked', { exact: true })).toBeVisible();
  expect(await stored(page, first)).toEqual({ draft: null, pending: null });
  expect(a.fixture.view.goal!.revision).toBe(4);
  a.fixture.answer = () => 'apply';

  // A slow, successful pause cannot replace a newer reading; its receipt still settles.
  const slow = a.hold('POST');
  await dialog.getByRole('button', { name: 'Pause goal' }).click();
  await slow.reached;
  expect(a.fixture.view.goal).toMatchObject({ revision: 5, status: 'paused' });
  a.fixture.view = managedGoalViewSchema.parse({
    ...a.fixture.view,
    goal: {
      ...a.fixture.view.goal!,
      revision: 6,
      progress: { summary: 'Checked dataset four.', nextAction: 'Compare datasets.' },
    },
    continuation: {
      runId: a.fixture.runId,
      status: 'queued',
      reason: 'Goal paused. Resume keeps this same queued continuation.',
    },
  });
  await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(dialog).toContainText('Checked dataset four.');
  slow.release();
  await expect.poll(() => stored(page, first)).toEqual({ draft: null, pending: null });
  await expect(entry).toHaveAccessibleName('Goal: Paused');
  await expect(dialog).toContainText('Checked dataset four.');
  await expect(dialog.locator('.managed-goal-queue')).toHaveText(
    'Next goal turn: Waiting in QUARK · Goal paused. Resume keeps this same queued continuation.',
  );
  await dialog.screenshot({ path: `${shots}/${info.project.name}-codex-newer-reading.png` });

  // A resume still in flight when the person switches chats never reaches the other chat.
  const resume = a.hold('POST');
  await dialog.getByRole('button', { name: 'Resume goal' }).click();
  await resume.reached;
  await page.evaluate((target) => (location.hash = `#/chat/${target}`), second);
  await expect(entry).toHaveAccessibleName('Goal');
  resume.release();
  await expect.poll(() => a.fixture.view.goal?.status).toBe('active');
  await entry.click();
  await expect(dialog.getByText('No goal is set.')).toBeVisible();
  await expect(dialog.getByText(replacement)).toHaveCount(0);
  expect(b.fixture.posts).toEqual([]);
  expect(await stored(page, second)).toEqual({});
  // The first chat's receipt was closed by its own answer.
  await expect.poll(() => stored(page, first)).toEqual({ draft: null, pending: null });
});

test('Back closes the Goal dialog first, then the open panel, staying in the same chat', async ({
  page,
  baseURL,
}) => {
  const id = await manager(page, baseURL!, 'codex');
  await goalEndpoint(page, id);
  await page.goto(`/#/chat/${id}`);
  const here = new RegExp(`#/chat/${id}$`);
  const notes = page.locator('button.chat-tool', {
    has: page.locator('.chat-tool-label', { hasText: /^Notes$/ }),
  });
  await notes.click();
  await expect(notes).toHaveAttribute('aria-pressed', 'true');
  await tools(page).getByRole('button', { name: /^Goal/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Manager goal' });
  await expect(dialog).toBeVisible();
  const link = page.locator('a.home-back');
  if (!(await link.isVisible())) {
    // Navigation ignores swipes while a dialog is open; nothing behind it changes.
    await swipe(page);
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(here);
  }
  // The modal makes the page inert, so the app's Back control is invoked directly.
  await link.evaluate((node) => (node as HTMLElement).click());
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(here);
  await expect(notes).toHaveAttribute('aria-pressed', 'true');
  // The panel's own Back step is restored behind the dialog.
  if (await link.isVisible()) await link.click();
  else await swipe(page);
  await expect(notes).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(here);
});

/** The phone's Back swipe, as dispatched by the existing navigation tests. */
function swipe(page: Page) {
  return page.locator('#home-content').evaluate((node) => {
    const dispatch = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const points = [{ clientX: x, clientY: 300 }];
      Object.defineProperties(event, {
        touches: { value: type === 'touchend' ? [] : points },
        changedTouches: { value: points },
      });
      node.dispatchEvent(event);
    };
    dispatch('touchstart', 40);
    dispatch('touchmove', 150);
    dispatch('touchend', 150);
  });
}

test('the objective, Start goal and Close stay reachable above a 297px keyboard viewport', async ({
  page,
  baseURL,
}, info) => {
  test.skip(info.project.name === 'desktop', 'Touch keyboard geometry.');
  // Emulated visualViewport geometry (the useVisibleViewport model), not a physical keyboard.
  await page.addInitScript(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 297 },
      offsetTop: { configurable: true, value: 0 },
      scale: { configurable: true, value: 1 },
    });
  });
  const id = await manager(page, baseURL!, 'claude');
  await goalEndpoint(page, id);
  await page.goto(`/#/chat/${id}`);
  await tools(page).getByRole('button', { name: /^Goal/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Manager goal' });
  await dialog
    .getByLabel('What should this manager accomplish?')
    .fill('Compare the three calibration runs and flag outliers.\n'.repeat(12));
  await expectFits(page, dialog);
  const form = dialog.locator('form');
  expect(await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  expect(await form.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await form.evaluate((el) => (el.scrollTop = el.scrollHeight));
  for (const name of ['Start goal', 'Close dialog']) {
    const box = (await dialog.getByRole('button', { name }).boundingBox())!;
    expect(box.y, name).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, name).toBeLessThanOrEqual(297);
  }
  const width = page.viewportSize()!.width;
  await page.screenshot({
    path: `${shots}/${info.project.name}-keyboard-297.png`,
    clip: { x: 0, y: 0, width, height: 297 },
  });
});
