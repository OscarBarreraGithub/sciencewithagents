import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  effortLabel,
  folderBrowseSchema,
  modelSchema,
  nativeRunnerLaunchOptionsSchema,
  nativeRunnerModelResolutionSchema,
  nativeRunnerStartReceiptSchema,
  nativeRunnerStartSchema,
  type Model,
  type NativeRunnerLaunchOptions,
  type NativeRunnerStart,
  type NativeRunnerStartReceipt,
} from '@dock/shared';
import { api, apiScope, ApiError, connectionLost } from '../api';
import { FolderBrowser } from '../FolderBrowser';
import { NativeConnectionPicker, useNativeConnections } from './NativeConnections';
import { useBackStep } from './Navigation';
import './NativeRunnerStart.css';

const base = '/native-connections';
const names = { codex: 'Codex', claude: 'Claude' };
const draftSchema = nativeRunnerStartSchema
  .omit({ key: true, choice: true })
  .partial()
  .extend({
    folderName: nativeRunnerStartReceiptSchema.shape.folderName.optional(),
    mode: nativeRunnerModelResolutionSchema.shape.mode,
    model: modelSchema.shape.id.max(100),
    effort: nativeRunnerModelResolutionSchema.shape.effort,
  });
type Draft = ReturnType<typeof draftSchema.parse>;
function read<T>(key: string, parse: (value: unknown) => T): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw && raw.length <= 20_000 ? parse(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
function sameStart(saved: NativeRunnerStart, input: NativeRunnerStart) {
  return (
    saved.key === input.key &&
    saved.folderId === input.folderId &&
    saved.sourceId === input.sourceId &&
    saved.provider === input.provider &&
    saved.choice.mode === input.choice.mode &&
    (saved.choice.mode !== 'exact' ||
      (input.choice.mode === 'exact' &&
        saved.choice.model === input.choice.model &&
        saved.choice.effort === input.choice.effort))
  );
}
function exactReceipt(raw: unknown, input: NativeRunnerStart) {
  const receipt = nativeRunnerStartReceiptSchema.parse(raw);
  const saved = nativeRunnerStartSchema.parse({
    key: receipt.key,
    folderId: receipt.folderId,
    sourceId: receipt.sourceId,
    provider: receipt.provider,
    choice: receipt.choice,
  });
  if (!sameStart(saved, input))
    throw new Error('This receipt does not match the original native start. Nothing was replayed.');
  return receipt;
}
const label = (state: NativeRunnerStartReceipt['state']) =>
  state === 'created'
    ? 'Native session created'
    : state === 'not_started'
      ? 'Not started'
      : 'Creation uncertain';

const setAsideLimit = 32;
const setAsideUnits = 128_000;
type SavedCheck = {
  input: NativeRunnerStart;
  folderName: string;
  lastReceipt: NativeRunnerStartReceipt | null;
  outcome: NativeRunnerStartReceipt['state'] | 'missing';
};
function parseCheck(value: unknown): SavedCheck {
  if (!value || typeof value !== 'object') throw new Error('Invalid saved native start check.');
  const record = value as Record<string, unknown>;
  const input = nativeRunnerStartSchema.parse(record.input);
  if (
    typeof record.outcome !== 'string' ||
    !['missing', 'uncertain', 'created', 'not_started'].includes(record.outcome)
  )
    throw new Error('Invalid saved native start check.');
  return {
    input,
    folderName: nativeRunnerStartReceiptSchema.shape.folderName.parse(record.folderName),
    lastReceipt: record.lastReceipt === null ? null : exactReceipt(record.lastReceipt, input),
    outcome: record.outcome as SavedCheck['outcome'],
  };
}
function retainedStarts(key: string): SavedCheck[] {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  if (raw.length > setAsideUnits) throw new Error('The retained native start record is too large.');
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > setAsideLimit)
    throw new Error('The retained native start record cannot be read.');
  const records = value.map(parseCheck);
  if (new Set(records.map((item) => item.input.key)).size !== records.length)
    throw new Error('The retained native start record has conflicting request identities.');
  return records;
}
function saveRetained(key: string, records: SavedCheck[]) {
  const raw = JSON.stringify(records);
  if (records.length > setAsideLimit || raw.length > setAsideUnits)
    throw new Error(
      'Set-aside storage is full (32 starts or 128,000 text units). Your original remains held; no retained starts were erased.',
    );
  localStorage.setItem(key, raw);
}

