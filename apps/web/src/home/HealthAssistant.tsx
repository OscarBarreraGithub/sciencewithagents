import { useEffect, useRef, useState } from 'react';
import { ArrowUp, History, Plus, RefreshCw, Square } from 'lucide-react';
import {
  effortLabel,
  latestFamily,
  modelPolicyStatusSchema,
  policyProvider,
  taskTiers,
  type AgentDetail,
  type Entry,
  type Model,
  type ModelPolicyStatus,
  type ProviderId,
  type ResourceCheck,
  type ResourceStatus,
} from '@dock/shared';
import { api, apiScope, detail, models as loadModels } from '../api';
import { useScrollHints } from './useScrollHints';
import { reportFallback } from './HealthHistory';
import {
  activeCheck,
  clock,
  providerNames,
  reasonLabels,
  ReportText,
  stateLabels,
  useResourceActions,
  when,
} from './health-shared';

type Catalog = { models: Model[]; error: string; loading: boolean };
/** Cached central policy on mount; a live catalog only for the provider being shown. */
export function useHealthModels() {
  const [status, setStatus] = useState<ModelPolicyStatus | null>(null);
  const [error, setError] = useState('');
  const [catalogs, setCatalogs] = useState<Partial<Record<ProviderId, Catalog>>>({});
  const requested = useRef(new Set<ProviderId>());
  useEffect(() => {
    let alive = true;
    api('/model-policy')
      .then((value) => {
        if (!alive) return;
        const parsed = modelPolicyStatusSchema.parse(value);
        setStatus(parsed);
        setCatalogs((old) => {
          const next = { ...old };
          for (const c of parsed.catalogs)
            if (c.models.length && !next[c.provider]?.models.length) {
              next[c.provider] = { models: c.models, error: '', loading: false };
              // A recent cached listing is enough; do not ask the provider again.
              if (!c.error && c.observedAt && Date.now() - Date.parse(c.observedAt) < 300_000)
                requested.current.add(c.provider);
            }
          return next;
        });
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'Unavailable.'));
    return () => {
      alive = false;
    };
  }, []);
  const load = async (provider: ProviderId, force = false) => {
    if (!force && requested.current.has(provider)) return;
    requested.current.add(provider);
    setCatalogs((old) => ({
      ...old,
      [provider]: { models: old[provider]?.models ?? [], error: '', loading: true },
    }));
    try {
      const list = await loadModels(undefined, provider);
      setCatalogs((old) => ({ ...old, [provider]: { models: list, error: '', loading: false } }));
    } catch (e) {
      setCatalogs((old) => ({
        ...old,
        [provider]: {
          models: old[provider]?.models ?? [],
          loading: false,
          error:
            e instanceof Error
              ? e.message
              : `${providerNames[provider]} models could not be listed.`,
        },
      }));
    }
  };
  const routine = (provider: ProviderId) => {
    const choice = status?.policy.models[provider][taskTiers.routine];
    const list = catalogs[provider]?.models ?? [];
    const id = choice ? (choice.model ?? latestFamily(list, choice.family)?.id) : undefined;
    return { choice, id, model: list.find((m) => m.id === id) };
  };
  const name = (id: string | null | undefined) => {
    if (!id) return 'Unknown model';
    for (const c of Object.values(catalogs)) {
      const found = c?.models.find((m) => m.id === id);
      if (found) return found.label === found.id ? found.id : `${found.label} (${found.id})`;
    }
    return id;
  };
  return { status, error, catalogs, load, routine, name };
}
export type HealthModels = ReturnType<typeof useHealthModels>;

