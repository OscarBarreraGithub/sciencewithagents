import { randomUUID } from 'node:crypto';
import {
  mirrorNativeQuestionSchema,
  mirrorNativeRequestIdSchema,
  mirrorQuestionAnswerSchema,
  type MirrorNativeRequest,
  type MirrorQuestionAnswer,
  type MirrorResult,
  type MirrorState,
} from '@dock/shared';

type NativeId = MirrorNativeRequest['requestId'];
type NativeConnection = {
  initialized: boolean;
  sendResponse?(id: NativeId, result: unknown): void;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const key = (id: NativeId) => `${typeof id}:${id}`;
const boundedId = (value: unknown, maximum = 128) => {
  const id = text(value);
  return id && id.length <= maximum ? id : null;
};
type Observed = { request: MirrorNativeRequest; fingerprint: string; recycled: boolean };
const approvalMethods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
  'execCommandApproval',
  'applyPatchApproval',
]);

/** Observe the existing dispatcher. No request lookup, new RPC or automatic response. */
export class NativeRequests {
  private threadId: string | null = null;
  private disconnected = false;
  private waiting = false;
  private gap = false;
  private untracked = false;
  private readonly requests = new Map<string, Observed>();
  private readonly omitted = new Map<string, string | null>();
  private readonly seen = new Set<string>();
  private readonly recentResponses = new Set<string>();
  private readonly originalResponse: NativeConnection['sendResponse'];
  private readonly wrappedResponse: NativeConnection['sendResponse'];
  constructor(private readonly connection: NativeConnection) {
    this.originalResponse =
      typeof connection.sendResponse === 'function' ? connection.sendResponse : undefined;
    if (this.originalResponse) {
      const observer = this;
      this.wrappedResponse = function (id, result) {
        // The editor can answer first. Retire before delegating, never after an await/new request.
        const identity = key(id);
        if (!observer.requests.has(identity)) {
          // Native providers are notified in registration order. An earlier provider may answer
          // synchronously before this observer receives that same incoming request.
          observer.recentResponses.add(identity);
          queueMicrotask(() => observer.recentResponses.delete(identity));
          if (observer.seen.size < 1024) observer.seen.add(identity);
          else observer.untracked = observer.gap = true;
        }
        observer.retire(id);
        observer.originalResponse!.call(connection, id, result);
      };
      connection.sendResponse = this.wrappedResponse;
    }
  }
  select(threadId: string | null) {
    this.threadId = threadId;
    this.requests.clear();
    this.omitted.clear();
    this.waiting = false;
    this.gap = false;
    this.untracked = false;
  }
  initialized() {
    // An initialized native generation does not prove old requests are still pending.
    this.disconnected = false;
    this.select(this.threadId);
    this.seen.clear();
    this.recentResponses.clear();
  }
  fatal() {
    this.disconnected = true;
    for (const record of this.requests.values()) {
      record.request.observation = 'unconfirmed';
      record.request.response = 'editor_only';
    }
  }
  observe(raw: unknown) {
    const event = object(raw),
      params = object(event.params);
    const parsedId = mirrorNativeRequestIdSchema.safeParse(event.id);
    if (!this.threadId || params.threadId !== this.threadId) {
      if (parsedId.success) {
        const existing = this.requests.get(key(parsedId.data));
        if (existing) {
          existing.recycled = true;
          existing.request.observation = 'unconfirmed';
          existing.request.response = 'editor_only';
        }
      }
      return;
    }
    if (!parsedId.success) {
      this.untracked = this.gap = true;
      return;
    }
    const id = key(parsedId.data);
    if (this.recentResponses.has(id)) return;
    const method = text(event.method);
    const question = method === 'item/tool/requestUserInput';
    const questions = Array.isArray(params.questions)
      ? params.questions.map((value) => mirrorNativeQuestionSchema.safeParse(value))
      : [];
    const validQuestions =
      questions.length > 0 &&
      questions.length <= 8 &&
      questions.every((value) => value.success) &&
      new Set(questions.map((value) => (value.success ? value.data.id : ''))).size ===
        questions.length;
    const normalized = validQuestions
      ? questions.flatMap((value) => (value.success ? [value.data] : []))
      : [];
    const turnId = boundedId(params.turnId),
      itemId = boundedId(params.itemId, 1024);
    const request: MirrorNativeRequest = {
      token: randomUUID(),
      requestId: parsedId.data,
      threadId: this.threadId,
      turnId,
      itemId,
      kind: question ? 'question' : approvalMethods.has(method) ? 'approval' : 'unsupported',
      title: question
        ? 'Codex has a question'
        : approvalMethods.has(method)
          ? 'Native approval requested'
          : 'Native request requires the editor',
      message:
        question && !validQuestions
          ? 'This question shape or size is unsupported here. Read and answer the original request in VS Code.'
          : (
              text(params.reason) ||
              (approvalMethods.has(method) ? text(params.command) || text(params.message) : '') ||
              'Use the original editor for this native request.'
            ).slice(0, 2000),
      questions: normalized,
      observation: 'pending',
      response:
        question &&
        validQuestions &&
        turnId &&
        itemId &&
        !normalized.some((value) => value.isSecret) &&
        !!this.originalResponse &&
        !this.disconnected &&
        this.connection.initialized
          ? 'answer'
          : 'editor_only',
    };
    const fingerprint = JSON.stringify({
      method: method.slice(0, 256),
      ...request,
      token: undefined,
    });
    const previous = this.requests.get(id);
    if (previous?.fingerprint === fingerprint) return;
    const recycled = this.seen.has(id);
    if (this.seen.size >= 1024) this.untracked = this.gap = true;
    else this.seen.add(id);
    if (recycled || this.gap) {
      request.observation = 'unconfirmed';
      request.response = 'editor_only';
      request.message =
        'The native request identity is ambiguous. Use VS Code; no response can be sent here.';
    }
    if (!previous && this.requests.size >= 8) {
      if (this.omitted.size < 120) this.omitted.set(id, turnId);
      else this.untracked = true;
      this.gap = true;
      return;
    }
    this.requests.set(id, { request, fingerprint, recycled });
  }
  notification(method: string, raw: unknown) {
    const params = object(raw);
    if (params.threadId !== this.threadId) return;
    if (method === 'serverRequest/resolved') {
      const id = mirrorNativeRequestIdSchema.safeParse(params.requestId);
      if (id.success) this.retire(id.data);
    } else if (method === 'turn/completed' || method === 'turn/started') {
      const turn = boundedId(object(params.turn).id) ?? boundedId(params.turnId);
      if (!turn) return;
      for (const [id, record] of this.requests)
        if (
          record.request.turnId &&
          (method === 'turn/completed'
            ? record.request.turnId === turn
            : record.request.turnId !== turn)
        )
          this.requests.delete(id);
      for (const [id, omittedTurn] of this.omitted)
        if (
          omittedTurn &&
          (method === 'turn/completed' ? omittedTurn === turn : omittedTurn !== turn)
        )
          this.omitted.delete(id);
      if (!this.requests.size && !this.omitted.size) this.gap = this.untracked;
      if (method === 'turn/completed') this.waiting = false;
    } else if (method === 'thread/status/changed') {
      const status = object(params.status);
      this.waiting =
        Array.isArray(status.activeFlags) &&
        status.activeFlags.some(
          (flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
        );
      if (status.type === 'idle') {
        for (const record of this.requests.values()) {
          record.request.observation = 'unconfirmed';
          record.request.response = 'editor_only';
        }
      }
    }
  }
  private retire(id: NativeId) {
    const identity = key(id),
      record = this.requests.get(identity);
    // A delayed resolution has no turn/token. It cannot retire a recycled request ID.
    if (!record?.recycled) this.requests.delete(identity);
    this.omitted.delete(identity);
    if (!this.requests.size && !this.omitted.size) {
      this.waiting = false;
      this.gap = this.untracked;
    }
  }
  get attention() {
    return !!this.requests.size || !!this.omitted.size || this.waiting || this.gap;
  }
  get pending() {
    return (
      this.waiting ||
      [...this.requests.values()].some(({ request }) => request.observation === 'pending')
    );
  }
  get connected() {
    return !this.disconnected && this.connection.initialized;
  }
  snapshot(): Pick<
    MirrorState,
    'nativeRequests' | 'nativeRequestCount' | 'nativeRequestsUnavailable'
  > {
    return {
      nativeRequests: [...this.requests.values()].map(({ request }) => ({ ...request })),
      nativeRequestCount: this.requests.size + this.omitted.size,
      nativeRequestsUnavailable:
        this.gap ||
        [...this.requests.values()].some(({ request }) => request.observation === 'unconfirmed') ||
        (this.waiting && !this.requests.size) ||
        this.disconnected,
    };
  }
  answer(raw: MirrorQuestionAnswer): MirrorResult {
    const input = mirrorQuestionAnswerSchema.parse(raw);
    const record = [...this.requests.values()].find(({ request }) => request.token === input.token);
    const request = record?.request;
    if (
      !request ||
      this.disconnected ||
      !this.connection.initialized ||
      input.threadId !== this.threadId ||
      request.threadId !== input.threadId ||
      request.turnId !== input.turnId ||
      request.observation !== 'pending' ||
      request.response !== 'answer' ||
      !this.originalResponse
    )
      return {
        state: 'not_sent',
        message:
          'This exact native question is no longer answerable here. Refresh or use VS Code; nothing was sent.',
      };
    const ids = Object.keys(input.answers);
    if (
      ids.length !== request.questions.length ||
      request.questions.some((question) => {
        const answers = input.answers[question.id];
        return (
          !answers ||
          (question.options?.length &&
            !question.isOther &&
            answers.some((answer) => !question.options!.some((option) => option.label === answer)))
        );
      })
    )
      return {
        state: 'not_sent',
        message:
          'Answer every original question using its native options or permitted text. Nothing was sent.',
      };
    // Claim before calling the original native boundary. No late cleanup can target a new token.
    this.requests.delete(key(request.requestId));
    try {
      this.originalResponse.call(this.connection, request.requestId, {
        answers: Object.fromEntries(ids.map((id) => [id, { answers: input.answers[id] }])),
      });
    } catch {
      /* The native write boundary has no acceptance receipt; never repeat it. */
    }
    return {
      state: 'uncertain',
      message:
        'The response was handed to the original native connection, but acceptance is not confirmed here. Inspect VS Code; this response will not be repeated.',
    };
  }
  dispose() {
    if (this.wrappedResponse && this.connection.sendResponse === this.wrappedResponse)
      this.connection.sendResponse = this.originalResponse;
    this.fatal();
  }
}
