import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { snapshotSchema, type WorkItem } from '@dock/shared';

async function freshManager(page: Page, baseURL: string) {
  const response = await page.request.post('/api/projects', {
    headers: { Origin: baseURL },
    data: { key: randomUUID(), name: `Polish ${randomUUID().slice(0, 8)}`, provider: 'codex' },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: string; managerId: string; name: string };
}

test('repeated delayed autosaves keep the composer, scroll and focus still; failures stay actionable', async ({
  page,
  baseURL,
}, info) => {
  const project = await freshManager(page, baseURL!);
  const detail = await (await page.request.get(`/api/agents/${project.managerId}`)).json();
  detail.entries = Array.from({ length: 40 }, (_, i) => ({
    id: randomUUID(),
    agentId: project.managerId,
    runId: null,
    kind: i % 2 ? 'assistant' : 'user',
    title: i % 2 ? 'Manager' : 'You',
    text: `Earlier message ${i}`,
    status: 'complete',
    createdAt: new Date().toISOString(),
  }));
  await page.route(new RegExp(`/api/agents/${project.managerId}(?:\\?.*)?$`), (route) =>
    route.fulfill({ json: detail }),
  );
  let release: (() => void) | null = null;
  let fail = false;
  let saves = 0;
  await page.route(`**/api/workspace/*/drafts/${project.managerId}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    saves++;
    if (fail) return route.fulfill({ status: 503, json: { error: 'Draft storage unavailable.' } });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return route.continue();
  });
  await page.goto(`/#/chat/${project.managerId}`);
  const composer = page.locator('.composer');
  const input = composer.getByRole('textbox', { name: /^Message / });
  const status = composer.locator('.draft-handoff [data-draft]').first();
  await expect(status).toHaveAttribute('data-draft', 'saved');
  const steadyText = await status.textContent();
  const conversation = page.locator('.conversation');
  await input.click();
  const before = (await composer.boundingBox())!;
  const scrollBefore = await conversation.evaluate((element) => element.scrollTop);
  for (const word of ['First', ' second', ' third']) {
    await input.pressSequentially(word);
    await expect(status).toHaveAttribute('data-draft', /unsaved|saving/);
    await expect.poll(() => release !== null).toBe(true);
    // Mid-save: same geometry, same text, focus kept.
    expect(await status.textContent()).toBe(steadyText);
    if (word === 'First')
      await page.screenshot({ path: info.outputPath('draft-saving.png'), scale: 'css' });
    const during = (await composer.boundingBox())!;
    expect(Math.abs(during.height - before.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(during.y - before.y)).toBeLessThanOrEqual(1);
    await expect(input).toBeFocused();
    const done = release!;
    release = null;
    done();
    await expect(status).toHaveAttribute('data-draft', 'saved');
    const after = (await composer.boundingBox())!;
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
    expect(await status.textContent()).toBe(steadyText);
  }
  await page.screenshot({ path: info.outputPath('draft-saved.png'), scale: 'css' });
  expect(saves).toBeGreaterThanOrEqual(3);
  expect(
    Math.abs((await conversation.evaluate((e) => e.scrollTop)) - scrollBefore),
  ).toBeLessThanOrEqual(2);
  await expect(input).toHaveValue('First second third');
  // A real failure is not silent: it alerts and Retry saves the retained text.
  fail = true;
  await input.pressSequentially(' fourth');
  const alert = composer.getByRole('alert').filter({ hasText: 'Draft storage unavailable.' });
  await expect(alert).toBeVisible();
  await expect(input).toHaveValue('First second third fourth');
  fail = false;
  await alert.getByRole('button', { name: 'Retry saving draft' }).click();
  await expect.poll(() => release !== null).toBe(true);
  release!();
  await expect(alert).toHaveCount(0);
  await expect(status).toHaveAttribute('data-draft', 'saved');
  await page.reload();
  await expect(input).toHaveValue('First second third fourth');
});

test('completed-turn progress and commands stay in activity; owner steering and replies remain', async ({
  page,
  baseURL,
}) => {
  const project = await freshManager(page, baseURL!);
  const detail = await (await page.request.get(`/api/agents/${project.managerId}`)).json();
  const done = randomUUID(),
    steered = randomUUID(),
    running = randomUUID();
  const at = new Date().toISOString();
  const entry = (runId: string | null, kind: string, title: string, text: string) => ({
    id: randomUUID(),
    agentId: project.managerId,
    runId,
    kind,
    title,
    text,
    status: 'complete',
    createdAt: at,
  });
  detail.entries = [
    entry(null, 'assistant', 'Imported', 'Imported reply without a run'),
    entry(done, 'user', 'You', 'Please compare the hosting options.'),
    entry(done, 'assistant', 'Manager', 'I will check the setup patterns first.'),
    entry(done, 'tool', '/bin/zsh -lc "rg -n hosting"', 'raw output'),
    entry(done, 'tool', 'dock_task_create', '{"error":"scheduling.tokenBudget"}'),
    entry(done, 'assistant', 'Manager', 'Final comparison: the free plan fits.'),
    entry(steered, 'user', 'You', 'Start the review.'),
    entry(steered, 'assistant', 'Manager', 'Reviewing now.'),
    entry(steered, 'tool', 'dock_inspect', '{}'),
    entry(steered, 'system', 'Owner steering', 'How is it going?'),
    entry(steered, 'assistant', 'Manager', 'Halfway; one reviewer left.'),
    entry(steered, 'tool', 'dock_message', '{}'),
    entry(steered, 'assistant', 'Manager', 'Review finished.'),
    entry(running, 'user', 'You', 'Next step?'),
    entry(running, 'assistant', 'Manager', 'Looking into it.'),
    entry(running, 'tool', 'dock_inspect', '{}'),
    entry(running, 'assistant', 'Manager', 'Still checking.'),
  ];
  detail.runs = [
    { id: done, status: 'completed', kind: 'user' },
    { id: steered, status: 'completed', kind: 'user' },
    { id: running, status: 'running', kind: 'user' },
  ].map((run) => ({ ...run, agentId: project.managerId, sourceId: null, text: '', createdAt: at }));
  await page.route(new RegExp(`/api/agents/${project.managerId}(?:\\?.*)?$`), (route) =>
    route.fulfill({ json: detail }),
  );
  await page.goto(`/#/chat/${project.managerId}`);
  const chat = page.locator('.conversation');
  for (const text of [
    'Imported reply without a run',
    'Please compare the hosting options.',
    'Final comparison: the free plan fits.',
    'Start the review.',
    'Reviewing now.',
    'How is it going?',
    'Review finished.',
    'Looking into it.',
    'Still checking.',
  ])
    await expect(chat.locator('.message').filter({ hasText: text })).toHaveCount(1);
  await expect(chat.locator('.message').filter({ hasText: 'I will check the setup' })).toHaveCount(
    0,
  );
  await expect(
    chat.locator('.message').filter({ hasText: 'Halfway; one reviewer left.' }),
  ).toHaveCount(1);
  const group = chat.locator('.tool-group').first();
  await expect(group.locator('summary')).toContainText('2 actions · 1 earlier reply');
  await expect(group.locator('summary')).toContainText('I will check the setup patterns first.');
  await expect(chat.locator('.tool-group summary').filter({ hasText: 'rg -n' })).toHaveCount(0);
  await group.locator('summary').click();
  await expect(group.locator('.tool-note')).toContainText('Earlier reply');
  await expect(group.locator('.tool-note')).toContainText('I will check the setup patterns first.');
  await expect(
    group.locator('.tool-entry summary').filter({ hasText: 'rg -n hosting' }),
  ).toBeVisible();
});

test('Home frame lists running and idle needy projects with both rates; counts expand in the page', async ({
  page,
}, info) => {
  const snapshot = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const base = snapshot.projects.find((p) => !p.internal)!;
  const manager = snapshot.agents.find((a) => a.id === base.managerId)!;
  const mk = (name: string, status: 'running' | 'idle') => {
    const id = randomUUID(),
      managerId = randomUUID();
    snapshot.projects.push({ ...base, id, name, managerId });
    snapshot.agents.push({ ...manager, id: managerId, projectId: id, status, taskId: null });
    return { id, managerId };
  };
  snapshot.agents.forEach((agent) => (agent.status = 'idle'));
  const busy = mk('Busy project', 'running');
  const needy = mk('Idle needy project', 'idle');
  mk('Quiet idle project', 'idle');
  const taskless = mk('Taskless manager project', 'running');
  snapshot.agents.find((a) => a.id === taskless.managerId)!.checkpoint =
    'Compared hosting plans; next: confirm free-tier limits.';
  const taskId = randomUUID();
  const task = snapshot.tasks[0]!;
  snapshot.tasks = [
    {
      ...task,
      id: taskId,
      projectId: busy.id,
      title: 'Draft the hosting report',
      status: 'working',
    },
  ];
  const worker = {
    ...manager,
    id: randomUUID(),
    projectId: busy.id,
    role: 'researcher' as const,
    status: 'running' as const,
    taskId,
    parentId: busy.managerId,
  };
  snapshot.agents.push(worker);
  snapshot.approvals = [];
  snapshot.backups = [];
  const now = new Date().toISOString();
  const items: WorkItem[] = [1, 2].map((n) => ({
    id: randomUUID(),
    projectId: needy.id,
    managerId: needy.managerId,
    taskId: null,
    kind: 'human',
    title: `Which account should run job ${n}?`,
    detail: 'Answer in the manager chat.',
    status: 'waiting',
    revision: 1,
    humanReply: null,
    repliedAt: null,
    replyRunId: null,
    assignmentRunId: null,
    ownerTicketId: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    sourceMessages: [],
    sourceDisposition: null,
  }));
  const rate = (
    projectId: string,
    provider: 'codex' | 'claude',
    label: string,
    value: number | null,
    stale = false,
  ) => ({
    projectId,
    provider,
    windowId: label,
    label,
    resetsAt: null,
    from: now,
    to: now,
    estimatedPercentPerHour: value,
    estimatedPercent: 0,
    samples: 3,
    stale,
    history: [],
    historyCoverageMinutes: 0,
  });
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/work-items*', (route) => route.fulfill({ json: { items } }));
  const queue = await (await page.request.get('/api/pulsar')).json();
  await page.route('**/api/pulsar', (route) => route.fulfill({ json: { ...queue, jobs: [] } }));
  await page.route('**/api/project-rates', (route) =>
    route.fulfill({
      json: {
        observedAt: now,
        notice: '',
        rates: [
          rate(busy.id, 'codex', 'Five-hour', 2.4),
          rate(busy.id, 'claude', 'Weekly', 0.6, true),
          rate(needy.id, 'claude', 'Five-hour', null),
        ],
      },
    }),
  );
  await page.goto('/#/home');
  const frame = page.getByRole('region', { name: 'For your attention', exact: true });
  const rows = frame.locator('.attention-project');
  const busyRow = rows.filter({ hasText: 'Busy project' });
  const needyRow = rows.filter({ hasText: 'Idle needy project' });
  await expect(busyRow).toContainText('Working on Draft the hosting report');
  await expect(busyRow).toContainText('2.4 %/h');
  await expect(busyRow).toContainText('Five-hour');
  await expect(busyRow).toContainText('Weekly · stale');
  await expect(busyRow.locator('button.attention-project-count')).toHaveCount(0);
  await expect(needyRow).toContainText('Idle');
  await expect(rows.filter({ hasText: 'Taskless manager project' })).toContainText(
    'Last checkpoint: Compared hosting plans; next: confirm free-tier limits.',
  );
  await expect(busyRow).not.toContainText('Last checkpoint');
  const besideBefore = (await page.locator('.overview-todo-slot').boundingBox())!;
  await expect(needyRow).toContainText('Not enough data');
  await expect(rows.filter({ hasText: 'Quiet idle project' })).toHaveCount(0);
  await expect(rows.first()).toContainText('Idle needy project');
  const count = needyRow.getByRole('button', { name: '2 requests for Idle needy project' });
  await expect(count).toHaveText('2');
  await expect(needyRow.locator('.attention-item')).toHaveCount(0);
  await count.click();
  await expect(count).toHaveAttribute('aria-expanded', 'true');
  await expect(
    needyRow.getByRole('link', { name: /Which account should run job 2/ }),
  ).toBeVisible();
  const besideAfter = (await page.locator('.overview-todo-slot').boundingBox())!;
  expect(Math.abs(besideAfter.height - besideBefore.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(besideAfter.width - besideBefore.width)).toBeLessThanOrEqual(1);
  // No nested scroller: the expanded list extends the page instead.
  expect(
    await frame.evaluate((element) =>
      [element, ...element.querySelectorAll('*')].some((node) => {
        const style = getComputedStyle(node);
        return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
      }),
    ),
  ).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Readable at every width: names keep whole words, labels and values never collide, each
  // rate is labelled by a visible column header or its own label, and work text is not cut.
  const readability = () =>
    frame.evaluate((element) => {
      const problems: string[] = [];
      const box = (node: Element) => node.getBoundingClientRect();
      const overlap = (a: DOMRect, b: DOMRect) =>
        a.width > 0 &&
        b.width > 0 &&
        a.left < b.right - 1 &&
        b.left < a.right - 1 &&
        a.top < b.bottom - 1 &&
        b.top < a.bottom - 1;
      const header = [...element.querySelectorAll('.attention-columns > span')].filter(
        (node) => box(node).width > 0,
      );
      header.forEach((a, i) =>
        header
          .slice(i + 1)
          .forEach((b) => overlap(box(a), box(b)) && problems.push(`header ${a.textContent}`)),
      );
      for (const row of element.querySelectorAll('.attention-project-row')) {
        const name = row.querySelector('.attention-project-name strong')!;
        const line = parseFloat(getComputedStyle(name).lineHeight) || 22;
        if (box(name).height > line * 2 + 1) problems.push(`name wraps: ${name.textContent}`);
        if (box(name).width < 160) problems.push(`name squeezed: ${name.textContent}`);
        const parts = [
          row.querySelector('.attention-project-name')!,
          ...row.querySelectorAll(
            '.attention-project-rate:not(.is-none), .attention-project-count',
          ),
        ];
        parts.forEach((a, i) =>
          parts
            .slice(i + 1)
            .forEach(
              (b) => overlap(box(a), box(b)) && problems.push(`overlap: ${name.textContent}`),
            ),
        );
        const work = row.querySelector('.attention-project-name small');
        if (work && work.scrollWidth > work.clientWidth + 1) problems.push('work text clipped');
        for (const rate of row.querySelectorAll('.attention-project-rate:not(.is-none)')) {
          const label = rate.querySelector('.attention-rate-label')!;
          if (box(label).width <= 1 && !header.length) problems.push('unlabelled rate');
          if (box(label).width > 1 && !/(Codex|Claude) %\/h/.test(label.textContent ?? ''))
            problems.push('wrong rate label');
        }
      }
      return problems;
    });
  expect(await readability()).toEqual([]);
  await expect(busyRow.locator('.attention-project-name small')).toBeVisible();
  await frame.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('home-crowded-expanded.png'), scale: 'css' });
  if (info.project.name === 'desktop') {
    // A very wide frame uses the column header instead of per-row labels.
    await page.setViewportSize({ width: 2400, height: 1000 });
    await expect(frame.locator('.attention-columns')).toBeVisible();
    expect(await readability()).toEqual([]);
    await page.screenshot({ path: info.outputPath('home-wide-columns.png'), scale: 'css' });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  // Sparse: nothing running and nothing needed.
  items.length = 0;
  snapshot.agents.forEach((agent) => (agent.status = 'idle'));
  await page.reload();
  await expect(frame).toContainText('Nothing needs you and no project is running work.');
  await frame.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('home-sparse.png'), scale: 'css' });
});

test('a titled to-do keeps its draft across reload and failure, then saves title and notes', async ({
  page,
}) => {
  const items: WorkItem[] = [];
  let fail = true;
  const posts: Record<string, unknown>[] = [];
  await page.route('**/api/work-items*', (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { items } });
    const body = route.request().postDataJSON();
    posts.push(body);
    if (fail) return route.fulfill({ status: 503, json: { error: 'Could not save right now.' } });
    const now = new Date().toISOString();
    const item: WorkItem = {
      id: randomUUID(),
      projectId: null,
      managerId: null,
      taskId: null,
      kind: body.kind,
      title: body.title,
      detail: body.detail,
      status: 'open',
      revision: 1,
      humanReply: null,
      repliedAt: null,
      replyRunId: null,
      assignmentRunId: null,
      ownerTicketId: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      sourceMessages: [],
      sourceDisposition: null,
    };
    items.push(item);
    return route.fulfill({ json: item });
  });
  await page.goto('/#/home');
  const board = page.locator('.overview-todo');
  await board.getByRole('textbox', { name: 'To-do title (optional)' }).fill('Renew cluster access');
  await board.getByRole('textbox', { name: 'New to-do' }).fill('Email the admin\nAttach the form');
  await page.reload();
  await expect(board.getByRole('textbox', { name: 'To-do title (optional)' })).toHaveValue(
    'Renew cluster access',
  );
  await expect(board.getByRole('textbox', { name: 'New to-do' })).toHaveValue(
    'Email the admin\nAttach the form',
  );
  await board.getByRole('button', { name: 'Add' }).click();
  await expect(board.getByRole('alert')).toContainText('Your text is kept');
  await expect(board.getByRole('textbox', { name: 'To-do title (optional)' })).toHaveValue(
    'Renew cluster access',
  );
  fail = false;
  await board.getByRole('button', { name: 'Add' }).click();
  await expect(
    board.locator('.todo-list > li').filter({ hasText: 'Renew cluster access' }),
  ).toContainText('Attach the form');
  expect(posts.at(-1)).toMatchObject({
    title: 'Renew cluster access',
    detail: 'Email the admin\nAttach the form',
  });
  await expect(board.getByRole('textbox', { name: 'To-do title (optional)' })).toHaveValue('');
});

