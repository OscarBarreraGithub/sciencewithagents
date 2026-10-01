import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Square } from 'lucide-react';
import {
  agentSchema,
  snapshotSchema,
  effortLabel,
  latestFamily,
  modelPolicyStatusSchema,
  policyProvider,
  taskTiers,
  type AgentDetail,
  type Model,
  type ModelPolicyStatus,
  type ProviderId,
  type ResourceCheck,
  type ResourceStatus,
} from '@dock/shared';
import { api, apiScope, detail, models as loadModels } from '../api';
import { Conversation, Composer } from '../Conversation';
import { useWorkspaceState } from '../useWorkspaceState';
import { useBrowserNotepad } from '../useBrowserNotepad';
import { useReading } from './useHomeData';
import { resourceAssistantOf } from './resource-chat';
import {
  activeCheck,
  providerNames,
  reportFallback,
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

export function HealthAssistant({
  status,
  stale,
  modelsState,
  refresh,
  agentId,
  onStop,
  stopping,
  stopError,
}: {
  status: ResourceStatus | null;
  stale: boolean;
  modelsState: HealthModels;
  refresh: () => void;
  agentId?: string;
  onStop: (check: ResourceCheck) => void;
  stopping: boolean;
  stopError: string;
}) {
  const [saved, setSaved] = useState(restore);
  const [notice, setNotice] = useState('');
  const [thread, setThread] = useState<AgentDetail | null>(null);
  const [error, setError] = useState('');
  const workspace = useWorkspaceState();
  const snapshot = useReading('/snapshot', snapshotSchema.parse);
  const ask = useResourceActions(refresh);
  const checks = status?.checks ?? [];
  const rootOf = (check: ResourceCheck) =>
    (check.escalatedFrom && checks.find((c) => c.id === check.escalatedFrom)?.agentId) ||
    check.agentId;
  const update = (change: Partial<Saved>) => setSaved((old) => ({ ...old, ...change }));
  const local = useBrowserNotepad(storageKey(), saved.draft, (draft) => update({ draft }));
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey(), JSON.stringify(saved));
    } catch {
      /* Text remains in this view. */
    }
  }, [saved]);
  useEffect(() => {
    if (saved.selection.kind !== 'auto' || !status) return;
    const latest = checks.find((c) => c.reason === 'asked' && !c.escalatedFrom);
    update({ selection: latest ? { kind: 'thread', id: latest.agentId } : { kind: 'new' } });
  }, [status, saved.selection.kind]);
  useEffect(() => {
    if (agentId) update({ selection: { kind: 'thread', id: agentId } });
  }, [agentId]);
  const threadId = saved.selection.kind === 'thread' ? saved.selection.id : null;
  const threadChecks = checks.filter((c) => threadId && rootOf(c) === threadId);
  const signature = threadChecks.map((c) => `${c.id}:${c.state}:${c.summary.length}`).join('|');
  useEffect(() => {
    if (!threadId) {
      setThread(null);
      return;
    }
    let alive = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await detail(threadId);
        if (alive) {
          setThread(result);
          setError('');
        }
      } catch (e) {
        if (alive)
          setError(e instanceof Error ? e.message : 'This conversation could not be loaded.');
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = window.setInterval(() => {
      if (!document.hidden) void read();
    }, 2500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [threadId, signature]);
  const agent = thread?.agent.id === threadId ? thread.agent : undefined;
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
  const defaultEffort =
    routine?.choice?.effort ??
    (routine?.model?.efforts.includes('low')
      ? 'low'
      : routine?.model?.efforts.includes('medium')
        ? 'medium'
        : undefined);
  const running = checks.find(activeCheck);
  const runningHere = running && threadId && rootOf(running) === threadId ? running : undefined;
  const identity = agent ? resourceAssistantOf(agent) : null;
  const snapshotOnly = identity
    ? identity.mode === 'snapshot' && identity.reason !== 'asked'
    : !!primaryCheck && primaryCheck.reason !== 'asked';
  const blocked = !status
    ? 'Connecting to computer health…'
    : stale && snapshotOnly
      ? 'Waiting for a fresh health reading for this automatic check.'
      : running
        ? 'One check at a time. A check is queued or running.'
        : !provider
          ? 'Loading the assistant’s provider…'
          : '';
  const send = async (question: string, key: string) => {
    const known = new Set(checks.map((c) => c.id));
    const result = await ask.run(
      '/resources/ask',
      threadId
        ? { agentId: threadId, question }
        : {
            provider,
            ...(saved.model ? { model: saved.model } : {}),
            ...(saved.effort ? { effort: saved.effort } : {}),
            question,
          },
      key,
    );
    if (!result)
      throw new Error('Delivery was not confirmed. Send again to check the same request.');
    const created =
      result.checks.find((c) => c.reason === 'asked' && !known.has(c.id)) ??
      result.checks.find((c) => c.reason === 'asked');
    if (!threadId && created)
      update({ selection: { kind: 'thread', id: created.agentId }, draft: '' });
    setNotice('');
  };
  const choose = (next: ProviderId) => {
    ask.clear();
    if (threadId && next === threadProvider) return;
    update({ selection: { kind: 'new' }, provider: next, model: '', effort: '' });
    setNotice(threadId ? 'New conversation. The earlier conversation remains saved.' : '');
  };
  const startNew = () => {
    ask.clear();
    update({
      selection: { kind: 'new' },
      provider: threadProvider ?? saved.provider,
      model: '',
      effort: '',
    });
    setNotice('The previous conversation remains saved.');
  };
  const started = thread?.runs[0]?.createdAt ?? primaryCheck?.createdAt;
  const placeholder = agentSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-000000000002',
    parentId: null,
    taskId: null,
    name: 'Resource assistant',
    role: 'manager',
    status: 'idle',
    provider: provider ?? 'codex',
    model: null,
    effort: 'low',
    permission: 'read-only',
    checkpoint: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      snapshot.retry();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please retry.');
    }
  };
  return (
    <section className="health-assistant" aria-labelledby="health-assistant">
      <div className="health-assistant-head">
        <div>
          <h2 id="health-assistant">Resource assistant</h2>
          <p>
            {threadId
              ? `Conversation${started ? ` from ${when(started)}` : ''}`
              : 'New conversation'}
          </p>
        </div>
        <div className="health-assistant-tools">
          {threadId && (
            <button onClick={startNew}>
              <Plus size={16} /> New diagnosis
            </button>
          )}
        </div>
      </div>
      <details className="health-chat-controls" open={!threadId} key={threadId ?? 'new'}>
        <summary>
          Model & provider{threadModel ? ` · ${modelsState.name(threadModel)}` : ''}
        </summary>
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
      </details>
      {running && (
        <div className="health-running" role="status">
          <span>
            <strong>{running.state === 'queued' ? 'Queued in QUARK' : 'Answering'}</strong>
            <small>{running.waitReason ?? 'Reviewing computer health and your request.'}</small>
          </span>
          {!runningHere && (
            <button onClick={() => update({ selection: { kind: 'thread', id: rootOf(running) } })}>
              Open
            </button>
          )}
          <button disabled={stopping} onClick={() => onStop(running)}>
            <Square size={14} /> {stopping ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      )}
      {stopError && (
        <p role="alert" className="health-alert">
          {stopError}
        </p>
      )}
      {(error || workspace.error) && (
        <p role="alert" className="health-alert">
          {error || workspace.error}
        </p>
      )}
      {ask.failure && (
        <p role="alert" className="health-alert">
          {ask.failure.message}{' '}
          {ask.failure.uncertain
            ? 'The request may have arrived. Send again checks the same request.'
            : ''}
        </p>
      )}
      {notice && (
        <p role="status" className="health-notice">
          {notice}
        </p>
      )}
      {stale && !snapshotOnly && (
        <p className="health-notice">
          The saved readings may be old. You can ask the assistant to inspect current conditions.
        </p>
      )}
      <div className="health-chat-main flow-chat-main">
        {agent ? (
          <Conversation
            key={agent.id}
            agent={agent}
            detail={thread}
            formatEntry={(entry) =>
              ['user', 'message'].includes(entry.kind)
                ? { ...entry, text: entry.text.split('<agent-dock-evidence>')[0]!.trim() }
                : entry
            }
            approvals={
              snapshot.data?.approvals.filter(
                (a) => a.agentId === agent.id && a.status === 'pending',
              ) ?? []
            }
            act={act}
          />
        ) : (
          <div className="health-intro">
            <p>
              {threadId
                ? 'Loading conversation…'
                : 'Describe a slowdown or anything odd. The assistant receives current measurements and saved health readings with your question.'}
            </p>
          </div>
        )}
        {threadChecks
          .filter((c) => c.escalatedFrom)
          .map((c) => (
            <details key={c.id} className="health-consult">
              <summary>Grad consultation · {modelsState.name(c.model)}</summary>
              <p>{c.summary || reportFallback(c)}</p>
            </details>
          ))}
        {(!threadId || agent) && (
          <Composer
            key={threadId ?? 'new'}
            agent={agent ?? placeholder}
            workspace={workspace.state}
            draftOverride={threadId ? undefined : local.draft}
            maxLength={1000}
            specialized
            localHistory={local.history}
            onNotepadClose={local.checkpoint}
            disabled={!!blocked || !!ask.busy || (!!threadId && !agent)}
            onError={setError}
            send={send}
            onCommand={() => {}}
            onHelp={() => {}}
            onStop={() => running && onStop(running)}
          />
        )}
        {blocked && <p className="health-composer-note">{blocked}</p>}
      </div>
    </section>
  );
}
