import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { detailSchema, snapshotSchema, type Entry } from '@dock/shared';
import { providerErrorPresentation, providerErrorRows } from '../../src/providerErrors';

const message = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
const envelope = (cause: string) =>
  JSON.stringify({
    message: JSON.stringify({
      type: 'error',
      status: 400,
      error: { type: 'invalid_request_error', message: cause },
    }),
    codexErrorInfo: 'other',
    additionalDetails: null,
    misalignment: null,
  });
const text = envelope(message);
const agentId = randomUUID();
function entry(changes: Partial<Entry> = {}): Entry {
  return {
    id: randomUUID(),
    agentId,
    runId: randomUUID(),
    kind: 'system',
    title: 'Codex reported an error',
    text,
    status: 'complete',
    createdAt: '2026-10-08T11:47:12.799Z',
    ...changes,
  };
}
function completion(first: Entry, changes: Partial<Entry> = {}) {
  return entry({
    runId: null,
    title: 'Turn failed',
    text: first.text,
    createdAt: '2026-10-08T11:47:12.997Z',
    ...changes,
  });
}

test('provider error projection unwraps the real nested envelope without changing original records', () => {
  const first = entry();
  const last = completion(first);
  const result = providerErrorRows([first, last]);
  expect(result.presentations.get(first.id)).toEqual({
    cause: 'Codex rejected gpt-6.1-sol.',
    action: 'Update Codex or choose an available model before trying again.',
    records: [first, last],
  });
  expect([...result.hidden]).toEqual([last.id]);
  expect(first.text).toBe(text);
  expect(last.text).toBe(text);
  const long = entry({ text: envelope('Native failure ' + 'x'.repeat(700)) });
  const presentation = providerErrorPresentation(long)!;
  expect(presentation.cause).toContain('Open Details');
  expect(presentation.records[0]!.text).toBe(long.text);
});

test('provider error projection preserves unrelated, malformed and bounded-out errors', () => {
  for (const changes of [
    { kind: 'user' as const },
    { kind: 'assistant' as const },
    { title: 'Owner steering' },
    { title: 'Other failure' },
    { text: 'Readable ordinary error' },
    { text: '{malformed' },
    { text: JSON.stringify({ codexErrorInfo: 'other', message: '{malformed' }) },
    { text: JSON.stringify({ message }) },
    { text: text + 'x'.repeat(16_384) },
    {
      text: JSON.stringify({
        codexErrorInfo: 'other',
        message: JSON.stringify({
          message: JSON.stringify({ message: JSON.stringify({ message }) }),
        }),
      }),
    },
  ]) {
    const original = entry(changes);
    const result = providerErrorRows([original, completion(original)]);
    expect(result.hidden.size).toBe(0);
    expect(result.presentations.has(original.id)).toBe(false);
    expect(original).toMatchObject(changes);
  }
});

test('provider error projection never joins distinct turns, separated owner messages or uncertain pairs', () => {
  const first = entry();
  const last = completion(first);
  const second = entry({ createdAt: '2026-10-08T11:48:12.799Z' });
  const secondLast = completion(second, { createdAt: '2026-10-08T11:48:12.997Z' });
  const owner = entry({ kind: 'user', title: 'You', text: 'Keep this owner message visible.' });
  const two = providerErrorRows([first, last, owner, second, secondLast]);
  expect([...two.hidden]).toEqual([last.id, secondLast.id]);
  expect([...two.presentations.keys()]).toEqual([first.id, second.id]);
  expect(two.presentations.get(second.id)!.records).toEqual([second, secondLast]);
  expect(providerErrorRows([first, owner, last]).hidden.size).toBe(0);
  expect(providerErrorRows([first, entry({ title: 'Owner steering' }), last]).hidden.size).toBe(0);
  for (const changes of [
    { runId: randomUUID() },
    { agentId: randomUUID() },
    { text: envelope('Different native cause') },
    { createdAt: '2026-10-08T11:47:14.000Z' },
    { createdAt: 'invalid' },
    { createdAt: '2026-10-08T11:47:12.000Z' },
    { kind: 'user' as const },
  ])
    expect(providerErrorRows([first, completion(first, changes)]).hidden.size).toBe(0);
  expect(providerErrorRows([entry({ runId: null }), last]).hidden.size).toBe(0);
  expect(providerErrorRows([last, first]).hidden.size).toBe(0);
});

test('native failure shows a readable cause once, exact originals in Details and retained recovery', async ({
  page,
}, info) => {
  const state = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = state.projects.find((p) => !p.internal)!;
  const agent = state.agents.find((a) => a.id === project.managerId)!;
  const detail = detailSchema.parse(
    await (await page.request.get(`/api/agents/${agent.id}`)).json(),
  );
  agent.status = 'failed';
  const first = entry({ agentId: agent.id });
  const last = completion(first, { agentId: agent.id });
  const owner = entry({
    agentId: agent.id,
    runId: first.runId,
    kind: 'user',
    title: 'You',
    text: 'Saved fixture request',
    createdAt: '2026-10-08T11:47:11.000Z',
  });
  let writes = 0;
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: state }));
  await page.route(new RegExp(`/api/agents/${agent.id}(?:\\?.*)?$`), (route) =>
    route.fulfill({
      json: {
        ...detail,
        agent,
        entries: [owner, first, last],
        runs: [
          {
            id: first.runId,
            agentId: agent.id,
            sourceId: null,
            text: owner.text,
            kind: 'user',
            status: 'failed',
            createdAt: owner.createdAt,
          },
        ],
        hasMore: false,
      },
    }),
  );
  await page.route(`**/api/agents/${agent.id}/run-recovery`, (route) => {
    if (route.request().method() !== 'GET') {
      writes++;
      return route.fulfill({
        status: 500,
        json: { error: 'No recovery invocation in this fixture' },
      });
    }
    return route.fulfill({
      json: {
        runId: first.runId,
        failureId: randomUUID(),
        action: 'continue',
        explanation: 'Continue inspects saved progress before taking the next step.',
      },
    });
  });
  await page.route(`**/api/agents/${agent.id}/messages`, (route) => {
    writes++;
    return route.fulfill({ status: 500, json: { error: 'No model call allowed' } });
  });
  await page.goto(`/#/chat/${agent.id}`);
  const row = page.locator('.provider-error');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Codex rejected gpt-6.1-sol.');
  await expect(row).toContainText('Update Codex or choose an available model before trying again.');
  await expect(page.getByText(owner.text, { exact: true })).toHaveCount(1);
  const recovery = page
    .locator('.run-recovery')
    .getByRole('button', { name: 'Continue', exact: true });
  await expect(recovery).toBeVisible();
  const details = row.locator('details');
  await expect(details).not.toHaveAttribute('open', '');
  await expect(details.locator('pre').first()).not.toBeVisible();
  const summary = details.locator('summary');
  expect(
    await summary.evaluate((node) => node.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  await summary.click();
  await expect(details.locator('pre')).toHaveText([text, text]);
  await expect(details).toContainText(first.id);
  await expect(details).toContainText(last.id);
  await expect(details).toContainText(first.runId!);
  await expect(details).toContainText('Both original records are retained.');
  expect(await row.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await summary.click();
  await expect(recovery).toBeVisible();
  expect(writes).toBe(0);
  await info.attach('readable-provider-error', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});
