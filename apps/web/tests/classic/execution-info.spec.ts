import { test, expect, type Page } from './fixture';
import { randomUUID } from 'node:crypto';
import type { Agent, UsageSummary } from '@dock/shared';

const catalog = {
  providers: [
    {
      id: 'codex',
      label: 'Codex',
      enabled: true,
      message: 'This build supports Codex.',
      capabilities: ['managed_chat', 'native_terminal', 'coordination_tools', 'reported_usage'],
    },
    {
      id: 'claude',
      label: 'Claude Code',
      enabled: false,
      message: 'Not enabled — adapter verification required.',
      capabilities: [],
    },
  ],
  automaticRouting: {
    enabled: false,
    policyRevision: null,
    message:
      'Automatic routing is off. The owner still needs to choose model, difficulty and usage rules.',
  },
};
const counts = (total: number | null) => ({
  totalTokens: total,
  inputTokens: total === null ? null : 80,
  cachedInputTokens: 0,
  cacheWriteInputTokens: null,
  outputTokens: total === null ? null : 20,
  reasoningOutputTokens: null,
});
const empty = (agent: Agent): UsageSummary => ({
  projectId: agent.projectId,
  agentId: agent.id,
  asOf: new Date().toISOString(),
  tokenSnapshots: [],
  quotaSnapshots: [],
  unknownTokenAgentIds: [agent.id],
  unknownQuotaAgentIds: [agent.id],
  omitted: { agents: 0, tokenSnapshots: 0, quotaSnapshots: 0 },
  notice:
    'Provider observations are retained individually. Missing reports are unknown, not zero usage or remaining budget.',
});
const reported = (agent: Agent): UsageSummary => {
  const now = new Date().toISOString(),
    older = new Date(Date.now() - 30 * 60_000).toISOString();
  const summary = empty(agent);
  summary.unknownTokenAgentIds = [];
  summary.unknownQuotaAgentIds = [];
  summary.tokenSnapshots = [
    {
      provider: 'codex',
      projectId: agent.projectId,
      agentId: agent.id,
      threadId: randomUUID(),
      turnId: null,
      runId: null,
      modelAtObservation: 'Observed model',
      modelScope: 'context-only-not-billing',
      total: counts(100),
      last: counts(20),
      modelContextWindow: null,
      observedAt: older,
      currentContext: true,
      stale: true,
    },
    {
      provider: 'codex',
      projectId: agent.projectId,
      agentId: agent.id,
      threadId: randomUUID(),
      turnId: null,
      runId: null,
      modelAtObservation: 'Earlier model',
      modelScope: 'context-only-not-billing',
      total: counts(90),
      last: counts(null),
      modelContextWindow: null,
      observedAt: older,
      currentContext: false,
      stale: true,
    },
  ];
  summary.quotaSnapshots = [
    {
      provider: 'codex',
      projectId: agent.projectId,
      agentId: agent.id,
      scope: 'provider-local-installation',
      accountAffinity: 'unknown',
      source: 'read',
      ordinaryUsageAllowed: true,
      ordinaryUsageObservedAt: older,
      ordinaryUsageStale: true,
      observedAt: now,
      stale: false,
      buckets: [
        {
          id: 'test-limit',
          name: 'Reported Codex allowance',
          normalModel: null,
          primary: {
            usedPercent: 40,
            windowDurationMins: 300,
            resetsAt: Math.floor(Date.now() / 1000) - 60,
            observedAt: older,
          },
          secondary: null,
          spendControlReached: null,
          rateLimitReachedType: null,
          observedAt: older,
          primaryStale: true,
          secondaryStale: null,
        },
      ],
    },
  ];
  return summary;
};

