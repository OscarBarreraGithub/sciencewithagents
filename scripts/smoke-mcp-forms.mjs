// Two explicit model turns; only a generated, harmless local MCP fixture is enabled.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Store } from '../apps/server/dist/store.js';
import { Runtime } from '../apps/server/dist/runtime.js';
import { createServer } from '../apps/server/dist/server.js';
import { git } from '../apps/server/dist/workspaces.js';
if (!process.argv.includes('--run')) throw new Error('Pass --run for two bounded MCP form turns.');
const native = process.argv.includes('--native');
const previous = native ? process.argv[2] : null;
if (native && !/^[a-f0-9]{8}$/.test(previous ?? ''))
  throw new Error(
    'Native verification reuses a successful form fixture: <fixture-id> --run --native.',
  );
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
process.umask(0o077);
const fixture = previous ?? randomUUID().slice(0, 8),
  root = resolve('data/smoke', fixture),
  projectRoot = join(root, 'project');
console.log(`MCP form fixture: ${fixture}`);
if (native)
  assert(existsSync(join(root, 'dock.sqlite')), 'The successful form fixture must exist.');
else mkdirSync(projectRoot, { recursive: true });
process.env.DOCK_MCP_FIXTURE = root;
process.env.DOCK_MCP_FORMS = '1';
if (!native) {
  await git(projectRoot, ['init', '-b', 'main']);
  await git(projectRoot, ['config', 'user.name', 'Agent Dock Smoke']);
  await git(projectRoot, ['config', 'user.email', 'smoke@example.invalid']);
  writeFileSync(join(projectRoot, 'README.md'), '# MCP form fixture\n');
  await git(projectRoot, ['add', 'README.md']);
  await git(projectRoot, ['commit', '-m', 'Fixture']);
}
const binary = resolve('scripts/fixtures/codex-mcp.mjs');
let store = new Store(join(root, 'dock.sqlite'));
const project = store.register(
  projectRoot,
  'Form smoke',
  'Explicit non-sensitive local form verification.',
);
const worker = native
  ? store.agents().find((agent) => agent.name === 'Form fixture reader' && agent.threadId)
  : store.addAgent({
      projectId: project.id,
      parentId: null,
      taskId: null,
      role: 'researcher',
      name: 'Form fixture reader',
      cwd: projectRoot,
    });
assert(worker && worker.status === 'idle', 'The existing worker must be idle.');
assert(
  store.approvals().every((approval) => approval.status !== 'pending'),
  'No previous request may be pending.',
);
store.updateAgent(worker.id, { mcpServers: ['dock_fixture'] });
const originalEntries = store.entries(worker.id);
if (native) assert(originalEntries.length > 0, 'Reuse retained real history.');
const callsPath = join(root, 'mcp-calls.txt');
const originalReplies = existsSync(callsPath)
  ? readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse)
  : [];
const originalSubmitted = store
  .entries(worker.id)
  .filter((entry) => entry.title === 'Form submitted to dock_fixture').length;
let runtime = new Runtime(store, root, binary),
  app,
  browser;
