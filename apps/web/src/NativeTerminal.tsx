import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ArrowLeft, CircleHelp } from 'lucide-react';
import { api, apiUrl } from './api';
import { Modal } from './Modal';
import { terminalOutputSchema } from '@dock/shared';

export function NativeTerminal({
  agentId,
  onClose,
  onTransfer,
}: {
  agentId: string;
  onClose: () => void;
  onTransfer: (agentId: string) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const transfer = useRef(onTransfer);
  transfer.current = onTransfer;
  const [status, setStatus] = useState('Connecting to Codex…');
  const [closePending, setClosePending] = useState(false);
  const [closeError, setCloseError] = useState('');
  const [help, setHelp] = useState(false);
  const [connection, setConnection] = useState<'connecting' | 'ready' | 'closed' | 'moved'>(
    'connecting',
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setConnection('connecting');
    setStatus('Connecting to Codex…');
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'SFMono-Regular, Consolas, monospace',
      theme: { background: '#202421', foreground: '#e7ece4', cursor: '#e1a981' },
      convertEol: true,
      scrollback: 6000,
      disableStdin: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current!);
    fit.fit();
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${apiUrl(`/agents/${agentId}/terminal`)}`,
    );
    socket.current = ws;
    let sized = false;
    let endedMessage: string | null = null;
    const resize = () => {
      fit.fit();
      terminal.scrollToBottom();
      if (ws.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: Math.min(300, Math.max(20, terminal.cols)),
            rows: Math.min(120, Math.max(5, terminal.rows)),
          }),
        );
    };
    ws.onopen = () => {
      setStatus('Starting native Codex…');
      resize();
    };
    ws.onmessage = (event) => {
      const value = terminalOutputSchema.parse(JSON.parse(event.data as string));
      if (value.type === 'ready') {
        setStatus('Native Codex · connected');
        setConnection('ready');
        terminal.options.disableStdin = false;
        terminal.focus();
      }
      if (value.type === 'transferred') {
        terminal.reset();
        transfer.current(value.agentId);
      }
      if (value.type === 'output') {
        terminal.write(value.data, () => terminal.scrollToBottom());
        if (!sized) {
          sized = true;
          resize();
        }
      }
      if (value.type === 'error') {
        endedMessage = value.message ?? 'Could not attach';
        setStatus(endedMessage);
        terminal.writeln(`\r\n${value.message}`);
      }
      if (value.type === 'exit') {
        endedMessage = `Codex terminal exited (${value.code}). Return to chat to reconnect.`;
        setStatus(endedMessage);
      }
    };
    ws.onclose = (event) => {
      terminal.options.disableStdin = true;
      setConnection(event.code === 4001 ? 'moved' : 'closed');
      setStatus(
        event.code === 4001
          ? 'Control moved to another browser.'
          : (endedMessage ?? 'Connection lost. Reconnect when you are online.'),
      );
    };
    terminal.onData((data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
    });
    const observer = new ResizeObserver(resize);
    observer.observe(element.current!);
    return () => {
      observer.disconnect();
      ws.onclose = null;
      ws.close();
      terminal.dispose();
    };
  }, [agentId, attempt]);
  const close = async () => {
    if (closePending) return;
    setClosePending(true);
    setCloseError('');
    try {
      await api(`/agents/${agentId}/terminal/close`, {});
      onClose();
    } catch {
      setCloseError(
        'We couldn’t return to chat. Check your connection and try again. Your conversation is still saved.',
      );
    } finally {
      setClosePending(false);
    }
  };
  return (
    <section className="terminal-pane">
      <div className="terminal-bar">
        <button disabled={closePending} onClick={() => void close()}>
          <ArrowLeft size={16} /> Return to chat
        </button>
        <span>{status}</span>
        {(connection === 'closed' || connection === 'moved') && (
          <button onClick={() => setAttempt((value) => value + 1)}>
            {connection === 'moved' ? 'Take control here' : 'Reconnect terminal'}
          </button>
        )}
        <button
          aria-label="Native Codex help"
          title="Native Codex help"
          onClick={() => setHelp(true)}
        >
          <CircleHelp size={17} />
        </button>
      </div>
      {closeError && (
        <p className="terminal-note" role="alert">
          {closeError}
        </p>
      )}
      <div className="terminal-host" ref={element} />
      <div className="terminal-keys">
        {[
          ['Esc', '\u001b'],
          ['Tab', '\t'],
          ['↑', '\u001b[A'],
          ['↓', '\u001b[B'],
          ['Ctrl C', '\u0003'],
          ['Enter', '\r'],
        ].map(([label, data]) => (
          <button
            key={label}
            disabled={connection !== 'ready'}
            onClick={() => {
              if (socket.current?.readyState === WebSocket.OPEN)
                socket.current.send(JSON.stringify({ type: 'input', data }));
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="terminal-note">
        Your full Codex terminal. Use Help for slash commands, skills and connected tools.
      </p>
      {help && (
        <Modal title="Native Codex help" close={() => setHelp(false)}>
          <p>
            This is the real Codex terminal for this conversation. Type / to see its commands; use
            /skills or $ to choose a skill, /plugins to manage plugins, and /mcp to inspect
            connected MCP tools. Model and permission controls remain available in Codex.
          </p>
          <p>
            Closing the browser keeps this terminal alive. Return to chat when you want the simpler
            conversation view. If a phone sleeps or changes networks, Reconnect terminal returns to
            the saved terminal without resending input. Take control here explicitly transfers input
            from another device. Manager tools remain restricted by role.
          </p>
          <p>
            /new and /fork keep this agent’s archive and task; /resume restores a saved context or
            transfers control to its registered agent. Use Existing Codex sessions to import an
            external session first.
          </p>
        </Modal>
      )}
    </section>
  );
}
