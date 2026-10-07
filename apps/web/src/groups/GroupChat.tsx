import { createPortal } from 'react-dom';
import { GroupDocumentOfferButton } from './GroupDocumentLink';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  groupHostErrorSchema as groupErrorSchema,
  groupHostChatSchema,
  groupHostNativeReceiptSchema,
  groupHostDraftStateSchema,
  groupHostDraftSchema,
  type GroupHostSlot,
  type GroupHostChat,
} from '@dock/shared/dist/group-host.js';
import { Conversation, Composer } from '../Conversation';
import { ApiError, apiScope } from '../api';
import type { SharedDraft } from '../useWorkspaceState';
import './group-chat.css';
import { GroupNativeOwner } from './GroupNativeOwner';
export type GroupChatClient = (path: string, body: unknown) => Promise<unknown>;
const errorText = (value: unknown) =>
  value instanceof Error ? value.message : 'Groups host unavailable. Reconnect and retry.';
const sharedDeliveryMessage = (state: string) => {
  if (state === 'source_registration_pending' || state.startsWith('pending:'))
    return 'Waiting for the shared feed.';
  if (['pending', 'waiting', 'idle', 'busy'].includes(state)) return 'Delivery is pending.';
  if (state === 'offline') return 'Waiting for a connection to deliver your message.';
  if (state === 'uncertain') return 'Delivery is not yet confirmed. Your message is saved.';
  if (state === 'suppressed') return 'This message is not shared with the feed.';
  if (state.startsWith('full:') || ['capacity', 'storage'].includes(state))
    return 'The shared feed has no storage available. Your message is saved.';
  if (['unauthorized', 'revoked', 'identity_changed'].includes(state))
    return 'Delivery is blocked. Ask your setup agent to check group access.';
  if (['exhausted', 'collision', 'protocol', 'integrity', 'invalid'].includes(state))
    return 'Delivery failed. Your message is saved.';
  return 'Delivery status is unknown. Your message is saved.';
};
const positions = new Map<string, number>();
const cacheKey = (handle: string) =>
  location.pathname === '/group-fixture'
    ? `swa:group-fixture:${location.origin}:${handle}:draft`
    : `swa:groups:${apiScope()}:${location.origin}:${handle}:draft`;
const pendingKey = (handle: string) => `${cacheKey(handle)}:pending`;

