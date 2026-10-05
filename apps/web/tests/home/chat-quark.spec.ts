import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { chatQuarkPolicySchema, schedulerStatusSchema, snapshotSchema } from '@dock/shared';

test('Configure saves chat-only bypass, retains a lost save receipt and restores its explicit off choice', async ({
  page,
  baseURL,
}, info) => {
  const original = schedulerStatusSchema.parse(
    await (await page.request.get('/api/scheduler')).json(),
  ).settings;
  const state = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = state.projects.find((value) => !value.internal)!;
  let managerId = '';
  const writes: { key: string; enabled: boolean; expectedRevision: number }[] = [];
  try {
    const paused = await page.request.post('/api/scheduler/settings', {
      headers: { origin: baseURL! },
      data: { key: randomUUID(), settings: { ...original, paused: true } },
    });
    expect(paused.ok()).toBe(true);
    const created = await page.request.post(`/api/projects/${project.id}/managers`, {
      headers: { origin: baseURL! },
      data: {
        key: randomUUID(),
        name: `Chat preference ${info.project.name} ${randomUUID().slice(0, 8)}`,
        scope: 'Owned browser fixture',
        provider: 'codex',
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    managerId = (await created.json()).id;
    const message = await page.request.post(`/api/agents/${managerId}/messages`, {
      headers: { origin: baseURL! },
      data: { key: randomUUID(), text: 'Retain this direct reply while paused.' },
    });
    expect(message.ok()).toBe(true);
    await page.route(`**/api/agents/${managerId}/chat-quark`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      writes.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (writes.length === 1)
        return route.fulfill({
          status: 502,
          json: { error: 'The preference was saved, but its response was lost.' },
        });
      await route.fulfill({ response });
    });
    await page.goto(`/#/chat/${managerId}`);
    await page.getByRole('button', { name: 'Configure', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Configuration', exact: true });
    const toggle = panel.getByRole('switch', { name: /Ignore QUARK for my replies/ });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(panel.getByRole('alert')).toContainText('Your change is retained');
    await expect(toggle).toBeDisabled();
    await expect(panel).toContainText('Direct replies only; workers stay supervised.');
    await expect(panel).toContainText('Current queued replies and new messages');
    await page.reload();
    await page.getByRole('button', { name: 'Configure', exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Save unconfirmed: On.');
    await panel.getByRole('button', { name: 'Retry chat preference save', exact: true }).click();
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(writes[1]).toEqual(writes[0]);
    const policy = chatQuarkPolicySchema.parse(
      await (await page.request.get(`/api/agents/${managerId}/chat-quark`)).json(),
    );
    expect(policy).toMatchObject({ enabled: true, revision: 1 });
    const detail = await (await page.request.get(`/api/agents/${managerId}`)).json();
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0].status).toBe('queued'); // host pause is retained
    await toggle.scrollIntoViewIfNeeded();
    const bounds = (await toggle.boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 1440) + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('chat-quark-config.png') });
    await toggle.focus();
    await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toBeEnabled();
    await page.reload();
    await page.getByRole('button', { name: 'Configure', exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(panel.locator('.chat-quark-preference')).toContainText('Saved: Off.');
  } finally {
    await page.unroute(`**/api/agents/${managerId}/chat-quark`);
    if (managerId) {
      const removed = await page.request.post(`/api/agents/${managerId}/remove`, {
        headers: { origin: baseURL! },
        data: { key: randomUUID() },
      });
      expect(removed.ok()).toBe(true);
    }
    const restored = await page.request.post('/api/scheduler/settings', {
      headers: { origin: baseURL! },
      data: { key: randomUUID(), settings: original },
    });
    expect(restored.ok()).toBe(true);
  }
});
