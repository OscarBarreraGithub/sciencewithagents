import * as vscode from 'vscode';
import WebSocket from 'ws';
import {
  mirrorCommandSchema,
  mirrorPage,
  type MirrorState,
  type MirrorSend,
  type MirrorResult,
  type MirrorControl,
} from '@dock/shared';
import { bridgeSymbol, patch, restore } from './patch.js';
import { MirrorConnection, isCodexConnection } from './connection.js';
import { claudeBridgeSymbol, patchClaude, restoreClaude } from './claude-patch.js';
import { ClaudeMirrorConnection, isClaudeHost } from './claude-connection.js';

type Provider = 'codex' | 'claude';
interface Adapter {
  readonly summary: Omit<MirrorState, 'entries'>;
  choices(): Promise<{ id: string; label: string }[]>;
  select(id: string | null): Promise<void>;
  read(): Promise<MirrorState>;
  send(input: MirrorSend): Promise<MirrorResult>;
  control(input: MirrorControl): Promise<MirrorResult>;
  dispose(): void;
}
const providers = {
  codex: { name: 'Codex', extension: 'openai.chatgpt', symbol: bridgeSymbol, patch, restore },
  claude: {
    name: 'Claude Code',
    extension: 'anthropic.claude-code',
    symbol: claudeBridgeSymbol,
    patch: patchClaude,
    restore: restoreClaude,
  },
} as const;

