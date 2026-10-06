import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { AdaptivePace } from '@dock/shared';

type Saved = { limitPercent: number; enabled: boolean } | null;

/** Demo coordinator with one reported Codex window; advice and saved caps are fixture-only. */
async function setup(
  page: Page,
  baseURL: string,
  { adaptive, saved = null }: { adaptive?: AdaptivePace; saved?: Saved },
) {
  const created = await page.request.post('/api/projects', {
    headers: { Origin: baseURL },
    data: {
      key: randomUUID(),
      name: `Hourly advice ${randomUUID().slice(0, 8)}`,
      provider: 'codex',
    },
  });
  expect(created.ok()).toBe(true);
  const project = await created.json();
  const now = new Date().toISOString();
  const resetsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const quark = await (await page.request.get('/api/quark')).json();
  const coordinator = await (await page.request.get('/api/quark/coordinator')).json();
  const budget = (limitPercent: number, enabled: boolean, revision: number) => ({
    id: savedId,
    projectId: project.id,
    taskId: null,
    provider: 'codex',
    windowId: 'secondary',
    period: 'hour',
    enabled,
    limitPercent,
    revision,
    createdAt: now,
    startSequence: 0,
    source: 'owner',
    spentPercent: 0,
    reservedPercent: 0,
    remainingPercent: limitPercent,
    nextEligibleAt: null,
    reason: null,
  });
  const savedId = randomUUID();
  let budgets = saved ? [budget(saved.limitPercent, saved.enabled, 1)] : [];
  coordinator.capacity = [
    {
      provider: 'codex',
      account: 'local-sign-in',
      label: 'Codex',
      plan: null,
      source: 'codexbar-oauth',
      observedAt: now,
      attemptedAt: now,
      nextRefreshAt: null,
      state: 'ready',
      stale: false,
      message: '',
      windows: [
        {
          id: 'secondary',
          label: 'Weekly',
          scope: 'general',
          model: null,
          usedPercent: 40,
          windowMinutes: 10080,
          resetsAt,
        },
      ],
      weeklyPolicy: 'reported',
    },
  ];
  // Earlier demo projects can fill the board; keep this one in view.
  const mine = coordinator.projects.find((p: { id: string }) => p.id === project.id);
  expect(mine).toBeTruthy();
  coordinator.projects = [mine];
  await page.route('**/api/quark/coordinator', (route) =>
    route.fulfill({
      json: { ...coordinator, accounting: { ...coordinator.accounting, budgets } },
    }),
  );
  await page.route('**/api/project-rates', (route) =>
    route.fulfill({
      json: {
        observedAt: now,
        notice: '',
        rates: [
          {
            projectId: project.id,
            provider: 'codex',
            windowId: 'secondary',
            label: 'Weekly',
            resetsAt,
            from: now,
            to: now,
            estimatedPercentPerHour: 0.8,
            estimatedPercent: 0.2,
            samples: 4,
            stale: false,
            history: [],
            historyCoverageMinutes: 0,
            ...(adaptive ? { adaptive } : {}),
          },
        ],
      },
    }),
  );
  const posts: Record<string, unknown>[] = [];
  let failNext = false;
  await page.route('**/api/quark/budgets', (route) => {
    const body = route.request().postDataJSON();
    posts.push(body);
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 503, json: { error: 'The reply was lost. Retry.' } });
    }
    budgets = [budget(body.limitPercent, body.enabled, 2)];
    return route.fulfill({ json: { ...quark, budgets } });
  });
  await page.goto('/#/work');
  const card = page.locator(`#quark-project-${project.id}`);
  const rate = card.getByRole('region', { name: 'Codex project rate' });
  await expect(rate).toBeVisible();
  return {
    rate,
    field: rate.getByRole('spinbutton', { name: 'Codex rate value (% per hour)' }),
    posts,
    loseNextReply: () => (failNext = true),
  };
}
const ready: AdaptivePace = {
  state: 'ready',
  percentPerHour: 1.26,
  reason: 'Two projects share the remaining weekly allowance.',
  demandProjects: 2,
  observedAt: new Date().toISOString(),
  resetsAt: null,
};

test('a ready suggestion fills only an unsaved field; Enter saves it with one durable retry', async ({
  page,
  baseURL,
}) => {
  const { rate, field, posts, loseNextReply } = await setup(page, baseURL!, { adaptive: ready });
  await expect(field).toHaveValue('1.3');
  await expect(rate).toContainText('Shared pace');
  await expect(rate).toContainText(
    'Suggested 1.3% / hour for this window · not saved · Two projects share the remaining weekly allowance.',
  );
  // Opening, focusing, leaving and reloading never save the suggestion.
  await field.focus();
  await field.blur();
  await page.reload();
  await expect(field).toHaveValue('1.3');
  await field.focus();
  await field.blur();
  expect(posts).toEqual([]);
  // Enter is the owner's explicit choice; a lost reply retries the exact same request.
  loseNextReply();
  await field.focus();
  await field.press('Enter');
  await expect(rate.getByRole('alert')).toContainText('The reply was lost. Retry.');
  await rate.getByRole('button', { name: 'Retry rate save', exact: true }).click();
  await expect(rate.getByRole('status')).toHaveText('Saved');
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[0]).toMatchObject({
    provider: 'codex',
    windowId: 'secondary',
    period: 'hour',
    enabled: true,
    limitPercent: 1.3,
  });
  await page.reload();
  await expect(field).toHaveValue('1.3');
  await expect(rate).toContainText('1.3% / hour');
  expect(posts).toHaveLength(2);
});

for (const adaptive of [
  { ...ready, state: 'unknown', percentPerHour: null, reason: 'No fresh allowance reading.' },
  { ...ready, state: 'idle', percentPerHour: null, reason: 'No project demand right now.' },
  { ...ready, state: 'blocked', percentPerHour: 2, reason: 'Shared reserve reached.' },
  undefined,
] as (AdaptivePace | undefined)[])
  test(`${adaptive?.state ?? 'an older computer without advice'} leaves a blank manual field and shared pace`, async ({
    page,
    baseURL,
  }) => {
    const { rate, field, posts } = await setup(page, baseURL!, { adaptive });
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('placeholder', 'Manual');
    await expect(rate).toContainText('Shared pace');
    await expect(rate).not.toContainText('5% / hour');
    await expect(rate.getByRole('slider', { name: 'Codex project rate limit' })).toHaveAttribute(
      'aria-valuetext',
      'No project rate limit; move to set one',
    );
    await expect(rate.locator('.quark-rate-advice')).toHaveText(
      adaptive
        ? `No suggestion (${adaptive.state}): ${adaptive.reason}`
        : 'No suggested pace from this computer; set a rate manually or keep the shared pace.',
    );
    await field.focus();
    await field.press('Enter');
    await field.blur();
    expect(posts).toEqual([]);
  });

for (const limit of [0, 2.5])
  test(`a saved ${limit}% cap wins over a ready suggestion`, async ({ page, baseURL }) => {
    const { rate, field, posts } = await setup(page, baseURL!, {
      adaptive: ready,
      saved: { limitPercent: limit, enabled: true },
    });
    await expect(field).toHaveValue(String(limit));
    await expect(rate.locator('.quark-rate-label strong')).toHaveText(`${limit}% / hour`);
    if (limit === 0) await expect(rate).toContainText('Codex paused for this project.');
    await field.focus();
    await field.press('Enter');
    await page.reload();
    await expect(field).toHaveValue(String(limit));
    expect(posts).toEqual([]);
  });
