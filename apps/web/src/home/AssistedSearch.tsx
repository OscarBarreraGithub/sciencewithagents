import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Sparkles, X } from 'lucide-react';
import {
  conversationSearchResultSchema,
  latestFamily,
  modelPolicyStatusSchema,
  policyProvider,
  taskTiers,
  type ConversationSearchCandidate,
  type ConversationSearchResult,
  type ModelPolicyStatus,
  type ProviderId,
} from '@dock/shared';
import { api, ApiError, apiScope } from '../api';
import { ReportText } from './health-shared';
import { Modal } from '../Modal';
import { ArchiveSearch } from './ArchiveSearch';
import './assisted-search.css';

type Pending = { key: string; query: string; provider: ProviderId; at: string };
type Saved = { pending: Pending | null; resultId: string | null; draft: string; open: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const storageKey = () => `dock:assisted-search:${apiScope()}`;
const providerNames: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude' };
const statusNames: Record<ConversationSearchResult['status'], string> = {
  queued: 'Waiting in QUARK',
  running: 'Searching',
  completed: 'Finished',
  failed: 'Did not finish',
  interrupted: 'Stopped',
  cancelled: 'Cancelled',
};
function restore(): Saved {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey()) ?? 'null') as {
      pending?: Record<string, unknown> | null;
      resultId?: unknown;
      draft?: unknown;
      open?: unknown;
    } | null;
    const p = value?.pending;
    return {
      open: value?.open === true,
      draft: typeof value?.draft === 'string' ? value.draft.slice(0, 500) : '',
      pending:
        p &&
        typeof p.key === 'string' &&
        uuid.test(p.key) &&
        typeof p.query === 'string' &&
        (p.provider === 'codex' || p.provider === 'claude')
          ? {
              key: p.key,
              query: p.query.slice(0, 500),
              provider: p.provider,
              at: typeof p.at === 'string' ? p.at : new Date().toISOString(),
            }
          : null,
      resultId:
        typeof value?.resultId === 'string' && uuid.test(value.resultId) ? value.resultId : null,
    };
  } catch {
    return { pending: null, resultId: null, draft: '', open: false };
  }
}
function persist(value: Saved) {
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify(value));
  } catch {
    /* The request identity stays in this page if browser storage is unavailable. */
  }
}

