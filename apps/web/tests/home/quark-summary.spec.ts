import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const window = (
  id: string,
  label: string,
  usedPercent: number,
  windowMinutes: number,
  model: string | null = null,
) => ({
  id,
  label,
  scope: model ? 'model' : 'general',
  model,
  usedPercent,
  windowMinutes,
  resetsAt: at(windowMinutes / 2),
});
const provider = (name: 'claude' | 'codex', reading: Record<string, unknown>) => ({
  provider: name,
  account: 'local-sign-in',
  label: name === 'claude' ? 'Claude' : 'Codex',
  plan: null,
  source: name === 'claude' ? 'claude-native-oauth' : 'codexbar-oauth',
  observedAt: at(-2),
  attemptedAt: at(-2),
  nextRefreshAt: at(5),
  state: 'ready',
  stale: false,
  message: 'Provider-reported allowance. All managers on this computer share this reading.',
  windows: [],
  weeklyPolicy: 'reported',
  ...reading,
});
const pacing = (name: 'claude' | 'codex', windowId: string) => ({
  provider: name,
  windowId,
  label: 'Five-hour',
  remainingPercent: 60,
  reservePercent: 10,
  resetsAt: at(150),
  minutesToReset: 150,
  observedPercentPerHour: 30,
  targetPercentPerHour: 10,
  projectedRemainingPercent: 5,
  state: 'fast',
  message: 'Fixture pace',
});

async function serve(page: Page, capacity: unknown[], utilization: unknown[] = []) {
  let starts = 0;
  page.on('request', (r) => {
    if (r.url().includes('/coordinator/start')) starts++;
  });
  await page.route('**/api/quark/coordinator', async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, capacity, utilization } });
  });
  await page.route('**/api/project-rates', async (route) => {
    const body = await (await route.fetch()).json();
    body.accounts = [
      {
        provider: 'claude',
        windowId: 'five_hour',
        label: 'Five-hour',
        observedAt: at(-2),
        remainingPercent: 60,
        savedReservePercent: 10,
        effectiveReservePercent: 10,
        reserveReleased: false,
        resetsAt: at(150),
        estimatedPercentPerHour: 4.5,
        reserveAt: at(600),
        exhaustionAt: at(800),
        resetBeforeReserve: true,
        stale: false,
        configuredProjectPercentPerHour: 3,
        uncappedProjects: 1,
      },
    ];
    await route.fulfill({ json: body });
  });
  return () => starts;
}

async function bounded(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const heading = page.locator('.quark-workspace > .flow-heading');
  await expect(heading.getByText('QUARK', { exact: true })).toHaveCount(1);
  await expect(heading.locator('.flow-subtitle')).toHaveText('Queued Usage, Agent Routing Kernel.');
  for (const box of await page.locator('.quark-summary-counts button').all()) {
    const size = (await box.boundingBox())!;
    expect(size.height).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeLessThanOrEqual(72);
  }
  for (const summary of await page.locator('.quark-account summary').all())
    expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const card of await page.locator('.quark-account').all())
    expect((await card.boundingBox())!.height).toBeLessThanOrEqual(240);
  await mkdir('../../data/quark-summary', { recursive: true });
  await page.locator('.quark-overview').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `../../data/quark-summary/${info.project.name}-${name}.png` });
}

