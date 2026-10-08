import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { defaultModelPolicy, detailSchema } from '@dock/shared';

test('a Claude-only first project defaults its workers correctly and preserves an explicit saved choice', async ({
  page,
}) => {
  let fail = true;
  await page.route('**/api/model-policy', (route) =>
    route.fulfill(
      fail
        ? { status: 503, json: { error: 'Temporarily unavailable' } }
        : {
            json: { policy: { ...defaultModelPolicy, enabledProviders: ['claude'] }, catalogs: [] },
          },
    ),
  );
  await page.goto('/#/new');
  const spawn = page.getByRole('button', { name: 'Spawn', exact: true });
  await expect(spawn).toBeDisabled();
  await expect(
    page.getByText('Could not read your model defaults. Try reading them again.'),
  ).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Read defaults again', exact: true }).click();
  const manager = page.getByRole('group', { name: 'Manager', exact: true });
  await expect(manager.getByRole('combobox', { name: 'Provider', exact: true })).toHaveValue(
    'claude',
  );
  const mix = page.getByRole('slider', { name: 'Provider mix', exact: true });
  await expect(mix).toHaveAttribute('aria-valuetext', 'Claude only');
  await expect(spawn).toBeEnabled();
  await mix.focus();
  await mix.press('ArrowLeft');
  await expect(mix).toHaveAttribute('aria-valuetext', 'Claude heavy');
  await page.reload();
  await expect(mix).toHaveAttribute('aria-valuetext', 'Claude heavy');
  await expect(manager.getByRole('combobox', { name: 'Provider', exact: true })).toHaveValue(
    'claude',
  );
});