export async function activate(context: vscode.ExtensionContext) {
  const bridges = new Map<
    Provider,
    { adapter: Adapter; socket?: WebSocket; retry?: NodeJS.Timeout }
  >();
  const needsSetup = new Set<Provider>();
  let stopped = false;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 5);
  status.command = 'agentDockMirror.menu';
  status.tooltip = 'sciencewithagents: share Codex or Claude Code, open chats, or stop sharing';
  status.show();
  const port = () => vscode.workspace.getConfiguration('agentDockMirror').get<number>('port', 4330);
  const enabled = (provider: Provider) =>
    context.globalState.get(
      `enabled.${provider}`,
      provider === 'codex' && context.globalState.get('enabled', false),
    );
  const shared = (provider: Provider) =>
    context.workspaceState.get<string>(`sharedThread.${provider}`) ??
    (provider === 'codex' ? context.workspaceState.get<string>('sharedThread') : undefined);
  const installed = (provider: Provider) => {
    const extension = vscode.extensions.getExtension(providers[provider].extension);
    if (!extension)
      throw new Error(
        `Install ${providers[provider].name} in VS Code first, then sign in there. sciencewithagents uses that same account.`,
      );
    return extension;
  };
  const reference = (provider: Provider) =>
    (globalThis as Record<symbol, unknown>)[Symbol.for(providers[provider].symbol)];
  function updateStatus() {
    const sharing = [...bridges.entries()].filter(([, bridge]) => bridge.adapter.summary.threadId);
    const connected = sharing.filter(
      ([, bridge]) => bridge.socket?.readyState === WebSocket.OPEN,
    ).length;
    status.text = needsSetup.size
      ? '$(warning) sciencewithagents · setup needed'
      : connected
        ? `$(device-mobile) sciencewithagents · ${connected} chat${connected === 1 ? '' : 's'}`
        : sharing.length
          ? '$(device-mobile) sciencewithagents · reconnecting'
          : '$(device-mobile) sciencewithagents';
  }
  function disconnect(provider: Provider) {
    const bridge = bridges.get(provider);
    if (!bridge) return;
    clearTimeout(bridge.retry);
    bridge.socket?.removeAllListeners();
    bridge.socket?.on('error', () => {});
    bridge.socket?.terminate();
    bridge.socket = undefined;
    updateStatus();
  }
  function connect(provider: Provider) {
    const bridge = bridges.get(provider);
    if (stopped || !bridge?.adapter.summary.threadId) return;
    disconnect(provider);
    const p = port();
    if (!Number.isInteger(p) || p < 1024 || p > 65535) return;
    const peer = new WebSocket(`ws://127.0.0.1:${p}/api/vscode/bridge`, {
      perMessageDeflate: false,
      maxPayload: 128 * 1024,
      handshakeTimeout: 5000,
    });
    bridge.socket = peer;
    peer.on('open', () => {
      peer.send(
        JSON.stringify({
          type: 'hello',
          window: { ...bridge.adapter.summary, paged: true, groupedActivity: true },
        }),
      );
      updateStatus();
    });
    peer.on('message', async (data) => {
      try {
        const command = mirrorCommandSchema.parse(JSON.parse(data.toString()));
        let result =
          command.type === 'read'
            ? await bridge.adapter.read()
            : command.type === 'send'
              ? await bridge.adapter.send(command.input)
              : await bridge.adapter.control(command.input);
        if (command.type === 'read' && command.page)
          result = {
            ...mirrorPage(result as MirrorState, command.page),
            paged: true,
            groupedActivity: true,
          };
        let text = JSON.stringify(result);
        if (Buffer.byteLength(text) > 32 * 1024 * 1024) {
          result = {
            ...bridge.adapter.summary,
            status: 'offline',
            entries: [],
            message:
              'This saved conversation exceeds the 32 MiB preview limit. Read it in VS Code; no truncated transcript is shown as complete.',
          };
          text = JSON.stringify(result);
        }
        for (
          let offset = 0;
          offset < text.length && peer.readyState === WebSocket.OPEN;
          offset += 4096
        )
          peer.send(
            JSON.stringify({
              type: 'chunk',
              id: command.id,
              text: text.slice(offset, offset + 4096),
              last: offset + 4096 >= text.length,
            }),
          );
      } catch {
        peer.close(1008);
      }
    });
    peer.on('error', () => {
      /* Status provides recovery without logging private content. */
    });
    peer.on('close', () => {
      if (bridge.socket !== peer || stopped) return;
      updateStatus();
      bridge.retry = setTimeout(() => void connect(provider), 4000);
    });
  }
  async function attach(provider: Provider) {
    const existing = bridges.get(provider);
    if (existing) return existing.adapter;
    await installed(provider).activate();
    const candidate = reference(provider);
    let adapter: Adapter;
    if (provider === 'codex') {
      if (!isCodexConnection(candidate))
        throw new Error(
          'Enable Codex sharing from the sciencewithagents menu, then reload this window once when work is safe. Open Codex before sharing.',
        );
      adapter = new MirrorConnection(candidate, vscode.workspace.name ?? 'VS Code');
    } else {
      if (!candidate)
        throw new Error(
          'Enable Claude Code sharing from the sciencewithagents menu, then reload this window once when work is safe. Open Claude Code before sharing.',
        );
      if (!isClaudeHost(candidate))
        throw new Error(
          'Claude Code changed the connection features sciencewithagents needs. Sharing is unavailable; keep using Claude Code normally.',
        );
      adapter = new ClaudeMirrorConnection(candidate, vscode.workspace.name ?? 'VS Code');
    }
    bridges.set(provider, { adapter });
    return adapter;
  }
  async function enable(provider: Provider) {
    await providers[provider].patch(installed(provider).extensionPath);
    await context.globalState.update(`enabled.${provider}`, true);
    needsSetup.delete(provider);
    await installed(provider).activate();
    if (reference(provider)) return true;
    updateStatus();
    const choice = await vscode.window.showInformationMessage(
      `${providers[provider].name} sharing is prepared with an exact backup. Reload this VS Code window once when work is safe. This restarts the extension host; ordinary phone handoffs will not.`,
      'Reload window',
    );
    if (choice) await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return false;
  }
  async function share(provider: Provider) {
    if ((!enabled(provider) || !reference(provider)) && !(await enable(provider))) return;
    const adapter = await attach(provider);
    const choices = await adapter.choices();
    if (!choices.length)
      throw new Error(
        `Open a saved conversation in ${providers[provider].name} first. Send its first message on the computer if it is new. Only loaded conversations can be shared.`,
      );
    const choice = await vscode.window.showQuickPick(choices, {
      title: `Share a ${providers[provider].name} conversation`,
      placeHolder:
        'Choose the conversation to show in sciencewithagents on your computer and paired phone',
    });
    if (!choice) return;
    disconnect(provider);
    await adapter.select(choice.id);
    await context.workspaceState.update(`sharedThread.${provider}`, choice.id);
    if (provider === 'codex') await context.workspaceState.update('sharedThread', undefined);
    void connect(provider);
    updateStatus();
  }
  async function stop(provider: Provider) {
    disconnect(provider);
    await bridges.get(provider)?.adapter.select(null);
    await context.workspaceState.update(`sharedThread.${provider}`, undefined);
    if (provider === 'codex') await context.workspaceState.update('sharedThread', undefined);
    updateStatus();
  }
  async function chooseProvider(title: string): Promise<Provider | undefined> {
    const choices = (Object.keys(providers) as Provider[])
      .filter((provider) => vscode.extensions.getExtension(providers[provider].extension))
      .map((provider) => ({ label: providers[provider].name, provider }));
    if (choices.length === 1) return choices[0].provider;
    const result = await vscode.window.showQuickPick(choices, { title });
    return result?.provider;
  }
  async function restoreProvider(provider: Provider) {
    await stop(provider);
    bridges.get(provider)?.adapter.dispose();
    bridges.delete(provider);
    await providers[provider].restore(installed(provider).extensionPath);
    await context.globalState.update(`enabled.${provider}`, false);
    if (provider === 'codex') await context.globalState.update('enabled', false);
    needsSetup.delete(provider);
    updateStatus();
    void vscode.window.showInformationMessage(
      `Original ${providers[provider].name} restored. Reload when work is safe. Conversation history was not changed.`,
    );
  }
  function command(name: string, fn: () => Promise<unknown>) {
    context.subscriptions.push(
      vscode.commands.registerCommand(name, async () => {
        try {
          await fn();
        } catch (error) {
          void vscode.window.showErrorMessage(
            error instanceof Error
              ? error.message
              : 'sciencewithagents could not complete that action.',
          );
        }
      }),
    );
  }
  command('agentDockMirror.menu', async () => {
    const options = [
      {
        label: '$(comment-discussion) Open sciencewithagents chats',
        description: 'Your computer and phone share the same chat list',
        action: 'open',
      },
      {
        label: '$(device-mobile) Share a Codex conversation',
        description: 'Choose one existing Codex chat',
        action: 'codex',
      },
      {
        label: '$(device-mobile) Share a Claude Code conversation',
        description: 'Choose one existing Claude Code chat',
        action: 'claude',
      },
      {
        label: '$(tools) Open native commands and settings',
        description: 'Models, slash commands, skills, MCPs and approvals stay in VS Code',
        action: 'native',
      },
      {
        label: '$(debug-disconnect) Stop sharing',
        description: 'Keeps the original conversations running',
        action: 'stop',
      },
      {
        label: '$(history) Restore an original extension',
        description: 'Remove the recognized sharing patch',
        action: 'restore',
      },
    ];
    const choice = await vscode.window.showQuickPick(options, {
      title: 'sciencewithagents',
      placeHolder: 'Connect a conversation once, then chat from either device',
    });
    if (!choice) return;
    if (choice.action === 'codex' || choice.action === 'claude') return share(choice.action);
    return vscode.commands.executeCommand(`agentDockMirror.${choice.action}`);
  });
  command('agentDockMirror.enable', async () => {
    if (await enable('codex')) await share('codex');
  });
  command('agentDockMirror.share', async () => {
    const provider = await chooseProvider('Which conversation would you like to share?');
    if (provider) await share(provider);
  });
  command('agentDockMirror.shareCodex', () => share('codex'));
  command('agentDockMirror.shareClaude', () => share('claude'));
  command('agentDockMirror.enableClaude', async () => {
    if (await enable('claude')) await share('claude');
  });
  command('agentDockMirror.stop', async () => {
    const active = [...bridges.keys()].filter(
      (provider) => bridges.get(provider)?.adapter.summary.threadId,
    );
    if (active.length <= 1) {
      if (active[0]) await stop(active[0]);
      return;
    }
    const choice = await vscode.window.showQuickPick(
      [
        ...active.map((provider) => ({
          label: `Stop sharing ${providers[provider].name}`,
          provider,
        })),
        { label: 'Stop sharing both', provider: 'both' as const },
      ],
      { title: 'Stop sharing' },
    );
    if (choice?.provider === 'both') {
      for (const provider of active) await stop(provider);
    } else if (choice) await stop(choice.provider);
  });
  command('agentDockMirror.restore', async () => {
    const provider = await chooseProvider('Restore the original extension');
    if (provider) await restoreProvider(provider);
  });
  command('agentDockMirror.restoreCodex', () => restoreProvider('codex'));
  command('agentDockMirror.restoreClaude', () => restoreProvider('claude'));
  command('agentDockMirror.native', async () => {
    const provider = await chooseProvider('Open original commands and settings');
    if (provider)
      await vscode.commands.executeCommand(
        provider === 'codex' ? 'chatgpt.openCommandMenu' : 'claude-vscode.editor.openLast',
      );
  });
  command('agentDockMirror.open', async () =>
    vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${port()}/?mirror=1`)),
  );
  context.subscriptions.push(status, {
    dispose() {
      stopped = true;
      for (const [provider, bridge] of bridges) {
        disconnect(provider);
        bridge.adapter.dispose();
      }
    },
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('agentDockMirror.port'))
        for (const provider of bridges.keys()) void connect(provider);
    }),
  );
  updateStatus();
  await Promise.all(
    (Object.keys(providers) as Provider[]).map(async (provider) => {
      if (!enabled(provider)) return;
      try {
        await providers[provider].patch(installed(provider).extensionPath);
        const id = shared(provider);
        if (id) {
          await (await attach(provider)).select(id);
          void connect(provider);
        }
      } catch {
        needsSetup.add(provider);
      }
    }),
  );
  updateStatus();
}
