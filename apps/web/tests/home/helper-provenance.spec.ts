import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mirrorPage } from '@dock/shared';

test('explicit helpers stay excluded while same-title personal, imported and shared chats retain their filters', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const owner = snapshot.agents.find((agent: { role: string }) => agent.role === 'manager');
  const name = 'Computer health';
  const personal = { ...owner, name };
  const imported = {
    ...owner,
    id: randomUUID(),
    role: 'researcher',
    name,
    surface: 'misc',
    modelSelection: 'native',
    parentId: owner.id,
  };
  const helper = { ...owner, id: randomUUID(), name, nativeRootId: owner.id, surface: 'misc' };
  const resource = {
    ...owner,
    id: randomUUID(),
    name,
    surface: 'misc',
    resourceAssistant: { mode: 'snapshot' },
  };
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshot,
        agents: [personal, imported, helper, resource],
      },
    }),
  );
  const shared = ['vscode', 'codex-daemon'].map((source) => ({
    windowId: randomUUID(),
    provider: 'codex',
    threadId: randomUUID(),
    source,
    label: source,
    title: name,
    status: 'idle',
    message: '',
  }));
  await page.route('**/api/vscode/windows', (route) => route.fulfill({ json: shared }));
  await page.goto('/#/chats');
  await page.getByRole('textbox', { name: 'Find a conversation' }).fill(name);
  await expect(page.locator('.flow-person')).toHaveCount(4);
  await page.getByRole('button', { name: 'Managers', exact: true }).click();
  await expect(page.locator('.flow-person')).toHaveCount(1);
  await expect(page.locator('.flow-person')).toHaveAttribute('href', `#/chat/${owner.id}`);
  await page.getByRole('button', { name: 'Shared', exact: true }).click();
  await expect(page.locator('.flow-person')).toHaveCount(2);
  await page.getByRole('button', { name: 'Misc', exact: true }).click();
  await expect(page.locator('.flow-person')).toHaveCount(1);
  await expect(page.locator('.flow-person')).toHaveAttribute('href', `#/chat/${imported.id}`);
  await page.reload();
  await expect(page.locator('.flow-person')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('shared read failures remain visible and recover without submitting the retained draft', async ({
  page,
}) => {
  const state = {
    windowId: randomUUID(),
    provider: 'codex' as const,
    threadId: randomUUID(),
    label: 'Isolated editor fixture',
    title: 'Retry fixture',
    status: 'idle' as const,
    message: '',
    entries: [{ id: 'reply', role: 'assistant' as const, text: 'Retained provider reply.' }],
  };
  let fail = false;
  let sends = 0;
  const { entries: _, ...window } = state;
  await page.route('**/api/vscode/windows', (route) => route.fulfill({ json: [window] }));
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill(
      fail ? { status: 503, json: { error: 'Bridge unavailable' } } : { json: mirrorPage(state) },
    ),
  );
  await page.route(`**/api/vscode/windows/${state.windowId}/send`, (route) => {
    sends++;
    return route.fulfill({ json: { state: 'not_sent', message: 'Fixture refuses delivery' } });
  });
  await page.goto(`/#/chats/vscode/${encodeURIComponent(`codex:${state.threadId}`)}`);
  await expect(page.getByText('Retained provider reply.', { exact: true })).toBeVisible();
  const draft = page.getByLabel('Message Codex');
  await draft.fill('Keep this unsent request.');
  fail = true;
  await expect(
    page.getByText('Connection interrupted. Your draft is safe; reconnecting automatically.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(draft).toHaveValue('Keep this unsent request.');
  fail = false;
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await expect(draft).toHaveValue('Keep this unsent request.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Fixture refuses delivery', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('Keep this unsent request.');
  expect(sends).toBe(1);
});
