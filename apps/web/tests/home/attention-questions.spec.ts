import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { snapshotSchema, type WorkItem } from '@dock/shared';

test('unanswered human requests stay visible regardless of open progress status', async ({
  page,
}) => {
  const snapshot = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = snapshot.projects.find((p) => !p.internal)!;
  const now = new Date().toISOString();
  const items: WorkItem[] = (['open', 'in_progress', 'waiting', 'done'] as const).map((status) => ({
    id: randomUUID(),
    projectId: project.id,
    managerId: project.managerId,
    taskId: null,
    kind: 'human',
    title: `Human question ${status}`,
    detail: 'Work can continue while you decide.',
    status,
    revision: 1,
    humanReply: null,
    repliedAt: null,
    replyRunId: null,
    assignmentRunId: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: status === 'done' ? now : null,
  }));
  items.push({
    ...items[0]!,
    id: randomUUID(),
    title: 'Answered question',
    humanReply: 'Fractions',
  });
  let failed = false;
  await page.route('**/api/work-items', (route) =>
    failed
      ? route.fulfill({ status: 503, json: { error: 'Temporary read failure' } })
      : route.fulfill({ json: { items } }),
  );
  await page.goto('/#/home');
  const panel = page.getByRole('region', { name: 'For your attention', exact: true });
  for (const status of ['open', 'in_progress', 'waiting']) {
    await expect(
      panel.getByRole('link', { name: new RegExp(`Human question ${status}`) }),
    ).toHaveAttribute('href', `#/chat/${project.managerId}`);
  }
  await expect(panel).not.toContainText('Human question done');
  await expect(panel).not.toContainText('Answered question');
  await expect(panel).not.toContainText('Nothing needs you');
  failed = true;
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(panel.locator('.overview-count')).toHaveText('—');
  await expect(panel.getByRole('link', { name: /Human question open/ })).toBeVisible();
  await page.reload();
  await expect(panel).toContainText('Requests will appear when the computer reconnects.');
  await expect(panel).not.toContainText('Nothing needs you');
  failed = false;
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(panel.getByRole('link', { name: /Human question open/ })).toBeVisible();
});
