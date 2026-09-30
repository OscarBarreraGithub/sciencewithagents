import { test, expect } from '@playwright/test';
import {
  defaultModelPolicy,
  type SetupStatus,
  type SignInStatus,
  type ClaudeSignInStatus,
} from '@dock/shared';
import { mkdir } from 'node:fs/promises';

test.afterEach(async ({ page }) => {
  // Await in-flight fixture responses before WebKit disposes their request context.
  await page.unrouteAll({ behavior: 'wait' });
});

function status(): SetupStatus {
  const policy = structuredClone(defaultModelPolicy);
  policy.enabledProviders = ['codex'];
  policy.scheduledProvider = 'codex';
  return {
    policy: {
      policy,
      catalogs: [
        { provider: 'codex', observedAt: null, error: null, models: [] },
        { provider: 'claude', observedAt: null, error: null, models: [] },
      ],
    },
    accounts: [
      { provider: 'codex', state: 'unchecked', checkedAt: null },
      { provider: 'claude', state: 'unchecked', checkedAt: null },
    ],
    checking: false,
  };
}

test('a new workspace opens setup, preserves progress and retries checks without dispatching work', async ({
  page,
}, info) => {
  let state = status(),
    checks = 0;
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);
  });
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({
      json: { ...value, projects: [], agents: [], tasks: [], runs: [], approvals: [] },
    });
  });
  await page.route('**/api/setup', (route) => route.fulfill({ json: state }));
  await page.route('**/api/setup/check', (route) => {
    if (checks++ === 0)
      return route.fulfill({
        status: 503,
        json: { error: 'Temporary connection problem. Your choices are saved.' },
      });
    state.accounts[0] = {
      provider: 'codex',
      state: 'signed-in',
      checkedAt: new Date().toISOString(),
    };
    state.policy.catalogs[0] = {
      provider: 'codex',
      observedAt: new Date().toISOString(),
      error: null,
      models: ['astra', 'sol', 'terra'].map((id) => ({
        id,
        label: id,
        efforts: ['low', 'high'],
        isDefault: false,
      })),
    };
    return route.fulfill({ json: state });
  });
  await page.goto('/');
  await expect(page).toHaveURL(/#\/welcome$/);
  await expect(page.getByRole('heading', { name: 'A home for your agents.' })).toBeVisible();
  await expect(page.getByText('Saved defaults: Codex')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('choices are saved');
  expect(writes).toEqual(['/api/setup/check']);
  await page.getByRole('button', { name: 'Check this computer', exact: true }).click();
  await expect(page.getByText('Native sign-in found', { exact: true })).toBeVisible();
  await expect(page.getByText('luna unavailable', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Native sign-in found', { exact: true })).toBeVisible();
  expect(writes).toEqual(['/api/setup/check', '/api/setup/check']);
  await page.getByRole('link', { name: 'Create first project', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goto('/#/welcome');
  await page.getByRole('link', { name: 'Open home', exact: true }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await page.goto('/#/welcome');
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.querySelector('.home-content')?.scrollTo({ top: 0, behavior: 'instant' });
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('../../data/screenshots/welcome', { recursive: true });
  await page.screenshot({
    path: `../../data/screenshots/welcome/${info.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole('heading', { name: 'Make room for an idea', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `../../data/screenshots/welcome/${info.project.name}-next-steps.png`,
    fullPage: true,
  });
  await page.goto('/?mirror');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('From your editor, to here.');
});

test('Codex sign-in restores its exact pending code after a lost response and never automatically starts again', async ({
  page,
}) => {
  const state = status();
  state.accounts[0] = { provider: 'codex', state: 'sign-in', checkedAt: new Date().toISOString() };
  let login: SignInStatus = {
    key: null,
    state: 'idle',
    verificationUrl: null,
    userCode: null,
    expiresAt: null,
  };
  let starts = 0,
    checks = 0;
  await page.route('**/api/setup', (route) => route.fulfill({ json: state }));
  await page.route('**/api/setup/check', (route) => {
    checks++;
    state.accounts[0]!.state = 'signed-in';
    return route.fulfill({ json: state });
  });
  await page.route('**/api/setup/sign-in', (route) => {
    if (route.request().method() === 'POST') {
      starts++;
      login = {
        key: route.request().postDataJSON().key,
        state: 'pending',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'EXAMPLE-CODE',
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      };
      return route.fulfill({
        status: 502,
        json: { error: 'Connection interrupted. Check the sign-in status.' },
      });
    }
    return route.fulfill({ json: login });
  });
  await page.goto('/#/welcome');
  await page.getByRole('button', { name: 'Sign in with Codex', exact: true }).click();
  await page.reload();
  await expect(page.getByText('EXAMPLE-CODE', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open OpenAI sign-in' })).toHaveAttribute(
    'href',
    'https://auth.openai.com/codex/device',
  );
  expect(starts).toBe(1);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain('EXAMPLE-CODE');
  login = { ...login, state: 'completed', userCode: null, verificationUrl: null };
  await expect(page.getByText('Native sign-in found', { exact: true })).toBeVisible({
    timeout: 8000,
  });
  expect(starts).toBe(1);
  expect(checks).toBe(1);
});

test('welcome lets a Claude-only user choose their provider before readiness without losing exact pins', async ({
  page,
}) => {
  const initial = status();
  const policy = initial.policy.policy;
  policy.models.codex.grad.model = 'retained-sol-version';
  policy.models.claude.grad.model = 'retained-opus-version';
  policy.providers.routine = 'codex';
  let current = { policy, catalogs: [] };
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);
  });
  await page.route('**/api/setup', (route) =>
    route.fulfill({ json: { ...initial, policy: current } }),
  );
  await page.route('**/api/setup/check', (route) =>
    route.fulfill({
      json: {
        ...initial,
        policy: current,
        accounts: [{ provider: 'claude', state: 'signed-in', checkedAt: new Date().toISOString() }],
      },
    }),
  );
  await page.route('**/api/model-policy', (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      current = { ...current, policy: { ...input.policy, revision: input.expectedRevision + 1 } };
    }
    return route.fulfill({ json: current });
  });
  await page.goto('/#/welcome');
  await expect(page.getByText('Saved defaults: Codex')).toBeVisible();
  await page.getByRole('link', { name: 'Choose team defaults', exact: true }).click();
  await page.getByLabel('Use Claude in defaults').check();
  await page.getByLabel('Use Codex in defaults').uncheck();
  await expect(page.getByLabel('Use Claude in defaults')).toBeDisabled();
  await expect(page.getByLabel('Routine checks & monitoring provider')).toHaveValue('preset');
  await expect(page.getByLabel('Unattended checks provider')).toHaveValue('claude');
  await page.getByRole('button', { name: 'Save model settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('saved');
  await page.reload();
  await expect(page.getByLabel('Use Codex in defaults')).not.toBeChecked();
  await expect(page.getByLabel('Grad student Claude model', { exact: true })).toHaveValue(
    'retained-opus-version',
  );
  expect(current.policy.enabledProviders).toEqual(['claude']);
  expect(current.policy.models.codex.grad.model).toBe('retained-sol-version');
  await page.getByRole('link', { name: 'Check accounts and setup', exact: true }).click();
  await expect(page.getByText('Saved defaults: Claude')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Codex readiness' })).toHaveCount(0);
  await expect(page.getByText('Native sign-in found', { exact: true })).toBeVisible();
  expect(writes).toEqual(['/api/setup/check', '/api/model-policy', '/api/setup/check']);
});

test('Claude sign-in opens only on request, restores a lost response and lets the owner verify completion', async ({
  page,
}, info) => {
  const state = status();
  state.policy.policy.enabledProviders = ['claude'];
  state.policy.policy.scheduledProvider = 'claude';
  state.policy.policy.preset = 'claude-heavy';
  state.accounts[1] = { provider: 'claude', state: 'sign-in', checkedAt: new Date().toISOString() };
  let login: ClaudeSignInStatus = { available: true, attempt: null };
  let starts = 0,
    checks = 0;
  await page.route('**/api/setup', (route) => route.fulfill({ json: state }));
  await page.route('**/api/setup/check', (route) => {
    checks++;
    state.accounts[1]!.state = 'signed-in';
    return route.fulfill({ json: state });
  });
  await page.route('**/api/setup/claude-sign-in', (route) => {
    if (route.request().method() === 'POST') {
      starts++;
      login.attempt = {
        key: route.request().postDataJSON().key,
        state: 'opened',
        openedAt: new Date().toISOString(),
      };
      return route.fulfill({
        status: 502,
        json: { error: 'Connection interrupted. Check sign-in progress.' },
      });
    }
    return route.fulfill({ json: login });
  });
  await page.goto('/#/welcome');
  const card = page.getByRole('region', { name: 'Claude readiness' });
  await expect(
    card.getByRole('button', { name: 'Sign in with Claude', exact: true }),
  ).toBeVisible();
  expect(starts).toBe(0);
  expect(checks).toBe(0);
  await card.getByRole('button', { name: 'Sign in with Claude', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('Connection interrupted');
  await card.getByRole('button', { name: 'Check sign-in progress', exact: true }).click();
  await expect(card.getByRole('status')).toContainText('window was opened on your Mac');
  await page.reload();
  await expect(card.getByRole('status')).toContainText('window was opened on your Mac');
  expect(starts).toBe(1);
  expect(checks).toBe(0);
  await card
    .getByRole('button', { name: 'Check Claude sign-in', exact: true })
    .scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('../../data/screenshots/welcome', { recursive: true });
  await page.screenshot({
    path: `../../data/screenshots/welcome/${info.project.name}-claude-sign-in.png`,
  });
  await card.getByRole('button', { name: 'Check Claude sign-in', exact: true }).click();
  await expect(card.getByText('Native sign-in found', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Open another sign-in window' })).toHaveCount(0);
  expect(starts).toBe(1);
  expect(checks).toBe(1);
});

test('setup makes pacing and stale usage visible without changing saved choices', async ({
  page,
}, info) => {
  let mode: 'on' | 'off' | 'error' = 'on';
  let recovery: Promise<void> | undefined;
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);
  });
  const ready = status();
  ready.accounts[0] = {
    provider: 'codex',
    state: 'signed-in',
    checkedAt: new Date().toISOString(),
  };
  await page.route('**/api/setup', (route) => route.fulfill({ json: ready }));
  await page.route('**/api/pulsar', async (route) => {
    await recovery;
    if (mode === 'error') return route.fulfill({ status: 503, json: { error: 'Disconnected' } });
    const response = await route.fetch(),
      value = await response.json();
    return route.fulfill({
      json: { ...value, policy: { ...value.policy, enabled: mode === 'on' } },
    });
  });
  await page.route('**/api/capacity', async (route) => {
    const response = await route.fetch(),
      value = await response.json();
    return route.fulfill({
      json: {
        ...value,
        providers: value.providers.map((provider: object) => ({ ...provider, stale: true })),
      },
    });
  });
  await page.goto('/#/welcome');
  const card = page.getByRole('article', { name: 'QUARK setup' });
  await expect(card).toContainText('Shared pacing on');
  await expect(card).toContainText('readings are missing or out of date');
  const control = card.getByRole('link', { name: 'Review pacing' });
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport();
  await page.screenshot({ path: `../../data/screenshots/welcome/${info.project.name}-pacing.png` });
  await control.click();
  await expect(page).toHaveURL(/#\/work$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Work, at the right pace.');
  mode = 'off';
  await page.goto('/#/welcome');
  await expect(card).toContainText('Shared pacing off');
  await expect(card).toContainText('Tasks still obey saved allowance caps');
  await card.getByRole('link', { name: 'Inspect usage' }).click();
  await expect(page).toHaveURL(/#\/usage$/);
  mode = 'error';
  await page.goto('/#/welcome');
  await page.reload();
  await expect(card).toContainText('Pacing status is unavailable');
  // Keep the failed state until the click lands. A background poll may recover too;
  // it must not remove the retry control while this fixture is trying to exercise it.
  let recover!: () => void;
  recovery = new Promise<void>((resolve) => {
    recover = resolve;
  });
  await card.getByRole('button', { name: 'Check pacing status' }).click();
  mode = 'on';
  recover();
  await expect(card).toContainText('Shared pacing on');
  expect(writes).toEqual([]);
});
