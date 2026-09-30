import { randomUUID } from 'node:crypto';
import { codexTranscript as transcript } from '@dock/shared';
export { codexTranscript as transcript } from '@dock/shared';
import type { MirrorState, MirrorSend, MirrorResult, MirrorControl } from '@dock/shared';

type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
class NativeRequestRejected extends Error {}
export interface Provider {
  onInitialized?: () => void;
  onResult?: (response: ObjectValue) => void;
  onNotification?: (notification: { method: string; params: unknown }) => void;
  onFatalError?: () => void;
  onRequestDelivery?: (event: unknown) => void;
}
export interface Connection {
  providers: Map<string, Provider>;
  initialized: boolean;
  registerProvider(name: string, provider: Provider): { dispose(): void };
  sendRequest(
    provider: string,
    id: string,
    method: string,
    params: unknown,
    delivery?: boolean,
  ): void;
  sendProviderRequest(
    provider: string,
    id: string,
    method: string,
    params: unknown,
    prewarm: boolean,
    delivery: boolean,
  ): void;
}
export function isCodexConnection(value: unknown): value is Connection {
  const connection = object(value);
  return (
    connection.providers instanceof Map &&
    typeof connection.initialized === 'boolean' &&
    ['registerProvider', 'sendRequest', 'sendProviderRequest'].every(
      (name) => typeof connection[name] === 'function',
    )
  );
}
/** One owner-selected existing thread. No resume, fork, config override or approvals. */
export class MirrorConnection {
  readonly windowId = randomUUID();
  private readonly providerName = `AgentDockMirror-${randomUUID()}`;
  private readonly pending = new Map<
    string,
    { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }
  >();
  private readonly subscription: { dispose(): void };
  private readonly originalSend: Connection['sendProviderRequest'];
  private readonly wrappedSend: Connection['sendProviderRequest'];
  private threadId: string | null = null;
  private activeTurn: string | null = null;
  private stoppedTurn: string | null = null;
  private busy = false;
  private uncertain = false;
  private disconnected = false;
  private pendingStartUntil = 0;
  private activityEpoch = 0;
  private lastRead = 0;
  private dirty = true;
  private reading: Promise<MirrorState> | undefined;
  private state: MirrorState;
  private readonly live = new Map<string, MirrorState['entries'][number]>();
  constructor(
    private readonly connection: Connection,
    label: string,
  ) {
    this.state = {
      windowId: this.windowId,
      label: label.slice(0, 200),
      threadId: null,
      title: 'Choose a conversation in VS Code',
      status: 'offline',
      message: 'Use sciencewithagents Mirror: Share a Conversation in VS Code.',
      entries: [],
      canSteer: true,
    };
    this.subscription = connection.registerProvider(this.providerName, {
      onInitialized: () => {
        this.disconnected = false;
        this.dirty = true;
      },
      onResult: (response) => {
        const id = str(response.id);
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(request.timer);
        if (response.error)
          request.reject(
            new NativeRequestRejected(
              str(object(response.error).message) || 'Codex rejected the request.',
            ),
          );
        else request.resolve(response.result);
      },
      onNotification: (event) => {
        const p = object(event.params);
        const id = str(p.threadId) || str(object(p.thread).id);
        if (id !== this.threadId) return;
        this.dirty = true;
        const turnId = str(p.turnId);
        const itemId = str(p.itemId);
        if (
          (event.method === 'item/started' || event.method === 'item/completed') &&
          turnId &&
          p.item
        ) {
          const entry = transcript({ turns: [{ id: turnId, items: [p.item] }] })[0];
          if (entry) this.live.set(entry.id, entry);
        }
        if (event.method === 'item/agentMessage/delta' && turnId && itemId) {
          const key = `${turnId}:${itemId}`;
          const entry = this.live.get(key) ?? { id: key, role: 'assistant' as const, text: '' };
          // Long/unrecognized streams fall back to the next full provider read.
          if (entry.text.length + str(p.delta).length <= 8 * 1024 * 1024)
            this.live.set(key, { ...entry, text: entry.text + str(p.delta) });
        }
        if (event.method === 'turn/started') {
          this.activeTurn = str(object(p.turn).id) || turnId || null;
          this.activityEpoch++;
          this.busy = true;
          this.pendingStartUntil = 0;
        }
        if (event.method === 'turn/completed') {
          const completedTurn = str(object(p.turn).id) || turnId;
          if (completedTurn && this.activeTurn && completedTurn !== this.activeTurn) return;
          this.activeTurn = null;
          this.activityEpoch++;
          this.busy = false;
          this.pendingStartUntil = 0;
          this.uncertain = false;
        }
        if (event.method === 'thread/status/changed') {
          this.activityEpoch++;
          this.busy = object(p.status).type === 'active';
        }
      },
      onFatalError: () => {
        this.disconnected = true;
        this.dirty = true;
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('Codex disconnected. Check VS Code before sending again.'));
        }
        this.pending.clear();
      },
      onRequestDelivery: () => {
        /* A timeout is uncertain, never an automatic retry. */
      },
    });
    this.originalSend = connection.sendProviderRequest;
    const self = this;
    this.wrappedSend = function (provider, id, method, params, prewarm, delivery) {
      const p = object(params);
      if (self.threadId && p.threadId === self.threadId && method === 'turn/start') {
        // Covers a desktop/phone race at the single native write boundary. Existing
        // desktop turn/steer semantics stay native; mirror steering uses an exact turn precondition.
        if (self.pendingStartUntil > Date.now()) {
          connection.providers.get(provider)?.onResult?.({
            id,
            error: {
              code: -32000,
              message:
                'A message is being submitted from another view. Your draft was not sent; wait for Codex to finish.',
            },
          });
          return;
        }
        self.pendingStartUntil = Date.now() + 30_000;
        self.activityEpoch++;
        self.dirty = true;
      }
      return self.originalSend.call(connection, provider, id, method, params, prewarm, delivery);
    };
    connection.sendProviderRequest = this.wrappedSend;
  }
  get summary() {
    const { entries: _, ...summary } = this.state;
    return summary;
  }
  private snapshot(): MirrorState {
    const state = {
      ...this.state,
      stopToken:
        this.state.status !== 'offline' &&
        this.busy &&
        this.activeTurn &&
        this.activeTurn !== this.stoppedTurn
          ? this.activeTurn
          : undefined,
      steerToken:
        this.state.status === 'busy' &&
        this.busy &&
        !this.uncertain &&
        this.pendingStartUntil <= Date.now() &&
        this.activeTurn &&
        this.activeTurn !== this.stoppedTurn
          ? this.activeTurn
          : undefined,
    };
    if (!this.live.size) return state;
    const entries = new Map(this.state.entries.map((entry) => [entry.id, entry]));
    for (const [id, entry] of this.live) entries.set(id, entry);
    return { ...state, entries: [...entries.values()] };
  }
  private request(method: string, params: unknown): Promise<unknown> {
    if (this.disconnected || !this.connection.initialized)
      return Promise.reject(new Error('Open Codex in VS Code and wait for it to connect.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            'Codex did not confirm the request. Check the conversation before trying again.',
          ),
        );
      }, 12_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.connection.sendRequest(this.providerName, id, method, params, true);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  async choices(): Promise<{ id: string; label: string }[]> {
    const loaded = object(await this.request('thread/loaded/list', {}));
    const ids = array(loaded.data).filter((x) => typeof x === 'string') as string[];
    const choices: { id: string; label: string }[] = [];
    for (const id of ids.slice(0, 100)) {
      try {
        const thread = object(
          object(await this.request('thread/read', { threadId: id, includeTurns: false })).thread,
        );
        if (thread.ephemeral !== true)
          choices.push({
            id,
            label: (str(thread.name) || str(thread.preview) || id).slice(0, 160),
          });
      } catch {
        /* Empty prewarmed threads have no retained history yet. */
      }
    }
    return choices;
  }
  async select(threadId: string | null): Promise<void> {
    this.threadId = threadId;
    this.activeTurn = null;
    this.stoppedTurn = null;
    this.busy = false;
    this.uncertain = false;
    this.pendingStartUntil = 0;
    this.activityEpoch++;
    this.live.clear();
    this.dirty = true;
    this.state = {
      ...this.state,
      threadId,
      entries: [],
      status: 'offline',
      title: threadId ? 'Loading conversation…' : 'Sharing stopped',
      message: threadId ? '' : 'Choose a conversation in VS Code to share it.',
    };
    if (threadId) await this.read(true);
  }
  async read(force = false): Promise<MirrorState> {
    if (!this.threadId) return this.state;
    if (this.reading) return this.reading;
    if (!force && Date.now() - this.lastRead < 800) return this.snapshot();
    if (!force && !this.dirty && Date.now() - this.lastRead < 5000) return this.snapshot();
    const threadId = this.threadId;
    const epoch = this.activityEpoch;
    const reading = (async () => {
      this.dirty = false;
      try {
        const thread = object(
          object(await this.request('thread/read', { threadId, includeTurns: true })).thread,
        );
        if (this.threadId !== threadId) return this.state;
        if (thread.id !== threadId || !Array.isArray(thread.turns))
          throw new Error(
            'Codex did not return the complete saved transcript. Use VS Code; no partial history is presented as complete.',
          );
        const status = object(thread.status);
        // A read response may describe the instant before a desktop send. Never
        // overwrite newer native activity with that stale idle snapshot.
        if (epoch === this.activityEpoch) {
          this.busy =
            status.type === 'active' ||
            array(thread.turns).some((t) => object(t).status === 'inProgress');
          const active = array(thread.turns).filter((t) => object(t).status === 'inProgress');
          this.activeTurn = active.length === 1 ? str(object(active[0]).id) || null : null;
        }
        const attention = array(status.activeFlags).some(
          (x) => x === 'waitingOnApproval' || x === 'waitingOnUserInput',
        );
        if (!this.busy && epoch === this.activityEpoch) this.live.clear();
        this.state = {
          ...this.state,
          title: (str(thread.name) || str(thread.preview) || threadId).slice(0, 500),
          entries: transcript(thread),
          status:
            attention || this.uncertain
              ? 'attention'
              : this.busy || this.pendingStartUntil > Date.now()
                ? 'busy'
                : status.type !== 'idle'
                  ? 'offline'
                  : 'idle',
          message: this.uncertain
            ? 'Submission was not confirmed. Inspect VS Code before sending anything else.'
            : attention
              ? 'Codex needs your attention in VS Code. Approvals stay on the computer.'
              : status.type !== 'idle' && status.type !== 'active'
                ? 'Open this conversation in Codex on the computer.'
                : 'Same conversation as VS Code. Drafts stay separate.',
        };
        this.lastRead = Date.now();
      } catch (error) {
        this.dirty = true;
        this.state = {
          ...this.state,
          status: 'offline',
          message:
            error instanceof Error
              ? error.message.slice(0, 1000)
              : 'Open Codex in VS Code to reconnect.',
        };
      }
      return this.snapshot();
    })();
    this.reading = reading;
    try {
      return await reading;
    } finally {
      if (this.reading === reading) this.reading = undefined;
    }
  }
  async send(input: MirrorSend): Promise<MirrorResult> {
    if (input.mode === 'queue')
      return {
        state: 'not_sent',
        message:
          'This Codex connection supports steering, not queued follow-ups. Nothing was sent.',
      };
    if ((input.provider && input.provider !== 'codex') || input.threadId !== this.threadId)
      return { state: 'not_sent', message: 'The shared conversation changed. Nothing was sent.' };
    const current = await this.read(true);
    if (input.expectedTurnId) {
      if (
        input.threadId !== this.threadId ||
        current.status !== 'busy' ||
        this.snapshot().steerToken !== input.expectedTurnId
      )
        return {
          state: 'not_sent',
          message:
            'That reply is no longer available for steering. Nothing was sent; refresh the conversation and keep your draft.',
        };
      try {
        const result = object(
          await this.request('turn/steer', {
            threadId: input.threadId,
            expectedTurnId: input.expectedTurnId,
            input: [{ type: 'text', text: input.text, text_elements: [] }],
          }),
        );
        if (result.turnId !== input.expectedTurnId)
          throw new Error('The steering acknowledgement did not identify the expected turn.');
        this.dirty = true;
        return { state: 'sent', message: 'Sent guidance to the active Codex reply.' };
      } catch (error) {
        this.dirty = true;
        if (error instanceof NativeRequestRejected)
          return {
            state: 'not_sent',
            message:
              'Codex did not accept guidance for that reply. Nothing was resent; refresh the conversation and keep your draft.',
          };
        this.uncertain = true;
        return {
          state: 'uncertain',
          message:
            'Codex did not confirm steering. Check VS Code; this message will not be resent automatically.',
        };
      }
    }
    if (
      input.threadId !== this.threadId ||
      current.status !== 'idle' ||
      this.busy ||
      this.uncertain ||
      this.pendingStartUntil > Date.now()
    )
      return {
        state: 'not_sent',
        message: 'Nothing was sent. Wait for Codex to finish or resolve its request in VS Code.',
      };
    try {
      // Omitted model, permissions, MCP and other settings inherit the loaded thread.
      await this.request('turn/start', {
        threadId: input.threadId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
      });
      this.busy = true;
      this.dirty = true;
      return { state: 'sent', message: 'Sent to the existing Codex conversation.' };
    } catch {
      this.uncertain = true;
      this.dirty = true;
      return {
        state: 'uncertain',
        message:
          'Codex did not confirm delivery. Check VS Code; this message will not be resent automatically.',
      };
    }
  }
  async control(input: MirrorControl): Promise<MirrorResult> {
    if ((input.provider ?? 'codex') !== 'codex' || input.threadId !== this.threadId)
      return {
        state: 'not_sent',
        message: 'The shared conversation changed. Nothing was stopped.',
      };
    await this.read(true);
    if (input.threadId !== this.threadId || this.snapshot().stopToken !== input.token)
      return {
        state: 'not_sent',
        message: 'That reply is no longer active. Nothing else was stopped.',
      };
    try {
      this.stoppedTurn = input.token;
      await this.request('turn/interrupt', { threadId: input.threadId, turnId: input.token });
      this.dirty = true;
      return {
        state: 'sent',
        message: 'Stop requested for this reply. Completed actions are not undone.',
      };
    } catch {
      return {
        state: 'uncertain',
        message:
          'Stop was not confirmed. Check the conversation; this request will not be repeated automatically.',
      };
    }
  }
  dispose() {
    this.disconnected = true;
    this.threadId = null;
    this.activeTurn = null;
    if (this.connection.sendProviderRequest === this.wrappedSend)
      this.connection.sendProviderRequest = this.originalSend;
    this.subscription.dispose();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Sharing stopped.'));
    }
    this.pending.clear();
  }
}
