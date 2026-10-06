import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { snapshotSchema } from '@dock/shared';

async function claudeChat(page: Page) {
  const response = await page.request.get('/api/snapshot');
  const state = snapshotSchema.parse(await response.json());
  const manager = state.agents.find(
    (agent) => agent.id === state.projects.find((project) => !project.internal)!.managerId,
  )!;
  manager.provider = 'claude';
  manager.status = 'idle';
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: state }));
  await page.route(new RegExp(`/api/agents/${manager.id}(?:\\?.*)?$`), async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    await route.fulfill({ json: { ...detail, agent: manager } });
  });
  await page.goto(`/#/chat/${manager.id}`);
  return {
    manager,
    composer: page.getByRole('textbox', { name: `Message ${manager.name}`, exact: true }),
  };
}

test('native commands retain the draft, retry the same receipt after reload, and reject unknown names locally', async ({
  page,
}) => {
  const { manager, composer } = await claudeChat(page);
  const requests: { key: string; text: string }[] = [];
  let reject = false;
  let lost = true;
  let malformed = false;
  let messages = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/messages')) messages++;
  });
  await page.route(`**/api/agents/${manager.id}/native-commands`, (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: {
          provider: 'claude',
          commands: ['compact', 'verify'],
          note: 'Native Claude commands.',
        },
      });
    requests.push(route.request().postDataJSON());
    if (malformed) return route.fulfill({ json: { ok: true } });
    return route.fulfill(
      reject
        ? {
            status: 409,
            json: { error: 'Unknown native command. No message was sent; your draft is retained.' },
          }
        : lost
          ? { status: 502, json: { error: 'Command response lost.' } }
          : {
              status: 202,
              json: {
                ...requests.at(-1),
                agentId: manager.id,
                run: {
                  id: randomUUID(),
                  agentId: manager.id,
                  sourceId: null,
                  text: requests.at(-1)!.text,
                  kind: 'user',
                  status: 'queued',
                  createdAt: new Date().toISOString(),
                },
              },
            },
    );
  });
  await composer.fill('/verify keep exact arguments');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Command response lost.', { exact: true }).first()).toBeVisible();
  await expect(composer).toHaveValue('/verify keep exact arguments');
  await page.reload();
  await expect(composer).toHaveValue('/verify keep exact arguments');
  lost = false;
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(composer).toHaveValue('/verify keep exact arguments');
  reject = true;
  await composer.fill('/missing');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page
      .getByText('Unknown native command. No message was sent; your draft is retained.', {
        exact: true,
      })
      .first(),
  ).toBeVisible();
  await expect(composer).toHaveValue('/missing');
  expect(messages).toBe(0);
  await composer.fill('Keep this unsent draft');
  await page.getByRole('button', { name: 'Show commands', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Session commands', exact: true });
  await expect(
    menu.getByRole('button', { name: '/verify Run in Claude', exact: true }),
  ).toBeVisible();
  reject = false;
  malformed = true;
  await menu.getByRole('button', { name: '/verify Run in Claude', exact: true }).click();
  await expect.poll(() => requests.length).toBe(4);
  expect(requests[3]!.text).toBe('/verify');
  await expect(
    page
      .getByText(
        'The computer returned an incomplete command acknowledgement. Its original receipt and draft are retained.',
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await expect(composer).toHaveValue('Keep this unsent draft');
  malformed = false;
  await page.getByRole('button', { name: 'Show commands', exact: true }).click();
  await menu.getByRole('button', { name: '/verify Run in Claude', exact: true }).click();
  await expect.poll(() => requests.length).toBe(5);
  expect(requests[4]).toEqual(requests[3]);
  await page.getByRole('button', { name: 'Show commands', exact: true }).click();
  await expect(menu.getByRole('button', { name: /compact/ })).toHaveCount(1);
  await menu.getByRole('button', { name: '/compact Compact context', exact: true }).click();
  await expect.poll(() => requests.length).toBe(6);
  expect(requests[5]!.text).toBe('/compact');
  await expect(page).toHaveURL(new RegExp(`#/chat/${manager.id}$`));
  await expect(composer).toHaveValue('Keep this unsent draft');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('an older host without command discovery keeps chat and the composer available', async ({
  page,
}) => {
  const { manager, composer } = await claudeChat(page);
  await page.route(`**/api/agents/${manager.id}/native-commands`, (route) =>
    route.fulfill({ status: 404, json: { error: 'Unknown route' } }),
  );
  await composer.fill('Draft on an older computer');
  await page.getByRole('button', { name: 'Show commands', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Session commands', exact: true });
  await expect(menu).toContainText(
    'Native command discovery is unavailable on this computer. Existing chat and app controls still work.',
  );
  await menu.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(composer).toHaveValue('Draft on an older computer');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await composer.fill('/unsupported');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Unknown route', { exact: true }).first()).toBeVisible();
  await composer.fill('A normal message remains writable');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
});
