import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  jobEstimateSchema,
  localJobSchema,
  mirrorStateSchema,
  mirrorWindowSchema,
  pulsarJobSchema,
  quarkCoordinatorStatusSchema,
  snapshotSchema,
  workItemsSchema,
  type MirrorState,
} from '@dock/shared';

// UI fixtures stay in the browser. Only to-do and managed draft persistence use
// the disposable demo database; nothing launches a real provider or local job.
async function snapshot(page: Page) {
  const response = await page.request.get('/api/snapshot');
  expect(response.ok()).toBe(true);
  return snapshotSchema.parse(await response.json());
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

function sharedChat(provider: 'codex' | 'claude' = 'codex'): MirrorState {
  return mirrorStateSchema.parse({
    windowId: randomUUID(),
    provider,
    label: 'Polish fixture computer',
    threadId: `polish-${randomUUID()}`,
    title: 'Shared polish conversation',
    status: 'idle',
    message: '',
    entries: [{ id: 'fixture-reply', role: 'assistant', text: 'Retained shared reply.' }],
  });
}

test('VS Code setup stays at the top of Chats and opens instructions without leaving the list', async ({
  page,
}) => {
  const editor = sharedChat();
  const terminal = { ...sharedChat(), source: 'codex-daemon', title: 'Separate native session' };
  await page.route('**/api/vscode/windows', (route) =>
    route.fulfill({ json: [editor, terminal].map((chat) => mirrorWindowSchema.parse(chat)) }),
  );
  await page.goto('/#/home');
  await expect(page.getByRole('button', { name: /^VS Code on this computer:/ })).toHaveCount(0);
  await page.locator('a[href="#/chats"]:visible').first().click();
  await page.getByRole('button', { name: /^VS Code on this computer:/ }).click();
  const setup = page.getByRole('dialog', { name: 'VS Code setup' });
  await expect(setup).toBeVisible();
  await expect(page).toHaveURL(/#\/chats$/);
  await expect(setup).toContainText('The extension is connected');
  await expect(setup).toContainText('Install from VSIX');
  await expect(setup).toContainText('Chats → Shared');
  await expect(setup.getByRole('link', { name: 'Extension setup guide' })).toHaveAttribute(
    'href',
    /CONTRIBUTOR_SETUP.md#optional-vs-code-companion$/,
  );
  await expect(setup).not.toContainText('Shared polish conversation');
  await expect(setup).not.toContainText('Separate native session');
  const bounds = await setup.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: test.info().outputPath('vscode-setup.png') });
  await setup.getByRole('button', { name: 'Close dialog' }).click();
  await expect(setup).toHaveCount(0);
  await noOverflow(page);
});

test('A connected shared chat reads its first history even when opened in a background browser', async ({
  page,
}) => {
  const editor = sharedChat();
  await page.addInitScript(() =>
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }),
  );
  await page.route('**/api/vscode/windows', (route) =>
    route.fulfill({ json: [mirrorWindowSchema.parse(editor)] }),
  );
  await page.route(`**/api/vscode/windows/${editor.windowId}`, (route) =>
    route.fulfill({ json: editor }),
  );
  await page.goto(`/#/vscode/${encodeURIComponent(`codex:${editor.threadId}`)}`);
  await expect(page.getByText('Retained shared reply.', { exact: true })).toBeVisible();
  await expect(page.locator('.mirror-header')).toContainText('Connected');
  await expect(page.getByRole('button', { name: 'Open notepad', exact: true })).toBeVisible();
});

test('an app update offers a reload without replacing an unsent draft', async ({ page }) => {
  await page.goto('/#/home');
  const draft = page.getByRole('textbox', { name: 'New to-do', exact: true });
  await draft.fill('Keep this unsent note across an app update.');
  await page.route('**/', async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    const response = await route.fetch();
    const html = (await response.text()).replace(
      /src="\/assets\/index-[^"]+\.js"/,
      'src="/assets/next-test-release.js"',
    );
    await route.fulfill({ response, body: html });
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.home-update')).toBeVisible();
  await expect(draft).toHaveValue('Keep this unsent note across an app update.');
  await page.unroute('**/');
  await page.getByRole('button', { name: 'Reload app', exact: true }).click();
  await expect(draft).toHaveValue('Keep this unsent note across an app update.');
  await expect(page.locator('.home-update')).toHaveCount(0);
});

