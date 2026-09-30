// Opt-in, disposable VS Code + browser acceptance. Never patches the owner's install.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
import { mkdtemp, mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (!process.argv.includes('--run'))
  throw new Error('Use --run for an isolated real-provider acceptance check.');
const requireWeb = createRequire(join(root, 'apps/web/package.json'));
const { _electron, chromium, expect } = requireWeb('@playwright/test');
const requireExtension = createRequire(join(root, 'apps/vscode-mirror/package.json'));
const { build } = requireExtension('esbuild');
const fixture = await mkdtemp(join(root, 'data/mirror-vscode-'));
const registered = JSON.parse(
  await readFile(join(homedir(), '.vscode/extensions/extensions.json'), 'utf8'),
).find((extension) => extension.identifier.id === 'openai.chatgpt');
if (!registered) throw new Error('Install Codex in VS Code before running this probe.');
const source = registered.location.path;
const copy = join(fixture, 'extensions', basename(source));
const evidence = { fixture, providerVersion: registered.version, stage: 'prepare', passed: [] };
let electron, browser, server;
const save = () =>
  writeFile(join(fixture, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
try {
  await cp(source, copy, { recursive: true });
  await build({
    entryPoints: [join(root, 'apps/vscode-mirror/src/patch.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(fixture, 'patch.cjs'),
  });
  const { patch, restore, hash } = requireExtension(join(fixture, 'patch.cjs'));
  // Normalize only a recognized patch in the disposable copy, including legacy v1.
  await restore(copy);
  const originalHash = hash(await readFile(join(copy, 'out/extension.js'), 'utf8'));
  evidence.originalHash = originalHash;
  await patch(copy);
  await patch(copy);
  await restore(copy);
  if (hash(await readFile(join(copy, 'out/extension.js'), 'utf8')) !== originalHash)
    throw new Error('Restore was not byte-exact');
  await patch(copy);
  evidence.passed.push('real-file patch, idempotency and byte-exact restore');
  await mkdir(join(fixture, 'profile/User'), { recursive: true });
  await mkdir(join(fixture, 'workspace'), { recursive: true });
  await writeFile(
    join(fixture, 'profile/User/settings.json'),
    JSON.stringify({
      'agentDockMirror.port': 4345,
      'workbench.startupEditor': 'none',
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoUpdate': false,
      'git.openRepositoryInParentFolders': 'never',
      'git.autoRepositoryDetection': false,
    }),
    { mode: 0o600 },
  );
  server = spawn(process.execPath, [join(root, 'apps/server/dist/main.js'), '--demo'], {
    cwd: root,
    env: { ...process.env, DOCK_PORT: '4345', DOCK_DATA_DIR: join(fixture, 'dock') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', () => {});
  server.stdout.on('data', () => {});
  await expect
    .poll(
      async () => {
        try {
          return (await fetch('http://127.0.0.1:4345/api/vscode/windows')).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(200);
  evidence.stage = 'launch';
  await save();
  const env = { ...process.env, DOCK_MIRROR_FIXTURE: fixture };
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
      join(root, 'scripts/mirror-vscode-host.cjs'),
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
          return JSON.parse(await readFile(join(fixture, 'host-ready.json'), 'utf8')).ready;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  evidence.stage = 'inspect-native-ui';
  await save();
  let native;
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          if (await frame.locator('[contenteditable=true], textarea').count()) {
            native = frame;
            return true;
          }
          if (!frame.url().includes('vscode-webview:')) continue;
          for (const label of ['Next', 'Get started', 'Done']) {
            const button = frame.getByRole('button', { name: label, exact: true });
            if (await button.isVisible().catch(() => false)) await button.click();
          }
        }
        return false;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await writeFile(join(fixture, 'command.json'), JSON.stringify({ command: 'new' }));
  await delay(1500);
  const editor = native.locator('[contenteditable=true], textarea').first();
  const prompt = (suffix) =>
    `This is an isolated Agent Dock mirror acceptance test. Do not use tools, change files, or execute commands. Reply with exactly MIRROR_${suffix}_OK.`;
  evidence.stage = 'desktop-send';
  await save();
  await editor.fill(prompt('DESKTOP'));
  await editor.press('Enter');
  await expect(
    native
      .getByText('MIRROR_DESKTOP_OK.', { exact: true })
      .or(native.getByText('MIRROR_DESKTOP_OK', { exact: true }))
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  evidence.passed.push('native desktop message and real provider reply');
  evidence.stage = 'share';
  await save();
  await writeFile(join(fixture, 'command.json'), JSON.stringify({ command: 'share' }));
  const picker = page.locator('.quick-input-widget input');
  await expect(picker).toBeVisible({ timeout: 20_000 });
  await picker.fill('MIRROR');
  await picker.press('Enter');
  await expect
    .poll(
      async () => (await (await fetch('http://127.0.0.1:4345/api/vscode/windows')).json()).length,
      { timeout: 20_000 },
    )
    .toBe(1);
  browser = await chromium.launch();
  const phone = await browser.newPage({ viewport: { width: 412, height: 915 } });
  await phone.goto('http://127.0.0.1:4345/?mirror=1');
  const log = phone.getByRole('log', { name: 'Codex conversation' });
  await expect(
    log
      .getByText('MIRROR_DESKTOP_OK', { exact: true })
      .or(log.getByText('MIRROR_DESKTOP_OK.', { exact: true }))
      .first(),
  ).toBeVisible({ timeout: 20_000 });
  evidence.passed.push('whole retained native transcript visible in mirror');
  evidence.stage = 'phone-send-with-desktop-draft';
  await save();
  await editor.fill(prompt('LOCAL_AGAIN'));
  await phone.getByLabel('Message Codex').fill(prompt('PHONE'));
  await phone.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    log
      .getByText('MIRROR_PHONE_OK', { exact: true })
      .or(log.getByText('MIRROR_PHONE_OK.', { exact: true }))
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    native
      .getByText('MIRROR_PHONE_OK', { exact: true })
      .or(native.getByText('MIRROR_PHONE_OK.', { exact: true }))
      .first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(editor).toHaveText(prompt('LOCAL_AGAIN'));
  evidence.passed.push('phone input/reply in both views; native draft preserved');
  evidence.stage = 'desktop-followup';
  await save();
  await editor.press('Enter');
  await expect(
    log
      .getByText('MIRROR_LOCAL_AGAIN_OK', { exact: true })
      .or(log.getByText('MIRROR_LOCAL_AGAIN_OK.', { exact: true }))
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  evidence.passed.push('subsequent human keyboard message/reply mirrored');
  await phone.reload();
  await expect(phone.getByRole('log')).toContainText('MIRROR_LOCAL_AGAIN_OK', { timeout: 20_000 });
  evidence.passed.push('browser reload restores retained transcript');
  if (process.argv.includes('--stop-reply')) {
    evidence.stage = 'phone-stop-reply';
    await save();
    const [shared] = await (await fetch('http://127.0.0.1:4345/api/vscode/windows')).json();
    if (!shared?.threadId) throw new Error('Disposable shared conversation unavailable');
    const read = async () =>
      (await fetch(`http://127.0.0.1:4345/api/vscode/windows/${shared.windowId}`)).json();
    // No tools, workspace writes or owner conversation. Long text only creates a
    // short opportunity to exercise the real provider interruption from the UI.
    const stopPrompt =
      'This is an isolated Agent Dock stop-button test. Do not use any tools, execute commands, or change files. Begin with MIRROR_STOP_BEGIN and then list the integers from 1 to 5000, one per line. The test harness will interrupt this reply.';
    await editor.fill('UNSENT_NATIVE_DRAFT_DURING_STOP');
    await phone.getByLabel('Message Codex').fill(stopPrompt);
    await phone.getByRole('button', { name: 'Send', exact: true }).click();
    const stop = phone.getByRole('button', { name: 'Stop reply', exact: true });
    await expect(stop).toBeEnabled({ timeout: 20_000 });
    const before = await read();
    if (!before.stopToken)
      throw new Error('Native active reply did not expose an exact stop token');
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
        `Real stop was not acknowledged for the displayed turn: ${JSON.stringify(result)}`,
      );
    await expect.poll(async () => (await read()).status, { timeout: 20_000 }).toBe('idle');
    await expect(editor).toHaveText('UNSENT_NATIVE_DRAFT_DURING_STOP');
    evidence.stopReply = {
      threadId: shared.threadId,
      token: requested.token,
      result: result.state,
      finalStatus: 'idle',
      nativeDraftPreserved: true,
    };
    evidence.passed.push(
      'phone Stop reply acknowledged for exact real native turn; idle restored; native draft preserved',
    );
    evidence.stage = 'phone-after-stop';
    await save();
    await phone.getByLabel('Message Codex').fill(prompt('AFTER_STOP'));
    await phone.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(
      log
        .getByText('MIRROR_AFTER_STOP_OK', { exact: true })
        .or(log.getByText('MIRROR_AFTER_STOP_OK.', { exact: true }))
        .first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(editor).toHaveText('UNSENT_NATIVE_DRAFT_DURING_STOP');
    evidence.passed.push(
      'same real native conversation accepts a phone followup after interruption',
    );
  }
  await phone.screenshot({ path: join(fixture, 'phone.png') });
  await page.screenshot({ path: join(fixture, 'native.png') });
  evidence.stage = 'stop-and-restore';
  await save();
  await writeFile(join(fixture, 'command.json'), JSON.stringify({ command: 'stop' }));
  await expect
    .poll(
      async () => (await (await fetch('http://127.0.0.1:4345/api/vscode/windows')).json()).length,
    )
    .toBe(0);
  await expect(editor).toBeVisible();
  await writeFile(join(fixture, 'command.json'), JSON.stringify({ command: 'restore' }));
  await expect
    .poll(async () => hash(await readFile(join(copy, 'out/extension.js'), 'utf8')))
    .toBe(originalHash);
  evidence.passed.push(
    'stop sharing removes remote access; restore returns exact original without closing native chat',
  );
  evidence.passed.push('patched Codex activated in isolated VS Code');
  evidence.stage = 'passed';
  console.log(JSON.stringify(evidence));
} catch (error) {
  evidence.error = String(error);
  console.error(evidence.stage, String(error));
  process.exitCode = 1;
} finally {
  if (electron) {
    for (const page of electron.windows())
      for (const frame of page.frames()) {
        await writeFile(
          join(fixture, `frame-${page.frames().indexOf(frame)}.txt`),
          await frame
            .locator('body')
            .innerText()
            .catch(() => ''),
          { mode: 0o600 },
        ).catch(() => {});
      }
  }
  await save();
  if (electron) {
    await writeFile(join(fixture, 'finish'), 'done');
    await electron.close().catch(() => {});
  }
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((r) => server.once('exit', r)), delay(5000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
}
