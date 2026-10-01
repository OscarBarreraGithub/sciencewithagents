import { test, expect } from '@playwright/test';
import { defaultModelPolicy, type ModelPolicyStatus } from '@dock/shared';
import { mkdir } from 'node:fs/promises';

test('model settings support mobile editing, exact versions, safe save retry and a renamed family', async ({
  page,
}, info) => {
  let state: ModelPolicyStatus = {
    policy: structuredClone(defaultModelPolicy),
    catalogs: [
      { provider: 'codex', observedAt: null, error: null, models: [] },
      { provider: 'claude', observedAt: null, error: null, models: [] },
    ],
  };
  const requests: object[] = [];
  await page.route('**/api/model-policy', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: state });
    const input = route.request().postDataJSON();
    requests.push(input);
    state = { ...state, policy: { ...input.policy, revision: input.expectedRevision + 1 } };
    if (requests.length === 1)
      return route.fulfill({
        status: 502,
        json: { error: 'Connection interrupted. Try saving again.' },
      });
    return route.fulfill({ json: state });
  });
  await page.route('**/api/model-policy/catalogs', (route) => {
    const model = (id: string) => ({
      id,
      label: id.toUpperCase(),
      isDefault: false,
      efforts: ['low', 'high', 'adaptive-v2'],
    });
    state.catalogs = [
      {
        provider: 'codex',
        observedAt: new Date().toISOString(),
        error: null,
        models: [
          'gpt-6-astra',
          'gpt-6-sol',
          'gpt-5.6-sol',
          'gpt-5.6-terra',
          'gpt-6-luna',
          'gpt-5.5',
        ].map(model),
      },
      {
        provider: 'claude',
        observedAt: new Date().toISOString(),
        error: null,
        models: [
          ...['sonnet', 'opus', 'claude-fable-5-1'].map(model),
          { ...model('haiku'), efforts: ['provider-default'] },
        ],
      },
    ];
    return route.fulfill({ json: state });
  });
  await page.goto('/#/models');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Model preferences');
  await expect(page.getByRole('combobox', { name: 'Manager provider', exact: true })).toHaveValue(
    'codex',
  );
  await page.getByRole('button', { name: 'Refresh available models' }).click();
  await expect(
    page.getByLabel('Uncle Claude model', { exact: true }).locator('option[value="haiku"]'),
  ).toBeAttached();
  await page.getByRole('combobox', { name: 'Manager provider', exact: true }).selectOption('ask');
  await page.getByLabel('Grad student Codex model', { exact: true }).selectOption('gpt-5.5');
  const grad = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Grad student', exact: true }) });
  await grad
    .locator('details')
    .first()
    .getByText('Family & thinking level', { exact: true })
    .click();
  await page
    .getByLabel('Grad student Codex thinking level', { exact: true })
    .selectOption('adaptive-v2');
  await page.getByLabel('Routine checks & monitoring provider').selectOption('codex');
  await page.getByLabel('Unattended checks provider').selectOption('codex');
  const uncle = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Uncle', exact: true }) });
  await uncle
    .locator('details')
    .first()
    .getByText('Family & thinking level', { exact: true })
    .click();
  await page.getByLabel('Uncle Codex family', { exact: true }).fill('next-luna');
  await page.getByLabel('Uncle Claude model', { exact: true }).selectOption('haiku');
  await uncle
    .locator('details')
    .nth(1)
    .getByText('Family & thinking level', { exact: true })
    .click();
  await page
    .getByLabel('Uncle Claude thinking level', { exact: true })
    .selectOption({ label: 'Provider default' });
  await page.getByRole('button', { name: 'Save model settings', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Connection interrupted');
  await page.getByRole('button', { name: 'Save model settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Model settings saved');
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(state.policy.models.codex.grad.model).toBe('gpt-5.5');
  expect(state.policy.models.codex.grad.effort).toBe('adaptive-v2');
  expect(state.policy.models.codex.uncle.family).toBe('next-luna');
  expect(state.policy.models.claude.uncle.effort).toBe('provider-default');
  expect(state.policy.providers.routine).toBe('codex');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Manager provider', exact: true })).toHaveValue(
    'ask',
  );
  await expect(page.getByLabel('Grad student Codex model', { exact: true })).toHaveValue('gpt-5.5');
  await expect(page.getByLabel('Uncle Claude thinking level', { exact: true })).toHaveValue(
    'provider-default',
  );
  await expect(page.getByLabel('Grad student Codex thinking level', { exact: true })).toHaveValue(
    'adaptive-v2',
  );
  await expect(
    page.getByText('One consultation on the same provider', { exact: false }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement)?.blur();
    window.scrollTo(0, 0);
  });
  await mkdir('../../data/screenshots/model-settings', { recursive: true });
  await page.screenshot({
    path: `../../data/screenshots/model-settings/${info.project.name}.png`,
    fullPage: true,
  });
});

