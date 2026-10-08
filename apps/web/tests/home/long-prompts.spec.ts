import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  mirrorPage,
  promptTextLimit,
  schedulerSettingsSchema,
  type MirrorState,
} from '@dock/shared';

const longPrompt = `Start of scientific prompt\n${'café 🧪 漢字 and equations α → β\n'.repeat(2000)}End 🧬`;
const owned = new WeakMap<Page, { settings: unknown; runs: string[] }>();
test.beforeEach(async ({ page, baseURL }) => {
  const settings = schedulerSettingsSchema.parse(
    (await (await page.request.get('/api/scheduler')).json()).settings,
  );
  owned.set(page, { settings, runs: [] });
  expect(
    (
      await page.request.post('/api/scheduler/settings', {
        headers: { Origin: baseURL! },
        data: { key: randomUUID(), settings: { ...settings, paused: true } },
      })
    ).ok(),
  ).toBe(true);
});
test.afterEach(async ({ page, baseURL }) => {
  const fixture = owned.get(page)!;
  for (const runId of fixture.runs)
    expect(
      (
        await page.request.post('/api/pulsar/jobs', {
          headers: { Origin: baseURL! },
          data: { key: randomUUID(), runId, action: 'cancel' },
        })
      ).ok(),
    ).toBe(true);
  expect(
    (
      await page.request.post('/api/scheduler/settings', {
        headers: { Origin: baseURL! },
        data: { key: randomUUID(), settings: fixture.settings },
      })
    ).ok(),
  ).toBe(true);
});
async function manager(page: Page) {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  return snapshot.agents.find(
    (agent: { role: string; projectId: string }) =>
      agent.role === 'manager' &&
      snapshot.projects.some(
        (project: { id: string; internal?: boolean }) =>
          project.id === agent.projectId && !project.internal,
      ),
  ) as { id: string; name: string };
}
async function paste(page: Page, editor: Locator, text: string) {
  await expect(editor).not.toHaveAttribute('maxlength');
  await editor.fill('');
  await editor.focus();
  // Native text insertion exercises the browser's editing path, including maxlength.
  await page.keyboard.insertText(text);
  await expect(editor).toHaveValue(text);
}
async function downloaded(page: Page, button: Locator) {
  const event = page.waitForEvent('download');
  await button.click();
  return readFile((await (await event).path())!, 'utf8');
}

test('a 50k Unicode notepad prompt autosaves, reloads and delivers exactly once after a lost response', async ({
  page,
}) => {
  expect(longPrompt.length).toBeGreaterThan(50_000);
  const agent = await manager(page);
  let saved = '';
  await page.route(`**/api/workspace/*/drafts/${agent.id}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    if (response.ok()) saved = (await response.json()).state.own.text;
    await route.fulfill({ response });
  });
  const sends: { text: string; key: string }[] = [];
  await page.route(`**/api/agents/${agent.id}/messages`, async (route) => {
    sends.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    owned.get(page)!.runs.push((await response.json()).id);
    await route.abort('failed');
  });
  await page.goto(`/#/chat/${agent.id}`);
  await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
  const notepad = page.getByRole('dialog', { name: 'Write at length', exact: true });
  await paste(
    page,
    notepad.getByRole('textbox', { name: `Long message to ${agent.name}`, exact: true }),
    longPrompt,
  );
  await expect.poll(() => saved).toBe(longPrompt);
  await notepad.getByRole('button', { name: 'Minimize', exact: true }).click();
  await page.reload();
  const compact = page.getByRole('textbox', { name: `Message ${agent.name}`, exact: true });
  await expect(compact).toHaveValue(longPrompt);
  expect(sends).toHaveLength(0);
  await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
  await notepad.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  await expect(notepad.getByRole('textbox').first()).toHaveValue(longPrompt);
  await page.reload();
  await expect(compact).toHaveValue('');
  expect(sends).toHaveLength(1);
  expect(sends[0]!.text).toBe(longPrompt);
  const detail = await (await page.request.get(`/api/agents/${agent.id}`)).json();
  expect(detail.runs.find((run: { id: string }) => run.id === owned.get(page)!.runs[0]).text).toBe(
    longPrompt,
  );
});

test('a 50k Unicode shared-chat paste survives notepad and reload; delivery checking never resends it', async ({
  page,
}) => {
  const state: MirrorState = {
    windowId: randomUUID(),
    threadId: randomUUID(),
    provider: 'codex',
    label: 'Long prompt fixture',
    title: 'Shared long prompt',
    status: 'idle',
    message: '',
    paged: true,
    entries: [],
  };
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) => {
    const { entries: _, ...window } = state;
    return route.fulfill({ json: [window] });
  });
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: mirrorPage(state) }),
  );
  const sends: { text: string; key: string }[] = [];
  await page.route(`**/api/vscode/windows/${state.windowId}/send`, (route) => {
    sends.push(route.request().postDataJSON());
    return route.abort('failed');
  });
  let checks = 0;
  await page.route('**/api/vscode/deliveries/*', (route) => {
    checks++;
    expect(route.request().method()).toBe('GET');
    expect(route.request().url()).toContain(sends[0]!.key);
    return route.fulfill({ json: { state: 'sent', message: 'Delivered once.' } });
  });
  await page.goto(`/#/chats/vscode/${encodeURIComponent(`codex:${state.threadId}`)}`);
  const compact = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  await paste(page, compact, longPrompt);
  await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
  const notepad = page.getByRole('dialog', { name: 'Write at length', exact: true });
  await expect(
    notepad.getByRole('textbox', { name: 'Long message to Codex', exact: true }),
  ).toHaveValue(longPrompt);
  await notepad.getByRole('button', { name: 'Minimize', exact: true }).click();
  await page.reload();
  await expect(compact).toHaveValue(longPrompt);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeEnabled();
  await page.reload();
  await expect(compact).toHaveValue(longPrompt);
  await page.getByRole('button', { name: 'Check delivery', exact: true }).click();
  await expect(compact).toHaveValue('');
  expect(sends).toHaveLength(1);
  expect(sends[0]!.text).toBe(longPrompt);
  expect(checks).toBe(1);
});

