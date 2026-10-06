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
async function openGoal(page: Page) {
  await page.getByRole('button', { name: 'Show commands' }).click();
  await page
    .getByRole('dialog', { name: 'Session commands' })
    .getByRole('button', { name: '/goal Goal', exact: true })
    .click();
}
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
    await expect(tools(page).getByRole('button', { name: /^Goal/ })).toHaveCount(0);
    expect(
      (await page.getByRole('button', { name: 'Show commands' }).boundingBox())!.height,
    ).toBeGreaterThanOrEqual(44);
    await openGoal(page);
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
    expect(fixture.posts).toEqual([
      { key: fixture.posts[0].key, action: 'create', expectedRevision: null, objective },
    ]);
    await expectFits(page, dialog);
    await dialog.screenshot({ path: `${shots}/${info.project.name}-${provider}-active.png` });
    await page.screenshot({ path: `${shots}/${info.project.name}-${provider}-page.png` });

    await page.reload();
    await openGoal(page);
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
  await openGoal(page);
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
  await openGoal(page);
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
  await openGoal(page);
  await expect(dialog.getByLabel('Objective awaiting confirmation')).toHaveValue(objective);
  await expect(dialog.getByText('Active', { exact: true })).toBeVisible();
  const retry = dialog.getByRole('button', { name: 'Retry same change' });
  await expect(retry).toBeVisible();
  expect(fixture.posts).toHaveLength(1);
  expect(await stored(page, id)).toEqual({ draft: objective, pending: sent });

  await retry.click();
  await expect(retry).toBeHidden();
  expect(fixture.posts).toEqual([sent, sent]);
  expect(fixture.view.goal!.revision).toBe(1);
  await expect.poll(() => stored(page, id)).toEqual({ draft: null, pending: null });
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
  await openGoal(page);
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
  await openGoal(page);
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
  await openGoal(page);
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
  resume.release();
  await expect.poll(() => a.fixture.view.goal?.status).toBe('active');
  await openGoal(page);
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
  // The narrow Notes panel covers the composer. Invoke its scoped command directly
  // to exercise Back with an underlying panel, just as the inert Back link below.
  await page
    .getByRole('button', { name: 'Show commands' })
    .evaluate((node) => (node as HTMLElement).click());
  await page
    .getByRole('dialog', { name: 'Session commands' })
    .getByRole('button', { name: '/goal Goal', exact: true })
    .click();
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

