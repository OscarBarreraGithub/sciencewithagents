import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mirrorPage, type MirrorState } from '@dock/shared';
import { mkdir } from 'node:fs/promises';

async function fullscreen(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  const size = await page.evaluate(() => ({ width: innerWidth, height: visualViewport!.height }));
  expect(box!.width).toBe(size.width);
  expect(box!.height).toBeGreaterThanOrEqual(size.height - 2);
  await expect(dialog.locator('.composer textarea')).toBeInViewport();
  expect(
    await dialog
      .locator('.assistant-fullscreen-bar > strong')
      .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
  ).toBe(true);
  return dialog;
}

test('QUARK opens the normal full-screen chat, retains its model controls and returns without sending', async ({
  page,
}, info) => {
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  const created = await page.request.post('/api/projects', {
    headers: { origin },
    data: {
      key: randomUUID(),
      name: `QUARK viewport ${randomUUID().slice(0, 8)}`,
      provider: 'codex',
    },
  });
  expect(created.ok()).toBe(true);
  const project = await created.json();
  await page.route(`**/api/agents/${project.managerId}`, async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    detail.entries = [
      {
        id: randomUUID(),
        agentId: project.managerId,
        runId: null,
        kind: 'assistant',
        title: 'QUARK',
        status: 'completed',
        createdAt: new Date().toISOString(),
        text: 'A detailed scheduling explanation should use the available conversation width. '.repeat(
          24,
        ),
      },
    ];
    await route.fulfill({ json: detail });
  });
  await page.route('**/api/quark/coordinator', async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ json: { ...status, agentId: project.managerId, projectId: project.id } });
  });
  await page.route('**/api/models?*', (route) =>
    route.fulfill({
      json: [{ id: 'fixture-opus', label: 'Opus example', isDefault: true, efforts: ['high'] }],
    }),
  );
  const sends: unknown[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith(`/agents/${project.managerId}/messages`)
    )
      sends.push(request.postDataJSON());
  });
  await page.goto('/#/work');
  await page.getByRole('button', { name: 'Open QUARK conversation', exact: true }).click();
  const chat = await fullscreen(page, 'QUARK conversation');
  const timeline = chat.locator('.conversation-inner');
  await expect(timeline.locator('.message-body')).toBeVisible();
  expect((await timeline.boundingBox())!.width).toBeGreaterThan(
    (await chat.boundingBox())!.width - 60,
  );
  expect((await timeline.locator('.message-body').boundingBox())!.width).toBeGreaterThan(
    (await timeline.boundingBox())!.width * 0.7,
  );
  await chat.getByRole('button', { name: 'Model & settings', exact: true }).click();
  await expect(chat.getByRole('combobox', { name: 'Provider', exact: true })).toBeVisible();
  await chat.getByRole('button', { name: 'Model & settings', exact: true }).click();
  await chat.getByRole('textbox', { name: /Message/ }).fill('Keep this scheduling request unsent.');
  await chat.getByRole('button', { name: 'Open notepad' }).click();
  const notepad = page.getByRole('dialog', { name: 'Write at length' });
  await expect(notepad.getByRole('textbox')).toHaveValue('Keep this scheduling request unsent.');
  const paper = (await notepad.locator('.notepad-paper').boundingBox())!;
  const editor = (await notepad.getByRole('textbox').boundingBox())!;
  expect(paper.width).toBeGreaterThan(page.viewportSize()!.width - 60);
  const padBounds = (await notepad.boundingBox())!;
  expect(editor.height).toBeGreaterThan(padBounds.height * 0.8);
  expect(editor.height).toBeGreaterThan(paper.height - 2);
  expect(editor.y + editor.height).toBeGreaterThan(padBounds.y + padBounds.height - 2);
  const writing = notepad.getByRole('textbox');
  await writing.fill('A long document scrolls across the entire writing surface.\n'.repeat(90));
  await writing.evaluate((element) => {
    element.scrollTop = 0;
  });
  // The lower part of the page is editable text, not an inert card or a separate page scroller.
  const lowerPage = { x: editor.x + editor.width / 2, y: editor.y + editor.height - 25 };
  expect(
    await writing.evaluate(
      (element, point) => document.elementFromPoint(point.x, point.y) === element,
      lowerPage,
    ),
  ).toBe(true);
  if (info.project.use.browserName === 'webkit') {
    // Mobile WebKit exposes no wheel input; moving the end caret checks native text scrolling.
    await writing.press('ArrowUp');
  } else {
    await page.mouse.move(lowerPage.x, lowerPage.y);
    await page.mouse.wheel(0, 360);
  }
  await expect.poll(() => writing.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  expect(await notepad.evaluate((element) => element.scrollTop)).toBe(0);
  await writing.fill('Keep this scheduling request unsent.');
  await page.screenshot({ path: info.outputPath('full-writing-area.png'), scale: 'css' });
  await notepad.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expect(chat.getByRole('textbox', { name: /Message/ })).toHaveValue(
    'Keep this scheduling request unsent.',
  );
  await mkdir('../../data/screenshots/assistant-chats', { recursive: true });
  await page.screenshot({
    path: `../../data/screenshots/assistant-chats/${info.project.name}-quark.png`,
  });
  await chat.getByRole('button', { name: 'Back to QUARK', exact: true }).click();
  await expect(chat).toHaveCount(0);
  expect(sends).toEqual([]);
  await page.getByRole('button', { name: 'Open QUARK conversation', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /Message/ })).toHaveValue(
    'Keep this scheduling request unsent.',
  );
  const multiline = 'A retained line in the scheduling request.\n'.repeat(20);
  const composer = chat.locator('.composer > textarea');
  await composer.fill(multiline);
  await expect(chat.locator('.composer')).toHaveClass(/draft-steady/);
  await chat.getByRole('button', { name: 'Back to QUARK', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Open QUARK conversation', exact: true }).click();
  await expect(composer).toHaveValue(multiline);
  await expect.poll(async () => (await composer.boundingBox())!.height).toBeGreaterThan(70);
  expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(221);
  const conversation = chat.locator('.conversation');
  expect((await conversation.boundingBox())!.height).toBeGreaterThan(
    (await chat.boundingBox())!.height * 0.45,
  );
  expect(sends).toEqual([]);
});

