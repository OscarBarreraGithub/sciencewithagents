// Explicit, opt-in real-provider check. Uses only the disposable smoke fixture.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Store } from '../apps/server/dist/store.js';
import { Runtime } from '../apps/server/dist/runtime.js';
import { ownerAuthorization } from '../apps/server/dist/local-access.js';
import { prepareBrowserHandoff } from '../apps/server/dist/local-browser-handoff.js';
const fixture = process.argv[2];
const runModel = !process.argv.includes('--controls-only');
const forkContext = process.argv.includes('--fork');
const newContext = process.argv.includes('--new');
const resumeContext = process.argv.includes('--resume');
const transferAgent = process.argv.includes('--transfer');
const mcpCheck = process.argv.includes('--mcp');
const pluginCheck = process.argv.includes('--plugins');
const agentOption = process.argv.indexOf('--agent');
assert(
  !mcpCheck || runModel,
  'The native MCP check includes one explicit tool approval and model turn.',
);
assert(
  !pluginCheck || !mcpCheck,
  'Run the plugin check separately from the standalone MCP fixture.',
);
assert(
  !transferAgent || (!forkContext && !newContext && !resumeContext),
  'Run the transfer check separately.',
);
assert(!(forkContext && newContext), 'Choose /fork or /new for this bounded smoke check.');
assert(!resumeContext || newContext, 'The /resume check returns from a new context. Pass --new.');
if (!/^[a-f0-9]{8}$/.test(fixture ?? '') || (!process.argv.includes('--run') && runModel))
  throw new Error(
    'Pass a successful smoke fixture ID and --run (one model turn) or --controls-only (no model call).',
  );
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
const pty = serverRequire('node-pty');
const root = resolve('data/smoke', fixture);
const host = 'http://127.0.0.1:4341';
const privateRequest = async (path, init = {}) =>
  fetch(host + path, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: await ownerAuthorization(root, 4341, init.method ?? 'GET', path),
    },
  });
const openFixture = async (page) => {
  await page.goto(await prepareBrowserHandoff(root, 4341));
  await expect(page.locator('.home-shell')).toBeVisible();
  await page.goto(`${new URL(page.url()).origin}/?workspace=classic`);
};
const db = new DatabaseSync(resolve(root, 'dock.sqlite'), { readOnly: true });
const agents = db
  .prepare('SELECT body FROM agents')
  .all()
  .map((r) => JSON.parse(r.body));
let manager =
  agentOption >= 0
    ? agents.find((a) => a.id === process.argv[agentOption + 1] && a.threadId)?.id
    : agents.find((a) => a.role === 'manager' && a.threadId)?.id;
assert(manager, 'Fixture needs a selected agent with existing Codex history.');
assert(
  agents.every((a) => !['queued', 'running', 'waiting'].includes(a.status)),
  'Fixture must be idle.',
);
const savedAgent = () =>
  JSON.parse(db.prepare('SELECT body FROM agents WHERE id=?').get(manager).body);
const savedEntries = () =>
  db
    .prepare('SELECT body FROM entries WHERE agent_id=? ORDER BY rowid')
    .all(manager)
    .map((r) => r.body);
