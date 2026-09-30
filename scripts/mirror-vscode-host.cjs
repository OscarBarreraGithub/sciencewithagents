// Isolated VS Code test-host entry; never loaded by the shipped extension.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async function () {
  const root = process.env.DOCK_MIRROR_FIXTURE;
  if (!root || !root.includes('/data/mirror-vscode-'))
    throw new Error('Disposable fixture required');
  try {
    await vscode.extensions.getExtension('openai.chatgpt').activate();
    await vscode.extensions.getExtension('oscarphysics.agent-dock-mirror').activate();
    await vscode.commands.executeCommand('chatgpt.openSidebar');
    await fs.writeFile(path.join(root, 'host-ready.json'), JSON.stringify({ ready: true }), {
      mode: 0o600,
    });
    // Commands requested by the owned acceptance script only. No arbitrary RPC bridge.
    const timer = setInterval(async () => {
      try {
        const file = path.join(root, 'command.json');
        const { command } = JSON.parse(await fs.readFile(file, 'utf8'));
        await fs.unlink(file);
        const allowed = {
          share: 'agentDockMirror.enable',
          stop: 'agentDockMirror.stop',
          new: 'chatgpt.newChat',
          restore: 'agentDockMirror.restore',
        };
        if (allowed[command]) await vscode.commands.executeCommand(allowed[command]);
      } catch {}
    }, 500);
    await new Promise((resolve) => {
      const handle = setInterval(async () => {
        try {
          await fs.stat(path.join(root, 'finish'));
          clearInterval(handle);
          clearInterval(timer);
          resolve();
        } catch {}
      }, 500);
    });
  } catch (error) {
    await fs.writeFile(
      path.join(root, 'host-error.json'),
      JSON.stringify({ message: String(error) }),
      { mode: 0o600 },
    );
    throw error;
  }
};
