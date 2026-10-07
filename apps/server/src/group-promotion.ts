import { createHash } from 'node:crypto';
import {
  GROUP_LIMITS,
  groupEntityIdSchema,
  groupOperationIdSchema,
  groupScopeSchema,
  groupUtf8Bytes,
  type GroupEvent,
  type GroupScope,
} from '@dock/shared';
import {
  GROUP_PROMOTION_LIMITS as L,
  groupPromotionDecisionSchema,
  groupPromotionReplySchema,
  groupPromotionSourceSchema,
  type GroupPromotionCommand,
  type GroupPromotionDecision,
  type GroupPromotionEvidence,
  type GroupPromotionIdentity,
  type GroupPromotionReceipt,
  type GroupPromotionSource,
} from '@dock/shared/dist/group-promotion.js';
import { GroupEventRepository } from './group-events.js';
import { PUBLICATION_LIMITS, publicationCanonical } from './group-publication-protocol.js';
import { GroupPromotionEvidenceIndex } from './group-promotion-evidence.js';

export interface GroupPromotionSynthesisRequest {
  synthesisId: string;
  identity: GroupPromotionIdentity;
  source: GroupPromotionSource;
  /** Only exact, already-authorized shared evidence; no global history or private context. */
  evidence: { event: GroupEvent; original: string }[];
}
export type GroupPromotionSynthesisResult =
  | { state: 'pending' | 'unavailable' | 'unknown' }
  | { state: 'completed'; identity: GroupPromotionIdentity; decision: GroupPromotionDecision };
/** Adapter must use the existing admitted, source-authorized execution lane.
 * This module launches no provider. inspect is read-only; it must never resubmit. */
export interface GroupPromotionSynthesis {
  submit(
    request: GroupPromotionSynthesisRequest,
    signal: AbortSignal,
  ): Promise<GroupPromotionSynthesisResult>;
  inspect(
    synthesisId: string,
    identity: GroupPromotionIdentity,
    signal: AbortSignal,
  ): Promise<GroupPromotionSynthesisResult>;
}
export interface GroupPromotionPorts {
  /** Existing authenticated hosted transport; same-DO policy owns the designation. */
  command(command: GroupPromotionCommand, signal: AbortSignal): Promise<unknown>;
  /** Existing GroupPublicationController.enqueue, durable/idempotent; no direct send. */
  enqueue(
    scope: GroupScope,
    eventId: GroupEvent['eventId'],
  ): Promise<{ operationId: string; state: 'pending' | 'committed' }>;
  synthesis?: GroupPromotionSynthesis;
}
export type GroupPromotionOutcome =
  | { state: 'suppressed' | 'needs-summary' | 'offline' | 'pending' | 'unknown' }
  | { state: 'unavailable'; reason: string }
  | {
      state: 'promoted';
      event: GroupEvent;
      receipt: GroupPromotionReceipt;
      evidence: GroupPromotionEvidence;
    };

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
class PromotionDeadline extends Error {}
/** Bound the I/O wait, never cancel an admitted model turn or replay its effects. */
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(abort.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new PromotionDeadline('Promotion I/O deadline'));
        }, PUBLICATION_LIMITS.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const quietHuman = /^(?:thanks?|thank you|ok(?:ay)?|got it|noted|ack(?:nowledged)?|👍)[.!\s]*$/iu;
/** Conservative deterministic treatment of complete short human statements.
 * Ambiguous/long/mixed material needs the bounded admitted lane, never truncation. */
