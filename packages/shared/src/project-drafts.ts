import { z } from 'zod';
import { jobEstimateSchema } from './pulsar.js';
const uuidSchema = z.string().uuid();

// Browser creation drafts retain the original receipt when a response is uncertain.
export const taskDraftSchema = z.object({
  key: uuidSchema,
  submitted: z.boolean().default(false),
  managerId: uuidSchema,
  title: z.string().max(160),
  goal: z.string().max(4000),
  acceptance: z.string().max(2000),
  scheduling: jobEstimateSchema,
});
export const managerDraftSchema = z.object({
  key: uuidSchema,
  submitted: z.boolean().default(false),
  name: z.string().max(80),
  scope: z.string().max(2000),
  provider: z.enum(['policy', 'codex', 'claude']),
});
