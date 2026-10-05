import { useEffect, useRef, useState } from 'react';
import { Clock3, Plus, RefreshCw, Settings2, Square } from 'lucide-react';
import {
  agentSchema,
  snapshotSchema,
  effortLabel,
  latestFamily,
  modelPolicyStatusSchema,
  policyProvider,
  policyDefaultEffort,
  taskTiers,
  type AgentDetail,
  type Model,
  type ModelPolicyStatus,
  type ProviderId,
  type ResourceCheck,
  type ResourceStatus,
  type WorkspaceSnapshot,
} from '@dock/shared';
import { api, apiScope, detail, models as loadModels } from '../api';
import { Conversation, Composer } from '../Conversation';
import { Modal } from '../Modal';
import { useSharedDraft, useWorkspaceState, type SharedDraft } from '../useWorkspaceState';
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
  const routine = (provider: ProviderId, task: 'routine' | 'reasoning' = 'routine') => {
    const choice = status?.policy.models[provider][taskTiers[task]];
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
/** Compact navigation text only; the saved report keeps its original formatting. */
function diagnosisPreview(text: string) {
  return text
    .replace(/^ {0,3}(?:#{1,6}\s+|>\s?)/gm, '')
    .replace(/^ {0,3}(?:[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^\n)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[\s(])([*_])(\S(?:[^\n]*?\S)?)\2(?=$|[\s.,;:!?])/g, '$1$3')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
type Saved = {
  selection: Selection;
  provider: ProviderId | null;
  model: string;
  effort: string;
  draft: string;
  handoff: string | null;
};
const storageKey = () => `swa:health-assistant:${apiScope()}`;
const unconfirmedDelivery = 'Delivery was not confirmed. Send again to check the same request.';
function restore(): Saved {
  const fallback: Saved = {
    selection: { kind: 'auto' },
    provider: null,
    model: '',
    effort: '',
    draft: '',
    handoff: null,
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
      handoff:
        typeof value.handoff === 'string' && /^[0-9a-f-]{36}$/i.test(value.handoff)
          ? value.handoff
          : null,
    };
  } catch {
    return fallback;
  }
}

/** The old composer remains visible until the replacement's existing CAS draft is saved. */
function DiagnosisDraftHandoff({
  workspace,
  agentId,
  text,
  complete,
  cancel,
}: {
  workspace: WorkspaceSnapshot | null;
  agentId: string;
  text: string;
  complete: (text: string) => boolean;
  cancel: () => void;
}) {
  const draft = useSharedDraft(workspace, agentId);
  const seeded = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const latest = useRef({ text, complete });
  latest.current = { text, complete };
  const [error, setError] = useState('');
  const save = async () => {
    if (!alive.current || !draft.ready || draft.conflict) return;
    if (!seeded.current && draft.currentText() && draft.currentText() !== latest.current.text) {
      setError('The new diagnosis has a saved draft. Your current draft stays here.');
      return;
    }
    seeded.current = true;
    if (draft.currentText() !== latest.current.text) draft.setText(latest.current.text);
    try {
      await draft.flush();
      if (!alive.current) return;
      setError('');
      if (
        draft.currentText() === latest.current.text &&
        latest.current.complete(draft.currentText())
      )
        alive.current = false;
    } catch {
      setError('Your message was accepted. Reconnect to save the draft in the new diagnosis.');
    }
  };
  useEffect(() => {
    void save();
  }, [draft.ready, draft.conflict, text]);
  return error || draft.error ? (
    <div className="health-alert health-draft-recovery" role="alert">
      <p>{error || draft.error}</p>
      <div className="health-draft-recovery-actions">
        <button
          aria-label="Retry saving draft"
          disabled={!draft.ready || draft.saving || draft.conflict}
          onClick={() => void save()}
        >
          Retry save
        </button>
        <button
          aria-label="Keep draft here"
          onClick={() => {
            alive.current = false;
            cancel();
          }}
        >
          Keep draft
        </button>
      </div>
    </div>
  ) : null;
}

export function HealthAssistant({
  status,
  stale,
  unreachable,
  modelsState,
  refresh,
  agentId,
  onStop,
  stopping,
  stopError,
}: {
  status: ResourceStatus | null;
  stale: boolean;
  unreachable: boolean;
  modelsState: HealthModels;
  refresh: () => void;
  agentId?: string;
  onStop: (check: ResourceCheck) => void;
  stopping: boolean;
  stopError: string;
}) {
  const [saved, setSaved] = useState<Saved>(() => {
    const saved = restore();
    // A deep link must never expose a new-diagnosis draft before its thread loads.
    // Typing into that temporary composer would be lost when the selection effect runs.
    return agentId ? { ...saved, selection: { kind: 'thread', id: agentId } } : saved;
  });
  const [notice, setNotice] = useState('');
  const [thread, setThread] = useState<AgentDetail | null>(null);
  const [modelEdit, setModelEdit] = useState<{ model: string; effort: string } | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState('');
  const [error, setError] = useState('');
  const [handoffText, setHandoffText] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  const sourceDraft = useRef<SharedDraft | null>(null);
  const acknowledgedAgent = useRef<string | null>(null);
  const workspace = useWorkspaceState();
  const snapshot = useReading('/snapshot', snapshotSchema.parse);
  const ask = useResourceActions(refresh);
  const checks = status?.checks ?? [];
  const diagnoses = checks.filter(
    (check, index, all) =>
      check.reason === 'asked' &&
      !check.escalatedFrom &&
      all.findIndex(
        (other) =>
          other.reason === 'asked' && !other.escalatedFrom && other.agentId === check.agentId,
      ) === index,
  );
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
  const routine = provider ? modelsState.routine(provider, 'reasoning') : null;
  const selectedModel = saved.model
    ? catalog?.models.find((m) => m.id === saved.model)
    : routine?.model;
  const efforts = selectedModel?.efforts ?? [];
  const defaultEffort =
    routine?.choice?.effort ?? policyDefaultEffort(routine?.model?.efforts ?? [], 'grad');
  const foreground = checks.find((c) => activeCheck(c) && c.reason === 'asked');
  const running = foreground ?? checks.find(activeCheck);
  const runningHere = running && threadId && rootOf(running) === threadId ? running : undefined;
  const identity = agent ? resourceAssistantOf(agent) : null;
  const snapshotOnly = identity
    ? identity.mode === 'snapshot' && identity.reason !== 'asked'
    : !!primaryCheck && primaryCheck.reason !== 'asked';
  const canChangeModel =
    !snapshotOnly || threadChecks.some((c) => c.reason === 'asked' && !c.escalatedFrom);
  const modelLocked =
    !canChangeModel ||
    !!foreground ||
    !agent ||
    ['running', 'queued', 'waiting'].includes(agent.status);
  const needsFreshReading = snapshotOnly && !identity?.reason;
  const blocked = !status
    ? unreachable
      ? 'Computer health on this computer could not be reached. Retry reading on Computer health.'
      : 'Connecting to computer health…'
    : stale && needsFreshReading
      ? 'Waiting for a fresh health reading for this automatic check.'
      : foreground || runningHere
        ? 'This resource conversation is queued or running. You can start a new diagnosis.'
        : modelSaving
          ? 'Saving the model…'
          : !provider
            ? modelsState.error
              ? 'Model settings could not be loaded. Choose a provider in Model settings.'
              : 'Loading the assistant’s provider…'
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
    if (!result) throw new Error(unconfirmedDelivery);
    const created =
      result.checks.find((c) => c.reason === 'asked' && !known.has(c.id)) ??
      result.checks.find((c) => c.reason === 'asked');
    acknowledgedAgent.current = created && created.agentId !== threadId ? created.agentId : null;
    setError('');
    setNotice('');
  };
  // The uncertain-delivery alert already explains an unconfirmed send; show it once.
  const shownError = (ask.failure && error === unconfirmedDelivery ? '' : error) || workspace.error;
  const choose = (next: ProviderId) => {
    ask.clear();
    if (next === provider) return;
    startNew(next);
    setModelOpen(true);
  };
  const startNew = (nextProvider?: ProviderId) => {
    ask.clear();
    local.checkpoint();
    update({
      selection: { kind: 'new' },
      provider: nextProvider ?? threadProvider ?? saved.provider,
      model: nextProvider && nextProvider !== provider ? '' : (threadModel ?? saved.model),
      effort: nextProvider && nextProvider !== provider ? '' : (agent?.effort ?? saved.effort),
      handoff: null,
      draft: nextProvider && !threadId ? saved.draft : '',
    });
    setThread(null);
    setError('');
    setModelError('');
    setModelEdit(null);
    setModelOpen(false);
    setHistoryOpen(false);
    setNotice('');
    // A deep link must not reopen the previous conversation after a reload.
    if (agentId) window.location.replace('#/resources/chat');
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
      <div className="health-chat-options">
        <div className="health-assistant-head">
          <div>
            <h2 id="health-assistant">Resource assistant</h2>
            <p>
              {threadId
                ? `Conversation${started ? ` from ${when(started)}` : ''}`
                : 'New diagnosis'}
            </p>
          </div>
          <div className="health-assistant-tools">
            <button
              className="health-model-button"
              aria-label="Model settings"
              title="Model settings"
              disabled={!!threadId && !agent}
              onClick={() => {
                setModelError('');
                setModelEdit(agent?.model ? { model: agent.model, effort: agent.effort } : null);
                setModelOpen(true);
              }}
            >
              <Settings2 size={18} aria-hidden="true" />
              <span>
                {threadId
                  ? (catalog?.models.find((m) => m.id === threadModel)?.label ??
                    threadModel ??
                    'Loading model…')
                  : (selectedModel?.label ?? (provider ? providerNames[provider] : 'Choose model'))}
              </span>
            </button>
            <button
              className="health-history-button"
              aria-label="Diagnosis history"
              title="Diagnosis history"
              disabled={!!ask.busy || modelSaving || !!saved.handoff}
              onClick={() => setHistoryOpen(true)}
            >
              <Clock3 size={19} aria-hidden="true" />
            </button>
            <button
              className="primary health-new-diagnosis"
              onClick={() => startNew()}
              disabled={!!ask.busy || modelSaving || !!saved.handoff}
            >
              <Plus size={18} aria-hidden="true" /> New diagnosis
            </button>
          </div>
        </div>
        {historyOpen && (
          <Modal
            title="Diagnosis history"
            className="resource-history-dialog"
            close={() => setHistoryOpen(false)}
          >
            {diagnoses.length ? (
              <ul className="health-diagnosis-history">
                {diagnoses.map((check) => (
                  <li key={check.agentId}>
                    <button
                      aria-current={threadId === check.agentId ? 'true' : undefined}
                      onClick={() => {
                        ask.clear();
                        update({ selection: { kind: 'thread', id: check.agentId } });
                        setThread(null);
                        setError('');
                        setNotice('');
                        setHistoryOpen(false);
                        window.location.replace(`#/resources/${check.agentId}`);
                      }}
                    >
                      <strong>{diagnosisPreview(check.summary || reportFallback(check))}</strong>
                      <span>
                        {when(check.createdAt)} · {modelsState.name(check.model)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No saved diagnoses yet.</p>
            )}
          </Modal>
        )}
        {modelOpen && (
          <Modal
            title="Resource assistant model"
            className="resource-model-dialog"
            close={() => {
              if (!modelSaving) setModelOpen(false);
            }}
          >
            <div className="health-provider" role="radiogroup" aria-label="Assistant provider">
              {(['codex', 'claude'] as const).map((p) => (
                <button
                  key={p}
                  role="radio"
                  aria-checked={provider === p}
                  disabled={!!ask.busy || modelSaving}
                  onClick={() => choose(p)}
                >
                  {providerNames[p]}
                </button>
              ))}
            </div>
            {threadId && agent && modelEdit ? (
              <>
                <p>Change the model while keeping this conversation.</p>
                {modelLocked && (
                  <p>
                    Model changes are available when this conversation is idle. You can start a new
                    conversation with another provider.
                  </p>
                )}
                <div className="health-model-pick">
                  <label>
                    <span>Model</span>
                    <select
                      value={modelEdit.model}
                      disabled={modelLocked || modelSaving || !!catalog?.loading}
                      onChange={(event) => {
                        const model = catalog?.models.find((m) => m.id === event.target.value);
                        setModelEdit({
                          model: event.target.value,
                          effort: model?.efforts.includes(modelEdit.effort)
                            ? modelEdit.effort
                            : (model?.efforts[0] ?? agent.effort),
                        });
                      }}
                    >
                      {catalog?.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label === model.id ? model.id : `${model.label} (${model.id})`}
                        </option>
                      ))}
                      {!catalog?.models.some((m) => m.id === modelEdit.model) && (
                        <option value={modelEdit.model}>{modelEdit.model}</option>
                      )}
                    </select>
                  </label>
                  <label>
                    <span>Thinking</span>
                    <select
                      value={modelEdit.effort}
                      disabled={modelLocked || modelSaving}
                      onChange={(event) =>
                        setModelEdit({ ...modelEdit, effort: event.target.value })
                      }
                    >
                      {(
                        catalog?.models.find((m) => m.id === modelEdit.model)?.efforts ?? [
                          modelEdit.effort,
                        ]
                      ).map((e) => (
                        <option key={e} value={e}>
                          {effortLabel(e)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {(modelError || catalog?.error) && (
                  <p role="alert">{modelError || catalog?.error}</p>
                )}
                <div className="resource-model-actions">
                  <button
                    className="secondary"
                    disabled={modelLocked || modelSaving || !!catalog?.loading}
                    onClick={() => void modelsState.load(agent.provider, true)}
                  >
                    Refresh models
                  </button>
                  <button
                    className="primary"
                    disabled={
                      modelLocked ||
                      modelSaving ||
                      !catalog?.models.some((m) => m.id === modelEdit.model)
                    }
                    onClick={async () => {
                      setModelSaving(true);
                      setModelError('');
                      try {
                        await api(`/agents/${agent.id}/settings`, {
                          model: modelEdit.model,
                          effort: modelEdit.effort,
                          permission: agent.permission,
                          toolPolicy: agent.toolPolicy,
                        });
                        setThread(await detail(agent.id));
                        setModelEdit(null);
                        setModelOpen(false);
                        setNotice('Model updated. Your next message uses the selected model.');
                        refresh();
                      } catch (reason) {
                        setModelError(
                          reason instanceof Error
                            ? reason.message
                            : 'The model could not be saved. Try again.',
                        );
                      } finally {
                        setModelSaving(false);
                      }
                    }}
                  >
                    {modelSaving ? 'Saving…' : 'Use this model'}
                  </button>
                </div>
              </>
            ) : !threadId ? (
              <>
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
                          ? `${routine.model.label} · diagnosis default`
                          : routine?.choice
                            ? `Latest ${routine.choice.family} · diagnosis default`
                            : 'Central diagnosis default'}
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
                    <RefreshCw size={17} /> Refresh models
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
                <div className="resource-model-actions">
                  <button className="primary" onClick={() => setModelOpen(false)}>
                    Done
                  </button>
                </div>
              </>
            ) : (
              <p>Loading this conversation’s model…</p>
            )}
            {threadId && (
              <p className="health-model-help">
                Choosing another provider starts a new conversation. Your previous conversation
                stays saved.
              </p>
            )}
          </Modal>
        )}
        {running && (
          <div className="health-running" role="status">
            <span>
              <strong>
                {running.reason !== 'asked'
                  ? 'Background health check'
                  : running.state === 'queued'
                    ? 'Waiting to answer'
                    : 'Answering'}
              </strong>
              <small>{running.waitReason ?? 'Reviewing computer health and your request.'}</small>
            </span>
            {!runningHere && (
              <button
                onClick={() => update({ selection: { kind: 'thread', id: rootOf(running) } })}
              >
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
        {shownError && (
          <p role="alert" className="health-alert">
            {shownError}
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
        {stale && !needsFreshReading && (
          <p className="health-notice">
            The saved readings may be old. You can ask the assistant to inspect current conditions.
          </p>
        )}
      </div>
      {saved.handoff && draftReady && (
        <DiagnosisDraftHandoff
          key={saved.handoff}
          workspace={workspace.state}
          agentId={saved.handoff}
          text={handoffText}
          cancel={() => update({ handoff: null })}
          complete={(text) => {
            if (sourceDraft.current?.conflict || sourceDraft.current?.currentText() !== text)
              return false;
            const destination = saved.handoff!;
            update({ selection: { kind: 'thread', id: destination }, handoff: null, draft: '' });
            setDraftReady(false);
            if (agentId) window.location.replace(`#/resources/${destination}`);
            return true;
          }}
        />
      )}
      <div className="health-chat-main flow-chat-main">
        {agent ? (
          <Conversation
            // The transcript and composer are siblings: their keys must be distinct.
            key={`conversation:${agent.id}`}
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
          <div className="health-intro" key="new-conversation">
            <p>{threadId ? 'Loading conversation…' : 'Ask about this computer'}</p>
            {!threadId && (
              <p>
                Describe a slowdown or ask what’s running. Current measurements are included
                automatically.
              </p>
            )}
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
            key={`composer:${threadId ?? 'new'}`}
            agent={agent ?? placeholder}
            workspace={workspace.state}
            draftOverride={threadId ? undefined : local.draft}
            maxLength={1000}
            specialized
            messagePlaceholder="Ask about this computer…"
            localHistory={local.history}
            onNotepadClose={local.checkpoint}
            disabled={!!blocked || !!ask.busy || !!saved.handoff || (!!threadId && !agent)}
            onError={setError}
            send={send}
            onDraftReady={(draft) => {
              sourceDraft.current = draft;
              setDraftReady(!draft.conflict);
              if (saved.handoff) setHandoffText(draft.currentText());
            }}
            onSent={(remainingDraft) => {
              if (!acknowledgedAgent.current) return;
              setHandoffText(remainingDraft);
              update({ handoff: acknowledgedAgent.current });
              acknowledgedAgent.current = null;
            }}
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
