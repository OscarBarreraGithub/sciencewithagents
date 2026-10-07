import type { GroupContext, GroupEvent, GroupFeedPage, GroupFeedQuery } from '@dock/shared';
import { createHash } from 'node:crypto';
/** Structural match to normal GroupHost.authenticatedContext. Issued by the authenticated
 * host only; never deserialize this port or accept browser-selected member identity. */
export interface GroupCatchupReader {
  readonly context: Readonly<GroupContext>;
  readonly enrollmentHandle: string;
  revalidate(): Promise<void>;
  readShared(query: GroupFeedQuery): Promise<GroupFeedPage>;
  original(
    eventId: GroupEvent['eventId'],
  ): Promise<{ eventId: GroupEvent['eventId']; text: string }>;
}
export const catchupMemberKey = (reader: GroupCatchupReader): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        reader.context.groupId,
        reader.context.memberId,
        reader.context.installationId,
        reader.enrollmentHandle,
      ]),
    )
    .digest('hex');
export const evidenceReaderKey = (reader: GroupCatchupReader): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        catchupMemberKey(reader),
        reader.context.sessionId,
        reader.context.visibility,
      ]),
    )
    .digest('hex');
export class GroupCatchupError extends Error {
  constructor(
    readonly code: 'invalid_cursor' | 'discontinuous' | 'conflict' | 'limit' | 'private_required',
    message: string,
  ) {
    super(message);
  }
}
export function catchupFail(code: GroupCatchupError['code'], message: string): never {
  throw new GroupCatchupError(code, message);
}
export function catchupCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(catchupCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${catchupCanonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
