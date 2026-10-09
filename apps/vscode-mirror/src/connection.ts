import { randomUUID, createHash } from 'node:crypto';
import {
  codexTranscript,
  codexQueue,
  codexQueueUnsupported,
  isBackgroundCodexThread,
  latestConversationActivity,
  mirrorNativeRequestsViewSchema,
  type MirrorNativeRequestsView,
  type MirrorQuestionAnswer,
} from '@dock/shared';
import { NativeRequests } from './native-requests.js';
import type { MirrorState, MirrorSend, MirrorResult, MirrorControl } from '@dock/shared';
import {
  nativeGoalSchema,
  nativeGoalVersion,
  nativeGoalActionProblem,
  nativeGoalParams,
  type NativeGoalView,
  type NativeGoalAction,
} from '@dock/shared';

type ObjectValue = Record<string, unknown>;
// Native callbacks share VS Code's extension event loop. Bound tool display work
// before serialization; retained provider history and message text stay native.
export const transcript = (thread: ObjectValue): MirrorState['entries'] =>
  codexTranscript(thread, 'VS Code', { characters: 256 * 1024, values: 4096, depth: 64 });
export const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
class NativeRequestRejected extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}
/** This Codex build cannot page complete turns; use its full-history read instead. */
class PagingUnavailable extends Error {}
const incompleteHistory =
  'Codex did not return the complete saved transcript. Use VS Code; no partial history is presented as complete.';
