import { createHash } from 'node:crypto';
import { z } from 'zod';
import { catchupFail, type GroupCatchupReader } from './group-catchup-context.js';

const argumentsSchema = z.strictObject({
  eventId: z.uuid(),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(16 * 1024 * 1024),
  limit: z.number().int().min(2).max(12000),
});
/** Exact immutable shared bodies, paged without exposing a personal history or
 * accepting a browser/model-selected member, context or filesystem path. */
export function createGroupEvidenceOriginal(resolve: () => Promise<GroupCatchupReader>) {
  return async (raw: unknown) => {
    const input = argumentsSchema.parse(raw),
      reader = await resolve();
    await reader.revalidate();
    const original = await reader.original(
      input.eventId as Parameters<GroupCatchupReader['original']>[0],
    );
    await reader.revalidate();
    const { text } = original;
    if (
      original.eventId !== input.eventId ||
      input.offset > text.length ||
      (input.offset > 0 &&
        /[\uDC00-\uDFFF]/u.test(text[input.offset] ?? '') &&
        /[\uD800-\uDBFF]/u.test(text[input.offset - 1]!))
    )
      catchupFail('invalid_cursor', 'Original offset must belong to this exact shared body.');
    let through = Math.min(text.length, input.offset + input.limit);
    if (through < text.length && /[\uD800-\uDBFF]/u.test(text[through - 1]!)) through--;
    return {
      eventId: original.eventId,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      offset: input.offset,
      through,
      total: text.length,
      text: text.slice(input.offset, through),
      nextOffset: through < text.length ? through : null,
    };
  };
}
export const GROUP_EVIDENCE_ORIGINAL_TOOL = {
  name: 'group_evidence_original',
  description:
    'Read an exact authenticated shared original by eventId from group evidence. Begin at offset 0, then follow nextOffset; offsets/counts use UTF-16 units and each response includes the whole original SHA-256. At most 12000 units per page. Private asides and personal history are excluded; this tool cannot publish or launch work.',
  inputSchema: z.toJSONSchema(argumentsSchema),
} as const;
