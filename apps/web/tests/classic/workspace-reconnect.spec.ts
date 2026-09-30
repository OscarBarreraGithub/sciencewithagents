import { test, expect } from './fixture';
import { randomUUID } from 'node:crypto';

test('failed automatic restoration has an explicit no-turn retry with per-conversation outcomes', async ({
  page,
}, info) => {
  const headers = { Origin: 'http://127.0.0.1:4339' };
  const projectReply = await page.request.post('/api/projects', {
    headers,
    data: { key: randomUUID(), name: `Reconnect ${info.project.name}`, description: '' },
  });
  expect(projectReply.status()).toBe(201);
  const project = await projectReply.json();
  const managerIds = [project.managerId];
  for (let index = 1; index < 5; index++) {
    const reply = await page.request.post(`/api/projects/${project.id}/managers`, {
      headers,
      data: { key: randomUUID(), name: `Saved module ${index}`, scope: 'Saved test module' },
    });
    expect(reply.status()).toBe(201);
    const manager = await reply.json();
    managerIds.push(manager.id);
  }
  const registered = await (
    await page.request.post('/api/workspace/clients', {
      headers,
      data: { key: randomUUID(), label: 'Saved five conversations' },
    })
  ).json();
  let saved = registered;
  for (const agentId of managerIds) {
    saved = (
      await (
        await page.request.post(`/api/workspace/${saved.client.id}`, {
          headers,
          data: {
            key: randomUUID(),
            hostId: saved.hostId,
            revision: saved.client.revision,
            action: { kind: 'open', agentId },
          },
        })
      ).json()
    ).state;
  }
  await page.addInitScript(
    ({ clientId, selected }) => {
      localStorage.setItem('dock:local:workspace:client', clientId);
      localStorage.setItem('dock:local:selected', selected);
    },
    { clientId: saved.client.id, selected: saved.client.selectedAgentId },
  );
  let attempts = 0;
  let turns = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/agents\/[^/]+\/(messages|commands)$/.test(new URL(request.url()).pathname)
    )
      turns++;
  });
  await page.route('**/api/workspace/*/restore', async (route) => {
    attempts++;
    expect(route.request().postDataJSON()).toEqual({ hostId: saved.hostId });
    if (attempts === 1) return route.abort('failed');
    if (attempts === 2)
      return route.fulfill({
        json: managerIds.map((agentId, index) => ({
          agentId,
          state: index === 0 ? 'unavailable' : 'inspect',
          message:
            index === 0
              ? 'History is retained. Check this computer’s Codex connection and retry.'
              : 'Same conversation reconnected. Inspect interrupted work before continuing.',
        })),
      });
    return route.continue();
  });
  await page.goto('/');
  await expect(
    page.getByText('Your saved conversations need a connection retry.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect saved conversations', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Open conversations' });
  await dialog.getByRole('button', { name: 'Reconnect saved conversations', exact: true }).click();
  const results = dialog.getByRole('region', { name: 'Conversation connection results' });
  await expect(results.getByRole('listitem')).toHaveCount(5);
  await expect(results).toContainText('History is retained. Check this computer');
  await expect(results).toContainText('Inspect interrupted work before continuing.');
  await expect(results).toContainText('Saved module 4');
  await dialog.getByRole('button', { name: 'Reconnect saved conversations', exact: true }).click();
  await expect(results.getByRole('listitem')).toHaveCount(5);
  await expect(results.getByText('Ready for your first message.', { exact: false })).toHaveCount(5);
  await expect(
    page.getByText('Your saved conversations need a connection retry.', { exact: false }),
  ).toHaveCount(0);
  expect(attempts).toBe(3);
  expect(turns).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.screenshot({
    path: `../../data/screenshots/${info.project.name}-workspace-reconnect.png`,
  });
  for (const agentId of managerIds) {
    const detail = await (await page.request.get(`/api/agents/${agentId}`)).json();
    expect(detail.runs).toEqual([]);
    expect(detail.agent.threadId).toBeUndefined(); // Private provider identities do not cross this UI API.
  }
});