for (const source of ['editor', 'codex-daemon'] as const) {
  test(`${source} notepad retains meaningful local revisions across a closed tab without replacing another tab draft`, async ({
    page,
    context,
  }, info) => {
    const state: MirrorState = {
      windowId: randomUUID(),
      provider: 'codex',
      threadId: randomUUID(),
      ...(source === 'codex-daemon' ? { source } : {}),
      label: 'Shared test',
      title: 'Saved local writing',
      status: 'idle',
      message: '',
      paged: true,
      entries: [{ id: 'saved', role: 'assistant', text: 'Your ongoing work remains available.' }],
    };
    const { entries: _, ...window } = state;
    await context.route('**/api/vscode/windows', (route) => route.fulfill({ json: [window] }));
    await context.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
      route.fulfill({ json: mirrorPage(state) }),
    );
    const sends: unknown[] = [];
    await context.route(`**/api/vscode/windows/${state.windowId}/send`, async (route) => {
      sends.push(route.request().postDataJSON());
      await route.fulfill({ json: { state: 'sent', message: 'Sent.' } });
    });
    const url = `/#/chats/vscode/${encodeURIComponent(`codex:${state.threadId}`)}`;
    await page.goto(url);
    await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
    const notepad = page.getByRole('dialog', { name: 'Write at length' });
    const editor = notepad.getByRole('textbox', { name: 'Long message to Codex' });
    const original = 'First meaningful draft that must survive a long paragraph.';
    await editor.fill(original);
    await notepad.getByRole('button', { name: 'Minimize', exact: true }).click();
    await expect(page.getByLabel('Message Codex')).toHaveValue(original);
    await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
    const later = 'Later unsent paragraph. '.repeat(25);
    await editor.fill(later);
    await notepad.getByRole('button', { name: 'Minimize', exact: true }).click();
    await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
    await notepad.getByRole('button', { name: 'Versions', exact: true }).click();
    await expect(
      notepad
        .getByRole('complementary', { name: 'Saved versions' })
        .getByText(original, { exact: true }),
    ).toBeVisible();
    await mkdir('../../data/screenshots/assistant-chats', { recursive: true });
    await page.screenshot({
      path: `../../data/screenshots/assistant-chats/${info.project.name}-${source}-notepad.png`,
    });
    const separate = await context.newPage();
    await separate.goto(url);
    await separate
      .getByLabel('Message Codex')
      .fill('Another tab keeps its independent primary draft.');
    // Only this disposable page closes; the second tab retains its primary text.
    await page.close();
    const reopened = await context.newPage();
    try {
      await reopened.goto(url);
      await expect(reopened.getByLabel('Message Codex')).toHaveValue('');
      await reopened.getByRole('button', { name: 'Open notepad', exact: true }).click();
      const pad = reopened.getByRole('dialog', { name: 'Write at length' });
      await pad.getByRole('button', { name: 'Versions', exact: true }).click();
      const versions = pad.getByRole('complementary', { name: 'Saved versions' });
      await versions
        .getByRole('button')
        .filter({ hasText: 'Later unsent paragraph.' })
        .first()
        .click();
      await expect(pad.getByRole('textbox')).toHaveValue(later);
      await expect(separate.getByLabel('Message Codex')).toHaveValue(
        'Another tab keeps its independent primary draft.',
      );
      expect(sends).toEqual([]);
    } finally {
      await reopened.close();
      await separate.close();
    }
  });
}
