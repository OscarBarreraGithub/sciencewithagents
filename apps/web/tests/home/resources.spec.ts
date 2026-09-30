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
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
      writes.push(request.url());
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
  await projects.getByText('Research project', { exact: true }).click();
  await expect(
    projects.getByText('Literature worker and its helpers', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Memory is under pressure' }),
  ).toBeVisible();
  await expect(assistant.getByRole('radio', { name: 'Ask Codex', exact: true })).toBeChecked();
  expect(writes).toEqual([]);

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
    .getByRole('textbox', { name: /Your question/ })
    .fill('Why is Chrome slow at only 20% CPU?');
  await assistant.getByRole('button', { name: 'Ask Claude', exact: true }).click();
  await expect(assistant.getByRole('alert')).toContainText('The request may have arrived');
  await expect(assistant.getByRole('button', { name: 'Retry the same request' })).toBeVisible();
  await page.reload();
  await expect(assistant.getByRole('radio', { name: 'Ask Claude', exact: true })).toBeChecked();
  await expect(assistant.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'fixture-opus',
  );
  await expect(assistant.getByRole('combobox', { name: 'Thinking', exact: true })).toHaveValue(
    'adaptive-v2',
  );
  await expect(assistant.getByRole('textbox', { name: /Your question/ })).toHaveValue(
    'Why is Chrome slow at only 20% CPU?',
  );
  await assistant.getByRole('button', { name: 'Ask Claude', exact: true }).click();
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
  await expect(
    assistant.getByText('Follow-ups keep this conversation’s provider and model.', {
      exact: false,
    }),
  ).toBeVisible();
  await assistant
    .getByRole('textbox', { name: 'Follow-up question' })
    .fill('What should I compare after closing a tab?');
  await assistant.getByRole('button', { name: 'Send follow-up' }).click();
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
  await page.getByRole('link', { name: 'Back to home', exact: true }).click();
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
    await expect(assistant.getByRole('radio', { name: 'Ask Codex', exact: true })).toBeChecked();
    await expect(assistant.getByRole('button', { name: 'Ask Codex', exact: true })).toBeDisabled();
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
    expect(writes).toEqual([]);
    await noHorizontalOverflow(page);
  });
}

test('History pages and searches saved diagnoses and readings without starting agents', async ({
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
  const history = page.getByRole('region', { name: 'History', exact: true });
  const rows = history.getByRole('listitem');
  await expect(rows).toHaveCount(6);
  await expect(history.getByText('1–6 of 20', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'Older', exact: true }).click();
  await expect(rows).toHaveCount(6);
  await expect(history.getByText('7–12 of 20', { exact: true })).toBeVisible();
  await history.getByRole('searchbox', { name: 'Search reports' }).fill('distinctive archive');
  await expect(rows).toHaveCount(1);
  await rows.getByRole('button').click();
  await expect(
    history.getByText('Diagnosis 19: distinctive archive answer.', { exact: true }),
  ).toBeVisible();
  await expect(history.getByRole('button', { name: 'Continue in chat' })).toBeVisible();
  await history.getByRole('button', { name: 'Back to the list' }).click();
  await history.getByRole('searchbox', { name: 'Search reports' }).fill('');
  await history.getByRole('button', { name: 'Readings (96)', exact: true }).click();
  await expect(rows).toHaveCount(8);
  await expect(history.getByText('1–8 of 96', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'Older', exact: true }).click();
  await expect(history.getByText('9–16 of 96', { exact: true })).toBeVisible();
  await history.getByLabel('Only busy readings').check();
  await expect(rows).toHaveCount(8);
  await expect(history.getByText('1–8 of 24', { exact: true })).toBeVisible();
  await rows.first().getByRole('button').click();
  await expect(history.getByText('Whole-computer CPU', { exact: true })).toBeVisible();
  await expect(
    history.getByText('App-by-app breakdowns are kept only for the current reading.', {
      exact: false,
    }),
  ).toBeVisible();
  expect(writes).toEqual([]);
  await noHorizontalOverflow(page);
});