test('QUARK summary keeps model windows and never presents an old reading as current', async ({
  page,
}, info) => {
  const starts = await serve(
    page,
    [
      provider('claude', {
        windows: [
          window('five_hour', 'Session', 40, 300),
          window('seven_day', 'Weekly', 25, 10080),
          window('seven_day_opus', 'Opus weekly', 90, 10080, 'Opus'),
        ],
      }),
      provider('codex', {
        observedAt: at(-180),
        nextRefreshAt: at(10),
        state: 'error',
        stale: true,
        message:
          'Could not refresh usage. Check this computer’s provider sign-in and usage collector. Saved readings are shown as stale; automatic work waits for a fresh report.',
        windows: [window('primary', 'Session', 30, 300)],
      }),
    ],
    [pacing('claude', 'five_hour'), pacing('codex', 'primary')],
  );
  await page.goto('/#/work');
  const claude = page.locator('.quark-account').filter({ hasText: 'Claude' });
  const codex = page.locator('.quark-account').filter({ hasText: 'Codex' });
  const listed = claude.locator('.quark-account-windows');
  for (const text of ['Five-hour', '60% left', 'Weekly', '75% left', 'Opus weekly', '10% left'])
    await expect(listed.getByText(text, { exact: true })).toBeVisible();
  // Rendered text only: the closed details repeat some of this for later reading.
  const shown = { useInnerText: true };
  await expect(claude).toContainText('Updated 2 min ago', shown);
  await expect(listed).toContainText('Resets in');
  await expect(listed).toContainText('ahead of pace', shown);
  await expect(claude).not.toContainText('· old', shown);
  // The stale provider keeps its numbers, marks them old and shows only its actionable reason.
  await expect(codex.getByText('70% left · old', { exact: true })).toBeVisible();
  await expect(codex).toContainText('Last reading 3 h ago');
  await expect(
    codex.getByText(
      'Could not refresh usage. Check this computer’s provider sign-in and usage collector.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(codex).not.toContainText('ahead of pace', shown);
  await expect(codex.getByText(/Saved readings are shown as stale/)).toBeHidden();
  // Forecast prose, exact times and provider actions wait behind a closed expansion.
  await expect(page.locator('.quark-account details[open]')).toHaveCount(0);
  await expect(claude.getByText(/Account rate/)).toBeHidden();
  await expect(claude.getByText(/Saved project ceilings/)).toBeHidden();
  await expect(claude.getByText(/Usage is ahead of pace/)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Refresh usage' })).toHaveCount(0);
  await bounded(page, info, 'fresh-stale');
  await claude.getByText('Details & actions').click();
  await expect(claude.getByText('Account rate ≈4.5% / hour.')).toBeVisible();
  await expect(claude.getByText(/Saved project ceilings total 3% \/ hour/)).toBeVisible();
  await expect(claude.getByText(/Usage is ahead of pace/)).toBeVisible();
  await codex.getByText('Details & actions').click();
  await expect(codex.getByText(/Saved readings are shown as stale/)).toBeVisible();
  await expect(codex).not.toContainText('ahead of pace', shown);
  await expect(codex).toContainText('Next automatic check');
  await expect(codex).not.toContainText('queued work fits', shown);
  for (const name of ['Refresh usage', 'Check connection', 'Check & install updates'])
    await expect(codex.getByRole('button', { name, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await codex.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `../../data/quark-summary/${info.project.name}-expanded.png` });
  expect(starts()).toBe(0);
});

test('QUARK summary keeps unreported and empty allowances short and unavailable', async ({
  page,
}, info) => {
  const starts = await serve(page, [
    provider('claude', {
      observedAt: null,
      attemptedAt: null,
      nextRefreshAt: null,
      state: 'unknown',
      stale: true,
      message: 'Waiting for this computer’s signed-in usage report.',
    }),
    provider('codex', { observedAt: at(-10) }),
  ]);
  await page.goto('/#/work');
  const claude = page.locator('.quark-account').filter({ hasText: 'Claude' });
  const codex = page.locator('.quark-account').filter({ hasText: 'Codex' });
  await expect(claude).toContainText('Allowance not reported yet');
  await expect(claude).toContainText('Waiting for this computer’s signed-in usage report.');
  await expect(claude).not.toContainText('% left', { useInnerText: true });
  await expect(claude).not.toContainText('Updated', { useInnerText: true });
  await expect(codex).toContainText('The last reading has no allowance windows.');
  // Empty readings never make a claim that queued work fits.
  for (const card of [claude, codex])
    await expect(card).not.toContainText('queued work fits', { useInnerText: true });
  await bounded(page, info, 'empty');
  await claude.getByText('Details & actions').click();
  await expect(claude.getByRole('button', { name: 'Refresh usage', exact: true })).toBeVisible();
  expect(starts()).toBe(0);
});

test('QUARK summary counts the same cards as the board and opens that column', async ({ page }) => {
  const state = await (await page.request.get('/api/snapshot')).json();
  const coordinator = await (await page.request.get('/api/quark/coordinator')).json();
  const project = state.projects.find((p: { internal?: boolean }) => !p.internal);
  const template = state.tasks.find((t: { projectId: string }) => t.projectId === project.id);
  // A task between turns has no queued job, yet the board still shows it as Waiting.
  state.tasks.push({
    ...template,
    id: crypto.randomUUID(),
    title: 'Between turns fixture',
    status: 'working',
  });
  coordinator.projects.find((p: { id: string }) => p.id === project.id).policy.paused = false;
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: state }));
  await page.route('**/api/quark/coordinator', (route) => route.fulfill({ json: coordinator }));
  await page.goto('/#/work');
  await expect(page.getByRole('region', { name: 'Waiting', exact: true })).toContainText(
    'Between turns fixture',
  );
  const counts = page.locator('.quark-summary-counts');
  for (const column of ['Working', 'Waiting', 'Paused / needs input']) {
    const board = await page
      .getByRole('region', { name: column, exact: true })
      .locator('h3 b')
      .innerText();
    await expect(
      counts.getByRole('button', { name: `${board} ${column}`, exact: true }),
    ).toBeVisible();
  }
  await counts.getByRole('button', { name: /Waiting$/ }).click();
  await expect(counts.getByRole('button', { name: /Waiting$/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Waiting', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('region', { name: 'Waiting', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Working', exact: true })).toHaveCount(0);
  await expect(page.locator('.quark-filters')).toBeInViewport();
});

test('an unavailable provider keeps long errors in details and suppresses current forecasts', async ({
  page,
}, info) => {
  const message = `Usage could not refresh because ${'a detailed connection failure '.repeat(12)}. Check connection.`;
  const starts = await serve(
    page,
    [
      provider('claude', {
        state: 'error',
        stale: false,
        message,
        windows: [window('five_hour', 'Session', 40, 300)],
      }),
    ],
    [pacing('claude', 'five_hour')],
  );
  await page.goto('/#/work');
  const card = page.locator('.quark-account');
  await expect(
    card.getByText('Usage reading needs attention. Check connection.', { exact: true }),
  ).toBeVisible();
  await expect(card.getByText(message, { exact: true })).toBeHidden();
  await expect(card.getByText('60% left · old', { exact: true })).toBeVisible();
  await bounded(page, info, 'long-error');
  await card.getByText('Details & actions').click();
  await expect(card.getByText(message, { exact: true })).toBeVisible();
  await expect(card).toContainText('Last observed account rate');
  for (const text of [
    'queued work fits',
    'Usage is ahead of pace.',
    'Reserve projected',
    'Zero projected',
  ])
    await expect(card).not.toContainText(text, { useInnerText: true });
  expect(starts()).toBe(0);
});

test('scheduled checks do not invent expiry and reset-expired windows have no current projection', async ({
  page,
}) => {
  const expired = { ...window('primary', 'Session', 30, 300), resetsAt: at(-1) };
  const starts = await serve(
    page,
    [
      provider('claude', {
        nextRefreshAt: at(-10),
        windows: [window('five_hour', 'Session', 40, 300)],
      }),
      provider('codex', { windows: [expired] }),
    ],
    [pacing('claude', 'five_hour'), pacing('codex', 'primary')],
  );
  await page.goto('/#/work');
  const claude = page.locator('.quark-account').filter({ hasText: 'Claude' });
  const codex = page.locator('.quark-account').filter({ hasText: 'Codex' });
  await expect(claude.getByText('60% left', { exact: true })).toBeVisible();
  await expect(claude).toContainText('Updated 2 min ago');
  await expect(claude).toContainText('ahead of pace', { useInnerText: true });
  await expect(codex.getByText('70% left · old', { exact: true })).toBeVisible();
  await expect(codex).not.toContainText('ahead of pace', { useInnerText: true });
  await claude.getByText('Details & actions').click();
  await codex.getByText('Details & actions').click();
  await expect(claude).toContainText('Usage is ahead of pace.', { useInnerText: true });
  await expect(codex).not.toContainText('Usage is ahead of pace.', { useInnerText: true });
  for (const card of [claude, codex])
    await expect(card).not.toContainText('queued work fits', { useInnerText: true });
  expect(starts()).toBe(0);
});
