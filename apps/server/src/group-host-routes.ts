import { registerGroupReportRoutes } from './group-document-sharing.js';
import { groupFeatureGit } from './group-feature-git.js';
import { groupFeatureDocuments } from './group-feature-documents.js';
import { registerGroupDocumentsRoutes } from './group-documents-routes.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { groupFeatureCoordination } from './group-feature-coordination.js';
import { GroupHost, GroupHostError } from './group-host.js';
import { HostedPublicationError } from './group-publication-host-transport.js';
import { registerGroupActionsRoutes } from './group-actions-routes.js';
import { registerGroupFeatureReading } from './group-features-reading.js';
/** Registration deliberately requires an auth predicate even on loopback. */
export function registerGroupHostRoutes(
  app: FastifyInstance,
  host: GroupHost,
  authenticated: (request: FastifyRequest) => boolean,
) {
  const documents = groupFeatureDocuments(host);
  if (documents) {
    registerGroupDocumentsRoutes(app, documents.documents, authenticated, (handle, id) =>
      documents.sharing.revokeOriginal(handle, id),
    );
    registerGroupReportRoutes(app, documents.sharing, authenticated);
  }
  registerGroupFeatureReading(app, host, authenticated);
  registerGroupActionsRoutes(
    app,
    {
      authenticatedContext: async (handle) => {
        const context = await host.actionContext(handle);
        return {
          ...context,
          command: async (command) => {
            const result = await context.command(command);
            return groupFeatureCoordination(host)?.after(result, command) ?? result;
          },
        };
      },
    },
    authenticated,
  );
  const guard = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!authenticated(request))
      return reply.code(401).send({
        code: 'GROUP_AUTH_REQUIRED',
        error: 'Open an authenticated owner browser or paired device to use Groups.',
      });
  };
  app.get('/api/groups', { onRequest: guard }, async () => host.list());
  const actions = {
    resume: (v: unknown) => host.resume(v),
    create: (v: unknown) => host.create(v),
    join: (v: unknown) => host.join(v),
    open: (v: unknown) => host.open(v),
    chat: (v: unknown) => host.chat(v),
    draft: (v: unknown) => host.saveDraft(v),
    send: (v: unknown) => host.send(v),
    status: (v: unknown) => host.status(v),
    feed: (v: unknown) => host.feed(v),
    original: (v: unknown) => host.original(v),
    'catch-up': (v: unknown) => host.catchUp(v),
    invite: (v: unknown) => host.invite(v),
    pending: (v: unknown) => host.pending(v),
    revoke: (v: unknown) => host.revoke(v),
    approve: (v: unknown) => host.approve(v),
    'request-agent': (v: unknown) => host.requestAgent(v),
    'feed-writer': (v: unknown) => host.configurePromotion(v),
    'native-owner': (v: unknown) => host.nativeOwnerControl(v),
    git: (v: unknown) => {
      const git = groupFeatureGit(host);
      if (!git)
        throw new GroupHostError(
          503,
          'GROUP_GIT_UNAVAILABLE',
          'Saved Git integration is unavailable.',
        );
      return git.request(v);
    },
    'document-offer': (v: unknown) => host.documentOffer(v),
  };
  for (const [name, fn] of Object.entries(actions))
    app.post(
      `/api/groups/${name}`,
      { bodyLimit: 24 * 1024, onRequest: guard },
      async (request, reply) => {
        try {
          return await fn(request.body);
        } catch (error) {
          if (error instanceof GroupHostError)
            return reply.code(error.status).send({ code: error.code, error: error.message });
          if (error instanceof HostedPublicationError)
            return reply.code(503).send({
              code: 'GROUP_DELIVERY_UNAVAILABLE',
              error:
                'Authenticated Groups delivery is unavailable. Reconnect and retry the same request; its exact identity is retained.',
            });
          throw error;
        }
      },
    );
}