test('spawn an independently configured manager, retain notepad versions and send once through the real demo API', async ({
  page,
}, info) => {
  const name = `Flow ${info.project.name} ${randomUUID().slice(0, 8)}`;
  const original = 'Keep this draft until I send it.';
  const newer = 'A newer draft must remain available after restoring the first version.';
  const submissions: { key: string; text: string }[] = [];
  const priorities: { key: string; priority: string }[] = [];
  await page.route('**/api/projects/*/quark', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    priorities.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (priorities.length === 1)
      await route.fulfill({
        status: 502,
        json: { error: 'Priority saved; its response was lost.' },
      });
    else await route.fulfill({ response });
  });
  await page.route('**/api/agents/*/messages', async (route) => {
    submissions.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (submissions.length === 1)
      await route.fulfill({
        status: 502,
        json: { error: 'The response was lost. Your draft is retained; retry the same send.' },
      });
    else await route.fulfill({ response });
  });
  await page.goto('/#/chats');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page
    .getByRole('group', { name: 'Start new' })
    .getByRole('link', { name: /New project/ })
    .click();
  await page.getByLabel('Project name', { exact: true }).fill(name);
  const manager = page.getByRole('group', { name: 'Manager', exact: true });
  await manager.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('codex');
  const managerModel = manager.getByRole('combobox', { name: 'Model', exact: true });
  await expect(managerModel.locator('option[value="demo"]')).toHaveCount(1);
  await managerModel.selectOption('demo');
  await expect(manager.getByRole('combobox', { name: 'Reasoning', exact: true })).toHaveValue(
    'medium',
  );
  const mix = page.getByRole('slider', { name: 'Provider mix', exact: true });
  await mix.focus();
  await mix.press('End');
  await mix.press('ArrowLeft');
  await expect(mix).toHaveAttribute('aria-valuetext', 'Claude heavy');
  const usage = page.getByRole('slider', { name: 'Usage', exact: true });
  await usage.focus();
  await usage.press('Home');
  await expect(usage).toHaveAttribute('aria-valuetext', 'Light');
  // Worker choices do not silently switch this manager or its exact live catalog choice.
  await expect(manager.getByRole('combobox', { name: 'Provider', exact: true })).toHaveValue(
    'codex',
  );
  await expect(managerModel).toHaveValue('demo');
  await page.getByRole('radio', { name: /Back burner/ }).check();
  await page.getByRole('button', { name: 'Spawn', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('response was lost');
  await page.reload();
  const brief = page.getByRole('dialog', { name: 'Describe your project', exact: true });
  await expect(brief).toBeVisible();
  await expect.poll(() => priorities.length).toBe(2);
  expect(priorities[0]).toEqual(priorities[1]);
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const project = snapshot.projects.find((p: { name: string }) => p.name === name);
  const managerId = project.managerId;
  const created = await (await page.request.get(`/api/agents/${managerId}`)).json();
  expect(created.agent).toMatchObject({ provider: 'codex', model: 'demo', effort: 'medium' });
  const workflowUrl = `/api/projects/${created.agent.projectId}/workflow`;
  const workflow = await (await page.request.get(workflowUrl)).json();
  expect(workflow).toMatchObject({ providerMix: 'claude-heavy', spending: 'light' });
  expect(
    await (await page.request.get(`/api/projects/${created.agent.projectId}/quark`)).json(),
  ).toMatchObject({ priority: 'background', revision: 1 });
  expect(created.runs).toHaveLength(0);
  expect(submissions).toHaveLength(0);
  const editor = brief.getByRole('textbox', { name: 'Project description', exact: true });
  await editor.fill(original);
  await expect(brief.locator('.notepad-status')).toHaveText('Saved in this browser');
  // Local versions are written after typing settles, and survive reloading the setup.
  await expect
    .poll(() =>
      page.evaluate(
        (value) =>
          Object.entries(localStorage).some(
            ([key, raw]) =>
              key.includes(':notepad-recovery:') &&
              JSON.parse(raw).versions.some((version: { text: string }) => version.text === value),
          ),
        original,
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(editor).toHaveValue(original);
  await brief.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expect(brief).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue writing', exact: true }).click();
  await expect(editor).toHaveValue(original);
  await editor.fill(newer);
  await expect(brief.locator('.notepad-status')).toHaveText('Saved in this browser');
  await brief.getByRole('button', { name: 'Versions', exact: true }).click();
  const versions = brief.getByRole('complementary', { name: 'Saved versions', exact: true });
  await versions.locator('.notepad-versions button').filter({ hasText: original }).first().click();
  await expect(editor).toHaveValue(original);
  await expect(
    versions.locator('.notepad-versions button').filter({ hasText: newer }).first(),
  ).toBeVisible();
  expect(submissions).toHaveLength(0);
  await brief.getByRole('button', { name: 'Versions', exact: true }).click();
  await page.screenshot({
    path: `../../data/screenshots/workspace/${info.project.name}-notepad.png`,
  });
  // Admission can precede the reply; wait for the page's completed read, including
  // its 5s fallback poll, before starting the rendered-reply assertion deadline.
  const completedRead = page.waitForResponse(async (response) => {
    if (
      new URL(response.url()).pathname !== `/api/agents/${managerId}` ||
      response.request().method() !== 'GET' ||
      !response.ok()
    )
      return false;
    const detail = detailSchema.parse(await response.json());
    const run = detail.runs.find(
      (run) => run.agentId === managerId && run.text === original && run.status === 'completed',
    );
    return (
      detail.agent.id === managerId &&
      detail.agent.status === 'idle' &&
      !!run &&
      detail.entries.some(
        (entry) =>
          entry.agentId === managerId &&
          entry.runId === run.id &&
          entry.kind === 'assistant' &&
          entry.text.includes('demo mode'),
      )
    );
  });
  await brief.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(brief.getByRole('alert')).toContainText('response was lost');
  await expect(editor).toHaveValue(original);
  await brief.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[0].key).toBe(submissions[1].key);
  expect(submissions.map((submission) => submission.text)).toEqual([original, original]);
  await expect(brief).toHaveCount(0);
  await expect(page).toHaveURL(/#\/chat\/[^/]+$/);
  await expect(page.locator('.message.user').filter({ hasText: original })).toHaveCount(1);
  await completedRead;
  await expect(page.locator('.message.assistant')).toContainText('demo mode');
  const composer = page.getByRole('textbox', { name: `Message ${name}`, exact: true });
  await expect(composer).toHaveValue('');
  expect(
    await page.evaluate(() => ({
      width: document.documentElement.scrollWidth <= innerWidth,
      height: document.documentElement.scrollHeight <= innerHeight,
    })),
  ).toEqual({ width: true, height: true });
  await page.screenshot({ path: `../../data/screenshots/workspace/${info.project.name}-chat.png` });
  // The conversation uses the actual demo catalog, with changes saved through settings.
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  const settings = page.locator('.chat-side .settings-card');
  await expect(settings.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('demo');
  await expect(settings.getByRole('combobox', { name: 'Reasoning', exact: true })).toHaveValue(
    'medium',
  );
  await settings.getByRole('combobox', { name: 'Model', exact: true }).selectOption('');
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/agents/${managerId}`)).json()).agent.modelSelection,
    )
    .toBe('policy');
  expect(await (await page.request.get(workflowUrl)).json()).toEqual(workflow);
  expect(submissions).toHaveLength(2);
  await page
    .locator('.chat-side')
    .getByRole('link', { name: 'Project overview', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  await page.getByRole('link', { name: 'Talk to manager', exact: true }).click();
  await expect(page.locator('.message.user').filter({ hasText: original })).toHaveCount(1);
});

test('a finished worker offers an explicitly separate evidence discussion without replaying its task', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const source = snapshot.agents.find((a: { role: string }) => a.role === 'implementer');
  const sourceDetail = await (await page.request.get(`/api/agents/${source.id}`)).json();
  source.model = 'demo';
  sourceDetail.agent = source;
  snapshot.tasks.find((t: { id: string }) => t.id === source.taskId).status = 'integrated';
  const discussion = {
    ...source,
    id: randomUUID(),
    role: 'researcher',
    parentId: null,
    permission: 'read-only',
    name: `About ${source.name}`,
    interview: {
      sourceAgentId: source.id,
      sourceTaskId: source.taskId,
      capturedAt: new Date().toISOString(),
      continuity: 'saved-evidence',
    },
  };
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route(`**/api/agents/${source.id}`, (route) => route.fulfill({ json: sourceDetail }));
  await page.route(`**/api/agents/${discussion.id}`, (route) =>
    route.fulfill({ json: { agent: discussion, entries: [], runs: [], hasMore: false } }),
  );
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/agents\//.test(request.url())) writes.push(request.url());
  });
  await page.route(`**/api/agents/${source.id}/interviews`, (route) =>
    route.fulfill({ json: discussion }),
  );
  await page.goto(`/#/chat/${source.id}`);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask about this work' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(discussion.name);
  await expect(page.locator('.flow-chat-notice')).toContainText(
    'new read-only discussion using saved evidence',
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain('/interviews');
  await page.getByRole('link', { name: 'Original worker', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(source.name);
});

for (const provider of ['codex', 'claude'] as const)
  test(`a finished ${provider} worker offers native continuity and an explicit evidence fallback without starting a turn`, async ({
    page,
  }, info) => {
    const snapshot = await (await page.request.get('/api/snapshot')).json();
    const source = snapshot.agents.find((a: { role: string }) => a.role === 'implementer');
    const sourceDetail = await (await page.request.get(`/api/agents/${source.id}`)).json();
    source.provider = provider;
    source.model = 'demo';
    source.threadId = randomUUID();
    source.status = 'idle';
    source.turnId = null;
    sourceDetail.agent = source;
    sourceDetail.runs = [
      {
        id: randomUUID(),
        agentId: source.id,
        sourceId: null,
        kind: 'user',
        text: 'Original finished request',
        status: 'completed',
        turnId: 'final-reply',
        createdAt: new Date().toISOString(),
      },
    ];
    sourceDetail.nativeDiscussion = 'available';
    snapshot.tasks.find((t: { id: string }) => t.id === source.taskId).status = 'integrated';
    const discussion = {
      ...source,
      id: randomUUID(),
      role: 'researcher',
      parentId: null,
      threadId: null,
      permission: 'read-only',
      name: `About ${source.name}`,
      interview: {
        sourceAgentId: source.id,
        sourceTaskId: source.taskId,
        capturedAt: new Date().toISOString(),
        continuity: 'native-fork',
        sourceThreadId: source.threadId,
        ...(provider === 'claude'
          ? { sourceMessageId: randomUUID() }
          : { sourceTurnId: 'final-reply' }),
      },
    };
    await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
    await page.route(`**/api/agents/${source.id}`, (route) =>
      route.fulfill({ json: sourceDetail }),
    );
    await page.route(`**/api/agents/${discussion.id}`, (route) =>
      route.fulfill({ json: { agent: discussion, entries: [], runs: [], hasMore: false } }),
    );
    const choices: { key: string; continuity?: string }[] = [];
    let turns = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/messages')) turns++;
    });
    await page.route(`**/api/agents/${source.id}/interviews`, (route) => {
      const choice = route.request().postDataJSON();
      choices.push(choice);
      if (choices.length === 1)
        return route.fulfill({
          status: 409,
          json: { error: 'Native history unavailable. Choose saved evidence.' },
        });
      discussion.interview.continuity = choice.continuity ?? 'saved-evidence';
      return route.fulfill({ json: discussion });
    });
    await page.goto(`/#/chat/${source.id}`);
    const context = page.getByLabel('Discussion context');
    await expect(context).toHaveValue('native');
    await expect(context.locator('option:checked')).toHaveText(
      `Original ${provider === 'claude' ? 'Claude' : 'Codex'} conversation`,
    );
    await context.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `../../data/screenshots/workspace/${info.project.name}-${provider}-native-discussion.png`,
    });
    await page.getByRole('button', { name: 'Ask about this work' }).click();
    await expect(page.locator('.flow-chat-notice')).toContainText('Native history unavailable');
    await context.selectOption('evidence');
    await page.getByRole('button', { name: 'Ask about this work' }).click();
    await expect(page.locator('.flow-chat-notice')).toContainText('using saved evidence');
    expect(choices[0].continuity).toBe('native-fork');
    expect(choices[1].continuity).toBeUndefined();
    expect(choices[0].key).not.toBe(choices[1].key);
    await page.getByRole('link', { name: 'Original worker', exact: true }).click();
    await context.selectOption('native');
    await page.getByRole('button', { name: 'Ask about this work' }).click();
    await expect(page.locator('.flow-chat-notice')).toContainText(
      'copy is prepared when you send your first question',
    );
    expect(turns).toBe(0);
  });

test('a native Claude helper exposes retained evidence and owning-session controls without a false model claim', async ({
  page,
}, info) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const parent = snapshot.agents.find((a: { role: string }) => a.role === 'manager');
  const child = {
    ...parent,
    id: randomUUID(),
    name: 'Native reviewer',
    role: 'researcher',
    provider: 'claude',
    status: 'idle',
    model: null as string | null,
    taskId: null,
    parentId: parent.id,
    nativeRootId: parent.id,
    nativePath: 'native-session/real-helper-id',
  };
  const caller = {
    ...child,
    id: randomUUID(),
    name: 'Native lead',
    nativePath: 'native-session/real-caller-id',
  };
  child.parentId = caller.id;
  snapshot.agents.push(caller, child);
  // The retained helper fixtures need matching browser-view metadata as well as chat reads.
  const workspace = {
    hostId: randomUUID(),
    client: {
      id: randomUUID(),
      label: 'Helper fixture',
      revision: 0,
      openAgentIds: [child.id],
      selectedAgentId: child.id,
      updatedAt: new Date().toISOString(),
    },
    others: [],
  };
  await page.route('**/api/workspace/clients', (route) => route.fulfill({ json: workspace }));
  await page.route(`**/api/workspace/${workspace.client.id}`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: workspace });
    const input = route.request().postDataJSON();
    expect(input.action.kind).toBe('open');
    workspace.client.selectedAgentId = input.action.agentId;
    workspace.client.openAgentIds = [
      ...new Set([...workspace.client.openAgentIds, input.action.agentId]),
    ];
    workspace.client.revision++;
    return route.fulfill({ json: { status: 'applied', state: workspace } });
  });
  await page.route(`**/api/agents/${caller.id}`, (route) =>
    route.fulfill({ json: { agent: caller, entries: [], runs: [], hasMore: false } }),
  );
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route(`**/api/agents/${child.id}`, (route) =>
    route.fulfill({
      json: {
        agent: child,
        entries: [
          {
            id: randomUUID(),
            agentId: child.id,
            runId: null,
            kind: 'assistant',
            title: 'Reported closing text',
            text: 'I checked the boundary conditions.',
            status: 'complete',
            createdAt: new Date().toISOString(),
          },
        ],
        runs: [],
        hasMore: false,
      },
    }),
  );
  await page.goto(`/#/chat/${child.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Native reviewer');
  await expect(page.getByText('Native model not reported', { exact: false })).toBeVisible();
  await expect(page.getByText('I checked the boundary conditions.', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Ask about this work', exact: false }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
  const invoker = page.getByRole('link', { name: 'Open invoking helper', exact: false });
  await expect(invoker).toHaveAttribute('href', `#/chat/${caller.id}`);
  const controls = page.getByRole('link', { name: 'Open controlling conversation', exact: false });
  await controls.scrollIntoViewIfNeeded();
  await expect(controls).toBeInViewport();
  await expect(page.locator('.flow-chat-notice [role=alert]')).toHaveCount(0);
  expect(
    await page
      .locator('.flow-chat-main')
      .evaluate((panel) => panel.scrollWidth <= panel.clientWidth + 1),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/screenshots/workspace/${info.project.name}-claude-helper.png`,
  });
  child.model = 'claude-native-fixture';
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Ask about this work', exact: false }),
  ).toBeEnabled();
  await expect(page.getByText('Native model not reported', { exact: false })).toHaveCount(0);
  await invoker.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Native lead');
  await expect(page.getByRole('link', { name: 'Open invoking helper' })).toHaveCount(0);
  await page.goto(`/#/chat/${child.id}`);
  await controls.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(parent.name);
  await page.unrouteAll({ behavior: 'wait' });
});

test('projects and conversations have panel scrolling and reachable controls at narrow sizes', async ({
  page,
}, info) => {
  await page.goto('/#/projects');
  await expect(page.locator('.flow-project-card').first()).toBeVisible();
  await page.screenshot({
    path: `../../data/screenshots/workspace/${info.project.name}-projects.png`,
  });
  await page.goto('/#/chats');
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('textbox', { name: 'Find a conversation' }).fill('Fieldnotes');
  await expect(page.locator('.flow-person')).toHaveCount(1);
  await page.locator('.flow-person').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fieldnotes');
  const violations = await page.evaluate(() =>
    [...document.querySelectorAll('.flow-page button, .flow-page input, .flow-page a')]
      .filter((node) => {
        const r = node.getBoundingClientRect();
        return r.width && r.height && r.height < 43;
      })
      .map((node) => node.textContent),
  );
  expect(violations).toEqual([]);
});

test('ordinary-folder tracking stays explicit and its uncertain confirmation survives reload', async ({
  page,
}, info) => {
  await page.route('**/api/project-options', (route) =>
    route.fulfill({ json: { canChooseFolder: true } }),
  );
  let key = '';
  await page.route('**/api/projects/connect-folder', (route) => {
    key = route.request().postDataJSON().key;
    return route.fulfill({
      json: route.request().postDataJSON().selectOnly
        ? { project: null, selection: { key, name: 'My research notes', needsTracking: true } }
        : { project: null, tracking: { key, name: 'My research notes' } },
    });
  });
  const confirmations: unknown[] = [];
  await page.route('**/api/projects/track-folder', async (route) => {
    confirmations.push(route.request().postDataJSON());
    if (confirmations.length === 1) return route.abort('failed');
    return route.fulfill({
      status: 409,
      json: {
        error: 'The folder is temporarily unavailable. Retry this folder or choose another.',
      },
    });
  });
  await page.goto('/#/new');
  await page.getByRole('radio', { name: /Existing folder/ }).check();
  await expect(page.getByText('Selected folder: My research notes', { exact: true })).toBeVisible();
  const region = page.getByRole('region', { name: 'Start tracking this folder' });
  await expect(region).toHaveCount(0);
  expect(confirmations).toHaveLength(0);
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('My research notes');
  const start = page.getByRole('button', { name: 'Spawn', exact: true });
  await start.scrollIntoViewIfNeeded();
  await expect(start).toBeInViewport();
  await page.screenshot({
    path: `../../data/screenshots/workspace/${info.project.name}-folder-tracking.png`,
  });
  await start.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(region.getByRole('button', { name: 'Choose another folder' })).toHaveCount(0);
  await page.reload();
  // The immediate notepad resumes its saved setup receipt automatically after reload.
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await page
    .getByRole('dialog', { name: 'Describe your project', exact: true })
    .getByRole('button', { name: 'Minimize', exact: true })
    .click();
  await expect(region).toContainText('My research notes');
  expect(confirmations).toEqual([
    { key, confirmedTracking: true },
    { key, confirmedTracking: true },
  ]);
  await region.getByRole('button', { name: 'Choose another folder' }).click();
  await expect(page.getByText('Selected folder: My research notes', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Spawn', exact: true })).toBeEnabled();
  await page.getByRole('radio', { name: /New folder/ }).check();
  await expect(page.getByLabel('Project name', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('answer Claude native questions with multiple choices and custom text from the conversation', async ({
  page,
}, info) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const source = snapshot.agents.find((agent: { role: string }) => agent.role === 'manager');
  const detail = await (await page.request.get(`/api/agents/${source.id}`)).json();
  source.provider = 'claude';
  source.status = 'waiting';
  detail.agent = source;
  const approval = {
    id: randomUUID(),
    agentId: source.id,
    kind: 'input',
    title: 'Claude has a question',
    details: '',
    questions: [
      {
        id: 'question-0',
        question: 'Which checks should I run?',
        header: 'Checks',
        multiSelect: true,
        allowCustom: true,
        options: [
          { label: 'Tests', description: 'Check behavior and recovery.' },
          { label: 'Types', description: 'Check the shared contracts.' },
        ],
      },
      {
        id: 'question-1',
        question: 'When should I start?',
        header: 'Timing',
        multiSelect: false,
        allowCustom: true,
        options: [{ label: 'Now', description: 'Start when QUARK admits the work.' }],
      },
    ],
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  snapshot.approvals = [approval];
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route(`**/api/agents/${source.id}`, (route) => route.fulfill({ json: detail }));
  let reply: unknown;
  await page.route(`**/api/approvals/${approval.id}`, async (route) => {
    reply = route.request().postDataJSON();
    snapshot.approvals = [];
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/#/chat/${source.id}`);
  const card = page.locator('.approval-card');
  // On a short landscape screen the chat itself begins below the page header.
  await card.getByRole('heading', { name: 'Claude has a question' }).scrollIntoViewIfNeeded();
  await expect(card.getByRole('heading', { name: 'Claude has a question' })).toBeInViewport();
  await page.screenshot({
    path: `../../data/screenshots/workspace/${info.project.name}-claude-questions-start.png`,
  });
  await card.getByRole('checkbox', { name: 'Tests', exact: true }).check();
  await card.getByRole('checkbox', { name: 'Types', exact: true }).check();
  await card.getByRole('radio', { name: 'Now', exact: true }).check();
  await card
    .getByRole('textbox', { name: 'Timing — your own answer', exact: true })
    .fill('After lunch');
  await expect(card.getByRole('radio', { name: 'Now', exact: true })).not.toBeChecked();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `../../data/screenshots/workspace/${info.project.name}-claude-questions.png`,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await card.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(reply).toEqual({
    decision: 'accept',
    answers: { 'question-0': ['Tests', 'Types'], 'question-1': ['After lunch'] },
  });
});

test('task shows its shared budgets, quota pause and jobs, with a scoped budget handoff', async ({
  page,
}, info) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const task = snapshot.tasks[0];
  const worker = snapshot.agents.find((agent: { taskId: string }) => agent.taskId === task.id);
  const parent = { ...task, id: randomUUID(), title: 'Parent task', parentId: null };
  task.parentId = parent.id;
  snapshot.tasks.push(parent);
  const quark = await (await page.request.get('/api/quark')).json();
  const runId = randomUUID();
  const now = new Date().toISOString();
  const cap = {
    id: randomUUID(),
    revision: 1,
    createdAt: now,
    startSequence: 0,
    source: 'owner',
    projectId: task.projectId,
    taskId: parent.id,
    provider: 'claude',
    windowId: 'weekly',
    limitPercent: 10,
    spentPercent: 4,
    reservedPercent: 1,
    remainingPercent: 5,
    reason: null,
  };
  quark.budgets = [
    cap,
    { ...cap, id: randomUUID(), taskId: null, limitPercent: 20 },
    { ...cap, id: randomUUID(), taskId: randomUUID(), limitPercent: 99 },
  ];
  quark.holds = [
    {
      runId,
      agentId: worker.id,
      projectId: task.projectId,
      reason: 'Task allowance reached; saved progress retained.',
      cause: 'budget',
      createdAt: now,
      stopAcknowledgedAt: now,
      releasedAt: null,
      lastAttemptAt: null,
      error: null,
    },
  ];
  const tokens = {
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningOutputTokens: null,
  };
  quark.runs = [
    {
      runId: randomUUID(),
      agentId: worker.id,
      projectId: task.projectId,
      taskId: task.id,
      taskAncestors: [task.id, parent.id],
      nativeRootId: task.managerId,
      provider: 'claude',
      model: null,
      observedModels: ['claude-native-fixture'],
      threadId: 'parent/helper',
      startedAt: now,
      finishedAt: now,
      observedAt: now,
      baseline: tokens,
      tokens: { ...tokens, inputTokens: 30, cachedInputTokens: 60, cacheWriteInputTokens: 90 },
      basis: 'partial',
      expectedTokens: 100,
      quotaPercent: 1,
      expectedSeconds: 60,
      cacheNudge: false,
      agentName: worker.name,
      projectName: 'Fieldnotes',
      status: 'completed',
    },
  ];
  const work = await (await page.request.get('/api/pulsar')).json();
  work.jobs = [
    {
      runId,
      agentId: worker.id,
      taskId: task.id,
      projectName: 'Fieldnotes',
      agentName: worker.name,
      provider: 'claude',
      status: 'interrupted',
      estimate: task.scheduling,
      held: true,
      override: false,
      reason: 'Waiting for the owner to review the allowance.',
      eligible: false,
      expectedFinishAt: null,
      tokensCharged: 400,
      tokenBasis: 'estimated',
    },
  ];
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/pulsar', (route) => route.fulfill({ json: work }));
  let unavailable = false;
  await page.route('**/api/quark', (route) =>
    unavailable
      ? route.fulfill({ status: 503, json: { error: 'Reading unavailable' } })
      : route.fulfill({ json: quark }),
  );
  await page.goto(`/#/task/${task.id}`);
  const region = page.getByRole('region', { name: 'Task progress and spending' });
  await expect(region).toContainText('Task allowance reached; saved progress retained.');
  await expect(region).toContainText('Shared parent-task cap');
  await expect(region).toContainText('Shared project cap, including manager overhead');
  await expect(region).not.toContainText('99.0 allowed');
  await expect(region).toContainText('5.0 percentage points left');
  await expect(region).toContainText('30 input · 60 cache read · 90 cache write');
  await expect(region).toContainText('Token total not reported');
  await expect(region.getByRole('link', { name: 'Job details and controls' })).toHaveAttribute(
    'href',
    `#/job/${runId}`,
  );
  await region.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `../../data/screenshots/workspace/${info.project.name}-task-progress.png`,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  unavailable = true;
  await page.evaluate(() => dispatchEvent(new Event('swa:refresh-home')));
  await expect(region.getByRole('alert')).toContainText('Last saved readings may be out of date');
  await expect(region).toContainText('Task allowance reached; saved progress retained.');
  unavailable = false;
  await region.getByRole('button', { name: 'Retry readings' }).click();
  await expect(region.getByRole('alert')).toHaveCount(0);
  await region.getByRole('link', { name: 'Manage budgets' }).click();
  await expect(page).toHaveURL(new RegExp(`/#/work/${task.id}$`));
  await expect(page.locator('.quark-workspace .flow-heading h1')).toHaveText('QUARK');
  expect(writes).toEqual([]);
});
