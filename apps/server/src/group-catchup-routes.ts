import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import {
  groupCatchupSelectSchema,
  groupCatchupPageRequestSchema,
  groupCatchupAckRequestSchema,
} from '@dock/shared/dist/group-catchup.js';
import { groupEvidenceRequestSchema } from '@dock/shared/dist/group-evidence.js';
import { GroupCatchupError, type GroupCatchupReader } from './group-catchup-context.js';
import type { GroupCatchupStore } from './group-catchup.js';
import type { GroupEvidenceIndex } from './group-evidence.js';
/** Normal host owns registration with its existing owner/paired-device authentication
 * and GroupHost.authenticatedContext. Identity fields cannot come from request JSON. */
export function registerGroupCatchupRoutes(
  app: FastifyInstance,
  ports: {
    authenticated: (request: FastifyRequest) => boolean;
    resolve: (handle: string) => Promise<GroupCatchupReader>;
    catchup: GroupCatchupStore;
    evidence: GroupEvidenceIndex;
  },
) {
  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ports.authenticated(request))
      return reply.code(401).send({
        code: 'GROUP_AUTH_REQUIRED',
        error: 'Open your authenticated owner browser or paired device.',
      });
  };
  const actions = {
    'catchup/start': async (raw: unknown) => {
      const input = groupCatchupSelectSchema.parse(raw);
      const reader = await ports.resolve(input.handle);
      const page = await ports.catchup.start(reader);
      await ports.evidence.observePage(reader, page.entries);
      for (const event of page.entries)
        if (ports.evidence.source) await ports.evidence.ingestVerifiedShared(reader, event.eventId);
      return { ...page, sourceFacts: await ports.evidence.pageEvidence(reader, page.entries) };
    },
    'catchup/page': async (raw: unknown) => {
      const input = groupCatchupPageRequestSchema.parse(raw);
      const reader = await ports.resolve(input.handle);
      const page = await ports.catchup.page(reader, input.snapshotId, input.continuation);
      await ports.evidence.observePage(reader, page.entries);
      for (const event of page.entries)
        if (ports.evidence.source) await ports.evidence.ingestVerifiedShared(reader, event.eventId);
      return { ...page, sourceFacts: await ports.evidence.pageEvidence(reader, page.entries) };
    },
    'catchup/ack': async (raw: unknown) => {
      const input = groupCatchupAckRequestSchema.parse(raw);
      return ports.catchup.acknowledge(
        await ports.resolve(input.handle),
        input.snapshotId,
        input.pageId,
        input.acknowledgementId,
      );
    },
    'evidence/original': async (raw: unknown) => {
      const input = z.strictObject({ handle: z.uuid(), eventId: z.uuid() }).parse(raw);
      const reader = await ports.resolve(input.handle);
      return reader.original(input.eventId as Parameters<GroupCatchupReader['original']>[0]);
    },
    'evidence/query': async (raw: unknown) => {
      const input = groupEvidenceRequestSchema.parse(raw);
      return ports.evidence.query(
        await ports.resolve(input.handle),
        input.query,
        input.limit,
        input.continuation,
        ports.catchup,
        input.queryId,
      );
    },
  };
  for (const [path, action] of Object.entries(actions))
    app.post(
      `/api/groups/${path}`,
      { bodyLimit: 4096, onRequest: guard },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        try {
          return await action(request.body);
        } catch (error) {
          if (error instanceof ZodError)
            return reply.code(400).send({
              code: 'GROUP_INVALID_QUERY',
              error: 'Use a valid bounded catch-up or evidence request.',
            });
          if (error instanceof GroupCatchupError)
            return reply
              .code(error.code === 'limit' ? 429 : 409)
              .send({ code: `GROUP_${error.code.toUpperCase()}`, error: error.message });
          // Existing normal auth/enrollment errors keep their status, without exposing secrets.
          if (error instanceof Error && 'status' in error && typeof error.status === 'number')
            return reply.code(error.status).send({
              code: 'GROUP_ACCESS_UNAVAILABLE',
              error: 'This saved group enrollment is unavailable. Reconnect or reopen it.',
            });
          return reply.code(503).send({
            code: 'GROUP_READ_UNAVAILABLE',
            error:
              'Shared reading is unavailable. Retry; saved snapshot and acknowledgement identities remain intact.',
          });
        }
      },
    );
}
