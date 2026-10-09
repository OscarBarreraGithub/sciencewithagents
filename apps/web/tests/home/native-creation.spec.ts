import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Real typed creation API; demo provider, no native/model launches.
test('New defaults personal chats to direct, retains an exact lost reply and draft, and keeps managed controls optional', async ({
  page,
}, info) => {
  const inputs: Record<string, unknown>[] = [];
  let agentId: string | undefined;
  await page.route('**/api/conversations', async (route) => {
    inputs.push(route.request().postDataJSON());
    const response = await route.fetch();
    agentId = (await response.json()).id;
    if (inputs.length === 1) return route.abort('failed');
    return route.fulfill({ response });
  });
  try {
    await page.goto('/#/chats');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('button', { name: /^Chat/ }).click();
    await page.getByRole('link', { name: /Start chat \+ save contact/ }).click();
    const mode = page.getByRole('combobox', { name: 'Run with', exact: true });
    await expect(mode).toHaveValue('direct');
    await mode.selectOption('managed');
    await expect(page.getByText(/Add the app’s manager/)).toBeVisible();
    await mode.selectOption('direct');
    const name = `Native chat ${info.project.name} ${randomUUID().slice(0, 8)}`;
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('codex');
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('connection was interrupted');
    await page.reload();
    await expect(mode).toHaveValue('direct');
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(name);
    expect(inputs).toHaveLength(1);
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    await expect(page).toHaveURL(/#\/chat\/[^/]+$/);
    expect(inputs[0]).toEqual(inputs[1]);
    expect(inputs[0]).toMatchObject({ executionMode: 'direct', provider: 'codex', name });
    const detail = await (await page.request.get(`/api/agents/${agentId}`)).json();
    expect(detail.agent.executionMode).toBe('direct');
    expect(detail.runs).toEqual([]);
    await expect(page.getByRole('button', { name: 'Subagents', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Goal', exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Message priority' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show commands', exact: true }).click();
    const commands = page.getByRole('dialog', { name: 'Session commands' });
    await expect(commands.getByRole('button', { name: /\/goal/ })).toHaveCount(0);
    await expect(commands.getByRole('button', { name: /Stop reply/ })).toBeVisible();
    await commands.getByRole('button', { name: 'Close dialog' }).click();
    const draft = page.getByRole('textbox', { name: /^Message / });
    await draft.fill(`Unsent direct draft ${info.project.name}`);
    const chatBack = page.getByRole('link', { name: 'All chats', exact: true });
    if (await chatBack.isVisible()) await chatBack.click();
    else {
      await page.getByRole('link', { name: 'Back', exact: true }).click();
      await page.getByRole('link', { name: 'Chats', exact: true }).click();
    }
    await page.getByRole('link', { name: new RegExp(name) }).click();
    await expect(draft).toHaveValue(`Unsent direct draft ${info.project.name}`);
    await page.reload();
    await expect(draft).toHaveValue(`Unsent direct draft ${info.project.name}`);
    await page.getByRole('button', { name: 'Native helpers', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Native helpers' })).toContainText(
      'this view does not delegate new work',
    );
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await page.getByRole('button', { name: 'Configure', exact: true }).click();
    const settings = page.getByRole('complementary', { name: 'Configuration' });
    await expect(settings.getByRole('combobox', { name: 'Tools and connections' })).toHaveCount(0);
    await expect(settings).toContainText('native setup is fixed');
    await expect(settings.getByRole('link', { name: /QUARK/ })).toHaveCount(0);
    await expect(settings.getByRole('combobox', { name: 'Native permissions' })).toBeVisible();
    const readable = await settings.locator('select').evaluateAll((elements) =>
      elements.map((element) => ({
        font: parseFloat(getComputedStyle(element).fontSize),
        height: element.getBoundingClientRect().height,
      })),
    );
    for (const control of readable) {
      expect(control.font).toBeGreaterThanOrEqual(16);
      expect(control.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({
      path: `../../data/native-ui/${info.project.name}-direct-controls.png`,
    });
    expect((await (await page.request.get(`/api/agents/${agentId}`)).json()).runs).toEqual([]);
  } finally {
    if (agentId)
      await page.request.post(`/api/agents/${agentId}/remove`, {
        headers: { origin: new URL(info.project.use.baseURL as string).origin },
        data: { key: randomUUID() },
      });
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('an older browser conversation draft preserves its missing mode and exact key through explicit retry', async ({
  page,
}) => {
  const key = randomUUID();
  await page.addInitScript((key) => {
    if (!localStorage.getItem('dock:local:conversation-start:misc'))
      localStorage.setItem(
        'dock:local:conversation-start:misc',
        JSON.stringify({
          key,
          name: 'Retained older chat',
          provider: 'codex',
          model: null,
          effort: null,
        }),
      );
  }, key);
  const inputs: Record<string, unknown>[] = [];
  let agentId: string | undefined;
  await page.route('**/api/conversations', async (route) => {
    const input = route.request().postDataJSON();
    inputs.push(input);
    if (inputs.length === 1) return route.abort('failed');
    const response = await route.fetch();
    agentId = (await response.json()).id;
    return route.fulfill({ response });
  });
  await page.goto('/#/new/chat');
  await expect(page.getByRole('combobox', { name: 'Run with' })).toHaveValue('retained');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('connection was interrupted');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Run with' })).toHaveValue('retained');
  expect(inputs).toHaveLength(1);
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/#\/chat\//);
  expect(inputs[0]).toEqual(inputs[1]);
  expect(inputs[0]!.key).toBe(key);
  expect(inputs[0]).not.toHaveProperty('executionMode');
  if (agentId)
    await page.request.post(`/api/agents/${agentId}/remove`, {
      headers: { origin: new URL(page.url()).origin },
      data: { key: randomUUID() },
    });
  await page.unrouteAll({ behavior: 'wait' });
});
