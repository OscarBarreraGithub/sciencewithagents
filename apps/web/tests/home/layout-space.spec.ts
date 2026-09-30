import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { snapshotSchema } from '@dock/shared';

test('attention keeps questions usable without listing every stopped background check', async ({
  page,
}) => {
  let managerId = '',
    projectId = '';
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const snapshot = snapshotSchema.parse(await response.json());
    const project = snapshot.projects.find((p) => !p.internal)!;
    const manager = snapshot.agents.find((a) => a.id === project.managerId)!;
    managerId = manager.id;
    projectId = project.id;
    const internalId = randomUUID();
    snapshot.projects.push({
      ...project,
      id: internalId,
      name: 'Automatic checks',
      internal: true,
    });
    snapshot.agents = [
      { ...manager, status: 'idle' },
      ...Array.from({ length: 30 }, (_, n) => ({
        ...manager,
        id: randomUUID(),
        projectId: internalId,
        name: `Routine check ${n}`,
        status: 'interrupted' as const,
      })),
      ...Array.from({ length: 5 }, (_, n) => ({
        ...manager,
        id: randomUUID(),
        role: 'implementer' as const,
        name: `Stopped worker ${n}`,
        status: 'interrupted' as const,
      })),
    ];
    snapshot.tasks = [];
    snapshot.approvals = [];
    snapshot.backups = [];
    await route.fulfill({ json: snapshot });
  });
  await page.route('**/api/work-items', async (route) => {
    // Wait for the snapshot identity; this read never changes the demo database.
    await expect.poll(() => managerId).not.toBe('');
    const now = new Date().toISOString();
    await route.fulfill({
      json: {
        items: Array.from({ length: 4 }, (_, n) => ({
          id: randomUUID(),
          projectId,
          managerId,
          taskId: null,
          kind: 'human',
          status: 'waiting',
          title: `Question ${n + 1}`,
          detail: 'Choose the input needed to continue this task.',
          revision: 1,
          humanReply: null,
          repliedAt: null,
          replyRunId: null,
          assignmentRunId: null,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        })),
      },
    });
  });
  await page.goto('/#/home');
  const attention = page.locator('.overview-attention');
  await expect(attention.locator('.attention-item')).toHaveCount(3);
  await expect(attention).not.toContainText('Routine check');
  await expect(attention.getByRole('link', { name: /Question 1/ })).toHaveAttribute(
    'href',
    `#/chat/${managerId}`,
  );
  await attention.getByRole('button', { name: 'Show 2 more requests' }).click();
  await expect(attention.locator('.attention-item')).toHaveCount(5);
  await expect(attention.locator('a[href="#/work"]')).toHaveCount(1);
  const list = attention.locator('.overview-attention-list');
  expect(await list.evaluate((e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
  await attention.getByRole('button', { name: 'Show fewer' }).click();
  await expect(attention.locator('.attention-item')).toHaveCount(3);
});

test('main pages use the browser width and mobile allowances scroll away', async ({ page }) => {
  await page.goto('/#/home');
  await expect(page.locator('.overview')).toBeVisible();
  const width = page.viewportSize()!.width;
  const box = await page.locator('.overview').boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(width - 70);
  if (width <= 700) {
    await expect(page.locator('.home-mobile-status')).toBeVisible();
    await page.locator('.home-content').evaluate((e) => e.scrollTo(0, e.scrollHeight));
    const usage = await page.locator('.home-mobile-status').boundingBox();
    expect(usage!.y + usage!.height).toBeLessThanOrEqual(52);
  }
  await page.goto('/#/computers');
  await expect(
    page.getByRole('heading', { name: 'Computers and accounts', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.activity-shortcuts a[href="#/recovery"]')).toHaveCount(0);
  await expect(page.locator('.activity-shortcuts a[href="#/usage"]')).toHaveCount(0);
});
