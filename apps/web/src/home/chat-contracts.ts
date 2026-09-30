import {
  providerMixSchema,
  spendingLevelSchema,
  workerPurposeSchema,
  projectWorkflowSchema,
  workItemsSchema,
  projectNotesSchema,
  projectRatesSchema,
  workspaceDraftHistorySchema,
  quarkCoordinatorStatusSchema,
  quarkProjectPolicySchema,
  quarkProjectPrioritySchema,
  type Agent,
  type ProjectWorkflow,
  type ProjectRates,
} from '@dock/shared';

// Screens use the same validation and model defaults as manager dispatch.
export { modelFamilies, workerDefault, workerDefaults } from '@dock/shared';
export type { ProjectWorkflow, WorkItem, ProjectNotes } from '@dock/shared';
export const providerMixes = providerMixSchema.options;
export const spendingLevels = spendingLevelSchema.options;
export const workerPurposes = workerPurposeSchema.options;
export type ProviderMix = ProjectWorkflow['providerMix'];
export type SpendingLevel = ProjectWorkflow['spending'];
export type WorkerPurpose = (typeof workerPurposes)[number];
export type WorkerChoice = NonNullable<ProjectWorkflow['overrides']['research']>;
export type ProjectRate = ProjectRates['rates'][number];
export type ConversationSurface = NonNullable<Agent['surface']>;
export const surfaceOf = (agent: Agent | undefined): ConversationSurface | null =>
  agent?.surface ?? null;
export const parseWorkflow = (value: unknown) => projectWorkflowSchema.parse(value);
export const parseWorkItems = (value: unknown) => workItemsSchema.parse(value).items;
export const parseNotes = (value: unknown) => projectNotesSchema.parse(value);
export const parseProjectRates = (value: unknown) => projectRatesSchema.parse(value);
export const parseDraftHistory = (value: unknown) => workspaceDraftHistorySchema.parse(value);
export const parseCoordinator = (value: unknown) => quarkCoordinatorStatusSchema.parse(value);

export const quarkPriorities = quarkProjectPrioritySchema.unwrap().options;
export type QuarkPriority = (typeof quarkPriorities)[number];
export type ProjectQuark = { revision: number; priority: QuarkPriority | null };
/** GET/POST /projects/:id/quark. Null inherits task defaults. */
export function parseProjectQuark(value: unknown): ProjectQuark {
  const policy = quarkProjectPolicySchema.parse(value);
  return { revision: policy.revision, priority: policy.priority };
}
