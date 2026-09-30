import { randomUUID } from 'node:crypto';
import type { MirrorState, MirrorSend, MirrorResult, MirrorControl } from '@dock/shared';
import { object } from './connection.js';

type Value = Record<string, unknown>;
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export interface ClaudeChannel {
  sessionId?: string;
  turnComplete: boolean;
  outstandingSendUuids: string[];
  queuedCommandUuids: Set<string>;
  runningBackgroundTasks: number;
  query?: { interrupt(): Promise<unknown> };
}
export interface ClaudeSurface {
  channels: Map<string, ClaudeChannel>;
  outstandingRequests: Map<string, unknown>;
  shutDown?: boolean;
  getSession(id: string): Promise<unknown>;
  transportMessage(channelId: string, message: unknown, done?: boolean): void;
  send(message: unknown): void;
}
export interface ClaudeHost {
  allComms: Set<ClaudeSurface>;
  sessionStates: Map<string, { info: { title?: string; state?: string } }>;
}

export function isClaudeHost(value: unknown): value is ClaudeHost {
  const host = object(value);
  return host.allComms instanceof Set && host.sessionStates instanceof Map;
}
function isClaudeChannel(value: unknown): value is ClaudeChannel {
  const channel = object(value);
  return (
    typeof channel.sessionId === 'string' &&
    !!channel.sessionId &&
    typeof channel.turnComplete === 'boolean' &&
    Array.isArray(channel.outstandingSendUuids) &&
    channel.outstandingSendUuids.every((id) => typeof id === 'string') &&
    channel.queuedCommandUuids instanceof Set &&
    typeof channel.runningBackgroundTasks === 'number' &&
    Number.isFinite(channel.runningBackgroundTasks) &&
    channel.runningBackgroundTasks >= 0
  );
}
const compatibilityMessage =
  'Claude Code changed the connection features sciencewithagents needs. Sharing is unavailable; keep using Claude Code in VS Code. No message was sent.';

/** Only visible content, never signatures, encrypted reasoning, credentials or raw frames. */
export function claudeTranscript(messages: unknown[]): MirrorState['entries'] {
  return messages.flatMap((value, index) => {
    const frame = object(value);
    const message = object(frame.message);
    const id = str(frame.uuid) || str(message.id) || `saved-${index}`;
    const type = str(frame.type);
    if (type === 'user' || type === 'assistant') {
      const blocks =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : list(message.content);
      return blocks.map((value, blockIndex) => {
        const block = object(value);
        let role: 'user' | 'assistant' | 'activity' = type;
        let text: string;
        if (block.type === 'text') text = str(block.text);
        else {
          role = 'activity';
          if (block.type === 'tool_use')
            text = `${str(block.name) || 'Tool call'}\n${JSON.stringify(block.input ?? {})}`;
          else if (block.type === 'tool_result')
            text = `Tool result${block.is_error ? ' (error)' : ''}\n${
              typeof block.content === 'string'
                ? block.content
                : list(block.content)
                    .map((x) => str(object(x).text) || '[Attachment — view in VS Code]')
                    .join('\n')
            }`;
          else if (block.type === 'thinking')
            text = str(block.thinking)
              ? `Thinking\n${str(block.thinking)}`
              : '[Thinking — view in VS Code]';
          else text = `[${str(block.type) || 'Saved activity'} — view in VS Code]`;
        }
        return { id: `${id}:${blockIndex}`, role, text };
      });
    }
    if (type === 'system' && frame.subtype === 'compact_boundary')
      return [
        {
          id,
          role: 'activity' as const,
          text: 'Context compacted. Retained visible history is not the hidden context cache.',
        },
      ];
    if (type === 'system' && typeof frame.content === 'string')
      return [{ id, role: 'activity' as const, text: frame.content }];
    if (type === 'result' && frame.is_error === true)
      return [
        {
          id,
          role: 'activity' as const,
          text:
            list(frame.errors)
              .filter((x) => typeof x === 'string')
              .join('\n') || 'Claude reported an error. Check VS Code.',
        },
      ];
    return [];
  });
}

