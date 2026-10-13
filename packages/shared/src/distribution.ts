import { z } from 'zod';
/** Non-sensitive browser entry signal; it grants no access to app records. */
export const distributionSchema = z.strictObject({
  distribution: z.enum(['groups-only', 'full-swa']),
});
