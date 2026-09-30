import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  projectSchema,
  quarkFocusSchema,
  quarkFocusStatusSchema,
  quarkProjectPolicySchema,
  type ConversationSearchResult,
  type QuarkFocusRecord,
} from '@dock/shared';

async function write(page: Page, path: string, data: unknown) {
  const response = await page.request.post(`/api${path}`, {
    headers: { origin: 'http://127.0.0.1:4339' },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function project(page: Page, name: string) {
  return projectSchema.parse(
    await write(page, '/projects', { key: randomUUID(), name, provider: 'codex' }),
  );
}

async function policy(page: Page, id: string) {
  const response = await page.request.get(`/api/projects/${id}/quark`);
  expect(response.ok()).toBe(true);
  return quarkProjectPolicySchema.parse(await response.json());
}

async function focusStatus(page: Page) {
  const response = await page.request.get('/api/quark/focus');
  expect(response.ok()).toBe(true);
  return quarkFocusStatusSchema.parse(await response.json());
}

test('focus pause and release recover the same real receipts after lost responses and reloads', async ({
  page,
}, info) => {
  const suffix = `${info.project.name} ${randomUUID().slice(0, 8)}`;
  const owner = await project(page, `Focus ${suffix}`);
  const held = await project(page, `Already paused ${suffix}`);
  const peer = await project(page, `Other project ${suffix}`);
  expect((await focusStatus(page)).active).toBeNull();
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);
  });

  try {
    // Establish a real preexisting pause using only public owner controls. A later policy
    // revision owns this project's pause, so ending the setup focus must leave it intact.
    const setup = quarkFocusSchema.parse(
      await write(page, '/quark/focus', { key: randomUUID(), projectId: owner.id }),
    );
    const paused = await policy(page, held.id);
    const heldPolicy = quarkProjectPolicySchema.parse(
      await write(page, `/projects/${held.id}/quark`, {
        key: randomUUID(),
        expectedRevision: paused.revision,
        priority: 'background',
      }),
    );
    await write(page, '/quark/focus/release', { key: randomUUID(), focusId: setup.id });
    expect(heldPolicy.paused).toBe(true);
    expect(await policy(page, held.id)).toEqual(heldPolicy);
    expect((await policy(page, peer.id)).paused).toBe(false);
    const ownerPolicy = await policy(page, owner.id);

    const starts: { key: string; projectId: string }[] = [];
    const startReceipts: QuarkFocusRecord[] = [];
    await page.route('**/api/quark/focus', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      starts.push(route.request().postDataJSON());
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      startReceipts.push(quarkFocusSchema.parse(await response.json()));
      return starts.length === 1
        ? route.fulfill({ status: 502, json: { error: 'Focus confirmation lost.' } })
        : route.fulfill({ response });
    });
    const releases: { key: string; focusId: string }[] = [];
    const releaseReceipts: QuarkFocusRecord[] = [];
    await page.route('**/api/quark/focus/release', async (route) => {
      releases.push(route.request().postDataJSON());
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      releaseReceipts.push(quarkFocusSchema.parse(await response.json()));
      return releases.length === 1
        ? route.fulfill({ status: 502, json: { error: 'Release confirmation lost.' } })
        : route.fulfill({ response });
    });

    await page.goto(`/#/chat/${owner.managerId}`);
    await page.getByRole('button', { name: 'Configure', exact: true }).click();
    const card = page.getByRole('complementary', { name: 'Configuration' }).locator('.focus-card');
    await card.getByRole('button', { name: 'Pause other projects', exact: true }).click();
    await expect(card.getByRole('alert')).toContainText('Focus confirmation lost');
    const active = (await focusStatus(page)).active!;
    expect(active.id).toBe(startReceipts[0].id);
    expect(active.projects.find((p) => p.projectId === held.id)?.pausedRevision).toBeNull();
    expect(active.projects.find((p) => p.projectId === peer.id)?.pausedRevision).toBeGreaterThan(0);
    expect(await policy(page, owner.id)).toEqual(ownerPolicy);
    expect(await policy(page, held.id)).toEqual(heldPolicy);
    expect((await policy(page, peer.id)).paused).toBe(true);

    // A retry must retain the captured project set, not pause newly created work.
    const later = await project(page, `Created during focus ${suffix}`);
    await page.reload();
    await page.getByRole('button', { name: 'Configure', exact: true }).click();
    await expect(card.getByRole('status')).toContainText('Your request to pause other projects');
    expect(starts).toHaveLength(1);
    await card.getByRole('button', { name: 'Check this request', exact: true }).click();
    await expect(card.getByRole('status')).toContainText('Other projects are paused');
    expect(starts).toHaveLength(2);
    expect(starts[1]).toEqual(starts[0]);
    expect(startReceipts[1]).toEqual(startReceipts[0]);
    expect(startReceipts[1].projects.some((p) => p.projectId === later.id)).toBe(false);
    expect((await policy(page, later.id)).paused).toBe(false);
    await expect(card.getByRole('status')).toContainText('already paused');

    await card.getByRole('button', { name: 'Return to normal', exact: true }).click();
    await expect(card.getByRole('alert')).toContainText('Release confirmation lost');
    expect((await focusStatus(page)).active).toBeNull();
    await page.reload();
    await page.getByRole('button', { name: 'Configure', exact: true }).click();
    await expect(card.getByRole('status')).toContainText('Your request to return to normal');
    expect(releases).toHaveLength(1);
    await card.getByRole('button', { name: 'Check this request', exact: true }).click();
    await expect(card.getByRole('status')).toContainText('Back to normal since');
    expect(releases).toHaveLength(2);
    expect(releases[1]).toEqual(releases[0]);
    expect(releaseReceipts[1]).toEqual(releaseReceipts[0]);
    expect(releaseReceipts[1].projects.find((p) => p.projectId === peer.id)?.restored).toBe(true);
    expect(releaseReceipts[1].projects.find((p) => p.projectId === held.id)?.restored).toBe(false);
    expect(await policy(page, held.id)).toEqual(heldPolicy);
    expect((await policy(page, peer.id)).paused).toBe(false);
    expect(await policy(page, owner.id)).toEqual(ownerPolicy);
    expect((await policy(page, later.id)).paused).toBe(false);
    expect(writes.filter((path) => /\/(messages|commands|coordinator\/start)$/.test(path))).toEqual(
      [],
    );
    for (const item of [owner, held, peer, later]) {
      const detail = await (await page.request.get(`/api/agents/${item.managerId}`)).json();
      expect(detail.runs).toEqual([]);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await card.locator('.focus-result').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `../../data/screenshots/focus-search/${info.project.name}-focus.png`,
    });
  } finally {
    // Only release a focus owned by this test; never leave other projects paused after a failure.
    const active = (await focusStatus(page)).active;
    if (active?.projectId === owner.id)
      await write(page, '/quark/focus/release', { key: randomUUID(), focusId: active.id });
  }
});

