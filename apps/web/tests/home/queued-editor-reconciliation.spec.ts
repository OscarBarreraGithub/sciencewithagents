import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { detailSchema, snapshotSchema, type Run } from '@dock/shared';

test('a taken-over and delivered queued editor retains its local copy without saving or sending again', async ({
  page,
  browser,
  baseURL,
}, info) => {
  const snapshot = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  const project = snapshot.projects.find((value) => !value.internal)!;
  const agent = snapshot.agents.find((value) => value.id === project.managerId)!;
  const retained = detailSchema.parse(
    await (await page.request.get(`/api/agents/${agent.id}`)).json(),
  );
  let run: Run = {
    id: randomUUID(),
    agentId: agent.id,
    sourceId: null,
    text: 'Synthetic queued owner input',
    kind: 'user',
    status: 'queued',
    createdAt: new Date().toISOString(),
    queueEditable: true,
    queueRevision: 0,
    queueEdit: null,
  };
  let omitted = false;
  let exactReads = 0;
  let firstTabWrites = 0;
  let deliveries = 0;
  const otherContext = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const other = await otherContext.newPage();
  const setup = async (context: BrowserContext, first: boolean) => {
    await context.addInitScript(() => {
      const sources: EventTarget[] = [];
      class FixtureEvents extends EventTarget {
        onopen = null;
        onerror = null;
        constructor() {
          super();
          sources.push(this);
        }
        close() {
          const index = sources.indexOf(this);
          if (index >= 0) sources.splice(index, 1);
        }
      }
      Object.assign(window, {
        EventSource: FixtureEvents,
        refreshQueueFixture: () => sources.at(-1)?.dispatchEvent(new Event('change')),
      });
    });
    await context.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
    await context.route(new RegExp(`/api/agents/${agent.id}(?:\\?.*)?$`), (route) =>
      route.fulfill({
        json: {
          ...retained,
          agent,
          runs: first && omitted ? [] : [run],
          entries: [],
        },
      }),
    );
    await context.route(`**/api/agents/${agent.id}/queued/${run.id}/receipts/*`, (route) => {
      if (first) exactReads++;
      return route.fulfill({ json: { status: 'not_found', run } });
    });
    await context.route(`**/api/agents/${agent.id}/queued/${run.id}`, (route) => {
      if (first) firstTabWrites++;
      const input = route.request().postDataJSON();
      if (
        run.status !== 'queued' ||
        input.revision !== run.queueRevision ||
        (!['edit', 'takeover'].includes(input.action) && run.queueEdit?.clientId !== input.clientId)
      )
        return route.fulfill({ status: 409, json: { error: 'Fixture ownership changed.' } });
      run = {
        ...run,
        queueRevision: run.queueRevision! + 1,
        queueEdit: {
          clientId: input.clientId,
          text: input.text ?? run.queueEdit?.text ?? run.text,
          state: 'editing',
        },
      };
      if (input.action === 'queue') {
        deliveries++;
        run = { ...run, text: run.queueEdit!.text, queueEdit: null, status: 'completed' };
        omitted = true;
      }
      return route.fulfill({ json: run });
    });
  };
  const refresh = (tab: Page) =>
    tab.evaluate(() =>
      (window as unknown as { refreshQueueFixture(): void }).refreshQueueFixture(),
    );
  const openEdit = async (tab: Page, name: 'Edit' | 'Take over edit') => {
    await tab.getByRole('button', { name: /Expand queue/ }).click();
    const queue = tab.getByRole('dialog', { name: 'Queued messages', exact: true });
    await queue.getByRole('button', { name, exact: true }).click();
    return tab.getByRole('dialog', { name: 'Edit queued message', exact: true });
  };
  try {
    await setup(page.context(), true);
    await setup(otherContext, false);
    await page.goto(`/#/chat/${agent.id}`);
    await other.goto(`/#/chat/${agent.id}`);
    const pad = await openEdit(page, 'Edit');
    await expect(pad).toBeVisible();
    await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'));
    const localText = 'Unsent scientific edits retained only in the first tab.';
    const local = pad.getByRole('textbox');
    await local.fill(localText);

    // A paged/filtered list omitting a still-owned held input is not delivery proof.
    omitted = true;
    await refresh(page);
    await expect.poll(() => exactReads).toBe(1);
    await expect(pad.getByRole('button', { name: 'Save and queue', exact: true })).toBeEnabled();
    await expect(local).toHaveValue(localText);
    // Keep the first tab's list omitting this item across takeover and delivery.
    // Only a fresh exact read can observe those later transitions.
    await refresh(other);
    await expect(other.getByRole('button', { name: /1 held/ })).toBeVisible();
    const remotePad = await openEdit(other, 'Take over edit');
    await expect(remotePad).toBeVisible();
    await refresh(page);
    await expect.poll(() => exactReads).toBe(2);
    await expect(pad.getByRole('status').first()).toHaveText('Editing closed · local copy');
    await expect(local).toHaveAttribute('readonly', '');
    await expect(local).toHaveValue(localText);
    await expect(pad.getByRole('button', { name: 'Editing closed', exact: true })).toBeDisabled();
    const before = firstTabWrites;
    await page.clock.runFor(2000);
    expect(firstTabWrites).toBe(before);

    await remotePad
      .getByRole('textbox')
      .fill('The other browser explicitly delivered this version.');
    await remotePad.getByRole('button', { name: 'Save and queue', exact: true }).click();
    await expect.poll(() => deliveries).toBe(1);
    await refresh(page);
    await expect.poll(() => exactReads).toBe(3);
    await expect(pad).toBeVisible();
    await expect(local).toHaveValue(localText);
    await page.clock.runFor(2000);
    await local.press('Control+Enter');
    expect(firstTabWrites).toBe(before);
    expect(deliveries).toBe(1);
    await pad.getByRole('button', { name: 'Versions', exact: true }).click();
    await expect(pad.getByRole('complementary', { name: 'Saved versions' })).toContainText(
      localText,
    );
    const options = pad.getByRole('button', { name: 'Notepad options', exact: true });
    if ((await options.getAttribute('aria-expanded')) !== 'true') await options.click();
    await expect(pad.getByRole('button', { name: 'Copy text', exact: true })).toBeVisible();
    await expect(pad.getByRole('button', { name: 'Steer now', exact: true })).toHaveCount(0);
    await expect(pad.getByRole('button', { name: 'Retry saved action', exact: true })).toHaveCount(
      0,
    );
    await page.screenshot({ path: info.outputPath('delivered-editor-local-copy.png') });
    await pad.getByRole('button', { name: 'Close edit', exact: true }).click();
    await expect(pad).toHaveCount(0);
    expect(
      await page.evaluate(
        (text) => Object.values(localStorage).some((value) => value.includes(text)),
        localText,
      ),
    ).toBe(true);
    expect(firstTabWrites).toBe(before);
  } finally {
    await otherContext.close();
  }
});
