import { test, expect, type Page, type Route } from '@playwright/test';
import type { GroupDocumentCapacity } from '@dock/shared/dist/group-document-capacity.js';

const owner = 'd5ced7dc-df8d-4e94-82b1-a4f97218cd9c',
  target = '067556ac-2b5a-480a-9f7a-1b730a8dffb0',
  grant = 'eeeb5ab8-e0c3-413b-b763-21f96af596d4',
  version = 'a'.repeat(64),
  endpoint = `/api/groups/documents/${owner}/${grant}/${version}`,
  storage = `swa:group-report-share:local:${owner}:${grant}:${version}:${target}`,
  mib = 1024 ** 2;
const available = (): GroupDocumentCapacity => ({
  kind: 'capacity',
  logical: { usedBytes: 250 * mib, limitBytes: 256 * mib, requiredBytes: 5 * mib },
  physical: {
    usedBytes: 300 * mib,
    limitBytes: 512 * mib,
    reservedBytes: 20 * mib,
    requiredBytes: 6 * mib,
  },
  pending: 0,
  pendingLimit: 8,
  fits: true,
  reason: 'available',
});
const success = {
  grantId: '07d4fc8b-367c-4d55-9d0c-036ec12c43d5',
  version: 'b'.repeat(64),
  href: '#/groups/report/07d4fc8b-367c-4d55-9d0c-036ec12c43d5/' + 'b'.repeat(64),
  visibility: 'shared',
};
async function fixture(page: Page) {
  const state = {
    capacity: available(),
    unavailable: false,
    preflights: [] as { path: string; body: unknown }[],
    publishes: [] as { path: string; body: { key: string; sharedHandle: string } }[],
    publish: async (route: Route) => route.fulfill({ json: success }),
    hold: null as Promise<void> | null,
  };
  await page.route('**/api/groups/documents/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    expect(path.startsWith(endpoint)).toBe(true);
    if (path.endsWith('/preflight')) {
      state.preflights.push({ path, body: route.request().postDataJSON() });
      if (state.hold) await state.hold;
      if (state.unavailable)
        await route.fulfill({
          status: 409,
          json: { code: 'GROUP_REPORT_HOSTING_UPDATE', error: 'Generic creator upgrade refusal.' },
        });
      else await route.fulfill({ json: state.capacity });
    } else if (path.endsWith('/publish')) {
      state.publishes.push({ path, body: route.request().postDataJSON() });
      await state.publish(route);
    } else if (path.endsWith('/reading')) {
      await route.fulfill({
        json: {
          available: true,
          html: '<h1>Retained example report</h1><p>Exact selected report text remains readable while sharing is checked.</p>',
          warnings: [],
          labels: {},
        },
      });
    } else {
      await route.fulfill({
        json: {
          id: grant,
          name: 'Retained example report.pdf',
          folder: 'Reports',
          kind: 'pdf',
          state: 'ready',
          hasPdf: true,
          builtAt: null,
          openedAt: null,
          error: null,
          href: `#/groups/document/${grant}/${version}`,
        },
      });
    }
  });
  return state;
}
async function open(page: Page, readOnly = false) {
  await page.goto(`/?publish${readOnly ? '&readOnly' : ''}`);
  await page
    .getByRole('textbox', { name: 'Draft', exact: true })
    .fill('Exact unsent draft · α → β');
  await page.getByRole('link', { name: 'Open my report', exact: true }).click();
  await expect(page.locator('.document-reading')).toContainText('Retained example report');
  await page.getByText('Share this report', { exact: true }).click();
  return page.locator('.group-report-publish');
}
async function key(page: Page) {
  return page.evaluate((name) => sessionStorage.getItem(name), storage);
}
async function capture(page: Page, suffix: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width + 2,
  );
  const reading = await page.locator('.document-reading-scroll').boundingBox();
  expect(reading!.height).toBeGreaterThan(80);
  expect(
    (await page.locator('.group-report-publish > summary').boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: `../../data/group-documents-ui/${test.info().project.name}-report-${suffix}.png`,
  });
}

