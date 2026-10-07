import {
  DELIVERY_LIMITS,
  deliveryCommandSchema,
  deliveryReplySchema,
  deliveryResultSchema,
  publicationCanonical,
  publicationKeySchema,
  publicationReceiptSchema,
  type DeliveryCommand,
  type DeliveryReply,
} from '@dock/shared/dist/group-delivery.js';
import {
  publicationBindingSchema,
  publicationEffectSchema,
  type PublicationBinding,
  type PublicationTransport,
  type PublicationKey,
  type PublicationEffect,
  type PublicationReply,
  type PublicationEffectReply,
  type PublicationAvailability,
} from './group-publication-protocol.js';
import {
  groupBetaProfileSchema,
  verifyGroupBetaAdmission,
} from '@dock/shared/dist/group-beta-admission.js';
import type { z } from 'zod';

/** Host-owned enrollment/secret lookup. Never expose this resolver as a browser route. */
export type HostedPublicationResolution =
  | { kind: 'unavailable'; reason: PublicationAvailability }
  | {
      kind: 'enrolled';
      binding: PublicationBinding;
      endpoint: string;
      credential: string;
      remoteInstallationId: string;
      remoteMemberId: string;
      hostingAuthorization?: { origin: string; approvalCapability: string; freeApprovalId: string };
      betaAuthorization?: { profile: z.infer<typeof groupBetaProfileSchema>; admission: string };
    };
export type HostedPublicationResolver = (
  binding: PublicationBinding,
) => HostedPublicationResolution;
export class HostedPublicationError extends Error {
  constructor() {
    super('Hosted publication reply unavailable; delivery may have occurred');
  }
}