type SavedDraft = { text: string; revision: number };
type PendingDraft = { handle: string; key: string; revision: number; text: string };
// Local recovery accepts the Composer's full text bound, including text the host
// rejects. Parsing it as a valid host draft would discard its retry identity.
const localText = groupErrorSchema.shape.error.max(24_000);
const pendingRecordSchema = groupHostDraftSchema.extend({ text: localText });
const flag = groupHostChatSchema.shape.detail.shape.hasMore;
const draftViewSchema = groupHostDraftStateSchema.omit({ revision: true }).extend({
  text: localText,
  base: groupHostDraftStateSchema.nullable(),
  pending: pendingRecordSchema.nullable(),
  conflict: groupHostDraftStateSchema.nullable(),
  blocked: flag,
  ready: flag,
  saving: flag,
  error: groupErrorSchema.shape.error.max(8192),
});
type DraftView = ReturnType<typeof draftViewSchema.parse>;
const rejectedText = 'Draft too long or invalid. Shorten or correct it to save and send.';
function storedJson(raw: string | null): unknown {
  // Four bounded text snapshots plus JSON escaping fit within this local bound.
  if (!raw || raw.length > 750_000) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
function pendingRecord(value: unknown, handle: string) {
  const result = pendingRecordSchema.safeParse(value);
  return result.success && result.data.handle === handle ? result.data : null;
}
function storedView(raw: string | null, handle: string): DraftView | null {
  const value = storedJson(raw);
  const result = draftViewSchema.safeParse(value);
  if (result.success && (!result.data.pending || result.data.pending.handle === handle))
    return result.data;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // Salvage a supported pending identity even when unrelated view metadata is
  // malformed. Never adopt another shared/private handle from browser storage.
  const record = value as Record<string, unknown>;
  const otherPending = pendingRecordSchema.safeParse(record.pending);
  // A copied view from another scope has no trustworthy text/base provenance.
  if (otherPending.success && otherPending.data.handle !== handle) return null;
  const text = localText.safeParse(record.text);
  const base = groupHostDraftStateSchema.safeParse(record.base);
  const pending = pendingRecord(record.pending, handle);
  const conflict = groupHostDraftStateSchema.safeParse(record.conflict);
  if (!text.success && !base.success && !pending) return null;
  return {
    // The pending snapshot is the latest known local input when text is damaged.
    // Using an empty string (or an older base) could overwrite its accepted save.
    text: text.success ? text.data : pending ? pending.text : base.success ? base.data.text : '',
    base: base.success ? base.data : null,
    pending,
    conflict: conflict.success ? conflict.data : null,
    blocked: record.blocked === true || conflict.success,
    ready: false,
    saving: false,
    error: '',
  };
}

// sessionStorage belongs to this tab and survives reload. The controller serializes
// saves across shared/private unmounts; cleanup never starts a second save queue.
class GroupDraft {
  view: DraftView;
  listeners = new Set<(view: DraftView) => void>();
  queue: Promise<unknown> = Promise.resolve();
  timer: ReturnType<typeof setTimeout> | undefined;
  storageKey: string;
  hadLocal: boolean;
  typed = false;
  constructor(
    readonly handle: string,
    readonly request: GroupChatClient,
  ) {
    this.storageKey = `${cacheKey(handle)}:view`;
    const stored = sessionStorage.getItem(this.storageKey);
    const legacy = localStorage.getItem(pendingKey(handle));
    const prior = storedView(stored, handle);
    const legacyPending = pendingRecord(storedJson(legacy), handle);
    const legacyText = localText.safeParse(localStorage.getItem(cacheKey(handle)));
    this.hadLocal = prior !== null || legacyPending !== null || legacyText.success;
    this.view = {
      text: prior?.text ?? (legacyText.success ? legacyText.data : ''),
      base: prior?.base ?? null,
      pending: prior ? prior.pending : legacy ? pendingRecord(storedJson(legacy), handle) : null,
      conflict: prior?.conflict ?? null,
      blocked: prior?.blocked ?? false,
      ready: false,
      saving: false,
      error: '',
    };
  }
  update(change: Partial<DraftView>) {
    this.view = { ...this.view, ...change };
    sessionStorage.setItem(this.storageKey, JSON.stringify(this.view));
    this.listeners.forEach((listener) => listener(this.view));
  }
  setText = (text: string) => {
    this.typed = true;
    this.update({ text });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush().catch(() => {}), 250);
  };
  clearPending(input: PendingDraft) {
    // Never erase a different request. Legacy keys may still be shared with an
    // older tab; new requests are kept only in this tab's sessionStorage.
    const legacy = pendingRecord(
      storedJson(localStorage.getItem(pendingKey(this.handle))),
      this.handle,
    );
    if (legacy && JSON.stringify(legacy) === JSON.stringify(input))
      localStorage.removeItem(pendingKey(this.handle));
    if (JSON.stringify(this.view.pending) === JSON.stringify(input)) this.update({ pending: null });
  }

  async saved() {
    return groupHostChatSchema.parse(await this.request('chat', { handle: this.handle })).draft;
  }
  async rejected(input: PendingDraft) {
    this.clearPending(input); // 409 is definitive; network/ack failures retain this exact key.
    this.update({
      blocked: true,
      conflict: null,
      error: 'Draft changed in another view. Your text is retained. Choose which version to keep.',
    });
    const conflict = await this.saved();
    this.update({ conflict });
  }
  async replay(input: PendingDraft) {
    try {
      const base = groupHostDraftStateSchema.parse(await this.request('draft', input));
      this.clearPending(input);
      this.update({ base });
    } catch (reason) {
      if (reason instanceof ApiError) {
        if (reason.status === 409) await this.rejected(input);
        else if (reason.status === 400 || reason.status === 413) {
          this.clearPending(input);
          // Proven validation/body rejection has no receipt. Keep all current
          // typing (including edits during the await); the next save is a new key.
          throw new Error(rejectedText);
        }
        // Authentication, 5xx and transport failures do not prove no effect.
      }
      throw reason;
    }
  }
  initialize(remote: SavedDraft) {
    if (this.view.ready) {
      if (this.view.blocked && !this.view.conflict) this.update({ conflict: remote });
      return;
    }
    if (!this.view.base && this.view.pending)
      // Preserve the recorded request's revision even if its text was invalid:
      // shortening still needs CAS if another view saved in the meantime.
      this.update({ base: { text: remote.text, revision: this.view.pending.revision } });
    if (!this.view.base && !this.view.pending) {
      // Typing before the first read is local input, not an old stored revision.
      // Retain it; an already nonempty saved draft still requires a choice.
      const keepLocal = this.hadLocal || this.typed;
      const blocked =
        keepLocal && this.view.text !== remote.text && (this.hadLocal || Boolean(remote.text));
      this.update({
        text: keepLocal ? this.view.text : remote.text,
        base: remote,
        blocked,
        conflict: blocked ? remote : null,
      });
    }
    if (!this.view.pending && this.view.base?.revision !== remote.revision) {
      if (this.view.text === remote.text) this.update({ base: remote });
      else this.update({ blocked: true, conflict: remote });
    }
    this.update({ ready: true });
    if (this.view.pending || (!this.view.blocked && this.view.text !== this.view.base?.text))
      void this.flush().catch(() => {});
  }
  flush = async () => {
    const save = async () => {
      if (!this.view.ready) this.initialize(await this.saved());
      this.update({ saving: true });
      try {
        if (this.view.pending) {
          await this.replay(this.view.pending);
          // A durable receipt may acknowledge an older revision. Read the current
          // revision before saving newer typing; do not silently rebase over a tab.
          const remote = await this.saved();
          if (remote.revision !== this.view.base?.revision) {
            if (remote.text === this.view.text) this.update({ base: remote });
            else this.update({ blocked: true, conflict: remote });
          }
        }
        if (this.view.blocked) {
          if (!this.view.conflict) this.update({ conflict: await this.saved() });
          throw new Error('Choose which draft to keep. Your text is retained in this tab.');
        }
        while (this.view.text !== this.view.base?.text) {
          const input = {
            handle: this.handle,
            key: crypto.randomUUID(),
            revision: this.view.base!.revision,
            text: this.view.text,
          };
          // Only new requests can be refused locally. An uncertain pending key
          // must replay first, even if its text would now fail these checks.
          if (
            !groupHostDraftSchema.safeParse(input).success ||
            new TextEncoder().encode(JSON.stringify(input)).byteLength > 24 * 1024
          )
            throw new Error(rejectedText);
          this.update({ pending: input });
          await this.replay(input);
          // Typing while awaiting an acknowledgement stays in this.view.text and
          // is saved separately, never replaced by the acknowledged snapshot.
        }
        this.update({ error: '' });
      } catch (reason) {
        this.update({ error: errorText(reason) });
        throw reason;
      } finally {
        this.update({ saving: false });
      }
      return null;
    };
    const next = this.queue.catch(() => {}).then(save);
    this.queue = next;
    return next;
  };
  useSavedVersion = () => {
    if (this.view.saving || this.view.pending || !this.view.conflict) return;
    const base = this.view.conflict;
    this.update({ text: base.text, base, blocked: false, conflict: null, error: '' });
  };
  keepMyVersion = () => {
    if (this.view.saving || this.view.pending || !this.view.conflict) return;
    this.update({ base: this.view.conflict, blocked: false, conflict: null, error: '' });
    void this.flush().catch(() => {}); // CAS still guards against a newer saved version.
  };
}
const draftViews = new Map<string, GroupDraft>();
function draftView(handle: string, request: GroupChatClient) {
  let value = draftViews.get(handle);
  if (!value) {
    value = new GroupDraft(handle, request);
    draftViews.set(handle, value);
  }
  return value;
}