type Selection = { kind: 'auto' } | { kind: 'new' } | { kind: 'thread'; id: string };
type Saved = {
  selection: Selection;
  provider: ProviderId | null;
  model: string;
  effort: string;
  draft: string;
};
const storageKey = () => `swa:health-assistant:${apiScope()}`;
function restore(): Saved {
  const fallback: Saved = {
    selection: { kind: 'auto' },
    provider: null,
    model: '',
    effort: '',
    draft: '',
  };
  try {
    const value = JSON.parse(
      sessionStorage.getItem(storageKey()) ?? 'null',
    ) as Partial<Saved> | null;
    if (!value || typeof value !== 'object') return fallback;
    const s = value.selection;
    return {
      selection:
        s?.kind === 'new'
          ? s
          : s?.kind === 'thread' && typeof s.id === 'string' && /^[0-9a-f-]{36}$/i.test(s.id)
            ? { kind: 'thread', id: s.id }
            : fallback.selection,
      provider: value.provider === 'codex' || value.provider === 'claude' ? value.provider : null,
      model: typeof value.model === 'string' ? value.model.slice(0, 100) : '',
      effort: typeof value.effort === 'string' ? value.effort.slice(0, 64) : '',
      draft: typeof value.draft === 'string' ? value.draft.slice(0, 1000) : '',
    };
  } catch {
    return fallback;
  }
}

type Line =
  | { kind: 'entry'; at: string; entry: Entry }
  | { kind: 'consult'; at: string; check: ResourceCheck };