test('Home rounds the usage observation interval to whole minutes, with a one-minute minimum', async ({
  page,
}) => {
  const state = await snapshot(page);
  const project = state.projects.find((p) => !p.internal)!;
  state.agents.find((a) => a.id === project.managerId)!.status = 'running';
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: state }));
  let minutes = 10.51;
  await page.route('**/api/project-rates', (route) => {
    const now = Date.now();
    return route.fulfill({
      json: {
        observedAt: new Date(now).toISOString(),
        notice: 'Browser-only estimated usage fixture.',
        rates: [
          {
            projectId: project.id,
            provider: 'codex',
            windowId: 'weekly',
            label: 'Weekly',
            resetsAt: new Date(now + 86_400_000).toISOString(),
            from: new Date(now - minutes * 60_000).toISOString(),
            to: new Date(now).toISOString(),
            estimatedPercentPerHour: 2.4,
            estimatedPercent: 0.4,
            samples: 3,
            stale: false,
          },
        ],
      },
    });
  });
  await page.goto('/#/home');
  const notes = page.locator('.running-notes');
  await expect(notes).toContainText('over the last 11 min');
  for (const [interval, displayed] of [
    [10.49, 10],
    [0.2, 1],
  ]) {
    minutes = interval;
    await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
    await expect(notes).toContainText(`over the last ${displayed} min`);
  }
  await expect(page.locator('.overview-running')).toContainText('2.4 %/h');
  await noOverflow(page);
});

