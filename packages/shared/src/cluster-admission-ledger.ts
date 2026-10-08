import { z } from 'zod';
import { allowanceSchema } from './quark.js';

const id = z.uuid(),
  affinity = z.string().regex(/^[a-f0-9]{64}$/),
  provider = z.enum(['codex', 'claude']);
/** Opaque remote native account; the browser never selects a ledger path. */
export const clusterLedgerAccountSchema = z.object({ provider, affinity }).strict();
export const clusterAdmissionHoldSchema = z
  .object({
    runId: id,
    projectId: id,
    cause: z.enum(['setup', 'usage-not-allowed', 'allowance', 'allocation']),
    reason: z.string().max(500),
    at: z.string().datetime(),
  })
  .strict();
const count = z.number().int().nonnegative();
export const clusterAdmissionAccountStatusSchema = z
  .object({
    provider,
    accountAffinity: affinity,
    /** False when only setup holds exist: no verified identity, so no ledger was opened. */
    verified: z.boolean(),
    policyRevision: z.number().int().nonnegative().nullable(),
    reservedPercent: z.number().nonnegative(),
    running: count,
    /** Expired grants without a receipt: spend is unknown, so reservations are retained. */
    uncertain: z.array(z.object({ runId: id, projectId: id }).strict()).max(32),
    holds: z.array(clusterAdmissionHoldSchema).max(32),
    settled: z
      .object({ complete: count, interrupted: count, failed: count, unused: count })
      .strict(),
    /** Normalized cumulative per-run receipt counts; never a transcript or prompt. */
    recent: z
      .array(
        z
          .object({
            runId: id,
            projectId: id,
            state: z.enum(['complete', 'interrupted', 'failed', 'unused']),
            basis: z.enum(['measured', 'partial', 'unknown']),
            totalTokens: count.nullable(),
            settledAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(10),
    budgets: z
      .array(
        allowanceSchema.safeExtend({
          spentPercent: z.number(),
          reservedPercent: z.number(),
          remainingPercent: z.number(),
        }),
      )
      .max(256),
  })
  .strict();
export const clusterAdmissionStatusSchema = z.array(clusterAdmissionAccountStatusSchema).max(64);
export type ClusterLedgerAccount = z.infer<typeof clusterLedgerAccountSchema>;
export type ClusterAdmissionStatus = z.infer<typeof clusterAdmissionStatusSchema>;