test('desktop reachable command menu Back closes the menu before Notes', async ({
  page,
  baseURL,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Notes covers the composer on narrow layouts.');
  const id = await manager(page, baseURL!, 'codex');
  await goalEndpoint(page, id);
  await page.goto(`/#/chat/${id}`);
  const notes = page.locator('button.chat-tool', {
    has: page.locator('.chat-tool-label', { hasText: /^Notes$/ }),
  });
  await notes.click();
  await page.getByRole('button', { name: 'Show commands' }).click();
  const menu = page.getByRole('dialog', { name: 'Session commands' });
  await expect(menu).toBeVisible();
  // Modal inertness prevents clicking controls behind it; invoke the app Back handler.
  const back = page.locator('a.home-back');
  await back.evaluate((node) => (node as HTMLElement).click());
  await expect(menu).toBeHidden();
  await expect(notes).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(new RegExp(`#/chat/${id}$`));
  await back.click();
  await expect(notes).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(new RegExp(`#/chat/${id}$`));
});

test('a manager becoming read-only removes its goal and stale Back step', async ({
  page,
  baseURL,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Keep the Notes composer actually reachable.');
  const id = await manager(page, baseURL!, 'codex');
  await goalEndpoint(page, id);
  let archived = false;
  await page.route(new RegExp(`/api/agents/${id}(?:\\?.*)?$`), async (route) => {
    const value = await (await route.fetch()).json();
    if (archived) value.agent.archivedAt = new Date().toISOString();
    return route.fulfill({ json: value });
  });
  await page.goto(`/#/chat/${id}`);
  const notes = page.locator('button.chat-tool', {
    has: page.locator('.chat-tool-label', { hasText: /^Notes$/ }),
  });
  await notes.click();
  await openGoal(page);
  const goal = page.getByRole('dialog', { name: 'Manager goal' });
  await expect(goal).toBeVisible();
  archived = true;
  await expect(goal).toHaveCount(0, { timeout: 12_000 });
  // The next Back closes the actual panel, not a goal that is no longer mounted.
  await page.locator('a.home-back').click();
  await expect(notes).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(new RegExp(`#/chat/${id}$`));
  archived = false;
  await expect(page.getByRole('button', { name: 'Show commands' })).toBeVisible({
    timeout: 12_000,
  });
  await expect(goal).toHaveCount(0);
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
  await openGoal(page);
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

test('/goal opens only the scoped manager dialog and preserves draft, attachments and unknown slash handling', async ({
  page,
  baseURL,
}) => {
  const id = await manager(page, baseURL!, 'codex');
  const other = await manager(page, baseURL!, 'codex');
  const { fixture } = await goalEndpoint(page, id);
  await goalEndpoint(page, other);
  const modelCalls = watchModelCalls(page, id);
  await page.goto(`/#/chat/${id}`);
  const composer = page.locator('.composer > textarea');
  await expect(composer).toBeVisible();
  await composer.fill('Unsent working notes');
  // Attach through the normal picker, preserving the actual shared draft machinery.
  await page.getByLabel('Choose files').setInputFiles({
    name: 'draft.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Draft attachment'),
  });
  await expect(page.getByText('draft.txt', { exact: true }).first()).toBeVisible();
  await openGoal(page);
  const dialog = page.getByRole('dialog', { name: 'Manager goal' });
  await expect(dialog).toBeVisible();
  expect(fixture.posts).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(composer).toHaveValue('Unsent working notes');
  await expect(page.getByText('draft.txt', { exact: true }).first()).toBeVisible();
  await composer.fill('/goal');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(fixture.posts).toHaveLength(0);
  expect(modelCalls).toEqual([]);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(composer).toBeFocused();
  await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
  const notepad = page.getByRole('dialog', { name: 'Write at length' });
  await notepad.getByRole('textbox').fill('/goal');
  await notepad.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(notepad).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('/goal');
  expect(modelCalls).toEqual([]);
  await page.goto(`/#/chat/${other}`);
  await expect(dialog).toHaveCount(0);
  await page.goto(`/#/chat/${id}`);
  await expect(composer).toHaveValue('/goal');
  await expect(page.getByText('draft.txt', { exact: true }).first()).toBeVisible();
  await composer.fill('/goal extra text');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.getByText('Use /goal by itself to open goal controls. Your draft is retained.').first(),
  ).toBeVisible();
  await expect(composer).toHaveValue('/goal extra text');
  await composer.fill('/unknown');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send as text' })).toBeVisible();
  await expect(composer).toHaveValue('/unknown');
  expect(modelCalls).toEqual([]);
});

test('compact VS Code action uses the registered project and one safe retry without header overflow', async ({
  page,
  baseURL,
}, info) => {
  const id = await manager(page, baseURL!, 'codex');
  const detail = (await (await page.request.get(`/api/agents/${id}`)).json()) as {
    agent: { projectId: string };
  };
  await goalEndpoint(page, id);
  const calls: { url: string; key: string }[] = [];
  await page.route('**/api/projects/*/open-in-editor', async (route) => {
    calls.push({
      url: new URL(route.request().url()).pathname,
      key: route.request().postDataJSON().key,
    });
    return calls.length === 1
      ? route.fulfill({ status: 502, json: { error: 'Lost editor acknowledgement.' } })
      : route.fulfill({ json: { message: 'Opened in VS Code on this project’s computer.' } });
  });
  await page.goto(`/#/chat/${id}`);
  const button = tools(page).getByRole('button', { name: 'Open project in VS Code' });
  await expect(button).toHaveText('VS Code');
  await expect(page.locator('.chat-pane-project button')).toHaveCount(0);
  await expect(tools(page).getByRole('button', { name: /^Goal/ })).toHaveCount(0);
  await button.dblclick();
  await expect(
    page.getByRole('status').filter({ hasText: 'Lost editor acknowledgement.' }),
  ).toBeVisible();
  expect(calls).toHaveLength(1);
  await button.click();
  await expect(page.getByRole('status').filter({ hasText: 'Opened in VS Code' })).toBeVisible();
  expect(calls).toEqual([
    { url: `/api/projects/${detail.agent.projectId}/open-in-editor`, key: calls[0].key },
    { url: `/api/projects/${detail.agent.projectId}/open-in-editor`, key: calls[0].key },
  ]);
  const fits = async () =>
    expect(
      await page.locator('.chat-pane-head').evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return (
          el.scrollWidth <= el.clientWidth + 1 && rect.right <= innerWidth + 1 && rect.left >= 0
        );
      }),
    ).toBe(true);
  await fits();
  expect(
    await page.locator('.chat-editor-status').evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1;
    }),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('vscode-header.png') });
  if (info.project.name === 'desktop') {
    await page.setViewportSize({ width: 720, height: 500 });
    await fits();
  }
});

test('a missing manager goal endpoint retains the objective and explains capability without changing work', async ({
  page,
  baseURL,
}) => {
  const id = await manager(page, baseURL!, 'codex');
  const { fixture } = await goalEndpoint(page, id);
  await page.goto(`/#/chat/${id}`);
  await openGoal(page);
  const dialog = page.getByRole('dialog', { name: 'Manager goal' });
  await dialog
    .getByLabel('What should this manager accomplish?')
    .fill('Retain the manager objective');
  await page.keyboard.press('Escape');
  await page.route(`**/api/agents/${id}/goal`, (route) =>
    route.fulfill({ status: 404, json: { error: 'No goal endpoint' } }),
  );
  await openGoal(page);
  await expect(dialog).toContainText(
    'Goals are unavailable for this conversation. Your drafts are kept.',
  );
  await expect(dialog.getByRole('button', { name: 'Start goal' })).toBeDisabled();
  expect(await stored(page, id)).toEqual({ draft: 'Retain the manager objective', pending: null });
  expect(fixture.posts).toEqual([]);
});
