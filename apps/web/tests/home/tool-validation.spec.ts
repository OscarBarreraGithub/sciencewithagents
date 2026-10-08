import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  snapshotSchema,
  detailSchema,
  inspectSchema,
  sourceDispositionLengthMessage,
  type Entry,
} from '@dock/shared';
import { internalToolValidation } from '../../src/toolValidation';
const sourceIssue = {
  origin: 'string',
  code: 'too_big',
  maximum: 2000,
  inclusive: true,
  path: ['sourceDisposition'],
  message: 'Too big: expected string to have <=2000 characters',
};
const budgetIssue = {
  origin: 'number',
  code: 'too_small',
  minimum: 100,
  inclusive: true,
  path: ['scheduling', 'tokenBudget'],
  message: 'Too small: expected number to be >=100',
};
const inspection = inspectSchema.safeParse({ models: true, capacity: true });
const inspectionMessage = inspection.success ? '' : inspection.error.issues[0]!.message;
const inspectionIssue = { code: 'custom', path: [], message: inspectionMessage };
const raw = (issues: unknown[]) => JSON.stringify(issues, null, 2);
function entry(changes: Partial<Entry> = {}): Entry {
  return {
    id: randomUUID(),
    agentId: randomUUID(),
    runId: randomUUID(),
    kind: 'system',
    title: 'Request failed',
    text: raw([sourceIssue]),
    status: 'complete',
    createdAt: new Date().toISOString(),
    ...changes,
  };
}

test('tool-validation classifier accepts only verified current and retained internal contracts', () => {
  for (const text of [
    raw([sourceIssue]),
    raw([budgetIssue]),
    raw([inspectionIssue]),
    raw([
      {
        ...inspectionIssue,
        message: inspectionMessage.replace(', coordination or cluster.', ' or cluster.'),
      },
    ]),
    sourceDispositionLengthMessage,
  ]) {
    const original = entry({ text });
    expect(internalToolValidation(original)).toBe(true);
    expect(original.text).toBe(text);
  }
});

test('tool-validation classifier retains permissions, owner input, mixed and unknown failures in chat', () => {
  for (const changes of [
    { kind: 'user' as const },
    { kind: 'assistant' as const },
    { title: 'Owner steering' },
    { title: 'Turn failed' },
    { status: 'waiting' },
    { runId: null },
    { text: 'Permission required before publishing. Ask the owner.' },
    { text: '{malformed' },
    { text: raw([{ ...sourceIssue, path: ['permission'] }]) },
    { text: raw([{ ...budgetIssue, minimum: 1000 }]) },
    { text: raw([{ ...sourceIssue, maximum: 1000 }]) },
    { text: raw([{ ...sourceIssue, ownerAction: 'confirm' }]) },
    {
      text: raw([sourceIssue, { code: 'custom', path: [], message: 'Owner permission required' }]),
    },
    { text: raw([inspectionIssue, { ...sourceIssue, path: ['unknown'] }]) },
    { text: raw(Array.from({ length: 9 }, () => sourceIssue)) },
    { text: 'x'.repeat(4097) },
  ])
    expect(internalToolValidation(entry(changes))).toBe(false);
});

test('tool input corrections stay in activity while owner, permission and final messages stay visible', async ({
  page,
}, info) => {
  const snapshot = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = snapshot.projects.find((p) => !p.internal)!;
  const agent = snapshot.agents.find((a) => a.id === project.managerId)!;
  const detail = detailSchema.parse(
    await (await page.request.get(`/api/agents/${agent.id}`)).json(),
  );
  agent.status = 'idle';
  const runId = randomUUID();
  const make = (changes: Partial<Entry>) => entry({ agentId: agent.id, runId, ...changes });
  const owner = make({
    kind: 'user',
    title: 'You',
    text: 'Keep my sourceDisposition question visible.',
  });
  const corrections = [sourceIssue, budgetIssue, inspectionIssue].map((issue) =>
    make({ text: raw([issue]) }),
  );
  const permission = make({ text: 'Permission required before publishing. Ask the owner.' });
  const mixed = make({
    text: raw([sourceIssue, { code: 'custom', path: [], message: 'Owner permission required' }]),
  });
  const final = make({
    kind: 'assistant',
    title: 'Agent',
    phase: 'final',
    text: 'The saved work is intact.',
  });
  const entries = [owner, ...corrections, permission, mixed, final];
  let writes = 0;
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route(new RegExp(`/api/agents/${agent.id}(?:\\?.*)?$`), (route) =>
    route.fulfill({ json: { ...detail, agent, entries, runs: [], hasMore: false } }),
  );
  await page.route(`**/api/agents/${agent.id}/messages`, (route) => {
    writes++;
    return route.fulfill({ status: 500, json: { error: 'No native call allowed' } });
  });
  await page.goto(`/#/chat/${agent.id}`);
  await expect(page.getByText(owner.text, { exact: true })).toBeVisible();
  await expect(page.getByText(final.text, { exact: true })).toBeVisible();
  await expect(page.locator('.system-entry').filter({ hasText: permission.text })).toBeVisible();
  await expect(
    page.locator('.system-entry').filter({ hasText: 'Owner permission required' }),
  ).toBeVisible();
  const activity = page.locator('.tool-group');
  await expect(activity).toHaveCount(1);
  const summary = activity.locator(':scope > summary');
  await expect(summary).toContainText('3 input corrections');
  await expect(summary).not.toContainText('sourceDisposition');
  await expect(summary).not.toContainText('too_big');
  await expect(summary).not.toContainText('Request failed');
  expect(
    await summary.evaluate((node) => node.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  await summary.click();
  const retained = activity.locator('.tool-entry');
  await expect(retained).toHaveCount(3);
  expect(
    await retained
      .first()
      .locator('summary')
      .evaluate((node) => node.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  await retained.first().locator('summary').click();
  await expect(retained.first().locator('pre')).toHaveText(corrections[0]!.text);
  await expect(retained.first()).toContainText(corrections[0]!.id);
  await expect(retained.first()).toContainText(runId);
  await expect(retained.first()).toContainText('This tool request was rejected.');
  expect(await activity.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await summary.click();
  await expect(page.getByText(final.text, { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  await info.attach('tool-validation-in-activity', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});