test('a refused autosave releases a corrected short draft and over-limit pasted text remains downloadable after reload', async ({
  page,
}) => {
  const agent = await manager(page);
  let delivered = '';
  await page.route(`**/api/agents/${agent.id}/messages`, async (route) => {
    delivered = route.request().postDataJSON().text;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    owned.get(page)!.runs.push((await response.json()).id);
    await route.fulfill({ response });
  });
  const saves: { key: string; action: { kind: string; text: string } }[] = [];
  let saved = '';
  await page.route(`**/api/workspace/*/drafts/${agent.id}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const input = route.request().postDataJSON();
    saves.push(input);
    if (input.action.text === longPrompt)
      return route.fulfill({
        status: 400,
        json: { error: 'The request does not match the input contract.' },
      });
    const response = await route.fetch();
    if (response.ok()) saved = (await response.json()).state.own.text;
    return route.fulfill({ response });
  });
  await page.goto(`/#/chat/${agent.id}`);
  const compact = page.getByRole('textbox', { name: `Message ${agent.name}`, exact: true });
  await paste(page, compact, longPrompt);
  await expect(
    page.getByRole('alert').filter({ hasText: 'The request does not match the input contract.' }),
  ).toBeVisible();
  const short = 'Please continue with https://example.com/research 🧪';
  await compact.fill(short);
  await expect.poll(() => saved).toBe(short);
  expect(saves.filter((save) => save.action.text === longPrompt)).toHaveLength(1);
  expect(new Set(saves.map((save) => save.key)).size).toBe(saves.length);
  await page.reload();
  await expect(compact).toHaveValue(short);
  await page.getByText('Earlier draft refused by this computer', { exact: true }).click();
  expect(
    await downloaded(
      page,
      page.getByRole('button', { name: 'Download earlier draft', exact: true }),
    ),
  ).toBe(longPrompt);
  await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
  const notepad = page.getByRole('dialog', { name: 'Write at length', exact: true });
  const oversized = `${'x'.repeat(promptTextLimit)}🧪`;
  await paste(page, notepad.getByRole('textbox').first(), oversized);
  await expect(notepad.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(
    notepad.getByRole('alert').filter({ hasText: 'Message limit: 200,000 characters.' }).first(),
  ).toBeVisible();
  expect(
    await downloaded(page, notepad.getByRole('button', { name: 'Download', exact: true })),
  ).toBe(oversized);
  await notepad.getByRole('button', { name: 'Minimize', exact: true }).click();
  await page.reload();
  await expect(compact).toHaveValue(oversized);
  expect(saves.some((save) => save.action.text === oversized)).toBe(false);
  await compact.fill(short);
  await expect.poll(() => saved).toBe(short);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(compact).toHaveValue('');
  expect(delivered).toBe(short);
});