test('settings failures are retryable and another device cannot silently overwrite a draft', async ({
  page,
}) => {
  let reads = 0;
  await page.route('**/api/model-policy', (route) => {
    if (route.request().method() === 'POST')
      return route.fulfill({
        status: 409,
        json: {
          error:
            'Model settings changed on another device. Reload the saved settings before saving your changes.',
        },
      });
    if (reads++ === 0)
      return route.fulfill({ status: 500, json: { error: 'Computer connection unavailable.' } });
    return route.fulfill({ json: { policy: defaultModelPolicy, catalogs: [] } });
  });
  await page.goto('/#/models');
  await expect(page.getByRole('alert')).toContainText('Computer connection unavailable');
  await page.getByRole('button', { name: 'Retry loading settings' }).click();
  await page
    .getByRole('combobox', { name: 'Manager provider', exact: true })
    .selectOption('claude');
  await page.getByRole('button', { name: 'Save model settings', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('another device');
  await expect(page.getByRole('combobox', { name: 'Manager provider', exact: true })).toHaveValue(
    'claude',
  );
  await page.getByRole('button', { name: 'Reload saved settings' }).click();
  await expect(page.getByRole('combobox', { name: 'Manager provider', exact: true })).toHaveValue(
    'codex',
  );
});

test('general preferences seed project customization and recommendations restore without overwriting the saved setup draft', async ({
  page,
}, info) => {
  const model = (id: string) => ({
    id,
    label: id,
    isDefault: false,
    efforts: ['medium', 'high', 'xhigh'],
  });
  let state: ModelPolicyStatus = {
    policy: structuredClone(defaultModelPolicy),
    catalogs: [
      {
        provider: 'codex',
        observedAt: new Date().toISOString(),
        error: null,
        models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-6-terra', 'gpt-6-luna'].map(model),
      },
      {
        provider: 'claude',
        observedAt: new Date().toISOString(),
        error: null,
        models: ['fable', 'opus', 'sonnet'].map(model),
      },
    ],
  };
  await page.route('**/api/model-policy', (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      state = { ...state, policy: { ...input.policy, revision: input.expectedRevision + 1 } };
    }
    return route.fulfill({ json: state });
  });
  await page.route('**/api/models?*', (route) =>
    route.fulfill({
      json: state.catalogs.find(
        (c) => c.provider === new URL(route.request().url()).searchParams.get('provider'),
      )!.models,
    }),
  );
  await page.goto('/#/models');
  await expect(page.getByRole('heading', { name: 'Task defaults', exact: true })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Provider mix', exact: true })).toHaveAttribute(
    'aria-valuetext',
    'Balanced',
  );
  await expect(page.getByRole('slider', { name: 'Usage', exact: true })).toHaveAttribute(
    'aria-valuetext',
    'Tokenmax',
  );
  await page
    .getByRole('combobox', { name: 'Manager provider', exact: true })
    .selectOption('claude');
  await expect(page.getByRole('combobox', { name: 'Manager reasoning', exact: true })).toHaveValue(
    'xhigh',
  );
  await page.getByRole('combobox', { name: 'Manager model', exact: true }).selectOption('fable');
  const usage = page.getByRole('slider', { name: 'Usage', exact: true });
  await usage.focus();
  await usage.press('Home');
  await page.locator('.config-models > summary').click();
  await page
    .getByRole('combobox', { name: 'Research & coding', exact: true })
    .selectOption('codex:gpt-5.6-sol');
  await page.getByRole('button', { name: 'Save model settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Model settings saved');
  expect(state.policy.projectDefaults.overrides.research?.model).toBe('gpt-5.6-sol');
  expect(state.policy.managerModels.claude?.model).toBe('fable');
  expect(state.policy.models.claude.postdoc.model).toBeNull();
  await page.goto('/#/new');
  const manager = page.getByRole('group', { name: 'Manager', exact: true });
  await expect(manager.getByRole('combobox', { name: 'Provider', exact: true })).toHaveValue(
    'claude',
  );
  await expect(manager.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('fable');
  await expect(page.getByRole('slider', { name: 'Usage', exact: true })).toHaveAttribute(
    'aria-valuetext',
    'Light',
  );
  const research = page.getByRole('combobox', { name: 'Research & coding', exact: true });
  await expect(research).toHaveValue('codex:gpt-5.6-sol');
  await research.selectOption('codex:gpt-6-sol');
  expect(state.policy.projectDefaults.overrides.research?.model).toBe('gpt-5.6-sol');
  await page.goto('/#/models');
  await page.getByRole('button', { name: 'Restore recommended defaults', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Save to apply');
  expect(state.policy.projectDefaults.spending).toBe('light');
  await page.getByRole('button', { name: 'Save model settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Model settings saved');
  expect(state.policy.projectDefaults).toEqual(defaultModelPolicy.projectDefaults);
  await page.reload();
  await expect(page.getByRole('slider', { name: 'Usage', exact: true })).toHaveAttribute(
    'aria-valuetext',
    'Tokenmax',
  );
  await page.getByRole('group', { name: 'Manager default', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('general-model-preferences.png') });
  await page.goto('/#/new');
  await expect(research).toHaveValue('codex:gpt-6-sol');
  await expect(manager.getByRole('combobox', { name: 'Provider', exact: true })).toHaveValue(
    'claude',
  );
  await page
    .getByRole('button', { name: 'Use my current worker preferences', exact: true })
    .click();
  await expect(page.getByRole('slider', { name: 'Usage', exact: true })).toHaveAttribute(
    'aria-valuetext',
    'Tokenmax',
  );
  await expect(page.locator('.config-task-summary')).toContainText(
    'Research & coding: gpt-6-astra',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
