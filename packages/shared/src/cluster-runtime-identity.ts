import { z } from 'zod';

/** Exact owned allocation identity shared by bootstrap and subsequent admission. */
export const remoteRuntimeIdentitySchema = z
  .object({
    controllerHostId: z.uuid(),
    remoteHostId: z.uuid(),
    clusterProjectId: z.uuid(),
    remoteProjectId: z.uuid(),
    jobId: z.string().regex(/^\d{1,20}$/),
    leaseToken: z.uuid(),
  })
  .strict();
export type RemoteRuntimeIdentity = z.infer<typeof remoteRuntimeIdentitySchema>;
