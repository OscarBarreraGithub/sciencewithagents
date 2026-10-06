import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { schedulerSettingsSchema } from '@dock/shared';

// Synthetic geometry exercises the visualViewport contract, not a physical keyboard.
async function keyboardFixture(page: Page) {
  await page.addInitScript(() => {
    const viewport = window.visualViewport!;
    const prototype = Object.getPrototypeOf(viewport);
    const nativeHeight = Object.getOwnPropertyDescriptor(prototype, 'height')!.get!.bind(viewport);
    const nativeTop = Object.getOwnPropertyDescriptor(prototype, 'offsetTop')!.get!.bind(viewport);
    let height: number | undefined;
    let top: number | undefined;
    Object.defineProperties(viewport, {
      height: { configurable: true, get: () => height ?? nativeHeight() },
      offsetTop: { configurable: true, get: () => top ?? nativeTop() },
      pageTop: { configurable: true, get: () => (top ?? nativeTop()) + scrollY },
    });
    Object.assign(window, {
      __queueViewport: (nextHeight: number, nextTop: number) => {
        height = nextHeight;
        top = nextTop;
        viewport.dispatchEvent(new Event('resize'));
        viewport.dispatchEvent(new Event('scroll'));
      },
    });
  });
}

async function setViewport(page: Page, height: number, top: number) {
  await page.evaluate(
    ({ height, top }) =>
      (
        window as unknown as { __queueViewport: (height: number, top: number) => void }
      ).__queueViewport(height, top),
    { height, top },
  );
}

async function insideVisibleArea(locator: Locator, height: number, top: number) {
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      return Boolean(box && box.y >= top - 1 && box.y + box.height <= top + height + 1);
    })
    .toBe(true);
}

test('expanded queue keeps Close, list and held editing above the keyboard and refits after dismissal', async ({
  page,
  baseURL,
}, info) => {
  const headers = { Origin: baseURL! };
  const settings = schedulerSettingsSchema.parse(
    (await (await page.request.get('/api/scheduler')).json()).settings,
  );
  let agentId: string | undefined;
  try {
    expect(
      (
        await page.request.post('/api/scheduler/settings', {
          headers,
          data: { key: randomUUID(), settings: { paused: true, maxConcurrent: 4 } },
        })
      ).ok(),
    ).toBe(true);
    const project = await (
      await page.request.post('/api/projects', {
        headers,
        data: {
          key: randomUUID(),
          name: `Queue viewport ${randomUUID().slice(0, 8)}`,
          provider: 'codex',
        },
      })
    ).json();
    agentId = project.managerId;
    for (let i = 1; i <= 12; i++) {
      expect(
        (
          await page.request.post(`/api/agents/${agentId}/messages`, {
            headers,
            data: {
              key: randomUUID(),
              text: `Saved queue item ${i}: ${'Keep the full request available. '.repeat(8)}`,
            },
          })
        ).ok(),
      ).toBe(true);
    }
    // This geometry slice uses an established browser; cold registration has its own regression.
    const client = await (
      await page.request.post('/api/workspace/clients', {
        headers,
        data: { key: randomUUID(), label: 'Owned queue viewport browser' },
      })
    ).json();
    await page.addInitScript(
      (id) => localStorage.setItem('dock:local:workspace:client', id),
      client.client.id,
    );
    await keyboardFixture(page);
    await page.goto(`/#/chat/${agentId}`);
    const draft = page.locator('.composer textarea');
    await draft.fill('Separate composer draft');
    const layoutHeight = page.viewportSize()!.height;
    const shortHeight = Math.min(480, layoutHeight - 115);
    const top = 12;
    await setViewport(page, shortHeight, top);
    await page.locator('.message-queue-summary').click();
    const dialog = page.getByRole('dialog', { name: 'Queued messages', exact: true });
    const list = dialog.getByRole('list', { name: 'Queued messages' });
    const close = dialog.getByRole('button', { name: 'Close dialog', exact: true });
    await insideVisibleArea(dialog, shortHeight, top);
    await insideVisibleArea(close, shortHeight, top);
    await insideVisibleArea(list, shortHeight, top);
    await expect(list.getByRole('listitem')).toHaveCount(12);
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    const last = list.getByRole('listitem').last();
    const edit = last.getByRole('button', { name: 'Edit', exact: true });
    await edit.scrollIntoViewIfNeeded();
    await insideVisibleArea(edit, shortHeight, top);
    await page.screenshot({ path: info.outputPath('queue-keyboard-fit.png'), scale: 'css' });
    await edit.click();
    const pad = page.getByRole('dialog', { name: 'Edit queued message', exact: true });
    const minimize = pad.getByRole('button', { name: 'Minimize', exact: true });
    await insideVisibleArea(minimize, shortHeight, top);
    await pad.getByRole('textbox').fill('Held edit stays separate');
    await minimize.click();
    await insideVisibleArea(close, shortHeight, top);
    await setViewport(page, layoutHeight, 0);
    await insideVisibleArea(dialog, layoutHeight, 0);
    await expect
      .poll(() => dialog.evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThan(shortHeight);
    await insideVisibleArea(close, layoutHeight, 0);
    const resume = last.getByRole('button', { name: 'Resume edit', exact: true });
    await resume.scrollIntoViewIfNeeded();
    await insideVisibleArea(resume, layoutHeight, 0);
    await page.screenshot({ path: info.outputPath('queue-keyboard-dismissed.png'), scale: 'css' });
    await close.click();
    await expect(draft).toHaveValue('Separate composer draft');
    const detail = await (await page.request.get(`/api/agents/${agentId}`)).json();
    expect(
      detail.runs.filter(
        (run: { queueEdit?: { state: string } }) => run.queueEdit?.state === 'editing',
      ),
    ).toHaveLength(1);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    if (agentId) {
      const detail = await (await page.request.get(`/api/agents/${agentId}`)).json();
      for (const run of detail.runs as { id: string; status: string }[]) {
        if (run.status !== 'queued') continue;
        expect(
          (
            await page.request.post('/api/pulsar/jobs', {
              headers,
              data: { key: randomUUID(), runId: run.id, action: 'cancel' },
            })
          ).ok(),
        ).toBe(true);
      }
    }
    expect(
      (
        await page.request.post('/api/scheduler/settings', {
          headers,
          data: { key: randomUUID(), settings },
        })
      ).ok(),
    ).toBe(true);
  }
});
