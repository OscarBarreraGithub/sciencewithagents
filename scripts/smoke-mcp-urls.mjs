// Bounded real-provider URL flow: a local fake step, never real authentication.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Store } from '../apps/server/dist/store.js';
import { Runtime } from '../apps/server/dist/runtime.js';
import { createServer } from '../apps/server/dist/server.js';
import { git } from '../apps/server/dist/workspaces.js';
if (!process.argv.includes('--run')) throw new Error('Pass --run for two bounded URL turns.');
const native = process.argv.includes('--native'),
  continuing = process.argv.includes('--continue'),
  previous = native || continuing ? process.argv[2] : null;
if ((native || continuing) && !/^[a-f0-9]{8}$/.test(previous ?? ''))
  throw new Error('Reuse a retained URL fixture: <fixture-id> --run --native or --continue.');
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
process.umask(0o077);
const fixture = previous ?? randomUUID().slice(0, 8),
  root = resolve('data/smoke', fixture),
  projectRoot = join(root, 'project'),
  callsPath = join(root, 'mcp-calls.txt');
console.log(`MCP URL fixture: ${fixture}`);
if (previous) assert(existsSync(join(root, 'dock.sqlite')), 'The retained URL fixture must exist.');
else {
  mkdirSync(projectRoot, { recursive: true });
  await git(projectRoot, ['init', '-b', 'main']);
  await git(projectRoot, ['config', 'user.name', 'Agent Dock Smoke']);
  await git(projectRoot, ['config', 'user.email', 'smoke@example.invalid']);
  writeFileSync(join(projectRoot, 'README.md'), '# Harmless MCP URL fixture\n');
  await git(projectRoot, ['add', 'README.md']);
  await git(projectRoot, ['commit', '-m', 'Fixture']);
}
process.env.DOCK_MCP_FIXTURE = root;
process.env.DOCK_MCP_URLS = '1';
const binary = resolve('scripts/fixtures/codex-mcp.mjs');
let store = new Store(join(root, 'dock.sqlite'));
const project = store.register(projectRoot, 'URL smoke', 'Harmless local URL flow verification.');
const worker = previous
  ? store.agents().find((agent) => agent.name === 'URL fixture reader' && agent.threadId)
  : store.addAgent({
      projectId: project.id,
      parentId: null,
      taskId: null,
      role: 'researcher',
      name: 'URL fixture reader',
      cwd: projectRoot,
    });
assert(worker && (worker.status === 'idle' || (continuing && worker.status === 'interrupted')));
assert(store.approvals().every((approval) => approval.status !== 'pending'));
store.updateAgent(worker.id, { mcpServers: ['dock_fixture'] });
const originalEntries = store.entries(worker.id);
if (previous) assert(originalEntries.length > 0);
const events = () =>
  existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
const oldEvents = events(),
  oldAllowed = originalEntries.filter((entry) => entry.title === 'URL request allowed').length;
if (continuing) {
  assert(oldEvents.length >= 2);
  assert.equal(oldEvents[1].result.action, 'decline');
  assert(
    originalEntries.some(
      (entry) => entry.kind === 'tool' && entry.text.includes('DOCK-URL-DECLINED'),
    ),
  );
  assert(
    store
      .runs()
      .filter((run) => run.agentId === worker.id)
      .every((run) => ['completed', 'interrupted'].includes(run.status)),
  );
  assert.equal(
    oldEvents.filter((event) => event.event === 'completed').length,
    0,
    'Inspect effects first; continuation is only for a fixture with no completed page step.',
  );
}
let runtime = new Runtime(store, root, binary),
  app,
  browser;