test('explicit phases and page boundaries never hide finals, owner input or unknown replies', async ({
  page,
  baseURL,
}) => {
  const project = await freshManager(page, baseURL!);
  const base = await (await page.request.get(`/api/agents/${project.managerId}`)).json();
  const at = new Date().toISOString();
  const run = randomUUID(),
    live = randomUUID(),
    split = randomUUID();
  const entry = (
    runId: string | null,
    kind: string,
    text: string,
    phase?: 'commentary' | 'final',
  ) => ({
    id: randomUUID(),
    agentId: project.managerId,
    runId,
    kind,
    title: kind === 'user' ? 'You' : kind === 'tool' ? 'dock_inspect' : 'Manager',
    text,
    status: 'complete',
    createdAt: at,
    ...(phase ? { phase } : {}),
  });
  // Older page ends mid-run: its later reply is on the newer page.
  const older = [
    entry(split, 'user', 'Older owner question'),
    entry(split, 'assistant', 'Older reply before tools'),
    entry(split, 'tool', 'tool output'),
  ];
  const newer = [
    entry(split, 'assistant', 'Split-run final reply'),
    entry(run, 'user', 'Owner request with phases'),
    entry(run, 'assistant', 'Marked commentary note', 'commentary'),
    entry(run, 'tool', 'tool output'),
    entry(run, 'assistant', 'Marked final answer', 'final'),
    entry(run, 'tool', 'tool output'),
    entry(run, 'assistant', 'Unknown closing words'),
    entry(live, 'user', 'Owner request while running'),
    entry(live, 'assistant', 'Running commentary', 'commentary'),
    entry(live, 'tool', 'tool output'),
    entry(live, 'assistant', 'Running unknown reply'),
  ];
  const runs = [
    { id: split, status: 'completed' },
    { id: run, status: 'completed' },
    { id: live, status: 'running' },
  ].map((r) => ({
    ...r,
    agentId: project.managerId,
    sourceId: null,
    text: '',
    kind: 'user',
    createdAt: at,
  }));
  await page.route(new RegExp(`/api/agents/${project.managerId}(?:\\?.*)?$`), (route) => {
    const before = new URL(route.request().url()).searchParams.get('before');
    return route.fulfill({
      json: before
        ? { ...base, entries: older, runs, hasMore: false }
        : { ...base, entries: newer, runs, hasMore: true },
    });
  });
  await page.goto(`/#/chat/${project.managerId}`);
  const chat = page.locator('.conversation');
  const visible = (text: string) => chat.locator('.message').filter({ hasText: text });
  // The final reply of a run whose earlier part is on another page stays visible.
  await expect(visible('Split-run final reply')).toHaveCount(1);
  await expect(visible('Owner request with phases')).toHaveCount(1);
  await expect(visible('Marked final answer')).toHaveCount(1);
  await expect(visible('Unknown closing words')).toHaveCount(1);
  await expect(visible('Marked commentary note')).toHaveCount(0);
  await expect(visible('Running unknown reply')).toHaveCount(1);
  await expect(visible('Running commentary')).toHaveCount(0);
  const marked = chat.locator('.tool-group').filter({ hasText: 'Marked commentary note' });
  await expect(marked.locator('summary')).toContainText('1 action · 1 update');
  await marked.locator('summary').click();
  await expect(marked.locator('.tool-note')).toContainText('Update');
  await expect(marked.locator('.tool-note')).not.toContainText('Earlier reply');
  // Older page: the reply before tools has no later reply on this page, so it stays.
  await page.getByRole('button', { name: 'Your prompts', exact: true }).click();
  const prompts = page.getByRole('dialog', { name: 'Your prompts', exact: true });
  await prompts.getByRole('button', { name: 'Older prompts', exact: true }).click();
  await prompts.getByRole('button', { name: /Older owner question/ }).click();
  await expect(visible('Older owner question')).toHaveCount(1);
  await expect(visible('Older reply before tools')).toHaveCount(1);
  await page.getByRole('button', { name: 'Back to latest', exact: true }).click();
  await expect(visible('Split-run final reply')).toHaveCount(1);
});

