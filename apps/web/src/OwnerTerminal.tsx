import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  ownerTerminalOpenSchema,
  ownerTerminalSessionSchema,
  terminalOutputSchema,
  type OwnerTerminalSession,
} from '@dock/shared';
import { api, apiScope, apiUrl } from './api';
import { AssistantFullscreen } from './home/AssistantFullscreen';
import '@xterm/xterm/css/xterm.css';
import './OwnerTerminal.css';

type Receipt = { key: string; id?: string };
function readReceipt(storage: Storage, storageKey: string): Receipt | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(storageKey) ?? 'null');
    if (
      value &&
      typeof value === 'object' &&
      'key' in value &&
      ownerTerminalOpenSchema.safeParse({ key: value.key }).success &&
      (!('id' in value) || ownerTerminalOpenSchema.safeParse({ key: value.id }).success)
    )
      return value as Receipt;
  } catch {
    /* An invalid saved receipt does not select a shell. */
  }
  return null;
}
function receipt(storageKey: string): Receipt {
  const value = readReceipt(localStorage, storageKey) ??
    readReceipt(sessionStorage, storageKey) ?? { key: crypto.randomUUID() };
  // Migrate once, after the durable write succeeds. Tabs and PWA windows share this identity.
  localStorage.setItem(storageKey, JSON.stringify(value));
  sessionStorage.removeItem(storageKey);
  return value;
}
function clearReceipt(storageKey: string, saved: Receipt | null) {
  // Closing an older view must not forget a newer shell opened in another tab.
  if (readReceipt(localStorage, storageKey)?.key === saved?.key)
    localStorage.removeItem(storageKey);
  sessionStorage.removeItem(storageKey);
}