test('Home keeps every to-do keystroke and multiline title/detail through reload and a lost save response', async ({
  page,
}, info) => {
  await page.goto('/#/home');
  const editor = page.getByRole('textbox', { name: 'New to-do', exact: true });
  await expect(editor).toHaveJSProperty('tagName', 'TEXTAREA');
  await editor.fill('');
  await page.evaluate(() => {
    const inputs: { value: string; saved: string | null }[] = [];
    (window as unknown as { todoInputs: typeof inputs }).todoInputs = inputs;
    // React's root handler has run before this document-level listener. Checking
    // here distinguishes per-input storage from a later debounce or blur save.
    document.addEventListener('input', (event) => {
      const field = event.target;
      if (field instanceof HTMLTextAreaElement && field.id === 'todo-new')
        inputs.push({
          value: field.value,
          saved: sessionStorage.getItem('dock:local:home-todo:draft'),
        });
    });
  });
  const title = `Polish ${info.project.name} ${randomUUID().slice(0, 8)}`;
  const detail = 'First detail line.\nSecond detail line.';
  for (const [index, line] of [title, '', ...detail.split('\n')].entries()) {
    if (index) await editor.press('Enter');
    if (line) await editor.pressSequentially(line);
  }
  const text = `${title}\n\n${detail}`;
  await expect(editor).toHaveValue(text);
  const inputs = await page.evaluate(
    () =>
      (window as unknown as { todoInputs: { value: string; saved: string | null }[] }).todoInputs,
  );
  expect(inputs.length).toBeGreaterThan(20);
  expect(inputs.every((input) => input.value === input.saved)).toBe(true);
  await page.reload();
  await expect(editor).toHaveValue(text);

  const submissions: { key: string; kind: string; title: string; detail: string }[] = [];
  await page.route('**/api/work-items', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (submissions.length === 1)
      return route.fulfill({ status: 502, json: { error: 'Saved, but the response was lost.' } });
    return route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.todo-error')).toContainText('response was lost');
  await expect(editor).toHaveValue(text);
  await page.reload();
  await expect(editor).toHaveValue(text);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(editor).toHaveValue('');
  expect(submissions).toHaveLength(2);
  expect(submissions[0]).toMatchObject({ kind: 'general', title, detail });
  expect(submissions[1]).toEqual(submissions[0]);
  expect(
    await page.evaluate(() => sessionStorage.getItem('dock:local:home-todo:draft')),
  ).toBeNull();
  await page.reload();
  const row = page.locator('.todo-list li').filter({ has: page.getByText(title, { exact: true }) });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.todo-detail')).toHaveText(detail);
  const saved = workItemsSchema.parse(await (await page.request.get('/api/work-items')).json());
  expect(saved.items.filter((item) => item.title === title)).toHaveLength(1);
  expect(saved.items.find((item) => item.title === title)).toMatchObject({ title, detail });
  await noOverflow(page);
});

test('QUARK excludes completed tasks, runs and local jobs from Active and searches all ten-at-a-time pages', async ({
  page,
}, info) => {
  const state = await snapshot(page);
  const coordinator = quarkCoordinatorStatusSchema.parse(
    await (await page.request.get('/api/quark/coordinator')).json(),
  );
  const project = state.projects.find((p) => !p.internal)!;
  const template = state.tasks.find((t) => t.projectId === project.id)!;
  coordinator.agentId = null;
  coordinator.projects = coordinator.projects.filter((p) => p.id === project.id);
  coordinator.projects[0].name = 'Ledger Alpha';
  coordinator.projects[0].policy.paused = false;
  state.tasks = Array.from({ length: 23 }, (_, index) => ({
    ...template,
    id: randomUUID(),
    title: `Archive item ${String(index + 1).padStart(2, '0')}`,
    status: (['done', 'integrated', 'split'] as const)[index % 3],
  }));
  state.tasks.push({
    ...template,
    id: randomUUID(),
    title: 'Current waiting task',
    status: 'open',
  });
  state.tasks.push({
    ...template,
    id: randomUUID(),
    title: 'Current question task',
    status: 'needs_decision',
  });
  const manager = state.agents.find((a) => a.id === project.managerId)!;
  manager.model = 'fixture-completed-model';
  manager.status = 'idle';
  const job = pulsarJobSchema.parse({
    runId: randomUUID(),
    agentId: manager.id,
    taskId: null,
    projectName: 'Run Ledger',
    agentName: 'Archived model run',
    provider: 'codex',
    status: 'completed',
    estimate: jobEstimateSchema.parse({}),
    held: false,
    override: false,
    reason: 'Completed fixture',
    eligible: false,
    expectedFinishAt: null,
    tokensCharged: 125,
    tokenBasis: 'measured',
  });
  coordinator.queue.history = [job];
  coordinator.queue.jobs = [
    { ...job, runId: randomUUID(), agentName: 'Current working run', status: 'running' },
  ];
  const now = new Date().toISOString();
  coordinator.localJobs = [
    localJobSchema.parse({
      id: randomUUID(),
      kind: 'youtube-transcription',
      projectId: project.id,
      taskId: null,
      requestedBy: null,
      url: 'https://example.invalid/fixture',
      resources: {},
      status: 'completed',
      phase: 'finished',
      message: 'Completed local fixture',
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      autoPaused: false,
      attempt: 1,
      transcriptAvailable: true,
      expectedFinishAt: null,
    }),
  ];
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: state }));
  await page.route('**/api/quark/coordinator', (route) => route.fulfill({ json: coordinator }));
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url());
  });
  await page.goto('/#/work');
  await expect(page.getByRole('button', { name: 'Active work', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('region', { name: 'Completed', exact: true })).toHaveCount(0);
  await expect(page.locator('.quark-ticket')).toHaveCount(3);
  await expect(page.locator('.quark-board')).not.toContainText('Archive item');
  await expect(page.locator('.quark-board')).not.toContainText('Archived model run');
  await expect(page.locator('.quark-board')).not.toContainText('Video transcription');
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  const completed = page.getByRole('region', { name: 'Completed', exact: true });
  const cards = completed.locator('.quark-ticket');
  await expect(cards).toHaveCount(10);
  await expect(completed.locator('h3 b')).toHaveText('25');
  await completed.getByRole('button', { name: 'Show 10 more', exact: true }).click();
  await expect(cards).toHaveCount(20);
  await completed.getByRole('button', { name: 'Show 10 more', exact: true }).click();
  await expect(cards).toHaveCount(25);
  await expect(completed.getByRole('button', { name: 'Show 10 more' })).toHaveCount(0);
  const search = page.getByRole('searchbox', { name: 'Find completed work', exact: true });
  await search.fill('ARCHIVE ITEM 22');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Archive item 22');
  await search.fill('fixture-completed-model');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Archived model run');
  await search.fill('Local Whisper');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Video transcription');
  await search.fill('ledger alpha');
  await expect(cards).toHaveCount(10);
  await expect(completed.locator('h3 b')).toHaveText('24');
  await search.fill('no matching fixture');
  await expect(cards).toHaveCount(0);
  await expect(completed).toContainText('No matching completed work.');
  await search.fill('');
  await expect(cards).toHaveCount(10);
  await expect(cards.locator('.quark-ticket-facts')).toHaveCount(0);
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath('completed.png') });
  await page.getByRole('button', { name: 'Active work', exact: true }).click();
  await expect(page.locator('.quark-ticket')).toHaveCount(3);
  expect(writes).toEqual([]);
});