const originalThread = savedAgent().threadId;
assert(!pluginCheck || savedAgent().pluginsEnabled, 'Select an opted-in plugin fixture worker.');
const originalEntries = savedEntries();
assert(originalEntries.length > 0, 'Archive verification must inspect real entries.');
const sourceId = manager;
let sourceMarker;
let transferTarget;
let targetOriginalEntries;
try {
  await fetch(`${host}/api/health`);
  throw new Error('Fixture port is in use; do not attach to another server.');
} catch (error) {
  if (!(error instanceof TypeError)) throw error;
}
let marker = `NATIVE-SMOKE-READY-${Date.now()}`;
const server = spawn(process.execPath, ['apps/server/dist/main.js'], {
  env: { ...process.env, DOCK_DATA_DIR: root, DOCK_PORT: '4341' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
let page;
let cli;
let stage = 'startup';
let cliOutput = '';
let serverLog = '';
for (const stream of [server.stdout, server.stderr])
  stream.on('data', (data) => {
    serverLog = (serverLog + data).slice(-500_000);
  });
const stopServer = async () => {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exit = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  let timer;
  try {
    await Promise.race([
      exit,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Fixture server shutdown exceeded 10 seconds.')),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
try {
  const startup = Date.now() + 10_000;
  while (true) {
    try {
      if ((await fetch(`${host}/api/health`)).ok) break;
    } catch {}
    if (Date.now() > startup) throw new Error('Fixture server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  const snapshot = await (await privateRequest('/api/snapshot')).json();
  if (!runModel) marker = snapshot.agents.find((a) => a.id === manager).checkpoint;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  await page.addInitScript((id) => localStorage.setItem('dock:selected', id), manager);
  await openFixture(page);
  const previousReply = await page
    .locator('article.message.assistant .markdown')
    .last()
    .textContent();
  stage = 'browser terminal startup';
  await page.getByRole('button', { name: 'Native terminal', exact: true }).click();
  await page.getByText('Native Codex · connected', { exact: true }).waitFor({ timeout: 25_000 });
  await page.waitForTimeout(500);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('/status', { delay: 70 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: resolve(root, 'native-attached.png') });
  if (forkContext || newContext) {
    const command = forkContext ? '/fork' : '/new';
    await page.keyboard.type(command, { delay: 70 });
    await page.keyboard.press('Enter');
    const deadline = Date.now() + 15_000;
    while (savedAgent().threadId === originalThread && Date.now() < deadline)
      await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(root, `native-${forkContext ? 'fork' : 'new'}.png`) });
    assert.notEqual(
      savedAgent().threadId,
      originalThread,
      `Native ${command} must change the managed context.`,
    );
    assert.deepEqual(savedEntries().slice(0, originalEntries.length), originalEntries);
    console.log(`Native ${command} adopted with the previous archive intact.`);
    await page.waitForTimeout(1000);
    await page.locator('.xterm-helper-textarea').focus();
  }
  if (pluginCheck) {
    await page.keyboard.type('/plugins', { delay: 70 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: resolve(root, 'native-plugins.png') });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  if (runModel) {
    const callsPath = resolve(root, 'mcp-calls.txt');
    const previousCalls = mcpCheck && existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '';
    let approvalsSent = 0;
    if (mcpCheck) {
      await page.keyboard.type('/mcp', { delay: 70 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
      await page.screenshot({ path: resolve(root, 'native-mcp.png') });
    }
    await page.keyboard.type(
      `${pluginCheck ? 'Call the computer-use MCP list_apps tool exactly once with empty arguments. It will be declined: do not retry or interact with any apps. After that decline, ' : mcpCheck ? 'Call the dock_fixture MCP ping tool exactly once. If declined, stop without retrying. If accepted, ' : ''}Use dock_checkpoint to save exactly ${marker} and then answer ${marker}. This is a smoke check. Do nothing else.`,
      { delay: 20 },
    );
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    console.log('Submitted native turn through the actual browser terminal.');
    const deadline = Date.now() + 90_000;
    let agent;
    let seenBusy = false;
    do {
      await page.waitForTimeout(1000);
      agent = (await (await privateRequest(`/api/agents/${manager}`)).json()).agent;
      if (['running', 'waiting'].includes(agent.status)) seenBusy = true;
      if (mcpCheck || pluginCheck) {
        const approval = db
          .prepare('SELECT body FROM approvals WHERE agent_id=?')
          .all(manager)
          .map((r) => JSON.parse(r.body))
          .find((a) => a.status === 'pending');
        if (approval) {
          assert.equal(approval.kind, 'mcp');
          assert.equal(approval.params.serverName, pluginCheck ? 'computer-use' : 'dock_fixture');
          if (pluginCheck) assert(approval.title.includes('list_apps'));
          assert.equal(approval.params.threadId, savedAgent().threadId);
          assert.equal(approval.params._meta.codex_approval_kind, 'mcp_tool_call');
          assert.deepEqual(approval.params._meta.tool_params, {});
          assert.equal(approvalsSent, 0, 'Only one harmless fixture call may be approved.');
          assert.equal(
            existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '',
            previousCalls,
            'Native MCP must pause before executing.',
          );
          const response = await privateRequest(`/api/approvals/${approval.id}`, {
            method: 'POST',
            headers: { origin: host, 'content-type': 'application/json' },
            body: JSON.stringify({ decision: pluginCheck ? 'decline' : 'accept' }),
          });
          assert(response.ok, 'The original MCP approval must receive the chosen decision.');
          approvalsSent++;
        }
      }
      if (agent.checkpoint === marker && agent.status === 'idle') break;
      if (seenBusy && ['idle', 'failed', 'interrupted'].includes(agent.status)) break;
    } while (Date.now() < deadline);
    await page.screenshot({ path: resolve(root, 'native-result.png') });
    if (agent.checkpoint !== marker || agent.status !== 'idle')
      throw new Error('Native coordination/archive did not complete. Inspect fixture screenshots.');
    if (mcpCheck) {
      assert.equal(approvalsSent, 1, 'Native MCP must preserve the code-enforced approval gate.');
      assert.equal(readFileSync(callsPath, 'utf8'), previousCalls + 'ping\n');
      console.log('Native MCP tool paused for its original approval, then executed once.');
    }
    if (pluginCheck) {
      assert.equal(approvalsSent, 1, 'Native plugins must preserve the original approval gate.');
      assert.equal(savedAgent().pluginsEnabled, true);
      console.log(
        'Native installed-plugin tool paused and was declined; host checkpoint completed.',
      );
    }
  }
  if (resumeContext) {
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`/resume ${originalThread}`, { delay: 50 });
    await page.keyboard.press('Enter');
    const deadline = Date.now() + 15_000;
    while (savedAgent().threadId !== originalThread && Date.now() < deadline)
      await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(root, 'native-resume.png') });
    assert.equal(
      savedAgent().threadId,
      originalThread,
      'Native /resume must return to the recorded context.',
    );
    console.log('Native /resume restored the original managed context.');
    if (runModel) {
      marker = `${marker}-RESUMED`;
      await page.waitForTimeout(1000);
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type(
        `Call dock_inspect with no arguments to retrieve current project evidence. Then use dock_checkpoint to save exactly ${marker} and answer ${marker}. Do nothing else.`,
        { delay: 20 },
      );
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      const deadline = Date.now() + 90_000;
      while (
        (savedAgent().checkpoint !== marker || savedAgent().status !== 'idle') &&
        Date.now() < deadline
      )
        await page.waitForTimeout(500);
      await page.screenshot({ path: resolve(root, 'native-resume-result.png') });
      assert.equal(savedAgent().checkpoint, marker, 'A post-resume host-tool turn must finish.');
      assert.equal(savedAgent().status, 'idle');
    }
  }
  if (transferAgent) {
    transferTarget = agents.find((a) => a.role === 'researcher' && a.threadId && !a.taskId);
    assert(transferTarget, 'Transfer smoke needs a read-only imported fixture agent.');
    targetOriginalEntries = db
      .prepare('SELECT body FROM entries WHERE agent_id=? ORDER BY rowid')
      .all(transferTarget.id)
      .map((r) => r.body);
    sourceMarker = marker;
    const sourceArchive = savedEntries();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`/resume ${transferTarget.threadId}`, { delay: 50 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (id) => localStorage.getItem('dock:selected') === id,
      transferTarget.id,
      { timeout: 25_000 },
    );
    manager = transferTarget.id;
    await page.getByRole('heading', { name: transferTarget.name, exact: true }).waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: resolve(root, 'native-transferred.png') });
    assert.deepEqual(
      db
        .prepare('SELECT body FROM entries WHERE agent_id=? ORDER BY rowid')
        .all(sourceId)
        .map((r) => r.body),
      sourceArchive,
    );
    assert.equal(savedAgent().role, 'researcher');
    assert.equal(savedAgent().cwd, transferTarget.cwd);
    assert.equal(savedAgent().threadId, transferTarget.threadId);
    assert.equal(savedAgent().permission, 'read-only');
    console.log(
      'Native /resume transferred browser selection and input to the registered read-only agent.',
    );
    if (runModel) {
      // Imports may predate the coordination tools. A fresh context installs this role's tools.
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type('/new', { delay: 70 });
      await page.keyboard.press('Enter');
      const contextDeadline = Date.now() + 15_000;
      while (savedAgent().threadId === transferTarget.threadId && Date.now() < contextDeadline)
        await page.waitForTimeout(250);
      assert.notEqual(savedAgent().threadId, transferTarget.threadId);
      await page.waitForTimeout(1000);
      marker = `${marker}-TRANSFERRED`;
      await page.keyboard.type(
        `Call dock_inspect with no arguments. Then use dock_checkpoint to save exactly ${marker} and answer ${marker}. Do nothing else.`,
        { delay: 20 },
      );
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      const deadline = Date.now() + 90_000;
      while (
        (savedAgent().checkpoint !== marker || savedAgent().status !== 'idle') &&
        Date.now() < deadline
      )
        await page.waitForTimeout(500);
      assert.equal(
        savedAgent().checkpoint,
        marker,
        'The transferred agent must execute its own host tools.',
      );
      assert.equal(savedAgent().status, 'idle');
      await page.screenshot({ path: resolve(root, 'native-transfer-result.png') });
    } else marker = savedAgent().checkpoint;
  }
  stage = 'phone layouts';
  for (const [width, height] of [
    [412, 915],
    [360, 800],
    [915, 412],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(350);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error('Native terminal overflows this viewport');
    await page.screenshot({ path: resolve(root, `native-${width}x${height}.png`) });
  }
  stage = 'second browser takeover';
  let other = await browser.newPage();
  other.setDefaultTimeout(15_000);
  await other.addInitScript((id) => localStorage.setItem('dock:selected', id), manager);
  await openFixture(other);
  await other.getByRole('button', { name: 'Native terminal', exact: true }).click();
  await page.getByText('Control moved to another browser.', { exact: true }).waitFor();
  stage = 'return to saved chat';
  await other.getByRole('button', { name: 'Return to chat' }).click();
  // A checkpoint is internal state, not necessarily an assistant reply. Controls-only
  // fixtures must verify their actual archived conversation without sending a new turn.
  if (runModel) await other.getByText(marker, { exact: true }).last().waitFor();
  else {
    const reply = other.locator('article.message.assistant .markdown').last();
    await expect(reply).toBeVisible();
    // Compare rendered text: Markdown source (e.g. backticks) is not visible text either.
    if (!transferAgent) await expect(reply).toHaveText(previousReply);
  }
  stage = 'local CLI attach';
  cli = pty.spawn(process.execPath, ['apps/server/dist/cli.js', 'attach', manager], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: { ...process.env, DOCK_PORT: '4341' },
  });
  let cliExit = null;
  cli.onData((data) => {
    cliOutput = (cliOutput + data).slice(-500_000);
    if (data.includes('\u001b[6n')) cli.write('\u001b[1;1R');
  });
  cli.onExit(({ exitCode }) => {
    cliExit = exitCode;
  });
  const attachDeadline = Date.now() + 8000;
  while (!cliOutput.includes('OpenAI Codex') && Date.now() < attachDeadline)
    await page.waitForTimeout(200);
  if (!cliOutput.includes('OpenAI Codex'))
    throw new Error('Local dock attach did not render the managed Codex terminal');
  if (transferAgent) {
    // A worker's recorded completion report can briefly occupy its manager.
    const idleDeadline = Date.now() + 90_000;
    const sourceAgent = () =>
      JSON.parse(db.prepare('SELECT body FROM agents WHERE id=?').get(sourceId).body);
    while (
      ['running', 'waiting', 'queued'].includes(sourceAgent().status) &&
      Date.now() < idleDeadline
    )
      await page.waitForTimeout(500);
    assert.equal(
      sourceAgent().status,
      'idle',
      'The manager must finish its recorded worker report first.',
    );
    sourceMarker = sourceAgent().checkpoint;
    await page.waitForTimeout(1000);
    for (const character of `/resume ${originalThread}`) {
      cli.write(character);
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(500);
    cli.write('\r');
    const deadline = Date.now() + 25_000;
    const transferredBack = () =>
      db
        .prepare(
          "SELECT agent_id FROM events WHERE type='terminal.transferred' ORDER BY id DESC LIMIT 1",
        )
        .get()?.agent_id;
    while (transferredBack() !== sourceId && Date.now() < deadline) await page.waitForTimeout(250);
    writeFileSync(resolve(root, 'native-transfer-cli.txt'), cliOutput, { mode: 0o600 });
    assert.equal(transferredBack(), sourceId, 'Local CLI must transfer back to the manager.');
    assert.equal(
      cliExit,
      null,
      'A cross-agent transfer must preserve the local CLI input session.',
    );
    manager = sourceId;
    marker = sourceMarker;
    // Use a new browser context: the earlier page's init script intentionally restores its target.
    other = await browser.newPage();
    other.setDefaultTimeout(15_000);
    await other.addInitScript((id) => localStorage.setItem('dock:selected', id), manager);
    await openFixture(other);
    console.log('Local dock attach transferred back without exiting or opening an untracked CLI.');
  }
  stage = 'browser takes control from local CLI';
  await other.getByRole('button', { name: 'Native terminal', exact: true }).click();
  const takeoverDeadline = Date.now() + 5000;
  while (cliExit === null && Date.now() < takeoverDeadline) await page.waitForTimeout(200);
  if (cliExit !== 0) throw new Error('Browser takeover did not cleanly release the local CLI');
  await other.getByRole('button', { name: 'Return to chat' }).click();
  const retainedThread = savedAgent().threadId;
  const retainedEntries = savedEntries();
  assert.deepEqual(
    retainedEntries.slice(0, originalEntries.length),
    originalEntries,
    'Earlier visible history must remain unchanged.',
  );
  const targetEntries = transferTarget
    ? db
        .prepare('SELECT body FROM entries WHERE agent_id=? ORDER BY rowid')
        .all(transferTarget.id)
        .map((r) => r.body)
    : null;
  if (targetOriginalEntries)
    assert.deepEqual(
      targetEntries.slice(0, targetOriginalEntries.length),
      targetOriginalEntries,
      'Transfer must retain the target’s original visible history.',
    );
  stage = 'same-context restart';
  await stopServer();
  const reopened = new Store(resolve(root, 'dock.sqlite'));
  const replacement = new Runtime(reopened, root, process.env.DOCK_CODEX_BIN ?? 'codex');
  try {
    await replacement.attach(manager);
    assert.equal(reopened.agent(manager).threadId, retainedThread);
    assert.deepEqual(
      savedEntries(),
      retainedEntries,
      'Restart must not duplicate archived history.',
    );
    assert.equal(reopened.agent(manager).checkpoint, marker);
    if (transferTarget) {
      const targetThread = reopened.agent(transferTarget.id).threadId;
      await replacement.attach(transferTarget.id);
      assert.equal(reopened.agent(transferTarget.id).threadId, targetThread);
      assert.deepEqual(
        db
          .prepare('SELECT body FROM entries WHERE agent_id=? ORDER BY rowid')
          .all(transferTarget.id)
          .map((r) => r.body),
        targetEntries,
      );
    }
  } finally {
    await replacement.close();
    reopened.close();
  }
  console.log(
    `PASS: ${transferAgent ? 'cross-agent native transfer, ' : ''}${forkContext ? 'native /fork, ' : newContext ? 'native /new, ' : ''}${resumeContext ? 'native /resume, ' : ''}${runModel ? 'real turn and coordination, ' : ''}archive, three phone layouts, browser/local CLI handoff and same-context restart.`,
  );
} catch (error) {
  await page?.screenshot({ path: resolve(root, 'native-failure.png') }).catch(() => {});
  writeFileSync(resolve(root, 'native-failure-server.txt'), serverLog, { mode: 0o600 });
  writeFileSync(
    resolve(root, 'native-failure-detail.json'),
    JSON.stringify({ stage, error: String(error), stack: error?.stack, cliOutput }, null, 2),
    { mode: 0o600 },
  );
  console.error(`Native check failed at: ${stage}`);
  throw error;
} finally {
  cli?.kill();
  await browser?.close();
  await stopServer();
  db.close();
}
