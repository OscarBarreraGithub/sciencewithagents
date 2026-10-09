import { z } from 'zod';

/**
 * MCP tool input schemas must declare a top-level object type. Zod emits a bare
 * anyOf/oneOf for unions of strict objects, which Claude rejects for the whole dock
 * server; keep the strict branches and add only the root type.
 */
export function toolInputSchema(schema: z.ZodType) {
  const json = z.toJSONSchema(schema);
  if (json.type !== undefined && json.type !== 'object')
    throw new Error('Coordination tool input must be a JSON object.');
  return { ...json, type: 'object' as const };
}