const origin = 'http://127.0.0.1:4347';
const waitFor = async (predicate, message, deadline = Date.now() + 120_000) => {
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 200));
  assert(predicate(), message);
};
const openWorker = async (viewport) => {
  const page = await browser.newPage({ viewport });
  await page.goto(origin);
  if (viewport.width < 1191) await page.getByRole('button', { name: 'Open team' }).click();
  await page.getByRole('button', { name: /URL fixture reader Researcher/ }).click();
  return page;
};
try {
  await runtime.initialize();
  await runtime.attach(worker.id);
  runtime.health = {
    ready: true,
    version: 'Installed Codex',
    message: 'Isolated local URL fixture',
  };
  app = await createServer(store, runtime, { port: 4347, webDir: resolve('apps/web/dist') });
  await app.listen({ host: '127.0.0.1', port: 4347 });
  browser = await chromium.launch();
  for (const decision of previous ? ['accept'] : ['decline', 'accept']) {
    const prompt =
      'Call dock_fixture complete_local_step exactly once. It asks the owner to complete a harmless local page step. Wait for the original URL response and tool result, then report the exact returned marker. If declined, stop without retrying. Do not open the URL yourself, call other tools, run commands, write files, use external services, or spawn agents.';
    let run, desktop;
    if (native) {
      const oldRuns = new Set(store.runs().map((value) => value.id));
      desktop = await openWorker({ width: 1440, height: 1000 });
      await desktop.getByRole('button', { name: 'Native terminal', exact: true }).click();
      await desktop
        .getByText('Native Codex · connected', { exact: true })
        .waitFor({ timeout: 25_000 });
      await desktop.locator('.xterm-helper-textarea').focus();
      await desktop.keyboard.type(prompt, { delay: 20 });
      await desktop.waitForTimeout(500);
      await desktop.keyboard.press('Enter');
      await waitFor(
        () =>
          (run = store
            .runs()
            .find((value) => value.agentId === worker.id && !oldRuns.has(value.id))),
        'Native input must create a tracked run.',
        Date.now() + 20_000,
      );
      console.log('Submitted one native URL turn through the browser terminal.');
    } else {
      run = store.enqueue(worker.id, randomUUID(), prompt);
      runtime.kick();
    }
    const deadline = Date.now() + 120_000;
    let consent, request;
    const nextRequest = () => {
      const pending = store.approvals().find((value) => value.status === 'pending');
      assert(
        pending || ['queued', 'running'].includes(store.run(run.id).status),
        'The run ended before the expected request; inspect its retained result, not the timeout.',
      );
      return pending;
    };
    await waitFor(() => (consent = nextRequest()), 'Expected original tool consent.', deadline);
    assert.equal(consent.kind, 'mcp');
    assert.equal(consent.params.serverName, 'dock_fixture');
    await runtime.approve(consent.id, 'accept');
    await waitFor(() => (request = nextRequest()), 'Expected original URL request.', deadline);
    assert.equal(request.kind, 'mcp_url');
    assert.equal(request.urlRequest.serverName, 'dock_fixture');
    const requestEvents = () =>
      events().filter((event) => event.id === request.params.elicitationId);
    assert.equal(requestEvents().filter((event) => event.event === 'requested').length, 1);
    assert.equal(requestEvents().length, 1, 'Nothing may open or answer the URL automatically.');
    if (native) {
      await expect(
        desktop.getByRole('button', { name: 'URL request needs your input — open Conversation' }),
      ).toBeVisible();
      await desktop.screenshot({ path: join(root, 'native-pending-url.png') });
      await desktop.getByRole('button', { name: 'Conversation', exact: true }).click();
    } else desktop = await openWorker({ width: 1440, height: 1000 });
    await expect(desktop.locator('.approval-card')).toContainText('Complete a local fixture step');
    await desktop.reload();
    assert.equal(store.approval(request.id).status, 'pending');
    if (decision === 'decline') {
      await desktop.getByRole('button', { name: 'Decline', exact: true }).click();
    } else {
      const pages = [];
      for (const [name, width, height] of [
        ['phone', 412, 915],
        ['small-phone', 360, 800],
        ['landscape', 915, 412],
      ]) {
        const page = await openWorker({ width, height });
        await expect(page.locator('.approval-card')).toContainText('not a hosted phone link');
        await expect(
          page.locator('.approval-card').getByRole('link', { name: 'Open requested page' }),
        ).toHaveAttribute('href', request.urlRequest.url);
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${name} overflow`,
        );
        await page
          .locator('.approval-card')
          .screenshot({ path: join(root, `${name}-pending-url.png`) });
        pages.push(page);
      }
      const phone = pages[0],
        popupPromise = phone.waitForEvent('popup');
      await phone
        .locator('.approval-card')
        .getByRole('link', { name: 'Open requested page' })
        .click();
      const popup = await popupPromise;
      await expect(popup.getByRole('heading')).toHaveText('Local URL fixture');
      assert.equal(await popup.evaluate(() => window.opener), null);
      assert.equal(await popup.evaluate(() => document.referrer), '');
      assert.equal(
        store.approval(request.id).status,
        'pending',
        'Opening the page is not consent.',
      );
      assert.equal(requestEvents().filter((event) => event.event === 'completed').length, 0);
      await popup.close();
      await phone.getByRole('button', { name: 'Allow URL request', exact: true }).click();
      await expect(desktop.locator('.approval-card')).toHaveCount(0);
      await waitFor(
        () => requestEvents().some((event) => event.event === 'reply'),
        'Original URL response must reach the server.',
        Date.now() + 5000,
      );
      assert.equal(store.approval(request.id).status, 'accepted');
      assert.equal(
        requestEvents().filter((event) => event.event === 'completed').length,
        0,
        'Acceptance is not completion.',
      );
      assert.equal(store.run(run.id).status, 'running');
      await desktop.reload();
      const retained = desktop
        .locator('.system-entry')
        .filter({ hasText: 'URL request allowed' })
        .last();
      await expect(retained).toContainText('not successful sign-in or completion');
      const resumedPopup = desktop.waitForEvent('popup');
      await retained.getByRole('link', { name: 'Open requested page' }).click();
      const continuation = await resumedPopup;
      await continuation.getByRole('button', { name: 'Complete fixture step' }).click();
      await expect(continuation.getByRole('heading')).toHaveText('Fixture step completed');
      await continuation.close();
      for (const page of pages) await page.close();
    }
    await waitFor(
      () => store.approval(request.id).status !== 'pending',
      'The browser must decide first.',
      Date.now() + 5000,
    );
    assert.equal(
      store.approval(request.id).status,
      decision === 'accept' ? 'accepted' : 'declined',
    );
    await runtime.approve(request.id, decision);
    await waitFor(
      () => !['queued', 'running'].includes(store.run(run.id).status),
      'Expected URL turn completion.',
      deadline,
    );
    assert.equal(store.run(run.id).status, 'completed');
    assert(
      store
        .entries(worker.id)
        .some(
          (entry) =>
            entry.runId === run.id &&
            entry.kind === 'tool' &&
            entry.text.includes(decision === 'accept' ? 'DOCK-URL-COMPLETED' : 'DOCK-URL-DECLINED'),
        ),
    );
    assert.equal(requestEvents().filter((event) => event.event === 'reply').length, 1);
    const reply = requestEvents().find((event) => event.event === 'reply').result;
    assert.equal(reply.action, decision);
    // App Server omits null on decline and normalizes accepted empty content to {}.
    assert.deepEqual(reply.content ?? {}, {});
    assert.equal(
      requestEvents().filter((event) => event.event === 'completed').length,
      decision === 'accept' ? 1 : 0,
    );
    assert.equal(
      requestEvents().filter((event) => event.event === 'visit').length,
      decision === 'accept' ? 2 : 0,
    );
    assert(
      requestEvents()
        .filter((event) => event.event === 'visit')
        .every((event) => event.referrer === null),
    );
    console.log(
      `Real URL ${decision}: original consent, distinct page visit/decision/effect and new-run-owned result verified.`,
    );
    if (native) {
      await desktop.getByRole('button', { name: 'Native terminal', exact: true }).click();
      await desktop
        .getByText('Native Codex · connected', { exact: true })
        .waitFor({ timeout: 25_000 });
      await desktop.getByRole('button', { name: 'Return to chat', exact: true }).click();
    }
    await desktop.close();
  }
  assert.deepEqual(events().slice(0, oldEvents.length), oldEvents);
  assert.deepEqual(store.entries(worker.id).slice(0, originalEntries.length), originalEntries);
  assert.equal(
    store.entries(worker.id).filter((entry) => entry.title === 'URL request allowed').length,
    oldAllowed + 1,
  );
  const entries = store.entries(worker.id),
    approvals = store.approvals(),
    threadId = store.agent(worker.id).threadId,
    verifiedEvents = events();
  await browser.close();
  browser = undefined;
  await app.close();
  app = undefined;
  store = new Store(join(root, 'dock.sqlite'));
  runtime = new Runtime(store, root, binary);
  await runtime.attach(worker.id);
  assert.equal(store.agent(worker.id).threadId, threadId);
  assert.deepEqual(store.entries(worker.id), entries);
  assert.deepEqual(store.approvals(), approvals);
  assert.deepEqual(events(), verifiedEvents);
  console.log(
    `PASS: ${native ? 'native-started URL acceptance' : 'URL decline/accept'}, phone/desktop handoff, one-time fake effect, exact archive and same-context restart. Fixture ${fixture}; agent ${worker.id}.`,
  );
} finally {
  await browser?.close();
  if (app) await app.close();
  else {
    await runtime.close();
    store.close();
  }
}
