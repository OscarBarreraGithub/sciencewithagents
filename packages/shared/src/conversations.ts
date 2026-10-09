import { z } from 'zod';
import { effortSchema, providerIdSchema } from './providers.js';
import { executionModeSchema } from './execution-mode.js';

export const conversationSurfaceSchema = z.enum(['misc', 'terminal']);
export const conversationCreateSchema = z
  .object({
    key: z.string().uuid(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    provider: providerIdSchema,
    executionMode: executionModeSchema.optional(),
    model: z.string().trim().min(1).max(100).optional(),
    effort: effortSchema.optional(),
    saveContact: z.boolean().default(true),
  })
  .strict()
  .refine((value) => value.saveContact || value.provider === 'codex', {
    message:
      'Terminal-only conversations currently require Codex. Save a Claude conversation in Misc instead.',
    path: ['saveContact'],
  });
