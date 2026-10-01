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
    unavailable: ['GPU, temperatures, disk I/O and network traffic are not measured.'],
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
  return { writes, conversations };
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
  await expect(assistant.getByRole('radio', { name: 'Ask Codex', exact: true })).toBeChecked();

  await assistant.getByRole('radio', { name: 'Ask Claude', exact: true }).click();
  await expect(assistant.getByRole('radio', { name: 'Ask Claude', exact: true })).toBeChecked();
  await expect(
    assistant.getByRole('combobox', { name: 'Model', exact: true }).locator('option[value=""]'),
  ).toHaveText('Sonnet example · routine-check default');
  await assistant
    .getByRole('combobox', { name: 'Model', exact: true })
    .selectOption('fixture-opus');
  await assistant
    .getByRole('combobox', { name: 'Thinking', exact: true })
    .selectOption('adaptive-v2');
  expect(writes).toEqual([]);
  await assistant
    .getByRole('textbox', { name: 'Message Resource assistant' })
    .fill('Why is Chrome slow at only 20% CPU?');
  await assistant.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    assistant.getByRole('alert').filter({ hasText: 'The request may have arrived' }),
  ).toBeVisible();
  await expect(assistant.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await page.reload();
  await expect(assistant.getByRole('radio', { name: 'Ask Claude', exact: true })).toBeChecked();
  await expect(assistant.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'fixture-opus',
  );
  await expect(assistant.getByRole('combobox', { name: 'Thinking', exact: true })).toHaveValue(
    'adaptive-v2',
  );
  await expect(assistant.getByRole('textbox', { name: 'Message Resource assistant' })).toHaveValue(
    'Why is Chrome slow at only 20% CPU?',
  );
  await assistant.getByRole('button', { name: 'Send message', exact: true }).click();
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
  await assistant.locator('.health-chat-controls > summary').click();
  await expect(
    assistant.getByText('Follow-ups keep this conversation’s provider and model.', {
      exact: false,
    }),
  ).toBeVisible();
  await assistant.locator('.health-chat-controls > summary').click();
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
      await expect(snapshot.getByText('Not measured', { exact: true })).toHaveCount(5);
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
    await expect(assistant.getByRole('radio', { name: 'Ask Codex', exact: true })).toBeChecked();
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

test('full-screen automatic snapshot keeps the fresh-reading guard and Stop retries its exact receipt', async ({
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
  await chat
    .getByRole('textbox', { name: 'Message Resource assistant' })
    .fill('Explain the readings.');
  await expect(chat.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await chat.locator('.health-running').getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(chat.getByRole('alert').filter({ hasText: 'Stop response lost.' })).toBeVisible();
  await chat.locator('.health-running').getByRole('button', { name: 'Stop', exact: true }).click();
  expect(stops).toHaveLength(2);
  expect(stops[0]).toEqual(stops[1]);
  await expect(chat.locator('.health-running')).toHaveCount(0);
  await expect(chat.getByRole('button', { name: 'Send message' })).toBeDisabled();
});
