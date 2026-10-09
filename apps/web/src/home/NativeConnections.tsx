import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, RefreshCw, Terminal as TerminalIcon } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  nativeConnectionAttachSchema,
  nativeConnectionAttachmentSchema,
  nativeConnectionDetachSchema,
  nativeConnectionPromptListSchema,
  nativeConnectionSendSchema,
  nativeConnectionSendReceiptSchema,
  nativeConnectionsViewSchema,
  id as uuidSchema,
  terminalOutputSchema,
  type NativeConnectionAttach,
  type NativeConnectionAttachment,
  type NativeConnectionSend,
  type NativeConnectionSendReceipt,
} from '@dock/shared';
import { api, apiScope, apiUrl, ApiError, connectionLost } from '../api';
import { Modal } from '../Modal';
import { PromptHistory } from '../PromptHistory';
import { useBackStep } from './Navigation';
import '@xterm/xterm/css/xterm.css';
import './NativeConnections.css';

const base = '/native-connections';
const href = (id: string) => `#/chats/native/${encodeURIComponent(id)}`;
const storageKey = (name: string) => `dock:${apiScope()}:native-connection:${name}`;
function stored<T>(key: string, parse: (value: unknown) => T): T | null {
  try {
    return parse(JSON.parse(localStorage.getItem(key) ?? 'null'));
  } catch {
    return null;
  }
}
function persist(key: string, value: unknown) {
  // A failed durable write refuses a new effect rather than losing its retry identity.
  localStorage.setItem(key, JSON.stringify(value));
}
function receiptLabel(state: NativeConnectionSendReceipt['state']) {
  return state === 'delivered'
    ? 'Delivered to terminal pane'
    : state === 'not_sent'
      ? 'Not sent'
      : 'Delivery uncertain';
}
function exactReceipt(value: unknown, input: SavedSend) {
  const receipt = nativeConnectionSendReceiptSchema.parse(value);
  if (
    receipt.key !== input.key ||
    receipt.attachmentId !== input.attachmentId ||
    receipt.inputToken !== input.inputToken ||
    receipt.text !== input.text
  )
    throw new Error('The receipt does not match the original saved prompt. Nothing was resent.');
  return receipt;
}
function message(error: unknown) {
  return error instanceof Error ? error.message : 'Could not read this connection. Try again.';
}

