import type { FastifyInstance } from 'fastify';
import type { ClusterProjects } from './cluster-projects.js';
import { registerHostRoutes } from './hosts.js';

export function registerClusterProjectRoutes(
  app: FastifyInstance,
  projects: ClusterProjects,
  options: Pick<NonNullable<Parameters<typeof registerHostRoutes>[2]>, 'watch'> = {},
) {
  app.get('/api/cluster/projects', async () => projects.list());
  app.post('/api/cluster/projects', async (request) => projects.create(request.body));
  app.get<{ Params: { id: string } }>('/api/cluster/projects/:id', async (request) =>
    projects.summary(request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/cluster/projects/:id/tracking', async (request) =>
    projects.enableTracking(request.params.id, request.body),
  );
  app.get<{ Params: { id: string } }>('/api/cluster/projects/:id/open', async (request) =>
    projects.opened(request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/cluster/projects/:id/open', async (request) =>
    projects.open(request.params.id, request.body),
  );
  app.get<{ Params: { id: string } }>('/api/cluster/projects/:id/admission', async (request) => {
    if (!projects.admission)
      throw new Error('Authoritative cluster admission needs controller setup.');
    return projects.admission.controls(request.params.id);
  });
  app.post<{ Params: { id: string } }>(
    '/api/cluster/projects/:id/admission/policy',
    async (request) => {
      if (!projects.admission)
        throw new Error('Authoritative cluster admission needs controller setup.');
      return projects.admission.savePolicy(request.params.id, request.body);
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/cluster/projects/:id/admission/budget',
    async (request) => {
      if (!projects.admission)
        throw new Error('Authoritative cluster admission needs controller setup.');
      return projects.admission.saveBudget(request.params.id, request.body);
    },
  );
  registerHostRoutes(
    app,
    {
      status: () => ({
        local: { id: 'local' as const, label: 'Cluster controller' },
        setupError: null,
        hosts: [],
      }),
      connection: async (id, retry) => {
        const record = projects.record(id);
        return projects.runtimes.gateway(id).connection(record.hostId, retry);
      },
      checked: async (id) => {
        const record = projects.record(id);
        return projects.runtimes.gateway(id).checked(record.hostId);
      },
      forward: async (id, method, path, body, signal, lastEventId) => {
        const record = projects.record(id);
        return projects.runtimes
          .gateway(id)
          .forward(record.hostId, method, path, body, signal, lastEventId);
      },
    },
    { ...options, prefix: '/api/cluster/projects', proxyOnly: true },
  );
}
