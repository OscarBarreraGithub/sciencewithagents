import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { Agent } from '@dock/shared';

const owned = new WeakMap<Page, string[]>();
test.afterEach(async ({ page, baseURL }) => {
  await page.unrouteAll({ behavior: 'wait' });
  for (const agentId of owned.get(page) ?? []) {
    const removed = await page.request.post(`/api/agents/${agentId}/remove`, {
      headers: { Origin: baseURL! },
      data: { key: randomUUID() },
    });
    expect(removed.ok()).toBe(true);
  }
});

/** A demo manager presented as a native Claude session; models and saves are typed fixtures. */
async function claudeManager(page: Page, origin: string) {
  const response = await page.request.post('/api/projects', {
    headers: { Origin: origin },
    data: { key: randomUUID(), name: `Configure ${randomUUID().slice(0, 8)}`, provider: 'codex' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const project = await response.json();
  owned.set(page, [project.managerId]);
  const override: Partial<Agent> = {
    provider: 'claude',
    toolPolicy: 'native',
    nativeChrome: 'inherit',
    model: 'claude-fixture',
    modelSelection: 'exact',
    effort: 'medium',
    permission: 'workspace-write',
  };
  await page.route('**/api/snapshot', async (route) => {
    const value = await (await route.fetch()).json();
    value.agents = value.agents.map((item: Agent) =>
      item.id === project.managerId ? { ...item, ...override } : item,
    );
    await route.fulfill({ json: value });
  });
  await page.route(new RegExp(`/api/agents/${project.managerId}(?:\\?.*)?$`), async (route) => {
    const value = await (await route.fetch()).json();
    value.agent = { ...value.agent, ...override };
    await route.fulfill({ json: value });
  });
  await page.route('**/api/models?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('provider') !== 'claude') return route.fallback();
    await route.fulfill({
      json: [
        {
          id: 'claude-fixture',
          label: 'Claude fixture with a deliberately long display name',
          isDefault: true,
          efforts: ['low', 'medium', 'high'],
        },
        {
          id: 'claude-second-fixture',
          label: 'Second Claude fixture',
          isDefault: false,
          efforts: ['medium', 'high'],
        },
      ],
    });
  });
  return { ...project, override } as {
    id: string;
    managerId: string;
    name: string;
    override: Partial<Agent>;
  };
}

/** Measure the form inside the panel it actually occupies, not the viewport. */
async function fieldLayout(card: Locator) {
  return card.evaluate((node) => {
    const issues: string[] = [];
    const host = node.closest('.chat-side-body')!.getBoundingClientRect();
    const fields = [...node.querySelectorAll<HTMLElement>('.session-field')];
    const boxes = fields.map((field) => field.getBoundingClientRect());
    fields.forEach((field, index) => {
      const label = field.querySelector('label')!;
      const control = field.querySelector('select')!.getBoundingClientRect();
      const name = label.firstChild!.textContent!.trim();
      const range = document.createRange();
      range.selectNodeContents(label.firstChild!);
      const text = range.getBoundingClientRect();
      if (control.left < host.left - 0.5 || control.right > host.right + 0.5)
        issues.push(`${name}: field reaches outside the panel`);
      if (control.height < 44) issues.push(`${name}: ${control.height}px target`);
      if (control.width < Math.min(200, host.width - 64))
        issues.push(`${name}: squeezed to ${Math.round(control.width)}px`);
      if (!text.width || text.left < host.left - 0.5 || text.right > host.right + 0.5)
        issues.push(`${name}: label hidden or clipped`);
      if (text.bottom > control.top + 0.5) issues.push(`${name}: label overlaps its field`);
      boxes.forEach((other, later) => {
        const box = boxes[index];
        if (
          later > index &&
          box.right > other.left + 0.5 &&
          other.right > box.left + 0.5 &&
          box.bottom > other.top + 0.5 &&
          other.bottom > box.top + 0.5
        )
          issues.push(`${name}: overlaps another field`);
      });
    });
    if (node.scrollWidth > node.clientWidth + 1) issues.push('settings scroll sideways');
    return {
      issues,
      fields: fields.length,
      columns: new Set(boxes.map((box) => Math.round(box.left))).size,
      panel: Math.round(host.width),
    };
  });
}

test('Configure keeps every native session setting readable at the panel width, then saves with retry', async ({
  page,
  baseURL,
}, info) => {
  const manager = await claudeManager(page, baseURL!);
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && !path.startsWith('/api/workspace/')) writes.push(path);
  });
  await page.goto(`/#/chat/${manager.managerId}`);
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Configuration', exact: true });
  const card = panel.locator('.settings-card').first();
  const fields = {
    'Tools and connections': 'native',
    'Chrome browser': 'inherit',
    Model: 'claude-fixture',
    Reasoning: 'medium',
    Permissions: 'workspace-write',
  };
  for (const [name, value] of Object.entries(fields))
    await expect(card.getByRole('combobox', { name, exact: true })).toHaveValue(value);
  await expect(card.getByRole('button', { name: 'Save settings', exact: true })).toBeEnabled();
  // Session controls come first; adapter, routing and delegation boilerplate is gone.
  const usageHeading = panel.getByRole('heading', { name: 'Usage and resources', exact: true });
  expect((await card.boundingBox())!.y).toBeLessThan((await usageHeading.boundingBox())!.y);
  for (const text of [
    'Automatic routing',
    'Provider availability',
    'Available provider features',
    'No original delegation choice',
    'The defaults are ready to use',
    'Model chooses the AI',
  ])
    await expect(panel).not.toContainText(text);
  await expect(panel.getByRole('region', { name: 'Provider and usage' })).toHaveCount(0);

  const sizes = [page.viewportSize()!];
  // Desktop also checks the CSS viewport that 200% browser zoom gives a 1440×900 window.
  if (info.project.name === 'desktop') sizes.push({ width: 720, height: 450 });
  await mkdir('../../data/screenshots/configure', { recursive: true });
  for (const size of sizes) {
    await page.setViewportSize(size);
    const layout = await fieldLayout(card);
    expect(layout.issues, `${size.width}×${size.height}, panel ${layout.panel}px`).toEqual([]);
    expect(layout.fields).toBe(5);
    if (layout.panel < 480) expect(layout.columns).toBe(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `../../data/screenshots/configure/${info.project.name}-${size.width}x${size.height}.png`,
    });
  }

  // Optional usage details are read-only, mounted on request and never invent zero usage.
  await panel.getByText('Reported usage and assignment', { exact: true }).click();
  const usage = panel.getByRole('region', { name: 'Provider and usage', exact: true });
  await expect(usage.getByText('Current model', { exact: true }).locator('..')).toContainText(
    'claude-fixture',
  );
  await expect(usage).toContainText('This does not mean zero usage.');
  await expect(usage.getByText(/\b0 tokens reported/)).toHaveCount(0);
  await expect(usage).not.toContainText('Automatic routing');
  expect(writes).toEqual([]);

  const saves: unknown[] = [];
  await page.route(`**/api/agents/${manager.managerId}/settings`, async (route) => {
    saves.push(route.request().postDataJSON());
    if (saves.length === 1)
      return route.fulfill({ status: 503, json: { error: 'Settings response was lost.' } });
    return route.fulfill({ json: {} });
  });
  await card.getByRole('combobox', { name: 'Chrome browser', exact: true }).selectOption('enabled');
  await card.getByRole('combobox', { name: 'Reasoning', exact: true }).selectOption('high');
  const save = card.getByRole('button', { name: 'Save settings', exact: true });
  await save.click();
  await expect(card.getByRole('alert')).toContainText('Settings response was lost.');
  await expect(card.getByRole('combobox', { name: 'Chrome browser', exact: true })).toHaveValue(
    'enabled',
  );
  await expect(card.getByRole('combobox', { name: 'Reasoning', exact: true })).toHaveValue('high');
  await save.click();
  await expect(card.getByRole('status')).toHaveText('Settings saved.');
  await expect(card.getByRole('alert')).toHaveCount(0);
  expect(saves).toEqual([
    {
      model: 'claude-fixture',
      effort: 'high',
      permission: 'workspace-write',
      toolPolicy: 'native',
      nativeChrome: 'enabled',
    },
    {
      model: 'claude-fixture',
      effort: 'high',
      permission: 'workspace-write',
      toolPolicy: 'native',
      nativeChrome: 'enabled',
    },
  ]);
  expect(writes.filter((path) => /\/(messages|commands)$/.test(path))).toEqual([]);
  const detail = await (await page.request.get(`/api/agents/${manager.managerId}`)).json();
  expect(detail.runs).toEqual([]);
});