function Links({ items }: { items: ConversationSearchCandidate[] }) {
  return (
    <ul className="assisted-search-links">
      {items.map((c) => (
        <li key={`${c.kind}:${c.id}`}>
          <a href={c.href}>
            <strong>{c.title || 'Untitled conversation'}</strong>
            <small>
              {c.kind === 'editor' ? 'VS Code' : 'Saved chat'} · {providerNames[c.provider]}
              {c.project ? ` · ${c.project}` : ''}
              {c.evidence === 'title-only' ? ' · title only' : ''}
            </small>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Explicit, owner-requested help finding a conversation. Typing and opening never start a
 * model turn; links only navigate and never message the matched conversation.
 */
export function AssistedSearch() {
  const [saved, setSaved] = useState(restore);
  // Reload an open prompt, but don't pop it back up after the owner closes it.
  const open = saved.open;
  const setOpen = (next: boolean) => {
    setSaved((old) => {
      const value = { ...old, open: next };
      persist(value);
      return value;
    });
  };
  const [policy, setPolicy] = useState<ModelPolicyStatus | null>(null);
  const [policyError, setPolicyError] = useState(false);
  const [choice, setChoice] = useState<ProviderId | null>(null);
  const [result, setResult] = useState<ConversationSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; uncertain: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    persist(saved);
  }, [saved]);
  // Cached policy only, and only once the owner opens this control.
  useEffect(() => {
    if (!open || policy) return;
    api('/model-policy')
      .then((value) => alive.current && setPolicy(modelPolicyStatusSchema.parse(value)))
      .catch(() => alive.current && setPolicyError(true));
  }, [open, policy]);
  // Reads the retained search record; polling stops once it reaches a final state.
  const resultId = saved.resultId;
  const unfinished =
    !result || result.id !== resultId || ['queued', 'running'].includes(result.status);
  useEffect(() => {
    if (!open || !resultId || !unfinished) return;
    let stop = false;
    const read = async () => {
      try {
        const value = conversationSearchResultSchema.parse(
          await api(`/conversations/search/${resultId}`),
        );
        if (!stop && alive.current) setResult(value);
      } catch (reason) {
        if (!stop && alive.current && reason instanceof ApiError && reason.status === 404)
          setSaved((old) => ({ ...old, resultId: null }));
      }
    };
    void read();
    const timer = window.setInterval(() => {
      if (!document.hidden) void read();
    }, 5000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [open, resultId, unfinished]);
  const fallbackProvider = policy ? (policyProvider(policy.policy, 'bulk') ?? null) : null;
  const provider = choice ?? fallbackProvider;
  const modelLabel = (p: ProviderId) => {
    const slot = policy?.policy.models[p][taskTiers.bulk];
    if (!slot) return null;
    const models = policy.catalogs.find((c) => c.provider === p)?.models ?? [];
    const id = slot.model ?? latestFamily(models, slot.family)?.id;
    return models.find((m) => m.id === id)?.label ?? id ?? `latest ${slot.family}`;
  };
  const text = saved.draft.trim();
  const send = async (request: Pending) => {
    // Save the exact receipt before any network side effect, including a fast reload.
    persist({ ...saved, pending: request });
    setSaved((old) => ({ ...old, pending: request }));
    setBusy(true);
    setError(null);
    try {
      const value = conversationSearchResultSchema.parse(
        await api('/conversations/search', {
          key: request.key,
          query: request.query,
          provider: request.provider,
        }),
      );
      if (!alive.current) return;
      setResult(value);
      setSaved((old) => ({ ...old, pending: null, resultId: value.id }));
    } catch (reason) {
      if (!alive.current) return;
      const rejected = reason instanceof ApiError && reason.status >= 400 && reason.status < 500;
      if (rejected) setSaved((old) => ({ ...old, pending: null }));
      setError({
        uncertain: !rejected,
        message:
          reason instanceof ApiError ? reason.message : 'The answer was lost or could not be read.',
      });
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const pending = saved.pending;
  const shown = result && result.id === resultId ? result : null;
  // Links come from the host's candidate list; the reply only decides which ones to surface.
  const named = shown?.report
    ? shown.candidates.filter((c) => shown.report!.includes(c.href) || shown.report!.includes(c.id))
    : [];
  return (
    <div className="assisted-search">
      <button
        type="button"
        className="chat-small-button assisted-search-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Sparkles size={15} /> Assisted search
        {!open && shown && ['queued', 'running'].includes(shown.status) ? ' · searching' : ''}
      </button>
      {open && (
        <Modal
          title="Assisted search"
          close={() => setOpen(false)}
          className="assisted-search-dialog"
        >
          <div
            className="assisted-search-panel"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('a[href^="#/"]')) setOpen(false);
            }}
          >
            <p className="assisted-search-note">
              Describe what you remember. A small model ranks a bounded set of saved excerpts and
              editor titles when you press Search. For full retained text, expand Search saved text.
              Your chat list filter stays unchanged.
            </p>
            <ArchiveSearch />
            <label className="assisted-search-prompt">
              What are you looking for?
              <textarea
                autoFocus
                rows={4}
                maxLength={500}
                placeholder="For example, the chat where we discussed the telescope budget…"
                value={saved.draft}
                onChange={(event) => {
                  const next = { ...saved, draft: event.target.value };
                  persist(next);
                  setSaved(next);
                }}
              />
            </label>
            <div className="assisted-search-row" role="radiogroup" aria-label="Search helper">
              {(['codex', 'claude'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={provider === p}
                  className="chat-small-button"
                  disabled={busy}
                  onClick={() => setChoice(p)}
                >
                  {providerNames[p]}
                  {modelLabel(p) ? ` · ${modelLabel(p)}` : ''}
                </button>
              ))}
            </div>
            {policyError && !policy && (
              <p className="assisted-search-note">
                Model settings could not be read; choose a provider. The central default for it will
                be used.
              </p>
            )}
            {pending ? (
              <div className="assisted-search-pending" role="status">
                <p>
                  Your search for “{pending.query}” with {providerNames[pending.provider]} was sent
                  but no answer arrived. Checking sends the same request, so it cannot start a
                  second search.
                </p>
                <div className="assisted-search-row">
                  <button
                    type="button"
                    className="chat-small-button primary"
                    disabled={busy}
                    onClick={() => void send(pending)}
                  >
                    {busy ? 'Checking…' : 'Check this search'}
                  </button>
                  <button
                    type="button"
                    className="chat-small-button"
                    disabled={busy}
                    onClick={() => {
                      setSaved((old) => ({ ...old, pending: null }));
                      setError(null);
                    }}
                  >
                    Forget it
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="chat-small-button primary"
                disabled={busy || !text || !provider}
                onClick={() =>
                  provider &&
                  void send({
                    key: crypto.randomUUID(),
                    query: text.slice(0, 500),
                    provider,
                    at: new Date().toISOString(),
                  })
                }
              >
                {busy
                  ? 'Sending…'
                  : !text
                    ? 'Search conversations'
                    : `Search for “${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`}
              </button>
            )}
            {error && (
              <p className="chat-panel-error" role="alert">
                {error.message}
                {error.uncertain
                  ? ' The search is saved on this device; check it instead of searching again.'
                  : ' No search was started.'}
              </p>
            )}
            {shown && (
              <section className="assisted-search-result" aria-label="Assisted search result">
                <header>
                  <p>
                    <strong>“{shown.query}”</strong>
                    {statusNames[shown.status]} · {providerNames[shown.provider]} · {shown.model}
                  </p>
                  <button
                    type="button"
                    className="chat-icon-button"
                    aria-label="Clear this result"
                    onClick={() => {
                      setSaved((old) => ({ ...old, resultId: null }));
                      setResult(null);
                    }}
                  >
                    <X size={16} />
                  </button>
                </header>
                {shown.message && <p className="assisted-search-note">{shown.message}</p>}
                {shown.report ? (
                  <>
                    <ReportText text={shown.report} fallback="" />
                    {shown.reportTruncated && (
                      <a className="chat-small-button" href={`#/chat/${shown.agentId}`}>
                        Full reply in the helper’s conversation <ArrowUpRight size={15} />
                      </a>
                    )}
                  </>
                ) : (
                  <p className="assisted-search-note">
                    {['queued', 'running'].includes(shown.status)
                      ? 'The helper’s reply will appear here.'
                      : 'No written reply was saved.'}
                  </p>
                )}
                {named.length > 0 && (
                  <>
                    <h3 className="assisted-search-heading">Conversations named in the reply</h3>
                    <Links items={named} />
                  </>
                )}
                {shown.candidates.length > 0 && (
                  <details className="assisted-search-pool">
                    <summary>
                      All {shown.candidates.length} conversations the helper was shown
                    </summary>
                    <Links items={shown.candidates} />
                  </details>
                )}
                <p className="assisted-search-note">
                  {shown.coverage.notice ||
                    `Partial search: ${shown.coverage.projectsConsidered} of ${shown.coverage.projectsAvailable} projects, ${shown.coverage.managedCandidates} saved and ${shown.coverage.editorCandidates} VS Code conversations (titles only).`}
                </p>
              </section>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
