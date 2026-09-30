// Opt-in real Claude/VS Code acceptance. Owns its profile, extension copy and test server.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
import { mkdtemp, mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (!process.argv.includes('--run'))
  throw new Error('Use --run for an isolated real-provider check.');
const requireWeb = createRequire(join(root, 'apps/web/package.json'));
const { _electron, chromium, expect } = requireWeb('@playwright/test');
const requireExtension = createRequire(join(root, 'apps/vscode-mirror/package.json'));
const { build } = requireExtension('esbuild');
const fixture = await mkdtemp(join(root, 'data/claude-mirror-vscode-'));
const registered = JSON.parse(
  await readFile(join(homedir(), '.vscode/extensions/extensions.json'), 'utf8'),
).find((extension) => extension.identifier.id === 'anthropic.claude-code');
if (!registered) throw new Error('Install Claude Code in VS Code before running this probe.');
const source = registered.location.path;
const copy = join(fixture, 'extensions', basename(source));
const evidence = { fixture, providerVersion: registered.version, stage: 'prepare', passed: [] };
let claudeOriginalHash;
const hash = (text) => createHash('sha256').update(text).digest('hex');
let electron, browser, server;
const save = () =>
  writeFile(join(fixture, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
const api = 'http://127.0.0.1:4346';
const windows = async () => (await fetch(`${api}/api/vscode/windows`)).json();
const command = (value) =>
  writeFile(join(fixture, 'command.json'), JSON.stringify({ command: value }), { mode: 0o600 });
try {
  await cp(source, copy, { recursive: true });
  await build({
    entryPoints: [join(root, 'apps/vscode-mirror/src/claude-patch.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(fixture, 'patch.cjs'),
  });
  const { patchClaude, restoreClaude } = requireExtension(join(fixture, 'patch.cjs'));
  // Normalize an existing recognized hook in the disposable copy only.
  await restoreClaude(copy);
  claudeOriginalHash = hash(await readFile(join(copy, 'extension.js'), 'utf8'));
  evidence.originalHash = claudeOriginalHash;
  await patchClaude(copy);
  await patchClaude(copy);
  await restoreClaude(copy);
  if (hash(await readFile(join(copy, 'extension.js'), 'utf8')) !== claudeOriginalHash)
    throw new Error('Restore was not byte-exact');
  await patchClaude(copy);
  evidence.passed.push('real Claude file patch, idempotency and byte-exact restore');
  await mkdir(join(fixture, 'profile/User'), { recursive: true });
  await mkdir(join(fixture, 'workspace'), { recursive: true });
  await writeFile(
    join(fixture, 'profile/User/settings.json'),
    JSON.stringify({
      'agentDockMirror.port': 4346,
      'workbench.startupEditor': 'none',
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoUpdate': false,
      'git.openRepositoryInParentFolders': 'never',
      'git.autoRepositoryDetection': false,
      'claudeCode.hideOnboarding': true,
    }),
    { mode: 0o600 },
  );
  server = spawn(process.execPath, [join(root, 'apps/server/dist/main.js'), '--demo'], {
    cwd: root,
    env: { ...process.env, DOCK_PORT: '4346', DOCK_DATA_DIR: join(fixture, 'dock') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', () => {});
  server.stdout.on('data', () => {});
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${api}/api/vscode/windows`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(200);
  evidence.stage = 'launch';
  await save();
  const env = { ...process.env, DOCK_CLAUDE_MIRROR_FIXTURE: fixture };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({
    executablePath: '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    args: [
      '--user-data-dir',
      join(fixture, 'profile'),
      '--extensions-dir',
      join(fixture, 'extensions'),
      '--extensionDevelopmentPath',
      join(root, 'apps/vscode-mirror'),
      '--extensionTestsPath',
      join(root, 'scripts/claude-mirror-vscode-host.cjs'),
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      join(fixture, 'workspace'),
    ],
    env,
    timeout: 30_000,
  });
  const page = await electron.firstWindow();
  await expect
    .poll(
      async () => {
        try {
          return JSON.parse(await readFile(join(fixture, 'host-ready.json'), 'utf8')).host;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  evidence.passed.push(
    'patched real Claude extension activated; existing host reference discovered',
  );
  evidence.stage = 'native-composer';
  await save();
  let native;
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const editor = frame
            .locator('[contenteditable]:not([contenteditable=false]), textarea')
            .first();
          if (await editor.isVisible().catch(() => false)) {
            native = frame;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const editor = native.locator('[contenteditable]:not([contenteditable=false]), textarea').first();
  const prompt = (suffix) =>
    `This is an isolated Agent Dock mirror acceptance test. Do not use tools, change files, or execute commands. Reply with exactly CLAUDE_MIRROR_${suffix}_OK.`;
  const reply = (view, suffix) =>
    view
      .getByText(`CLAUDE_MIRROR_${suffix}_OK`, { exact: true })
      .or(view.getByText(`CLAUDE_MIRROR_${suffix}_OK.`, { exact: true }))
      .first();
  evidence.stage = 'native-desktop-send';
  await save();
  await editor.fill(prompt('DESKTOP'));
  await editor.press('Enter');
  await expect(reply(native, 'DESKTOP')).toBeVisible({ timeout: 60_000 });
  evidence.passed.push('native desktop message and real Claude reply');
  evidence.stage = 'share';
  await save();
  await command('share');
  const picker = page.locator('.quick-input-widget input');
  await expect(picker).toBeVisible({ timeout: 20_000 });
  await picker.press('Enter');
  await expect
    .poll(async () => (await windows()).filter((value) => value.provider === 'claude').length, {
      timeout: 20_000,
    })
    .toBe(1);
  browser = await chromium.launch();
  const phone = await browser.newPage({ viewport: { width: 412, height: 915 } });
  await phone.goto(`${api}/?mirror=1`);
  const log = phone.getByRole('log', { name: 'Claude Code conversation' });
  await expect(reply(log, 'DESKTOP')).toBeVisible({ timeout: 20_000 });
  evidence.passed.push('complete retained Claude transcript visible in central phone chat');
  evidence.stage = 'phone-send-preserves-native-draft';
  await save();
  await editor.fill(prompt('LOCAL_AGAIN'));
  await phone.getByLabel('Message Claude Code').fill(prompt('PHONE'));
  await phone.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(reply(log, 'PHONE')).toBeVisible({ timeout: 60_000 });
  await expect(reply(native, 'PHONE')).toBeVisible({ timeout: 20_000 });
  if (await editor.evaluate((element) => element.tagName === 'TEXTAREA'))
    await expect(editor).toHaveValue(prompt('LOCAL_AGAIN'));
  else await expect(editor).toHaveText(prompt('LOCAL_AGAIN'));
  evidence.passed.push('phone input/reply in both views; native unsent draft retained');
  evidence.stage = 'desktop-followup';
  await save();
  await editor.press('Enter');
  await expect(reply(log, 'LOCAL_AGAIN')).toBeVisible({ timeout: 60_000 });
  evidence.passed.push('subsequent desktop input and reply synchronized');
  await phone.reload();
  await expect(phone.getByRole('log')).toContainText('CLAUDE_MIRROR_LOCAL_AGAIN_OK', {
    timeout: 20_000,
  });
  evidence.passed.push('browser reload restores retained transcript');
  if (process.argv.includes('--stop-reply')) {
    evidence.stage = 'phone-stop-reply';
    await save();
    const shared = (await windows()).find((value) => value.provider === 'claude');
    if (!shared?.threadId) throw new Error('Disposable shared Claude conversation unavailable');
    const read = async () => (await fetch(`${api}/api/vscode/windows/${shared.windowId}`)).json();
    const draft = 'UNSENT_CLAUDE_DRAFT_DURING_STOP';
    const assertDraft = async () => {
      if (await editor.evaluate((element) => element.tagName === 'TEXTAREA'))
        await expect(editor).toHaveValue(draft);
      else await expect(editor).toHaveText(draft);
    };
    // Harmless text only, in the probe's new native session. The actual native
    // query handles interruption; this never starts another process or tool call.
    const stopPrompt =
      'This is an isolated Agent Dock stop-button test. Do not use any tools, execute commands, or change files. Begin with CLAUDE_MIRROR_STOP_BEGIN and then list the integers from 1 to 5000, one per line. The test harness will interrupt this reply.';
    await editor.fill(draft);
    await phone.getByLabel('Message Claude Code').fill(stopPrompt);
    await phone.getByRole('button', { name: 'Send', exact: true }).click();
    const stop = phone.getByRole('button', { name: 'Stop reply', exact: true });
    await expect(stop).toBeEnabled({ timeout: 20_000 });
    const before = await read();
    if (!before.stopToken) throw new Error('Native Claude reply has no observed stop token');
    const receiptResponse = phone.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/vscode/windows/${shared.windowId}/control`) &&
        response.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await stop.click();
    const response = await receiptResponse;
    const result = await response.json();
    const requested = response.request().postDataJSON();
    if (!response.ok() || result.state !== 'sent' || requested.token !== before.stopToken)
      throw new Error(
        `Real Claude stop was not acknowledged for the displayed turn: ${JSON.stringify(result)}`,
      );
    evidence.stopReply = {
      threadId: shared.threadId,
      token: requested.token,
      result: result.state,
    };
    await save();
    await expect
      .poll(
        async () => {
          const current = await read();
          evidence.stopReply.finalStatus = current.status;
          return current.status;
        },
        { timeout: 20_000 },
      )
      .toBe('idle');
    await assertDraft();
    evidence.stopReply.nativeDraftPreserved = true;
    evidence.passed.push(
      'phone Stop reply acknowledged for observed real Claude query; idle restored; native draft preserved',
    );
    evidence.stage = 'phone-after-stop';
    await save();
    await phone.getByLabel('Message Claude Code').fill(prompt('AFTER_STOP'));
    await phone.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(reply(log, 'AFTER_STOP')).toBeVisible({ timeout: 60_000 });
    await expect(reply(native, 'AFTER_STOP')).toBeVisible({ timeout: 20_000 });
    await assertDraft();
    evidence.passed.push('same real Claude session accepts a phone followup after interruption');
  }
  await phone.screenshot({ path: join(fixture, 'phone.png') });
  await page.screenshot({ path: join(fixture, 'native.png') });
  evidence.stage = 'stop-and-restore';
  await save();
  await command('stop');
  await expect.poll(async () => (await windows()).length).toBe(0);
  await expect(editor).toBeVisible();
  await command('restore');
  await expect
    .poll(async () => hash(await readFile(join(copy, 'extension.js'), 'utf8')))
    .toBe(claudeOriginalHash);
  evidence.passed.push(
    'stop removes remote access; restore is byte-exact; native chat remains open',
  );
  evidence.stage = 'passed';
  console.log(JSON.stringify(evidence));
} catch (error) {
  evidence.error = String(error);
  console.error(evidence.stage, String(error));
  process.exitCode = 1;
} finally {
  if (electron)
    for (const page of electron.windows())
      for (const [index, frame] of page.frames().entries())
        await writeFile(
          join(fixture, `frame-${index}.txt`),
          await frame
            .locator('body')
            .innerText()
            .catch(() => ''),
          { mode: 0o600 },
        ).catch(() => {});
  await save();
  if (electron) {
    await writeFile(join(fixture, 'finish'), 'done');
    await electron.close().catch(() => {});
  }
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(5000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
}
