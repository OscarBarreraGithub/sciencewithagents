import { useEffect, useRef, useState } from 'react';
import {
  mirrorQuestionAnswerSchema,
  mirrorQuestionReceiptSchema,
  mirrorResultSchema,
  type MirrorNativeRequest,
  type MirrorQuestionReceipt,
} from '@dock/shared';
import { api, apiScope } from './api';
import { Modal } from './Modal';
import './MirrorNativeRequests.css';

/** Native question responses have their own exact receipts, never composer/outbox drafts. */
export function MirrorNativeRequests({
  windowId,
  threadId,
  requests,
  unavailable,
  online,
  daemon,
  provider,
  readReady,
  error,
  retry,
}: {
  windowId: string;
  threadId: string;
  requests?: MirrorNativeRequest[];
  unavailable?: boolean;
  online: boolean;
  daemon: boolean;
  provider: 'codex' | 'claude';
  readReady: boolean;
  error: string;
  retry: () => void;
}) {
  const place = daemon ? 'on your computer' : 'in VS Code';
  const storageKey = `dock:mirror-question-receipts:${apiScope()}:${provider}:${threadId}`;
  const [receipts, setReceipts] = useState<MirrorQuestionReceipt[]>(() => {
    try {
      return mirrorQuestionReceiptSchema
        .array()
        .max(8)
        .parse(JSON.parse(sessionStorage.getItem(storageKey) ?? '[]'))
        .filter((receipt) => receipt.threadId === threadId);
    } catch {
      return [];
    }
  });
  const [open, setOpen] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const handled = useRef(new Set<string>());
  const current = (requests ?? []).filter((request) => request.threadId === threadId);
  useEffect(() => {
    const tokens = new Set(
      (requests ?? [])
        .filter((request) => request.threadId === threadId)
        .map((request) => request.token),
    );
    setValues((old) =>
      Object.keys(old).every((token) => tokens.has(token))
        ? old
        : Object.fromEntries(Object.entries(old).filter(([token]) => tokens.has(token))),
    );
    const retained = new Set([...tokens, ...receipts.map((receipt) => receipt.token)]);
    setMessages((old) =>
      Object.keys(old).every((token) => retained.has(token))
        ? old
        : Object.fromEntries(Object.entries(old).filter(([token]) => retained.has(token))),
    );
  }, [requests, receipts, threadId]);
  const selected = current.find((request) => request.token === open);
  const canAnswer = (request: MirrorNativeRequest) =>
    provider === 'codex' &&
    online &&
    !unavailable &&
    request.observation === 'pending' &&
    request.response === 'answer' &&
    request.kind === 'question' &&
    !!request.turnId &&
    request.questions.length > 0 &&
    request.questions.every((question) => !question.isSecret) &&
    !handled.current.has(request.token) &&
    !receipts.some((receipt) => receipt.token === request.token);
  function save(next: MirrorQuestionReceipt[]) {
    sessionStorage.setItem(storageKey, JSON.stringify(next));
    setReceipts(next);
  }
  async function answer(request: MirrorNativeRequest) {
    if (busyRef.current || !canAnswer(request) || receipts.length >= 8) return;
    const parsed = mirrorQuestionAnswerSchema.safeParse({
      key: crypto.randomUUID(),
      provider: 'codex',
      token: request.token,
      threadId,
      turnId: request.turnId,
      answers: Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          [values[request.token]?.[question.id] ?? ''],
        ]),
      ),
    });
    if (!parsed.success) return;
    const receipt = mirrorQuestionReceiptSchema.parse({
      key: parsed.data.key,
      token: request.token,
      threadId,
      turnId: request.turnId,
    });
    try {
      save([...receipts, receipt]);
    } catch {
      setMessages((old) => ({
        ...old,
        [request.token]: `This browser could not save the answer receipt. Nothing was sent. Allow browser storage or answer ${place}.`,
      }));
      return;
    }
    busyRef.current = true;
    setBusy(receipt.key);
    try {
      const result = mirrorResultSchema.parse(
        await api(`/vscode/windows/${windowId}/questions/answer`, parsed.data),
      );
      setMessages((old) => ({ ...old, [request.token]: result.message }));
      if (result.state !== 'uncertain') {
        if (result.state === 'sent') handled.current.add(request.token);
        save(receipts);
      }
    } catch {
      setMessages((old) => ({
        ...old,
        [request.token]: `Answer delivery is not confirmed. Check its status or inspect the original request ${place}; nothing is repeated automatically.`,
      }));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }
  async function check(receipt: MirrorQuestionReceipt) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(receipt.key);
    try {
      const result = mirrorResultSchema.parse(await api(`/vscode/deliveries/${receipt.key}`));
      setMessages((old) => ({ ...old, [receipt.token]: result.message }));
      if (result.state !== 'uncertain') {
        if (result.state === 'sent') handled.current.add(receipt.token);
        save(receipts.filter((item) => item.key !== receipt.key));
      }
    } catch {
      setMessages((old) => ({
        ...old,
        [receipt.token]: `Answer status is unavailable. The original receipt is retained. Inspect the request ${place}; no answer was repeated.`,
      }));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }
  if (
    (!readReady || (requests !== undefined && !unavailable)) &&
    !current.length &&
    !receipts.length
  )
    return null;
  return (
    <section className="mirror-native-requests" aria-label="Native requests">
      {error && current.length > 0 && (
        <p role="status">
          {error}{' '}
          <button className="secondary" onClick={retry}>
            Retry native requests
          </button>
        </p>
      )}
      {current.length ? (
        <div className="mirror-native-summary">
          <div>
            <strong>
              {online &&
              !unavailable &&
              current.every((request) => request.observation === 'pending')
                ? `${current.length} native ${current.length === 1 ? 'request needs' : 'requests need'} your input`
                : 'Last observed native request — confirmation unavailable'}
            </strong>
            <p>{(current[0]!.questions[0]?.question || current[0]!.title).slice(0, 160)}</p>
          </div>
          <button className="secondary" onClick={() => setOpen(current[0]!.token)}>
            Review request{current.length === 1 ? '' : 's'}
          </button>
        </div>
      ) : requests === undefined || unavailable ? (
        <details className="mirror-native-support">
          <summary>
            Native questions:{' '}
            {unavailable ? 'confirmation unavailable' : 'not supported by this connection'}
          </summary>
          <p>
            {error ||
              `Check for questions and permissions ${place}. This connection cannot confirm them here. An older companion may need an update when the editor's running work is safe.`}
          </p>
          {error && (
            <button className="secondary" onClick={retry}>
              Retry native requests
            </button>
          )}
          {!daemon && (
            <a className="secondary" href="#/vscode">
              VS Code connection help
            </a>
          )}
        </details>
      ) : null}
      {!!receipts.length && (
        <details className="mirror-native-receipts" open={!!open}>
          <summary>
            {receipts.length} native answer receipt{receipts.length === 1 ? '' : 's'} to check
          </summary>
          {receipts.map((receipt) => (
            <div key={receipt.key}>
              <p role="status">
                {messages[receipt.token] ||
                  `Answer delivery is not confirmed. Inspect the original request ${place}.`}
              </p>
              <button className="secondary" disabled={!!busy} onClick={() => void check(receipt)}>
                {busy === receipt.key ? 'Checking…' : 'Check answer status'}
              </button>
              <button
                className="secondary"
                disabled={!!busy}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Have you checked this request ${place}? This clears only its browser receipt. It will not answer or replay anything.`,
                    )
                  )
                    return;
                  try {
                    save(receipts.filter((item) => item.key !== receipt.key));
                    handled.current.add(receipt.token);
                  } catch {
                    setMessages((old) => ({
                      ...old,
                      [receipt.token]: 'The browser receipt could not be cleared; it is retained.',
                    }));
                  }
                }}
              >
                I checked {place}
              </button>
            </div>
          ))}
        </details>
      )}
      {open && (
        <Modal title="Native request" className="mirror-native-dialog" close={() => setOpen(null)}>
          {current.length > 1 && (
            <label>
              Request
              <select value={open} onChange={(event) => setOpen(event.target.value)}>
                {current.map((request) => (
                  <option key={request.token} value={request.token}>
                    {request.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!selected ? (
            <p>
              This request is no longer reported as pending. That does not confirm answer delivery.
            </p>
          ) : (
            <>
              <h3>{selected.title}</h3>
              {selected.message && <p>{selected.message}</p>}
              {!online || unavailable || selected.observation !== 'pending' ? (
                <p role="status">
                  This is the last observed request. Reconnect and wait for a fresh reading before
                  answering.
                </p>
              ) : null}
              {selected.questions.map((question) => (
                <fieldset key={question.id} disabled={!canAnswer(selected) || !!busy}>
                  <legend>{question.question}</legend>
                  {question.options?.map((option) => (
                    <label className="mirror-native-choice" key={option.label}>
                      <input
                        type="radio"
                        name={`${selected.token}:${question.id}`}
                        checked={values[selected.token]?.[question.id] === option.label}
                        onChange={() =>
                          setValues((old) => ({
                            ...old,
                            [selected.token]: {
                              ...old[selected.token],
                              [question.id]: option.label,
                            },
                          }))
                        }
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                    </label>
                  ))}
                  {!question.isSecret && (!question.options?.length || question.isOther) && (
                    <label>
                      {question.options?.length
                        ? 'Or write your own answer'
                        : question.header || 'Your answer'}
                      <textarea
                        aria-label={`${question.header || question.id} — your answer`}
                        maxLength={8000}
                        value={
                          question.options?.some(
                            (option) => option.label === values[selected.token]?.[question.id],
                          )
                            ? ''
                            : (values[selected.token]?.[question.id] ?? '')
                        }
                        onChange={(event) =>
                          setValues((old) => ({
                            ...old,
                            [selected.token]: {
                              ...old[selected.token],
                              [question.id]: event.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                  )}
                  {question.isSecret && (
                    <p>Answer this private question {place}. It is not collected here.</p>
                  )}
                </fieldset>
              ))}
              {selected.response === 'editor_only' || selected.kind !== 'question' ? (
                <p>
                  Use the original request {place}. Permissions and unsupported native request
                  formats stay there.
                </p>
              ) : (
                <>
                  <p>
                    Send only your explicit answer to this native question. Native acceptance is not
                    confirmed by this connection; inspect it {place} afterward.
                  </p>
                  <button
                    className="primary"
                    disabled={
                      !canAnswer(selected) ||
                      !!busy ||
                      receipts.length >= 8 ||
                      selected.questions.some(
                        (question) => !values[selected.token]?.[question.id]?.trim(),
                      )
                    }
                    onClick={() => void answer(selected)}
                  >
                    {busy ? 'Sending…' : 'Send native answer'}
                  </button>
                  {receipts.length >= 8 && (
                    <p>Check the retained answer receipts before sending another answer here.</p>
                  )}
                </>
              )}
              {messages[selected.token] && <p role="status">{messages[selected.token]}</p>}
              {!daemon && (
                <a className="secondary" href="#/vscode">
                  VS Code connection help
                </a>
              )}
            </>
          )}
        </Modal>
      )}
    </section>
  );
}