/** Attaches a selected *already loaded* native channel. Never launches/resumes a process. */
export class ClaudeMirrorConnection {
  readonly windowId = randomUUID();
  private state: MirrorState;
  private binding:
    | {
        surface: ClaudeSurface;
        id: string;
        channel: ClaudeChannel;
        threadId: string;
        query: ClaudeChannel['query'];
      }
    | undefined;
  private undo: (() => void) | undefined;
  private nativeDisplay: ((frame: unknown) => void) | undefined;
  private lastRead = 0;
  private reading: Promise<void> | undefined;
  private uncertain = false;
  private disposed = false;
  private generation = 0;
  private incompatible = false;
  private stopToken = randomUUID();
  private stopping = false;
  // Native turnComplete also means "successful completion" and remains false
  // after an interrupted/error result. Observe the original terminal frame,
  // without changing native state or treating an interrupt acknowledgement as idle.
  private observedTurnEnded = false;
  private readonly live = new Map<string, MirrorState['entries'][number]>();
  private readonly acknowledgements = new Map<
    string,
    { resolve(result: MirrorResult): void; timer: NodeJS.Timeout; queued: boolean }
  >();
  private streamId = '';
  private streamBlocks = new Map<number, string>();
  constructor(
    private readonly host: ClaudeHost,
    label: string,
    private readonly confirmationMs = 12_000,
    private readonly historyTimeoutMs = 12_000,
  ) {
    this.state = {
      windowId: this.windowId,
      provider: 'claude',
      label: label.slice(0, 200),
      threadId: null,
      title: 'Claude Code',
      status: 'offline',
      message: 'Choose a Claude Code conversation in VS Code to share it.',
      entries: [],
      canQueue: true,
    };
  }
  get summary() {
    const { entries: _, ...summary } = this.snapshot();
    return summary;
  }
  private candidates(id?: string) {
    const matches: { surface: ClaudeSurface; id: string; channel: ClaudeChannel }[] = [];
    this.incompatible = false;
    if (!isClaudeHost(this.host)) {
      this.incompatible = true;
      return matches;
    }
    for (const surface of this.host.allComms) {
      if (object(surface).shutDown) continue;
      if (
        !surface ||
        !(surface.channels instanceof Map) ||
        !(surface.outstandingRequests instanceof Map) ||
        typeof surface.getSession !== 'function' ||
        typeof surface.transportMessage !== 'function' ||
        typeof surface.send !== 'function'
      ) {
        this.incompatible = true;
        continue;
      }
      for (const [channelId, channel] of surface.channels) {
        if (!object(channel).sessionId) continue; // Not loaded yet, not an incompatibility.
        if (typeof channelId !== 'string' || !isClaudeChannel(channel)) {
          this.incompatible = true;
          continue;
        }
        if (!id || channel.sessionId === id) matches.push({ surface, id: channelId, channel });
      }
    }
    return matches;
  }
  async choices() {
    const matches = this.candidates();
    if (!matches.length && this.incompatible) throw new Error(compatibilityMessage);
    return matches
      .filter(
        (match) =>
          matches.filter((other) => other.channel.sessionId === match.channel.sessionId).length ===
          1,
      )
      .map((match) => ({
        id: match.channel.sessionId!,
        label:
          this.host.sessionStates.get(match.channel.sessionId!)?.info?.title ||
          `Claude Code · ${match.channel.sessionId!.slice(0, 8)}`,
      }));
  }
  private bind() {
    if (this.disposed) return;
    const matches = this.state.threadId ? this.candidates(this.state.threadId) : [];
    const next = matches.length === 1 ? matches[0] : undefined;
    if (
      next?.surface === this.binding?.surface &&
      next?.channel === this.binding?.channel &&
      next?.id === this.binding?.id &&
      next?.channel.query === this.binding?.query &&
      (!next || this.binding?.threadId === this.state.threadId)
    )
      return;
    this.undo?.();
    this.undo = undefined;
    this.nativeDisplay = undefined;
    this.binding = next
      ? { ...next, threadId: this.state.threadId!, query: next.channel.query }
      : undefined;
    this.stopToken = randomUUID();
    this.observedTurnEnded = false;
    this.lastRead = 0;
    if (!next) return;
    const { surface, id, channel, threadId } = this.binding!;
    const send = surface.send;
    const transport = surface.transportMessage;
    const self = this;
    // A native channel ID/object can be reused when its session changes. Pin both
    // the object and the selected session, including already-queued old callbacks.
    const belongs = (frame: Value) =>
      !self.disposed &&
      surface.channels.get(id) === channel &&
      channel.sessionId === threadId &&
      self.state.threadId === threadId &&
      (frame.session_id === undefined || frame.session_id === threadId);
    this.nativeDisplay = (frame) => send.call(surface, frame);
    const wrappedSend: ClaudeSurface['send'] = function (this: ClaudeSurface, frame) {
      // Observation must never prevent the original sidebar receiving its events.
      try {
        const message = object(object(frame).message);
        if (object(frame).channelId === id && belongs(message)) self.observe(message);
      } catch {
        /* native delivery still wins */
      }
      return send.call(this, frame);
    };
    const wrappedTransport: ClaudeSurface['transportMessage'] = function (
      this: ClaudeSurface,
      channelId,
      message,
      done,
    ) {
      const result = transport.call(this, channelId, message, done);
      try {
        if (channelId === id && object(message).type === 'user' && belongs(object(message))) {
          self.stopToken = randomUUID();
          self.observedTurnEnded = false;
          self.remember([message]);
        }
      } catch {
        /* never interrupt native input */
      }
      return result;
    };
    try {
      surface.send = wrappedSend;
      surface.transportMessage = wrappedTransport;
    } catch {
      // A provider may make its methods read-only. Undo only our partial install;
      // never let an observer failure stop the original native input/output.
      if (surface.send === wrappedSend) surface.send = send;
      this.binding = undefined;
      this.nativeDisplay = undefined;
      this.incompatible = true;
      return;
    }
    this.undo = () => {
      if (surface.send === wrappedSend) surface.send = send;
      if (surface.transportMessage === wrappedTransport) surface.transportMessage = transport;
    };
  }
  private remember(messages: unknown[]) {
    for (const entry of claudeTranscript(messages)) this.live.set(entry.id, entry);
  }
  private observe(frame: Value) {
    if (frame.type === 'command_lifecycle' && frame.state === 'started') {
      this.stopToken = randomUUID();
      this.observedTurnEnded = false;
    }
    if (
      frame.type === 'system' &&
      frame.subtype === 'session_state_changed' &&
      frame.state !== 'idle'
    )
      this.observedTurnEnded = false;
    if (frame.type === 'result') {
      this.stopToken = randomUUID();
      this.observedTurnEnded = true;
    }
    const acknowledged =
      frame.type === 'command_lifecycle'
        ? str(frame.command_uuid)
        : frame.type === 'result'
          ? str(frame.user_message_uuid)
          : frame.type === 'user' && frame.isReplay === true
            ? str(frame.uuid)
            : '';
    const receipt = this.acknowledgements.get(acknowledged);
    const lifecycle = frame.type === 'command_lifecycle' ? str(frame.state) : '';
    const positiveQueueAcknowledgement =
      frame.type === 'result' ||
      ['queued', 'started', 'completed', 'refused', 'cancelled', 'discarded'].includes(lifecycle);
    if (receipt && (!receipt.queued || positiveQueueAcknowledgement)) {
      clearTimeout(receipt.timer);
      this.acknowledgements.delete(acknowledged);
      receipt.resolve(
        ['refused', 'cancelled', 'discarded'].includes(lifecycle)
          ? {
              state: 'not_sent',
              message: 'Claude Code refused or cancelled this message. Check VS Code.',
            }
          : {
              state: 'sent',
              message:
                receipt.queued && lifecycle === 'queued'
                  ? 'Queued in Claude Code. It will run when native work allows.'
                  : receipt.queued && lifecycle === 'started'
                    ? 'The follow-up started in the existing Claude Code conversation.'
                    : 'Sent to the existing Claude Code conversation.',
            },
      );
    }
    this.remember([frame]);
    if (frame.type === 'assistant') {
      for (const key of this.live.keys()) if (key.startsWith('stream:')) this.live.delete(key);
      this.streamBlocks.clear();
    }
    if (frame.type === 'stream_event') {
      const event = object(frame.event);
      if (event.type === 'message_start') {
        this.streamId = str(object(event.message).id);
        this.streamBlocks.clear();
      }
      if (
        event.type === 'content_block_delta' &&
        object(event.delta).type === 'text_delta' &&
        this.streamId &&
        typeof event.index === 'number'
      ) {
        const text = (this.streamBlocks.get(event.index) ?? '') + str(object(event.delta).text);
        this.streamBlocks.set(event.index, text);
        const id = `stream:${this.streamId}:${event.index}`;
        this.live.set(id, { id, role: 'assistant', text });
      }
    }
  }
  private snapshot(): MirrorState {
    const entries = new Map(this.state.entries.map((entry) => [entry.id, entry]));
    for (const [key, entry] of this.live) entries.set(key, entry);
    const channel = this.binding?.channel;
    const requests = this.binding?.surface.outstandingRequests;
    const compatible = !channel || (isClaudeChannel(channel) && requests instanceof Map);
    const attention = this.uncertain || (requests?.size ?? 0) > 0;
    const idle =
      !!channel &&
      (channel.turnComplete === true || this.observedTurnEnded) &&
      Array.isArray(channel.outstandingSendUuids) &&
      channel.outstandingSendUuids.length === 0 &&
      channel.queuedCommandUuids instanceof Set &&
      channel.queuedCommandUuids.size === 0 &&
      channel.runningBackgroundTasks === 0;
    const status =
      this.state.status === 'offline' || !channel || !compatible
        ? 'offline'
        : attention
          ? 'attention'
          : idle
            ? 'idle'
            : 'busy';
    return {
      ...this.state,
      entries: [...entries.values()],
      status,
      stopToken:
        status !== 'offline' &&
        channel?.turnComplete === false &&
        !this.observedTurnEnded &&
        typeof channel.query?.interrupt === 'function' &&
        !this.stopping
          ? this.stopToken
          : undefined,
      message:
        this.state.status === 'offline'
          ? this.state.message
          : this.uncertain
            ? 'Delivery was not confirmed. Inspect Claude Code and share this conversation again before sending more.'
            : attention
              ? 'Claude Code needs attention in VS Code. Approvals stay on the computer.'
              : 'Same Claude Code conversation as VS Code. Drafts stay separate.',
    };
  }
  async select(id: string | null) {
    this.generation++;
    for (const pending of this.acknowledgements.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        state: 'uncertain',
        message:
          'The shared conversation changed before delivery was confirmed. Inspect Claude Code.',
      });
    }
    this.acknowledgements.clear();
    this.uncertain = false;
    this.live.clear();
    this.streamBlocks.clear();
    this.lastRead = 0;
    this.reading = undefined;
    this.state = {
      ...this.state,
      threadId: id,
      title: id ? 'Claude Code' : 'Sharing stopped',
      status: 'offline',
      entries: [],
      message: id
        ? 'Open this saved conversation in Claude Code on the computer.'
        : 'Sharing stopped.',
    };
    this.bind();
    if (id) await this.read(true);
  }
  async read(force = false): Promise<MirrorState> {
    if (this.disposed || !this.state.threadId) return this.snapshot();
    this.bind();
    if (!this.binding) {
      this.state = {
        ...this.state,
        status: 'offline',
        message: this.incompatible
          ? compatibilityMessage
          : 'Open this saved conversation in Claude Code on the computer. sciencewithagents will reconnect; it will not start another session.',
      };
      return this.snapshot();
    }
    if (this.reading) {
      await this.reading;
      return this.snapshot();
    }
    if (!force && Date.now() - this.lastRead < 5000) return this.snapshot();
    const generation = this.generation;
    const binding = this.binding;
    const threadId = this.state.threadId;
    const reading = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const response = object(
          await Promise.race([
            binding.surface.getSession(threadId),
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      'Claude Code did not finish reading its saved history. Check VS Code and try again.',
                    ),
                  ),
                this.historyTimeoutMs,
              );
            }),
          ]),
        );
        if (generation !== this.generation || this.disposed || this.binding !== binding) return;
        if (response.type !== 'get_session_response' || !Array.isArray(response.messages))
          throw new Error(
            'Claude Code did not return its saved transcript. No partial history is shown as complete.',
          );
        const entries = claudeTranscript(response.messages);
        const saved = new Set(entries.map((entry) => entry.id));
        for (const key of this.live.keys()) if (saved.has(key)) this.live.delete(key);
        this.state = {
          ...this.state,
          title: (
            this.host.sessionStates.get(threadId)?.info?.title ||
            entries.find((entry) => entry.role === 'user')?.text ||
            'Claude Code'
          ).slice(0, 500),
          entries,
          status: 'idle',
          message: '',
        };
        this.lastRead = Date.now();
      } catch (error) {
        if (generation === this.generation)
          this.state = {
            ...this.state,
            status: 'offline',
            message:
              error instanceof Error
                ? error.message.slice(0, 1000)
                : 'Unable to read Claude Code. Check VS Code.',
          };
      } finally {
        clearTimeout(timer);
      }
    })();
    this.reading = reading;
    try {
      await reading;
    } finally {
      if (this.reading === reading) this.reading = undefined;
    }
    return this.snapshot();
  }
  async send(input: MirrorSend): Promise<MirrorResult> {
    if (input.expectedTurnId)
      return {
        state: 'not_sent',
        message:
          'This Claude Code connection does not support turn-bound steering. Nothing was sent.',
      };
    if (input.provider !== 'claude' || input.threadId !== this.state.threadId)
      return {
        state: 'not_sent',
        message: 'The shared provider or conversation changed. Nothing was sent.',
      };
    if (input.text.trimStart().startsWith('/'))
      return {
        state: 'not_sent',
        message:
          'Use Claude Code in VS Code for slash commands and settings. This chat sends plain messages only.',
      };
    const state = await this.read();
    this.bind();
    const status = this.snapshot().status;
    if (
      state.threadId !== input.threadId ||
      this.state.threadId !== input.threadId ||
      (status !== 'idle' && !(input.mode === 'queue' && status === 'busy')) ||
      !this.binding
    )
      return {
        state: 'not_sent',
        message: this.incompatible
          ? compatibilityMessage
          : 'Nothing was sent. Wait for Claude Code to finish or resolve its request in VS Code.',
      };
    const binding = this.binding;
    const frame = {
      type: 'user',
      uuid: input.key,
      session_id: input.threadId,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: input.text }] },
    };
    const result = new Promise<MirrorResult>((resolve) => {
      const timer = setTimeout(() => {
        this.acknowledgements.delete(input.key);
        this.uncertain = true;
        resolve({
          state: 'uncertain',
          message:
            'Claude Code did not confirm delivery. Inspect VS Code; this message will not be resent automatically.',
        });
      }, this.confirmationMs);
      this.acknowledgements.set(input.key, { resolve, timer, queued: input.mode === 'queue' });
    });
    try {
      // The original synchronous write boundary marks turnComplete=false before
      // another phone request can pass its idle check. No settings/permissions change.
      binding.surface.transportMessage(binding.id, frame, false);
      // Claude's native replay path merges by UUID without editing its composer.
      // Call the unobserved native function: this is display, NOT a provider receipt.
      this.nativeDisplay?.({
        type: 'io_message',
        channelId: binding.id,
        message: { ...frame, isReplay: true },
        done: false,
      });
    } catch {
      const pending = this.acknowledgements.get(input.key);
      if (pending) {
        clearTimeout(pending.timer);
        this.acknowledgements.delete(input.key);
        this.uncertain = true;
        pending.resolve({
          state: 'uncertain',
          message:
            'Delivery could not be confirmed. Check Claude Code before continuing; nothing is retried automatically.',
        });
      }
    }
    return result;
  }
  async control(input: MirrorControl): Promise<MirrorResult> {
    this.bind();
    const binding = this.binding;
    if (
      input.provider !== 'claude' ||
      input.threadId !== this.state.threadId ||
      !binding ||
      this.snapshot().stopToken !== input.token ||
      !binding.query
    )
      return {
        state: 'not_sent',
        message: 'That reply is no longer active. Nothing else was stopped.',
      };
    this.stopping = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        binding.query.interrupt(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Stop timed out')), this.confirmationMs);
        }),
      ]);
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
    } finally {
      clearTimeout(timer);
      this.stopping = false;
      // An acknowledgement does not prove the turn has ended. Never reuse a
      // displayed control after an uncertain interruption or channel transition.
      this.stopToken = randomUUID();
    }
  }
  dispose() {
    this.disposed = true;
    this.undo?.();
    this.binding = undefined;
    for (const pending of this.acknowledgements.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        state: 'uncertain',
        message: 'Sharing stopped before delivery was confirmed. Inspect Claude Code.',
      });
    }
    this.acknowledgements.clear();
  }
}