test('assisted search starts only explicitly, reloads its saved result and only navigates matched chats', async ({
  page,
}, info) => {
  const owner = await project(
    page,
    `Search match ${info.project.name} ${randomUUID().slice(0, 8)}`,
  );
  const before = await (await page.request.get(`/api/agents/${owner.managerId}`)).json();
  const query = 'the conversation about sample storage';
  const result: ConversationSearchResult = {
    id: randomUUID(),
    agentId: randomUUID(),
    runId: randomUUID(),
    query,
    provider: 'codex',
    model: 'demo',
    effort: 'low',
    status: 'completed',
    createdAt: new Date().toISOString(),
    coverage: {
      projectsConsidered: 1,
      projectsAvailable: 1,
      managedCandidates: 1,
      editorCandidates: 0,
      bounded: true,
      editorTranscripts: false,
      notice: 'Search uses bounded saved excerpts. Editor conversations have title-only evidence.',
    },
    candidates: [
      {
        id: owner.managerId,
        kind: 'managed',
        provider: 'codex',
        title: before.agent.name,
        project: owner.name,
        href: `#/chat/${owner.managerId}`,
        excerpt: 'The saved discussion concerns sample storage.',
        evidence: 'saved-excerpts',
      },
    ],
    report: `The closest saved conversation is [${owner.name}](#/chat/${owner.managerId}). Check its saved discussion before continuing.`,
    reportTruncated: false,
    message: 'The helper finished comparing the available saved conversations.',
  };
  const submissions: { key: string; query: string; provider: string }[] = [];
  let reads = 0;
  // DemoProvider does not rank conversations. Fixture only the helper transport; the linked
  // conversation, its history and navigation still use the actual demo API.
  await page.route('**/api/conversations/search', async (route) => {
    expect(route.request().method()).toBe('POST');
    submissions.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        ...result,
        status: 'queued',
        report: null,
        message: 'Waiting for the search helper.',
      },
    });
  });
  await page.route(`**/api/conversations/search/${result.id}`, async (route) => {
    expect(route.request().method()).toBe('GET');
    reads++;
    await route.fulfill({ json: result });
  });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);
  });

  await page.goto('/#/chats');
  await page.getByRole('textbox', { name: 'Find a conversation', exact: true }).fill(query);
  await page.getByRole('button', { name: 'Assisted search', exact: true }).click();
  const helper = page.getByRole('radiogroup', { name: 'Search helper' });
  await helper.getByRole('radio', { name: /^Codex/ }).click();
  await page.getByRole('button', { name: 'Hide assisted search', exact: true }).click();
  await page.getByRole('button', { name: 'Assisted search', exact: true }).click();
  expect(submissions).toEqual([]);
  expect(reads).toBe(0);
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: `Search for “${query}”`, exact: true }).click();
  const reply = page.getByRole('region', { name: 'Assisted search result', exact: true });
  await expect(reply).toContainText('Finished');
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({ query, provider: 'codex' });
  expect(submissions[0].key).toMatch(/^[0-9a-f-]{36}$/);
  const firstReads = reads;
  expect(firstReads).toBeGreaterThan(0);

  await page.reload();
  await expect(reply).toContainText('Finished');
  await expect(reply).toContainText(query);
  expect(reads).toBeGreaterThan(firstReads);
  expect(submissions).toHaveLength(1);
  const link = reply.locator('.assisted-search-links').first().getByRole('link');
  await expect(link).toHaveAttribute('href', `#/chat/${owner.managerId}`);
  await expect(link).toContainText(before.agent.name);
  await link.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/screenshots/focus-search/${info.project.name}-search.png`,
  });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${owner.managerId}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(before.agent.name);
  const after = await (await page.request.get(`/api/agents/${owner.managerId}`)).json();
  expect(after.runs).toEqual(before.runs);
  expect(after.entries).toEqual(before.entries);
  // Opening a saved chat records its browser client/view, without sending model input.
  expect(
    writes.filter((path) => !/^\/api\/workspace\/(?:clients|[0-9a-f-]{36})$/.test(path)),
  ).toEqual(['/api/conversations/search']);
});