/** Discovery is a read on opening or explicit refresh, never an attach or native launch. */
export function useNativeConnections(enabled: boolean) {
  const [view, setView] = useState<ReturnType<typeof nativeConnectionsViewSchema.parse> | null>(
    null,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let alive = true;
    setBusy(true);
    setError('');
    void api(base, undefined, controller.signal)
      .then((value) => {
        if (alive) setView(nativeConnectionsViewSchema.parse(value));
      })
      .catch((reason: unknown) => {
        if (alive) setError(message(reason));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [enabled, revision]);
  return { view, error, busy, refresh: () => setRevision((value) => value + 1) };
}

export function NativeConnectionRows({
  connections,
  query,
  selectedId,
}: {
  connections: ReturnType<typeof useNativeConnections>;
  query: string;
  selectedId: string;
}) {
  const term = query.trim().toLowerCase();
  return (
    <>
      {connections.view?.attachments.map((attachment) => {
        const target = connections.view?.targets.find(
          (target) => target.id === attachment.targetId,
        );
        const label = target?.label ?? 'Retained terminal connection';
        if (term && !`${label} ${attachment.status}`.toLowerCase().includes(term)) return null;
        return (
          <a
            key={attachment.id}
            className={`flow-person chat-row vscode native-connection-row${selectedId === attachment.id ? ' selected' : ''}`}
            href={href(attachment.id)}
            aria-current={selectedId === attachment.id ? 'page' : undefined}
          >
            <span className="chat-row-icon vscode" aria-hidden="true">
              <TerminalIcon size={17} />
            </span>
            <span className="chat-row-text">
              <strong>{label}</strong>
              <small>
                External terminal · {attachment.mode === 'observe' ? 'Observe' : 'Control'}
              </small>
            </span>
            <span className="chat-row-side">{attachment.status}</span>
          </a>
        );
      })}
    </>
  );
}

/** An issued target ID is the whole selection; no paths, command text or native config. */
export function NativeConnectionPicker({
  connections,
  close,
  connected,
}: {
  connections: ReturnType<typeof useNativeConnections>;
  close: () => void;
  connected: (id: string) => void;
}) {
  useBackStep(close);
  const pendingKey = storageKey('attach');
  const [pending, setPending] = useState(() =>
    stored(pendingKey, nativeConnectionAttachSchema.parse),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const working = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const attach = async (request: NativeConnectionAttach) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    let dispatched = false;
    try {
      const other = stored(pendingKey, nativeConnectionAttachSchema.parse);
      if (other && other.key !== request.key) {
        setPending(other);
        throw new Error(
          'Another tab has a retained connection request. Check it first; no new connection was sent.',
        );
      }
      persist(pendingKey, request);
      setPending(request);
      dispatched = true;
      const result = nativeConnectionAttachmentSchema.parse(await api(`${base}/attach`, request));
      if (result.targetId !== request.targetId || result.mode !== request.mode)
        throw new Error('The connection receipt does not match the original selection.');
      // Keep a lost-reply request until an exact acknowledged response is available.
      if (stored(pendingKey, nativeConnectionAttachSchema.parse)?.key === request.key)
        localStorage.removeItem(pendingKey);
      if (!alive.current) return;
      setPending(null);
      connections.refresh();
      connected(result.id);
    } catch (reason) {
      const refused = reason instanceof ApiError && reason.status >= 400 && reason.status < 500;
      if (refused && stored(pendingKey, nativeConnectionAttachSchema.parse)?.key === request.key)
        localStorage.removeItem(pendingKey);
      if (alive.current) {
        if (refused) setPending(null);
        setError(
          `${message(reason)} ${!dispatched ? 'No new connection request was sent.' : refused ? 'No connection was opened. Refresh sessions before choosing again.' : 'The original connection request is retained.'}`,
        );
      }
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Modal title="Connect a native session" close={close} className="native-connections-dialog">
      <p>
        Connect an existing terminal session. It keeps running where it started; this app does not
        own its lifetime or read its complete chat history.
      </p>
      <p className="muted">
        Observe opens without typing or taking control from your desktop. Request control is an
        explicit owner action. Missing tools, SSH authentication and unsupported versions are shown
        below.
      </p>
      {error && <p role="alert">{error}</p>}
      {pending && (
        <div className="native-connection-recovery" role="status">
          <p>
            A connection request is saved. Check that same request before choosing another session.
          </p>
          <button className="secondary" disabled={busy} onClick={() => void attach(pending)}>
            Check original connection
          </button>
        </div>
      )}
      {connections.error && <p role="alert">{connections.error}</p>}
      <button
        className="secondary"
        disabled={connections.busy || busy}
        onClick={connections.refresh}
      >
        <RefreshCw size={16} /> {connections.busy ? 'Reading sessions…' : 'Refresh sessions'}
      </button>
      {connections.view?.sources.map((source) => (
        <section className="native-source" key={source.id}>
          <h3>
            {source.label} · {source.location === 'ssh' ? 'SSH' : 'This computer'}
          </h3>
          {source.message && (
            <p role={source.state === 'available' ? 'status' : 'alert'}>{source.message}</p>
          )}
          <ul>
            {connections.view?.targets
              .filter((target) => target.sourceId === source.id)
              .map((target) => (
                <li key={target.id}>
                  <strong>{target.label}</strong>
                  <p>
                    Native status: {target.nativeStatus}. Terminal status does not confirm an agent
                    turn or completion.
                  </p>
                  <div className="native-connection-actions">
                    <button
                      className="secondary"
                      disabled={busy || !!pending || !target.canObserve}
                      onClick={() =>
                        void attach({
                          key: crypto.randomUUID(),
                          targetId: target.id,
                          mode: 'observe',
                        })
                      }
                    >
                      Observe
                    </button>
                    {target.canControl && (
                      <button
                        className="secondary"
                        disabled={
                          busy ||
                          !!pending ||
                          (target.controlPolicy === 'exclusive' && target.controller === 'occupied')
                        }
                        onClick={() =>
                          void attach({
                            key: crypto.randomUUID(),
                            targetId: target.id,
                            mode: 'control',
                          })
                        }
                      >
                        Request control
                      </button>
                    )}
                  </div>
                  {target.controlPolicy === 'exclusive' && target.controller !== 'free' && (
                    <p className="muted">
                      {target.controller === 'occupied'
                        ? `Control is held by ${target.controllerLabel ?? 'another native client'}. Release it there before requesting control here.`
                        : 'The current controller is unknown. Request control can only acquire a free slot; it does not take over another client.'}
                    </p>
                  )}
                  {!target.canControl && (
                    <p className="muted">
                      Control is unavailable. Safe control requires supported capabilities and an
                      exact native session identity.
                    </p>
                  )}
                </li>
              ))}
          </ul>
        </section>
      ))}
      {connections.view && !connections.view.targets.length && (
        <p>
          No connectable sessions found. Start one in your native terminal or use Chat to create an
          app-owned personal conversation.
        </p>
      )}
    </Modal>
  );
}

type SavedSend = NativeConnectionSend & { attachmentId: string };
function readSend(key: string): SavedSend | null {
  return stored(key, nativeConnectionSendSchema.extend({ attachmentId: uuidSchema }).parse);
}

export function NativeConnectionPane({
  id,
  changed,
  connect,
}: {
  id: string;
  changed: () => void;
  connect: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const [attachment, setAttachment] = useState<NativeConnectionAttachment | null>(null);
  const [status, setStatus] = useState('Reading connection…');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [readRevision, setReadRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);
  const [notSent, setNotSent] = useState('');
  const [receipt, setReceipt] = useState<NativeConnectionSendReceipt | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<NativeConnectionSendReceipt | null>(null);
  const sendKey = storageKey(`send:${id}`);
  const draftKey = storageKey(`draft:${id}`);
  const detachKey = storageKey(`detach:${id}`);
  const [pendingDetach, setPendingDetach] = useState(() =>
    stored(detachKey, nativeConnectionDetachSchema.parse),
  );
  const [pending, setPending] = useState(() => readSend(sendKey));
  const [draft, setDraft] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? '';
    } catch {
      return '';
    }
  });
  const active = useRef(true);
  const working = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let ws: WebSocket | undefined;
    setReady(false);
    setError('');
    const term = new Terminal({
      fontSize: 16,
      fontFamily: 'SFMono-Regular, Consolas, monospace',
      scrollback: 2000,
      disableStdin: true,
      theme: { background: '#202421', foreground: '#e7ece4' },
    });
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
      if (term.options.disableStdin || ws?.readyState !== WebSocket.OPEN) return;
      for (let offset = 0; offset < data.length; offset += 8192)
        ws.send(JSON.stringify({ type: 'input', data: data.slice(offset, offset + 8192) }));
    });
    void api(`${base}/attachments/${id}`, undefined, controller.signal)
      .then((value) => {
        const info = nativeConnectionAttachmentSchema.parse(value);
        if (disposed) return;
        setAttachment(info);
        setStatus(info.message || info.status);
        // Only a newly reserved attachment may open its native client. A retained
        // connected/ended attachment is read-only until the owner explicitly attaches again.
        if (info.status !== 'connecting') return;
        ws = new WebSocket(
          `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${apiUrl(`${base}/attachments/${id}/socket`)}`,
        );
        socket.current = ws;
        ws.onopen = resize;
        ws.onmessage = (event) => {
          if (disposed) return;
          let value;
          try {
            value = terminalOutputSchema.parse(JSON.parse(event.data as string));
          } catch {
            ws?.close(1008, 'Invalid terminal response');
            return;
          }
          if (value.type === 'ready') {
            setAttachment({ ...info, status: 'connected' });
            setReady(true);
            setStatus(
              info.mode === 'observe'
                ? 'Observing · input disabled'
                : 'Control connected · owner input',
            );
            term.options.disableStdin = info.mode !== 'control' || !info.inputToken;
          } else if (value.type === 'output') term.write(value.data);
          else if (value.type === 'error') {
            setReady(false);
            term.options.disableStdin = true;
            setError(value.message);
            setStatus(value.message);
          } else if (value.type === 'exit') {
            setReady(false);
            term.options.disableStdin = true;
            setStatus(
              `Terminal attachment ended (${value.code}). The native session may still be running.`,
            );
          }
        };
        ws.onclose = () => {
          if (disposed) return;
          term.options.disableStdin = true;
          setReady(false);
          setStatus(
            'Attachment disconnected. Connect explicitly again after checking the native session.',
          );
          changed();
          // Status inspection cannot open another client or replay a takeover/input effect.
          void api(`${base}/attachments/${id}`, undefined, controller.signal)
            .then((value) => {
              if (disposed) return;
              const ended = nativeConnectionAttachmentSchema.parse(value);
              setAttachment(ended);
              setStatus(ended.message || ended.status);
            })
            .catch((reason: unknown) => {
              if (!disposed) setError(message(reason));
            });
        };
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setError(message(reason));
          setStatus('Connection unavailable.');
        }
      });
    return () => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      socket.current = null;
      term.dispose();
    };
  }, [id, readRevision]);
  const controlled = attachment?.mode === 'control';
  const canSend = ready && controlled && !!attachment.inputToken;
  const settle = (value: NativeConnectionSendReceipt) => {
    setReceipt(value);
    setNotSent('');
    setPending(null);
    if (readSend(sendKey)?.key === value.key) localStorage.removeItem(sendKey);
    // A newer edited draft belongs to the owner, not to this completed delivery receipt.
    setDraft((current) => {
      if (value.state === 'not_sent') return current;
      if (current !== value.text) return current;
      localStorage.removeItem(draftKey);
      return '';
    });
  };
  const send = async () => {
    if (!canSend || !attachment?.inputToken || pending || working.current || !draft.trim()) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotSent('');
    setReceipt(null);
    let request: SavedSend | undefined;
    let dispatched = false;
    try {
      const other = readSend(sendKey);
      if (other) {
        setPending(other);
        throw new Error(
          'A saved prompt needs its original receipt checked first. Nothing new was sent.',
        );
      }
      const input = nativeConnectionSendSchema.parse({
        key: crypto.randomUUID(),
        inputToken: attachment.inputToken,
        text: draft,
      });
      request = { ...input, attachmentId: id };
      persist(sendKey, request);
      setPending(request);
      dispatched = true;
      const result = exactReceipt(await api(`${base}/attachments/${id}/send`, input), request);
      if (active.current) settle(result);
    } catch (reason) {
      if (active.current) {
        // The initial send's definite 4xx occurs before native handoff/journaling.
        // Receipt inspection failures and uncertain dispatches keep their exact intent.
        const refused =
          dispatched &&
          reason instanceof ApiError &&
          reason.status >= 400 &&
          reason.status < 500 &&
          !connectionLost(reason);
        if (refused && request) {
          if (readSend(sendKey)?.key === request.key) localStorage.removeItem(sendKey);
          const key = request.key;
          setPending((current) => (current?.key === key ? null : current));
        }
        if (!dispatched || refused)
          setNotSent(
            `${message(reason)} Your draft is retained. Nothing new was handed to the native program; check the connection before sending again.`,
          );
        else
          setError(
            `${message(reason)} Check the saved receipt; do not resend an uncertain prompt.`,
          );
      }
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  };
  const checkReceipt = async () => {
    if (!pending || working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const result = exactReceipt(
        await api(`${base}/attachments/${pending.attachmentId}/receipts/${pending.key}`),
        pending,
      );
      if (active.current) settle(result);
    } catch (reason) {
      if (active.current)
        setError(
          `${message(reason)} The exact prompt is still retained in this browser. Nothing was resent.`,
        );
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  };
  const detach = async () => {
    if (working.current || !attachment || (!pendingDetach && attachment.status === 'detached'))
      return;
    working.current = true;
    setBusy(true);
    setError('');
    let dispatched = false;
    try {
      const request = pendingDetach ??
        stored(detachKey, nativeConnectionDetachSchema.parse) ?? { key: crypto.randomUUID() };
      persist(detachKey, request);
      setPendingDetach(request);
      dispatched = true;
      const result = nativeConnectionAttachmentSchema.parse(
        await api(`${base}/attachments/${id}/detach`, request),
      );
      if (result.id !== id) throw new Error('The detach receipt does not match this attachment.');
      if (stored(detachKey, nativeConnectionDetachSchema.parse)?.key === request.key)
        localStorage.removeItem(detachKey);
      if (active.current) {
        setPendingDetach(null);
        if (socket.current) {
          socket.current.onclose = null;
          socket.current.close();
        }
        setAttachment(result);
        setReady(false);
        setStatus('Detached. The native session continues where it started.');
        changed();
      }
    } catch (reason) {
      if (active.current)
        setError(
          `${message(reason)} ${dispatched ? 'Check the saved detach request.' : 'This browser could not save the detach intent. No detach request was sent.'}`,
        );
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <section className="native-connection-pane">
      <header className="native-connection-bar">
        <a className="secondary" href="#/chats" aria-label="All chats">
          <ChevronLeft size={18} /> Back
        </a>
        <h2>External native terminal</h2>
        {!ready && (
          <button className="secondary" onClick={connect}>
            Connect a session
          </button>
        )}
        <button
          className="secondary"
          disabled={busy || !attachment || (!pendingDetach && attachment.status === 'detached')}
          onClick={() => void detach()}
        >
          {pendingDetach ? 'Check saved detach' : 'Detach'}
        </button>
      </header>
      <p role="status">{status}</p>
      <p className="muted">
        Back closes this view. Detach releases this attachment; neither stops the external session.
        Raw terminal keys are owner input and are not saved as prompts.
      </p>
      {error && <p role="alert">{error}</p>}
      {notSent && (
        <div className="native-connection-receipt" role="status">
          <strong>Not sent</strong>
          <p>{notSent}</p>
        </div>
      )}
      {!attachment && (
        <button className="secondary" onClick={() => setReadRevision((value) => value + 1)}>
          Read connection again
        </button>
      )}
      <div className="native-connection-terminal" ref={host} aria-label="Native terminal output" />
      {controlled && (
        <>
          <div className="native-connection-actions">
            {(
              [
                ['Esc', '\u001b'],
                ['Tab', '\t'],
                ['Ctrl C', '\u0003'],
                ['Enter', '\r'],
              ] as const
            ).map(([label, data]) => (
              <button
                className="secondary"
                key={label}
                disabled={!canSend}
                onClick={() => {
                  if (socket.current?.readyState === WebSocket.OPEN)
                    socket.current.send(JSON.stringify({ type: 'input', data }));
                }}
              >
                {label}
              </button>
            ))}
            <button className="secondary" onClick={() => setHistory(true)}>
              Your saved prompts
            </button>
          </div>
          <label className="native-connection-draft">
            Prompt to send and save
            <textarea
              value={draft}
              onChange={(event) => {
                const value = event.target.value;
                setDraft(value);
                try {
                  localStorage.setItem(draftKey, value);
                } catch {
                  setError('This browser could not save the draft. It remains in this view.');
                }
              }}
            />
          </label>
          <p className="muted">
            Send pastes this text into the current terminal program and presses Enter. That program
            could be a shell, so check its prompt before sending. The receipt proves pane delivery,
            not agent acceptance or completion. Uncertain delivery is never replayed automatically.
          </p>
          {pending ? (
            <div className="native-connection-recovery">
              <p role="status">
                A prompt has an unresolved delivery receipt. Nothing is queued for automatic
                sending.
              </p>
              <pre className="native-saved-prompt" aria-label="Unresolved saved terminal prompt">
                {pending.text}
              </pre>
              <button className="secondary" disabled={busy} onClick={() => void checkReceipt()}>
                Check saved receipt
              </button>
            </div>
          ) : (
            <button
              className="primary"
              disabled={!canSend || busy || !draft.trim()}
              onClick={() => void send()}
            >
              Send and save prompt
            </button>
          )}
          {receipt && (
            <div className="native-connection-receipt" role="status">
              <strong>{receiptLabel(receipt.state)}</strong>
              <p>{receipt.message}</p>
              <button className="secondary" onClick={() => setSelectedReceipt(receipt)}>
                View saved prompt
              </button>
            </div>
          )}
        </>
      )}
      {history && attachment && (
        <PromptHistory
          className="native-saved-prompts"
          title="Your saved prompts"
          description="Only prompts submitted through this app are listed. Raw terminal input and complete native chat history are not recorded. Viewing a receipt sends nothing."
          choiceLabel="View saved receipt"
          read={async (before) => {
            const page = nativeConnectionPromptListSchema.parse(
              await api(
                `${base}/targets/${attachment.targetId}/prompts${before ? `?before=${encodeURIComponent(before)}` : ''}`,
              ),
            );
            return {
              value: page,
              prompts: page.items.map((item) => ({
                id: item.key,
                text: `${receiptLabel(item.state)} · ${item.textPreview}`,
                createdAt: item.createdAt,
              })),
              before: page.nextCursor ?? undefined,
            };
          }}
          choose={(page, key) => {
            const item = page.items.find((item) => item.key === key);
            if (!item) return;
            void api(`${base}/attachments/${item.attachmentId}/receipts/${key}`)
              .then((value) => {
                if (active.current) {
                  setSelectedReceipt(nativeConnectionSendReceiptSchema.parse(value));
                  setHistory(false);
                }
              })
              .catch((reason: unknown) => {
                if (active.current) setError(message(reason));
              });
          }}
          close={() => setHistory(false)}
        />
      )}
      {selectedReceipt && (
        <Modal
          title="Saved terminal prompt"
          close={() => setSelectedReceipt(null)}
          className="native-connections-dialog"
        >
          <p>
            {receiptLabel(selectedReceipt.state)} · {selectedReceipt.message}
          </p>
          <pre className="native-saved-prompt">{selectedReceipt.text}</pre>
          <p className="muted">
            This is the original receipt. Opening it does not send or replay the prompt.
          </p>
        </Modal>
      )}
    </section>
  );
}
