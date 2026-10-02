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
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  snapshot.agents.find((agent: { id: string }) => agent.id === project.managerId).status =
    'running';
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route(`**/api/agents/${project.managerId}`, (route) =>
    route.fulfill({ json: detail }),
  );
  const sent: { text: string; steer: boolean; scheduling?: { priority: string } }[] = [];
  let rejectFinished = false;
  await page.route(`**/api/agents/${project.managerId}/messages`, (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill(
      rejectFinished
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
  const composer = page.locator('.composer');
  const input = composer.getByRole('textbox');
  const timing = composer.getByRole('combobox', { name: 'Send timing' });
  const priority = composer.getByRole('combobox', { name: 'Message priority' });
  await expect(timing).toHaveValue('steer');
  await expect(priority).toHaveCount(0);
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
      composer.getByRole('button', { name: 'Send message', exact: true }),
    ]) {
      await expect(control).toBeInViewport();
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    }
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
});
