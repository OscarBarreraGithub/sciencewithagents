import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  groupActionRequestSchema,
  groupActionResultSchema,
  type GroupActionCommand,
  type GroupActionResult,
} from '@dock/shared/dist/group-actions.js';
/** Normal-host owner supplies current saved-handle resolution and protected
 * service transport. Credentials/identity never cross this browser contract. */
export interface GroupActionsHostPort {
  authenticatedContext(handle: string): Promise<{
    visibility: 'shared' | 'private';
    revalidate(): Promise<void>;
    command(command: GroupActionCommand): Promise<GroupActionResult>;
  }>;
  /** This compiled owner/paired-device lane alone may attest an exact override. */
  confirmHuman(
    handle: string,
    command: Extract<GroupActionCommand, { kind: 'confirm' }>,
  ): Promise<GroupActionResult>;
}
export function registerGroupActionsRoutes(
  app: FastifyInstance,
  host: GroupActionsHostPort,
  authenticated: (request: FastifyRequest) => boolean,
) {
  app.post(
    '/api/groups/actions',
    {
      bodyLimit: 12_000,
      onRequest: async (request, reply) => {
        if (!authenticated(request)) return reply.code(401).send({ ok: false, error: 'denied' });
      },
    },
    async (request, reply) => {
      const parsed = groupActionRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid' });
      const { handle, command } = parsed.data;
      if (!['board', 'instruction', 'propose', 'confirm'].includes(command.kind))
        return reply.code(403).send({ ok: false, error: 'denied' });
      try {
        const ctx = await host.authenticatedContext(handle);
        if (ctx.visibility !== 'shared' && command.kind !== 'board')
          return reply.code(403).send({ ok: false, error: 'denied' });
        await ctx.revalidate();
        return groupActionResultSchema.parse(
          await (command.kind === 'confirm'
            ? host.confirmHuman(handle, command)
            : ctx.command(command)),
        );
      } catch {
        return reply.code(503).send({ ok: false, error: 'unavailable' });
      }
    },
  );
}