test('after owner steering, marked commentary folds while the steering, unknown replies and final stay', async ({
  page,
  baseURL,
}) => {
  const project = await freshManager(page, baseURL!);
  const base = await (await page.request.get(`/api/agents/${project.managerId}`)).json();
  const at = new Date().toISOString();
  const run = randomUUID();
  const entry = (kind: string, title: string, text: string, phase?: 'commentary' | 'final') => ({
    id: randomUUID(),
    agentId: project.managerId,
    runId: run,
    kind,
    title,
    text,
    status: 'complete',
    createdAt: at,
    ...(phase ? { phase } : {}),
  });
  const entries = [
    entry('user', 'You', 'Prepare the release notes.'),
    entry('assistant', 'Manager', 'Unknown reply before tools'),
    entry('tool', 'dock_inspect', '{}'),
    entry('system', 'Owner steering', 'Also mention the phone fixes.'),
    entry('assistant', 'Manager', 'Marked commentary after steering', 'commentary'),
    entry('tool', 'dock_message', '{}'),
    entry('assistant', 'Manager', 'Unknown reply after steering'),
    entry('tool', 'dock_inspect', '{}'),
    entry('assistant', 'Manager', 'Marked final with the phone fixes', 'final'),
  ];
  const runs = [
    {
      id: run,
      agentId: project.managerId,
      sourceId: null,
      text: '',
      kind: 'user',
      status: 'completed',
      createdAt: at,
    },
  ];
  await page.route(new RegExp(`/api/agents/${project.managerId}(?:\\?.*)?$`), (route) =>
    route.fulfill({ json: { ...base, entries, runs, hasMore: false } }),
  );
  await page.goto(`/#/chat/${project.managerId}`);
  const chat = page.locator('.conversation');
  const visible = (text: string) => chat.locator('.message').filter({ hasText: text });
  await expect(visible('Prepare the release notes.')).toHaveCount(1);
  const steering = visible('Also mention the phone fixes.');
  await expect(steering).toHaveCount(1);
  await expect(steering.locator('.message-heading strong')).toHaveText('You');
  // The unknown reply before tools has no later reply before the owner boundary.
  await expect(visible('Unknown reply before tools')).toHaveCount(1);
  await expect(visible('Unknown reply after steering')).toHaveCount(1);
  await expect(visible('Marked final with the phone fixes')).toHaveCount(1);
  await expect(visible('Marked commentary after steering')).toHaveCount(0);
  const group = chat.locator('.tool-group').filter({ hasText: 'Marked commentary after steering' });
  await expect(group.locator('summary')).toContainText('1 action · 1 update');
  await expect(group.locator('summary')).not.toContainText('earlier');
  await group.locator('summary').click();
  await expect(group.locator('.tool-note')).toContainText('Update');
  await expect(group.locator('.tool-note .markdown')).toHaveText(
    'Marked commentary after steering',
  );
  await expect(
    group.locator('.tool-entry summary').filter({ hasText: 'dock_message' }),
  ).toBeVisible();
  await expect(chat.locator('.tool-note').filter({ hasText: 'Earlier reply' })).toHaveCount(0);
});