test('supported model, reasoning and native controls save and reopen without changing conversation history', async ({
  page,
  baseURL,
}) => {
  const manager = await claudeManager(page, baseURL!);
  const original = await (await page.request.get(`/api/agents/${manager.managerId}`)).json();
  await page.route(`**/api/agents/${manager.managerId}/settings`, async (route) => {
    Object.assign(manager.override, route.request().postDataJSON(), {
      updatedAt: new Date().toISOString(),
    });
    await route.fulfill({ json: {} });
  });
  await page.goto(`/#/chat/${manager.managerId}`);
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Configuration', exact: true });
  const card = panel.locator('.settings-card').first();
  await expect(
    card.getByRole('combobox', { name: 'Tools and connections', exact: true }),
  ).toHaveValue('native');
  await expect(card.getByRole('combobox', { name: 'Permissions', exact: true })).toHaveValue(
    'workspace-write',
  );
  await card
    .getByRole('combobox', { name: 'Model', exact: true })
    .selectOption('claude-second-fixture');
  await card.getByRole('combobox', { name: 'Reasoning', exact: true }).selectOption('high');
  await card.getByRole('combobox', { name: 'Chrome browser', exact: true }).selectOption('enabled');
  await card.getByRole('combobox', { name: 'Permissions', exact: true }).selectOption('read-only');
  await card.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(card.getByRole('status')).toHaveText('Settings saved.');
  await page.reload();
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  for (const [label, value] of Object.entries({
    Model: 'claude-second-fixture',
    Reasoning: 'high',
    'Chrome browser': 'enabled',
    Permissions: 'read-only',
    'Tools and connections': 'native',
  }))
    await expect(card.getByRole('combobox', { name: label, exact: true })).toHaveValue(value);
  const after = await (await page.request.get(`/api/agents/${manager.managerId}`)).json();
  expect(after.entries).toEqual(original.entries);
  expect(after.runs).toEqual([]);
});
