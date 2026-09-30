import type { FastifyInstance } from 'fastify';
import {
  projectWorkflowSchema,
  projectWorkflowSaveSchema,
  type ProjectWorkflow,
} from '@dock/shared';
import { Conflict, type Store } from './store.js';
import type { ModelPolicy } from './model-policy.js';
import { z } from 'zod';

export function projectWorkflow(store: Store, projectId: string): ProjectWorkflow {
  store.project(projectId);
  return projectWorkflowSchema.parse(store.getSetting(`project-workflow:${projectId}`) ?? {});
}
export function registerProjectWorkflowRoutes(
  app: FastifyInstance,
  store: Store,
  models: ModelPolicy,
) {
  const project = (params: unknown) => z.object({ id: z.string().uuid() }).parse(params).id;
  app.get('/api/projects/:id/workflow', async (request) =>
    projectWorkflow(store, project(request.params)),
  );
  app.post('/api/projects/:id/workflow', async (request) => {
    const projectId = project(request.params),
      value = projectWorkflowSaveSchema.parse(request.body);
    store.project(projectId);
    for (const choice of Object.values(value.workflow.overrides)) {
      const catalog = await models.catalog(choice.provider);
      if (
        choice.model &&
        !catalog.some(
          (model) =>
            model.id === choice.model && (!choice.effort || model.efforts.includes(choice.effort)),
        )
      )
        throw new Conflict(
          'Choose an available model and thinking level from the current provider catalog.',
        );
    }
    return store.operation(value.key, { kind: 'project.workflow', projectId, ...value }, () => {
      const current = projectWorkflow(store, projectId);
      if (current.revision !== value.expectedRevision)
        throw new Conflict(
          'Project settings changed on another device. Reload them before saving.',
        );
      const workflow = projectWorkflowSchema.parse({
        ...value.workflow,
        revision: current.revision + 1,
      });
      store.setSetting(`project-workflow:${projectId}`, workflow);
      store.event('project.workflow_changed', projectId, null, workflow);
      return workflow;
    });
  });
}
