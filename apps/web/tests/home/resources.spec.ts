import { expect, test, type Page } from '@playwright/test';
import {
  agentSchema,
  defaultModelPolicy,
  type AgentDetail,
  type Model,
  type ProviderId,
  type ResourceCheck,
  type ResourceSample,
  type ResourceStatus,
} from '@dock/shared';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

// Browser-only measurements and diagnoses. No fixture enters an owner's database or starts a model.
const models: Record<ProviderId, Model[]> = {
  codex: [
    { id: 'fixture-terra', label: 'Terra example', isDefault: true, efforts: ['low', 'high'] },
    { id: 'fixture-sol', label: 'Sol example', isDefault: false, efforts: ['low', 'high'] },
  ],
  claude: [
    { id: 'fixture-sonnet', label: 'Sonnet example', isDefault: true, efforts: ['low', 'high'] },
    {
      id: 'fixture-opus',
      label: 'Opus example',
      isDefault: false,
      efforts: ['high', 'adaptive-v2'],
    },
  ],
};
function sample(at: number): ResourceSample {
  return {
    observedAt: new Date(at).toISOString(),
    machine: {
      observedAt: new Date(at).toISOString(),
      cpuCount: 8,
      cpuUsedPercent: 20,
      memoryTotalBytes: 32 * 1024 ** 3,
      memoryAvailableBytes: 4 * 1024 ** 3,
      diskAvailableBytes: 90 * 1024 ** 3,
      loadPerCore: 0.5,
    },
    hottestCorePercent: 95,
    memoryPressure: 'warning',
    compressedBytes: 6 * 1024 ** 3,
    swapUsedBytes: 4 * 1024 ** 3,
    swapOutBytesPerSecond: 15 * 1024 ** 2,
    diskTotalBytes: 512 * 1024 ** 3,
    diskReadBytesPerSecond: 3 * 1024 ** 2,
    diskWriteBytesPerSecond: 1024 ** 2,
    networkReceiveBytesPerSecond: 2 * 1024 ** 2,
    networkSendBytesPerSecond: 0.5 * 1024 ** 2,
    gpuUtilizationPercent: 37,
    thermalWarning: 'none',
    processCount: 390,
    jobs: [
      {
        id: '10000000-0000-4000-8000-000000000001',
        projectId: '10000000-0000-4000-8000-000000000002',
        projectName: 'Research project',
        name: 'Literature worker and its helpers',
        kind: 'agent',
        status: 'running',
        processes: 4,
        cpuPercent: 5,
        memoryBytes: 1024 ** 3,
        memoryChangeBytes: 0,
      },
    ],
    groups: [
      {
        name: 'Google Chrome',
        processes: 45,
        cpuPercent: 12,
        memoryBytes: 10 * 1024 ** 3,
        memoryChangeBytes: 120 * 1024 ** 2,
      },
      {
        name: 'Visual Studio Code',
        processes: 18,
        cpuPercent: 3,
        memoryBytes: 2 * 1024 ** 3,
        memoryChangeBytes: 0,
      },
    ],
    unavailable: ['Temperatures are not measured; macOS exposes them only to administrator tools.'],
  };
}
function reading(now = Date.now()): ResourceStatus {
  return {
    latest: sample(now),
    history: Array.from({ length: 12 }, (_, i) => sample(now - (11 - i) * 60_000)),
    stale: false,
    findings: [
      {
        id: 'memory',
        level: 'warning',
        title: 'Memory is under pressure',
        detail: 'macOS reports memory pressure, even though CPU is low.',
        since: new Date(now - 120_000).toISOString(),
        sustained: true,
      },
    ],
    settings: { automatic: false, checkpointHours: 6 },
    checks: [],
    projectId: null,
    nextCheckpointAt: null,
    automaticChecksToday: 0,
    message: '',
    intervalSeconds: 15,
  };
}
function diagnosis(at: number, summary: string): ResourceCheck {
  return {
    id: randomUUID(),
    agentId: randomUUID(),
    runId: randomUUID(),
    createdAt: new Date(at).toISOString(),
    reason: 'asked',
    model: 'fixture-opus',
    state: 'completed',
    summary,
    waitReason: null,
  };
}
function conversation(check: ResourceCheck, question = 'Why is my computer slow?'): AgentDetail {
  return {
    agent: agentSchema.parse({
      id: check.agentId,
      projectId: '10000000-0000-4000-8000-000000000003',
      parentId: null,
      taskId: null,
      name: 'Resource assistant',
      role: 'researcher',
      status: 'idle',
      provider: 'claude',
      model: check.model,
      effort: 'adaptive-v2',
      permission: 'read-only',
      toolPolicy: 'restricted',
      checkpoint: '',
      createdAt: check.createdAt,
      updatedAt: check.createdAt,
    }),
    entries: [
      {
        id: `${check.id}:question`,
        agentId: check.agentId,
        runId: check.runId,
        kind: 'user',
        title: 'You',
        text: question,
        status: 'completed',
        createdAt: check.createdAt,
      },
      {
        id: `${check.id}:answer`,
        agentId: check.agentId,
        runId: check.runId,
        kind: 'assistant',
        title: 'Assistant',
        text: check.summary,
        status: 'completed',
        createdAt: check.createdAt,
      },
    ],
    runs: [],
    hasMore: false,
  };
}
async function fixture(
  page: Page,
  status: ResourceStatus,
  conversations = new Map<string, AgentDetail>(),
) {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (
      /\/api\/(resources\/(ask|stop|settings)|agents\/[^/]+\/(messages|commands))/.test(
        request.url(),
      ) &&
      request.method() !== 'GET'
    )
      writes.push(request.url());
  });
  const hostId = randomUUID(),
    clientId = randomUUID();
  const workspace = {
    hostId,
    client: {
      id: clientId,
      label: 'Health test browser',
      revision: 0,
      openAgentIds: [],
      selectedAgentId: null,
      updatedAt: new Date().toISOString(),
    },
    others: [],
  };
  const drafts = new Map<string, { revision: number; text: string; deliveryKey: string | null }>();
  await page.route('**/api/workspace/clients', (route) => route.fulfill({ json: workspace }));
  await page.route(`**/api/workspace/${clientId}`, (route) => route.fulfill({ json: workspace }));
  await page.route(`**/api/workspace/${clientId}/drafts/*`, async (route) => {
    const agentId = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const own = drafts.get(agentId) ?? { revision: 0, text: '', deliveryKey: null };
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      own.revision++;
      own.text = input.action.text;
      own.deliveryKey = randomUUID();
    }
    drafts.set(agentId, own);
    const state = {
      hostId,
      clientId,
      agentId,
      own: { clientId, agentId, ...own, submitted: false, updatedAt: new Date().toISOString() },
      others: [],
    };
    await route.fulfill({
      json: route.request().method() === 'POST' ? { status: 'applied', state } : state,
    });
  });
  const policy = structuredClone(defaultModelPolicy);
  policy.providers.routine = 'codex';
  policy.models.codex.undergrad.model = 'fixture-terra';
  policy.models.claude.undergrad.model = 'fixture-sonnet';
  await page.route('**/api/model-policy', (route) =>
    route.fulfill({
      json: {
        policy,
        catalogs: (['codex', 'claude'] as const).map((provider) => ({
          provider,
          observedAt: new Date().toISOString(),
          error: null,
          models: models[provider],
        })),
      },
    }),
  );
  await page.route('**/api/models?*', (route) => {
    const provider =
      new URL(route.request().url()).searchParams.get('provider') === 'claude' ? 'claude' : 'codex';
    return route.fulfill({ json: models[provider] });
  });
  await page.route('**/api/resources', (route) => route.fulfill({ json: status }));
  await page.route(/\/api\/agents\/[a-f0-9-]+(?:\?.*)?$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const saved = conversations.get(id);
    return saved ? route.fulfill({ json: saved }) : route.fallback();
  });
  return { writes, conversations, drafts };
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('computer health opens read-only, then preserves provider choices, a lost-reply retry, and the diagnostic conversation', async ({
  page,
}, info) => {
  const status = reading();
  const { writes, conversations } = await fixture(page, status);
  const asks: Record<string, unknown>[] = [];
  let savedCheck: ResourceCheck | undefined;
  await page.route('**/api/resources/settings', async (route) => {
    status.settings = route.request().postDataJSON().settings;
    await route.fulfill({ json: status });
  });
  await page.route('**/api/resources/ask', async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    asks.push(payload);
    if (!savedCheck) {
      savedCheck = diagnosis(
        Date.now(),
        'Memory pressure is the clearest signal. Chrome uses about 10 GB; its helper count alone does not establish a runaway.',
      );
      conversations.set(savedCheck.agentId, conversation(savedCheck, String(payload.question)));
      // The host accepted the request, but its acknowledgement did not reach the page.
      // Its cached resource snapshot still predates that check until the receipt is read.
      await route.fulfill({
        status: 503,
        json: { error: 'Connection interrupted after submission.' },
      });
      return;
    }
    status.checks = [savedCheck];
    if (payload.agentId) {
      const followup = {
        ...diagnosis(
          Date.now(),
          'Compare memory pressure again after closing an unused heavy tab.',
        ),
        agentId: savedCheck.agentId,
      };
      status.checks = [followup, savedCheck];
      const retained = conversations.get(savedCheck.agentId)!;
      retained.entries.push(...conversation(followup, String(payload.question)).entries);
    }
    await route.fulfill({ json: status });
  });
  await page.goto('/#/resources');
  await expect(page.getByRole('heading', { level: 1, name: 'Computer health' })).toBeVisible();
  const assistant = page.getByRole('region', { name: 'Resource assistant', exact: true });
  const apps = page.getByRole('region', { name: 'Apps and processes' });
  const projects = page.getByRole('region', { name: 'Projects and jobs' });
  await expect(apps.getByText('Google Chrome', { exact: true })).toBeVisible();
  await expect(projects.getByText('Research project', { exact: true })).toBeVisible();
  const projectBounds = (await projects.boundingBox())!;
  expect(projectBounds.y + projectBounds.height).toBeLessThanOrEqual((await apps.boundingBox())!.y);
  await expect(page.getByText('The busiest app groups', { exact: false })).toHaveCount(0);
  await projects.getByText('Research project', { exact: true }).click();
  await expect(
    projects.getByText('Literature worker and its helpers', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Memory is under pressure' }),
  ).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Open Resource assistant' }).click();
  const full = page.getByRole('dialog', { name: 'Resource assistant conversation' });
  await expect(full).toBeVisible();
  await expect(full.getByRole('button', { name: 'Past diagnoses', exact: true })).toHaveCount(0);
  const geometry = await full.boundingBox();
  expect(geometry!.width).toBe(page.viewportSize()!.width);
  expect(geometry!.height).toBeGreaterThanOrEqual(page.viewportSize()!.height - 2);
  await assistant.getByRole('button', { name: 'Model settings', exact: true }).click();
  await expect(assistant.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked();

  await assistant.getByRole('radio', { name: 'Claude', exact: true }).click();
  await expect(assistant.getByRole('radio', { name: 'Claude', exact: true })).toBeChecked();
  // Direct questions default to the stronger diagnosis model; routine checks stay lighter.
  await expect(
    assistant.getByRole('combobox', { name: 'Model', exact: true }).locator('option[value=""]'),
  ).toHaveText('Opus example · diagnosis default');
  await assistant
    .getByRole('combobox', { name: 'Model', exact: true })
    .selectOption('fixture-opus');
  await assistant
    .getByRole('combobox', { name: 'Thinking', exact: true })
    .selectOption('adaptive-v2');
  await assistant.getByRole('button', { name: 'Done', exact: true }).click();
  expect(writes).toEqual([]);
  await assistant
    .getByRole('textbox', { name: 'Message Resource assistant' })
    .fill('Why is Chrome slow at only 20% CPU?');
  await assistant.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    assistant.getByRole('alert').filter({ hasText: 'The request may have arrived' }),
  ).toBeVisible();
  // One alert explains the uncertain send; the composer retries the same request.
  await expect(assistant.getByRole('alert')).toHaveCount(1);
  await expect(
    assistant.getByRole('button', { name: 'Retry previous message', exact: true }),
  ).toBeEnabled();
  await page.reload();
  await assistant.getByRole('button', { name: 'Model settings', exact: true }).click();
  await expect(assistant.getByRole('radio', { name: 'Claude', exact: true })).toBeChecked();
  await expect(assistant.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'fixture-opus',
  );
  await expect(assistant.getByRole('combobox', { name: 'Thinking', exact: true })).toHaveValue(
    'adaptive-v2',
  );
  await assistant.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(assistant.getByRole('textbox', { name: 'Message Resource assistant' })).toHaveValue(
    'Why is Chrome slow at only 20% CPU?',
  );
  await assistant.getByRole('button', { name: 'Retry previous message', exact: true }).click();
  await expect(
    assistant.getByText('Memory pressure is the clearest signal.', { exact: false }),
  ).toBeVisible();
  expect(asks).toHaveLength(2);
  expect(asks[0]).toEqual(asks[1]);
  expect(asks[0]).toMatchObject({
    provider: 'claude',
    model: 'fixture-opus',
    effort: 'adaptive-v2',
    question: 'Why is Chrome slow at only 20% CPU?',
  });
  expect(status.checks).toHaveLength(1);
  await expect(assistant.getByRole('combobox', { name: 'Model', exact: true })).toHaveCount(0);
  await assistant.getByRole('button', { name: 'Model settings', exact: true }).click();
  await expect(
    assistant.getByText('Change the model while keeping this conversation.', {
      exact: false,
    }),
  ).toBeVisible();
  await assistant.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(assistant.locator('.composer textarea')).toBeInViewport();
  await expect(
    assistant.getByRole('button', { name: 'Open notepad', exact: true }),
  ).toBeInViewport();
  await assistant
    .getByRole('textbox', { name: 'Message Resource assistant' })
    .fill('What should I compare after closing a tab?');
  await assistant.getByRole('button', { name: 'Send message' }).click();
  await expect(
    assistant.getByText('Compare memory pressure again after closing an unused heavy tab.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(asks).toHaveLength(3);
  expect(Object.keys(asks[2]!).sort()).toEqual(['agentId', 'key', 'question']);
  expect(asks[2]).toMatchObject({
    agentId: savedCheck!.agentId,
    question: 'What should I compare after closing a tab?',
  });
  expect(asks[2]!.key).not.toBe(asks[0]!.key);
  expect(new Set(status.checks.map((check) => check.agentId)).size).toBe(1);

  await page.getByRole('button', { name: 'Computer health', exact: true }).click();
  await page.getByText('Automatic checks and what is measured', { exact: true }).click();
  await page.getByLabel('Automatic check-ins').check();
  await page.getByRole('button', { name: 'Save automatic checks' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Automatic check settings saved.' }),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await page.evaluate(() => document.fonts.ready);
  await mkdir('../../data/screenshots/resources', { recursive: true });
  await page.screenshot({
    path: `../../data/screenshots/resources/${info.project.name}.png`,
    fullPage: true,
    scale: 'css',
  });
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
});

for (const state of ['missing', 'stale'] as const) {
  test(`${state} computer readings stay honest and never start a diagnostic check`, async ({
    page,
  }) => {
    const status = reading(Date.now() - 15 * 60_000);
    status.stale = true;
    status.findings = [];
    if (state === 'missing') {
      status.latest = null;
      status.history = [];
    }
    const { writes } = await fixture(page, status);
    await page.goto('/#/resources');
    const snapshot = page.getByRole('region', { name: 'Right now' });
    const assistant = page.getByRole('region', { name: 'Resource assistant', exact: true });
    await expect(snapshot.getByText('Waiting for fresh readings')).toBeVisible();
    await expect(snapshot.getByText('No resource pressure detected', { exact: true })).toHaveCount(
      0,
    );

    if (state === 'missing') {
      await expect(snapshot.getByText('Not measured', { exact: true })).toHaveCount(9);
      await expect(
        page.getByText('No app readings yet. This does not mean no apps are running.'),
      ).toBeVisible();
    } else {
      await expect(
        snapshot.getByText('The figures below are the saved reading, not the present.'),
      ).toBeVisible();
      await expect(snapshot.getByText('Not current:', { exact: false })).toBeVisible();
      await expect(
        page
          .getByRole('region', { name: 'Apps and processes' })
          .getByText('Google Chrome', { exact: true }),
      ).toBeVisible();
    }
    await page.getByRole('button', { name: 'Open Resource assistant' }).click();
    await assistant.getByRole('button', { name: 'Model settings', exact: true }).click();
    await expect(assistant.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked();
    await assistant.getByRole('button', { name: 'Done', exact: true }).click();
    await assistant
      .getByRole('textbox', { name: 'Message Resource assistant' })
      .fill('Please explain the slowdown.');
    await expect(
      assistant.getByRole('button', { name: 'Send message', exact: true }),
    ).toBeEnabled();
    expect(writes).toEqual([]);
    await noHorizontalOverflow(page);
  });
}

test('graphs inspect retained readings without a human history browser or starting agents', async ({
  page,
}) => {
  const now = Date.now();
  const status = reading(now);
  status.checks = Array.from({ length: 20 }, (_, index) =>
    diagnosis(
      now - index * 60_000,
      `Diagnosis ${String(index).padStart(2, '0')}: ${index === 19 ? 'distinctive archive answer' : 'saved pressure explanation'}.`,
    ),
  );
  status.history = Array.from({ length: 96 }, (_, index) => ({
    ...sample(now - (95 - index) * 60_000),
    memoryPressure: index % 4 === 0 ? ('warning' as const) : ('normal' as const),
    hottestCorePercent: 20,
    swapOutBytesPerSecond: 0,
  }));
  const conversations = new Map(status.checks.map((check) => [check.agentId, conversation(check)]));
  const { writes } = await fixture(page, status, conversations);
  await page.goto('/#/resources');
  const trends = page.getByRole('region', { name: 'Trends', exact: true });
  await expect(trends.locator('.health-plot')).toHaveCount(4);
  await expect(page.getByRole('region', { name: 'History', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open this reading', exact: true })).toHaveCount(0);
  const cpu = trends.getByRole('img', { name: /^Whole-computer CPU,/ });
  await cpu.focus();
  await cpu.press('Home');
  await expect(trends.locator('.health-readout')).toContainText('Reading at');
  await expect(trends.locator('.health-plot').first().locator('header strong')).toHaveText('20%');
  await cpu.press('ArrowRight');
  await expect(trends.locator('.health-readout')).toContainText('Reading at');
  await cpu.press('Escape');
  await expect(trends.locator('.health-readout')).toContainText('Latest reading');
  await trends.getByRole('button', { name: '1 hour', exact: true }).click();
  await expect(trends.getByRole('button', { name: '1 hour', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await trends.getByRole('button', { name: '24 hours', exact: true }).click();
  await expect(trends.getByText('96 saved readings', { exact: false })).toBeVisible();
  const retained = await page.evaluate(async () => (await fetch('/api/resources')).json());
  expect(retained.history).toHaveLength(96);
  expect(retained.checks).toHaveLength(20);
  expect(writes).toEqual([]);
  await noHorizontalOverflow(page);
});

test('resource conversations stay out of lists while saved conversation links remain readable', async ({
  page,
}) => {
  const created = await page.request.post('/api/projects', {
    headers: { origin: new URL(test.info().project.use.baseURL as string).origin },
    data: {
      key: randomUUID(),
      name: `Resource history ${randomUUID().slice(0, 8)}`,
      provider: 'codex',
    },
  });
  expect(created.ok()).toBe(true);
  const project = await created.json();
  const base = await (await page.request.get(`/api/agents/${project.managerId}`)).json();
  const status = reading();
  status.projectId = project.id;
  const automatic = Array.from({ length: 30 }, (_, i) => ({
    ...base.agent,
    id: randomUUID(),
    name: `Automatic resource ${i}`,
    parentId: i === 29 ? base.agent.id : null,
    resourceAssistant: { mode: 'snapshot', reason: i % 2 ? 'pressure' : 'checkpoint' },
  }));
  const asked = {
    ...base.agent,
    id: randomUUID(),
    name: 'My resource question',
    resourceAssistant: { mode: 'interactive', reason: 'asked' },
  };
  const unknown = {
    ...base.agent,
    id: randomUUID(),
    name: 'Older resource question',
    resourceAssistant: { mode: 'snapshot' },
  };
  const originalSnapshot = await (await page.request.get('/api/snapshot')).json();
  const ordinary = {
    ...base.agent,
    id: randomUUID(),
    projectId: originalSnapshot.projects.find(
      (p: { id: string; internal: boolean }) => p.id !== project.id && !p.internal,
    )!.id,
    name: 'Automatic resource 0',
  };
  const legacy = { ...base.agent, id: randomUUID(), name: 'Legacy resource consultation' };
  const conversations = new Map(
    [...automatic, asked, unknown, legacy].map((agent) => [
      agent.id,
      {
        ...base,
        agent,
        entries: [
          {
            id: randomUUID(),
            agentId: agent.id,
            runId: null,
            kind: 'assistant',
            title: 'Assistant',
            text: 'Retained old automatic evidence.',
            status: 'completed',
            createdAt: agent.createdAt,
          },
        ],
      },
    ]),
  );
  await fixture(page, status, conversations);
  await page.route('**/api/snapshot', async (route) => {
    const original = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...original,
        agents: [...original.agents, ...automatic, asked, unknown, legacy, ordinary],
      },
    });
  });
  await page.goto('/#/chats');
  const list = page.getByRole('navigation', { name: 'Conversation list' });
  await expect(page.getByRole('link', { name: 'Resource assistant', exact: true })).toHaveCount(0);
  const searchBox = await page.getByRole('textbox', { name: 'Find a conversation' }).boundingBox();
  const searchRow = await page.locator('.chat-search').boundingBox();
  expect(searchRow!.height).toBeLessThanOrEqual(52);
  expect(Math.abs(searchRow!.y - searchBox!.y)).toBeLessThanOrEqual(2);
  await expect(list.getByRole('link', { name: /My resource question/ })).toHaveCount(0);
  await expect(list.getByRole('link', { name: /Older resource question/ })).toHaveCount(0);
  await expect(list.getByRole('link', { name: /Legacy resource consultation/ })).toHaveCount(0);
  await expect(list.getByRole('link', { name: /Automatic resource 0/ })).toHaveCount(1);
  await expect(
    list.getByRole('link', { name: /Automatic resource (?:[1-9]|[12][0-9])\b/ }),
  ).toHaveCount(0);
  await page.goto('/#/resources');
  await expect(page.locator('.health-older-checks')).toHaveCount(0);
  await expect(
    page.getByRole('searchbox', { name: 'Find a saved resource conversation' }),
  ).toHaveCount(0);
  await page.goto(`/#/resources/${legacy.id}`);
  const chat = page.getByRole('dialog', { name: 'Resource assistant conversation' });
  await expect(chat.getByText('Retained old automatic evidence.', { exact: true })).toBeVisible();
  await chat.getByRole('button', { name: 'Computer health', exact: true }).click();
  await expect(chat).toHaveCount(0);
});

test('a saved automatic report accepts an owner question with old readings after Stop retries its exact receipt', async ({
  page,
}) => {
  const status = reading(Date.now() - 900000);
  status.stale = true;
  const check = diagnosis(Date.now(), '');
  check.reason = 'pressure';
  check.state = 'running';
  status.checks = [check];
  const thread = conversation(check);
  thread.agent = {
    ...thread.agent,
    status: 'running',
    resourceAssistant: { mode: 'snapshot', reason: 'pressure' },
  } as typeof thread.agent;
  await fixture(page, status, new Map([[check.agentId, thread]]));
  const stops: { key: string; checkId: string }[] = [];
  await page.route('**/api/resources/stop', async (route) => {
    stops.push(route.request().postDataJSON());
    if (stops.length === 1)
      await route.fulfill({ status: 503, json: { error: 'Stop response lost.' } });
    else {
      check.state = 'interrupted';
      thread.agent.status = 'interrupted';
      await route.fulfill({ json: status });
    }
  });
  await page.goto(`/#/resources/${check.agentId}`);
  const chat = page.getByRole('dialog', { name: 'Resource assistant conversation' });
  const box = chat.getByRole('textbox', { name: 'Message Resource assistant' });
  await box.fill('Explain the readings.');
  await expect(box).toHaveValue('Explain the readings.');
  await expect(chat.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await chat.locator('.health-running').getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(chat.getByRole('alert').filter({ hasText: 'Stop response lost.' })).toBeVisible();
  await chat.locator('.health-running').getByRole('button', { name: 'Stop', exact: true }).click();
  expect(stops).toHaveLength(2);
  expect(stops[0]).toEqual(stops[1]);
  await expect(chat.locator('.health-running')).toHaveCount(0);
  await expect(box).toHaveValue('Explain the readings.');
  await expect(chat.getByRole('button', { name: 'Send message' })).toBeEnabled();
});

test('a saved resource deep link waits for its conversation and retains typing through delayed draft hydration', async ({
  page,
}) => {
  const status = reading(Date.now() - 900000);
  status.stale = true;
  const check = diagnosis(Date.now(), '');
  check.reason = 'pressure';
  check.state = 'running';
  status.checks = [check];
  const thread = conversation(check);
  thread.agent = {
    ...thread.agent,
    status: 'running',
    resourceAssistant: { mode: 'snapshot', reason: 'pressure' },
  } as typeof thread.agent;
  const { drafts } = await fixture(page, status, new Map([[check.agentId, thread]]));
  // Observe the first visible dialog without changing the browser's scheduling.
  await page.addInitScript(() => {
    const show = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      if (this.getAttribute('aria-label') === 'Resource assistant conversation')
        sessionStorage.setItem(
          'test:resource-composer-on-open',
          String(!!this.querySelector('.composer')),
        );
      return show.call(this);
    };
  });
  let releaseConversation!: () => void;
  const conversationReady = new Promise<void>((resolve) => {
    releaseConversation = resolve;
  });
  let releaseDraft!: () => void;
  const draftReady = new Promise<void>((resolve) => {
    releaseDraft = resolve;
  });
  let conversationRequested = false;
  let draftRequested = false;
  await page.route(`**/api/agents/${check.agentId}`, async (route) => {
    conversationRequested = true;
    await conversationReady;
    await route.fallback();
  });
  await page.route(`**/api/workspace/*/drafts/${check.agentId}`, async (route) => {
    if (route.request().method() === 'GET') {
      draftRequested = true;
      await draftReady;
    }
    await route.fallback();
  });
  await page.route('**/api/resources/stop', async (route) => {
    check.state = 'interrupted';
    thread.agent.status = 'interrupted';
    await route.fulfill({ json: status });
  });
  try {
    await page.goto(`/#/resources/${check.agentId}`);
    const chat = page.getByRole('dialog', { name: 'Resource assistant conversation' });
    await expect(chat.getByText('Loading conversation…', { exact: true })).toBeVisible();
    await expect.poll(() => conversationRequested).toBe(true);
    expect(
      await page.evaluate(() => sessionStorage.getItem('test:resource-composer-on-open')),
    ).toBe('false');
    await expect(chat.getByRole('textbox', { name: 'Message Resource assistant' })).toHaveCount(0);
    releaseConversation();
    const box = chat.getByRole('textbox', { name: 'Message Resource assistant' });
    await expect.poll(() => draftRequested).toBe(true);
    await box.fill('Keep this question while the saved draft reconnects.');
    await expect(box).toHaveValue('Keep this question while the saved draft reconnects.');
    await chat
      .locator('.health-running')
      .getByRole('button', { name: 'Stop', exact: true })
      .click();
    await expect(chat.locator('.health-running')).toHaveCount(0);
    await expect(box).toHaveValue('Keep this question while the saved draft reconnects.');
    await expect(chat.getByRole('button', { name: 'Send message' })).toBeDisabled();
    releaseDraft();
    await expect(chat.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await expect(box).toHaveValue('Keep this question while the saved draft reconnects.');
    await expect
      .poll(() => drafts.get(check.agentId)?.text)
      .toBe('Keep this question while the saved draft reconnects.');
    await page.reload();
    await expect(box).toHaveValue('Keep this question while the saved draft reconnects.');
    await expect(chat.getByRole('button', { name: 'Send message' })).toBeEnabled();
  } finally {
    releaseConversation();
    releaseDraft();
  }
});

test('crowded readings keep long names, large groups and whole-computer CPU inside their panels', async ({
  page,
}) => {
  const status = reading();
  const latest = status.latest!;
  // Schema maxima: 20 app groups of 100-character names and 100 jobs with 200-character projects.
  latest.processCount = 4812;
  latest.groups = Array.from({ length: 20 }, (_, i) => ({
    name:
      i % 2
        ? `com.example.UnbrokenHelperProcessName${i}`.padEnd(100, 'X')
        : `Very long app family ${i} with many words that should wrap neatly`.padEnd(100, ' w'),
    processes: 2400 - i,
    cpuPercent: i === 0 ? 12.5 : i === 1 ? null : 10 / (i + 2),
    memoryBytes: (1200 - i * 40) * 1024 ** 3,
    memoryChangeBytes: i % 3 ? -2048 * 1024 ** 2 : 9999 * 1024 ** 2,
  }));
  latest.jobs = Array.from({ length: 100 }, (_, i) => ({
    id: randomUUID(),
    projectId: i % 25 === 24 ? null : `20000000-0000-4000-8000-${String(i % 25).padStart(12, '0')}`,
    projectName:
      i % 25 === 24
        ? null
        : `Project ${i % 25} ${'with an extremely long title '.repeat(7)}`.slice(0, 200),
    name: `Worker ${i} ${'Z'.repeat(90)}`.slice(0, 100),
    kind: i % 2 ? 'local' : 'agent',
    status: 'running',
    processes: 1 + (i % 7),
    cpuPercent: i % 10 === 0 ? null : 0.4 * (i % 9),
    memoryBytes: (i + 1) * 64 * 1024 ** 2,
    memoryChangeBytes: null,
  }));
  const { writes } = await fixture(page, status);
  await page.goto('/#/resources');
  const apps = page.getByRole('region', { name: 'Apps and processes' });
  const projects = page.getByRole('region', { name: 'Projects and jobs' });
  await expect(apps.locator('.health-row')).toHaveCount(20);
  await expect(projects.locator('details.health-project')).toHaveCount(25);
  // App CPU is already divided by all cores; one saturated core on 8 cores reads 12.5%.
  await expect(
    apps.getByText('4812 processes, grouped by app · CPU is a share of all 8 cores together'),
  ).toBeVisible();
  await expect(
    projects.getByText('CPU is a share of all 8 cores together', { exact: false }),
  ).toBeVisible();
  await expect(apps.locator('.health-row').first().locator('> span').first()).toHaveText('13%');
  await expect(
    apps.getByText('+9999 MB since the last reading', { exact: false }).first(),
  ).toBeVisible();
  await expect(projects.getByText('Not in a project', { exact: true })).toBeVisible();
  const projectBounds = (await projects.boundingBox())!;
  expect(projectBounds.y + projectBounds.height).toBeLessThanOrEqual((await apps.boundingBox())!.y);
  await projects.locator('details.health-project > summary').first().click();
  await projects.locator('details.health-project > summary').last().click();
  const escapes = await page.evaluate(() =>
    [...document.querySelectorAll('.health-panel')].flatMap((panel) => {
      const box = panel.getBoundingClientRect();
      const scroll = panel.querySelector('.health-scroll')!;
      return [...panel.querySelectorAll('.health-row')].flatMap((row) => {
        const [name, cpu, memory] = [...row.children].map((c) => c.getBoundingClientRect());
        const problems: string[] = [];
        if (row.getBoundingClientRect().right > box.right + 0.5) problems.push('row');
        if (name!.right > cpu!.left + 0.5 || cpu!.right > memory!.left + 0.5)
          problems.push('overlap');
        if ((row.lastElementChild as HTMLElement).scrollWidth > memory!.width + 1)
          problems.push('memory');
        if (scroll.scrollHeight <= scroll.clientHeight) problems.push('unbounded');
        return problems.length ? [`${row.textContent?.slice(0, 40)}: ${problems}`] : [];
      });
    }),
  );
  expect(escapes).toEqual([]);
  for (const panel of [apps, projects]) {
    const height = await panel.locator('.health-scroll').evaluate((e) => e.clientHeight);
    expect(height).toBeLessThanOrEqual(320);
    await expect(panel.locator('.health-panel-hint')).not.toBeEmpty();
  }
  await apps.getByRole('button', { name: 'Memory', exact: true }).click();
  await expect(apps.locator('.health-row').first()).toContainText('1200 GB');
  expect(writes).toEqual([]);
  await noHorizontalOverflow(page);
  await mkdir('../../data/screenshots/resources', { recursive: true });
  await page.screenshot({
    path: `../../data/screenshots/resources/crowded-${test.info().project.name}.png`,
    fullPage: true,
    scale: 'css',
  });
});

test('partial and out-of-range readings stay explicit instead of looking healthy', async ({
  page,
}) => {
  const now = Date.now();
  const status = reading(now);
  status.findings = [];
  // The QUARK machine reading went stale (null) while the process probe still answered.
  status.latest = {
    ...status.latest!,
    machine: null,
    hottestCorePercent: null,
    memoryPressure: 'normal',
  };
  // Only readings from before a three-hour sleep remain.
  status.history = Array.from({ length: 30 }, (_, i) =>
    sample(now - 3 * 3600_000 - (29 - i) * 60_000),
  );
  const { writes } = await fixture(page, status);
  await page.goto('/#/resources');
  const snapshot = page.getByRole('region', { name: 'Right now' });
  await expect(
    snapshot.getByText('No detected pressure · some readings unavailable'),
  ).toBeVisible();
  await expect(snapshot.getByText('No resource pressure detected', { exact: true })).toHaveCount(0);
  for (const label of ['CPU', 'Busiest core', 'Storage headroom'])
    await expect(
      snapshot.locator('.health-metric').filter({ hasText: label }).first().locator('strong'),
    ).toHaveText('Not measured');
  // Disk, network, GPU and thermal readings come from their own sources.
  for (const [label, value] of [
    ['Disk activity', '4.0MB/s'],
    ['Network', '2.5MB/s'],
    ['GPU', '37%'],
    ['Thermal', 'No warning'],
  ])
    await expect(
      snapshot.locator('.health-metric').filter({ hasText: label }).first().locator('strong'),
    ).toHaveText(value);
  await expect(snapshot.getByText('3.0 read · 1.0 written')).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Apps and processes' })
      .getByText('CPU is a share of the whole computer', {
        exact: false,
      }),
  ).toBeVisible();
  const trends = page.getByRole('region', { name: 'Trends', exact: true });
  await expect(trends.locator('.health-plot')).toHaveCount(4);
  await trends.getByRole('button', { name: '1 hour', exact: true }).click();
  await expect(
    trends.getByText('Fewer than two saved readings in the last 1 hour.', { exact: false }),
  ).toBeVisible();
  await trends.getByRole('button', { name: '24 hours', exact: true }).click();
  await expect(trends.locator('.health-plot')).toHaveCount(4);
  await expect(trends.getByText('30 saved readings over 29 minutes')).toBeVisible();
  expect(writes).toEqual([]);
  await noHorizontalOverflow(page);
});

test('a lost refresh keeps the saved reading labelled, retries, and never blocks a reachable assistant', async ({
  page,
}) => {
  const status = reading();
  const { writes } = await fixture(page, status);
  let fail: 'none' | 'reset' | 'error' = 'none';
  await page.route('**/api/resources', (route) =>
    fail === 'reset'
      ? route.abort('connectionreset')
      : fail === 'error'
        ? route.fulfill({ status: 502, json: { error: 'Bad gateway' } })
        : route.fulfill({ json: status }),
  );
  await page.goto('/#/resources');
  const snapshot = page.getByRole('region', { name: 'Right now' });
  await expect(snapshot.getByRole('status')).toContainText('Memory is under pressure');
  fail = 'reset';
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(
    snapshot.getByText('Not current: this page could not reach the watcher', { exact: false }),
  ).toBeVisible();
  await expect(
    snapshot.getByText('The figures below are the saved reading, not the present.'),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Apps and processes' }).getByText('Google Chrome'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open Resource assistant' }).click();
  const chat = page.getByRole('dialog', { name: 'Resource assistant conversation' });
  await chat.getByRole('textbox', { name: 'Message Resource assistant' }).fill('Is it still slow?');
  // Owner questions may inspect current conditions even when cached readings are old.
  await expect(chat.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(chat.getByText('The saved readings may be old.', { exact: false })).toBeVisible();
  await chat.getByRole('button', { name: 'Computer health', exact: true }).click();
  fail = 'error';
  await snapshot.getByRole('button', { name: 'Retry reading' }).click();
  await expect(snapshot.getByRole('button', { name: 'Retry reading' })).toBeVisible();
  fail = 'none';
  await snapshot.getByRole('button', { name: 'Retry reading' }).click();
  await expect(snapshot.getByRole('button', { name: 'Retry reading' })).toHaveCount(0);
  await expect(snapshot.getByText('Updated', { exact: false })).toBeVisible();
  expect(writes).toEqual([]);
});

test('first-run failures explain the blocked assistant and keep provider choice usable', async ({
  page,
}) => {
  const status = reading();
  const { writes } = await fixture(page, status);
  let reachable = false;
  await page.route('**/api/resources', (route) =>
    reachable ? route.fulfill({ json: status }) : route.abort('connectionrefused'),
  );
  await page.route('**/api/model-policy', (route) =>
    route.fulfill({ status: 500, json: { error: 'Model settings unavailable.' } }),
  );
  await page.goto('/#/resources/chat');
  const chat = page.getByRole('dialog', { name: 'Resource assistant conversation' });
  await expect(
    chat.getByText('Computer health on this computer could not be reached.', { exact: false }),
  ).toBeVisible();
  await expect(chat.getByText('Connecting to computer health…')).toHaveCount(0);
  await chat.getByRole('button', { name: 'Computer health', exact: true }).click();
  await expect(page.getByText('Could not reach the watcher on this computer.')).toBeVisible();
  reachable = true;
  await page.getByRole('button', { name: 'Retry reading' }).click();
  await expect(page.getByRole('region', { name: 'Right now' }).getByRole('status')).toContainText(
    'Memory is under pressure',
  );
  await page.getByRole('button', { name: 'Open Resource assistant' }).click();
  await expect(
    chat.getByText('Model settings could not be loaded. Choose a provider in Model settings.'),
  ).toBeVisible();
  await chat.getByRole('button', { name: 'Model settings', exact: true }).click();
  await expect(chat.getByRole('radio', { name: 'Codex', exact: true })).not.toBeChecked();
  await chat.getByRole('radio', { name: 'Claude', exact: true }).click();
  await expect(chat.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled();
  await expect(
    chat
      .getByRole('combobox', { name: 'Model', exact: true })
      .locator('option', { hasText: 'Opus example' }),
  ).toHaveCount(1);
  await expect(
    chat.getByText('Model settings are unavailable; the central default will be used.'),
  ).toBeVisible();
  await chat.getByRole('button', { name: 'Done', exact: true }).click();
  await chat.getByRole('textbox', { name: 'Message Resource assistant' }).fill('Why is it slow?');
  await expect(chat.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  expect(writes).toEqual([]);
  await noHorizontalOverflow(page);
});

for (const mode of ['interactive', 'snapshot'] as const) {
  test(`a queued background check does not block a direct question or upgrading a ${mode} conversation model`, async ({
    page,
  }, info) => {
    const status = reading();
    if (mode === 'snapshot') status.stale = true;
    const previous = {
      ...diagnosis(Date.now() - 60000, 'Saved diagnosis'),
      model: 'fixture-sonnet',
    };
    const background = {
      ...diagnosis(Date.now(), ''),
      reason: 'pressure' as const,
      state: 'queued' as const,
      waitReason: 'Waiting for CPU headroom',
    };
    status.checks = [background, previous];
    const { conversations } = await fixture(page, status);
    const saved = conversation(previous);
    saved.agent.role = 'manager';
    saved.agent.resourceAssistant =
      mode === 'interactive' ? { mode, reason: 'asked' } : { mode, reason: 'checkpoint' };
    saved.agent.toolPolicy = mode === 'interactive' ? 'native' : 'restricted';
    saved.agent.permission = mode === 'interactive' ? 'workspace-write' : 'read-only';
    saved.agent.effort = 'high';
    conversations.set(previous.agentId, saved);
    const changes: Record<string, unknown>[] = [],
      asks: Record<string, unknown>[] = [];
    await page.route(`**/api/agents/${previous.agentId}/settings`, async (route) => {
      const input = route.request().postDataJSON();
      changes.push(input);
      if (changes.length === 1)
        return route.fulfill({
          status: 503,
          json: { error: 'Temporary connection failure. Retry.' },
        });
      saved.agent = {
        ...saved.agent,
        model: input.model,
        effort: input.effort,
        updatedAt: new Date().toISOString(),
      };
      return route.fulfill({ json: saved.agent });
    });
    await page.route('**/api/resources/ask', (route) => {
      asks.push(route.request().postDataJSON());
      return route.fulfill({ json: status });
    });
    await page.goto('/#/resources/chat');
    const chat = page.getByRole('dialog', { name: 'Resource assistant conversation' });
    await expect(chat.getByText('Saved diagnosis', { exact: true })).toBeVisible();
    await chat
      .getByRole('textbox', { name: 'Message Resource assistant' })
      .fill('What is using the CPU?');
    await expect(chat.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await chat.getByRole('button', { name: 'Model settings', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Resource assistant model', exact: true });
    await picker.getByRole('combobox', { name: 'Model', exact: true }).selectOption('fixture-opus');
    await picker
      .getByRole('combobox', { name: 'Thinking', exact: true })
      .selectOption('adaptive-v2');
    await page.screenshot({
      path: `../../data/resource-interactive-20261004/${info.project.name}-${mode}-model.png`,
    });
    expect(await picker.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await picker.getByRole('button', { name: 'Use this model', exact: true }).click();
    await expect(picker.getByRole('alert')).toContainText('Temporary connection failure');
    await picker.getByRole('button', { name: 'Use this model', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(chat.getByText('Model updated.', { exact: false })).toBeVisible();
    await expect(chat.getByText('Saved diagnosis', { exact: true })).toBeVisible();
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({
      model: 'fixture-opus',
      effort: 'adaptive-v2',
      permission: saved.agent.permission,
      toolPolicy: saved.agent.toolPolicy,
    });
    expect(asks).toEqual([]);
    await chat.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => asks.length).toBe(1);
    expect(asks[0]).toMatchObject({
      agentId: previous.agentId,
      question: 'What is using the CPU?',
    });
  });
}

// Different sibling keys matter here: a transcript and its composer must not share an ID.
// This exercises real React reconciliation, including late polling and repeated transitions.
test('new resource diagnoses remove old messages, preserve history and stay new after reload', async ({
  page,
}, info) => {
  const status = reading();
  const previous = diagnosis(Date.now() - 60_000, 'Earlier diagnosis: a long-running Python job.');
  status.checks = [previous];
  const history = conversation(
    previous,
    'Earlier question\n<agent-dock-evidence>Private measurements',
  );
  const { conversations, writes } = await fixture(
    page,
    status,
    new Map([[previous.agentId, history]]),
  );
  const asks: Record<string, unknown>[] = [];
  await page.route('**/api/resources/ask', async (route) => {
    const input = route.request().postDataJSON();
    asks.push(input);
    const created = diagnosis(Date.now(), 'New answer: memory pressure is normal.');
    conversations.set(created.agentId, conversation(created, input.question));
    status.checks.unshift(created);
    await route.fulfill({ json: status });
  });
  await page.goto(`/#/resources/${previous.agentId}`);
  const chat = page.getByRole('dialog', { name: 'Resource assistant conversation', exact: true });
  await expect(chat.getByText(previous.summary, { exact: true })).toBeVisible();
  await expect(chat.getByText('Private measurements', { exact: false })).toHaveCount(0);
  await expect(chat.getByRole('combobox')).toHaveCount(0);
  await chat
    .getByRole('textbox', { name: 'Message Resource assistant' })
    .fill('Unsent draft for the earlier conversation');
  // Leave an old poll in flight; it must not restore the old transcript after New.
  let finishPoll: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finishPoll = resolve;
  });
  let polling = false;
  await page.route(`**/api/agents/${previous.agentId}`, async (route) => {
    polling = true;
    await pending;
    await route.fulfill({ json: history });
  });
  await expect.poll(() => polling).toBe(true);
  await chat.getByRole('button', { name: 'New diagnosis', exact: true }).click();
  finishPoll!();
  await expect(page).toHaveURL(/#\/resources\/chat$/);
  await expect(chat.locator('.conversation')).toHaveCount(0);
  await expect(chat.locator('.message')).toHaveCount(0);
  await expect(chat.locator('.health-intro')).toHaveCount(1);
  await expect(chat.getByRole('combobox')).toHaveCount(0);
  await expect(chat.getByRole('textbox', { name: 'Message Resource assistant' })).toHaveValue('');
  await chat.getByRole('button', { name: 'Model settings', exact: true }).click();
  const preservedModel = page.getByRole('dialog', {
    name: 'Resource assistant model',
    exact: true,
  });
  await expect(preservedModel.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'fixture-opus',
  );
  await expect(preservedModel.getByRole('combobox', { name: 'Thinking', exact: true })).toHaveValue(
    'adaptive-v2',
  );
  await preservedModel.getByRole('button', { name: 'Done', exact: true }).click();
  expect(conversations.get(previous.agentId)).toEqual(history);
  expect(writes).toEqual([]);
  await page.reload();
  await expect(chat.locator('.health-intro')).toBeVisible();
  await expect(chat.locator('.conversation')).toHaveCount(0);
  const box = chat.getByRole('textbox', { name: 'Message Resource assistant' });
  await chat.getByRole('button', { name: 'Diagnosis history', exact: true }).click();
  const diagnosisHistory = page.getByRole('dialog', { name: 'Diagnosis history', exact: true });
  await diagnosisHistory.getByRole('button', { name: new RegExp(previous.summary) }).click();
  await expect(box).toHaveValue('Unsent draft for the earlier conversation');
  await expect(chat.locator('.conversation')).toHaveCount(1);
  await chat.getByRole('button', { name: 'New diagnosis', exact: true }).click();
  await expect(box).toHaveValue('');
  await box.fill('What is running now?');
  await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    chat.getByText('New answer: memory pressure is normal.', { exact: true }),
  ).toBeVisible();
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ question: 'What is running now?', provider: 'claude' });
  expect(asks[0]).not.toHaveProperty('agentId');
  await expect(chat.getByText(previous.summary, { exact: true })).toHaveCount(0);
  await expect(chat.locator('.conversation')).toHaveCount(1);
  await expect(chat.locator('.composer')).toHaveCount(1);
  await expect(chat.locator('.health-intro')).toHaveCount(0);
  await chat.getByRole('button', { name: 'New diagnosis', exact: true }).click();
  await box.fill('Keep this new draft while changing models');
  await chat.getByRole('button', { name: 'Model settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Resource assistant model', exact: true });
  await settings.getByRole('radio', { name: 'Codex', exact: true }).click();
  await settings.getByRole('combobox', { name: 'Model', exact: true }).selectOption('fixture-sol');
  // Re-selecting this provider must not reset a deliberate model choice.
  await settings.getByRole('radio', { name: 'Codex', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'fixture-sol',
  );
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(box).toHaveValue('Keep this new draft while changing models');
  expect(asks).toHaveLength(1);
  for (const zoom of [1, 1.25, 1.5]) {
    await page.evaluate((factor) => {
      document.documentElement.style.fontSize = `${16 * factor}px`;
    }, zoom);
    await expect(box).toBeInViewport();
    await expect(
      chat.getByRole('button', { name: 'Model settings', exact: true }),
    ).toBeInViewport();
    await expect(chat.locator('.message')).toHaveCount(0);
    expect(await chat.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const header = await chat.locator('.health-chat-options').boundingBox();
    expect(header!.height).toBeLessThan(page.viewportSize()!.height * 0.3);
    await mkdir('../../data/resource-chat-polish-20261003', { recursive: true });
    await page.screenshot({
      path: `../../data/resource-chat-polish-20261003/${info.project.name}-new-${zoom}.png`,
    });
  }
});

test('expired diagnosis acknowledges once, retains later typing through draft reconnect and save failure, and filters history', async ({
  page,
}, info) => {
  const previous = diagnosis(Date.now() - 2 * 60 * 60_000, 'Earlier owner diagnosis');
  const automatic = {
    ...diagnosis(Date.now() - 60_000, 'Automatic checkpoint evidence'),
    reason: 'checkpoint' as const,
  };
  const formattedSummary =
    '## **Latest owner follow-up**\nOne `python` process uses **91%** of a core; memory_tau = 1.2.\n- [Inspect processes](https://example.invalid)';
  const duplicate = {
    ...diagnosis(Date.now() - 60_000, formattedSummary),
    agentId: previous.agentId,
  };
  const status = reading();
  status.checks = [automatic, duplicate, previous];
  const history = conversation(previous);
  const { conversations, drafts } = await fixture(
    page,
    status,
    new Map([[previous.agentId, history]]),
  );
  const next = diagnosis(Date.now(), 'Fresh diagnosis received exactly the submitted question');
  conversations.set(next.agentId, conversation(next, 'Investigate this new slowdown'));
  const asks: Record<string, unknown>[] = [];
  let releaseFirst!: () => void;
  const firstReply = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route('**/api/resources/ask', async (route) => {
    asks.push(route.request().postDataJSON());
    if (asks.length === 1) {
      await firstReply;
      await route.fulfill({
        status: 503,
        json: { error: 'Connection interrupted after acceptance.' },
      });
      return;
    }
    status.checks = [next, automatic, duplicate, previous];
    await route.fulfill({ json: status });
  });
  let releaseDraft!: () => void;
  const draftConnection = new Promise<void>((resolve) => {
    releaseDraft = resolve;
  });
  let draftRequested = false;
  const draftWrites: Record<string, unknown>[] = [];
  await page.route(`**/api/workspace/*/drafts/${next.agentId}`, async (route) => {
    if (route.request().method() === 'GET') {
      draftRequested = true;
      await draftConnection;
    }
    if (route.request().method() === 'POST') {
      draftWrites.push(route.request().postDataJSON());
      if (draftWrites.length === 1) {
        await route.fulfill({
          status: 503,
          json: { error: 'Draft saving is temporarily unavailable.' },
        });
        return;
      }
    }
    await route.fallback();
  });
  await page.goto(`/#/resources/${previous.agentId}`);
  const chat = page.getByRole('dialog', { name: 'Resource assistant conversation', exact: true });
  const box = chat.getByRole('textbox', { name: 'Message Resource assistant' });
  await expect(chat.getByText(previous.summary, { exact: true })).toBeVisible();
  await box.fill('Investigate this new slowdown');
  await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => asks.length).toBe(1);
  await box.fill('Later typing while the acknowledgement is lost');
  releaseFirst();
  await expect(
    chat.getByRole('button', { name: 'Retry previous message', exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(box).toHaveValue('Later typing while the acknowledgement is lost');
  await chat.getByRole('button', { name: 'Retry previous message', exact: true }).click();
  await expect.poll(() => draftRequested).toBe(true);
  await expect(chat.getByText(previous.summary, { exact: true })).toBeVisible();
  await expect(box).toHaveValue('Later typing while the acknowledgement is lost');
  await box.fill('Later typing revised while the new draft reconnects');
  await expect(chat.getByText(next.summary, { exact: true })).toHaveCount(0);
  releaseDraft();
  await expect(chat.getByRole('button', { name: 'Retry saving draft', exact: true })).toBeVisible();
  await expect(
    chat.getByRole('button', { name: 'Retry saving draft', exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(chat.getByRole('button', { name: 'Keep draft here', exact: true })).toBeInViewport({
    ratio: 1,
  });
  await expect(chat.getByText(previous.summary, { exact: true })).toBeVisible();
  await expect(box).toHaveValue('Later typing revised while the new draft reconnects');
  await expect(
    chat.getByRole('button', { name: 'Retry previous message', exact: true }),
  ).toHaveCount(0);
  expect(asks).toHaveLength(2);
  await mkdir('../../data/resource-history-ui-checks', { recursive: true });
  await page.screenshot({
    path: `../../data/resource-history-ui-checks/${info.project.name}-save-recovery.png`,
  });
  await chat.getByRole('button', { name: 'Retry saving draft', exact: true }).click();
  await expect(chat.getByText(next.summary, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/resources/${next.agentId}$`));
  await expect(box).toHaveValue('Later typing revised while the new draft reconnects');
  expect(asks).toHaveLength(2);
  expect(asks[1]).toEqual(asks[0]);
  expect(asks[0]).toMatchObject({
    agentId: previous.agentId,
    question: 'Investigate this new slowdown',
  });
  expect(drafts.get(next.agentId)?.text).toBe(
    'Later typing revised while the new draft reconnects',
  );
  expect(draftWrites).toHaveLength(2);
  expect(draftWrites[1]).toEqual(draftWrites[0]);
  await page.reload();
  await expect(box).toHaveValue('Later typing revised while the new draft reconnects');
  await chat.getByRole('button', { name: 'Model settings', exact: true }).click();
  const model = page.getByRole('dialog', { name: 'Resource assistant model', exact: true });
  await expect(model.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'fixture-opus',
  );
  await expect(model.getByRole('combobox', { name: 'Thinking', exact: true })).toHaveValue(
    'adaptive-v2',
  );
  await model.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await chat.getByRole('button', { name: 'Diagnosis history', exact: true }).click();
  const saved = page.getByRole('dialog', { name: 'Diagnosis history', exact: true });
  await expect(saved.locator('.health-diagnosis-history li')).toHaveCount(2);
  await expect(saved.getByText(automatic.summary, { exact: true })).toHaveCount(0);
  await expect(saved.locator('strong').filter({ hasText: 'Latest owner follow-up' })).toHaveText(
    'Latest owner follow-up One python process uses 91% of a core; memory_tau = 1.2. Inspect processes',
  );
  expect(duplicate.summary).toBe(formattedSummary);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: `../../data/resource-history-ui-checks/${info.project.name}-history-dialog.png`,
  });
  await saved.getByRole('button', { name: /Latest owner follow-up/ }).click();
  await expect(box).toHaveValue('Later typing revised while the new draft reconnects');
  await expect(chat.getByText(previous.summary, { exact: true })).toBeVisible();
  await expect(chat.getByRole('button', { name: 'New diagnosis', exact: true })).toBeInViewport();
  await expect(
    chat.getByRole('button', { name: 'Diagnosis history', exact: true }),
  ).toBeInViewport();
  await noHorizontalOverflow(page);
  await mkdir('../../data/resource-history-ui-checks', { recursive: true });
  await page.screenshot({
    path: `../../data/resource-history-ui-checks/${info.project.name}-history.png`,
  });
});