const origin = 'http://127.0.0.1:4346';
const values = {
  displayName: 'Fixture',
  count: 0,
  ratio: 0.5,
  enabled: false,
  mode: '',
  channels: ['web', 'cli'],
};
const waitFor = async (predicate, message, deadline) => {
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 200));
  assert(predicate(), message);
};
const openWorker = async (viewport) => {
  const page = await browser.newPage({ viewport });
  await page.goto(origin);
  if (viewport.width < 1191) await page.getByRole('button', { name: 'Open team' }).click();
  await page.getByRole('button', { name: /Form fixture reader Researcher/ }).click();
  return page;
};
try {
  await runtime.initialize();
  await runtime.attach(worker.id);
  runtime.health = {
    ready: true,
    version: 'Installed Codex',
    message: 'Connected to the isolated form fixture',
  };
  app = await createServer(store, runtime, { port: 4346, webDir: resolve('apps/web/dist') });
  await app.listen({ host: '127.0.0.1', port: 4346 });
  browser = await chromium.launch();
  for (const decision of native ? ['accept'] : ['decline', 'accept']) {
    const prompt =
      'Call dock_fixture collect_preferences exactly once. It asks the owner for non-sensitive fixture preferences. Wait for the form response, then report the exact returned marker. If declined, stop without retrying. Do not call other tools, run commands, write files, access external services, or spawn agents.';
    let run, desktop;
    if (native) {
      const oldRunIds = new Set(store.runs().map((run) => run.id));
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
          (run = store.runs().find((run) => run.agentId === worker.id && !oldRunIds.has(run.id))),
        'Native input must create a tracked run.',
        Date.now() + 20_000,
      );
      console.log('Submitted one native form turn through the real browser terminal.');
    } else {
      run = store.enqueue(worker.id, randomUUID(), prompt);
      runtime.kick();
    }
    const deadline = Date.now() + 120_000;
    let consent, form;
    await waitFor(
      () => (consent = store.approvals().find((approval) => approval.status === 'pending')),
      'Expected original tool consent.',
      deadline,
    );
    assert.equal(consent.kind, 'mcp');
    assert.equal(consent.params.serverName, 'dock_fixture');
    assert.deepEqual(consent.params._meta.tool_params, {});
    await runtime.approve(consent.id, 'accept');
    await waitFor(
      () => (form = store.approvals().find((approval) => approval.status === 'pending')),
      'Expected the original typed form.',
      deadline,
    );
    assert.equal(form.kind, 'mcp_form');
    assert.equal(form.params.serverName, 'dock_fixture');
    if (native) {
      await desktop.screenshot({ path: join(root, 'native-pending-form.png') });
      await desktop.getByRole('button', { name: 'Conversation', exact: true }).click();
    } else desktop = await openWorker({ width: 1440, height: 1000 });
    await expect(
      desktop.getByRole('heading', { name: 'Local fixture preferences — no external action' }),
    ).toBeVisible();
    await desktop.reload();
    assert.equal(store.approval(form.id).status, 'pending');
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
        await expect(page.getByRole('textbox', { name: 'Display name' })).toBeVisible();
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${name} overflow`,
        );
        await page.screenshot({ path: join(root, `${name}-pending-form.png`), fullPage: true });
        pages.push(page);
      }
      const phone = pages[0];
      await phone.getByRole('textbox', { name: 'Display name' }).fill(values.displayName);
      await phone.getByRole('spinbutton', { name: 'Result count' }).fill('0');
      await phone.getByRole('combobox', { name: 'Include details' }).selectOption({ label: 'No' });
      await phone.getByRole('combobox', { name: 'Theme' }).selectOption({ label: 'No theme' });
      await phone.getByRole('checkbox', { name: 'Web', exact: true }).check();
      await phone.getByRole('checkbox', { name: 'Terminal', exact: true }).check();
      await phone.getByRole('button', { name: 'Submit form', exact: true }).click();
      await expect(
        desktop.getByRole('heading', { name: 'Local fixture preferences — no external action' }),
      ).toHaveCount(0);
      for (const page of pages) await page.close();
    }
    await waitFor(
      () => store.approval(form.id).status !== 'pending',
      'The browser must resolve the form before testing a duplicate reply.',
      Date.now() + 5000,
    );
    assert.equal(store.approval(form.id).status, decision === 'accept' ? 'accepted' : 'declined');
    await runtime.approve(form.id, decision, undefined, decision === 'accept' ? values : undefined);
    await waitFor(
      () => !['queued', 'running'].includes(store.run(run.id).status),
      'Expected form turn completion.',
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
            entry.text.includes(
              decision === 'accept' ? 'DOCK-FORM-ACCEPTED' : 'DOCK-FORM-DECLINED',
            ),
        ),
    );
    console.log(
      `Real form ${decision}: original tool consent preserved; browser reply resolved the original request.`,
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
  const replies = readFileSync(join(root, 'mcp-calls.txt'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(replies.length, originalReplies.length + (native ? 1 : 2));
  assert.deepEqual(replies.slice(0, originalReplies.length), originalReplies);
  if (!native) assert.equal(replies[0].form.action, 'decline');
  assert.equal(replies.at(-1).form.action, 'accept');
  assert.deepEqual(replies.at(-1).form.content, values);
  const submitted = store
    .entries(worker.id)
    .filter((entry) => entry.title === 'Form submitted to dock_fixture');
  assert.equal(submitted.length, originalSubmitted + 1);
  assert.deepEqual(JSON.parse(submitted.at(-1).text), values);
  assert.deepEqual(store.entries(worker.id).slice(0, originalEntries.length), originalEntries);
  const entries = store.entries(worker.id),
    approvals = store.approvals(),
    threadId = store.agent(worker.id).threadId;
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
  assert.equal(
    readFileSync(join(root, 'mcp-calls.txt'), 'utf8').trim().split('\n').length,
    replies.length,
  );
  console.log(
    `PASS: ${native ? 'native-started form acceptance' : 'typed form decline/accept'}, phone submission and desktop update, exact one-time values, retained history and same-context restart. Fixture ${fixture}; agent ${worker.id}.`,
  );
} finally {
  await browser?.close();
  if (app) await app.close();
  else {
    await runtime.close();
    store.close();
  }
}
