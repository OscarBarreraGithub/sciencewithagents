import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Only the running turn/transport are simulated. Draft autosave uses the real demo backend.
test('running composer preserves steering, queuing and notepad choices without cramped controls', async ({
  page,
  baseURL,
}, info) => {
  const response = await page.request.post('/api/projects', {
    headers: { Origin: baseURL! },
    data: { key: randomUUID(), name: `Composer ${randomUUID().slice(0, 8)}`, provider: 'codex' },
  });
  expect(response.ok()).toBe(true);
  const project = await response.json();
  const detail = await (await page.request.get(`/api/agents/${project.managerId}`)).json();
  detail.agent.status = 'running';
  detail.entries = [
    { kind: 'system', title: 'Workspace restored', text: 'The conversation is ready.' },
    { kind: 'user', title: 'You', text: 'Check the project layout.' },
    { kind: 'assistant', title: 'Assistant', text: 'I am checking the layout now.' },
    { kind: 'system', title: 'Owner steering', text: 'Please check the phone layout first.' },
  ].map((entry) => ({
    ...entry,
    id: randomUUID(),
    agentId: project.managerId,
    runId: null,
    status: 'completed',
    createdAt: new Date().toISOString(),
  }));
  detail.runs = Array.from({ length: 12 }, (_, i) => ({
    id: randomUUID(),
    agentId: project.managerId,
    sourceId: null,
    text: `Queued follow-up ${i + 1}: ${'long-word'.repeat(40)}`,
    kind: 'user',
    status: 'queued',
    createdAt: new Date().toISOString(),
  }));
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  snapshot.agents.find((agent: { id: string }) => agent.id === project.managerId).status =
    'running';
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route(`**/api/agents/${project.managerId}`, (route) =>
    route.fulfill({ json: detail }),
  );
  const sent: { key: string; text: string; steer: boolean; scheduling?: { priority: string } }[] =
    [];
  let rejectFinished = false;
  let rejectUnknown = false;
  let delayNext = false;
  let finish!: () => void;
  await page.route(`**/api/agents/${project.managerId}/messages`, async (route) => {
    sent.push(route.request().postDataJSON());
    if (delayNext)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return route.fulfill(
      rejectUnknown
        ? { status: 503, json: { error: 'Delivery acknowledgement unavailable.' } }
        : rejectFinished
          ? { status: 409, json: { code: 'NO_ACTIVE_TURN', error: 'The reply finished.' } }
          : { json: { status: 'submitted' } },
    );
  });
  await page.goto(`/#/chat/${project.managerId}`);
  const steering = page
    .locator('.message.user')
    .filter({ hasText: 'Please check the phone layout first.' });
  await expect(steering).toBeVisible();
  await expect(steering.locator('.message-heading strong')).toHaveText('You');
  await expect(page.getByText('Owner steering', { exact: true })).toHaveCount(0);
  await expect(page.locator('.system-entry')).toHaveCount(1);
  await expect(page.locator('.system-entry')).toContainText('Workspace restored');
  // Closed, the queue is one summary row; its list opens in the full-height dialog on demand.
  const summary = page.getByRole('button', { name: /^12 queued messages/ });
  await expect(summary).toBeVisible();
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  const summaryBox = (await summary.boundingBox())!;
  expect(summaryBox.height).toBeGreaterThanOrEqual(43);
  expect(summaryBox.height).toBeLessThanOrEqual(56);
  expect(summaryBox.x + summaryBox.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await summary.click();
  const queueDialog = page.getByRole('dialog', { name: 'Queued messages', exact: true });
  const queue = queueDialog.getByRole('list', { name: 'Queued messages' });
  await expect(queue.getByRole('listitem')).toHaveCount(12);
  const firstItem = queue.getByRole('listitem').first();
  const preview = firstItem.locator('p').first();
  expect(
    await preview.evaluate(
      (element) => element.clientHeight <= parseFloat(getComputedStyle(element).lineHeight) * 3 + 1,
    ),
  ).toBe(true);
  await firstItem.getByRole('button', { name: 'Read full text', exact: true }).click();
  expect(
    await preview.evaluate(
      (element) => element.clientHeight > parseFloat(getComputedStyle(element).lineHeight) * 3,
    ),
  ).toBe(true);
  await firstItem.getByRole('button', { name: 'Collapse text', exact: true }).click();
  expect(await queue.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await queue.focus();
  await page.keyboard.press('End');
  await expect.poll(() => queue.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(queue.getByText(/Queued follow-up 12:/)).toBeInViewport();
  await queueDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(queueDialog).toHaveCount(0);
  const composer = page.locator('.composer');
  const input = composer.getByRole('textbox');
  const timing = composer.getByRole('combobox', { name: 'Send timing' });
  const priority = composer.getByRole('combobox', { name: 'Message priority' });
  await expect(timing).toHaveValue('steer');
  await expect(priority).toHaveCount(0);
  // Attachment limits are described, not permanent toolbar copy.
  const attach = composer.getByRole('button', { name: 'Attach files', exact: true });
  await expect(attach).toHaveAccessibleDescription('Up to four files per message, 8 MB each.');
  await expect(composer.getByText(/8 MB each/)).toBeHidden();
  await expect(composer.locator('input[type=checkbox]')).toHaveCount(0);
  await input.fill('Focus on the smallest fix first.');
  await composer.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue('');
  expect(sent[0]).toMatchObject({ text: 'Focus on the smallest fix first.', steer: true });
  expect(sent[0].scheduling).toBeUndefined();

  await timing.selectOption('queue');
  await priority.selectOption('background');
  await input.fill('Run the follow-up check afterward.');
  await composer.getByRole('button', { name: 'Open notepad' }).click();
  const notepad = page.getByRole('dialog', { name: 'Write at length', exact: true });
  await notepad.getByRole('button', { name: 'Notepad options' }).click();
  const padTiming = notepad.getByRole('combobox', { name: 'Send timing' });
  await expect(padTiming).toHaveValue('queue');
  await padTiming.selectOption('steer');
  await expect(notepad.getByRole('combobox', { name: 'Priority for this message' })).toHaveCount(0);
  await padTiming.selectOption('queue');
  await notepad.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expect(timing).toHaveValue('queue');
  await expect(priority).toHaveValue('background');
  await composer.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue('');
  expect(sent[1]).toMatchObject({ steer: false, scheduling: { priority: 'background' } });

  for (const mode of ['steer', 'queue']) {
    await timing.selectOption(mode);
    await expect(composer).toHaveClass(/draft-steady/);
    for (const control of [
      timing,
      composer.getByRole('button', { name: 'Open notepad' }),
      attach,
      composer.getByRole('button', { name: 'Send message', exact: true }),
    ]) {
      await expect(control).toBeInViewport();
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    }
    // Timing is a small tool beside Notepad, not a separate full-width row.
    const timingBox = (await timing.boundingBox())!;
    const notepadBox = (await composer
      .getByRole('button', { name: 'Open notepad' })
      .boundingBox())!;
    expect(Math.abs(timingBox.y - notepadBox.y)).toBeLessThanOrEqual(2);
    expect(timingBox.width).toBeLessThan(page.viewportSize()!.width / 2);
    // Native selects need room for both text and arrow; scrollWidth alone misses clipping.
    for (const select of await composer.locator('select').all()) {
      expect(
        await select.evaluate((element: HTMLSelectElement) => {
          const style = getComputedStyle(element);
          const canvas = document.createElement('canvas').getContext('2d')!;
          canvas.font = style.font;
          const textWidth = canvas.measureText(element.selectedOptions[0].text).width;
          return (
            element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) >=
            textWidth
          );
        }),
      ).toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`composer-${mode}.png`), scale: 'css' });
  }

  // A turn finishing before steering is accepted must retain the text for an explicit follow-up.
  await timing.selectOption('steer');
  await input.fill('Keep this when the running reply ends.');
  rejectFinished = true;
  await composer.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(timing).toHaveValue('queue');
  await expect(input).toHaveValue('Keep this when the running reply ends.');
  rejectFinished = false;
  await composer.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue('');
  expect(sent.at(-1)).toMatchObject({
    text: 'Keep this when the running reply ends.',
    steer: false,
  });
  // Writing the next draft must remain possible while the transport is waiting.
  delayNext = true;
  await input.fill('A slow accepted message.');
  await composer.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => typeof finish).toBe('function');
  await expect(input).toBeEnabled();
  await input.fill('The next unsent managed draft.');
  finish();
  await expect(composer.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('The next unsent managed draft.');
  expect(sent.at(-1)?.text).toBe('A slow accepted message.');
  const sendsBeforeReplacement = sent.length;
  await input.fill('An identical replacement draft.');
  await composer.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => sent.length).toBe(sendsBeforeReplacement + 1);
  await input.fill('Changed during delivery.');
  await input.fill('An identical replacement draft.');
  finish();
  await expect(composer.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('An identical replacement draft.');

  delayNext = false;
  rejectUnknown = true;
  await input.fill('Original message with a lost acknowledgement.');
  await composer.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    composer.getByRole('button', { name: 'Retry previous message', exact: true }),
  ).toBeEnabled();
  await input.fill('A newer draft kept while retrying.');
  rejectUnknown = false;
  await composer.getByRole('button', { name: 'Retry previous message', exact: true }).click();
  await expect(composer.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('A newer draft kept while retrying.');
  expect(sent.at(-1)?.key).toBe(sent.at(-2)?.key);
  expect(sent.at(-1)?.text).toBe('Original message with a lost acknowledgement.');
});