/** One owner start, with receipt-only recovery. Opening this page never starts a session. */
export function NativeRunnerStartPage({ heading }: { heading: ReactNode }) {
  const storage = `dock:${apiScope()}:native-runner-start`;
  const pendingKey = `${storage}:pending`;
  const resultKey = `${storage}:result`;
  const checkKey = `${storage}:check`;
  const asideKey = `${storage}:set-aside`;
  const [checked, setChecked] = useState(() => read(checkKey, parseCheck));
  const [confirmed, setConfirmed] = useState(false);
  const [retained, setRetained] = useState(() => {
    try {
      return { items: retainedStarts(asideKey), error: '' };
    } catch {
      return {
        items: [] as SavedCheck[],
        error: 'Retained native starts could not be read. Their saved bytes have not been changed.',
      };
    }
  });
  const [draft, setDraft] = useState<Draft>(
    () => read(storage, draftSchema.parse) ?? { mode: 'native', model: '', effort: null },
  );
  const [pending, setPending] = useState(() => read(pendingKey, nativeRunnerStartSchema.parse));
  const [receipt, setReceipt] = useState(() =>
    read(resultKey, nativeRunnerStartReceiptSchema.parse),
  );
  const [options, setOptions] = useState<NativeRunnerLaunchOptions | null>(null);
  const [error, setError] = useState('');
  const [optionsError, setOptionsError] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [connecting, setConnecting] = useState<'created' | 'inspect' | null>(null);
  const [starting, setStarting] = useState(false);
  const [catalog, setCatalog] = useState<Model[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const working = useRef(false);
  const alive = useRef(true);
  const connections = useNativeConnections(connecting !== null);
  const provider =
    draft.provider ?? options?.providers.find((item) => item.installed)?.provider ?? 'codex';
  const sourceId = draft.sourceId ?? options?.sources.find((item) => item.available)?.id ?? '';
  const source = options?.sources.find((item) => item.id === sourceId);
  const installed = options?.providers.find((item) => item.provider === provider);
  const model = catalog.find((item) => item.id === draft.model);
  const locked = !!pending || !!receipt || busy;
  const canSetAside =
    !!pending &&
    !!checked &&
    sameStart(checked.input, pending) &&
    (checked.outcome === 'uncertain' || checked.outcome === 'missing');
  useBackStep(browsing ? () => setBrowsing(false) : connecting ? () => setConnecting(null) : null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setOptionsError('');
    void api(`${base}/launch-options`, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setOptions(nativeRunnerLaunchOptionsSchema.parse(value));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setOptionsError(
            reason instanceof Error ? reason.message : 'Native start options are unavailable.',
          );
      });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog([]);
    setCatalogError('');
    if (draft.mode !== 'exact' || pending || receipt) {
      setCatalogBusy(false);
      return;
    }
    setCatalogBusy(true);
    void api(`/models?provider=${provider}`, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setCatalog(modelSchema.array().parse(value));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setCatalogError(
            reason instanceof Error ? reason.message : 'Native models are unavailable.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogBusy(false);
      });
    return () => controller.abort();
  }, [draft.mode, provider, catalogRevision, pending, receipt]);
  const edit = (patch: Partial<Draft>) => {
    if (locked) return;
    const next = draftSchema.parse({ ...draft, ...patch });
    setDraft(next);
    setError('');
    try {
      localStorage.setItem(storage, JSON.stringify(next));
    } catch {
      setError('This browser could not save your setup choices. Nothing was started.');
    }
  };
  const choose = async (folderId: string) => {
    setBrowsing(false);
    if (working.current || locked) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const listing = folderBrowseSchema.parse(
        await api(`/project-folders?folderId=${encodeURIComponent(folderId)}`),
      );
      if (listing.current.id !== folderId || !listing.current.canSelect)
        throw new Error('Choose an available folder on this computer. Nothing was started.');
      if (alive.current) {
        const next = draftSchema.parse({ ...draft, folderId, folderName: listing.current.name });
        localStorage.setItem(storage, JSON.stringify(next));
        setDraft(next);
      }
    } catch (reason) {
      if (alive.current)
        setError(
          reason instanceof Error
            ? reason.message
            : 'The folder could not be selected. Nothing was started.',
        );
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const clearPending = (input: NativeRunnerStart) => {
    const saved = read(pendingKey, nativeRunnerStartSchema.parse);
    if (saved && sameStart(saved, input)) localStorage.removeItem(pendingKey);
    const check = read(checkKey, parseCheck);
    if (check && sameStart(check.input, input)) localStorage.removeItem(checkKey);
    setChecked((current) => (current && sameStart(current.input, input) ? null : current));
    setConfirmed(false);
    setPending((current) => (current?.key === input.key ? null : current));
  };
  const settle = (value: NativeRunnerStartReceipt, input: NativeRunnerStart) => {
    // A browser write failure after a reply retains the pending original for a later read.
    localStorage.setItem(resultKey, JSON.stringify(value));
    setReceipt(value);
    if (value.state !== 'uncertain') clearPending(input);
  };
  const start = async () => {
    if (working.current || locked || !draft.folderId || !source?.available || !installed?.installed)
      return;
    working.current = true;
    setBusy(true);
    setError('');
    let input: NativeRunnerStart | undefined;
    let dispatched = false;
    try {
      const existing = read(pendingKey, nativeRunnerStartSchema.parse);
      if (existing) {
        setPending(existing);
        throw new Error('An original native start needs its saved receipt checked first.');
      }
      input = nativeRunnerStartSchema.parse({
        key: crypto.randomUUID(),
        folderId: draft.folderId,
        sourceId,
        provider,
        choice:
          draft.mode === 'exact'
            ? {
                mode: 'exact',
                model: draft.model,
                ...(draft.effort ? { effort: draft.effort } : {}),
              }
            : { mode: draft.mode },
      });
      localStorage.setItem(pendingKey, JSON.stringify(input));
      setPending(input);
      dispatched = true;
      setStarting(true);
      const value = exactReceipt(await api(`${base}/start`, input), input);
      if (alive.current) settle(value, input);
    } catch (reason) {
      if (alive.current) {
        const refused =
          dispatched &&
          reason instanceof ApiError &&
          reason.status >= 400 &&
          reason.status < 500 &&
          !connectionLost(reason);
        if (refused && input) clearPending(input);
        const detail = reason instanceof Error ? reason.message : 'Native start is unavailable.';
        setError(
          !dispatched || refused
            ? `Not started. ${detail} No creation request was handed to the native program.`
            : `${detail} Creation is unconfirmed. Check the exact saved start receipt; do not start again.`,
        );
      }
    } finally {
      working.current = false;
      if (alive.current) {
        setBusy(false);
        setStarting(false);
      }
    }
  };
  const savedCheck = (
    input: NativeRunnerStart,
    value: NativeRunnerStartReceipt | null,
    outcome: SavedCheck['outcome'],
  ): SavedCheck => ({
    input,
    folderName:
      value?.folderName ??
      (input.folderId === draft.folderId ? draft.folderName : undefined) ??
      'Original selected folder',
    lastReceipt: value,
    outcome,
  });
  const inspect = async () => {
    if (working.current || !pending) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const value = exactReceipt(await api(`${base}/starts/${pending.key}`), pending);
      if (alive.current) {
        settle(value, pending);
        if (value.state === 'uncertain') {
          const next = savedCheck(pending, value, 'uncertain');
          localStorage.setItem(checkKey, JSON.stringify(next));
          setChecked(next);
        }
      }
    } catch (reason) {
      if (alive.current) {
        let detail = reason instanceof Error ? reason.message : 'The receipt is unavailable.';
        if (reason instanceof ApiError && reason.status === 404 && !connectionLost(reason)) {
          try {
            const prior = read(resultKey, nativeRunnerStartReceiptSchema.parse);
            const next = savedCheck(
              pending,
              prior?.key === pending.key ? exactReceipt(prior, pending) : null,
              'missing',
            );
            localStorage.setItem(checkKey, JSON.stringify(next));
            setChecked(next);
          } catch {
            detail +=
              ' This browser could not retain the completed check. Check again before setting aside.';
          }
        }
        setError(
          `${detail} The original request remains retained. Nothing was replayed; a missing receipt does not prove another start is safe.`,
        );
      }
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const setAside = () => {
    if (working.current || !pending || !canSetAside || !confirmed) return;
    setError('');
    try {
      const original = read(pendingKey, nativeRunnerStartSchema.parse);
      const check = read(checkKey, parseCheck);
      if (
        !original ||
        !sameStart(original, pending) ||
        !check ||
        !sameStart(check.input, pending) ||
        (check.outcome !== 'uncertain' && check.outcome !== 'missing')
      )
        throw new Error(
          'The original saved start changed. Check its receipt again before setting aside.',
        );
      const items = retainedStarts(asideKey);
      const existing = items.find((item) => item.input.key === pending.key);
      if (existing && !sameStart(existing.input, pending))
        throw new Error('A retained start has conflicting input. The original remains held.');
      const prior = read(resultKey, nativeRunnerStartReceiptSchema.parse);
      const record = {
        ...check,
        lastReceipt: prior?.key === pending.key ? exactReceipt(prior, pending) : check.lastReceipt,
      };
      const next = existing
        ? items.map((item) => (item.input.key === pending.key ? record : item))
        : [...items, record];
      // Save the complete original first. Failed writes never discard the current pending input.
      saveRetained(asideKey, next);
      setRetained({ items: next, error: '' });
      if (prior?.key === pending.key) {
        localStorage.removeItem(resultKey);
        setReceipt(null);
      }
      clearPending(pending);
    } catch (reason) {
      setError(
        `${reason instanceof Error ? reason.message : 'This browser could not save the set-aside record.'} Nothing was started, cancelled or stopped.`,
      );
    }
  };
  const inspectRetained = async (item: SavedCheck) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      let receipt: NativeRunnerStartReceipt | null = null;
      try {
        receipt = exactReceipt(await api(`${base}/starts/${item.input.key}`), item.input);
      } catch (reason) {
        if (!(reason instanceof ApiError && reason.status === 404 && !connectionLost(reason)))
          throw reason;
      }
      if (alive.current) {
        const items = retainedStarts(asideKey);
        const original = items.find((value) => value.input.key === item.input.key);
        if (!original || !sameStart(original.input, item.input))
          throw new Error('The retained original changed. Nothing was replayed.');
        const next = receipt
          ? { ...original, lastReceipt: receipt, outcome: receipt.state }
          : { ...original, outcome: 'missing' as const };
        const updated = items.map((value) => (value.input.key === item.input.key ? next : value));
        saveRetained(asideKey, updated);
        setRetained({ items: updated, error: '' });
      }
    } catch (reason) {
      if (alive.current)
        setError(
          `${reason instanceof Error ? reason.message : 'The original receipt could not be read or saved.'} The retained original has not been removed. Nothing was replayed.`,
        );
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const canStart =
    !locked &&
    !!draft.folderId &&
    !!source?.available &&
    !!installed?.installed &&
    !optionsError &&
    (draft.mode !== 'exact' ||
      (!!model &&
        (!draft.effort || model.efforts.includes(draft.effort)) &&
        !catalogBusy &&
        !catalogError));
  return (
    <section className="flow-page native-runner-start">
      {heading}
      <p>
        Start a native Codex or Claude terminal in an existing folder. No prompt is sent. Native
        sign-in, tools, hooks and permissions stay native. The session keeps running when this app
        closes.
      </p>
      <p>
        Folder start currently uses a configured local tmux source. Existing SSH and Herdr sessions
        can be connected separately; this app installs no optional tools.
      </p>
      {optionsError && (
        <div role="alert">
          <p>{optionsError}</p>
          <button
            type="button"
            className="secondary"
            onClick={() => setRevision((value) => value + 1)}
          >
            Read start options again
          </button>
        </div>
      )}
      {!options && !optionsError && <p role="status">Reading native start options…</p>}
      {error && <p role="alert">{error}</p>}
      {!receipt && !pending && (
        <fieldset disabled={locked}>
          <legend>Native session setup</legend>
          <p>
            Chosen folder: <strong>{draft.folderName ?? 'Choose an existing folder'}</strong>
          </p>
          <button type="button" className="secondary" onClick={() => setBrowsing(true)}>
            Choose native work folder
          </button>
          <label>
            Local native source
            <select
              aria-label="Local native source"
              value={sourceId}
              onChange={(event) => edit({ sourceId: event.target.value || undefined })}
            >
              {!sourceId && <option value="">No local source available</option>}
              {draft.sourceId && !source && (
                <option value={draft.sourceId}>Saved source unavailable</option>
              )}
              {options?.sources.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.available}>
                  {item.label}
                  {item.available ? '' : ' · Unavailable'}
                </option>
              ))}
            </select>
          </label>
          {source && <p>{source.message}</p>}
          {options && !options.sources.length && (
            <p role="status">
              No configured local tmux source. Connect an existing session, or ask your setup agent
              to configure the optional native source.
            </p>
          )}
          <label>
            Native provider
            <select
              aria-label="Native provider"
              value={provider}
              onChange={(event) =>
                edit({ provider: event.target.value as Draft['provider'], model: '', effort: null })
              }
            >
              {(['codex', 'claude'] as const).map((value) => (
                <option key={value} value={value}>
                  {names[value]}
                  {options?.providers.find((item) => item.provider === value)?.installed
                    ? ''
                    : ' · Not installed'}
                </option>
              ))}
            </select>
          </label>
          {installed && (
            <p>
              {installed.message}
              {installed.version ? ` (${installed.version})` : ''}
            </p>
          )}
          <label>
            Model choice
            <select
              aria-label="Model choice"
              value={draft.mode}
              onChange={(event) => edit({ mode: event.target.value as Draft['mode'] })}
            >
              <option value="native">Keep native settings</option>
              <option value="policy">Saved app model defaults</option>
              <option value="exact">Choose exact model</option>
            </select>
          </label>
          <p>
            {draft.mode === 'native'
              ? 'No model or thinking override is passed; your native configuration wins.'
              : draft.mode === 'policy'
                ? 'The server resolves your saved central model policy for this explicit start.'
                : 'Choose from this provider’s native catalog, including light models. No manager tier is inferred.'}
          </p>
          {draft.mode === 'exact' && (
            <>
              {catalogBusy && <p role="status">Reading native models…</p>}
              {catalogError && <p role="alert">{catalogError}</p>}
              <label>
                Exact native model
                <select
                  aria-label="Exact native model"
                  value={draft.model}
                  onChange={(event) => edit({ model: event.target.value, effort: null })}
                >
                  <option value="">Choose a model</option>
                  {draft.model && !model && (
                    <option value={draft.model}>Saved model unavailable</option>
                  )}
                  {catalog.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Thinking level
                <select
                  aria-label="Thinking level"
                  value={draft.effort ?? ''}
                  onChange={(event) => edit({ effort: event.target.value || null })}
                >
                  <option value="">Keep native thinking setting</option>
                  {draft.effort && !model?.efforts.includes(draft.effort) && (
                    <option value={draft.effort}>Saved thinking level unavailable</option>
                  )}
                  {model?.efforts.map((value) => (
                    <option key={value} value={value}>
                      {effortLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary"
                onClick={() => setCatalogRevision((value) => value + 1)}
              >
                Read native models again
              </button>
            </>
          )}
        </fieldset>
      )}
      {pending ? (
        <section aria-label="Unconfirmed native start">
          <h2>{starting ? 'Starting native session…' : 'Check your original start'}</h2>
          <p>
            {pending.folderId === draft.folderId
              ? (draft.folderName ?? 'Original selected folder')
              : 'Original selected folder'}{' '}
            · {names[pending.provider]} ·{' '}
            {options?.sources.find((item) => item.id === pending.sourceId)?.label ??
              'Original source currently unavailable'}{' '}
            ·{' '}
            {pending.choice.mode === 'exact'
              ? `${pending.choice.model}${pending.choice.effort ? ` · ${effortLabel(pending.choice.effort)}` : ''}`
              : pending.choice.mode === 'native'
                ? 'Native model and thinking settings'
                : 'Saved app model defaults'}
          </p>
          <p>
            {starting
              ? 'Waiting for the original creation response.'
              : 'Creation is not confirmed.'}{' '}
            Your exact folder, source, provider, model choice and request identity are retained.
            Nothing is queued for automatic replay.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void inspect()}
          >
            Check saved start receipt
          </button>
          {canSetAside && (
            <>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setConnecting('inspect')}
              >
                Inspect native connections
              </button>
              <p>
                Check native connections for a session that may already exist in this folder.
                Setting aside retains the exact original for later receipt checks; it does not
                cancel or stop a session. A separate new Start may create another session.
              </p>
              <label className="native-runner-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I understand the original may have created a session and is not cancelled or
                stopped.
              </label>
              <button
                type="button"
                className="secondary"
                disabled={busy || !confirmed}
                onClick={setAside}
              >
                Set aside unconfirmed start
              </button>
            </>
          )}
        </section>
      ) : (
        !receipt && (
          <button
            type="button"
            className="primary"
            disabled={!canStart}
            onClick={() => void start()}
          >
            {busy ? 'Starting native session…' : 'Start native session'}
          </button>
        )
      )}
      {receipt && (
        <section aria-label="Native start receipt">
          <h2>{label(receipt.state)}</h2>
          <p>{receipt.message}</p>
          <p>
            {receipt.folderName} · {names[receipt.provider]} ·{' '}
            {receipt.resolution.model ?? 'Native model setting'} ·{' '}
            {receipt.resolution.effort ?? 'Native thinking setting'}
          </p>
          <p>
            This is the saved creation outcome, not a sign-in, agent-turn or current-running
            acknowledgement.
          </p>
          {receipt.state === 'created' && receipt.targetId && (
            <button type="button" className="primary" onClick={() => setConnecting('created')}>
              Connect created session
            </button>
          )}
          {receipt.state !== 'uncertain' && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                try {
                  localStorage.removeItem(resultKey);
                  setReceipt(null);
                  setError('');
                } catch {
                  setError(
                    'This browser could not clear the displayed receipt. Nothing new was started.',
                  );
                }
              }}
            >
              Prepare another native session
            </button>
          )}
        </section>
      )}
      {retained.error && <p role="alert">{retained.error}</p>}
      {retained.items.length > 0 && (
        <section aria-label="Set-aside native starts">
          <h2>Set-aside native starts</h2>
          <p>
            These original requests are retained in this browser, never replayed. Setting aside does
            not cancel or stop a native session.
          </p>
          {retained.items.map((item) => (
            <details key={item.input.key}>
              <summary>
                {item.folderName} · {names[item.input.provider]} ·{' '}
                {item.outcome === 'missing' ? 'Receipt missing' : label(item.outcome)}
              </summary>
              <p>Original request: {item.input.key}</p>
              <pre className="native-runner-original">{JSON.stringify(item.input, null, 2)}</pre>
              {item.lastReceipt && (
                <>
                  <p>
                    Last receipt: {label(item.lastReceipt.state)} · {item.lastReceipt.message}
                  </p>
                  <pre className="native-runner-original">
                    {JSON.stringify(item.lastReceipt, null, 2)}
                  </pre>
                </>
              )}
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void inspectRetained(item)}
              >
                Check original receipt
              </button>
            </details>
          ))}
        </section>
      )}
      <div className="native-runner-links">
        <a className="secondary" href="#/chats">
          Back to Chats
        </a>
        <a className="secondary" href="#/new">
          Managed project setup (Advanced)
        </a>
      </div>
      {options && options.starts.length > 0 && (
        <details>
          <summary>Recent native start receipts</summary>
          <p>Recorded creation outcomes only; native sessions may have ended or changed since.</p>
          <ul>
            {options.starts.map((item) => (
              <li key={item.key}>
                {item.folderName} · {names[item.provider]} · {label(item.state)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {browsing && (
        <FolderBrowser close={() => setBrowsing(false)} select={(id) => void choose(id)} />
      )}
      {connecting && (
        <NativeConnectionPicker
          connections={{
            ...connections,
            view: connections.view && {
              ...connections.view,
              targets:
                connecting === 'inspect'
                  ? connections.view.targets
                  : connections.view.targets.filter((item) => item.id === receipt?.targetId),
            },
          }}
          close={() => setConnecting(null)}
          connected={(id) => {
            setConnecting(null);
            location.hash = `#/chats/native/${encodeURIComponent(id)}`;
          }}
        />
      )}
    </section>
  );
}