export function groupPromotionHumanDecision(text: string): GroupPromotionDecision | null {
  const complete = text.trim();
  if (!complete || quietHuman.test(complete) || complete.includes('\n')) return null;
  const units = complete.match(/[^.!?]+[.!?]+(?:["')\]]*)|[^.!?]+$/gu) ?? [];
  if (units.length < 1 || units.length > 2 || groupUtf8Bytes(complete) > L.summaryBytes)
    return null;
  if (units.length === 2) {
    const parts = units.map((unit) => groupPromotionHumanDecision(unit.trim()));
    if (!parts[0] || !parts[1] || parts[0].category !== parts[1].category) return null;
    return groupPromotionDecisionSchema.parse({
      category: parts[0].category,
      sentences: parts.flatMap((p) => p!.sentences),
      evidenceRefs: [],
    });
  }
  let category: GroupPromotionDecision['category'] | undefined;
  if (/^(?:we (?:have )?decided|decision:|we will use|i approve|approved:)/iu.test(complete))
    category = 'Decision';
  else if (/^(?:please |instruction:|stop |continue |run |implement |do not )/iu.test(complete))
    category = 'Instruction';
  else if (/^(?:idea:|i suggest|we could|what if|perhaps we)/iu.test(complete)) category = 'Idea';
  else if (/^(?:blocked:|blocker:|we cannot|i cannot|unable to)/iu.test(complete))
    category = 'Blocker';
  else if (/^(?:conflict:|these instructions conflict|the changes conflict)/iu.test(complete))
    category = 'Conflict';
  else if (/^(?:finding:|result:|the experiment shows|the tests show)/iu.test(complete))
    category = 'Finding';
  else if (/^(?:status:|started:|completed:|job \S+ (?:started|completed|failed))/iu.test(complete))
    category = 'Action';
  else if (/\?$/u.test(complete) && units.every((v) => v.trim().endsWith('?')))
    category = 'Question';
  if (!category) return null;
  const parsed = groupPromotionDecisionSchema.safeParse({
    category,
    sentences: units.map((v) => v.trim()),
    evidenceRefs: [],
  });
  return parsed.success ? parsed.data : null;
}

/** Host-only bounded controller. select MUST resolve an immutable saved, authenticated
 * shared source journal/registration receipt; it is never a browser request body or SSE.
 * Invoke again after connectivity/explicit retry, not with an autonomous timer per edit. */
export class GroupPromotionController {
  constructor(
    private readonly repository: GroupEventRepository,
    private readonly ports: GroupPromotionPorts,
    private readonly index: GroupPromotionEvidenceIndex,
  ) {}
  async promote(select: () => Promise<unknown>): Promise<GroupPromotionOutcome> {
    // Private and quiet material is excluded BEFORE original parsing/hash/remote receipts.
    let raw: unknown;
    try {
      raw = await bounded(() => select());
    } catch (e) {
      if (e instanceof PromotionDeadline) return { state: 'offline' };
      throw e;
    }
    if (!raw || typeof raw !== 'object') return { state: 'suppressed' };
    const header = raw as Partial<GroupPromotionSource>;
    if (
      header.scope?.visibility !== 'shared' ||
      header.projectionScope?.visibility !== 'shared' ||
      header.contentMode !== 'shared-content' ||
      header.activity !== 'substantive'
    )
      return { state: 'suppressed' };
    // Revalidate persisted contexts before parsing the original body.
    const sourceScope = groupScopeSchema.parse(header.scope);
    const projectionScope = groupScopeSchema.parse(header.projectionScope);
    this.repository.trustedHostScope(sourceScope);
    this.repository.trustedHostScope(projectionScope);
    if (
      sourceScope.groupId !== projectionScope.groupId ||
      publicationCanonical(sourceScope.causalRefs) !==
        publicationCanonical(projectionScope.causalRefs)
    )
      throw new Error('Projection must retain verified source causality');
    const source = groupPromotionSourceSchema.parse(raw);
    const original =
      source.original.kind === 'inline' ? source.original.text : source.original.chunks.join('');
    if (groupUtf8Bytes(original) > GROUP_LIMITS.payloadBytes)
      throw new Error('Promotion original exceeds bound');
    if (source.kind === 'human' && quietHuman.test(original.trim())) return { state: 'suppressed' };
    const access = this.repository.trustedHostScope(source.scope);
    // Independent repository checks prevent shared refs to private/unrelated records.
    const evidence = this.repository.sharedPublication(access, [
      ...new Set([...source.scope.causalRefs, ...source.evidenceRefs]),
    ]);
    if (source.correction) {
      const prior = this.repository.sharedPublication(access, [source.correction.eventId])[0].event;
      if (
        prior.entityId !== source.correction.entityId ||
        prior.revision !== source.correction.revision
      )
        throw new Error('Correction evidence mismatch');
    }
    let decision =
      source.decision ?? (source.kind === 'human' ? groupPromotionHumanDecision(original) : null);
    if (decision && !source.decision) decision = { ...decision, evidenceRefs: source.evidenceRefs };
    const identity: GroupPromotionIdentity = {
      key: structuredClone(source.key),
      sourceHash: hash(publicationCanonical(source)),
    };
    if (!decision && (!source.synthesisAuthorized || !this.ports.synthesis))
      return { state: 'needs-summary' };
    if (
      !decision &&
      groupUtf8Bytes(original) + evidence.reduce((n, e) => n + groupUtf8Bytes(e.original), 0) >
        L.synthesisBytes
    )
      return { state: 'needs-summary' };
    const validateDecision = (input: GroupPromotionDecision) => {
      const value = groupPromotionDecisionSchema.parse(input);
      if (
        value.evidenceRefs.length !== source.evidenceRefs.length ||
        value.evidenceRefs.some((ref) => !source.evidenceRefs.includes(ref))
      )
        throw new Error('Summary must retain exactly the source-authorized evidence');
      return value;
    };
    // Validate source-provided decision before it can enter the global receipt.
    if (decision) decision = validateDecision(decision);
    const command = async (
      value: GroupPromotionCommand,
    ): Promise<GroupPromotionReceipt | GroupPromotionOutcome> => {
      let rawReply: unknown;
      try {
        rawReply = await bounded((signal) => this.ports.command(structuredClone(value), signal));
      } catch {
        return { state: 'offline' };
      }
      const reply = groupPromotionReplySchema.parse(rawReply);
      if (reply.kind === 'unavailable') return { state: 'unavailable', reason: reply.reason };
      if (publicationCanonical(reply.receipt.identity) !== publicationCanonical(identity))
        throw new Error('Promotion receipt identity mismatch');
      if (reply.receipt.writerId !== source.writerId)
        throw new Error('Promotion writer receipt mismatch');
      return reply.receipt;
    };
    let receipt = await command({ kind: 'reserve', identity });
    if ('state' in receipt) return receipt;
    if (receipt.disposition) return { state: 'unavailable', reason: receipt.disposition.reason };
    if (!receipt.decision && !decision) {
      // startSynthesis acquired is an atomic, durable one-shot launch intent.
      // Lost acknowledgement returns offline; retry only inspects the saved ID.
      let reply;
      try {
        reply = groupPromotionReplySchema.parse(
          await bounded((signal) =>
            this.ports.command(structuredClone({ kind: 'startSynthesis', identity }), signal),
          ),
        );
      } catch {
        return { state: 'offline' };
      }
      if (reply.kind === 'unavailable') return { state: 'unavailable', reason: reply.reason };
      if (
        publicationCanonical(reply.receipt.identity) !== publicationCanonical(identity) ||
        reply.receipt.synthesisId !== receipt.synthesisId
      )
        throw new Error('Synthesis receipt mismatch');
      receipt = reply.receipt;
      if (!receipt.decision) {
        const synthesisId = receipt.synthesisId;
        let result: GroupPromotionSynthesisResult;
        try {
          result = reply.acquired
            ? await bounded((signal) =>
                this.ports.synthesis!.submit(
                  {
                    synthesisId,
                    identity: structuredClone(identity),
                    source: structuredClone(source),
                    evidence: structuredClone(evidence),
                  },
                  signal,
                ),
              )
            : await bounded((signal) =>
                this.ports.synthesis!.inspect(synthesisId, structuredClone(identity), signal),
              );
        } catch {
          return { state: 'unknown' };
        }
        if (result.state !== 'completed')
          return { state: result.state === 'unavailable' ? 'pending' : result.state };
        if (publicationCanonical(result.identity) !== publicationCanonical(identity))
          throw new Error('Synthesis returned unrelated source');
        decision = validateDecision(result.decision);
      }
    }
    if (!receipt.decision) {
      const saved = await command({ kind: 'decide', identity, decision: decision! });
      if ('state' in saved) return saved;
      receipt = saved;
    }
    // Revalidate persisted source and membership after all awaits, before event/outbox.
    let current: unknown;
    try {
      current = await bounded(() => select());
    } catch (e) {
      if (e instanceof PromotionDeadline) return { state: 'offline' };
      throw e;
    }
    if (publicationCanonical(current) !== publicationCanonical(source))
      throw new Error('Immutable promotion source changed');
    this.repository.trustedHostScope(source.scope);
    const authorized = this.repository.trustedHostScope(source.projectionScope);
    const d = validateDecision(receipt.decision!);
    const appended = this.repository.append(authorized, {
      operationId: groupOperationIdSchema.parse(receipt.operationId),
      entityId: groupEntityIdSchema.parse(source.correction?.entityId ?? receipt.entityId),
      expectedRevision: source.correction?.revision ?? 0,
      category: d.category,
      condensedText: d.sentences.join(' '),
      original: source.original,
      evidenceRefs: d.evidenceRefs,
      corrects: source.correction?.eventId ?? null,
    });
    if (receipt.eventId && receipt.eventId !== appended.event.eventId)
      throw new Error('Promotion event collision');
    const verifiedEvidence: GroupPromotionEvidence = {
      identity,
      eventId: appended.event.eventId,
      scope: source.scope,
      kind: source.kind,
      causalRefs: source.scope.causalRefs,
      evidenceRefs: d.evidenceRefs,
      corrects: source.correction?.eventId ?? null,
    };
    this.index.record(verifiedEvidence);
    const bound = await command({ kind: 'bindEvent', identity, eventId: appended.event.eventId });
    if ('state' in bound) return bound;
    // Enqueue repeats are safe only through the existing durable publication controller.
    this.repository.sharedPublication(authorized, [appended.event.eventId]);
    const publication = await this.ports.enqueue(
      structuredClone(source.projectionScope),
      appended.event.eventId,
    );
    let finalReceipt = bound;
    if (publication.state === 'committed') {
      const published = await command({
        kind: 'published',
        identity,
        eventId: appended.event.eventId,
        publicationOperationId: publication.operationId,
      });
      if ('state' in published) return published;
      finalReceipt = published;
    }
    return {
      state: 'promoted',
      event: appended.event,
      receipt: finalReceipt,
      evidence: verifiedEvidence,
    };
  }
}
