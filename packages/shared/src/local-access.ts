import { z } from 'zod';

export const localAccessStatusSchema = z.object({ enabled: z.boolean() }).strict();