export function GroupChat({
  slot,
  onChanged,
  request,
  nativeControlsTarget,
  onAuthorizationRequired,
}: {
  slot: GroupHostSlot;
  onChanged: () => void;
  request: GroupChatClient;
  nativeControlsTarget?: HTMLDivElement | null;
  onAuthorizationRequired?: () => void;
}) {
  const fixture = location.pathname === '/group-fixture';
  const signature = useRef('');
  const [chat, setChat] = useState<GroupHostChat | null>(null);
  const pendingAuthorization = chat?.nativeRequests?.find(
    (receipt) => receipt.state === 'pending-consent',
  )?.requestId;
  useEffect(() => {
    if (pendingAuthorization) onAuthorizationRequired?.();
  }, [pendingAuthorization, onAuthorizationRequired]);
  const model = draftView(slot.handle, request);
  const [view, setView] = useState(model.view);
  const [error, setError] = useState('');
  const [refused, setRefused] = useState(false);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [sendTarget, setSendTarget] = useState<'agent' | 'message'>('agent');
  const [agentIntent, setAgentIntent] = useState<'ask' | 'work'>('ask');
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let intent: 'ask' | 'work' = 'ask';
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(`${cacheKey(slot.handle)}:native-request`) ?? 'null',
      ) as { intent?: unknown } | null;
      if (slot.context.visibility === 'shared' && saved?.intent === 'work') intent = 'work';
    } catch {
      // A damaged browser hint cannot grant work authority.
    }
    setAgentIntent(intent);
  }, [slot.handle, slot.context.visibility]);
  useEffect(() => {
    model.listeners.add(setView);
    setView(model.view);
    return () => {
      model.listeners.delete(setView);
      clearTimeout(model.timer);
      if (
        !model.view.blocked &&
        (model.view.pending ||
          (!model.view.base && model.typed) ||
          (model.view.base && model.view.text !== model.view.base.text))
      )
        void model.flush().catch(() => {});
    };
  }, [model]);
  useEffect(() => {
    let alive = true;
    let active = false;
    const read = async () => {
      if (active) return;
      active = true;
      try {
        const value = groupHostChatSchema.parse(await request('chat', { handle: slot.handle }));
        if (!alive) return;
        const nextSignature = value.detail.entries
          .map((e) => `${e.id}:${e.status}:${e.text.length}`)
          .join(',');
        if (signature.current !== nextSignature) {
          signature.current = nextSignature;
          onChanged();
        }
        setChat(value);
        setError('');
        model.initialize(value.draft);
      } catch (reason) {
        if (alive) {
          setError(errorText(reason));
          if (reason instanceof ApiError && reason.status === 403) {
            setRefused(true);
            setChat(null);
          }
        }
      } finally {
        active = false;
      }
    };
    void read();
    const interval = setInterval(() => void read(), 1000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [slot.handle, model, onChanged]);
  useLayoutEffect(() => {
    if (!chat) return;
    const element = container.current?.querySelector('.conversation');
    if (!element) return;
    const remember = () => {
      if (element.clientHeight) positions.set(slot.handle, element.scrollTop);
    };
    const frame = requestAnimationFrame(() => {
      element.scrollTop = positions.get(slot.handle) ?? element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
      element.addEventListener('scroll', remember);
    });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('scroll', remember);
    };
  }, [Boolean(chat), slot.handle]);
  const recoverAgent = async (key: string, text: string, intent: 'ask' | 'work' = 'ask') => {
    setDeliveryBusy(true);
    try {
      const receipt = groupHostNativeReceiptSchema.parse(
        await request('request-agent', { handle: slot.handle, key, text, intent }),
      );
      setChat(groupHostChatSchema.parse(await request('chat', { handle: slot.handle })));
      onChanged();
      if (receipt.state === 'unknown' || receipt.state === 'blocked')
        throw new Error(receipt.message);
      sessionStorage.removeItem(`${cacheKey(slot.handle)}:native-request`);
      setError('');
      return receipt;
    } catch (reason) {
      setError(errorText(reason));
      throw reason;
    } finally {
      setDeliveryBusy(false);
    }
  };
  const saved = view.conflict ?? view.base;
  const draft: SharedDraft = {
    text: view.text,
    currentText: () => model.view.text,
    setText: model.setText,
    ready: view.ready,
    // Render-only adapter for the existing Composer recovery controls. These
    // identifiers never authorize a Groups request; the host-issued handle does.
    state: saved
      ? {
          hostId: slot.handle,
          clientId: slot.handle,
          agentId: slot.agent.id,
          own: {
            clientId: slot.handle,
            agentId: slot.agent.id,
            revision: saved.revision,
            text: saved.text,
            deliveryKey: null,
            submitted: false,
            updatedAt: '',
          },
          others: [],
        }
      : null,
    saving: view.saving,
    unsaved: view.text !== view.base?.text || Boolean(view.pending),
    error: view.error,
    conflict: view.blocked,
    flush: model.flush,
    retry: model.flush,
    copyDraft: async () => {
      await navigator.clipboard.writeText(model.view.text);
    },
    useSavedVersion: model.useSavedVersion,
    keepMyVersion: model.keepMyVersion,
    clearSent: async () => {},
  };
  const renderReceipt = (receipt: NonNullable<GroupHostChat['nativeRequests']>[number]) => {
    const prompt = receipt.text;
    return (
      <div className="group-chat-cue" role="status" key={receipt.requestId}>
        Agent request: {receipt.state}. {receipt.message}{' '}
        {receipt.source && (
          <span>
            Verified source {receipt.source.messageId}. Shared delivery: {receipt.delivery}.{' '}
          </span>
        )}
        {receipt.state === 'completed' && receipt.delivery === 'private' && (
          <span>Private result retained in this aside. </span>
        )}
        {receipt.documentAvailable && (
          <GroupDocumentOfferButton
            handle={slot.handle}
            requestKey={receipt.key}
            request={request}
          />
        )}
        {prompt !== undefined &&
          !refused &&
          receipt.state !== 'blocked' &&
          (receipt.state !== 'completed' ||
            !['complete', 'private'].includes(receipt.delivery)) && (
            <button
              disabled={deliveryBusy}
              onClick={() => void recoverAgent(receipt.key, prompt, receipt.intent).catch(() => {})}
            >
              Recover agent request
            </button>
          )}
      </div>
    );
  };
  const currentReceipt = chat?.nativeRequests?.find((receipt) => receipt.state !== 'completed');
  const olderReceipts = chat?.nativeRequests?.filter((receipt) => receipt !== currentReceipt) ?? [];
  const nativeOwner =
    !fixture && !refused ? (
      <GroupNativeOwner
        key={slot.handle}
        handle={slot.handle}
        requestId={pendingAuthorization}
        request={request}
        onChanged={onChanged}
      />
    ) : null;
  return (
    <div className={`group-chat ${fixture ? 'group-fixture-chat' : ''}`} ref={container}>
      {nativeControlsTarget ? createPortal(nativeOwner, nativeControlsTarget) : nativeOwner}
      {!refused && chat ? (
        <Conversation
          key={slot.context.sessionId}
          agent={chat.detail.agent}
          // This bounded view has no older-page route. The notice below
          // reports the host flag; suppress Conversation's native paging action.
          detail={{ ...chat.detail, hasMore: false }}
          approvals={[]}
          act={async (action) => {
            try {
              await action();
            } catch (reason) {
              setError(errorText(reason));
            }
          }}
        />
      ) : (
        <p role="status">Loading saved chat…</p>
      )}
      {chat?.detail.hasMore && (
        <p className="group-chat-cue" role="status">
          Older messages hidden · this view shows the latest 200 entries.
        </p>
      )}
      {error && (
        <p role="alert" className="group-chat-error">
          {error}
        </p>
      )}
      <p className={`group-chat-cue ${slot.context.visibility}`} role="status">
        {slot.context.visibility === 'private'
          ? fixture
            ? 'Private test session · saved locally; excluded from shared feed'
            : 'Private · saved on this computer; excluded from shared feed'
          : fixture
            ? 'Shared test session · messages and fake replies enter the shared feed'
            : sendTarget === 'agent'
              ? 'Shared group agent · native setup and admission apply'
              : 'Human message · shared with this group'}
        {view.blocked && <strong> · Draft conflict: choose a version below.</strong>}
        {view.error === rejectedText && <strong> · Shorten or correct draft to save/send.</strong>}
      </p>
      {!fixture &&
        chat?.deliveries
          ?.filter((d) => !['complete', 'private'].includes(d.state))
          .map((d) => (
            <p className="group-chat-cue" role="status" key={d.key}>
              {sharedDeliveryMessage(d.state)}{' '}
              <button
                disabled={deliveryBusy}
                onClick={async () => {
                  setDeliveryBusy(true);
                  try {
                    await request('status', { handle: slot.handle, key: d.key, retry: true });
                    setChat(
                      groupHostChatSchema.parse(await request('chat', { handle: slot.handle })),
                    );
                    onChanged();
                  } catch (reason) {
                    setError(errorText(reason));
                  } finally {
                    setDeliveryBusy(false);
                  }
                }}
              >
                Retry delivery
              </button>
            </p>
          ))}
      {!fixture && currentReceipt && renderReceipt(currentReceipt)}
      {!fixture && olderReceipts.length > 0 && (
        <details className="group-native-receipts">
          <summary>Saved agent requests ({olderReceipts.length})</summary>
          {olderReceipts.map(renderReceipt)}
        </details>
      )}
      {!fixture && !refused && (
        <div className="group-agent-request">
          <label>
            Send to
            <select
              value={sendTarget}
              disabled={deliveryBusy}
              onChange={(event) =>
                setSendTarget(event.target.value === 'message' ? 'message' : 'agent')
              }
            >
              <option value="agent">Group agent</option>
              <option value="message">
                {slot.context.visibility === 'private' ? 'Private note' : 'Human group message'}
              </option>
            </select>
          </label>
          {sendTarget === 'agent' && slot.context.visibility === 'shared' && (
            <label>
              Agent request
              <select
                value={agentIntent}
                disabled={deliveryBusy}
                onChange={(event) => setAgentIntent(event.target.value === 'work' ? 'work' : 'ask')}
              >
                <option value="ask">Ask</option>
                <option value="work">Work</option>
              </select>
            </label>
          )}
        </div>
      )}
      <Composer
        key={slot.context.sessionId}
        agent={chat?.detail.agent ?? slot.agent}
        workspace={null}
        disabled={!view.ready || refused}
        draftOverride={draft}
        specialized={!fixture}
        attachments={fixture}
        preserveWhitespace={!fixture}
        send={async (value, key, steer) => {
          if (steer) throw new Error('Use a separate saved group agent request.');
          if (fixture) {
            await request('send', { handle: slot.handle, key, text: value });
            setChat(groupHostChatSchema.parse(await request('chat', { handle: slot.handle })));
          } else {
            // Composer owns the durable UUID and draft clearing. Pin only its dispatch
            // choice so changing the selector cannot redirect a saved retry.
            const storage = `${cacheKey(slot.handle)}:composer-request:${key}`;
            const saved = JSON.parse(sessionStorage.getItem(storage) ?? 'null') as {
              key: string;
              text: string;
              target: 'agent' | 'message';
              intent: 'ask' | 'work';
            } | null;
            if (
              saved &&
              (saved.key !== key ||
                saved.text !== value ||
                !['agent', 'message'].includes(saved.target) ||
                !['ask', 'work'].includes(saved.intent) ||
                (slot.context.visibility === 'private' && saved.intent !== 'ask'))
            )
              throw new Error('Saved request metadata is invalid. Your draft is retained.');
            const input = saved ?? {
              key,
              text: value,
              target: sendTarget,
              intent: slot.context.visibility === 'shared' ? agentIntent : 'ask',
            };
            sessionStorage.setItem(storage, JSON.stringify(input));
            if (input.target === 'agent') {
              sessionStorage.setItem(
                `${cacheKey(slot.handle)}:native-request`,
                JSON.stringify({ key, text: value, intent: input.intent }),
              );
              await recoverAgent(key, value, input.intent);
            } else {
              await request('send', { handle: slot.handle, key, text: value });
              setChat(groupHostChatSchema.parse(await request('chat', { handle: slot.handle })));
            }
            sessionStorage.removeItem(storage);
          }
          setError('');
        }}
        onError={setError}
        onCommand={() => setError('Native commands require the verified Groups execution adapter.')}
        onStop={() => setError('No native turn is running in this message context.')}
        onHelp={() =>
          setError(
            'Human messages are saved separately from native execution. Your private aside is never published.',
          )
        }
        messagePlaceholder={
          slot.context.visibility === 'private'
            ? fixture
              ? 'Message private test session…'
              : sendTarget === 'agent'
                ? 'Ask privately…'
                : 'Write a private note…'
            : fixture
              ? 'Message shared test session…'
              : sendTarget === 'agent'
                ? 'Message your group agent…'
                : 'Send a group message…'
        }
      />
    </div>
  );
}
