// Isolated acceptance host, never included in the companion package.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async function () {
  const root = process.env.DOCK_CLAUDE_MIRROR_FIXTURE;
  if (!root || !root.includes('/data/claude-mirror-vscode-'))
    throw new Error('Disposable fixture required');
  let timer;
  try {
    await vscode.extensions.getExtension('anthropic.claude-code').activate();
    await vscode.extensions.getExtension('oscarphysics.agent-dock-mirror').activate();
    await vscode.commands.executeCommand('claude-vscode.editor.open');
    const host = globalThis[Symbol.for('agent-dock.claude-mirror.host.v1')];
    await fs.writeFile(
      path.join(root, 'host-ready.json'),
      JSON.stringify({ ready: true, host: !!host, surfaces: host?.allComms?.size }),
      { mode: 0o600 },
    );
    timer = setInterval(async () => {
      try {
        const file = path.join(root, 'command.json');
        const { command } = JSON.parse(await fs.readFile(file, 'utf8'));
        await fs.unlink(file);
        const allowed = {
          share: 'agentDockMirror.shareClaude',
          stop: 'agentDockMirror.stop',
          restore: 'agentDockMirror.restoreClaude',
        };
        if (allowed[command]) await vscode.commands.executeCommand(allowed[command]);
      } catch {
        /* No command, or a fixture-only command already consumed. */
      }
    }, 500);
    await new Promise((resolve) => {
      const handle = setInterval(async () => {
        try {
          await fs.stat(path.join(root, 'finish'));
          clearInterval(handle);
          clearInterval(timer);
          resolve();
        } catch {
          /* Still testing. */
        }
      }, 500);
    });
  } catch (error) {
    clearInterval(timer);
    await fs.writeFile(
      path.join(root, 'host-error.json'),
      JSON.stringify({ message: String(error) }),
      { mode: 0o600 },
    );
    throw error;
  }
};