async function fixture(
  page: Page,
  options: { initialFailure?: boolean; assignment?: boolean; known?: boolean } = {},
) {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const saved = snapshot.agents.find(
    (item: Agent) => item.role === 'implementer' && !item.nativeRootId,
  );
  expect(saved).toBeTruthy();
  const agent: Agent = {
    ...saved,
    provider: 'codex',
    model: 'demo',
    effort: 'high',
    assignment: options.assignment
      ? {
          provider: 'codex',
          model: 'Original demo model',
          effort: 'medium',
          difficulty: 'high',
          source: 'manager_selection',
          reason:
            'The manager chose this worker for an independent review. No automatic ranking was used.',
          policyRevision: null,
        }
      : null,
  };
  const before = await (await page.request.get(`/api/agents/${agent.id}`)).json();
  let summary = options.known ? reported(agent) : empty(agent);
  const counts = { providers: 0, usage: 0, refresh: 0, work: 0 };
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/(?:agents\/[^/]+\/(?:messages|commands|settings)|approvals\/|tasks\/)/.test(
        new URL(request.url()).pathname,
      )
    )
      counts.work++;
  });
  await page.addInitScript(({ id }) => localStorage.setItem('dock:local:selected', id), {
    id: agent.id,
  });
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch(),
      value = await response.json();
    value.agents = value.agents.map((item: Agent) =>
      item.id === agent.id ? { ...item, ...agent } : item,
    );
    await route.fulfill({ json: value });
  });
  await page.route(`**/api/agents/${agent.id}`, async (route) => {
    const response = await route.fetch(),
      value = await response.json();
    value.agent = { ...value.agent, ...agent };
    await route.fulfill({ json: value });
  });
  await page.route('**/api/providers', async (route) => {
    counts.providers++;
    if (options.initialFailure && counts.providers === 1)
      return route.fulfill({
        status: 500,
        json: { error: 'Provider details could not be read. Your saved work is unchanged.' },
      });
    return route.fulfill({ json: catalog });
  });
  await page.route(`**/api/agents/${agent.id}/usage`, async (route) => {
    counts.usage++;
    if (options.initialFailure && counts.usage === 1)
      return route.fulfill({
        status: 500,
        json: { error: 'Saved usage could not be read. Try again.' },
      });
    return route.fulfill({ json: summary });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: agent.name, exact: true })).toBeVisible();
  await page.locator('.model-button').click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible();
  await page.getByText('Provider, usage and assignment', { exact: true }).click();
  const section = page.getByRole('region', { name: 'Provider and usage', exact: true });
  await expect(section).toBeVisible();
  return {
    agent,
    section,
    counts,
    before,
    summary: () => summary,
    setSummary: (value: UsageSummary) => {
      summary = value;
    },
  };
}
async function untouched(page: Page, value: Awaited<ReturnType<typeof fixture>>) {
  expect(value.counts.work).toBe(0);
  const after = await (await page.request.get(`/api/agents/${value.agent.id}`)).json();
  expect(after.runs).toEqual(value.before.runs);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

test('provider availability and unknown usage are read-only, with no automatic refresh', async ({
  page,
}, info) => {
  await page.clock.install();
  const value = await fixture(page),
    section = value.section;
  await expect(section.getByRole('list', { name: 'Provider availability' })).toContainText(
    'CodexAvailable',
  );
  await expect(section.getByRole('list', { name: 'Provider availability' })).toContainText(
    'Claude CodeNot enabled',
  );
  await expect(section).toContainText('Not enabled — adapter verification required.');
  await expect(section).toContainText('Automatic routing: Off.');
  await expect(section).toContainText('This does not mean zero usage.');
  await expect(section).toContainText('Remaining allowance and reset time are unknown.');
  await expect(section.locator('input, select, textarea')).toHaveCount(0);
  await expect(section.getByText('0 tokens reported', { exact: false })).toHaveCount(0);
  await page.clock.fastForward(16_000);
  expect(value.counts).toMatchObject({ providers: 1, usage: 1, refresh: 0 });
  await section
    .getByRole('heading', { name: 'Provider and usage', exact: true })
    .scrollIntoViewIfNeeded();
  await page.locator('.settings-card').screenshot({
    path: `../../data/screenshots/${info.project.name}-execution-unknown.png`,
  });
  await untouched(page, value);
});

test('saved token snapshots are not summed and elapsed resets remain unknown', async ({
  page,
}, info) => {
  const value = await fixture(page, { known: true }),
    section = value.section;
  await expect(section).toContainText('Current conversation: 100 tokens reported');
  await expect(section).toContainText('Older report — may be out of date');
  await expect(section).toContainText('5-hour window: 40% used');
  await expect(section).toContainText(
    'The reported reset time has passed. Available capacity is unknown',
  );
  await expect(section).toContainText('An older report said ordinary usage was allowed.');
  await expect(section).toContainText('not a project budget or a billing statement');
  await section.getByText('Token details', { exact: true }).click();
  await expect(section).toContainText('This is one saved snapshot, not a sum of updates.');
  await expect(section.getByText('Cached input', { exact: true }).locator('..')).toContainText('0');
  await section.getByText('Other saved usage reports', { exact: true }).click();
  await expect(section).toContainText('Earlier conversation context: 90 tokens reported');
  await expect(section.getByText(/190 tokens|210 tokens|60% remaining/)).toHaveCount(0);
  const observation = value.summary().quotaSnapshots[0].buckets[0].primary!.observedAt;
  await expect(section.locator(`time[datetime="${observation}"]`).first()).toHaveAttribute(
    'datetime',
    observation,
  );
  await section
    .getByRole('heading', { name: 'Reported account limits', exact: true })
    .scrollIntoViewIfNeeded();
  await page.locator('.settings-card').screenshot({
    path: `../../data/screenshots/${info.project.name}-execution-observed.png`,
  });
  await untouched(page, value);
});

test('reported-limit refresh failure retains usage and explicit retry reuses its receipt', async ({
  page,
}, info) => {
  const value = await fixture(page, { known: true }),
    section = value.section;
  const keys: string[] = [];
  await page.route(`**/api/agents/${value.agent.id}/usage/refresh`, async (route) => {
    value.counts.refresh++;
    const body = route.request().postDataJSON();
    expect(Object.keys(body)).toEqual(['key']);
    expect(body.key).toMatch(/^[0-9a-f-]{36}$/i);
    keys.push(body.key);
    if (keys.length === 1)
      return route.fulfill({
        status: 500,
        json: { error: 'This computer is offline. Saved usage is retained.' },
      });
    const next = structuredClone(value.summary());
    next.quotaSnapshots[0].buckets[0].primary!.usedPercent = 50;
    next.quotaSnapshots[0].buckets[0].primary!.resetsAt = Math.floor(Date.now() / 1000) + 3600;
    next.quotaSnapshots[0].buckets[0].primary!.observedAt = new Date().toISOString();
    next.quotaSnapshots[0].buckets[0].primaryStale = false;
    value.setSummary(next);
    return route.fulfill({ json: next });
  });
  await section.getByRole('button', { name: 'Refresh reported limits', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText(
    'This computer is offline. Saved usage is retained.',
  );
  await expect(section).toContainText('Current conversation: 100 tokens reported');
  await expect(section).toContainText('5-hour window: 40% used');
  await section.getByRole('button', { name: 'Try refreshing limits again', exact: true }).click();
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(section).toContainText('5-hour window: 50% used');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(value.counts.usage).toBe(1);
  await expect(section).toContainText('It does not send a message or start a model turn.');
  await section
    .getByRole('heading', { name: 'Reported account limits', exact: true })
    .scrollIntoViewIfNeeded();
  await page.locator('.settings-card').screenshot({
    path: `../../data/screenshots/${info.project.name}-execution-refresh.png`,
  });
  await untouched(page, value);
});

test('original assignment stays separate from current settings without invented model rankings', async ({
  page,
}, info) => {
  const value = await fixture(page, { assignment: true }),
    section = value.section;
  await section.getByText('Why this agent was assigned', { exact: true }).click();
  await expect(section.getByText('Current model', { exact: true }).locator('..')).toContainText(
    'demo',
  );
  await expect(section.getByText('Original model', { exact: true }).locator('..')).toContainText(
    'Original demo model',
  );
  await expect(
    section.getByText('Original reasoning', { exact: true }).locator('..'),
  ).toContainText('medium');
  await expect(section.getByText('Task difficulty', { exact: true }).locator('..')).toContainText(
    'high',
  );
  await expect(section).toContainText('Manager selection');
  await expect(section).toContainText(value.agent.assignment!.reason);
  await expect(section).toContainText('No automatic routing policy was used.');
  await expect(section.locator('input, select, textarea')).toHaveCount(0);
  await section.getByText('Why this agent was assigned', { exact: true }).scrollIntoViewIfNeeded();
  await page.locator('.settings-card').screenshot({
    path: `../../data/screenshots/${info.project.name}-execution-assignment.png`,
  });
  await untouched(page, value);
});

test('failed initial information reads have independent in-app retry controls', async ({
  page,
}) => {
  const value = await fixture(page, { initialFailure: true }),
    section = value.section;
  await expect(section.getByRole('alert')).toHaveCount(2);
  await expect(section).toContainText('Current provider');
  await expect(
    section.getByRole('button', { name: 'Refresh reported limits', exact: true }),
  ).toBeDisabled();
  await section
    .getByRole('button', { name: 'Try reading provider details again', exact: true })
    .click();
  await expect(section.getByRole('alert')).toHaveCount(1);
  await expect(section).toContainText('Claude Code');
  await section.getByRole('button', { name: 'Try reading saved usage again', exact: true }).click();
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(section).toContainText('Remaining allowance and reset time are unknown.');
  expect(value.counts).toMatchObject({ providers: 2, usage: 2, refresh: 0 });
  await untouched(page, value);
});
