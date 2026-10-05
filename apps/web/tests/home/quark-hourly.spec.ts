import { expect, test, type Locator, type Page } from '@playwright/test';
import { join, resolve } from 'node:path';
import { Store } from '../../../server/dist/store.js';
import { parseCapacity } from '../../../server/dist/capacity.js';
async function createProject(page: Page, origin: string, name: string) {
  const key = crypto.randomUUID();
  const response = await page.request.post('/api/projects', {
    headers: { Origin: origin },
    data: { key, name: `${name} ${key.slice(0, 8)}`, provider: 'codex' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function move(slider: Locator, value: number, release = true) {
  await slider.evaluate((node, next) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      node,
      String(next),
    );
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  if (release) await slider.dispatchEvent('pointerup');
}
test('primary rate and reserve sliders persist zero, retry lost replies, queue in-flight edits and show bounded history', async ({
  page,
  baseURL,
}, info) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  expect(snapshot.provider.version).toBe('demo');
  // Saved hourly windows belong to their project. Never reuse another test's project.
  const priorProject = await createProject(page, baseURL!, 'Prior hourly budget');
  const project = await createProject(page, baseURL!, 'Hourly controls');
  const store = new Store(
    join(
      resolve(process.env.DOCK_E2E_DATA_DIR ?? '../../data/browser-data/home'),
      'demo',
      'dock.sqlite',
    ),
  );
  const now = Date.now();
  try {
    for (const provider of ['codex', 'claude'] as const) {
      const fixtureReading = store.db
        .prepare('SELECT body FROM quark_intervals WHERE receipt=?')
        .get(`rate-ui:${provider}:0`) as { body: string } | undefined;
      // Keep this spec's append-only account observations on the same reported reset
      // across browser cases. A fresh project has no earlier allocations in those rows.
      const resetsAt: string = fixtureReading
        ? JSON.parse(fixtureReading.body).resetsAt
        : new Date(now + (provider === 'codex' ? 6 * 86400_000 : 300 * 60_000)).toISOString();
      store.setSetting(
        `capacity:v1:${provider}`,
        parseCapacity(
          provider,
          [
            {
              provider,
              source: 'oauth',
              usage: {
                updatedAt: new Date(now).toISOString(),
                ...(provider === 'codex'
                  ? {
                      primary: {
                        usedPercent: 50,
                        windowMinutes: 300,
                        resetsAt: new Date(now + 300 * 60_000).toISOString(),
                      },
                    }
                  : {}),
                [provider === 'codex' ? 'secondary' : 'primary']: {
                  usedPercent: 50,
                  windowMinutes: provider === 'codex' ? 10080 : 300,
                  resetsAt,
                },
              },
            },
          ],
          now,
        ),
      );
      store.setSetting(
        `quark:meter:${provider}:${provider === 'codex' ? 'secondary' : 'primary'}`,
        {
          observedAt: new Date(now).toISOString(),
          resetsAt,
          usedPercent: 50,
          scores: {},
          pending: {},
          unitsPerPercent: null,
          samples: 0,
        },
      );
      const insert = store.db.prepare(
        'INSERT OR IGNORE INTO quark_intervals(receipt,body) VALUES(?,?)',
      );
      const step = provider === 'codex' ? 2 : 5,
        count = 720 / step;
      for (let n = 0; n <= count; n++) {
        if (n >= 80 && n < 95) continue; // honest visible gap
        const at = now - (count - n) * step * 60_000;
        insert.run(
          `rate-ui:${provider}:${n}`,
          JSON.stringify({
            provider,
            windowId: provider === 'codex' ? 'secondary' : 'primary',
            label: provider === 'codex' ? 'Weekly' : 'Five-hour',
            resetsAt,
            observedAt: new Date(at).toISOString(),
            from: new Date(at - step * 60_000).toISOString(),
            baseline: n === 0,
            gap: n === 95,
            delta: 0.05,
            unattributed: 0,
            allocations: [
              { runId: project.managerId, projectId: project.id, taskIds: [], percent: 0.05 },
            ],
          }),
        );
      }
    }
  } finally {
    store.close();
  }
  // Reproduce earlier browser scenarios saving a different hourly window first.
  const priorResponse = await page.request.post('/api/quark/budgets', {
    headers: { Origin: baseURL! },
    data: {
      key: crypto.randomUUID(),
      projectId: priorProject.id,
      taskId: null,
      provider: 'codex',
      windowId: 'primary',
      period: 'hour',
      enabled: true,
      limitPercent: 4,
    },
  });
  expect(priorResponse.ok(), await priorResponse.text()).toBe(true);
  const before = await (await page.request.get('/api/quark')).json();
  const priorBudget = before.budgets.find(
    (b: { projectId: string }) => b.projectId === priorProject.id,
  );
  expect(priorBudget).toMatchObject({ windowId: 'primary', limitPercent: 4, enabled: true });
  expect(before.budgets.filter((b: { projectId: string }) => b.projectId === project.id)).toEqual(
    [],
  );
  const policy = (await (await page.request.get('/api/pulsar')).json()).policy;
  expect(
    (
      await page.request.post('/api/pulsar/policy', {
        headers: { Origin: baseURL! },
        data: {
          key: crypto.randomUUID(),
          policy: {
            ...policy,
            enabled: false,
            providerReserves: {
              codex: { reservePercent: 20, releaseEnabled: false, releaseBeforeResetMinutes: 720 },
              claude: { reservePercent: 20, releaseEnabled: false, releaseBeforeResetMinutes: 45 },
            },
          },
        },
      })
    ).ok(),
  ).toBe(true);
  let finishDelay: (() => void) | undefined;
  try {
    const extra = Array.from({ length: 8 }, (_, n) => ({
      id: crypto.randomUUID(),
      name: `Additional project ${n + 1}`,
    }));
    await page.route('**/api/snapshot', async (route) => {
      const response = await route.fetch(),
        body = await response.json();
      body.projects = [project, ...extra.map((item) => ({ ...project, ...item }))];
      await route.fulfill({ response, json: body });
    });
    await page.route('**/api/quark/coordinator', async (route) => {
      const response = await route.fetch(),
        body = await response.json();
      const template = body.projects.find((p: { id: string }) => p.id === project.id);
      body.projects = [template, ...extra.map((item) => ({ ...template, ...item }))];
      await route.fulfill({ response, json: body });
    });
    await page.goto('/#/work');
    const reserves = page.getByRole('region', { name: 'Shared provider reserves' });
    const reserve = page.getByRole('slider', { name: 'Codex shared reserve', exact: true });
    await expect(reserve).toBeVisible();
    await move(reserve, 0);
    await expect(
      page.getByRole('region', { name: 'Codex shared reserve control' }).getByRole('status'),
    ).toHaveText('Saved');
    const afterReserve = await (await page.request.get('/api/pulsar')).json();
    expect(afterReserve.policy.providerReserves.codex.reservePercent).toBe(0);
    expect(afterReserve.policy.providerReserves.claude.reservePercent).toBe(20);
    expect(afterReserve.policy.providerReserves.codex.releaseEnabled).toBe(false);
    expect(afterReserve.policy.enabled).toBe(false); // saving a reserve never enables pacing
    const card = page.locator(`#quark-project-${project.id}`);
    const providerRate = card.getByRole('region', { name: 'Codex project rate' });
    const slider = providerRate.getByRole('slider', { name: 'Codex project rate limit' });
    await expect(providerRate.locator('select')).toHaveValue('secondary');
    await expect(providerRate.getByText('Saved rate · Weekly', { exact: true })).toBeVisible();
    const writes: Record<string, unknown>[] = [];
    let loseReply = true,
      delayNext = false;
    await page.route('**/api/quark/budgets', async (route) => {
      writes.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (delayNext) {
        delayNext = false;
        await new Promise<void>((done) => {
          finishDelay = done;
        });
      }
      if (loseReply) {
        loseReply = false;
        return route.fulfill({ status: 502, json: { error: 'Rate save response lost' } });
      }
      return route.fulfill({ response });
    });
    await slider.scrollIntoViewIfNeeded();
    await move(slider, 4, false);
    await move(slider, 3, false);
    expect(writes).toHaveLength(0); // no save for every pixel
    await slider.dispatchEvent('pointerup');
    await expect(providerRate.getByRole('alert')).toContainText('Rate save response lost');
    await providerRate.getByRole('button', { name: 'Retry rate save' }).click();
    await expect(providerRate.getByRole('alert')).toHaveCount(0);
    await expect(providerRate.getByRole('status')).toHaveText('Saved');
    expect(writes[0]).toEqual(writes[1]);
    expect(writes[0]).toMatchObject({
      provider: 'codex',
      windowId: 'secondary',
      period: 'hour',
      limitPercent: 3,
      enabled: true,
    });
    const exactRate = providerRate.getByRole('spinbutton', {
      name: 'Codex rate value (% per hour)',
    });
    for (const invalid of ['', '101', '1.25']) {
      await exactRate.fill(invalid);
      await exactRate.press('Tab');
      await expect(providerRate.getByRole('status')).toContainText('Enter a rate from 0 to 100');
      expect(writes).toHaveLength(2);
    }
    await exactRate.fill('5');
    await exactRate.press('Enter');
    await expect(providerRate.getByRole('status')).toHaveText('Saved');
    await exactRate.fill('2');
    await exactRate.press('Enter');
    await expect(providerRate.getByRole('status')).toHaveText('Saved');
    expect(writes.at(-1)?.limitPercent).toBe(2);
    await expect(slider).toHaveValue('2');
    delayNext = true;
    await move(slider, 3);
    await expect(providerRate.getByRole('status')).toHaveText('Saving…');
    await expect.poll(() => !!finishDelay).toBe(true);
    await move(slider, 0);
    finishDelay!();
    await expect(
      providerRate.getByText('Codex paused for this project.', { exact: false }),
    ).toBeVisible();
    await expect(providerRate.getByRole('status')).toHaveText('Saved');
    const current = (await (await page.request.get('/api/quark')).json()).budgets.find(
      (b: { projectId: string; provider: string; period: string }) =>
        b.projectId === project.id && b.provider === 'codex' && b.period === 'hour',
    );
    expect(current.limitPercent).toBe(0);
    const claudeReserve = page.getByRole('region', { name: 'Claude shared reserve control' });
    await claudeReserve.getByText('Optional timed release', { exact: true }).click();
    await claudeReserve.getByRole('checkbox').check();
    await claudeReserve.getByRole('spinbutton').fill('30');
    await claudeReserve.getByRole('button', { name: 'Save reserve settings' }).click();
    await expect(claudeReserve.getByRole('status')).toHaveText('Saved');
    await page.reload();
    await expect(slider).toHaveValue('0');
    await expect(reserve).toHaveValue('0');
    await claudeReserve.getByText('Optional timed release', { exact: true }).click();
    await expect(claudeReserve.getByRole('checkbox')).toBeChecked();
    await expect(claudeReserve.getByRole('spinbutton')).toHaveValue('30');
    await move(slider, 2);
    await expect(providerRate.getByRole('status')).toHaveText('Saved');
    await expect(slider).toHaveValue('2');
    await expect(
      card.getByRole('img', { name: /Estimated project usage over the last 12 hours/ }),
    ).toHaveCount(2);
    await expect(providerRate.getByText(/min observed/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Show all 9 projects' }).click();
    await expect(page.locator('.quark-project-card')).toHaveCount(9);
    await expect(
      page.locator('.quark-project-card').nth(1).getByText('History not yet available'),
    ).toHaveCount(2);
    await page.addStyleTag({
      content: ':root { --text-small:20px; --text-caption:17px; --text-lead:24px; }',
    });
    for (const control of [reserve, slider, card.locator('svg').first()]) {
      await control.scrollIntoViewIfNeeded();
      const bounds = (await control.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 1440) + 1);
    }
    await expect(reserves).toBeAttached();
    await reserve.scrollIntoViewIfNeeded();
    await page
      .getByRole('region', { name: 'Codex shared reserve control' })
      .screenshot({ path: `../../data/quark-rate-evidence/${info.project.name}-reserve.png` });
    await reserves.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({
      path: `../../data/quark-rate-evidence/${info.project.name}-reserve-viewport.png`,
    });
    await page
      .getByRole('heading', { name: 'Project usage rates' })
      .evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({
      path: `../../data/quark-rate-evidence/${info.project.name}-project-viewport.png`,
    });
    await reserves.getByRole('button', { name: 'Enable shared protection' }).click();
    await expect(reserves.getByText('Shared protection is on.', { exact: true })).toBeVisible();
    const enabledPolicy = (await (await page.request.get('/api/pulsar')).json()).policy;
    expect(enabledPolicy.enabled).toBe(true);
    expect(enabledPolicy.providerReserves).toMatchObject({
      codex: { reservePercent: 0 },
      claude: { reservePercent: 20, releaseEnabled: true, releaseBeforeResetMinutes: 30 },
    });
    await providerRate.scrollIntoViewIfNeeded();
    await providerRate.screenshot({
      path: `../../data/quark-rate-evidence/${info.project.name}-project.png`,
    });
    const after = await (await page.request.get('/api/quark')).json();
    expect(after.budgets.find((b: { id: string }) => b.id === priorBudget.id)).toMatchObject({
      revision: priorBudget.revision,
      windowId: 'primary',
      limitPercent: 4,
      enabled: true,
    });
  } finally {
    finishDelay?.();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});
