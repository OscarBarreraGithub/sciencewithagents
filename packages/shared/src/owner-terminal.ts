import { z } from 'zod';

/** Owner-operated shell; no agent, provider, executable or working-directory input. */
export const ownerTerminalOpenSchema = z.object({ key: z.uuid() }).strict();
export const ownerTerminalSessionSchema = z
  .object({
    id: z.uuid(),
    computer: z.string().min(1).max(500),
    shell: z.string().min(1).max(4096),
    cwd: z.string().min(1).max(4096),
    status: z.enum(['running', 'exited']),
    exitCode: z.number().int().nullable(),
  })
  .strict();
export type OwnerTerminalSession = z.infer<typeof ownerTerminalSessionSchema>;