test('Home uses the alien brand and functional headings, and QUARK has no transcription shortcut', async ({
  page,
}, info) => {
  await page.goto('/#/home');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  const logo = page.locator('img[src="/dock.svg?v=alien"]:visible').first();
  await expect(logo).toBeVisible();
  expect(
    await logo.evaluate((element) => (element as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
  const asset = await page.request.get('/dock.svg?v=alien');
  expect(asset.ok()).toBe(true);
  expect(await asset.text()).toContain('class="alien-eyes"');
  await expect(
    page.getByText(/One home for your agents|Your ideas, in good hands|Your agents, together/i),
  ).toHaveCount(0);
  await expect(page.locator('.overview-destinations a')).toHaveText([/Chats/, /Apps/, /QUARK/]);
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath('home.png') });
  await page.goto('/#/work');
  await expect(page.getByRole('heading', { name: 'QUARK', exact: true })).toBeVisible();
  await expect(page.locator('.activity-shortcuts a[href="#/transcribe"]')).toHaveCount(0);
  await expect(page.locator('.activity-shortcuts')).toContainText('Computer health');
  await noOverflow(page);
});

test('Shared chat discovery refreshes cached metadata and marks disconnected chats offline', async ({
  page,
}) => {
  const cached = sharedChat();
  cached.title = 'Old cached title';
  cached.status = 'busy';
  await page.addInitScript((chat) => {
    sessionStorage.setItem('dock:mirror-chats:local', JSON.stringify([chat]));
  }, mirrorWindowSchema.parse(cached));
  let live: MirrorState[] = [];
  let reads = 0;
  await page.route('**/api/vscode/windows', (route) => {
    reads++;
    return route.fulfill({ json: live.map((chat) => mirrorWindowSchema.parse(chat)) });
  });
  await page.goto('/#/chats');
  await page
    .getByRole('group', { name: 'Conversation type' })
    .getByRole('button', { name: 'Shared', exact: true })
    .click();
  const rows = page.locator('.chat-row.vscode');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Old cached title');
  await expect(rows.first().locator('.chat-row-state')).toHaveText('Offline');
  live = [{ ...cached, windowId: randomUUID(), title: 'Refreshed shared title', status: 'idle' }];
  await expect(rows.first()).toContainText('Refreshed shared title');
  await expect(rows.first().locator('.chat-row-state')).toHaveText('Connected');
  expect(reads).toBeGreaterThan(1);
  live[0].status = 'busy';
  await expect(rows.first().locator('.chat-row-state')).toHaveText('Working');
  live = [];
  await expect(rows.first().locator('.chat-row-state')).toHaveText('Offline');
  await expect(rows.first()).toContainText('Refreshed shared title');
  await expect(rows).toHaveCount(1);
  await noOverflow(page);
});

test('Managed chat notepad shares the multiline draft and keeps edits through minimize and reload', async ({
  page,
}) => {
  const state = await snapshot(page);
  const manager = state.agents.find(
    (a) => a.id === state.projects.find((p) => !p.internal)!.managerId,
  )!;
  const sends: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(messages|commands|start)$/.test(request.url()))
      sends.push(request.url());
  });
  await page.goto(`/#/chat/${manager.id}`);
  const composer = page.getByRole('textbox', { name: `Message ${manager.name}`, exact: true });
  const text = `Unsent ${randomUUID()}\nA second draft line.`;
  await composer.fill(text);
  await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
  const notepad = page.getByRole('dialog', { name: 'Write at length', exact: true });
  const editor = notepad.getByRole('textbox', {
    name: `Long message to ${manager.name}`,
    exact: true,
  });
  await expect(editor).toHaveValue(text);
  const revised = `${text}\nKeep this edit too.`;
  await editor.fill(revised);
  await expect(notepad.locator('.notepad-status')).toHaveText('Saved');
  await expect(notepad.getByRole('button', { name: 'Versions', exact: true })).toBeVisible();
  await expect(notepad.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
  await notepad.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expect(composer).toHaveValue(revised);
  await page.reload();
  await expect(composer).toHaveValue(revised);
  expect(sends).toEqual([]);
  await noOverflow(page);
});