/** Exact protocol180 adapter. Activation requires explicit host approval; defaults to disabled. */
export class HostedPublicationTransport implements PublicationTransport {
  constructor(
    private readonly resolve: HostedPublicationResolver,
    private readonly mode: 'disabled' | 'local-test' | 'hosted' | 'beta' = 'disabled',
    private readonly http: typeof fetch = fetch,
  ) {}
  private async resolution(binding: PublicationBinding): Promise<HostedPublicationResolution> {
    try {
      if (this.mode === 'disabled') return { kind: 'unavailable', reason: 'offline' };
      const value = this.resolve(publicationBindingSchema.parse(binding));
      if (value.kind === 'unavailable') {
        if (!['offline', 'unauthorized', 'revoked'].includes(value.reason))
          throw new HostedPublicationError();
        return value;
      }
      if (
        publicationCanonical(value.binding) !== publicationCanonical(binding) ||
        !/^[a-f0-9]{64}$/.test(value.credential) ||
        !publicationBindingSchema.shape.installationId.safeParse(value.remoteInstallationId)
          .success ||
        !publicationBindingSchema.shape.groupId.safeParse(value.remoteMemberId).success
      )
        throw new HostedPublicationError();
      const url = new URL(value.endpoint);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
        throw new HostedPublicationError();
      if (this.mode === 'local-test') {
        if (
          url.protocol !== 'http:' ||
          url.hostname !== '127.0.0.1' ||
          value.hostingAuthorization ||
          value.betaAuthorization
        )
          throw new HostedPublicationError();
      } else if (this.mode === 'hosted') {
        const approved = value.hostingAuthorization;
        if (
          url.protocol !== 'https:' ||
          !approved ||
          value.betaAuthorization ||
          url.origin !== approved.origin ||
          !/^[a-f0-9]{64}$/.test(approved.approvalCapability) ||
          !publicationBindingSchema.shape.endpointId.safeParse(approved.freeApprovalId).success
        )
          throw new HostedPublicationError();
      } else {
        if (!value.betaAuthorization || value.hostingAuthorization)
          throw new HostedPublicationError();
        const profile = groupBetaProfileSchema.parse(value.betaAuthorization.profile);
        if (
          url.protocol !== 'https:' ||
          url.origin !== profile.origin ||
          binding.endpointId !== profile.endpointId
        )
          throw new HostedPublicationError();
        const payload = await verifyGroupBetaAdmission(value.betaAuthorization.admission, profile);
        if (payload.groupId !== binding.remoteGroupId) throw new HostedPublicationError();
      }
      return value;
    } catch {
      throw new HostedPublicationError();
    }
  }
  private async request(
    binding: PublicationBinding,
    command: DeliveryCommand,
    signal: AbortSignal,
    resolved: Extract<HostedPublicationResolution, { kind: 'enrolled' }>,
  ): Promise<DeliveryReply> {
    const body = publicationCanonical(deliveryCommandSchema.parse(command));
    if (Buffer.byteLength(body) > DELIVERY_LIMITS.bodyBytes) throw new HostedPublicationError();
    // Once fetch is called, every exception/denial/redirect is an ambiguous handoff.
    const deadline = AbortSignal.timeout(DELIVERY_LIMITS.timeoutMs);
    const bounded = AbortSignal.any([signal, deadline]);
    try {
      const pending = this.http(
        `${resolved.endpoint.replace(/\/$/, '')}/v1/groups/${binding.remoteGroupId}/delivery`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resolved.credential}`,
            'Content-Type': 'application/json',
            ...(resolved.hostingAuthorization
              ? { 'X-Hosting-Approval': resolved.hostingAuthorization.approvalCapability }
              : {}),
            ...(resolved.betaAuthorization
              ? { 'X-Group-Admission': resolved.betaAuthorization.admission }
              : {}),
          },
          body,
          signal: bounded,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        },
      );
      const response = await new Promise<Response>((resolve, reject) => {
        const abort = () => reject(new HostedPublicationError());
        bounded.addEventListener('abort', abort, { once: true });
        if (bounded.aborted) abort();
        void pending.then(
          (value) => {
            bounded.removeEventListener('abort', abort);
            if (bounded.aborted) {
              void value.body?.cancel().catch(() => {});
              reject(new HostedPublicationError());
            } else resolve(value);
          },
          () => {
            bounded.removeEventListener('abort', abort);
            reject(new HostedPublicationError());
          },
        );
      });
      if (
        !response.ok ||
        response.headers.get('Content-Type')?.split(';')[0] !== 'application/json'
      ) {
        void response.body?.cancel().catch(() => {});
        throw new HostedPublicationError();
      }
      const bound =
        command.kind === 'receipt' || command.kind === 'effect'
          ? 4096 + 64
          : DELIVERY_LIMITS.responseBytes + 64;
      const length = response.headers.get('Content-Length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > bound)) {
        void response.body?.cancel().catch(() => {});
        throw new HostedPublicationError();
      }
      if (!response.body || bounded.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new HostedPublicationError();
      }
      const reader = response.body.getReader(),
        parts: Uint8Array[] = [];
      let size = 0;
      const abort = () => {
        void reader.cancel().catch(() => {});
      };
      bounded.addEventListener('abort', abort, { once: true });
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (bounded.aborted) throw new HostedPublicationError();
          if (done) break;
          size += value.byteLength;
          if (size > bound) {
            void reader.cancel().catch(() => {});
            throw new HostedPublicationError();
          }
          parts.push(value);
        }
      } finally {
        bounded.removeEventListener('abort', abort);
        reader.releaseLock();
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
      const result = deliveryResultSchema.parse(JSON.parse(text));
      if (!result.ok) throw new HostedPublicationError();
      return deliveryReplySchema.parse(result.value);
    } catch {
      throw new HostedPublicationError();
    }
  }
  private exactReceipt(reply: DeliveryReply, key: PublicationKey) {
    if (reply.kind !== 'receipt') throw new HostedPublicationError();
    const receipt = publicationReceiptSchema.parse(reply.receipt);
    const identity = (value: PublicationKey) => ({
      version: value.version,
      binding: value.binding,
      operationId: value.operationId,
      payloadHash: value.payloadHash,
    });
    if (publicationCanonical(identity(receipt)) !== publicationCanonical(identity(key)))
      throw new HostedPublicationError();
    return receipt;
  }
  async receipt(key: PublicationKey, signal: AbortSignal): Promise<PublicationReply> {
    try {
      const checked = publicationKeySchema.parse(key);
      const resolved = await this.resolution(checked.binding);
      if (resolved.kind === 'unavailable') return resolved;
      const reply = await this.request(
        checked.binding,
        { kind: 'receipt', key: checked },
        signal,
        resolved,
      );
      return { kind: 'receipt', receipt: this.exactReceipt(reply, checked) };
    } catch {
      return { kind: 'unavailable', reason: 'offline' };
    }
  }
  async effect(packet: PublicationEffect, signal: AbortSignal): Promise<PublicationEffectReply> {
    try {
      const checked = publicationEffectSchema.parse(packet);
      const key = checked.kind === 'begin' ? checked.header : checked.key;
      const resolved = await this.resolution(key.binding);
      if (resolved.kind === 'unavailable') return { kind: 'not_sent', reason: resolved.reason };
      if (signal.aborted) return { kind: 'not_sent', reason: 'offline' };
      const reply = await this.request(
        key.binding,
        { kind: 'effect', packet: checked },
        signal,
        resolved,
      );
      return { kind: 'receipt', receipt: this.exactReceipt(reply, key) };
    } catch {
      throw new HostedPublicationError();
    }
  }
  private authorMatches(
    author: import('@dock/shared/dist/group-delivery.js').DeliveryAuthor,
    remoteBinding: PublicationBinding,
    binding: PublicationBinding,
    resolved: Extract<HostedPublicationResolution, { kind: 'enrolled' }>,
  ): boolean {
    if (author.groupId !== binding.remoteGroupId) return false;
    if (
      remoteBinding.groupId === binding.groupId &&
      remoteBinding.installationId === binding.installationId
    )
      return (
        author.installationId === resolved.remoteInstallationId &&
        author.memberId === resolved.remoteMemberId
      );
    return (
      author.installationId !== resolved.remoteInstallationId &&
      author.memberId !== resolved.remoteMemberId
    );
  }
  /** Host-only source approval and bounded shared reads; auth uses the same enrollment. */
  async query(
    binding: PublicationBinding,
    command: DeliveryCommand,
    signal: AbortSignal,
  ): Promise<DeliveryReply> {
    try {
      const checked = deliveryCommandSchema.parse(command);
      if (checked.kind === 'effect' || checked.kind === 'receipt')
        throw new HostedPublicationError();
      if (
        'binding' in checked &&
        publicationCanonical(checked.binding) !== publicationCanonical(binding)
      )
        throw new HostedPublicationError();
      const resolved = await this.resolution(binding);
      if (resolved.kind === 'unavailable') throw new HostedPublicationError();
      const reply = await this.request(binding, checked, signal, resolved);
      if (checked.kind === 'feed') {
        if (reply.kind !== 'feed') throw new HostedPublicationError();
        const after = checked.cursor?.after ?? checked.after,
          watermark = checked.cursor?.watermark ?? reply.watermark;
        if (
          reply.watermark !== watermark ||
          reply.entries.length > checked.limit ||
          reply.entries.some(
            (entry, i) =>
              entry.header.binding.remoteGroupId !== binding.remoteGroupId ||
              !this.authorMatches(entry.author, entry.header.binding, binding, resolved) ||
              entry.remoteSequence <= after ||
              entry.remoteSequence > watermark ||
              (i > 0 && entry.remoteSequence <= reply.entries[i - 1].remoteSequence),
          ) ||
          (reply.continuation &&
            (reply.continuation.groupId !== binding.remoteGroupId ||
              reply.continuation.watermark !== watermark ||
              reply.continuation.after !== reply.entries.at(-1)?.remoteSequence))
        )
          throw new HostedPublicationError();
      } else if (checked.kind === 'expand') {
        if (
          reply.kind !== 'expansion' ||
          reply.header.event.eventId !== checked.eventId ||
          reply.header.binding.remoteGroupId !== binding.remoteGroupId ||
          !this.authorMatches(reply.author, reply.header.binding, binding, resolved) ||
          reply.start !== checked.start ||
          reply.chunks.length === 0 ||
          reply.chunks.length > checked.count ||
          reply.chunks.some((chunk, i) => {
            const expected = reply.header.event.manifest.chunks[checked.start + i];
            return (
              chunk.index !== checked.start + i ||
              !expected ||
              expected.sha256 !== chunk.sha256 ||
              expected.bytes !== chunk.bytes
            );
          }) ||
          reply.next !==
            (checked.start + reply.chunks.length < reply.header.event.manifest.chunks.length
              ? checked.start + reply.chunks.length
              : null)
        )
          throw new HostedPublicationError();
      } else if (checked.kind === 'registerSource') {
        if (
          reply.kind !== 'registered' ||
          publicationCanonical(reply.source) !== publicationCanonical(checked.source) ||
          reply.author.groupId !== binding.remoteGroupId ||
          reply.author.installationId !== resolved.remoteInstallationId ||
          reply.author.memberId !== resolved.remoteMemberId
        )
          throw new HostedPublicationError();
      }
      return reply;
    } catch {
      throw new HostedPublicationError();
    }
  }
}
