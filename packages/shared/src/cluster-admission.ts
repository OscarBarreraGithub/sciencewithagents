import { z } from 'zod';
import { remoteRuntimeIdentitySchema } from './cluster-runtime-identity.js';
import { providerIdSchema, effortSchema, taskClassSchema } from './providers.js';
import { jobEstimateSchema } from './pulsar.js';
import { tokenCountsSchema } from './usage.js';
import { providerCapacitySchema } from './capacity.js';

const id = z.uuid(),
  affinity = z.string().regex(/^[a-f0-9]{64}$/);
export const remoteAccountIdentitySchema = z
  .object({
    provider: providerIdSchema,
    affinity: affinity.nullable(),
    identityBasis: z.enum(['native', 'native-home', 'independent-host']),
    state: z.enum(['ready', 'setup-required', 'unavailable']),
    observedAt: z.string().datetime(),
    message: z.string().max(500),
  })
  .strict();
export const remoteAccountCapacitySchema = z
  .object({
    provider: providerIdSchema,
    accountAffinity: affinity,
    readerHostId: id,
    generation: id,
    capacity: providerCapacitySchema,
    ordinaryUsageAllowed: z.boolean().nullable().default(null),
  })
  .strict();
export const remoteAdmissionCandidateSchema = z
  .object({
    runId: id,
    agentId: id,
    projectId: id,
    projectName: z.string().max(100),
    provider: providerIdSchema,
    accountAffinity: affinity,
    model: z.string().max(100).nullable(),
    effort: effortSchema,
    taskClass: taskClassSchema,
    /** Current remote project preference, included in the exact prepared-request hash. */
    followQuark: z.boolean(),
    kind: z.enum(['user', 'delegation', 'message', 'report', 'resume']),
    estimate: jobEstimateSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export const remoteAdmissionGrantSchema = z
  .object({
    id,
    controllerHostId: id,
    remoteHostId: id,
    clusterProjectId: id,
    jobId: z.string().regex(/^\d{1,20}$/),
    leaseToken: id,
    runId: id,
    provider: providerIdSchema,
    accountAffinity: affinity,
    requestHash: affinity,
    policyRevision: z.string().max(100),
    expiresAt: z.string().datetime(),
    decision: z.enum(['allow', 'hold']),
    reason: z.string().max(500),
  })
  .strict();
export const remoteAdmissionReceiptSchema = z
  .object({
    grantId: id,
    runId: id,
    provider: providerIdSchema,
    accountAffinity: affinity,
    state: z.enum(['running', 'complete', 'interrupted', 'failed', 'unused']),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    usage: tokenCountsSchema,
    basis: z.enum(['measured', 'partial', 'unknown']).default('unknown'),
  })
  .strict();
export const remoteAdmissionSnapshotSchema = z
  .object({
    identity: remoteRuntimeIdentitySchema,
    followQuark: z.boolean(),
    accounts: z.array(remoteAccountIdentitySchema).max(2),
    candidates: z.array(remoteAdmissionCandidateSchema).max(32),
    receipts: z.array(remoteAdmissionReceiptSchema).max(64),
    capacities: z.array(remoteAccountCapacitySchema).max(2),
  })
  .strict()
  .superRefine((snapshot, context) => {
    snapshot.candidates.forEach((candidate, index) => {
      if (candidate.followQuark !== snapshot.followQuark)
        context.addIssue({
          code: 'custom',
          path: ['candidates', index, 'followQuark'],
          message: 'Candidate scheduling preference must match its remote project.',
        });
    });
  });
export const remoteAdmissionPushSchema = z
  .object({ key: id, grant: remoteAdmissionGrantSchema })
  .strict();
export const remoteAdmissionAcceptedSchema = z
  .object({
    key: id,
    accepted: z.literal(true),
    grantId: id,
    runId: id,
    decision: z.enum(['allow', 'hold']),
  })
  .strict();
export const remoteAccountReaderSchema = z
  .object({
    key: id,
    controllerHostId: id,
    accountAffinity: affinity,
    provider: providerIdSchema,
    generation: id,
    reader: z.boolean(),
    expiresAt: z.string().datetime(),
    cached: remoteAccountCapacitySchema.nullable(),
  })
  .strict();
export type RemoteAccountIdentity = z.infer<typeof remoteAccountIdentitySchema>;
export type RemoteAccountCapacity = z.infer<typeof remoteAccountCapacitySchema>;
export type RemoteAdmissionCandidate = z.infer<typeof remoteAdmissionCandidateSchema>;
export type RemoteAdmissionGrant = z.infer<typeof remoteAdmissionGrantSchema>;
export type RemoteAdmissionReceipt = z.infer<typeof remoteAdmissionReceiptSchema>;
export type RemoteAdmissionSnapshot = z.infer<typeof remoteAdmissionSnapshotSchema>;