test('Shared chats retain multiline drafts on reload and expose their current long-form control coverage', async ({
  page,
}, info) => {
  const chat = sharedChat('claude');
  await page.route('**/api/vscode/windows', (route) =>
    route.fulfill({ json: [mirrorWindowSchema.parse(chat)] }),
  );
  await page.route(`**/api/vscode/windows/${chat.windowId}`, (route) =>
    route.fulfill({ json: chat }),
  );
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url());
  });
  await page.goto(`/#/chats/vscode/${encodeURIComponent(`claude:${chat.threadId}`)}`);
  const composer = page.getByRole('textbox', { name: 'Message Claude Code', exact: true });
  await expect(composer).toBeVisible();
  const text = 'An unsent shared draft.\nKeep both lines after reloading.';
  await composer.fill(text);
  await page.reload();
  await expect(composer).toHaveValue(text);
  // Observe the baseline gap without requiring that a future correction remain
  // absent. The frontend task owns shared Expand/Versions and assistant views.
  const controls = {
    expand: await page.getByRole('button', { name: 'Open notepad', exact: true }).count(),
    versions: await page.getByRole('button', { name: 'Versions', exact: true }).count(),
  };
  await info.attach('shared-long-form-controls', {
    body: JSON.stringify(controls),
    contentType: 'application/json',
  });
  expect(writes).toEqual([]);
  await noOverflow(page);
});

test('internal development managers stay out of owner lists, while a newly created project is visible', async ({
  page,
  baseURL,
}) => {
  const original = await snapshot(page);
  const internalIds = new Set(original.projects.map((p) => p.id));
  const originalManager = original.agents.find((a) => a.role === 'manager')!;
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const state = snapshotSchema.parse(await response.json());
    state.projects = state.projects.map((p) =>
      internalIds.has(p.id) ? { ...p, internal: true } : p,
    );
    await route.fulfill({ json: state });
  });
  await page.goto('/#/managers');
  await expect(page.getByRole('button', { name: 'Managers', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.chat-row')).toHaveCount(0);
  await expect(
    page.getByText('No conversations yet. Choose New to start a project.'),
  ).toBeVisible();
  await page.goto('/#/home');
  await expect(page.locator('.overview-destinations')).toContainText('0 project managers');
  await page.goto('/#/projects');
  await expect(page.locator('.flow-project-grid > *')).toHaveCount(0);
  await page.goto('/#/work');
  await expect(page.locator('.quark-projects a')).toHaveCount(0);
  await page.goto('/#/advanced');
  await expect(page.locator(`a[href="#/advanced/${originalManager.id}"]`)).toBeVisible();
  const response = await page.request.post('/api/projects', {
    headers: { Origin: baseURL! },
    data: { key: randomUUID(), name: 'My actual project', provider: 'codex' },
  });
  expect(response.ok()).toBe(true);
  const project = await response.json();
  await page.goto('/#/managers');
  // The API fixture bypasses the creation UI's snapshot refresh.
  await page.reload();
  await expect(page.locator(`.chat-list a[href="#/chat/${project.managerId}"]`)).toBeVisible();
  await expect(page.locator('.chat-row')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.chat-row')).toHaveCount(1);
  await noOverflow(page);
});
