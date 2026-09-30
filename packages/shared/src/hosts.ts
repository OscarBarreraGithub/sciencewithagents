import { z } from 'zod';

export const hostInfoSchema = z
  .object({
    hostId: z.string().uuid(),
    protocolVersion: z.literal(1),
    localAuthentication: z.boolean().optional(),
    instanceId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

// This configuration is host-only. No browser endpoint accepts these transport fields.
export const hostConnectionSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().trim().min(1).max(80),
    accountLabel: z.string().trim().min(1).max(80),
    expectedHostId: z.string().uuid(),
    sshAlias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    remotePort: z.number().int().min(1).max(65535).default(4330),
    credential: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const hostConnectionsSchema = hostConnectionSchema
  .array()
  .max(16)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
    message: 'Computer connection IDs must be unique.',
  });
export type HostConnection = z.infer<typeof hostConnectionSchema>;

export const hostSummarySchema = z
  .object({
    id: z.string().uuid(),
    label: z.string(),
    accountLabel: z.string(),
    status: z.enum(['disconnected', 'connecting', 'connected', 'error']),
    error: z.string().nullable(),
  })
  .strict();
export type HostSummary = z.infer<typeof hostSummarySchema>;
export const hostsStatusSchema = z
  .object({
    local: z.object({ id: z.literal('local'), label: z.string() }).strict(),
    hosts: hostSummarySchema.array(),
    setupError: z.string().nullable(),
  })
  .strict();
export type HostsStatus = z.infer<typeof hostsStatusSchema>;