test('fresh hosted report capacity and Read-only refusals keep exact files local with no publication identity or idle checks', async ({
  page,
}) => {
  const state = await fixture(page);
  state.capacity = {
    ...available(),
    logical: { ...available().logical, requiredBytes: 10 * mib },
    fits: false,
    reason: 'logical-limit',
  };
  const action = await open(page);
  const share = action.getByRole('button', {
    name: 'Share selected report files with group',
    exact: true,
  });
  await expect(action).toContainText('require 10 MiB');
  await expect(action).toContainText('6 MiB remains of 256 MiB');
  await expect(share).toBeDisabled();
  const refusal = action.getByText('Hosted report storage cannot fit this new attachment.', {
    exact: false,
  });
  await refusal.scrollIntoViewIfNeeded();
  await expect(refusal).toBeVisible();
  await capture(page, 'full-hosted-storage');
  expect(await key(page)).toBeNull();
  expect(state.publishes).toEqual([]);
  expect(state.preflights).toEqual([
    { path: `${endpoint}/preflight`, body: { sharedHandle: target } },
  ]);
  await page.getByText('Share this report', { exact: true }).click();
  expect(state.preflights).toHaveLength(1); // collapse is not a read or a share
  await page.getByText('Share this report', { exact: true }).click();
  await expect.poll(() => state.preflights.length).toBe(2);
  for (const [reason, notice] of [
    ['physical-limit', 'alongside its retained data and reservations'],
    ['pending-limit', 'All pending report upload slots are occupied'],
  ] as const) {
    state.capacity = { ...available(), fits: false, reason };
    await action.getByRole('button', { name: 'Recheck hosted storage', exact: true }).click();
    await expect(action).toContainText(notice);
    await expect(share).toBeDisabled();
    expect(await key(page)).toBeNull();
  }
  state.unavailable = true;
  await action.getByRole('button', { name: 'Recheck hosted storage', exact: true }).click();
  await expect(action.getByRole('alert')).toContainText('creator needs to update');
  await expect(action).not.toContainText('Generic creator upgrade refusal');
  await expect(share).toBeDisabled();
  expect(state.publishes).toEqual([]);
  state.unavailable = false;
  state.capacity = available();
  const readonly = await open(page, true);
  await expect(readonly).toContainText('There is room now');
  await expect(readonly).toContainText('This group is Read-only');
  await expect(
    readonly.getByRole('button', { name: 'Share selected report files with group', exact: true }),
  ).toBeDisabled();
  expect(await key(page)).toBeNull();
  expect(state.publishes).toEqual([]);
  await page.getByRole('button', { name: 'Back to where I was', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
    'Exact unsent draft · α → β',
  );
});

test('Confirm rechecks changed hosted capacity before a new key and a racing Read-only refusal retains the exact request', async ({
  page,
}) => {
  const state = await fixture(page),
    action = await open(page),
    share = action.getByRole('button', {
      name: 'Share selected report files with group',
      exact: true,
    });
  await expect(share).toBeEnabled();
  state.capacity = { ...available(), fits: false, reason: 'logical-limit' };
  await share.click();
  await expect(action).toContainText('cannot fit this new attachment');
  expect(state.preflights).toHaveLength(2);
  expect(state.publishes).toEqual([]);
  expect(await key(page)).toBeNull();
  state.capacity = available();
  await action.getByRole('button', { name: 'Recheck hosted storage', exact: true }).click();
  await expect(share).toBeEnabled();
  state.publish = async (route) =>
    route.fulfill({
      status: 409,
      json: {
        code: 'GROUP_LOCAL_READ_ONLY',
        error: 'This group is Read-only. Choose Contribute before sharing a new report.',
      },
    });
  await share.click();
  await expect(action).toContainText('Choose Contribute');
  expect(state.preflights).toHaveLength(4); // open, refused Confirm, Recheck, fresh Confirm
  const retained = await key(page);
  expect(retained).toMatch(/^[a-f0-9-]{36}$/);
  expect(state.publishes[0]).toEqual({
    path: `${endpoint}/publish`,
    body: { key: retained, sharedHandle: target },
  });
  state.publish = async (route) => route.fulfill({ json: success });
  await action.getByRole('button', { name: 'Retry saved report share', exact: true }).click();
  await expect(action).toContainText('Shared the selected report');
  expect(state.preflights).toHaveLength(4); // saved-key reconciliation bypasses advisory
  expect(state.publishes[1]).toEqual(state.publishes[0]);
  expect(await key(page)).toBeNull();
});

test('lost share acknowledgement survives reload and current full or legacy-host refusal cannot retarget the saved publication', async ({
  page,
}) => {
  const state = await fixture(page),
    action = await open(page);
  state.publish = async (route) => route.abort('failed');
  await action
    .getByRole('button', { name: 'Share selected report files with group', exact: true })
    .click();
  await expect(action).toContainText('Retry uses the same saved publication');
  const original = state.publishes[0],
    retained = await key(page);
  expect(retained).toBe(original.body.key);
  state.capacity = { ...available(), fits: false, reason: 'logical-limit' };
  const reopened = await open(page, true);
  await expect(reopened).toContainText('cannot fit this new attachment');
  const retry = reopened.getByRole('button', { name: 'Retry saved report share', exact: true });
  await expect(retry).toBeEnabled();
  await expect(reopened).toContainText('Nothing is automatically resent');
  expect(state.publishes).toHaveLength(1);
  state.unavailable = true;
  await reopened.getByRole('button', { name: 'Recheck hosted storage', exact: true }).click();
  await expect(reopened).toContainText('creator needs to update');
  await expect(retry).toBeEnabled();
  expect(await key(page)).toBe(retained);
  state.publish = async (route) => route.fulfill({ json: success });
  await retry.click();
  await expect(reopened).toContainText('Shared the selected report');
  expect(state.publishes).toEqual([original, original]);
  expect(await key(page)).toBeNull();
  await reopened.getByRole('status').last().scrollIntoViewIfNeeded();
  await capture(page, 'retained-share-reconciled');
});

test('an already saved share can reconcile while its independent advisory read is stalled', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto('/?publish&readOnly');
  const retained = 'cbe6a083-bf3b-461e-963f-1e1c8ce69cd9';
  await page.evaluate(({ storage, retained }) => sessionStorage.setItem(storage, retained), {
    storage,
    retained,
  });
  await page.getByRole('link', { name: 'Open my report', exact: true }).click();
  let release = () => {};
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.getByText('Share this report', { exact: true }).click();
    const action = page.locator('.group-report-publish');
    await expect(action).toContainText('Checking hosted report storage');
    await action.getByRole('button', { name: 'Retry saved report share', exact: true }).click();
    await expect(action).toContainText('Shared the selected report');
    expect(state.publishes).toEqual([
      { path: `${endpoint}/publish`, body: { key: retained, sharedHandle: target } },
    ]);
    expect(state.preflights).toHaveLength(1);
    expect(await key(page)).toBeNull();
  } finally {
    release();
  }
});