export function HealthAssistant({
  status,
  stale,
  modelsState,
  refresh,
  select,
  showHistory,
  onStop,
  stopping,
  stopError,
}: {
  status: ResourceStatus | null;
  stale: boolean;
  modelsState: HealthModels;
  refresh: () => void;
  select: { check: ResourceCheck; nonce: number } | null;
  showHistory: () => void;
  onStop: (check: ResourceCheck) => void;
  stopping: boolean;
  stopError: string;
}) {
  const [saved, setSaved] = useState(restore);
  const [notice, setNotice] = useState('');
  const [thread, setThread] = useState<{
    id: string;
    data: AgentDetail | null;
    earlier: Entry[];
    error: string;
  } | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const ask = useResourceActions(refresh);
  const checks = status?.checks ?? [];
  const rootOf = (check: ResourceCheck) =>
    (check.escalatedFrom && checks.find((c) => c.id === check.escalatedFrom)?.agentId) ||
    check.agentId;
  const update = (change: Partial<Saved>) => setSaved((old) => ({ ...old, ...change }));
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey(), JSON.stringify(saved));
    } catch {
      // Private browsing can refuse storage; the draft stays in this page.
    }
  }, [saved]);
  // Resolve "latest conversation" once so a later automatic check cannot swap the thread.
  useEffect(() => {
    if (saved.selection.kind !== 'auto' || !status) return;
    const latest = checks[0];
    update({ selection: latest ? { kind: 'thread', id: rootOf(latest) } : { kind: 'new' } });
  }, [status, saved.selection.kind]);
  useEffect(() => {
    if (!select) return;
    update({ selection: { kind: 'thread', id: rootOf(select.check) } });
    ask.clear();
    setNotice('');
    panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    composer.current?.focus({ preventScroll: true });
  }, [select]);
  const threadId = saved.selection.kind === 'thread' ? saved.selection.id : null;
  const threadChecks = checks.filter((c) => threadId && rootOf(c) === threadId);
  const signature = threadChecks.map((c) => `${c.id}:${c.state}:${c.summary.length}`).join('|');
  // Reads the retained conversation only. Opening or refreshing it never starts a model turn.
  useEffect(() => {
    if (!threadId) {
      setThread(null);
      return;
    }
    let alive = true;
    setThread((old) =>
      old?.id === threadId ? old : { id: threadId, data: null, earlier: [], error: '' },
    );
    detail(threadId)
      .then((data) => {
        if (alive)
          setThread((old) => ({
            id: threadId,
            data,
            earlier: old?.id === threadId ? old.earlier : [],
            error: '',
          }));
      })
      .catch((e) => {
        if (alive)
          setThread((old) => ({
            id: threadId,
            data: old?.id === threadId ? old.data : null,
            earlier: old?.id === threadId ? old.earlier : [],
            error: e instanceof Error ? e.message : 'This conversation could not be loaded.',
          }));
      });
    return () => {
      alive = false;
    };
  }, [threadId, signature]);
  const agent = thread?.id === threadId ? thread?.data?.agent : undefined;
  const primaryCheck = threadChecks.find((c) => !c.escalatedFrom);
  const threadProvider = agent?.provider;
  const threadModel = agent?.model ?? primaryCheck?.model ?? null;
  const defaultProvider = modelsState.status
    ? (policyProvider(modelsState.status.policy, 'routine') ?? null)
    : null;
  const provider: ProviderId | null = threadId
    ? (threadProvider ?? null)
    : (saved.provider ?? defaultProvider);
  useEffect(() => {
    if (provider) void modelsState.load(provider);
  }, [provider]);
  const catalog = provider ? modelsState.catalogs[provider] : undefined;
  const routine = provider ? modelsState.routine(provider) : null;
  const selectedModel = saved.model
    ? catalog?.models.find((m) => m.id === saved.model)
    : routine?.model;
  const efforts = selectedModel?.efforts ?? [];
  // Mirrors the central resolver for routine-tier defaults; the saved conversation shows the result.
  const defaultEffort =
    routine?.choice?.effort ??
    (routine?.model?.efforts.includes('low')
      ? 'low'
      : routine?.model?.efforts.includes('medium')
        ? 'medium'
        : undefined);
  const entries =
    thread?.id === threadId && thread?.data
      ? [
          ...thread.earlier,
          ...thread.data.entries.filter((e) => !thread.earlier.some((o) => o.id === e.id)),
        ]
      : [];
  const lines: Line[] = [
    ...entries
      .filter((e) => ['user', 'message', 'assistant', 'system'].includes(e.kind) && e.text.trim())
      .map((entry) => ({ kind: 'entry' as const, at: entry.createdAt, entry })),
    ...threadChecks
      .filter((c) => c.escalatedFrom)
      .map((check) => ({ kind: 'consult' as const, at: check.createdAt, check })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const hint = useScrollHints(scroll, threadId ?? 'new');
  useEffect(() => {
    pinned.current = true;
  }, [threadId]);
  useEffect(() => {
    const element = scroll.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [lines.length, signature, threadId]);
  const running = checks.find(activeCheck);
  const runningHere = running && threadId && rootOf(running) === threadId ? running : undefined;
  const question = saved.draft.trim();
  const blocked = !status
    ? 'Waiting for the computer’s first health reading.'
    : stale
      ? 'Waiting for a fresh reading. The assistant needs a current snapshot; monitoring retries on its own.'
      : running
        ? runningHere
          ? 'This conversation’s question is still being answered.'
          : 'One check at a time. Another check is queued or running.'
        : !provider
          ? threadId
            ? 'Loading this conversation…'
            : 'Choose Ask Codex or Ask Claude.'
          : threadId && !question
            ? 'Type a follow-up question.'
            : '';
  const payload = (): Record<string, unknown> =>
    threadId
      ? // The server keeps the conversation's own provider, model and thinking level.
        { agentId: threadId, question }
      : {
          provider,
          ...(saved.model ? { model: saved.model } : {}),
          ...(saved.effort ? { effort: saved.effort } : {}),
          ...(question ? { question } : {}),
        };
  // A retry skips local guards: the server answers a saved receipt before any other check.
  const send = async (retry = false) => {
    if ((!retry && blocked) || ask.busy) return;
    const known = new Set(checks.map((c) => c.id));
    const result = await ask.run('/resources/ask', payload());
    if (!result) return;
    const created =
      result.checks.find((c) => c.reason === 'asked' && !known.has(c.id)) ??
      (result.checks[0]?.reason === 'asked' ? result.checks[0] : undefined);
    pinned.current = true;
    update({
      draft: '',
      ...(threadId || !created ? {} : { selection: { kind: 'thread', id: created.agentId } }),
    });
    setNotice(threadId ? '' : `New ${providerNames[provider!]} diagnosis started.`);
  };
  const choose = (next: ProviderId) => {
    ask.clear();
    if (threadId) {
      if (next === threadProvider) return;
      update({ selection: { kind: 'new' }, provider: next, model: '', effort: '' });
      setNotice(
        `New ${providerNames[next]} diagnosis. The ${threadProvider ? providerNames[threadProvider] : 'earlier'} conversation stays in History.`,
      );
      return;
    }
    update({ provider: next, model: '', effort: '' });
    setNotice('');
  };
  const startNew = () => {
    ask.clear();
    update({
      selection: { kind: 'new' },
      provider: threadProvider ?? saved.provider,
      model: '',
      effort: '',
    });
    setNotice('New diagnosis. The previous conversation stays in History.');
  };
  const started = thread?.data?.runs[0]?.createdAt ?? primaryCheck?.createdAt;
  const latestOther = !threadId ? checks[0] : undefined;
  return (
    <section className="health-assistant" aria-labelledby="health-assistant" ref={panel}>
      <div className="health-assistant-head">
        <div>
          <h2 id="health-assistant">Resource assistant</h2>
          <p>
            {threadId
              ? `Conversation${started ? ` from ${when(started)}` : ''}${threadProvider ? ` · ${providerNames[threadProvider]}` : ''}`
              : `New diagnosis${provider ? ` · ${providerNames[provider]}` : ''}`}
          </p>
        </div>
        <div className="health-assistant-tools">
          {threadId && (
            <button onClick={startNew}>
              <Plus size={16} /> New diagnosis
            </button>
          )}
          {!!checks.length && (
            <button onClick={showHistory}>
              <History size={16} /> Past diagnoses
            </button>
          )}
        </div>
      </div>
      <div className="health-provider" role="radiogroup" aria-label="Assistant provider">
        {(['codex', 'claude'] as const).map((p) => (
          <button
            key={p}
            role="radio"
            aria-checked={provider === p}
            disabled={!!ask.busy}
            onClick={() => choose(p)}
          >
            Ask {providerNames[p]}
          </button>
        ))}
      </div>
      {threadId ? (
        <p className="health-model-fixed">
          <span>
            <strong>{threadModel ? modelsState.name(threadModel) : 'Loading model…'}</strong>
            {agent ? ` · thinking ${effortLabel(agent.effort)}` : ''}
            {agent
              ? ` · ${agent.permission === 'read-only' ? 'read-only' : 'can edit its folder'}`
              : ''}
          </span>
          <small>
            Follow-ups keep this conversation’s provider and model. Choosing the other provider or
            New diagnosis starts a separate conversation.
          </small>
        </p>
      ) : (
        <div className="health-model-pick">
          <label>
            <span>Model</span>
            <select
              value={saved.model}
              disabled={!provider || !!ask.busy}
              onChange={(e) => update({ model: e.target.value, effort: '' })}
            >
              <option value="">
                {routine?.model
                  ? `${routine.model.label} · routine-check default`
                  : routine?.choice
                    ? `Latest ${routine.choice.family} · routine-check default`
                    : 'Central routine-check default'}
              </option>
              {catalog?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label === m.id ? m.id : `${m.label} (${m.id})`}
                </option>
              ))}
              {saved.model && !catalog?.models.some((m) => m.id === saved.model) && (
                <option value={saved.model}>{saved.model}</option>
              )}
            </select>
          </label>
          <label>
            <span>Thinking</span>
            <select
              value={saved.effort}
              disabled={!provider || !!ask.busy}
              onChange={(e) => update({ effort: e.target.value })}
            >
              <option value="">
                {saved.model
                  ? 'Model default'
                  : defaultEffort
                    ? `${effortLabel(defaultEffort)} · default`
                    : 'Default'}
              </option>
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effortLabel(effort)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="health-icon-button"
            aria-label={`Refresh ${provider ? providerNames[provider] : ''} model list`}
            disabled={!provider || !!catalog?.loading}
            onClick={() => provider && void modelsState.load(provider, true)}
          >
            <RefreshCw size={17} />
          </button>
          <small>
            {!provider
              ? 'Choose a provider to see its models.'
              : catalog?.loading
                ? `Checking ${providerNames[provider]}’s available models…`
                : catalog?.error
                  ? catalog.error
                  : modelsState.error && !modelsState.status
                    ? 'Model settings are unavailable; the central default will be used.'
                    : routine?.choice && !routine.model && !saved.model
                      ? `No ${routine.choice.family} model is listed right now. Choose another model or refresh.`
                      : modelsState.status &&
                          !modelsState.status.policy.enabledProviders.includes(provider)
                        ? `${providerNames[provider]} is not in your Model settings defaults. It runs only because you chose it here.`
                        : 'Defaults come from Model settings. Other models apply to this diagnosis only.'}
          </small>
        </div>
      )}
      <div
        className="health-transcript"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {threadId ? (
          <>
            {thread?.data?.hasMore && !thread.earlier.length && (
              <button
                className="health-text-button"
                disabled={loadingEarlier}
                onClick={async () => {
                  const first = entries[0];
                  if (!first || !threadId) return;
                  setLoadingEarlier(true);
                  try {
                    const older = await detail(threadId, first.id);
                    pinned.current = false;
                    setThread((old) =>
                      old?.id === threadId ? { ...old, earlier: older.entries } : old,
                    );
                  } catch {
                    setNotice('Earlier messages could not be loaded. Try again.');
                  } finally {
                    setLoadingEarlier(false);
                  }
                }}
              >
                {loadingEarlier ? 'Loading…' : 'Show earlier messages'}
              </button>
            )}
            {thread?.error && !thread.data && (
              <p className="health-alert" role="alert">
                {thread.error} Start a new diagnosis, or open another report from History.
              </p>
            )}
            {!thread?.data && !thread?.error && (
              <p className="health-empty">Loading conversation…</p>
            )}
            {lines.map((line) =>
              line.kind === 'consult' ? (
                <article key={line.check.id} className="health-message is-consult">
                  <header>
                    <strong>Grad consultation</strong>
                    <small>
                      {clock(line.at)} · {modelsState.name(line.check.model)} ·{' '}
                      {stateLabels[line.check.state]}
                    </small>
                  </header>
                  <ReportText text={line.check.summary} fallback={reportFallback(line.check)} />
                </article>
              ) : line.entry.kind === 'assistant' ? (
                <article key={line.entry.id} className="health-message is-assistant">
                  <header>
                    <strong>Assistant</strong>
                    <small>{clock(line.at)}</small>
                  </header>
                  <ReportText text={line.entry.text.slice(0, 12_000)} fallback="" />
                </article>
              ) : line.entry.kind === 'system' ? (
                <p key={line.entry.id} className="health-message is-system">
                  {line.entry.text.slice(0, 300)}
                </p>
              ) : (
                <article key={line.entry.id} className="health-message is-question">
                  <header>
                    <strong>
                      {line.entry.kind === 'user'
                        ? 'You'
                        : (() => {
                            const check = threadChecks.find((c) => c.runId === line.entry.runId);
                            return check ? reasonLabels[check.reason] : 'Automatic check';
                          })()}
                    </strong>
                    <small>
                      {clock(line.at)}
                      {['queued', 'running'].includes(line.entry.status)
                        ? ` · ${line.entry.status}`
                        : ''}
                    </small>
                  </header>
                  <p>{line.entry.text.split('<agent-dock-evidence>')[0]!.trim().slice(0, 1000)}</p>
                </article>
              ),
            )}
            {thread?.data && !lines.length && (
              <p className="health-empty">No messages are saved in this conversation yet.</p>
            )}
          </>
        ) : (
          <div className="health-intro">
            <p>
              Describe a slowdown or anything odd. The assistant reads the snapshot above, the last
              24 hours of readings and QUARK’s queue. It runs only when you send, answers with
              read-only advice, then goes idle.
            </p>
            {latestOther && (
              <article className="health-latest">
                <header>
                  <strong>
                    Latest: {reasonLabels[latestOther.reason]} · {when(latestOther.createdAt)}
                  </strong>
                  <small>
                    {modelsState.name(latestOther.model)} · {stateLabels[latestOther.state]}
                  </small>
                </header>
                <p>
                  {latestOther.summary.replace(/[#*_`>]/g, '').slice(0, 260) ||
                    reportFallback(latestOther)}
                </p>
                <button
                  className="health-text-button"
                  onClick={() => {
                    update({ selection: { kind: 'thread', id: rootOf(latestOther) } });
                    ask.clear();
                    setNotice('');
                  }}
                >
                  Open this conversation
                </button>
              </article>
            )}
          </div>
        )}
      </div>
      <div className="health-transcript-hint" aria-hidden={!hint}>
        {hint}
      </div>
      {running && (
        <div className="health-running" role="status">
          <span>
            <strong>
              {running.state === 'queued' ? 'Queued in QUARK' : 'Answering'}
              {runningHere
                ? ''
                : ` · ${reasonLabels[running.reason]} from ${clock(running.createdAt)}`}
            </strong>
            <small>
              {running.waitReason ??
                (running.state === 'queued'
                  ? 'Waiting for its turn.'
                  : 'Reading the saved measurements and current work.')}{' '}
              Queued checks expire after 15 minutes; running checks stop after about three.
            </small>
          </span>
          {!runningHere && (
            <button
              onClick={() => {
                update({ selection: { kind: 'thread', id: rootOf(running) } });
                ask.clear();
                setNotice('');
              }}
            >
              Open
            </button>
          )}
          <button disabled={stopping} onClick={() => onStop(running)}>
            <Square size={14} /> {stopping ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      )}
      {stopError && running && (
        <p role="alert" className="health-alert">
          {stopError} Stopping again uses the same request.
        </p>
      )}
      <form
        className="health-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor="health-question">
          {threadId ? 'Follow-up question' : 'Your question'}{' '}
          <span>{threadId ? '' : 'Optional'}</span>
        </label>
        <div>
          <textarea
            id="health-question"
            ref={composer}
            rows={2}
            maxLength={1000}
            value={saved.draft}
            placeholder={
              threadId
                ? 'For example, what changed since your last answer?'
                : 'For example, Chrome feels slow even though CPU looks low.'
            }
            onChange={(e) => update({ draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button type="submit" className="health-send" disabled={!!blocked || !!ask.busy}>
            <ArrowUp size={17} />
            {ask.busy
              ? 'Sending…'
              : threadId
                ? 'Send follow-up'
                : `Ask ${provider ? providerNames[provider] : ''}`.trim()}
          </button>
        </div>
        <small className="health-composer-note">
          {blocked ||
            'Uses your signed-in subscription under QUARK’s shared limits. Advice only: it cannot close apps or change this computer.'}
        </small>
      </form>
      {ask.failure && (
        <div role="alert" className="health-alert">
          <p>
            {ask.failure.message}
            {ask.failure.uncertain
              ? ' The request may have arrived. Retry sends the same request, so it cannot start a second check.'
              : ''}
          </p>
          <button disabled={!!ask.busy} onClick={() => void send(true)}>
            Retry the same request
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="health-notice">
          {notice}
        </p>
      )}
    </section>
  );
}
