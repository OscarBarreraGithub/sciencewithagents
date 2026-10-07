import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError, z } from 'zod';
import { GroupDocuments, GroupDocumentError } from './group-documents.js';

/** Normal server owner installs alongside GroupHost routes with the SAME owner/paired auth predicate.
 * Browser selects a persisted slot + grant + immutable version, never path/result/native receipt.
 */
export function registerGroupDocumentsRoutes(
  app: FastifyInstance,
  documents: GroupDocuments,
  authenticated: (request: FastifyRequest) => boolean,
  afterRevoke?: (handle: string, id: string) => Promise<void>,
) {
  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (!authenticated(request))
      return reply.code(401).send({
        code: 'GROUP_AUTH_REQUIRED',
        error: 'Open an authenticated owner browser or paired device to read group documents.',
      });
  };
  const run =
    (fn: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(request, reply);
      } catch (error) {
        reply.type('application/json');
        if (error instanceof GroupDocumentError)
          return reply.code(error.status).send({ code: error.code, error: error.message });
        if (error instanceof ZodError)
          return reply.code(400).send({
            code: 'GROUP_DOCUMENT_INVALID',
            error: 'Select a valid scoped document request.',
          });
        throw error;
      }
    };
  const params = z.strictObject({
    handle: z.uuid(),
    id: z.uuid(),
    version: z.string().regex(/^[a-f0-9]{64}$/),
  });
  const base = '/api/groups/documents/:handle/:id/:version';
  app.post(
    '/api/groups/documents/:handle/grants',
    { onRequest: guard, bodyLimit: 16 * 1024 },
    run(async (request) =>
      documents.grant(
        z.strictObject({ handle: z.uuid() }).parse(request.params).handle,
        request.body,
      ),
    ),
  );
  app.get(
    base,
    { onRequest: guard },
    run(async (request) => {
      const p = params.parse(request.params);
      return documents.get(p.handle, p.id, p.version);
    }),
  );
  for (const action of ['open', 'build', 'share', 'revoke'] as const)
    app.post(
      `${base}/${action}`,
      { onRequest: guard, bodyLimit: 4096 },
      run(async (request) => {
        const p = params.parse(request.params);
        if (action !== 'revoke') await documents.get(p.handle, p.id, p.version);
        if (action === 'revoke') {
          const result = await documents.revoke(p.handle, p.id, request.body, p.version);
          await afterRevoke?.(p.handle, p.id);
          return result;
        }
        return action === 'share'
          ? documents.share(p.handle, p.id, request.body)
          : documents[action](p.handle, p.id, p.version, request.body);
      }),
    );
  for (const resource of ['source', 'pdf', 'reading'] as const)
    app.get(
      `${base}/${resource}`,
      { onRequest: guard },
      run(async (request, reply) => {
        const p = params.parse(request.params);
        const result = await documents[resource](p.handle, p.id, p.version);
        if (resource === 'pdf') reply.type('application/pdf');
        if (resource === 'source') reply.type('application/octet-stream');
        return result;
      }),
    );
  app.get(
    `${base}/assets/:asset`,
    { onRequest: guard },
    run(async (request, reply) => {
      const p = params
        .extend({ asset: z.string().regex(/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/) })
        .parse(request.params);
      reply.type(
        p.asset.endsWith('.png')
          ? 'image/png'
          : p.asset.endsWith('.webp')
            ? 'image/webp'
            : p.asset.endsWith('.gif')
              ? 'image/gif'
              : 'image/jpeg',
      );
      return documents.asset(p.handle, p.id, p.version, p.asset);
    }),
  );
}