/** Direct owner input only. No model, scheduler, command replay or native account changes. */
export function OwnerTerminal({
  computer,
  fixedSessionId,
  onBack,
}: {
  computer: string;
  fixedSessionId?: string;
  onBack?: () => void;
}) {
  const storageKey = useRef(
    `dock:${apiScope()}:owner-terminal${fixedSessionId ? `:${fixedSessionId}` : ''}`,
  ).current;
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const saved = useRef<Receipt | null>(null);
  const [session, setSession] = useState<OwnerTerminalSession | null>(null);
  const [status, setStatus] = useState('Connecting…');
  const [connection, setConnection] = useState<
    'connecting' | 'ready' | 'closed' | 'exited' | 'moved'
  >('connecting');
  const [attempt, setAttempt] = useState(0);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const back = () => {
    if (onBack) return onBack();
    location.hash = '#/computers';
  };
  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | undefined;
    setConnection('connecting');
    setStatus('Connecting…');
    setError('');
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 16,
      fontFamily: 'SFMono-Regular, Consolas, monospace',
      theme: { background: '#202421', foreground: '#e7ece4', cursor: '#e1a981' },
      scrollback: 3000,
      disableStdin: true,
    });
    terminal.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    const resize = () => {
      if (disposed || !host.current?.clientHeight) return;
      fit.fit();
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: Math.min(300, Math.max(20, term.cols)),
            rows: Math.min(120, Math.max(5, term.rows)),
          }),
        );
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    term.onData((data) => {
      // Disconnected keystrokes are discarded, never buffered for later execution.
      if (ws?.readyState !== WebSocket.OPEN || term.options.disableStdin) return;
      for (let start = 0; start < data.length; start += 8192)
        ws.send(JSON.stringify({ type: 'input', data: data.slice(start, start + 8192) }));
    });
    void (async () => {
      saved.current ??= fixedSessionId
        ? { key: fixedSessionId, id: fixedSessionId }
        : receipt(storageKey);
      const info = ownerTerminalSessionSchema.parse(
        await api(
          saved.current.id ? `/owner-terminal/${saved.current.id}` : '/owner-terminal',
          saved.current.id ? undefined : { key: saved.current.key },
        ),
      );
      saved.current.id = info.id;
      if (readReceipt(localStorage, storageKey)?.key === saved.current.key)
        localStorage.setItem(storageKey, JSON.stringify(saved.current));
      if (disposed) return;
      setSession(info);
      if (info.status === 'exited') {
        setConnection('exited');
        setStatus('Shell closed.');
        return;
      }
      ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${apiUrl(`/owner-terminal/${info.id}/socket`)}`,
      );
      socket.current = ws;
      let ended = '';
      ws.onopen = resize;
      ws.onmessage = (event) => {
        const parsed = terminalOutputSchema.safeParse(JSON.parse(event.data as string));
        if (!parsed.success) {
          ws?.close(1008, 'Invalid terminal response');
          return;
        }
        const value = parsed.data;
        if (value.type === 'ready') {
          setConnection('ready');
          setStatus('Connected · owner shell · no AI usage');
          term.options.disableStdin = false;
          resize();
        } else if (value.type === 'output') term.write(value.data);
        else if (value.type === 'error') {
          ended = value.message;
          setError(value.message);
        } else if (value.type === 'exit') {
          ended = `Shell exited (${value.code}).`;
          setConnection('exited');
        }
      };
      ws.onclose = (event) => {
        term.options.disableStdin = true;
        if (event.code === 4001) {
          setConnection('moved');
          setStatus('Control moved to another browser.');
        } else {
          setConnection(event.code === 1000 ? 'exited' : 'closed');
          setStatus(
            ended ||
              (event.code === 1000
                ? 'Shell closed.'
                : 'Disconnected. Reconnect to the same shell.'),
          );
        }
      };
    })().catch((reason: unknown) => {
      if (disposed) return;
      setConnection('closed');
      setStatus('Could not connect.');
      setError(reason instanceof Error ? reason.message : 'The terminal could not open.');
    });
    return () => {
      disposed = true;
      observer.disconnect();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      socket.current = null;
      terminal.current = null;
      term.dispose();
    };
  }, [attempt, fixedSessionId]);
  const closeShell = async () => {
    if (!session || closing) return;
    setClosing(true);
    setError('');
    try {
      await api(`/owner-terminal/${session.id}/close`, {});
      clearReceipt(storageKey, saved.current);
      back();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not close the shell. Retry close.',
      );
    } finally {
      setClosing(false);
    }
  };
  return (
    <AssistantFullscreen
      title={`Terminal · ${computer}`}
      back="Back to computers"
      close={back}
      controls={
        <button
          className="flow-button"
          disabled={!session || closing}
          onClick={() => void closeShell()}
        >
          {closing ? 'Closing…' : 'Close shell'}
        </button>
      }
    >
      <section className="owner-terminal" aria-label="Owner shell terminal">
        <div className="owner-terminal-status" role="status">
          <span>{status}</span>
          {(connection === 'closed' || connection === 'moved') && (
            <button onClick={() => setAttempt((v) => v + 1)}>
              {connection === 'moved' ? 'Take control here' : 'Reconnect'}
            </button>
          )}
          {!fixedSessionId && (connection === 'exited' || connection === 'closed') && (
            <button
              onClick={() => {
                clearReceipt(storageKey, saved.current);
                saved.current = null;
                setSession(null);
                setAttempt((v) => v + 1);
              }}
            >
              New terminal
            </button>
          )}
        </div>
        {session && (
          <p className="owner-terminal-location">
            {session.computer} · {session.shell} · {session.cwd}
          </p>
        )}
        {error && (
          <p className="owner-terminal-error" role="alert">
            {error}
          </p>
        )}
        <div className="owner-terminal-host" ref={host} />
        <div className="owner-terminal-keys" aria-label="Terminal control keys">
          {[
            ['Esc', '\u001b'],
            ['Tab', '\t'],
            ['↑', '\u001b[A'],
            ['↓', '\u001b[B'],
            ['Ctrl C', '\u0003'],
            ['Ctrl D', '\u0004'],
            ['Enter', '\r'],
          ].map(([label, data]) => (
            <button
              key={label}
              disabled={connection !== 'ready'}
              onClick={() => {
                if (socket.current?.readyState === WebSocket.OPEN)
                  socket.current.send(JSON.stringify({ type: 'input', data }));
                terminal.current?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
    </AssistantFullscreen>
  );
}