// Re-read only the newest turns while a long conversation changes.
const tailTurns = 3;
const turnPage = 20;
const maxTurnPages = 5000;
export interface Provider {
  onRequest?: (request: unknown) => void;
  onInitialized?: () => void;
  onResult?: (response: ObjectValue) => void;
  onNotification?: (notification: { method: string; params: unknown }) => void;
  onFatalError?: () => void;
  onRequestDelivery?: (event: unknown) => void;
}
export interface Connection {
  sendResponse?(id: string | number, result: unknown): void;
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
/** One owner-selected existing thread. No resume, fork or config override; native approvals remain in the editor. */
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
  // Complete turns for the shared thread, oldest first, kept between native page reads.
  private history: { threadId: string; turns: ObjectValue[] } | undefined;
  private pagingUnavailable = false;
  private readonly turnEntries = new WeakMap<ObjectValue, MirrorState['entries']>();
  private state: MirrorState;
  private readonly live = new Map<string, MirrorState['entries'][number]>();
  private goalChanging = false;
  private readonly native: NativeRequests;
  constructor(
    private readonly connection: Connection,
    label: string,
  ) {
    this.native = new NativeRequests(connection);
    this.state = {
      windowId: this.windowId,
      label: label.slice(0, 200),
      threadId: null,
      title: 'Choose a conversation in VS Code',
      status: 'offline',
      message: 'Use sciencewithagents Mirror: Share a Conversation in VS Code.',
      entries: [],
      canSteer: true,
      canManageGoal: true,
      canReadNativeRequests: true,
    };
    this.subscription = connection.registerProvider(this.providerName, {
      onInitialized: () => {
        this.native.initialized();
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
              typeof object(response.error).code === 'number'
                ? (object(response.error).code as number)
                : undefined,
            ),
          );
        else request.resolve(response.result);
      },
      onNotification: (event) => {
        this.native.notification(event.method, event.params);
        const p = object(event.params);
        const id = str(p.threadId) || str(object(p.thread).id);
        if (id !== this.threadId) return;
        if (event.method === 'serverRequest/resolved') this.activityEpoch++;
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
        this.native.fatal();
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
      onRequest: (event) => {
        this.native.observe(event);
        if (object(object(event).params).threadId === this.threadId) this.activityEpoch++;
        this.dirty = true;
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
    const {
      entries: _,
      queuedMessages: _queue,
      queueHasMore: _more,
      queueReadError: _queueError,
      nativeRequests: _native,
      ...summary
    } = this.snapshot();
    return summary;
  }
  private snapshot(): MirrorState {
    const state = {
      ...this.state,
      ...this.native.snapshot(),
      ...(!this.native.connected
        ? {
            status: 'offline' as const,
            message: 'Codex is disconnected. Last observed native requests are unconfirmed.',
          }
        : {}),
      ...(this.native.attention && this.native.connected
        ? {
            status: 'attention' as const,
            message:
              'Codex has a pending native request. Read it here or use the original editor; transcript updates may wait.',
          }
        : {}),
      stopToken:
        this.native.connected &&
        this.state.status !== 'offline' &&
        this.busy &&
        this.activeTurn &&
        this.activeTurn !== this.stoppedTurn
          ? this.activeTurn
          : undefined,
      steerToken:
        this.native.connected &&
        !this.native.attention &&
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
        if (!isBackgroundCodexThread(thread))
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
    this.native.select(threadId);
    this.threadId = threadId;
    this.activeTurn = null;
    this.stoppedTurn = null;
    this.busy = false;
    this.uncertain = false;
    this.pendingStartUntil = 0;
    this.activityEpoch++;
    this.live.clear();
    this.history = undefined;
    this.pagingUnavailable = false;
    this.dirty = true;
    this.state = {
      ...this.state,
      threadId,
      lastActivityAt: undefined,
      entries: [],
      queuedMessages: undefined,
      queueReadError: undefined,
      canQueue: false,
      status: 'offline',
      title: threadId ? 'Loading conversation…' : 'Sharing stopped',
      message: threadId ? '' : 'Choose a conversation in VS Code to share it.',
    };
    if (threadId) await this.read(true);
  }
  async read(force = false): Promise<MirrorState> {
    if (!this.threadId) return this.state;
    // Prompt observation stays available while a separate transcript read is in flight.
    if (this.native.pending) return { ...this.snapshot(), historyUnavailable: true };
    if (this.reading) return this.reading;
    if (!force && Date.now() - this.lastRead < 800) return this.snapshot();
    if (!force && !this.dirty && Date.now() - this.lastRead < 5000) return this.snapshot();
    const threadId = this.threadId;
    const epoch = this.activityEpoch;
    const reading = (async () => {
      this.dirty = false;
      try {
        const { thread, entries } = await this.thread(threadId);
        if (this.threadId !== threadId) return this.state;
        let queue: Pick<MirrorState, 'queuedMessages' | 'queueHasMore'> = {};
        let canQueue = false;
        let queueReadError: MirrorState['queueReadError'];
        try {
          queue = codexQueue(await this.request('thread/queue/list', { threadId, limit: 100 }));
          canQueue = true;
        } catch (error) {
          queueReadError =
            error instanceof NativeRequestRejected && codexQueueUnsupported(error)
              ? 'unsupported'
              : 'unavailable';
        }
        if (this.threadId !== threadId) return this.state;
        const status = object(thread.status);
        if (epoch === this.activityEpoch)
          this.native.notification('thread/status/changed', { threadId, status });
        // A read response may describe the instant before a desktop send. Never
        // overwrite newer native activity with that stale idle snapshot.
        if (epoch === this.activityEpoch) {
          this.busy =
            status.type === 'active' || thread.turns.some((t) => t.status === 'inProgress');
          const active = thread.turns.filter((t) => t.status === 'inProgress');
          this.activeTurn = active.length === 1 ? str(object(active[0]).id) || null : null;
        }
        const attention =
          epoch === this.activityEpoch
            ? array(status.activeFlags).some(
                (x) => x === 'waitingOnApproval' || x === 'waitingOnUserInput',
              )
            : this.native.attention;
        if (!this.busy && epoch === this.activityEpoch) this.live.clear();
        this.state = {
          ...this.state,
          title: (str(thread.name) || str(thread.preview) || threadId).slice(0, 500),
          lastActivityAt: latestConversationActivity([thread.updatedAt, thread.createdAt]),
          entries,
          queuedMessages: undefined,
          queueHasMore: undefined,
          ...queue,
          canQueue,
          queueReadError,
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
  questions(): MirrorNativeRequestsView {
    const state = this.snapshot();
    return mirrorNativeRequestsViewSchema.parse({
      windowId: this.windowId,
      provider: 'codex',
      threadId: this.threadId,
      status: this.native.connected ? state.status : 'offline',
      message: this.native.connected
        ? state.message
        : 'Codex is disconnected; last observed native requests are unconfirmed.',
      ...this.native.snapshot(),
    });
  }
  questionAnswer(input: MirrorQuestionAnswer): MirrorResult {
    if (this.activeTurn && input.turnId !== this.activeTurn)
      return { state: 'not_sent', message: 'The native turn changed. Nothing was answered.' };
    return this.native.answer(input);
  }
  /**
   * Metadata plus complete turns. Supported Codex builds page turns natively and only
   * the newest few are re-read per change; others use their full-history read.
   */
  private async thread(
    threadId: string,
  ): Promise<{ thread: ObjectValue & { turns: ObjectValue[] }; entries: MirrorState['entries'] }> {
    if (!this.pagingUnavailable) {
      const thread = object(
        object(await this.request('thread/read', { threadId, includeTurns: false })).thread,
      );
      this.checkThread(thread, threadId);
      try {
        const turns = await this.pagedTurns(threadId);
        if (this.threadId === threadId) this.history = { threadId, turns };
        return {
          thread: { ...thread, turns },
          entries: turns.flatMap((turn) => {
            let entries = this.turnEntries.get(turn);
            if (!entries) this.turnEntries.set(turn, (entries = transcript({ turns: [turn] })));
            return entries;
          }),
        };
      } catch (error) {
        if (!(error instanceof NativeRequestRejected || error instanceof PagingUnavailable))
          throw error;
        // Explicit capability fallback for this shared thread; no version is assumed.
        this.pagingUnavailable = true;
        this.history = undefined;
      }
    }
    const thread = object(
      object(await this.request('thread/read', { threadId, includeTurns: true })).thread,
    );
    this.checkThread(thread, threadId);
    if (!Array.isArray(thread.turns)) throw new Error(incompleteHistory);
    return { thread: { ...thread, turns: thread.turns.map(object) }, entries: transcript(thread) };
  }
  private checkThread(thread: ObjectValue, threadId: string) {
    // Native metadata can change after the picker ran. Provenance must also
    // win at the read/write boundary, including a restored shared selection.
    if (this.threadId === threadId && isBackgroundCodexThread(thread)) {
      void this.select(null);
      throw new Error(
        'This is a background helper. Choose a personal conversation in VS Code to share it.',
      );
    }
    if (thread.id !== threadId) throw new Error(incompleteHistory);
  }
  private async turnPage(threadId: string, limit: number, cursor: string | null) {
    const page = object(
      await this.request('thread/turns/list', {
        threadId,
        limit,
        sortDirection: 'desc',
        itemsView: 'full',
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (!Array.isArray(page.data)) throw new PagingUnavailable();
    const turns = page.data.map(object);
    // A summary or unloaded turn is never presented as the complete saved transcript.
    if (
      turns.some(
        (turn) =>
          !str(turn.id) ||
          !Array.isArray(turn.items) ||
          (turn.itemsView !== undefined && turn.itemsView !== 'full'),
      )
    )
      throw new PagingUnavailable();
    return { turns: turns.reverse(), next: str(page.nextCursor) || null };
  }
  private async pagedTurns(threadId: string): Promise<ObjectValue[]> {
    const cached = this.history?.threadId === threadId ? this.history.turns : undefined;
    if (cached?.length) {
      const latest = await this.turnPage(threadId, tailTurns, null);
      if (!latest.next) return latest.turns;
      // Completed turns do not change; replace from the oldest re-read turn onward.
      const at = cached.findIndex((turn) => turn.id === latest.turns[0]?.id);
      if (at >= 0) return [...cached.slice(0, at), ...latest.turns];
      // More turns arrived than the tail covers: page the whole history again.
    }
    const pages: ObjectValue[][] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= maxTurnPages) throw new PagingUnavailable();
      const result = await this.turnPage(threadId, turnPage, cursor);
      pages.unshift(result.turns);
      if (!result.next) return pages.flat();
      // A repeated or empty-page cursor would loop; fall back once instead.
      if (seen.has(result.next) || !result.turns.length) throw new PagingUnavailable();
      seen.add(result.next);
      cursor = result.next;
    }
  }
  async send(input: MirrorSend): Promise<MirrorResult> {
    if ((input.provider && input.provider !== 'codex') || input.threadId !== this.threadId)
      return { state: 'not_sent', message: 'The shared conversation changed. Nothing was sent.' };
    const current = await this.read(true);
    if (input.mode === 'queue') {
      if (!current.canQueue || !['idle', 'busy'].includes(current.status))
        return {
          state: 'not_sent',
          message: 'Native queue is unavailable. Keep your draft and refresh.',
        };
      try {
        const result = object(
          await this.request('thread/queue/add', {
            threadId: input.threadId,
            clientUserMessageId: input.key,
            input: [{ type: 'text', text: input.text, text_elements: [] }],
          }),
        );
        if (
          object(result.queuedSubmission).clientUserMessageId !== input.key ||
          !str(object(result.queuedSubmission).id)
        )
          throw new Error('Native queue acknowledgement did not identify this message.');
        this.dirty = true;
        return { state: 'sent', message: 'Accepted into the native Codex queue.' };
      } catch (error) {
        this.dirty = true;
        if (error instanceof NativeRequestRejected)
          return {
            state: 'not_sent',
            message: 'Codex rejected the queued message. Keep your draft.',
          };
        this.uncertain = true;
        return {
          state: 'uncertain',
          message:
            'Queue delivery was not confirmed. Inspect Codex; this message will not be resent automatically.',
        };
      }
    }
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
  /** Small native metadata reads, independent of transcript paging or a model turn. */
  async goal(): Promise<NativeGoalView> {
    const threadId = this.threadId;
    const unavailable = (message: string): NativeGoalView => ({
      threadId,
      supported: false,
      goal: null,
      token: null,
      message,
    });
    if (!threadId) return unavailable('Share a conversation to use its native goal.');
    try {
      const thread = object(
        object(await this.request('thread/read', { threadId, includeTurns: false })).thread,
      );
      this.checkThread(thread, threadId);
      const response = object(await this.request('thread/goal/get', { threadId }));
      if (!Object.hasOwn(response, 'goal'))
        return unavailable(
          'This native Codex connection does not expose goals. Messages remain available here.',
        );
      const goal = response.goal === null ? null : nativeGoalSchema.parse(response.goal);
      if (this.threadId !== threadId || (goal && goal.threadId !== threadId))
        return unavailable(
          'The shared conversation changed. Refresh before choosing a goal action.',
        );
      return {
        threadId,
        supported: true,
        goal,
        token: goal ? createHash('sha256').update(nativeGoalVersion(goal)).digest('hex') : null,
        message: '',
      };
    } catch (error) {
      return unavailable(
        error instanceof NativeRequestRejected && error.code === -32601
          ? 'This native Codex connection does not expose goals. Messages remain available here.'
          : 'Native goal status is unavailable. Refresh its status; your conversation is unchanged.',
      );
    }
  }
  async goalAction(input: NativeGoalAction): Promise<MirrorResult> {
    if (
      this.goalChanging ||
      (input.provider ?? 'codex') !== 'codex' ||
      input.threadId !== this.threadId
    )
      return {
        state: 'not_sent',
        message:
          'The shared conversation changed or a goal action is pending. Nothing was changed.',
      };
    this.goalChanging = true;
    try {
      const current = await this.goal();
      const problem = nativeGoalActionProblem(input, current);
      if (problem || this.threadId !== input.threadId)
        return {
          state: 'not_sent',
          message: problem ?? 'The shared conversation changed. Nothing was changed.',
        };
      try {
        if (input.action === 'clear') {
          await this.request('thread/goal/clear', { threadId: input.threadId });
          this.dirty = true;
          return {
            state: 'sent',
            message: 'Native goal cleared. This conversation and its files are retained.',
          };
        }
        const response = object(await this.request('thread/goal/set', nativeGoalParams(input)));
        const goal = nativeGoalSchema.parse(response.goal);
        if (
          goal.threadId !== input.threadId ||
          goal.status !== (input.action === 'pause' ? 'paused' : 'active') ||
          (input.action === 'create'
            ? goal.objective !== input.objective
            : goal.objective !== current.goal?.objective ||
              goal.createdAt !== current.goal?.createdAt ||
              goal.tokenBudget !== current.goal?.tokenBudget)
        )
          throw new Error('Native goal acknowledgement did not match this action.');
        this.dirty = true;
        return {
          state: 'sent',
          message:
            input.action === 'pause'
              ? 'Native goal paused. Work already underway may finish at its safe boundary.'
              : input.action === 'resume'
                ? 'The existing native goal was resumed.'
                : 'Native goal created in this conversation.',
        };
      } catch (error) {
        return error instanceof NativeRequestRejected
          ? { state: 'not_sent', message: error.message.slice(0, 1000) }
          : {
              state: 'uncertain',
              message:
                'Codex did not confirm the goal action. Inspect its current status; this action will not be repeated automatically.',
            };
      }
    } finally {
      this.goalChanging = false;
    }
  }
  dispose() {
    this.native.dispose();
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
