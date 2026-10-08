import { z } from 'zod';
import { providerIdSchema } from './providers.js';
import { pulsarPolicySchema, pulsarPolicyUpdateSchema } from './pulsar.js';
import { allowanceRequestSchema } from './quark.js';
import { clusterAdmissionAccountStatusSchema } from './cluster-admission-ledger.js';
export const clusterAccountControlsSchema = z
  .object({
    projectId: z.uuid(),
    remoteProjectId: z.uuid().nullable(),
    accounts: z
      .array(
        z
          .object({
            provider: providerIdSchema,
            state: z.enum(['ready', 'setup-required', 'unavailable']),
            message: z.string().max(500),
            accountAffinity: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
            status: clusterAdmissionAccountStatusSchema.nullable(),
            policy: pulsarPolicySchema.nullable(),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();
export const clusterAccountPolicyUpdateSchema = z
  .object({
    provider: providerIdSchema,
    expectedAccountAffinity: z.string().regex(/^[a-f0-9]{64}$/),
    update: pulsarPolicyUpdateSchema,
  })
  .strict();
export const clusterAccountBudgetUpdateSchema = z
  .object({
    provider: providerIdSchema,
    expectedAccountAffinity: z.string().regex(/^[a-f0-9]{64}$/),
    budget: allowanceRequestSchema,
  })
  .strict();
export type ClusterAccountControls = z.infer<typeof clusterAccountControlsSchema>;
